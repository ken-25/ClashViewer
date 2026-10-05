import type { App } from "../app";
import type { DiffItem } from "../data/diff";
import { $, fmtDate, h, mount } from "./dom";

const KIND_LABEL: Record<string, string> = { position: "位置", size: "寸法", attributes: "属性", model: "ファイル" };

/** 「差分」タブ: 前の版との差分（件数・一覧・色分け・どのファイルから作った版か） */
export function renderDiff(app: App) {
  const el = $("#tab-diff");
  const m = app.current;
  const d = app.diff;
  if (!m) {
    mount(el, h("p", { class: "muted" }, "現場を開いてください。"));
    return;
  }
  if (!d) {
    mount(el, h("p", { class: "muted" }, m.previous ? "差分の情報がありません。" : "第1版のため、比べる前の版がありません。"));
    return;
  }
  const list = (items: DiffItem[], color: string, folder?: string) =>
    h(
      "div",
      { class: "diff-list" },
      items.slice(0, 1000).map((x) =>
        h("div", { title: x.guid, onclick: () => app.zoomToGuid(x.guid, x.model, folder) },
          h("span", { class: "sw", style: `background:${color}` }),
          `${x.c} ${x.n || ""}`,
          x.kinds ? h("span", { class: "muted" }, `（${x.kinds.map((k) => KIND_LABEL[k] ?? k).join("・")}${x.detail ? `: ${x.detail}` : ""}）`) : null,
        ),
      ),
      items.length > 1000 ? h("div", { class: "muted" }, `ほか ${items.length - 1000} 件`) : null,
    );
  const pv = d.provenance;
  mount(
    el,
    h("h2", null, `第${pv.base.version}版 → 第${pv.current.version}版`),
    h("label", { class: "row" }, h("input", { type: "checkbox", checked: app.diffShown, onchange: (e: Event) => app.showDiff((e.target as HTMLInputElement).checked) }), "色分けして表示（追加=緑・変更=黄・削除=赤の半透明）"),
    h("h3", null, "モデル"),
    h(
      "div",
      { class: "kv" },
      h("div", null, "追加"),
      h("div", null, `${d.models.added.length} 件`),
      h("div", null, "変更"),
      h("div", null, `${d.models.changed.length} 件`),
      h("div", null, "削除"),
      h("div", null, `${d.models.removed.length} 件`),
      h("div", null, "変化なし"),
      h("div", null, `${d.models.unchanged} 件`),
    ),
    d.models.added.length ? h("details", null, h("summary", null, `追加（${d.models.added.length}）`), list(d.models.added, "#3cc85a")) : null,
    d.models.changed.length ? h("details", { open: true }, h("summary", null, `変更（${d.models.changed.length}）`), list(d.models.changed, "#f2c01e")) : null,
    d.models.removed.length
      ? h("details", null, h("summary", null, `削除（${d.models.removed.length}）`), h("div", { class: "small muted" }, "色分け表示中に、前の版の要素へ寄れます。"), list(d.models.removed, "#e5534b", d.against))
      : null,
    h("h3", null, "点群"),
    d.pointcloud.changed ? d.pointcloud.differences.map((x) => h("div", { class: "small" }, `・${x}`)) : h("div", { class: "small muted" }, "変化なし"),
    h("h3", null, "どのファイルから作った版か"),
    h(
      "table",
      { class: "small" },
      h("tr", null, h("td", null, ""), h("td", null, `第${pv.base.version}版`), h("td", null, `第${pv.current.version}版`)),
      h("tr", null, h("td", null, "取込者"), h("td", null, app.memberName(pv.base.createdBy)), h("td", null, app.memberName(pv.current.createdBy))),
      h("tr", null, h("td", null, "日時"), h("td", null, fmtDate(pv.base.createdAt)), h("td", null, fmtDate(pv.current.createdAt))),
      ...unionKeys(pv.base.models, pv.current.models).map((k) => {
        const a = pv.base.models.find((x) => x.key === k);
        const b = pv.current.models.find((x) => x.key === k);
        return h("tr", null, h("td", null, k), h("td", { title: a?.sha256 }, a ? `${a.source} #${a.sha256.slice(0, 8)}` : "—"), h("td", { title: b?.sha256 }, b ? `${b.source} #${b.sha256.slice(0, 8)}` : "—"));
      }),
      h("tr", null, h("td", null, "点群"),
        h("td", null, pv.base.pointcloud.map((x) => `${x.source} #${x.sha256.slice(0, 8)}`).join("、") || "—"),
        h("td", null, pv.current.pointcloud.map((x) => `${x.source} #${x.sha256.slice(0, 8)}`).join("、") || "—")),
    ),
  );
}

function unionKeys(a: { key: string }[], b: { key: string }[]): string[] {
  return [...new Set([...a.map((x) => x.key), ...b.map((x) => x.key)])];
}
