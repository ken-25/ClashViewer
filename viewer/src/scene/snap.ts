import * as THREE from "three";
import type { LoadedModel } from "../model/models";

/**
 * スナップ候補の種類。
 * vertex: モデルの頂点、midpoint: モデルの辺の中点、edge: モデルの辺上（カーソルに最も近い点）、
 * corner: 点群の角（2 方向以上の端が交わる所）、boundary: 点群の端（面が途切れる所）、
 * axis: 軸を固定しているときの軸線上（何も無い所）、free: スナップしない（カーソル下の面・点そのもの）。
 */
export type SnapKind = "vertex" | "midpoint" | "edge" | "corner" | "boundary" | "axis" | "free";

export interface SnapCandidate {
  kind: SnapKind;
  source: "model" | "cloud" | "axis";
  point: THREE.Vector3; // シーン座標
  /** カメラからの距離 */
  distance: number;
  /** canvas 上の位置（px） */
  sx: number;
  sy: number;
  /** カーソルからの画面上の距離（px） */
  screenDist: number;
  /** 辺のスナップでは辺の両端（強調表示用） */
  edge?: [THREE.Vector3, THREE.Vector3];
  model?: { lm: LoadedModel; localId: number };
  /** 補足（点群の端の向き「+Z」など） */
  detail?: string;
}

export const SNAP_LABEL: Record<SnapKind, string> = {
  vertex: "端点",
  midpoint: "中点",
  edge: "辺上",
  corner: "角",
  boundary: "端",
  axis: "軸上",
  free: "フリー",
};

export function sourceLabel(c: { source: SnapCandidate["source"] }): string {
  return c.source === "model" ? "モデル" : c.source === "cloud" ? "点群" : "軸上";
}

/** 並べ替えの重み（px 相当）。角・端点を辺上より優先し、フリーは常に最後 */
const PENALTY: Record<SnapKind, number> = { vertex: 0, corner: 0, midpoint: 2, edge: 6, boundary: 6, axis: 8, free: 1e6 };

/** Tab で回す候補の上限（フリーを除く）。多いと目当ての候補へ辿り着くまでが長い */
export const MAX_SNAPS = 6;

/**
 * 候補を使いやすい順に並べ、画面上で重なるもの（mergePx 以内）は優先の高い方だけ残す。
 * スナップ候補は MAX_SNAPS 件まで。フリーは最大 1 つで、常に最後に置く。
 */
export function rankCandidates(list: SnapCandidate[], mergePx = 6, max = MAX_SNAPS): SnapCandidate[] {
  const sorted = [...list].sort((a, b) => a.screenDist + PENALTY[a.kind] - (b.screenDist + PENALTY[b.kind]) || a.distance - b.distance);
  const out: SnapCandidate[] = [];
  let free: SnapCandidate | null = null;
  for (const c of sorted) {
    if (c.kind === "free") {
      free ??= c;
      continue;
    }
    if (out.length >= max) continue;
    // 画面上でほぼ同じ所に見える候補は見分けられないので 1 つにまとめる
    if (out.some((o) => Math.hypot(o.sx - c.sx, o.sy - c.sy) <= mergePx)) continue;
    out.push(c);
  }
  if (free) out.push(free);
  return out;
}

// ---- 点群の端・角 ----

/** カーソルの周りの点。sx/sy はカーソルからの画面上のずれ（px）、dist はカメラからの距離 */
export interface CloudSample {
  n: number;
  pos: Float64Array; // n * 3（シーン座標）
  sx: Float32Array;
  sy: Float32Array;
  dist: Float32Array;
}

