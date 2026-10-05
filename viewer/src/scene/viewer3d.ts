import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

export type ViewKind = "iso" | "top" | "front" | "back" | "right" | "left";
/** 投影。perspective = 透視、orthographic = 平行（直交） */
export type Projection = "perspective" | "orthographic";

/**
 * Fragments（モデル）の LOD・カリング用のカメラ。姿勢と投影行列は表示中のカメラを写す。
 * Fragments 3.4.7 は OrthographicCamera を渡すと LOD の寸法が求まらない（画角が無く、
 * 平行投影の寸法も返さない）ため、常に透視カメラの型で渡す。Fragments は視錐台を求める前に
 * updateProjectionMatrix() を呼ぶので、そこで表示中のカメラの投影行列に差し替える。
 */
class LodCamera extends THREE.PerspectiveCamera {
  source: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;

  override updateProjectionMatrix() {
    super.updateProjectionMatrix();
    if (!this.source) return;
    this.projectionMatrix.copy(this.source.projectionMatrix);
    this.projectionMatrixInverse.copy(this.source.projectionMatrixInverse);
  }
}

/** 左ドラッグの回転 1 回分 */
interface OrbitDrag {
  pointerId: number;
  /** 直前のカーソル位置 */
  x: number;
  y: number;
  /** 回転の中心。カーソル下の取得（非同期）を待つ間は null で、その間の移動量は pending に溜める */
  pivot: THREE.Vector3 | null;
  pendingX: number;
  pendingY: number;
  released: boolean;
  cancelled: boolean;
}

/**
 * three.js の土台。点群とモデルを同じシーン・同じ深度バッファで描く。
 * 座標は Z 上・メートル。シーン座標＝世界座標 − データセットの原点オフセット（float32 の精度を保つため）。
 */
