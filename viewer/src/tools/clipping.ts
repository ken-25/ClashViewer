import * as THREE from "three";
import type { Viewer3D } from "../scene/viewer3d";

export type Axis = "x" | "y" | "z";

/** 保存形式の断面（世界座標） */
export interface SectionState {
  normal: number[];
  point: number[];
  offset: number;
  thickness: number;
  flip: boolean;
  enabled: boolean;
  /** 向きの表示名（「水平」「垂直（UCS X）」など）。面に合わせた断面は無し */
  label?: string;
  /** 軸に沿った断面の座標の表示（space の axis 方向の座標 = base + offset） */
  coord?: SectionCoord;
}

/**
 * 保存形式。古い指摘（mode・section の 1 枚断面）も読めるように、古い項目も任意で受ける。
 * 新しく保存するのは boxOn・box・sections。
 */
export interface ClipState {
  boxOn?: boolean;
  box?: { min: number[]; max: number[] }; // 世界座標
  sections?: SectionState[];
  /** 旧形式: "none" | "box" | "section" */
  mode?: string;
  /** 旧形式: XYZ に直交する 1 枚の断面（position は世界座標） */
  section?: { axis: Axis; position: number; thickness: number; flip: boolean };
  /** 旧形式（開発途中）: 面に合わせた断面 */
  planes?: SectionState[];
}

export interface SectionCoord {
  space: "WCS" | "UCS";
  axis: Axis;
  /** point の、その座標系の axis 方向の座標（m） */
  base: number;
}

/**
 * 断面（いくつでも作れる切断面）。水平・垂直は向きが軸に決まった断面、
 * 面に合わせた断面はクリックした面（モデルの面・点群の平らな所・3点）の向き。
 * 切断面は point + normal × offset を通り、normal に直交する。
 * 既定は normal 側を消し、flip で逆側を消す。
 */
export interface Section {
  id: number;
  name: string;
  /** 単位ベクトル（シーン座標） */
  normal: THREE.Vector3;
  /** 作ったときの点（シーン座標）。offset の基準・目印の位置 */
  point: THREE.Vector3;
  /** point から normal 方向へずらす量（m） */
  offset: number;
  /** 0 なら片側を残す。> 0 なら残す側をこの幅に絞る */
  thickness: number;
  flip: boolean;
  enabled: boolean;
  label?: string;
  coord?: SectionCoord;
}

/** クリックした面そのものを消さない（面と同じ位置で切ると、ちらつく）ための逃げ（m） */
export const FACE_EPS = 0.001;

/**
 * 切断ボックス（1 つ）と断面（いくつでも）。renderer.clippingPlanes（全体の切断面）を使うので、
 * 点群（自前シェーダー）とモデル（Fragments）に同じ切断が効く。重ねて効く（どれかで消える所は消える）。
 *
 * 「切断が効いているか」と「枠（箱・断面の目印）を出すか」は別に持つ。
 * 枠を隠しても切断はそのまま効く（showGuides）。
 */
export class Clipping {
  /** 切断ボックスを効かせるか。オフにしても範囲は覚えておく */
  boxOn = false;
  readonly box = new THREE.Box3(); // シーン座標
  /** 断面。enabled=false の断面は一覧に残したまま効かせない */
  sections: Section[] = [];
  /** 箱の枠・断面の目印・3D のドラッグを出すか（切断が効くかとは別） */
  showGuides = true;
  private nextId = 1;
  private readonly helper: THREE.Box3Helper;
  /** 断面の目印（1m 角の四角とレール） */
  private readonly guideGroup = new THREE.Group();
  private readonly guideObjs = new Map<string, GuideObj>();
  /** マウスの下（またはドラッグ中）の目印。強調する */
  private hoverGuide: string | null = null;
  onChange: (() => void) | null = null;

