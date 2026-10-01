// 取込の E2E: ファイルを登録 → 取込画面で「取り込む」→ 完了まで待ち、表示と計測値を記録する
//   node import.mjs <名称> <ファイル...> [--version]（--version なら表示中の現場の新しい版として取り込む）
import { join, resolve } from "node:path";
import { launch, assert, share } from "./lib.mjs";

const args = process.argv.slice(2);
const asVersion = args.includes("--version");
const [name, ...files] = args.filter((a) => a !== "--version");
const app = await launch();
const { page } = app;
try {
  // 起動時に前回のデータセットを開くので、それが終わるのを待つ
  await page.waitForFunction(() => document.getElementById("loading").classList.contains("hidden"), null, { timeout: 120000 });
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => window.__cv.app.current?.folder ?? null);
  const reg = await page.evaluate((paths) => window.__cv.host.devRegisterPaths(paths), files.map((f) => resolve(f)));
  assert(reg.length === files.length, `ファイル登録 ${reg.map((r) => r.name).join(", ")}`);
  const t0 = Date.now();
  const done = page.evaluate((reg) => window.__cv.data.startImport(reg), reg);
  await page.waitForSelector("#dlg-import[open]");
  const radios = await page.$$('#dlg-import input[name="imp-mode"]');
  if (asVersion) {
    await radios[1].click();
    // 現場 ID（CV_SITE）が指定されていればそれを、無ければ同じ名称の現場のうち版の多いものを選ぶ
    const value = await page.evaluate(
      ([n, site]) => {
        if (site) return site;
        const sites = [...window.__cv.app.sites.entries()].filter(([, v]) => v[0].name === n).sort((a, b) => b[1].length - a[1].length);
        return sites[0]?.[0];
      },
      [name, process.env.CV_SITE ?? ""],
    );
    if (!value) throw new Error(`現場 ${name} がありません`);
    await page.selectOption("#dlg-import select", value);
    // 前の版を明示する（CV_BASE=フォルダ名）。PoC の検証用で、画面からは常に最新版が前の版になる
    if (process.env.CV_BASE) {
      await page.evaluate((folder) => {
        const app = window.__cv.app;
        const m = app.datasets.find((d) => d.folder === folder);
        if (!m) throw new Error(`前の版がありません: ${folder}`);
        app.datasets = app.datasets.filter((d) => d.site !== m.site || d.version <= m.version);
      }, process.env.CV_BASE);
      await page.selectOption("#dlg-import select", value);
    }
  } else {
    await radios[0].click();
  }
  await page.fill("#dlg-import input.grow[type=text]", name);
  await page.click("#dlg-import button.primary");
  let last = "";
  const timer = setInterval(async () => {
    const s = await page.evaluate(() => document.getElementById("import-progress")?.innerText ?? "").catch(() => "");
    const line = s.split("\n").slice(0, 3).join(" ");
    if (line !== last) console.log(`  ${line}`);
    last = line;
  }, 3000);
  // 完了時のメッセージ（注意あり）が出たら閉じる
  const closer = setInterval(async () => {
    const open = await page.$("#dlg-message[open]");
    if (open) {
      console.log("[message]", (await open.innerText()).replace(/\n/g, " / "));
      await page.click("#dlg-message button.primary").catch(() => {});
    }
  }, 1000);
  await done;
  clearInterval(timer);
  clearInterval(closer);
  const secs = (Date.now() - t0) / 1000;
  const cur = await page.evaluate(() => window.__cv.app.current);
  assert(cur && cur.state === "ready" && cur.folder !== before, `取込完了 ${cur?.folder}（${secs.toFixed(1)} 秒）`);
  await page.waitForTimeout(4000);
  const stats = await page.evaluate(() => {
    const a = window.__cv.app;
    return {
      models: [...a.models.models.values()].map((m) => m.key),
      pc: a.pc ? { visible: a.pc.visiblePoints, nodes: a.pc.visibleNodes.length, total: a.pc.pointCount } : null,
      manifest: { origin: a.current.origin, alignment: a.current.alignment.method, models: a.current.models.map((m) => ({ key: m.key, expected: m.expectedCount, got: m.geometryCount, failed: m.failedCount, sec: m.seconds, app: m.application })), pointcloud: a.current.pointcloud && { points: a.current.pointcloud.points, timings: a.current.pointcloud.timings, sizes: a.current.pointcloud.outputSizes }, diff: a.current.diff, log: a.current.importLog },
    };
  });
  console.log(JSON.stringify(stats, null, 1));
  await page.screenshot({ path: join(share, "..", `e2e-import-${name}.png`) });
} finally {
  await app.close();
}
