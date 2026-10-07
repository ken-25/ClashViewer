// 登録された左タブ・見え方の項目（ui/panelRegistry.ts）から DOM を組み立て、通知で描き直す。

import type { App } from "../app";
import { $, h } from "./dom";
import { leftTabs, viewBarItems } from "./panelRegistry";

/** 左タブを切り替える（指摘のピンから詳細を開くときなど） */
export function activateLeftTab(id: string) {
  document.querySelectorAll<HTMLButtonElement>("#left [data-tab]").forEach((x) => {
    const on = x.dataset.tab === id;
    x.classList.toggle("active", on);
    x.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#left .tab").forEach((x) => x.classList.toggle("active", x.id === `tab-${id}`));
}

/**
 * 左タブのボタンとパネルを作る。戻り値はすべてのタブを描き直す関数（起動時に呼ぶ）。
 * 描き直しは各タブの topics の通知で行う。
 */
export function mountLeftTabs(app: App): () => void {
  const left = $("#left");
  const nav = left.querySelector<HTMLElement>("nav.tabs")!;
  const close = nav.querySelector(".panel-close");
  const defs = leftTabs();
  const renders: (() => void)[] = [];
  for (const [i, def] of defs.entries()) {
    const badge = def.badge ? h("span", { class: "badge", id: `${def.id}-count` }) : null;
    const btn = h("button", { role: "tab", "data-tab": def.id, id: `tabbtn-${def.id}`, "aria-controls": `tab-${def.id}`, "aria-selected": String(i === 0), class: i === 0 ? "active" : "" },
      def.label, badge);
    btn.addEventListener("click", () => activateLeftTab(def.id));
    nav.insertBefore(btn, close);
    const panel = h("section", { id: `tab-${def.id}`, class: `tab${i === 0 ? " active" : ""}`, role: "tabpanel", "aria-labelledby": `tabbtn-${def.id}` });
    left.appendChild(panel);
    const draw = def.setup(app, panel);
    const updateBadge = () => {
      if (badge && def.badge) badge.textContent = def.badge(app);
    };
    const render = () => {
      draw();
      updateBadge();
    };
    for (const t of def.topics) app.on(t, render);
    for (const t of def.badgeTopics ?? []) app.on(t, updateBadge);
    renders.push(render);
  }
  // 折りたたんだときの帯にタブの名前を並べる
  const strip = left.querySelector(".panel-strip .strip-label");
  if (strip) strip.textContent = defs.map((d) => d.label).join("・");
  return () => renders.forEach((r) => r());
}

/**
 * 3D 画面左上の見え方の項目を作る。setupMenus より前に呼ぶ（メニューの開閉はそちらで付ける）。
 * 戻り値はすべての項目の状態を合わせる関数（起動時に呼ぶ）。
 */
export function mountViewBar(app: App): () => void {
  const bar = $("#view-bar");
  const syncs: (() => void)[] = [];
  for (const def of viewBarItems()) {
    const btn = h("button", { id: def.id, title: def.title, class: def.needsData ? "needs-data" : "" });
    let menu: HTMLElement | null = null;
    if (def.menu) {
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", "false");
      menu = h("div", { class: `menu${def.menu.wide ? " menu-wide" : ""} hidden`, role: "menu", "aria-label": def.menu.ariaLabel, id: def.menu.id });
      def.menu.build(app, menu);
      bar.appendChild(h("div", { class: "menu-wrap" }, btn, menu));
    } else {
      btn.addEventListener("click", () => def.onClick!(app));
      bar.appendChild(btn);
    }
    const sync = () => {
      btn.textContent = `${typeof def.label === "function" ? def.label(app) : def.label}${def.menu ? " ▾" : ""}`;
      def.sync?.(app, btn, menu);
    };
    for (const t of def.topics ?? []) app.on(t, sync);
    syncs.push(sync);
  }
  return () => syncs.forEach((s) => s());
}
