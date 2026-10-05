import * as THREE from "three";
import type { Viewer3D } from "../scene/viewer3d";
import type { Axis, ClipGuide, Clipping } from "./clipping";

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
/** 断面の目印が遠くて小さく見えても、中心からこの距離（px）以内なら掴める */
const GUIDE_PICK_PX = 10;
/** 法線と視線がこれより揃っている（真正面に近い）ときは、画面の上下のドラッグで動かす */
const FACE_ON_DOT = 0.9;

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

interface GuideHit {
  guide: ClipGuide;
  point: THREE.Vector3;
  t: number;
}

type Drag =
  | { kind: "box"; face: FaceHit; pointerId: number; dir: THREE.Vector3; s0: number; v0: number; lo: number; hi: number }
  | {
      kind: "guide";
      key: string;
      pointerId: number;
      dir: THREE.Vector3;
      point: THREE.Vector3;
      /** 光線で追うときの基準。null なら画面の上下で動かす（真正面から見ているとき） */
      s0: number | null;
      y0: number;
      /** 画面 1px あたりの m */
      pxM: number;
      /** 法線がカメラ側を向いていれば 1 */
      sign: number;
      v0: number;
      lo: number;
      hi: number;
    };

/**
 * 3D 画面で切断の目印をドラッグして動かす（枠を表示している間だけ）。
 * - 切断ボックスの面: 何も押さずに手前の面、Shift を押しながら奥の面（箱の内側から見えている面）。
 * - 断面の四角（1m 角）: レール（法線）に沿って動かす。四角が箱の面より優先。
 * 目印の上で押したときだけ回転（OrbitControls）を止めるので、ほかの所では普段どおり回せる。
 * 動かさずに離せば普段のクリック（選択・計測）になる。
 */
