import * as THREE from "three";

// datasets/<フォルダ>/manifest.json の形。取込ごとに新しいフォルダを作り、公開後に変えるのは alignment だけ。

export interface SourceFile {
  name: string;
  size: number;
  sha256: string;
}

export interface PointcloudEntry {
  owner: string; // ファイルを持つデータセットのフォルダ（通常は自分。PoC 初期の版は前の版を指すことがある）
  carriedFrom?: string; // 前の版から複製したときの元のフォルダ
  dir: string; // owner 内の相対パス
  sources: (SourceFile & { points?: number; scans?: any[] })[];
  points: number;
  scanCount: number;
  bounds: { min: number[]; max: number[] };
  outputSizes?: Record<string, number>;
  timings?: Record<string, number>;
}

export interface FailedElement {
  guid: string;
  cls: string;
  name: string;
}

export interface MapConversion {
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
  scale: number;
  mapUnitScale: number;
  crsName: string | null;
}

export interface ModelEntry {
  key: string;
  owner: string;
  carriedFrom?: string;
  file: string; // owner 内の相対パス（.frag）
  elements: string; // owner 内の相対パス（.elements.json）
  source: SourceFile;
  schema: string;
  application: string;
  unitScale: number;
  expectedCount: number; // 形状表現を持つ表示対象の要素数
  geometryCount: number; // Fragments に形状が入った要素数
  failedCount: number;
  failed: FailedElement[]; // 先頭 500 件
  categories: Record<string, number>;
  mapConversion: MapConversion | null;
  ifcBox: { min: number[]; max: number[] } | null; // IFC 座標での範囲
  seconds: number;
}

export interface Alignment {
  method: "identity" | "mapConversion" | "threePoint";
  matrix: number[]; // IFC 座標 → 世界座標（点群の座標）。列優先 16 要素
  residual?: number;
  pairs?: { model: number[]; cloud: number[] }[];
  levelOnly?: boolean;
  by?: string;
  at?: string;
  note?: string;
}

export interface DiffSummary {
  against: string;
  added: number;
  removed: number;
  changed: number;
  pointcloudChanged: boolean;
}

export interface Manifest {
  schema: number;
  id: string;
  folder: string;
  name: string;
  site: string; // 系列（同じプロジェクトの版）の ID。最初の版の id
  version: number;
  previous: string | null; // 前の版のフォルダ
  state: "importing" | "ready";
  createdBy: string;
  createdAt: string;
  appVersion?: string;
  origin: [number, number, number];
  pointcloud: PointcloudEntry | null;
  models: ModelEntry[];
  alignment: Alignment;
  alignmentHistory?: Alignment[];
  diff: DiffSummary | null;
  importLog: { level: string; message: string }[];
  comment?: string;
}

export function fileRel(owner: string, rel: string): string {
  return `datasets/${owner}/${rel}`;
}

export function alignmentMatrix(m: Manifest): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(m.alignment?.matrix ?? new THREE.Matrix4().elements);
}

/** IFC 座標 → シーン座標（T(−原点) · A） */
export function ifcToScene(m: Manifest): THREE.Matrix4 {
  const o = m.origin;
  return new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]).multiply(alignmentMatrix(m));
}

export function worldToScene(m: Manifest, p: ArrayLike<number>): THREE.Vector3 {
  return new THREE.Vector3(p[0] - m.origin[0], p[1] - m.origin[1], p[2] - m.origin[2]);
}

export function sceneToWorld(m: Manifest, v: THREE.Vector3): [number, number, number] {
  return [v.x + m.origin[0], v.y + m.origin[1], v.z + m.origin[2]];
}

/** IfcMapConversion を行列にする（IFC 座標 m → 地図座標 m） */
export function mapConversionMatrix(mc: MapConversion, unitScale: number): { matrix: THREE.Matrix4; note: string | null } {
  let s = (mc.mapUnitScale * mc.scale) / unitScale;
  let note: string | null = null;
  // Scale に単位換算を含めるかどうかは出力ソフトでまちまち。明らかにおかしい倍率は 1 とみなす
  if (!(s > 0.1 && s < 10)) {
    note = `IfcMapConversion の倍率 ${s} は不自然なため 1 として扱いました`;
    s = 1;
  }
  const theta = Math.atan2(mc.xAxisOrdinate, mc.xAxisAbscissa);
  const m = new THREE.Matrix4()
    .makeTranslation(mc.eastings * mc.mapUnitScale, mc.northings * mc.mapUnitScale, mc.orthogonalHeight * mc.mapUnitScale)
    .multiply(new THREE.Matrix4().makeRotationZ(theta))
    .multiply(new THREE.Matrix4().makeScale(s, s, s));
  return { matrix: m, note };
}

/** 系列（同じプロジェクトの版の並び）ごとにまとめる。新しい版が先頭 */
export function groupBySite(list: Manifest[]): Map<string, Manifest[]> {
  const map = new Map<string, Manifest[]>();
  for (const m of list) {
    const k = m.site || m.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(m);
  }
  for (const arr of map.values()) arr.sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt));
  return map;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function formatCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 億`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString("ja-JP");
}

/** モデル名（ファイル名にも使う）を安全な形に */
export function safeKey(name: string): string {
  const s = name.replace(/\.ifc$/i, "").replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_").trim();
  return s.length > 60 ? s.slice(0, 60) : s || "model";
}
