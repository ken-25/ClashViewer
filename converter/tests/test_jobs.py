"""ジョブの共通の約束（引数・JSON 行・result 1 回・出力先）を確かめる。"""

from __future__ import annotations

import json

from kasane_converter import cli, jobs

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
