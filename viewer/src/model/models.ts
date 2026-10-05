import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import type { Viewer3D } from "../scene/viewer3d";
import { buildStoreyTree, idsOfKeys, STOREY, type StoreyInfo, type StoreyNode } from "./layerTree";

/**
 * Fragments（That Open）のモデル表示。
 *
 * 座標: Fragments の座標 F は web-ifc の出力（Y 上、COORDINATE_TO_ORIGIN で原点寄せ済み）。
 * IFC 本来の座標 W（Z 上・m）とは W = N⁻¹ · C⁻¹ · F の関係にある（C: 原点寄せの平行移動、
 * N: Z 上→Y 上の回転）。シーンには T(−原点) · A（座標合わせ）· N⁻¹ · C⁻¹ を掛けて置く。
 */

export interface LoadedModel {
  key: string; // データセット内のモデル名
  datasetFolder: string;
  model: FRAGS.FragmentsModel;
  holder: THREE.Group; // matrix = シーン座標への変換
  fragToIfc: THREE.Matrix4; // F → W（IFC 本来の座標）
  categories: string[];
  /** 階（IfcBuildingStorey）・クラスの 2 段ツリー。空間構造が無ければ「全体」1 つ */
  storeys: StoreyNode[];
  visible: boolean;
  opacity: number;
  /** 非表示・半透明にする階・クラス（キーの形式は layerTree.ts） */
  hiddenKeys: Set<string>;
  ghostKeys: Set<string>;
  role: "current" | "previous";
}

/** 半透明にした階・クラスの不透明度 */
const GHOST_OPACITY = 0.2;

const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

export class ModelManager {
  readonly fragments: FRAGS.FragmentsModels;
  readonly models = new Map<string, LoadedModel>();
  readonly group = new THREE.Group();
  private updating = false;

  constructor(private readonly viewer: Viewer3D) {
    this.fragments = new FRAGS.FragmentsModels("./fragments/worker.mjs");
    // 原点は自前で合わせる（最初のモデルに寄せる既定動作は使わない）
    this.fragments.settings.autoCoordinate = false;
    this.group.name = "models";
    viewer.content.add(this.group);
    viewer.controls.addEventListener("change", () => this.update());
    viewer.controls.addEventListener("end", () => this.update(true));
    this.fragments.models.materials.list.onItemSet.add(({ value: material }) => {
      // 点群と同じ切断を効かせる
      (material as THREE.Material).clippingPlanes = null;
      if ("polygonOffset" in material) {
        // 点群と同じ面に重なるときにモデルを少し奥へ（点が埋もれにくい）
        material.polygonOffset = true;
        material.polygonOffsetFactor = 1;
        material.polygonOffsetUnits = 1;
      }
    });
  }

  /** Fragments の表示更新（LOD・カリング）。カメラが動いたら呼ぶ。 */
  async update(force = false) {
    // 実行中に呼ばれたら、終わってからもう 1 回だけ（最後のカメラ位置で）やり直す
    if (this.updating) {
      this.pendingUpdate = true;
      this.pendingForce ||= force;
      return;
    }
    this.updating = true;
    try {
      await this.fragments.update(force);
    } finally {
      this.updating = false;
      this.viewer.requestRender();
    }
    if (this.pendingUpdate) {
      const f = this.pendingForce;
      this.pendingUpdate = false;
      this.pendingForce = false;
      await this.update(f || true);
    }
  }

  private pendingUpdate = false;
  private pendingForce = false;

  get isBusy(): boolean {
    for (const m of this.models.values()) if (m.model.isBusy) return true;
    return false;
  }

  async load(
    key: string,
    datasetFolder: string,
    buffer: ArrayBuffer,
    role: "current" | "previous" = "current",
  ): Promise<LoadedModel> {
    const modelId = `${datasetFolder}/${key}`;
    if (this.models.has(modelId)) await this.unload(modelId);
    // LOD・カリング用のカメラは表示中のカメラを写した透視型（平行投影でも Fragments が LOD を求められる）
    const model = await this.fragments.load(buffer, { modelId, camera: this.viewer.lodCamera });
    this.useOrthoLod(model);
    model.getClippingPlanesEvent = () => this.viewer.renderer.clippingPlanes;
    const holder = new THREE.Group();
    holder.name = modelId;
    holder.matrixAutoUpdate = false;
    holder.add(model.object);
    this.group.add(holder);
    const coord = await model.getCoordinationMatrix();
    const fragToIfc = Y_UP_TO_Z_UP.clone().multiply(coord.clone().invert());
    const categories = (await model.getCategories()).sort();
    const storeys = await this.storeyTree(model, categories);
    const lm: LoadedModel = {
      key,
      datasetFolder,
      model,
      holder,
      fragToIfc,
      categories,
      storeys,
      visible: true,
      opacity: 1,
      hiddenKeys: new Set(),
      ghostKeys: new Set(),
      role,
    };
    this.models.set(modelId, lm);
    await this.update(true);
    return lm;
  }

