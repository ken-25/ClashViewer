using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Kasane.Host;

/// <summary>
/// 利用者が選んだ・ドロップしたローカルファイルの登録簿。
/// 画面からはトークンでだけ参照させ、任意のローカルパスは読ませない。
/// </summary>
public sealed class LocalFiles
{
    private readonly ConcurrentDictionary<string, string> _byToken = new();

    public sealed record Entry(string Token, string Name, string Path, long Size, string Kind);

    public Entry Register(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var info = new FileInfo(full);
        if (!info.Exists) throw new FileNotFoundException("ファイルがありません", full);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
        _byToken[token] = full;
        return new Entry(token, info.Name, full, info.Length, KindOf(info.Name));
    }

    public string? Resolve(string token) => _byToken.TryGetValue(token, out var p) ? p : null;

    public static string KindOf(string name) => System.IO.Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".e57" => "e57",
        ".ifc" => "ifc",
        _ => "other",
    };
}
