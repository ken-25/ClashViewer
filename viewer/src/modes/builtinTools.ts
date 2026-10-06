// 標準のツール（選択・計測・UCS・指摘・3点合わせ・断面）の定義。main.ts で 1 回だけ読み込む。
// 新しいツール（搬入検討・干渉チェックなど）は同じ形の定義を別のファイルに書き、main.ts で読み込む。

import { DEFAULT_TOOL, registerTool } from "../tools/toolRegistry";
import { renderAlignPanel, renderIssueToolPanel, renderMeasurePanel, renderOriginPanel, renderPlanePanel } from "../ui/viewPanels";

/** スナップを使うツールの案内に添えるキー */
const SNAP_KEYS = "Tab 候補切替・Alt フリー";
const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;

registerTool({
  id: DEFAULT_TOOL,
  title: "属性",
  toolbar: { label: "選択", tooltip: "要素を選んで属性を見る（Esc）", order: 0 },
  panel: "props",
  worksWithoutData: true,
  hint: () => "",
  onClick: (app, p) => app.select(p),
});

registerTool({
  id: "measure",
  title: "計測",
  toolbar: { label: "計測", tooltip: "距離・折れ線を測る。軸に沿わせると X/Y/Z 方向に吸着（X/Y/Z キーで固定）", order: 10 },
  capturesDblClick: true,
  hint: (app) => {
    const m = app.measure;
    const lock = app.axisLock ? `（${app.axisLock.toUpperCase()} 方向に固定）` : "";
    if (m.kind === "distance") {
      const step = m.hasPending ? `2点目をクリック${lock}` : "1点目をクリック";
      return `距離: ${step}　${SNAP_KEYS}・X/Y/Z 軸固定・Esc ${m.hasPending ? "キャンセル" : "終了"}`;
    }
    const step = !m.hasPending ? "1点目をクリック" : m.pointCount === 1 ? `2点目をクリック${lock}` : `次の点をクリック${lock}・Enter/ダブルクリックで確定`;
    return `折れ線: ${step}　${SNAP_KEYS}・Backspace 1点戻す・Esc ${m.hasPending ? "確定" : "終了"}`;
  },
  snap: () => ({ models: true, cloud: true }),
  onExit: (app) => app.measure.cancel(),
  preClick: (app, e) => app.finishPolylineAtLastPoint(e),
  onClick: (app, p, _e, info) => {
    if (p) app.addMeasurePoint(p, info.shift, info.snapLabel);
  },
  onKey: (app, e) => {
    const measuring = app.measure.hasPending;
    const key = e.key.toLowerCase();
    if (e.key === "Escape" && measuring) {
      // 距離は 1 点目を取り消し、折れ線はそこまでで確定する（ツールはそのまま。もう一度でツールを終える）
      if (app.measure.kind === "polyline") app.finishMeasure();
      else {
        app.measure.cancel();
        app.updateToolHint();
        app.snap.refresh();
      }
      return true;
    }
    if (e.key === "Enter" && measuring) {
      e.preventDefault();
      app.finishMeasure();
      return true;
    }
    if (e.key === "Backspace" && measuring) {
      e.preventDefault();
      app.measure.undo();
      app.updateToolHint();
      app.snap.refresh();
      return true;
    }
    if (e.key === "Shift") {
      app.setShiftHeld(true);
      return true;
    }
    if (plain(e) && !e.shiftKey && (key === "x" || key === "y" || key === "z")) {
      app.toggleAxisLock(key);
      return true;
    }
    return false;
  },
  renderPanel: renderMeasurePanel,
});

registerTool({
  id: "origin",
  title: "UCS（ユーザー座標系）",
  toolbar: { label: "UCS", tooltip: "ユーザー座標系（UCS）を決める。1点目=原点、2点目=X軸の向き", order: 20 },
  hint: (app) =>
    app.originStep === 0
      ? `UCS: 原点にする点をクリック　${SNAP_KEYS}・Esc 終了`
      : `UCS: X 軸の向きにする点をクリック（Esc で向きは変えずに終了）　${SNAP_KEYS}`,
  snap: () => ({ models: true, cloud: true }),
  onEnter: (app) => (app.originStep = 0),
  onExit: (app) => (app.originStep = 0),
  onClick: (app, p) => {
    if (p) app.addOriginPoint(p);
  },
  renderPanel: renderOriginPanel,
});

registerTool({
  id: "issue",
  title: "指摘を登録",
  toolbar: { label: "指摘を登録", tooltip: "クリックした位置に指摘を登録", order: 30 },
  hint: () => "指摘する位置をクリック　Esc 終了",
  onClick: (app, p) => {
    if (p) app.emit("issue:new");
  },
  renderPanel: renderIssueToolPanel,
});

registerTool({
  id: "align",
  title: "3点合わせ",
  toolbar: { label: "3点合わせ", tooltip: "モデルと点群の対応する3点で合わせる", order: 40 },
  exitLabel: "キャンセル",
  hint: () => `3点合わせ: 右のパネルの手順に従ってください　${SNAP_KEYS}・Esc キャンセル`,
  snap: (app) => {
    const needModel = app.align.model.length <= app.align.cloud.length;
    return { models: needModel, cloud: !needModel };
  },
  // 途中の対応点・仮の配置は、終わるとき（保存・キャンセル・Esc・ほかのツール）に捨てる
  onExit: (app) => app.resetAlign(),
  onClick: (app, p) => {
    if (p) app.addAlignPick(p);
  },
  renderPanel: renderAlignPanel,
});

// ツールバーには出さず、切断メニューの「面に合わせて断面を追加」から始める（app.startPlaneTool）
registerTool({
  id: "plane",
  title: "面に合わせて断面を追加",
  exitLabel: "キャンセル",
  hint: (app) => `${app.planeMethod === "face" ? "断面（面に合わせる）" : "断面（3点）"}: ${app.planeStepHint()}`,
  // 3点指定は角・端に吸着させる（面からのときは面の法線が要るのでスナップしない）
  snap: (app) => (app.planeMethod === "points" ? { models: true, cloud: true } : null),
  onEnter: (app) => app.resetPlaneTool(),
  onExit: (app) => app.resetPlaneTool(),
  onClick: (app, p, e) => {
    if (p) app.planeClick(p, e);
    else app.setHint(`断面: 何も無い所です。${app.planeStepHint()}`);
  },
  onKey: (app, e) => {
    if (e.key === "Backspace" && app.planePts.length) {
      e.preventDefault();
      app.undoPlanePoint();
      return true;
    }
    return false;
  },
  renderPanel: renderPlanePanel,
});
