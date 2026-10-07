// 処理（ジョブ）の画面の定義: ツールバーの「処理」ツール（右パネルで始める）、左タブ「成果」、
// レイヤーの「処理の結果」の行、標準の結果の出し方（selftest: 点群の範囲の枠）。main.ts で 1 回だけ読み込む。
// 新しい処理の結果を 3D に出すときは、registerDerivedLayerKind を同じ形で別のファイルに書く。

import * as THREE from "three";
import type { App } from "../app";
import { derivedRel, formatCount, worldToScene } from "../data/dataset";
import { registerDerivedLayerKind } from "../features/derivedLayers";
import { fetchJson } from "../host";
import { registerTool } from "../tools/toolRegistry";
import { fmtDate, h } from "../ui/dom";
import { refreshJobToolPanel, renderJobToolPanel, renderResults } from "../ui/jobPanels";
import { registerLayerSource } from "../ui/layerRegistry";
import { registerLeftTab } from "../ui/panelRegistry";

registerTool({
  id: "jobs",
  title: "処理",
  toolbar: { label: "処理", tooltip: "点群・モデルに対する重い計算（処理）を始める。進み具合と結果は左の「成果」タブ", order: 50 },
  hint: () => "処理: 右のパネルで種類と設定を選んで「開始」　Esc 終了",
  // 使える処理が無い（開発用の処理だけで、開発モードでない）ときはボタンを出さない
  available: (app) => app.jobKinds.length > 0,
  renderPanel: renderJobToolPanel,
  // 進み具合は下の欄だけを描き直す（入力中の設定欄を作り直さない）
  panelTopics: ["jobs", "datasets"],
  refreshPanel: refreshJobToolPanel,
});

registerLeftTab({
  id: "results",
  label: "成果",
  order: 40,
  topics: ["dataset", "datasets", "jobs", "derived"],
  badge: (app) => (app.activeJobCount ? String(app.activeJobCount) : ""),
  setup: (app, el) => () => renderResults(app, el),
});

// ---- レイヤー: 処理の結果 ----

registerLayerSource({
  id: "derived",
  order: 100,
  heading: "処理の結果",
  rows: (app: App) =>
    app.derivedLayers.list().map((s) => ({
      key: `derived:${s.entry.id}`,
      level: 0,
      label: s.entry.label || s.entry.kind,
      title: `${fmtDate(s.entry.createdAt)}・${app.memberName(s.entry.createdBy)}${s.error ? `\n表示できません: ${s.error}` : ""}`,
      count: s.status === "loading" ? "読込中…" : s.status === "error" ? "エラー" : s.layer?.count,
      busy: s.status === "loading",
      shown: s.visible,
      ghost: null,
      onShow: (on: boolean) => void app.derivedLayers.setVisible(s.entry.id, on),
      onMove: s.layer
        ? () => {
            const b = app.derivedLayers.boxOf(s.entry.id);
            if (b) app.focusBox(b);
          }
        : undefined,
      moveTitle: "この結果の全体が見える所へ移動（見る向きはそのまま）",
      body: s.layer?.body ? () => s.layer!.body!() : undefined,
    })),
});

// ---- 標準の結果の出し方 ----

interface SelftestSummary {
  points: number;
  pointcloud: { attributes: string[]; ranges: Record<string, [number, number]>; bounds: { min: number[]; max: number[] } | null } | null;
}

// 基盤の動作確認（開発用）: 点群を全点読んだ範囲を枠で出す
registerDerivedLayerKind({
  kind: "selftest",
  async create(_app, m, entry) {
    const file = entry.files.find((f) => f.endsWith("/summary.json")) ?? `${entry.dir}/summary.json`;
    const s = await fetchJson<SelftestSummary>(derivedRel(m, entry, file));
    const b = s.pointcloud?.bounds;
    if (!b) throw new Error("点群の範囲がありません");
    const box = new THREE.Box3(worldToScene(m, b.min), worldToScene(m, b.max));
    const helper = new THREE.Box3Helper(box, new THREE.Color(0xff9800));
    helper.name = `derived:${entry.id}`;
    return {
      object: helper,
      count: `${formatCount(s.points)} 点`,
      box: () => box.clone(),
      body: () => [
        h("table", { class: "small" },
          Object.entries(s.pointcloud?.ranges ?? {}).map(([k, [lo, hi]]) => h("tr", null, h("td", null, k), h("td", { class: "num" }, `${lo} 〜 ${hi}`)))),
      ],
      dispose: () => {
        helper.geometry.dispose();
        (helper.material as THREE.Material).dispose();
      },
    };
  },
});
