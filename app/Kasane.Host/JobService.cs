using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Kasane.Host;

/// <summary>
/// 公開済みの版に対する重い処理（ジョブ）を、変換エンジンのサブコマンドとして裏で動かす。
///
/// 待ち行列: 始めた順に並べ、同時に動かすのは maxParallel 本（既定 1）まで。残りは queued のまま待つ。
/// 点群を全点読む処理はメモリと CPU を使い切るので、並べて走らせると両方とも遅くなる。
///
/// 流れ
/// 1. Start: 種類（kind）と対象の版を受け、PC ローカルの work/job-&lt;ID&gt;/ を作って待ち行列に入れる
/// 2. 順番が来たら変換エンジン: `converter.exe &lt;command&gt; --manifest .. --datasets .. --params .. --out .. --work .. [--potree ..]`
///    進捗は JSON 行。画面へは job.progress として流す
/// 3. 完了（target ごと）
///    - derived:    out/ を datasets/&lt;版&gt;/derived/&lt;ID&gt;/ へ写し、manifest の derived に 1 件追記する
///    - newVersion: out/pointcloud/ を点群にした新しい版を取込（ImportService）と同じ手順で公開する。
///                  モデルは元の版から複製し、parent に元の版を残す（NewVersion.cs）
///
/// 画面へ流す通知（job.progress）の data:
///   { jobId, kind, folder, event: "queued", position }   待ち行列の位置（1 = 次）。位置が変わるたびに出す
///   { jobId, kind, folder, event: "started" }
///   { jobId, kind, folder, event: "stage"|"progress"|"log"|"error", ... }  変換エンジンの行そのまま
///   { jobId, kind, folder, event: "done", entry }        derived: 追記した 1 件
///   { jobId, kind, folder, event: "done", version }      newVersion: 公開した版の manifest（folder 付き）
///   { jobId, kind, folder, event: "failed", message }
///   { jobId, kind, folder, event: "aborted" }
/// </summary>
public sealed class JobService
{
    public enum JobTarget
    {
        /// <summary>結果を版の derived/ に追記する（干渉チェック・メッシュ化など）</summary>
        Derived,
        /// <summary>点群を作り直して新しい版として公開する（点群の削除・清掃・分類など）</summary>
        NewVersion,
    }

    /// <summary>
    /// ジョブの種類。新しい処理はここ（Kinds）に 1 行足し、変換エンジンに同名のサブコマンドを足す。
    /// ParamsJson は画面の入力欄の定義（JSON 配列。docs/architecture.md）。
    /// </summary>
    public sealed record JobKind(string Id, string Command, string Label, bool DevOnly = false)
    {
        public JobTarget Target { get; init; } = JobTarget.Derived;
        /// <summary>点群の無い版では始められない</summary>
        public bool NeedsPointcloud { get; init; }
        public string? Description { get; init; }
        public string? ParamsJson { get; init; }
    }

    private static readonly JobKind[] DefaultKinds =
    {
        // 基盤の疎通確認用（開発モードのみ）。点群を全点読み、件数と範囲を返す
        new("selftest", "selftest", "基盤の動作確認", DevOnly: true)
        {
            Description = "点群を全点読み、点数と範囲を書き出します（開発用）。結果はレイヤーに範囲の枠として出せます。",
            ParamsJson = """[{"key":"note","label":"メモ","type":"text","default":""}]""",
        },
        // 新しい版を作る処理の疎通確認用（開発モードのみ）。間引きと、高さによる分類・値を付ける
        new("selftest-version", "selftest-version", "基盤の動作確認（新しい版）", DevOnly: true)
        {
            Target = JobTarget.NewVersion,
            NeedsPointcloud = true,
            Description = "点群を間引き、高さで分類（2〜6）と値（selftest height）を付けて、新しい版として公開します（開発用）。",
            ParamsJson = """
                [{"key":"step","label":"間引き（n 点に 1 点を残す）","type":"number","default":1,"min":1,"max":1000,"step":1},
                 {"key":"note","label":"メモ","type":"text","default":""}]
                """,
        },
    };

