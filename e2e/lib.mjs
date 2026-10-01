// E2E 用: 干渉ビューア.exe を開発モード＋リモートデバッグで起動し、Playwright で WebView2 に繋ぐ
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
export const share = process.env.CV_SHARE ?? join(repo, "dist", "share");

// 起動ごとに別のポートを使う（前のインスタンスの WebView2 が残っていると、そちらへ繋がってしまう）
export async function launch({ port = 9400 + Math.floor(Math.random() * 500), root = share, user } = {}) {
  const exe = join(share, "干渉ビューア.exe");
  const args = ["--root", root, "--dev", "--debug-port", String(port)];
  if (user) args.push("--user", user); // 開発モードのみ有効
  const proc = spawn(exe, args, { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      // 起動待ち
    }
  }
  if (!browser) throw new Error("WebView2 に接続できません");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("https://cv.local"));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("画面が開きません");
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.waitForFunction(() => !!window.__cv, null, { timeout: 30000 });
  return {
    proc,
    browser,
    page,
    async close() {
      try {
        await browser.close();
      } catch {}
      proc.kill();
      await sleep(800);
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`NG: ${msg}`);
  console.log(`OK: ${msg}`);
}
