// 機能の E2E: 実際のマウス操作で 3点合わせ・計測・直交計測・原点・切断・属性・指摘・差分・版またぎを確かめる
//   node features.mjs <最新版フォルダ> <前の版フォルダ>
// 点群は dev/make_samples.py --survey で作った「測量座標」のもの（正解: Z 回り 23.5° 回転＋(-35210, 12880, 3.2) 移動）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launch, assert, share, shots } from "./lib.mjs";

const [latest, previous] = process.argv.slice(2);
const TRUTH = { yaw: (23.5 * Math.PI) / 180, shift: [-35210, 12880, 3.2] };
const results = {};

const app1 = await launch({ user: "e2e-sato" });
let page = app1.page;

// ---- ページ内の補助 ----
const idle = async (ms = 600) => {
  await page.waitForFunction(() => {
    const a = window.__cv.app;
    return document.getElementById("loading").classList.contains("hidden") && !(a.pc?.isLoading) && !a.models.isBusy;
  }, null, { timeout: 120000 });
  await page.waitForTimeout(ms);
};
const open = async (folder) => {
  await page.evaluate(async (f) => {
    const a = window.__cv.app;
    await a.refreshDatasets();
    await a.openDataset(a.datasets.find((d) => d.folder === f));
  }, folder);
  await idle(1500);
};
const setCamera = (pos, target) =>
  page.evaluate(([p, t]) => {
    const v = window.__cv.app.viewer;
    v.camera.position.set(...p);
    v.controls.target.set(...t);
    v.controls.update();
  }, [pos, target]);
const tool = (name) => page.click(`[data-tool="${name}"]`);
/** 画面上の (fx, fy)（0..1）をクリックする */
const clickAt = async (fx, fy) => {
  const box = await page.locator("#view canvas.gl").boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(400);
};
const lastPick = () =>
  page.evaluate(() => {
    const p = window.__cv.app.lastPick;
    return p ? { point: p.point.toArray(), source: p.source, model: p.model?.lm.key ?? null } : null;
  });
/** 画面の中で、モデルに当たる点を格子状に探す */
const findModelHits = async (n, region = [0.25, 0.75], opts = {}) => {
  const hits = [];
  const steps = 7;
  for (let i = 0; i < steps && hits.length < n * 3; i++)
    for (let j = 0; j < steps && hits.length < n * 3; j++) {
      const fx = region[0] + ((region[1] - region[0]) * i) / (steps - 1);
      const fy = region[0] + ((region[1] - region[0]) * j) / (steps - 1);
      const h = await page.evaluate(async ([fx, fy]) => {
        const a = window.__cv.app;
        const r = a.viewer.canvas.getBoundingClientRect();
        const p = await a.picker.pick(r.left + r.width * fx, r.top + r.height * fy, { models: true, cloud: false });
        if (!p) return null;
        const [d] = await p.model.lm.model.getItemsData([p.model.localId]);
        return { p: p.point.toArray(), key: p.model.lm.key, cls: d?._category?.value };
      }, [fx, fy]);
      // 合成点群に無いもの（設備は施工誤差としてずらしてある・敷地 IfcSite は点群を作っていない）は合わせの対応点に使わない
      if (h && (!opts.noMep || (!h.key.includes("MEP") && h.cls !== "IFCSITE"))) hits.push({ fx, fy, p: h.p, key: h.key, cls: h.cls });
    }
  if (opts.all) return hits;
  // 互いに離れた 3 点を選ぶ（一直線に並ばないように）
  const d = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  let best = null;
  for (let a = 0; a < hits.length; a++)
    for (let b = a + 1; b < hits.length; b++)
      for (let c = b + 1; c < hits.length; c++) {
        const s = Math.min(d(hits[a], hits[b]), d(hits[a], hits[c]), d(hits[b], hits[c]));
        if (!best || s > best.s) best = { s, pts: [hits[a], hits[b], hits[c]] };
      }
  return best?.pts ?? [];
};

