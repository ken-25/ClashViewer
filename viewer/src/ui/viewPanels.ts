import * as THREE from "three";
import type { App, Tool } from "../app";
import { formatCount } from "../data/dataset";
import { host } from "../host";
import { hasState, NO_STOREY, setState, type StoreyNode } from "../model/layerTree";
import type { LoadedModel } from "../model/models";
import { ColorMode, SizeMode } from "../pointcloud/material";
import { solveRigid } from "../tools/align";
import { MIN_BOX_SIZE } from "../tools/clipBoxEdit";
import type { Section } from "../tools/clipping";
import { fmtM, MEASURE_KIND_LABEL, type Axis, type Measurement } from "../tools/measure";
import { $, h, mount, showMessage } from "./dom";
import { rangeSlider } from "./rangeSlider";

const BUDGETS = [500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000, 20_000_000];

/** 行の右端に並べるアイコン（表示 / 半透明 / 移動）。SVG は currentColor で描く */
const ICONS = {
  eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" opacity=".45"/><path d="M2.5 13.5l11-11"/>',
  ghost: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
  move: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
} as const;

function icon(name: keyof typeof ICONS) {
  const s = h("span", { class: "ico", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">${ICONS[name]}</svg>`;
  return s;
}

const storeyCount = (lm: LoadedModel) => lm.storeys.filter((s) => s.key !== NO_STOREY).length;

/** 開いている行（作り直しても開いたままにする） */
const expanded = new Set<string>(["pc", "models"]);

interface RowSpec {
  key: string; // 開閉とフォーカスを戻すための識別子
  level: number;
  label: string;
  count?: string;
  /** 表示中か。null なら表示ボタンを出さない */
  shown: boolean | null;
  /** 親（モデル・階）が隠れているので、この行も見えていない */
  dimmed?: boolean;
  ghost: boolean | null;
  onShow?: (on: boolean) => void;
  onGhost?: (on: boolean) => void;
  onMove?: () => void;
  moveTitle?: string;
  /** 開くと出る中身。無ければ開閉の三角を出さない */
  body?: () => (Node | null)[];
}

/**
 * レイヤーの 1 行。点群・モデル・階・クラスを同じ形にそろえる:
 * [開閉] 名前 件数 [表示] [半透明] [移動]
 */
function layerRow(app: App, r: RowSpec): HTMLElement {
  const open = !!r.body && expanded.has(r.key);
  const toggle = r.body
    ? h("button", { class: "twisty", "aria-expanded": String(open), "aria-label": `${r.label} を${open ? "閉じる" : "開く"}`, "data-focus": `${r.key}:twisty`,
        onclick: () => { open ? expanded.delete(r.key) : expanded.add(r.key); renderLayers(app); } }, open ? "▾" : "▸")
    : h("span", { class: "twisty" });
  const btn = (kind: string, on: boolean | null, ico: keyof typeof ICONS, title: string, act?: (on: boolean) => void) =>
    on === null || !act
      ? h("span", { class: "ico-btn placeholder" })
      : h("button", { class: `ico-btn${on ? " on" : ""}`, "aria-pressed": String(on), title, "aria-label": `${r.label}: ${title}`, "data-focus": `${r.key}:${kind}`,
          onclick: () => act(!on) }, icon(ico));
  const row = h(
    "div",
    { class: `layer-row lv${r.level}${r.shown === false || r.dimmed ? " off" : ""}`, role: "treeitem", "aria-level": String(r.level + 1), "aria-expanded": r.body ? String(open) : undefined },
    toggle,
    h("span", { class: "name", title: r.label }, r.label),
    r.count ? h("span", { class: "count" }, r.count) : null,
    btn("show", r.shown, r.shown === false ? "eyeOff" : "eye", r.shown === false ? "表示する" : "隠す", r.onShow),
    btn("ghost", r.ghost, "ghost", r.ghost ? "半透明をやめる" : "半透明にする", r.onGhost),
    r.onMove ? h("button", { class: "ico-btn", title: r.moveTitle ?? "全体が見える所へ移動", "aria-label": `${r.label}: ${r.moveTitle ?? "移動"}`, "data-focus": `${r.key}:move`, onclick: r.onMove }, icon("move")) : h("span", { class: "ico-btn placeholder" }),
  );
  if (!open) return row;
  return h("div", { class: "layer-node", role: "group" }, row, h("div", { class: `layer-body lv${r.level}` }, r.body!()));
}

/** 点群の行の中身（色・大きさ・表示点数） */
function pointCloudBody(app: App): Node[] {
  const pc = app.pc!;
  const u = pc.material.uniforms;
  return [
    h("div", { class: "row" }, h("label", null, "色"), h("select", { class: "grow", onchange: (e: Event) => app.setColorMode(Number((e.target as HTMLSelectElement).value)) },
      [[ColorMode.RGB, "RGB"], [ColorMode.Intensity, "強度"], [ColorMode.Height, "高さ"], [ColorMode.Solid, "単色"]].map(([v, l]) =>
        h("option", { value: String(v), selected: u.uColorMode.value === v }, l as string)))),
    h("div", { class: "row" }, h("label", null, "点の大きさ"), h("input", { type: "range", min: "0.2", max: "4", step: "0.1", value: String(u.uSize.value), class: "grow", "aria-label": "点の大きさ",
      oninput: (e: Event) => { pc.setPointSize(Number((e.target as HTMLInputElement).value)); app.viewer.requestRender(); } })),
    h("label", { class: "row" }, h("input", { type: "checkbox", checked: u.uSizeMode.value === SizeMode.Adaptive, onchange: (e: Event) => {
      const on = (e.target as HTMLInputElement).checked;
      pc.setSizeMode(on ? SizeMode.Adaptive : SizeMode.Fixed);
      pc.setPointSize(on ? 1 : 2);
      renderLayers(app);
      app.viewer.requestRender();
    } }), "大きさを自動調整（離れると小さく）"),
    h("div", { class: "row" }, h("label", null, "表示点数"), h("select", { class: "grow", "aria-label": "表示点数の上限", onchange: (e: Event) => app.setPointBudget(Number((e.target as HTMLSelectElement).value)) },
      BUDGETS.map((b) => h("option", { value: String(b), selected: b === app.pointBudget }, `${formatCount(b)} 点まで`)))),
    h("div", { class: "small muted", id: "pc-stats" }),
  ];
}

/** モデルの行の中身（不透明度と、階 → クラスのツリー） */
function modelBody(app: App, lm: LoadedModel): (Node | null)[] {
  const apply = async () => {
    renderLayers(app);
    await app.models.applyCategoryStates(lm);
  };
  const moveTo = async (ids: number[]) => app.focusBox(await app.models.boxOfIds(lm, ids));
  const single = lm.storeys.length === 1 && lm.storeys[0].key === NO_STOREY;
  const classRows = (s: StoreyNode, level: number, storeyHidden: boolean) =>
    s.classes.map((c) => {
      const hidden = hasState(lm.hiddenKeys, s.key, c.name);
      return layerRow(app, {
        key: `${lm.key}|${s.key}|${c.name}`,
        level,
        label: c.name,
        count: formatCount(c.ids.length),
        shown: !hidden,
        dimmed: !lm.visible || storeyHidden,
        ghost: hasState(lm.ghostKeys, s.key, c.name),
        onShow: (on) => { setState(lm.hiddenKeys, lm.storeys, !on, s.key, c.name); void apply(); },
        onGhost: (on) => { setState(lm.ghostKeys, lm.storeys, on, s.key, c.name); void apply(); },
        onMove: () => void moveTo(c.ids),
        moveTitle: "このクラスの全体が見える所へ移動",
      });
    });
  return [
    h("div", { class: "row small" }, h("label", null, "不透明度"), h("input", { type: "range", min: "0.1", max: "1", step: "0.05", value: String(lm.opacity), class: "grow", "aria-label": `${lm.key} の不透明度`,
      onchange: async (e: Event) => { await app.models.setModelOpacity(lm, Number((e.target as HTMLInputElement).value)); } })),
    lm.storeys.length === 0 ? h("p", { class: "small muted" }, "要素がありません。") : null,
    ...(single
      ? classRows(lm.storeys[0], 2, false)
      : lm.storeys.map((s) => {
          const hidden = hasState(lm.hiddenKeys, s.key);
          return layerRow(app, {
            key: `${lm.key}|${s.key}`,
            level: 2,
            label: s.name,
            count: s.elevation !== null ? `${s.elevation >= 0 ? "+" : ""}${s.elevation.toFixed(2)}` : undefined,
            shown: !hidden,
            dimmed: !lm.visible,
            ghost: hasState(lm.ghostKeys, s.key),
            onShow: (on) => { setState(lm.hiddenKeys, lm.storeys, !on, s.key); void apply(); },
            onGhost: (on) => { setState(lm.ghostKeys, lm.storeys, on, s.key); void apply(); },
            onMove: () => void moveTo(s.ids),
            moveTitle: "この階の全体が見える所へ移動",
            body: () => classRows(s, 3, hidden),
          });
        })),
  ];
}

/** 「レイヤー」タブ: 何を見ているか。点群・モデル（階 → IFC クラス）ごとの表示・見せ方 */
export function renderLayers(app: App) {
  const el = $("#tab-layers");
  const pc = app.pc;
  const models = [...app.models.models.values()].filter((m) => m.role === "current");
  if (!app.current) {
    mount(el, h("p", { class: "muted" }, "プロジェクトを開くと、点群とモデルがここに並びます。"));
    return;
  }
  // 作り直してもキーボードのフォーカスを同じボタンに戻す
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#tab-layers [data-focus]")?.dataset.focus;
  mount(
    el,
    h(
      "div",
      { class: "layer-tree", role: "tree", "aria-label": "レイヤー" },
      h("div", { class: "layer-head small muted" }, h("span", { class: "grow" }, "名前"), h("span", { class: "ico-btn placeholder" }, "表示"), h("span", { class: "ico-btn placeholder" }, "半透明"), h("span", { class: "ico-btn placeholder" }, "移動")),
      pc
        ? layerRow(app, {
            key: "pc",
            level: 0,
            label: "点群",
            count: formatCount(pc.pointCount),
            shown: pc.group.visible,
            ghost: null,
            onShow: (on) => { pc.group.visible = on; app.viewer.requestRender(); renderLayers(app); },
            onMove: () => app.focusBox(pc.boxDisplay),
            moveTitle: "点群の全体が見える所へ移動（見る向きはそのまま）",
            body: () => pointCloudBody(app),
          })
        : h("p", { class: "small muted" }, "点群はありません。"),
      models.length === 0 ? h("p", { class: "small muted" }, "モデルはありません。") : null,
      models.map((lm) =>
        layerRow(app, {
          key: lm.key,
          level: 0,
          label: lm.key,
          count: storeyCount(lm) ? `${storeyCount(lm)} 階` : undefined,
          shown: lm.visible,
          ghost: lm.opacity < 0.999,
          onShow: async (on) => { await app.models.setModelVisible(lm, on); renderLayers(app); },
          onGhost: async (on) => { await app.models.setModelOpacity(lm, on ? 0.3 : 1); renderLayers(app); },
          onMove: () => app.focusBox(app.models.boxOf(lm)),
          moveTitle: "このモデルの全体が見える所へ移動（見る向きはそのまま）",
          body: () => modelBody(app, lm),
        }),
      ),
    ),
    // 差分の色分けは「差分」タブ（成果）にまとめる。色分け中だけ、ここにも状態を出す
    app.diffShown ? h("p", { class: "small muted" }, "前の版との差分を色分けしています（切替は「差分」タブ）。") : null,
  );
  if (focused) el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
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
    mount(el, h("h2", null, "属性"), h("p", { class: "small muted" }, app.current ? "モデル要素をクリックすると属性を表示します。" : app.isLoadingView ? "" : "プロジェクトを開いてください。"));
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

const TOOL_TITLE: Record<Exclude<Tool, "select">, string> = { measure: "計測", origin: "UCS（ユーザー座標系）", issue: "指摘を登録", align: "3点合わせ", plane: "面に合わせて断面を追加" };

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
  updateRightStrip(app);
}

/** 右パネルを折りたたんだときの帯に、いま右に出ている内容の名前を出す */
function updateRightStrip(app: App) {
  const el = document.getElementById("right-strip-label");
  if (!el) return;
  const parts = [app.tool === "select" ? "属性" : TOOL_TITLE[app.tool]];
  if (app.current && (app.clipping.boxOn || app.clipping.sections.length > 0)) parts.push("切断");
  el.textContent = parts.join("・");
}

/** 右側: 選んだツールの設定（選択ツールのときは何もしない） */
export function renderToolOptions(app: App) {
  const t = app.tool;
  if (t === "select") return;
  const el = $("#tool-opts");
  const head = h("div", { class: "row panel-head" },
    h("h2", { class: "grow" }, TOOL_TITLE[t]),
    // 途中の作業を捨てるツール（3点合わせ・断面の追加）は「キャンセル」、結果が残るツールは「終了」
    h("button", { class: "small", title: "選択ツールに戻る（Esc）", onclick: () => { if (t === "align") app.resetAlign(); app.setTool("select"); } }, t === "plane" || t === "align" ? "キャンセル" : "終了"));
  if (t === "plane") {
    const method = app.planeMethod;
    mount(
      el,
      head,
      h("div", { class: "row small", role: "group", "aria-label": "断面の決め方" }, h("span", { class: "lbl" }, "決め方"),
        ...(["face", "points"] as const).map((m) =>
          h("button", {
            class: method === m ? "active" : "",
            "aria-pressed": String(method === m),
            title: m === "face" ? "モデルの面、または点群の平らな所を 1 回クリック" : "面の上の 3 点をクリック（点群・モデルの角や端に吸着）",
            onclick: () => app.setPlaneMethod(m),
          }, m === "face" ? "面から" : "3点"))),
      method === "face"
        ? h("ol", { class: "small steps" },
            h("li", null, "切断面にしたい面（斜めの壁・屋根・配管の側面など）をクリック。モデルの面でも、点群の平らな所でも使えます"),
            h("li", null, "その面に平行な切断面ができます"))
        : h("ol", { class: "small steps" },
            [0, 1, 2].map((i) => h("li", { class: app.planePts.length === i ? "" : "muted" }, `${i + 1}点目${app.planePts[i] ? " ✓" : ""}`))),
      h("p", { class: "small muted" }, method === "face"
        ? "点群の角・縁など平らでない所をクリックすると、3点指定に切り替わり、その点を 1点目にします。"
        : "3 点を通る面で切ります。Backspace で 1 点戻せます。"),
      h("p", { class: "small muted" }, "クリックした側（カメラ側）を消します。位置・残す側は、できた断面を下の「切断」で調整します。"),
    );
    return;
  }
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
      h("p", { class: "small muted" }, "Z 軸は常に鉛直上です。点群・モデルのどちらの点でも決められます。UCS はプロジェクトごとにこの PC に保存します。"),
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
  const c = app.clipping;
  // 断面は位置（offset）以外が変わったら作り直す（offset はスライダー・3D のドラッグで動くので値だけ合わせる）
  const secs = c.sections.map((p) => `${p.id}:${p.enabled}:${p.flip}:${p.thickness}`).join(",");
  return `${c.boxOn}|${c.extent.min.toArray()}|${c.extent.max.toArray()}|${c.showGuides}|${app.tool === "select"}|${secs}`;
}

/**
 * 切断の値だけが変わったとき（スライダー・3D のドラッグ）に呼ぶ。
 * パネルの構成が同じなら値だけ合わせ、違えば作り直す。
 */
export function syncClipPanel(app: App) {
  if (panelSync && panelSync.key === panelKey(app)) panelSync.sync();
  else renderClipPanel(app);
}

/**
 * 右側の下段: 今ある切断（切断ボックス・断面）の調整だけ。切断を使っている間だけ出す。
 * 足す・すべてオフ・枠の表示は 3D 画面左上の「切断」メニューにまとめ、ここには置かない。
 */
export function renderClipPanel(app: App) {
  const el = $("#clip-panel");
  const clip = app.clipping;
  panelSync = null;
  updateRightStrip(app);
  if ((!clip.boxOn && clip.sections.length === 0) || !app.current) {
    el.classList.add("hidden");
    el.replaceChildren();
    return;
  }
  el.classList.remove("hidden");
  const syncs: (() => void)[] = [];
  const blocks: HTMLElement[] = [];
  if (clip.boxOn) {
    const box = renderBoxBlock(app);
    syncs.push(box.sync);
    blocks.push(box.el);
  }
  for (const s of clip.sections) {
    const b = renderSectionBlock(app, s);
    syncs.push(b.sync);
    blocks.push(b.el);
  }
  panelSync = { key: panelKey(app), sync: () => syncs.forEach((f) => f()) };
  mount(
    el,
    h("h2", null, "切断"),
    blocks,
    clip.showGuides
      ? h("p", { class: "small muted" }, "3D 画面でも動かせます: 箱の面をドラッグ（奥の面は Shift+ドラッグ）、断面の四角をドラッグするとレールに沿って動きます。")
      : h("p", { class: "small muted" }, "枠を隠しています。切断は効いたままです（B か「切断」メニューで表示）。"),
  );
}

function renderBoxBlock(app: App): { el: HTMLElement; sync: () => void } {
  const clip = app.clipping;
  const { lo, hi } = clip.limits();
  const b = clip.box;
  const sliders = (["x", "y", "z"] as const).map((a) =>
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
  const el = h("div", { class: "clip-block" },
    h("div", { class: "row panel-head" }, h("h3", { class: "grow" }, "切断ボックス"),
      h("button", { "aria-label": "切断ボックスをオフにする", title: "切断ボックスをオフにする（範囲は覚えておきます。「切断」メニューで戻せます）", onclick: () => clip.setBoxOn(false) }, "×")),
    sliders.map((s) => s.el),
    h("div", { class: "row" },
      h("button", { disabled: !app.lastPick, title: "最後にクリックした位置の周り 4m の箱にする", onclick: () => { if (app.lastPick) clip.boxAround(app.lastPick.point, 2); } }, "クリック位置の周り"),
      h("button", { title: "箱を全体の大きさに戻す", onclick: () => clip.setBox(clip.extent) }, "範囲をリセット"),
      h("button", { title: "箱の全体が見える所へ移動", onclick: () => app.viewer.fit(clip.box.clone()) }, "箱へ移動"),
    ),
  );
  return { el, sync: () => sliders.forEach((s) => s.sync()) };
}

const THICKNESS: [number, string][] = [[0, "片側を残す"], [0.05, "5 cm"], [0.1, "10 cm"], [0.3, "30 cm"], [1, "1 m"]];

/** 断面 1 つ: オン・オフ、向き、位置、厚み、残す側、削除 */
function renderSectionBlock(app: App, s: Section): { el: HTMLElement; sync: () => void } {
  const clip = app.clipping;
  const off = !s.enabled;
  const { lo, hi } = clip.sectionRange(s);
  const pos = h("input", { type: "range", class: "grow", min: String(lo), max: String(hi), step: "0.01", value: String(s.offset), disabled: off, "aria-label": `${s.name} の位置`,
    oninput: (e: Event) => clip.updateSection(s.id, { offset: Number((e.target as HTMLInputElement).value) }) });
  const posLabel = h("span", { class: "small muted num" });
  const sync = () => {
    if (Number(pos.value) !== s.offset) pos.value = String(s.offset);
    // 水平・垂直は座標（WCS / UCS）、面に合わせた断面は作ったときの面からのずれ
    posLabel.textContent = s.coord
      ? `${s.coord.space} ${s.coord.axis.toUpperCase()} ${(s.coord.base + s.offset).toFixed(3)} m`
      : `${s.offset >= 0 ? "+" : ""}${s.offset.toFixed(3)} m`;
  };
  sync();
  // 断面に向き合う: 消している側（法線側。flip なら逆側）から見る
  const moveFront = () => {
    const dir = s.normal.clone().multiplyScalar(s.flip ? -1 : 1);
    // 真上・真下から見るときは、カメラの上向きが決まるように少しだけ傾ける（視点の「平面」と同じ）
    if (Math.abs(dir.z) > 0.9999) dir.y -= 0.0001;
    const o = clip.sectionOrigin(s);
    const box = app.viewBox();
    app.viewer.fit(box.isEmpty() ? new THREE.Box3(o, o.clone()).expandByScalar(5) : box, dir);
  };
  const toPick = () => {
    if (app.lastPick) clip.updateSection(s.id, { offset: app.lastPick.point.clone().sub(s.point).dot(s.normal) });
  };
  const el = h("div", { class: `clip-block${off ? " muted" : ""}` },
    h("div", { class: "row panel-head" },
      h("label", { class: "row grow", title: "この断面を効かせる" },
        h("input", { type: "checkbox", checked: s.enabled, onchange: (e: Event) => clip.updateSection(s.id, { enabled: (e.target as HTMLInputElement).checked }) }),
        h("h3", null, s.name)),
      h("span", { class: "small muted", title: "断面の向き" }, s.label ?? normalLabel(s.normal)),
      h("button", { "aria-label": `${s.name} を消す`, title: "この断面を消す", onclick: () => clip.removeSection(s.id) }, "×")),
    h("div", { class: "row small" }, h("label", null, "位置"), pos, posLabel),
    h("div", { class: "row small" }, h("label", null, "厚み"),
      h("select", { disabled: off, "aria-label": `${s.name} の厚み`, onchange: (e: Event) => clip.updateSection(s.id, { thickness: Number((e.target as HTMLSelectElement).value) }) },
        THICKNESS.map(([v, l]) => h("option", { value: String(v), selected: s.thickness === v }, l))),
      h("label", { class: "row" },
        h("input", { type: "checkbox", checked: s.flip, disabled: off, onchange: (e: Event) => clip.updateSection(s.id, { flip: (e.target as HTMLInputElement).checked }) }),
        "残す側を反対に")),
    h("div", { class: "row small" },
      h("button", { class: "small", disabled: off || !app.lastPick, title: "最後にクリックした位置を通るように動かす", onclick: toPick }, "クリック位置に合わせる"),
      h("button", { class: "small", disabled: off, title: "断面に向き合う視点へ移動", onclick: moveFront }, "正面へ移動")),
  );
  return { el, sync };
}

/** 面に合わせた断面の向きを短く（水平・鉛直は分かりやすく、それ以外は傾きと方位） */
function normalLabel(n: THREE.Vector3): string {
  const tilt = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(n.z))));
  if (tilt < 0.05) return "水平";
  const az = (THREE.MathUtils.radToDeg(Math.atan2(n.y, n.x)) + 360) % 360;
  if (Math.abs(tilt - 90) < 0.05) return `鉛直・方位 ${az.toFixed(1)}°`;
  return `傾き ${tilt.toFixed(1)}°・方位 ${az.toFixed(1)}°`;
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