export class Viewer3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  /** 透視のカメラ。画角（fov）と縦横比はこちらが持ち、平行投影でも視野の大きさの基準にする */
  readonly perspCamera: THREE.PerspectiveCamera;
  /** 平行投影のカメラ。位置・向きは透視と同じ扱いで、視野の高さは注視点までの奥行きから決める */
  readonly orthoCamera: THREE.OrthographicCamera;
  /** Fragments に渡すカメラ（LodCamera の説明を参照） */
  readonly lodCamera = new LodCamera();
  readonly controls: OrbitControls;
  private _projection: Projection = "perspective";
  private readonly projectionListeners = new Set<(p: Projection) => void>();
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
    this.perspCamera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
    this.perspCamera.up.set(0, 0, 1);
    this.perspCamera.position.set(30, -30, 25);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 5000);
    this.orthoCamera.up.set(0, 0, 1);
    this.lodCamera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.perspCamera, this.renderer.domElement);
    this.controls.enableDamping = false;
    // ホイールは自前で処理する（カーソル下の物体までの距離に比例して寄る）。OrbitControls の
    // ズームは注視点までの距離で拡縮するため、注視点に近づくと寄れなくなる
    this.controls.enableZoom = false;
    // 回転も自前で処理する（カーソル下の物体を中心に回す）。OrbitControls は注視点（画面の中心）を
    // 中心にしか回せない。左ボタン＋Ctrl/Shift の移動は OrbitControls に残す
    this.controls.enableRotate = false;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    // 投影は描く前にも合わせるが、カメラが動いた直後の表示更新（Fragments・目印）に間に合うよう先に合わせる。
    // 先に登録するので、他の "change" の受け手より前に走る
    this.controls.addEventListener("change", () => {
      this.syncProjection();
      this.requestRender();
    });
    this.renderer.domElement.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // OrbitControls（構築時に登録済み）と切断箱の編集（capture で先に受けて controls を止める）の
    // 後に受ける。移動・離すは画面外へ出ても拾えるよう window で受ける
    this.renderer.domElement.addEventListener("pointerdown", (e) => this.onOrbitDown(e));
    window.addEventListener("pointermove", (e) => this.onOrbitMove(e));
    window.addEventListener("pointerup", (e) => this.onOrbitUp(e));
    window.addEventListener("pointercancel", (e) => this.onOrbitUp(e));

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

  /** 表示中のカメラ（投影で切り替わる）。位置・向きを変えたら cameraMoved() を呼ぶ */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this._projection === "orthographic" ? this.orthoCamera : this.perspCamera;
  }

  get projection(): Projection {
    return this._projection;
  }

  /** 縦の画角（度）。平行投影では、注視点の奥行きで透視と同じ大きさに見える視野の高さを決める */
  get fov(): number {
    return this.perspCamera.fov;
  }

  set fov(v: number) {
    if (!(v > 0 && v < 180)) return;
    this.perspCamera.fov = v;
    this.syncProjection();
    this.requestRender();
  }

  /** 画面の縦横比（幅 / 高さ） */
  get aspect(): number {
    return this.perspCamera.aspect;
  }

  onProjectionChange(cb: (p: Projection) => void): () => void {
    this.projectionListeners.add(cb);
    return () => this.projectionListeners.delete(cb);
  }

  /**
   * 透視・平行投影を切り替える。位置・向き・注視点はそのまま引き継ぎ、平行投影の視野の高さは
   * 注視点の奥行きで透視と同じ大きさに見えるように決める（切り替えても注視点付近の見え方が変わらない）。
   * 回転・移動・ホイールは同じ操作で動く（ホイールはカメラを寄せ、視野も奥行きに合わせて狭まる）。
   */
  setProjection(p: Projection) {
    if (p === this._projection) return;
    const from = this.camera;
    this._projection = p;
    const to = this.camera;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.updateMatrixWorld();
    this.controls.object = to;
    this.cancelOrbit();
    this.zoomPivot = null;
    this.cameraMoved();
    for (const cb of this.projectionListeners) cb(p);
  }

  /**
   * 平行投影の視野の半分の高さ（シーン座標の m）。透視のときは undefined。
   * Fragments の LOD に渡す（Fragments は透視のときの「距離 × tan(画角/2)」と同じ意味で使う）。
   */
  orthoHalfHeight(): number | undefined {
    if (this._projection !== "orthographic") return undefined;
    const o = this.orthoCamera;
    return (o.top - o.bottom) / (2 * o.zoom);
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
    this.perspCamera.aspect = width / height;
    this.syncProjection();
    this.requestRender();
  }

  /**
   * 表示中のカメラの投影を合わせる。近・遠クリップ面は注視点までの距離に合わせる（深度の精度を保つ）。
   * 平行投影の視野の高さは、注視点の奥行きで透視と同じ大きさに見えるようにする。
   * Fragments 用のカメラ（lodCamera）へ姿勢と投影を写す。
   */
  private syncProjection() {
    const cam = this.camera;
    const d = cam.position.distanceTo(this.controls.target);
    cam.near = THREE.MathUtils.clamp(d / 2000, 0.005, 1);
    cam.far = Math.max(2000, d * 50);
    if (cam instanceof THREE.OrthographicCamera) {
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const depth = Math.max(this.controls.target.clone().sub(cam.position).dot(fwd), 1e-3);
      const half = depth * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2));
      cam.top = half;
      cam.bottom = -half;
      cam.left = -half * this.perspCamera.aspect;
      cam.right = half * this.perspCamera.aspect;
      cam.zoom = 1;
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const lod = this.lodCamera;
    lod.source = cam;
    lod.fov = this.perspCamera.fov;
    lod.aspect = this.perspCamera.aspect;
    lod.near = cam.near;
    lod.far = cam.far;
    lod.position.copy(cam.position);
    lod.quaternion.copy(cam.quaternion);
    lod.updateProjectionMatrix();
    lod.updateMatrixWorld();
  }

  private tick() {
    // 点群の LOD（beforeRender）が新しい投影で選べるよう先に合わせる
    this.syncProjection();
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
    this.syncProjection();
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

  /**
   * カーソル下の物体（点群・モデル）の位置（シーン座標）を返す。ホイールで寄る先と回転の中心に使う。
   * 未設定または何も無いときは、寄る先は注視点と同じ奥行きの位置、回転の中心は注視点（画面の中心）。
   */
  pickPoint: ((clientX: number, clientY: number) => Promise<THREE.Vector3 | null>) | null = null;

  // ---- 左ドラッグでの回転 ----

  /** 回転の操作中。中心はカーソル下の取得（非同期）を待つ間 null で、その間の移動量は溜めておく */
  private orbit: OrbitDrag | null = null;
  /** 画面に触れている指（2 本目が来たら回転をやめて OrbitControls の移動に任せる） */
  private readonly touches = new Set<number>();

  private onOrbitDown(e: PointerEvent) {
    if (e.pointerType === "touch") {
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) {
        this.cancelOrbit();
        return;
      }
    }
    if (!this.controls.enabled || e.button !== 0 || this.orbit) return;
    // 左ボタン＋Ctrl/Shift は OrbitControls が移動として扱う（タッチは修飾キーを見ない）
    if (e.pointerType !== "touch" && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const orbit: OrbitDrag = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      pivot: null,
      pendingX: 0,
      pendingY: 0,
      released: false,
      cancelled: false,
    };
    this.orbit = orbit;
    void this.resolveOrbitPivot(orbit, e.clientX, e.clientY);
  }

  /** 押した位置の物体を回転の中心にする。何も無ければ注視点（画面の中心） */
  private async resolveOrbitPivot(orbit: OrbitDrag, clientX: number, clientY: number) {
    const hit = this.pickPoint ? await this.pickPoint(clientX, clientY).catch(() => null) : null;
    if (orbit.cancelled) return;
    orbit.pivot = hit ?? this.controls.target.clone();
    if (orbit.pendingX === 0 && orbit.pendingY === 0) return;
    this.rotateAround(orbit.pivot, orbit.pendingX, orbit.pendingY);
    orbit.pendingX = orbit.pendingY = 0;
    // 取得を待つ間に離していたら、OrbitControls の "end" は回す前に出ている。出し直して LOD を更新させる
    if (orbit.released) this.controls.dispatchEvent({ type: "end" });
  }

  private onOrbitMove(e: PointerEvent) {
    const o = this.orbit;
    if (!o || e.pointerId !== o.pointerId) return;
    if (!this.controls.enabled) {
      this.cancelOrbit();
      return;
    }
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;
    o.x = e.clientX;
    o.y = e.clientY;
    if (dx === 0 && dy === 0) return;
    if (o.pivot) {
      this.rotateAround(o.pivot, dx, dy);
    } else {
      o.pendingX += dx;
      o.pendingY += dy;
    }
  }

  private onOrbitUp(e: PointerEvent) {
    if (e.pointerType === "touch") this.touches.delete(e.pointerId);
    const o = this.orbit;
    if (!o || e.pointerId !== o.pointerId) return;
    this.orbit = null;
    o.released = true;
  }

  private cancelOrbit() {
    if (!this.orbit) return;
    this.orbit.cancelled = true;
    this.orbit = null;
  }

  /**
   * pivot を中心にカメラを回す（Z 上のターンテーブル）。横の移動は Z 軸まわり、縦の移動は
   * カメラの右方向の軸まわり。量と向きは OrbitControls と同じ（画面の高さ分で 1 周、物体が
   * カーソルに付いて動く向き）。真上・真下を越えないよう縦の角度は止める。
   * 注視点は視線上の pivot と同じ奥行きへ置き直す（移動の速さと近クリップ面を物体に合わせる）。
   */
  private rotateAround(pivot: THREE.Vector3, dx: number, dy: number) {
    const cam = this.camera;
    const h = this.canvas.clientHeight || 1;
    const k = (2 * Math.PI * this.controls.rotateSpeed) / h;
    const azimuth = -dx * k;
    // 視線の逆向き（カメラ側）と +Z のなす角。0 で真上から見下ろす
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const polar = Math.acos(THREE.MathUtils.clamp(-fwd.z, -1, 1));
    const eps = 1e-5;
    const nextPolar = THREE.MathUtils.clamp(polar - dy * k, Math.min(eps, polar), Math.max(Math.PI - eps, polar));
    const elevation = nextPolar - polar;

    const qAz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), azimuth);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).applyQuaternion(qAz);
    right.z = 0; // ロールは無いので水平のはず。誤差を落とす
    if (right.lengthSq() < 1e-12) return;
    const qEl = new THREE.Quaternion().setFromAxisAngle(right.normalize(), elevation);
    const q = qEl.multiply(qAz); // 先に Z 軸まわり、次に右方向の軸まわり

    cam.position.sub(pivot).applyQuaternion(q).add(pivot);
    cam.quaternion.premultiply(q);
    const fwd2 = cam.getWorldDirection(new THREE.Vector3());
    const depth = Math.max(pivot.clone().sub(cam.position).dot(fwd2), 0.02);
    this.controls.target.copy(cam.position).addScaledVector(fwd2, depth);
    this.controls.update(); // "change" が出て、描き直しとモデルの LOD 更新が走る
    this.requestRender();
  }

  // ---- ホイールでの拡大縮小 ----
  /** ホイール 1 目盛りで、寄る先までの距離に掛ける比率（0.8 = 2 割寄る） */
  zoomRatio = 0.8;

  /** 寄る先のキャッシュ。カーソルとカメラが動かない間は同じ点へ寄り続ける */
  private zoomPivot: { point: THREE.Vector3; x: number; y: number; time: number; camPos: THREE.Vector3; camQuat: THREE.Quaternion } | null = null;
  private zoomSteps = 0;
  private zoomCursor = { x: 0, y: 0 };
  private zoomBusy = false;

  private onWheel(e: WheelEvent) {
    if (!this.controls.enabled) return;
    e.preventDefault();
    // 1 目盛りを 1 に揃える（ピクセル単位は 100、行単位は 3 が 1 目盛り）。タッチパッドは小数になる
    const unit = e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1;
    // 奥へ回す（deltaY < 0）と寄る、手前へ回すと離れる
    const steps = THREE.MathUtils.clamp(-e.deltaY / unit, -5, 5);
    if (steps === 0) return;
    this.zoomSteps += steps;
    this.zoomCursor = { x: e.clientX, y: e.clientY };
    void this.flushZoom();
  }

  /** 溜まったホイール量を処理する。カーソル下の取得（非同期）を待つ間の回転は合算する */
  private async flushZoom() {
    if (this.zoomBusy) return;
    this.zoomBusy = true;
    try {
      while (this.zoomSteps !== 0) {
        const { x, y } = this.zoomCursor;
        let pivot = this.validZoomPivot(x, y);
        if (!pivot) {
          const hit = this.pickPoint ? await this.pickPoint(x, y).catch(() => null) : null;
          pivot = {
            point: hit ?? this.fallbackZoomPoint(x, y),
            x,
            y,
            time: 0,
            camPos: new THREE.Vector3(),
            camQuat: new THREE.Quaternion(),
          };
          this.zoomPivot = pivot;
        }
        const steps = this.zoomSteps;
        this.zoomSteps = 0;
        this.dollyToward(pivot.point, steps);
        pivot.time = performance.now();
        pivot.camPos.copy(this.camera.position);
        pivot.camQuat.copy(this.camera.quaternion);
      }
    } finally {
      this.zoomBusy = false;
    }
  }

  /**
   * キャッシュした寄る先がまだ使えるか。カメラを寄る先へ向けて真っ直ぐ動かすので、
   * カーソルが動かなければ寄る先は同じ画素に留まる。回転・移動・表示の変化に備えて、
   * カメラが他の操作で動いたときと少し間が空いたときは取り直す。
   */
  private validZoomPivot(x: number, y: number) {
    const p = this.zoomPivot;
    if (!p) return null;
    if (Math.abs(p.x - x) > 2 || Math.abs(p.y - y) > 2) return null;
    if (performance.now() - p.time > 800) return null;
    const dist = this.camera.position.distanceTo(p.point);
    if (this.camera.position.distanceTo(p.camPos) > dist * 1e-6 + 1e-9) return null;
    if (Math.abs(this.camera.quaternion.dot(p.camQuat)) < 1 - 1e-9) return null;
    return p;
  }

  /** カーソル下に何も無いとき: カーソル方向の線上で、注視点と同じ奥行きの位置 */
  private fallbackZoomPoint(clientX: number, clientY: number): THREE.Vector3 {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const depth = Math.max(this.controls.target.clone().sub(this.camera.position).dot(fwd), 0.5);
    const cos = Math.max(ray.ray.direction.dot(fwd), 1e-3);
    return ray.ray.origin.clone().addScaledVector(ray.ray.direction, depth / cos);
  }

  /**
   * 寄る先（point）へ向けてカメラを真っ直ぐ動かす。距離は 1 目盛りごとに zoomRatio 倍
   * （遠い物体ほど大きく、近い物体ほど小さく動く）。向きは変えない。
   * 注視点は視線上の寄る先と同じ奥行きへ置き直す（回転の中心と近クリップ面を物体に合わせる）。
   */
  private dollyToward(point: THREE.Vector3, steps: number) {
    const cam = this.camera.position;
    const toPoint = point.clone().sub(cam);
    const dist = toPoint.length();
    if (dist < 1e-9) return;
    const next = THREE.MathUtils.clamp(dist * Math.pow(this.zoomRatio, steps), 0.02, 20000);
    cam.addScaledVector(toPoint.divideScalar(dist), dist - next);
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const depth = Math.max(point.clone().sub(cam).dot(fwd), 0.02);
    this.controls.target.copy(cam).addScaledVector(fwd, depth);
    this.controls.update();
    this.syncProjection();
    // マウス操作の終了と同じく "end" を出して、モデルの LOD・カリングを更新させる
    this.controls.dispatchEvent({ type: "end" });
    this.requestRender();
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
    // 平行投影も注視点（中心）の奥行きで透視と同じ視野になるので、同じ距離で収まる
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.fov / 2));
    const dir = direction.clone().normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist * 0.9);
    this.cameraMoved();
  }

  /**
   * プログラムからカメラを動かした後に呼ぶ。マウス操作の終了と同じ "end" を出して、
   * モデル（Fragments）の LOD・カリングを新しい視点で強制更新させる。
   * これが無いと、開いた直後や視点ボタンの後に古い視点のまま表示が欠ける。
   */
  cameraMoved() {
    this.controls.update();
    // update() は動きが小さいと "change" を出さないので、ここでも投影を合わせる
    this.syncProjection();
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
