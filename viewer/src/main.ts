import "./style.css";
import * as THREE from "three";
import { App, type Tool } from "./app";
import { formatCount } from "./data/dataset";
import { attributeSignature } from "./data/diff";
import { solveRigid } from "./tools/align";
import { host, isHosted } from "./host";
import type { ClipMode } from "./tools/clipping";
import type { Projection, ViewKind } from "./scene/viewer3d";
import { DataPanel } from "./ui/dataPanel";
import { renderDiff } from "./ui/diffPanel";
import { $, anyPopupOpen, setupMenus, showMessage } from "./ui/dom";
import { openHelp } from "./ui/helpDialog";
import { IssuePanel } from "./ui/issuePanel";
import { Navigator } from "./ui/navigator";
import { SettingsDialog } from "./ui/settingsDialog";
import { renderLayers, renderMeasureList, renderNavMenu, renderRight, renderToolOptions, syncClipPanel, updatePcStats } from "./ui/viewPanels";

const CLIP_LABEL: Record<ClipMode, string> = { none: "なし", box: "ボックス", section: "断面" };

async function main() {
  if (!isHosted) {
    document.body.textContent = "干渉ビューア.exe から開いてください。";
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
  const issues = new IssuePanel(app);
  setupMenus();
  $("#btn-help").addEventListener("click", () => openHelp());

  /** プロジェクトを開いていないと使えないボタン（ツール・見え方）を、見た目も無効にする */
  const syncEnabled = () => {
    const off = !app.current;
    document.querySelectorAll<HTMLButtonElement>("[data-tool]:not([data-tool=select]), .needs-data").forEach((b) => {
      b.dataset.title ??= b.title;
      b.disabled = off;
      b.title = off ? `プロジェクトを開くと使えます。${b.dataset.title}` : b.dataset.title;
    });
  };
  app.on("dataset", () => {
    syncEnabled();
    renderLayers(app);
    renderDiff(app);
    renderMeasureList(app);
    renderRight(app);
    syncClipButtons();
  });
  app.on("display", () => renderLayers(app));
  app.on("nav", () => renderNavMenu(app));
  new Navigator(app);
  app.on("diff", () => {
    renderDiff(app);
    renderLayers(app);
  });
  app.on("selection", () => renderRight(app));
  app.on("measures", () => {
    renderMeasureList(app);
    renderToolOptions(app);
  });
  // 切断の状態はメニュー以外（指摘の視点再現・プロジェクトを開き直す）でも変わるので、表示を毎回合わせる
  const syncClipButtons = () => {
    document.querySelectorAll<HTMLButtonElement>("[data-clip]").forEach((x) => {
      const on = x.dataset.clip === app.clipping.mode;
      x.classList.toggle("active", on);
      x.setAttribute("aria-checked", String(on));
    });
    const btn = $("#btn-clip");
    btn.textContent = `切断: ${CLIP_LABEL[app.clipping.mode]} ▾`;
    btn.classList.toggle("on", app.clipping.mode !== "none");
  };
  app.on("clip", () => {
    // 値だけの変化（スライダー・3D のドラッグ中）はパネルを作り直さない。作り直すとドラッグが切れる
    syncClipPanel(app);
    syncClipButtons();
  });
  app.on("align", () => renderToolOptions(app));
  app.on("tool", () => renderRight(app));
  app.on("pcstats", () => updatePcStats(app));

  // ツールバー（モードの切替）
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!app.current && b.dataset.tool !== "select") return;
      if (b.dataset.tool === "align") app.resetAlign();
      app.setTool(b.dataset.tool as Tool);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-clip]").forEach((b) =>
    b.addEventListener("click", () => {
      const mode = b.dataset.clip as ClipMode;
      if (mode !== "none" && app.clipping.mode === "none") app.prepareClipExtent();
      if (mode === "section" && app.clipping.mode !== "section") {
        const c = app.clipping.extent.getCenter(new THREE.Vector3());
        app.clipping.section.position = app.clipping.section.axis === "z" ? c.z : c[app.clipping.section.axis];
      }
      app.clipping.setMode(mode);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
    b.addEventListener("click", () => app.viewer.setView(b.dataset.view as ViewKind, app.viewBox())),
  );
  // 投影の切替（平行投影 / 透視）。指摘の視点再現でも切り替わるので、ボタンの表示は viewer の通知で合わせる
  const projBtn = $("#btn-projection") as HTMLButtonElement;
  const syncProjection = (p: Projection) => {
    const on = p === "orthographic";
    projBtn.classList.toggle("active", on);
    projBtn.setAttribute("aria-pressed", String(on));
    localStorage.setItem("projection", p);
  };
  app.viewer.onProjectionChange(syncProjection);
  const toggleProjection = () => app.viewer.setProjection(app.viewer.projection === "orthographic" ? "perspective" : "orthographic");
  projBtn.addEventListener("click", toggleProjection);
  if (localStorage.getItem("projection") === "orthographic") app.viewer.setProjection("orthographic");
  syncProjection(app.viewer.projection);
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
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-selected", String(x === b));
      });
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.id === `tab-${b.dataset.tab}`));
    }),
  );

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
    app.setShiftHeld(false);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") app.snap.setFreeHeld(false);
    if (e.key === "Shift") app.setShiftHeld(false);
  });
  canvas.addEventListener("dblclick", async (e) => {
    // 計測中のダブルクリックは折れ線の確定に使う（注視点は動かさない）
    if (app.tool === "measure") return;
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
    const measuring = app.tool === "measure" && app.measure.hasPending;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "Escape") {
      // 開いているメニュー・パネルは、それぞれの処理が先に閉じる
      if (anyPopupOpen()) return;
      if (app.tool === "align") app.resetAlign();
      // 計測の作図中なら、距離は 1 点目を取り消し、折れ線はそこまでで確定する（ツールはそのまま）。
      // もう一度でツールを終える
      if (measuring) {
        if (app.measure.kind === "polyline") app.finishMeasure();
        else {
          app.measure.cancel();
          app.updateToolHint();
          app.snap.refresh();
        }
      } else {
        app.setTool("select");
      }
    } else if (e.key === "Enter" && measuring) {
      e.preventDefault();
      app.finishMeasure();
    } else if (e.key === "Backspace" && measuring) {
      e.preventDefault();
      app.measure.undo();
      app.updateToolHint();
      app.snap.refresh();
    } else if (e.key === "Shift" && app.tool === "measure") {
      app.setShiftHeld(true);
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
    } else if (app.tool === "measure" && plain && !e.shiftKey && ["x", "y", "z"].includes(key)) {
      app.toggleAxisLock(key as "x" | "y" | "z");
    } else if (key === "p" && plain && app.current) {
      toggleProjection();
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
      await app.refreshEvents();
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
  await Promise.all([app.refreshDatasets(), poll()]);
  // 前回のプロジェクトを自動で開くときは、最初の描画の前に読み込み中にする（「プロジェクトを開いてください」を出さない）
  const last = localStorage.getItem("lastDataset");
  const start = app.datasets.find((d) => d.folder === last);
  if (start) app.setLoading(`${start.name}（第${start.version}版）を開いています…`);
  data.render();
  issues.render();
  syncEnabled();
  renderLayers(app);
  renderDiff(app);
  renderMeasureList(app);
  renderRight(app);
  renderNavMenu(app);
  syncClipButtons();

  if (start) await app.openDataset(start).catch((e) => showMessage("開けません", String(e)));

  // E2E テスト・計測用（開発モードのみ）
  if (app.ctx.dev) (window as any).__cv = { app, host, data, issues, settings, THREE, attributeSignature, solveRigid };
}

main().catch((e) => {
  console.error(e);
  void showMessage("起動できません", String(e instanceof Error ? e.stack ?? e.message : e));
});
