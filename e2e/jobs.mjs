// 処理（ジョブ）基盤の E2E: 画面 → exe（JobService）→ 変換エンジン（selftest）→ derived の公開 → manifest 追記 → 画面へ通知
//   node jobs.mjs <データセットのフォルダ>
// 点群のある版を指定する。derived/<ID>/ と manifest の derived に 1 件増える（開発用データのみ）
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, assert, share } from "./lib.mjs";

const [folder] = process.argv.slice(2);
if (!folder) throw new Error("使い方: node jobs.mjs <データセットのフォルダ>");

const app = await launch({ user: "e2e-jobs" });
const page = app.page;
try {
  const kinds = await page.evaluate(() => window.__kasane.host.jobKinds());
  assert(kinds.some((k) => k.id === "selftest"), `開発モードで selftest が使える ${JSON.stringify(kinds)}`);

  const before = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    await a.refreshDatasets();
    return a.datasets.find((d) => d.folder === f)?.derived.length ?? -1;
  }, folder);
  assert(before >= 0, "版が一覧にあり、derived を持つ（schema 1 も移行して読める）");

  const r = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    const seen = [];
    const off = a.on("jobs", () => {
      for (const j of a.jobs.values()) seen.push(`${j.status}:${j.last?.event ?? ""}`);
    });
    const id = await a.startJob("selftest", f, { note: "e2e" });
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const j = a.jobs.get(id);
        if (j && j.status !== "running") {
          clearInterval(t);
          j.status === "done" ? resolve() : reject(new Error(`${j.status}: ${j.message}`));
        }
      }, 200);
      setTimeout(() => reject(new Error("時間切れ")), 300000);
    });
    off();
    const m = a.datasets.find((d) => d.folder === f);
    return { id, seen: [...new Set(seen)], derived: m.derived, active: await window.__kasane.host.jobList() };
  }, folder);
  const entry = r.derived.find((d) => d.id === r.id);
  assert(r.seen.some((s) => s.startsWith("running:progress")), `進捗が届く ${r.seen.join(",")}`);
  assert(entry && entry.kind === "selftest" && entry.params.note === "e2e" && r.derived.length === before + 1, "manifest の derived に 1 件追記");
  assert(r.active.length === 0, "終わった処理は実行中の一覧から消える");

  const dir = join(share, "datasets", folder);
  const summary = JSON.parse(readFileSync(join(dir, entry.dir, "summary.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert(summary.points === manifest.pointcloud.points, `全点を読めた（${summary.points} 点）`);
  assert(manifest.schema === 2 && !existsSync(join(dir, entry.dir + ".part")), "manifest は schema 2、書きかけのフォルダは残らない");

  // 中断: 始めてすぐ止める
  const ab = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    const id = await a.startJob("selftest", f);
    await a.abortJob(id);
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (a.jobs.get(id)?.status !== "running") {
          clearInterval(t);
          resolve();
        }
      }, 100);
    });
    return { status: a.jobs.get(id).status, n: a.datasets.find((d) => d.folder === f).derived.length };
  }, folder);
  assert(ab.status === "aborted" && ab.n === before + 1, "中断すると derived に追記しない");

  const err = await page.evaluate(() => window.__kasane.host.jobStart("nope", "x").then(() => "ok", (e) => String(e)));
  assert(err.includes("不明な処理"), "登録されていない処理は始められない");

  // 待ち行列: 2 本続けて始めると、2 本目は 1 本目が終わるまで待つ
  const q = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    const id1 = await a.startJob("selftest", f);
    const id2 = await a.startJob("selftest", f);
    const list = await window.__kasane.host.jobList();
    const wait = (id) => new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const j = a.jobs.get(id);
        if (j && j.status !== "queued" && j.status !== "running") { clearInterval(t); j.status === "done" ? resolve() : reject(new Error(`${j.status}: ${j.message}`)); }
      }, 200);
      setTimeout(() => reject(new Error("時間切れ")), 300000);
    });
    const queuedSeen = a.jobs.get(id2).status === "queued";
    await wait(id1);
    await wait(id2);
    return { list: list.map((j) => `${j.jobId === id1 ? 1 : 2}:${j.status}:${j.position}`), queuedSeen, n: a.datasets.find((d) => d.folder === f).derived.length };
  }, folder);
  assert(q.list.join(",") === "1:running:0,2:queued:1", `2 本目は待ち行列に入る ${q.list.join(",")}`);
  assert(q.queuedSeen && q.n === before + 3, "待っていた処理も順に動いて成果に追記される");

  // 画面: ツールバーの「処理」と左タブ「成果」
  const ui = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    await a.openDataset(a.datasets.find((d) => d.folder === f));
    document.querySelector('[data-tool="jobs"]').click();
    const kinds = [...document.querySelectorAll("#job-kind option")].map((o) => o.value);
    document.querySelector("#tabbtn-results").click();
    const items = document.querySelectorAll("#tab-results [data-derived]").length;
    // 処理の結果のレイヤー（selftest は範囲の枠）
    const s = a.derivedLayers.list()[0];
    await a.derivedLayers.setVisible(s.entry.id, true);
    const st = a.derivedLayers.get(s.entry.id);
    const row = !!document.querySelector(`#tab-layers [data-layer-source="derived"]`);
    await a.derivedLayers.setVisible(s.entry.id, false);
    a.setTool("select");
    return { kinds, items, status: st.status, hasBox: !!a.derivedLayers.boxOf(s.entry.id), row };
  }, folder);
  assert(ui.kinds.includes("selftest") && ui.kinds.includes("selftest-version"), `右パネルで処理を選べる ${ui.kinds}`);
  assert(ui.items === before + 3, `「成果」タブに成果が並ぶ（${ui.items} 件）`);
  assert(ui.status === "ready" && ui.hasBox && ui.row, "処理の結果をレイヤーに表示できる");

  // 新しい版を作る処理: 間引き・分類を付けた点群で新しい版を公開し、元の版は変えない
  const srcManifest = readFileSync(join(dir, "manifest.json"), "utf8");
  const nv = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    const id = await a.startJob("selftest-version", f, { step: 10, note: "e2e" });
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const j = a.jobs.get(id);
        if (j && j.status !== "queued" && j.status !== "running") { clearInterval(t); j.status === "done" ? resolve() : reject(new Error(`${j.status}: ${j.message}`)); }
      }, 300);
      setTimeout(() => reject(new Error("時間切れ")), 600000);
    });
    return a.jobs.get(id).version;
  }, folder);
  const nm = JSON.parse(readFileSync(join(share, "datasets", nv.folder, "manifest.json"), "utf8"));
  assert(nm.parent?.folder === folder && nm.parent.jobKind === "selftest-version" && nm.parent.note === "e2e" && nm.previous === folder, "新しい版の parent・previous は元の版");
  assert(nm.pointcloud.owner === nv.folder && nm.pointcloud.points === Math.ceil(manifest.pointcloud.points / 10) && Object.keys(nm.pointcloud.classCounts).length > 0, `点群は作り直したもの（${nm.pointcloud.points} 点）`);
  assert(nm.models.length === manifest.models.length && nm.models.every((m) => m.owner === nv.folder), "モデルは新しい版へ複製");
  assert(readFileSync(join(dir, "manifest.json"), "utf8") === srcManifest, "元の版の manifest は変わらない");

  // 点の属性: 分類で色分けし、分類を隠す
  const cls = await page.evaluate(async (folder) => {
    const a = window.__kasane.app;
    await a.refreshDatasets();
    await a.openDataset(a.datasets.find((d) => d.folder === folder));
    a.setColorMode(4);
    await new Promise((r) => setTimeout(r, 3000));
    const rows = a.pointAttrs.classes();
    a.pointAttrs.setClassHidden(rows[0].code, true);
    const checkbox = document.querySelector(`#tab-layers input[data-class="${rows[0].code}"]`);
    const r = {
      mode: a.pointAttrs.colorMode, attr: a.pc.classAttribute, extras: a.pc.extraAttributes, codes: rows.map((c) => c.code),
      hidden: [...a.pointAttrs.hidden], checkbox: checkbox ? checkbox.checked : null, scalar: a.pointAttrs.scalarCandidates.map((x) => x.name),
    };
    a.pointAttrs.showAllClasses();
    a.setColorMode(5);
    r.scalarAttr = a.pc.scalarAttribute;
    a.setColorMode(0);
    return r;
  }, nv.folder);
  assert(cls.mode === 4 && cls.attr === "classification" && cls.extras.includes("classification"), "分類で色分けすると分類の属性を読む");
  assert(cls.codes.every((c) => c >= 2 && c <= 6) && cls.codes.length >= 2, `分類の一覧 ${cls.codes}`);
  assert(cls.hidden.length === 1 && cls.checkbox === false, "分類を隠せる（レイヤーのチェックが外れる）");
  assert(cls.scalar.includes("selftest height") && cls.scalarAttr, `値で色分けできる属性 ${cls.scalar}`);
} finally {
  await app.close();
}
