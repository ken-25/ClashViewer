using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>
/// 公開済みの版に対する重い処理（ジョブ）を、変換エンジンのサブコマンドとして裏で動かす。
///
/// 流れ（target = derived。干渉チェック・分類・メッシュ化などが使う）
/// 1. Start: 種類（kind）と対象の版を受け、PC ローカルの work/job-&lt;ID&gt;/ を作って裏で走らせる
/// 2. 変換エンジン: `converter.exe &lt;command&gt; --manifest .. --datasets .. --params .. --out .. --work ..`
///    進捗は JSON 行。画面へは job.progress として流す
/// 3. 完了: out/ を datasets/&lt;版&gt;/derived/&lt;ID&gt;/ へ写し、manifest の derived に 1 件追記する
///
/// target = newVersion（点群の削除・清掃など、版そのものを作り直す処理）は未実装。
/// 取込（ImportService）の Begin / Finish に parent を付けて載せる想定（docs/architecture.md）。
///
/// 画面へ流す通知（job.progress）の data:
///   { jobId, kind, folder, event: "stage"|"progress"|"log"|"error", ... }  変換エンジンの行そのまま
///   { jobId, kind, folder, event: "done", entry }        derived に追記した 1 件
///   { jobId, kind, folder, event: "failed", message }
///   { jobId, kind, folder, event: "aborted" }
/// </summary>
public sealed class JobService
{
    /// <summary>ジョブの種類。新しい処理はここに 1 行足し、変換エンジンに同名のサブコマンドを足す。</summary>
    public sealed record JobKind(string Id, string Command, string Label, bool DevOnly = false);

    private static readonly JobKind[] Kinds =
    {
        // 基盤の疎通確認用（開発モードのみ）。点群を全点読み、件数と範囲を返す
        new("selftest", "selftest", "基盤の動作確認", DevOnly: true),
    };

    private sealed class Job
    {
        public required string Id { get; init; }
        public required JobKind Kind { get; init; }
        public required string Folder { get; init; }
        public required string Work { get; init; }
        public required JsonObject Params { get; init; }
        public required string StartedAt { get; init; }
        public CancellationTokenSource Cancel { get; } = new();
        public JsonObject? Last { get; set; }
    }

    private readonly AppPaths _paths;
    private readonly string _user;
    private readonly bool _dev;
    private readonly DatasetStore _datasets;
    private readonly ConcurrentDictionary<string, Job> _jobs = new();

    public event Action<JsonObject>? Progress;

    public JobService(AppPaths paths, string user, bool dev, DatasetStore datasets)
    {
        _paths = paths;
        _user = user;
        _dev = dev;
        _datasets = datasets;
    }

    public bool AnyActive => !_jobs.IsEmpty;

    /// <summary>使える種類の一覧（画面のメニューを組むため）</summary>
    public JsonArray ListKinds() =>
        new(Kinds.Where(k => _dev || !k.DevOnly)
            .Select(k => (JsonNode)new JsonObject { ["id"] = k.Id, ["label"] = k.Label })
            .ToArray());

    /// <summary>実行中のジョブ（画面を開き直したときに進捗表示を戻すため）</summary>
    public JsonArray ListActive() =>
        new(_jobs.Values.Select(j => (JsonNode)new JsonObject
        {
            ["jobId"] = j.Id,
            ["kind"] = j.Kind.Id,
            ["folder"] = j.Folder,
            ["startedAt"] = j.StartedAt,
            ["last"] = j.Last?.DeepClone(),
        }).ToArray());

    public JsonObject Start(string kindId, string folder, JsonObject? parameters)
    {
        var kind = Kinds.FirstOrDefault(k => k.Id == kindId && (_dev || !k.DevOnly))
            ?? throw new NotSupportedException($"不明な処理です: {kindId}");
        var dir = _datasets.FolderPath(folder);
        if (!File.Exists(Path.Combine(dir, "manifest.json"))) throw new DirectoryNotFoundException($"版が見つかりません: {folder}");
        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
        var work = Path.Combine(_paths.Work, $"job-{id}");
        Directory.CreateDirectory(work);
        var job = new Job
        {
            Id = id,
            Kind = kind,
            Folder = folder,
            Work = work,
            Params = parameters?.DeepClone().AsObject() ?? new JsonObject(),
            StartedAt = JsonUtil.NowIso(),
        };
        _jobs[id] = job;
        Log.Info($"ジョブ開始 {id} {kind.Id} {folder}");
        _ = Task.Run(() => Run(job));
        return new JsonObject { ["jobId"] = id, ["kind"] = kind.Id, ["folder"] = folder };
    }

