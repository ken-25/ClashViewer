using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ClashViewer.Host;

/// <summary>
/// 取込の流れを受け持つ。
///
/// 1. Begin: datasets/.importing/&lt;ID&gt;/ を作る
/// 2. 点群: 変換エンジン（converter.exe）を PC ローカルの作業用フォルダで動かし、できた 3 ファイルを作業用データセットへ写す
///    IFC: 画面側（web-ifc）で Fragments に変換し、/api/write で作業用データセットへ書く
/// 3. Finish: manifest(state=importing) を書き、datasets/&lt;日付&gt;_&lt;名称&gt;_&lt;ID&gt;/ へ改名して公開し、最後に state=ready を書く
/// </summary>
public sealed class ImportService
{
    private readonly AppPaths _paths;
    private readonly string _user;
    private readonly ConcurrentDictionary<string, Session> _sessions = new();

    public event Action<JsonObject>? Progress;

    public ImportService(AppPaths paths, string user)
    {
        _paths = paths;
        _user = user;
    }

    private sealed class Session
    {
        public required string Id { get; init; }
        public required string Folder { get; init; }
        public required string Dir { get; init; }
        public required string Work { get; init; }
        public Process? Process { get; set; }
        public bool Aborted { get; set; }
    }

    public bool IsActive(string id) => _sessions.ContainsKey(id);

