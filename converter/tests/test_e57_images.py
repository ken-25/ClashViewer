"""撮影ポイントの画像（E57 の images2D）の読み出しと書き出し。

画像付きの E57 は手元のサンプルに無いので、pye57 で小さなファイルを合成して確かめる。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pye57
import pytest
from pye57 import libe57

from kasane_converter import cli
from kasane_converter.e57 import E57Reader

JPEG = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 40 + b"\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + bytes(300)


def _struct(imf, **children):
    s = libe57.StructureNode(imf)
    for k, v in children.items():
        s.set(k, v)
    return s


def _pose(imf, rotation, translation):
    w, x, y, z = rotation
    return _struct(
        imf,
        rotation=_struct(imf, w=libe57.FloatNode(imf, w), x=libe57.FloatNode(imf, x), y=libe57.FloatNode(imf, y), z=libe57.FloatNode(imf, z)),
        translation=_struct(
            imf, x=libe57.FloatNode(imf, translation[0]), y=libe57.FloatNode(imf, translation[1]), z=libe57.FloatNode(imf, translation[2])
        ),
    )


def _add_image(e57, name, scan_guid, rep_key, blob_key, data, extra, pose=None):
    imf = e57.image_file
    img = libe57.StructureNode(imf)
    img.set("guid", libe57.StringNode(imf, f"{{img-{name}}}"))
    img.set("name", libe57.StringNode(imf, name))
    if scan_guid:
        img.set("associatedData3DGuid", libe57.StringNode(imf, scan_guid))
    if pose:
        img.set("pose", _pose(imf, *pose))
    rep = libe57.StructureNode(imf)
    blob = libe57.BlobNode(imf, len(data))
    rep.set(blob_key, blob)
    for k, v in extra.items():
        rep.set(k, libe57.IntegerNode(imf, v) if isinstance(v, int) else libe57.FloatNode(imf, v))
    img.set(rep_key, rep)
    e57.root["images2D"].append(img)
    # Blob は木に付けてから書く（libE57 の決まり）
    blob.write(np.frombuffer(data, dtype=np.uint8).copy(), 0, len(data))


@pytest.fixture()
def e57_with_images(tmp_path: Path) -> Path:
    path = tmp_path / "with_images.e57"
    e57 = pye57.E57(str(path), mode="w")
    rng = np.random.default_rng(1)
    pts = rng.uniform(-5, 5, size=(500, 3))
    e57.write_scan_raw(
        {"cartesianX": pts[:, 0], "cartesianY": pts[:, 1], "cartesianZ": pts[:, 2]},
        name="Scan_01",
        rotation=np.array([1.0, 0.0, 0.0, 0.0]),
        translation=np.array([100.0, 200.0, 1.5]),
    )
    scan_guid = e57.root["data3D"][0]["guid"].value()
    _add_image(
        e57,
        "pano",
        scan_guid,
        "sphericalRepresentation",
        "jpegImage",
        JPEG,
        {"imageWidth": 64, "imageHeight": 32, "pixelWidth": 2 * np.pi / 64, "pixelHeight": np.pi / 32},
        pose=([1.0, 0.0, 0.0, 0.0], [100.0, 200.0, 1.6]),
    )
    _add_image(
        e57,
        "photo",
        scan_guid,
        "pinholeRepresentation",
        "pngImage",
        PNG,
        {"imageWidth": 40, "imageHeight": 30, "pixelWidth": 1e-5, "pixelHeight": 1e-5, "focalLength": 4e-4, "principalPointX": 20.0, "principalPointY": 15.0},
    )
    # 参考画像だけ（姿勢と結び付かない）は撮影ポイントの画像にしない
    _add_image(e57, "preview", scan_guid, "visualReferenceRepresentation", "jpegImage", JPEG, {"imageWidth": 8, "imageHeight": 8})
    e57.close()
    return path


def test_reader_lists_images(e57_with_images: Path):
    with E57Reader(str(e57_with_images)) as r:
        assert [i.name for i in r.images] == ["pano", "photo"]
        pano, photo = r.images
        assert pano.kind == "spherical" and pano.format == "jpeg" and pano.byte_count == len(JPEG)
        assert pano.scan_guid == r.scans[0].guid
        assert pano.has_pose and pano.translation == [100.0, 200.0, 1.6]
        assert (pano.width, pano.height) == (64, 32)
        assert photo.kind == "pinhole" and photo.format == "png"
        assert not photo.has_pose
        assert photo.focal_length == pytest.approx(4e-4)
        assert photo.principal_point == [20.0, 15.0]
        assert r.image_errors == []


def test_write_image_copies_bytes(e57_with_images: Path, tmp_path: Path):
    with E57Reader(str(e57_with_images)) as r:
        out = tmp_path / "pano.jpg"
        # 小さい塊で読んでも同じ中身になる
        assert r.write_image(r.images[0], str(out), chunk=100) == len(JPEG)
        assert out.read_bytes() == JPEG


def test_extract_images_records_sources(e57_with_images: Path, tmp_path: Path, capsys):
    sources = [{"name": e57_with_images.name}]
    n = cli.extract_images([e57_with_images], sources, tmp_path / "images", "images")
    assert n == 2
    imgs = sources[0]["images"]
    assert [i["file"] for i in imgs] == ["images/00_0000.jpg", "images/00_0001.png"]
    assert (tmp_path / "images" / "00_0000.jpg").read_bytes() == JPEG
    assert (tmp_path / "images" / "00_0001.png").read_bytes() == PNG
    assert imgs[0]["pose"] == {"rotation": [1.0, 0.0, 0.0, 0.0], "translation": [100.0, 200.0, 1.6]}
    assert imgs[1]["pose"] is None and imgs[1]["focalLength"] == pytest.approx(4e-4)
    # 進捗は JSON 行で出る
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines() if x.strip()]
    assert any(x["event"] == "progress" and x["stage"] == "images" for x in lines)


def test_extract_images_without_dir_only_records(e57_with_images: Path):
    sources = [{"name": e57_with_images.name}]
    assert cli.extract_images([e57_with_images], sources, None, "images") == 0
    assert [i["file"] for i in sources[0]["images"]] == [None, None]


def test_scan_bounds_in_las_stats(e57_with_images: Path, tmp_path: Path):
    st = cli.e57_to_las(e57_with_images, tmp_path / "a.las", "read", 0, 500)
    b = st["scans"][0]["bounds"]
    # 姿勢（平行移動）を掛けた共通座標の範囲。器械点（姿勢の位置）を含む
    assert b["min"][0] > 94 and b["max"][0] < 106
    assert b["min"][0] <= 100 <= b["max"][0]


def test_e57_without_images(tmp_path: Path):
    path = tmp_path / "plain.e57"
    e57 = pye57.E57(str(path), mode="w")
    pts = np.zeros((10, 3))
    e57.write_scan_raw({"cartesianX": pts[:, 0], "cartesianY": pts[:, 1], "cartesianZ": pts[:, 2]}, name="S")
    e57.close()
    with E57Reader(str(path)) as r:
        assert r.images == []