  constructor(private readonly viewer: Viewer3D) {
    this.helper = new THREE.Box3Helper(this.box, COLOR_BOX);
    (this.helper.material as THREE.LineBasicMaterial).depthTest = false;
    this.helper.visible = false;
    viewer.overlay.add(this.helper);
    this.guideGroup.name = "clip-guides";
    viewer.overlay.add(this.guideGroup);
    // 目印の大きさはカメラとの距離で変わるので、描くたびに合わせる
    viewer.onBeforeRender(() => {
      for (const o of this.guideObjs.values()) o.square.scale.setScalar(this.guideSize(o.square.position));
    });
  }

  /**
   * 目印の四角の一辺（m）。近くでは 1m 角、遠くで 1m が画面上で小さすぎるときは
   * 画面で GUIDE_MIN_PX 以上に見える大きさにする（遠くから見ると見えなくなるため）。
   */
  guideSize(center: THREE.Vector3): number {
    const cam = this.viewer.camera;
    const h = Math.max(1, this.viewer.size.height);
    const px = cam instanceof THREE.OrthographicCamera
      ? (cam.top - cam.bottom) / cam.zoom / h
      : (cam.position.distanceTo(center) * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
    return Math.max(GUIDE_SIZE, px * GUIDE_MIN_PX);
  }

  /** シーン全体の範囲（初期値の基準） */
  extent = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));

  /** 箱・断面を動かせる範囲（全体の範囲を各辺 5% 広げたもの） */
  limits(): { lo: THREE.Vector3; hi: THREE.Vector3 } {
    const pad = this.extent.getSize(new THREE.Vector3()).multiplyScalar(0.05);
    return { lo: this.extent.min.clone().sub(pad), hi: this.extent.max.clone().add(pad) };
  }

  /** 何かの切断が効いているか（ボックス・有効な断面のどれか） */
  get active(): boolean {
    return this.boxOn || this.sections.some((p) => p.enabled);
  }

  get enabledSections(): number {
    return this.sections.filter((s) => s.enabled).length;
  }

  setBoxOn(on: boolean) {
    this.boxOn = on;
    if (on && this.box.isEmpty()) this.box.copy(this.extent);
    this.apply();
  }

  /** 切断をすべてオフにする（断面は一覧に残し、無効にするだけ） */
  disableAll() {
    this.boxOn = false;
    for (const p of this.sections) p.enabled = false;
    this.apply();
  }

  /** プロジェクトを閉じたとき。断面も消す */
  reset() {
    this.boxOn = false;
    this.sections = [];
    this.nextId = 1;
    this.apply();
  }

  setShowGuides(on: boolean) {
    this.showGuides = on;
    this.apply();
  }

  setBox(box: THREE.Box3) {
    this.box.copy(box);
    this.apply();
  }

  /** 点の周りに箱を置く（干渉を見たい所だけを切り出す） */
  boxAround(p: THREE.Vector3, half = 2) {
    this.box.set(p.clone().subScalar(half), p.clone().addScalar(half));
    this.setBoxOn(true);
  }

  /**
   * 向きが軸に決まった断面（水平・垂直）を足す。point を通り、dir 側（水平なら上）を消す。
   * coord はパネルに出す座標（WCS / UCS のどの軸か）。
   */
  addAxisSection(point: THREE.Vector3, dir: THREE.Vector3, label: string, coord: SectionCoord): Section {
    return this.push({ normal: dir.clone().normalize(), point: point.clone(), offset: 0, label, coord });
  }

  /**
   * 面に合わせた断面を足す。normal は面の法線（どちら向きでもよい）、
   * toCamera はクリックした点からカメラへの向き。法線をカメラ側へ向け、カメラ側を消す。
   */
  addFaceSection(point: THREE.Vector3, normal: THREE.Vector3, toCamera: THREE.Vector3, tolDeg?: number): Section {
    const n = cleanNormal(normal, tolDeg);
    if (n.dot(toCamera) < 0) n.negate();
    return this.push({ normal: n, point: point.clone(), offset: FACE_EPS });
  }

  private push(s: Pick<Section, "normal" | "point" | "offset" | "label" | "coord">): Section {
    const id = this.nextId++;
    const sec: Section = { id, name: `断面 ${id}`, thickness: 0, flip: false, enabled: true, ...s };
    this.sections.push(sec);
    this.apply();
    return sec;
  }

  updateSection(id: number, patch: Partial<Pick<Section, "offset" | "thickness" | "flip" | "enabled">>) {
    const p = this.sections.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    this.apply();
  }

  removeSection(id: number) {
    this.sections = this.sections.filter((x) => x.id !== id);
    this.apply();
  }

  /** 断面の offset を動かせる範囲（全体の範囲の 8 隅を法線へ投影したもの） */
  sectionRange(p: Section): { lo: number; hi: number } {
    const { lo, hi } = this.limits();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
      const d = c.sub(p.point).dot(p.normal);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    return { lo: Math.min(min, p.offset), hi: Math.max(max, p.offset) };
  }

  /** 断面が通る点（シーン座標） */
  sectionOrigin(p: Section): THREE.Vector3 {
    return p.point.clone().addScaledVector(p.normal, p.offset);
  }

  /** いま効かせる切断面すべて */
  clipPlanes(): THREE.Plane[] {
    const list: THREE.Plane[] = [];
    if (this.boxOn) {
      const { min, max } = this.box;
      list.push(
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -min.x),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), max.x),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -min.y),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), max.y),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -min.z),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z),
      );
    }
    for (const s of this.sections) if (s.enabled) list.push(...sectionPlanes(s, this.sectionOrigin(s)));
    return list;
  }

  apply() {
    this.viewer.renderer.clippingPlanes = this.clipPlanes();
    this.helper.visible = this.showGuides && this.boxOn;
    this.updateGuides();
    this.viewer.requestRender();
    this.onChange?.();
  }

  // ---- 断面の目印（3D でドラッグして動かす取っ手） ----

  /** いま出している断面の目印（offset をレール＝法線に沿って動かす）。枠を隠しているときは空 */
  guides(): ClipGuide[] {
    if (!this.showGuides) return [];
    const list: ClipGuide[] = [];
    for (const s of this.sections) {
      if (!s.enabled) continue;
      const r = this.sectionRange(s);
      list.push({ key: guideKey(s.id), center: this.sectionOrigin(s), normal: s.normal.clone(), ...basisOf(s.normal), railLo: r.lo - s.offset, railHi: r.hi - s.offset, color: COLOR_SECTION });
    }
    return list;
  }

  guideValue(key: string): number {
    return this.sectionByKey(key)?.offset ?? 0;
  }

  guideRange(key: string): { lo: number; hi: number } {
    const p = this.sectionByKey(key);
    return p ? this.sectionRange(p) : { lo: 0, hi: 0 };
  }

  /** ドラッグ中に値だけ変える（目印はすぐ動かし、重い apply は呼ぶ側がまとめる） */
  setGuideValue(key: string, v: number) {
    const p = this.sectionByKey(key);
    if (p) p.offset = v;
    this.viewer.renderer.clippingPlanes = this.clipPlanes();
    this.updateGuides();
    this.viewer.requestRender();
  }

  setHoverGuide(key: string | null) {
    if (this.hoverGuide === key) return;
    this.hoverGuide = key;
    this.updateGuides();
    this.viewer.requestRender();
  }

  private sectionByKey(key: string): Section | undefined {
    return this.sections.find((p) => guideKey(p.id) === key);
  }

  /** 目印の 3D 表示を今の値に合わせる（無くなった目印は捨てる） */
  updateGuides() {
    const list = this.guides();
    const keys = new Set(list.map((g) => g.key));
    for (const [k, o] of this.guideObjs) {
      if (keys.has(k)) continue;
      this.guideGroup.remove(o.square, o.rail);
      o.rail.geometry.dispose();
      for (const m of [o.fill.material, o.edge.material, o.rail.material]) (m as THREE.Material).dispose();
      this.guideObjs.delete(k);
    }
    const basis = new THREE.Matrix4();
    for (const g of list) {
      let o = this.guideObjs.get(g.key);
      if (!o) {
        o = createGuideObj(g.color);
        this.guideObjs.set(g.key, o);
        this.guideGroup.add(o.square, o.rail);
      }
      o.square.position.copy(g.center);
      o.square.quaternion.setFromRotationMatrix(basis.makeBasis(g.u, g.v, g.normal));
      o.square.scale.setScalar(this.guideSize(g.center));
      const pos = o.rail.geometry.getAttribute("position") as THREE.BufferAttribute;
      const a = g.center.clone().addScaledVector(g.normal, g.railLo);
      const b = g.center.clone().addScaledVector(g.normal, g.railHi);
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
      o.rail.geometry.computeBoundingSphere();
      const hot = this.hoverGuide === g.key;
      (o.fill.material as THREE.MeshBasicMaterial).opacity = hot ? 0.45 : 0.25;
      (o.edge.material as THREE.LineBasicMaterial).opacity = hot ? 1 : 0.8;
      (o.rail.material as THREE.LineBasicMaterial).opacity = hot ? 0.9 : 0.45;
    }
  }

  serialize(origin: number[]): ClipState {
    const o = new THREE.Vector3(origin[0], origin[1], origin[2]);
    return {
      boxOn: this.boxOn,
      box: {
        min: [this.box.min.x + origin[0], this.box.min.y + origin[1], this.box.min.z + origin[2]],
        max: [this.box.max.x + origin[0], this.box.max.y + origin[1], this.box.max.z + origin[2]],
      },
      sections: this.sections.map((p) => ({
        normal: p.normal.toArray(),
        point: p.point.clone().add(o).toArray(),
        offset: p.offset,
        thickness: p.thickness,
        flip: p.flip,
        enabled: p.enabled,
        ...(p.label ? { label: p.label } : {}),
        ...(p.coord ? { coord: { ...p.coord } } : {}),
      })),
    };
  }

  restore(s: ClipState | undefined, origin: number[]) {
    this.sections = [];
    this.nextId = 1;
    this.boxOn = false;
    if (!s) {
      this.apply();
      return;
    }
    if (s.box?.min?.length === 3 && s.box?.max?.length === 3)
      this.box.set(
        new THREE.Vector3(s.box.min[0] - origin[0], s.box.min[1] - origin[1], s.box.min[2] - origin[2]),
        new THREE.Vector3(s.box.max[0] - origin[0], s.box.max[1] - origin[1], s.box.max[2] - origin[2]),
      );
    this.boxOn = s.boxOn ?? s.mode === "box";
    const o = new THREE.Vector3(origin[0], origin[1], origin[2]);
    // 旧形式の 1 枚断面は「断面 1」として読む（軸の向き、正の側を消す）
    if (s.mode === "section" && s.section) {
      const { axis, position, thickness, flip } = s.section;
      const n = new THREE.Vector3();
      n[axis] = 1;
      const pt = this.extent.getCenter(new THREE.Vector3());
      pt[axis] = position - origin[{ x: 0, y: 1, z: 2 }[axis]];
      this.sections.push({
        id: this.nextId++, name: "", normal: n, point: pt, offset: 0, thickness: Number(thickness) || 0, flip: !!flip, enabled: true,
        label: axis === "z" ? "水平" : `垂直（${axis.toUpperCase()}）`,
        coord: { space: "WCS", axis, base: position },
      });
    }
    for (const p of [...(Array.isArray(s.sections) ? s.sections : []), ...(Array.isArray(s.planes) ? s.planes : [])]) {
      if (p?.normal?.length !== 3 || p?.point?.length !== 3) continue;
      this.sections.push({
        id: this.nextId++,
        name: "",
        normal: new THREE.Vector3().fromArray(p.normal).normalize(),
        point: new THREE.Vector3().fromArray(p.point).sub(o),
        offset: Number(p.offset) || 0,
        thickness: Number(p.thickness) || 0,
        flip: !!p.flip,
        enabled: p.enabled !== false,
        label: typeof p.label === "string" ? p.label : undefined,
        coord: p.coord && ["WCS", "UCS"].includes(p.coord.space) && ["x", "y", "z"].includes(p.coord.axis) ? { ...p.coord, base: Number(p.coord.base) || 0 } : undefined,
      });
    }
    for (const sec of this.sections) sec.name = `断面 ${sec.id}`;
    this.apply();
  }
}

