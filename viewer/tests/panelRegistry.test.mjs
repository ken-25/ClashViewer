// 左タブ・見え方の登録口の単体テスト（node --test）
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
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { reg: "src/ui/panelRegistry.ts" }, formats: ["es"] } },
  });
  reg = await import(pathToFileURL(join(out, "reg.js")));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
});

const tab = (id, order) => ({ id, label: id, order, topics: [], setup: () => () => {} });

test("registerLeftTab: order 順・二重登録の拒否", () => {
  reg.registerLeftTab(tab("b", 20));
  reg.registerLeftTab(tab("a", 10));
  assert.deepEqual(reg.leftTabs().map((t) => t.id), ["a", "b"]);
  assert.throws(() => reg.registerLeftTab(tab("a", 30)));
});

test("registerViewBarItem: order 順・二重登録と、menu も onClick も無い項目の拒否", () => {
  reg.registerViewBarItem({ id: "v2", order: 20, label: "V2", title: "", onClick: () => {} });
  reg.registerViewBarItem({ id: "v1", order: 10, label: "V1", title: "", menu: { ariaLabel: "V1", build: () => {} } });
  assert.deepEqual(reg.viewBarItems().map((t) => t.id), ["v1", "v2"]);
  assert.throws(() => reg.registerViewBarItem({ id: "v1", order: 0, label: "x", title: "", onClick: () => {} }));
  assert.throws(() => reg.registerViewBarItem({ id: "v3", order: 0, label: "x", title: "" }));
});
