import * as THREE from "three";
import type { App, Tool } from "../app";
import { formatCount } from "../data/dataset";
import { host } from "../host";
import { ColorMode, SizeMode } from "../pointcloud/material";
import { solveRigid } from "../tools/align";
import { MIN_BOX_SIZE } from "../tools/clipBoxEdit";
import { fmtM, MEASURE_KIND_LABEL, type Axis, type Measurement } from "../tools/measure";
import { $, h, mount, showMessage } from "./dom";
import { rangeSlider } from "./rangeSlider";

const BUDGETS = [500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000, 20_000_000];

/** 「レイヤー」タブ: 何を見ているか。点群・モデル（IFC クラス）ごとの表示・見せ方 */
export function renderLayers(app: App) {
  const el = $("#tab-layers");
  const pc = app.pc;
  const u = pc?.material.uniforms;
  const models = [...app.models.models.values()].filter((m) => m.role === "current");
  if (!app.current) {
    mount(el, h("p", { class: "muted" }, "現場を開くと、点群とモデルがここに並びます。"));
    return;
  }
  mount(
    el,
    h("h2", null, "点群"),
    pc
      ? h(
          "div",
          { class: "layer" },
          h("div", { class: "row" },
            h("label", { class: "row grow" }, h("input", { type: "checkbox", checked: pc.group.visible, onchange: (e: Event) => { pc.group.visible = (e.target as HTMLInputElement).checked; app.viewer.requestRender(); } }), h("b", null, "点群")),
            h("button", { title: "点群の全体が見える所へ移動（見る向きはそのまま）", onclick: () => app.focusBox(pc.boxDisplay) }, "移動")),
          h("div", { class: "row" }, h("label", null, "色"), h("select", { class: "grow", onchange: (e: Event) => app.setColorMode(Number((e.target as HTMLSelectElement).value)) },
            [[ColorMode.RGB, "RGB"], [ColorMode.Intensity, "強度"], [ColorMode.Height, "高さ"], [ColorMode.Solid, "単色"]].map(([v, l]) =>
              h("option", { value: String(v), selected: u!.uColorMode.value === v }, l as string)))),
          h("div", { class: "row" }, h("label", null, "点の大きさ"), h("input", { type: "range", min: "0.2", max: "4", step: "0.1", value: String(u!.uSize.value), class: "grow", "aria-label": "点の大きさ",
            oninput: (e: Event) => { pc.setPointSize(Number((e.target as HTMLInputElement).value)); app.viewer.requestRender(); } })),
          h("label", { class: "row" }, h("input", { type: "checkbox", checked: u!.uSizeMode.value === SizeMode.Adaptive, onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            pc.setSizeMode(on ? SizeMode.Adaptive : SizeMode.Fixed);
            pc.setPointSize(on ? 1 : 2);
            renderLayers(app);
            app.viewer.requestRender();
          } }), "大きさを自動調整（離れると小さく）"),
          h("div", { class: "row" }, h("label", null, "表示点数"), h("select", { class: "grow", "aria-label": "表示点数の上限", onchange: (e: Event) => app.setPointBudget(Number((e.target as HTMLSelectElement).value)) },
            BUDGETS.map((b) => h("option", { value: String(b), selected: b === app.pointBudget }, `${formatCount(b)} 点まで`)))),
          h("div", { class: "small muted", id: "pc-stats" }),
        )
      : h("p", { class: "muted" }, "点群はありません。"),
    h("h2", null, "モデル"),
    models.length === 0 ? h("p", { class: "muted" }, "モデルはありません。") : null,
    models.map((lm) =>
      h(
        "div",
        { class: "layer" },
        h("div", { class: "row" },
          h("label", { class: "row grow" }, h("input", { type: "checkbox", checked: lm.visible, onchange: async (e: Event) => { await app.models.setModelVisible(lm, (e.target as HTMLInputElement).checked); } }), h("b", null, lm.key)),
          h("button", { title: "このモデルの全体が見える所へ移動（見る向きはそのまま）", onclick: () => app.focusBox(app.models.boxOf(lm)) }, "移動")),
        h("div", { class: "row" }, h("label", null, "不透明度"), h("input", { type: "range", min: "0.1", max: "1", step: "0.05", value: String(lm.opacity), class: "grow", "aria-label": `${lm.key} の不透明度`,
          onchange: async (e: Event) => { await app.models.setModelOpacity(lm, Number((e.target as HTMLInputElement).value)); } })),
        h(
          "details",
          null,
          h("summary", { class: "small" }, `IFC クラス（${lm.categories.length}）`),
          h(
            "div",
            { class: "classes" },
            h("div", { class: "row small muted" }, h("span", { class: "grow" }, "クラス"), "表示", "半透明"),
            lm.categories.map((c) =>
              h(
                "div",
                { class: "row" },
                h("span", { class: "grow" }, c),
                h("input", { type: "checkbox", "aria-label": `${c} を表示`, checked: !lm.hiddenCategories.has(c), onchange: async (e: Event) => {
                  (e.target as HTMLInputElement).checked ? lm.hiddenCategories.delete(c) : lm.hiddenCategories.add(c);
                  await app.models.applyCategoryStates(lm);
                } }),
                h("input", { type: "checkbox", "aria-label": `${c} を半透明`, checked: lm.ghostCategories.has(c), onchange: async (e: Event) => {
                  (e.target as HTMLInputElement).checked ? lm.ghostCategories.add(c) : lm.ghostCategories.delete(c);
                  await app.models.applyCategoryStates(lm);
                } }),
              ),
            ),
          ),
        ),
      ),
    ),
    app.diff
      ? [
          h("h2", null, "差分"),
          h("label", { class: "row small" }, h("input", { type: "checkbox", checked: app.diffShown, onchange: (e: Event) => app.showDiff((e.target as HTMLInputElement).checked) }),
            "前の版との差分を色分け（追加=緑・変更=黄・削除=赤）"),
          h("div", { class: "small muted" }, "一覧は「差分」タブにあります。"),
        ]
      : null,
  );
  updatePcStats(app);
}

