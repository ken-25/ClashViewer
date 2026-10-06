"""Potree 2.0 形式（圧縮なし）の読み込み。

保存済みの版（datasets/<版>/pointcloud/）から全点を復元するために使う。
干渉チェック・分類・点群処理などのジョブは、元の E57 ではなくこれを入力にする
（E57 はデータフォルダに残さないため）。

Potree 2.0 では各点はちょうど 1 つのノードに入る（親ノードは間引いた代表点、子は残りの点）。
したがって全ノードを読めば全点になる。

形式は Potree（BSD-2-Clause, Markus Schütz）と viewer/src/pointcloud/potree.ts の読み方に合わせた。
"""

from __future__ import annotations

import json
import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

BYTES_PER_NODE = 22
_NODE = struct.Struct("<BBIqq")  # type, childMask, numPoints, byteOffset, byteSize

NODE_NORMAL = 0
NODE_LEAF = 1
NODE_PROXY = 2

# metadata.json の type → numpy の型
_TYPES = {
    "int8": "i1",
    "int16": "<i2",
    "int32": "<i4",
    "int64": "<i8",
    "uint8": "u1",
    "uint16": "<u2",
    "uint32": "<u4",
    "uint64": "<u8",
    "float": "<f4",
    "double": "<f8",
}


class PotreeFormatError(ValueError):
    pass


@dataclass
class Node:
    name: str
    level: int
    num_points: int = 0
    byte_offset: int = 0
    byte_size: int = 0
    node_type: int = NODE_NORMAL
    hierarchy_offset: int = 0
    hierarchy_size: int = 0
    children: list[Node] = field(default_factory=list)


@dataclass
class PointBlock:
    """1 ノード分の点。xyz は世界座標（float64）。attrs は position 以外の属性（名前 → 配列）。"""

    node: str
    xyz: np.ndarray
    attrs: dict[str, np.ndarray]


class PotreeReader:
    """metadata.json / hierarchy.bin / octree.bin を読む。"""

    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        meta_path = self.dir / "metadata.json"
        if not meta_path.is_file():
            raise PotreeFormatError(f"metadata.json がありません: {self.dir}")
        self.meta = json.loads(meta_path.read_text(encoding="utf-8"))
        version = str(self.meta.get("version", ""))
        if not version.startswith("2."):
            raise PotreeFormatError(f"Potree {version} 形式には対応していません")
        if self.meta.get("encoding") not in ("DEFAULT", "UNCOMPRESSED"):
            raise PotreeFormatError(f"点群の圧縮形式 {self.meta.get('encoding')} には対応していません")
        self.scale = np.asarray(self.meta["scale"], dtype=np.float64)
        self.offset = np.asarray(self.meta["offset"], dtype=np.float64)
        self.dtype = self._build_dtype(self.meta["attributes"])
        if self.dtype.itemsize == 0:
            raise PotreeFormatError("属性がありません")
        self.root = Node("r", 0, node_type=NODE_PROXY, hierarchy_offset=0, hierarchy_size=self.meta["hierarchy"]["firstChunkSize"])
        self._load_hierarchy(self.root)

    @staticmethod
    def _build_dtype(attributes: list[dict]) -> np.dtype:
        fields = []
        for a in attributes:
            t = _TYPES.get(a["type"])
            if t is None:
                raise PotreeFormatError(f"属性 {a['name']} の型 {a['type']} には対応していません")
            n = int(a.get("numElements", 1))
            if np.dtype(t).itemsize * n != int(a["size"]):
                raise PotreeFormatError(f"属性 {a['name']} の大きさが合いません")
            fields.append((a["name"], t, (n,)) if n > 1 else (a["name"], t))
        return np.dtype(fields)

    @property
    def points(self) -> int:
        return int(self.meta["points"])

    @property
    def attribute_names(self) -> list[str]:
        return [a["name"] for a in self.meta["attributes"]]

    # ---- 階層 ----

    def _load_hierarchy(self, node: Node) -> None:
        with open(self.dir / "hierarchy.bin", "rb") as f:
            f.seek(node.hierarchy_offset)
            buf = f.read(node.hierarchy_size)
        if len(buf) != node.hierarchy_size:
            raise PotreeFormatError("hierarchy.bin が途中で切れています")
        nodes = [node]
        count = len(buf) // BYTES_PER_NODE
        i = 0
        while i < count and i < len(nodes):
            cur = nodes[i]
            ntype, mask, npts, off, size = _NODE.unpack_from(buf, i * BYTES_PER_NODE)
            if cur.node_type == NODE_PROXY:
                # 子チャンクの先頭は自分自身。中身で置き換える
                cur.byte_offset, cur.byte_size, cur.num_points = off, size, npts
            elif ntype == NODE_PROXY:
                cur.hierarchy_offset, cur.hierarchy_size, cur.num_points = off, size, npts
            else:
                cur.byte_offset, cur.byte_size, cur.num_points = off, size, npts
            cur.node_type = ntype
            i += 1
            if ntype == NODE_PROXY:
                continue
            for ci in range(8):
                if mask & (1 << ci):
                    child = Node(cur.name + str(ci), cur.level + 1)
                    cur.children.append(child)
                    nodes.append(child)
        # 先の子チャンク（proxy のまま残ったノード）を読む
        for n in nodes[1:]:
            if n.node_type == NODE_PROXY:
                self._load_hierarchy(n)

    def nodes(self) -> Iterator[Node]:
        """全ノード（幅優先）。"""
        queue = [self.root]
        while queue:
            n = queue.pop(0)
            yield n
            queue.extend(n.children)

    # ---- 点 ----

    def iter_blocks(self, attributes: list[str] | None = None) -> Iterator[PointBlock]:
        """ノードごとに点を返す。attributes を指定すると position 以外はその属性だけ。"""
        names = [n for n in self.dtype.names if n != "position"]
        if attributes is not None:
            unknown = set(attributes) - set(names)
            if unknown:
                raise PotreeFormatError(f"点群にない属性です: {', '.join(sorted(unknown))}")
            names = [n for n in names if n in attributes]
        with open(self.dir / "octree.bin", "rb") as f:
            for node in self.nodes():
                if node.num_points == 0 or node.byte_size == 0:
                    continue
                f.seek(node.byte_offset)
                buf = f.read(node.byte_size)
                n = min(node.num_points, len(buf) // self.dtype.itemsize)
                rec = np.frombuffer(buf, dtype=self.dtype, count=n)
                xyz = rec["position"].astype(np.float64) * self.scale + self.offset
                yield PointBlock(node.name, xyz, {k: rec[k].copy() for k in names})

    def read_all(self, attributes: list[str] | None = None) -> PointBlock:
        """全点を 1 つの配列にまとめる（数千万点ではメモリに注意。大きい点群は iter_blocks を使う）。"""
        blocks = list(self.iter_blocks(attributes))
        if not blocks:
            return PointBlock("*", np.zeros((0, 3)), {})
        keys = blocks[0].attrs.keys()
        return PointBlock(
            "*",
            np.concatenate([b.xyz for b in blocks]),
            {k: np.concatenate([b.attrs[k] for b in blocks]) for k in keys},
        )
