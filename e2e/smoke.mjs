// 起動・Range 要求（懸念2）・書き込み API の確認
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, assert, share, shots } from "./lib.mjs";

const app = await launch();
const { page } = app;
try {
  const ctx = await page.evaluate(() => window.__kasane.app.ctx);
  assert(ctx.user && ctx.root, `コンテキスト取得 user=${ctx.user}`);

  // 懸念2: Range。自前ハンドラ（kasane.local/data）と仮想ホスト割り当て（raw.kasane.local）を比べる
  mkdirSync(join(share, "config"), { recursive: true });
  const buf = Buffer.alloc(1 << 20);
  for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
  writeFileSync(join(share, "config", "range-test.bin"), buf);
  const r = await page.evaluate(async () => {
    const out = {};
    for (const [name, url] of [
      ["自前ハンドラ", "/data/config/range-test.bin"],
      ["仮想ホスト割り当て", "https://raw.kasane.local/config/range-test.bin"],
    ]) {
      try {
        const res = await fetch(url, { headers: { Range: "bytes=1000-1009" } });
        const b = new Uint8Array(await res.arrayBuffer());
        out[name] = { status: res.status, length: b.length, first: b[0], contentRange: res.headers.get("content-range") };
      } catch (e) {
        out[name] = { error: String(e) };
      }
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  assert(r["自前ハンドラ"].status === 206 && r["自前ハンドラ"].length === 10 && r["自前ハンドラ"].first === (1000 & 0xff), "自前ハンドラは Range に 206 で応える");

  // 書き込み（許可されない場所は 403）
  const w = await page.evaluate(async () => {
    const ok = await fetch(`/api/write?path=${encodeURIComponent("issues/e2e-test/a.bin")}`, { method: "PUT", body: new Uint8Array([1, 2, 3]) });
    const ng = await fetch(`/api/write?path=${encodeURIComponent("tools/evil.bin")}`, { method: "PUT", body: new Uint8Array([1]) });
    const trav = await fetch(`/data/${encodeURIComponent("..")}/x`, {});
    return { ok: ok.status, okBody: await ok.text(), ng: ng.status, trav: trav.status };
  });
  console.log(JSON.stringify(w));
  assert(w.ok === 200 && w.okBody.includes('"size":3'), "issues/ への書き込み");
  assert(w.ng === 403, "tools/ への書き込みは拒否");
  assert(w.trav === 403 || w.trav === 404, "共有フォルダの外は読めない");
  await page.screenshot({ path: join(shots, "e2e-smoke.png") });
} finally {
  await app.close();
}
