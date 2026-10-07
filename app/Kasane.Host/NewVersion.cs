using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>
/// 処理（ジョブ）で点群を作り直して「新しい版」として公開するときの manifest と diff.json を組み立てる（target = newVersion）。
///
/// - 点群: 処理の結果（out/pointcloud/）。sources（元の E57 の記録）は元の版から引き継ぎ、derivedFrom に元の版と処理の種類を残す
/// - モデル・原点・座標合わせ: 元の版と同じ（ファイルは新しい版のフォルダへ複製。版どうしでファイルを共有しない）
/// - previous: 元の版（差分は元の版との比較）。parent: { folder, jobKind, note }
/// - derived: 空（派生成果物は入力が変わるので引き継がない）
///
/// ファイルには触れない（純粋な組み立て）。書くのは JobService。
/// </summary>
public static class NewVersion
{
    /// <summary>点群の 3 ファイル（PotreeConverter の出力）</summary>
    public static readonly string[] PointcloudFiles = { "metadata.json", "hierarchy.bin", "octree.bin" };

    public static string? Note(JsonObject parameters)
    {
        var s = parameters["note"] is JsonValue v && v.TryGetValue<string>(out var t) ? t.Trim() : null;
        return string.IsNullOrEmpty(s) ? null : s;
    }

    public static JsonObject Parent(JsonObject source, string jobKind, JsonObject parameters) => new()
    {
        ["folder"] = source["folder"]!.GetValue<string>(),
        ["jobKind"] = jobKind,
        ["note"] = Note(parameters),
    };

