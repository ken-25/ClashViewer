using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace Kasane.Host;

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
    private readonly JobService _jobs;
    private readonly DatasetStore _datasets;
    private readonly EventStore _events;
    private readonly Form _owner;
    private CoreWebView2? _core;

    public Bridge(AppPaths paths, string user, bool dev, LocalFiles local, ImportService imports, JobService jobs, DatasetStore datasets, EventStore events, Form owner)
    {
        _paths = paths;
        _user = user;
        _dev = dev;
        _local = local;
        _imports = imports;
        _jobs = jobs;
        _datasets = datasets;
        _events = events;
        _owner = owner;
        _imports.Progress += evt => Post(new JsonObject { ["event"] = "import.progress", ["data"] = evt });
        _jobs.Progress += evt => Post(new JsonObject { ["event"] = "job.progress", ["data"] = evt });
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
            case "jobKinds":
                return _jobs.ListKinds();
            case "jobList":
                return _jobs.ListActive();
            case "jobStart":
                return await Task.Run(() => _jobs.Start(Req(p, "kind"), Req(p, "folder"), p["params"] as JsonObject));
            case "jobAbort":
                return _jobs.Abort(Req(p, "jobId"));
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
            case "getStorage":
                return await Task.Run(GetStorage);
            case "pickFolder":
                return await PickFolder(Req(p, "kind"), p["initial"]?.GetValue<string>());
            case "inspectFolder":
            {
                var kind = Kind(Req(p, "kind"));
                var path = Req(p, "path");
                return await Task.Run(() => FolderCheck.Inspect(kind, path, _paths, probeWrite: true));
            }
            case "saveStorage":
                return await Task.Run(() => SaveStorage(
                    p["dataRoot"]?.GetValue<string>(), p["configRoot"]?.GetValue<string>(), p["copyConfig"]?.GetValue<bool>() ?? false));
            case "openFolder":
                OpenFolder(Req(p, "kind"));
                return true;
            case "restartApp":
                if (_imports.AnyActive) throw new InvalidOperationException("取込中は再起動できません。取込が終わってから操作してください。");
                if (_jobs.AnyActive) throw new InvalidOperationException("処理の実行中は再起動できません。処理が終わってから操作してください。");
                Program.RestartRequested = true;
                _owner.BeginInvoke(_owner.Close);
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
            ["configRoot"] = _paths.Config,
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

    private static string Kind(string kind) => kind switch
    {
        FolderCheck.Project or FolderCheck.ConfigKind => kind,
        _ => throw new ArgumentException($"不明な保存先の種類です: {kind}"),
    };

    /// <summary>設定画面の「保存先」に出す情報。今使っている場所と、settings.json に保存してある（次の起動で使う）場所。</summary>
    private JsonObject GetStorage()
    {
        var saved = StorageSettings.Load();
        var savedRoot = saved.DataRoot ?? AppPaths.DefaultRoot;
        var savedConfig = saved.ConfigRoot ?? AppPaths.DefaultConfigFor(savedRoot);
        var overridden = _paths.RootSource == "arg";
        return new JsonObject
        {
            ["project"] = new JsonObject
            {
                ["path"] = _paths.Root,
                ["source"] = _paths.RootSource,
                ["isDefault"] = StorageSettings.SamePath(_paths.Root, AppPaths.DefaultRoot),
                ["info"] = FolderCheck.Inspect(FolderCheck.Project, _paths.Root, _paths, probeWrite: false),
            },
            ["config"] = new JsonObject
            {
                ["path"] = _paths.Config,
                ["source"] = _paths.ConfigSource,
                ["isDefault"] = StorageSettings.SamePath(_paths.Config, AppPaths.DefaultConfigFor(_paths.Root)),
                ["info"] = FolderCheck.Inspect(FolderCheck.ConfigKind, _paths.Config, _paths, probeWrite: false),
            },
            ["saved"] = new JsonObject
            {
                ["dataRoot"] = saved.DataRoot,
                ["configRoot"] = saved.ConfigRoot,
                ["projectPath"] = savedRoot,
                ["configPath"] = savedConfig,
            },
            ["defaultRoot"] = AppPaths.DefaultRoot,
            // --root で起動しているときは settings.json を見ない（保存はできるが、--root なしの起動で効く）
            ["overridden"] = overridden,
            // 保存したが、まだ再起動していない
            ["restartPending"] = !overridden
                && !(StorageSettings.SamePath(savedRoot, _paths.Root) && StorageSettings.SamePath(savedConfig, _paths.Config)),
            ["importing"] = _imports.AnyActive,
            ["local"] = new JsonObject
            {
                ["folder"] = AppPaths.Local,
                ["settingsFile"] = AppPaths.SettingsFile,
                ["logs"] = _paths.Logs,
                ["work"] = _paths.Work,
                ["webview"] = _paths.WebViewData,
            },
        };
    }

    private async Task<JsonNode?> PickFolder(string kind, string? initial)
    {
        kind = Kind(kind);
        string? chosen;
        // ダイアログは UI スレッドで出す（OnMessage から await 前に呼ばれるので UI スレッド）
        using (var dlg = new FolderBrowserDialog
        {
            Description = kind == FolderCheck.Project
                ? "プロジェクトフォルダ（点群・モデル・指摘を保存する場所）を選んでください"
                : "設定データフォルダ（app.json・メンバーを保存する場所）を選んでください",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
        })
        {
            var start = !string.IsNullOrWhiteSpace(initial) ? initial : kind == FolderCheck.Project ? _paths.Root : _paths.Config;
            if (Directory.Exists(start)) dlg.InitialDirectory = start;
            chosen = dlg.ShowDialog(_owner) == DialogResult.OK ? dlg.SelectedPath : null;
        }
        if (string.IsNullOrWhiteSpace(chosen)) return null;
        return await Task.Run(() => FolderCheck.Inspect(kind, chosen, _paths, probeWrite: true));
    }

    /// <summary>
    /// 保存先を settings.json に保存する（null は既定）。反映は再起動後。
    /// 今あるデータは移動しない。copyConfig なら設定データ（app.json・members）だけ新しい場所へ写す（上書きはしない）。
    /// </summary>
    private JsonObject SaveStorage(string? dataRoot, string? configRoot, bool copyConfig)
    {
        if (_imports.AnyActive) throw new InvalidOperationException("取込中は保存先を変えられません。取込が終わってから操作してください。");
        if (string.IsNullOrWhiteSpace(dataRoot)) dataRoot = null;
        if (string.IsNullOrWhiteSpace(configRoot)) configRoot = null;

        var project = FolderCheck.Inspect(FolderCheck.Project, dataRoot ?? AppPaths.DefaultRoot, _paths, probeWrite: false);
        var errors = (project["errors"] as JsonArray)!.Select(e => $"プロジェクトフォルダ: {e}").ToList();
        if (errors.Count > 0) throw new InvalidOperationException(string.Join("\n", errors));
        var newRoot = project["path"]!.GetValue<string>();
        var config = FolderCheck.Inspect(FolderCheck.ConfigKind, configRoot ?? AppPaths.DefaultConfigFor(newRoot), _paths, probeWrite: false);
        errors = (config["errors"] as JsonArray)!.Select(e => $"設定データフォルダ: {e}").ToList();
        var newConfig = config["path"]!.GetValue<string>();
        foreach (var sub in new[] { "datasets", "events", "issues" })
            if (StorageSettings.IsUnder(newConfig, Path.Combine(newRoot, sub)))
                errors.Add($"設定データフォルダ: プロジェクトフォルダの {sub} の中には置けません。");
        if (errors.Count > 0) throw new InvalidOperationException(string.Join("\n", errors));

        // 実際に作って書けるかを確かめてから保存する（起動できない設定を残さない）
        foreach (var (dir, label) in new[] { (newRoot, "プロジェクトフォルダ"), (newConfig, "設定データフォルダ") })
        {
            var (ok, message) = FolderCheck.ProbeWrite(dir);
            if (!ok) throw new InvalidOperationException($"{label}に書き込めません: {dir}\n{message}");
        }
        var copied = copyConfig ? FolderCheck.CopyConfig(_paths.Config, newConfig) : 0;
        StorageSettings.Save(dataRoot is null ? null : newRoot, configRoot is null ? null : newConfig);
        var result = GetStorage();
        result["copied"] = copied;
        return result;
    }

    /// <summary>エクスプローラーで開く。開けるのは決まった保存先だけ（画面から任意のパスは渡さない）。</summary>
    private void OpenFolder(string kind)
    {
        var dir = kind switch
        {
            "project" => _paths.Root,
            "config" => _paths.Config,
            "local" => AppPaths.Local,
            "logs" => _paths.Logs,
            "work" => _paths.Work,
            _ => throw new ArgumentException($"不明なフォルダです: {kind}"),
        };
        if (!Directory.Exists(dir)) throw new DirectoryNotFoundException($"フォルダがありません: {dir}");
        var psi = new System.Diagnostics.ProcessStartInfo("explorer.exe") { UseShellExecute = false };
        psi.ArgumentList.Add(dir);
        System.Diagnostics.Process.Start(psi);
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
