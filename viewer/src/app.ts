import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { fetchBytes, host, onJobProgress, type HostContext, type JobProgress } from "./host";
import { DEFAULT_TOOL, getTool, type ToolId } from "./tools/toolRegistry";
import { fileRel, groupBySite, ifcToScene, migrateManifests, sceneToWorld, worldToScene, type Manifest } from "./data/dataset";
import { AlignMode } from "./features/alignMode";
import { DiffView } from "./features/diffView";
import type { AppFeature } from "./features/feature";
import { IssueStore } from "./features/issueStore";
import { MeasureMode, sourceName } from "./features/measureMode";
import { SectionMode } from "./features/sectionMode";
import { UcsMode } from "./features/ucsMode";
import { ModelManager, type LoadedModel } from "./model/models";
import { ColorMode } from "./pointcloud/material";
import { PotreePointCloud } from "./pointcloud/potree";
import { candidateToPick, Picker, type Pick } from "./scene/picker";
import { SNAP_LABEL } from "./scene/snap";
import { Viewer3D } from "./scene/viewer3d";
import { ClipBoxEditor } from "./tools/clipBoxEdit";
import { Clipping } from "./tools/clipping";
import { LocalFrame, MeasureTool } from "./tools/measure";
import { SnapCursor } from "./tools/snapCursor";
import { $ } from "./ui/dom";

/** ツールの ID。定義は tools/toolRegistry.ts に登録する（標準のツールは modes/builtinTools.ts） */
export type Tool = ToolId;

/**
 * App が出す通知の名前。購読は app.on(名前, cb)。足すときはここに追記する（打ち間違いを型で止める）。
 * jobs: 処理（ジョブ）の進捗・完了（app.jobs が変わった）
 * projection: 平行投影・透視が切り替わった
 */
export type AppTopic =
  | "datasets"
  | "dataset"
  | "display"
  | "nav"
  | "diff"
  | "selection"
  | "measures"
  | "clip"
  | "align"
  | "tool"
  | "pcstats"
  | "issues"
  | "issue:new"
  | "issue:open"
  | "jobs"
  | "projection";

/** 実行中・直近に終わった処理（ジョブ）の状態 */
export interface JobState {
  jobId: string;
  kind: string;
  folder: string;
  status: "running" | "done" | "failed" | "aborted";
  /** 最後の段階・進捗（stage / progress の通知） */
  last: JobProgress | null;
  message?: string;
}

/** 位置の目印（画面端の矢印・小地図）に出すもの。box はシーン座標（原点は大きさ 0 の箱） */
export interface NavTarget {
  id: string;
  kind: "cloud" | "model" | "frameOrigin" | "worldOrigin";
  label: string;
  box: THREE.Box3;
}

export interface NavSettings {
  /** 画面外（または遠くて小さい）点群・モデルの方向を画面の端に出す */
  markers: boolean;
  /** 原点（世界座標の 0,0,0・原点設定の原点）も目印に入れる */
  origins: boolean;
  /** 平面の小地図 */
  minimap: boolean;
}

const SELECT_COLOR = new THREE.Color(0x3399ff);

function loadNavSettings(): NavSettings {
  const def: NavSettings = { markers: true, origins: true, minimap: true };
  try {
    const s = JSON.parse(localStorage.getItem("nav") ?? "{}");
    for (const k of Object.keys(def) as (keyof NavSettings)[]) if (typeof s?.[k] === "boolean") def[k] = s[k];
  } catch {
    // 壊れていたら既定値
  }
  return def;
}

/**
 * 画面全体の状態と操作。各パネルはこれを参照して描く。
 * App が持つのは共通の土台（版・点群・モデル・視点・切断・ツールの切替・選択・処理）だけ。
 * 各機能の状態と操作は features/ のモジュールに置き、下の measureMode〜diff から使う。
 */
