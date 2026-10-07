"""点群を作り直す処理（新しい版を作るジョブ）の出力。

PotreeReader で読んだ点（PointBlock）を LAS 1.4（点形式 7: XYZ・強度・RGB・分類 8bit・GPS 時刻）に書き、
PotreeConverter で Potree 2.0（圧縮なし）にする。取込（cli.cmd_e57）と同じ PotreeConverter を使うので、
画面はふつうの版と同じように読める。

属性の扱い
- 元の点群の属性（Potree の名前）は対応する LAS の項目へ写す（_LAS_FIELDS）
- それ以外の 1 要素の数値属性（処理が足した値など）は LAS の extra bytes にする。
  PotreeConverter はそのままの名前で属性にする（画面の「値で色分け」で選べる）
- 分類（classification）は 0〜255。分類ごとの点数を classCounts として結果に入れる（画面の分類一覧に使う）
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import laspy
import numpy as np

from . import progress
from .potree import run_potree
from .potree_reader import PointBlock, PotreeReader

# Potree の属性名 → LAS（点形式 7）の項目名
_LAS_FIELDS = {
    "intensity": "intensity",
    "return number": "return_number",
    "number of returns": "number_of_returns",
    "classification flags": "classification_flags",
    "classification": "classification",
    "user data": "user_data",
    "scan angle": "scan_angle",
    "point source id": "point_source_id",
    "gps-time": "gps_time",
}
# 点形式 7 に無い（LAS 1.2 の点形式 2 から来た）属性。値を換算して写す
_CONVERTED = {"scan angle rank"}
_SKIP = {"position", "rgb", "rgba"} | _CONVERTED

# LAS の extra bytes に使える型
_EXTRA_TYPES = {np.dtype(t) for t in ("i1", "u1", "<i2", "<u2", "<i4", "<u4", "<i8", "<u8", "<f4", "<f8")}
POINTCLOUD_DIR = "pointcloud"


class PointcloudWriter:
    """新しい点群を書く。`with ctx.new_pointcloud() as w: w.write(block)` で使う（JobContext.new_pointcloud）。

    extra: 元の点群に無い属性（名前 → numpy の型）。block.attrs に同じ名前で値を入れる。
    """

    def __init__(
        self,
        template: PotreeReader,
        las_path: Path,
        out_dir: Path,
        potree_exe: Path | None,
        extra: dict[str, Any] | None = None,
        lod_weight: float = 0.4,
        on_done: Callable[[dict[str, Any]], None] | None = None,
    ):
        self.on_done = on_done
        if potree_exe is None or not Path(potree_exe).is_file():
            raise FileNotFoundError("PotreeConverter が見つかりません（--potree）")
        self.template = template
        self.las_path = las_path
        self.out_dir = out_dir
        self.potree_exe = Path(potree_exe)
        self.lod_weight = lod_weight
        self.extra: dict[str, np.dtype] = {}
        header = laspy.LasHeader(point_format=7, version="1.4")
        header.scales = np.asarray(template.scale)
        header.offsets = np.asarray(template.offset)
        names = set(template.attribute_names)
        # 元の点群の属性のうち LAS の項目に無いものは extra bytes で残す
        for a in template.meta["attributes"]:
            n = a["name"]
            if n in _SKIP or n in _LAS_FIELDS or int(a.get("numElements", 1)) != 1:
                continue
            self.extra[n] = template.dtype[n]
        for n, t in (extra or {}).items():
            if n in names and n not in self.extra:
                raise ValueError(f"属性 {n} は元の点群にあります（新しい属性には別の名前を付けてください）")
            self.extra[n] = np.dtype(t)
        for n, t in self.extra.items():
            if t not in _EXTRA_TYPES:
                raise ValueError(f"属性 {n} の型 {t} は使えません")
            if len(n.encode("utf-8")) > 32:
                raise ValueError(f"属性名 {n} が長すぎます（32 バイトまで）")
            header.add_extra_dim(laspy.ExtraBytesParams(name=n, type=t))
        self.header = header
        self._writer: laspy.LasWriter | None = None
        self.points = 0
        self.bmin = np.full(3, np.inf)
        self.bmax = np.full(3, -np.inf)
        self.class_counts = np.zeros(256, dtype=np.int64)
        self.stats: dict[str, Any] | None = None
        self._t0 = time.monotonic()

    def __enter__(self) -> PointcloudWriter:
        self.las_path.parent.mkdir(parents=True, exist_ok=True)
        self._writer = laspy.open(str(self.las_path), mode="w", header=self.header)
        return self

    def write(self, block: PointBlock) -> None:
        """1 塊を書く。xyz は世界座標。attrs は元の属性（PotreeReader の名前）と extra の値。"""
        assert self._writer is not None, "with の中で書いてください"
        n = len(block.xyz)
        if n == 0:
            return
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=self.header)
        rec.x = block.xyz[:, 0]
        rec.y = block.xyz[:, 1]
        rec.z = block.xyz[:, 2]
        a = block.attrs
        rgb = a.get("rgb", a.get("rgba"))
        if rgb is not None:
            rec.red = rgb[:, 0]
            rec.green = rgb[:, 1]
            rec.blue = rgb[:, 2]
        for src, dst in _LAS_FIELDS.items():
            if src in a:
                rec[dst] = a[src]
        if "scan angle rank" in a and "scan angle" not in a:
            # 点形式 2 は度（int8）、点形式 7 は 0.006 度単位（int16）
            rec.scan_angle = np.clip(np.round(a["scan angle rank"].astype(np.float64) / 0.006), -30000, 30000).astype(np.int16)
        for name in self.extra:
            if name in a:
                rec[name] = a[name]
        self._writer.write_points(rec)
        self.points += n
        self.bmin = np.minimum(self.bmin, block.xyz.min(axis=0))
        self.bmax = np.maximum(self.bmax, block.xyz.max(axis=0))
        if "classification" in a:
            self.class_counts += np.bincount(np.asarray(a["classification"], dtype=np.int64) & 0xFF, minlength=256)

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._writer is not None:
            self._writer.close()
            self._writer = None
        if exc_type is not None:
            return
        if self.points == 0:
            raise ValueError("新しい点群に点がありません（すべて取り除かれました）")
        t_write = time.monotonic()
        progress.stage("lod", "点群の LOD 化（PotreeConverter）", self.lod_weight)
        log_path = run_potree(self.potree_exe, [self.las_path], self.out_dir, self.las_path.parent / "chunks", "lod")
        if log_path.is_file():
            log_path.unlink()
        self.las_path.unlink(missing_ok=True)
        counts = {str(i): int(c) for i, c in enumerate(self.class_counts) if c}
        self.stats = {
            "points": int(self.points),
            "bounds": {"min": self.bmin.tolist(), "max": self.bmax.tolist()},
            "attributes": PotreeReader(self.out_dir).attribute_names,
            "timings": {"writeSeconds": round(t_write - self._t0, 2), "lodSeconds": round(time.monotonic() - t_write, 2)},
        }
        if counts:
            self.stats["classCounts"] = counts
        if self.on_done is not None:
            self.on_done(self.stats)
