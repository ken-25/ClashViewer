import type { App } from "../app";
import { formatBytes } from "../data/dataset";
import { host, type FolderInfo, type FolderKind, type OpenableFolder, type StorageSource, type StorageState } from "../host";
import { $, h, mount, showMessage } from "./dom";

// 設定画面: 利用者（表示名）と保存先（プロジェクトフォルダ・設定データフォルダ）、この PC の作業領域。
// 保存先は settings.json に保存し、再起動で切り替える（取込中・表示中のデータを途中で差し替えないため）。
// 今あるデータは移動しない（点群は数 GB〜数十 GB あり、画面からの移動は失敗時の影響が大きい）。

/** 変更の下書き。value=null は「既定に戻す」 */
interface Draft {
  value: string | null;
  info: FolderInfo;
}

const SOURCE_LABEL: Record<StorageSource, string> = {
  arg: "起動引数 --root で指定",
  settings: "設定で指定",
  default: "既定",
  fallback: "既定（設定した場所が使えないため）",
};

const KIND_TEXT: Record<FolderKind, { title: string; desc: string }> = {
  project: {
    title: "プロジェクトフォルダ",
    desc: "取り込んだ点群・モデル（datasets）、指摘とスクリーンショット（events・issues）を保存します。大きくなるので、空きの多いドライブを選んでください。",
  },
  config: {
    title: "設定データフォルダ",
    desc: "アプリの設定（app.json）とメンバー（表示名）を保存します。既定はプロジェクトフォルダの中の config です。",
  },
};

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string) => s.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return a != null && b != null && n(a) === n(b);
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
}

let instance: SettingsDialog | null = null;

/** どこからでも設定画面を開く（データタブの案内・フッターなど） */
export function openSettings(): void {
  void instance?.open();
}

export class SettingsDialog {
  private readonly dlg: HTMLDialogElement;
  private state: StorageState | null = null;
  private project: Draft | undefined;
  private config: Draft | undefined;
  /** 次の設定データフォルダ（変更後）の検査結果。設定データを写すかの判断に使う */
  private nextConfigInfo: FolderInfo | null = null;
  private copyConfig = true;
  private busy = false;
  private nameDraft = "";

  constructor(private readonly app: App) {
    this.dlg = $("#dlg-settings") as HTMLDialogElement;
    instance = this;
  }

  async open() {
    this.project = undefined;
    this.config = undefined;
    this.nextConfigInfo = null;
    this.copyConfig = true;
    this.nameDraft = this.app.ctx.displayName;
    try {
      this.state = await host.getStorage();
    } catch (e) {
      await showMessage("設定を開けません", String(e instanceof Error ? e.message : e));
      return;
    }
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
  }

  // ---- 次の起動で使う値（下書き → 保存済み の順） ----

  private get nextDataRoot(): string | null {
    return this.project !== undefined ? this.project.value : this.state!.saved.dataRoot;
  }
  private get nextConfigRoot(): string | null {
    return this.config !== undefined ? this.config.value : this.state!.saved.configRoot;
  }
  private get nextProjectPath(): string {
    return this.nextDataRoot ?? this.state!.defaultRoot;
  }
  private get nextConfigPath(): string {
    return this.nextConfigRoot ?? joinPath(this.nextProjectPath, "config");
  }
  private get dirty(): boolean {
    const s = this.state!;
    return !samePath(this.nextDataRoot ?? "", s.saved.dataRoot ?? "") || !samePath(this.nextConfigRoot ?? "", s.saved.configRoot ?? "");
  }
  private get hasErrors(): boolean {
    return [this.project?.info, this.config?.info, this.nextConfigInfo].some((i) => (i?.errors.length ?? 0) > 0);
  }
  /** 設定データの置き場所が今と変わるか（変わるなら今の設定を写すかを聞く） */
  private get configMoves(): boolean {
    return !samePath(this.nextConfigPath, this.state!.config.path);
  }

  // ---- 操作 ----

  private async change(kind: FolderKind) {
    const initial = kind === "project" ? this.nextProjectPath : this.nextConfigPath;
    const info = await this.guard(() => host.pickFolder(kind, initial));
    if (!info) return;
    await this.setDraft(kind, { value: info.path, info });
  }

  private async reset(kind: FolderKind) {
    const path = kind === "project" ? this.state!.defaultRoot : joinPath(this.nextProjectPath, "config");
    const info = await this.guard(() => host.inspectFolder(kind, path));
    if (!info) return;
    await this.setDraft(kind, { value: null, info });
  }

