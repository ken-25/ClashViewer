// 撮影ポイント（data/scanPoints.ts）の単体テスト（node --test）
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let sp;
const out = mkdtempSync(join(tmpdir(), "kasane-test-"));

before(async () => {
  await build({
    logLevel: "silent",
    configFile: false,
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { scanPoints: "src/data/scanPoints.ts" }, formats: ["es"] } },
  });
  sp = await import(pathToFileURL(join(out, "scanPoints.js")));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
});

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const box = (min, max) => ({ min, max });
const pose = (t, r = [1, 0, 0, 0]) => ({ rotation: r, translation: t });

function manifest(sources, bounds = box([0, 0, 0], [100, 100, 10])) {
  return { origin: [0, 0, 0], pointcloud: { owner: "20260101_x_aaaaaa", dir: "pointcloud", sources, points: 1, scanCount: 1, bounds } };
}

const pano = (extra = {}) => ({ index: 0, name: "pano", kind: "spherical", format: "jpeg", width: 400, height: 200, pixelWidth: (2 * Math.PI) / 400, pixelHeight: Math.PI / 200, pose: null, file: "images/00_0000.jpg", ...extra });

test("scanStations: スキャンの器械点と、guid で結び付いた画像", () => {
  const m = manifest([{ name: "a.e57", scans: [
    { index: 0, name: "S1", guid: "g1", points: 10, pose: pose([10, 10, 1.5]), bounds: box([0, 0, 0], [20, 20, 3]) },
    { index: 1, name: "S2", guid: "g2", pose: pose([50, 50, 1.5]), bounds: box([40, 40, 0], [60, 60, 3]) },
  ], images: [pano({ scanGuid: "g2" })] }]);
  const list = sp.scanStations(m);
  assert.deepEqual(list.map((s) => s.id), ["0:0", "0:1"]);
  assert.deepEqual(list[0].position, [10, 10, 1.5]);
  assert.equal(list[0].images.length, 0);
  assert.equal(list[1].images.length, 1);
  // 画像に姿勢が無ければスキャンの姿勢で貼る
  assert.deepEqual(list[1].images[0].position, [50, 50, 1.5]);
  assert.equal(list[1].images[0].rel, "datasets/20260101_x_aaaaaa/images/00_0000.jpg");
});

test("scanStations: 姿勢が原点のまま（点は世界座標）のスキャンは位置不明", () => {
  const m = manifest([{ name: "a.e57", scans: [
    { index: 0, name: "S1", pose: pose([0, 0, 0]), bounds: box([1000, 2000, 0], [1020, 2020, 3]) },
    // 範囲が無い古い版は点群全体の範囲で見る
    { index: 1, name: "S2", pose: pose([0, 0, 0]) },
    { index: 2, name: "S3", pose: pose([50, 50, 1]) },
  ] }], box([1000, 2000, 0], [1100, 2100, 10]));
  const list = sp.scanStations(m);
  assert.deepEqual(list.map((s) => s.position), [null, null, null]);
  assert.equal(sp.placedStations(list).length, 0);
  assert.equal(sp.stepStation(list, null, 1), null);
});

test("scanStations: 器械点が不明でも、姿勢のある画像があればその位置", () => {
  const m = manifest([{ name: "a.e57", scans: [{ index: 0, name: "S1", guid: "g1", pose: pose([0, 0, 0]), bounds: box([10, 10, 0], [20, 20, 3]) }],
    images: [pano({ scanGuid: "g1", pose: pose([15, 15, 1.6]) })] }]);
  const [st] = sp.scanStations(m);
  assert.deepEqual(st.position, [15, 15, 1.6]);
});

