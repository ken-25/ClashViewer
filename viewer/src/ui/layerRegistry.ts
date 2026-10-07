// 左タブ「レイヤー」に並べる行の登録口。点群・モデル（標準）と、処理の結果（derived）を同じ形の行で並べる。
// 行の種類を足すときは、定義を 1 つ書いて registerLayerSource するだけにする（viewPanels.renderLayers は触らない）。
//
// 処理の結果を 3D に出すときは、ここではなく features/derivedLayers.ts の registerDerivedLayerKind を使う
// （結果の読み込み・表示切替・後始末はそちらが受け持ち、行は標準の「処理の結果」の行の元から出る）。
//
// このファイルは型だけに依存させる（App ⇄ 定義 ⇄ パネルの循環 import を作らないため）。

import type { App } from "../app";

/**
 * レイヤーの 1 行。点群・モデル・階・クラス・処理の結果を同じ形にそろえる:
 * [開閉] 名前 件数 [表示] [半透明] [移動]
 */
export interface LayerRow {
  /** 開閉とフォーカスを戻すための識別子（タブ全体で一意） */
  key: string;
  level: number;
  label: string;
  count?: string;
  /** 名前の横に添える補足（作成日時など） */
  title?: string;
  /** 表示中か。null なら表示ボタンを出さない */
  shown: boolean | null;
  /** 親（モデル・階）が隠れているので、この行も見えていない */
  dimmed?: boolean;
  /** 読み込み中など、押せない状態 */
  busy?: boolean;
  ghost: boolean | null;
  onShow?: (on: boolean) => void;
  onGhost?: (on: boolean) => void;
  onMove?: () => void;
  moveTitle?: string;
  /** 開くと出る中身。無ければ開閉の三角を出さない */
  body?: () => (Node | null)[];
}

export interface LayerSourceDefinition {
  id: string;
  /** 並び順（小さいほど上）。点群 0・モデル 10・処理の結果 100 */
  order: number;
  /** 見出し（無ければ出さない） */
  heading?: string;
  /** 並べる行（level 0 の行。下の階層は body で作る） */
  rows(app: App): LayerRow[];
  /** 行が無いときの一文（null なら何も出さない） */
  empty?(app: App): string | null;
}

const sources = new Map<string, LayerSourceDefinition>();

export function registerLayerSource(def: LayerSourceDefinition): void {
  if (sources.has(def.id)) throw new Error(`レイヤーの行の元 ${def.id} が二重に登録されています`);
  sources.set(def.id, def);
}

/** 登録された行の元（並び順） */
export function layerSources(): LayerSourceDefinition[] {
  return [...sources.values()].sort((a, b) => a.order - b.order);
}