/** 3D 画面左上「目印」メニュー: 画面端の目印・原点・小地図の表示 */
export function renderNavMenu(app: App) {
  const item = (key: "markers" | "origins" | "minimap", label: string) =>
    h("label", { class: "menu-check", role: "menuitemcheckbox", "aria-checked": String(app.nav[key]) },
      h("input", { type: "checkbox", checked: app.nav[key], onchange: (e: Event) => app.setNav({ [key]: (e.target as HTMLInputElement).checked } as Record<typeof key, boolean>) }),
      label);
  mount(
    $("#nav-menu"),
    item("markers", "画面外・遠くの点群やモデルの方向を画面の端に出す"),
    item("origins", "WCS 原点・UCS 原点も目印に出す"),
    item("minimap", "小地図を出す"),
    h("p", { class: "small muted" }, "目印・小地図の点群やモデルを押すと、そこへ移動します。小地図の何も無い所を押すと、その場所へ平行移動します。"),
  );
}

export function updatePcStats(app: App) {
  const el = document.getElementById("pc-stats");
  const pc = app.pc;
  if (!el || !pc) return;
  el.textContent = `全 ${formatCount(pc.pointCount)} 点中 ${formatCount(pc.visiblePoints)} 点を表示（読込済み ${formatCount(pc.loadedPoints)} 点・ノード ${pc.visibleNodes.length}）`;
}

