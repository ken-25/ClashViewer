import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { fetchBytes, fetchJson, host, on, writeFile, type LocalFile } from "../host";
import {
  fileRel,
  formatBytes,
  mapConversionMatrix,
  safeKey,
  type Alignment,
  type FailedElement,
  type Manifest,
  type ModelEntry,
  type PointcloudEntry,
  MANIFEST_SCHEMA,
} from "../data/dataset";
import {
  attributeSignature,
  diffElements,
  diffPointcloud,
  provenance,
  SIGNATURE_VERSION,
  type DatasetDiff,
  type ElementIndex,
} from "../data/diff";
import type { IfcInventory, IfcWorkerMessage } from "./ifc.worker";
import IfcWorker from "./ifc.worker?worker";

export interface ImportPlan {
  name: string;
  base: Manifest | null; // 前の版（新しいプロジェクトなら null）
  files: LocalFile[];
  keys: Record<string, string>; // token → モデル名
  keepPointcloud: boolean;
  keepModels: string[]; // 前の版から引き継ぐモデル名
  comment: string;
}

export interface TaskState {
  label: string;
  weight: number;
  fraction: number;
  status: "waiting" | "running" | "done" | "error";
  message: string;
}

export interface ImportState {
  tasks: TaskState[];
  overall: number;
  elapsed: number;
  remaining: number | null;
  done: boolean;
  error: string | null;
}

const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const MAX_FAILED_LISTED = 500;

export class ImportJob {
  readonly state: ImportState;
  private listeners = new Set<(s: ImportState) => void>();
  private aborted = false;
  private importId: string | null = null;
  private worker: Worker | null = null;
  private readonly t0 = performance.now();
  private readonly log: { level: string; message: string }[] = [];

  constructor(readonly plan: ImportPlan) {
    const e57 = plan.files.filter((f) => f.kind === "e57");
    const ifc = plan.files.filter((f) => f.kind === "ifc");
    const tasks: TaskState[] = [];
    if (e57.length)
      tasks.push(task(`点群 ${e57.map((f) => f.name).join("、")}`, e57.reduce((s, f) => s + f.size, 0)));
    for (const f of ifc) tasks.push(task(`IFC ${f.name}`, f.size * 15));
    const carry = carryList(plan);
    if (carry.files.length) tasks.push(task(`前の版（第${plan.base!.version}版）から複製`, carry.bytes * 0.3));
    tasks.push(task("差分と公開", 1e6));
    this.state = { tasks, overall: 0, elapsed: 0, remaining: null, done: false, error: null };
  }

  onChange(cb: (s: ImportState) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    const total = this.state.tasks.reduce((s, t) => s + t.weight, 0);
    const done = this.state.tasks.reduce((s, t) => s + t.weight * t.fraction, 0);
    this.state.overall = total > 0 ? done / total : 0;
    this.state.elapsed = (performance.now() - this.t0) / 1000;
    this.state.remaining =
      this.state.overall > 0.03 ? (this.state.elapsed * (1 - this.state.overall)) / this.state.overall : null;
    this.listeners.forEach((cb) => cb(this.state));
  }

  abort() {
    this.aborted = true;
    this.worker?.terminate();
    if (this.importId) void host.importAbort(this.importId);
  }

  private check() {
    if (this.aborted) throw new Error("中断しました");
  }