  /**
   * 平行投影のときの LOD の寸法を Fragments に渡す。Fragments 3.4.7 はこれを常に undefined にしており
   * （ViewManager.setOrtho）、透視の「距離 × tan(画角/2)」で LOD を選ぶ。平行投影では奥の物も同じ大きさに
   * 見えるので、それだと注視点より奥の物が粗くなる。内部の受け口（_viewManager._updateOrthoSizeEvent）を
   * 差し替える。版が変わって受け口が無ければ何もしない（透視の基準で LOD を選ぶだけで、表示はできる）。
   */
  private useOrthoLod(model: FRAGS.FragmentsModel) {
    const vm = (model as any)._viewManager;
    if (!vm || typeof vm._updateOrthoSizeEvent !== "function") return;
    vm._updateOrthoSizeEvent = () => this.viewer.orthoHalfHeight();
  }

  /** ifcToScene = T(−原点) · A。F → シーン座標の行列を設定する */
  setPlacement(lm: LoadedModel, ifcToScene: THREE.Matrix4) {
    lm.holder.matrix.copy(ifcToScene).multiply(lm.fragToIfc);
    lm.holder.matrixWorldNeedsUpdate = true;
    lm.holder.updateMatrixWorld(true);
    this.viewer.requestRender();
    void this.update(true);
  }

  async unload(modelId: string) {
    const lm = this.models.get(modelId);
    if (!lm) return;
    this.models.delete(modelId);
    this.group.remove(lm.holder);
    await this.fragments.disposeModel(modelId);
    this.viewer.requestRender();
  }

  async unloadAll() {
    for (const id of [...this.models.keys()]) await this.unload(id);
  }

  /** シーン座標での全体範囲 */
  box(): THREE.Box3 {
    const b = new THREE.Box3();
    for (const lm of this.models.values()) {
      if (!lm.visible) continue;
      b.union(this.boxOf(lm));
    }
    return b;
  }

  /** 1 モデルのシーン座標での範囲 */
  boxOf(lm: LoadedModel): THREE.Box3 {
    lm.holder.updateMatrixWorld(true);
    return lm.model.box;
  }

  async setModelVisible(lm: LoadedModel, visible: boolean) {
    lm.visible = visible;
    lm.holder.visible = visible;
    await this.update(true);
  }

  async setModelOpacity(lm: LoadedModel, opacity: number) {
    lm.opacity = opacity;
    await this.applyCategoryStates(lm);
  }

  /** 前の反映が終わってから次を始める（続けて押したときに、途中の状態が後から上書きしないように） */
  private applyChain: Promise<void> = Promise.resolve();

  /** モデル全体の不透明度と、階・クラス単位の表示・半透明を反映する */
  applyCategoryStates(lm: LoadedModel): Promise<void> {
    const run = async () => {
      if (!this.models.has(`${lm.datasetFolder}/${lm.key}`)) return;
      await lm.model.setVisible(undefined, true);
      // 半透明を外した階・クラスも戻るように、毎回モデル全体の不透明度から置き直す
      if (lm.opacity >= 0.999) await lm.model.resetOpacity(undefined);
      else await lm.model.setOpacity(undefined, lm.opacity);
      const hidden = idsOfKeys(lm.hiddenKeys, lm.storeys);
      if (hidden.length) await lm.model.setVisible(hidden, false);
      const ghost = idsOfKeys(lm.ghostKeys, lm.storeys);
      if (ghost.length) await lm.model.setOpacity(ghost, Math.min(GHOST_OPACITY, lm.opacity));
      await this.update(true);
    };
    this.applyChain = this.applyChain.then(run, run);
    return this.applyChain;
  }

