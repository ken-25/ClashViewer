namespace Kasane.Host;

/// <summary>
/// アプリ一式・プロジェクトフォルダ・設定データフォルダ・ローカル作業領域のパス。
/// アプリは MSI でユーザーごとに入れる（%LocalAppData%\Programs\Kasane、読み取り専用として扱う）。
/// データは PC ごとのローカルに置く。
///
/// - プロジェクトフォルダ（Root）: datasets/・events/・issues/。既定は %LocalAppData%\Kasane\data
/// - 設定データフォルダ（Config）: app.json・members/。既定はプロジェクトフォルダの config\
///
/// どちらも settings.json（設定画面から保存）か、開発用の --root で変えられる。
/// </summary>
public sealed class AppPaths
{
    /// <summary>アプリ一式（exe・viewer/・tools/）の場所。exe を置いたフォルダ。ここには書き込まない。</summary>
    public string App { get; }
    public string Viewer => Path.Combine(App, "viewer");
    public string Tools => Path.Combine(App, "tools");

    /// <summary>プロジェクトフォルダ（datasets/・events/・issues/）。</summary>
    public string Root { get; }
    /// <summary>設定データフォルダ（app.json・members/）。画面からは /data/config/ で読む。</summary>
    public string Config { get; }
    public string Members => Path.Combine(Config, "members");
    public string Datasets => Path.Combine(Root, "datasets");
    public string Importing => Path.Combine(Datasets, ".importing");
    public string Events => Path.Combine(Root, "events");
    public string Issues => Path.Combine(Root, "issues");

    /// <summary>Root・Config がどこから決まったか（arg / settings / default）。設定画面の表示に使う。</summary>
    public string RootSource { get; }
    public string ConfigSource { get; }

    /// <summary>PC ごとのローカル領域（WebView2 のプロファイル・変換の作業用・ログ・設定）。アンインストールしても消さない。</summary>
    public static string Local { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kasane");
    public static string DefaultRoot => Path.Combine(Local, "data");
    /// <summary>設定データフォルダの既定（プロジェクトフォルダの config\）。</summary>
    public static string DefaultConfigFor(string root) => Path.Combine(Normalize(root), "config");
    /// <summary>PC ごとの設定（保存先の場所など）。保存先の外に置く（場所を変えても読めるように）。</summary>
    public static string SettingsFile => Path.Combine(Local, "settings.json");
    public string WebViewData => Path.Combine(Local, "WebView2");
    public string Work => Path.Combine(Local, "work");
    public string Logs => Path.Combine(Local, "logs");

    public AppPaths(string app, string root, string? config = null, string rootSource = "default", string configSource = "default")
    {
        App = Normalize(app);
        Root = Normalize(root);
        Config = config is null ? DefaultConfigFor(Root) : Normalize(config);
        RootSource = rootSource;
        ConfigSource = config is null ? "default" : configSource;
    }

    /// <summary>絶対パスにして末尾の区切りを取る（ドライブ直下 "D:\" は区切りを残す）。</summary>
    public static string Normalize(string path)
    {
        var full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
        var trimmed = full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return trimmed.EndsWith(':') ? trimmed + Path.DirectorySeparatorChar : trimmed;
    }

    /// <summary>
    /// 保存先を決めて AppPaths を作る。
    /// --root（開発用）があればプロジェクトフォルダはそれ、設定データはその config\（settings.json は見ない）。
    /// なければ settings.json の dataRoot / configRoot、それも無ければ既定。
    /// settings.json が壊れていても起動は止めず、既定を使う。
    /// </summary>
    public static AppPaths Resolve(string app, string? argRoot)
    {
        if (!string.IsNullOrWhiteSpace(argRoot)) return new AppPaths(app, argRoot, null, "arg");
        var s = StorageSettings.Load();
        return new AppPaths(
            app,
            s.DataRoot ?? DefaultRoot,
            s.ConfigRoot,
            s.DataRoot is null ? "default" : "settings",
            "settings");
    }

    public void EnsureFolders()
    {
        foreach (var d in new[] { Datasets, Importing, Events, Issues, Config, Members })
            Directory.CreateDirectory(d);
        foreach (var d in new[] { Local, Work, Logs })
            Directory.CreateDirectory(d);
    }

    /// <summary>
    /// データ相対のパス（datasets/…・events/…・issues/…・config/…）を絶対パスにする。
    /// config/ は設定データフォルダ、それ以外はプロジェクトフォルダの下。
    /// 許可した先頭フォルダの外や、ルートの外へ出るパスは拒否する。
    /// </summary>
    public string ResolveRelative(string relative, params string[] allowedPrefixes)
    {
        if (string.IsNullOrWhiteSpace(relative)) throw new UnauthorizedAccessException("パスが空です");
        var rel = relative.Replace('\\', '/').TrimStart('/');
        if (rel.Contains(':') || rel.Split('/').Any(s => s == ".." || s == "."))
            throw new UnauthorizedAccessException($"使えないパスです: {relative}");
        if (allowedPrefixes.Length > 0 && !allowedPrefixes.Any(p => rel.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            throw new UnauthorizedAccessException($"このパスにはアクセスできません: {relative}");
        var (baseDir, sub) = rel.StartsWith("config/", StringComparison.OrdinalIgnoreCase)
            ? (Config, rel["config/".Length..])
            : (Root, rel);
        if (sub.Length == 0) throw new UnauthorizedAccessException($"使えないパスです: {relative}");
        var full = Path.GetFullPath(Path.Combine(baseDir, sub.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = baseDir.EndsWith(Path.DirectorySeparatorChar) ? baseDir : baseDir + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"データフォルダの外です: {relative}");
        return full;
    }

    /// <summary>プロジェクトフォルダ相対にする（取込中フォルダなど、Root の下だけに使う）。</summary>
    public string ToRelative(string full) => Path.GetRelativePath(Root, full).Replace('\\', '/');
}