    /// <summary>
    /// 新しい版の manifest（公開前。id・createdBy・createdAt・state は ImportService.Finish が入れる）。
    /// outputSizes は写した点群ファイルの大きさ（metadata.json などの名前 → バイト数）。
    /// </summary>
    public static JsonObject BuildManifest(
        JsonObject source,
        string newFolder,
        int version,
        string jobKind,
        string jobLabel,
        JsonObject parameters,
        JsonObject result,
        IReadOnlyDictionary<string, long> outputSizes)
    {
        var srcFolder = source["folder"]!.GetValue<string>();
        var srcVersion = source["version"]?.GetValue<int>() ?? 0;
        var pcSrc = source["pointcloud"] as JsonObject;
        var pcRes = result["pointcloud"] as JsonObject ?? throw new InvalidDataException("処理の結果に点群がありません");
        var sizes = new JsonObject();
        foreach (var f in PointcloudFiles)
            sizes[f] = outputSizes.TryGetValue(f, out var n) ? n : throw new InvalidDataException($"処理の結果に {f} がありません");
        var pc = new JsonObject
        {
            ["owner"] = newFolder,
            ["dir"] = "pointcloud",
            ["sources"] = pcSrc?["sources"]?.DeepClone() ?? new JsonArray(),
            ["points"] = pcRes["points"]?.DeepClone() ?? 0,
            ["scanCount"] = pcSrc?["scanCount"]?.DeepClone() ?? 0,
            ["bounds"] = pcRes["bounds"]?.DeepClone() ?? pcSrc?["bounds"]?.DeepClone(),
            ["outputSizes"] = sizes,
            ["derivedFrom"] = new JsonObject { ["folder"] = srcFolder, ["jobKind"] = jobKind },
        };
        foreach (var key in new[] { "classCounts", "attributes", "timings" })
            if (pcRes[key] is JsonNode v) pc[key] = v.DeepClone();

        var models = new JsonArray();
        foreach (var m in (source["models"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var c = m.DeepClone().AsObject();
            c["owner"] = newFolder;
            c["carriedFrom"] = srcFolder;
            models.Add(c);
        }
        var note = Note(parameters);
        var log = new JsonArray
        {
            new JsonObject { ["level"] = "info", ["message"] = $"第{srcVersion}版（{srcFolder}）の点群を「{jobLabel}」で処理して作成しました" },
        };
        if (result["log"] is JsonArray extra)
            foreach (var l in extra) log.Add(l?.DeepClone());
        return new JsonObject
        {
            ["name"] = source["name"]?.DeepClone(),
            ["site"] = source["site"]?.DeepClone() ?? source["id"]?.DeepClone(),
            ["version"] = version,
            ["previous"] = srcFolder,
            ["origin"] = source["origin"]?.DeepClone(),
            ["pointcloud"] = pc,
            ["models"] = models,
            ["alignment"] = source["alignment"]?.DeepClone(),
            ["diff"] = null,
            ["importLog"] = log,
            ["comment"] = note ?? $"「{jobLabel}」で第{srcVersion}版から作成",
            ["derived"] = new JsonArray(),
        };
    }

    /// <summary>モデルを複製するファイル（元のデータセットのフォルダ, その中の相対パス）</summary>
    public static List<(string Folder, string Rel)> ModelFiles(JsonObject source)
    {
        var list = new List<(string, string)>();
        foreach (var m in (source["models"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var owner = m["owner"]!.GetValue<string>();
            list.Add((owner, m["file"]!.GetValue<string>()));
            list.Add((owner, m["elements"]!.GetValue<string>()));
        }
        return list;
    }

    /// <summary>
    /// 撮影ポイントの画像（sources[].images[].file）を複製するファイル（元のデータセットのフォルダ, その中の相対パス）。
    /// 新しい版は sources をそのまま引き継ぐので、画像も同じ相対パスで新しい版のフォルダへ写す。
    /// </summary>
    public static List<(string Folder, string Rel)> ImageFiles(JsonObject source)
    {
        var list = new List<(string, string)>();
        if (source["pointcloud"] is not JsonObject pc || pc["owner"] is not JsonValue ov || !ov.TryGetValue<string>(out var owner)) return list;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in (pc["sources"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            foreach (var img in (s["images"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                if (img["file"] is JsonValue fv && fv.TryGetValue<string>(out var rel) && !string.IsNullOrEmpty(rel) && seen.Add(rel))
                    list.Add((owner, rel));
        return list;
    }

    /// <summary>
    /// diff.json（画面の data/diff.ts の DatasetDiff と同じ形）と、manifest の diff に入れる要約。
    /// モデルは元の版の複製なので変化なし（unchanged は要素数）。点群だけ変わる。
    /// </summary>
    public static (JsonObject Diff, JsonObject Summary) BuildDiff(JsonObject source, JsonObject draft, string jobLabel, int unchangedElements, string user, string now)
    {
        var srcFolder = source["folder"]!.GetValue<string>();
        var a = PcSummary(source["pointcloud"] as JsonObject);
        var b = PcSummary(draft["pointcloud"] as JsonObject);
        var differences = new JsonArray { $"点群を「{jobLabel}」で処理（第{source["version"]}版から）" };
        var pa = (long)Num(a?["points"]);
        var pb = (long)Num(b?["points"]);
        if (pa != pb) differences.Add($"点数 {pa:N0} → {pb:N0}");
        if (a?["bounds"] is JsonObject ba && b?["bounds"] is JsonObject bb)
        {
            double d = 0;
            foreach (var k in new[] { "min", "max" })
                for (int i = 0; i < 3; i++)
                    d = Math.Max(d, Math.Abs(Num(ba[k]?[i]) - Num(bb[k]?[i])));
            if (d > 0.01) differences.Add($"範囲が最大 {d:F2} m 変化");
        }
        var diff = new JsonObject
        {
            ["version"] = 1,
            ["against"] = srcFolder,
            ["createdAt"] = now,
            ["models"] = new JsonObject
            {
                ["added"] = new JsonArray(),
                ["removed"] = new JsonArray(),
                ["changed"] = new JsonArray(),
                ["unchanged"] = unchangedElements,
            },
            ["pointcloud"] = new JsonObject
            {
                ["changed"] = true,
                ["base"] = a,
                ["current"] = b,
                ["differences"] = differences,
            },
            ["provenance"] = new JsonObject
            {
                ["base"] = Provenance(source, source["createdBy"]?.GetValue<string>() ?? "", source["createdAt"]?.GetValue<string>() ?? ""),
                ["current"] = Provenance(draft, user, now),
            },
        };
        var summary = new JsonObject
        {
            ["against"] = srcFolder,
            ["added"] = 0,
            ["removed"] = 0,
            ["changed"] = 0,
            ["pointcloudChanged"] = true,
        };
        return (diff, summary);
    }

    /// <summary>数の値（JSON から読んだ値・組み立てた値のどちらでも。数でなければ 0）</summary>
    private static double Num(JsonNode? n) =>
        n is JsonValue && double.TryParse(n.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : 0;

    /// <summary>elements.json の要素数（items のキーの数）</summary>
    public static int CountElements(string path)
    {
        using var fs = File.OpenRead(path);
        using var doc = JsonDocument.Parse(fs);
        return doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Object
            ? items.EnumerateObject().Count()
            : 0;
    }

    private static JsonObject? PcSummary(JsonObject? pc) => pc is null
        ? null
        : new JsonObject
        {
            ["sources"] = new JsonArray((pc["sources"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                .Select(s => (JsonNode)new JsonObject { ["name"] = s["name"]?.DeepClone(), ["size"] = s["size"]?.DeepClone(), ["sha256"] = s["sha256"]?.DeepClone() })
                .ToArray()),
            ["points"] = pc["points"]?.DeepClone(),
            ["scanCount"] = pc["scanCount"]?.DeepClone(),
            ["bounds"] = pc["bounds"]?.DeepClone(),
        };

    private static JsonObject Provenance(JsonObject m, string createdBy, string createdAt) => new()
    {
        ["folder"] = m["folder"]?.DeepClone(),
        ["version"] = m["version"]?.DeepClone(),
        ["createdBy"] = createdBy,
        ["createdAt"] = createdAt,
        ["models"] = new JsonArray((m["models"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Select(x => (JsonNode)new JsonObject { ["key"] = x["key"]?.DeepClone(), ["source"] = x["source"]?["name"]?.DeepClone(), ["sha256"] = x["source"]?["sha256"]?.DeepClone() })
            .ToArray()),
        ["pointcloud"] = new JsonArray(((m["pointcloud"] as JsonObject)?["sources"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Select(s => (JsonNode)new JsonObject { ["source"] = s["name"]?.DeepClone(), ["sha256"] = s["sha256"]?.DeepClone() })
            .ToArray()),
    };
}
