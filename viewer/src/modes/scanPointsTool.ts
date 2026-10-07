// 撮影ポイント（F6）の画面: ツールバーの「撮影ポイント」ツール（右パネルで移動・巡回・画像の設定）と、
// レイヤーの「撮影ポイント」の行（目印の表示・一覧から移動）。main.ts で 1 回だけ読み込む。
//
// 置き場所（.kiro/steering/ui-rules.md の 4 分類）:
// - ツールバー: 撮影ポイントに立って見回すのは操作のモード（左ドラッグ・ホイール・クリックの意味が変わる）なのでツール
// - 左タブ「レイヤー」: 目印は 3D に出る対象なので、表示の切替と一覧（〜へ移動）はレイヤーの行
// - 右パネル: 立っている撮影ポイント・前後の移動・巡回・画像の表示の設定（今のツールの設定と結果）
// - 3D の目印を押すと、このツールに切り替わってその撮影ポイントへ移動する

import * as THREE from "three";
import type { App } from "../app";
import { formatCount, worldToScene } from "../data/dataset";
import { TOUR_INTERVALS } from "../features/scanPoints";
import { registerTool } from "../tools/toolRegistry";
import { h, mount } from "../ui/dom";
import { registerLayerSource } from "../ui/layerRegistry";
import { layerRow } from "../ui/viewPanels";
import type { ScanStation } from "../data/scanPoints";

const TOOL_ID = "scanPoints";
const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;
const KIND_LABEL = { spherical: "360 画像", pinhole: "写真", cylindrical: "円筒画像" } as const;

/** 撮影ポイントに立つ（ツールに切り替えてから） */
function enter(app: App, id: string) {
  if (app.tool !== TOOL_ID) app.setTool(TOOL_ID);
  app.scanPoints.goTo(id);
}

registerTool({
  id: TOOL_ID,
  title: "撮影ポイント",
  toolbar: { label: "撮影ポイント", tooltip: "点群を撮った位置（器械点）に立って見回す。360 画像・写真があれば重ねて表示", order: 45 },
  // 見回しているときのダブルクリックで注視点を動かさない（撮影ポイントから離れない）
  capturesDblClick: true,
  hint: (app) => {
    const sp = app.scanPoints;
    if (!sp.current) return "撮影ポイント: 目印・一覧から選ぶか近くをクリック　N 次へ・Esc 終了";
    return `${sp.current.label}: ドラッグで見回す・クリックで近くへ　N 次・Shift+N 前${sp.current.images.length ? "・I 画像" : ""}・Esc 終了`;
  },
  // 位置の分かる撮影ポイントが無い版ではボタンを出さない（開いていないときは無効のボタンだけ出す）
  available: (app) => !app.current || app.scanPoints.placed.length > 0,
  onExit: (app) => app.scanPoints.leave(),
  onClick: (app, p) => {
    if (p) app.scanPoints.goNear(p.point);
  },
  onKey: (app, e) => {
    const sp = app.scanPoints;
    const key = e.key.toLowerCase();
    if ((key === "n" && plain(e)) || e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      sp.stopTour();
      sp.step(e.shiftKey || e.key === "PageUp" ? -1 : 1);
      return true;
    }
    if (key === "i" && plain(e) && !e.shiftKey && sp.current?.images.length) {
      sp.setShowImage(!sp.showImage);
      return true;
    }
    return false;
  },
  renderPanel: renderScanPanel,
  panelTopics: ["scans", "dataset"],
});

/** 撮影ポイントのツールの右パネル */
function renderScanPanel(app: App, el: HTMLElement, head: HTMLElement) {
  const sp = app.scanPoints;
  const cur = sp.current;
  const placed = sp.placed;
  const unplaced = sp.list.filter((s) => !s.position);
  // 一覧のスクロール位置を描き直しても保つ
  const scroll = el.querySelector<HTMLElement>(".station-list")?.scrollTop ?? 0;
  app.updateToolHint();
  mount(
    el,
    head,
    h("p", { class: "small muted" }, `${placed.length} か所${unplaced.length ? `（位置不明 ${unplaced.length}）` : ""}・画像 ${sp.imageCount} 枚`),
    h("h3", null, cur ? cur.label : "撮影ポイントに立っていません"),
    cur ? h("div", { class: "small muted" }, [cur.source, cur.points ? `${formatCount(cur.points)} 点` : null].filter(Boolean).join("・")) : null,
    h("div", { class: "row" },
      h("button", { title: "前の撮影ポイントへ移動（Shift+N / PageUp）", disabled: placed.length === 0, onclick: () => { sp.stopTour(); sp.step(-1); } }, "◀ 前へ"),
      h("button", { title: "次の撮影ポイントへ移動（N / PageDown）。最後まで行くと最初に戻ります", disabled: placed.length === 0, onclick: () => { sp.stopTour(); sp.step(1); } }, "次へ ▶"),
      h("span", { class: "grow" }),
      cur ? h("button", { class: "small", title: "撮影ポイントから出て、入る前の視点に戻る", onclick: () => sp.leave() }, "元の視点へ戻る") : null),
    h("div", { class: "row small" },
      h("label", { for: "scan-tour" }, "順に巡る"),
      h("select", { id: "scan-tour", "aria-label": "巡る間隔", disabled: placed.length < 2, onchange: (e: Event) => sp.startTour(Number((e.target as HTMLSelectElement).value)) },
        h("option", { value: "0", selected: sp.tourSeconds === 0 }, "止める"),
        TOUR_INTERVALS.map((s) => h("option", { value: String(s), selected: sp.tourSeconds === s }, `${s} 秒ごと`)))),
    imageSection(app),
    h("h3", null, "一覧"),
    h("ul", { class: "station-list", "aria-label": "撮影ポイントの一覧" },
      placed.map((s) => h("li", null, h("button", {
        class: s.id === sp.currentId ? "active" : "",
        "aria-current": s.id === sp.currentId ? "true" : undefined,
        "data-station": s.id,
        title: `${s.label} へ移動`,
        onclick: () => { sp.stopTour(); enter(app, s.id); },
      }, h("span", { class: "grow" }, s.label), s.images.length ? h("span", { class: "small muted" }, `画像 ${s.images.length}`) : null))),
      unplaced.map((s) => h("li", { class: "unplaced small muted", title: "E57 に器械点の位置（姿勢）が入っていないため、移動できません" }, `${s.label}（位置不明）`))),
    unplaced.length ? h("p", { class: "small muted" }, "位置不明: E57 に器械点の位置が入っていない（点を世界座標で持ち、姿勢が原点のまま）スキャンです。") : null,
  );
  const list = el.querySelector<HTMLElement>(".station-list");
  if (list) {
    list.scrollTop = scroll;
    list.querySelector<HTMLElement>("button.active")?.scrollIntoView({ block: "nearest" });
  }
}

