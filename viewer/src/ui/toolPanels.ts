// 標準ツール（計測・UCS・断面・指摘・3点合わせ）の右パネルと、左「計測」タブ。
// ツールの定義（modes/builtinTools.ts）の renderPanel から呼ぶ。

import type { App } from "../app";
import { fmtM, MEASURE_KIND_LABEL, type Axis, type Measurement } from "../tools/measure";
import { h, mount, showMessage } from "./dom";
import { renderToolOptions } from "./viewPanels";

/** UCS（ユーザー座標系）の状態。設定済みなら「WCS に戻す」 */
function ucsStatus(app: App) {
  const f = app.frame;
  return f.isSet
    ? h("div", { class: "row small" },
        h("span", { class: "grow" }, `UCS 設定済み　X 軸の向き ${((Math.atan2(f.xAxis.y, f.xAxis.x) * 180) / Math.PI).toFixed(2)}°`),
        h("button", { class: "small", title: "UCS を解除し、WCS（ワールド座標系）で測る", onclick: () => app.ucs.reset() }, "WCS に戻す"))
    : h("div", { class: "small muted" }, "WCS（ワールド座標系）で測ります。ツールバーの「UCS」で原点と X 軸の向きを決められます。");
}

/** 左「計測」タブ: 計測結果の一覧と、測る座標系（WCS / UCS） */
export function renderMeasureList(app: App, el: HTMLElement) {
  const n = app.measure.list.length;
  mount(
    el,
    h("h2", null, "座標系"),
    ucsStatus(app),
    h("h2", null, `計測結果（${n}）`),
    n === 0 ? h("p", { class: "small muted" }, "ツールバーの「計測」で点をクリックすると、ここに残ります。") : null,
    app.measure.list
      .slice()
      .reverse()
      .map((m) => measureItem(app, m)),
    n ? h("div", { class: "row" }, h("button", { onclick: () => app.measure.clear() }, "すべて消す")) : null,
  );
}

/** 断面（面に合わせる・3点）ツールの右パネル */
export function renderPlanePanel(app: App, el: HTMLElement, head: HTMLElement) {
  const { method, points } = app.section;
  mount(
    el,
    head,
    h("div", { class: "row small", role: "group", "aria-label": "断面の決め方" }, h("span", { class: "lbl" }, "決め方"),
      ...(["face", "points"] as const).map((m) =>
        h("button", {
          class: method === m ? "active" : "",
          "aria-pressed": String(method === m),
          title: m === "face" ? "モデルの面、または点群の平らな所を 1 回クリック" : "面の上の 3 点をクリック（点群・モデルの角や端に吸着）",
          onclick: () => app.section.setMethod(m),
        }, m === "face" ? "面から" : "3点"))),
    method === "face"
      ? h("ol", { class: "small steps" },
          h("li", null, "切断面にしたい面（斜めの壁・屋根・配管の側面など）をクリック。モデルの面でも、点群の平らな所でも使えます"),
          h("li", null, "その面に平行な切断面ができます"))
      : h("ol", { class: "small steps" },
          [0, 1, 2].map((i) => h("li", { class: points.length === i ? "" : "muted" }, `${i + 1}点目${points[i] ? " ✓" : ""}`))),
    h("p", { class: "small muted" }, method === "face"
      ? "点群の角・縁など平らでない所をクリックすると、3点指定に切り替わり、その点を 1点目にします。"
      : "3 点を通る面で切ります。Backspace で 1 点戻せます。"),
    h("p", { class: "small muted" }, "クリックした側（カメラ側）を消します。位置・残す側は、できた断面を下の「切断」で調整します。"),
  );
}

/** 計測ツールの右パネル */
export function renderMeasurePanel(app: App, el: HTMLElement, head: HTMLElement) {
  const last = app.measure.list[app.measure.list.length - 1];
  mount(
    el,
    head,
    measureOptions(app),
    last ? [h("h3", null, "直前の結果"), measureItem(app, last)] : null,
    h("p", { class: "small muted" }, "結果は左の「計測」タブに一覧します。キー操作は上の案内と「?」にあります。"),
  );
}

