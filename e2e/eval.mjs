// 開発用: 起動中の Kasane（--debug-port 9333）に繋いで JS を評価し、必要なら画面を保存する
//   node eval.mjs "<式（async 可）>" [保存する png]
import { chromium } from "playwright-core";

const [expr, shot] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("https://kasane.local"));
page.on("console", (m) => console.log(`[page ${m.type()}] ${m.text()}`));
try {
  if (expr) {
    const r = await page.evaluate(`(async () => { const kasane = window.__kasane; const app = kasane?.app; return (${expr}); })()`);
    console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
  }
  if (shot) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot });
  }
} catch (e) {
  console.log("ERROR", e.message);
} finally {
  // 接続だけ切る（アプリは閉じない）
  setTimeout(() => process.exit(0), 200);
}
