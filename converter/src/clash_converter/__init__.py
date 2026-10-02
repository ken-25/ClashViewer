"""干渉ビューアの変換エンジン。"""

from pathlib import Path


def _read_version() -> str:
    # バージョンはリポジトリ直下の VERSION が唯一の正（SSOT）。
    # exe 化するときは scripts/build.ps1 が VERSION から _version.py を生成する
    try:
        from ._version import VERSION

        return VERSION
    except ImportError:
        pass
    f = Path(__file__).resolve().parents[3] / "VERSION"
    try:
        return f.read_text(encoding="utf-8").strip()
    except OSError:
        return "0+unknown"


__version__ = _read_version()