test("scanStations: スキャンに結び付かない姿勢付きの画像は画像だけの撮影ポイント。書き出せなかった画像は使わない", () => {
  const m = manifest([{ name: "a.e57", scans: [], images: [
    pano({ index: 3, name: "solo", pose: pose([5, 5, 1]) }),
    pano({ index: 4, name: "nopose" }),
    pano({ index: 5, name: "broken", pose: pose([6, 6, 1]), file: null }),
  ] }]);
  const list = sp.scanStations(m);
  assert.deepEqual(list.map((s) => [s.id, s.label]), [["0:img3", "solo"]]);
});

test("scanStations: 元ファイルが複数ならファイル名を添える。点群が無ければ空", () => {
  const s = (n) => ({ index: 0, name: n, pose: pose([1, 1, 1]) });
  const list = sp.scanStations(manifest([{ name: "a.e57", scans: [s("S")] }, { name: "b.e57", scans: [s("S")] }]));
  assert.deepEqual(list.map((x) => [x.id, x.label]), [["0:0", "S（a.e57）"], ["1:0", "S（b.e57）"]]);
  assert.deepEqual(sp.scanStations({ pointcloud: null }), []);
});

test("stepStation: 位置が分かるものだけを巡り、端で反対へ戻る", () => {
  const list = [
    { id: "a", position: [0, 0, 0], images: [] },
    { id: "b", position: null, images: [] },
    { id: "c", position: [1, 0, 0], images: [] },
  ];
  assert.equal(sp.stepStation(list, null, 1).id, "a");
  assert.equal(sp.stepStation(list, null, -1).id, "c");
  assert.equal(sp.stepStation(list, "a", 1).id, "c");
  assert.equal(sp.stepStation(list, "c", 1).id, "a");
  assert.equal(sp.stepStation(list, "a", -1).id, "c");
  assert.equal(sp.nearestStation(list, [0.9, 0, 0]).id, "c");
});

test("panoramaDirection: 中央が +X、右へ時計回り、上が上向き", () => {
  const img = pano();
  const c = sp.panoramaDirection(img, 0.5, 0.5);
  near(c.x, 1); near(c.y, 0); near(c.z, 0);
  // 右へ 1/4 → 方位 −90°（−Y）
  const r = sp.panoramaDirection(img, 0.75, 0.5);
  near(r.x, 0); near(r.y, -1);
  // 左端は真後ろ
  near(sp.panoramaDirection(img, 0, 0.5).x, -1);
  // 上端は真上
  near(sp.panoramaDirection(img, 0.5, 0).z, 1);
  // 円筒画像: 主点の高さが水平
  const cyl = { ...img, kind: "cylindrical", radius: 2, principalY: 100, pixelHeight: 0.01 };
  const cv = sp.panoramaDirection(cyl, 0.5, 0);
  near(cv.length(), 1);
  assert.ok(cv.z > 0 && cv.x > 0);
});

test("pinholeCorners: −Z を向き、+X が右・+Y が上。主点が中心なら左右対称", () => {
  const img = { ...pano(), kind: "pinhole", width: 40, height: 30, pixelWidth: 1e-5, pixelHeight: 1e-5, focalLength: 4e-4, principalPoint: [20, 15] };
  const [tl, tr, br, bl] = sp.pinholeCorners(img, 2);
  near(tl.z, -2); near(br.z, -2);
  near(tl.x, -1); near(tr.x, 1); // 20 画素 × 1e-5 m / 4e-4 m × 2 m
  near(tl.y, 0.75); near(bl.y, -0.75);
  assert.ok(br.x > 0 && br.y < 0);
});

test("imageQuaternion と stationForward: 方位の補正は鉛直まわり", () => {
  // Z まわり 90° の姿勢
  const s = Math.SQRT1_2;
  const st = { id: "a", position: [0, 0, 0], rotation: [s, 0, 0, s], images: [] };
  const f = sp.stationForward(st);
  near(f.x, 0); near(f.y, 1);
  const g = sp.stationForward(st, 90);
  near(g.x, -1); near(g.y, 0);
  const q = sp.poseQuaternion([0, 0, 0, 0]);
  assert.equal(q.w, 1);
});
