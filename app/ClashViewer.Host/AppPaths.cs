namespace ClashViewer.Host;

/// <summary>共有フォルダとローカル作業領域のパス。</summary>
public sealed class AppPaths
{
    public string Root { get; }
    public string Viewer => Path.Combine(Root, "viewer");
    public string Tools => Path.Combine(Root, "tools");
    public string Config => Path.Combine(Root, "config");
    public string Members => Path.Combine(Config, "members");
    public string Datasets => Path.Combine(Root, "datasets");
    public string Importing => Path.Combine(Datasets, ".importing");
    public string Events => Path.Combine(Root, "events");
    public string Issues => Path.Combine(Root, "issues");

    /// <summary>PC ごとのローカル領域（WebView2 のプロファイル・変換の作業用・ログ）。共有フォルダには置かない。</summary>
    public string Local { get; }
    public string WebViewData => Path.Combine(Local, "WebView2");
    public string Work => Path.Combine(Local, "work");
    public string Logs => Path.Combine(Local, "logs");

    public AppPaths(string root)
    {
        Root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        Local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClashViewer");
    }

    public void EnsureShared()
    {
        foreach (var d in new[] { Datasets, Importing, Events, Issues, Config, Members })
            Directory.CreateDirectory(d);
        foreach (var d in new[] { Local, Work, Logs })
            Directory.CreateDirectory(d);
    }

    /// <summary>
    /// 共有フォルダ相対のパスを絶対パスにする。許可した先頭フォルダの外や、ルートの外へ出るパスは拒否する。
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
            throw new UnauthorizedAccessException($"共有フォルダの外です: {relative}");
        return full;
    }

    public string ToRelative(string full) => Path.GetRelativePath(Root, full).Replace('\\', '/');
}
