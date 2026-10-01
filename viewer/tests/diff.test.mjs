// 差分・3点合わせの単体テスト（node --test）。TS を直接読めないので vite で一時的に束ねてから読む
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let diff, align, THREE, issues;
const out = mkdtempSync(join(tmpdir(), "cv-test-"));

before(async () => {
  await build({
    logLevel: "silent",
    configFile: false,
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: false,
      lib: { entry: { diff: "src/data/diff.ts", align: "src/tools/align.ts", issues: "src/issues/issues.ts", three: "node_modules/three/build/three.module.js" }, formats: ["es"] },
      rollupOptions: { external: [] },
    },
  });
  diff = await import(pathToFileURL(join(out, "diff.js")));
  align = await import(pathToFileURL(join(out, "align.js")));
  issues = await import(pathToFileURL(join(out, "issues.js")));
  THREE = await import(pathToFileURL(join(out, "three.js")));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
});

const idx = (items) => ({ version: 1, items });
const rec = (b, h = "x", c = "IFCCOLUMN", n = "c") => ({ c, n, b, h });

test("diffElements: 追加・削除・移動・寸法・属性", () => {
  const base = new Map([["S", idx({ A: rec([0, 0, 0, 100, 100, 3000]), B: rec([0, 0, 0, 100, 100, 3000]), C: rec([0, 0, 0, 100, 100, 3000]), D: rec([0, 0, 0, 100, 100, 3000]) })]]);
  const cur = new Map([["S", idx({ A: rec([0, 0, 300, 100, 100, 3300]), B: rec([0, 0, 0, 200, 100, 3000]), C: rec([0, 0, 0, 100, 100, 3000], "y"), E: rec([0, 0, 0, 1, 1, 1]) })]]);
  const d = diff.diffElements(base, cur);
  assert.deepEqual(d.added.map((x) => x.guid), ["E"]);
  assert.deepEqual(d.removed.map((x) => x.guid), ["D"]);
  const kinds = Object.fromEntries(d.changed.map((x) => [x.guid, x.kinds]));
  assert.deepEqual(kinds.A, ["position"]);
  assert.deepEqual(kinds.B, ["size", "position"]);
  assert.deepEqual(kinds.C, ["attributes"]);
  assert.equal(d.unchanged, 0);
});

test("diffElements: 同じ GlobalId が別モデルにあっても混ざらない", () => {
  const base = new Map([["ARC", idx({ G: rec([0, 0, 0, 1, 1, 1]) })], ["STR", idx({ G: rec([5, 5, 5, 9, 9, 9]) })]]);
  const cur = new Map([["STR", idx({ G: rec([5, 5, 5, 9, 9, 9]) })], ["ARC", idx({ G: rec([0, 0, 0, 1, 1, 1]) })]]);
  const d = diff.diffElements(base, cur);
  assert.equal(d.changed.length, 0);
  assert.equal(d.unchanged, 2);
});

test("attributeSignature: 同じタイプの別要素の数（ObjectTypeOf）では変わらない", () => {
  const mk = (n) => ({
    Name: { value: "c1" },
    IsDefinedBy: [{ Name: { value: "Type" }, ObjectTypeOf: new Array(n).fill({ x: 1 }), HasPropertySets: [{ Name: { value: "P" }, HasProperties: [{ Name: { value: "W" }, NominalValue: { value: 1 } }] }] }],
  });
  assert.equal(diff.attributeSignature(mk(4)), diff.attributeSignature(mk(2)));
  const changed = mk(2);
  changed.IsDefinedBy[0].HasPropertySets[0].HasProperties[0].NominalValue.value = 2;
  assert.notEqual(diff.attributeSignature(mk(2)), diff.attributeSignature(changed));
});

test("stableStringify: 共有オブジェクトと循環", () => {
  const shared = { v: 1 };
  const a = { p: shared, q: shared };
  const b = { p: { v: 1 }, q: { v: 1 } };
  assert.equal(diff.stableStringify(a), diff.stableStringify(b));
  const c = { x: 1 };
  c.self = c;
  assert.doesNotThrow(() => diff.stableStringify(c));
});

test("diffPointcloud: 点数・スキャン数・元ファイル", () => {
  const pc = (sha, points, scans) => ({ sources: [{ name: "a.e57", size: 1, sha256: sha }], points, scanCount: scans, bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
  assert.equal(diff.diffPointcloud(pc("x", 10, 1), pc("x", 10, 1)).changed, false);
  const d = diff.diffPointcloud(pc("x", 10, 1), pc("y", 12, 2));
  assert.equal(d.differences.length, 3);
});

test("solveRigid: 回転・平行移動を復元する（一般・水平のみ）", () => {
  const T = new THREE.Matrix4().makeTranslation(-35210, 12880, 3.2).multiply(new THREE.Matrix4().makeRotationZ(0.41));
  const model = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 0, 3), new THREE.Vector3(5, 30, 0), new THREE.Vector3(12, 8, 9)];
  const cloud = model.map((p) => p.clone().applyMatrix4(T));
  for (const level of [false, true]) {
    const r = align.solveRigid(model, cloud, level);
    assert.ok(r.residual < 1e-6, `残差 ${r.residual}`);
    const q = new THREE.Vector3(7, 7, 7);
    assert.ok(q.clone().applyMatrix4(r.matrix).distanceTo(q.clone().applyMatrix4(T)) < 1e-6);
  }
  // クリック誤差（数 mm）があっても残差は誤差程度に収まる
  const noisy = cloud.map((p, i) => p.clone().add(new THREE.Vector3(0.003 * (i - 1), -0.002, 0.004 * (i % 2))));
  assert.ok(align.solveRigid(model, noisy, true).residual < 0.01);
});

test("foldIssues: 状態・担当・コメントを時刻順に畳み込み、同じイベントは 1 回", () => {
  const ev = [
    { type: "issue.update", id: "i1", by: "b", at: "2026-10-01T10:02:00", status: "対応中", eid: "e2" },
    { type: "issue.create", id: "i1", by: "a", at: "2026-10-01T10:00:00", site: "s", dataset: "d", title: "t", position: [0, 0, 0], view: {}, eid: "e1" },
    { type: "issue.comment", id: "i1", by: "b", at: "2026-10-01T10:03:00", text: "見ます", eid: "e3" },
    { type: "issue.comment", id: "i1", by: "b", at: "2026-10-01T10:03:00", text: "見ます", eid: "e3" },
    { type: "issue.update", id: "i1", by: "a", at: "2026-10-01T10:04:00", assignee: "b", eid: "e4" },
  ];
  const m = issues.foldIssues(ev);
  const i = m.get("i1");
  assert.equal(i.status, "対応中");
  assert.equal(i.assignee, "b");
  assert.equal(i.comments.length, 1);
  assert.equal(i.history.length, 3);
});
