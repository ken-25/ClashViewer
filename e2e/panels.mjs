// 登録口から作った左タブ・見え方（view-bar）と、features/ に分けた状態の E2E
//   node panels.mjs <差分のある版フォルダ>（例: 改修A棟の第2版。前の版との追加・変更・削除がある版）
// マウスで 3D 画面を狙う操作は使わない（features.mjs より安定させる）
import { launch, assert } from "./lib.mjs";
if (!process.argv[2]) throw new Error("使い方: node panels.mjs <差分のある版フォルダ>");
const app = await launch({ user: "e2e-panels" });
const page = app.page;
const ev = (fn, arg) => page.evaluate(fn, arg);
try {
  await ev(async (f) => {
    const a = window.__kasane.app;
    await a.refreshDatasets();
    await a.openDataset(a.datasets.find((d) => d.folder === f));
  }, process.argv[2]);
  await page.waitForTimeout(2000);
  // 見え方: 切断メニュー
  await page.click("#btn-clip");
  assert(await page.isVisible('[data-add-section="z"]'), "切断メニューが開く");
  await page.click('[data-add-section="z"]');
  assert(!(await page.isVisible('[data-add-section="z"]')), "メニューの項目でメニューが閉じる");
  const clipLabel = await page.locator("#btn-clip").innerText();
  assert(clipLabel.includes("断面 1") && (await ev(() => window.__kasane.app.clipping.sections.length)) === 1, `水平断面の追加 ${clipLabel}`);
  await page.click("#btn-clip");
  await page.click("#chk-clip-guides");
  assert(await page.isVisible("#chk-clip-guides"), "チェックボックスではメニューが閉じない");
  assert((await page.locator("#btn-clip").innerText()).includes("枠なし") && !(await ev(() => window.__kasane.app.clipping.showGuides)), "枠の表示の切替");
  await page.keyboard.press("Escape");
  await page.keyboard.press("b");
  assert(await ev(() => document.getElementById("chk-clip-guides").checked), "B キーでメニューのチェックも戻る");
  await page.click("#btn-clip");
  await page.click("#btn-clip-off");
  assert((await page.locator("#btn-clip").innerText()).startsWith("切断: なし"), "切断をすべてオフ");
  // 視点・投影
  await page.click("#btn-view");
  await page.click('[data-view="top"]');
  await page.click("#btn-projection");
  assert(await ev(() => window.__kasane.app.viewer.projection === "orthographic" && document.getElementById("btn-projection").getAttribute("aria-pressed") === "true"), "平行投影ボタン");
  await page.keyboard.press("p");
  assert(await ev(() => window.__kasane.app.viewer.projection === "perspective" && !document.getElementById("btn-projection").classList.contains("active")), "P キーでボタンの表示も戻る");
  // 目印
  await page.click("#btn-nav");
  await page.locator("#nav-menu input").first().uncheck();
  assert(await ev(() => !window.__kasane.app.nav.markers && !document.querySelector("#nav-menu input").checked), "目印の切替");
  await page.locator("#nav-menu input").first().check();
  await page.keyboard.press("Escape");
  // 計測タブの件数
  await ev(() => {
    const a = window.__kasane.app;
    const T = window.__kasane.THREE;
    a.measure.add(new T.Vector3(0, 0, 0), "モデル", null, null);
    a.measure.add(new T.Vector3(1, 0, 0), "モデル", null, null);
  });
  assert((await page.locator("#measures-count").innerText()) === "1", "計測タブの件数");
  await page.click('[data-tab="measures"]');
  assert(await page.isVisible("#tab-measures") && (await page.locator("#tab-measures").innerText()).includes("計測結果（1）"), "計測タブに切り替わる");
  // 差分タブ
  await page.click('[data-tab="diff"]');
  const diffText = await page.locator("#tab-diff").innerText();
  await page.click('#tab-diff input[type="checkbox"]');
  await page.waitForFunction(() => window.__kasane.app.diff.shown && [...window.__kasane.app.models.models.values()].some((m) => m.role === "previous"), null, { timeout: 60000 });
  // 通知 diff は色分けの反映が終わってから出る（shown はその前に true になる）
  const layersNote = await page
    .waitForFunction(() => document.getElementById("tab-layers").textContent.includes("差分を色分けしています"), null, { timeout: 30000 })
    .then(() => true, () => false);
  assert(/追加/.test(diffText) && layersNote, "差分の色分け（レイヤータブにも状態を出す）");
  await page.click("#tab-diff details[open] .diff-list div");
  await page.waitForFunction(() => !!window.__kasane.app.selection, null, { timeout: 10000 });
  assert(true, "差分の要素へ寄って選ぶ");
  await page.click('#tab-diff input[type="checkbox"]');
  await page.waitForFunction(() => !window.__kasane.app.diff.shown && ![...window.__kasane.app.models.models.values()].some((m) => m.role === "previous"), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  // 指摘: ピンから詳細へ（タブが切り替わる）
  await page.click('[data-tab="layers"]');
  const n = await ev(() => window.__kasane.app.issues.all.size);
  if (n && (await page.locator(".issue-pin").count())) {
    await ev(() => document.querySelector(".issue-pin").click());
    await page.waitForTimeout(500);
    assert(await page.isVisible("#tab-issues .issue-detail"), `ピンから指摘の詳細（指摘 ${n} 件）`);
  } else console.log(`（指摘のピンなし: ${n} 件）`);
  // 版を閉じて開き直すと機能の状態が戻る
  await ev(async (f) => {
    const a = window.__kasane.app;
    a.measureMode.toggleAxisLock("x");
    await a.openDataset(a.datasets.find((d) => d.folder === f));
  }, process.argv[2]);
  const st = await ev(() => { const a = window.__kasane.app; return { m: a.measure.list.length, diff: a.diff.shown, data: !!a.diff.data, align: a.align.picks.model.length }; });
  assert(st.m === 0 && !st.diff && st.data && st.align === 0, `開き直すと計測・色分けは消え、差分は読み直す ${JSON.stringify(st)}`);
} finally {
  await app.close();
}
