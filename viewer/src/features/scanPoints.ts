// 撮影ポイント（F6）: 器械点の目印、撮影ポイントに立って見回す視点、順に巡る移動、そこで撮った画像（360 画像・写真）の表示。
// 一覧と向きの計算は data/scanPoints.ts、画面（ツール・右パネル・レイヤーの行）は modes/scanPointsTool.ts。

import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { App } from "../app";
import { worldToScene, type Manifest } from "../data/dataset";
import {
  imageQuaternion,
  nearestStation,
  panoramaDirection,
  pinholeCorners,
  placedStations,
  scanStations,
  stationForward,
  stepStation,
  type ScanStation,
  type StationImage,
} from "../data/scanPoints";
import { fetchBytes } from "../host";
import type { AppFeature } from "./feature";

/** 撮影ポイントに入る前の視点（出るときに戻す） */
interface SavedView {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  projection: "perspective" | "orthographic";
}

/** 画像を貼る球・面の半径（m）。重ね描き（深度なし）なので大きさは見え方に関係しない */
const IMAGE_RADIUS = 5;
/** 巡回の間隔（秒）の選択肢 */
export const TOUR_INTERVALS = [3, 5, 10, 20];

export class ScanPoints implements AppFeature {
  /** 開いている版の撮影ポイント（位置不明も含む） */
  list: ScanStation[] = [];
  /** 立っている撮影ポイント（null なら普通の視点） */
  currentId: string | null = null;
  /** 3D 画面に目印を出すか（この PC に覚える） */
  showMarkers = localStorage.getItem("scanPoints:markers") !== "off";
  /** 撮影ポイントに立ったとき画像を出すか（この PC に覚える） */
  showImage = localStorage.getItem("scanPoints:image") !== "off";
  /** 画像の不透明度（0 = 点群だけ、1 = 画像だけ） */
  imageOpacity = clamp01(Number(localStorage.getItem("scanPoints:opacity") ?? "1"));
  /** 画像の読み込み状態 */
  imageStatus: "none" | "loading" | "shown" | "error" = "none";
  imageError = "";
  /** 巡回の間隔（秒）。0 なら止まっている */
  tourSeconds = 0;
  private tourTimer: number | null = null;
  private saved: SavedView | null = null;
  private readonly pins = new THREE.Group();
  private readonly images = new THREE.Group();
  private loadToken = 0;

  constructor(private readonly app: App) {
    this.pins.name = "scan-points";
    this.images.name = "scan-images";
    // 画像は切断を受けず、点群・モデルの上に重ねる（不透明度で透かす）
    this.images.renderOrder = -10;
    app.viewer.overlay.add(this.images, this.pins);
  }

  onOpen(m: Manifest) {
    this.list = scanStations(m);
    this.renderPins();
    this.app.emit("scans");
  }

  onClose() {
    this.stopTour();
    this.currentId = null;
    this.saved = null;
    this.app.viewer.setLookAround(false);
    this.clearImages();
    this.list = [];
    this.renderPins();
    this.app.emit("scans");
  }

  get current(): ScanStation | null {
    return this.list.find((s) => s.id === this.currentId) ?? null;
  }

  get placed(): ScanStation[] {
    return placedStations(this.list);
  }

  get imageCount(): number {
    return this.list.reduce((n, s) => n + s.images.length, 0);
  }

  /** 方位の補正（度）。画像の向きがずれるデータのために、プロジェクトごとにこの PC に覚える */
  get yawDeg(): number {
    const site = this.app.current?.site;
    return site ? Number(localStorage.getItem(`scanPoints:yaw:${site}`) ?? "0") || 0 : 0;
  }

  setYaw(deg: number) {
    const site = this.app.current?.site;
    if (!site) return;
    localStorage.setItem(`scanPoints:yaw:${site}`, String(((deg % 360) + 360) % 360));
    this.layoutImages();
    this.app.emit("scans");
  }

  setShowMarkers(on: boolean) {
    this.showMarkers = on;
    localStorage.setItem("scanPoints:markers", on ? "on" : "off");
    this.renderPins();
    this.app.emit("scans");
  }