/** 断面の切断面（n·x + c >= 0 の側を残す）。既定は normal 側を消す。厚み t > 0 なら残す側を t の幅に絞る */
function sectionPlanes(s: Section, o: THREE.Vector3): THREE.Plane[] {
  const n = s.normal;
  const d = n.dot(o);
  const t = s.thickness;
  if (!s.flip) {
    const planes = [new THREE.Plane(n.clone().negate(), d)];
    if (t > 0) planes.push(new THREE.Plane(n.clone(), -(d - t)));
    return planes;
  }
  const planes = [new THREE.Plane(n.clone(), -d)];
  if (t > 0) planes.push(new THREE.Plane(n.clone().negate(), d + t));
  return planes;
}

/**
 * 面の法線を整える。ほぼ 0 の成分は 0 にする（水平・鉛直の面はぴったり水平・鉛直に切れるように）。
 * tolDeg: 軸からこの角度以内のずれを丸める。モデルの法線は圧縮で少しぶれる程度（約 0.1°）、
 * 点群の当てはめ・3点指定はクリックのぶれがあるので大きめにする。
 */
export function cleanNormal(v: THREE.Vector3, tolDeg = 0.11): THREE.Vector3 {
  const n = v.clone().normalize();
  const tol = Math.sin(THREE.MathUtils.degToRad(tolDeg));
  for (const a of ["x", "y", "z"] as const) if (Math.abs(n[a]) < tol) n[a] = 0;
  return n.normalize();
}

