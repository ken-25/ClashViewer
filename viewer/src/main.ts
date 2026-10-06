import "./style.css";
import * as THREE from "three";
import { App } from "./app";
// 標準のツール・左タブ・見え方を登録する（App を作る前に）
import "./modes/builtinTools";
import "./modes/builtinPanels";
import { DEFAULT_TOOL, getTool, toolbarTools } from "./tools/toolRegistry";
import { formatCount } from "./data/dataset";
import { attributeSignature } from "./data/diff";
import { solveRigid } from "./tools/align";
import { host, isHosted } from "./host";
import { DataPanel } from "./ui/dataPanel";
import { $, anyPopupOpen, setupMenus, showMessage } from "./ui/dom";
import { openHelp } from "./ui/helpDialog";
import { Navigator } from "./ui/navigator";
import { mountLeftTabs, mountViewBar } from "./ui/panelHost";
import { SettingsDialog } from "./ui/settingsDialog";
import { renderRight, renderToolOptions, syncClipPanel, updatePcStats } from "./ui/viewPanels";


async function main() {
  if (!isHosted) {
    document.body.textContent = "Kasane.exe から開いてください。";
    return;
  }
  const app = new App();
  app.ctx = await host.getContext();
  $("#st-user").textContent = `${app.ctx.displayName}（${app.ctx.user}）`;
  const settings = new SettingsDialog(app);
  const stRoot = $("#st-root");
  stRoot.textContent = `保存先: ${app.ctx.root}`;
  stRoot.title = `プロジェクトフォルダ: ${app.ctx.root}\n設定データフォルダ: ${app.ctx.configRoot}\n（クリックで設定を開く）`;
  stRoot.addEventListener("click", () => void settings.open());
  $("#btn-settings").addEventListener("click", () => void settings.open());
  const budget = Number(app.ctx.config?.pointBudget);
  if (!localStorage.getItem("pointBudget") && budget > 0) app.pointBudget = budget;

  const data = new DataPanel(app);
  // 左タブ・見え方は登録から作る（メニューの開閉を付ける setupMenus より前に）
  const renderTabs = mountLeftTabs(app);
  const syncViewBar = mountViewBar(app);
  setupMenus();
  $("#btn-help").addEventListener("click", () => openHelp());

  /** プロジェクトを開いていないと使えないボタン（ツール・見え方）を、見た目も無効にする */
  const syncEnabled = () => {
    const off = !app.current;
    document.querySelectorAll<HTMLButtonElement>(".needs-tool-data, .needs-data").forEach((b) => {
      b.dataset.title ??= b.title;
      b.disabled = off;
      b.title = off ? `プロジェクトを開くと使えます。${b.dataset.title}` : b.dataset.title;
    });
  };
  // 左タブ・見え方の描き直しは、それぞれの登録（modes/builtinPanels.ts）の topics で行う
  app.on("dataset", () => {
    syncEnabled();
    renderRight(app);
  });
  new Navigator(app);
  app.on("selection", () => renderRight(app));
  app.on("measures", () => renderToolOptions(app));
  // 値だけの変化（スライダー・3D のドラッグ中）はパネルを作り直さない。作り直すとドラッグが切れる
  app.on("clip", () => syncClipPanel(app));
  app.on("align", () => renderToolOptions(app));
  app.on("tool", () => renderRight(app));
  app.on("pcstats", () => updatePcStats(app));

  // ツールバー（モードの切替）。ボタンは登録されたツールから作る
  const toolGroup = $("#tool-group");
  for (const def of toolbarTools()) {
    const b = document.createElement("button");
    b.dataset.tool = def.id;
    b.title = def.toolbar!.tooltip;
    b.textContent = def.toolbar!.label;
    if (!def.worksWithoutData) b.classList.add("needs-tool-data");
    b.classList.toggle("active", def.id === app.tool);
    b.addEventListener("click", () => {
      if (!app.current && !def.worksWithoutData) return;
      app.setTool(def.id);
    });
    toolGroup.appendChild(b);
  }
  // 左右パネルの折りたたみ（狭い画面で 3D 画面を広げる）。状態はこの PC に覚える
  const appEl = $("#app");
  const setPanel = (side: "left" | "right", collapsed: boolean, focus = false) => {
    appEl.classList.toggle(`${side}-collapsed`, collapsed);
    document.querySelectorAll<HTMLElement>(`.panel-strip[data-panel=${side}]`).forEach((b) => b.setAttribute("aria-expanded", String(!collapsed)));
    localStorage.setItem(`panel:${side}`, collapsed ? "collapsed" : "open");
    if (focus) document.querySelector<HTMLElement>(`${collapsed ? ".panel-strip" : ".panel-close"}[data-panel=${side}]`)?.focus();
  };
  for (const side of ["left", "right"] as const) {
    setPanel(side, localStorage.getItem(`panel:${side}`) === "collapsed");
    document.querySelector(`.panel-close[data-panel=${side}]`)?.addEventListener("click", () => setPanel(side, true, true));
    document.querySelector(`.panel-strip[data-panel=${side}]`)?.addEventListener("click", () => setPanel(side, false, true));
  }
  // 折りたたんだ側のタブ・指摘を開く操作（3D の指摘ピンなど）が来たら開く
  app.on("issue:open", () => setPanel("left", false));

  // 3D 画面のクリック（ドラッグで回したときは無視する）
  const canvas = app.viewer.canvas;
  let down: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 4 || !app.current) {
      // 回した・動かしたあとは、止まった位置で候補を探し直す
      app.snap.request(e.clientX, e.clientY);
      return;
    }
    void app.handleClick(e).catch((err) => console.error(err));
  });
  // スナップの候補（計測・原点設定・3点合わせ）。ボタンを押したまま（回転・移動中）は探さない
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    if (e.buttons !== 0) {
      app.snap.leave();
      return;
    }
    app.snap.request(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerleave", () => app.snap.leave());
  window.addEventListener("blur", () => {
    app.snap.setFreeHeld(false);
    app.measureMode.setShiftHeld(false);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") app.snap.setFreeHeld(false);
    if (e.key === "Shift") app.measureMode.setShiftHeld(false);
  });
  canvas.addEventListener("dblclick", async (e) => {
    // 計測中のダブルクリックは折れ線の確定に使う（注視点は動かさない）
    if (getTool(app.tool).capturesDblClick) return;
    const p = await app.picker.pick(e.clientX, e.clientY);
    if (!p) return;
    // 注視点をクリック位置へ（そこを中心に回る）
    const offset = app.viewer.camera.position.clone().sub(app.viewer.controls.target);
    app.viewer.controls.target.copy(p.point);
    app.viewer.camera.position.copy(p.point).add(offset.multiplyScalar(0.6));
    app.viewer.cameraMoved();
  });
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const key = e.key.toLowerCase();
    if (document.querySelector("dialog[open]")) return;
    // 開いているメニュー・パネルは、それぞれの処理が先に閉じる
    if (e.key === "Escape" && anyPopupOpen()) return;
    // 今のツールのキー操作が先（処理したら共通のキー操作はしない）
    if (getTool(app.tool).onKey?.(app, e)) return;
    if (e.key === "Escape") {
      // 途中の作業の片付けは各ツールの onExit
      app.setTool(DEFAULT_TOOL);
    } else if (e.key === "Tab" && app.snap.active && !e.ctrlKey && !e.altKey) {
      // スナップ候補の切替（フォーカスは移さない）
      e.preventDefault();
      app.snap.cycle(e.shiftKey ? -1 : 1);
    } else if (e.key === "Alt" && app.snap.active) {
      // 押している間はフリー（Alt 単独でメニューへフォーカスが移らないように止める）
      e.preventDefault();
      app.snap.setFreeHeld(true);
    } else if (key === "s" && plain && !e.shiftKey && app.snap.active) {
      app.snap.setEnabled(!app.snap.enabled);
      renderToolOptions(app);
    } else if (key === "p" && plain && app.current) {
      app.toggleProjection();
    } else if (key === "b" && plain && !e.shiftKey && app.current) {
      app.clipping.setShowGuides(!app.clipping.showGuides);
    } else if (e.key === "F1" || (e.key === "?" && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      openHelp();
    } else if (e.key === "F12" && app.ctx.dev) {
      void host.openDevTools();
    }
  });

  // 状態表示
  setInterval(() => {
    const pc = app.pc;
    $("#st-fps").textContent = `描画 ${app.viewer.frameMs.toFixed(1)} ms`;
    $("#st-points").textContent = pc ? `点群 ${formatCount(pc.visiblePoints)} / ${formatCount(pc.pointCount)} 点${pc.isLoading ? "（読込中）" : ""}` : "";
    updatePcStats(app);
  }, 1000);

  // 保存先の取込・指摘の変化を拾う（データはこの PC のローカルだけ。外部とは同期しない。要件定義 5.3）
  const poll = async () => {
    try {
      await app.issues.refresh();
    } catch (e) {
      console.warn(e);
    }
  };
  setInterval(poll, 10_000);
  setInterval(() => void app.refreshDatasets().catch(() => undefined), 30_000);
  window.addEventListener("focus", () => {
    void poll();
    void app.refreshDatasets().catch(() => undefined);
  });

  // プロジェクト一覧と保存先の変化は互いに依存しないので同時に取る（起動時の RPC 待ちを 1 往復分減らす）
  await Promise.all([app.refreshDatasets(), poll(), app.attachJobs().catch((e) => console.warn(e))]);
  // 前回のプロジェクトを自動で開くときは、最初の描画の前に読み込み中にする（「プロジェクトを開いてください」を出さない）
  const last = localStorage.getItem("lastDataset");
  const start = app.datasets.find((d) => d.folder === last);
  if (start) app.setLoading(`${start.name}（第${start.version}版）を開いています…`);
  data.render();
  syncEnabled();
  renderTabs();
  renderRight(app);
  syncViewBar();

  if (start) await app.openDataset(start).catch((e) => showMessage("開けません", String(e)));

  // E2E テスト・計測用（開発モードのみ）
  if (app.ctx.dev) (window as any).__kasane = { app, host, data, settings, THREE, attributeSignature, solveRigid };
}

main().catch((e) => {
  console.error(e);
  void showMessage("起動できません", String(e instanceof Error ? e.stack ?? e.message : e));
});
