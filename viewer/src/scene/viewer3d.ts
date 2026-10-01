import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

export type ViewKind = "iso" | "top" | "front" | "back" | "right" | "left";

/**
 * three.js の土台。点群とモデルを同じシーン・同じ深度バッファで描く。
 * 座標は Z 上・メートル。シーン座標＝世界座標 − データセットの原点オフセット（float32 の精度を保つため）。
 */
export class Viewer3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly content = new THREE.Group(); // 点群・モデル
  /** 計測線・指摘の印など。切断の影響を受けないよう別シーンで後から描く */
  readonly overlay = new THREE.Scene();
  private dirty = true;
  private readonly beforeRender = new Set<() => void>();
  private readonly afterRender = new Set<() => void>();
  private frames = 0;
  private fpsTime = performance.now();
  fps = 0;
  continuous = false;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x20242b);
    this.renderer.localClippingEnabled = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add("gl");

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.classList.add("labels");
    container.appendChild(this.labelRenderer.domElement);

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(30, -30, 25);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("change", () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(sun);
    this.scene.add(this.content);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    requestAnimationFrame(loop);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get size(): { width: number; height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  requestRender() {
    this.dirty = true;
  }

  onBeforeRender(cb: () => void): () => void {
    this.beforeRender.add(cb);
    return () => this.beforeRender.delete(cb);
  }

  onAfterRender(cb: () => void): () => void {
    this.afterRender.add(cb);
    return () => this.afterRender.delete(cb);
  }

  private resize() {
    const { width, height } = this.size;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** 近・遠クリップ面を注視点までの距離に合わせる（深度の精度を保つ） */
  private updateClipRange() {
    const d = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = THREE.MathUtils.clamp(d / 2000, 0.005, 1);
    this.camera.far = Math.max(2000, d * 50);
    this.camera.updateProjectionMatrix();
  }

  private tick() {
    for (const cb of this.beforeRender) cb();
    if (!this.dirty && !this.continuous) return;
    this.dirty = false;
    this.render();
  }

  /** 今すぐ描く（スクリーンショットの直前など） */
  /** 直近 1 フレームの描画にかかった時間（ms）。必要なときだけ描くので fps より実態に近い */
  frameMs = 0;

  render() {
    const t0 = performance.now();
    this.updateClipRange();
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    // 重ね描き（切断なし・深度は消して常に手前に）
    const planes = this.renderer.clippingPlanes;
    this.renderer.clippingPlanes = [];
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.camera);
    this.renderer.clippingPlanes = planes;
    this.renderer.autoClear = true;
    this.labelRenderer.render(this.overlay, this.camera);
    for (const cb of this.afterRender) cb();
    this.frameMs = performance.now() - t0;
    this.frames++;
    const now = performance.now();
    if (now - this.fpsTime > 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsTime);
      this.frames = 0;
      this.fpsTime = now;
    }
  }

  /** 画面上の位置（client 座標）を NDC へ */
  toNdc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  /** 範囲全体が見えるようにカメラを置く */
  fit(box: THREE.Box3, direction = new THREE.Vector3(1, -1, 0.8)) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = direction.clone().normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist * 0.9);
    this.camera.updateProjectionMatrix();
    this.cameraMoved();
  }

  /**
   * プログラムからカメラを動かした後に呼ぶ。マウス操作の終了と同じ "end" を出して、
   * モデル（Fragments）の LOD・カリングを新しい視点で強制更新させる。
   * これが無いと、開いた直後や視点ボタンの後に古い視点のまま表示が欠ける。
   */
  cameraMoved() {
    this.controls.update();
    this.controls.dispatchEvent({ type: "end" });
    this.requestRender();
  }

  /**
   * 視点ボタン。「前・右」は既定の斜め視点（全体）から見たときの向き。
   * 全体はカメラが +X・−Y 側にあるので、見えている手前の面が −Y 側（前）、右の面が +X 側（右）。
   */
  setView(kind: ViewKind, box: THREE.Box3) {
    const dirs: Record<ViewKind, THREE.Vector3> = {
      iso: new THREE.Vector3(1, -1, 0.8),
      top: new THREE.Vector3(0, -0.0001, 1),
      front: new THREE.Vector3(0, -1, 0.0001),
      back: new THREE.Vector3(0, 1, 0.0001),
      right: new THREE.Vector3(1, 0, 0.0001),
      left: new THREE.Vector3(-1, 0, 0.0001),
    };
    this.fit(box, dirs[kind]);
  }

  /** 画面の画像（PNG）。直前に描き直してから読む */
  screenshot(): Promise<Blob> {
    this.render();
    return new Promise((resolve, reject) =>
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れません"))), "image/png"),
    );
  }
}
