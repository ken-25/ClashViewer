namespace Kasane.Host;

internal static class Program
{
    /// <summary>
    /// 引数（通常は不要。保存先は設定画面で選び、settings.json の dataRoot / configRoot に保存する）
    ///   --root &lt;dir&gt;        プロジェクトフォルダ（datasets/・events/・issues/）を指定する（開発・E2E 用）。
    ///                       設定データは &lt;dir&gt;\config を使い、settings.json は見ない。
    ///                       viewer/・tools/ は常に exe の隣を使う
    ///   --dev               開発モード（開発者ツール、テスト用の操作を有効にする）
    ///   --debug-port &lt;n&gt;    WebView2 のリモートデバッグ（E2E テスト用）
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        string? root = null;
        bool dev = false;
        int? port = null;
        string? user = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--user" when i + 1 < args.Length:
                    user = args[++i];
                    break;
                case "--root" when i + 1 < args.Length:
                    root = args[++i];
                    break;
                case "--dev":
                    dev = true;
                    break;
                case "--debug-port" when i + 1 < args.Length && int.TryParse(args[i + 1], out var p):
                    port = p;
                    i++;
                    break;
            }
        }

        // 保存先の決定（settings.json の読込）より前にログを使えるようにする
        Log.Init(Path.Combine(AppPaths.Local, "logs"));
        var paths = AppPaths.Resolve(AppContext.BaseDirectory, root);
        Log.Info($"起動 app={paths.App} root={paths.Root}({paths.RootSource}) config={paths.Config}({paths.ConfigSource}) dev={dev} user={Environment.UserName}");
        ApplicationConfiguration.Initialize();
        if (!Directory.Exists(paths.Viewer))
        {
            MessageBox.Show($"画面のフォルダ（viewer）が見つかりません。\n{paths.Viewer}", "3D施工検討Viewer Kasane", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            paths.EnsureFolders();
        }
        catch (Exception ex)
        {
            Log.Error("保存先に書き込めません", ex);
            // 設定画面で選んだ保存先（外付けドライブを外した等）が使えないときは、既定の保存先で起動できるようにする。
            // 設定画面へたどり着けないまま起動できなくなるのを防ぐため。settings.json は書き換えない
            var fromSettings = paths.RootSource == "settings" || paths.ConfigSource == "settings";
            if (!fromSettings)
            {
                MessageBox.Show($"保存先に書き込めません。\n{paths.Root}\n{ex.Message}", "3D施工検討Viewer Kasane", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            var answer = MessageBox.Show(
                $"設定した保存先を使えません。\n\nプロジェクトフォルダ: {paths.Root}\n設定データフォルダ: {paths.Config}\n\n{ex.Message}\n\n" +
                "今回だけ既定の保存先で起動しますか？\n（設定画面から保存先を選び直せます）",
                "3D施工検討Viewer Kasane", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes) return;
            paths = new AppPaths(AppContext.BaseDirectory, AppPaths.DefaultRoot, null, "fallback");
            try
            {
                paths.EnsureFolders();
            }
            catch (Exception ex2)
            {
                MessageBox.Show($"既定の保存先にも書き込めません。\n{paths.Root}\n{ex2.Message}", "3D施工検討Viewer Kasane", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }
        var form = new MainForm(paths, dev, port, user);
        Application.Run(form);

        // 設定画面で保存先を変えたときは、同じ引数で起動し直す（画面とサービスを新しい保存先で作り直すため）
        if (RestartRequested && Environment.ProcessPath is { } exe)
        {
            // 前の WebView2 が終わりきる前に同じプロファイルで作ると、画面の初期化に失敗することがある
            if (form.BrowserProcessId is int pid)
            {
                try
                {
                    using var browser = System.Diagnostics.Process.GetProcessById(pid);
                    if (!browser.WaitForExit(10_000)) Log.Warn("WebView2 の終了を待ちきれませんでした");
                }
                catch (ArgumentException)
                {
                    // もう終わっている
                }
            }
            var psi = new System.Diagnostics.ProcessStartInfo(exe) { UseShellExecute = false };
            foreach (var a in args) psi.ArgumentList.Add(a);
            Log.Info("保存先の変更のため再起動します");
            System.Diagnostics.Process.Start(psi);
        }
    }

    /// <summary>画面を閉じたあとに起動し直す（設定画面の「保存して再起動」）。</summary>
    internal static bool RestartRequested { get; set; }
}
