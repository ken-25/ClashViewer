// UCS（ユーザー座標系）の設定手順と、プロジェクトごとの保存（この PC の localStorage）。
// 座標系そのもの（原点・軸・変換）は LocalFrame（app.frame）が持つ。

import type { App } from "../app";
import type { Manifest } from "../data/dataset";
import type { Pick } from "../scene/picker";
import { DEFAULT_TOOL } from "../tools/toolRegistry";
import type { AppFeature } from "./feature";

const storageKey = (site: string) => `frame:${site}`;

export class UcsMode implements AppFeature {
  /** UCS ツールの手順（0: 原点 / 1: X 軸の向き） */
  step = 0;

  constructor(private readonly app: App) {}

  onOpen(m: Manifest) {
    this.app.frame.restore(JSON.parse(localStorage.getItem(storageKey(m.site)) ?? "null"), m.origin);
  }

  /** UCS ツールのクリック: 1 点目で原点、2 点目で X 軸の向き */
  addPoint(p: Pick) {
    const { frame } = this.app;
    if (this.step === 0) {
      frame.set(p.point);
      this.step = 1;
      this.app.updateToolHint();
    } else {
      frame.set(frame.origin, p.point);
      this.save();
      this.app.setTool(DEFAULT_TOOL);
    }
    this.save();
    this.app.emit("measures");
  }

  save() {
    const m = this.app.current;
    if (!m) return;
    localStorage.setItem(storageKey(m.site), JSON.stringify(this.app.frame.serialize(m.origin)));
  }

  /** UCS を解除して WCS に戻す */
  reset() {
    this.app.frame.reset();
    this.save();
    this.app.emit("measures");
  }
}
