import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Viewer3D } from "../scene/viewer3d";

export type Axis = "x" | "y" | "z";
/**
 * 計測の種類。distance = 2 点で確定、polyline = 点を足していき Enter・ダブルクリックで確定。
 * 面積・体積を足すときはここに増やす（点の打ち方と区間の拘束は共通）。
 */
export type MeasureKind = "distance" | "polyline";

export const MEASURE_KIND_LABEL: Record<MeasureKind, string> = { distance: "距離", polyline: "折れ線" };

/** 軸の色（原点の印と同じ: X 赤・Y 緑・Z 青） */
export const AXIS_COLOR: Record<Axis, number> = { x: 0xff5c5c, y: 0x5cd65c, z: 0x4d9fff };
const FREE_COLOR = 0xffe066;
const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

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

  axisVector(axis: Axis): THREE.Vector3 {
    return axis === "x" ? this.xAxis.clone() : axis === "y" ? this.yAxis : new THREE.Vector3(0, 0, 1);
  }

  /** 局所座標の X/Y/Z 軸（シーン座標の向き） */
  axes(): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    return [this.xAxis.clone(), this.yAxis, new THREE.Vector3(0, 0, 1)];
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

/** 計測の 1 区間。軸を決めた区間では b は a から軸方向へ射影した点 */
export interface Segment {
  a: THREE.Vector3;
  b: THREE.Vector3;
  axis: Axis | null;
  length: number;
  components: THREE.Vector3; // 局所座標系での ΔX ΔY ΔZ
  /** 実際にクリックした点（軸へ射影する前） */
  clicked: THREE.Vector3;
}

export interface Measurement {
  id: number;
  kind: MeasureKind;
  /** 頂点（軸へ射影した後） */
  points: THREE.Vector3[];
  segments: Segment[];
  /** 区間の長さの合計 */
  total: number;
  // 以下は一覧・互換用のまとめ
  a: THREE.Vector3; // 最初の点
  b: THREE.Vector3; // 最後の点
  /** 1 区間で軸を決めたときの軸 */
  ortho: Axis | null;
  /** = total */
  distance: number;
  /** 最初 → 最後の ΔX ΔY ΔZ（局所座標） */
  components: THREE.Vector3;
  /** 各点の出所（モデル・点群・軸上） */
  sources: string[];
  /** 各点のスナップの種類（「端点」など。フリーは null） */
  snaps: (string | null)[];
  object: THREE.Group;
}

export function fmtM(v: number): string {
  return `${v.toFixed(3)} m`;
}

interface Vertex {
  p: THREE.Vector3;
  source: string;
  snap: string | null;
}

/**
 * 距離・折れ線の計測。点を打つごとに直前の点からの区間を足す。区間ごとに軸（局所座標の X/Y/Z）を
 * 決められ、決めた区間はその軸方向の成分だけを測る（クリック点を軸へ射影した点が次の頂点になる）。
 */
export class MeasureTool {
  readonly list: Measurement[] = [];
  kind: MeasureKind = (localStorage.getItem("measureKind") as MeasureKind) === "polyline" ? "polyline" : "distance";
  private nextId = 1;
  /** 作図中（確定前）の点と区間 */
  private verts: Vertex[] = [];
  private segs: Segment[] = [];
  private draftObject: THREE.Group | null = null;
  /** 次の点を探している間の仮の線・距離・軸のガイド */
  private readonly preview = new THREE.Group();
  private readonly previewLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly previewDash: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  private readonly previewEnd: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly previewLabel: CSS2DObject;
  private readonly guides: Record<Axis, THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>;
  onChange: (() => void) | null = null;