  private async setDraft(kind: FolderKind, d: Draft | undefined) {
    const s = this.state!;
    // 保存済みと同じに戻したら下書きを消す
    const saved = kind === "project" ? s.saved.dataRoot : s.saved.configRoot;
    if (d && samePath(d.value ?? "", saved ?? "")) d = undefined;
    if (kind === "project") this.project = d;
    else this.config = d;
    await this.refreshNextConfig();
    this.render();
  }

  /** 設定データフォルダの行き先を調べ直す（プロジェクトフォルダに連動する既定のときも） */
  private async refreshNextConfig() {
    this.nextConfigInfo = null;
    if (!this.configMoves) return;
    if (this.config && samePath(this.config.info.path, this.nextConfigPath)) this.nextConfigInfo = this.config.info;
    else this.nextConfigInfo = await this.guard(() => host.inspectFolder("config", this.nextConfigPath));
    // 行き先に設定が無ければ、今の設定を写すのを既定にする
    const i = this.nextConfigInfo;
    this.copyConfig = !i?.hasAppJson && !(i?.members ?? 0);
  }

  private async save() {
    const s = this.state!;
    const next = await this.guard(() => host.saveStorage(this.nextDataRoot, this.nextConfigRoot, this.configMoves && this.copyConfig));
    if (!next) return;
    this.state = next;
    this.project = undefined;
    this.config = undefined;
    this.nextConfigInfo = null;
    this.render();
    const copied = next.copied ? `\n設定データを ${next.copied} 件写しました。` : "";
    if (s.overridden) {
      await showMessage("保存しました", `起動引数 --root で起動しているため、いまの保存先は変わりません。--root を付けずに起動したときに使われます。${copied}`);
      return;
    }
    if (!next.restartPending) {
      await showMessage("保存しました", `いま使っている保存先と同じなので、再起動は要りません。${copied}`);
      return;
    }
    const r = await showMessage(
      "保存しました",
      `新しい保存先は再起動すると使われます。${copied}\n\n今すぐ再起動しますか？（開いている現場は閉じます）`,
      [
        { label: "後で再起動", value: "later" },
        { label: "今すぐ再起動", value: "restart", primary: true },
      ],
    );
    if (r === "restart") await this.restart();
  }

  private async restart() {
    await this.guard(() => host.restartApp());
  }

  private async saveName() {
    const name = this.nameDraft.trim();
    if (!name || name === this.app.ctx.displayName) return;
    const ctx = await this.guard(() => host.setMyName(name));
    if (!ctx) return;
    this.app.ctx = ctx;
    this.nameDraft = ctx.displayName;
    $("#st-user").textContent = `${ctx.displayName}（${ctx.user}）`;
    this.app.emit("issues");
    this.render();
  }

  private async openFolder(kind: OpenableFolder) {
    await this.guard(() => host.openFolder(kind));
  }

