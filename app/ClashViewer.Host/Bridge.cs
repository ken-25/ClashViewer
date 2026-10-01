using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace ClashViewer.Host;

/// <summary>
/// 画面（JS）との RPC。画面は {id, method, params} を postMessage し、{id, result} か {id, error} を受け取る。
/// exe から画面への通知は {event, ...} で送る。
/// </summary>
public sealed class Bridge
{
    private readonly AppPaths _paths;
    private readonly string _user;
    private readonly bool _dev;
    private readonly LocalFiles _local;
    private readonly ImportService _imports;
    private readonly DatasetStore _datasets;
    private readonly EventStore _events;
    private readonly Form _owner;
    private CoreWebView2? _core;

    public Bridge(AppPaths paths, string user, bool dev, LocalFiles local, ImportService imports, DatasetStore datasets, EventStore events, Form owner)
    {
        _paths = paths;
        _user = user;
        _dev = dev;
        _local = local;
        _imports = imports;
        _datasets = datasets;
        _events = events;
        _owner = owner;
        _imports.Progress += evt => Post(new JsonObject { ["event"] = "import.progress", ["data"] = evt });
    }

    public void Attach(CoreWebView2 core)
    {
        _core = core;
        core.WebMessageReceived += OnMessage;
    }

    /// <summary>画面へ通知する。どのスレッドから呼んでもよい。</summary>
    public void Post(JsonObject msg)
    {
        var json = msg.ToJsonString(JsonUtil.Compact);
        if (_owner.IsDisposed) return;
        if (_owner.InvokeRequired) _owner.BeginInvoke(() => _core?.PostWebMessageAsJson(json));
        else _core?.PostWebMessageAsJson(json);
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonObject? msg = null;
        try
        {
            msg = JsonNode.Parse(e.WebMessageAsJson) as JsonObject;
        }
        catch
        {
            // 文字列メッセージ等は無視する
        }
        if (msg is null) return;
        var id = msg["id"]?.DeepClone();
        var method = msg["method"]?.GetValue<string>() ?? "";
        var p = msg["params"] as JsonObject ?? new JsonObject();
        // 追加オブジェクト（ドロップされたファイル）は UI スレッドのうちに取り出す
        List<string>? dropped = null;
        if (method == "dropFiles" && e.AdditionalObjects is { } extra)
        {
            dropped = new List<string>();
            for (int i = 0; i < extra.Count; i++)
                if (extra[i] is CoreWebView2File f) dropped.Add(f.Path);
        }
        try
        {
            var result = await Dispatch(method, p, dropped);
            Post(new JsonObject { ["id"] = id, ["result"] = result });
        }
        catch (Exception ex)
        {
            if (ex is not OperationCanceledException) Log.Error($"RPC {method} に失敗", ex);
            Post(new JsonObject
            {
                ["id"] = id,
                ["error"] = new JsonObject { ["message"] = ex.Message, ["type"] = ex.GetType().Name },
            });
        }
    }

    private async Task<JsonNode?> Dispatch(string method, JsonObject p, List<string>? dropped)
    {
        switch (method)
        {
            case "getContext":
                return GetContext();
            case "setMyName":
                SaveMember(p["name"]?.GetValue<string>() ?? _user);
                return GetContext();
            case "listDatasets":
                return await Task.Run(_datasets.List);
            case "pickFiles":
                return PickFiles();
            case "dropFiles":
                return Register(dropped ?? new List<string>());
            case "devRegisterPaths":
                if (!_dev) throw new UnauthorizedAccessException("開発モードでのみ使えます");
                return Register((p["paths"] as JsonArray ?? new JsonArray()).Select(n => n!.GetValue<string>()).ToList());
            case "importBegin":
                return _imports.Begin(p["name"]?.GetValue<string>() ?? "無題");
            case "importPointcloud":
            {
                var id = Req(p, "id");
                var paths = (p["tokens"] as JsonArray ?? new JsonArray())
                    .Select(n => _local.Resolve(n!.GetValue<string>()) ?? throw new FileNotFoundException("登録されていないファイルです"))
                    .ToList();
                return await _imports.RunPointcloud(id, paths);
            }
            case "importCarry":
            {
                var id = Req(p, "id");
                var files = (p["files"] as JsonArray ?? new JsonArray())
                    .Select(n => (n!["folder"]!.GetValue<string>(), n!["rel"]!.GetValue<string>()))
                    .ToList();
                return await _imports.CopyFromDatasets(id, files, p["task"]?.GetValue<string>() ?? "carry");
            }
            case "importFinish":
            {
                var id = Req(p, "id");
                var manifest = p["manifest"]?.DeepClone() as JsonObject ?? throw new ArgumentException("manifest がありません");
                return await Task.Run(() => _imports.Finish(id, manifest));
            }
            case "importAbort":
                _imports.Abort(Req(p, "id"));
                return true;
            case "updateAlignment":
            {
                var folder = Req(p, "folder");
                var alignment = p["alignment"] ?? throw new ArgumentException("alignment がありません");
                return await Task.Run(() => _datasets.UpdateAlignment(folder, alignment, _user));
            }
            case "eventsAppend":
            {
                var evt = p["event"]?.DeepClone() as JsonObject ?? throw new ArgumentException("event がありません");
                return await Task.Run(() => _events.Append(evt));
            }
            case "eventsRead":
                return await Task.Run(() => _events.Read(p["offsets"] as JsonObject));
            case "openDevTools":
                _core?.OpenDevToolsWindow();
                return true;
            default:
                throw new NotSupportedException($"不明な操作です: {method}");
        }
    }

