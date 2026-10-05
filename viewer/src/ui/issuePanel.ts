import type { App } from "../app";
import { sceneToWorld } from "../data/dataset";
import { dataUrl, writeFile } from "../host";
import { newIssueId, STATUSES, type Issue } from "../issues/issues";
import { $, fmtDate, h, mount, showMessage } from "./dom";

/**
 * 「指摘」タブ: 一覧・絞り込みと、一覧に重ねて出す詳細（状態・担当・コメント）・視点の再現。
 * 将来の BCF 書き出しは一覧の上（「指摘を登録」の行）に置く。
 */
export class IssuePanel {
  filter = { status: "", assignee: "", scope: "site" as "site" | "version" | "all" };

  constructor(private readonly app: App) {
    app.on("issues", () => this.render());
    app.on("dataset", () => this.render());
    app.on("issue:new", () => void this.create());
    app.on("issue:open", () => {
      document.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
      void this.open(app.selectedIssue!);
    });
  }

  private list(): Issue[] {
    const { app, filter } = this;
    const m = app.current;
    return [...app.issues.values()]
      .filter((i) => filter.scope === "all" || !m || (filter.scope === "site" ? i.site === m.site : i.dataset === m.folder))
      .filter((i) => !filter.status || i.status === filter.status)
      .filter((i) => !filter.assignee || i.assignee === filter.assignee)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 一覧に戻ったときに戻すスクロール位置と、目印を付ける指摘 */
  private listScroll = 0;
  private lastViewed: string | null = null;
  /** 書きかけのコメント（10 秒ごとの再読込でパネルを作り直しても消さない） */
  private drafts = new Map<string, string>();

  render() {
    const { app } = this;
    $("#issue-count").textContent = String(app.issuesForCurrentSite().filter((i) => i.status === "未対応" || i.status === "対応中").length || "");
    const sel = app.selectedIssue ? app.issues.get(app.selectedIssue) : null;
    // 詳細は一覧の上に重ねて出す（一覧と縦に積むと、件数が多いとき詳細が見えなくなる）
    if (sel) this.renderDetailView(sel);
    else this.renderList();
  }

  /** 詳細から一覧に戻る（スクロール位置も戻す） */
  back() {
    this.app.selectedIssue = null;
    this.render();
    const scroller = document.getElementById("left");
    if (scroller) scroller.scrollTop = this.listScroll;
    document.querySelector<HTMLElement>(`#tab-issues [data-issue="${this.lastViewed}"]`)?.focus();
  }

  private renderDetailView(i: Issue) {
    const list = this.list();
    const idx = list.findIndex((x) => x.id === i.id);
    const go = (d: number) => {
      const next = list[idx + d];
      if (next) void this.open(next.id);
    };
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#tab-issues [data-focus]")?.dataset.focus;
    mount(
      $("#tab-issues"),
      h("div", { class: "row issue-nav" },
        h("button", { "data-focus": "back", title: "絞り込んだ一覧に戻る", onclick: () => this.back() }, "‹ 一覧に戻る"),
        h("span", { class: "grow" }),
        idx >= 0 ? h("span", { class: "small muted" }, `${idx + 1} / ${list.length}`) : h("span", { class: "small muted" }, "絞り込みの対象外"),
        h("button", { class: "small", "data-focus": "prev", disabled: idx <= 0, title: "一覧の前の指摘", "aria-label": "前の指摘", onclick: () => go(-1) }, "▲"),
        h("button", { class: "small", "data-focus": "next", disabled: idx < 0 || idx >= list.length - 1, title: "一覧の次の指摘", "aria-label": "次の指摘", onclick: () => go(1) }, "▼"),
      ),
      this.renderDetail(i),
    );
    if (focused) document.querySelector<HTMLElement>(`#tab-issues [data-focus="${focused}"]`)?.focus();
  }

  private renderList() {
    const { app, filter } = this;
    const list = this.list();
    mount(
      $("#tab-issues"),
      h("div", { class: "row" }, h("button", { class: "primary", disabled: !app.current, onclick: () => app.setTool("issue") }, "指摘を登録"), h("span", { class: "small muted" }, "画面上の位置をクリックして登録")),
      h("div", { class: "row small" }, h("label", null, "状態"), h("select", { class: "grow", onchange: (e: Event) => { filter.status = (e.target as HTMLSelectElement).value; this.render(); } },
        h("option", { value: "" }, "すべて"), STATUSES.map((s) => h("option", { value: s, selected: filter.status === s }, s)))),
      h("div", { class: "row small" }, h("label", null, "担当"), h("select", { class: "grow", onchange: (e: Event) => { filter.assignee = (e.target as HTMLSelectElement).value; this.render(); } },
        h("option", { value: "" }, "すべて"), app.ctx.members.map((m) => h("option", { value: m.id, selected: filter.assignee === m.id }, m.name)))),
      h("div", { class: "row small" }, h("label", null, "範囲"), h("select", { class: "grow", onchange: (e: Event) => { filter.scope = (e.target as HTMLSelectElement).value as any; this.render(); } },
        h("option", { value: "site", selected: filter.scope === "site" }, "このプロジェクトの全版"),
        h("option", { value: "version", selected: filter.scope === "version" }, "表示中の版だけ"),
        h("option", { value: "all", selected: filter.scope === "all" }, "すべてのプロジェクト"))),
      h("div", { class: "small muted" }, `${list.length} 件`),
      list.map((i) =>
        h(
          "div",
          { class: `issue-item${this.lastViewed === i.id ? " selected" : ""}`, tabindex: "0", "data-issue": i.id, onclick: () => this.open(i.id), onkeydown: (e: KeyboardEvent) => e.key === "Enter" && this.open(i.id) },
          h("div", { class: "row" }, h("span", { class: "t grow" }, i.title || "（件名なし）"), h("span", { class: `chip s-${i.status}` }, i.status)),
          h("div", { class: "small muted" }, `担当 ${i.assignee ? app.memberName(i.assignee) : "なし"}　${fmtDate(i.updatedAt)}　第${i.datasetVersion}版`),
        ),
      ),
    );
  }

  private renderDetail(i: Issue) {
    const app = this.app;
    let comment = this.drafts.get(i.id) ?? "";
    const otherVersion = app.current && i.dataset !== app.current.folder;
    return h(
      "div",
      { class: "issue-detail" },
      h("h2", null, "指摘の詳細"),
      h("div", null, h("b", null, i.title || "（件名なし）")),
      h("div", { class: "small muted" }, `${app.memberName(i.createdBy)} ${fmtDate(i.createdAt)} 登録・第${i.datasetVersion}版（${i.dataset}）`),
      otherVersion ? h("div", { class: "small", style: "color:var(--warn)" }, "表示中とは別の版で登録された指摘です（位置で重ねて表示しています）。") : null,
      i.comment ? h("p", { style: "white-space:pre-wrap" }, i.comment) : null,
      i.screenshots.map((s) => h("img", { src: dataUrl(s), alt: `${i.title} のスクリーンショット`, loading: "lazy" })),
      h("div", { class: "row" },
        h("button", { onclick: () => app.restoreView(i.view) }, "登録時の視点を再現"),
        otherVersion ? h("button", { onclick: async () => {
          const ds = app.datasets.find((d) => d.folder === i.dataset);
          if (ds) { await app.openDataset(ds); await app.restoreView(i.view); }
          else await showMessage("開けません", "登録した版が見つかりません（削除された可能性があります）。");
        } }, "登録した版で開く") : null,
      ),
      h("div", { class: "row small" }, h("label", null, "状態"), h("select", { class: "grow", onchange: (e: Event) => app.appendEvent({ type: "issue.update", id: i.id, status: (e.target as HTMLSelectElement).value }) },
        STATUSES.map((s) => h("option", { value: s, selected: i.status === s }, s)))),
      h("div", { class: "row small" }, h("label", null, "担当"), h("select", { class: "grow", onchange: (e: Event) => app.appendEvent({ type: "issue.update", id: i.id, assignee: (e.target as HTMLSelectElement).value }) },
        h("option", { value: "" }, "なし"), app.ctx.members.map((m) => h("option", { value: m.id, selected: i.assignee === m.id }, m.name)))),
      h("h3", null, `コメント（${i.comments.length}）`),
      i.comments.map((c) => h("div", { class: "small" }, h("b", null, app.memberName(c.by)), ` ${fmtDate(c.at)}`, h("div", { style: "white-space:pre-wrap" }, c.text))),
      h("textarea", { rows: 2, style: "width:100%", placeholder: "コメントを書く", "aria-label": "コメント", oninput: (e: Event) => { comment = (e.target as HTMLTextAreaElement).value; this.drafts.set(i.id, comment); } }, comment),
      h("div", { class: "row" },
        h("button", { onclick: async () => {
          if (!comment.trim()) return;
          this.drafts.delete(i.id);
          await app.appendEvent({ type: "issue.comment", id: i.id, text: comment.trim() });
        } }, "コメントを追加"),
        h("button", { onclick: async () => {
          const shot = await this.saveScreenshot(i.id);
          this.drafts.delete(i.id);
          await app.appendEvent({ type: "issue.comment", id: i.id, text: comment.trim() || "画面を追加", screenshot: shot });
        } }, "今の画面を添付"),
      ),
      h("details", null, h("summary", { class: "small" }, "履歴"), i.history.map((x) => h("div", { class: "small muted" }, `${fmtDate(x.at)} ${app.memberName(x.by)} ${x.text}`))),
    );
  }

  async open(id: string) {
    const app = this.app;
    const scroller = document.getElementById("left");
    // 一覧から開くときだけ位置を覚える（詳細どうしの移動では覚え直さない）
    if (!app.selectedIssue && scroller) this.listScroll = scroller.scrollTop;
    app.selectedIssue = id;
    this.lastViewed = id;
    this.render();
    if (scroller) scroller.scrollTop = 0;
    const i = app.issues.get(id);
    if (i && app.current && i.site === app.current.site) await app.restoreView(i.view);
  }

  private async saveScreenshot(id: string): Promise<string> {
    const blob = await this.app.viewer.screenshot();
    const rel = `issues/${id}/${Date.now()}.png`;
    await writeFile(rel, await blob.arrayBuffer());
    return rel;
  }

  /** 指摘の登録画面（クリックした位置・今の視点・画面画像を保存） */
  async create() {
    const app = this.app;
    const m = app.current;
    const p = app.lastPick;
    if (!m || !p) return;
    app.setTool("select");
    const id = newIssueId(app.ctx.user);
    const view = app.captureView();
    const blob = await app.viewer.screenshot();
    const url = URL.createObjectURL(blob);
    const dlg = $("#dlg-issue") as HTMLDialogElement;
    let title = p.model ? `${p.model.lm.key} ${app.selection?.data?._category?.value ?? ""}`.trim() : "";
    let comment = "";
    let assignee = "";
    const done = new Promise<boolean>((resolve) => {
      mount(
        dlg,
        h("h2", null, "指摘を登録"),
        h("img", { src: url, alt: "登録する画面", style: "max-width:100%;border:1px solid var(--line);border-radius:4px" }),
        h("div", { class: "row" }, h("label", null, "件名"), h("input", { type: "text", class: "grow", value: title, placeholder: "例: ダクトと梁が干渉", oninput: (e: Event) => { title = (e.target as HTMLInputElement).value; } })),
        h("div", { class: "row" }, h("label", null, "コメント"), h("textarea", { class: "grow", rows: 3, oninput: (e: Event) => { comment = (e.target as HTMLTextAreaElement).value; } })),
        h("div", { class: "row" }, h("label", null, "担当"), h("select", { class: "grow", onchange: (e: Event) => { assignee = (e.target as HTMLSelectElement).value; } },
          h("option", { value: "" }, "なし"), app.ctx.members.map((x) => h("option", { value: x.id }, x.name)))),
        h("div", { class: "small muted" }, `位置（WCS）${sceneToWorld(m, p.point).map((v) => v.toFixed(3)).join(", ")}　${p.source === "model" ? "モデル上" : "点群上"}`),
        h("div", { class: "actions" },
          h("button", { onclick: () => { dlg.close(); resolve(false); } }, "キャンセル"),
          h("button", { class: "primary", onclick: () => { dlg.close(); resolve(true); } }, "登録"),
        ),
      );
      dlg.onclose = () => resolve(false);
      dlg.showModal();
    });
    const ok = await done;
    URL.revokeObjectURL(url);
    if (!ok) return;
    const rel = `issues/${id}/${Date.now()}.png`;
    await writeFile(rel, await blob.arrayBuffer());
    await app.appendEvent({
      type: "issue.create",
      id,
      site: m.site,
      dataset: m.folder,
      datasetVersion: m.version,
      title: title.trim(),
      comment: comment.trim(),
      status: "未対応",
      assignee,
      position: sceneToWorld(m, p.point),
      source: p.source,
      element: p.model ? { model: p.model.lm.key, localId: p.model.localId } : null,
      view,
      screenshot: rel,
    });
    app.selectedIssue = id;
    this.lastViewed = id;
    this.render();
  }
}
