namespace ClashViewer.Host;

internal static class Program
{
    /// <summary>
    /// 引数（通常は不要。exe を置いたフォルダが共有フォルダのルートになる）
    ///   --root &lt;dir&gt;        共有データ（config/・datasets/・events/・issues/）のルートを指定する。
    ///                       viewer/・tools/ は常に exe の隣を使う
    ///   --dev               開発モード（開発者ツール、テスト用の操作を有効にする）
    ///   --debug-port &lt;n&gt;    WebView2 のリモートデバッグ（E2E テスト用）
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        string root = AppContext.BaseDirectory;
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

        var paths = new AppPaths(AppContext.BaseDirectory, root);
        Log.Init(paths.Logs);
        Log.Info($"起動 app={paths.App} root={paths.Root} dev={dev} user={Environment.UserName}");
        ApplicationConfiguration.Initialize();
        if (!Directory.Exists(paths.Viewer))
        {
            MessageBox.Show($"画面のフォルダ（viewer）が見つかりません。\n{paths.Viewer}", "干渉ビューア", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            paths.EnsureShared();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"共有フォルダに書き込めません。\n{ex.Message}", "干渉ビューア", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Application.Run(new MainForm(paths, dev, port, user));
    }
}