    public JsonObject Begin(string name)
    {
        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(3)).ToLowerInvariant();
        var folder = $"{DateTime.Now:yyyyMMdd}_{SafeFolderName(name)}_{id}";
        var dir = Path.Combine(_paths.Importing, id);
        Directory.CreateDirectory(dir);
        var work = Path.Combine(_paths.Work, id);
        Directory.CreateDirectory(work);
        _sessions[id] = new Session { Id = id, Folder = folder, Dir = dir, Work = work };
        Log.Info($"取込開始 {id} {folder}");
        return new JsonObject { ["id"] = id, ["folder"] = folder, ["dir"] = _paths.ToRelative(dir) };
    }

    public static string SafeFolderName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder();
        foreach (var c in name.Trim()) sb.Append(invalid.Contains(c) || c == '_' || char.IsWhiteSpace(c) ? '-' : c);
        var s = sb.ToString().Trim('-', '.');
        if (s.Length == 0) s = "無題";
        return s.Length > 40 ? s[..40] : s;
    }

    private Session Get(string id) =>
        _sessions.TryGetValue(id, out var s) ? s : throw new InvalidOperationException($"取込中ではありません: {id}");

    private void Emit(string id, string task, JsonObject evt)
    {
        evt["importId"] = id;
        evt["task"] = task;
        Progress?.Invoke(evt);
    }

    /// <summary>E57 を変換し、作業用データセットの pointcloud/ に置く。戻り値は変換エンジンの結果。</summary>
    public async Task<JsonObject> RunPointcloud(string id, IReadOnlyList<string> inputs)
    {
        var s = Get(id);
        var outLocal = Path.Combine(s.Work, "pointcloud");
        var (exe, prefix) = ResolveConverter();
        var potree = Path.Combine(_paths.Tools, "PotreeConverter", "PotreeConverter.exe");
        if (!File.Exists(potree)) throw new FileNotFoundException("PotreeConverter が見つかりません", potree);

        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in prefix) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("e57");
        foreach (var i in inputs)
        {
            psi.ArgumentList.Add("--input");
            psi.ArgumentList.Add(i);
        }
        psi.ArgumentList.Add("--out");
        psi.ArgumentList.Add(outLocal);
        psi.ArgumentList.Add("--potree");
        psi.ArgumentList.Add(potree);
        psi.ArgumentList.Add("--work");
        psi.ArgumentList.Add(Path.Combine(s.Work, "tmp"));
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        Log.Info($"変換エンジン起動: {exe} {string.Join(' ', psi.ArgumentList)}");

        JsonObject? result = null;
        string? error = null;
        var stderr = new StringBuilder();
        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        proc.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            try
            {
                if (JsonNode.Parse(e.Data) is not JsonObject o) return;
                switch (o["event"]?.GetValue<string>())
                {
                    case "result":
                        result = o;
                        break;
                    case "error":
                        error = o["message"]?.GetValue<string>() ?? "変換に失敗しました";
                        Log.Error($"変換エンジン: {o["detail"]}");
                        Emit(id, "pointcloud", o);
                        break;
                    default:
                        Emit(id, "pointcloud", o);
                        break;
                }
            }
            catch
            {
                Log.Warn($"変換エンジンの出力を解釈できません: {e.Data}");
            }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null) lock (stderr) stderr.AppendLine(e.Data);
        };
        proc.Start();
        s.Process = proc;
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        await proc.WaitForExitAsync();
        s.Process = null;
        if (s.Aborted) throw new OperationCanceledException("取込を中断しました");
        if (proc.ExitCode != 0 || result is null)
        {
            var tail = stderr.ToString();
            if (tail.Length > 2000) tail = tail[^2000..];
            throw new InvalidOperationException(error ?? $"変換エンジンが終了コード {proc.ExitCode} で終わりました。{tail}");
        }

        // 共有フォルダへ写す（同期対象には完成品だけを置く）
        var dest = Path.Combine(s.Dir, "pointcloud");
        Directory.CreateDirectory(dest);
        var files = new[] { "metadata.json", "hierarchy.bin", "octree.bin" };
        long total = files.Sum(f => new FileInfo(Path.Combine(outLocal, f)).Length), done = 0;
        Emit(id, "pointcloud", new JsonObject { ["event"] = "stage", ["stage"] = "copy", ["label"] = "共有フォルダへ書き込み", ["weight"] = 0.0 });
        var buf = new byte[4 << 20];
        var sw = Stopwatch.StartNew();
        foreach (var f in files)
        {
            using var src = new FileStream(Path.Combine(outLocal, f), FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20);
            using var dst = new FileStream(Path.Combine(dest, f), FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
            int n;
            while ((n = await src.ReadAsync(buf)) > 0)
            {
                if (s.Aborted) throw new OperationCanceledException("取込を中断しました");
                await dst.WriteAsync(buf.AsMemory(0, n));
                done += n;
                if (sw.ElapsedMilliseconds > 250)
                {
                    sw.Restart();
                    Emit(id, "pointcloud", new JsonObject { ["event"] = "progress", ["stage"] = "copy", ["done"] = done, ["total"] = total });
                }
            }
        }
        Emit(id, "pointcloud", new JsonObject { ["event"] = "progress", ["stage"] = "copy", ["done"] = total, ["total"] = total });
        TryDelete(outLocal);
        result.Remove("event");
        return result;
    }

    /// <summary>
    /// 前の版のファイルを作業用データセットへ複製する（引き継ぎ）。版どうしでファイルを共有しないので、古い版を消しても新しい版は壊れない。
    /// files は「元のデータセットのフォルダ名」と「その中の相対パス」の組。複製先は同じ相対パス。
    /// </summary>
    public async Task<JsonObject> CopyFromDatasets(string id, IReadOnlyList<(string Folder, string Rel)> files, string task)
    {
        var s = Get(id);
        var pairs = new List<(string Src, string Dst, string Rel)>();
        foreach (var (folder, rel) in files)
        {
            var src = _paths.ResolveRelative($"datasets/{folder}/{rel}", "datasets/");
            if (folder.StartsWith('.')) throw new UnauthorizedAccessException("取込中のデータセットからは複製できません");
            if (!File.Exists(src)) throw new FileNotFoundException($"前の版のファイルがありません（削除された可能性があります）: {folder}/{rel}", src);
            var dst = Path.GetFullPath(Path.Combine(s.Dir, rel.Replace('/', Path.DirectorySeparatorChar)));
            if (!dst.StartsWith(s.Dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException($"使えないパスです: {rel}");
            pairs.Add((src, dst, rel));
        }
        long total = pairs.Sum(p => new FileInfo(p.Src).Length), done = 0;
        Emit(id, task, new JsonObject { ["event"] = "stage", ["stage"] = "carry", ["label"] = "前の版から複製", ["weight"] = 1.0 });
        var buf = new byte[4 << 20];
        var sw = Stopwatch.StartNew();
        foreach (var (src, dst, rel) in pairs)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            var tmp = dst + ".part";
            await using (var fi = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 20, FileOptions.SequentialScan))
            await using (var fo = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
            {
                int n;
                while ((n = await fi.ReadAsync(buf)) > 0)
                {
                    if (s.Aborted) throw new OperationCanceledException("取込を中断しました");
                    await fo.WriteAsync(buf.AsMemory(0, n));
                    done += n;
                    if (sw.ElapsedMilliseconds > 250)
                    {
                        sw.Restart();
                        Emit(id, task, new JsonObject { ["event"] = "progress", ["stage"] = "carry", ["done"] = done, ["total"] = total, ["message"] = rel });
                    }
                }
            }
            File.Move(tmp, dst, overwrite: true);
        }
        Emit(id, task, new JsonObject { ["event"] = "progress", ["stage"] = "carry", ["done"] = total, ["total"] = total });
        Log.Info($"引き継ぎ {id}: {pairs.Count} ファイル {total:N0} バイト");
        return new JsonObject { ["files"] = pairs.Count, ["bytes"] = total };
    }

    /// <summary>
    /// 変換エンジンの場所。配布時は tools/converter/converter.exe。
    /// 開発時は config/app.json の converterCommand（例: ["uv","run","--project","...","clash-converter"]）を使う。
    /// </summary>
    private (string exe, string[] prefix) ResolveConverter()
    {
        var exe = Path.Combine(_paths.Tools, "converter", "converter.exe");
        if (File.Exists(exe)) return (exe, Array.Empty<string>());
        var cfg = Path.Combine(_paths.Config, "app.json");
        if (File.Exists(cfg) && JsonUtil.ReadFile(cfg)?["converterCommand"] is JsonArray cmd && cmd.Count > 0)
        {
            var parts = cmd.Select(n => n!.GetValue<string>()).ToArray();
            return (parts[0], parts[1..]);
        }
        throw new FileNotFoundException("変換エンジンが見つかりません", exe);
    }

    public JsonObject Finish(string id, JsonObject manifest)
    {
        var s = Get(id);
        manifest["schema"] = 1;
        manifest["id"] = id;
        manifest["createdBy"] = _user;
        manifest["createdAt"] = JsonUtil.NowIso();
        manifest["appVersion"] = typeof(ImportService).Assembly.GetName().Version?.ToString();
        manifest["state"] = "importing";
        manifest.Remove("folder");
        JsonUtil.WriteFileAtomic(Path.Combine(s.Dir, "manifest.json"), manifest);

        var final = Path.Combine(_paths.Datasets, s.Folder);
        if (Directory.Exists(final)) throw new IOException($"同じ名前のデータセットがあります: {s.Folder}");
        Directory.Move(s.Dir, final);
        manifest["state"] = "ready";
        JsonUtil.WriteFileAtomic(Path.Combine(final, "manifest.json"), manifest);
        _sessions.TryRemove(id, out _);
        TryDelete(s.Work);
        Log.Info($"取込完了 {id} → {s.Folder}");
        manifest["folder"] = s.Folder;
        return manifest;
    }

    public void Abort(string id)
    {
        if (!_sessions.TryRemove(id, out var s)) return;
        s.Aborted = true;
        try
        {
            if (s.Process is { HasExited: false } p) p.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            Log.Warn($"変換エンジンを止められません: {ex.Message}");
        }
        // 変換エンジンの終了を少し待ってから片付ける
        Task.Run(async () =>
        {
            await Task.Delay(500);
            TryDelete(s.Dir);
            TryDelete(s.Work);
        });
        Log.Info($"取込中断 {id}");
    }

    public void AbortAll()
    {
        foreach (var id in _sessions.Keys.ToList()) Abort(id);
    }

    private static void TryDelete(string dir)
    {
        for (int i = 0; i < 5; i++)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
                return;
            }
            catch (IOException)
            {
                Thread.Sleep(300);
            }
            catch (UnauthorizedAccessException)
            {
                Thread.Sleep(300);
            }
        }
        Log.Warn($"削除できません: {dir}");
    }
}
