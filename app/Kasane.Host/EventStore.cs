using System.Text;
using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>
/// events/&lt;ユーザー&gt;.jsonl。各自が自分のファイルにだけ追記し、全員分を読んで重ねる。
/// 同じファイルに複数人が書かないので、Box Drive の同期で衝突しない。
/// </summary>
public sealed class EventStore
{
    private readonly AppPaths _paths;
    private readonly string _user;
    private readonly object _gate = new();

    public EventStore(AppPaths paths, string user)
    {
        _paths = paths;
        _user = user;
    }

    public string MyFile => Path.Combine(_paths.Events, SafeName(_user) + ".jsonl");

    public static string SafeName(string s)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder();
        foreach (var c in s) sb.Append(invalid.Contains(c) ? '_' : c);
        return sb.ToString();
    }

    public JsonObject Append(JsonObject evt)
    {
        evt["by"] = _user;
        evt["at"] ??= JsonUtil.NowIso();
        evt["eid"] ??= Guid.NewGuid().ToString("N");
        var line = evt.ToJsonString(JsonUtil.Compact) + "\n";
        lock (_gate)
        {
            Directory.CreateDirectory(_paths.Events);
            using var fs = new FileStream(MyFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            var bytes = new UTF8Encoding(false).GetBytes(line);
            fs.Write(bytes);
            fs.Flush(true);
        }
        return evt;
    }

    /// <summary>
    /// 全員のイベントを読む。offsets（ファイル名→読み済みバイト位置）を渡すと続きだけ返す。
    /// 改行で終わっていない最後の行（同期途中）は次回に回す。
    /// </summary>
    public JsonObject Read(JsonObject? offsets)
    {
        var events = new JsonArray();
        var next = new JsonObject();
        if (Directory.Exists(_paths.Events))
        {
            foreach (var file in Directory.EnumerateFiles(_paths.Events, "*.jsonl"))
            {
                var name = Path.GetFileName(file);
                long from = offsets?[name]?.GetValue<long>() ?? 0;
                try
                {
                    using var fs = ResourceServer.OpenShared(file);
                    if (from > fs.Length) from = 0; // ファイルが置き換わった
                    fs.Seek(from, SeekOrigin.Begin);
                    using var ms = new MemoryStream();
                    fs.CopyTo(ms);
                    var buf = ms.ToArray();
                    int lastNl = Array.LastIndexOf(buf, (byte)'\n');
                    if (lastNl >= 0)
                    {
                        var text = Encoding.UTF8.GetString(buf, 0, lastNl + 1);
                        foreach (var line in text.Split('\n'))
                        {
                            if (string.IsNullOrWhiteSpace(line)) continue;
                            try
                            {
                                if (JsonNode.Parse(line) is JsonObject o)
                                {
                                    o["_file"] = name;
                                    events.Add(o);
                                }
                            }
                            catch
                            {
                                Log.Warn($"イベント行を読めません: {name}");
                            }
                        }
                        from += lastNl + 1;
                    }
                }
                catch (IOException ex)
                {
                    Log.Warn($"イベントファイルを読めません: {name}: {ex.Message}");
                }
                next[name] = from;
            }
        }
        return new JsonObject { ["events"] = events, ["offsets"] = next };
    }
}
