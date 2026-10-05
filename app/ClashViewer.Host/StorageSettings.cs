using System.Text.Json.Nodes;

namespace ClashViewer.Host;

/// <summary>
/// %LocalAppData%\ClashViewer\settings.json の保存先の設定（PC・利用者ごと）。
///   dataRoot   プロジェクトフォルダ。省略時は %LocalAppData%\ClashViewer\data
///   configRoot 設定データフォルダ。省略時はプロジェクトフォルダの config\
/// ほかのキーは読み書きで消さない。値が既定と同じなら書かない（既定の場所が変わっても追従できるように）。
/// </summary>
public sealed record StorageSettings(string? DataRoot, string? ConfigRoot)
{
    public static StorageSettings Load()
    {
        try
        {
            if (!File.Exists(AppPaths.SettingsFile)) return new(null, null);
            var o = JsonUtil.ReadFile(AppPaths.SettingsFile) as JsonObject;
            return new(Str(o, "dataRoot"), Str(o, "configRoot"));
        }
        catch (Exception ex)
        {
            Log.Warn($"settings.json を読めません（既定の保存先を使います）: {ex.Message}");
            return new(null, null);
        }
    }

    private static string? Str(JsonObject? o, string key) =>
        o?[key] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s)
            ? AppPaths.Normalize(s)
            : null;

    /// <summary>保存する。null・既定と同じ値はキーを消す。</summary>
    public static void Save(string? dataRoot, string? configRoot)
    {
        JsonObject o;
        try
        {
            o = File.Exists(AppPaths.SettingsFile) ? JsonUtil.ReadFile(AppPaths.SettingsFile) as JsonObject ?? new() : new();
        }
        catch (Exception ex)
        {
            // 壊れていたら作り直す（読めない設定は起動時にも無視している）
            Log.Warn($"settings.json を読めないので作り直します: {ex.Message}");
            o = new();
        }
        var root = dataRoot is null ? null : AppPaths.Normalize(dataRoot);
        if (root is not null && SamePath(root, AppPaths.DefaultRoot)) root = null;
        var config = configRoot is null ? null : AppPaths.Normalize(configRoot);
        if (config is not null && SamePath(config, AppPaths.DefaultConfigFor(root ?? AppPaths.DefaultRoot))) config = null;
        Set(o, "dataRoot", root);
        Set(o, "configRoot", config);
        o["updatedAt"] = JsonUtil.NowIso();
        Directory.CreateDirectory(AppPaths.Local);
        JsonUtil.WriteFileAtomic(AppPaths.SettingsFile, o);
        Log.Info($"保存先を保存 dataRoot={root ?? "(既定)"} configRoot={config ?? "(既定)"}");
    }

    private static void Set(JsonObject o, string key, string? value)
    {
        if (value is null) o.Remove(key);
        else o[key] = value;
    }

    public static bool SamePath(string a, string b) =>
        string.Equals(AppPaths.Normalize(a), AppPaths.Normalize(b), StringComparison.OrdinalIgnoreCase);

    public static bool IsUnder(string path, string parent)
    {
        var p = AppPaths.Normalize(path);
        var q = AppPaths.Normalize(parent);
        if (string.Equals(p, q, StringComparison.OrdinalIgnoreCase)) return true;
        if (!q.EndsWith(Path.DirectorySeparatorChar)) q += Path.DirectorySeparatorChar;
        return p.StartsWith(q, StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>保存先に選んだフォルダの検査（使えるか・何が入っているか・注意点）。</summary>
public static class FolderCheck
{
    public const string Project = "project";
    public const string ConfigKind = "config";

    /// <summary>点群 1 件で数 GB〜数十 GB 使うので、これを切ったら注意を出す。</summary>
    private const long LowFreeBytes = 20L * 1024 * 1024 * 1024;

    /// <summary>
    /// フォルダの状態を返す。probeWrite なら（フォルダがあれば）書けるかを実際に試す。フォルダは作らない。
    /// errors があると保存できない。warnings は保存できるが知らせたいこと。
    /// </summary>
    public static JsonObject Inspect(string kind, string path, AppPaths paths, bool probeWrite)
    {
        var errors = new JsonArray();
        var warnings = new JsonArray();
        var o = new JsonObject { ["kind"] = kind, ["errors"] = errors, ["warnings"] = warnings };
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(Environment.ExpandEnvironmentVariables(path)))
        {
            o["path"] = path;
            errors.Add("フォルダをフルパス（例: D:\\ClashViewerData）で指定してください。");
            return o;
        }
        string full;
        try
        {
            full = AppPaths.Normalize(path);
        }
        catch (Exception ex)
        {
            o["path"] = path;
            errors.Add($"使えないパスです: {ex.Message}");
            return o;
        }
        o["path"] = full;

        // 置いてはいけない場所
        if (string.Equals(Path.GetPathRoot(full), full, StringComparison.OrdinalIgnoreCase))
            errors.Add("ドライブの直下は選べません。フォルダを作って選んでください（例: D:\\ClashViewerData）。");
        if (StorageSettings.IsUnder(full, paths.App))
            errors.Add("アプリのフォルダの中には置けません（更新・アンインストールで消えます）。");
        foreach (var (dir, label) in new[] { (paths.WebViewData, "画面のプロファイル"), (paths.Work, "変換の作業用"), (paths.Logs, "ログ") })
            if (StorageSettings.IsUnder(full, dir)) errors.Add($"{label}のフォルダ（{dir}）の中には置けません。");

        var exists = Directory.Exists(full);
        o["exists"] = exists;

        // ドライブの空き・種類
        try
        {
            var root = Path.GetPathRoot(full);
            if (!string.IsNullOrEmpty(root) && !root.StartsWith(@"\\", StringComparison.Ordinal))
            {
                var d = new DriveInfo(root);
                if (d.IsReady)
                {
                    o["freeBytes"] = d.AvailableFreeSpace;
                    o["totalBytes"] = d.TotalSize;
                }
                else
                {
                    errors.Add($"ドライブ {root} が見つからないか、使えない状態です。");
                }
                o["driveType"] = d.DriveType.ToString();
                if (d.DriveType == DriveType.Network) warnings.Add("ネットワーク上のフォルダです。点群の表示や取込が遅くなります。");
                if (d.DriveType == DriveType.Removable) warnings.Add("取り外せるドライブです。外したまま起動すると、既定の保存先で起動するか確認します。");
            }
            else if (root?.StartsWith(@"\\", StringComparison.Ordinal) == true)
            {
                o["driveType"] = "Network";
                warnings.Add("ネットワーク上のフォルダです。点群の表示や取込が遅くなります。");
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"ドライブの情報を読めません: {full} {ex.Message}");
        }
        if (kind == Project && o["freeBytes"] is JsonValue fv && fv.GetValue<long>() < LowFreeBytes)
            warnings.Add("ドライブの空きが少なめです。点群 1 件で数 GB〜数十 GB 使います。");
        if (IsSyncFolder(full))
            warnings.Add("同期フォルダ（OneDrive・Box など）の中です。同期に時間がかかり、表示も遅くなります。");

        // 選び間違い（中のフォルダを選んだ）
        var name = Path.GetFileName(full).ToLowerInvariant();
        if (kind == Project && name is "datasets" or "events" or "issues" or "config")
            warnings.Add($"「{Path.GetFileName(full)}」フォルダそのものを選んでいます。ふつうはその 1 つ上のフォルダを選びます。");
        if (kind == ConfigKind && name == "members")
            warnings.Add("「members」フォルダそのものを選んでいます。ふつうはその 1 つ上（config）を選びます。");

        // 中身
        if (exists)
        {
            if (kind == Project)
            {
                var datasets = CountDatasets(Path.Combine(full, "datasets"));
                o["datasets"] = datasets;
                o["eventFiles"] = Count(Path.Combine(full, "events"), "*.jsonl");
                var looksLike = new[] { "datasets", "events", "issues" }.Any(s => Directory.Exists(Path.Combine(full, s)));
                o["looksLikeProject"] = looksLike;
                if (!looksLike && SafeAny(full))
                    warnings.Add("干渉ビューア以外のファイルが入っているフォルダです。専用のフォルダを作って選ぶと整理しやすくなります。");
            }
            else
            {
                o["hasAppJson"] = File.Exists(Path.Combine(full, "app.json"));
                o["members"] = Count(Path.Combine(full, "members"), "*.json");
            }
            if (probeWrite)
            {
                var (ok, message) = ProbeWrite(full);
                o["writable"] = ok;
                if (!ok) errors.Add($"このフォルダに書き込めません: {message}");
            }
        }
        return o;
    }

    /// <summary>フォルダを作り、書けるかを確かめる。書けなければ理由を返す。</summary>
    public static (bool ok, string message) ProbeWrite(string full)
    {
        try
        {
            Directory.CreateDirectory(full);
            var f = Path.Combine(full, $".cv-write-test-{Guid.NewGuid():N}");
            File.WriteAllText(f, "");
            File.Delete(f);
            return (true, "");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    /// <summary>設定データ（app.json・members/*.json）を新しい場所へ写す。新しい場所にあるものは上書きしない。</summary>
    public static int CopyConfig(string from, string to)
    {
        if (StorageSettings.SamePath(from, to) || !Directory.Exists(from)) return 0;
        int n = 0;
        Directory.CreateDirectory(to);
        var app = Path.Combine(from, "app.json");
        var appTo = Path.Combine(to, "app.json");
        if (File.Exists(app) && !File.Exists(appTo))
        {
            File.Copy(app, appTo);
            n++;
        }
        var members = Path.Combine(from, "members");
        if (Directory.Exists(members))
        {
            var membersTo = Path.Combine(to, "members");
            Directory.CreateDirectory(membersTo);
            foreach (var f in Directory.EnumerateFiles(members, "*.json"))
            {
                var dst = Path.Combine(membersTo, Path.GetFileName(f));
                if (File.Exists(dst)) continue;
                File.Copy(f, dst);
                n++;
            }
        }
        Log.Info($"設定データを写しました {from} → {to}（{n} 件）");
        return n;
    }

    private static int CountDatasets(string dir)
    {
        try
        {
            if (!Directory.Exists(dir)) return 0;
            return Directory.EnumerateDirectories(dir)
                .Count(d => !Path.GetFileName(d).StartsWith('.') && File.Exists(Path.Combine(d, "manifest.json")));
        }
        catch
        {
            return 0;
        }
    }

    private static int Count(string dir, string pattern)
    {
        try
        {
            return Directory.Exists(dir) ? Directory.EnumerateFiles(dir, pattern).Count() : 0;
        }
        catch
        {
            return 0;
        }
    }

    private static bool SafeAny(string dir)
    {
        try
        {
            return Directory.EnumerateFileSystemEntries(dir).Any();
        }
        catch
        {
            return false;
        }
    }

    private static bool IsSyncFolder(string full)
    {
        foreach (var env in new[] { "OneDrive", "OneDriveCommercial", "OneDriveConsumer" })
        {
            var p = Environment.GetEnvironmentVariable(env);
            if (!string.IsNullOrWhiteSpace(p) && Path.IsPathFullyQualified(p) && StorageSettings.IsUnder(full, p)) return true;
        }
        var segs = full.Split(Path.DirectorySeparatorChar);
        return segs.Any(s => s.Equals("Box", StringComparison.OrdinalIgnoreCase) || s.StartsWith("OneDrive", StringComparison.OrdinalIgnoreCase));
    }
}
