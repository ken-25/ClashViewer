"""新しい版を作る処理の疎通確認（開発モードのみ。利用者向けの機能ではない）。

版の点群を全点読み、n 点に 1 点へ間引き、高さで分類（2〜6 の 5 段）と値（selftest height = 最低点からの高さ m）を付けて、
新しい版の点群として書く。点群の書き出し → PotreeConverter → 新しい版の公開（parent 付き）→ 画面の分類・値の色分け
までを通しで確かめるのに使う。
"""

from __future__ import annotations

import numpy as np

from .. import progress
from . import JobContext, JobError, job

HEIGHT_ATTR = "selftest height"
# 高さを 5 段に分けたときの分類コード（ASPRS: 2 地面・3〜5 植生・6 建物。見分けやすい色になるものを選んだ）
CLASSES = np.array([2, 3, 4, 5, 6], dtype=np.uint8)


@job("selftest-version", help="基盤の動作確認（点群を作り直して新しい版にする）")
def selftest_version(ctx: JobContext) -> dict:
    step = ctx.param("step", 1, int)
    if step < 1:
        raise JobError("間引きは 1 以上にしてください")
    r = ctx.reader()
    pos = next(a for a in r.meta["attributes"] if a["name"] == "position")
    zmin = float(pos["min"][2])
    zmax = float(pos["max"][2])
    span = max(zmax - zmin, 1e-6)
    progress.stage("write", "点の選別と書き出し", 0.6)
    done = 0
    kept = 0
    seen = 0
    with ctx.new_pointcloud(extra={HEIGHT_ATTR: "f4"}, lod_weight=0.4) as w:
        for b in r.iter_blocks():
            n = len(b.xyz)
            # 通し番号で間引く（ノードをまたいでも n 点に 1 点）
            idx = np.nonzero((np.arange(seen, seen + n) % step) == 0)[0]
            seen += n
            done += n
            if len(idx):
                xyz = b.xyz[idx]
                attrs = {k: v[idx] for k, v in b.attrs.items()}
                h = (xyz[:, 2] - zmin).astype(np.float32)
                band = np.clip((h / span * len(CLASSES)).astype(np.int64), 0, len(CLASSES) - 1)
                attrs["classification"] = CLASSES[band]
                attrs[HEIGHT_ATTR] = h
                b.xyz, b.attrs = xyz, attrs
                w.write(b)
                kept += len(idx)
            progress.progress("write", done, r.points)
    progress.progress("write", r.points, r.points, force=True)
    return {"keptPoints": kept, "sourcePoints": done, "step": step}