    private static string Req(JsonObject p, string key) =>
        p[key]?.GetValue<string>() ?? throw new ArgumentException($"{key} がありません");

    private JsonObject GetContext()
    {
        var members = new JsonArray();
        if (Directory.Exists(_paths.Members))
        {
            foreach (var f in Directory.EnumerateFiles(_paths.Members, "*.json"))
            {
                try
                {
                    if (JsonUtil.ReadFile(f) is JsonObject m) members.Add(m);
                }
                catch
                {
                    Log.Warn($"メンバー情報を読めません: {f}");
                }
            }
        }
        JsonNode? config = null;
        var cfg = Path.Combine(_paths.Config, "app.json");
        if (File.Exists(cfg))
        {
            try
            {
                config = JsonUtil.ReadFile(cfg);
                (config as JsonObject)?.Remove("converterCommand");
            }
            catch
            {
                Log.Warn("config/app.json を読めません");
            }
        }
        var me = members.OfType<JsonObject>().FirstOrDefault(m => m["id"]?.GetValue<string>() == _user);
        return new JsonObject
        {
            ["user"] = _user,
            ["displayName"] = me?["name"]?.GetValue<string>() ?? _user,
            ["members"] = members,
            ["root"] = _paths.Root,
            ["dev"] = _dev,
            ["appVersion"] = typeof(Bridge).Assembly.GetName().Version?.ToString(),
            ["config"] = config ?? new JsonObject(),
        };
    }

    public void EnsureMember()
    {
        var f = Path.Combine(_paths.Members, EventStore.SafeName(_user) + ".json");
        if (!File.Exists(f)) SaveMember(_user);
    }

    private void SaveMember(string name)
    {
        Directory.CreateDirectory(_paths.Members);
        var f = Path.Combine(_paths.Members, EventStore.SafeName(_user) + ".json");
        JsonUtil.WriteFileAtomic(f, new JsonObject { ["id"] = _user, ["name"] = name.Trim(), ["updatedAt"] = JsonUtil.NowIso() });
    }

    private JsonArray PickFiles()
    {
        using var dlg = new OpenFileDialog
        {
            Title = "取り込むファイルを選んでください",
            Filter = "点群・IFC (*.e57;*.ifc)|*.e57;*.ifc|点群 (*.e57)|*.e57|IFC (*.ifc)|*.ifc",
            Multiselect = true,
        };
        return dlg.ShowDialog(_owner) == DialogResult.OK ? Register(dlg.FileNames.ToList()) : new JsonArray();
    }

    private JsonArray Register(List<string> paths)
    {
        var arr = new JsonArray();
        foreach (var path in paths)
        {
            if (Directory.Exists(path)) continue;
            var e = _local.Register(path);
            arr.Add(new JsonObject
            {
                ["token"] = e.Token,
                ["name"] = e.Name,
                ["path"] = e.Path,
                ["size"] = e.Size,
                ["kind"] = e.Kind,
                ["url"] = $"{ResourceServer.Origin}/local/{e.Token}",
            });
        }
        return arr;
    }
}
