"""公開済みの版に対する処理（ジョブ）のサブコマンド。

ビューア exe（app/Kasane.Host/JobService.cs）は次の形で呼ぶ。引数は全ジョブ共通。

    converter.exe <ジョブ名> --manifest <版>/manifest.json --datasets <datasets/> \
        --params <params.json> --out <出力先> --work <作業用> [--potree <PotreeConverter.exe>]

- 入力は manifest と、その版のファイル（JobContext が場所を解決する）。版のフォルダには書かない
- 出力は --out の下にだけ書く。終わるとビューア exe が受け取る（JobService.Kinds の Target で決まる）
  - derived: --out の中身を datasets/<版>/derived/<ID>/ へ写し、manifest の derived に追記する
  - newVersion: ctx.new_pointcloud() で --out/pointcloud/ に点群を作る。それを点群にした新しい版を公開する
- 進捗・結果は progress（JSON 行）。result はちょうど 1 回。戻り値の dict がそのまま result になる

新しいジョブは、このパッケージにモジュールを足して @job("名前") を付けた関数を書き、
下の _MODULES に足す（ホスト側は JobService.Kinds に 1 行）。
"""

from __future__ import annotations

import argparse
import importlib
import json
import shutil
import tempfile
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import __version__, progress
from ..pointcloud_writer import POINTCLOUD_DIR, PointcloudWriter
from ..potree_reader import PotreeReader

JobFunc = Callable[["JobContext"], dict[str, Any]]

_REGISTRY: dict[str, tuple[str, JobFunc]] = {}

# ジョブを定義したモジュール（読み込むと @job で登録される）
_MODULES = ["selftest", "selftest_version"]


def job(name: str, help: str = "") -> Callable[[JobFunc], JobFunc]:
    def deco(fn: JobFunc) -> JobFunc:
        if name in _REGISTRY:
            raise ValueError(f"ジョブ {name} が二重に登録されています")
        _REGISTRY[name] = (help, fn)
        return fn

    return deco


class JobError(RuntimeError):
    """利用者に見せてよい失敗（入力の不足など）。message をそのまま画面に出す。"""


@dataclass
class JobContext:
    manifest: dict[str, Any]
    manifest_path: Path
    datasets: Path
    params: dict[str, Any]
    out: Path
    work: Path
    # PotreeConverter.exe（新しい版を作るジョブだけが使う。ビューア exe が渡す）
    potree: Path | None = None
    # new_pointcloud で書いた点群の統計（run が result["pointcloud"] に入れる）
    pointcloud_stats: dict[str, Any] | None = field(default=None, init=False)

    @property
    def folder(self) -> str:
        return self.manifest_path.parent.name

    def param(self, key: str, default: Any = None, kind: type | None = None) -> Any:
        """params の値。kind を渡すとその型に変換し、変換できなければ JobError。"""
        v = self.params.get(key, default)
        if v is None or v == "" or kind is None:
            return default if v in (None, "") else v
        try:
            return kind(v)
        except (TypeError, ValueError):
            raise JobError(f"設定「{key}」の値が正しくありません: {v}") from None

    def reader(self) -> PotreeReader:
        """この版の点群（保存済みの Potree）を読む。"""
        return PotreeReader(self.pointcloud_dir())

    def new_pointcloud(self, extra: dict[str, Any] | None = None, lod_weight: float = 0.4) -> PointcloudWriter:
        """新しい版の点群を書く（target = newVersion のジョブ）。

        with ctx.new_pointcloud(extra={"distance": "f4"}) as w:
            for b in ctx.reader().iter_blocks():
                ...  # 点を選ぶ・属性を足す
                w.write(b)

        書き終わると PotreeConverter で out/pointcloud/ を作り、統計を result["pointcloud"] に入れる。
        ビューア exe はそれを点群にした新しい版を公開する（モデル・座標合わせは元の版と同じ）。
        """
        writer = PointcloudWriter(
            self.reader(),
            self.work / "new_pointcloud.las",
            self.out / POINTCLOUD_DIR,
            self.potree,
            extra=extra,
            lod_weight=lod_weight,
            on_done=lambda stats: setattr(self, "pointcloud_stats", stats),
        )
        return writer

    def dataset_file(self, owner: str, rel: str) -> Path:
        """manifest の owner（データセットのフォルダ）と相対パスから実ファイルの場所を返す。datasets/ の外は拒否する。"""
        root = self.datasets.resolve()
        p = (root / owner / rel).resolve()
        if root not in p.parents:
            raise JobError(f"使えないパスです: {owner}/{rel}")
        return p

    def pointcloud_dir(self) -> Path:
        pc = self.manifest.get("pointcloud")
        if not pc:
            raise JobError("この版には点群がありません")
        return self.dataset_file(pc["owner"], pc["dir"])

    def model_files(self) -> list[dict[str, Any]]:
        """モデルごとの .frag / .elements.json の場所。"""
        out = []
        for m in self.manifest.get("models", []):
            out.append(
                {
                    "key": m["key"],
                    "frag": self.dataset_file(m["owner"], m["file"]),
                    "elements": self.dataset_file(m["owner"], m["elements"]),
                }
            )
        return out


def _load() -> None:
    # PyInstaller が拾えるよう、文字列で import するモジュールは build.ps1 で --collect-submodules している
    for m in _MODULES:
        importlib.import_module(f"{__name__}.{m}")


def names() -> list[str]:
    _load()
    return sorted(_REGISTRY)


def add_parsers(sub: argparse._SubParsersAction) -> None:
    """argparse にジョブのサブコマンドを足す。"""
    _load()
    for name, (help_text, fn) in sorted(_REGISTRY.items()):
        p = sub.add_parser(name, help=help_text or f"ジョブ {name}")
        p.add_argument("--manifest", required=True)
        p.add_argument("--datasets", required=True)
        p.add_argument("--params")
        p.add_argument("--out", required=True)
        p.add_argument("--work")
        p.add_argument("--potree", help="PotreeConverter.exe（新しい版を作るジョブで使う）")
        p.add_argument("--keep-work", action="store_true")
        p.set_defaults(func=lambda a, _fn=fn, _name=name: run(_name, _fn, a))


def run(name: str, fn: JobFunc, args: argparse.Namespace) -> int:
    work = Path(args.work) if args.work else Path(tempfile.mkdtemp(prefix=f"kasanejob_{name}_"))
    try:
        mpath = Path(args.manifest)
        if not mpath.is_file():
            progress.emit("error", message=f"manifest がありません: {mpath}")
            return 2
        params: dict[str, Any] = {}
        if args.params:
            params = json.loads(Path(args.params).read_text(encoding="utf-8")) or {}
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        work.mkdir(parents=True, exist_ok=True)
        ctx = JobContext(
            manifest=json.loads(mpath.read_text(encoding="utf-8")),
            manifest_path=mpath,
            datasets=Path(args.datasets),
            params=params,
            out=out,
            work=work,
            potree=Path(args.potree) if args.potree else None,
        )
        result = fn(ctx) or {}
        if ctx.pointcloud_stats is not None:
            result = {**result, "pointcloud": {**ctx.pointcloud_stats, **result.get("pointcloud", {})}}
        progress.emit("result", kind=name, converterVersion=__version__, **result)
        return 0
    except JobError as e:
        progress.emit("error", message=str(e))
        return 1
    except Exception as e:  # 失敗は必ず JSON 行で返す
        progress.emit("error", message=str(e), detail=traceback.format_exc())
        return 1
    finally:
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
