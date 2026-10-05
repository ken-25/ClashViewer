import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import type { LoadedModel, ModelManager } from "../model/models";
import type { PotreePointCloud } from "../pointcloud/potree";
import { cloudSnaps, rankCandidates, type SnapCandidate, type SnapKind } from "./snap";
import type { Viewer3D } from "./viewer3d";

export interface Pick {
  point: THREE.Vector3; // シーン座標
  /** axis は軸を固定した計測で、何も無い所の軸線上を拾ったとき */
  source: "model" | "cloud" | "axis";
  distance: number;
  model?: { lm: LoadedModel; localId: number };
  snap?: SnapKind | "point" | "line" | "face";
}

export interface PickOptions {
  models?: boolean;
  cloud?: boolean;
  snap?: boolean;
}

/** 点群の端・角を探す範囲（px）。モデル側は Fragments が 10px の範囲で探す */
const CLOUD_SNAP_PX = 16;
/** フリー（スナップなし）で点群の点を拾う範囲（px） */
const CLOUD_PICK_PX = 7;
/** モデルの辺の中点を候補にする範囲（px） */
const MIDPOINT_PX = 12;

export function candidateToPick(c: SnapCandidate): Pick {
  return { point: c.point.clone(), source: c.source, distance: c.distance, model: c.model, snap: c.kind };
}

/** 点群とモデルのどちらでもクリック位置を取る（計測・原点・指摘・3点合わせで共通） */
export class Picker {
  cloud: PotreePointCloud | null = null;
  /** 点群の端・角を探す向き（局所座標の X/Y/Z）。未設定なら世界座標の軸 */
  axes: (() => [THREE.Vector3, THREE.Vector3, THREE.Vector3]) | null = null;

  constructor(
    private readonly viewer: Viewer3D,
    private readonly models: ModelManager,
  ) {}

  async pick(clientX: number, clientY: number, opt: PickOptions = {}): Promise<Pick | null> {
    const { models = true, cloud = true, snap = false } = opt;
    if (snap) {
      const list = await this.candidates(clientX, clientY, { models, cloud });
      return list[0] ? candidateToPick(list[0]) : null;
    }
    const ndc = this.viewer.toNdc(clientX, clientY);
    const planes = this.viewer.renderer.clippingPlanes;
    let best: Pick | null = null;
    if (cloud && this.cloud && this.cloud.group.visible) {
      const p = this.cloud.pick(this.viewer.camera, ndc, this.viewer.size, CLOUD_PICK_PX, planes);
      if (p) best = { point: p.point, source: "cloud", distance: p.distance };
    }
    if (models) {
      const h = await this.models.raycast(ndc, false);
      if (h) {
        const cand: Pick = {
          point: h.point.clone(),
          source: "model",
          distance: this.viewer.camera.position.distanceTo(h.point),
          model: { lm: h.lm, localId: h.localId },
        };
        // ほぼ同じ奥行きならモデルを優先
        if (!best || cand.distance < best.distance * 1.01 + 0.01) best = cand;
      }
    }
    return best;
  }

