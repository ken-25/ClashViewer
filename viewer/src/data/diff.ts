// 版どうしの差分（6.4）。IFC は GlobalId で要素を突き合わせ、点群は元ファイル・点数・範囲・スキャン数を比べる。

import type { Manifest, PointcloudEntry } from "./dataset";

/** model/<名前>.elements.json。要素ごとの外形（IFC 座標、mm 単位の整数）と属性のハッシュ */
export interface ElementIndex {
  version: 1;
  /** 属性署名の作り方の版。違う版どうしでは属性を比べられないので、取込時に作り直す */
  sig?: number;
  items: Record<string, ElementRecord>;
}

export const SIGNATURE_VERSION = 2;

export interface ElementRecord {
  c: string; // IFC クラス
  n: string; // 名称
  b: [number, number, number, number, number, number] | null; // min xyz, max xyz（mm）。形状を作れなかった要素は null
  h: string; // 属性・Pset のハッシュ
}

export type ChangeKind = "position" | "size" | "attributes";

export interface DiffItem {
  guid: string;
  model: string;
  c: string;
  n: string;
  kinds?: ChangeKind[];
  detail?: string;
}

export interface DatasetDiff {
  version: 1;
  against: string; // 比べた前の版のフォルダ
  createdAt: string;
  models: {
    added: DiffItem[];
    removed: DiffItem[];
    changed: DiffItem[];
    unchanged: number;
  };
  pointcloud: {
    changed: boolean;
    base: PointcloudSummary | null;
    current: PointcloudSummary | null;
    differences: string[];
  };
  provenance: {
    base: Provenance;
    current: Provenance;
  };
}

interface PointcloudSummary {
  sources: { name: string; size: number; sha256: string }[];
  points: number;
  scanCount: number;
  bounds: { min: number[]; max: number[] };
}

interface Provenance {
  folder: string;
  version: number;
  createdBy: string;
  createdAt: string;
  models: { key: string; source: string; sha256: string }[];
  pointcloud: { source: string; sha256: string }[];
}

const TOL_MM = 2; // 位置・寸法の変化とみなす閾値

export function diffElements(base: Map<string, ElementIndex>, cur: Map<string, ElementIndex>): DatasetDiff["models"] {
  // 同じ GlobalId が複数の IFC に入っていることがある（Revit の意匠・構造で同じ要素を出すなど）。
  // モデル名＋GlobalId で突き合わせる
  const flatten = (m: Map<string, ElementIndex>) => {
    const out = new Map<string, ElementRecord & { model: string; guid: string }>();
    for (const [model, idx] of m) for (const [g, r] of Object.entries(idx.items)) out.set(`${model}\u0000${g}`, { ...r, model, guid: g });
    return out;
  };
  const a = flatten(base);
  const b = flatten(cur);
  const added: DiffItem[] = [];
  const removed: DiffItem[] = [];
  const changed: DiffItem[] = [];
  let unchanged = 0;
  for (const [k, r] of b) {
    const p = a.get(k);
    const g = r.guid;
    if (!p) {
      added.push({ guid: g, model: r.model, c: r.c, n: r.n });
      continue;
    }
    const kinds: ChangeKind[] = [];
    const details: string[] = [];
    if (p.b && r.b) {
      const sizeA = [p.b[3] - p.b[0], p.b[4] - p.b[1], p.b[5] - p.b[2]];
      const sizeB = [r.b[3] - r.b[0], r.b[4] - r.b[1], r.b[5] - r.b[2]];
      const centerA = [(p.b[0] + p.b[3]) / 2, (p.b[1] + p.b[4]) / 2, (p.b[2] + p.b[5]) / 2];
      const centerB = [(r.b[0] + r.b[3]) / 2, (r.b[1] + r.b[4]) / 2, (r.b[2] + r.b[5]) / 2];
      if (sizeA.some((v, i) => Math.abs(v - sizeB[i]) > TOL_MM)) {
        kinds.push("size");
        details.push(`寸法 ${sizeA.map((v) => v.toFixed(0)).join("×")} → ${sizeB.map((v) => v.toFixed(0)).join("×")} mm`);
      }
      const move = Math.hypot(centerA[0] - centerB[0], centerA[1] - centerB[1], centerA[2] - centerB[2]);
      if (move > TOL_MM) {
        kinds.push("position");
        details.push(`移動 ${move.toFixed(0)} mm`);
      }
    } else if (!!p.b !== !!r.b) {
      kinds.push("size");
      details.push(r.b ? "形状あり（前の版は形状なし）" : "形状なし（前の版は形状あり）");
    }
    if (p.h !== r.h) kinds.push("attributes");
    if (kinds.length) changed.push({ guid: g, model: r.model, c: r.c, n: r.n, kinds, detail: details.join("、") });
    else unchanged++;
  }
  for (const [k, r] of a) if (!b.has(k)) removed.push({ guid: r.guid, model: r.model, c: r.c, n: r.n });
  return { added, removed, changed, unchanged };
}

