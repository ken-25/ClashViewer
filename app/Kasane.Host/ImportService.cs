using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Kasane.Host;

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

    /// <summary>撮影ポイントの画像を置くフォルダ（データセットのフォルダからの相対。manifest の sources[].images[].file と同じ先頭）</summary>
    public const string ImagesDir = "images";

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
        /// <summary>中断で取り消す（変換エンジンはプロセスツリーごと止まる）</summary>
        public CancellationTokenSource Cancel { get; } = new();
        public bool Aborted => Cancel.IsCancellationRequested;
    }

    public bool IsActive(string id) => _sessions.ContainsKey(id);
    public bool AnyActive => !_sessions.IsEmpty;

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
        var potree = Path.Combine(_paths.Tools, "PotreeConverter", "PotreeConverter.exe");
        if (!File.Exists(potree)) throw new FileNotFoundException("PotreeConverter が見つかりません", potree);

        var args = new List<string>();
        foreach (var i in inputs)
        {
            args.Add("--input");
            args.Add(i);
        }
        // 撮影ポイントの画像（E57 の images2D）は PC ローカルに書かせ、点群の後で images/ へ写す
        var imagesLocal = Path.Combine(s.Work, "images");
        args.AddRange(new[] { "--out", outLocal, "--potree", potree, "--work", Path.Combine(s.Work, "tmp"), "--images", imagesLocal });
        JsonObject result;
        try
        {
            result = await ConverterProcess.RunAsync(_paths, "e57", args, o => Emit(id, "pointcloud", o), s.Cancel.Token);
        }
        catch (OperationCanceledException)
        {
            throw new OperationCanceledException("取込を中断しました");
        }

        // データフォルダへ写す（取込中フォルダには完成品だけを置く）
        var dest = Path.Combine(s.Dir, "pointcloud");
        Directory.CreateDirectory(dest);
        var files = new[] { "metadata.json", "hierarchy.bin", "octree.bin" };
        long total = files.Sum(f => new FileInfo(Path.Combine(outLocal, f)).Length), done = 0;
        Emit(id, "pointcloud", new JsonObject { ["event"] = "stage", ["stage"] = "copy", ["label"] = "データフォルダへ書き込み", ["weight"] = 0.0 });
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
        if (Directory.Exists(imagesLocal) && Directory.EnumerateFiles(imagesLocal).Any())
        {
            await StageDirectory(id, imagesLocal, ImagesDir, o => Emit(id, "pointcloud", o));
            TryDelete(imagesLocal);
        }
        result.Remove("event");
        return result;
    }

    /// <summary>
    /// 前の版のファイルを作業用データセットへ複製する（引き継ぎ）。版どうしでファイルを共有しないので、古い版を消しても新しい版は壊れない。
    /// files は「元のデータセットのフォルダ名」と「その中の相対パス」の組。複製先は同じ相対パス。
    /// </summary>
    public async Task<JsonObject> CopyFromDatasets(string id, IReadOnlyList<(string Folder, string Rel)> files, string task, Action<JsonObject>? onEvent = null)
    {
        var s = Get(id);
        // 処理（ジョブ）から呼ぶときは、進捗をジョブの通知として流す
        void Emit(string _, string t, JsonObject evt)
        {
            if (onEvent is not null) onEvent(evt);
            else this.Emit(id, t, evt);
        }
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

    /// <summary>作業用データセットの公開先のフォルダ名（datasets/ 直下の名前）</summary>
    public string FolderOf(string id) => Get(id).Folder;

    /// <summary>
    /// PC ローカルにできたフォルダ（処理の結果など）を作業用データセットの destRel の下へ写す。
    /// 戻り値は写したファイルの大きさ（destRel からの相対パス → バイト数）。
    /// </summary>
    public async Task<Dictionary<string, long>> StageDirectory(string id, string srcDir, string destRel, Action<JsonObject>? onEvent = null)
    {
        var s = Get(id);
        var dest = Path.GetFullPath(Path.Combine(s.Dir, destRel.Replace('/', Path.DirectorySeparatorChar)));
        if (!dest.StartsWith(s.Dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"使えないパスです: {destRel}");
        var files = Directory.EnumerateFiles(srcDir, "*", SearchOption.AllDirectories).ToList();
        long total = files.Sum(f => new FileInfo(f).Length), done = 0;
        var sizes = new Dictionary<string, long>();
        onEvent?.Invoke(new JsonObject { ["event"] = "stage", ["stage"] = "copy", ["label"] = "データフォルダへ書き込み", ["weight"] = 0.0 });
        var buf = new byte[4 << 20];
        var sw = Stopwatch.StartNew();
        foreach (var src in files)
        {
            var rel = Path.GetRelativePath(srcDir, src);
            var dst = Path.Combine(dest, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            await using (var fi = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan))
            await using (var fo = new FileStream(dst, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
            {
                int n;
                while ((n = await fi.ReadAsync(buf)) > 0)
                {
                    if (s.Aborted) throw new OperationCanceledException("中断しました");
                    await fo.WriteAsync(buf.AsMemory(0, n));
                    done += n;
                    if (sw.ElapsedMilliseconds > 250)
                    {
                        sw.Restart();
                        onEvent?.Invoke(new JsonObject { ["event"] = "progress", ["stage"] = "copy", ["done"] = done, ["total"] = total });
                    }
                }
            }
            sizes[rel.Replace('\\', '/')] = new FileInfo(dst).Length;
        }
        onEvent?.Invoke(new JsonObject { ["event"] = "progress", ["stage"] = "copy", ["done"] = total, ["total"] = total });
        return sizes;
    }

    /// <summary>作業用データセットへ JSON を書く（diff.json など）</summary>
    public void WriteJson(string id, string rel, JsonNode node)
    {
        var s = Get(id);
        var path = Path.GetFullPath(Path.Combine(s.Dir, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(s.Dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"使えないパスです: {rel}");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        JsonUtil.WriteFileAtomic(path, node);
    }

    /// <summary>
    /// 公開する。parent は既存の版から処理で作った版のときだけ（JobService が渡す）。
    /// 画面からの取込（RPC importFinish）は parent を渡さないので、画面が parent を偽って書くことはできない。
    /// </summary>
    public JsonObject Finish(string id, JsonObject manifest, JsonObject? parent = null)
    {
        var s = Get(id);
        manifest["schema"] = Manifest.Schema;
        manifest["parent"] = parent?.DeepClone();
        Manifest.EnsureDefaults(manifest);
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
        s.Cancel.Cancel();
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
