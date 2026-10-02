"""変換エンジンのコマンドライン。

ビューア exe から呼ばれ、進捗と結果を標準出力の JSON 行で返す。
終了コード: 0=成功、1=失敗、2=引数の誤り。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

import laspy
import numpy as np

from . import __version__, progress
from .e57 import E57FormatError, E57Reader, check_signature
from .potree import run_potree

HASH_BLOCK = 8 * 1024 * 1024


def sha256_file(path: Path, stage_id: str, done_before: int, total: int) -> str:
    h = hashlib.sha256()
    done = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(HASH_BLOCK)
            if not b:
                break
            h.update(b)
            done += len(b)
            progress.progress(stage_id, done_before + done, total)
    return h.hexdigest()


def e57_to_las(src: Path, dst: Path, stage_id: str, done_before: int, total: int) -> dict:
    """E57 を LAS 1.2（点形式 2: XYZ・強度・RGB・点ソースID=スキャン番号）に書き出す。"""
    stats: dict = {"scans": [], "points": 0}
    bmin = np.full(3, np.inf)
    bmax = np.full(3, -np.inf)
    with E57Reader(str(src)) as r:
        if not r.scans:
            raise ValueError(f"{src.name} にスキャンがありません")
        # LAS の整数座標の基準。最初のスキャンの位置を mm 単位に丸めて使う
        t0 = np.asarray(r.scans[0].translation)
        header = laspy.LasHeader(point_format=2, version="1.2")
        header.scales = np.array([0.001, 0.001, 0.001])
        header.offsets = np.floor(t0)
        has_color = any(s.has_color for s in r.scans)
        has_intensity = any(s.has_intensity for s in r.scans)
        done = done_before
        with laspy.open(str(dst), mode="w", header=header) as w:
            for s in r.scans:
                valid_points = 0
                for chunk, stored in r.iter_scan(s.index):
                    n = chunk.xyz.shape[0]
                    if n:
                        rec = laspy.ScaleAwarePointRecord.zeros(n, header=header)
                        rec.x = chunk.xyz[:, 0]
                        rec.y = chunk.xyz[:, 1]
                        rec.z = chunk.xyz[:, 2]
                        if chunk.intensity is not None:
                            rec.intensity = chunk.intensity
                        if chunk.rgb is not None:
                            rec.red = chunk.rgb[:, 0]
                            rec.green = chunk.rgb[:, 1]
                            rec.blue = chunk.rgb[:, 2]
                        elif has_color:
                            rec.red = rec.green = rec.blue = np.full(n, 40000, np.uint16)
                        rec.point_source_id = np.full(n, min(s.index, 65535), np.uint16)
                        w.write_points(rec)
                        bmin = np.minimum(bmin, chunk.xyz.min(axis=0))
                        bmax = np.maximum(bmax, chunk.xyz.max(axis=0))
                        valid_points += n
                    done += stored
                    progress.progress(stage_id, done, total, f"{src.name} / {s.name}")
                stats["scans"].append(
                    {
                        "index": s.index,
                        "name": s.name,
                        "guid": s.guid,
                        "storedPoints": s.point_count,
                        "points": valid_points,
                        "coordinateSystem": s.coordinate_system,
                        "hasColor": s.has_color,
                        "hasIntensity": s.has_intensity,
                        "pose": {"rotation": s.rotation, "translation": s.translation},
                    }
                )
                stats["points"] += valid_points
                if valid_points == 0:
                    progress.log("warn", f"{src.name} / {s.name}: 有効な点がありません")
        stats["hasColor"] = has_color
        stats["hasIntensity"] = has_intensity
    if stats["points"] == 0:
        raise ValueError(f"{src.name} に有効な点がありません")
    stats["bounds"] = {"min": bmin.tolist(), "max": bmax.tolist()}
    return stats


def cmd_e57(args: argparse.Namespace) -> int:
    inputs = [Path(p) for p in args.input]
    for p in inputs:
        if not p.is_file():
            progress.emit("error", message=f"入力ファイルがありません: {p}")
            return 2
    # 数 GB のハッシュ計算より前に、E57 でないファイルを弾く
    for p in inputs:
        try:
            check_signature(str(p))
        except E57FormatError as e:
            progress.emit("error", message=str(e), detail=f"signature check failed: {p}")
            return 1
    potree_exe = Path(args.potree) if args.potree else Path(sys.executable).parent.parent / "PotreeConverter" / "PotreeConverter.exe"
    if not potree_exe.is_file():
        progress.emit("error", message=f"PotreeConverter が見つかりません: {potree_exe}")
        return 2
    out_dir = Path(args.out)
    work_root = Path(args.work) if args.work else Path(tempfile.mkdtemp(prefix="clashconv_"))
    work_root.mkdir(parents=True, exist_ok=True)
    t_start = time.monotonic()
    try:
        sizes = [p.stat().st_size for p in inputs]
        # 段階の重み。E57 の読込が最も重く、LOD 化が次に重い
        progress.stage("hash", "元ファイルのハッシュ計算", 0.08)
        sources = []
        done = 0
        for p, size in zip(inputs, sizes):
            sources.append({"name": p.name, "size": size, "sha256": sha256_file(p, "hash", done, sum(sizes))})
            done += size
        progress.progress("hash", 1, 1, force=True)

        progress.stage("read", "E57 の読込と LAS 変換", 0.52)
        with_counts = []
        total_stored = 0
        for p in inputs:
            with E57Reader(str(p)) as r:
                with_counts.append(r.total_points)
                total_stored += r.total_points
        las_files: list[Path] = []
        done = 0
        bmin = np.full(3, np.inf)
        bmax = np.full(3, -np.inf)
        total_points = 0
        for i, (p, src) in enumerate(zip(inputs, sources)):
            las = work_root / f"input_{i:02d}.las"
            st = e57_to_las(p, las, "read", done, total_stored)
            done += with_counts[i]
            src.update(st)
            las_files.append(las)
            bmin = np.minimum(bmin, st["bounds"]["min"])
            bmax = np.maximum(bmax, st["bounds"]["max"])
            total_points += st["points"]
        progress.progress("read", total_stored, total_stored, force=True)
        t_read = time.monotonic()

        progress.stage("lod", "点群の LOD 化（PotreeConverter）", 0.40)
        log_path = run_potree(potree_exe, las_files, out_dir, work_root / "chunks", "lod")
        t_lod = time.monotonic()
        # 作業用ログは出力先に残さず結果に含める
        potree_log = ""
        if log_path.is_file():
            potree_log = log_path.read_text(encoding="utf-8", errors="replace")[-20000:]
            log_path.unlink()
        out_sizes = {n: (out_dir / n).stat().st_size for n in ("metadata.json", "hierarchy.bin", "octree.bin")}
        progress.emit(
            "result",
            kind="pointcloud",
            sources=sources,
            points=int(total_points),
            scanCount=sum(len(s["scans"]) for s in sources),
            bounds={"min": bmin.tolist(), "max": bmax.tolist()},
            outputSizes=out_sizes,
            timings={
                "readSeconds": round(t_read - t_start, 2),
                "lodSeconds": round(t_lod - t_read, 2),
                "totalSeconds": round(t_lod - t_start, 2),
            },
            potreeLog=potree_log,
            converterVersion=__version__,
        )
        return 0
    except Exception as e:  # 変換失敗は必ず JSON 行で返す
        progress.emit("error", message=str(e), detail=traceback.format_exc())
        return 1
    finally:
        if not args.keep_work:
            shutil.rmtree(work_root, ignore_errors=True)


def cmd_info(args: argparse.Namespace) -> int:
    try:
        out = []
        for p in args.input:
            with E57Reader(p) as r:
                out.append(
                    {
                        "name": Path(p).name,
                        "size": os.path.getsize(p),
                        "points": r.total_points,
                        "scans": [
                            {"name": s.name, "points": s.point_count, "fields": s.fields, "translation": s.translation}
                            for s in r.scans
                        ],
                    }
                )
        progress.emit("result", kind="info", files=out)
        return 0
    except E57FormatError as e:
        progress.emit("error", message=str(e))
        return 1
    except Exception as e:
        progress.emit("error", message=str(e), detail=traceback.format_exc())
        return 1


def main(argv: list[str] | None = None) -> int:
    # 標準出力は UTF-8 の JSON 行に固定する（ビューア exe が UTF-8 で読む）
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    ap = argparse.ArgumentParser(prog="converter")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("e57", help="E57 を Potree 2.0 形式に変換する")
    e.add_argument("--input", action="append", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--potree")
    e.add_argument("--work")
    e.add_argument("--keep-work", action="store_true")
    e.set_defaults(func=cmd_e57)
    i = sub.add_parser("info", help="E57 の概要を出す")
    i.add_argument("--input", action="append", required=True)
    i.set_defaults(func=cmd_info)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