  /** 距離 d の位置での画面 1px の大きさ（m） */
  pxSize(d: number): number {
    const cam = this.viewer.camera;
    const h = Math.max(1, this.viewer.size.height);
    if (cam instanceof THREE.OrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
    return (d * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
  }

  /** シーン座標の点の canvas 上の位置（px） */
  project(p: THREE.Vector3): { x: number; y: number } {
    const v = p.clone().project(this.viewer.camera);
    const { width, height } = this.viewer.size;
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  }

  /** カーソル位置の光線（シーン座標） */
  rayAt(clientX: number, clientY: number): THREE.Ray {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(this.viewer.toNdc(clientX, clientY), this.viewer.camera);
    return rc.ray.clone();
  }

  /**
   * カーソル付近のスナップ候補を、使いやすい順（端点・角 → 中点 → 辺上・端 → フリー）に返す。
   * フリーはカーソル下の面・点そのもの（スナップしない位置）で、あれば最後に 1 つ入る。
   * 手前の物に隠れた候補（点群の奥のモデルの頂点など）は除く。
   */
  async candidates(clientX: number, clientY: number, opt: { models?: boolean; cloud?: boolean } = {}): Promise<SnapCandidate[]> {
    const { models = true, cloud = true } = opt;
    const ndc = this.viewer.toNdc(clientX, clientY);
    const cam = this.viewer.camera;
    const camPos = cam.position;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const planes = this.viewer.renderer.clippingPlanes;
    const make = (kind: SnapKind, source: SnapCandidate["source"], point: THREE.Vector3, extra: Partial<SnapCandidate> = {}): SnapCandidate => {
      const s = this.project(point);
      return { kind, source, point, distance: camPos.distanceTo(point), sx: s.x, sy: s.y, screenDist: Math.hypot(s.x - cx, s.y - cy), ...extra };
    };

    const cloudList: SnapCandidate[] = [];
    let cloudFree: SnapCandidate | null = null;
    if (cloud && this.cloud && this.cloud.group.visible) {
      const sample = this.cloud.collect(cam, ndc, this.viewer.size, CLOUD_SNAP_PX, planes);
      const axes = this.axes?.() ?? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
      const r = cloudSnaps(sample, { radiusPx: CLOUD_SNAP_PX, pickPx: CLOUD_PICK_PX, pxSize: (d) => this.pxSize(d), axes });
      if (r.free) cloudFree = make("free", "cloud", r.free);
      for (const s of r.snaps) cloudList.push(make(s.kind, "cloud", s.point, { detail: s.detail }));
    }

    const modelList: SnapCandidate[] = [];
    let modelFree: SnapCandidate | null = null;
    if (models) {
      const hits = await this.models.snapHits(ndc);
      for (const h of hits) {
        const model = h.localId !== undefined ? { lm: h.lm, localId: h.localId } : undefined;
        if (h.snappingClass === FRAGS.SnappingClass.POINT) {
          modelList.push(make("vertex", "model", h.point.clone(), { model }));
        } else if (h.snappingClass === FRAGS.SnappingClass.LINE) {
          const edge: [THREE.Vector3, THREE.Vector3] | undefined =
            h.snappedEdgeP1 && h.snappedEdgeP2 ? [h.snappedEdgeP1.clone(), h.snappedEdgeP2.clone()] : undefined;
          modelList.push(make("edge", "model", h.point.clone(), { model, edge }));
          if (edge) {
            const mid = make("midpoint", "model", edge[0].clone().add(edge[1]).multiplyScalar(0.5), { model, edge });
            if (mid.screenDist <= MIDPOINT_PX) modelList.push(mid);
          }
        } else {
          // 面: カーソル直下の面の点。最も手前を「フリー」にする
          const c = make("free", "model", h.point.clone(), { model });
          if (c.screenDist <= 3 && (!modelFree || c.distance < modelFree.distance)) modelFree = c;
        }
      }
    }

    // フリー: ほぼ同じ奥行きならモデルを優先（従来のクリック位置の取得と同じ）
    let free: SnapCandidate | null = cloudFree;
    if (modelFree && (!free || modelFree.distance < free.distance * 1.01 + 0.01)) free = modelFree;

    // 手前の物に隠れた候補を除く。斜めに見た面の奥行きの差ぶんは許す
    const visibleBehind = (front: SnapCandidate | null) => {
      if (!front) return () => true;
      const tol = Math.max(0.02, CLOUD_SNAP_PX * this.pxSize(front.distance) * 3);
      return (c: SnapCandidate) => c.distance <= front.distance * 1.01 + tol;
    };
    const all = [
      ...modelList.filter(visibleBehind(cloudFree && (!modelFree || cloudFree.distance < modelFree.distance) ? cloudFree : null)),
      ...cloudList.filter(visibleBehind(modelFree && (!cloudFree || modelFree.distance < cloudFree.distance) ? modelFree : null)),
    ];
    if (free) all.push(free);
    return rankCandidates(all);
  }
}
