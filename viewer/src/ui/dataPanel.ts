import type { App } from "../app";
import { formatBytes, formatCount, safeKey, type Manifest } from "../data/dataset";
import { host, type LocalFile } from "../host";
import { ImportJob, type ImportPlan, type ImportState } from "../import/importer";
import { $, confirmDialog, fmtDate, fmtDuration, h, mount, showMessage } from "./dom";
import { openSettings } from "./settingsDialog";

/**
 * 現場・版のパネル（ツールバーの現場名から開くポップオーバー）: 取込と、現場（系列）・版の一覧、
 * 表示中の版の情報。現場を開いていないときは 3D 画面の中央に入口を出す。
 * 取込の進み具合は、パネルを閉じていても状態バーに出す。
 */
export class DataPanel {
  private job: ImportJob | null = null;
  private jobState: ImportState | null = null;
  private expanded = new Set<string>();
  private readonly panel = $("#site-panel");
  private readonly toggleBtn = $("#current-title");

  constructor(private readonly app: App) {
    app.on("datasets", () => this.render());
    app.on("dataset", () => this.render());
    this.setupDrop();
    this.setupPopover();
    $("#st-msg").addEventListener("click", () => this.open());
  }

  get isOpen() {
    return !this.panel.classList.contains("hidden");
  }

  open() {
    // render() は開いているときだけ中身を描くので、先に開く
    this.panel.classList.remove("hidden");
    this.render();
    this.toggleBtn.setAttribute("aria-expanded", "true");
    this.panel.querySelector<HTMLElement>("button")?.focus();
  }

  close() {
    this.panel.classList.add("hidden");
    this.toggleBtn.setAttribute("aria-expanded", "false");
  }