function pcSummary(pc: PointcloudEntry | null): PointcloudSummary | null {
  if (!pc) return null;
  return {
    sources: pc.sources.map((s) => ({ name: s.name, size: s.size, sha256: s.sha256 })),
    points: pc.points,
    scanCount: pc.scanCount,
    bounds: pc.bounds,
  };
}

export function diffPointcloud(base: PointcloudEntry | null, cur: PointcloudEntry | null): DatasetDiff["pointcloud"] {
  const a = pcSummary(base);
  const b = pcSummary(cur);
  const differences: string[] = [];
  if (!a && b) differences.push("点群を追加");
  else if (a && !b) differences.push("点群を削除");
  else if (a && b) {
    const ha = a.sources.map((s) => s.sha256).join(",");
    const hb = b.sources.map((s) => s.sha256).join(",");
    if (ha !== hb) differences.push(`元ファイル ${a.sources.map((s) => s.name).join("、")} → ${b.sources.map((s) => s.name).join("、")}`);
    if (a.points !== b.points) differences.push(`点数 ${a.points.toLocaleString()} → ${b.points.toLocaleString()}`);
    if (a.scanCount !== b.scanCount) differences.push(`スキャン数 ${a.scanCount} → ${b.scanCount}`);
    const d = Math.max(
      ...[0, 1, 2].map((i) => Math.abs(a.bounds.min[i] - b.bounds.min[i])),
      ...[0, 1, 2].map((i) => Math.abs(a.bounds.max[i] - b.bounds.max[i])),
    );
    if (d > 0.01) {
      const f = (bb: { min: number[]; max: number[] }) => bb.max.map((v, i) => (v - bb.min[i]).toFixed(2)).join("×");
      differences.push(`範囲 ${f(a.bounds)} → ${f(b.bounds)} m（最大 ${d.toFixed(2)} m 変化）`);
    }
  }
  return { changed: differences.length > 0, base: a, current: b, differences };
}

export function provenance(m: Manifest): Provenance {
  return {
    folder: m.folder,
    version: m.version,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    models: m.models.map((x) => ({ key: x.key, source: x.source.name, sha256: x.source.sha256 })),
    pointcloud: (m.pointcloud?.sources ?? []).map((s) => ({ source: s.name, sha256: s.sha256 })),
  };
}

/** 文字列の 53bit ハッシュ（cyrb53） */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 属性比較用の署名。要素自身の属性と、それに付く Pset・数量・タイプの「名前と値」だけを見る。
 * 関係の先をさらに辿ると、同じタイプの別要素（ObjectTypeOf）など無関係な変更まで拾ってしまう。
 */
export function attributeSignature(d: Record<string, any>): string {
  const flat = (o: Record<string, any> | undefined) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (!Array.isArray(v)) out[k] = v;
    return out;
  };
  const list = (x: any) => (Array.isArray(x) ? x : []);
  const defs = list(d.IsDefinedBy).map((ps: any) => ({
    ...flat(ps),
    // Pset・数量セットの値と、タイプが持つ Pset。ObjectTypeOf（同じタイプの全要素）などは見ない
    props: [...list(ps.HasProperties), ...list(ps.Quantities)].map((p: any) => flat(p)),
    typeProps: list(ps.HasPropertySets).map((t: any) => ({ ...flat(t), props: list(t.HasProperties).map((p: any) => flat(p)) })),
  }));
  const types = (Array.isArray(d.IsTypedBy) ? d.IsTypedBy : []).map((t: any) => flat(t));
  return hash53(stableStringify({ self: flat(d), defs, types }));
}

/** 属性比較用に、順序に依らない文字列にする（ローカル ID など版で変わる値は除く） */
export function stableStringify(v: unknown, ancestors: object[] = [], depth = 0): string {
  // 循環（祖先に同じものがある）と深さだけを止める。同じ値を 2 か所で共有していても同じ結果になるようにする
  if (v && typeof v === "object") {
    if (ancestors.includes(v) || depth > 12) return '"…"';
  }
  const next = v && typeof v === "object" ? [...ancestors, v] : ancestors;
  const rec = (x: unknown) => stableStringify(x, next, depth + 1);
  if (Array.isArray(v)) return `[${v.map(rec).sort().join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      // 版ごとに振り直される識別子は比べない（Pset の GlobalId は出力のたびに変わるソフトがある）
      .filter((k) => !["_localId", "localId", "expressID", "_guid", "GlobalId"].includes(k))
      .sort()
      .map((k) => `${k}:${rec(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