  /** 階・クラスの要素全体が見える範囲（シーン座標）。要素が無ければ空 */
  async boxOfIds(lm: LoadedModel, ids: number[]): Promise<THREE.Box3> {
    if (ids.length === 0) return new THREE.Box3();
    lm.holder.updateMatrixWorld(true);
    return lm.model.getMergedBox(ids);
  }

  /**
   * 階・クラスのツリーを作る。空間構造が読めない IFC でも、クラスだけの 1 段（「全体」）にはする。
   */
  private async storeyTree(model: FRAGS.FragmentsModel, categories: string[]): Promise<StoreyNode[]> {
    const byCategory = categories.length ? await model.getItemsOfCategories(categories.map((c) => new RegExp(`^${c}$`))) : {};
    const root = await model.getSpatialStructure().catch((e) => {
      console.warn("空間構造を読めません", e);
      return null;
    });
    const storeyIds = byCategory[STOREY] ?? [];
    const info = new Map<number, StoreyInfo>();
    if (storeyIds.length) {
      const v = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);
      const data = await model.getItemsData(storeyIds, { attributesDefault: true }).catch(() => []);
      storeyIds.forEach((id, i) => {
        const d: any = data[i] ?? {};
        const el = Number(v(d.Elevation));
        info.set(id, { guid: v(d._guid) ? String(v(d._guid)) : null, name: v(d.Name) ? String(v(d.Name)) : null, elevation: Number.isFinite(el) ? el : null });
      });
    }
    return buildStoreyTree(root, byCategory, info);
  }

  /** 画面上の位置にあるモデル要素（表示中のものだけ） */
  async raycast(ndc: THREE.Vector2, snap = false): Promise<(FRAGS.RaycastResult & { lm: LoadedModel }) | null> {
    const mouse = new THREE.Vector2(
      ((ndc.x + 1) / 2) * this.viewer.canvas.clientWidth,
      ((1 - ndc.y) / 2) * this.viewer.canvas.clientHeight,
    );
    // Fragments の raycast は client 座標（DOM 基準）を受け取る
    const rect = this.viewer.canvas.getBoundingClientRect();
    mouse.x += rect.left;
    mouse.y += rect.top;
    let best: (FRAGS.RaycastResult & { lm: LoadedModel }) | null = null;
    const planes = this.viewer.renderer.clippingPlanes;
    for (const lm of this.models.values()) {
      if (!lm.visible) continue;
      const data = { camera: this.viewer.camera, mouse, dom: this.viewer.canvas };
      let hits: FRAGS.RaycastResult[] | null;
      if (snap) {
        hits = await lm.model.raycastWithSnapping({
          ...data,
          snappingClasses: [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE, FRAGS.SnappingClass.FACE],
        });
      } else {
        hits = await lm.model.raycastAll(data);
      }
      const sorted = [...(hits ?? [])].sort((a, b) => a.distance - b.distance);
      for (const h of sorted) {
        if (planes.some((p) => p.distanceToPoint(h.point) < -1e-4)) continue;
        if (!best || h.distance < best.distance) best = { ...h, lm };
        break;
      }
    }
    return best;
  }

  /**
   * スナップの候補（頂点・辺・面）をすべて返す（表示中のモデル・切断で隠れていないものだけ）。
   * Fragments はカーソルの周り 10px の範囲で探し、最初に当たった面より奥のものは除いて返す。
   */
  async snapHits(ndc: THREE.Vector2): Promise<(FRAGS.RaycastResult & { lm: LoadedModel })[]> {
    const rect = this.viewer.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((ndc.x + 1) / 2) * this.viewer.canvas.clientWidth + rect.left,
      ((1 - ndc.y) / 2) * this.viewer.canvas.clientHeight + rect.top,
    );
    const planes = this.viewer.renderer.clippingPlanes;
    const out: (FRAGS.RaycastResult & { lm: LoadedModel })[] = [];
    // Fragments の raycast は内部の作業用の値を共有するので、モデルごとに順に呼ぶ
    for (const lm of [...this.models.values()]) {
      if (!lm.visible) continue;
      const hits = await lm.model
        .raycastWithSnapping({
          camera: this.viewer.camera,
          mouse,
          dom: this.viewer.canvas,
          snappingClasses: [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE, FRAGS.SnappingClass.FACE],
        })
        .catch(() => null);
      for (const h of hits ?? []) {
        if (planes.some((p) => p.distanceToPoint(h.point) < -1e-4)) continue;
        out.push({ ...h, lm });
      }
    }
    return out;
  }
}
