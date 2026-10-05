using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>datasets/ の一覧と manifest の更新。</summary>
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

    public string FolderPath(string folder)
    {
        if (folder.StartsWith('.') || folder.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new UnauthorizedAccessException($"使えないフォルダ名です: {folder}");
        return Path.Combine(_paths.Datasets, folder);
    }

    /// <summary>
    /// 公開後に変えてよいのは座標合わせ（alignment）だけ。データ本体には触れない。
    /// 変更前の値は alignmentHistory に残す。
    /// </summary>
    public JsonObject UpdateAlignment(string folder, JsonNode alignment, string user)
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
