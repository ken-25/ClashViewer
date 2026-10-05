using System.Text;
using Microsoft.Web.WebView2.Core;

namespace ClashViewer.Host;

/// <summary>
/// https://cv.local/ の応答を自前で返す。
///
/// - /            画面（viewer/）
/// - /data/...    プロジェクトフォルダ（datasets/・issues/・events/）と設定データフォルダ（config/）。Range 要求に 206 で応える
/// - /local/<t>   利用者が選んだローカルファイル（トークン指定）
/// - PUT /api/write?path=...  取込中データセット・指摘画像の書き込み
///
/// 仮想ホストのフォルダ割り当て（SetVirtualHostNameToFolderMapping）を使わず自前で返すのは、
/// Range の扱い・書き込み・アクセス範囲の制限を 1 か所で確実に制御するため。
/// </summary>
public sealed class ResourceServer
{
    public const string Host = "cv.local";
    public const string Origin = "https://" + Host;

    private static readonly string[] ReadablePrefixes = { "datasets/", "issues/", "config/", "events/" };

    private readonly AppPaths _paths;
    private readonly LocalFiles _local;
    private readonly ImportService _imports;
    private CoreWebView2Environment? _env;

    public ResourceServer(AppPaths paths, LocalFiles local, ImportService imports)
    {
        _paths = paths;
        _local = local;
        _imports = imports;
    }

    public void Attach(CoreWebView2 core, CoreWebView2Environment env)
    {
        _env = env;
        core.AddWebResourceRequestedFilter($"{Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnRequested;
    }

    private sealed record Reply(int Status, string Reason, Stream? Body, Dictionary<string, string> Headers);

    private async void OnRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        Uri uri;
        try
        {
            uri = new Uri(e.Request.Uri);
        }
        catch
        {
            return;
        }
        if (!string.Equals(uri.Host, Host, StringComparison.OrdinalIgnoreCase)) return;

        var deferral = e.GetDeferral();
        try
        {
            var method = e.Request.Method.ToUpperInvariant();
            var path = Uri.UnescapeDataString(uri.AbsolutePath);
            var range = e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : null;
            Reply reply;
            if (method == "PUT" && path == "/api/write")
            {
                // 要求本文は UI スレッドで取り出す（COM ストリーム）
                var body = e.Request.Content;
                var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
                reply = await Task.Run(() => Write(query["path"] ?? "", body));
            }
            else if (method is "GET" or "HEAD")
            {
                reply = await Task.Run(() => Read(path, range, method == "HEAD"));
            }
            else
            {
                reply = Text(405, "Method Not Allowed", "許可されていない操作です");
            }
            e.Response = ToResponse(reply);
        }
        catch (UnauthorizedAccessException ex)
        {
            e.Response = ToResponse(Text(403, "Forbidden", ex.Message));
        }
        catch (FileNotFoundException ex)
        {
            e.Response = ToResponse(Text(404, "Not Found", ex.Message));
        }
        catch (DirectoryNotFoundException ex)
        {
            e.Response = ToResponse(Text(404, "Not Found", ex.Message));
        }
        catch (Exception ex)
        {
            Log.Error($"要求の処理に失敗: {e.Request.Method} {e.Request.Uri}", ex);
            e.Response = ToResponse(Text(500, "Internal Server Error", ex.Message));
        }
        finally
        {
            deferral.Complete();
        }
    }

    private CoreWebView2WebResourceResponse ToResponse(Reply r)
    {
        var sb = new StringBuilder();
        foreach (var (k, v) in r.Headers) sb.Append(k).Append(": ").Append(v).Append("\r\n");
        return _env!.CreateWebResourceResponse(r.Body, r.Status, r.Reason, sb.ToString());
    }

    private static Reply Text(int status, string reason, string message)
    {
        var bytes = Encoding.UTF8.GetBytes(message);
        return new Reply(status, reason, new MemoryStream(bytes), new()
        {
            ["Content-Type"] = "text/plain; charset=utf-8",
            ["Content-Length"] = bytes.Length.ToString(),
        });
    }