try {
  // ======== 3点合わせ ========
  // 繰り返し実行できるよう、合わせを IFC 座標のままに戻してから始める
  await page.evaluate(async (f) => {
    const id = new window.__cv.THREE.Matrix4().toArray();
    await window.__cv.host.updateAlignment(f, { method: "identity", matrix: id, note: "E2E の初期化" });
  }, latest);
  await open(latest);
  const m0 = await page.evaluate(() => ({ origin: window.__cv.app.current.origin, method: window.__cv.app.current.alignment.method, modelBox: window.__cv.app.models.box().toJSON?.() ?? null }));
  // モデル全体が見える視点（シーン座標）
  const mb = await page.evaluate(() => {
    const b = window.__cv.app.models.box();
    return { min: b.min.toArray(), max: b.max.toArray() };
  });
  const c = mb.min.map((v, i) => (v + mb.max[i]) / 2);
  const camModel = { pos: [c[0] + 25, c[1] - 35, c[2] + 22], target: c };
  await setCamera(camModel.pos, camModel.target);
  await idle();
  // 候補を離れた順に並べる（最遠点サンプリング）
  const all = await findModelHits(3, [0.15, 0.85], { all: true, noMep: true });
  const picks = [all[0]];
  while (picks.length < all.length) {
    let best = null;
    for (const h of all) {
      if (picks.includes(h)) continue;
      const d = Math.min(...picks.map((q) => Math.hypot(...h.p.map((v, i) => v - q.p[i]))));
      if (!best || d > best.d) best = { h, d };
    }
    picks.push(best.h);
  }
  assert(picks.length >= 3, `モデル上の候補点 ${picks.length} 個`);

  await tool("align");
  // 点群側は、カメラを「正解の変換」で動かして同じ画面位置をクリックする（＝同じ物理位置の点群）
  const toCloudScene = (p, origin) => {
    // シーン → IFC（原点を足す。合わせ前は identity）→ 正解変換 → 世界 → シーン
    const w = [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]];
    const cs = Math.cos(TRUTH.yaw), sn = Math.sin(TRUTH.yaw);
    const q = [cs * w[0] - sn * w[1] + TRUTH.shift[0], sn * w[0] + cs * w[1] + TRUTH.shift[1], w[2] + TRUTH.shift[2]];
    return [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
  };
  const pairErr = [];
  // 利用者と同じく、対応点ごとに近寄ってクリックする（6 m 手前から）
  const clickRetry = async (want) => {
    for (let i = 0; i < 4; i++) {
      await clickAt(0.5, 0.5);
      const p = await lastPick();
      if (p?.source === want) return p;
      const dbg = await page.evaluate(async () => {
        const a = window.__cv.app;
        const r = a.viewer.canvas.getBoundingClientRect();
        const any = await a.picker.pick(r.left + r.width / 2, r.top + r.height / 2, { models: true, cloud: true });
        return { tool: a.tool, align: [a.align.model.length, a.align.cloud.length], any: any && [any.source, ...any.point.toArray().map((x) => +x.toFixed(2))], cam: a.viewer.camera.position.toArray().map((x) => +x.toFixed(2)) };
      });
      if (i === 0) console.log(`    （${want} を拾えず）`, JSON.stringify(dbg));
      await idle(800);
    }
    return null;
  };
  for (const k of picks) {
    if (pairErr.length >= 3) break;
    const dir = camModel.pos.map((v, i) => v - k.p[i]);
    const len = Math.hypot(...dir);
    const pos = k.p.map((v, i) => v + (dir[i] / len) * 6);
    await setCamera(pos, k.p);
    await idle(500);
    const pm = await clickRetry("model");
    await setCamera(toCloudScene(pos, m0.origin), toCloudScene(k.p, m0.origin));
    await idle(1500);
    if (!pm) continue;
    const pc = await clickRetry("cloud");
    if (!pc) {
      // 点群に対応する点が無い所（未施工・隠れ）は、モデル側の点を取り消して次の候補へ（パネルの「やり直す」と同じ考え方）
      await page.click('#tool-panel button:has-text("1点戻す")');
      console.log("  点群側の対応点が無いため次の候補へ");
      continue;
    }
    const expect = toCloudScene(pm.point, m0.origin);
    const err = pc ? Math.hypot(pc.point[0] - expect[0], pc.point[1] - expect[1], pc.point[2] - expect[2]) : NaN;
    console.log(`  対応点（${k.cls}）: 点群側のクリック位置と正解の差 ${(err * 1000).toFixed(0)} mm`);
    if (err > 0.3) {
      // 手前の別の物を拾った。利用者が画面で見て「1点戻す」のと同じ
      await page.click('#tool-panel button:has-text("1点戻す")');
      await page.click('#tool-panel button:has-text("1点戻す")');
      continue;
    }
    pairErr.push(err);
  }
  const align = await page.evaluate(() => {
    const a = window.__cv.app;
    return { n: [a.align.model.length, a.align.cloud.length], preview: a.alignPreview?.toArray() ?? null, panel: document.getElementById("tool-panel").innerText };
  });
  assert(align.n[0] === 3 && align.n[1] === 3 && align.preview, "3 組の対応点から合わせ行列を計算");
  const M = align.preview; // 列優先
  const yaw = Math.atan2(M[1], M[0]);
  // 正解との差: 建物の中心で比べる
  const ifcC = c.map((v, i) => v + m0.origin[i]);
  const got = [M[0] * ifcC[0] + M[4] * ifcC[1] + M[8] * ifcC[2] + M[12], M[1] * ifcC[0] + M[5] * ifcC[1] + M[9] * ifcC[2] + M[13], M[2] * ifcC[0] + M[6] * ifcC[1] + M[10] * ifcC[2] + M[14]];
  const exp = toCloudScene(c, m0.origin).map((v, i) => v + m0.origin[i]);
  const centerErr = Math.hypot(got[0] - exp[0], got[1] - exp[1], got[2] - exp[2]);
  results.align = { pairClickErrorMm: pairErr.map((e) => +(e * 1000).toFixed(1)), yawDeg: +((yaw * 180) / Math.PI).toFixed(3), centerErrorMm: +(centerErr * 1000).toFixed(1), panel: align.panel.replace(/\n/g, " / ") };
  console.log("  ", JSON.stringify(results.align));
  assert(Math.abs((yaw * 180) / Math.PI - 23.5) < 0.5 && centerErr < 0.1, "正解の変換に近い（回転 0.5° 以内・建物中心で 100 mm 以内）");
  await page.click('#tool-panel button.primary');
  await page.waitForSelector("#dlg-message[open]");
  await page.click("#dlg-message button.primary");
  const mf = JSON.parse(readFileSync(join(share, "datasets", latest, "manifest.json"), "utf8"));
  assert(mf.alignment.method === "threePoint" && mf.alignment.by === "e2e-sato" && mf.alignmentHistory?.length >= 1, "manifest に座標合わせを保存（履歴も残る）");
  await open(latest);

  // ======== 重ね表示の確認（合わせ後） ========
  const ov = await page.evaluate(() => {
    const a = window.__cv.app;
    const mb = a.models.box();
    const pb = a.pc.boxDisplay;
    return { inter: mb.intersectsBox(pb), mb: [mb.min.toArray(), mb.max.toArray()], pb: [pb.min.toArray(), pb.max.toArray()] };
  });
  assert(ov.inter, "合わせ後、モデルと点群の範囲が重なる");
  await page.evaluate(() => window.__cv.app.viewer.fit(window.__cv.app.models.box()));
  await idle(2000);
  await page.screenshot({ path: join(shots, "e2e-overlay.png") });

  // ======== 計測（点群・モデルの混在） ========
  const mb2 = await page.evaluate(() => {
    const b = window.__cv.app.models.box();
    return { min: b.min.toArray(), max: b.max.toArray() };
  });
  const c2 = mb2.min.map((v, i) => (v + mb2.max[i]) / 2);
  await setCamera([c2[0] + 20, c2[1] - 30, c2[2] + 18], c2);
  await idle(1500);
  const mp = await findModelHits(3);
  await tool("measure");
  await clickAt(mp[0].fx, mp[0].fy);
  const a1 = await lastPick();
  await clickAt(mp[1].fx, mp[1].fy);
  const a2 = await lastPick();
  const m1 = await page.evaluate(() => {
    const l = window.__cv.app.measure.list;
    const m = l[l.length - 1];
    return { n: l.length, d: m.distance, comps: m.components.toArray(), src: m.sources, panel: document.getElementById("measures").innerText };
  });
  const dExp = Math.hypot(a1.point[0] - a2.point[0], a1.point[1] - a2.point[1], a1.point[2] - a2.point[2]);
  assert(m1.n === 1 && Math.abs(m1.d - dExp) < 1e-6, `2点間距離 ${m1.d.toFixed(3)} m（${m1.src.join("→")}）`);
  // 点群の点を拾えること（モデルを隠して同じ位置をクリック）
  // 「表示」タブのモデルの表示切替と同じ操作でモデルを隠し、点群の点を拾う
  const setModelsVisible = (on) =>
    page.evaluate(async (on) => {
      const a = window.__cv.app;
      for (const lm of a.models.models.values()) await a.models.setModelVisible(lm, on);
    }, on);
  await setModelsVisible(false);
  await idle(800);
  let cp1 = null;
  for (const k of mp) {
    await clickAt(k.fx, k.fy);
    cp1 = await lastPick();
    if (cp1?.source === "cloud") break;
  }
  await setModelsVisible(true);
  await idle(500);
  await clickAt(mp[2].fx, mp[2].fy);
  const mixed = await page.evaluate(() => window.__cv.app.measure.list.at(-1)?.sources ?? null);
  assert(cp1?.source === "cloud" && mixed?.[0] === "点群" && mixed?.[1] === "モデル", "点群→モデルをまたいで計測");
  results.measure = { modelToModel: +m1.d.toFixed(3), mixed: await page.evaluate(() => +window.__cv.app.measure.list.at(-1).distance.toFixed(3)) };
  console.log("  ", JSON.stringify(results.measure));

  // ======== 原点設定と直交計測 ========
  await page.keyboard.press("Escape");
  await tool("origin");
  await clickAt(mp[0].fx, mp[0].fy);
  const o = await lastPick();
  await clickAt(mp[1].fx, mp[1].fy);
  const frame = await page.evaluate(() => {
    const f = window.__cv.app.frame;
    return { set: f.isSet, origin: f.origin.toArray(), x: f.xAxis.toArray() };
  });
  assert(frame.set && Math.hypot(...frame.origin.map((v, i) => v - o.point[i])) < 1e-9 && Math.abs(frame.x[2]) < 1e-12, "原点と X 軸（水平）を設定");
  await tool("ortho");
  await clickAt(mp[0].fx, mp[0].fy);
  await clickAt(mp[2].fx, mp[2].fy);
  const om = await page.evaluate(() => {
    const m = window.__cv.app.measure.list.at(-1);
    return { axis: m.ortho, d: m.distance, comps: m.components.toArray() };
  });
  const big = om.comps.map(Math.abs);
  const nonAxis = big.filter((_, i) => i !== { x: 0, y: 1, z: 2 }[om.axis]);
  assert(om.axis && Math.abs(Math.max(...big) - om.d) < 1e-9 && nonAxis.every((v) => v < 1e-9), `直交計測 ${om.axis.toUpperCase()} 方向 ${om.d.toFixed(3)} m（他の成分 0）`);
  // 局所座標の表示（原点で 0）
  const coordText = await page.locator("#st-coord").innerText();
  results.ortho = om;
  await page.keyboard.press("Escape");

  // ======== 属性 ========
  await tool("select");
  // 選択モードではピンのクリックで指摘が開くので、前回までの指摘（mp[1] に登録）の無い位置を選ぶ
  await clickAt(mp[0].fx, mp[0].fy);
  await page.waitForFunction(() => !!window.__cv.app.selection);
  const props = await page.locator("#props").innerText();
  assert(props.includes("GlobalId") && props.includes("IFC クラス"), "要素の属性（GlobalId・クラス・Pset）を表示");
  results.props = props.split("\n").slice(0, 8).join(" | ");

  // ======== 切断ボックス・断面 ========
  await page.click('[data-clip="box"]');
  await page.evaluate(() => {
    const a = window.__cv.app;
    a.clipping.boxAround(a.lastPick.point, 1.5);
  });
  await idle(1500);
  const clip = await page.evaluate(() => {
    const a = window.__cv.app;
    const planes = a.viewer.renderer.clippingPlanes.length;
    // 箱の外の点は拾わない
    const r = a.viewer.canvas.getBoundingClientRect();
    return { planes, pcClip: !!a.pc.clipBox, visible: a.pc.visiblePoints };
  });
  // 箱の外（画面の隅）をクリックしても何も拾わない
  await clickAt(0.03, 0.03);
  const outside = await lastPick();
  assert(clip.planes === 6 && clip.pcClip && outside === null, "切断ボックス（6 面、点群・モデル共通、外側は拾わない）");
  await page.screenshot({ path: join(shots, "e2e-clipbox.png") });
  await page.click('[data-clip="section"]');
  await page.evaluate(() => window.__cv.app.clipping.setSection({ axis: "z", thickness: 0.3 }));
  const sec = await page.evaluate(() => window.__cv.app.viewer.renderer.clippingPlanes.length);
  await page.click('[data-view="top"]');
  await idle(1500);
  await page.screenshot({ path: join(shots, "e2e-section.png") });
  assert(sec === 2, "水平断面（厚み 30 cm の薄切り）");
  await page.click('[data-clip="none"]');
  await idle(500);

  // ======== 指摘の登録・再現 ========
  await setCamera([c2[0] + 20, c2[1] - 30, c2[2] + 18], c2);
  await idle(1000);
  await page.click('[data-tab="issues"]');
  await tool("issue");
  await clickAt(mp[1].fx, mp[1].fy);
  await page.waitForSelector("#dlg-issue[open]");
  await page.fill('#dlg-issue input[type="text"]', "E2E: 柱と配管の干渉");
  await page.fill("#dlg-issue textarea", "E2E テストで登録");
  await page.click("#dlg-issue button.primary");
  await page.waitForFunction(() => window.__cv.app.issues.size > 0);
  const issue = await page.evaluate(() => {
    const a = window.__cv.app;
    const i = [...a.issues.values()].at(-1);
    return { id: i.id, cam: i.view.camera, shot: i.screenshots[0], status: i.status, pins: document.querySelectorAll(".issue-pin").length };
  });
  assert(existsSync(join(share, issue.shot)) && existsSync(join(share, "events", "e2e-sato.jsonl")), "指摘を登録（events/e2e-sato.jsonl とスクリーンショット）");
  // 視点を変えてから一覧で選ぶと元に戻る
  await setCamera([c2[0] - 40, c2[1] + 40, c2[2] + 60], c2);
  await page.click(".issue-item");
  await page.waitForTimeout(800);
  const back = await page.evaluate(() => {
    const a = window.__cv.app;
    const o = a.current.origin;
    return a.viewer.camera.position.toArray().map((v, i) => v + o[i]);
  });
  const camErr = Math.hypot(...back.map((v, i) => v - issue.cam.position[i]));
  assert(camErr < 1e-6, "一覧から選ぶと登録時の視点を再現");

  // ======== 版の差分（色分け） ========
  await page.click('[data-tab="diff"]');
  const diffText = await page.locator("#tab-diff").innerText();
  await page.click('#tab-diff input[type="checkbox"]');
  await page.waitForFunction(() => window.__cv.app.diffShown && [...window.__cv.app.models.models.values()].some((m) => m.role === "previous"), null, { timeout: 60000 });
  await idle(1500);
  // 変更された柱へ寄る
  await page.click("#tab-diff details[open] .diff-list div");
  await idle(1500);
  await page.screenshot({ path: join(shots, "e2e-diff.png") });
  results.diff = diffText.split("\n").slice(0, 12).join(" | ");
  assert(/追加\s*\n?\s*1 件/.test(diffText) && /削除\s*\n?\s*5 件/.test(diffText), "差分タブ（追加 1・変更・削除 5）と色分け表示");
  await page.click('#tab-diff input[type="checkbox"]');
  await idle(500);
} finally {
  await app1.close();
}

