// 計測ツールの操作の状態（軸の固定・Shift・軸への吸着）と、点の追加・確定。
// 計測結果と 3D の線は MeasureTool（app.measure）が持つ。

import * as THREE from "three";
import type { App } from "../app";
import type { Pick } from "../scene/picker";
import type { SnapCandidate } from "../scene/snap";
import type { Axis, MeasureKind } from "../tools/measure";
import type { AppFeature } from "./feature";

/** カーソルが軸の線からこの距離（px）以内なら、その軸に吸着する */
const AXIS_TRACK_PX = 10;

/** 拾った位置の出どころの表示名 */
export function sourceName(p: Pick): string {
  return p.source === "model" ? "モデル" : p.source === "cloud" ? "点群" : "軸上";
}

export class MeasureMode implements AppFeature {
  /** 計測の区間を固定する軸（X/Y/Z キーで固定、もう一度で解除）。null なら軸に近いときだけ吸着 */
  axisLock: Axis | null = null;
  /** Shift を押している間（最も大きい成分の軸に固定） */
  shiftHeld = false;

  constructor(private readonly app: App) {}

  onClose() {
    this.app.measure.clear();
  }

  /** 計測の種類（距離・折れ線）を変える */
  setKind(k: MeasureKind) {
    this.app.measure.setKind(k);
    this.app.updateToolHint();
    this.app.snap.refresh();
    this.app.emit("measures");
  }

  /** X/Y/Z キー・パネルのボタン。同じ軸をもう一度で解除 */
  toggleAxisLock(a: Axis) {
    this.axisLock = this.axisLock === a ? null : a;
    this.app.updateToolHint();
    this.app.snap.refresh();
    this.app.emit("measures");
  }

  setShiftHeld(on: boolean) {
    if (this.shiftHeld === on) return;
    this.shiftHeld = on;
    this.app.snap.refresh();
  }

  /**
   * 最後の点 → target の区間の軸。優先順: X/Y/Z キーの固定 → Shift（最も大きい成分）→
   * 軸への吸着（target を軸へ射影した点が画面上で AXIS_TRACK_PX 以内なら、その軸）→ なし。
   * Alt・スナップ切のときは吸着しない。
   */
  segmentAxis(target: THREE.Vector3, shift = this.shiftHeld): Axis | null {
    const { measure, picker, snap } = this.app;
    const a = measure.pendingPoint;
    if (!a || this.app.tool !== "measure") return null;
    if (this.axisLock) return this.axisLock;
    if (shift) return measure.dominantAxis(a, target);
    if (snap.isFree) return null;
    const sa = picker.project(a);
    const st = picker.project(target);
    // 最後の点のすぐ近くでは向きが定まらないので吸着しない
    if (Math.hypot(st.x - sa.x, st.y - sa.y) < 2 * AXIS_TRACK_PX) return null;
    let best: Axis | null = null;
    let bestD = AXIS_TRACK_PX;
    for (const k of ["x", "y", "z"] as const) {
      const b = measure.endPoint(a, target, k);
      const sb = picker.project(b);
      // 視線の向きに近い軸（画面上で縮んで見える軸）は、どこでも近く見えるので除く
      if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < AXIS_TRACK_PX) continue;
      const d = Math.hypot(sb.x - st.x, sb.y - st.y);
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /**
   * 計測の作図中、カーソルの下に何も無いときは最後の点を通る軸の線上の点を候補にする
   * （空中でも軸に沿って測れるように）。固定した軸・Shift では常に、それ以外は軸の線の近くだけ。
   */
  addAxisCandidate(list: SnapCandidate[], clientX: number, clientY: number): SnapCandidate[] {
    const { measure, picker, snap, viewer, frame } = this.app;
    const a = measure.pendingPoint;
    if (!a || this.app.tool !== "measure") return list;
    if (list.some((c) => c.kind === "free")) return list;
    const forced = !!this.axisLock || this.shiftHeld;
    if (!forced && snap.isFree) return list;
    const ray = picker.rayAt(clientX, clientY);
    const rect = viewer.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    let best: SnapCandidate | null = null;
    for (const k of this.axisLock ? [this.axisLock] : (["x", "y", "z"] as const)) {
      const dir = frame.axisVector(k);
      const L = 1e4;
      const p = new THREE.Vector3();
      ray.distanceSqToSegment(a.clone().addScaledVector(dir, -L), a.clone().addScaledVector(dir, L), undefined, p);
      const s = picker.project(p);
      const c: SnapCandidate = {
        kind: "axis",
        source: "axis",
        point: p,
        distance: viewer.camera.position.distanceTo(p),
        sx: s.x,
        sy: s.y,
        screenDist: Math.hypot(s.x - cx, s.y - cy),
        detail: k.toUpperCase(),
      };
      if (!best || c.screenDist < best.screenDist) best = c;
    }
    if (!best || (!forced && best.screenDist > AXIS_TRACK_PX)) return list;
    return [...list, best];
  }

  /** 作図中の計測を確定する（折れ線の Enter・ダブルクリック・Esc） */
  finish() {
    this.app.measure.finish();
    this.app.updateToolHint();
    this.app.snap.refresh();
  }

  /** 作図中の計測を取り消す（距離の 1 点目の Esc） */
  cancel() {
    this.app.measure.cancel();
    this.app.updateToolHint();
    this.app.snap.refresh();
  }

  /** 折れ線の最後の点を 1 つ戻す（Backspace） */
  undo() {
    this.app.measure.undo();
    this.app.updateToolHint();
    this.app.snap.refresh();
  }

  /** 計測ツールのクリック: 点を足す */
  addPoint(p: Pick, shift: boolean, snapLabel: string | null) {
    this.app.measure.add(p.point, sourceName(p), this.segmentAxis(p.point, shift), snapLabel);
    this.app.updateToolHint();
    // 続けて仮の線を出す（カーソルは動いていないので同じ候補を使う）
    this.app.snap.refresh();
  }

  /** 折れ線: 最後の点をもう一度クリック（ダブルクリック）で確定。確定したら true */
  finishPolylineAtLastPoint(e: MouseEvent): boolean {
    const { measure, picker, viewer } = this.app;
    if (measure.kind !== "polyline" || measure.pointCount < 2) return false;
    const last = picker.project(measure.pendingPoint!);
    const rect = viewer.canvas.getBoundingClientRect();
    if (Math.hypot(e.clientX - rect.left - last.x, e.clientY - rect.top - last.y) > 5) return false;
    this.finish();
    return true;
  }
}
