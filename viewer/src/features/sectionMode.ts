// 切断メニューの操作（切断ボックス・水平/垂直の断面を足す）と、面に合わせた断面ツールの手順。
// 切断の状態そのもの（箱・断面の一覧・クリップ面）は Clipping（app.clipping）が持つ。

import * as THREE from "three";
import type { App } from "../app";
import type { Pick } from "../scene/picker";
import type { Axis } from "../tools/measure";
import { fitCloudPlane, PickMarks, planeFrom3 } from "../tools/planePick";
import { DEFAULT_TOOL } from "../tools/toolRegistry";
import type { AppFeature } from "./feature";

export type PlaneMethod = "face" | "points";

/** 断面の向きを WCS の軸へ丸める角度。モデルの法線は圧縮のぶれ程度、点群・3点指定はクリックのぶれを見込む */
const MODEL_NORMAL_TOL_DEG = 0.11;
const PICKED_NORMAL_TOL_DEG = 0.5;

export class SectionMode implements AppFeature {
  /** 断面の決め方。face: 面（モデルの面・点群の平らな所）を 1 クリック / points: 3点指定 */
  method: PlaneMethod = "face";
  /** パネルで選んだ決め方（自動で 3点指定に切り替わっても、次はこちらから始める） */
  private methodPref: PlaneMethod = "face";
  /** 3点指定で選んだ点（シーン座標） */
  points: THREE.Vector3[] = [];
  private readonly marks = new PickMarks();

  constructor(private readonly app: App) {
    app.viewer.overlay.add(this.marks.object);
  }

  /** 3点指定の途中の点・目印を捨てる（切断そのものは app.clipping.reset で戻る） */
  onClose() {
    this.resetTool();
  }

  // ---- 切断メニュー ----

  /** 切断ボックスのオン・オフ（3D 画面左上の「切断」メニュー） */
  setClipBox(on: boolean) {
    const { clipping } = this.app;
    if (on && !clipping.active) this.app.prepareClipExtent();
    clipping.setBoxOn(on);
  }

  /**
   * 水平・垂直の断面を足す（3D 画面左上の「切断」メニュー）。今見ている所（注視点）を通す。
   * 垂直は UCS を設定していれば UCS の X・Y 軸に直交、なければ WCS。
   */
  addAxisSection(axis: Axis) {
    const { clipping, frame, viewer } = this.app;
    const m = this.app.current;
    if (!m) return;
    if (!clipping.active) this.app.prepareClipExtent();
    const ext = clipping.extent;
    const t = viewer.controls.target;
    const point = ext.containsPoint(t) ? t.clone() : ext.getCenter(new THREE.Vector3());
    const ucs = axis !== "z" && frame.isSet;
    const dir = ucs ? frame.axisVector(axis) : new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    const base = ucs ? frame.toLocal(point)[axis] : point[axis] + m.origin[{ x: 0, y: 1, z: 2 }[axis]];
    const label = axis === "z" ? "水平" : `垂直（${ucs ? "UCS " : ""}${axis.toUpperCase()}）`;
    clipping.addAxisSection(point, dir, label, { space: ucs ? "UCS" : "WCS", axis, base });
  }

  /** 面に合わせた断面ツールを始める（切断の範囲を今見ている側に合わせてから） */
  startPlaneTool() {
    if (!this.app.current) return;
    if (!this.app.clipping.active) this.app.prepareClipExtent();
    this.app.setTool("plane");
  }

  // ---- 面に合わせた断面ツール ----

  /** 断面ツールに入る・出るとき: パネルで選んだ決め方から始める */
  resetTool() {
    this.method = this.methodPref;
    this.points = [];
    this.marks.set([]);
  }

  /** 断面の決め方を変える（右のパネル）。次に断面ツールを始めたときもこの決め方 */
  setMethod(m: PlaneMethod) {
    this.methodPref = m;
    this.method = m;
    this.points = [];
    this.marks.set([]);
    this.app.updateToolHint();
    this.app.snap.refresh();
    this.app.emit("tool");
  }