function imageSection(app: App): (Node | null)[] {
  const sp = app.scanPoints;
  const cur = sp.current;
  if (sp.imageCount === 0) return [h("p", { class: "small muted" }, "この版には撮影ポイントの画像がありません（E57 に 360 画像・写真が入っていれば、取込時に一緒に取り込みます）。")];
  const kinds = cur ? [...new Set(cur.images.map((i) => KIND_LABEL[i.image.kind] ?? i.image.kind))].join("・") : "";
  const status = !cur
    ? "撮影ポイントに立つと表示します。"
    : !cur.images.length
      ? "この撮影ポイントには画像がありません。"
      : !sp.showImage
        ? `${kinds}（隠しています）`
        : sp.imageStatus === "loading"
          ? "画像を読み込んでいます…"
          : sp.imageStatus === "error"
            ? `画像を表示できません: ${sp.imageError}`
            : `${kinds} を表示中`;
  const yaw = sp.yawDeg;
  return [
    h("h3", null, "画像"),
    h("label", { class: "row small" },
      h("input", { type: "checkbox", checked: sp.showImage, onchange: (e: Event) => sp.setShowImage((e.target as HTMLInputElement).checked) }),
      "撮影ポイントの画像を重ねる（I）"),
    h("div", { class: "row small" },
      h("label", { for: "scan-opacity" }, "濃さ"),
      h("input", { id: "scan-opacity", type: "range", min: "0", max: "1", step: "0.05", value: String(sp.imageOpacity), class: "grow", "aria-label": "画像の濃さ（左端で点群だけ）",
        oninput: (e: Event) => sp.setImageOpacity(Number((e.target as HTMLInputElement).value)) })),
    h("div", { class: "row small" },
      h("label", { for: "scan-yaw", title: "画像の向きが点群とずれるときに回す（このプロジェクトだけ・この PC に保存）" }, "向きの補正"),
      h("select", { id: "scan-yaw", onchange: (e: Event) => sp.setYaw(Number((e.target as HTMLSelectElement).value)) },
        [0, 90, 180, 270].map((d) => h("option", { value: String(d), selected: yaw === d }, `${d}°`)))),
    h("p", { class: `small${sp.imageStatus === "error" ? " err" : " muted"}`, role: "status" }, status),
  ];
}

// ---- レイヤー: 撮影ポイント ----

registerLayerSource({
  id: "scanPoints",
  order: 5,
  rows: (app: App) => {
    const sp = app.scanPoints;
    const placed = sp.placed;
    if (!app.pc || placed.length === 0) return [];
    return [{
      key: "scanPoints",
      level: 0,
      label: "撮影ポイント",
      count: `${placed.length} か所`,
      title: sp.imageCount ? `画像 ${sp.imageCount} 枚` : "画像なし",
      shown: sp.showMarkers,
      ghost: null,
      onShow: (on: boolean) => sp.setShowMarkers(on),
      onMove: () => app.focusBox(stationsBox(app, placed)),
      moveTitle: "撮影ポイントの全体が見える所へ移動（見る向きはそのまま）",
      body: () => placed.map((s) => layerRow(app, {
        key: `scan:${s.id}`,
        level: 1,
        label: s.label,
        count: s.images.length ? `画像 ${s.images.length}` : undefined,
        dimmed: !sp.showMarkers,
        shown: null,
        ghost: null,
        onMove: () => enter(app, s.id),
        moveTitle: "この撮影ポイントへ移動（その場で見回す）",
      })),
    }];
  },
});

function stationsBox(app: App, list: ScanStation[]): THREE.Box3 {
  const b = new THREE.Box3();
  const m = app.current;
  if (m) for (const s of list) b.expandByPoint(worldToScene(m, s.position!));
  return b;
}