  async run(): Promise<Manifest> {
    const { plan } = this;
    let ti = 0;
    try {
      const begin = await host.importBegin(plan.name);
      this.importId = begin.id;
      const stagingDir = `datasets/.importing/${begin.id}`;

      // 点群
      let pointcloud: PointcloudEntry | null = plan.keepPointcloud ? plan.base?.pointcloud ?? null : null;
      const e57 = plan.files.filter((f) => f.kind === "e57");
      if (e57.length) {
        const t = this.state.tasks[ti++];
        pointcloud = await this.runPointcloud(t, begin.id, begin.folder, e57);
      }
      this.check();

      // IFC
      const models: ModelEntry[] = [];
      const indexes = new Map<string, ElementIndex>();
      const ifc = plan.files.filter((f) => f.kind === "ifc");
      for (const f of ifc) {
        const t = this.state.tasks[ti++];
        const key = plan.keys[f.token] ?? safeKey(f.name);
        const { entry, index } = await this.runIfc(t, f, key, begin.folder, stagingDir);
        models.push(entry);
        indexes.set(key, index);
        this.check();
      }
      // 前の版から引き継ぐ点群・モデル（同じ名前の新しいファイルがあればそちらで置き換える）。
      // ファイルはこの版のフォルダへ複製し、版どうしで共有しない（古い版を消しても壊れないように）
      const carry = carryList(plan);
      if (carry.files.length) {
        const t = this.state.tasks[ti++];
        await this.runCarry(t, begin.id, carry.files);
        this.check();
        if (pointcloud && carry.pointcloud) pointcloud = { ...pointcloud, owner: begin.folder, carriedFrom: plan.base!.folder };
        for (const m of carry.models) models.push({ ...m, owner: begin.folder, carriedFrom: plan.base!.folder });
      }

      // 差分・原点・座標合わせ
      const t = this.state.tasks[ti++];
      t.status = "running";
      t.message = "原点と座標合わせを決めています";
      this.emit();
      // 取込の間に他の人（や自分）が同じプロジェクトの版を足したり、座標合わせを保存したりしていることがある。
      // 確認画面を出した時点の情報ではなく、公開直前の一覧から版番号と座標合わせを決める（同じ版番号が 2 つできないように）
      const fresh = plan.base ? ((await host.listDatasets()) as Manifest[]).filter((d) => d.site === plan.base!.site) : [];
      const freshBase = fresh.find((d) => d.folder === plan.base?.folder) ?? plan.base;
      const maxVersion = Math.max(plan.base?.version ?? 0, ...fresh.map((d) => d.version));
      if (plan.base && maxVersion > plan.base.version)
        this.log.push({ level: "warn", message: `取込中に第${maxVersion}版が追加されていたため、第${maxVersion + 1}版として登録しました（差分は第${plan.base.version}版との比較です）` });
      const origin = plan.base?.origin ?? computeOrigin(pointcloud, models);
      const alignment = freshBase?.alignment ?? autoAlignment(pointcloud, models, this.log);
      let diffSummary: Manifest["diff"] = null;
      const draft: Manifest = {
        schema: MANIFEST_SCHEMA,
        id: begin.id,
        folder: begin.folder,
        name: plan.name,
        site: plan.base?.site ?? begin.id,
        version: maxVersion + 1,
        previous: plan.base?.folder ?? null,
        state: "importing",
        createdBy: "",
        createdAt: new Date().toISOString(),
        origin,
        pointcloud,
        models,
        alignment,
        diff: null,
        importLog: this.log,
        comment: plan.comment,
        // 派生成果物は版ごと（前の版の結果は引き継がない。入力が変わるので作り直す）
        derived: [],
        parent: null,
      };
      if (plan.base) {
        t.message = "前の版との差分を計算しています";
        this.emit();
        const baseIdx = new Map<string, ElementIndex>();
        for (const m of plan.base.models) baseIdx.set(m.key, await loadIndex(m));
        // 引き継いだモデルは公開前なので、複製元（前の版）のファイルから読む
        for (const m of models) if (!indexes.has(m.key)) indexes.set(m.key, await loadIndex(plan.base.models.find((b) => b.key === m.key) ?? m));
        const diff: DatasetDiff = {
          version: 1,
          against: plan.base.folder,
          createdAt: new Date().toISOString(),
          models: diffElements(baseIdx, indexes),
          pointcloud: diffPointcloud(plan.base.pointcloud, pointcloud),
          provenance: { base: provenance(plan.base), current: provenance(draft) },
        };
        await writeFile(`${stagingDir}/diff.json`, JSON.stringify(diff));
        diffSummary = {
          against: plan.base.folder,
          added: diff.models.added.length,
          removed: diff.models.removed.length,
          changed: diff.models.changed.length,
          pointcloudChanged: diff.pointcloud.changed,
        };
        draft.diff = diffSummary;
      }
      this.check();
      t.message = "公開しています";
      this.emit();
      const finalManifest = (await host.importFinish(begin.id, draft)) as Manifest;
      t.fraction = 1;
      t.status = "done";
      this.state.done = true;
      this.emit();
      return finalManifest;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.state.error = msg;
      const cur = this.state.tasks.find((t) => t.status === "running");
      if (cur) {
        cur.status = "error";
        cur.message = msg;
      }
      this.emit();
      if (this.importId && !this.aborted) void host.importAbort(this.importId);
      throw e;
    }
  }