  /** 3点指定の 1 点を戻す（Backspace） */
  undoPoint() {
    if (!this.points.length) return;
    this.points.pop();
    this.marks.set(this.points);
    this.app.updateToolHint();
    this.app.snap.refresh();
    this.app.emit("tool");
  }

  /** 今の手順の案内（断面ツール） */
  stepHint(): string {
    if (this.method === "face") return "モデルの面か、点群の平らな所をクリック　Esc キャンセル";
    return `${this.points.length + 1}点目をクリック　Tab 候補切替・Alt フリー${this.points.length ? "・Backspace 1点戻す" : ""}・Esc キャンセル`;
  }

  /**
   * 断面ツールのクリック。
   * - 面から: モデルは面の法線、点群は周りの点に平面を当てはめる。平らでなければ 3点指定に切り替え、
   *   クリックした点を 1 点目にする。
   * - 3点指定: 3 点目で面を決める。
   * 足せたら選択ツールに戻る。
   */
  click(p: Pick, e: MouseEvent) {
    const { pc, viewer, picker } = this.app;
    if (this.method === "points") {
      this.addPoint(p.point);
      return;
    }
    if (p.source === "model" && p.normal && p.normal.lengthSq() > 1e-12) {
      this.finish(p.point, p.normal, MODEL_NORMAL_TOL_DEG);
      return;
    }
    if (p.source === "cloud" && pc) {
      // 周りの点を集めて当てはめる。範囲は画面で約 16px（近くで細かく、遠くで広く）
      const d = viewer.camera.position.distanceTo(p.point);
      const radius = THREE.MathUtils.clamp(16 * picker.pxSize(d), 0.05, 0.5);
      const sample = pc.collect(viewer.camera, viewer.toNdc(e.clientX, e.clientY), viewer.size, 32, viewer.renderer.clippingPlanes);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < sample.n; i++) pts.push(new THREE.Vector3(sample.pos[i * 3], sample.pos[i * 3 + 1], sample.pos[i * 3 + 2]));
      const fit = fitCloudPlane(p.point, pts, radius);
      if (fit) {
        // クリックした点を面へ落とした所を通す
        const on = p.point.clone().addScaledVector(fit.normal, -fit.normal.dot(p.point.clone().sub(fit.centroid)));
        this.finish(on, fit.normal, PICKED_NORMAL_TOL_DEG);
        return;
      }
    }
    // 面の向きが決まらない（点群の角・縁・まばらな所など）: 3点指定に切り替えて続ける
    this.method = "points";
    this.points = [p.point.clone()];
    this.marks.set(this.points);
    this.app.snap.refresh();
    this.app.emit("tool");
    this.app.setHint(`断面: ここは平らな面が見つかりません。3点で決めます: ${this.stepHint()}`);
  }

  private addPoint(pt: THREE.Vector3) {
    this.points.push(pt.clone());
    if (this.points.length < 3) {
      this.marks.set(this.points);
      this.app.updateToolHint();
      this.app.snap.refresh();
      this.app.emit("tool");
      return;
    }
    const [a, b, c] = this.points;
    const n = planeFrom3(a, b, c);
    if (!n) {
      this.points.pop();
      this.marks.set(this.points);
      this.app.setHint(`断面: 3点がほぼ一直線です。3点目を離れた所でクリック　${this.stepHint()}`);
      return;
    }
    // 目印は 3 点の真ん中に置く
    this.finish(a.clone().add(b).add(c).divideScalar(3), n, PICKED_NORMAL_TOL_DEG);
  }

  private finish(point: THREE.Vector3, normal: THREE.Vector3, tolDeg: number) {
    const { viewer } = this.app;
    const toCamera = viewer.camera.position.clone().sub(point);
    // 平行投影では、カメラの位置より視線の向きの方が確か
    if (viewer.camera instanceof THREE.OrthographicCamera) viewer.camera.getWorldDirection(toCamera).negate();
    this.app.clipping.addFaceSection(point, normal, toCamera, tolDeg);
    this.app.setTool(DEFAULT_TOOL);
  }
}
