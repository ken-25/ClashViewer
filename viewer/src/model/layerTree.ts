/**
 * レイヤーの階・クラスの 2 段ツリーと、表示・半透明の状態キー。
 *
 * 状態キー（LoadedModel.hiddenKeys / ghostKeys の要素。指摘の視点にもそのまま保存する）:
 * - "IFCWALL"                … そのクラスを全ての階で（以前の保存形式。IfcSpace の既定非表示にも使う）
 * - "storey:<階キー>"         … その階の要素すべて
 * - "storey:<階キー>/IFCWALL" … その階のそのクラス
 * 階キーは IfcBuildingStorey の GlobalId（無ければ "#<localId>"）。どの階にも入っていない要素は "-"。
 * GlobalId を使うのは、別の版で登録した指摘の視点を開いても同じ階に効かせるため。
 */

/** Fragments の SpatialTreeItem と同じ形（型だけ。Fragments に依存させない） */
export interface SpatialNode {
  category: string | null;
  localId: number | null;
  children?: SpatialNode[];
}

export interface ClassNode {
  name: string;
  ids: number[];
}

export interface StoreyNode {
  key: string;
  name: string;
  elevation: number | null;
  classes: ClassNode[];
  ids: number[];
}

export interface StoreyInfo {
  guid: string | null;
  name: string | null;
  elevation: number | null;
}

export const STOREY = "IFCBUILDINGSTOREY";
export const NO_STOREY = "-";
/** 要素ではなく入れ物（階の行・モデルの行で扱うので、クラスとしては並べない） */
const CONTAINERS = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", STOREY]);

export const storeyKeyOf = (storey: string) => `storey:${storey}`;
export const classKeyOf = (storey: string, cls: string) => `storey:${storey}/${cls}`;

/** 空間構造の中の階（localId）と、各要素がどの階に入っているか */
export function findStoreys(root: SpatialNode | null | undefined): { storeys: number[]; storeyOf: Map<number, number> } {
  const storeys: number[] = [];
  const storeyOf = new Map<number, number>();
  // 分類だけの節（localId なし）は子の種類を表す。要素の節の子には引き継がない
  const walk = (n: SpatialNode, groupCategory: string | null, storey: number | null) => {
    const cat = n.category ?? groupCategory;
    let cur = storey;
    if (n.localId !== null && n.localId !== undefined) {
      if (cat === STOREY) {
        storeys.push(n.localId);
        cur = n.localId;
      } else if (cur !== null) storeyOf.set(n.localId, cur);
    }
    const nextGroup = n.localId === null || n.localId === undefined ? cat : null;
    for (const c of n.children ?? []) walk(c, nextGroup, cur);
  };
  if (root && typeof root === "object") walk(root, null, null);
  return { storeys, storeyOf };
}

/**
 * 階ごとにクラスを並べたツリーを作る。階は高さの低い順（高さが分からなければ空間構造の順）。
 * 要素の無い階は出さない。どの階にも入っていない要素は最後の「階なし」にまとめる。
 */
export function buildStoreyTree(
  root: SpatialNode | null | undefined,
  itemsByCategory: Record<string, number[]>,
  info: Map<number, StoreyInfo>,
): StoreyNode[] {
  const { storeys, storeyOf } = findStoreys(root);
  const keyOf = new Map<number, string>();
  for (const s of storeys) keyOf.set(s, info.get(s)?.guid || `#${s}`);
  const groups = new Map<string, Map<string, number[]>>();
  for (const [cls, ids] of Object.entries(itemsByCategory)) {
    if (CONTAINERS.has(cls)) continue;
    for (const id of ids) {
      const s = storeyOf.get(id);
      const k = s === undefined ? NO_STOREY : keyOf.get(s)!;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = new Map()));
      let list = g.get(cls);
      if (!list) g.set(cls, (list = []));
      list.push(id);
    }
  }
  const node = (key: string, name: string, elevation: number | null): StoreyNode | null => {
    const g = groups.get(key);
    if (!g) return null;
    const classes = [...g.entries()].map(([n, ids]) => ({ name: n, ids })).sort((a, b) => a.name.localeCompare(b.name));
    return { key, name, elevation, classes, ids: classes.flatMap((c) => c.ids) };
  };
  const order = storeys.map((s, i) => ({ s, i, e: info.get(s)?.elevation ?? null }));
  if (order.every((o) => o.e !== null)) order.sort((a, b) => a.e! - b.e! || a.i - b.i);
  const out: StoreyNode[] = [];
  const seen = new Set<string>();
  for (const { s, e } of order) {
    const k = keyOf.get(s)!;
    if (seen.has(k)) continue;
    seen.add(k);
    const n = node(k, info.get(s)?.name || `階 #${s}`, e);
    if (n) out.push(n);
  }
  const rest = node(NO_STOREY, storeys.length ? "階なし" : "全体", null);
  if (rest) out.push(rest);
  return out;
}

/** 状態キーの集合 → 対象の localId（重複なし） */
export function idsOfKeys(keys: Iterable<string>, tree: StoreyNode[]): number[] {
  const byStorey = new Map(tree.map((s) => [s.key, s]));
  const out = new Set<number>();
  const add = (ids: number[]) => ids.forEach((i) => out.add(i));
  for (const k of keys) {
    if (k.startsWith("storey:")) {
      const rest = k.slice(7);
      const slash = rest.indexOf("/");
      const s = byStorey.get(slash < 0 ? rest : rest.slice(0, slash));
      if (!s) continue;
      if (slash < 0) add(s.ids);
      else add(s.classes.find((c) => c.name === rest.slice(slash + 1))?.ids ?? []);
    } else {
      for (const s of tree) add(s.classes.find((c) => c.name === k)?.ids ?? []);
    }
  }
  return [...out];
}

/** 階・クラスの行が、この状態キーの集合に入っているか（全階のクラス指定も含める） */
export function hasState(keys: Set<string>, storey: string, cls?: string): boolean {
  if (cls === undefined) return keys.has(storeyKeyOf(storey));
  return keys.has(classKeyOf(storey, cls)) || keys.has(cls);
}

/**
 * 階・クラスの行の状態を切り替える。全階のクラス指定（"IFCSPACE" など）が効いている行を外すときは、
 * ほかの階の分を階ごとの指定に置き換えてから、その行だけ外す。
 */
export function setState(keys: Set<string>, tree: StoreyNode[], on: boolean, storey: string, cls?: string) {
  if (cls === undefined) {
    if (on) keys.add(storeyKeyOf(storey));
    else keys.delete(storeyKeyOf(storey));
    return;
  }
  if (keys.has(cls)) {
    keys.delete(cls);
    for (const s of tree) if (s.classes.some((c) => c.name === cls)) keys.add(classKeyOf(s.key, cls));
  }
  if (on) keys.add(classKeyOf(storey, cls));
  else keys.delete(classKeyOf(storey, cls));
}
