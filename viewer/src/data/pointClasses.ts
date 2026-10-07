// 点群の分類（LAS の classification）の名前と色。
// 既定は ASPRS LAS 1.4 の標準分類。プロジェクトごとの読み替えは config/app.json の pointcloud.classes で上書きする:
//   "pointcloud": { "classes": { "2": { "name": "床", "color": "#a0522d" }, "20": { "name": "配管" } } }
// DOM・three.js に依存しない（単体テストできるように）。

export interface PointClassInfo {
  code: number;
  name: string;
  /** #rrggbb */
  color: string;
}

const ASPRS: Record<number, [string, string]> = {
  0: ["未分類（作成のみ）", "#9e9e9e"],
  1: ["未分類", "#bdbdbd"],
  2: ["地面", "#a1785c"],
  3: ["低い植生", "#9ccc65"],
  4: ["中位の植生", "#43a047"],
  5: ["高い植生", "#1b5e20"],
  6: ["建物", "#e57373"],
  7: ["ノイズ（低）", "#ff00ff"],
  8: ["予約（キーポイント）", "#ffeb3b"],
  9: ["水面", "#42a5f5"],
  10: ["鉄道", "#795548"],
  11: ["道路面", "#616161"],
  12: ["予約（重なり）", "#ffcc80"],
  13: ["ワイヤー（ガード）", "#ffd54f"],
  14: ["ワイヤー（導体）", "#ffa000"],
  15: ["送電塔", "#8d6e63"],
  16: ["ワイヤー（接続）", "#ffca28"],
  17: ["橋床", "#90a4ae"],
  18: ["ノイズ（高）", "#d500f9"],
};

/** 標準に無い番号の色（番号から決める。隣り合う番号が似た色にならないように黄金角で回す） */
function autoColor(code: number): string {
  const hue = (code * 137.508) % 360;
  return hslToHex(hue, 0.65, 0.55);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** 設定（pointcloud.classes）を読む。壊れた項目は無視する */
export function parseClassOverrides(raw: unknown): Map<number, Partial<Omit<PointClassInfo, "code">>> {
  const out = new Map<number, Partial<Omit<PointClassInfo, "code">>>();
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const code = Number(k);
    if (!Number.isInteger(code) || code < 0 || code > 255 || !v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const e: Partial<Omit<PointClassInfo, "code">> = {};
    if (typeof o.name === "string" && o.name.trim()) e.name = o.name.trim();
    if (typeof o.color === "string" && HEX.test(o.color)) e.color = o.color.toLowerCase();
    out.set(code, e);
  }
  return out;
}

export function classInfo(code: number, overrides?: Map<number, Partial<Omit<PointClassInfo, "code">>>): PointClassInfo {
  const std = ASPRS[code];
  const o = overrides?.get(code);
  return {
    code,
    name: o?.name ?? std?.[0] ?? `分類 ${code}`,
    color: o?.color ?? std?.[1] ?? autoColor(code),
  };
}

/** シェーダーに渡す 256 色の表（RGBA。A は表示=255・非表示=0） */
export function classTable(hidden: ReadonlySet<number>, overrides?: Map<number, Partial<Omit<PointClassInfo, "code">>>): Uint8Array {
  const t = new Uint8Array(256 * 4);
  for (let c = 0; c < 256; c++) {
    const hex = classInfo(c, overrides).color;
    t[c * 4] = parseInt(hex.slice(1, 3), 16);
    t[c * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    t[c * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    t[c * 4 + 3] = hidden.has(c) ? 0 : 255;
  }
  return t;
}
