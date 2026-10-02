import "./style.css";
import * as THREE from "three";
import { App, type Tool } from "./app";
import { formatCount } from "./data/dataset";
import { attributeSignature } from "./data/diff";
import { solveRigid } from "./tools/align";
import { host, isHosted } from "./host";
import type { ClipMode } from "./tools/clipping";
import type { ViewKind } from "./scene/viewer3d";
import { DataPanel } from "./ui/dataPanel";
import { renderDiff } from "./ui/diffPanel";
import { $, showMessage } from "./ui/dom";
import { IssuePanel } from "./ui/issuePanel";
import { renderDisplay, renderMeasures, renderProps, renderToolPanel, syncToolPanel, updatePcStats } from "./ui/viewPanels";

async function main() {
  if (!isHosted) {
    document.body.textContent = "干渉ビューア.exe から開いてください。";
    return;
  }
  const app = new App();
  app.ctx = await host.getContext();
  $("#st-user").textContent = `${app.ctx.displayName}（${app.ctx.user}）`;
  const budget = Number(app.ctx.config?.pointBudget);
  if (!localStorage.getItem("pointBudget") && budget > 0) app.pointBudget = budget;

  const data = new DataPanel(app);
  const issues = new IssuePanel(app);
  app.on("dataset", () => {
    renderDisplay(app);
    renderDiff(app);
    renderToolPanel(app);
    renderMeasures(app);
    renderProps(app);
  });
  app.on("display", () => renderDisplay(app));
  app.on("diff", () => renderDiff(app));
  app.on("selection", () => renderProps(app));
  app.on("measures", () => renderMeasures(app));
  // 切断の状態はボタン以外（指摘の視点再現・データセットを開き直す）でも変わるので、ボタンの表示を毎回合わせる
  const syncClipButtons = () =>
    document.querySelectorAll<HTMLButtonElement>("[data-clip]").forEach((x) => x.classList.toggle("active", x.dataset.clip === app.clipping.mode));
  app.on("clip", () => {
    // 値だけの変化（スライダー・3D のドラッグ中）はパネルを作り直さない。作り直すとドラッグが切れる
    syncToolPanel(app);
    syncClipButtons();
  });
  app.on("align", () => renderToolPanel(app));
  app.on("tool", () => {
    renderToolPanel(app);
    renderMeasures(app);
  });
  app.on("pcstats", () => updatePcStats(app));

  // ツールバー
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
      if (mode === "section" && app.clipping.mode !== "section") {
        const c = app.clipping.extent.getCenter(new THREE.Vector3());
        app.clipping.section.position = app.clipping.section.axis === "z" ? c.z : c[app.clipping.section.axis];
      }
      app.clipping.setMode(mode);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
    b.addEventListener("click", () => app.viewer.setView(b.dataset.view as ViewKind, app.sceneBox())),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
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
    if (moved > 4 || !app.current) return;
    void app.handleClick(e).catch((err) => console.error(err));
  });
  canvas.addEventListener("dblclick", async (e) => {
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
    if (e.key === "Escape") {
      app.measure.cancel();
      app.setTool("select");
    } else if (app.tool === "ortho" && ["x", "y", "z"].includes(e.key.toLowerCase())) {
      app.orthoAxis = e.key.toLowerCase() as "x" | "y" | "z";
      renderMeasures(app);
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

  // 他の人の取込・指摘を拾う（Box Drive で同期されてくる）
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

  await app.refreshDatasets();
  await poll();
  data.render();
  issues.render();
  renderDisplay(app);
  renderDiff(app);
  renderMeasures(app);

  const last = localStorage.getItem("lastDataset");
  const start = app.datasets.find((d) => d.folder === last);
  if (start) await app.openDataset(start).catch((e) => showMessage("開けません", String(e)));

  // E2E テスト・計測用（開発モードのみ）
  if (app.ctx.dev) (window as any).__cv = { app, host, data, issues, THREE, attributeSignature, solveRigid };
}

main().catch((e) => {
  console.error(e);
  void showMessage("起動できません", String(e instanceof Error ? e.stack ?? e.message : e));
});
