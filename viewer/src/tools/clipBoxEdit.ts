import * as THREE from "three";
import type { Viewer3D } from "../scene/viewer3d";
import type { Axis, Clipping } from "./clipping";

export interface BoxFace {
  axis: Axis;
  side: "min" | "max";
}

export interface FaceHit extends BoxFace {
  point: THREE.Vector3;
  /** true: 箱の内側から見えている面（光線が箱から出る面） */
  inner: boolean;
}

const AXES: Axis[] = ["x", "y", "z"];
/** 箱の最小の厚み（m）。最小と最大が入れ替わらないように */
export const MIN_BOX_SIZE = 0.01;

/**
 * 光線と箱の交差（スラブ法）。
 * enter: 光線が箱へ入る面（外側から見えている面）。カメラが箱の中なら null。
 * exit: 光線が箱から出る面（内側から見えている面）。
 */
export function rayBoxFaces(ray: THREE.Ray, box: THREE.Box3): { enter: FaceHit | null; exit: FaceHit } | null {
  if (box.isEmpty()) return null;
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterFace: BoxFace | null = null;
  let exitFace: BoxFace | null = null;
  for (const a of AXES) {
    const o = ray.origin[a];
    const d = ray.direction[a];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[a] || o > box.max[a]) return null;
      continue;
    }
    let t1 = (box.min[a] - o) / d;
    let t2 = (box.max[a] - o) / d;
    let s1: BoxFace["side"] = "min";
    let s2: BoxFace["side"] = "max";
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [s1, s2] = [s2, s1];
    }
    if (t1 > tEnter) {
      tEnter = t1;
      enterFace = { axis: a, side: s1 };
    }
    if (t2 < tExit) {
      tExit = t2;
      exitFace = { axis: a, side: s2 };
    }
  }
  if (tEnter > tExit || tExit < 0 || !exitFace) return null;
  return {
    enter: tEnter > 0 && enterFace ? { ...enterFace, point: ray.at(tEnter, new THREE.Vector3()), inner: false } : null,
    exit: { ...exitFace, point: ray.at(tExit, new THREE.Vector3()), inner: true },
  };
}

/**
 * 直線 p0 + s·u（u は単位ベクトル）上で、光線に最も近い点の s。
 * 軸とほぼ平行に見ているとき（動かす量が決まらない）と、カメラの後ろになるときは null。
 */
export function axisParamOnRay(ray: THREE.Ray, p0: THREE.Vector3, u: THREE.Vector3): number | null {
  const d = ray.direction;
  const w0 = p0.clone().sub(ray.origin);
  const b = u.dot(d);
  const c = d.dot(d);
  const du = u.dot(w0);
  const e = d.dot(w0);
  const denom = c - b * b;
  if (denom < 1e-3) return null;
  const t = (e - b * du) / denom;
  if (t < 0) return null;
  return (b * e - c * du) / denom;
}

const COLOR_OUTER = 0xffa040;
const COLOR_INNER = 0x40c0ff;

/**
 * 3D 画面で切断ボックスの面をドラッグして動かす。
 * 何も押さずに: カメラから見て手前の面（箱の外側から見えている面）。
 * Shift を押しながら: 奥の面（箱の内側から見えている面）。
 * 面の上で押したときだけ回転（OrbitControls）を止めるので、箱の外では普段どおり回せる。
 * 動かさずに離せば普段のクリック（選択・計測）になる。
 */
export class ClipBoxEditor {
  /** 3D で面を動かせるか（パネルの切替） */
  enabled = true;
  private hover: FaceHit | null = null;
  private drag: {
    face: FaceHit;
    pointerId: number;
    dir: THREE.Vector3;
    s0: number;
    v0: number;
    lo: number;
    hi: number;
  } | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private shift = false;
  private applyQueued = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly highlight: THREE.Mesh;

