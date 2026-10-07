"""ジョブの共通の約束（引数・JSON 行・result 1 回・出力先）を確かめる。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kasane_converter import cli, jobs
from kasane_converter.potree_reader import PotreeReader

from . import potree_fixture


def _dataset(tmp_path, with_pc=True):
    datasets = tmp_path / "datasets"
    folder = datasets / "20260101_test_abc123"
    if with_pc:
        potree_fixture.write(folder / "pointcloud")
    manifest = {
        "schema": 2,
        "id": "abc123",
        "pointcloud": {"owner": folder.name, "dir": "pointcloud"} if with_pc else None,
        "models": [],
        "derived": [],
        "parent": None,
    }
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return datasets, folder


def _run(capsys, argv):
    code = cli.main(argv)
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines() if x.strip()]
    return code, lines


def test_selftest_registered():
    assert "selftest" in jobs.names()


def test_selftest_end_to_end(tmp_path, capsys):
    datasets, folder = _dataset(tmp_path)
    out = tmp_path / "out"
    params = tmp_path / "params.json"
    params.write_text("{}", encoding="utf-8")
    code, lines = _run(capsys, ["selftest", "--manifest", str(folder / "manifest.json"), "--datasets", str(datasets),
                                "--params", str(params), "--out", str(out), "--work", str(tmp_path / "w")])
    assert code == 0
    results = [x for x in lines if x["event"] == "result"]
    assert len(results) == 1
    assert results[0]["kind"] == "selftest"
    assert results[0]["points"] == 12
    assert any(x["event"] == "stage" for x in lines)
    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert summary["pointcloud"]["ranges"]["classification"] == [2.0, 7.0]
    # 作業用は消える。版のフォルダには書かない
    assert not (tmp_path / "w").exists()
    assert sorted(p.name for p in folder.iterdir()) == ["manifest.json", "pointcloud"]


def test_job_error_is_json_line(tmp_path, capsys):
    datasets, folder = _dataset(tmp_path)
    code, lines = _run(capsys, ["selftest", "--manifest", str(tmp_path / "none.json"), "--datasets", str(datasets),
                                "--out", str(tmp_path / "out")])
    assert code == 2
    assert lines[-1]["event"] == "error"


def test_dataset_file_rejects_escape(tmp_path):
    datasets, folder = _dataset(tmp_path, with_pc=False)
    ctx = jobs.JobContext(manifest={}, manifest_path=folder / "manifest.json", datasets=datasets, params={}, out=tmp_path, work=tmp_path)
    try:
        ctx.dataset_file("..", "secret.txt")
    except jobs.JobError:
        pass
    else:
        raise AssertionError("datasets の外を読めてしまう")
    try:
        ctx.pointcloud_dir()
    except jobs.JobError as e:
        assert "点群" in str(e)


def _potree_exe():
    root = Path(__file__).resolve().parents[2]
    for p in sorted((root / "third_party" / "PotreeConverter").glob("*/PotreeConverter.exe")):
        return p
    return None


def test_param_conversion(tmp_path):
    ctx = jobs.JobContext(manifest={}, manifest_path=tmp_path / "m.json", datasets=tmp_path, params={"step": "3", "bad": "x", "empty": ""},
                          out=tmp_path, work=tmp_path)
    assert ctx.param("step", 1, int) == 3
    assert ctx.param("empty", 5, int) == 5
    assert ctx.param("none", 7) == 7
    with pytest.raises(jobs.JobError):
        ctx.param("bad", 1, int)


def test_new_version_requires_potree(tmp_path, capsys):
    datasets, folder = _dataset(tmp_path)
    code, lines = _run(capsys, ["selftest-version", "--manifest", str(folder / "manifest.json"), "--datasets", str(datasets),
                                "--out", str(tmp_path / "out"), "--work", str(tmp_path / "w")])
    assert code == 1
    assert "PotreeConverter" in lines[-1]["message"]


@pytest.mark.skipif(_potree_exe() is None, reason="third_party/PotreeConverter がありません（scripts/fetch-third-party.ps1）")
def test_new_version_end_to_end(tmp_path, capsys):
    datasets, folder = _dataset(tmp_path)
    out = tmp_path / "out"
    params = tmp_path / "params.json"
    params.write_text(json.dumps({"step": 2}), encoding="utf-8")
    code, lines = _run(capsys, ["selftest-version", "--manifest", str(folder / "manifest.json"), "--datasets", str(datasets),
                                "--params", str(params), "--out", str(out), "--work", str(tmp_path / "w"),
                                "--potree", str(_potree_exe())])
    assert code == 0, lines[-1]
    result = [x for x in lines if x["event"] == "result"][0]
    pc = result["pointcloud"]
    assert result["keptPoints"] == 6 and pc["points"] == 6
    assert sum(pc["classCounts"].values()) == 6
    assert set(pc["classCounts"]) <= {"2", "3", "4", "5", "6"}
    assert "selftest height" in pc["attributes"] and "classification" in pc["attributes"]
    # 出力は out/pointcloud/ の 3 ファイルだけ（LAS・ログは残さない）
    assert sorted(p.name for p in (out / "pointcloud").iterdir()) == ["hierarchy.bin", "metadata.json", "octree.bin"]
    r = PotreeReader(out / "pointcloud")
    blk = r.read_all()
    assert len(blk.xyz) == 6
    assert blk.attrs["selftest height"].min() >= 0
    # 色（rgb）は元の値のまま
    assert int(blk.attrs["rgb"].max()) == 40000
    # 版のフォルダには書かない
    assert sorted(p.name for p in folder.iterdir()) == ["manifest.json", "pointcloud"]