/** 目印の四角の一辺（m）。遠くでは画面で GUIDE_MIN_PX 以上になるよう大きくする */
export const GUIDE_SIZE = 1;
const GUIDE_MIN_PX = 60;
const COLOR_BOX = 0xffa040;
const COLOR_SECTION = 0x60c0ff;

/** 断面の目印（シーン座標）。u・v は四角の辺の向き、rail は center から法線方向の動かせる範囲 */
export interface ClipGuide {
  key: string;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  railLo: number;
  railHi: number;
  color: number;
}

interface GuideObj {
  square: THREE.Group;
  fill: THREE.Mesh;
  edge: THREE.LineLoop;
  rail: THREE.Line;
}

const guideKey = (id: number) => `section:${id}`;

const SQUARE_GEO = new THREE.PlaneGeometry(1, 1);
const EDGE_GEO = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0),
]);

function createGuideObj(color: number): GuideObj {
  const fill = new THREE.Mesh(SQUARE_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
  const edge = new THREE.LineLoop(EDGE_GEO, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: false }));
  const square = new THREE.Group();
  square.add(fill, edge);
  const railGeo = new THREE.BufferGeometry();
  railGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
  const rail = new THREE.Line(railGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthTest: false }));
  rail.frustumCulled = false;
  square.renderOrder = rail.renderOrder = 5;
  return { square, fill, edge, rail };
}

/** 法線 n に直交する 2 方向。鉛直な面は辺が水平・鉛直に、水平な面は X・Y に沿うように */
function basisOf(n: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const z = new THREE.Vector3(0, 0, 1);
  const u = Math.abs(n.z) > 0.999 ? new THREE.Vector3(1, 0, 0) : z.clone().cross(n).normalize();
  const v = n.clone().cross(u).normalize();
  return { u, v };
}
