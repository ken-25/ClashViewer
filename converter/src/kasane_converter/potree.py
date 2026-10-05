"""PotreeConverter 2.x の呼び出し。"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from . import progress

# 例: "[ 41%, 3s], [INDEXING: 63%, duration: 2s, throughput: 12MPs][RAM: ...]"
_RE_TOTAL = re.compile(r"^\[\s*(\d+)%")
_RE_STAGE = re.compile(r"\[(CHUNKING|INDEXING|MERGING|COUNTING)[^\]]*?(\d+)%")


class PotreeError(RuntimeError):
    pass


def run_potree(potree_exe: Path, inputs: list[Path], out_dir: Path, chunk_dir: Path, stage_id: str) -> Path:
    """LAS を Potree 2.0 形式（圧縮なし）に変換する。戻り値は出力ログのパス。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    chunk_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(potree_exe),
        *[str(p) for p in inputs],
        "-o",
        str(out_dir),
        "--encoding",
        "UNCOMPRESSED",
        "-m",
        "poisson",
        "--chunkdir",
        str(chunk_dir),
    ]
    progress.log("info", "PotreeConverter を起動", command=cmd)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=flags,
    )
    tail: list[str] = []
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if not line:
            continue
        tail.append(line)
        del tail[:-40]
        m = _RE_TOTAL.search(line)
        if m:
            sm = _RE_STAGE.search(line)
            progress.progress(stage_id, int(m.group(1)), 100, sm.group(1) if sm else None)
    code = proc.wait()
    if code != 0:
        raise PotreeError(f"PotreeConverter が終了コード {code} で失敗しました:\n" + "\n".join(tail[-15:]))
    for name in ("metadata.json", "hierarchy.bin", "octree.bin"):
        if not (out_dir / name).is_file():
            raise PotreeError(f"PotreeConverter の出力に {name} がありません")
    progress.progress(stage_id, 100, 100, force=True)
    return out_dir / "log.txt"