  private async runPointcloud(t: TaskState, id: string, folder: string, files: LocalFile[]): Promise<PointcloudEntry> {
    t.status = "running";
    this.emit();
    const stages = new Map<string, { weight: number; frac: number; label: string }>();
    const off = on("import.progress", (d: any) => {
      if (d.importId !== id) return;
      if (d.event === "stage") {
        stages.set(d.stage, { weight: d.weight || 0.02, frac: 0, label: d.label });
        t.message = d.label;
      } else if (d.event === "progress") {
        const s = stages.get(d.stage);
        if (s) {
          s.frac = d.total > 0 ? Math.min(1, d.done / d.total) : 0;
          t.message = `${s.label} ${(s.frac * 100).toFixed(0)}%${d.message ? `（${d.message}）` : ""}`;
        }
      } else if (d.event === "log") {
        if (d.level !== "info") this.log.push({ level: d.level, message: d.message });
      }
      const tw = [...stages.values()].reduce((s, x) => s + x.weight, 0) || 1;
      // 変換エンジンの段階の重みの合計は 1。写す段階の分を少し残す
      t.fraction = Math.min(0.99, [...stages.values()].reduce((s, x) => s + x.weight * x.frac, 0) / Math.max(1, tw));
      this.emit();
    });
    try {
      const r = await host.importPointcloud(
        id,
        files.map((f) => f.token),
      );
      t.fraction = 1;
      t.status = "done";
      t.message = `${r.points.toLocaleString()} 点・${r.scanCount} スキャン${r.imageCount ? `・画像 ${r.imageCount} 枚` : ""}`;
      this.emit();
      return {
        owner: folder,
        dir: "pointcloud",
        sources: r.sources,
        points: r.points,
        scanCount: r.scanCount,
        bounds: r.bounds,
        outputSizes: r.outputSizes,
        timings: r.timings,
        imageCount: r.imageCount ?? 0,
      };
    } finally {
      off();
    }
  }

  private async runCarry(t: TaskState, id: string, files: { folder: string; rel: string }[]) {
    t.status = "running";
    t.message = "複製を開始";
    this.emit();
    const off = on("import.progress", (d: any) => {
      if (d.importId !== id || d.task !== "carry" || d.event !== "progress") return;
      t.fraction = d.total > 0 ? Math.min(0.99, d.done / d.total) : 0;
      t.message = `${formatBytes(d.done)} / ${formatBytes(d.total)}${d.message ? `（${d.message}）` : ""}`;
      this.emit();
    });
    try {
      const r = await host.importCarry(id, files, "carry");
      t.fraction = 1;
      t.status = "done";
      t.message = `${r.files} ファイル・${formatBytes(r.bytes)}`;
      this.emit();
    } finally {
      off();
    }
  }