/** 右側: 選択した要素の属性 */
export function renderProps(app: App) {
  const el = $("#props");
  const sel = app.selection;
  if (!sel) {
    mount(el, h("h2", null, "属性"), h("p", { class: "small muted" }, app.current ? "モデル要素をクリックすると属性を表示します。" : "現場を開いてください。"));
    return;
  }
  const d = sel.data ?? {};
  const v = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const basic = Object.entries(d).filter(([k, x]) => !Array.isArray(x) && k !== "_localId");
  const psets: any[] = Array.isArray(d.IsDefinedBy) ? d.IsDefinedBy : [];
  const types: any[] = Array.isArray(d.IsTypedBy) ? d.IsTypedBy : [];
  const container: any[] = Array.isArray(d.ContainedInStructure) ? d.ContainedInStructure : [];
  const label: Record<string, string> = { _category: "IFC クラス", _guid: "GlobalId", Name: "名称", ObjectType: "タイプ", Tag: "タグ", Description: "説明", PredefinedType: "定義済みタイプ" };
  mount(
    el,
    h("h2", null, "属性"),
    h("div", { class: "small muted" }, `モデル ${sel.lm.key}`),
    h(
      "div",
      { class: "props" },
      h("table", null, basic.map(([k, x]) => h("tr", null, h("td", null, label[k] ?? k), h("td", null, String(v(x) ?? ""))))),
      container.length ? h("table", null, h("tr", null, h("td", null, "階"), h("td", null, container.map((c) => v(c.Name)).join("、")))) : null,
      types.length ? h("table", null, h("tr", null, h("td", null, "タイプ名"), h("td", null, types.map((c) => v(c.Name)).join("、")))) : null,
      psets.map((ps) => {
        const props: any[] = ps.HasProperties ?? ps.Quantities ?? [];
        return h(
          "details",
          { open: psets.length <= 3 },
          h("summary", null, String(v(ps.Name) ?? "Pset")),
          h("table", null, props.map((p) => {
            const val = v(p.NominalValue) ?? v(p.LengthValue) ?? v(p.AreaValue) ?? v(p.VolumeValue) ?? v(p.CountValue) ?? v(p.WeightValue) ?? "";
            return h("tr", null, h("td", null, String(v(p.Name) ?? "")), h("td", null, String(val)));
          })),
        );
      }),
    ),
  );
}

/** UCS（ユーザー座標系）の状態。設定済みなら「WCS に戻す」 */
function ucsStatus(app: App) {
  const f = app.frame;
  return f.isSet
    ? h("div", { class: "row small" },
        h("span", { class: "grow" }, `UCS 設定済み　X 軸の向き ${((Math.atan2(f.xAxis.y, f.xAxis.x) * 180) / Math.PI).toFixed(2)}°`),
        h("button", { class: "small", title: "UCS を解除し、WCS（ワールド座標系）で測る", onclick: () => app.resetFrame() }, "WCS に戻す"))
    : h("div", { class: "small muted" }, "WCS（ワールド座標系）で測ります。ツールバーの「UCS」で原点と X 軸の向きを決められます。");
}

