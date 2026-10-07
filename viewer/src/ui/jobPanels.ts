// 処理（ジョブ）の画面: 右パネル「処理」ツール（始める）と、左タブ「成果」（進捗・中断・結果の一覧）。
// 定義（ツール・タブの登録）は modes/builtinJobs.ts。

import type { App } from "../app";
import type { DerivedEntry, Manifest } from "../data/dataset";
import { checkParams, defaultParams, isActiveJob, jobFraction, type JobKindInfo, type JobParamDef, type JobState } from "../data/jobs";
import { hasDerivedLayerKind } from "../features/derivedLayers";
import { activateLeftTab } from "./panelHost";
import { fmtDate, h, mount, showMessage } from "./dom";

// ---- 共通 ----

/** 版の短い名前（「改修A棟 第2版」）。一覧に無ければフォルダ名 */
export function versionLabel(app: App, folder: string): string {
  const m = app.datasets.find((d) => d.folder === folder);
  return m ? `${m.name} 第${m.version}版` : folder;
}

function kindLabel(app: App, kind: string): string {
  return app.jobKind(kind)?.label ?? kind;
}

const STATUS_LABEL: Record<JobState["status"], string> = {
  queued: "待機中",
  running: "実行中",
  done: "完了",
  failed: "失敗",
  aborted: "中断",
};

async function openVersion(app: App, folder: string) {
  await app.refreshDatasets();
  const m = app.datasets.find((d) => d.folder === folder);
  if (!m) {
    await showMessage("開けません", "版が見つかりません。一覧を読み直してください。");
    return;
  }
  await app.openDataset(m).catch((e) => showMessage("開けません", String(e)));
}

async function abort(app: App, j: JobState) {
  try {
    await app.abortJob(j.jobId);
  } catch (e) {
    await showMessage("中断できません", String(e instanceof Error ? e.message : e));
  }
}

/** 処理 1 件（進捗・中断・結果への入口） */
function jobItem(app: App, j: JobState, showVersion: boolean): HTMLElement {
  const active = isActiveJob(j);
  const f = jobFraction(j);
  const newVersion = j.version;
  return h("div", { class: `job-item ${j.status}`, "data-job": j.jobId },
    h("div", { class: "row small" },
      h("b", { class: "grow" }, kindLabel(app, j.kind)),
      h("span", { class: `job-status ${j.status}` }, STATUS_LABEL[j.status]),
      j.status === "running" ? h("span", { class: "num" }, `${Math.floor(f * 100)}%`) : null),
    showVersion ? h("div", { class: "small muted" }, versionLabel(app, j.folder)) : null,
    j.status === "running" ? h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.floor(f * 100)), "aria-label": `${kindLabel(app, j.kind)} の進み具合` },
      h("div", { style: `width:${(f * 100).toFixed(1)}%` })) : null,
    active || j.status === "done" ? h("div", { class: "small msg muted" }, j.current) : null,
    j.message && j.status !== "done" ? h("div", { class: "small err" }, j.message) : null,
    j.warnings.length ? h("details", { class: "small" }, h("summary", null, `注意 ${j.warnings.length} 件`), h("ul", null, j.warnings.slice(-20).map((w) => h("li", null, w)))) : null,
    h("div", { class: "row small" },
      active ? h("button", { class: "small", "data-focus": `job:${j.jobId}:abort`, title: j.status === "queued" ? "待ち行列から外す" : "処理を止める（結果は残りません）", onclick: () => void abort(app, j) }, j.status === "queued" ? "取り消す" : "中断") : null,
      newVersion ? h("button", { class: "small", "data-focus": `job:${j.jobId}:open`, title: "処理で作った版を開く", onclick: () => void openVersion(app, newVersion.folder) }, `第${newVersion.version}版を開く`) : null),
  );
}

// ---- 右パネル: 処理ツール ----

/** 選んでいる種類と、種類ごとの入力値（パネルを描き直しても残す） */
const form = { kind: "" as string, values: new Map<string, Record<string, unknown>>(), errors: [] as string[], starting: false };

