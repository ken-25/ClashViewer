import * as THREE from "three";
import { dataUrl, fetchRange } from "../host";
import type { DecodeRequest, DecodeResponse } from "./decoder.worker";
import DecoderWorker from "./decoder.worker?worker";
import { ColorMode, PointCloudMaterial, SizeMode, VN_TEX_WIDTH } from "./material";
import type { CloudSample } from "../scene/snap";

// Potree 2.0 形式（metadata.json / hierarchy.bin / octree.bin）の読込と LOD 選択。
// 形式の読み方は Potree（BSD-2-Clause, Markus Schütz）の OctreeLoader.js を参考にした。

export interface PotreeAttribute {
  name: string;
  size: number;
  numElements: number;
  elementSize: number;
  type: string;
  min: number[];
  max: number[];
}

export interface PotreeMetadata {
  version: string;
  points: number;
  hierarchy: { firstChunkSize: number; stepSize: number; depth: number };
  offset: [number, number, number];
  scale: [number, number, number];
  spacing: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  encoding: string;
  attributes: PotreeAttribute[];
}

const enum NodeType {
  Normal = 0,
  Leaf = 1,
  Proxy = 2,
}

const BYTES_PER_NODE = 22;

export class PCNode {
  children: (PCNode | undefined)[] = new Array(8);
  parent: PCNode | null = null;
  nodeType: NodeType = NodeType.Normal;
  numPoints = 0;
  byteOffset = 0;
  byteSize = 0;
  hierarchyByteOffset = 0;
  hierarchyByteSize = 0;
  points: THREE.Points | null = null;
  loading = false;
  failed = false;
  lastVisibleFrame = -1;
  readonly sphere: THREE.Sphere;

  constructor(
    readonly name: string,
    readonly level: number,
    readonly box: THREE.Box3, // 表示座標（世界座標 − 原点）
    readonly worldMin: [number, number, number],
  ) {
    this.sphere = box.getBoundingSphere(new THREE.Sphere());
  }

  get loaded(): boolean {
    return this.points !== null;
  }
}

export interface PointCloudOptions {
  pointBudget: number;
  maxLoadedPoints: number;
  minNodePixelSize: number;
  maxConcurrentLoads: number;
}

export interface PointPick {
  point: THREE.Vector3; // 表示座標
  distance: number;
  node: string;
}

/** 点群 1 つ分。group を scene に足し、毎フレーム update(camera) を呼ぶ。 */
export class PotreePointCloud {
  readonly group = new THREE.Group();
  readonly material = new PointCloudMaterial();
  readonly root: PCNode;
  readonly octreeUrl: string;
  readonly hierarchyUrl: string;
  readonly boxDisplay: THREE.Box3; // 実データの範囲（表示座標）
  readonly options: PointCloudOptions;
  visiblePoints = 0;
  visibleNodes: PCNode[] = [];
  loadedPoints = 0;
  frame = 0;
  private readonly loaded = new Set<PCNode>();
  private readonly workers: Worker[] = [];
  private readonly callbacks = new Map<number, (r: DecodeResponse) => void>();
  private nextReq = 1;
  private nextWorker = 0;
  private activeLoads = 0;
  private readonly layout: {
    bytesPerPoint: number;
    positionOffset: number;
    rgbOffset: number;
    rgbShift: number;
    intensityOffset: number;
  };
  private needsUpdate = true;
  private readonly lastCam = new THREE.Matrix4();
  private readonly tmpFrustum = new THREE.Frustum();
  private readonly tmpMat = new THREE.Matrix4();
  clipBox: THREE.Box3 | null = null; // 表示座標。外側のノードは読まない
  onChange: (() => void) | null = null;