  constructor(
    private readonly viewer: Viewer3D,
    private readonly frame: LocalFrame,
  ) {
    const line2 = () => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.previewLine = new THREE.Line(line2(), new THREE.LineBasicMaterial({ color: FREE_COLOR, depthTest: false }));
    this.previewDash = new THREE.Line(
      line2(),
      new THREE.LineDashedMaterial({ color: 0xaaaaaa, dashSize: 0.05, gapSize: 0.05, depthTest: false, transparent: true, opacity: 0.8 }),
    );
    this.previewEnd = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: FREE_COLOR, depthTest: false }));
    this.previewEnd.userData.marker = true;
    const el = document.createElement("div");
    el.className = "measure-label preview";
    this.previewLabel = new CSS2DObject(el);
    this.guides = {} as Record<Axis, THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>;
    for (const a of ["x", "y", "z"] as const) {
      this.guides[a] = new THREE.Line(
        line2(),
        new THREE.LineBasicMaterial({ color: AXIS_COLOR[a], depthTest: false, transparent: true, opacity: 0.3 }),
      );
      this.guides[a].renderOrder = -1;
      this.preview.add(this.guides[a]);
    }
    this.preview.add(this.previewLine, this.previewDash, this.previewEnd, this.previewLabel);
    this.preview.visible = false;
    viewer.overlay.add(this.preview);
    viewer.onBeforeRender(() => this.scaleMarkers());
  }

  setKind(k: MeasureKind) {
    if (k === this.kind) return;
    // 作図中の折れ線は確定してから切り替える（距離の 1 点目はそのまま引き継ぐ）
    if (this.segs.length) this.finish();
    this.kind = k;
    localStorage.setItem("measureKind", k);
  }

  /** 作図中（1 点以上打った） */
  get hasPending() {
    return this.verts.length > 0;
  }

  /** 打った点の数（作図中） */
  get pointCount() {
    return this.verts.length;
  }

  /** 最後に打った点（次の区間の始点） */
  get pendingPoint(): THREE.Vector3 | null {
    return this.verts.at(-1)?.p ?? null;
  }

  /** 作図中の区間の合計 */
  get draftTotal(): number {
    return this.segs.reduce((s, x) => s + x.length, 0);
  }

  /** 作図中のものを捨てる */
  cancel() {
    this.verts = [];
    this.segs = [];
    this.disposeDraft();
    this.setPreview(null, null);
    this.viewer.requestRender();
  }

  /** p を a を通る軸の線へ射影した点（軸が null なら p のまま） */
  endPoint(a: THREE.Vector3, p: THREE.Vector3, axis: Axis | null): THREE.Vector3 {
    if (!axis) return p.clone();
    const dir = this.frame.axisVector(axis);
    return a.clone().addScaledVector(dir, p.clone().sub(a).dot(dir));
  }

  /** a → p の最も大きい成分の軸 */
  dominantAxis(a: THREE.Vector3, p: THREE.Vector3): Axis {
    const c = this.frame.componentsOf(p.clone().sub(a));
    const v = [Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)];
    return (["x", "y", "z"] as const)[v.indexOf(Math.max(...v))];
  }

  /**
   * 次の区間の仮表示。target はカーソル位置（スナップ後）、axis はこの区間の軸。null で線を消す。
   * 最後の点から局所座標の軸のガイドを出し、測る軸を濃く表示する。
   */
  setPreview(target: THREE.Vector3 | null, axis: Axis | null) {
    const a = this.pendingPoint;
    if (!a) {
      if (this.preview.visible) {
        this.preview.visible = false;
        this.viewer.requestRender();
      }
      return;
    }
    this.preview.visible = true;
    const L = Math.max(50, this.viewer.camera.position.distanceTo(a) * 20);
    for (const k of ["x", "y", "z"] as const) {
      const g = this.guides[k];
      const dir = this.frame.axisVector(k);
      setLine(g, a.clone().addScaledVector(dir, -L), a.clone().addScaledVector(dir, L));
      g.material.opacity = axis === k ? 0.9 : axis ? 0.1 : 0.25;
    }
    const show = !!target;
    this.previewLine.visible = show;
    this.previewEnd.visible = show;
    this.previewLabel.visible = show;
    this.previewDash.visible = false;
    if (target) {
      const b = this.endPoint(a, target, axis);
      const color = axis ? AXIS_COLOR[axis] : FREE_COLOR;
      setLine(this.previewLine, a, b);
      this.previewLine.material.color.setHex(color);
      this.previewEnd.material.color.setHex(color);
      this.previewEnd.position.copy(b);
      if (axis && target.distanceTo(b) > 1e-4) {
        setLine(this.previewDash, b, target);
        this.previewDash.computeLineDistances();
        this.previewDash.visible = true;
      }
      this.previewLabel.position.copy(a).add(b).multiplyScalar(0.5);
      const el = this.previewLabel.element;
      el.replaceChildren();
      el.append(segmentText(b.distanceTo(a), axis));
      if (!axis) {
        const c = this.frame.componentsOf(b.clone().sub(a));
        el.append(div("c", `ΔX ${c.x.toFixed(3)}  ΔY ${c.y.toFixed(3)}  ΔZ ${c.z.toFixed(3)}`));
      }
      if (this.kind === "polyline" && this.segs.length) el.append(div("c", `計 ${fmtM(this.draftTotal + b.distanceTo(a))}`));
    }
    this.viewer.requestRender();
  }

  /**
   * 点を打つ。axis は直前の点からの区間の軸（1 点目では無視）。snap はスナップの種類（フリーは null）。
   * 距離は 2 点目で確定して返す。折れ線は finish() まで作図を続ける。
   */
  add(p: THREE.Vector3, source: string, axis: Axis | null, snap: string | null = null): Measurement | null {
    const prev = this.pendingPoint;
    if (!prev) {
      this.verts.push({ p: p.clone(), source, snap });
    } else {
      const b = this.endPoint(prev, p, axis);
      // 同じ点を続けて打ったときは区間にしない
      if (b.distanceTo(prev) < 1e-6) return null;
      this.segs.push({ a: prev.clone(), b, axis, length: b.distanceTo(prev), components: this.frame.componentsOf(b.clone().sub(prev)), clicked: p.clone() });
      this.verts.push({ p: b, source, snap });
    }
    if (this.kind === "distance" && this.segs.length >= 1) return this.finish();
    this.redrawDraft();
    this.setPreview(null, null);
    return null;
  }

  /** 最後に打った点を取り消す（折れ線の作図中） */
  undo() {
    if (!this.verts.length) return;
    this.verts.pop();
    this.segs.pop();
    this.redrawDraft();
    this.setPreview(null, null);
  }

  /** 作図中のものを確定する。区間が無ければ捨てる */
  finish(): Measurement | null {
    if (!this.segs.length) {
      this.cancel();
      return null;
    }
    const points = this.verts.map((v) => v.p.clone());
    const segs = this.segs;
    const total = segs.reduce((s, x) => s + x.length, 0);
    const m: Measurement = {
      id: this.nextId++,
      kind: this.kind,
      points,
      segments: segs,
      total,
      a: points[0].clone(),
      b: points[points.length - 1].clone(),
      ortho: segs.length === 1 ? segs[0].axis : null,
      distance: total,
      components: this.frame.componentsOf(points[points.length - 1].clone().sub(points[0])),
      sources: this.verts.map((v) => v.source),
      snaps: this.verts.map((v) => v.snap),
      object: this.makeObject(points, segs, this.kind),
    };
    this.viewer.overlay.add(m.object);
    this.list.push(m);
    this.verts = [];
    this.segs = [];
    this.disposeDraft();
    this.setPreview(null, null);
    this.onChange?.();
    return m;
  }

  remove(id: number) {
    const i = this.list.findIndex((m) => m.id === id);
    if (i < 0) return;
    disposeGroup(this.viewer.overlay, this.list[i].object);
    this.list.splice(i, 1);
    this.viewer.requestRender();
    this.onChange?.();
  }

  clear() {
    for (const m of [...this.list]) this.remove(m.id);
  }

  private disposeDraft() {
    if (this.draftObject) disposeGroup(this.viewer.overlay, this.draftObject);
    this.draftObject = null;
  }

  private redrawDraft() {
    this.disposeDraft();
    const g = this.makeObject(
      this.verts.map((v) => v.p),
      this.segs,
      this.kind,
    );
    this.draftObject = g;
    this.viewer.overlay.add(g);
    this.viewer.requestRender();
  }

  /** 区間ごとの線・点・長さ。折れ線で 2 区間以上なら最後の点に合計を出す */
  private makeObject(points: THREE.Vector3[], segs: Segment[], kind: MeasureKind): THREE.Group {
    const g = new THREE.Group();
    for (const s of segs) {
      const color = s.axis ? AXIS_COLOR[s.axis] : FREE_COLOR;
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([s.a, s.b]), new THREE.LineBasicMaterial({ color, depthTest: false })));
      if (s.axis && s.clicked.distanceTo(s.b) > 1e-4) {
        // 実際にクリックした点との関係を点線で示す
        const dash = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([s.b, s.clicked]),
          new THREE.LineDashedMaterial({ color: 0x888888, dashSize: 0.05, gapSize: 0.05, depthTest: false }),
        );
        dash.computeLineDistances();
        g.add(dash);
      }
      const el = document.createElement("div");
      el.className = "measure-label";
      el.append(segmentText(s.length, s.axis));
      const label = new CSS2DObject(el);
      label.position.copy(s.a).add(s.b).multiplyScalar(0.5);
      g.add(label);
    }
    points.forEach((p, i) => {
      const prevAxis = segs[i - 1]?.axis ?? segs[i]?.axis ?? null;
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(1, 10, 6),
        new THREE.MeshBasicMaterial({ color: prevAxis ? AXIS_COLOR[prevAxis] : FREE_COLOR, depthTest: false }),
      );
      s.position.copy(p);
      s.userData.marker = true;
      g.add(s);
    });
    if (kind === "polyline" && segs.length >= 2) {
      const el = document.createElement("div");
      el.className = "measure-label total";
      el.textContent = `計 ${fmtM(segs.reduce((a, s) => a + s.length, 0))}`;
      const label = new CSS2DObject(el);
      label.position.copy(points[points.length - 1]);
      label.center.set(-0.15, 1.3);
      g.add(label);
    }
    return g;
  }

  private scaleMarkers() {
    const cam = this.viewer.camera.position;
    const scale = (o: THREE.Object3D) => o.scale.setScalar(Math.max(0.004, cam.distanceTo(o.position) * 0.006));
    if (this.previewEnd.visible) scale(this.previewEnd);
    const groups = this.draftObject ? [...this.list.map((m) => m.object), this.draftObject] : this.list.map((m) => m.object);
    for (const g of groups) g.children.forEach((c) => c.userData.marker && scale(c));
  }
}

function div(cls: string, text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

/** 区間の長さの表示（軸を決めた区間は軸名と軸の色） */
function segmentText(len: number, axis: Axis | null): HTMLDivElement {
  const d = div("v", axis ? `${axis.toUpperCase()} ${fmtM(len)}` : fmtM(len));
  if (axis) d.style.color = css(AXIS_COLOR[axis]);
  return d;
}

function disposeGroup(parent: THREE.Object3D, g: THREE.Group) {
  parent.remove(g);
  g.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
}

function setLine(line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3) {
  const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  pos.setXYZ(0, a.x, a.y, a.z);
  pos.setXYZ(1, b.x, b.y, b.z);
  pos.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}
