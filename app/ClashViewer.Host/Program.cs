namespace ClashViewer.Host;

internal static class Program
{
    /// <summary>
    /// 引数（通常は不要。データは %LocalAppData%\ClashViewer\data、または settings.json の dataRoot に置く）
    ///   --root &lt;dir&gt;        データ（config/・datasets/・events/・issues/）のルートを指定する（開発・E2E 用）。
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

        // データフォルダの決定（settings.json の読込）より前にログを使えるようにする
        Log.Init(Path.Combine(AppPaths.Local, "logs"));
        var paths = new AppPaths(AppContext.BaseDirectory, AppPaths.ResolveRoot(root));
        Log.Info($"起動 app={paths.App} root={paths.Root} dev={dev} user={Environment.UserName}");
        ApplicationConfiguration.Initialize();
        if (!Directory.Exists(paths.Viewer))
        {
            MessageBox.Show($"画面のフォルダ（viewer）が見つかりません。\n{paths.Viewer}", "干渉ビューア", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            paths.EnsureFolders();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"データフォルダに書き込めません。\n{paths.Root}\n{ex.Message}", "干渉ビューア", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Application.Run(new MainForm(paths, dev, port, user));
    }
}