  private setupPopover() {
    this.toggleBtn.addEventListener("click", () => (this.isOpen ? this.close() : this.open()));
    document.addEventListener("pointerdown", (e) => {
      const t = e.target as Element;
      // ダイアログ（取込の確認など）はパネルの上に出るので、押しても閉じない
      if (!this.isOpen || this.panel.contains(t) || this.toggleBtn.contains(t) || t.closest("dialog")) return;
      this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.isOpen || document.querySelector("dialog[open]")) return;
      // ツールの終了（Esc）より先に、パネルだけを閉じる
      e.stopImmediatePropagation();
      this.close();
      this.toggleBtn.focus();
    }, true);
  }

  /** 版を開く（パネルは閉じる） */
  private async openVersion(m: Manifest) {
    this.close();
    await this.app.openDataset(m).catch((e) => showMessage("開けません", String(e instanceof Error ? e.message : e)));
  }

  private setupDrop() {
    const overlay = $("#drop-overlay");
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      overlay.classList.remove("hidden");
    });
    window.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.classList.add("hidden");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.add("hidden");
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      try {
        const registered = await host.dropFiles(files);
        await this.startImport(registered);
      } catch (err) {
        await showMessage("取り込めません", String(err instanceof Error ? err.message : err));
      }
    });
  }

  async pick() {
    const files = await host.pickFiles();
    if (files.length) await this.startImport(files);
  }

  /** 取込の確認画面を出し、OK なら取込を始める */
  async startImport(files: LocalFile[]) {
    if (this.job && !this.jobState?.done && !this.jobState?.error) {
      await showMessage("取込中です", "前の取込が終わってから取り込んでください。");
      return;
    }
    // 表示の読込と変換が重なるとメモリが足りなくなることがあるので、開き終わるのを待つ
    if (this.app.opening) await this.app.opening;
    const usable = files.filter((f) => f.kind === "e57" || f.kind === "ifc");
    const ignored = files.filter((f) => !usable.includes(f));
    if (usable.length === 0) {
      await showMessage("取り込めるファイルがありません", "E57（点群）か IFC（モデル）を選んでください。");
      return;
    }
    const plan = await importDialog(this.app, usable, ignored);
    if (!plan) return;
    const job = new ImportJob(plan);
    this.job = job;
    this.jobState = job.state;
    job.onChange((s) => {
      this.jobState = s;
      this.renderJob();
    });
    this.render();
    try {
      const m = await job.run();
      await this.app.refreshDatasets();
      const opened = this.app.datasets.find((d) => d.folder === m.folder) ?? m;
      await this.app.openDataset(opened);
      if (m.importLog?.some((l) => l.level === "warn")) {
        await showMessage("取込が終わりました（注意あり）", m.importLog.map((l) => `・${l.message}`).join("\n"));
      }
    } catch (e) {
      console.error("取込に失敗", e instanceof Error ? e.stack : e);
      if (!String(e).includes("中断")) await showMessage("取込に失敗しました", String(e instanceof Error ? e.message : e));
    }
  }

  /** 状態バーの取込表示（パネルを閉じていても進み具合が分かるように。押すとパネルを開く） */
  private renderJobStatus() {
    const st = $("#st-msg");
    const s = this.jobState;
    st.classList.toggle("hidden", !s);
    if (!s) return;
    const pct = `${(s.overall * 100).toFixed(0)}%`;
    st.textContent = s.done ? "取込完了" : s.error ? "取込失敗" : `取込中 ${pct}・残り ${fmtDuration(s.remaining)}`;
    st.title = "クリックで取込の詳細を開く";
  }

  private renderJob() {
    this.renderJobStatus();
    const box = document.getElementById("import-progress");
    if (!box || !this.jobState) return;
    const s = this.jobState;
    mount(
      box,
      h("div", { class: "row" }, h("b", { class: "grow" }, s.done ? "取込完了" : s.error ? "取込失敗" : "取込中"), `${(s.overall * 100).toFixed(0)}%`),
      h("div", { class: "progress" }, h("div", { style: `width:${(s.overall * 100).toFixed(1)}%` })),
      h("div", { class: "small muted" }, `経過 ${fmtDuration(s.elapsed)}　残り ${s.done ? "0 秒" : fmtDuration(s.remaining)}`),
      s.tasks.map((t) =>
        h(
          "div",
          { class: `task ${t.status}` },
          h("div", { class: "row small" }, h("span", { class: "grow" }, t.label), `${(t.fraction * 100).toFixed(0)}%`),
          h("div", { class: "progress" }, h("div", { style: `width:${(t.fraction * 100).toFixed(1)}%` })),
          h("div", { class: "small msg muted" }, t.message),
        ),
      ),
      !s.done && !s.error
        ? h("div", { class: "row" }, h("button", { class: "danger", onclick: async () => {
            if (await confirmDialog("取込を中断しますか", "作業中のデータは削除されます。", "中断する")) this.job?.abort();
          } }, "中断"))
        : h("div", { class: "row" }, h("button", { onclick: () => { this.job = null; this.jobState = null; this.render(); } }, "閉じる")),
    );
  }

  render() {
    this.renderEmpty();
    this.renderJobStatus();
    if (!this.isOpen) return;
    const el = this.panel;
    const app = this.app;
    const sites = [...app.sites.entries()].sort((a, b) => b[1][0].createdAt.localeCompare(a[1][0].createdAt));
    mount(
      el,
      h("div", { class: "row panel-head" }, h("h2", { class: "grow" }, "現場・版"), h("button", { class: "small", title: "閉じる（Esc）", onclick: () => this.close() }, "閉じる")),
      h(
        "div",
        { class: "dropzone" },
        h("div", null, "E57（点群）・IFC（モデル）をここにドロップ"),
        h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "primary", onclick: () => this.pick() }, "ファイルを選んで取り込む")),
        h("div", { class: "small muted" }, "変換は自動で行い、終わると一覧に出ます。"),
      ),
      this.job ? h("div", { class: "import-box", id: "import-progress" }) : null,
      h("h2", null, `現場 ${sites.length} 件`),
      sites.length === 0
        ? h(
            "div",
            { class: "empty-state" },
            h("p", { class: "muted" }, "まだデータがありません。"),
            h("div", { class: "small muted" }, "保存先（プロジェクトフォルダ）:"),
            h("code", { class: "small", title: app.ctx.root }, app.ctx.root),
            h("div", { class: "row" }, h("button", { class: "small", onclick: () => openSettings() }, "保存先を確認・変更")),
          )
        : null,
      sites.map(([site, versions]) => this.renderSite(site, versions)),
      app.current ? this.renderDetail(app.current) : null,
    );
    this.renderJob();
  }

  /** 現場を開いていないときの 3D 画面中央の入口 */
  private renderEmpty() {
    const el = $("#empty-view");
    const app = this.app;
    el.classList.toggle("hidden", !!app.current);
    if (app.current) return;
    const hasSites = app.sites.size > 0;
    mount(
      el,
      h(
        "div",
        { class: "empty-card" },
        h("h2", null, hasSites ? "現場を開いてください" : "まだデータがありません"),
        h("p", { class: "muted" }, "E57（点群）・IFC（モデル）を画面にドロップすると取り込めます。"),
        h("div", { class: "row", style: "justify-content:center" },
          hasSites ? h("button", { onclick: () => this.open() }, "現場・版の一覧を開く") : null,
          h("button", { class: "primary", onclick: () => this.pick() }, "ファイルを選んで取り込む")),
        hasSites
          ? null
          : h("div", { class: "small muted" }, "保存先（プロジェクトフォルダ）: ", h("code", { title: app.ctx.root }, app.ctx.root), " ",
              h("button", { class: "small", onclick: () => openSettings() }, "保存先を確認・変更")),
      ),
    );
  }

  private renderSite(site: string, versions: Manifest[]) {
    const latest = versions[0];
    const cur = this.app.current;
    const isCur = cur?.site === site;
    const open = this.expanded.has(site);
    return h(
      "div",
      { class: `site${isCur ? " current" : ""}` },
      h(
        "div",
        {
          class: "site-head",
          role: "button",
          tabindex: "0",
          title: "最新版を開く",
          onclick: () => this.openVersion(latest),
          onkeydown: (e: KeyboardEvent) => e.key === "Enter" && this.openVersion(latest),
        },
        h("div", { class: "row" }, h("span", { class: "name grow" }, latest.name), h("span", { class: "badge" }, `第${latest.version}版`)),
        h(
          "div",
          { class: "small muted" },
          `${fmtDate(latest.createdAt)} ${this.app.memberName(latest.createdBy)}　`,
          latest.pointcloud ? `点群 ${formatCount(latest.pointcloud.points)}点　` : "",
          `モデル ${latest.models.length}`,
        ),
      ),
      versions.length > 1 || open
        ? h(
            "div",
            { class: "versions" },
            h("button", { class: "small", onclick: () => { open ? this.expanded.delete(site) : this.expanded.add(site); this.render(); } }, open ? "版の一覧を閉じる" : `全 ${versions.length} 版を表示`),
            open
              ? versions.map((v) =>
                  h(
                    "div",
                    { class: "version" },
                    h("span", { class: "grow small" }, `第${v.version}版 ${fmtDate(v.createdAt)} ${this.app.memberName(v.createdBy)}${v.comment ? `「${v.comment}」` : ""}`),
                    cur?.folder === v.folder ? h("span", { class: "chip" }, "表示中") : h("button", { onclick: () => this.openVersion(v) }, "開く"),
                  ),
                )
              : null,
          )
        : null,
    );
  }

  private renderDetail(m: Manifest) {
    const pc = m.pointcloud;
    return h(
      "details",
      { class: "version-info" },
      h("summary", null, `表示中の版の情報（${m.name} 第${m.version}版）`),
      h(
        "div",
        { class: "kv" },
        h("div", null, "フォルダ"),
        h("div", null, m.folder),
        h("div", null, "取込"),
        h("div", null, `${fmtDate(m.createdAt)} ${this.app.memberName(m.createdBy)}`),
        h("div", null, "前の版"),
        h("div", null, m.previous ?? "なし"),
        h("div", { title: "表示の内部原点を置いた WCS 上の位置（大きな座標でも表示の精度を保つため）" }, "内部原点"),
        h("div", null, m.origin.map((v) => v.toFixed(1)).join(", ")),
        h("div", null, "座標合わせ"),
        h("div", null, { identity: "IFC 座標のまま", mapConversion: "IfcMapConversion", threePoint: "3点合わせ" }[m.alignment.method] ?? m.alignment.method,
          m.alignment.residual !== undefined ? `（残差 ${(m.alignment.residual * 1000).toFixed(0)} mm）` : "",
          m.alignment.by ? ` ${this.app.memberName(m.alignment.by)} ${fmtDate(m.alignment.at)}` : ""),
      ),
      pc
        ? h(
            "div",
            null,
            h("h3", null, "点群"),
            h(
              "div",
              { class: "kv" },
              h("div", null, "元ファイル"),
              h("div", null, pc.sources.map((s) => `${s.name}（${formatBytes(s.size)}）`).join("、")),
              h("div", null, "点数"),
              h("div", null, `${pc.points.toLocaleString()} 点・${pc.scanCount} スキャン`),
              h("div", null, "保存サイズ"),
              h("div", null, pc.outputSizes ? formatBytes(Object.values(pc.outputSizes).reduce((a, b) => a + b, 0)) : "—"),
              carriedLabel(pc.owner, pc.carriedFrom, m.folder),
            ),
          )
        : null,
      m.models.length
        ? h(
            "div",
            null,
            h("h3", null, "モデル"),
            m.models.map((x) =>
              h(
                "details",
                null,
                h("summary", null, `${x.key}　${x.geometryCount.toLocaleString()} / ${x.expectedCount.toLocaleString()} 要素`, x.failedCount ? h("span", { style: "color:var(--warn)" }, `（形状なし ${x.failedCount}）`) : ""),
                h(
                  "div",
                  { class: "kv" },
                  h("div", null, "元ファイル"),
                  h("div", null, `${x.source.name}（${formatBytes(x.source.size)}）`),
                  h("div", null, "出力ソフト"),
                  h("div", null, x.application || "不明"),
                  h("div", null, "スキーマ・単位"),
                  h("div", null, `${x.schema}・${x.unitScale === 0.001 ? "mm" : x.unitScale === 1 ? "m" : x.unitScale}`),
                  h("div", null, "取込率"),
                  h("div", null, x.expectedCount ? `${((x.geometryCount / x.expectedCount) * 100).toFixed(1)}%` : "—"),
                  h("div", null, "変換時間"),
                  h("div", null, `${x.seconds.toFixed(1)} 秒`),
                  carriedLabel(x.owner, x.carriedFrom, m.folder),
                ),
                x.failed.length
                  ? h("details", null, h("summary", { class: "small" }, `形状を作れなかった要素（${x.failedCount} 件）`),
                      h("div", { class: "diff-list" }, x.failed.map((f) => h("div", null, `${f.cls} ${f.name || ""} `, h("span", { class: "muted" }, f.guid)))))
                  : null,
              ),
            ),
          )
        : null,
      m.importLog?.length
        ? h("details", null, h("summary", null, `取込ログ（${m.importLog.length}）`), m.importLog.map((l) => h("div", { class: "small" }, `[${l.level}] ${l.message}`)))
        : null,
    );
  }
}

