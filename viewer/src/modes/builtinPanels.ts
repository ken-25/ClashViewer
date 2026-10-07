// 標準の左タブ（レイヤー・計測・指摘・差分）と、3D 画面左上の見え方（視点・投影・切断・目印）の定義。
// main.ts で 1 回だけ読み込む。新しいタブ（成果など）・見え方の項目は同じ形の定義を別のファイルに書き、main.ts で読み込む。

import type { App } from "../app";
import type { ViewKind } from "../scene/viewer3d";
import { renderDiff } from "../ui/diffPanel";
import { h } from "../ui/dom";
import { IssuePanel } from "../ui/issuePanel";
import { registerLeftTab, registerViewBarItem } from "../ui/panelRegistry";
import { renderMeasureList } from "../ui/toolPanels";
import { registerLayerSource } from "../ui/layerRegistry";
import { modelRows, pointCloudRows, renderLayers, renderNavMenu } from "../ui/viewPanels";

// ---- 左タブ: 対象（レイヤー）と成果（計測・指摘・差分） ----

registerLeftTab({
  id: "layers",
  label: "レイヤー",
  order: 0,
  // derived: 処理の結果の行（modes/builtinJobs.ts の行の元）
  // scans: 撮影ポイントの行（modes/scanPointsTool.ts）
  topics: ["dataset", "display", "diff", "derived", "scans"],
  setup: (app) => () => renderLayers(app),
});

// レイヤーの行の元（点群・モデル）。処理の結果の行は modes/builtinJobs.ts
registerLayerSource({
  id: "pointcloud",
  order: 0,
  rows: pointCloudRows,
  empty: () => "点群はありません。",
});

registerLayerSource({
  id: "models",
  order: 10,
  rows: modelRows,
  empty: () => "モデルはありません。",
});

registerLeftTab({
  id: "measures",
  label: "計測",
  order: 10,
  topics: ["dataset", "measures"],
  badge: (app) => (app.measure.list.length ? String(app.measure.list.length) : ""),
  setup: (app, el) => () => renderMeasureList(app, el),
});

registerLeftTab({
  id: "issues",
  label: "指摘",
  order: 20,
  topics: ["dataset", "issues"],
  badge: (app) => IssuePanel.openCount(app),
  setup: (app, el) => {
    const panel = new IssuePanel(app, el);
    return () => panel.render();
  },
});

registerLeftTab({
  id: "diff",
  label: "差分",
  order: 30,
  topics: ["dataset", "diff"],
  setup: (app, el) => () => renderDiff(app, el),
});

// ---- 3D 画面左上: 見え方 ----

const VIEWS: [ViewKind, string, string][] = [
  ["iso", "斜め上から", "斜め上から全体を見る（前・右はこの視点が基準）"],
  ["top", "平面", "真上から見下ろす（小地図と同じ向き）"],
  ["front", "正面", "前（−Y 側）から +Y 方向を見る"],
  ["back", "背面", "後ろ（+Y 側）から −Y 方向を見る"],
  ["left", "左側面", "左（−X 側）から +X 方向を見る"],
  ["right", "右側面", "右（+X 側）から −X 方向を見る"],
];

registerViewBarItem({
  id: "btn-view",
  order: 0,
  label: "視点",
  title: "視点を切り替える（方位の軸を押しても切り替わります）",
  needsData: true,
  menu: {
    ariaLabel: "視点",
    build: (app, el) =>
      el.append(...VIEWS.map(([kind, label, title]) =>
        h("button", { role: "menuitem", "data-view": kind, title, onclick: () => app.viewer.setView(kind, app.viewBox()) }, label))),
  },
});

registerViewBarItem({
  id: "btn-projection",
  order: 10,
  label: "平行投影",
  title: "平行投影（遠近なし）と透視を切り替える（P）",
  needsData: true,
  onClick: (app) => app.toggleProjection(),
  // 指摘の視点再現でも切り替わるので、ボタンの表示は通知で合わせる
  topics: ["projection"],
  sync: (app, btn) => {
    const on = app.viewer.projection === "orthographic";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  },
});

