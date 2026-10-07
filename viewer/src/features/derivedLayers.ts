// 処理の結果（manifest の derived）を 3D に重ねて出す共通の枠。左タブ「レイヤー」の「処理の結果」に並ぶ。
//
// 結果の種類（ジョブの kind）ごとに、出し方を registerDerivedLayerKind で登録する（例: modes/builtinJobs.ts の selftest）。
// 登録の無い種類の結果はレイヤーに出さない（左タブ「成果」の一覧には出る）。
//
// - 結果は初めて表示するときに読む（版を開いただけでは読まない。大きなメッシュ・干渉結果があっても開くのが遅くならない）
// - 置くものはシーン座標（世界座標から版の原点を引いた座標。data/dataset.ts の worldToScene）
// - 版を閉じるとき・結果が一覧から消えたときに dispose を呼ぶ

import * as THREE from "three";
import type { App } from "../app";
import type { DerivedEntry, Manifest } from "../data/dataset";
import type { AppFeature } from "./feature";

/** 表示中の結果 1 件 */
export interface DerivedLayer {
  /** 3D に置くもの（シーン座標）。表示・非表示は枠が切り替える */
  object: THREE.Object3D | null;
  /** 行の横の短い表示（件数など） */
  count?: string;
  /** 移動ボタンで見せる範囲（シーン座標）。無ければ object の範囲 */
  box?(): THREE.Box3 | null;
  /** 行を開いたときの中身（凡例・設定） */
  body?(): (Node | null)[];
  /** 後始末（geometry・material・テクスチャの dispose）。object は枠がシーンから外す */
  dispose?(): void;
}

export interface DerivedLayerKind {
  /** ジョブの種類（JobService.Kinds の id） */
  kind: string;
  /** 結果を読み、3D に置くものを作る（初めて表示するとき 1 回） */
  create(app: App, m: Manifest, entry: DerivedEntry): Promise<DerivedLayer>;
}

const kinds = new Map<string, DerivedLayerKind>();

export function registerDerivedLayerKind(def: DerivedLayerKind): void {
  if (kinds.has(def.kind)) throw new Error(`処理の結果の出し方 ${def.kind} が二重に登録されています`);
  kinds.set(def.kind, def);
}

export function hasDerivedLayerKind(kind: string): boolean {
  return kinds.has(kind);
}

export interface DerivedLayerState {
  entry: DerivedEntry;
  status: "idle" | "loading" | "ready" | "error";
  visible: boolean;
  layer: DerivedLayer | null;
  error?: string;
}

/** 開いている版の処理の結果のレイヤー */
export class DerivedLayers implements AppFeature {
  private readonly states = new Map<string, DerivedLayerState>();
  private readonly group = new THREE.Group();
  private manifest: Manifest | null = null;

  constructor(private readonly app: App) {
    this.group.name = "derived";
    app.viewer.content.add(this.group);
  }

  /** レイヤーに出せる結果（新しい順） */
  list(): DerivedLayerState[] {
    return [...this.states.values()].sort((a, b) => b.entry.createdAt.localeCompare(a.entry.createdAt));
  }

  get(id: string): DerivedLayerState | undefined {
    return this.states.get(id);
  }

  onOpen(m: Manifest) {
    this.manifest = m;
    this.sync(m);
  }

  onClose() {
    for (const s of this.states.values()) this.disposeState(s);
    this.states.clear();
    this.manifest = null;
  }

  /** manifest の derived に合わせる（処理が終わって増えたとき・一覧を読み直したとき） */
  sync(m: Manifest) {
    if (this.manifest?.folder !== m.folder) return;
    this.manifest = m;
    const ids = new Set(m.derived.map((d) => d.id));
    for (const [id, s] of this.states) {
      if (!ids.has(id)) {
        this.disposeState(s);
        this.states.delete(id);
      }
    }
    for (const e of m.derived) {
      if (!kinds.has(e.kind) || this.states.has(e.id)) continue;
      this.states.set(e.id, { entry: e, status: "idle", visible: false, layer: null });
    }
    this.app.emit("derived");
  }

  /** 表示を切り替える（初めてなら読み込む） */
  async setVisible(id: string, on: boolean) {
    const s = this.states.get(id);
    const m = this.manifest;
    if (!s || !m) return;
    s.visible = on;
    if (on && (s.status === "idle" || s.status === "error")) {
      s.status = "loading";
      s.error = undefined;
      this.app.emit("derived");
      try {
        const layer = await kinds.get(s.entry.kind)!.create(this.app, m, s.entry);
        // 読んでいる間に版を閉じた・結果が消えた
        if (this.states.get(id) !== s || this.manifest !== m) {
          layer.dispose?.();
          return;
        }
        s.layer = layer;
        s.status = "ready";
        if (layer.object) this.group.add(layer.object);
      } catch (e) {
        s.status = "error";
        s.error = e instanceof Error ? e.message : String(e);
        s.visible = false;
        console.warn(`処理の結果 ${id} を表示できません`, e);
      }
    }
    if (s.layer?.object) s.layer.object.visible = s.visible;
    this.app.viewer.requestRender();
    this.app.emit("derived");
  }

  /** 範囲（シーン座標）。読んでいなければ null */
  boxOf(id: string): THREE.Box3 | null {
    const l = this.states.get(id)?.layer;
    if (!l) return null;
    const b = l.box?.() ?? (l.object ? new THREE.Box3().setFromObject(l.object) : null);
    return b && !b.isEmpty() ? b : null;
  }

  private disposeState(s: DerivedLayerState) {
    if (s.layer?.object) this.group.remove(s.layer.object);
    try {
      s.layer?.dispose?.();
    } catch (e) {
      console.warn(e);
    }
    s.layer = null;
    s.status = "idle";
  }
}
