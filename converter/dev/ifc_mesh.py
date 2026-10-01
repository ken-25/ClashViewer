"""開発用: IfcOpenShell で IFC を三角形メッシュにする（サンプル生成・取込率の比較に使う）。"""

from __future__ import annotations

import multiprocessing
from dataclasses import dataclass

import ifcopenshell
import ifcopenshell.geom
import numpy as np

# 形状を表示しない（形状を作れなくても問題にしない）クラス
NON_DISPLAY = {"IfcOpeningElement", "IfcSpace", "IfcAnnotation", "IfcGrid", "IfcVirtualElement", "IfcSite"}


@dataclass
class ElementMesh:
    guid: str
    ifc_class: str
    name: str
    verts: np.ndarray  # (n, 3) float64 m、IFC の座標（Z 上）
    faces: np.ndarray  # (m, 3) int


def iter_meshes(path: str):
    f = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    it = ifcopenshell.geom.iterator(settings, f, multiprocessing.cpu_count())
    if it.initialize():
        while True:
            shape = it.get()
            el = f.by_id(shape.id)
            g = shape.geometry
            verts = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
            faces = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
            if len(faces):
                yield ElementMesh(el.GlobalId, el.is_a(), getattr(el, "Name", "") or "", verts, faces)
            if not it.next():
                break


def products_with_representation(path: str) -> dict[str, str]:
    """形状表現を持つ表示対象の要素（GlobalId → クラス）。"""
    f = ifcopenshell.open(path)
    out = {}
    for el in f.by_type("IfcProduct"):
        if el.is_a() in NON_DISPLAY or any(el.is_a(c) for c in ("IfcOpeningElement", "IfcSpatialStructureElement")):
            continue
        if getattr(el, "Representation", None):
            out[el.GlobalId] = el.is_a()
    return out
