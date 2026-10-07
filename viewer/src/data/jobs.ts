// 処理（ジョブ）の型と状態の畳み込み。ホストの通知 job.progress（app/Kasane.Host/JobService.cs）を 1 件ずつ reduceJob に通す。
// DOM・App に依存しない（単体テストできるように）。

import type { DerivedEntry } from "./dataset";

/** 処理パネルの入力欄の定義（JobService.Kinds の ParamsJson） */
export type JobParamDef =
  | { key: string; label: string; type: "number"; default?: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: "text"; default?: string }
  | { key: string; label: string; type: "checkbox"; default?: boolean }
  | { key: string; label: string; type: "select"; default?: string; options: { value: string; label: string }[] };

export interface JobKindInfo {
  id: string;
  label: string;
  /** derived: 版の成果に追記する / newVersion: 新しい版を作る */
  target: "derived" | "newVersion";
  needsPointcloud: boolean;
  description?: string | null;
  params: JobParamDef[];
}

/** 公開した新しい版（done の version）。manifest の一部 */
export interface PublishedVersion {
  folder: string;
  name: string;
  version: number;
  [key: string]: unknown;
}

/**
 * 処理の通知 job.progress の data。
 * stage / progress / log / error は変換エンジンの JSON 行そのまま。
 */
export type JobProgress = { jobId: string; kind: string; folder: string } & (
  | { event: "queued"; position: number }
  | { event: "started" }
  | { event: "stage"; stage: string; label: string; weight: number }
  | { event: "progress"; stage: string; done: number; total: number; message?: string }
  | { event: "log"; level: string; message: string }
  | { event: "error"; message: string }
  | { event: "done"; entry?: DerivedEntry; version?: PublishedVersion }
  | { event: "failed"; message: string }
  | { event: "aborted" }
);

export type JobStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface JobStage {
  id: string;
  label: string;
  weight: number;
  fraction: number;
}

/** 実行中・直近に終わった処理の状態（画面を閉じるまで残す） */
export interface JobState {
  jobId: string;
  kind: string;
  folder: string;
  status: JobStatus;
  /** 待ち行列の位置（1 = 次）。待っていなければ 0 */
  position: number;
  stages: JobStage[];
  /** 今の段階の表示（「点群の読込 42%（…）」） */
  current: string;
  /** 最後の段階・進捗の通知 */
  last: JobProgress | null;
  /** 失敗・エラーの文 */
  message?: string;
  /** 注意・警告のログ（info は残さない） */
  warnings: string[];
  /** derived: 追記した成果 */
  entry?: DerivedEntry;
  /** newVersion: 公開した版 */
  version?: PublishedVersion;
}

export function newJobState(jobId: string, kind: string, folder: string, status: JobStatus = "queued"): JobState {
  return { jobId, kind, folder, status, position: 0, stages: [], current: status === "queued" ? "待機中" : "", last: null, warnings: [] };
}

export const isActiveJob = (s: JobState) => s.status === "queued" || s.status === "running";

const pct = (f: number) => `${Math.floor(f * 100)}%`;

/** 通知を 1 件反映する（s を書き換えて返す）。終わった後に届いた通知は無視する */
export function reduceJob(s: JobState, p: JobProgress): JobState {
  if (!isActiveJob(s)) return s;
  switch (p.event) {
    case "queued":
      s.status = "queued";
      s.position = p.position;
      s.current = p.position <= 1 ? "待機中（次に始まります）" : `待機中（${p.position} 番目）`;
      break;
    case "started":
      s.status = "running";
      s.position = 0;
      s.current = "開始しています";
      break;
    case "stage": {
      s.status = "running";
      s.position = 0;
      let st = s.stages.find((x) => x.id === p.stage);
      if (!st) s.stages.push((st = { id: p.stage, label: p.label, weight: Math.max(0, p.weight || 0), fraction: 0 }));
      else st.label = p.label;
      s.current = p.label;
      s.last = p;
      break;
    }
    case "progress": {
      s.status = "running";
      let st = s.stages.find((x) => x.id === p.stage);
      // 画面を開き直したとき（jobList の last）は段階の開始を見ていない。名前だけで仮に足す
      if (!st) s.stages.push((st = { id: p.stage, label: p.stage, weight: 0, fraction: 0 }));
      const f = p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;
      st.fraction = f;
      s.current = `${st.label} ${pct(f)}${p.message ? `（${p.message}）` : ""}`;
      s.last = p;
      break;
    }
    case "log":
      if (p.level !== "info") s.warnings.push(p.message);
      break;
    case "error":
      s.message = p.message;
      break;
    case "done":
      s.status = "done";
      s.position = 0;
      s.entry = p.entry;
      s.version = p.version;
      s.current = "完了";
      for (const st of s.stages) st.fraction = 1;
      break;
    case "failed":
      s.status = "failed";
      s.position = 0;
      s.message = p.message;
      s.current = "失敗";
      break;
    case "aborted":
      s.status = "aborted";
      s.position = 0;
      s.current = "中断しました";
      break;
  }
  return s;
}

/**
 * 全体の進み具合（0〜1）。段階の重みで按分する。
 * 重みの合計が 0（ホストが写すだけの段階など）なら今の段階の進み具合。終わるまでは 1 にしない
 */
export function jobFraction(s: JobState): number {
  if (s.status === "done") return 1;
  if (s.status === "queued" || s.stages.length === 0) return 0;
  const total = s.stages.reduce((a, x) => a + x.weight, 0);
  const f = total > 0
    ? s.stages.reduce((a, x) => a + x.weight * x.fraction, 0) / Math.max(1, total)
    : s.stages[s.stages.length - 1].fraction;
  return Math.min(0.99, f);
}

/** 入力欄の既定値 */
export function defaultParams(kind: JobKindInfo): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const p of kind.params) {
    if (p.default !== undefined) v[p.key] = p.default;
    else if (p.type === "checkbox") v[p.key] = false;
    else if (p.type === "select") v[p.key] = p.options[0]?.value ?? "";
    else if (p.type === "text") v[p.key] = "";
  }
  return v;
}

/** 入力値を確かめて揃える（数は数に、範囲外はエラー）。errors が空なら始められる */
export function checkParams(kind: JobKindInfo, input: Record<string, unknown>): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const defaults = defaultParams(kind);
  for (const p of kind.params) {
    const raw = input[p.key] ?? defaults[p.key];
    if (p.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
      if (raw === undefined || raw === "" || !Number.isFinite(n)) {
        errors.push(`「${p.label}」に数を入れてください`);
        continue;
      }
      if (p.min !== undefined && n < p.min) errors.push(`「${p.label}」は ${p.min} 以上にしてください`);
      if (p.max !== undefined && n > p.max) errors.push(`「${p.label}」は ${p.max} 以下にしてください`);
      values[p.key] = n;
    } else if (p.type === "checkbox") {
      values[p.key] = !!raw;
    } else if (p.type === "select") {
      const s = String(raw ?? "");
      if (!p.options.some((o) => o.value === s)) errors.push(`「${p.label}」を選んでください`);
      values[p.key] = s;
    } else {
      values[p.key] = String(raw ?? "");
    }
  }
  return { values, errors };
}