  private convertIfc(f: LocalFile, t: TaskState): Promise<{ frag: Uint8Array; inventory: IfcInventory; seconds: number }> {
    return new Promise((resolve, reject) => {
      const w = new IfcWorker();
      this.worker = w;
      const weights: Record<string, [number, number]> = { read: [0, 0.05], inventory: [0.05, 0.15], convert: [0.15, 0.85] };
      w.onmessage = (e: MessageEvent<IfcWorkerMessage>) => {
        const m = e.data;
        if (m.type === "progress") {
          const [a, b] = weights[m.stage] ?? [0, 0];
          t.fraction = a + (b - a) * (m.total ? m.done / m.total : 0);
          if (m.message) t.message = m.message;
          this.emit();
        } else if (m.type === "done") {
          w.terminate();
          this.worker = null;
          resolve(m);
        } else {
          w.terminate();
          this.worker = null;
          reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        w.terminate();
        this.worker = null;
        // メッセージの無いエラーはワーカーの読込失敗・メモリ不足のことが多い
        reject(new Error(e.message || "IFC の変換に失敗しました（変換処理が異常終了しました。メモリ不足の可能性があります）"));
      };
      w.postMessage({ url: f.url, name: f.name });
    });
  }

  private async runIfc(
    t: TaskState,
    f: LocalFile,
    key: string,
    folder: string,
    stagingDir: string,
  ): Promise<{ entry: ModelEntry; index: ElementIndex }> {
    t.status = "running";
    t.message = "変換を開始";
    this.emit();
    let conv: Awaited<ReturnType<ImportJob["convertIfc"]>>;
    try {
      conv = await this.convertIfc(f, t);
    } catch (e) {
      // ワーカーの異常終了は 1 回だけやり直す
      this.check();
      if (!String(e).includes("異常終了")) throw e;
      this.log.push({ level: "warn", message: `${f.name}: 変換処理が異常終了したため、やり直しました` });
      t.message = "やり直しています";
      this.emit();
      conv = await this.convertIfc(f, t);
    }
    const { frag, inventory, seconds } = conv;
    this.check();
    t.message = "要素の一覧と外形を作成中";
    t.fraction = 0.86;
    this.emit();
    const fragRel = `model/${key}.frag`;
    await writeFile(`${stagingDir}/${fragRel}`, frag);
    const { index, categories, ifcBox } = await buildElementIndex(frag, inventory.products);
    this.check();
    const elementsRel = `model/${key}.elements.json`;
    await writeFile(`${stagingDir}/${elementsRel}`, JSON.stringify(index));

    // 取込率は「形状表現を持つ表示対象の要素」のうち形状が入ったものの割合（敷地などの対象外クラスは数えない）
    const withShape = new Set(Object.entries(index.items).filter(([, r]) => r.b).map(([g]) => g));
    const failed: FailedElement[] = inventory.products.filter((p) => !withShape.has(p.guid));
    const got = new Set(inventory.products.filter((p) => withShape.has(p.guid)).map((p) => p.guid));
    if (failed.length)
      this.log.push({ level: "warn", message: `${f.name}: 形状を作れなかった要素 ${failed.length} 件（全 ${inventory.products.length} 件中）` });
    const sha = await sha256Of(f);
    t.fraction = 1;
    t.status = "done";
    t.message = `${got.size.toLocaleString()} 要素${failed.length ? `（形状なし ${failed.length} 件）` : ""}・${seconds.toFixed(1)} 秒`;
    this.emit();
    return {
      index,
      entry: {
        key,
        owner: folder,
        file: fragRel,
        elements: elementsRel,
        source: { name: f.name, size: f.size, sha256: sha },
        schema: inventory.schema,
        application: inventory.application,
        unitScale: inventory.unitScale,
        expectedCount: inventory.products.length,
        geometryCount: got.size,
        failedCount: failed.length,
        failed: failed.slice(0, MAX_FAILED_LISTED),
        categories,
        mapConversion: inventory.mapConversion,
        ifcBox,
        seconds,
      },
    };
  }
}

/**
 * 前の版の要素一覧を読む。属性署名の版が古ければ、その版の Fragments から作り直す
 * （共有フォルダの既存データセットは書き換えない。作り直した結果は差分の計算にだけ使う）
 */
async function loadIndex(m: ModelEntry): Promise<ElementIndex> {
  const idx = await fetchJson<ElementIndex>(fileRel(m.owner, m.elements));
  if (idx.sig === SIGNATURE_VERSION) return idx;
  const frag = new Uint8Array(await fetchBytes(fileRel(m.owner, m.file)));
  const products = Object.entries(idx.items).map(([guid, r]) => ({ guid, cls: r.c, name: r.n }));
  return (await buildElementIndex(frag, products)).index;
}

/** 前の版から複製するファイルの一覧（元のフォルダと相対パス）と、引き継ぐ点群・モデル */
export function carryList(plan: ImportPlan): {
  files: { folder: string; rel: string }[];
  bytes: number;
  pointcloud: boolean;
  models: ModelEntry[];
} {
  const files: { folder: string; rel: string }[] = [];
  let bytes = 0;
  const base = plan.base;
  if (!base) return { files, bytes, pointcloud: false, models: [] };
  const hasE57 = plan.files.some((f) => f.kind === "e57");
  const pc = plan.keepPointcloud && !hasE57 ? base.pointcloud : null;
  if (pc) {
    for (const n of ["metadata.json", "hierarchy.bin", "octree.bin"]) files.push({ folder: pc.owner, rel: `${pc.dir}/${n}` });
    bytes += Object.values(pc.outputSizes ?? {}).reduce((a, b) => a + b, 0) || pc.points * 27;
    // 撮影ポイントの画像も引き継ぐ（sources をそのまま使うので、同じ相対パスへ複製する）
    for (const src of pc.sources)
      for (const img of src.images ?? [])
        if (img?.file) {
          files.push({ folder: pc.owner, rel: img.file });
          bytes += img.bytes ?? 0;
        }
  }
  const newKeys = new Set(plan.files.filter((f) => f.kind === "ifc").map((f) => plan.keys[f.token] ?? safeKey(f.name)));
  const models = base.models.filter((m) => plan.keepModels.includes(m.key) && !newKeys.has(m.key));
  for (const m of models) {
    files.push({ folder: m.owner, rel: m.file }, { folder: m.owner, rel: m.elements });
    bytes += m.source.size / 4; // .frag は元の IFC のおおむね 1/4〜1/10
  }
  return { files, bytes, pointcloud: !!pc, models };
}

function task(label: string, weight: number): TaskState {
  return { label, weight: Math.max(1, weight), fraction: 0, status: "waiting", message: "待機中" };
}

async function sha256Of(f: LocalFile): Promise<string> {
  const buf = await (await fetch(f.url)).arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let staging: FRAGS.FragmentsModels | null = null;

/** Fragments を一時的に読んで、要素ごとの GlobalId・外形（IFC 座標）・属性ハッシュを作る */
export async function buildElementIndex(
  frag: Uint8Array,
  products: { guid: string; cls: string; name: string }[] = [],
): Promise<{ index: ElementIndex; categories: Record<string, number>; ifcBox: { min: number[]; max: number[] } | null }> {
  staging ??= new FRAGS.FragmentsModels("./fragments/worker.mjs");
  staging.settings.autoCoordinate = false;
  const modelId = `staging-${Math.random().toString(36).slice(2)}`;
  const model = await staging.load(frag, { modelId });
  try {
    const coord = await model.getCoordinationMatrix();
    const fragToIfc = Y_UP_TO_Z_UP.clone().multiply(coord.clone().invert());
    model.object.matrixAutoUpdate = false;
    model.object.matrix.copy(fragToIfc);
    model.object.updateMatrixWorld(true);
    const ids = await model.getItemsIdsWithGeometry();
    const guids = await model.getGuidsByLocalIds(ids);
    const boxes = await model.getBoxes(ids);
    const items: ElementIndex["items"] = {};
    const categories: Record<string, number> = {};
    const all = new THREE.Box3();
    const chunk = 2000;
    for (let s = 0; s < ids.length; s += chunk) {
      const part = ids.slice(s, s + chunk);
      const data = await model.getItemsData(part, {
        attributesDefault: true,
        relations: {
          IsDefinedBy: { attributes: true, relations: true },
          // Pset から要素へ戻る関係は辿らない（循環して巨大になる）
          DefinesOcurrence: { attributes: false, relations: false },
          IsTypedBy: { attributes: true, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < part.length; i++) {
        const g = guids[s + i];
        if (!g) continue;
        const d = data[i] as Record<string, any>;
        const c = String(d?._category?.value ?? "");
        const n = String(d?.Name?.value ?? "");
        const b = boxes[s + i];
        if (b && !b.isEmpty()) all.union(b);
        items[g] = {
          c,
          n,
          b: b && !b.isEmpty()
            ? ([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 1000)) as ElementIndex["items"][string]["b"])
            : null,
          h: attributeSignature(d ?? {}),
        };
        categories[c] = (categories[c] ?? 0) + 1;
      }
    }
    // 形状を作れなかった要素も差分の対象にする（追加・削除を見落とさない）
    for (const p of products) {
      if (items[p.guid]) continue;
      items[p.guid] = { c: p.cls, n: p.name, b: null, h: "" };
    }
    return {
      index: { version: 1, sig: SIGNATURE_VERSION, items },
      categories,
      ifcBox: all.isEmpty() ? null : { min: all.min.toArray(), max: all.max.toArray() },
    };
  } finally {
    await staging.disposeModel(modelId);
  }
}

/** 共通の原点オフセット。点群があれば点群の中心、無ければモデルの中心を 10 m 単位で丸める */
export function computeOrigin(pc: PointcloudEntry | null, models: ModelEntry[]): [number, number, number] {
  const round = (v: number) => Math.round(v / 10) * 10;
  if (pc) {
    const c = [0, 1, 2].map((i) => (pc.bounds.min[i] + pc.bounds.max[i]) / 2);
    return [round(c[0]), round(c[1]), round(c[2])];
  }
  const b = new THREE.Box3();
  for (const m of models) if (m.ifcBox) b.union(new THREE.Box3().setFromArray([...m.ifcBox.min, ...m.ifcBox.max]));
  if (b.isEmpty()) return [0, 0, 0];
  const c = b.getCenter(new THREE.Vector3());
  return [round(c.x), round(c.y), round(c.z)];
}

/**
 * 自動の座標合わせ。基本は「両方の座標をそのまま使う」。
 * IFC に IfcMapConversion があり、それを掛けた方が点群に近ければ掛ける。
 */
export function autoAlignment(pc: PointcloudEntry | null, models: ModelEntry[], log: { level: string; message: string }[]): Alignment {
  const identity: Alignment = { method: "identity", matrix: new THREE.Matrix4().toArray() };
  const withMc = models.find((m) => m.mapConversion && m.ifcBox);
  if (pc && !withMc) {
    const mb = new THREE.Box3();
    for (const m of models) if (m.ifcBox) mb.union(new THREE.Box3().setFromArray([...m.ifcBox.min, ...m.ifcBox.max]));
    if (!mb.isEmpty()) {
      const pb = new THREE.Box3().setFromArray([...pc.bounds.min, ...pc.bounds.max]);
      if (!mb.intersectsBox(pb)) {
        const d = mb.getCenter(new THREE.Vector3()).distanceTo(pb.getCenter(new THREE.Vector3()));
        log.push({ level: "warn", message: `点群とモデルが重なっていません（中心どうし ${d.toFixed(0)} m）。「3点合わせ」で合わせてください` });
      }
    }
  }
  if (!pc || !withMc || !withMc.ifcBox) return identity;
  const { matrix, note } = mapConversionMatrix(withMc.mapConversion!, withMc.unitScale);
  const box = new THREE.Box3().setFromArray([...withMc.ifcBox.min, ...withMc.ifcBox.max]);
  const c = box.getCenter(new THREE.Vector3());
  const pcc = new THREE.Vector3(
    (pc.bounds.min[0] + pc.bounds.max[0]) / 2,
    (pc.bounds.min[1] + pc.bounds.max[1]) / 2,
    (pc.bounds.min[2] + pc.bounds.max[2]) / 2,
  );
  const dRaw = c.distanceTo(pcc);
  const dMap = c.clone().applyMatrix4(matrix).distanceTo(pcc);
  if (dMap < dRaw) {
    if (note) log.push({ level: "warn", message: note });
    log.push({ level: "info", message: `IfcMapConversion（${withMc.key}）を掛けて点群に合わせました` });
    return { method: "mapConversion", matrix: matrix.toArray(), note: note ?? undefined };
  }
  if (dRaw > 200) log.push({ level: "warn", message: `点群とモデルが ${dRaw.toFixed(0)} m 離れています。3点合わせで合わせてください` });
  return identity;
}
