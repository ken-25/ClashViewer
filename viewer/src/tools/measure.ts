import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Viewer3D } from "../scene/viewer3d";

/**
 * 利用者が決める局所座標系（原点設定）。原点＋X 軸の向き（水平）。Z は常に鉛直上。
 * 点群・モデルのどちらでクリックした点でも同じ座標系で測る。
 */
export class LocalFrame {
  origin = new THREE.Vector3(); // シーン座標
  xAxis = new THREE.Vector3(1, 0, 0);
  isSet = false;
  private readonly gizmo = new THREE.Group();

  constructor(private readonly viewer: Viewer3D) {
    const mk = (dir: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    };
    this.gizmo.add(mk(new THREE.Vector3(1, 0, 0), 0xff4040), mk(new THREE.Vector3(0, 1, 0), 0x40d040), mk(new THREE.Vector3(0, 0, 1), 0x4080ff));
    const label = document.createElement("div");
    label.className = "origin-label";
    label.textContent = "原点";
    this.gizmo.add(new CSS2DObject(label));
    this.gizmo.visible = false;
    viewer.overlay.add(this.gizmo);
  }

  get yAxis(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, 1).cross(this.xAxis).normalize();
  }

  set(origin: THREE.Vector3, xPoint?: THREE.Vector3) {
    this.origin.copy(origin);
    if (xPoint) {
      const d = xPoint.clone().sub(origin);
      d.z = 0;
      if (d.lengthSq() > 1e-8) this.xAxis.copy(d.normalize());
    }
    this.isSet = true;
    this.updateGizmo();
  }

  reset() {
    this.origin.set(0, 0, 0);
    this.xAxis.set(1, 0, 0);
    this.isSet = false;
    this.updateGizmo();
  }

  private updateGizmo() {
    this.gizmo.visible = this.isSet;
    this.gizmo.position.copy(this.origin);
    this.gizmo.rotation.set(0, 0, Math.atan2(this.xAxis.y, this.xAxis.x));
    const d = this.viewer.camera.position.distanceTo(this.origin);
    this.gizmo.scale.setScalar(Math.max(0.3, d * 0.06));
    this.viewer.requestRender();
  }

  /** シーン座標 → 局所座標 */
  toLocal(p: THREE.Vector3): THREE.Vector3 {
    const d = p.clone().sub(this.origin);
    return new THREE.Vector3(d.dot(this.xAxis), d.dot(this.yAxis), d.z);
  }

  /** 方向ベクトル（差）を局所座標の成分へ */
  componentsOf(delta: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(delta.dot(this.xAxis), delta.dot(this.yAxis), delta.z);
  }

  axisVector(axis: "x" | "y" | "z"): THREE.Vector3 {
    return axis === "x" ? this.xAxis.clone() : axis === "y" ? this.yAxis : new THREE.Vector3(0, 0, 1);
  }

  serialize(originOffset: number[]) {
    return this.isSet
      ? {
          origin: [this.origin.x + originOffset[0], this.origin.y + originOffset[1], this.origin.z + originOffset[2]],
          xAxis: this.xAxis.toArray(),
        }
      : null;
  }

  restore(s: { origin: number[]; xAxis: number[] } | null, originOffset: number[]) {
    if (!s) return this.reset();
    this.origin.set(s.origin[0] - originOffset[0], s.origin[1] - originOffset[1], s.origin[2] - originOffset[2]);
    this.xAxis.fromArray(s.xAxis);
    this.isSet = true;
    this.updateGizmo();
  }
}

export interface Measurement {
  id: number;
  a: THREE.Vector3;
  b: THREE.Vector3; // 直交計測では a から軸方向へ射影した点
  ortho: "x" | "y" | "z" | null;
  distance: number;
  components: THREE.Vector3; // 局所座標系での ΔX ΔY ΔZ
  sources: [string, string];
  object: THREE.Group;
}

export function fmtM(v: number): string {
  return `${v.toFixed(3)} m`;
}