  setShowImage(on: boolean) {
    this.showImage = on;
    localStorage.setItem("scanPoints:image", on ? "on" : "off");
    void this.loadImages();
    this.app.emit("scans");
  }

  setImageOpacity(v: number) {
    this.imageOpacity = clamp01(v);
    localStorage.setItem("scanPoints:opacity", String(this.imageOpacity));
    for (const o of this.images.children) if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).opacity = this.imageOpacity;
    this.images.visible = this.imageOpacity > 0;
    this.app.viewer.requestRender();
  }

  // ---- 移動 ----

  /** 撮影ポイントに立つ（その場で見回す操作になる）。位置不明なら何もしない */
  goTo(id: string) {
    const m = this.app.current;
    const st = this.list.find((s) => s.id === id);
    if (!m || !st?.position) return;
    const v = this.app.viewer;
    if (!this.saved) {
      this.saved = { position: v.camera.position.clone(), target: v.controls.target.clone(), fov: v.fov, projection: v.projection };
      // 見回すのは透視だけ（平行投影ではその場の向きが分からない）
      v.setProjection("perspective");
    }
    // 前の撮影ポイントで見ていた向きを引き継ぐ（巡るたびに向きが飛ばないように）
    const keep = this.currentId ? v.camera.getWorldDirection(new THREE.Vector3()) : null;
    this.currentId = id;
    v.setLookAround(true);
    v.standAt(worldToScene(m, st.position), keep ?? stationForward(st, this.yawDeg));
    this.renderPins();
    void this.loadImages();
    this.app.emit("scans");
  }

  /** 次・前の撮影ポイントへ（端まで行ったら反対の端へ戻る） */
  step(dir: 1 | -1) {
    const next = stepStation(this.list, this.currentId, dir);
    if (next) this.goTo(next.id);
  }

  /** クリックした所（シーン座標）にいちばん近い撮影ポイントへ */
  goNear(scenePoint: THREE.Vector3) {
    const m = this.app.current;
    if (!m) return;
    const o = m.origin;
    const st = nearestStation(this.list, [scenePoint.x + o[0], scenePoint.y + o[1], scenePoint.z + o[2]]);
    if (st) this.goTo(st.id);
  }

  /** 撮影ポイントから出て、入る前の視点に戻る */
  leave() {
    this.stopTour();
    if (!this.currentId && !this.saved) return;
    const v = this.app.viewer;
    this.currentId = null;
    v.setLookAround(false);
    this.clearImages();
    const s = this.saved;
    this.saved = null;
    if (s) {
      v.setProjection(s.projection);
      v.fov = s.fov;
      v.camera.position.copy(s.position);
      v.controls.target.copy(s.target);
      v.cameraMoved();
    }
    this.renderPins();
    this.app.emit("scans");
  }

  // ---- 巡回 ----

  /** seconds ごとに次の撮影ポイントへ（0 で止める） */
  startTour(seconds: number) {
    this.stopTour(false);
    if (seconds <= 0 || this.placed.length < 2) {
      this.app.emit("scans");
      return;
    }
    this.tourSeconds = seconds;
    if (!this.currentId) this.step(1);
    this.tourTimer = window.setInterval(() => this.step(1), seconds * 1000);
    this.app.emit("scans");
  }

  stopTour(notify = true) {
    if (this.tourTimer !== null) window.clearInterval(this.tourTimer);
    this.tourTimer = null;
    const was = this.tourSeconds;
    this.tourSeconds = 0;
    if (notify && was) this.app.emit("scans");
  }

  // ---- 目印 ----

  renderPins() {
    for (const c of [...this.pins.children]) {
      this.pins.remove(c);
      if (c instanceof CSS2DObject) c.element.remove();
    }
    const m = this.app.current;
    if (!m || !this.showMarkers) {
      this.app.viewer.requestRender();
      return;
    }
    for (const st of this.placed) {
      // 立っている撮影ポイントの目印はカメラと重なるので出さない
      if (st.id === this.currentId) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = `scan-pin${st.images.length ? " has-image" : ""}`;
      el.title = `${st.label}${st.images.length ? `（画像 ${st.images.length}）` : ""}\nクリックでこの撮影ポイントへ移動`;
      el.setAttribute("aria-label", `撮影ポイント ${st.label} へ移動`);
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.app.tool !== "scanPoints") this.app.setTool("scanPoints");
        this.goTo(st.id);
      });
      const obj = new CSS2DObject(el);
      obj.position.copy(worldToScene(m, st.position!));
      this.pins.add(obj);
    }
    this.app.viewer.requestRender();
  }

  // ---- 画像 ----

  private clearImages() {
    this.loadToken++;
    for (const o of [...this.images.children]) {
      this.images.remove(o);
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mat = o.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
    }
    this.imageStatus = "none";
    this.imageError = "";
    this.app.viewer.requestRender();
  }

  /** 立っている撮影ポイントの画像を読み、球（360 画像）・面（写真）に貼る */
  private async loadImages() {
    this.clearImages();
    const st = this.current;
    const m = this.app.current;
    if (!st || !m || !this.showImage || !st.images.length) {
      this.app.emit("scans");
      return;
    }
    const token = this.loadToken;
    this.imageStatus = "loading";
    this.app.emit("scans");
    try {
      const max = Math.min(this.app.viewer.renderer.capabilities.maxTextureSize, 8192);
      for (const si of st.images) {
        const tex = await loadTexture(si.rel, max);
        if (token !== this.loadToken) {
          tex.dispose();
          return;
        }
        const mesh = new THREE.Mesh(
          imageGeometry(si),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: this.imageOpacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
        );
        mesh.renderOrder = -10;
        mesh.userData.image = si;
        this.images.add(mesh);
      }
      this.layoutImages();
      this.images.visible = this.imageOpacity > 0;
      this.imageStatus = "shown";
    } catch (e) {
      if (token !== this.loadToken) return;
      this.imageStatus = "error";
      this.imageError = e instanceof Error ? e.message : String(e);
    }
    this.app.viewer.requestRender();
    this.app.emit("scans");
  }

  /** 画像の位置と向き（方位の補正を変えたときも呼ぶ） */
  private layoutImages() {
    const m = this.app.current;
    if (!m) return;
    const yaw = this.yawDeg;
    for (const o of this.images.children) {
      const si = o.userData.image as StationImage | undefined;
      if (!si) continue;
      o.position.copy(worldToScene(m, si.position));
      o.quaternion.copy(imageQuaternion(si.rotation, yaw));
    }
    this.app.viewer.requestRender();
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** 画像を読んでテクスチャにする。GPU の上限を超える大きさ（360 画像は 2 万画素幅もある）は縮める */
async function loadTexture(rel: string, maxSize: number): Promise<THREE.Texture> {
  const blob = new Blob([await fetchBytes(rel)]);
  const probe = await createImageBitmap(blob);
  const { width, height } = probe;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  let bmp = probe;
  if (scale < 1) {
    probe.close();
    bmp = await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.floor(width * scale)), resizeHeight: Math.max(1, Math.floor(height * scale)), resizeQuality: "high" });
  }
  const tex = new THREE.Texture(bmp);
  // ImageBitmap は上下を反転しない（UV の v=0 が画像の上端）
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 画像を貼る形（画像の姿勢での座標。原点が撮影位置） */
function imageGeometry(si: StationImage): THREE.BufferGeometry {
  const img = si.image;
  if (img.kind === "pinhole") {
    const [tl, tr, br, bl] = pinholeCorners(img, IMAGE_RADIUS);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...tl.toArray(), ...tr.toArray(), ...br.toArray(), ...bl.toArray()], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 3, 1, 1, 3, 2]);
    return g;
  }
  // 360 画像・円筒画像: 画像の範囲の角度に合わせた格子（全周なら横 96・縦 48）
  const spanU = Math.min(1, (img.width * img.pixelWidth) / (2 * Math.PI));
  const spanV = img.kind === "spherical" ? Math.min(1, (img.height * img.pixelHeight) / Math.PI) : 0.5;
  const nu = Math.max(8, Math.ceil(96 * spanU));
  const nv = Math.max(4, Math.ceil(48 * spanV));
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const v = j / nv;
      const d = panoramaDirection(img, u, v).multiplyScalar(IMAGE_RADIUS);
      pos.push(d.x, d.y, d.z);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
