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
} finally {
  await app.close();
}
