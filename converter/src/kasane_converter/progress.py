"""ビューア exe へ進捗を伝える JSON 行の出力。

1 行 1 イベント。ビューア exe は標準出力を 1 行ずつ読み、そのまま画面へ流す。
"""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

_lock = threading.Lock()
# 同じ段階の progress を出しすぎないための間引き（秒）
_MIN_INTERVAL = 0.25
_last_progress: dict[str, float] = {}


def emit(event: str, **fields: Any) -> None:
    line = json.dumps({"event": event, **fields}, ensure_ascii=False)
    with _lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def stage(stage_id: str, label: str, weight: float) -> None:
    """段階の開始。weight は全体に占める重み（0〜1、合計 1）。"""
    emit("stage", stage=stage_id, label=label, weight=weight)


def progress(stage_id: str, done: float, total: float, message: str | None = None, force: bool = False) -> None:
    now = time.monotonic()
    if not force and now - _last_progress.get(stage_id, 0.0) < _MIN_INTERVAL and done < total:
        return
    _last_progress[stage_id] = now
    fields: dict[str, Any] = {"stage": stage_id, "done": done, "total": total}
    if message:
        fields["message"] = message
    emit("progress", **fields)


def log(level: str, message: str, **fields: Any) -> None:
    emit("log", level=level, message=message, **fields)