export class App {
  ctx!: HostContext;
  readonly viewer: Viewer3D;
  readonly models: ModelManager;
  readonly picker: Picker;
  readonly clipping: Clipping;
  readonly clipEditor: ClipBoxEditor;
  readonly frame: LocalFrame;
  readonly measure: MeasureTool;
  readonly snap: SnapCursor;
  datasets: Manifest[] = [];
  current: Manifest | null = null;
  pc: PotreePointCloud | null = null;
  tool: Tool = DEFAULT_TOOL;
  selection: { lm: LoadedModel; localId: number; data: any } | null = null;
  lastPick: Pick | null = null;
  pointBudget = 3_000_000;
  nav: NavSettings = loadNavSettings();
  private listeners = new Map<AppTopic, Set<() => void>>();
  /** 処理（ジョブ）の状態。jobId → 状態。終わったものも画面を閉じるまで残す */
  readonly jobs = new Map<string, JobState>();

  // ---- 機能（状態と操作はそれぞれのモジュール） ----
  /** 計測の操作（軸の固定・吸着・点の追加）。結果は measure */
  readonly measureMode: MeasureMode;
  /** UCS の設定手順と保存。座標系は frame */
  readonly ucs: UcsMode;
  /** 切断メニューの操作と、面に合わせた断面ツール */
  readonly section: SectionMode;
  /** 3点合わせ */
  readonly align: AlignMode;
  /** 指摘（イベントの読み書きとピン） */
  readonly issues: IssueStore;
  /** 前の版との差分 */
  readonly diff: DiffView;
  /** 版を開く・閉じるときに呼ぶ機能（登録順） */
  private readonly features: AppFeature[];

  constructor() {
    this.viewer = new Viewer3D($("#view"));
    this.models = new ModelManager(this.viewer);
    this.picker = new Picker(this.viewer, this.models);
    // ホイールはカーソル下の物体（点群・モデル。切断で隠れた物は除く）へ寄る
    // 回転もその物体を中心にする（何も無ければ画面の中心）
    this.viewer.pickPoint = async (x, y) => (await this.picker.pick(x, y))?.point ?? null;
    this.clipping = new Clipping(this.viewer);
    this.clipEditor = new ClipBoxEditor(this.viewer, this.clipping);
    this.frame = new LocalFrame(this.viewer);
    this.measure = new MeasureTool(this.viewer, this.frame);
    this.measure.onChange = () => this.emit("measures");
    this.picker.axes = () => this.frame.axes();
    this.snap = new SnapCursor(this.viewer, this.picker);

    this.measureMode = new MeasureMode(this);
    this.ucs = new UcsMode(this);
    this.section = new SectionMode(this);
    this.align = new AlignMode(this);
    this.issues = new IssueStore(this);
    this.diff = new DiffView(this);
    this.features = [this.measureMode, this.ucs, this.section, this.align, this.issues, this.diff];

    this.snap.options = () => this.snapOptions();
    this.snap.augment = (list, x, y) => this.measureMode.addAxisCandidate(list, x, y);
    this.snap.onChange = (c) => {
      if (this.tool === "measure") this.measure.setPreview(c?.point ?? null, c ? this.measureMode.segmentAxis(c.point) : this.measureMode.axisLock);
      if (c) this.showCoord(candidateToPick(c));
    };
    this.viewer.controls.addEventListener("change", () => this.snap.cameraMoved());
    this.viewer.controls.addEventListener("end", () => this.snap.refresh());
    this.clipping.onChange = () => {
      if (this.pc) this.pc.clipBox = this.clipping.boxOn ? this.clipping.box : null;
      this.pc?.invalidate();
      void this.models.update(true);
      this.clipEditor.refresh();
      this.emit("clip");
    };
    this.viewer.onProjectionChange((p) => {
      localStorage.setItem("projection", p);
      this.emit("projection");
    });
    this.viewer.onBeforeRender(() => {
      if (!this.pc) return;
      this.pc.update(this.viewer.camera, this.viewer.size.height * this.viewer.renderer.getPixelRatio());
      if (this.pc.isLoading) this.viewer.requestRender();
    });
    const saved = Number(localStorage.getItem("pointBudget"));
    if (saved > 0) this.pointBudget = saved;
    if (localStorage.getItem("projection") === "orthographic") this.viewer.setProjection("orthographic");
  }

