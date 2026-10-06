// 3点合わせ（モデル上の点と点群上の対応点から、モデルの置き方を決める）の状態と保存。

import * as THREE from "three";
import type { App } from "../app";
import { ifcToScene, sceneToWorld } from "../data/dataset";
import { host } from "../host";
import type { Pick } from "../scene/picker";
import { solveRigid } from "../tools/align";
import { DEFAULT_TOOL } from "../tools/toolRegistry";
import type { AppFeature } from "./feature";

export interface AlignPick {
  model: THREE.Vector3[]; // IFC 座標
  cloud: THREE.Vector3[]; // 世界座標
  modelScene: THREE.Vector3[];
  cloudScene: THREE.Vector3[];
}

export interface AlignResult {
  matrix: THREE.Matrix4;
  residual: number;
  errors: number[];
}

const emptyPicks = (): AlignPick => ({ model: [], cloud: [], modelScene: [], cloudScene: [] });

export class AlignMode implements AppFeature {
  picks: AlignPick = emptyPicks();
  /** 仮の合わせ（IFC → 世界）。3 組そろうと入る */
  preview: THREE.Matrix4 | null = null;
  /** 水平を保つ（Z 軸回りの回転と移動だけ） */
  levelOnly = true;

  constructor(private readonly app: App) {}

  onClose() {
    this.picks = emptyPicks();
    this.preview = null;
  }

  /** 次にクリックするのはモデル側か */
  get needsModel(): boolean {
    return this.picks.model.length <= this.picks.cloud.length;
  }

  /** そろった組の数 */
  get pairs(): number {
    return Math.min(this.picks.model.length, this.picks.cloud.length);
  }

  addPick(p: Pick) {
    const m = this.app.current;
    if (!m) return;
    const a = this.picks;
    if (this.needsModel) {
      if (p.source !== "model") return;
      const toIfc = ifcToScene(m).invert();
      a.model.push(p.point.clone().applyMatrix4(toIfc));
      a.modelScene.push(p.point.clone());
    } else {
      if (p.source !== "cloud") return;
      a.cloud.push(new THREE.Vector3(...sceneToWorld(m, p.point)));
      a.cloudScene.push(p.point.clone());
    }
    this.app.emit("align");
  }

  /** 最後にクリックした対応点を 1 つ取り消す（点群側に対応する点が見つからないときなど） */
  undo() {
    const a = this.picks;
    if (a.model.length > a.cloud.length) {
      a.model.pop();
      a.modelScene.pop();
    } else if (a.cloud.length > 0) {
      a.cloud.pop();
      a.cloudScene.pop();
    }
    if (this.pairs < 3) {
      this.preview = null;
      this.app.applyPlacement();
    }
    this.app.emit("align");
  }

  /** 対応点と仮の配置を捨てて、保存済みの合わせ方に戻す */
  reset() {
    this.picks = emptyPicks();
    this.preview = null;
    this.app.applyPlacement();
    this.app.emit("align");
  }

  setLevelOnly(on: boolean) {
    this.levelOnly = on;
    this.app.emit("align");
  }

  /** 3 組そろっていれば解いて、仮の配置としてモデルを置き直す。そろっていなければ null */
  solve(): AlignResult | null {
    const n = this.pairs;
    if (n < 3 || !this.app.current) return null;
    try {
      const result = solveRigid(this.picks.model.slice(0, n), this.picks.cloud.slice(0, n), this.levelOnly);
      // 現在の合わせ A に対して、新しい A' = 解（IFC → 世界）
      this.preview = result.matrix;
      this.app.applyPlacement(result.matrix);
      return result;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  /** 解いた合わせ方を版の alignment に保存し、選択ツールに戻る */
  async save(result: AlignResult) {
    const m = this.app.current;
    if (!m) return;
    const n = this.pairs;
    const a = this.picks;
    const updated = await host.updateAlignment(m.folder, {
      method: "threePoint",
      matrix: result.matrix.toArray(),
      residual: result.residual,
      levelOnly: this.levelOnly,
      pairs: a.model.slice(0, n).map((p, i) => ({ model: p.toArray(), cloud: a.cloud[i].toArray() })),
    });
    Object.assign(m, { alignment: updated.alignment, alignmentHistory: updated.alignmentHistory });
    await this.app.refreshDatasets();
    this.reset();
    this.app.setTool(DEFAULT_TOOL);
  }
}
