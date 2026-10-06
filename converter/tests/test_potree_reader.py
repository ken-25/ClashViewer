from __future__ import annotations

import numpy as np
import pytest

from kasane_converter.potree_reader import PotreeFormatError, PotreeReader

from . import potree_fixture


def test_reads_all_nodes_including_proxy(tmp_path):
    blocks = potree_fixture.write(tmp_path / "pc")
    r = PotreeReader(tmp_path / "pc")
    assert [n.name for n in r.nodes()] == ["r", "r0", "r4"]
    got = {b.node: b for b in r.iter_blocks()}
    assert set(got) == {"r", "r0", "r4"}
    for k, v in blocks.items():
        expect = v["position"] * potree_fixture.SCALE + potree_fixture.OFFSET
        np.testing.assert_allclose(got[k].xyz, expect)
        np.testing.assert_array_equal(got[k].attrs["classification"], v["classification"])


def test_read_all_and_attribute_filter(tmp_path):
    potree_fixture.write(tmp_path / "pc")
    r = PotreeReader(tmp_path / "pc")
    all_ = r.read_all(["classification"])
    assert all_.xyz.shape == (12, 3)
    assert list(all_.attrs) == ["classification"]
    assert sorted(set(all_.attrs["classification"].tolist())) == [2, 6, 7]
    assert r.attribute_names == ["position", "rgb", "classification"]
    with pytest.raises(PotreeFormatError):
        list(r.iter_blocks(["intensity"]))


def test_rejects_compressed(tmp_path):
    import json

    potree_fixture.write(tmp_path / "pc")
    mp = tmp_path / "pc" / "metadata.json"
    meta = json.loads(mp.read_text(encoding="utf-8"))
    meta["encoding"] = "BROTLI"
    mp.write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(PotreeFormatError):
        PotreeReader(tmp_path / "pc")
