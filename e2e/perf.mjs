// 表示性能の計測（懸念 1・5・9）
//   node perf.mjs <データセットのフォルダ> [--root <共有フォルダ>]
// 初回表示までの時間、表示点数の上限ごとの描画時間・読込時間・メモリ、カメラを動かし続けたときのメモリの推移を測る
import { launch, share } from "./lib.mjs";

const args = process.argv.slice(2);
const folder = args[0];
const ri = args.indexOf("--root");
const root = ri >= 0 ? args[ri + 1] : share;
const app = await launch({ root });
const { page } = app;
const out = { folder, root };
try {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const mem = async () => {
    const m = await cdp.send("Performance.getMetrics");
    const g = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
    const gpu = await page.evaluate(() => {
      const a = window.__kasane.app;
      const info = a.viewer.renderer.info.memory;
      return { geometries: info.geometries, loadedPoints: a.pc?.loadedPoints ?? 0 };
    });
    return { jsHeapMB: +(g("JSHeapUsedSize") / 1e6).toFixed(0), ...gpu };
  };
  const waitIdle = () =>
    page.waitForFunction(() => {
      const a = window.__kasane.app;
      return document.getElementById("loading").classList.contains("hidden") && a.pc && !a.pc.isLoading;
    }, null, { timeout: 600000, polling: 100 });
  // 描画時間（GPU 完了まで）を測る: 同じフレームを n 回描いて gl.finish
  const drawMs = () =>
    page.evaluate(() => {
      const a = window.__kasane.app;
      const gl = a.viewer.renderer.getContext();
      a.viewer.render();
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) a.viewer.render();
      gl.finish();
      return +((performance.now() - t0) / 10).toFixed(1);
    });

  // 初回表示
  const t0 = Date.now();
  await page.evaluate((f) => {
    localStorage.setItem("pointBudget", "3000000");
    const a = window.__kasane.app;
    a.setPointBudget(3_000_000);
    return a.refreshDatasets().then(() => a.openDataset(a.datasets.find((d) => d.folder === f)));
  }, folder);
  const tOpen = Date.now() - t0;
  const tFirstPoints = await page.evaluate(async () => {
    const a = window.__kasane.app;
    const t = performance.now();
    while (a.pc.visiblePoints === 0) await new Promise((r) => setTimeout(r, 20));
    return performance.now() - t;
  });
  await waitIdle();
  out.firstView = { openMs: tOpen, firstPointsMs: Math.round(tFirstPoints), settledMs: Date.now() - t0, ...(await mem()) };
  console.log("初回表示", JSON.stringify(out.firstView));

  // 表示点数の上限ごと（同じ視点・寄った視点）
  const views = {
    全体: () => page.evaluate(() => window.__kasane.app.viewer.fit(window.__kasane.app.pc.boxDisplay)),
    近接: () =>
      page.evaluate(() => {
        const a = window.__kasane.app;
        const c = a.pc.boxDisplay.getCenter(new window.__kasane.THREE.Vector3());
        a.viewer.camera.position.set(c.x + 8, c.y - 8, c.z + 3);
        a.viewer.controls.target.copy(c);
        a.viewer.controls.update();
      }),
  };
  out.budgets = [];
  for (const budget of [1_000_000, 3_000_000, 5_000_000, 10_000_000, 20_000_000]) {
    for (const [name, set] of Object.entries(views)) {
      await page.evaluate((b) => window.__kasane.app.setPointBudget(b), budget);
      await set();
      const t = Date.now();
      await page.waitForTimeout(100);
      await waitIdle();
      const r = { budget, view: name, loadMs: Date.now() - t, visible: await page.evaluate(() => window.__kasane.app.pc.visiblePoints), drawMs: await drawMs(), ...(await mem()) };
      out.budgets.push(r);
      console.log(JSON.stringify(r));
    }
  }

  // カメラを動かし続けてメモリが増え続けないか（上限 3M 点）
  await page.evaluate(() => window.__kasane.app.setPointBudget(3_000_000));
  out.walk = [];
  for (let i = 0; i < 40; i++) {
    await page.evaluate((i) => {
      const a = window.__kasane.app;
      const b = a.pc.boxDisplay;
      const T = window.__kasane.THREE;
      const s = b.getSize(new T.Vector3());
      const p = new T.Vector3(b.min.x + s.x * ((i * 0.37) % 1), b.min.y + s.y * ((i * 0.61) % 1), b.min.z + s.z * 0.5);
      a.viewer.camera.position.set(p.x + 6, p.y - 6, p.z + 3);
      a.viewer.controls.target.copy(p);
      a.viewer.controls.update();
    }, i);
    await waitIdle();
    if (i % 5 === 4) {
      const m = await mem();
      out.walk.push({ step: i + 1, ...m });
      console.log("移動", i + 1, JSON.stringify(m));
    }
  }
  const gpu = await page.evaluate(() => {
    const gl = window.__kasane.app.viewer.renderer.getContext();
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
  });
  out.gpu = gpu;
  console.log(JSON.stringify(out));
} finally {
  await app.close();
}
