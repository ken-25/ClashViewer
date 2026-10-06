"""テスト用に小さな Potree 2.0（圧縮なし）を書く。

階層: r（通常・子 0 と 4）→ r0（葉）/ r4（proxy → 2 つ目のチャンクに本体。葉）
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

SCALE = 0.001
OFFSET = [1000.0, 2000.0, 10.0]

DTYPE = np.dtype([("position", "<i4", (3,)), ("rgb", "<u2", (3,)), ("classification", "u1")])


def make_points(n: int, base: float, cls: int) -> np.ndarray:
    rec = np.zeros(n, dtype=DTYPE)
    xyz = np.stack([np.arange(n) * 0.01 + base, np.full(n, base), np.full(n, 1.5)], axis=1)
    rec["position"] = np.round(xyz / SCALE).astype(np.int32)
    rec["rgb"] = 40000
    rec["classification"] = cls
    return rec


def write(dir: Path) -> dict[str, np.ndarray]:
    dir.mkdir(parents=True, exist_ok=True)
    blocks = {"r": make_points(5, 0.0, 2), "r0": make_points(3, 1.0, 6), "r4": make_points(4, 2.0, 7)}
    octree = b""
    offs: dict[str, tuple[int, int]] = {}
    for k, v in blocks.items():
        b = v.tobytes()
        offs[k] = (len(octree), len(b))
        octree += b
    (dir / "octree.bin").write_bytes(octree)

    node = struct.Struct("<BBIqq")
    # 2 つ目のチャンク（r4 の本体）
    chunk2 = node.pack(1, 0, 4, *offs["r4"])
    chunk1 = (
        node.pack(0, 0b00010001, 5, *offs["r"])  # 子 0 と 4
        + node.pack(1, 0, 3, *offs["r0"])
        + node.pack(2, 0, 4, len(b"") + 3 * node.size, node.size)  # proxy: hierarchy の位置
    )
    (dir / "hierarchy.bin").write_bytes(chunk1 + chunk2)

    all_xyz = np.concatenate([v["position"] for v in blocks.values()]) * SCALE + OFFSET
    meta = {
        "version": "2.0",
        "name": "test",
        "points": 12,
        "hierarchy": {"firstChunkSize": len(chunk1), "stepSize": 4, "depth": 1},
        "offset": OFFSET,
        "scale": [SCALE] * 3,
        "spacing": 0.1,
        "boundingBox": {"min": OFFSET, "max": [o + 10 for o in OFFSET]},
        "encoding": "DEFAULT",
        "attributes": [
            {"name": "position", "size": 12, "numElements": 3, "elementSize": 4, "type": "int32",
             "min": all_xyz.min(axis=0).tolist(), "max": all_xyz.max(axis=0).tolist()},
            {"name": "rgb", "size": 6, "numElements": 3, "elementSize": 2, "type": "uint16", "min": [0] * 3, "max": [65535] * 3},
            {"name": "classification", "size": 1, "numElements": 1, "elementSize": 1, "type": "uint8", "min": [2], "max": [7]},
        ],
    }
    (dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return blocks
