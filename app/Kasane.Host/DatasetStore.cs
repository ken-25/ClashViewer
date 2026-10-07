using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>datasets/ の一覧と manifest の更新（alignment の差し替えと derived の追記だけ）。</summary>
public sealed class DatasetStore
{
    private readonly AppPaths _paths;

    public DatasetStore(AppPaths paths) => _paths = paths;

    /// <summary>公開済み（state=ready）のデータセットだけを返す。取込中・壊れたものは出さない。</summary>
    public JsonArray List()
    {
        var arr = new JsonArray();
        if (!Directory.Exists(_paths.Datasets)) return arr;
        foreach (var dir in Directory.EnumerateDirectories(_paths.Datasets))
        {
            var name = Path.GetFileName(dir);
            if (name.StartsWith('.')) continue;
            var mf = Path.Combine(dir, "manifest.json");
            if (!File.Exists(mf)) continue;
            try
            {
                var node = JsonUtil.ReadFile(mf);
                if (node is not JsonObject obj || obj["state"]?.GetValue<string>() != "ready") continue;
                obj["folder"] = name;
                arr.Add(obj);
            }
            catch (Exception ex)
            {
                Log.Warn($"manifest を読めません: {mf}: {ex.Message}");
            }
        }
        return arr;
    }

    /// <summary>公開済みの版の manifest（folder 付き）。無い・公開前なら例外</summary>
    public JsonObject Read(string folder)
    {
        var mf = Path.Combine(FolderPath(folder), "manifest.json");
        if (!File.Exists(mf)) throw new DirectoryNotFoundException($"版が見つかりません: {folder}");
        var obj = JsonUtil.ReadFile(mf) as JsonObject ?? throw new InvalidDataException("manifest が壊れています");
        if (obj["state"]?.GetValue<string>() != "ready") throw new InvalidOperationException($"公開前の版です: {folder}");
        obj["folder"] = folder;
        return obj;
    }

    /// <summary>同じプロジェクト（site）の版のうち最大の版番号（無ければ 0）</summary>
    public int MaxVersion(string site) =>
        List().OfType<JsonObject>()
            .Where(m => (m["site"]?.GetValue<string>() ?? m["id"]?.GetValue<string>()) == site)
            .Select(m => m["version"]?.GetValue<int>() ?? 0)
            .DefaultIfEmpty(0)
            .Max();

    public string FolderPath(string folder)
    {
        if (folder.StartsWith('.') || folder.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new UnauthorizedAccessException($"使えないフォルダ名です: {folder}");
        return Path.Combine(_paths.Datasets, folder);
    }

    /// <summary>
    /// 公開後に変えてよいのは座標合わせ（alignment）と派生成果物の追記（derived）だけ。データ本体には触れない。
    /// 変更前の値は alignmentHistory に残す。
    /// </summary>
    public JsonObject UpdateAlignment(string folder, JsonNode alignment, string user)
    {
        lock (_manifestLock) return UpdateAlignmentLocked(folder, alignment, user);
    }

    /// <summary>
    /// 派生成果物（ジョブの結果）を manifest の derived に追記する。データ本体・既存の derived には触れない。
    /// 読み直してから書くので、座標合わせの保存と重なっても互いの変更を消さない（同じプロセス内は lock で直列）。
    /// </summary>
    public JsonObject AddDerived(string folder, JsonObject entry)
    {
        lock (_manifestLock)
        {
            var mf = Path.Combine(FolderPath(folder), "manifest.json");
            var obj = JsonUtil.ReadFile(mf) as JsonObject ?? throw new InvalidDataException("manifest が壊れています");
            Manifest.EnsureDefaults(obj);
            if ((obj["schema"]?.GetValue<int>() ?? 1) < Manifest.Schema) obj["schema"] = Manifest.Schema;
            obj["derived"]!.AsArray().Add(entry.DeepClone());
            obj.Remove("folder");
            JsonUtil.WriteFileAtomic(mf, obj);
            obj["folder"] = folder;
            return obj;
        }
    }

    private readonly object _manifestLock = new();

    private JsonObject UpdateAlignmentLocked(string folder, JsonNode alignment, string user)
    {
        var mf = Path.Combine(FolderPath(folder), "manifest.json");
        var obj = JsonUtil.ReadFile(mf) as JsonObject ?? throw new InvalidDataException("manifest が壊れています");
        var history = obj["alignmentHistory"] as JsonArray ?? new JsonArray();
        if (obj["alignment"] is JsonNode prev) history.Add(prev.DeepClone());
        obj["alignmentHistory"] = history;
        var a = alignment.DeepClone().AsObject();
        a["by"] = user;
        a["at"] = JsonUtil.NowIso();
        obj["alignment"] = a;
        obj.Remove("folder");
        JsonUtil.WriteFileAtomic(mf, obj);
        obj["folder"] = folder;
        return obj;
    }
}
