namespace ClashViewer.Host;

/// <summary>
/// アプリ一式・データフォルダ・ローカル作業領域のパス。
/// アプリは MSI でユーザーごとに入れる（%LocalAppData%\Programs\ClashViewer、読み取り専用として扱う）。
/// データは PC ごとのローカルに置く。既定は %LocalAppData%\ClashViewer\data で、
/// settings.json の dataRoot（大容量ドライブへ移すとき）か、開発用の --root で変えられる。
/// </summary>
public sealed class AppPaths
{
    /// <summary>アプリ一式（exe・viewer/・tools/）の場所。exe を置いたフォルダ。ここには書き込まない。</summary>
    public string App { get; }
    public string Viewer => Path.Combine(App, "viewer");
    public string Tools => Path.Combine(App, "tools");

    /// <summary>データ（config/・datasets/・events/・issues/）のルート。</summary>
    public string Root { get; }
    public string Config => Path.Combine(Root, "config");
    public string Members => Path.Combine(Config, "members");
    public string Datasets => Path.Combine(Root, "datasets");
    public string Importing => Path.Combine(Datasets, ".importing");
    public string Events => Path.Combine(Root, "events");
    public string Issues => Path.Combine(Root, "issues");

    /// <summary>PC ごとのローカル領域（WebView2 のプロファイル・変換の作業用・ログ・設定）。アンインストールしても消さない。</summary>
    public static string Local { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClashViewer");
    public static string DefaultRoot => Path.Combine(Local, "data");
    /// <summary>PC ごとの設定（データフォルダの場所など）。データフォルダの外に置く（場所を変えても読めるように）。</summary>
    public static string SettingsFile => Path.Combine(Local, "settings.json");
    public string WebViewData => Path.Combine(Local, "WebView2");
    public string Work => Path.Combine(Local, "work");
    public string Logs => Path.Combine(Local, "logs");

    public AppPaths(string app, string root)
    {
        App = Path.GetFullPath(app).TrimEnd(Path.DirectorySeparatorChar);
        Root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
    }

    /// <summary>
    /// データフォルダを決める。--root（開発用）＞ settings.json の dataRoot ＞ 既定（%LocalAppData%\ClashViewer\data）。
    /// settings.json が壊れていても起動は止めず、既定を使う。
    /// </summary>
    public static string ResolveRoot(string? argRoot)
    {
        if (!string.IsNullOrWhiteSpace(argRoot)) return argRoot;
        try
        {
            if (File.Exists(SettingsFile)
                && JsonUtil.ReadFile(SettingsFile)?["dataRoot"] is System.Text.Json.Nodes.JsonValue v
                && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                return Environment.ExpandEnvironmentVariables(s);
        }
        catch (Exception ex)
        {
            Log.Warn($"settings.json を読めません（既定のデータフォルダを使います）: {ex.Message}");
        }
        return DefaultRoot;
    }

    public void EnsureFolders()
    {
        foreach (var d in new[] { Datasets, Importing, Events, Issues, Config, Members })
            Directory.CreateDirectory(d);
        foreach (var d in new[] { Local, Work, Logs })
            Directory.CreateDirectory(d);
    }

    /// <summary>
    /// データフォルダ相対のパスを絶対パスにする。許可した先頭フォルダの外や、ルートの外へ出るパスは拒否する。
    /// </summary>
    public string ResolveRelative(string relative, params string[] allowedPrefixes)
    {
        if (string.IsNullOrWhiteSpace(relative)) throw new UnauthorizedAccessException("パスが空です");
        var rel = relative.Replace('\\', '/').TrimStart('/');
        if (rel.Contains(':') || rel.Split('/').Any(s => s == ".." || s == "."))
            throw new UnauthorizedAccessException($"使えないパスです: {relative}");
        if (allowedPrefixes.Length > 0 && !allowedPrefixes.Any(p => rel.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            throw new UnauthorizedAccessException($"このパスにはアクセスできません: {relative}");
        var full = Path.GetFullPath(Path.Combine(Root, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"データフォルダの外です: {relative}");
        return full;
    }

    public string ToRelative(string full) => Path.GetRelativePath(Root, full).Replace('\\', '/');
}