/** UCS ツールの右パネル */
export function renderOriginPanel(app: App, el: HTMLElement, head: HTMLElement) {
  mount(
    el,
    head,
    h("ol", { class: "small steps" },
      h("li", null, "UCS の原点にする点をクリック"),
      h("li", null, "X 軸の向きにする点をクリック（Esc で向きは変えずに終了）")),
    h("p", { class: "small muted" }, "Z 軸は常に鉛直上です。点群・モデルのどちらの点でも決められます。UCS はプロジェクトごとにこの PC に保存します。"),
    ucsStatus(app),
  );
}

/** 指摘の登録ツールの右パネル */
export function renderIssueToolPanel(_app: App, el: HTMLElement, head: HTMLElement) {
  mount(el, head, h("p", { class: "small" }, "指摘する位置を 3D 画面でクリックすると、登録画面が開きます。"), h("p", { class: "small muted" }, "今の視点・表示の状態・画面の画像も一緒に保存します。"));
}

const axisStyle = (a: Axis | null) => (a ? { class: `axis-${a}` } : null);

/** 一覧の 1 件。折れ線は合計と区間ごとの長さ */
function measureItem(app: App, m: Measurement) {
  const del = h("button", { "aria-label": "この計測を消す", onclick: () => app.measure.remove(m.id) }, "×");
  const src = h("div", { class: "small muted" }, m.sources.map((s, i) => (m.snaps[i] ? `${s}（${m.snaps[i]}）` : s)).join(" → "));
  if (m.kind === "distance") {
    const s = m.segments[0];
    return h(
      "div",
      { class: "issue-item" },
      h("div", { class: "row" }, h("b", { class: "grow" }, h("span", axisStyle(s.axis), s.axis ? `${s.axis.toUpperCase()} 方向 ` : ""), fmtM(m.total)), del),
      s.axis ? null : h("div", { class: "small muted" }, `ΔX ${m.components.x.toFixed(3)}　ΔY ${m.components.y.toFixed(3)}　ΔZ ${m.components.z.toFixed(3)}`),
      src,
    );
  }
  return h(
    "div",
    { class: "issue-item" },
    h("div", { class: "row" }, h("b", { class: "grow" }, `折れ線 計 ${fmtM(m.total)}`), h("span", { class: "small muted" }, `${m.segments.length} 区間`), del),
    h("table", { class: "seg-table small" },
      m.segments.map((s, i) =>
        h("tr", null,
          h("td", { class: "muted" }, String(i + 1)),
          h("td", axisStyle(s.axis), s.axis ? s.axis.toUpperCase() : "—"),
          h("td", { class: "num" }, fmtM(s.length))))),
    h("div", { class: "small muted" }, `始点→終点 ΔX ${m.components.x.toFixed(3)}　ΔY ${m.components.y.toFixed(3)}　ΔZ ${m.components.z.toFixed(3)}`),
  );
}

