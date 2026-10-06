using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Kasane.Host;

public sealed class MainForm : Form
{
    private readonly AppPaths _paths;
    private readonly bool _dev;
    private readonly int? _debugPort;
    private readonly string _user;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly ImportService _imports;
    private readonly JobService _jobs;
    private readonly ResourceServer _server;
    private readonly Bridge _bridge;

    /// <summary>WebView2 のブラウザープロセス。再起動の前に終わるのを待つ（同じプロファイルを続けて使うため）。</summary>
    public int? BrowserProcessId { get; private set; }

    public MainForm(AppPaths paths, bool dev, int? debugPort, string? userOverride = null)
    {
        _paths = paths;
        _dev = dev;
        _debugPort = debugPort;
        // 利用者は Windows のログオン名。開発モードに限り --user で差し替えられる（複数人の E2E 用）
        var user = dev && !string.IsNullOrWhiteSpace(userOverride) ? userOverride : Environment.UserName;
        _user = user;
        var local = new LocalFiles();
        _imports = new ImportService(paths, user);
        var datasets = new DatasetStore(paths);
        _jobs = new JobService(paths, user, dev, datasets);
        _server = new ResourceServer(paths, local, _imports);
        _bridge = new Bridge(paths, user, dev, local, _imports, _jobs, datasets, new EventStore(paths, user), this);

        Text = "3D施工検討Viewer Kasane";
        // タイトルバー・タスクバーのアイコン（app.ico を同梱したときだけ。csproj 参照）
        using (var ico = typeof(MainForm).Assembly.GetManifestResourceStream("Kasane.app.ico"))
        {
            if (ico != null) Icon = new Icon(ico);
        }
        Width = 1600;
        Height = 960;
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
        FormClosing += (_, _) =>
        {
            _imports.AbortAll();
            _jobs.AbortAll();
        };
    }

    private bool ReadConfigBool(string key, bool fallback)
    {
        try
        {
            var f = Path.Combine(_paths.Config, "app.json");
            if (File.Exists(f) && JsonUtil.ReadFile(f)?[key] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<bool>(out var b)) return b;
        }
        catch (Exception ex)
        {
            Log.Warn($"config/app.json を読めません: {ex.Message}");
        }
        return fallback;
    }

    private async Task InitAsync()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions();
            var args = new List<string>();
            if (_debugPort is int port) args.Add($"--remote-debugging-port={port}");
            // GPU が 2 つあるノート PC では既定で内蔵 GPU が選ばれる。点群は重いので外部 GPU を優先する
            // （config/app.json の "highPerformanceGpu": false で無効にできる）
            if (ReadConfigBool("highPerformanceGpu", true)) args.Add("--force_high_performance_gpu");
            options.AdditionalBrowserArguments = string.Join(' ', args);
            // プロファイルは %LocalAppData%\Kasane に置く（既定の「exe の隣」だとインストール先に書き込んでしまう）
            // 同じプロファイルを別の起動引数で同時に使えないため、開発用の別利用者はプロファイルを分ける
            var profile = _user == Environment.UserName ? _paths.WebViewData : $"{_paths.WebViewData}-{EventStore.SafeName(_user)}";
            var env = await CoreWebView2Environment.CreateAsync(null, profile, options);
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            BrowserProcessId = (int)core.BrowserProcessId;
            core.Settings.AreDevToolsEnabled = _dev;
            core.Settings.AreDefaultContextMenusEnabled = _dev;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = _dev;
            core.Settings.IsZoomControlEnabled = false;
            // 外部へは出ない。kasane.local 以外への移動は止める
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith(ResourceServer.Origin, StringComparison.OrdinalIgnoreCase) && !e.Uri.StartsWith("about:", StringComparison.Ordinal))
                {
                    Log.Warn($"移動を止めました: {e.Uri}");
                    e.Cancel = true;
                }
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            if (_dev)
            {
                // 懸念2の確認用: 仮想ホストのフォルダ割り当てが Range に応えるかを比べるため
                core.SetVirtualHostNameToFolderMapping("raw.kasane.local", _paths.Root, CoreWebView2HostResourceAccessKind.Allow);
            }
            _server.Attach(core, env);
            _bridge.Attach(core);
            _bridge.EnsureMember();
            Text = $"3D施工検討Viewer Kasane — {_paths.Root}";
            core.Navigate($"{ResourceServer.Origin}/index.html");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this, "WebView2 ランタイムが見つかりません。情報システム担当に導入を依頼してください。", "3D施工検討Viewer Kasane", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
        catch (Exception ex)
        {
            Log.Error("起動に失敗", ex);
            MessageBox.Show(this, $"起動に失敗しました。\n{ex.Message}", "3D施工検討Viewer Kasane", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