  static async load(dir: string, origin: number[], options: Partial<PointCloudOptions> = {}): Promise<PotreePointCloud> {
    const r = await fetch(dataUrl(`${dir}/metadata.json`), { cache: "no-cache" });
    if (!r.ok) throw new Error(`点群の metadata.json を読めません（${r.status}）`);
    const meta = (await r.json()) as PotreeMetadata;
    if (!meta.version?.startsWith("2.")) throw new Error(`Potree ${meta.version} 形式には対応していません`);
    if (meta.encoding !== "UNCOMPRESSED" && meta.encoding !== "DEFAULT")
      throw new Error(`点群の圧縮形式 ${meta.encoding} には対応していません（圧縮なしで変換してください）`);
    const pc = new PotreePointCloud(dir, meta, origin, options);
    await pc.loadHierarchy(pc.root);
    return pc;
  }

  private constructor(
    readonly dir: string,
    readonly meta: PotreeMetadata,
    readonly origin: number[],
    options: Partial<PointCloudOptions>,
  ) {
    this.options = {
      pointBudget: 3_000_000,
      maxLoadedPoints: 8_000_000,
      minNodePixelSize: 100,
      maxConcurrentLoads: 6,
      ...options,
    };
    this.octreeUrl = new URL(dataUrl(`${dir}/octree.bin`), location.href).href;
    this.hierarchyUrl = new URL(dataUrl(`${dir}/hierarchy.bin`), location.href).href;
    const min = meta.boundingBox.min;
    const max = meta.boundingBox.max;
    const box = new THREE.Box3(
      new THREE.Vector3(min[0] - origin[0], min[1] - origin[1], min[2] - origin[2]),
      new THREE.Vector3(max[0] - origin[0], max[1] - origin[1], max[2] - origin[2]),
    );
    this.root = new PCNode("r", 0, box, [min[0], min[1], min[2]]);
    this.root.nodeType = NodeType.Proxy;
    this.root.hierarchyByteOffset = 0;
    this.root.hierarchyByteSize = meta.hierarchy.firstChunkSize;

    const pos = meta.attributes.find((a) => a.name === "position");
    this.boxDisplay = pos
      ? new THREE.Box3(
          new THREE.Vector3(pos.min[0] - origin[0], pos.min[1] - origin[1], pos.min[2] - origin[2]),
          new THREE.Vector3(pos.max[0] - origin[0], pos.max[1] - origin[1], pos.max[2] - origin[2]),
        )
      : box.clone();

    let off = 0;
    const offsets = new Map<string, number>();
    for (const a of meta.attributes) {
      offsets.set(a.name, off);
      off += a.size;
    }
    const rgb = meta.attributes.find((a) => a.name === "rgb" || a.name === "rgba");
    const inten = meta.attributes.find((a) => a.name === "intensity");
    this.layout = {
      bytesPerPoint: off,
      positionOffset: offsets.get("position") ?? 0,
      rgbOffset: rgb ? offsets.get(rgb.name)! : -1,
      rgbShift: rgb && Math.max(...rgb.max) > 255 ? 8 : 0,
      intensityOffset: inten ? offsets.get("intensity")! : -1,
    };

    const u = this.material.uniforms;
    u.uOctreeSize.value = box.max.x - box.min.x;
    u.uOctreeSpacing.value = meta.spacing;
    u.uHasRgb.value = !!rgb;
    u.uHasIntensity.value = !!inten;
    u.uHeightRange.value.set(this.boxDisplay.min.z, this.boxDisplay.max.z);
    if (inten) {
      // 強度は 0..65535 に正規化して保存している
      const lo = inten.min[0] / 65535;
      const hi = inten.max[0] / 65535;
      u.uIntensityRange.value.set(lo, hi > lo ? hi : lo + 1e-3);
    }
    if (!rgb) u.uColorMode.value = ColorMode.Height;

    const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new DecoderWorker();
      w.onmessage = (e: MessageEvent<DecodeResponse>) => {
        const cb = this.callbacks.get(e.data.id);
        this.callbacks.delete(e.data.id);
        cb?.(e.data);
      };
      this.workers.push(w);
    }
    this.group.name = "pointcloud";
  }

  get pointCount(): number {
    return this.meta.points;
  }

  setColorMode(m: ColorMode) {
    this.material.uniforms.uColorMode.value = m;
  }
  setPointSize(size: number) {
    this.material.uniforms.uSize.value = size;
  }
  setSizeMode(m: SizeMode) {
    this.material.uniforms.uSizeMode.value = m;
  }
  setBudget(points: number) {
    this.options.pointBudget = points;
    this.options.maxLoadedPoints = Math.max(points * 2.5, 2_000_000);
    this.needsUpdate = true;
  }
  invalidate() {
    this.needsUpdate = true;
  }

  // ---- 階層 ----

  private async loadHierarchy(node: PCNode): Promise<void> {
    const buf = await fetchRange(this.hierarchyUrl, node.hierarchyByteOffset, node.hierarchyByteOffset + node.hierarchyByteSize);
    const view = new DataView(buf);
    const numNodes = buf.byteLength / BYTES_PER_NODE;
    const nodes: PCNode[] = [node];
    for (let i = 0; i < numNodes && i < nodes.length; i++) {
      const cur = nodes[i];
      const o = i * BYTES_PER_NODE;
      const type = view.getUint8(o);
      const childMask = view.getUint8(o + 1);
      const numPoints = view.getUint32(o + 2, true);
      const byteOffset = Number(view.getBigInt64(o + 6, true));
      const byteSize = Number(view.getBigInt64(o + 14, true));
      if (cur.nodeType === NodeType.Proxy) {
        // 子チャンクの先頭は自分自身。中身で置き換える
        cur.byteOffset = byteOffset;
        cur.byteSize = byteSize;
        cur.numPoints = numPoints;
      } else if (type === NodeType.Proxy) {
        cur.hierarchyByteOffset = byteOffset;
        cur.hierarchyByteSize = byteSize;
        cur.numPoints = numPoints;
      } else {
        cur.byteOffset = byteOffset;
        cur.byteSize = byteSize;
        cur.numPoints = numPoints;
      }
      cur.nodeType = type as NodeType;
      if (cur.nodeType === NodeType.Proxy) continue;
      for (let ci = 0; ci < 8; ci++) {
        if ((childMask & (1 << ci)) === 0) continue;
        const child = this.createChild(cur, ci);
        cur.children[ci] = child;
        nodes.push(child);
      }
    }
  }

  private createChild(parent: PCNode, index: number): PCNode {
    const b = parent.box;
    const size = b.max.clone().sub(b.min);
    const min = b.min.clone();
    const max = b.max.clone();
    const wmin = [...parent.worldMin] as [number, number, number];
    // 子の番号: bit2=x, bit1=y, bit0=z
    if (index & 0b100) {
      min.x += size.x / 2;
      wmin[0] += size.x / 2;
    } else max.x -= size.x / 2;
    if (index & 0b010) {
      min.y += size.y / 2;
      wmin[1] += size.y / 2;
    } else max.y -= size.y / 2;
    if (index & 0b001) {
      min.z += size.z / 2;
      wmin[2] += size.z / 2;
    } else max.z -= size.z / 2;
    const c = new PCNode(parent.name + index, parent.level + 1, new THREE.Box3(min, max), wmin);
    c.parent = parent;
    return c;
  }

  // ---- 読込 ----

  private async loadNode(node: PCNode): Promise<void> {
    if (node.loading || node.loaded || node.failed) return;
    node.loading = true;
    this.activeLoads++;
    try {
      if (node.nodeType === NodeType.Proxy) await this.loadHierarchy(node);
      if (node.numPoints === 0 || node.byteSize === 0) {
        // 点の無いノード（子だけを持つ）は空の Points を置いて読込済みにする
        this.attach(node, new Float32Array(0), null, null);
        return;
      }
      const req: DecodeRequest = {
        id: this.nextReq++,
        url: this.octreeUrl,
        byteOffset: node.byteOffset,
        byteSize: node.byteSize,
        numPoints: node.numPoints,
        ...this.layout,
        scale: this.meta.scale,
        offset: this.meta.offset,
        nodeMin: node.worldMin,
      };
      const res = await new Promise<DecodeResponse>((resolve) => {
        this.callbacks.set(req.id, resolve);
        const w = this.workers[this.nextWorker++ % this.workers.length];
        w.postMessage(req);
      });
      if (res.error) throw new Error(res.error);
      this.attach(node, res.position, res.color, res.intensity);
    } catch (e) {
      node.failed = true;
      console.warn(`点群ノード ${node.name} を読めません`, e);
    } finally {
      node.loading = false;
      this.activeLoads--;
      this.needsUpdate = true;
      this.onChange?.();
    }
  }

  private attach(node: PCNode, position: Float32Array, color: Uint8Array | null, intensity: Uint16Array | null) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(position, 3));
    if (color) g.setAttribute("rgba", new THREE.BufferAttribute(color, 4, true));
    if (intensity) g.setAttribute("intensity", new THREE.BufferAttribute(intensity, 1, true));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), node.box.max.clone().sub(node.box.min));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const pts = new THREE.Points(g, this.material);
    pts.name = node.name;
    pts.position.copy(node.box.min);
    pts.matrixAutoUpdate = false;
    pts.updateMatrix();
    pts.frustumCulled = false;
    pts.visible = false;
    pts.userData.node = node;
    pts.onBeforeRender = () => {
      const u = this.material.uniforms;
      u.uLevel.value = node.level;
      u.uVNStart.value = (pts.userData.vnStart as number) ?? 0;
      this.material.uniformsNeedUpdate = true;
    };
    node.points = pts;
    this.group.add(pts);
    this.loaded.add(node);
    this.loadedPoints += position.length / 3;
  }

  private unload(node: PCNode) {
    if (!node.points) return;
    this.group.remove(node.points);
    node.points.geometry.dispose();
    this.loadedPoints -= node.points.geometry.getAttribute("position").count;
    node.points = null;
    this.loaded.delete(node);
  }

  // ---- LOD 選択 ----

  /** 毎フレーム呼ぶ。カメラが動いたか読込が進んだときだけ選び直す。 */
  update(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, screenHeight: number): void {
    this.material.uniforms.uScreenHeight.value = screenHeight;
    camera.updateMatrixWorld();
    const camMat = this.tmpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.needsUpdate && camMat.equals(this.lastCam)) return;
    this.lastCam.copy(camMat);
    this.needsUpdate = false;
    this.frame++;

    const frustum = this.tmpFrustum.setFromProjectionMatrix(camMat);
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const isPersp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    const fov = isPersp ? THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) : 0;
    const ortho = camera as THREE.OrthographicCamera;
    const orthoHeight = isPersp ? 1 : (ortho.top - ortho.bottom) / ortho.zoom;
    const { pointBudget, minNodePixelSize } = this.options;

    // 重み（画面上の半径）の大きい順に辿る
    const heap = new MaxHeap<PCNode>();
    const weight = (n: PCNode): number => {
      if (!isPersp) return (n.sphere.radius * screenHeight) / orthoHeight;
      const d = camPos.distanceTo(n.sphere.center);
      if (d - n.sphere.radius < 0) return Number.MAX_VALUE;
      return (n.sphere.radius * 0.5 * screenHeight) / (Math.tan(fov / 2) * d);
    };
    heap.push(this.root, Number.MAX_VALUE);
    const visible: PCNode[] = [];
    const toLoad: { n: PCNode; w: number }[] = [];
    let points = 0;
    while (heap.size > 0) {
      const { item: node, weight: w } = heap.pop()!;
      if (!frustum.intersectsBox(node.box)) continue;
      if (this.clipBox && !this.clipBox.intersectsBox(node.box)) continue;
      if (points + node.numPoints > pointBudget && visible.length > 0) break;
      if (!node.loaded) {
        if (!node.failed) toLoad.push({ n: node, w });
        continue;
      }
      visible.push(node);
      points += node.numPoints;
      node.lastVisibleFrame = this.frame;
      for (const c of node.children) {
        if (!c) continue;
        const cw = weight(c);
        if (cw < minNodePixelSize) continue;
        heap.push(c, cw);
      }
    }

    for (const n of this.loaded) n.points!.visible = false;
    for (const n of visible) n.points!.visible = true;
    this.visibleNodes = visible;
    this.visiblePoints = points;
    this.updateVisibilityTexture(visible);

    // 重い順に読み始める
    toLoad.sort((a, b) => b.w - a.w);
    for (const { n } of toLoad) {
      if (this.activeLoads >= this.options.maxConcurrentLoads) break;
      void this.loadNode(n);
    }
    if (toLoad.length > 0) this.needsUpdate = true;
    this.evict();
  }

  get isLoading(): boolean {
    return this.activeLoads > 0;
  }

  /** 古い（長く表示していない）ノードからメモリを空ける */
  private evict() {
    if (this.loadedPoints <= this.options.maxLoadedPoints) return;
    const candidates = [...this.loaded].filter((n) => n.lastVisibleFrame !== this.frame && n !== this.root);
    candidates.sort((a, b) => a.lastVisibleFrame - b.lastVisibleFrame || b.level - a.level);
    for (const n of candidates) {
      if (this.loadedPoints <= this.options.maxLoadedPoints) break;
      // 子が読込済みの親を先に消すと LOD が崩れるので、子孫が読込済みでないものだけ消す
      if (n.children.some((c) => c?.loaded)) continue;
      this.unload(n);
    }
  }

  /** 表示中ノードの子の有無をテクスチャに詰める（点の大きさの自動調整に使う） */
  private updateVisibilityTexture(visible: PCNode[]) {
    const sorted = [...visible].sort((a, b) => a.level - b.level || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const tex = this.material.visibleNodesTexture;
    const data = tex.image.data as Uint8Array;
    const max = Math.min(sorted.length, VN_TEX_WIDTH * 4);
    const index = new Map<PCNode, number>();
    for (let i = 0; i < max; i++) index.set(sorted[i], i);
    for (let i = 0; i < max; i++) {
      const n = sorted[i];
      let mask = 0;
      let first = -1;
      for (let c = 0; c < 8; c++) {
        const child = n.children[c];
        if (child && index.has(child)) {
          mask |= 1 << c;
          if (first < 0) first = index.get(child)!;
        }
      }
      const adv = first >= 0 ? first - i : 0;
      data[i * 4] = mask;
      data[i * 4 + 1] = (adv >> 8) & 0xff;
      data[i * 4 + 2] = adv & 0xff;
      data[i * 4 + 3] = n.level;
      n.points!.userData.vnStart = i;
    }
    tex.needsUpdate = true;
  }

  // ---- クリック位置の取得 ----

  /**
   * 画面上の位置に最も近い点を返す。tolerancePx 以内の点のうちカメラに最も近いもの。
   * 切断面（clipPlanes）の外側の点は除く。
   */
  pick(
    camera: THREE.Camera,
    ndc: THREE.Vector2,
    viewport: { width: number; height: number },
    tolerancePx = 6,
    clipPlanes: THREE.Plane[] = [],
  ): PointPick | null {
    camera.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const mx = ((ndc.x + 1) / 2) * viewport.width;
    const my = ((1 - ndc.y) / 2) * viewport.height;
    const tol2 = tolerancePx * tolerancePx;
    let best: PointPick | null = null;
    let bestDepth = Infinity;
    const e = viewProj.elements;
    const v = new THREE.Vector3();
    for (const node of this.visibleNodes) {
      const pts = node.points;
      if (!pts) continue;
      // ノードの外接球が光線から遠いものは飛ばす
      const dist = ray.ray.distanceToPoint(node.sphere.center);
      if (dist > node.sphere.radius * 1.05 + 0.5) continue;
      const pos = pts.geometry.getAttribute("position").array as Float32Array;
      const ox = node.box.min.x;
      const oy = node.box.min.y;
      const oz = node.box.min.z;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i] + ox;
        const y = pos[i + 1] + oy;
        const z = pos[i + 2] + oz;
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0) continue;
        const sx = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2) * viewport.width;
        const sy = ((1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2) * viewport.height;
        const dx = sx - mx;
        const dy = sy - my;
        if (dx * dx + dy * dy > tol2) continue;
        const depth = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
        if (depth >= bestDepth || depth < -1 || depth > 1) continue;
        v.set(x, y, z);
        if (clipPlanes.some((p) => p.distanceToPoint(v) < 0)) continue;
        bestDepth = depth;
        best = { point: v.clone(), distance: ray.ray.origin.distanceTo(v), node: node.name };
      }
    }
    return best;
  }

  /**
   * 画面上の位置から radiusPx 以内に見えている点を集める（スナップの端・角を探す元）。
   * 切断面の外側の点は除く。多すぎるときは maxPoints で打ち切る。
   */
  collect(
    camera: THREE.Camera,
    ndc: THREE.Vector2,
    viewport: { width: number; height: number },
    radiusPx: number,
    clipPlanes: THREE.Plane[] = [],
    maxPoints = 40000,
  ): CloudSample {
    camera.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const mx = ((ndc.x + 1) / 2) * viewport.width;
    const my = ((1 - ndc.y) / 2) * viewport.height;
    const r2 = radiusPx * radiusPx;
    // 円の半径ぶん光線から離れた点も拾うので、外接球の判定は 1px の大きさで広げる
    const e = viewProj.elements;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const pos: number[] = [];
    const sx: number[] = [];
    const sy: number[] = [];
    const dist: number[] = [];
    const v = new THREE.Vector3();
    const tanPx = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? (2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov / 2))) / viewport.height
      : 0;
    const orthoPx = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom) /
        (camera as THREE.OrthographicCamera).zoom /
        viewport.height
      : 0;
    outer: for (const node of this.visibleNodes) {
      const pts = node.points;
      if (!pts) continue;
      const along = Math.max(0, node.sphere.center.clone().sub(ray.ray.origin).dot(ray.ray.direction));
      const slack = (tanPx * (along + node.sphere.radius) + orthoPx) * radiusPx;
      if (ray.ray.distanceToPoint(node.sphere.center) > node.sphere.radius * 1.05 + 0.5 + slack) continue;
      const arr = pts.geometry.getAttribute("position").array as Float32Array;
      const ox = node.box.min.x;
      const oy = node.box.min.y;
      const oz = node.box.min.z;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i] + ox;
        const y = arr[i + 1] + oy;
        const z = arr[i + 2] + oz;
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0) continue;
        const dx = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2) * viewport.width - mx;
        const dy = ((1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2) * viewport.height - my;
        if (dx * dx + dy * dy > r2) continue;
        const depth = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
        if (depth < -1 || depth > 1) continue;
        v.set(x, y, z);
        if (clipPlanes.some((p) => p.distanceToPoint(v) < 0)) continue;
        pos.push(x, y, z);
        sx.push(dx);
        sy.push(dy);
        dist.push(camPos.distanceTo(v));
        if (dist.length >= maxPoints) break outer;
      }
    }
    return { n: dist.length, pos: Float64Array.from(pos), sx: Float32Array.from(sx), sy: Float32Array.from(sy), dist: Float32Array.from(dist) };
  }

  dispose() {
    for (const n of [...this.loaded]) this.unload(n);
    for (const w of this.workers) w.terminate();
    this.material.dispose();
    this.material.visibleNodesTexture.dispose();
  }
}

class MaxHeap<T> {
  private items: { item: T; weight: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(item: T, weight: number) {
    const a = this.items;
    a.push({ item, weight });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].weight >= a[i].weight) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { item: T; weight: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].weight > a[m].weight) m = l;
        if (r < a.length && a[r].weight > a[m].weight) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