/** 引き継いだデータの由来。複製したもの・（PoC 初期の）前の版を参照しているもの */
function carriedLabel(owner: string, carriedFrom: string | undefined, folder: string) {
  if (carriedFrom) return [h("div", null, "引継ぎ"), h("div", null, `${carriedFrom} から複製`)];
  if (owner !== folder)
    return [h("div", null, "引継ぎ"), h("div", { style: "color:var(--warn)" }, `${owner} を参照（その版を消すと開けません）`)];
  return null;
}

/** 取込の確認画面。新しい現場か、既存の現場の新しい版かを選ぶ */
function importDialog(app: App, files: LocalFile[], ignored: LocalFile[]): Promise<ImportPlan | null> {
  const dlg = $("#dlg-import") as HTMLDialogElement;
  const sites = [...app.sites.entries()];
  const keys: Record<string, string> = {};
  for (const f of files) if (f.kind === "ifc") keys[f.token] = safeKey(f.name);
  const firstName = files[0].name.replace(/\.(e57|ifc)$/i, "");
  return new Promise((resolve) => {
    let mode: "new" | "version" = app.current ? "version" : "new";
    let site = app.current?.site ?? sites[0]?.[0] ?? "";
    let name = app.current?.name ?? firstName;
    let comment = "";
    const keep = { pointcloud: true, models: new Set<string>() };
    const base = () => (mode === "version" ? app.versionsOf(site)[0] ?? null : null);
    const resetKeep = () => {
      const b = base();
      keep.models = new Set(b?.models.map((m) => m.key) ?? []);
      keep.pointcloud = true;
      if (b) name = b.name;
    };
    resetKeep();
    const draw = () => {
      const b = base();
      const newKeys = new Set(Object.values(keys));
      const hasE57 = files.some((f) => f.kind === "e57");
      mount(
        dlg,
        h("h2", null, "取り込む"),
        h(
          "table",
          null,
          files.map((f) =>
            h(
              "tr",
              null,
              h("td", null, f.kind === "e57" ? "点群" : "IFC"),
              h("td", null, f.name),
              h("td", { class: "muted" }, formatBytes(f.size)),
              h(
                "td",
                null,
                f.kind === "ifc"
                  ? h("input", { type: "text", value: keys[f.token], "aria-label": `${f.name} のモデル名`, title: "モデル名（建築・電気・機械 など）。同じ名前のモデルは置き換えます", oninput: (e: Event) => { keys[f.token] = safeKey((e.target as HTMLInputElement).value); } })
                  : "",
              ),
            ),
          ),
        ),
        ignored.length ? h("p", { class: "small muted" }, `対象外のため無視: ${ignored.map((f) => f.name).join("、")}`) : null,
        h(
          "div",
          { class: "row" },
          h("label", null, h("input", { type: "radio", name: "imp-mode", checked: mode === "new", onchange: () => { mode = "new"; name = firstName; draw(); } }), " 新しい現場"),
          h("label", null, h("input", { type: "radio", name: "imp-mode", checked: mode === "version", disabled: sites.length === 0, onchange: () => { mode = "version"; resetKeep(); draw(); } }), " 既存の現場の新しい版"),
        ),
        mode === "version"
          ? h(
              "div",
              { class: "row" },
              h("label", null, "現場"),
              h("select", { class: "grow", onchange: (e: Event) => { site = (e.target as HTMLSelectElement).value; resetKeep(); draw(); } },
                sites.map(([s, v]) => h("option", { value: s, selected: s === site }, `${v[0].name}（第${v[0].version}版まで）`))),
            )
          : null,
        h("div", { class: "row" }, h("label", null, "名称"), h("input", { type: "text", class: "grow", value: name, oninput: (e: Event) => { name = (e.target as HTMLInputElement).value; } })),
        b
          ? h(
              "div",
              null,
              h("h3", null, `第${b.version}版から引き継ぐもの`),
              b.pointcloud
                ? h("label", { class: "row" }, h("input", { type: "checkbox", checked: keep.pointcloud && !hasE57, disabled: hasE57, onchange: (e: Event) => { keep.pointcloud = (e.target as HTMLInputElement).checked; } }),
                    `点群（${formatCount(b.pointcloud.points)}点）${hasE57 ? " → 新しい点群で置き換え" : ""}`)
                : null,
              b.models.map((m) =>
                h("label", { class: "row" }, h("input", { type: "checkbox", checked: keep.models.has(m.key) && !newKeys.has(m.key), disabled: newKeys.has(m.key), onchange: (e: Event) => {
                  (e.target as HTMLInputElement).checked ? keep.models.add(m.key) : keep.models.delete(m.key);
                } }), `モデル ${m.key}${newKeys.has(m.key) ? " → 新しいファイルで置き換え" : ""}`),
              ),
              h("p", { class: "small muted" }, "引き継ぐデータはこの版のフォルダへ複製します（古い版を消しても、この版はそのまま開けます）。取込後に前の版との差分を作ります。"),
            )
          : null,
        h("div", { class: "row" }, h("label", null, "コメント"), h("input", { type: "text", class: "grow", placeholder: "例: 3F 設備 施工図反映", value: comment, oninput: (e: Event) => { comment = (e.target as HTMLInputElement).value; } })),
        h(
          "div",
          { class: "actions" },
          h("button", { onclick: () => { dlg.close(); resolve(null); } }, "キャンセル"),
          h("button", { class: "primary", onclick: () => {
            if (!name.trim()) return;
            dlg.close();
            const bb = base();
            resolve({
              name: name.trim(),
              base: bb,
              files,
              keys,
              keepPointcloud: !!bb?.pointcloud && keep.pointcloud && !hasE57,
              keepModels: [...keep.models],
              comment,
            });
          } }, "取り込む"),
        ),
      );
    };
    draw();
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}
