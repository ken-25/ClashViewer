"""開発用: IFC の形状から「現況を測った」体の点群（E57）を合成する。

実データが無い段階で取込・重ね表示・3点合わせ・干渉確認を試すためのもの。

- IFC 要素の表面を面積比で一様にサンプリングし、計測誤差（ノイズ）を加える
- 一部の配管・ダクトを施工誤差としてずらし、一部の要素を「未施工」として抜く
- 全体を測量座標へ回転・平行移動する（3点合わせが必要になる）
- 複数の器械点（スキャン）に分け、各スキャンを器械点のローカル座標＋姿勢で格納する

使い方:
  uv run python dev/make_samples.py --ifc a.ifc --ifc b.ifc --out x.e57 --points 20000000
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import pye57
from pyquaternion import Quaternion

sys.path.insert(0, str(Path(__file__).parent))
from ifc_mesh import iter_meshes  # noqa: E402

CLASS_COLORS = {
    "IfcWall": (200, 196, 188),
    "IfcWallStandardCase": (200, 196, 188),
    "IfcSlab": (165, 160, 150),
    "IfcColumn": (150, 150, 155),
    "IfcBeam": (140, 140, 150),
    "IfcDuctSegment": (180, 190, 200),
    "IfcDuctFitting": (180, 190, 200),
    "IfcPipeSegment": (120, 160, 120),
    "IfcPipeFitting": (120, 160, 120),
    "IfcCableCarrierSegment": (200, 170, 90),
    "IfcCableCarrierFitting": (200, 170, 90),
    "IfcDoor": (150, 110, 80),
    "IfcWindow": (120, 170, 210),
}
SKIP = {"IfcSpace", "IfcOpeningElement", "IfcAnnotation", "IfcSite", "IfcGrid", "IfcVirtualElement"}
MEP = ("IfcDuctSegment", "IfcPipeSegment", "IfcCableCarrierSegment")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ifc", action="append", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--points", type=int, default=20_000_000)
    ap.add_argument("--scans", type=int, default=6)
    ap.add_argument("--noise", type=float, default=0.004, help="計測誤差の標準偏差（m）")
    ap.add_argument("--shift-ratio", type=float, default=0.08, help="ずらす配管・ダクトの割合")
    ap.add_argument("--shift", type=float, default=0.12, help="施工誤差としてずらす量（m）")
    ap.add_argument("--missing", type=int, default=5, help="未施工として抜く要素数")
    ap.add_argument("--survey", action="store_true", help="測量座標へ移す（3点合わせが必要になる）")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    t0 = time.time()
    tris = []
    tri_class = []
    elements = []
    for path in args.ifc:
        for m in iter_meshes(path):
            if m.ifc_class in SKIP:
                continue
            elements.append((m.guid, m.ifc_class, m.name, len(tris)))
            tris.append(m.verts[m.faces])
            tri_class.append(m.ifc_class)
    print(f"要素 {len(elements)} 件を読込（{time.time() - t0:.1f}s）")

    # 施工誤差・未施工の要素を決める
    mep_idx = [i for i, e in enumerate(elements) if e[1] in MEP]
    n_shift = int(len(mep_idx) * args.shift_ratio)
    shifted = set(rng.choice(mep_idx, size=n_shift, replace=False).tolist()) if n_shift else set()
    candidates = [i for i in mep_idx if i not in shifted] or list(range(len(elements)))
    missing = set(rng.choice(candidates, size=min(args.missing, len(candidates)), replace=False).tolist())

    all_tris = []
    colors = []
    for i, t in enumerate(tris):
        if i in missing:
            continue
        t = t.copy()
        if i in shifted:
            t[..., 2] += args.shift
        all_tris.append(t)
        colors.append(np.tile(np.array(CLASS_COLORS.get(tri_class[i], (175, 175, 175)), np.float64), (len(t), 1)))
    T = np.concatenate(all_tris)
    C = np.concatenate(colors)
    area = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
    total_area = float(area.sum())
    print(f"三角形 {len(T):,} 枚、表面積 {total_area:,.0f} m2、点密度 {args.points / total_area:,.0f} 点/m2")

    # 面積比でサンプリング（大きいと 1 度に作るとメモリが厳しいので分割）
    cdf = np.cumsum(area) / total_area
    lo = T.reshape(-1, 3).min(0)
    hi = T.reshape(-1, 3).max(0)
    # 器械点は建物の床付近に格子状に置く
    nx = max(1, round(math.sqrt(args.scans * (hi[0] - lo[0]) / max(1e-6, hi[1] - lo[1]))))
    ny = max(1, math.ceil(args.scans / nx))
    stations = []
    for ix in range(nx):
        for iy in range(ny):
            if len(stations) < args.scans:
                stations.append([lo[0] + (ix + 0.5) * (hi[0] - lo[0]) / nx, lo[1] + (iy + 0.5) * (hi[1] - lo[1]) / ny, lo[2] + 1.5])
    stations = np.array(stations)

    # 測量座標への変換（Z 回りの回転＋平行移動）
    yaw = math.radians(23.5) if args.survey else 0.0
    shift = np.array([-35210.0, 12880.0, 3.2]) if args.survey else np.zeros(3)
    R = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])

    per_scan = [[] for _ in stations]
    batch = 5_000_000
    remaining = args.points
    while remaining > 0:
        n = min(batch, remaining)
        remaining -= n
        ti = np.searchsorted(cdf, rng.random(n))
        ti = np.minimum(ti, len(T) - 1)
        u = rng.random(n)
        v = rng.random(n)
        flip = u + v > 1
        u[flip] = 1 - u[flip]
        v[flip] = 1 - v[flip]
        tri = T[ti]
        p = tri[:, 0] + (tri[:, 1] - tri[:, 0]) * u[:, None] + (tri[:, 2] - tri[:, 0]) * v[:, None]
        p += rng.normal(0, args.noise, size=p.shape)
        shade = rng.normal(1.0, 0.06, size=(n, 1))
        col = np.clip(C[ti] * shade, 0, 255).astype(np.uint8)
        d2 = ((p[:, None, :2] - stations[None, :, :2]) ** 2).sum(-1)
        nearest = d2.argmin(1)
        dist = np.sqrt(d2[np.arange(n), nearest])
        inten = np.clip(1.0 - dist / (dist.max() + 1e-6) + rng.normal(0, 0.05, n), 0, 1).astype(np.float32)
        world = p @ R.T + shift
        for s in range(len(stations)):
            m = nearest == s
            if m.any():
                per_scan[s].append((world[m], col[m], inten[m]))
        print(f"  {args.points - remaining:,} / {args.points:,} 点")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    e57 = pye57.E57(str(out), mode="w")
    for s, parts in enumerate(per_scan):
        if not parts:
            continue
        world = np.concatenate([a for a, _, _ in parts])
        col = np.concatenate([b for _, b, _ in parts])
        inten = np.concatenate([c for _, _, c in parts])
        # 器械点ローカル（器械点を原点・任意の向き）で格納し、姿勢を付ける
        st_world = stations[s] @ R.T + shift
        q = Quaternion(axis=[0, 0, 1], angle=float(rng.uniform(0, 2 * math.pi)))
        local = (world - st_world) @ q.rotation_matrix  # = R^T (p - t)
        e57.write_scan_raw(
            {
                "cartesianX": local[:, 0],
                "cartesianY": local[:, 1],
                "cartesianZ": local[:, 2],
                "intensity": inten,
                "colorRed": col[:, 0],
                "colorGreen": col[:, 1],
                "colorBlue": col[:, 2],
            },
            name=f"Scan_{s + 1:02d}",
            rotation=q.elements,
            translation=st_world,
        )
        print(f"  スキャン {s + 1}: {len(world):,} 点")
    e57.close()

    truth = {
        "ifc": [Path(p).name for p in args.ifc],
        "points": args.points,
        "survey": bool(args.survey),
        "yawDeg": math.degrees(yaw),
        "shift": shift.tolist(),
        "shifted": [{"guid": elements[i][0], "class": elements[i][1], "name": elements[i][2], "dz": args.shift} for i in sorted(shifted)],
        "missing": [{"guid": elements[i][0], "class": elements[i][1], "name": elements[i][2]} for i in sorted(missing)],
    }
    out.with_suffix(".truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"完了: {out}（{out.stat().st_size / 1e6:,.0f} MB, {time.time() - t0:.0f}s）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
