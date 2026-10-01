using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Unicode;

namespace ClashViewer.Host;

public static class JsonUtil
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        // 日本語をエスケープせずに書く（共有フォルダ上で人が読めるように）
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    public static readonly JsonSerializerOptions Compact = new()
    {
        WriteIndented = false,
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    public static JsonNode? ReadFile(string path)
    {
        using var fs = ResourceServer.OpenShared(path);
        return JsonNode.Parse(fs);
    }

    /// <summary>一時ファイルに書いてから置き換える（読み手が書きかけを見ないように）。</summary>
    public static void WriteFileAtomic(string path, JsonNode node)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, node.ToJsonString(Options), new System.Text.UTF8Encoding(false));
        File.Move(tmp, path, overwrite: true);
    }

    public static string NowIso() => DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz");
}