export class ClipBoxEditor {
  private hover: FaceHit | null = null;
  private hoverGuide: string | null = null;
  private drag: Drag | null = null;
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
    // OrbitControls より先に受けて、目印の上なら回転を止める（同じ要素の capture は bubble より先に呼ばれる）
    canvas.addEventListener("pointerdown", (e) => this.onDown(e), { capture: true });
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => {
      this.lastPointer = null;
      if (!this.drag) this.setHover(null, null);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || this.shift === e.shiftKey) return;
      this.shift = e.shiftKey;
      if (!this.drag && this.lastPointer) this.hoverAt(this.lastPointer.x, this.lastPointer.y, this.shift);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", () => {
      this.shift = false;
      if (!this.drag) this.setHover(null, null);
    });
  }

  /** 箱の面を掴めるか（枠を隠している間は掴めない。切断は効いたまま） */
  private get boxActive(): boolean {
    return this.clipping.showGuides && this.clipping.boxOn;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** 切断の状態が変わったとき（パネル・視点再現など）に呼ぶ。強調表示を今の目印に合わせる */
  refresh() {
    const d = this.drag;
    const stale = d && (d.kind === "box" ? !this.boxActive : !this.clipping.guides().some((g) => g.key === d.key));
    if (stale) this.endDrag(false);
    if (this.hoverGuide && !this.clipping.guides().some((g) => g.key === this.hoverGuide)) this.setHover(this.hover, null);
    if (!this.boxActive && this.hover) this.setHover(null, this.hoverGuide);
    this.updateHighlight();
  }

  private ray(clientX: number, clientY: number): THREE.Ray {
    this.raycaster.setFromCamera(this.viewer.toNdc(clientX, clientY), this.viewer.camera);
    return this.raycaster.ray;
  }

  /** 画面の位置にある箱の面。inner=false は手前（外側）の面、true は奥（内側）の面 */
  faceAt(clientX: number, clientY: number, inner: boolean): FaceHit | null {
    if (!this.boxActive) return null;
    const hits = rayBoxFaces(this.ray(clientX, clientY), this.clipping.box);
    if (!hits) return null;
    return inner ? hits.exit : hits.enter;
  }

  /** 画面の位置にある断面の四角（いちばん手前）。遠くて小さいときは中心の近くでも掴める */
  guideAt(clientX: number, clientY: number): GuideHit | null {
    const guides = this.clipping.guides();
    if (!guides.length) return null;
    const ray = this.ray(clientX, clientY).clone();
    const rect = this.viewer.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const { width, height } = this.viewer.size;
    let best: GuideHit | null = null;
    const plane = new THREE.Plane();
    for (const g of guides) {
      let hit: GuideHit | null = null;
      const p = ray.intersectPlane(plane.setFromNormalAndCoplanarPoint(g.normal, g.center), new THREE.Vector3());
      if (p) {
        const d = p.clone().sub(g.center);
        const half = this.clipping.guideSize(g.center) / 2;
        if (Math.abs(d.dot(g.u)) <= half && Math.abs(d.dot(g.v)) <= half) hit = { guide: g, point: p, t: ray.origin.distanceTo(p) };
      }
      if (!hit) {
        const s = g.center.clone().project(this.viewer.camera);
        if (s.z >= -1 && s.z <= 1 && Math.hypot(((s.x + 1) / 2) * width - cx, ((1 - s.y) / 2) * height - cy) <= GUIDE_PICK_PX)
          hit = { guide: g, point: g.center.clone(), t: ray.origin.distanceTo(g.center) };
      }
      if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
  }

  private hoverAt(clientX: number, clientY: number, inner: boolean) {
    const g = this.guideAt(clientX, clientY);
    if (g) this.setHover(null, g.guide.key);
    else this.setHover(this.faceAt(clientX, clientY, inner), null);
  }

  /** 距離 d の位置での画面 1px の大きさ（m） */
  private pxSize(d: number): number {
    const cam = this.viewer.camera;
    const h = Math.max(1, this.viewer.size.height);
    if (cam instanceof THREE.OrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
    return (d * 2 * Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov / 2))) / h;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || !this.clipping.showGuides) return;
    this.shift = e.shiftKey;
    const g = this.guideAt(e.clientX, e.clientY);
    if (g) {
      this.startGuideDrag(e, g);
      return;
    }
    if (!this.boxActive) return;
    const face = this.faceAt(e.clientX, e.clientY, e.shiftKey);
    if (!face) return;
    const dir = new THREE.Vector3();
    dir[face.axis] = 1;
    const s0 = axisParamOnRay(this.ray(e.clientX, e.clientY), face.point, dir);
    if (s0 === null) return; // 面を真横から見ていて動かす量が決まらない
    const { lo, hi } = this.clipping.limits();
    const v0 = this.clipping.box[face.side][face.axis];
    this.drag = {
      kind: "box",
      face,
      pointerId: e.pointerId,
      dir,
      s0,
      v0,
      lo: Math.min(lo[face.axis], v0),
      hi: Math.max(hi[face.axis], v0),
    };
    this.capture(e);
    this.setHover(face, null);
  }

  private startGuideDrag(e: PointerEvent, hit: GuideHit) {
    const ray = this.ray(e.clientX, e.clientY);
    const dir = hit.guide.normal.clone();
    // 斜めから見ていれば、レールに沿って光線で追う。真正面に近ければ画面の上下で動かす
    const s0 = Math.abs(dir.dot(ray.direction)) < FACE_ON_DOT ? axisParamOnRay(ray, hit.point, dir) : null;
    const { lo, hi } = this.clipping.guideRange(hit.guide.key);
    this.drag = {
      kind: "guide",
      key: hit.guide.key,
      pointerId: e.pointerId,
      dir,
      point: hit.point.clone(),
      s0,
      y0: e.clientY,
      pxM: this.pxSize(this.viewer.camera.position.distanceTo(hit.point)),
      sign: dir.dot(ray.direction) < 0 ? 1 : -1,
      v0: this.clipping.guideValue(hit.guide.key),
      lo,
      hi,
    };
    this.capture(e);
    this.setHover(null, hit.guide.key);
  }

  private capture(e: PointerEvent) {
    // 回転を止める（OrbitControls は enabled=false なら pointerdown を無視する）
    this.viewer.controls.enabled = false;
    this.viewer.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (d) {
      if (e.pointerId !== d.pointerId) return;
      if (d.kind === "box") {
        const s = axisParamOnRay(this.ray(e.clientX, e.clientY), d.face.point, d.dir);
        if (s === null) return;
        const box = this.clipping.box;
        const a = d.face.axis;
        const v = d.v0 + (s - d.s0);
        if (d.face.side === "min") box.min[a] = THREE.MathUtils.clamp(v, d.lo, box.max[a] - MIN_BOX_SIZE);
        else box.max[a] = THREE.MathUtils.clamp(v, box.min[a] + MIN_BOX_SIZE, d.hi);
        this.updateHighlight();
        this.viewer.requestRender();
      } else {
        let ds: number;
        if (d.s0 !== null) {
          const s = axisParamOnRay(this.ray(e.clientX, e.clientY), d.point, d.dir);
          if (s === null) return;
          ds = s - d.s0;
        } else {
          // 真正面: 上へドラッグするとカメラから遠ざかる（奥へ押し込む）
          ds = (d.y0 - e.clientY) * d.pxM * -d.sign;
        }
        this.clipping.setGuideValue(d.key, THREE.MathUtils.clamp(d.v0 + ds, d.lo, d.hi));
      }
      this.queueApply();
      return;
    }
    // ボタンを押したまま（回転・移動中）は強調しない
    if (e.buttons === 0) this.hoverAt(e.clientX, e.clientY, e.shiftKey);
    else this.setHover(null, null);
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.endDrag();
    if (e.type === "pointerup") this.hoverAt(e.clientX, e.clientY, e.shiftKey);
    else this.setHover(null, null);
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
   * 切断の適用（点群の読み直し・モデルの更新・パネルの値）は重いので 1 フレームに 1 回にまとめる。
   * 目印と強調はその場で動かす。
   */
  private queueApply() {
    if (this.applyQueued) return;
    this.applyQueued = true;
    requestAnimationFrame(() => {
      this.applyQueued = false;
      if (this.clipping.active) this.clipping.apply();
    });
  }

  private setHover(face: FaceHit | null, guide: string | null) {
    const same = face && this.hover && face.axis === this.hover.axis && face.side === this.hover.side && face.inner === this.hover.inner;
    const sameFace = same || (!face && !this.hover);
    this.hover = face;
    this.hoverGuide = guide;
    this.clipping.setHoverGuide(guide);
    this.viewer.canvas.style.cursor = this.drag ? "grabbing" : face || guide ? "grab" : "";
    if (sameFace) return;
    this.updateHighlight();
  }

  /** 強調する箱の面（ドラッグ中はその面、それ以外はマウスの下の面）を箱の今の位置に置く */
  private updateHighlight() {
    const face = (this.drag?.kind === "box" ? this.drag.face : null) ?? this.hover;
    const m = this.highlight;
    const was = m.visible;
    m.visible = !!face && this.boxActive;
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