  constructor(
    private readonly viewer: Viewer3D,
    private readonly clipping: Clipping,
  ) {
    this.highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: COLOR_OUTER, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 10;
    viewer.overlay.add(this.highlight);

    const canvas = viewer.canvas;
    // OrbitControls より先に受けて、面の上なら回転を止める（同じ要素の capture は bubble より先に呼ばれる）
    canvas.addEventListener("pointerdown", (e) => this.onDown(e), { capture: true });
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => {
      this.lastPointer = null;
      if (!this.drag) this.setHover(null);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || this.shift === e.shiftKey) return;
      this.shift = e.shiftKey;
      if (!this.drag && this.lastPointer) this.setHover(this.faceAt(this.lastPointer.x, this.lastPointer.y, this.shift));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", () => {
      this.shift = false;
      if (!this.drag) this.setHover(null);
    });
  }

  private get active(): boolean {
    return this.enabled && this.clipping.mode === "box";
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** 切断の状態が変わったとき（パネル・視点再現など）に呼ぶ。強調表示を箱に合わせる */
  refresh() {
    if (!this.active) {
      this.cancel();
      return;
    }
    this.updateHighlight();
  }

  private cancel() {
    // 切断の切替から呼ばれるので、ここでは適用し直さない（onChange が入れ子になる）
    if (this.drag) this.endDrag(false);
    this.setHover(null);
  }

  private ray(clientX: number, clientY: number): THREE.Ray {
    this.raycaster.setFromCamera(this.viewer.toNdc(clientX, clientY), this.viewer.camera);
    return this.raycaster.ray;
  }

  /** 画面の位置にある面。inner=false は手前（外側）の面、true は奥（内側）の面 */
  faceAt(clientX: number, clientY: number, inner: boolean): FaceHit | null {
    if (!this.active) return null;
    const hits = rayBoxFaces(this.ray(clientX, clientY), this.clipping.box);
    if (!hits) return null;
    return inner ? hits.exit : hits.enter;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || !this.active) return;
    this.shift = e.shiftKey;
    const face = this.faceAt(e.clientX, e.clientY, e.shiftKey);
    if (!face) return;
    const dir = new THREE.Vector3();
    dir[face.axis] = 1;
    const s0 = axisParamOnRay(this.ray(e.clientX, e.clientY), face.point, dir);
    if (s0 === null) return; // 面を真横から見ていて動かす量が決まらない
    const { lo, hi } = this.clipping.limits();
    const v0 = this.clipping.box[face.side][face.axis];
    this.drag = {
      face,
      pointerId: e.pointerId,
      dir,
      s0,
      v0,
      lo: Math.min(lo[face.axis], v0),
      hi: Math.max(hi[face.axis], v0),
    };
    // 回転を止める（OrbitControls は enabled=false なら pointerdown を無視する）
    this.viewer.controls.enabled = false;
    this.viewer.canvas.setPointerCapture(e.pointerId);
    this.setHover(face);
  }

  private onMove(e: PointerEvent) {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (d) {
      if (e.pointerId !== d.pointerId) return;
      const s = axisParamOnRay(this.ray(e.clientX, e.clientY), d.face.point, d.dir);
      if (s === null) return;
      const box = this.clipping.box;
      const a = d.face.axis;
      const v = d.v0 + (s - d.s0);
      if (d.face.side === "min") box.min[a] = THREE.MathUtils.clamp(v, d.lo, box.max[a] - MIN_BOX_SIZE);
      else box.max[a] = THREE.MathUtils.clamp(v, box.min[a] + MIN_BOX_SIZE, d.hi);
      this.updateHighlight();
      this.viewer.requestRender();
      this.queueApply();
      return;
    }
    // ボタンを押したまま（回転・移動中）は強調しない
    this.setHover(e.buttons === 0 ? this.faceAt(e.clientX, e.clientY, e.shiftKey) : null);
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.endDrag();
    this.setHover(e.type === "pointerup" ? this.faceAt(e.clientX, e.clientY, e.shiftKey) : null);
  }

  private endDrag(apply = true) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.viewer.controls.enabled = true;
    if (this.viewer.canvas.hasPointerCapture(d.pointerId)) this.viewer.canvas.releasePointerCapture(d.pointerId);
    if (apply) this.clipping.apply();
  }

  /**
   * 切断の適用（点群の読み直し・モデルの更新）は重いので 1 フレームに 1 回にまとめる。
   * 箱の枠と強調はその場で動かす。
   */
  private queueApply() {
    if (this.applyQueued) return;
    this.applyQueued = true;
    requestAnimationFrame(() => {
      this.applyQueued = false;
      if (this.clipping.mode === "box") this.clipping.apply();
    });
  }

  private setHover(face: FaceHit | null) {
    const same = face && this.hover && face.axis === this.hover.axis && face.side === this.hover.side && face.inner === this.hover.inner;
    this.hover = face;
    this.viewer.canvas.style.cursor = this.drag ? "grabbing" : face ? "grab" : "";
    if (same) return;
    this.updateHighlight();
  }

  /** 強調する面（ドラッグ中はその面、それ以外はマウスの下の面）を箱の今の位置に置く */
  private updateHighlight() {
    const face = this.drag?.face ?? this.hover;
    const m = this.highlight;
    const was = m.visible;
    m.visible = !!face && this.active;
    if (face && m.visible) {
      const box = this.clipping.box;
      const size = box.getSize(new THREE.Vector3());
      box.getCenter(m.position);
      m.position[face.axis] = box[face.side][face.axis];
      m.rotation.set(0, 0, 0);
      // PlaneGeometry は XY 平面（法線 +Z）。面の向きに回す（clipping.ts の断面表示と同じ回し方）
      if (face.axis === "z") m.scale.set(size.x, size.y, 1);
      else if (face.axis === "x") {
        m.rotation.y = Math.PI / 2;
        m.scale.set(size.z, size.y, 1);
      } else {
        m.rotation.x = Math.PI / 2;
        m.scale.set(size.x, size.z, 1);
      }
      (m.material as THREE.MeshBasicMaterial).color.setHex(face.inner ? COLOR_INNER : COLOR_OUTER);
    }
    if (was || m.visible) this.viewer.requestRender();
  }
}