/** 左「計測」タブ: 計測結果の一覧と、測る座標系（WCS / UCS） */
export function renderMeasureList(app: App) {
  const n = app.measure.list.length;
  $("#measure-count").textContent = n ? String(n) : "";
  mount(
    $("#tab-measures"),
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

const TOOL_TITLE: Record<Exclude<Tool, "select">, string> = { measure: "計測", origin: "UCS（ユーザー座標系）", issue: "指摘を登録", align: "3点合わせ" };

/**
 * 右側: いま何をしているか。選択ツールなら属性、ほかのツールならそのツールの設定と手順。
 * 切断を使っている間は、その設定を下に積む。
 */
export function renderRight(app: App) {
  const sel = app.tool === "select";
  $("#props").classList.toggle("hidden", !sel);
  const opts = $("#tool-opts");
  opts.classList.toggle("hidden", sel);
  if (sel) {
    opts.replaceChildren();
    renderProps(app);
  } else renderToolOptions(app);
  renderClipPanel(app);
}

/** 右側: 選んだツールの設定（選択ツールのときは何もしない） */
export function renderToolOptions(app: App) {
  const t = app.tool;
  if (t === "select") return;
  const el = $("#tool-opts");
  const head = h("div", { class: "row panel-head" },
    h("h2", { class: "grow" }, TOOL_TITLE[t]),
    h("button", { class: "small", title: "選択ツールに戻る（Esc）", onclick: () => { if (t === "align") app.resetAlign(); app.setTool("select"); } }, "終了"));
  if (t === "align") {
    renderAlignPanel(app, el, head);
    return;
  }
  if (t === "measure") {
    const last = app.measure.list[app.measure.list.length - 1];
    mount(
      el,
      head,
      measureOptions(app),
      last ? [h("h3", null, "直前の結果"), measureItem(app, last)] : null,
      h("p", { class: "small muted" }, "結果は左の「計測」タブに一覧します。キー操作は上の案内と「?」にあります。"),
    );
    return;
  }
  if (t === "origin") {
    mount(
      el,
      head,
      h("ol", { class: "small steps" },
        h("li", null, "UCS の原点にする点をクリック"),
        h("li", null, "X 軸の向きにする点をクリック（Esc で向きは変えずに終了）")),
      h("p", { class: "small muted" }, "Z 軸は常に鉛直上です。点群・モデルのどちらの点でも決められます。UCS は現場ごとにこの PC に保存します。"),
      ucsStatus(app),
    );
    return;
  }
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
  return h(
    "div",
    { class: "measure-opts" },
    h("div", { class: "row small", role: "group", "aria-label": "計測の種類" }, h("span", { class: "lbl" }, "種類"),
      ...(["distance", "polyline"] as const).map((k) =>
        h("button", {
          class: kind === k ? "active" : "",
          "aria-pressed": String(kind === k),
          title: k === "distance" ? "2 点をクリックして 1 本測る" : "点を続けてクリックし、区間ごとの長さと合計を測る（Enter・ダブルクリックで確定）",
          onclick: () => app.setMeasureKind(k),
        }, MEASURE_KIND_LABEL[k]))),
    h("div", { class: "row small", role: "group", "aria-label": "軸の固定" }, h("span", { class: "lbl" }, "軸固定"),
      ...(["x", "y", "z"] as const).map((a) =>
        h("button", {
          class: `${app.axisLock === a ? "active" : ""} axis-${a}`,
          "aria-pressed": String(app.axisLock === a),
          title: `UCS（未設定なら WCS）の ${a.toUpperCase()} 方向だけを測る（${a.toUpperCase()} キー。もう一度で解除）`,
          onclick: () => app.toggleAxisLock(a),
        }, a.toUpperCase())),
      h("span", { class: "muted" }, app.axisLock ? "" : "なし（軸に近づけると吸着）")),
    h("div", { class: "row small" }, h("span", { class: "lbl" }, "スナップ"),
      h("button", {
        class: app.snap.enabled ? "active" : "",
        "aria-pressed": String(app.snap.enabled),
        title: "点群・モデルの端点・辺・角と、X/Y/Z 軸に吸着する（S キー）",
        onclick: () => { app.snap.setEnabled(!app.snap.enabled); renderToolOptions(app); },
      }, app.snap.enabled ? "オン" : "オフ")),
  );
}

/** 切断パネルの値を、作り直さずに合わせる関数（スライダーをドラッグ中に DOM を作り直すと掴みが外れる） */
let panelSync: { key: string; sync: () => void } | null = null;

function panelKey(app: App): string {
  return `${app.clipping.mode}|${app.clipping.section.axis}|${app.clipping.extent.min.toArray()}|${app.clipping.extent.max.toArray()}`;
}

/**
 * 切断の値だけが変わったとき（スライダー・3D のドラッグ）に呼ぶ。
 * パネルの構成が同じなら値だけ合わせ、違えば作り直す。
 */
export function syncClipPanel(app: App) {
  if (panelSync && panelSync.key === panelKey(app)) panelSync.sync();
  else renderClipPanel(app);
}

/** 右側の下段: 切断ボックス・断面の設定（切断を使っている間だけ。ツールとは別に効き続ける） */
export function renderClipPanel(app: App) {
  const el = $("#clip-panel");
  const clip = app.clipping;
  panelSync = null;
  if (clip.mode === "none" || !app.current) {
    el.classList.add("hidden");
    el.replaceChildren();
    return;
  }
  const head = (title: string) =>
    h("div", { class: "row panel-head" }, h("h2", { class: "grow" }, title),
      h("button", { class: "small", title: "切断をやめて全体を表示する", onclick: () => clip.setMode("none") }, "切断なし"));
  el.classList.remove("hidden");
  const ext = clip.extent;
  const { lo, hi } = clip.limits();
  const step = 0.01;
  const slider = (label: string, value: number, min: number, max: number, set: (v: number) => void) =>
    h("div", { class: "row small" }, h("label", null, label), h("input", { type: "range", class: "grow", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label,
      oninput: (e: Event) => set(Number((e.target as HTMLInputElement).value)) }));
  if (clip.mode === "box") {
    const b = clip.box;
    const axes = ["x", "y", "z"] as const;
    const sliders = axes.map((a) =>
      rangeSlider({
        label: a.toUpperCase(),
        lo: lo[a],
        hi: hi[a],
        minGap: MIN_BOX_SIZE,
        get: () => ({ min: b.min[a], max: b.max[a] }),
        set: (min, max) => {
          b.min[a] = min;
          b.max[a] = max;
          clip.apply();
        },
        format: (min, max) => `幅 ${fmtM(max - min)}`,
      }),
    );
    panelSync = { key: panelKey(app), sync: () => sliders.forEach((s) => s.sync()) };
    mount(
      el,
      head("切断ボックス"),
      sliders.map((s) => s.el),
      h("label", { class: "row small" },
        h("input", { type: "checkbox", checked: app.clipEditor.enabled, onchange: (e: Event) => { app.clipEditor.enabled = (e.target as HTMLInputElement).checked; app.clipEditor.refresh(); } }),
        "3D で面をドラッグして動かす"),
      h("div", { class: "small muted" }, "手前の面はそのままドラッグ、奥の面（箱の内側）は Shift を押しながらドラッグ。箱の外をドラッグすると回転します。"),
      h("div", { class: "row" },
        h("button", { disabled: !app.lastPick, title: "最後にクリックした位置の周り 4m の箱にする", onclick: () => { if (app.lastPick) { clip.boxAround(app.lastPick.point, 2); renderClipPanel(app); } } }, "クリック位置の周り"),
        h("button", { title: "箱を全体の大きさに戻す", onclick: () => { clip.setBox(ext); renderClipPanel(app); } }, "範囲をリセット"),
        h("button", { title: "箱の全体が見える所へ移動", onclick: () => app.viewer.fit(clip.box.clone()) }, "箱へ移動"),
      ),
    );
  } else {
    const s = clip.section;
    const pos = slider("位置", s.position, lo[s.axis], hi[s.axis], (v) => clip.setSection({ position: v }));
    const posInput = pos.querySelector("input")!;
    const thickness = h("select", { onchange: (e: Event) => clip.setSection({ thickness: Number((e.target as HTMLSelectElement).value) }) },
      [[0, "片側を残す"], [0.05, "5 cm"], [0.1, "10 cm"], [0.3, "30 cm"], [1, "1 m"]].map(([v, l]) => h("option", { value: String(v), selected: s.thickness === v }, l as string)));
    const flip = h("input", { type: "checkbox", checked: s.flip, onchange: (e: Event) => clip.setSection({ flip: (e.target as HTMLInputElement).checked }) });
    panelSync = {
      key: panelKey(app),
      sync: () => {
        const cur = clip.section;
        if (Number(posInput.value) !== cur.position) posInput.value = String(cur.position);
        thickness.value = String(cur.thickness);
        flip.checked = cur.flip;
        updateSectionLabel(app);
      },
    };
    mount(
      el,
      head("断面"),
      h("div", { class: "row small" }, "向き",
        ...(["z", "x", "y"] as const).map((a) => h("button", { class: s.axis === a ? "active" : "", onclick: () => {
          const c = ext.getCenter(new THREE.Vector3());
          clip.setSection({ axis: a, position: c[a] });
          renderClipPanel(app);
        } }, a === "z" ? "水平" : `垂直（${a.toUpperCase()}）`))),
      pos,
      h("div", { class: "row small" }, h("label", null, "厚み"), thickness),
      h("label", { class: "row small" }, flip, "残す側を反対にする"),
      h("div", { class: "small muted", id: "section-label" }),
      h("div", { class: "row" },
        h("button", { disabled: !app.lastPick, title: "最後にクリックした位置を断面の位置にする", onclick: () => { if (app.lastPick) { clip.setSection({ position: app.lastPick.point[s.axis] }); renderClipPanel(app); } } }, "クリック位置に合わせる"),
        h("button", { title: "断面に向き合う視点に切り替える", onclick: () => app.viewer.setView(s.axis === "z" ? "top" : s.axis === "x" ? "right" : "front", app.viewBox()) }, "断面を正面から見る"),
      ),
    );
    updateSectionLabel(app);
  }
}

function updateSectionLabel(app: App) {
  const el = document.getElementById("section-label");
  const m = app.current;
  if (!el || !m) return;
  const s = app.clipping.section;
  const i = { x: 0, y: 1, z: 2 }[s.axis];
  el.textContent = `位置（WCS）${(s.position + m.origin[i]).toFixed(3)} m`;
}

/** 3点合わせの「水平を保つ」（パネルを作り直しても保つ） */
let alignLevelOnly = true;

function renderAlignPanel(app: App, el: HTMLElement, head: HTMLElement) {
  const a = app.align;
  const n = Math.min(a.model.length, a.cloud.length);
  const step = a.model.length + a.cloud.length;
  const next = step >= 6 ? null : a.model.length <= a.cloud.length ? `モデル上の点 ${a.model.length + 1}` : `点群上の対応する点 ${a.cloud.length + 1}`;
  let result: { matrix: THREE.Matrix4; residual: number; errors: number[] } | null = null;
  const levelOnly = alignLevelOnly;
  if (n >= 3 && app.current) {
    try {
      result = solveRigid(a.model.slice(0, n), a.cloud.slice(0, n), levelOnly);
      // 現在の合わせ A に対して、新しい A' = 解（IFC → 世界）
      app.alignPreview = result.matrix;
      app.applyPlacement(result.matrix);
    } catch (e) {
      console.warn(e);
    }
  }
  app.setHint(next ? `3点合わせ: ${next} をクリック` : "3点合わせ: 結果を確認して保存してください");
  mount(
    el,
    head,
    h("p", { class: "small muted" }, "モデル上の点と、それに対応する点群上の点を交互に 3 組クリックします（柱の角・梁の端など、両方で同じ所が分かる点）。モデルを点群に重ねます。"),
    h("div", { class: "small" }, next ? `次: ${next} をクリック` : "結果を確認して保存してください"),
    h("div", { class: "row small" },
      h("button", { class: next?.startsWith("モデル") ? "active" : "", disabled: app.models.box().isEmpty(), title: "モデルの全体が見える所へ移動", onclick: () => app.focusBox(app.models.box()) }, "モデルへ移動"),
      h("button", { class: next?.startsWith("点群") ? "active" : "", disabled: !app.pc, title: "点群の全体が見える所へ移動", onclick: () => app.pc && app.focusBox(app.pc.boxDisplay) }, "点群へ移動")),
    h("ol", { class: "small" }, [0, 1, 2].map((i) => h("li", null, `モデル ${a.model[i] ? "✓" : "—"}　点群 ${a.cloud[i] ? "✓" : "—"}${result ? `　ずれ ${(result.errors[i] * 1000).toFixed(0)} mm` : ""}`))),
    h("label", { class: "row small" }, h("input", { type: "checkbox", checked: levelOnly, onchange: (e: Event) => { alignLevelOnly = (e.target as HTMLInputElement).checked; renderAlignPanel(app, el, head); } }), "水平を保つ（Z 軸回りの回転と移動だけ）"),
    result ? h("div", { class: "small" }, `残差（RMS）${(result.residual * 1000).toFixed(1)} mm`) : null,
    h(
      "div",
      { class: "row" },
      h("button", { disabled: step === 0, onclick: () => app.undoAlignPick() }, "1点戻す"),
      h("button", { onclick: () => app.resetAlign() }, "やり直す"),
      h("button", { class: "primary", disabled: !result, onclick: async () => {
        if (!result || !app.current) return;
        const m = app.current;
        const updated = await host.updateAlignment(m.folder, {
          method: "threePoint",
          matrix: result.matrix.toArray(),
          residual: result.residual,
          levelOnly,
          pairs: a.model.slice(0, n).map((p, i) => ({ model: p.toArray(), cloud: a.cloud[i].toArray() })),
        });
        Object.assign(m, { alignment: updated.alignment, alignmentHistory: updated.alignmentHistory });
        await app.refreshDatasets();
        app.resetAlign();
        app.setTool("select");
        await showMessage("座標合わせを保存しました", "次にこの版を開いたときも、この合わせ方で表示します。");
      } }, "保存"),
    ),
  );
}