    private Reply Read(string path, string? range, bool headOnly)
    {
        string full;
        bool immutable = false;
        if (path.StartsWith("/data/", StringComparison.Ordinal))
        {
            var rel = path["/data/".Length..];
            full = _paths.ResolveRelative(rel, ReadablePrefixes);
            // 公開済みデータセットの中身は上書きしない（5章）。manifest と diff 以外はキャッシュしてよい
            immutable = rel.StartsWith("datasets/", StringComparison.OrdinalIgnoreCase)
                && !rel.Contains("/.importing/") && !rel.EndsWith("manifest.json", StringComparison.OrdinalIgnoreCase);
        }
        else if (path.StartsWith("/local/", StringComparison.Ordinal))
        {
            full = _local.Resolve(path["/local/".Length..]) ?? throw new FileNotFoundException("登録されていないファイルです");
        }
        else
        {
            var rel = path == "/" ? "index.html" : path.TrimStart('/');
            if (rel.Split('/').Any(s => s is ".." or "."))
                throw new UnauthorizedAccessException("使えないパスです");
            full = Path.GetFullPath(Path.Combine(_paths.Viewer, rel.Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(_paths.Viewer + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("画面フォルダの外です");
        }
        return ServeFile(full, range, headOnly, immutable);
    }

    private static Reply ServeFile(string full, string? range, bool headOnly, bool immutable)
    {
        var info = new FileInfo(full);
        if (!info.Exists) throw new FileNotFoundException("ファイルがありません", full);
        long length = info.Length;
        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = MimeOf(full),
            ["Accept-Ranges"] = "bytes",
            ["Cache-Control"] = immutable ? "max-age=86400" : "no-cache",
        };

        if (range is not null && TryParseRange(range, length, out var start, out var end))
        {
            long count = end - start + 1;
            headers["Content-Range"] = $"bytes {start}-{end}/{length}";
            headers["Content-Length"] = count.ToString();
            if (headOnly) return new Reply(206, "Partial Content", null, headers);
            var fs = OpenShared(full);
            fs.Seek(start, SeekOrigin.Begin);
            // 範囲が小さければ読み切って返す（点群のノード 1 つは通常数 MB 以下）
            Stream body = count <= 32L * 1024 * 1024 ? ReadExact(fs, (int)count) : new BoundedStream(fs, count);
            return new Reply(206, "Partial Content", body, headers);
        }
        if (range is not null)
        {
            headers["Content-Range"] = $"bytes */{length}";
            return new Reply(416, "Range Not Satisfiable", null, headers);
        }
        headers["Content-Length"] = length.ToString();
        return new Reply(200, "OK", headOnly ? null : OpenShared(full), headers);
    }

    private static MemoryStream ReadExact(FileStream fs, int count)
    {
        using (fs)
        {
            var buf = new byte[count];
            int read = 0;
            while (read < count)
            {
                int n = fs.Read(buf, read, count - read);
                if (n <= 0) break;
                read += n;
            }
            return new MemoryStream(buf, 0, read, writable: false);
        }
    }

    /// <summary>Box Drive で他の人が同期中でも読めるよう、共有を広く取って開く。</summary>
    public static FileStream OpenShared(string full) =>
        new(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.RandomAccess);

    /// <summary>"bytes=a-b" / "bytes=a-" / "bytes=-n" の単一範囲だけに対応する。</summary>
    public static bool TryParseRange(string header, long length, out long start, out long end)
    {
        start = end = 0;
        var h = header.Trim();
        if (!h.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase) || h.Contains(',')) return false;
        var spec = h[6..].Trim();
        var dash = spec.IndexOf('-');
        if (dash < 0) return false;
        var a = spec[..dash].Trim();
        var b = spec[(dash + 1)..].Trim();
        if (a.Length == 0)
        {
            if (!long.TryParse(b, out var suffix) || suffix <= 0) return false;
            start = Math.Max(0, length - suffix);
            end = length - 1;
        }
        else
        {
            if (!long.TryParse(a, out start)) return false;
            end = b.Length == 0 ? length - 1 : (long.TryParse(b, out var e) ? Math.Min(e, length - 1) : -1);
        }
        return start >= 0 && start <= end && end < length;
    }

    private Reply Write(string relative, Stream? body)
    {
        if (body is null) throw new InvalidOperationException("本文がありません");
        var rel = relative.Replace('\\', '/').TrimStart('/');
        // 書けるのは「自分が取込中のデータセット」と「指摘の画像」だけ
        if (rel.StartsWith("datasets/.importing/", StringComparison.OrdinalIgnoreCase))
        {
            var id = rel["datasets/.importing/".Length..].Split('/')[0];
            if (!_imports.IsActive(id)) throw new UnauthorizedAccessException("取込中ではないデータセットには書けません");
        }
        else if (!rel.StartsWith("issues/", StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException($"このパスには書けません: {relative}");
        }
        var full = _paths.ResolveRelative(rel);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var tmp = full + ".part";
        long written;
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
        {
            body.CopyTo(fs, 1 << 20);
            written = fs.Length;
        }
        File.Move(tmp, full, overwrite: true);
        var json = $"{{\"path\":\"{rel}\",\"size\":{written}}}";
        var bytes = Encoding.UTF8.GetBytes(json);
        return new Reply(200, "OK", new MemoryStream(bytes), new()
        {
            ["Content-Type"] = "application/json",
            ["Content-Length"] = bytes.Length.ToString(),
        });
    }

    public static string MimeOf(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" or ".map" => "application/json; charset=utf-8",
        ".jsonl" => "application/x-ndjson; charset=utf-8",
        ".wasm" => "application/wasm",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
}

/// <summary>元ストリームの現在位置から指定バイト数だけ読ませるストリーム。</summary>
public sealed class BoundedStream : Stream
{
    private readonly Stream _inner;
    private long _remaining;

    public BoundedStream(Stream inner, long length)
    {
        _inner = inner;
        _remaining = length;
        Length = length;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length { get; }
    public override long Position { get => Length - _remaining; set => throw new NotSupportedException(); }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (_remaining <= 0) return 0;
        int n = _inner.Read(buffer, offset, (int)Math.Min(count, _remaining));
        _remaining -= n;
        return n;
    }

    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }
}
