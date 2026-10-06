using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>
/// manifest.json の版（schema）と、ホストが書くときに揃える既定値。
///
/// schema 1 → 2 の違い（追加だけ。既存の項目の意味は変えない）
/// - derived: 公開後に追記する派生成果物（干渉結果・分類・メッシュなど）の一覧。各要素は derived/&lt;ID&gt;/ を指す
/// - parent:  点群の処理などで既存の版から作った版のとき、その元（{ folder, jobKind, note }）。取込で作った版は null
///
/// 読む側（画面）は schema 1 も読めること（viewer/src/data/dataset.ts の migrateManifest）。
/// </summary>
public static class Manifest
{
    public const int Schema = 2;

    /// <summary>schema 2 の項目が無ければ既定値を入れる（ファイルには書かない。書くのは呼び出し側）</summary>
    public static void EnsureDefaults(JsonObject m)
    {
        if (m["derived"] is not JsonArray) m["derived"] = new JsonArray();
        if (!m.ContainsKey("parent")) m["parent"] = null;
    }
}