  /** 操作中は二重に押せないようにし、失敗はメッセージで知らせる */
  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null;
    this.busy = true;
    this.render();
    try {
      return await fn();
    } catch (e) {
      await showMessage("できませんでした", String(e instanceof Error ? e.message : e));
      return null;
    } finally {
      this.busy = false;
      if (this.dlg.open) this.render();
    }
  }

  // ---- 描画 ----

  private render() {
    const s = this.state;
    if (!s) return;
    const ctx = this.app.ctx;
    const locked = this.busy || s.importing;
    mount(
      this.dlg,
      h("h2", null, "設定"),
      h(
        "div",
        { class: "settings" },
        h(
          "section",
          { class: "settings-section", "aria-labelledby": "set-user" },
          h("h3", { id: "set-user" }, "利用者"),
          h(
            "div",
            { class: "row" },
            h("label", { for: "set-name" }, "表示名"),
            h("input", {
              id: "set-name",
              type: "text",
              class: "grow",
              value: this.nameDraft,
              maxlength: 40,
              oninput: (e: Event) => {
                this.nameDraft = (e.target as HTMLInputElement).value;
                const btn = document.getElementById("set-name-save") as HTMLButtonElement | null;
                if (btn) btn.disabled = !this.nameDraft.trim() || this.nameDraft.trim() === ctx.displayName;
              },
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === "Enter") void this.saveName();
              },
            }),
            h("button", { id: "set-name-save", disabled: !this.nameDraft.trim() || this.nameDraft.trim() === ctx.displayName, onclick: () => this.saveName() }, "変更"),
          ),
          h("div", { class: "small muted" }, `ユーザー ID: ${ctx.user}（Windows のログオン名。指摘の登録者・取込者の記録に使います）`),
        ),
        h(
          "section",
          { class: "settings-section", "aria-labelledby": "set-storage" },
          h("h3", { id: "set-storage" }, "保存先"),
          s.overridden
            ? h("div", { class: "notice warn" }, "起動引数 --root で保存先を指定して起動しています。ここで保存した内容は、--root を付けずに起動したときに使われます。")
            : null,
          s.project.source === "fallback"
            ? h("div", { class: "notice bad" }, `設定した保存先（${s.saved.projectPath}）が使えないため、既定の保存先で起動しています。保存先を選び直してください。`)
            : null,
          s.importing ? h("div", { class: "notice warn" }, "取込中は保存先を変えられません。取込が終わってから操作してください。") : null,
          s.restartPending && !this.dirty && s.project.source !== "fallback"
            ? h(
                "div",
                { class: "notice" },
                h("span", { class: "grow" }, "保存した保存先は、再起動すると使われます。"),
                h("button", { class: "primary", disabled: locked, onclick: () => this.restart() }, "今すぐ再起動"),
              )
            : null,
          this.renderCard("project", locked),
          this.renderCard("config", locked),
          h(
            "p",
            { class: "small muted" },
            "保存先を変えても、今あるデータは移動しません。今のデータを使い続けるときは、「エクスプローラーで開く」から新しいフォルダへコピーしてから切り替えてください。",
          ),
        ),
        h(
          "details",
          { class: "settings-section" },
          h("summary", null, "この PC の作業領域（変更できません）"),
          h("p", { class: "small muted" }, "ログ・変換の作業用・画面の状態は、保存先とは別にこの PC の利用者ごとに保存します。アンインストールしても消えません。"),
          h(
            "table",
            { class: "settings-local" },
            h(
              "tbody",
              null,
              this.localRow("保存先の設定", s.local.settingsFile, "local"),
              this.localRow("ログ", s.local.logs, "logs"),
              this.localRow("変換の作業用", s.local.work, "work"),
              this.localRow("画面の状態", s.local.webview, null),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "actions" },
        this.dirty ? h("span", { class: "small muted grow" }, "まだ保存していない変更があります。") : null,
        h("button", { onclick: () => this.dlg.close() }, this.dirty ? "保存せずに閉じる" : "閉じる"),
        h(
          "button",
          { class: "primary", disabled: !this.dirty || this.hasErrors || locked, onclick: () => this.save() },
          s.overridden ? "保存" : "保存して再起動…",
        ),
      ),
    );
  }

  private renderCard(kind: FolderKind, locked: boolean) {
    const s = this.state!;
    const cur = s[kind];
    const text = KIND_TEXT[kind];
    const draft = kind === "project" ? this.project : this.config;
    const savedPath = kind === "project" ? s.saved.projectPath : s.saved.configPath;
    const nextPath = kind === "project" ? this.nextProjectPath : this.nextConfigPath;
    const nextIsDefault = kind === "project" ? this.nextDataRoot === null : this.nextConfigRoot === null;
    // 次の起動で使う場所の検査結果（下書き、または連動して変わる設定データ）
    const nextInfo = draft?.info ?? (kind === "config" && this.configMoves ? this.nextConfigInfo : null);
    const changed = !samePath(nextPath, cur.path);
    const id = `set-${kind}`;
    return h(
      "div",
      { class: "storage-card", role: "group", "aria-labelledby": id },
      h("div", { class: "row" }, h("b", { id, class: "grow" }, text.title)),
      h("div", { class: "small muted" }, text.desc),
      this.pathLine("使用中", cur.path, SOURCE_LABEL[cur.source], cur.info, kind),
      // 保存済みだが未反映（再起動待ち・--root 中）
      !draft && !samePath(savedPath, cur.path) && cur.source !== "fallback"
        ? this.pathLine(s.overridden ? "--root なしの起動" : "再起動後", savedPath, nextIsDefault ? "既定" : "設定で指定", null, kind)
        : null,
      draft || (kind === "config" && this.configMoves && !samePath(savedPath, nextPath))
        ? h(
            "div",
            { class: "storage-next" },
            this.pathLine(
              "変更後",
              nextPath,
              nextIsDefault ? (kind === "config" ? "既定（プロジェクトフォルダの config）" : "既定") : "設定で指定",
              nextInfo,
              kind,
            ),
            nextInfo ? this.infoMessages(kind, nextInfo) : null,
            kind === "config" && !draft
              ? h("div", { class: "small muted" }, "プロジェクトフォルダに合わせて切り替わります。")
              : null,
            kind === "config" && this.configMoves && changed
              ? h(
                  "label",
                  { class: "row small" },
                  h("input", {
                    type: "checkbox",
                    checked: this.copyConfig,
                    onchange: (e: Event) => (this.copyConfig = (e.target as HTMLInputElement).checked),
                  }),
                  "今の設定データ（app.json・メンバー）を新しい場所へ写す（同じ名前のファイルは上書きしません）",
                )
              : null,
            draft
              ? h("div", { class: "row" }, h("button", { disabled: locked, onclick: () => this.setDraft(kind, undefined) }, "変更を取り消す"))
              : null,
          )
        : null,
      h(
        "div",
        { class: "row" },
        h("button", { disabled: this.busy, onclick: () => this.openFolder(kind), title: cur.path }, "エクスプローラーで開く"),
        h("span", { class: "grow" }),
        !nextIsDefault ? h("button", { disabled: locked, onclick: () => this.reset(kind) }, "既定に戻す") : null,
        h("button", { disabled: locked, onclick: () => this.change(kind) }, "変更…"),
      ),
    );
  }

  private pathLine(label: string, path: string, source: string, info: FolderInfo | null, kind: FolderKind) {
    return h(
      "div",
      { class: "storage-path" },
      h("span", { class: "storage-label small muted" }, label),
      h("code", { class: "grow", title: path }, path),
      h("span", { class: "chip" }, source),
      info ? h("div", { class: "storage-meta small muted" }, describe(kind, info)) : null,
    );
  }

  /** 選んだフォルダについて、切り替えると何が起きるか・注意点 */
  private infoMessages(kind: FolderKind, info: FolderInfo) {
    const s = this.state!;
    const notes: { cls: string; text: string }[] = [];
    for (const e of info.errors) notes.push({ cls: "bad", text: e });
    for (const w of info.warnings) notes.push({ cls: "warn", text: w });
    if (info.errors.length === 0) {
      if (kind === "project") {
        const now = s.project.info.datasets ?? 0;
        if (!info.exists) notes.push({ cls: "", text: "フォルダはまだありません。保存するときに作ります。" });
        if ((info.datasets ?? 0) > 0)
          notes.push({ cls: "", text: `取込済みの版 ${info.datasets} 件が入っています。切り替えると、このフォルダの内容が一覧に出ます。` });
        else if (now > 0)
          notes.push({ cls: "", text: `取込済みの版はありません。今のフォルダの版 ${now} 件は移動しないので、切り替えると一覧は空になります。` });
      } else if (!info.exists) {
        notes.push({ cls: "", text: "フォルダはまだありません。保存するときに作ります。" });
      } else if (info.hasAppJson || (info.members ?? 0) > 0) {
        notes.push({ cls: "", text: "設定データが入っています。切り替えると、このフォルダの設定を使います。" });
      }
    }
    return notes.length ? h("ul", { class: "storage-notes small" }, notes.map((n) => h("li", { class: n.cls }, n.text))) : null;
  }

  private localRow(label: string, path: string, open: OpenableFolder | null) {
    return h(
      "tr",
      null,
      h("td", { class: "muted" }, label),
      h("td", null, h("code", { title: path }, path)),
      h("td", null, open ? h("button", { class: "small", disabled: this.busy, onclick: () => this.openFolder(open) }, "開く") : null),
    );
  }
}

/** フォルダの要約（空き容量・中身） */
export function describe(kind: FolderKind, info: FolderInfo): string {
  const parts: string[] = [];
  if (info.exists === false) parts.push("未作成");
  if (info.freeBytes != null) parts.push(`空き ${formatBytes(info.freeBytes)}${info.totalBytes ? ` / ${formatBytes(info.totalBytes)}` : ""}`);
  if (info.driveType === "Network") parts.push("ネットワーク");
  else if (info.driveType === "Removable") parts.push("取り外せるドライブ");
  if (info.exists) {
    if (kind === "project") parts.push(`取込済みの版 ${info.datasets ?? 0} 件`);
    else parts.push(`app.json ${info.hasAppJson ? "あり" : "なし"}・メンバー ${info.members ?? 0} 人`);
  }
  return parts.join("　");
}
