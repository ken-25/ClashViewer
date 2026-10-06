"""基盤の疎通確認（開発モードのみ。利用者向けの機能ではない）。

版の点群を全点読み、点数・範囲・属性ごとの値の範囲を summary.json に書く。
ジョブの起動 → 進捗 → 結果の公開（derived）→ manifest への追記までを通しで確かめるのに使う。
"""

from __future__ import annotations

import json

import numpy as np

from .. import progress
from ..potree_reader import PotreeReader
from . import JobContext, job


@job("selftest", help="基盤の動作確認（点群を全点読む）")
def selftest(ctx: JobContext) -> dict:
    summary: dict = {"folder": ctx.folder, "points": 0, "pointcloud": None}
    if ctx.manifest.get("pointcloud"):
        progress.stage("read", "点群の読込", 1.0)
        r = PotreeReader(ctx.pointcloud_dir())
        bmin = np.full(3, np.inf)
        bmax = np.full(3, -np.inf)
        ranges: dict[str, list[float]] = {}
        done = 0
        for b in r.iter_blocks():
            if len(b.xyz):
                bmin = np.minimum(bmin, b.xyz.min(axis=0))
                bmax = np.maximum(bmax, b.xyz.max(axis=0))
            for k, v in b.attrs.items():
                if not len(v):
                    continue
                lo, hi = float(v.min()), float(v.max())
                cur = ranges.get(k)
                ranges[k] = [min(cur[0], lo), max(cur[1], hi)] if cur else [lo, hi]
            done += len(b.xyz)
            progress.progress("read", done, r.points)
        progress.progress("read", r.points, r.points, force=True)
        summary["points"] = done
        summary["pointcloud"] = {
            "metadataPoints": r.points,
            "attributes": r.attribute_names,
            "ranges": ranges,
            "bounds": {"min": bmin.tolist(), "max": bmax.tolist()} if done else None,
        }
    summary["models"] = [m["key"] for m in ctx.manifest.get("models", [])]
    (ctx.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"points": summary["points"], "files": ["summary.json"]}