    public bool Abort(string jobId)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return false;
        job.Cancel.Cancel();
        return true;
    }

    public void AbortAll()
    {
        foreach (var j in _jobs.Values) j.Cancel.Cancel();
    }

    private void Emit(Job job, JsonObject evt)
    {
        evt["jobId"] = job.Id;
        evt["kind"] = job.Kind.Id;
        evt["folder"] = job.Folder;
        if (evt["event"]?.GetValue<string>() is "stage" or "progress") job.Last = evt.DeepClone().AsObject();
        Progress?.Invoke(evt);
    }

    private async Task Run(Job job)
    {
        var outLocal = Path.Combine(job.Work, "out");
        try
        {
            Directory.CreateDirectory(outLocal);
            var paramsFile = Path.Combine(job.Work, "params.json");
            JsonUtil.WriteFileAtomic(paramsFile, job.Params);
            var args = new[]
            {
                "--manifest", Path.Combine(_datasets.FolderPath(job.Folder), "manifest.json"),
                "--datasets", _paths.Datasets,
                "--params", paramsFile,
                "--out", outLocal,
                "--work", Path.Combine(job.Work, "tmp"),
            };
            var result = await ConverterProcess.RunAsync(_paths, job.Kind.Command, args, o => Emit(job, o), job.Cancel.Token);
            var entry = await Publish(job, outLocal, result);
            Emit(job, new JsonObject { ["event"] = "done", ["entry"] = entry });
            Log.Info($"ジョブ完了 {job.Id}");
        }
        catch (OperationCanceledException)
        {
            Emit(job, new JsonObject { ["event"] = "aborted" });
            Log.Info($"ジョブ中断 {job.Id}");
        }
        catch (Exception ex)
        {
            Log.Error($"ジョブ失敗 {job.Id}", ex);
            Emit(job, new JsonObject { ["event"] = "failed", ["message"] = ex.Message });
        }
        finally
        {
            _jobs.TryRemove(job.Id, out _);
            TryDelete(job.Work);
        }
    }

    /// <summary>結果を datasets/&lt;版&gt;/derived/&lt;ID&gt;/ へ写し（.part で書いてから改名）、manifest に追記する。</summary>
    private async Task<JsonObject> Publish(Job job, string outLocal, JsonObject result)
    {
        var rel = $"derived/{job.Id}";
        var final = Path.Combine(_datasets.FolderPath(job.Folder), "derived", job.Id);
        var part = final + ".part";
        var files = new JsonArray();
        if (Directory.Exists(part)) Directory.Delete(part, true);
        foreach (var src in Directory.EnumerateFiles(outLocal, "*", SearchOption.AllDirectories))
        {
            job.Cancel.Token.ThrowIfCancellationRequested();
            var sub = Path.GetRelativePath(outLocal, src);
            var dst = Path.Combine(part, sub);
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            await using (var fi = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan))
            await using (var fo = new FileStream(dst, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
                await fi.CopyToAsync(fo, job.Cancel.Token);
            files.Add($"{rel}/{sub.Replace('\\', '/')}");
        }
        Directory.CreateDirectory(part);
        Directory.Move(part, final);
        var entry = new JsonObject
        {
            ["id"] = job.Id,
            ["kind"] = job.Kind.Id,
            ["label"] = job.Kind.Label,
            ["dir"] = rel,
            ["files"] = files,
            ["params"] = job.Params.DeepClone(),
            ["result"] = result.DeepClone(),
            ["createdBy"] = _user,
            ["createdAt"] = JsonUtil.NowIso(),
            ["startedAt"] = job.StartedAt,
            ["appVersion"] = typeof(JobService).Assembly.GetName().Version?.ToString(),
        };
        _datasets.AddDerived(job.Folder, entry);
        return entry;
    }

    private static void TryDelete(string dir)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch (Exception ex)
        {
            Log.Warn($"作業用フォルダを消せません: {dir}: {ex.Message}");
        }
    }
}