/** メニュー内のチェックボックス（押してもメニューを閉じずに続けて切り替えられる） */
function menuCheck(id: string, label: string, title: string, onchange: (on: boolean) => void) {
  return h("label", { class: "menu-check", role: "menuitemcheckbox", "aria-checked": "false", title },
    h("input", { type: "checkbox", id, onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) }), label);
}

function setCheck(menu: HTMLElement, id: string, on: boolean) {
  const c = menu.querySelector<HTMLInputElement>(`#${id}`)!;
  c.checked = on;
  c.closest("[role=menuitemcheckbox]")?.setAttribute("aria-checked", String(on));
}

// 切断を足す・全部オフ・枠の表示はここだけ。右のパネルは今ある切断の調整だけ
registerViewBarItem({
  id: "btn-clip",
  order: 20,
  label: (app: App) => {
    const clip = app.clipping;
    const n = clip.enabledSections;
    const parts = [clip.boxOn ? "ボックス" : "", n ? `断面 ${n}` : ""].filter(Boolean);
    return `切断: ${parts.length ? parts.join("＋") : "なし"}${clip.active && !clip.showGuides ? "（枠なし）" : ""}`;
  },
  title: "切断ボックス・断面（足す・オフはここ、調整は右のパネル）",
  needsData: true,
  menu: {
    ariaLabel: "切断",
    wide: true,
    build: (app, el) =>
      el.append(
        menuCheck("chk-clip-box", "切断ボックス", "見たい範囲を箱で切り出す", (on) => app.section.setClipBox(on)),
        h("div", { class: "menu-sep", role: "separator" }),
        h("button", { role: "menuitem", "data-add-section": "z", title: "今見ている所の高さで水平に切る（上を消す）", onclick: () => app.section.addAxisSection("z") }, "水平断面を追加"),
        ...(["x", "y"] as const).map((a) =>
          h("button", { role: "menuitem", "data-add-section": a, onclick: () => app.section.addAxisSection(a) })),
        h("button", { role: "menuitem", id: "btn-add-face-section", title: "モデルの面・点群の平らな所・3点をクリックして、その面に平行に切る", onclick: () => app.section.startPlaneTool() }, "面に合わせて断面を追加…"),
        h("div", { class: "menu-sep", role: "separator" }),
        menuCheck("chk-clip-guides", "枠を表示する（B）", "箱の枠・断面の目印を出す。隠しても切断は効いたまま（B）", (on) => app.clipping.setShowGuides(on)),
        h("button", { role: "menuitem", id: "btn-clip-off", title: "切断ボックスと断面をすべてオフにする（断面は右のパネルの一覧に残ります）", onclick: () => app.clipping.disableAll() }, "切断をすべてオフ"),
      ),
  },
  // 切断の状態はメニュー以外（指摘の視点再現・プロジェクトを開き直す）でも変わるので、表示を毎回合わせる。
  // UCS が変わると、垂直断面の追加の軸（UCS / WCS）が変わる
  topics: ["dataset", "clip", "measures"],
  sync: (app, btn, menu) => {
    const clip = app.clipping;
    btn.classList.toggle("on", clip.active);
    setCheck(menu!, "chk-clip-box", clip.boxOn);
    setCheck(menu!, "chk-clip-guides", clip.showGuides);
    menu!.querySelector<HTMLButtonElement>("#btn-clip-off")!.disabled = !clip.active;
    // 垂直断面は UCS を設定していれば UCS の軸に直交
    const ucs = app.frame.isSet;
    for (const a of ["x", "y"] as const) {
      const b = menu!.querySelector<HTMLButtonElement>(`[data-add-section=${a}]`)!;
      const name = `${ucs ? "UCS " : ""}${a.toUpperCase()}`;
      b.textContent = `垂直断面を追加（${name}）`;
      b.title = `今見ている所を通り、${name} 軸に直交する面で切る`;
    }
  },
});

registerViewBarItem({
  id: "btn-nav",
  order: 30,
  label: "目印",
  title: "位置の目印・小地図",
  needsData: true,
  menu: { ariaLabel: "位置の目印", wide: true, id: "nav-menu", build: (app, el) => renderNavMenu(app, el) },
  topics: ["nav"],
  sync: (app, _btn, menu) => renderNavMenu(app, menu!),
});
