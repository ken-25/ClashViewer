// manifest の版の移行（schema 1 → 2）の単体テスト（node --test）
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let ds;
const out = mkdtempSync(join(tmpdir(), "kasane-test-"));

before(async () => {
  await build({
    logLevel: "silent",
    configFile: false,
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { dataset: "src/data/dataset.ts" }, formats: ["es"] } },
  });
  ds = await import(pathToFileURL(join(out, "dataset.js")));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
});

test("migrateManifest: schema 1 に derived・parent を補い、元は変えない", () => {
  const raw = { schema: 1, id: "a", folder: "f", models: [], importLog: [] };
  const m = ds.migrateManifest(raw);
  assert.deepEqual(m.derived, []);
  assert.equal(m.parent, null);
  assert.equal(raw.derived, undefined);
});

test("migrateManifest: schema 2 の値はそのまま", () => {
  const entry = { id: "j1", kind: "selftest", dir: "derived/j1", files: ["derived/j1/summary.json"] };
  const m = ds.migrateManifest({ schema: 2, derived: [entry], parent: { folder: "p", jobKind: "x" }, models: [], importLog: [] });
  assert.equal(m.derived[0], entry);
  assert.equal(m.parent.folder, "p");
});

test("migrateManifests: 新しすぎる版は外して理由を返す", () => {
  const r = ds.migrateManifests([{ schema: 1, folder: "a" }, { schema: 99, folder: "b" }]);
  assert.deepEqual(r.ok.map((m) => m.folder), ["a"]);
  assert.equal(r.skipped[0].folder, "b");
});

test("derivedRel: files は版フォルダ相対・dir 相対のどちらでも", () => {
  const m = { folder: "20260101_x_abc" };
  const e = { dir: "derived/j1" };
  assert.equal(ds.derivedRel(m, e, "derived/j1/a.json"), "datasets/20260101_x_abc/derived/j1/a.json");
  assert.equal(ds.derivedRel(m, e, "a.json"), "datasets/20260101_x_abc/derived/j1/a.json");
});
