// 撮影ポイント（F6）の E2E: 画像付きの E57 を取り込み、目印・撮影ポイントへの移動・巡回・360 画像の表示を確かめる
//   node scanpoints.mjs <画像付きの E57>
//   画像付きの E57 は converter/dev/add_station_images.py で作れる（点群の色を器械点から投影した 360 画像）
import { join, resolve } from "node:path";
import { launch, assert, shots } from "./lib.mjs";

const file = process.argv[2];
if (!file) throw new Error("画像付きの E57 を指定してください");
const app = await launch();
const { page } = app;
try {
  await page.waitForFunction(() => document.getElementById("loading").classList.contains("hidden"), null, { timeout: 120000 });
  const reg = await page.evaluate((p) => window.__kasane.host.devRegisterPaths([p]), resolve(file));
  const done = page.evaluate((reg) => window.__kasane.data.startImport(reg), reg);
  await page.waitForSelector("#dlg-import[open]");
  await (await page.$$('#dlg-import input[name="imp-mode"]'))[0].click();
  await page.fill("#dlg-import input.grow[type=text]", "撮影ポイントE2E");
  await page.click("#dlg-import button.primary");
  const closer = setInterval(async () => {
    if (await page.$("#dlg-message[open]")) await page.click("#dlg-message button.primary").catch(() => {});
  }, 1000);
  await done;
  clearInterval(closer);
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const a = window.__kasane.app;
    const pc = a.current.pointcloud;
    return {
      imageCount: pc.imageCount,
      files: pc.sources.flatMap((s) => (s.images ?? []).map((i) => i.file)),
      scanBounds: pc.sources.flatMap((s) => s.scans.map((x) => !!x.bounds)),
      stations: a.scanPoints.list.map((s) => ({ id: s.id, placed: !!s.position, images: s.images.length })),
      pins: document.querySelectorAll(".scan-pin").length,
      toolButton: !document.querySelector('[data-tool="scanPoints"]').classList.contains("hidden"),
      layerRow: !!document.querySelector('[data-layer-source="scanPoints"]'),
    };
  });
  console.log(JSON.stringify(info));
  assert(info.imageCount >= 1 && info.files.every((f) => f?.startsWith("images/")), `画像を取り込んだ（${info.imageCount} 枚）`);
  assert(info.scanBounds.every(Boolean), "スキャンごとの範囲を記録した");
  assert(info.stations.filter((s) => s.placed).length >= 2, `撮影ポイント ${info.stations.length} か所`);
  assert(info.pins === info.stations.filter((s) => s.placed).length, `目印 ${info.pins} 個`);
  assert(info.toolButton && info.layerRow, "ツールバーのボタンとレイヤーの行がある");
  await page.screenshot({ path: join(shots, "e2e-scanpoints-overview.png") });

  // 目印を押す → ツールに切り替わり、その撮影ポイントに立つ
  const before = await page.evaluate(() => window.__kasane.app.viewer.camera.position.toArray());
  await page.evaluate(() => document.querySelector(".scan-pin").click());
  await page.waitForFunction(() => window.__kasane.app.scanPoints.imageStatus === "shown", null, { timeout: 30000 });
  const at = await page.evaluate(() => {
    const a = window.__kasane.app;
    const st = a.scanPoints.current;
    const o = a.current.origin;
    const p = a.viewer.camera.position;
    return {
      tool: a.tool,
      look: a.viewer.lookAround,
      dist: Math.hypot(p.x + o[0] - st.position[0], p.y + o[1] - st.position[1], p.z + o[2] - st.position[2]),
      meshes: a.viewer.overlay.getObjectByName("scan-images").children.length,
      panel: document.getElementById("tool-opts").innerText,
    };
  });
  assert(at.tool === "scanPoints" && at.look, "目印からツールに入り、見回す操作になった");
  assert(at.dist < 1e-3, `撮影ポイントに立った（ずれ ${at.dist.toExponential(1)} m）`);
  assert(at.meshes >= 1 && at.panel.includes("360 画像 を表示中"), "360 画像を表示した");
  await page.screenshot({ path: join(shots, "e2e-scanpoints-image.png") });
  await page.evaluate(() => window.__kasane.app.scanPoints.setImageOpacity(0.5));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "e2e-scanpoints-image-half.png") });
  await page.evaluate(() => window.__kasane.app.scanPoints.setImageOpacity(0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "e2e-scanpoints-cloud.png") });
  await page.evaluate(() => window.__kasane.app.scanPoints.setImageOpacity(1));

  // 見回す: ドラッグしても位置は変わらない
  const box = await page.locator("#view canvas.gl").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const p0 = await page.evaluate(() => window.__kasane.app.viewer.camera.position.toArray());
  const d0 = await page.evaluate(() => window.__kasane.app.viewer.camera.getWorldDirection(new window.__kasane.THREE.Vector3()).toArray());
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 30, { steps: 8 });
  await page.mouse.up();
  const p1 = await page.evaluate(() => window.__kasane.app.viewer.camera.position.toArray());
  const d1 = await page.evaluate(() => window.__kasane.app.viewer.camera.getWorldDirection(new window.__kasane.THREE.Vector3()).toArray());
  const moved = Math.hypot(...p0.map((v, i) => v - p1[i]));
  const turned = Math.acos(Math.min(1, d0.reduce((s, v, i) => s + v * d1[i], 0)));
  assert(moved < 1e-6 && turned > 0.1, `見回した（位置のずれ ${moved.toExponential(1)} m・向き ${((turned * 180) / Math.PI).toFixed(0)}°）`);
  // ホイールは画角
  const fov0 = await page.evaluate(() => window.__kasane.app.viewer.fov);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(300);
  const fov1 = await page.evaluate(() => window.__kasane.app.viewer.fov);
  assert(fov1 < fov0, `ホイールで画角 ${fov0.toFixed(0)}° → ${fov1.toFixed(0)}°`);

  // N で次へ、端で戻る
  const start = await page.evaluate(() => window.__kasane.app.scanPoints.currentId);
  const ids = [];
  const n = info.stations.filter((s) => s.placed).length;
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("n");
    ids.push(await page.evaluate(() => window.__kasane.app.scanPoints.currentId));
  }
  // n 回で全部を巡り、最後は元の撮影ポイントに戻る（端で反対へ戻る）
  assert(new Set(ids).size === n && ids[n - 1] === start, `N で ${n} か所を巡って戻った（${[start, ...ids].join(" → ")}）`);

  // Esc で出て、入る前の視点に戻る
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const a = window.__kasane.app;
    return { tool: a.tool, look: a.viewer.lookAround, pos: a.viewer.camera.position.toArray(), meshes: a.viewer.overlay.getObjectByName("scan-images").children.length };
  });
  const back = Math.hypot(...before.map((v, i) => v - after.pos[i]));
  assert(after.tool === "select" && !after.look && after.meshes === 0 && back < 1e-6, "Esc で出て、元の視点に戻った");
} finally {
  await app.close();
}