    /// <summary>変換エンジンを 1 回動かす（テストでは差し替える）</summary>
    public delegate Task<JsonObject> ConverterRunner(string command, IReadOnlyList<string> args, Action<JsonObject> onEvent, CancellationToken ct);

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
        /// <summary>queued → running</summary>
        public string Status { get; set; } = "queued";
    }

    private readonly AppPaths _paths;
    private readonly string _user;
    private readonly bool _dev;
    private readonly DatasetStore _datasets;
    private readonly ImportService _imports;
    private readonly JobKind[] _kinds;
    private readonly ConverterRunner _runner;
    private readonly int _maxParallel;
    private readonly object _lock = new();
    /// <summary>待っている・動いているジョブ（終わったら消す）</summary>
    private readonly Dictionary<string, Job> _jobs = new();
    private readonly LinkedList<Job> _queue = new();
    private int _running;
    /// <summary>新しい版の版番号を決めて公開するまでを直列にする（同じ版番号を 2 つ作らない）</summary>
    private static readonly SemaphoreSlim PublishLock = new(1, 1);

    public event Action<JsonObject>? Progress;

    public JobService(AppPaths paths, string user, bool dev, DatasetStore datasets, ImportService imports)
        : this(paths, user, dev, datasets, imports, null, null, 1)
    {
    }

    internal JobService(AppPaths paths, string user, bool dev, DatasetStore datasets, ImportService imports,
        IEnumerable<JobKind>? kinds, ConverterRunner? runner, int maxParallel)
    {
        _paths = paths;
        _user = user;
        _dev = dev;
        _datasets = datasets;
        _imports = imports;
        _kinds = (kinds ?? DefaultKinds).ToArray();
        _runner = runner ?? ((cmd, args, onEvent, ct) => ConverterProcess.RunAsync(paths, cmd, args, onEvent, ct));
        _maxParallel = Math.Max(1, maxParallel);
    }

    public bool AnyActive
    {
        get
        {
            lock (_lock) return _jobs.Count > 0;
        }
    }

    private IEnumerable<JobKind> Available => _kinds.Where(k => _dev || !k.DevOnly);

    /// <summary>使える種類の一覧（画面の処理パネルを組むため）</summary>
    public JsonArray ListKinds() =>
        new(Available.Select(k => (JsonNode)new JsonObject
        {
            ["id"] = k.Id,
            ["label"] = k.Label,
            ["target"] = k.Target == JobTarget.NewVersion ? "newVersion" : "derived",
            ["needsPointcloud"] = k.NeedsPointcloud,
            ["description"] = k.Description,
            ["params"] = k.ParamsJson is null ? new JsonArray() : JsonNode.Parse(k.ParamsJson),
        }).ToArray());

    /// <summary>待っている・動いているジョブ（画面を開き直したときに進捗表示を戻すため）。待ち行列の順</summary>
    public JsonArray ListActive()
    {
        lock (_lock)
        {
            var queued = _queue.ToList();
            return new(_jobs.Values
                .OrderBy(j => j.Status == "running" ? -1 : queued.IndexOf(j))
                .Select(j => (JsonNode)new JsonObject
                {
                    ["jobId"] = j.Id,
                    ["kind"] = j.Kind.Id,
                    ["folder"] = j.Folder,
                    ["startedAt"] = j.StartedAt,
                    ["status"] = j.Status,
                    ["position"] = j.Status == "queued" ? queued.IndexOf(j) + 1 : 0,
                    ["last"] = j.Last?.DeepClone(),
                }).ToArray());
        }
    }

    public JsonObject Start(string kindId, string folder, JsonObject? parameters)
    {
        var kind = Available.FirstOrDefault(k => k.Id == kindId)
            ?? throw new NotSupportedException($"不明な処理です: {kindId}");
        var manifest = _datasets.Read(folder);
        if (kind.NeedsPointcloud && manifest["pointcloud"] is not JsonObject)
            throw new InvalidOperationException("この版には点群がありません");
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
        lock (_lock)
        {
            _jobs[id] = job;
            _queue.AddLast(job);
        }
        Log.Info($"ジョブ受付 {id} {kind.Id} {folder}");
        EmitPositions();
        Pump();
        return new JsonObject { ["jobId"] = id, ["kind"] = kind.Id, ["folder"] = folder };
    }

    public bool Abort(string jobId)
    {
        Job? job;
        bool wasQueued;
        lock (_lock)
        {
            if (!_jobs.TryGetValue(jobId, out job)) return false;
            wasQueued = _queue.Remove(job);
            if (wasQueued) _jobs.Remove(jobId);
        }
        if (wasQueued)
        {
            // まだ始まっていない。待ち行列から外すだけ
            Emit(job, new JsonObject { ["event"] = "aborted" });
            TryDelete(job.Work);
            Log.Info($"ジョブ取消（待機中） {job.Id}");
            EmitPositions();
        }
        else
        {
            job.Cancel.Cancel();
        }
        return true;
    }

    public void AbortAll()
    {
        List<string> ids;
        lock (_lock) ids = _jobs.Keys.ToList();
        // 待っているものを先に外す（動いているものを止めた拍子に次が始まらないように）
        foreach (var id in ids.OrderBy(i => IsRunning(i) ? 1 : 0)) Abort(id);
    }

    private bool IsRunning(string id)
    {
        lock (_lock) return _jobs.TryGetValue(id, out var j) && j.Status == "running";
    }

    /// <summary>空きがあれば待ち行列の先頭から始める</summary>
    private void Pump()
    {
        var start = new List<Job>();
        lock (_lock)
        {
            while (_running < _maxParallel && _queue.First is { } node)
            {
                _queue.RemoveFirst();
                node.Value.Status = "running";
                _running++;
                start.Add(node.Value);
            }
        }
        foreach (var job in start)
        {
            Log.Info($"ジョブ開始 {job.Id} {job.Kind.Id} {job.Folder}");
            Emit(job, new JsonObject { ["event"] = "started" });
            _ = Task.Run(() => Run(job));
        }
        if (start.Count > 0) EmitPositions();
    }

    /// <summary>待っているジョブに今の順番を知らせる</summary>
    private void EmitPositions()
    {
        List<Job> queued;
        lock (_lock) queued = _queue.ToList();
        for (int i = 0; i < queued.Count; i++)
            Emit(queued[i], new JsonObject { ["event"] = "queued", ["position"] = i + 1 });
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
            var args = new List<string>
            {
                "--manifest", Path.Combine(_datasets.FolderPath(job.Folder), "manifest.json"),
                "--datasets", _paths.Datasets,
                "--params", paramsFile,
                "--out", outLocal,
                "--work", Path.Combine(job.Work, "tmp"),
            };
            // 点群を作り直す処理は PotreeConverter を使う
            var potree = Path.Combine(_paths.Tools, "PotreeConverter", "PotreeConverter.exe");
            if (File.Exists(potree)) args.AddRange(new[] { "--potree", potree });
            var result = await _runner(job.Kind.Command, args, o => Emit(job, o), job.Cancel.Token);
            if (job.Kind.Target == JobTarget.NewVersion)
            {
                var version = await PublishVersion(job, outLocal, result);
                Emit(job, new JsonObject { ["event"] = "done", ["version"] = version });
            }
            else
            {
                var entry = await Publish(job, outLocal, result);
                Emit(job, new JsonObject { ["event"] = "done", ["entry"] = entry });
            }
            Log.Info($"ジョブ完了 {job.Id}");
        }
        catch (Exception ex) when (ex is OperationCanceledException || job.Cancel.IsCancellationRequested)
        {
            // 中断の後に片付け済みのフォルダへ触って別の例外になることがある。中断を優先して扱う
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
            lock (_lock)
            {
                _jobs.Remove(job.Id);
                _running--;
            }
            TryDelete(job.Work);
            Pump();
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
        try
        {
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
        }
        catch
        {
            TryDelete(part);
            throw;
        }
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

    /// <summary>
    /// out/pointcloud/ を点群にした新しい版を公開する（取込と同じ: .importing/ に組み立ててから改名）。
    /// 元の版には触れない。戻り値は公開した版の manifest（folder 付き）。
    /// </summary>
    private async Task<JsonObject> PublishVersion(Job job, string outLocal, JsonObject result)
    {
        var pcOut = Path.Combine(outLocal, "pointcloud");
        foreach (var f in NewVersion.PointcloudFiles)
            if (!File.Exists(Path.Combine(pcOut, f))) throw new InvalidDataException($"処理の結果に点群（{f}）がありません");
        var source = _datasets.Read(job.Folder);
        var begin = _imports.Begin(source["name"]?.GetValue<string>() ?? "無題");
        var importId = begin["id"]!.GetValue<string>();
        var newFolder = begin["folder"]!.GetValue<string>();
        void OnEvent(JsonObject o) => Emit(job, o);
        // 中断されたら組み立て中のフォルダを片付ける（ImportService.Abort）
        using var reg = job.Cancel.Token.Register(() => _imports.Abort(importId));
        try
        {
            var sizes = await _imports.StageDirectory(importId, pcOut, "pointcloud", OnEvent);
            var modelFiles = NewVersion.ModelFiles(source);
            // 撮影ポイントの画像も引き継ぐ（点群の sources をそのまま使うので、画像の場所も同じ）
            var carryFiles = modelFiles.Concat(NewVersion.ImageFiles(source)).ToList();
            if (carryFiles.Count > 0) await _imports.CopyFromDatasets(importId, carryFiles, "carry", OnEvent);
            job.Cancel.Token.ThrowIfCancellationRequested();
            var unchanged = 0;
            foreach (var (folder, rel) in modelFiles.Where(x => x.Rel.EndsWith(".elements.json", StringComparison.OrdinalIgnoreCase)))
                unchanged += NewVersion.CountElements(_paths.ResolveRelative($"datasets/{folder}/{rel}", "datasets/"));

            await PublishLock.WaitAsync(job.Cancel.Token);
            try
            {
                var site = source["site"]?.GetValue<string>() ?? source["id"]!.GetValue<string>();
                var version = _datasets.MaxVersion(site) + 1;
                var draft = NewVersion.BuildManifest(source, newFolder, version, job.Kind.Id, job.Kind.Label, job.Params, result, sizes);
                draft["folder"] = newFolder;
                var (diff, summary) = NewVersion.BuildDiff(source, draft, job.Kind.Label, unchanged, _user, JsonUtil.NowIso());
                _imports.WriteJson(importId, "diff.json", diff);
                draft["diff"] = summary;
                job.Cancel.Token.ThrowIfCancellationRequested();
                return _imports.Finish(importId, draft, NewVersion.Parent(source, job.Kind.Id, job.Params));
            }
            finally
            {
                PublishLock.Release();
            }
        }
        catch
        {
            if (_imports.IsActive(importId)) _imports.Abort(importId);
            throw;
        }
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