/** 計測中の種類・軸の固定・スナップの切替と操作キーの案内 */
function measureOptions(app: App) {
  const kind = app.measure.kind;
  const lock = app.measureMode.axisLock;
  return h(
    "div",
    { class: "measure-opts" },
    h("div", { class: "row small", role: "group", "aria-label": "計測の種類" }, h("span", { class: "lbl" }, "種類"),
      ...(["distance", "polyline"] as const).map((k) =>
        h("button", {
          class: kind === k ? "active" : "",
          "aria-pressed": String(kind === k),
          title: k === "distance" ? "2 点をクリックして 1 本測る" : "点を続けてクリックし、区間ごとの長さと合計を測る（Enter・ダブルクリックで確定）",
          onclick: () => app.measureMode.setKind(k),
        }, MEASURE_KIND_LABEL[k]))),
    h("div", { class: "row small", role: "group", "aria-label": "軸の固定" }, h("span", { class: "lbl" }, "軸固定"),
      ...(["x", "y", "z"] as const).map((a) =>
        h("button", {
          class: `${lock === a ? "active" : ""} axis-${a}`,
          "aria-pressed": String(lock === a),
          title: `UCS（未設定なら WCS）の ${a.toUpperCase()} 方向だけを測る（${a.toUpperCase()} キー。もう一度で解除）`,
          onclick: () => app.measureMode.toggleAxisLock(a),
        }, a.toUpperCase())),
      h("span", { class: "muted" }, lock ? "" : "なし（軸に近づけると吸着）")),
    h("div", { class: "row small" }, h("span", { class: "lbl" }, "スナップ"),
      h("button", {
        class: app.snap.enabled ? "active" : "",
        "aria-pressed": String(app.snap.enabled),
        title: "点群・モデルの端点・辺・角と、X/Y/Z 軸に吸着する（S キー）",
        onclick: () => { app.snap.setEnabled(!app.snap.enabled); renderToolOptions(app); },
      }, app.snap.enabled ? "オン" : "オフ")),
  );
}

/** 3点合わせツールの右パネル（描くたびに 3 組そろっていれば解いて仮の配置にする） */
export function renderAlignPanel(app: App, el: HTMLElement, head: HTMLElement) {
  const align = app.align;
  const a = align.picks;
  const step = a.model.length + a.cloud.length;
  const next = step >= 6 ? null : align.needsModel ? `モデル上の点 ${a.model.length + 1}` : `点群上の対応する点 ${a.cloud.length + 1}`;
  const result = align.solve();
  app.setHint(next ? `3点合わせ: ${next} をクリック　Esc キャンセル` : "3点合わせ: 結果を確認して保存してください　Esc キャンセル");
  mount(
    el,
    head,
    h("p", { class: "small muted" }, "モデル上の点と、それに対応する点群上の点を交互に 3 組クリックします（柱の角・梁の端など、両方で同じ所が分かる点）。モデルを点群に重ねます。"),
    h("div", { class: "small" }, next ? `次: ${next} をクリック` : "結果を確認して保存してください"),
    h("div", { class: "row small" },
      h("button", { class: next?.startsWith("モデル") ? "active" : "", disabled: app.models.box().isEmpty(), title: "モデルの全体が見える所へ移動", onclick: () => app.focusBox(app.models.box()) }, "モデルへ移動"),
      h("button", { class: next?.startsWith("点群") ? "active" : "", disabled: !app.pc, title: "点群の全体が見える所へ移動", onclick: () => app.pc && app.focusBox(app.pc.boxDisplay) }, "点群へ移動")),
    h("ol", { class: "small" }, [0, 1, 2].map((i) => h("li", null, `モデル ${a.model[i] ? "✓" : "—"}　点群 ${a.cloud[i] ? "✓" : "—"}${result ? `　ずれ ${(result.errors[i] * 1000).toFixed(0)} mm` : ""}`))),
    h("label", { class: "row small" }, h("input", { type: "checkbox", checked: align.levelOnly, onchange: (e: Event) => align.setLevelOnly((e.target as HTMLInputElement).checked) }), "水平を保つ（Z 軸回りの回転と移動だけ）"),
    result ? h("div", { class: "small" }, `残差（RMS）${(result.residual * 1000).toFixed(1)} mm`) : null,
    h(
      "div",
      { class: "row" },
      h("button", { disabled: step === 0, onclick: () => align.undo() }, "1点戻す"),
      h("button", { onclick: () => align.reset() }, "やり直す"),
      h("button", { class: "primary", disabled: !result, onclick: async () => {
        if (!result || !app.current) return;
        await align.save(result);
        await showMessage("座標合わせを保存しました", "次にこの版を開いたときも、この合わせ方で表示します。");
      } }, "保存"),
    ),
  );
}
