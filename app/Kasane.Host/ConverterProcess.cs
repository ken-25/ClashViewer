using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>
/// 変換エンジン（converter.exe）を 1 回起動し、標準出力の JSON 行を読む。取込とジョブの共通部品。
///
/// 約束（converter 側の progress.py と対）:
/// - 1 行 1 イベント。event = stage / progress / log / result / error
/// - result はちょうど 1 回。戻り値になる（event キーは外す）
/// - error・result 以外はそのまま onEvent へ流す（画面の進捗表示用）
/// - 終了コード 0 以外か result が無ければ失敗
/// </summary>
public static class ConverterProcess
{
    /// <summary>
    /// 変換エンジンの場所。配布時は tools/converter/converter.exe。
    /// 開発時は config/app.json の converterCommand（例: ["uv","run","--project","...","kasane-converter"]）を使う。
    /// </summary>
    public static (string Exe, string[] Prefix) Resolve(AppPaths paths)
    {
        var exe = Path.Combine(paths.Tools, "converter", "converter.exe");
        if (File.Exists(exe)) return (exe, Array.Empty<string>());
        var cfg = Path.Combine(paths.Config, "app.json");
        if (File.Exists(cfg) && JsonUtil.ReadFile(cfg)?["converterCommand"] is JsonArray cmd && cmd.Count > 0)
        {
            var parts = cmd.Select(n => n!.GetValue<string>()).ToArray();
            return (parts[0], parts[1..]);
        }
        throw new FileNotFoundException("変換エンジンが見つかりません", exe);
    }

    /// <summary>
    /// サブコマンドを実行して result を返す。ct が取り消されたらプロセスツリーごと止めて OperationCanceledException。
    /// </summary>
    public static async Task<JsonObject> RunAsync(
        AppPaths paths,
        string command,
        IEnumerable<string> args,
        Action<JsonObject> onEvent,
        CancellationToken ct)
    {
        var (exe, prefix) = Resolve(paths);
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
        psi.ArgumentList.Add(command);
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        Log.Info($"変換エンジン起動: {exe} {string.Join(' ', psi.ArgumentList)}");

        JsonObject? result = null;
        string? error = null;
        var stderr = new StringBuilder();
        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        proc.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            JsonObject? o;
            try
            {
                o = JsonNode.Parse(e.Data) as JsonObject;
            }
            catch
            {
                Log.Warn($"変換エンジンの出力を解釈できません: {e.Data}");
                return;
            }
            if (o is null) return;
            switch (o["event"]?.GetValue<string>())
            {
                case "result":
                    result = o;
                    break;
                case "error":
                    error = o["message"]?.GetValue<string>() ?? "変換に失敗しました";
                    Log.Error($"変換エンジン: {o["detail"]}");
                    onEvent(o);
                    break;
                default:
                    onEvent(o);
                    break;
            }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null) lock (stderr) stderr.AppendLine(e.Data);
        };
        ct.ThrowIfCancellationRequested();
        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        using (ct.Register(() => Kill(proc)))
        {
            await proc.WaitForExitAsync(CancellationToken.None);
            // 標準出力の読み残しを待つ（WaitForExitAsync は非同期読みの完了まで待つ）
        }
        ct.ThrowIfCancellationRequested();
        if (proc.ExitCode != 0 || result is null)
        {
            string tail;
            lock (stderr) tail = stderr.ToString();
            if (tail.Length > 2000) tail = tail[^2000..];
            throw new InvalidOperationException(error ?? $"変換エンジンが終了コード {proc.ExitCode} で終わりました。{tail}");
        }
        result.Remove("event");
        return result;
    }

    private static void Kill(Process p)
    {
        try
        {
            if (!p.HasExited) p.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            Log.Warn($"変換エンジンを止められません: {ex.Message}");
        }
    }
}
