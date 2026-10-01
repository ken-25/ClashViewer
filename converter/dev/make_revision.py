"""開発用: IFC の「改訂版」を作る（版差分の確認用）。

- 先頭 N 件の要素を削除
- 次の N 件の要素を Z 方向へ移動
- 次の N 件の要素の名称を変える（属性の変更）
- 1 件の要素を複製し、新しい GlobalId で追加

  uv run python dev/make_revision.py in.ifc out.ifc --n 5 --cls IfcColumn
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import ifcopenshell.util.placement
import ifcopenshell.util.element
import numpy as np


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--cls", default="IfcColumn")
    ap.add_argument("--dz", type=float, default=0.3, help="移動量（m）")
    args = ap.parse_args()
    f = ifcopenshell.open(args.src)
    import ifcopenshell.util.unit as uu

    scale = uu.calculate_unit_scale(f)
    els = [e for e in f.by_type(args.cls) if e.Representation and e.ObjectPlacement]
    n = args.n
    removed, moved, renamed = els[:n], els[n : 2 * n], els[2 * n : 3 * n]
    truth = {"removed": [e.GlobalId for e in removed], "moved": [e.GlobalId for e in moved], "renamed": [e.GlobalId for e in renamed]}
    for e in moved:
        m = ifcopenshell.util.placement.get_local_placement(e.ObjectPlacement)
        m[2, 3] += args.dz / scale
        ifcopenshell.api.run("geometry.edit_object_placement", f, product=e, matrix=m, is_si=False)
    for e in renamed:
        e.Name = (e.Name or "") + "_改"
    src = els[3 * n]
    dup = ifcopenshell.api.run("root.copy_class", f, product=src)
    # copy_class は形状を写さないので、元の形状表現を共有させる
    dup.Representation = src.Representation
    m = ifcopenshell.util.placement.get_local_placement(src.ObjectPlacement)
    m[0, 3] += 1.0 / scale
    ifcopenshell.api.run("geometry.edit_object_placement", f, product=dup, matrix=m, is_si=False)
    truth["added"] = [dup.GlobalId]
    for e in removed:
        ifcopenshell.api.run("root.remove_product", f, product=e)
    f.write(args.dst)
    Path(args.dst).with_suffix(".truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
    print(json.dumps({k: len(v) for k, v in truth.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