function paramField(def: JobParamDef, values: Record<string, unknown>): HTMLElement {
  const id = `job-param-${def.key}`;
  const set = (v: unknown) => (values[def.key] = v);
  let input: HTMLElement;
  if (def.type === "number") {
    input = h("input", { id, type: "number", class: "grow", value: String(values[def.key] ?? ""), min: def.min !== undefined ? String(def.min) : undefined, max: def.max !== undefined ? String(def.max) : undefined, step: def.step !== undefined ? String(def.step) : "any",
      oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  } else if (def.type === "checkbox") {
    return h("label", { class: "row small" }, h("input", { id, type: "checkbox", checked: !!values[def.key], onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), def.label);
  } else if (def.type === "select") {
    input = h("select", { id, class: "grow", onchange: (e: Event) => set((e.target as HTMLSelectElement).value) },
      def.options.map((o) => h("option", { value: o.value, selected: values[def.key] === o.value }, o.label)));
  } else {
    input = h("input", { id, type: "text", class: "grow", value: String(values[def.key] ?? ""), oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  }
  return h("div", { class: "row small" }, h("label", { for: id, class: "lbl-wide" }, def.label), input);
}

function valuesFor(kind: JobKindInfo): Record<string, unknown> {
  if (!form.values.has(kind.id)) form.values.set(kind.id, defaultParams(kind));
  return form.values.get(kind.id)!;
}

/** 始められない理由（無ければ null） */
function blocker(app: App, kind: JobKindInfo): string | null {
  if (!app.current) return "プロジェクトを開いてください。";
  if (kind.needsPointcloud && !app.current.pointcloud) return "この版には点群がありません。";
  return null;
}

async function start(app: App, kind: JobKindInfo, el: HTMLElement, head: HTMLElement) {
  const m = app.current;
  if (!m || form.starting) return;
  const { values, errors } = checkParams(kind, valuesFor(kind));
  form.errors = errors;
  if (errors.length) {
    renderJobToolPanel(app, el, head);
    return;
  }
  form.starting = true;
  renderJobToolPanel(app, el, head);
  try {
    await app.startJob(kind.id, m.folder, values);
  } catch (e) {
    form.errors = [String(e instanceof Error ? e.message : e)];
  } finally {
    form.starting = false;
    if (app.tool === "jobs") renderJobToolPanel(app, el, head);
  }
}

/** 右パネル「処理」: 種類を選び、設定を入れて始める。進み具合は下の欄と左の「成果」タブ */
export function renderJobToolPanel(app: App, el: HTMLElement, head: HTMLElement) {
  const kinds = app.jobKinds;
  if (!kinds.some((k) => k.id === form.kind)) form.kind = kinds[0]?.id ?? "";
  const kind = kinds.find((k) => k.id === form.kind);
  const m = app.current;
  const stop = kind ? blocker(app, kind) : null;
  mount(
    el,
    head,
    kinds.length === 0
      ? h("p", { class: "small muted" }, "使える処理はありません。")
      : [
          h("div", { class: "row small" }, h("label", { for: "job-kind", class: "lbl-wide" }, "処理"),
            h("select", { id: "job-kind", class: "grow", onchange: (e: Event) => { form.kind = (e.target as HTMLSelectElement).value; form.errors = []; renderJobToolPanel(app, el, head); } },
              kinds.map((k) => h("option", { value: k.id, selected: k.id === form.kind }, k.label)))),
          kind?.description ? h("p", { class: "small muted" }, kind.description) : null,
          kind && m
            ? h("p", { class: "small" }, kind.target === "newVersion"
                ? `結果は新しい版（${m.name} 第${nextVersion(app, m)}版）として公開します。${m.name} 第${m.version}版はそのまま残ります。`
                : `結果は ${m.name} 第${m.version}版の成果（左の「成果」タブ）に追加します。`)
            : null,
          kind ? kind.params.map((p) => paramField(p, valuesFor(kind))) : null,
          form.errors.length ? h("ul", { class: "small err", role: "alert" }, form.errors.map((e) => h("li", null, e))) : null,
          stop ? h("p", { class: "small muted" }, stop) : null,
          h("div", { class: "row" },
            h("button", { class: "primary", id: "btn-job-start", disabled: !kind || !!stop || form.starting, onclick: () => kind && void start(app, kind, el, head) }, form.starting ? "受付中…" : "開始")),
          h("p", { class: "small muted" }, "処理は 1 件ずつ順に動きます。動いている間も画面は使えます。"),
        ],
    h("div", { id: "job-tool-status" }),
  );
  refreshJobToolPanel(app, el);
}

/** 新しい版にしたときの版番号（今ある最大の版 + 1） */
function nextVersion(app: App, m: Manifest): number {
  return Math.max(m.version, ...app.versionsOf(m.site).map((d) => d.version)) + 1;
}

/** 右パネル「処理」の下の欄（この版の、待っている・動いている処理）だけを描き直す */
export function refreshJobToolPanel(app: App, el: HTMLElement) {
  const box = el.querySelector<HTMLElement>("#job-tool-status");
  if (!box) return;
  const folder = app.current?.folder;
  const jobs = [...app.jobs.values()].filter((j) => j.folder === folder && (isActiveJob(j) || j.status !== "aborted")).slice(-5).reverse();
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#job-tool-status [data-focus]")?.dataset.focus;
  mount(box,
    jobs.length ? h("h3", null, "この版の処理") : null,
    jobs.map((j) => jobItem(app, j, false)),
    jobs.length ? h("button", { class: "small link", onclick: () => activateLeftTab("results") }, "左の「成果」タブで一覧を見る") : null);
  if (focused) box.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

// ---- 左タブ: 成果 ----

/** 結果の要約（result の数・文字の値を短く並べる） */
function resultSummary(entry: DerivedEntry): string {
  const skip = new Set(["kind", "converterVersion", "files", "log"]);
  return Object.entries(entry.result ?? {})
    .filter(([k, v]) => !skip.has(k) && (typeof v === "number" || typeof v === "string"))
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toLocaleString("ja-JP") : v}`)
    .join("　");
}

function derivedItem(app: App, entry: DerivedEntry): HTMLElement {
  const layer = app.derivedLayers.get(entry.id);
  const summary = resultSummary(entry);
  return h("div", { class: "job-item done", "data-derived": entry.id },
    h("div", { class: "row small" }, h("b", { class: "grow" }, entry.label || entry.kind), h("span", { class: "muted" }, fmtDate(entry.createdAt))),
    h("div", { class: "small muted" }, `${app.memberName(entry.createdBy)}・${entry.files.length} ファイル`),
    summary ? h("div", { class: "small" }, summary) : null,
    layer
      ? h("div", { class: "row small" },
          h("button", { class: "small", "data-focus": `derived:${entry.id}:show`, disabled: layer.status === "loading", onclick: () => void app.derivedLayers.setVisible(entry.id, !layer.visible) },
            layer.status === "loading" ? "読込中…" : layer.visible ? "レイヤーで隠す" : "レイヤーに表示"),
          layer.error ? h("span", { class: "err" }, layer.error) : null)
      : hasDerivedLayerKind(entry.kind) ? null : h("div", { class: "small muted" }, "この結果は 3D には出せません。"),
  );
}

/** 左タブ「成果」: 処理の進み具合（待機中・実行中）、この版の成果、この版から作った版、終わった処理 */
export function renderResults(app: App, el: HTMLElement) {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#tab-results [data-focus]")?.dataset.focus;
  const jobs = [...app.jobs.values()];
  const active = jobs.filter(isActiveJob);
  const finished = jobs.filter((j) => !isActiveJob(j)).reverse();
  const m = app.current;
  const children = m ? app.datasets.filter((d) => d.parent?.folder === m.folder) : [];
  const parent = m?.parent ?? null;
  mount(
    el,
    h("h2", null, `実行中・待機中（${active.length}）`),
    active.length === 0
      ? h("p", { class: "small muted" }, "動いている処理はありません。ツールバーの「処理」から始められます。")
      : active.map((j) => jobItem(app, j, true)),
    m ? [
      h("h2", null, `この版の成果（${m.derived.length}）`),
      m.derived.length === 0
        ? h("p", { class: "small muted" }, "まだありません。")
        : [...m.derived].reverse().map((e) => derivedItem(app, e)),
      parent || children.length
        ? [
            h("h2", null, "処理で作った版"),
            parent
              ? h("div", { class: "row small" },
                  h("span", { class: "grow" }, `この版は ${versionLabel(app, parent.folder)} から「${kindLabel(app, parent.jobKind)}」で作りました${parent.note ? `（${parent.note}）` : ""}`),
                  app.datasets.some((d) => d.folder === parent.folder)
                    ? h("button", { class: "small", "data-focus": "parent:open", onclick: () => void openVersion(app, parent.folder) }, "元の版を開く")
                    : h("span", { class: "muted" }, "（元の版は見つかりません）"))
              : null,
            children.map((c) =>
              h("div", { class: "row small" },
                h("span", { class: "grow" }, `第${c.version}版（「${kindLabel(app, c.parent!.jobKind)}」・${fmtDate(c.createdAt)}）`),
                h("button", { class: "small", "data-focus": `child:${c.folder}:open`, onclick: () => void openVersion(app, c.folder) }, "開く"))),
          ]
        : null,
    ] : null,
    finished.length
      ? [
          h("div", { class: "row" }, h("h2", { class: "grow" }, `終わった処理（${finished.length}）`),
            h("button", { class: "small", title: "この一覧から消す（成果・版は消えません）", onclick: () => app.clearFinishedJobs() }, "一覧から消す")),
          finished.map((j) => jobItem(app, j, true)),
        ]
      : null,
  );
  if (focused) el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}