/** 2 点間距離と直交計測（局所座標系の X/Y/Z 方向の成分だけを測る） */
export class MeasureTool {
  readonly list: Measurement[] = [];
  private nextId = 1;
  private pending: { p: THREE.Vector3; source: string } | null = null;
  private readonly pendingMarker: THREE.Mesh;
  onChange: (() => void) | null = null;

  constructor(
    private readonly viewer: Viewer3D,
    private readonly frame: LocalFrame,
  ) {
    this.pendingMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false }),
    );
    this.pendingMarker.visible = false;
    viewer.overlay.add(this.pendingMarker);
    viewer.onBeforeRender(() => this.scaleMarkers());
  }

  get hasPending() {
    return this.pending !== null;
  }

  cancel() {
    this.pending = null;
    this.pendingMarker.visible = false;
    this.viewer.requestRender();
  }

  /** クリック点を渡す。2 点目で 1 件確定して返す */
  add(p: THREE.Vector3, source: string, ortho: "auto" | "x" | "y" | "z" | null): Measurement | null {
    if (!this.pending) {
      this.pending = { p: p.clone(), source };
      this.pendingMarker.position.copy(p);
      this.pendingMarker.visible = true;
      this.viewer.requestRender();
      return null;
    }
    const a = this.pending.p;
    let b = p.clone();
    const delta = b.clone().sub(a);
    const comps = this.frame.componentsOf(delta);
    let axis: "x" | "y" | "z" | null = null;
    if (ortho) {
      axis =
        ortho === "auto"
          ? (["x", "y", "z"] as const)[[Math.abs(comps.x), Math.abs(comps.y), Math.abs(comps.z)].reduce((m, v, i, arr) => (v > arr[m] ? i : m), 0)]
          : ortho;
      const dir = this.frame.axisVector(axis);
      b = a.clone().addScaledVector(dir, delta.dot(dir));
    }
    const m: Measurement = {
      id: this.nextId++,
      a: a.clone(),
      b,
      ortho: axis,
      distance: b.distanceTo(a),
      components: this.frame.componentsOf(b.clone().sub(a)),
      sources: [this.pending.source, source],
      object: this.makeObject(a, b, axis, p),
    };
    this.list.push(m);
    this.cancel();
    this.onChange?.();
    return m;
  }

  remove(id: number) {
    const i = this.list.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.viewer.overlay.remove(this.list[i].object);
    this.list[i].object.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
    });
    this.list.splice(i, 1);
    this.viewer.requestRender();
    this.onChange?.();
  }

  clear() {
    for (const m of [...this.list]) this.remove(m.id);
  }

  private makeObject(a: THREE.Vector3, b: THREE.Vector3, axis: string | null, clicked: THREE.Vector3): THREE.Group {
    const g = new THREE.Group();
    const color = axis ? 0x66d9ff : 0xffe066;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color, depthTest: false }),
    );
    g.add(line);
    if (axis && clicked.distanceTo(b) > 1e-4) {
      // 実際にクリックした点との関係を点線で示す
      const dash = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([b, clicked]),
        new THREE.LineDashedMaterial({ color: 0x888888, dashSize: 0.05, gapSize: 0.05, depthTest: false }),
      );
      dash.computeLineDistances();
      g.add(dash);
    }
    for (const p of [a, b]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      s.position.copy(p);
      s.userData.marker = true;
      g.add(s);
    }
    const el = document.createElement("div");
    el.className = "measure-label";
    const d = b.distanceTo(a);
    el.textContent = axis ? `${axis.toUpperCase()} ${fmtM(d)}` : fmtM(d);
    const label = new CSS2DObject(el);
    label.position.copy(a).add(b).multiplyScalar(0.5);
    g.add(label);
    this.viewer.overlay.add(g);
    this.viewer.requestRender();
    return g;
  }

  private scaleMarkers() {
    const cam = this.viewer.camera.position;
    const scale = (o: THREE.Object3D) => o.scale.setScalar(Math.max(0.004, cam.distanceTo(o.position) * 0.006));
    if (this.pendingMarker.visible) scale(this.pendingMarker);
    for (const m of this.list) m.object.children.forEach((c) => c.userData.marker && scale(c));
  }
}
