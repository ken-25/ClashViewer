// 左タブと、3D 画面左上の見え方（view-bar）の登録口。
// タブ・メニューを足すときは、定義を 1 つ書いて register するだけにする（index.html・main.ts は触らない）。
//
// 置き場所のきまり（.kiro/steering/ui-rules.md）:
// - 左タブ: 対象（レイヤー）と成果（計測・指摘・差分）
// - view-bar: 見え方（視点・投影・切断・目印）
// - ツールバー・右パネルはツールの登録口（tools/toolRegistry.ts）
//
// このファイルは型だけに依存させる（App ⇄ 定義 ⇄ パネルの循環 import を作らないため）。
// DOM を組み立てるのは ui/panelHost.ts。

import type { App, AppTopic } from "../app";

export interface LeftTabDefinition {
  /** パネルは #tab-<id>、タブのボタンは [data-tab="<id>"] になる */
  id: string;
  label: string;
  /** 並び順（小さいほど左） */
  order: number;
  /**
   * パネルを用意して、描き直す関数を返す（起動時に 1 回）。
   * el はこのタブのパネル。状態を持つパネル（指摘など）はここで作る
   */
  setup(app: App, el: HTMLElement): () => void;
  /** 描き直すきっかけ */
  topics: AppTopic[];
  /** タブの横の件数（空文字なら出さない）。topics・badgeTopics のたびに数え直す */
  badge?(app: App): string;
  /** 件数だけが変わるきっかけ（パネルは描き直さない） */
  badgeTopics?: AppTopic[];
}

export interface ViewBarMenu {
  /** メニューの aria-label */
  ariaLabel: string;
  /** 幅の広いメニュー（説明文・チェックボックスが並ぶもの） */
  wide?: boolean;
  /** メニュー要素の id（e2e・既存の CSS から参照するとき） */
  id?: string;
  /** メニューの中身を作る（起動時に 1 回）。中の button を押すとメニューは閉じる */
  build(app: App, el: HTMLElement): void;
}

export interface ViewBarItemDefinition {
  /** ボタンの id */
  id: string;
  order: number;
  /** ボタンの文字。メニューを開くボタンには「 ▾」を付ける */
  label: string | ((app: App) => string);
  title: string;
  /** プロジェクトを開いていないと使えない（開くまで無効にする） */
  needsData?: boolean;
  /** 押すとメニューを開く。無ければ onClick */
  menu?: ViewBarMenu;
  onClick?(app: App): void;
  /** ボタンとメニューの状態を合わせる（起動時と topics のたび。メニューは作り直さず値だけ合わせる） */
  sync?(app: App, button: HTMLButtonElement, menu: HTMLElement | null): void;
  topics?: AppTopic[];
}

const tabs = new Map<string, LeftTabDefinition>();
const viewItems = new Map<string, ViewBarItemDefinition>();

export function registerLeftTab(def: LeftTabDefinition): void {
  if (tabs.has(def.id)) throw new Error(`左タブ ${def.id} が二重に登録されています`);
  tabs.set(def.id, def);
}

/** 登録された左タブ（並び順） */
export function leftTabs(): LeftTabDefinition[] {
  return [...tabs.values()].sort((a, b) => a.order - b.order);
}

export function registerViewBarItem(def: ViewBarItemDefinition): void {
  if (viewItems.has(def.id)) throw new Error(`見え方の項目 ${def.id} が二重に登録されています`);
  if (!def.menu && !def.onClick) throw new Error(`見え方の項目 ${def.id} に menu も onClick もありません`);
  viewItems.set(def.id, def);
}

/** 登録された見え方の項目（並び順） */
export function viewBarItems(): ViewBarItemDefinition[] {
  return [...viewItems.values()].sort((a, b) => a.order - b.order);
}
