"""E57 の読込。

スキャンごとに一定点数ずつ読み、姿勢（pose）を掛けて共通座標の点にする。
1 スキャンを丸ごとメモリに載せないため、数億点のスキャンでも使用メモリは
チャンクの大きさで決まる。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator

import numpy as np
from pye57 import libe57
from pyquaternion import Quaternion

CHUNK_POINTS = 2_000_000


@dataclass
class ScanInfo:
    index: int
    name: str
    guid: str
    point_count: int  # 無効点を含む格納点数
    coordinate_system: str  # cartesian / spherical
    has_color: bool
    has_intensity: bool
    color_max: float
    intensity_min: float
    intensity_max: float
    rotation: list[float]  # 四元数 w, x, y, z
    translation: list[float]
    fields: list[str] = field(default_factory=list)


@dataclass
class PointChunk:
    xyz: np.ndarray  # (n, 3) float64、共通座標（m）
    intensity: np.ndarray | None  # (n,) uint16 0..65535
    rgb: np.ndarray | None  # (n, 3) uint16 0..65535
    scan_index: int


def _child_value(node: libe57.StructureNode, path: str, default):
    try:
        cur = node
        for p in path.split("/"):
            cur = cur[p]
        return cur.value()
    except Exception:  # E57 の任意項目は無いことが多い
        return default


def _fields(node) -> list[str]:
    proto = libe57.StructureNode(node["points"].prototype())
    return [proto.get(i).elementName() for i in range(proto.childCount())]


class E57Reader:
    def __init__(self, path: str):
        self.path = path
        self.image = libe57.ImageFile(path, "r")
        root = self.image.root()
        # pye57 の [] アクセスは具体的なノード型を返す
        self.data3d = root["data3D"]
        self.scans = [self._scan_info(i) for i in range(self.data3d.childCount())]

    def close(self) -> None:
        self.image.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _scan_node(self, index: int) -> libe57.StructureNode:
        return self.data3d[index]

    def _scan_info(self, index: int) -> ScanInfo:
        node = self._scan_node(index)
        fields = _fields(node)
        if all(f in fields for f in ("cartesianX", "cartesianY", "cartesianZ")):
            cs = "cartesian"
        elif all(f in fields for f in ("sphericalRange", "sphericalAzimuth", "sphericalElevation")):
            cs = "spherical"
        else:
            raise ValueError(f"スキャン {index} の座標系に対応していません: {fields}")
        has_color = all(f in fields for f in ("colorRed", "colorGreen", "colorBlue"))
        has_intensity = "intensity" in fields
        color_max = float(_child_value(node, "colorLimits/colorRedMaximum", 0) or 0)
        if has_color and color_max <= 0:
            # colorLimits が無ければ格納型の上限から推定する
            try:
                proto = libe57.StructureNode(node["points"].prototype())
                color_max = float(proto["colorRed"].maximum())
            except Exception:
                color_max = 255.0
        i_min = float(_child_value(node, "intensityLimits/intensityMinimum", np.nan))
        i_max = float(_child_value(node, "intensityLimits/intensityMaximum", np.nan))
        if has_intensity and (np.isnan(i_min) or np.isnan(i_max) or i_max <= i_min):
            i_min, i_max = self._intensity_limits_from_prototype(node)
        rotation = [
            float(_child_value(node, f"pose/rotation/{k}", d)) for k, d in (("w", 1.0), ("x", 0.0), ("y", 0.0), ("z", 0.0))
        ]
        translation = [float(_child_value(node, f"pose/translation/{k}", 0.0)) for k in ("x", "y", "z")]
        return ScanInfo(
            index=index,
            name=str(_child_value(node, "name", f"Scan {index}")),
            guid=str(_child_value(node, "guid", "")),
            point_count=int(node["points"].childCount()),
            coordinate_system=cs,
            has_color=has_color,
            has_intensity=has_intensity,
            color_max=color_max,
            intensity_min=i_min if has_intensity else 0.0,
            intensity_max=i_max if has_intensity else 1.0,
            rotation=rotation,
            translation=translation,
            fields=fields,
        )

    @staticmethod
    def _intensity_limits_from_prototype(node) -> tuple[float, float]:
        try:
            proto = libe57.StructureNode(node["points"].prototype())
            child = proto["intensity"]
            lo, hi = float(child.minimum()), float(child.maximum())
            if hi > lo:
                return lo, hi
        except Exception:
            pass
        return 0.0, 1.0

    @property
    def total_points(self) -> int:
        return sum(s.point_count for s in self.scans)

    def iter_scan(self, index: int, chunk_points: int = CHUNK_POINTS) -> Iterator[tuple[PointChunk, int]]:
        """スキャンを読み、(共通座標の点, 読んだ格納点数) を順に返す。"""
        info = self.scans[index]
        node = self._scan_node(index)
        cap = max(1, min(chunk_points, info.point_count))
        names: list[str]
        if info.coordinate_system == "cartesian":
            names = ["cartesianX", "cartesianY", "cartesianZ"]
            invalid_name = "cartesianInvalidState"
        else:
            names = ["sphericalRange", "sphericalAzimuth", "sphericalElevation"]
            invalid_name = "sphericalInvalidState"
        arrays: dict[str, np.ndarray] = {n: np.empty(cap, np.float64) for n in names}
        if invalid_name in info.fields:
            arrays[invalid_name] = np.empty(cap, np.int8)
        if info.has_intensity:
            arrays["intensity"] = np.empty(cap, np.float32)
        color_dtype = np.uint8 if info.color_max <= 255 else np.uint16
        if info.has_color:
            for c in ("colorRed", "colorGreen", "colorBlue"):
                arrays[c] = np.empty(cap, color_dtype)

        buffers = libe57.VectorSourceDestBuffer()
        for n, a in arrays.items():
            buffers.append(libe57.SourceDestBuffer(self.image, n, a, cap, True, True))

        rot = Quaternion(info.rotation).rotation_matrix
        trans = np.asarray(info.translation, dtype=np.float64)
        has_pose = info.rotation != [1.0, 0.0, 0.0, 0.0] or any(trans != 0)
        i_scale = 65535.0 / (info.intensity_max - info.intensity_min) if info.has_intensity else 0.0
        c_scale = 65535.0 / info.color_max if info.has_color and info.color_max > 0 else 257.0

        reader = node["points"].reader(buffers)
        try:
            while True:
                n = reader.read()
                if n == 0:
                    break
                if invalid_name in arrays:
                    valid = arrays[invalid_name][:n] == 0
                else:
                    valid = np.ones(n, dtype=bool)
                if info.coordinate_system == "cartesian":
                    xyz = np.stack([arrays[k][:n][valid] for k in names], axis=1)
                else:
                    r = arrays["sphericalRange"][:n][valid]
                    az = arrays["sphericalAzimuth"][:n][valid]
                    el = arrays["sphericalElevation"][:n][valid]
                    rc = r * np.cos(el)
                    xyz = np.stack([rc * np.cos(az), rc * np.sin(az), r * np.sin(el)], axis=1)
                if has_pose:
                    xyz = xyz @ rot.T + trans
                intensity = None
                if info.has_intensity:
                    v = (arrays["intensity"][:n][valid].astype(np.float64) - info.intensity_min) * i_scale
                    intensity = np.clip(v, 0, 65535).astype(np.uint16)
                rgb = None
                if info.has_color:
                    rgb = np.stack(
                        [arrays[c][:n][valid].astype(np.float64) for c in ("colorRed", "colorGreen", "colorBlue")], axis=1
                    )
                    rgb = np.clip(rgb * c_scale, 0, 65535).astype(np.uint16)
                yield PointChunk(xyz=xyz, intensity=intensity, rgb=rgb, scan_index=index), n
        finally:
            reader.close()
