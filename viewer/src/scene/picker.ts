import * as THREE from "three";
import type { LoadedModel, ModelManager } from "../model/models";
import type { PotreePointCloud } from "../pointcloud/potree";
import type { Viewer3D } from "./viewer3d";

export interface Pick {
  point: THREE.Vector3; // シーン座標
  source: "model" | "cloud";
  distance: number;
  model?: { lm: LoadedModel; localId: number };
  snap?: "point" | "line" | "face";
}

export interface PickOptions {
  models?: boolean;
  cloud?: boolean;
  snap?: boolean;
}

/** 点群とモデルのどちらでもクリック位置を取る（計測・原点・指摘・3点合わせで共通） */
export class Picker {
  cloud: PotreePointCloud | null = null;

  constructor(
    private readonly viewer: Viewer3D,
    private readonly models: ModelManager,
  ) {}

  async pick(clientX: number, clientY: number, opt: PickOptions = {}): Promise<Pick | null> {
    const { models = true, cloud = true, snap = false } = opt;
    const ndc = this.viewer.toNdc(clientX, clientY);
    const planes = this.viewer.renderer.clippingPlanes;
    let best: Pick | null = null;
    if (cloud && this.cloud && this.cloud.group.visible) {
      const p = this.cloud.pick(this.viewer.camera, ndc, this.viewer.size, 7, planes);
      if (p) best = { point: p.point, source: "cloud", distance: p.distance };
    }
    if (models) {
      const h = await this.models.raycast(ndc, snap);
      if (h) {
        const snapName = ({ 0: "point", 1: "line", 2: "face" } as const)[h.snappingClass as number];
        const cand: Pick = {
          point: h.point.clone(),
          source: "model",
          distance: this.viewer.camera.position.distanceTo(h.point),
          model: { lm: h.lm, localId: h.localId },
          snap: snap ? snapName : undefined,
        };
        // ほぼ同じ奥行きならモデルを優先（スナップが効くため）
        if (!best || cand.distance < best.distance * 1.01 + 0.01) best = cand;
      }
    }
    return best;
  }
}
