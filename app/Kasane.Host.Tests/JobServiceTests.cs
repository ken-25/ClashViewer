using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Kasane.Host;
using Xunit;

namespace Kasane.Host.Tests;

/// <summary>
/// JobService の待ち行列・結果の公開（derived / newVersion）・中断。
/// 変換エンジンは差し替え（FakeRunner）、データは一時フォルダに作る。
/// </summary>
public sealed class JobServiceTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "kasane-host-test-" + Guid.NewGuid().ToString("N")[..8]);
    private readonly AppPaths _paths;
    private readonly DatasetStore _datasets;
    private readonly ImportService _imports;
    private readonly ConcurrentQueue<JsonObject> _events = new();

    public JobServiceTests()
    {
        _paths = new AppPaths(Path.Combine(_tmp, "app"), Path.Combine(_tmp, "root")) { Work = Path.Combine(_tmp, "work") };
        _paths.EnsureFolders();
        _datasets = new DatasetStore(_paths);
        _imports = new ImportService(_paths, "tester");
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_tmp, true);
        }
        catch
        {
            // 片付けの失敗はテストの結果にしない
        }
    }

    // ---- 準備 ----

    private const string Source = "20260101_現場_aaaaaa";

    /// <summary>点群とモデル 1 つを持つ公開済みの版（第 1 版）</summary>
    private void MakeDataset(string folder = Source, bool pointcloud = true, int version = 1, string site = "aaaaaa", bool images = false)
    {
        var dir = Path.Combine(_paths.Datasets, folder);
        if (images)
        {
            Directory.CreateDirectory(Path.Combine(dir, "images"));
            File.WriteAllText(Path.Combine(dir, "images", "00_0000.jpg"), "pano");
        }
        Directory.CreateDirectory(Path.Combine(dir, "pointcloud"));
        Directory.CreateDirectory(Path.Combine(dir, "model"));
        foreach (var f in NewVersion.PointcloudFiles) File.WriteAllText(Path.Combine(dir, "pointcloud", f), "old-" + f);
        File.WriteAllText(Path.Combine(dir, "model", "A.frag"), "frag");
        File.WriteAllText(Path.Combine(dir, "model", "A.elements.json"), """{"version":1,"items":{"g1":{},"g2":{},"g3":{}}}""");
        var m = new JsonObject
        {
            ["schema"] = 2,
            ["id"] = folder[^6..],
            ["name"] = "現場",
            ["site"] = site,
            ["version"] = version,
            ["previous"] = null,
            ["state"] = "ready",
            ["createdBy"] = "someone",
            ["createdAt"] = "2026-01-01T00:00:00.000+09:00",
            ["origin"] = new JsonArray(10, 20, 0),
            ["pointcloud"] = pointcloud
                ? new JsonObject
                {
                    ["owner"] = folder,
                    ["dir"] = "pointcloud",
                    ["sources"] = new JsonArray(new JsonObject
                    {
                        ["name"] = "a.e57",
                        ["size"] = 1,
                        ["sha256"] = "x",
                        ["images"] = images
                            ? new JsonArray(
                                new JsonObject { ["name"] = "pano", ["kind"] = "spherical", ["file"] = "images/00_0000.jpg" },
                                // 書き出せなかった画像（file が null）は複製しない
                                new JsonObject { ["name"] = "broken", ["kind"] = "pinhole", ["file"] = null })
                            : new JsonArray(),
                    }),
                    ["points"] = 100,
                    ["scanCount"] = 2,
                    ["bounds"] = new JsonObject { ["min"] = new JsonArray(0, 0, 0), ["max"] = new JsonArray(1, 1, 1) },
                }
                : null,
            ["models"] = new JsonArray(new JsonObject { ["key"] = "A", ["owner"] = folder, ["file"] = "model/A.frag", ["elements"] = "model/A.elements.json", ["source"] = new JsonObject { ["name"] = "A.ifc", ["sha256"] = "y" } }),
            ["alignment"] = new JsonObject { ["method"] = "identity", ["matrix"] = new JsonArray(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) },
            ["diff"] = null,
            ["importLog"] = new JsonArray(),
            ["derived"] = new JsonArray(),
            ["parent"] = null,
        };
        JsonUtil.WriteFileAtomic(Path.Combine(dir, "manifest.json"), m);
    }

    /// <summary>変換エンジンの代わり。ジョブごとに Release されるまで待ち、out/ に書いて result を返す</summary>
    private sealed class FakeRunner
    {
        public readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> Gates = new();
        public readonly ConcurrentQueue<string> Started = new();
        public Action<string>? WriteOut;

        public async Task<JsonObject> Run(string command, IReadOnlyList<string> args, Action<JsonObject> onEvent, CancellationToken ct)
        {
            var outDir = args[args.ToList().IndexOf("--out") + 1];
            var jobDir = Path.GetFileName(Path.GetDirectoryName(outDir)!);
            Started.Enqueue(jobDir);
            onEvent(new JsonObject { ["event"] = "stage", ["stage"] = "s", ["label"] = "段階", ["weight"] = 1.0 });
            var gate = Gates.GetOrAdd(jobDir, _ => new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously));
            using (ct.Register(() => gate.TrySetCanceled(ct)))
            {
                var result = await gate.Task;
                WriteOut?.Invoke(outDir);
                return result;
            }
        }

        public void Release(string jobId, JsonObject? result = null) =>
            Gates.GetOrAdd($"job-{jobId}", _ => new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously))
                .TrySetResult(result ?? new JsonObject { ["ok"] = true });

        public void Fail(string jobId) =>
            Gates.GetOrAdd($"job-{jobId}", _ => new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously))
                .TrySetException(new InvalidOperationException("変換に失敗しました"));
    }

    private JobService Service(FakeRunner runner, params JobService.JobKind[] kinds)
    {
        var svc = new JobService(_paths, "tester", dev: false, _datasets, _imports,
            kinds.Length > 0 ? kinds : new[] { new JobService.JobKind("calc", "calc", "計算") },
            runner.Run, maxParallel: 1);
        svc.Progress += e => _events.Enqueue(e);
        return svc;
    }

    private async Task<JsonObject> WaitEvent(string jobId, string evt, int timeoutMs = 10000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < until)
        {
            var hit = _events.FirstOrDefault(e => e["jobId"]?.GetValue<string>() == jobId && e["event"]?.GetValue<string>() == evt);
            if (hit is not null) return hit;
            await Task.Delay(20);
        }
        throw new TimeoutException($"{jobId} の {evt} が届きません。届いた通知: {string.Join(", ", _events.Select(e => $"{e["jobId"]}:{e["event"]}{(e["message"] is JsonNode msg ? $"({msg})" : "")}"))}");
    }

    private static async Task Until(Func<bool> cond, int timeoutMs = 10000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!cond())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException();
            await Task.Delay(20);
        }
    }

    private JsonObject ManifestOf(string folder) => (JsonObject)JsonUtil.ReadFile(Path.Combine(_paths.Datasets, folder, "manifest.json"))!;

    // ---- 待ち行列 ----

    [Fact]
    public async Task 一度に動くのは1本で残りは順に待つ()
    {
        MakeDataset();
        var runner = new FakeRunner();
        var svc = Service(runner);
        var a = svc.Start("calc", Source, null)["jobId"]!.GetValue<string>();
        var b = svc.Start("calc", Source, null)["jobId"]!.GetValue<string>();
        var c = svc.Start("calc", Source, null)["jobId"]!.GetValue<string>();

        await WaitEvent(a, "started");
        await Until(() => runner.Started.Count == 1);
        var active = svc.ListActive();
        Assert.Equal(new[] { a, b, c }, active.Select(j => j!["jobId"]!.GetValue<string>()));
        Assert.Equal(new[] { "running", "queued", "queued" }, active.Select(j => j!["status"]!.GetValue<string>()));
        Assert.Equal(new[] { 0, 1, 2 }, active.Select(j => j!["position"]!.GetValue<int>()));
        Assert.Single(runner.Started);

        // 待っている c を取り消すと、b の位置は変わらず c は動かない
        Assert.True(svc.Abort(c));
        await WaitEvent(c, "aborted");
        runner.Release(a);
        await WaitEvent(a, "done");
        await WaitEvent(b, "started");
        // started の通知は変換エンジンを呼ぶ直前に出る。呼ばれるまで待つ
        await Until(() => runner.Started.Count == 2);
        Assert.Equal(new[] { $"job-{a}", $"job-{b}" }, runner.Started.ToArray());
        runner.Release(b);
        await WaitEvent(b, "done");
        await Until(() => !svc.AnyActive);
        Assert.Equal(2, ManifestOf(Source)["derived"]!.AsArray().Count);
        Assert.False(Directory.Exists(Path.Combine(_paths.Work, $"job-{c}")), "取り消した処理の作業用フォルダは消える");
    }

    [Fact]
    public async Task 失敗しても次の処理が始まる()
    {
        MakeDataset();
        var runner = new FakeRunner();
        var svc = Service(runner);
        var a = svc.Start("calc", Source, null)["jobId"]!.GetValue<string>();
        var b = svc.Start("calc", Source, null)["jobId"]!.GetValue<string>();
        await WaitEvent(a, "started");
        runner.Fail(a);
        var failed = await WaitEvent(a, "failed");
        Assert.Contains("変換に失敗", failed["message"]!.GetValue<string>());
        await WaitEvent(b, "started");
        runner.Release(b);
        await WaitEvent(b, "done");
    }

    [Fact]
    public async Task 動いている処理を中断すると結果は残らない()
    {
        MakeDataset();
        var runner = new FakeRunner();
        var svc = Service(runner);
        var a = svc.Start("calc", Source, null)["jobId"]!.GetValue<string>();
        await WaitEvent(a, "started");
        Assert.True(svc.Abort(a));
        await WaitEvent(a, "aborted");
        await Until(() => !svc.AnyActive);
        Assert.Empty(ManifestOf(Source)["derived"]!.AsArray());
        Assert.False(Directory.Exists(Path.Combine(_paths.Datasets, Source, "derived")));
        Assert.False(svc.Abort(a), "終わった処理は中断できない");
    }

    // ---- 受付の検査 ----

    [Fact]
    public void 点群の無い版や不明な処理は受け付けない()
    {
        MakeDataset(pointcloud: false);
        var svc = Service(new FakeRunner(), new JobService.JobKind("pc", "pc", "点群処理") { NeedsPointcloud = true },
            new JobService.JobKind("dev", "dev", "開発用", DevOnly: true));
        Assert.Throws<InvalidOperationException>(() => svc.Start("pc", Source, null));
        Assert.Throws<NotSupportedException>(() => svc.Start("dev", Source, null));
        Assert.Throws<NotSupportedException>(() => svc.Start("nope", Source, null));
        Assert.Throws<DirectoryNotFoundException>(() => svc.Start("pc", "20990101_none_000000", null));
        Assert.Throws<UnauthorizedAccessException>(() => svc.Start("pc", ".importing", null));
        Assert.False(svc.AnyActive);
        var kinds = svc.ListKinds();
        Assert.Single(kinds);
        Assert.Equal("derived", kinds[0]!["target"]!.GetValue<string>());
    }

    // ---- 結果の公開 ----

    [Fact]
    public async Task derived_結果を版の成果に追記する()
    {
        MakeDataset();
        var runner = new FakeRunner { WriteOut = o => { Directory.CreateDirectory(Path.Combine(o, "sub")); File.WriteAllText(Path.Combine(o, "sub", "r.json"), "{}"); } };
        var svc = Service(runner);
        var a = svc.Start("calc", Source, new JsonObject { ["x"] = 1 })["jobId"]!.GetValue<string>();
        runner.Release(a, new JsonObject { ["count"] = 3 });
        var done = await WaitEvent(a, "done");
        var entry = done["entry"]!.AsObject();
        Assert.Equal($"derived/{a}", entry["dir"]!.GetValue<string>());
        Assert.Equal($"derived/{a}/sub/r.json", entry["files"]![0]!.GetValue<string>());
        Assert.Equal(3, entry["result"]!["count"]!.GetValue<int>());
        Assert.True(File.Exists(Path.Combine(_paths.Datasets, Source, "derived", a, "sub", "r.json")));
        var m = ManifestOf(Source);
        Assert.Equal(a, m["derived"]![0]!["id"]!.GetValue<string>());
        Assert.Equal(1, m["derived"]![0]!["params"]!["x"]!.GetValue<int>());
    }

    private static readonly JobService.JobKind Clean = new("clean", "clean", "点群の清掃") { Target = JobService.JobTarget.NewVersion, NeedsPointcloud = true };

    private static void WritePointcloud(string outDir)
    {
        var pc = Path.Combine(outDir, "pointcloud");
        Directory.CreateDirectory(pc);
        foreach (var f in NewVersion.PointcloudFiles) File.WriteAllText(Path.Combine(pc, f), "new-" + f);
    }

    private static JsonObject PcResult() => new()
    {
        ["pointcloud"] = new JsonObject
        {
            ["points"] = 60,
            ["bounds"] = new JsonObject { ["min"] = new JsonArray(0, 0, 0), ["max"] = new JsonArray(1, 1, 0.5) },
            ["classCounts"] = new JsonObject { ["2"] = 40, ["6"] = 20 },
            ["attributes"] = new JsonArray("position", "classification"),
        },
    };

    [Fact]
    public async Task newVersion_点群を作り直した版をparent付きで公開する()
    {
        MakeDataset();
        // 同じプロジェクトに第 2 版が既にある → 第 3 版になる
        MakeDataset("20260102_現場_bbbbbb", version: 2);
        var before = File.ReadAllText(Path.Combine(_paths.Datasets, Source, "manifest.json"));
        var runner = new FakeRunner { WriteOut = WritePointcloud };
        var svc = Service(runner, Clean);
        var a = svc.Start("clean", Source, new JsonObject { ["note"] = "床のノイズ" })["jobId"]!.GetValue<string>();
        runner.Release(a, PcResult());
        var done = await WaitEvent(a, "done");
        var v = done["version"]!.AsObject();
        var folder = v["folder"]!.GetValue<string>();
        Assert.NotEqual(Source, folder);

        var m = ManifestOf(folder);
        Assert.Equal("ready", m["state"]!.GetValue<string>());
        Assert.Equal(2, m["schema"]!.GetValue<int>());
        Assert.Equal(3, m["version"]!.GetValue<int>());
        Assert.Equal("aaaaaa", m["site"]!.GetValue<string>());
        Assert.Equal(Source, m["previous"]!.GetValue<string>());
        Assert.Equal(Source, m["parent"]!["folder"]!.GetValue<string>());
        Assert.Equal("clean", m["parent"]!["jobKind"]!.GetValue<string>());
        Assert.Equal("床のノイズ", m["parent"]!["note"]!.GetValue<string>());
        Assert.Equal("tester", m["createdBy"]!.GetValue<string>());
        Assert.Empty(m["derived"]!.AsArray());
        // 点群は新しいもの、元の記録（sources）は引き継ぐ
        var pc = m["pointcloud"]!.AsObject();
        Assert.Equal(folder, pc["owner"]!.GetValue<string>());
        Assert.Equal(60, pc["points"]!.GetValue<int>());
        Assert.Equal(40, pc["classCounts"]!["2"]!.GetValue<int>());
        Assert.Equal("a.e57", pc["sources"]![0]!["name"]!.GetValue<string>());
        Assert.Equal(Source, pc["derivedFrom"]!["folder"]!.GetValue<string>());
        Assert.Equal("new-octree.bin", File.ReadAllText(Path.Combine(_paths.Datasets, folder, "pointcloud", "octree.bin")));
        // モデル・原点・座標合わせは元の版と同じ。ファイルは新しい版へ複製
        var model = m["models"]![0]!.AsObject();
        Assert.Equal(folder, model["owner"]!.GetValue<string>());
        Assert.Equal(Source, model["carriedFrom"]!.GetValue<string>());
        Assert.True(File.Exists(Path.Combine(_paths.Datasets, folder, "model", "A.frag")));
        Assert.Equal(10, m["origin"]![0]!.GetValue<int>());
        Assert.Equal("identity", m["alignment"]!["method"]!.GetValue<string>());
        // 差分（元の版と比べる）
        Assert.True(m["diff"]!["pointcloudChanged"]!.GetValue<bool>());
        var diff = (JsonObject)JsonUtil.ReadFile(Path.Combine(_paths.Datasets, folder, "diff.json"))!;
        Assert.Equal(Source, diff["against"]!.GetValue<string>());
        Assert.Equal(3, diff["models"]!["unchanged"]!.GetValue<int>());
        Assert.Contains(diff["pointcloud"]!["differences"]!.AsArray(), d => d!.GetValue<string>().Contains("100 → 60"));
        // 元の版には触れない
        Assert.Equal(before, File.ReadAllText(Path.Combine(_paths.Datasets, Source, "manifest.json")));
        Assert.Equal("old-octree.bin", File.ReadAllText(Path.Combine(_paths.Datasets, Source, "pointcloud", "octree.bin")));
        // 取込中のフォルダは残らない
        Assert.Empty(Directory.EnumerateFileSystemEntries(_paths.Importing));
    }

    [Fact]
    public async Task newVersion_撮影ポイントの画像も新しい版へ複製する()
    {
        MakeDataset(images: true);
        var runner = new FakeRunner { WriteOut = WritePointcloud };
        var svc = Service(runner, Clean);
        var a = svc.Start("clean", Source, new JsonObject())["jobId"]!.GetValue<string>();
        runner.Release(a, PcResult());
        var done = await WaitEvent(a, "done");
        var folder = done["version"]!["folder"]!.GetValue<string>();
        var m = ManifestOf(folder);
        var img = m["pointcloud"]!["sources"]![0]!["images"]![0]!;
        Assert.Equal("images/00_0000.jpg", img["file"]!.GetValue<string>());
        Assert.Equal("pano", File.ReadAllText(Path.Combine(_paths.Datasets, folder, "images", "00_0000.jpg")));
        Assert.Single(Directory.EnumerateFiles(Path.Combine(_paths.Datasets, folder, "images")));
    }

    [Fact]
    public void ImageFiles_は書き出した画像だけを点群の持ち主から複製する()
    {
        var source = new JsonObject
        {
            ["pointcloud"] = new JsonObject
            {
                ["owner"] = "v1",
                ["sources"] = new JsonArray(
                    new JsonObject { ["images"] = new JsonArray(new JsonObject { ["file"] = "images/a.jpg" }, new JsonObject { ["file"] = null }) },
                    new JsonObject { ["name"] = "画像なし" }),
            },
        };
        Assert.Equal(new[] { ("v1", "images/a.jpg") }, NewVersion.ImageFiles(source));
        Assert.Empty(NewVersion.ImageFiles(new JsonObject { ["pointcloud"] = null }));
    }

    [Fact]
    public async Task newVersion_点群が出ていなければ失敗し何も公開しない()
    {
        MakeDataset();
        var runner = new FakeRunner();
        var svc = Service(runner, Clean);
        var a = svc.Start("clean", Source, null)["jobId"]!.GetValue<string>();
        runner.Release(a, PcResult());
        var failed = await WaitEvent(a, "failed");
        Assert.Contains("点群", failed["message"]!.GetValue<string>());
        Assert.Single(Directory.EnumerateDirectories(_paths.Datasets).Where(d => !Path.GetFileName(d).StartsWith('.')));
    }

    [Fact]
    public async Task 公開済みの版の一覧と版番号()
    {
        MakeDataset();
        MakeDataset("20260102_現場_bbbbbb", version: 4);
        MakeDataset("20260103_別_cccccc", version: 9, site: "cccccc");
        Assert.Equal(4, _datasets.MaxVersion("aaaaaa"));
        Assert.Equal(0, _datasets.MaxVersion("zzzzzz"));
        Assert.Equal(Source, _datasets.Read(Source)["folder"]!.GetValue<string>());
        await Task.CompletedTask;
    }
}