export interface CloudSnapParams {
  /** 集めた範囲の半径（px） */
  radiusPx: number;
  /** フリーとして拾う範囲（px）。従来のクリック位置の取得と同じ */
  pickPx: number;
  /** 距離 d の位置での 1px の大きさ（m） */
  pxSize: (d: number) => number;
  /** 局所座標系の X/Y/Z 軸（端・角はこの向きで探す） */
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

export interface CloudSnapResult {
  /** カーソル下の点（従来の取得と同じ: pickPx 以内で最も手前） */
  free: THREE.Vector3 | null;
  snaps: { kind: "corner" | "boundary"; point: THREE.Vector3; detail: string }[];
}

const AXIS_NAMES = ["X", "Y", "Z"] as const;

/**
 * 点群の端と角を探す。
 *
 * 1. カーソルの周りを小さな格子に分け、格子ごとの最も手前の点から、奥行きが連続する範囲を
 *    カーソル下の面として塗り広げる（背景や奥の物を除く）
 * 2. 面の点を局所座標の ±X/±Y/±Z の向きに測り、最も先の点がカーソルの近く（集めた円の内側）に
 *    あれば、そこで面が途切れている＝端とみなす（面が円の外まで続くなら、最も先は円の縁になる）
 * 3. 違う軸の端が 2 つ以上あれば、その交わる所を角とする
 *
 * 端・角の位置は、端の向きの成分だけを端の値に揃える（点のばらつきで丸まった角を立てる）。
 */
export function cloudSnaps(s: CloudSample, prm: CloudSnapParams): CloudSnapResult {
  const res: CloudSnapResult = { free: null, snaps: [] };
  if (s.n === 0) return res;
  const R = prm.radiusPx;
  const pick2 = prm.pickPx * prm.pickPx;
  // 種: カーソル近く（pickPx 以内）で最も手前の点。無ければ円の中で最も手前の点
  let seed = -1;
  let nearest = -1;
  for (let i = 0; i < s.n; i++) {
    if (s.sx[i] * s.sx[i] + s.sy[i] * s.sy[i] <= pick2 && (seed < 0 || s.dist[i] < s.dist[seed])) seed = i;
    if (nearest < 0 || s.dist[i] < s.dist[nearest]) nearest = i;
  }
  if (seed >= 0) res.free = new THREE.Vector3(s.pos[seed * 3], s.pos[seed * 3 + 1], s.pos[seed * 3 + 2]);
  if (seed < 0) seed = nearest;
  const d0 = s.dist[seed];
  const px = prm.pxSize(d0);

  // 格子（3px）ごとの最も手前の距離
  const cell = 3;
  const G = Math.ceil((2 * R) / cell) + 1;
  const cellOf = (i: number) => {
    const cx = Math.min(G - 1, Math.max(0, Math.floor((s.sx[i] + R) / cell)));
    const cy = Math.min(G - 1, Math.max(0, Math.floor((s.sy[i] + R) / cell)));
    return cy * G + cx;
  };
  const cellMin = new Float32Array(G * G).fill(Infinity);
  const cellIdx = new Int32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const c = cellOf(i);
    cellIdx[i] = c;
    if (s.dist[i] < cellMin[c]) cellMin[c] = s.dist[i];
  }
  // 奥行きが連続する格子を塗り広げる。隣が空でも 1 つ飛ばしで繋ぐ（点がまばらでも途切れないように）。
  // 許す段差は、斜めに見た面（約 70°）の格子間の奥行きの差＋点のばらつき
  const inRegion = new Uint8Array(G * G);
  const start = cellIdx[seed];
  inRegion[start] = 1;
  const queue = [start];
  while (queue.length) {
    const c = queue.pop()!;
    const cx = c % G;
    const cy = (c - cx) / G;
    const dc = cellMin[c];
    const step = cell * prm.pxSize(dc) * 3;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        const nc = ny * G + nx;
        if (inRegion[nc] || cellMin[nc] === Infinity) continue;
        const k = Math.max(Math.abs(dx), Math.abs(dy));
        if (Math.abs(cellMin[nc] - dc) > k * step + 0.01) continue;
        inRegion[nc] = 1;
        queue.push(nc);
      }
    }
  }
  // 面の点（格子の中でも手前の層だけ）
  const region: number[] = [];
  for (let i = 0; i < s.n; i++) {
    const c = cellIdx[i];
    if (inRegion[c] && s.dist[i] <= cellMin[c] + Math.max(0.01, cell * prm.pxSize(cellMin[c]) * 3)) region.push(i);
  }
  if (region.length < 12) return res;

  const P = (i: number) => new THREE.Vector3(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]);
  const sd = (i: number) => Math.hypot(s.sx[i], s.sy[i]);
  const band = Math.max(0.006, 1.5 * px);
  interface Edge {
    axis: number;
    sign: 1 | -1;
    tmax: number;
    t: Float64Array; // region の各点の sign * (p · axis)
  }
  const edges: Edge[] = [];
  for (let a = 0; a < 3; a++) {
    const ax = prm.axes[a];
    const base = new Float64Array(region.length);
    for (let j = 0; j < region.length; j++) {
      const i = region[j];
      base[j] = s.pos[i * 3] * ax.x + s.pos[i * 3 + 1] * ax.y + s.pos[i * 3 + 2] * ax.z;
    }
    const sorted = Float64Array.from(base).sort();
    const n = sorted.length;
    // 広がりの判定は外れ値に強く（両端 2% を除く）、端の値は端の列を削らないよう数点だけ除く
    const spread = sorted[n - 1 - Math.floor(n * 0.02)] - sorted[Math.floor(n * 0.02)];
    // この向きに面が広がっていない（視線の向きなど）ときは端を探さない
    if (spread < 0.25 * R * px) continue;
    const trim = Math.min(3, Math.floor(n * 0.005));
    const lo = sorted[trim];
    const hi = sorted[n - 1 - trim];
    for (const sign of [1, -1] as const) {
      const tmax = sign > 0 ? hi : -lo;
      const t = sign > 0 ? base : base.map((v) => -v);
      let count = 0;
      let minSd = Infinity;
      for (let j = 0; j < region.length; j++) {
        if (t[j] < tmax - band) continue;
        count++;
        minSd = Math.min(minSd, sd(region[j]));
      }
      if (count >= 3 && minSd < 0.7 * R) edges.push({ axis: a, sign, tmax, t });
    }
  }
  const snapTo = (p: THREE.Vector3, list: Edge[]) => {
    for (const e of list) {
      const ax = prm.axes[e.axis];
      const cur = e.sign * p.dot(ax);
      p.addScaledVector(ax, e.sign * (e.tmax - cur));
    }
    return p;
  };
  const name = (e: Edge) => `${e.sign > 0 ? "+" : "−"}${AXIS_NAMES[e.axis]}`;

  // 端: 端の帯の中でカーソルに最も近い点を、端の値に揃える
  for (const e of edges) {
    let best = -1;
    for (let j = 0; j < region.length; j++) {
      if (e.t[j] < e.tmax - band) continue;
      if (best < 0 || sd(region[j]) < sd(region[best])) best = j;
    }
    if (best >= 0) res.snaps.push({ kind: "boundary", point: snapTo(P(region[best]), [e]), detail: name(e) });
  }
  // 角: 違う軸の端の組（3 軸揃えば 3 軸の角も）
  const combos: Edge[][] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (edges[i].axis === edges[j].axis) continue;
      combos.push([edges[i], edges[j]]);
      for (let k = j + 1; k < edges.length; k++) {
        if (edges[k].axis !== edges[i].axis && edges[k].axis !== edges[j].axis) combos.push([edges[i], edges[j], edges[k]]);
      }
    }
  }
  for (const combo of combos) {
    let best = -1;
    let bestScore = -Infinity;
    for (let j = 0; j < region.length; j++) {
      let score = 0;
      for (const e of combo) score += e.t[j] - e.tmax;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best < 0) continue;
    // 角の近くに実際に点があること（L 字の内側などを角にしない）
    if (!combo.every((e) => e.t[best] >= e.tmax - 3 * band)) continue;
    if (sd(region[best]) > 0.85 * R) continue;
    res.snaps.push({ kind: "corner", point: snapTo(P(region[best]), combo), detail: combo.map(name).join(" ") });
  }
  return res;
}
