// 処理（ジョブ）の状態の畳み込み・進み具合・入力値の検査、分類の名前と色の単体テスト（node --test）
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let jobs;
let cls;
const out = mkdtempSync(join(tmpdir(), "kasane-test-"));

before(async () => {
  await build({
    logLevel: "silent",
    configFile: false,
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { jobs: "src/data/jobs.ts", cls: "src/data/pointClasses.ts" }, formats: ["es"] } },
  });
  jobs = await import(pathToFileURL(join(out, "jobs.js")));
  cls = await import(pathToFileURL(join(out, "cls.js")));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
});

const ev = (event, rest = {}) => ({ jobId: "j", kind: "k", folder: "f", event, ...rest });

test("reduceJob: 待機 → 開始 → 段階・進捗 → 完了", () => {
  const s = jobs.newJobState("j", "k", "f");
  assert.equal(s.status, "queued");
  jobs.reduceJob(s, ev("queued", { position: 2 }));
  assert.equal(s.position, 2);
  assert.match(s.current, /2 番目/);
  assert.equal(jobs.jobFraction(s), 0);
  jobs.reduceJob(s, ev("started"));
  assert.equal(s.status, "running");
  assert.equal(s.position, 0);
  jobs.reduceJob(s, ev("stage", { stage: "a", label: "読込", weight: 0.6 }));
  jobs.reduceJob(s, ev("progress", { stage: "a", done: 50, total: 100 }));
  assert.ok(Math.abs(jobs.jobFraction(s) - 0.3) < 1e-9);
  jobs.reduceJob(s, ev("stage", { stage: "b", label: "LOD 化", weight: 0.4 }));
  jobs.reduceJob(s, ev("progress", { stage: "a", done: 100, total: 100 }));
  jobs.reduceJob(s, ev("progress", { stage: "b", done: 100, total: 100, message: "x" }));
  // 終わるまでは 100% にしない
  assert.equal(jobs.jobFraction(s), 0.99);
  assert.match(s.current, /LOD 化 100%（x）/);
  jobs.reduceJob(s, ev("log", { level: "info", message: "i" }));
  jobs.reduceJob(s, ev("log", { level: "warn", message: "w" }));
  assert.deepEqual(s.warnings, ["w"]);
  jobs.reduceJob(s, ev("done", { version: { folder: "g", name: "n", version: 3 } }));
  assert.equal(s.status, "done");
  assert.equal(s.version.version, 3);
  assert.equal(jobs.jobFraction(s), 1);
  // 終わった後の通知は無視する
  jobs.reduceJob(s, ev("failed", { message: "late" }));
  assert.equal(s.status, "done");
});

test("reduceJob: 失敗・中断、開き直したとき（段階を見ていない進捗）", () => {
  const f = jobs.newJobState("j", "k", "f", "running");
  jobs.reduceJob(f, ev("error", { message: "e1" }));
  jobs.reduceJob(f, ev("failed", { message: "e2" }));
  assert.equal(f.status, "failed");
  assert.equal(f.message, "e2");
  assert.equal(jobs.isActiveJob(f), false);
  const a = jobs.newJobState("j", "k", "f");
  jobs.reduceJob(a, ev("aborted"));
  assert.equal(a.status, "aborted");
  const r = jobs.newJobState("j", "k", "f", "running");
  jobs.reduceJob(r, ev("progress", { stage: "read", done: 1, total: 4 }));
  assert.equal(r.stages.length, 1);
  assert.equal(jobs.jobFraction(r), 0.25);
});

test("checkParams / defaultParams: 既定値・数の変換・範囲", () => {
  const kind = {
    id: "k", label: "K", target: "newVersion", needsPointcloud: true,
    params: [
      { key: "step", label: "間引き", type: "number", default: 1, min: 1, max: 10 },
      { key: "note", label: "メモ", type: "text" },
      { key: "on", label: "オン", type: "checkbox" },
      { key: "mode", label: "方法", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    ],
  };
  assert.deepEqual(jobs.defaultParams(kind), { step: 1, note: "", on: false, mode: "a" });
  assert.deepEqual(jobs.checkParams(kind, { step: "3", note: "x", on: true, mode: "b" }), { values: { step: 3, note: "x", on: true, mode: "b" }, errors: [] });
  assert.equal(jobs.checkParams(kind, { step: "0" }).errors.length, 1);
  assert.equal(jobs.checkParams(kind, { step: "11" }).errors.length, 1);
  assert.equal(jobs.checkParams(kind, { step: "abc" }).errors.length, 1);
  assert.equal(jobs.checkParams(kind, { step: "", mode: "z" }).errors.length, 2);
});

test("pointClasses: 標準の名前・設定での上書き・壊れた設定は無視・色の表", () => {
  assert.equal(cls.classInfo(2).name, "地面");
  assert.equal(cls.classInfo(200).name, "分類 200");
  assert.match(cls.classInfo(200).color, /^#[0-9a-f]{6}$/);
  const ov = cls.parseClassOverrides({ 2: { name: "床", color: "#FF0000" }, 300: { name: "x" }, abc: {}, 5: { color: "red" } });
  assert.deepEqual(cls.classInfo(2, ov), { code: 2, name: "床", color: "#ff0000" });
  assert.equal(ov.has(300), false);
  assert.equal(cls.classInfo(5, ov).color, cls.classInfo(5).color);
  const t = cls.classTable(new Set([2]), ov);
  assert.equal(t.length, 1024);
  assert.deepEqual([...t.slice(8, 12)], [255, 0, 0, 0]);
  assert.equal(t[3 * 4 + 3], 255);
});
