namespace ClashViewer.Host;

/// <summary>PC ローカルのログ（%LOCALAPPDATA%\ClashViewer\logs）。</summary>
public static class Log
{
    private static readonly object Gate = new();
    private static string? _file;

    public static void Init(string dir)
    {
        Directory.CreateDirectory(dir);
        _file = Path.Combine(dir, $"host-{DateTime.Now:yyyyMMdd}.log");
    }

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);
    public static void Error(string message, Exception? ex = null) => Write("ERROR", ex is null ? message : $"{message}\n{ex}");

    private static void Write(string level, string message)
    {
        if (_file is null) return;
        try
        {
            lock (Gate) File.AppendAllText(_file, $"{DateTime.Now:HH:mm:ss.fff} [{level}] {message}\n");
        }
        catch
        {
            // ログの失敗で本処理を止めない
        }
    }
}