// ======== 2 人目: 指摘の共有・状態変更・版またぎ ========
const app2 = await launch({ user: "e2e-tanaka" });
page = app2.page;
try {
  await page.waitForFunction(() => window.__cv.app.issues.size > 0, null, { timeout: 30000 });
  await page.evaluate(async (f) => {
    const a = window.__cv.app;
    await a.refreshDatasets();
    await a.openDataset(a.datasets.find((d) => d.folder === f));
  }, previous);
  await page.waitForTimeout(2000);
  const seen = await page.evaluate(() => {
    const a = window.__cv.app;
    const i = [...a.issues.values()].at(-1);
    return { id: i.id, by: i.createdBy, pinsOther: document.querySelectorAll(".issue-pin.other-version").length, version: a.current.version };
  });
  assert(seen.by === "e2e-sato" && seen.pinsOther >= 1, `別の人の指摘が見える・前の版（第${seen.version}版）にも位置で重ねて表示`);
  await page.click('[data-tab="issues"]');
  await page.click(".issue-item");
  await page.selectOption("#tab-issues .issue-detail select >> nth=0", "対応中");
  await page.waitForFunction(() => [...window.__cv.app.issues.values()].at(-1).status === "対応中");
  const files = readdirSync(join(share, "events"));
  assert(files.includes("e2e-tanaka.jsonl") && files.includes("e2e-sato.jsonl"), "状態変更は自分のファイル（events/e2e-tanaka.jsonl）にだけ追記");
  await page.screenshot({ path: join(shots, "e2e-issue-other.png") });
} finally {
  await app2.close();
}
console.log(JSON.stringify(results, null, 1));
