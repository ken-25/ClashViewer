import * as THREE from "three";
import type { App } from "../app";
import { formatCount } from "../data/dataset";
import { host } from "../host";
import { ColorMode, SizeMode } from "../pointcloud/material";
import { solveRigid } from "../tools/align";
import { fmtM } from "../tools/measure";
import { $, h, mount, showMessage } from "./dom";

const BUDGETS = [500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000, 20_000_000];

/** 「表示」タブ: 点群の見せ方、モデル・IFC クラスの表示切替 */
export function renderDisplay(app: App) {
  const el = $("#tab-display");
  const pc = app.pc;
  const u = pc?.material.uniforms;
  const models = [...app.models.models.values()].filter((m) => m.role === "current");
  mount(
    el,
    h("h2", null, "点群"),
    pc
      ? h(
          "div",
          { class: "layer" },
          h("label", { class: "row" }, h("input", { type: "checkbox", checked: pc.group.visible, onchange: (e: Event) => { pc.group.visible = (e.target as HTMLInputElement).checked; app.viewer.requestRender(); } }), "表示"),
          h("div", { class: "row" }, h("label", null, "色"), h("select", { class: "grow", onchange: (e: Event) => app.setColorMode(Number((e.target as HTMLSelectElement).value)) },
            [[ColorMode.RGB, "RGB"], [ColorMode.Intensity, "強度"], [ColorMode.Height, "高さ"], [ColorMode.Solid, "単色"]].map(([v, l]) =>
              h("option", { value: String(v), selected: u!.uColorMode.value === v }, l as string)))),
          h("div", { class: "row" }, h("label", null, "点の大きさ"), h("input", { type: "range", min: "0.2", max: "4", step: "0.1", value: String(u!.uSize.value), class: "grow", "aria-label": "点の大きさ",
            oninput: (e: Event) => { pc.setPointSize(Number((e.target as HTMLInputElement).value)); app.viewer.requestRender(); } })),
          h("label", { class: "row" }, h("input", { type: "checkbox", checked: u!.uSizeMode.value === SizeMode.Adaptive, onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            pc.setSizeMode(on ? SizeMode.Adaptive : SizeMode.Fixed);
            pc.setPointSize(on ? 1 : 2);
            renderDisplay(app);
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
        h("label", { class: "row" }, h("input", { type: "checkbox", checked: lm.visible, onchange: async (e: Event) => { await app.models.setModelVisible(lm, (e.target as HTMLInputElement).checked); } }), h("b", null, lm.key)),
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
  );
  updatePcStats(app);
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
    mount(el, h("h2", null, "属性"), h("p", { class: "muted" }, "モデル要素をクリックすると属性を表示します。"));
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

/** 右側: 計測結果と局所座標系 */
export function renderMeasures(app: App) {
  const el = $("#measures");
  const f = app.frame;
  mount(
    el,
    h("h2", null, "原点（局所座標）"),
    f.isSet
      ? h("div", { class: "small" }, `設定済み　X 軸の向き ${((Math.atan2(f.xAxis.y, f.xAxis.x) * 180) / Math.PI).toFixed(2)}°`, " ", h("button", { onclick: () => app.resetFrame() }, "解除"))
      : h("div", { class: "small muted" }, "未設定（世界座標の向きで測ります）。「原点設定」で決められます。"),
    h("h2", null, `計測（${app.measure.list.length}）`),
    app.tool === "ortho"
      ? h("div", { class: "row small" }, "方向", ...(["auto", "x", "y", "z"] as const).map((a) =>
          h("button", { class: app.orthoAxis === a ? "active" : "", onclick: () => { app.orthoAxis = a; renderMeasures(app); } }, a === "auto" ? "自動" : a.toUpperCase())))
      : null,
    app.measure.list.length === 0 ? h("p", { class: "small muted" }, "「計測」「直交計測」で 2 点をクリックします。") : null,
    app.measure.list
      .slice()
      .reverse()
      .map((m) =>
        h(
          "div",
          { class: "issue-item" },
          h("div", { class: "row" }, h("b", { class: "grow" }, `${m.ortho ? `${m.ortho.toUpperCase()} 方向 ` : ""}${fmtM(m.distance)}`), h("button", { "aria-label": "この計測を消す", onclick: () => app.measure.remove(m.id) }, "×")),
          h("div", { class: "small muted" }, `ΔX ${m.components.x.toFixed(3)}　ΔY ${m.components.y.toFixed(3)}　ΔZ ${m.components.z.toFixed(3)}`),
          h("div", { class: "small muted" }, `${m.sources[0]} → ${m.sources[1]}`),
        ),
      ),
    app.measure.list.length ? h("button", { onclick: () => app.measure.clear() }, "すべて消す") : null,
  );
}

/** 画面右上のツールパネル（切断・3点合わせ） */
export function renderToolPanel(app: App) {
  const el = $("#tool-panel");
  const clip = app.clipping;
  if (app.tool === "align") {
    renderAlignPanel(app, el);
    el.classList.remove("hidden");
    return;
  }
  if (clip.mode === "none") {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const ext = clip.extent;
  const pad = ext.getSize(new THREE.Vector3()).multiplyScalar(0.05);
  const lo = ext.min.clone().sub(pad);
  const hi = ext.max.clone().add(pad);
  const step = 0.01;
  const slider = (label: string, value: number, min: number, max: number, set: (v: number) => void) =>
    h("div", { class: "row small" }, h("label", null, label), h("input", { type: "range", class: "grow", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label,
      oninput: (e: Event) => set(Number((e.target as HTMLInputElement).value)) }));
  if (clip.mode === "box") {
    const b = clip.box;
    const axes = ["x", "y", "z"] as const;
    mount(
      el,
      h("h3", null, "切断ボックス"),
      axes.map((a) => [
        slider(`${a.toUpperCase()} 最小`, b.min[a], lo[a], hi[a], (v) => { b.min[a] = Math.min(v, b.max[a] - 0.01); clip.apply(); }),
        slider(`${a.toUpperCase()} 最大`, b.max[a], lo[a], hi[a], (v) => { b.max[a] = Math.max(v, b.min[a] + 0.01); clip.apply(); }),
      ]),
      h("div", { class: "row" },
        h("button", { disabled: !app.lastPick, title: "最後にクリックした位置の周り 4m の箱", onclick: () => { if (app.lastPick) { clip.boxAround(app.lastPick.point, 2); renderToolPanel(app); } } }, "選択位置の周り"),
        h("button", { onclick: () => { clip.setBox(ext); renderToolPanel(app); } }, "全体に戻す"),
        h("button", { onclick: () => app.viewer.fit(clip.box.clone()) }, "箱に寄る"),
      ),
    );
  } else {
    const s = clip.section;
    mount(
      el,
      h("h3", null, "断面"),
      h("div", { class: "row small" }, "向き",
        ...(["z", "x", "y"] as const).map((a) => h("button", { class: s.axis === a ? "active" : "", onclick: () => {
          const c = ext.getCenter(new THREE.Vector3());
          clip.setSection({ axis: a, position: c[a] });
          renderToolPanel(app);
        } }, a === "z" ? "水平" : `垂直（${a.toUpperCase()}）`))),
      slider("位置", s.position, lo[s.axis], hi[s.axis], (v) => { clip.setSection({ position: v }); updateSectionLabel(app); }),
      h("div", { class: "row small" }, h("label", null, "厚み"), h("select", { onchange: (e: Event) => clip.setSection({ thickness: Number((e.target as HTMLSelectElement).value) }) },
        [[0, "片側を残す"], [0.05, "5 cm"], [0.1, "10 cm"], [0.3, "30 cm"], [1, "1 m"]].map(([v, l]) => h("option", { value: String(v), selected: s.thickness === v }, l as string)))),
      h("label", { class: "row small" }, h("input", { type: "checkbox", checked: s.flip, onchange: (e: Event) => clip.setSection({ flip: (e.target as HTMLInputElement).checked }) }), "残す側を反対にする"),
      h("div", { class: "small muted", id: "section-label" }),
      h("div", { class: "row" },
        h("button", { disabled: !app.lastPick, onclick: () => { if (app.lastPick) { clip.setSection({ position: app.lastPick.point[s.axis] }); renderToolPanel(app); } } }, "選択位置に合わせる"),
        h("button", { onclick: () => app.viewer.setView(s.axis === "z" ? "top" : s.axis === "x" ? "side" : "front", app.sceneBox()) }, "断面に正対"),
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
  el.textContent = `位置（世界座標）${(s.position + m.origin[i]).toFixed(3)} m`;
}

function renderAlignPanel(app: App, el: HTMLElement) {
  const a = app.align;
  const n = Math.min(a.model.length, a.cloud.length);
  const step = a.model.length + a.cloud.length;
  const next = step >= 6 ? null : a.model.length <= a.cloud.length ? `モデル上の点 ${a.model.length + 1}` : `点群上の対応する点 ${a.cloud.length + 1}`;
  let result: { matrix: THREE.Matrix4; residual: number; errors: number[] } | null = null;
  const levelOnly = (el.dataset.level ?? "1") === "1";
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
    h("h3", null, "3点合わせ"),
    h("p", { class: "small muted" }, "モデル上の点と、それに対応する点群上の点を交互に 3 組クリックします（柱の角・梁の端など、両方で同じ所が分かる点）。"),
    h("ol", { class: "small" }, [0, 1, 2].map((i) => h("li", null, `モデル ${a.model[i] ? "✓" : "—"}　点群 ${a.cloud[i] ? "✓" : "—"}${result ? `　ずれ ${(result.errors[i] * 1000).toFixed(0)} mm` : ""}`))),
    h("label", { class: "row small" }, h("input", { type: "checkbox", checked: levelOnly, onchange: (e: Event) => { el.dataset.level = (e.target as HTMLInputElement).checked ? "1" : "0"; renderAlignPanel(app, el); } }), "水平を保つ（Z 軸回りの回転と移動だけ）"),
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
        await showMessage("座標合わせを保存しました", "この版を開く全員に反映されます。");
      } }, "保存（全員に反映）"),
      h("button", { onclick: () => { app.resetAlign(); app.setTool("select"); } }, "閉じる"),
    ),
  );
}