  /** 通知を購読する。戻り値で購読をやめる */
  on(topic: AppTopic, cb: () => void): () => void {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic)!.add(cb);
    return () => this.listeners.get(topic)?.delete(cb);
  }

  emit(topic: AppTopic) {
    this.listeners.get(topic)?.forEach((cb) => cb());
  }

  // ---- 処理（ジョブ） ----

  /** 公開済みの版に対する処理を始める。進捗は "jobs" の通知と app.jobs で追う */
  async startJob(kind: string, folder: string, params: Record<string, unknown> = {}): Promise<string> {
    const r = await host.jobStart(kind, folder, params);
    this.jobs.set(r.jobId, { jobId: r.jobId, kind: r.kind, folder: r.folder, status: "running", last: null });
    this.emit("jobs");
    return r.jobId;
  }

  async abortJob(jobId: string): Promise<void> {
    await host.jobAbort(jobId);
  }

  /** ホストの job.progress を状態に畳む。完了したら一覧と開いている版の manifest を読み直す */
  private async onJobProgress(p: JobProgress) {
    const cur = this.jobs.get(p.jobId) ?? { jobId: p.jobId, kind: p.kind, folder: p.folder, status: "running" as const, last: null };
    if (p.event === "stage" || p.event === "progress") cur.last = p;
    else if (p.event === "log") return;
    else if (p.event === "error") cur.message = p.message;
    else if (p.event === "failed") Object.assign(cur, { status: "failed", message: p.message });
    else if (p.event === "aborted") cur.status = "aborted";
    else if (p.event === "done") {
      // 一覧を読み直してから done にする（done を見た側が古い一覧を読まないように）
      await this.refreshDatasets();
      cur.status = "done";
      // 開いている版なら derived を差し替える（版の本体は変わらないので開き直さない）
      const fresh = this.datasets.find((d) => d.folder === p.folder);
      if (this.current && fresh && this.current.folder === p.folder) this.current.derived = fresh.derived;
    }
    this.jobs.set(p.jobId, cur);
    this.emit("jobs");
  }

  /** 起動時: 実行中の処理を拾い、以降の通知を受ける */
  async attachJobs() {
    onJobProgress((p) => void this.onJobProgress(p).catch((e) => console.warn(e)));
    for (const j of await host.jobList()) {
      this.jobs.set(j.jobId, { jobId: j.jobId, kind: j.kind, folder: j.folder, status: "running", last: j.last });
    }
    if (this.jobs.size) this.emit("jobs");
  }

  setHint(msg: string) {
    $("#hint").textContent = msg;
  }

  /** 読み込み中の表示があるか（中央の「プロジェクトを開いてください」と重ねないために使う） */
  isLoadingView = false;

  setLoading(msg: string | null) {
    const el = $("#loading");
    el.textContent = msg ?? "";
    el.classList.toggle("hidden", !msg);
    this.isLoadingView = !!msg;
    // 読み込み中は入口カードを隠す。終わったらプロジェクトの有無に合わせて戻す
    if (msg) $("#empty-view").classList.add("hidden");
    else $("#empty-view").classList.toggle("hidden", !!this.current);
  }

  // ---- データセット ----

  async refreshDatasets() {
    const { ok, skipped } = migrateManifests(await host.listDatasets());
    for (const s of skipped) console.warn(`版 ${s.folder} を読めません: ${s.reason}`);
    this.datasets = ok;
    this.emit("datasets");
  }

  get sites() {
    return groupBySite(this.datasets);
  }

  versionsOf(site: string): Manifest[] {
    return this.sites.get(site) ?? [];
  }

  memberName(id: string): string {
    return this.ctx.members.find((m) => m.id === id)?.name || id;
  }

  /** データセットを開いている途中なら、その完了を待つ Promise */
  opening: Promise<void> | null = null;

  async openDataset(m: Manifest) {
    const p = this.openDatasetInner(m);
    this.opening = p.catch(() => undefined);
    try {
      await p;
    } finally {
      this.opening = null;
    }
  }

  private async openDatasetInner(m: Manifest) {
    this.setLoading(`${m.name}（第${m.version}版）を開いています…`);
    try {
      await this.closeDataset();
      this.current = m;
      const origin = m.origin;
      $("#current-name").textContent = `${m.name} 第${m.version}版`;
      // モデルのファイルは点群の階層を読む間に先に取り始める（読込は従来どおり 1 つずつ）
      const buffers = m.models.map((entry) => fetchBytes(fileRel(entry.owner, entry.file)));
      // 点群の読込が失敗して使われなかった分の未処理の失敗通知を出さない
      for (const b of buffers) b.catch(() => undefined);
      if (m.pointcloud) {
        const pc = await PotreePointCloud.load(fileRel(m.pointcloud.owner, m.pointcloud.dir), origin, {
          pointBudget: this.pointBudget,
          maxLoadedPoints: Math.max(this.pointBudget * 2.5, 2_000_000),
        });
        pc.onChange = () => {
          this.viewer.requestRender();
          this.emit("pcstats");
        };
        this.pc = pc;
        this.picker.cloud = pc;
        this.viewer.content.add(pc.group);
      }
      const placement = ifcToScene(m);
      for (const [i, entry] of m.models.entries()) {
        this.setLoading(`モデル ${entry.key} を読込中…`);
        const buf = await buffers[i];
        const lm = await this.models.load(entry.key, m.folder, buf);
        this.models.setPlacement(lm, placement);
        if (lm.categories.includes("IFCSPACE")) {
          lm.hiddenKeys.add("IFCSPACE");
          await this.models.applyCategoryStates(lm);
        }
      }
      const extent = this.sceneBox();
      this.clipping.extent = extent.clone();
      this.clipping.box.copy(extent);
      this.viewer.fit(extent);
      // 離れて見えない側（モデル・点群）は、画面端の目印と小地図で場所を示す
      this.setHint("");
      for (const f of this.features) await f.onOpen?.(m);
      localStorage.setItem("lastDataset", m.folder);
      this.emit("dataset");
    } finally {
      this.setLoading(null);
      // 開けなかったとき、隠していた「プロジェクトを開いてください」を戻す
      if (!this.current) this.emit("dataset");
    }
  }

  async closeDataset() {
    for (const f of this.features) f.onClose?.();
    this.selection = null;
    if (this.pc) {
      this.viewer.content.remove(this.pc.group);
      this.pc.dispose();
      this.pc = null;
      this.picker.cloud = null;
    }
    await this.models.unloadAll();
    this.clipping.reset();
    this.current = null;
    $("#current-name").textContent = "プロジェクトを選んでください";
    this.viewer.requestRender();
  }

  /**
   * 開いた直後の視点・切断の基準にする範囲。
   * 点群とモデルが遠く離れている（km 単位）と、両方を入れると点にしか見えないので、
   * そのときは点群の範囲だけを使う（もう片方は目印・小地図から移動できる）。
   */
  sceneBox(): THREE.Box3 {
    const b = new THREE.Box3();
    const pcBox = this.pc && this.pc.group.visible ? this.pc.boxDisplay : null;
    const modelBox = this.models.box();
    if (pcBox && !modelBox.isEmpty() && this.modelGap(pcBox, modelBox) !== null) b.copy(pcBox);
    else {
      if (pcBox) b.union(pcBox);
      b.union(modelBox);
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(-10, -10, -2), new THREE.Vector3(10, 10, 10));
    return b;
  }

  /**
   * 視点ボタン・切断の基準にする範囲。点群とモデルが遠く離れていれば、いま見ている側
   * （注視点に近い方）だけ。モデルへ移動した後に「上から」を押して点群へ戻されないように。
   */
  viewBox(): THREE.Box3 {
    const pcBox = this.pc && this.pc.group.visible ? this.pc.boxDisplay : null;
    const modelBox = this.models.box();
    if (pcBox && !modelBox.isEmpty() && this.modelGap(pcBox, modelBox) !== null) {
      const t = this.viewer.controls.target;
      return (pcBox.distanceToPoint(t) <= modelBox.distanceToPoint(t) ? pcBox : modelBox).clone();
    }
    return this.sceneBox();
  }

  /** 切断を始めるとき、いま見ている側の範囲を基準にする（離れた側の範囲のままだと全部消える） */
  prepareClipExtent() {
    const ext = this.viewBox();
    if (ext.equals(this.clipping.extent)) return;
    this.clipping.extent.copy(ext);
    this.clipping.box.copy(ext);
  }

  /** 位置の目印に出すもの（表示中の点群・モデルと原点） */
  navTargets(): NavTarget[] {
    const m = this.current;
    if (!m) return [];
    const list: NavTarget[] = [];
    if (this.pc && this.pc.group.visible && !this.pc.boxDisplay.isEmpty()) list.push({ id: "cloud", kind: "cloud", label: "点群", box: this.pc.boxDisplay });
    for (const lm of this.models.models.values()) {
      if (lm.role !== "current" || !lm.visible) continue;
      const box = this.models.boxOf(lm);
      if (!box.isEmpty()) list.push({ id: `model:${lm.key}`, kind: "model", label: lm.key, box });
    }
    if (this.nav.origins) {
      if (this.frame.isSet) list.push({ id: "frame", kind: "frameOrigin", label: "UCS 原点", box: new THREE.Box3(this.frame.origin.clone(), this.frame.origin.clone()) });
      const o = worldToScene(m, [0, 0, 0]);
      list.push({ id: "world", kind: "worldOrigin", label: "WCS 原点", box: new THREE.Box3(o, o.clone()) });
    }
    return list;
  }

  /** 範囲へ移動する（見る向きは今のまま）。原点のような点は周り 20 m ほどを映す */
  focusBox(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const b = box.clone();
    const size = b.getSize(new THREE.Vector3()).length();
    if (size < 20) b.expandByScalar((20 - size) / 2);
    const dir = this.viewer.camera.position.clone().sub(this.viewer.controls.target);
    this.viewer.fit(b, dir.lengthSq() > 1e-12 ? dir : undefined);
    // km 単位で飛ぶと、Fragments の表示更新（LOD・カリング）が 1 回では追いつかず、
    // 操作するまでモデルが出ないことがある。少し後にも更新し直す
    for (const ms of [300, 1000, 2500]) setTimeout(() => void this.models.update(true), ms);
  }

  setNav(patch: Partial<NavSettings>) {
    Object.assign(this.nav, patch);
    localStorage.setItem("nav", JSON.stringify(this.nav));
    this.viewer.requestRender();
    this.emit("nav");
  }

  /** 平行投影と透視を切り替える（P キー・3D 画面左上のボタン） */
  toggleProjection() {
    this.viewer.setProjection(this.viewer.projection === "orthographic" ? "perspective" : "orthographic");
  }

  /** 点群とモデルが「明らかに合っていない」ほど離れていれば、その距離（m）。近ければ null */
  modelGap(pcBox = this.pc?.boxDisplay, modelBox = this.models.box()): number | null {
    if (!pcBox || pcBox.isEmpty() || modelBox.isEmpty()) return null;
    const gap = pcBox.distanceToPoint(modelBox.getCenter(new THREE.Vector3()));
    const size = Math.max(pcBox.getSize(new THREE.Vector3()).length(), modelBox.getSize(new THREE.Vector3()).length());
    return gap > Math.max(200, size * 2) ? gap : null;
  }

  /** 座標合わせを適用し直す（3点合わせのプレビュー・保存後） */
  applyPlacement(matrix?: THREE.Matrix4) {
    if (!this.current) return;
    const o = this.current.origin;
    const place = matrix
      ? new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]).multiply(matrix)
      : ifcToScene(this.current);
    for (const lm of this.models.models.values()) if (lm.role === "current") this.models.setPlacement(lm, place);
  }

  // ---- 点群の見え方 ----

  setPointBudget(n: number) {
    this.pointBudget = n;
    localStorage.setItem("pointBudget", String(n));
    this.pc?.setBudget(n);
    this.viewer.requestRender();
  }

  setColorMode(m: ColorMode) {
    this.pc?.setColorMode(m);
    this.viewer.requestRender();
  }

  // ---- ツール ----

  /** ツールを切り替える。前のツールの onExit → 次のツールの onEnter（同じツールの選び直しも同じ） */
  setTool(t: Tool) {
    const next = getTool(t);
    getTool(this.tool).onExit?.(this);
    this.tool = t;
    next.onEnter?.(this);
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    // 計測・合わせ中は指摘のピンをクリックで反応させない（ピンの下の点を拾えるように）
    document.body.classList.toggle("tool-active", t !== DEFAULT_TOOL);
    this.updateToolHint();
    this.snap.refresh();
    this.emit("tool");
  }

  /** ツールの案内。今の手順で使うキーだけを出し、一覧は「?」にまとめる */
  updateToolHint() {
    this.setHint(getTool(this.tool).hint(this));
  }

  /** スナップの候補を探す対象（スナップを使わないツールは null） */
  private snapOptions(): { models: boolean; cloud: boolean } | null {
    if (!this.current) return null;
    return getTool(this.tool).snap?.(this) ?? null;
  }

  async handleClick(e: MouseEvent) {
    const def = getTool(this.tool);
    // 候補を探す間に Shift を離しても、クリックした瞬間の状態で決める
    const shift = e.shiftKey;
    if (def.preClick?.(this, e)) return;
    let p: Pick | null;
    let snapLabel: string | null = null;
    if (this.snap.active) {
      const c = await this.snap.resolve(e.clientX, e.clientY);
      p = c ? candidateToPick(c) : null;
      if (c && c.kind !== "free") snapLabel = SNAP_LABEL[c.kind];
    } else {
      p = await this.picker.pick(e.clientX, e.clientY);
    }
    this.lastPick = p;
    this.showCoord(p);
    await def.onClick?.(this, p, e, { snapLabel, shift });
  }

  showCoord(p: Pick | null) {
    const el = $("#st-coord");
    if (!p || !this.current) {
      el.textContent = "座標 —";
      return;
    }
    const w = sceneToWorld(this.current, p.point);
    const l = this.frame.toLocal(p.point);
    const f = (v: number) => v.toFixed(3);
    const snap = p.snap && p.snap in SNAP_LABEL && p.snap !== "free" && p.snap !== "axis" ? `（${SNAP_LABEL[p.snap as keyof typeof SNAP_LABEL]}）` : "";
    el.textContent = this.frame.isSet
      ? `${sourceName(p)}${snap}  UCS X ${f(l.x)} Y ${f(l.y)} Z ${f(l.z)}  ／ WCS ${w.map(f).join(", ")}`
      : `${sourceName(p)}${snap}  WCS ${w.map(f).join(", ")}`;
  }

  // ---- 選択 ----

  async select(p: Pick | null) {
    if (this.selection) {
      await this.selection.lm.model.resetHighlight([this.selection.localId]);
      await this.diff.applyColors(this.selection.lm);
    }
    this.selection = null;
    if (p?.model) {
      const { lm, localId } = p.model;
      await lm.model.highlight([localId], {
        color: SELECT_COLOR,
        renderedFaces: FRAGS.RenderedFaces.TWO,
        opacity: 1,
        transparent: false,
      });
      const [data] = await lm.model.getItemsData([localId], {
        attributesDefault: true,
        relations: {
          IsDefinedBy: { attributes: true, relations: true },
          // Pset から要素へ戻る関係は辿らない（循環して巨大になる）
          DefinesOcurrence: { attributes: false, relations: false },
          IsTypedBy: { attributes: true, relations: false },
          ContainedInStructure: { attributes: true, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      this.selection = { lm, localId, data };
    }
    await this.models.update(true);
    this.emit("selection");
  }

  /** 要素（GlobalId）へ寄って選ぶ */
  async zoomToGuid(guid: string, modelKey: string, folder?: string) {
    const lm = [...this.models.models.values()].find((x) => x.key === modelKey && (!folder || x.datasetFolder === folder));
    if (!lm) return;
    const [id] = await lm.model.getLocalIdsByGuids([guid]);
    if (id === null || id === undefined) return;
    const box = await lm.model.getMergedBox([id]);
    if (box.isEmpty()) return;
    box.expandByScalar(Math.max(1, box.getSize(new THREE.Vector3()).length()));
    this.viewer.fit(box);
    await this.select({ point: box.getCenter(new THREE.Vector3()), source: "model", distance: 0, model: { lm, localId: id } });
  }
}
