// 開発用: 処理の画面（右パネル「処理」・左タブ「成果」・分類の色分け）のスクリーンショットを dev/screenshots/ に保存する
//   node shots-jobs.mjs <処理で作った版のフォルダ>
import { join } from "node:path";
import { launch, shots } from "./lib.mjs";

const [folder] = process.argv.slice(2);
if (!folder) throw new Error("使い方: node shots-jobs.mjs <処理で作った版のフォルダ>");
const app = await launch({ user: "e2e-shots" });
const page = app.page;
try {
  await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    await a.refreshDatasets();
    await a.openDataset(a.datasets.find((d) => d.folder === f));
    a.setColorMode(4);
    a.setTool("jobs");
  }, folder);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(shots, "jobs-panel-classes.png") });
  await page.click("#tabbtn-results");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "jobs-results.png") });
  await page.evaluate(() => window.__kasane.app.setColorMode(0));
} finally {
  await app.close();
}
