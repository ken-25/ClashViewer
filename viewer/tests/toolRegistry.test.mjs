// ツールの登録口の単体テスト（node --test）
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let reg;
const out = mkdtempSync(join(tmpdir(), "kasane-test-"));

before(async () => {
  await build({
    logLevel: "silent",
    configFile: false,
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { reg: "src/tools/toolRegistry.ts" }, formats: ["es"] } },
  });
  reg = await import(pathToFileURL(join(out, "reg.js")));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
});

test("registerTool: 登録・取得・二重登録の拒否", () => {
  reg.registerTool({ id: "t1", title: "T1", hint: () => "" });
  assert.equal(reg.getTool("t1").title, "T1");
  assert.ok(reg.hasTool("t1"));
  assert.throws(() => reg.registerTool({ id: "t1", title: "x", hint: () => "" }));
  assert.throws(() => reg.getTool("none"));
});

test("toolbarTools: toolbar を持つものだけ、order 順", () => {
  reg.registerTool({ id: "b", title: "B", toolbar: { label: "B", tooltip: "", order: 20 }, hint: () => "" });
  reg.registerTool({ id: "a", title: "A", toolbar: { label: "A", tooltip: "", order: 10 }, hint: () => "" });
  assert.deepEqual(reg.toolbarTools().map((t) => t.id), ["a", "b"]);
});
