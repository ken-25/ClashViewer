// ツール（作業のモード）の登録口。ツールを足すときは、定義を 1 つ書いて registerTool するだけにする。
// App・右パネル・ツールバー・キー操作は、ここに登録された定義を見て動く（ツール名の switch を持たない）。
//
// 置き場所のきまり（.kiro/steering/ui-rules.md）:
// - ツールバー: toolbar を指定したツールだけボタンを出す（モード）
// - 右パネル: panel = "props"（属性）か、renderPanel（今のツールの設定と結果）
// - キー操作を足したら src/ui/helpDialog.ts のキー一覧も更新する
//
// このファイルは型だけに依存させる（App ⇄ 定義 ⇄ パネルの循環 import を作らないため）。

import type { App, AppTopic } from "../app";
import type { Pick } from "../scene/picker";

export type ToolId = string;

export interface ToolClickInfo {
  /** スナップした種類の表示名（フリー・スナップなしは null） */
  snapLabel: string | null;
  /** クリックした瞬間の Shift */
  shift: boolean;
}

export interface ToolDefinition {
  id: ToolId;
  /** 右パネルの見出し・折りたたみ帯の名前 */
  title: string;
  /** ツールバーに出すとき（出さないツールは別の入口から setTool する。例: 断面は切断メニュー） */
  toolbar?: { label: string; tooltip: string; order: number };
  /** 右パネル: "props" なら選択要素の属性。既定は renderPanel（ツールの設定） */
  panel?: "props" | "tool";
  /** 右パネルの終わるボタン。途中の作業を捨てるツールは「キャンセル」、結果が残るツールは「終了」 */
  exitLabel?: "終了" | "キャンセル";
  /** プロジェクトを開いていなくても使えるか（選択ツールだけ） */
  worksWithoutData?: boolean;
  /** 計測など、ダブルクリックを注視点の移動に使わずツールで使う */
  capturesDblClick?: boolean;
  /** 状態表示の案内（今の手順で使うキーだけ） */
  hint(app: App): string;
  /** スナップの候補を探す対象。スナップを使わないなら null */
  snap?(app: App): { models: boolean; cloud: boolean } | null;
  /** ツールに入るとき・出るとき（同じツールを選び直したときも 出る → 入る） */
  onEnter?(app: App): void;
  onExit?(app: App): void;
  /** 位置を拾う前に済ませる操作（折れ線の確定など）。true なら拾わずに終える */
  preClick?(app: App, e: MouseEvent): boolean;
  /** 3D 画面のクリック。p は拾った位置（何も無ければ null） */
  onClick?(app: App, p: Pick | null, e: MouseEvent, info: ToolClickInfo): void | Promise<void>;
  /** キー操作。処理したら true（共通のキー操作より先に呼ぶ。Esc で true なら選択ツールに戻らない） */
  onKey?(app: App, e: KeyboardEvent): boolean;
  /** 右パネル（#tool-opts）を描く。head は見出しと終わるボタン */
  renderPanel?(app: App, el: HTMLElement, head: HTMLElement): void;
  /**
   * このツールの右パネルを更新するきっかけ（ツールを使っている間だけ）。
   * refreshPanel があればそれを呼び（入力中の欄を作り直さずに一部だけ更新する）、無ければ renderPanel で描き直す
   */
  panelTopics?: AppTopic[];
  refreshPanel?(app: App, el: HTMLElement): void;
  /** ツールバーに出すか（使える処理が無いときなど）。無ければいつも出す。panelTopics・"tool" のたびに見直す */
  available?(app: App): boolean;
}

const tools = new Map<ToolId, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (tools.has(def.id)) throw new Error(`ツール ${def.id} が二重に登録されています`);
  tools.set(def.id, def);
}

export function getTool(id: ToolId): ToolDefinition {
  const t = tools.get(id);
  if (!t) throw new Error(`登録されていないツールです: ${id}`);
  return t;
}

export function hasTool(id: ToolId): boolean {
  return tools.has(id);
}

/** 登録されたすべてのツール */
export function allTools(): ToolDefinition[] {
  return [...tools.values()];
}

/** ツールバーに出すツール（並び順） */
export function toolbarTools(): ToolDefinition[] {
  return [...tools.values()].filter((t) => t.toolbar).sort((a, b) => a.toolbar!.order - b.toolbar!.order);
}

/** 既定のツール（属性を見る選択ツール） */
export const DEFAULT_TOOL: ToolId = "select";
