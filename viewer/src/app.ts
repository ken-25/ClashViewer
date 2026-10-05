import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { fetchBytes, fetchJson, host, type HostContext } from "./host";
import { fileRel, groupBySite, ifcToScene, sceneToWorld, worldToScene, type Manifest } from "./data/dataset";
import type { DatasetDiff } from "./data/diff";
import { foldIssues, type Issue, type IssueEvent, type IssueView } from "./issues/issues";
import { ModelManager, type LoadedModel } from "./model/models";
import { ColorMode } from "./pointcloud/material";
import { PotreePointCloud } from "./pointcloud/potree";
import { candidateToPick, Picker, type Pick } from "./scene/picker";
import { SNAP_LABEL, type SnapCandidate } from "./scene/snap";
import { Viewer3D } from "./scene/viewer3d";
import { ClipBoxEditor } from "./tools/clipBoxEdit";
import { Clipping } from "./tools/clipping";
import { LocalFrame, MeasureTool, type Axis, type MeasureKind } from "./tools/measure";
import { SnapCursor } from "./tools/snapCursor";
import { $ } from "./ui/dom";

export type Tool = "select" | "measure" | "origin" | "issue" | "align";

/** カーソルが軸の線からこの距離（px）以内なら、その軸に吸着する */
const AXIS_TRACK_PX = 10;

export interface AlignPick {
  model: THREE.Vector3[]; // IFC 座標
  cloud: THREE.Vector3[]; // 世界座標
  modelScene: THREE.Vector3[];
  cloudScene: THREE.Vector3[];
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
const DIFF_COLORS = { added: new THREE.Color(0x3cc85a), changed: new THREE.Color(0xf2c01e), removed: new THREE.Color(0xe5534b) };

function sourceName(p: Pick): string {
  return p.source === "model" ? "モデル" : p.source === "cloud" ? "点群" : "軸上";
}

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

/** 画面全体の状態と操作。各パネルはこれを参照して描く。 */
export class App {
  ctx!: HostContext;
  readonly viewer: Viewer3D;
  readonly models: ModelManager;
  readonly picker: Picker;
  readonly clipping: Clipping;
  readonly clipEditor: ClipBoxEditor;
  readonly frame: LocalFrame;
  readonly measure: MeasureTool;
  datasets: Manifest[] = [];
  current: Manifest | null = null;
  pc: PotreePointCloud | null = null;
  tool: Tool = "select";
  /** 計測の区間を固定する軸（X/Y/Z キーで固定、もう一度で解除）。null なら軸に近いときだけ吸着 */
  axisLock: Axis | null = null;
  /** Shift を押している間（最も大きい成分の軸に固定） */
  shiftHeld = false;
  readonly snap: SnapCursor;
  selection: { lm: LoadedModel; localId: number; data: any } | null = null;
  lastPick: Pick | null = null;
  issues = new Map<string, Issue>();
  private events: IssueEvent[] = [];
  private eventOffsets: Record<string, number> | null = null;
  private readonly issuePins = new THREE.Group();
  selectedIssue: string | null = null;
  diff: DatasetDiff | null = null;
  diffShown = false;
  align: AlignPick = { model: [], cloud: [], modelScene: [], cloudScene: [] };
  alignPreview: THREE.Matrix4 | null = null;
  pointBudget = 3_000_000;
  nav: NavSettings = loadNavSettings();
  private listeners = new Map<string, Set<() => void>>();
  private originStep = 0;

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
    this.snap.options = () => this.snapOptions();
    this.snap.augment = (list, x, y) => this.addAxisCandidate(list, x, y);
    this.snap.onChange = (c) => {
      if (this.tool === "measure") this.measure.setPreview(c?.point ?? null, c ? this.segmentAxis(c.point) : this.axisLock);
      if (c) this.showCoord(candidateToPick(c));
    };
    this.viewer.controls.addEventListener("change", () => this.snap.cameraMoved());
    this.viewer.controls.addEventListener("end", () => this.snap.refresh());
    this.clipping.onChange = () => {
      if (this.pc) this.pc.clipBox = this.clipping.mode === "box" ? this.clipping.box : null;
      this.pc?.invalidate();
      void this.models.update(true);
      this.clipEditor.refresh();
      this.emit("clip");
    };
    this.issuePins.name = "issues";
    this.viewer.overlay.add(this.issuePins);
    this.viewer.onBeforeRender(() => {
      if (!this.pc) return;
      this.pc.update(this.viewer.camera, this.viewer.size.height * this.viewer.renderer.getPixelRatio());
      if (this.pc.isLoading) this.viewer.requestRender();
    });
    const saved = Number(localStorage.getItem("pointBudget"));
    if (saved > 0) this.pointBudget = saved;
  }

  on(topic: string, cb: () => void) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic)!.add(cb);
  }

  emit(topic: string) {
    this.listeners.get(topic)?.forEach((cb) => cb());
  }

  setHint(msg: string) {
    $("#hint").textContent = msg;
  }

  /** 読み込み中の表示があるか（中央の「現場を開いてください」と重ねないために使う） */
  isLoadingView = false;

  setLoading(msg: string | null) {
    const el = $("#loading");
    el.textContent = msg ?? "";
    el.classList.toggle("hidden", !msg);
    this.isLoadingView = !!msg;
    // 読み込み中は入口カードを隠す。終わったら現場の有無に合わせて戻す
    if (msg) $("#empty-view").classList.add("hidden");
    else $("#empty-view").classList.toggle("hidden", !!this.current);
  }

  // ---- データセット ----

  async refreshDatasets() {
    this.datasets = (await host.listDatasets()) as Manifest[];
    this.emit("datasets");
  }

  get sites() {
    return groupBySite(this.datasets);
  }

  versionsOf(site: string): Manifest[] {
    return this.sites.get(site) ?? [];
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
      for (const entry of m.models) {
        this.setLoading(`モデル ${entry.key} を読込中…`);
        const buf = await fetchBytes(fileRel(entry.owner, entry.file));
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
      this.frame.restore(JSON.parse(localStorage.getItem(`frame:${m.site}`) ?? "null"), origin);
      this.viewer.fit(extent);
      // 離れて見えない側（モデル・点群）は、画面端の目印と小地図で場所を示す
      this.setHint("");
      this.diff = null;
      if (m.diff) {
        try {
          this.diff = await fetchJson<DatasetDiff>(`datasets/${m.folder}/diff.json`);
        } catch (e) {
          console.warn(e);
        }
      }
      this.renderIssuePins();
      localStorage.setItem("lastDataset", m.folder);
      this.emit("dataset");
    } finally {
      this.setLoading(null);
      // 開けなかったとき、隠していた「現場を開いてください」を戻す
      if (!this.current) this.emit("dataset");
    }
  }

  async closeDataset() {
    this.measure.clear();
    this.selection = null;
    this.diffShown = false;
    if (this.pc) {
      this.viewer.content.remove(this.pc.group);
      this.pc.dispose();
      this.pc = null;
      this.picker.cloud = null;
    }
    await this.models.unloadAll();
    this.clipping.setMode("none");
    this.current = null;
    $("#current-name").textContent = "現場を選んでください";
    this.alignPreview = null;
    this.align = { model: [], cloud: [], modelScene: [], cloudScene: [] };
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

  setTool(t: Tool) {
    this.tool = t;
    this.measure.cancel();
    this.originStep = 0;
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    // 計測・合わせ中は指摘のピンをクリックで反応させない（ピンの下の点を拾えるように）
    document.body.classList.toggle("tool-active", t !== "select");
    this.updateToolHint();
    this.snap.refresh();
    this.emit("tool");
  }

  /** ツールの案内（計測は今の手順と区間の軸で変わる）。今の手順で使うキーだけを出し、一覧は「?」にまとめる */
  updateToolHint() {
    const t = this.tool;
    const keys = "Tab 候補切替・Alt フリー";
    if (t === "measure") {
      const m = this.measure;
      const lock = this.axisLock ? `（${this.axisLock.toUpperCase()} 方向に固定）` : "";
      if (m.kind === "distance") {
        const step = m.hasPending ? `2点目をクリック${lock}` : "1点目をクリック";
        this.setHint(`距離: ${step}　${keys}・X/Y/Z 軸固定・Esc ${m.hasPending ? "取消" : "終了"}`);
      } else {
        const step = !m.hasPending ? "1点目をクリック" : m.pointCount === 1 ? `2点目をクリック${lock}` : `次の点をクリック${lock}・Enter/ダブルクリックで確定`;
        this.setHint(`折れ線: ${step}　${keys}・Backspace 1点戻す・Esc ${m.hasPending ? "確定" : "終了"}`);
      }
      return;
    }
    const hints: Record<Tool, string> = {
      select: "",
      measure: "",
      origin: this.originStep === 0 ? `UCS: 原点にする点をクリック　${keys}・Esc 終了` : `UCS: X 軸の向きにする点をクリック（Esc で向きは変えずに終了）　${keys}`,
      issue: "指摘する位置をクリック　Esc 終了",
      align: `3点合わせ: 右のパネルの手順に従ってください　${keys}・Esc 終了`,
    };
    this.setHint(hints[t]);
  }

  /** 計測の種類（距離・折れ線）を変える */
  setMeasureKind(k: MeasureKind) {
    this.measure.setKind(k);
    this.updateToolHint();
    this.snap.refresh();
    this.emit("measures");
  }

  /** X/Y/Z キー・パネルのボタン。同じ軸をもう一度で解除 */
  toggleAxisLock(a: Axis) {
    this.axisLock = this.axisLock === a ? null : a;
    this.updateToolHint();
    this.snap.refresh();
    this.emit("measures");
  }

  setShiftHeld(on: boolean) {
    if (this.shiftHeld === on) return;
    this.shiftHeld = on;
    this.snap.refresh();
  }

  /**
   * 最後の点 → target の区間の軸。優先順: X/Y/Z キーの固定 → Shift（最も大きい成分）→
   * 軸への吸着（target を軸へ射影した点が画面上で AXIS_TRACK_PX 以内なら、その軸）→ なし。
   * Alt・スナップ切のときは吸着しない。
   */
  segmentAxis(target: THREE.Vector3, shift = this.shiftHeld): Axis | null {
    const a = this.measure.pendingPoint;
    if (!a || this.tool !== "measure") return null;
    if (this.axisLock) return this.axisLock;
    if (shift) return this.measure.dominantAxis(a, target);
    if (this.snap.isFree) return null;
    const sa = this.picker.project(a);
    const st = this.picker.project(target);
    // 最後の点のすぐ近くでは向きが定まらないので吸着しない
    if (Math.hypot(st.x - sa.x, st.y - sa.y) < 2 * AXIS_TRACK_PX) return null;
    let best: Axis | null = null;
    let bestD = AXIS_TRACK_PX;
    for (const k of ["x", "y", "z"] as const) {
      const b = this.measure.endPoint(a, target, k);
      const sb = this.picker.project(b);
      // 視線の向きに近い軸（画面上で縮んで見える軸）は、どこでも近く見えるので除く
      if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < AXIS_TRACK_PX) continue;
      const d = Math.hypot(sb.x - st.x, sb.y - st.y);
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /** スナップの候補を探す対象（スナップを使わないツールは null） */
  private snapOptions(): { models: boolean; cloud: boolean } | null {
    if (!this.current) return null;
    const t = this.tool;
    if (t === "align") {
      const needModel = this.align.model.length <= this.align.cloud.length;
      return { models: needModel, cloud: !needModel };
    }
    if (t === "measure" || t === "origin") return { models: true, cloud: true };
    return null;
  }

  /**
   * 計測の作図中、カーソルの下に何も無いときは最後の点を通る軸の線上の点を候補にする
   * （空中でも軸に沿って測れるように）。固定した軸・Shift では常に、それ以外は軸の線の近くだけ。
   */
  private addAxisCandidate(list: SnapCandidate[], clientX: number, clientY: number): SnapCandidate[] {
    const a = this.measure.pendingPoint;
    if (!a || this.tool !== "measure") return list;
    if (list.some((c) => c.kind === "free")) return list;
    const forced = !!this.axisLock || this.shiftHeld;
    if (!forced && this.snap.isFree) return list;
    const ray = this.picker.rayAt(clientX, clientY);
    const rect = this.viewer.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    let best: SnapCandidate | null = null;
    for (const k of this.axisLock ? [this.axisLock] : (["x", "y", "z"] as const)) {
      const dir = this.frame.axisVector(k);
      const L = 1e4;
      const p = new THREE.Vector3();
      ray.distanceSqToSegment(a.clone().addScaledVector(dir, -L), a.clone().addScaledVector(dir, L), undefined, p);
      const s = this.picker.project(p);
      const c: SnapCandidate = {
        kind: "axis",
        source: "axis",
        point: p,
        distance: this.viewer.camera.position.distanceTo(p),
        sx: s.x,
        sy: s.y,
        screenDist: Math.hypot(s.x - cx, s.y - cy),
        detail: k.toUpperCase(),
      };
      if (!best || c.screenDist < best.screenDist) best = c;
    }
    if (!best || (!forced && best.screenDist > AXIS_TRACK_PX)) return list;
    return [...list, best];
  }

  /** 作図中の計測を確定する（折れ線の Enter・ダブルクリック・Esc） */
  finishMeasure() {
    this.measure.finish();
    this.updateToolHint();
    this.snap.refresh();
  }

  async handleClick(e: MouseEvent) {
    const t = this.tool;
    // 候補を探す間に Shift を離しても、クリックした瞬間の状態で決める
    const shift = e.shiftKey;
    // 折れ線: 最後の点をもう一度クリック（ダブルクリック）で確定
    if (t === "measure" && this.measure.kind === "polyline" && this.measure.pointCount >= 2) {
      const last = this.picker.project(this.measure.pendingPoint!);
      const rect = this.viewer.canvas.getBoundingClientRect();
      if (Math.hypot(e.clientX - rect.left - last.x, e.clientY - rect.top - last.y) <= 5) {
        this.finishMeasure();
        return;
      }
    }
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
    if (!p) {
      if (t === "select") await this.select(null);
      return;
    }
    switch (t) {
      case "select":
        await this.select(p);
        break;
      case "measure": {
        this.measure.add(p.point, sourceName(p), this.segmentAxis(p.point, shift), snapLabel);
        this.updateToolHint();
        // 続けて仮の線を出す（カーソルは動いていないので同じ候補を使う）
        this.snap.refresh();
        break;
      }
      case "origin":
        if (this.originStep === 0) {
          this.frame.set(p.point);
          this.originStep = 1;
          this.updateToolHint();
        } else {
          this.frame.set(this.frame.origin, p.point);
          this.saveFrame();
          this.setTool("select");
        }
        this.saveFrame();
        this.emit("measures");
        break;
      case "issue":
        this.emit("issue:new");
        break;
      case "align":
        this.addAlignPick(p);
        break;
    }
  }

  private saveFrame() {
    if (!this.current) return;
    localStorage.setItem(`frame:${this.current.site}`, JSON.stringify(this.frame.serialize(this.current.origin)));
  }

  resetFrame() {
    this.frame.reset();
    this.saveFrame();
    this.emit("measures");
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

  async select(p: Pick | null) {
    if (this.selection) {
      await this.selection.lm.model.resetHighlight([this.selection.localId]);
      if (this.diffShown) await this.applyDiffColors(this.selection.lm);
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

  // ---- 3点合わせ ----

  addAlignPick(p: Pick) {
    if (!this.current) return;
    const needModel = this.align.model.length <= this.align.cloud.length;
    if (needModel) {
      if (p.source !== "model") return;
      const toIfc = ifcToScene(this.current).invert();
      this.align.model.push(p.point.clone().applyMatrix4(toIfc));
      this.align.modelScene.push(p.point.clone());
    } else {
      if (p.source !== "cloud") return;
      this.align.cloud.push(new THREE.Vector3(...sceneToWorld(this.current, p.point)));
      this.align.cloudScene.push(p.point.clone());
    }
    this.emit("align");
  }

  /** 最後にクリックした対応点を 1 つ取り消す（点群側に対応する点が見つからないときなど） */
  undoAlignPick() {
    const a = this.align;
    if (a.model.length > a.cloud.length) {
      a.model.pop();
      a.modelScene.pop();
    } else if (a.cloud.length > 0) {
      a.cloud.pop();
      a.cloudScene.pop();
    }
    if (Math.min(a.model.length, a.cloud.length) < 3) {
      this.alignPreview = null;
      this.applyPlacement();
    }
    this.emit("align");
  }

  resetAlign() {
    this.align = { model: [], cloud: [], modelScene: [], cloudScene: [] };
    this.alignPreview = null;
    this.applyPlacement();
    this.emit("align");
  }

  // ---- 指摘 ----

  async refreshEvents() {
    const r = await host.eventsRead(this.eventOffsets);
    this.eventOffsets = r.offsets;
    if (r.events.length) {
      this.events.push(...(r.events as IssueEvent[]));
      this.issues = foldIssues(this.events);
      this.renderIssuePins();
      this.emit("issues");
    }
  }

  async appendEvent(e: Partial<IssueEvent>) {
    await host.eventsAppend(e);
    await this.refreshEvents();
  }

  captureView(): IssueView {
    const m = this.current!;
    const visibility: any = { pointcloud: this.pc ? { visible: this.pc.group.visible, colorMode: this.pc.material.uniforms.uColorMode.value } : null, models: {} };
    for (const lm of this.models.models.values()) {
      if (lm.role !== "current") continue;
      visibility.models[lm.key] = { visible: lm.visible, opacity: lm.opacity, hidden: [...lm.hiddenKeys], ghost: [...lm.ghostKeys] };
    }
    return {
      camera: {
        position: sceneToWorld(m, this.viewer.camera.position),
        target: sceneToWorld(m, this.viewer.controls.target),
        fov: this.viewer.fov,
        projection: this.viewer.projection,
      },
      clip: this.clipping.serialize(m.origin),
      visibility,
      frame: this.frame.serialize(m.origin),
    };
  }

  async restoreView(v: IssueView) {
    const m = this.current;
    if (!m || !v) return;
    // 投影を先に切り替える（切り替えは位置を引き継ぐので、位置はその後に置く）
    this.viewer.setProjection(v.camera.projection === "orthographic" ? "orthographic" : "perspective");
    this.viewer.camera.position.copy(worldToScene(m, v.camera.position));
    this.viewer.controls.target.copy(worldToScene(m, v.camera.target));
    if (v.camera.fov) this.viewer.fov = v.camera.fov;
    this.viewer.cameraMoved();
    this.clipping.restore(v.clip, m.origin);
    if (v.visibility?.pointcloud && this.pc) {
      this.pc.group.visible = v.visibility.pointcloud.visible;
      this.pc.setColorMode(v.visibility.pointcloud.colorMode);
    }
    for (const lm of this.models.models.values()) {
      const s = v.visibility?.models?.[lm.key];
      if (!s || lm.role !== "current") continue;
      // 以前の指摘はクラス名だけ（全階）で保存している。そのまま全階のクラス指定として効く
      lm.hiddenKeys = new Set(s.hidden);
      lm.ghostKeys = new Set(s.ghost);
      await this.models.setModelVisible(lm, s.visible);
      await this.models.setModelOpacity(lm, s.opacity);
    }
    this.viewer.requestRender();
    this.emit("display");
  }

  /** 同じ現場（全ての版）の指摘を位置に重ねて表示する */
  renderIssuePins() {
    for (const c of [...this.issuePins.children]) {
      this.issuePins.remove(c);
      if (c instanceof CSS2DObject) c.element.remove();
    }
    const m = this.current;
    if (!m) return;
    let n = 0;
    for (const issue of this.issues.values()) {
      if (issue.site !== m.site || !issue.position) continue;
      n++;
      const el = document.createElement("div");
      el.className = `issue-pin s-${issue.status}${issue.dataset !== m.folder ? " other-version" : ""}`;
      el.title = `${issue.title}（${issue.status}${issue.dataset !== m.folder ? `・第${issue.datasetVersion}版で登録` : ""}）`;
      el.appendChild(Object.assign(document.createElement("span"), { textContent: String(n) }));
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedIssue = issue.id;
        this.emit("issue:open");
      });
      const obj = new CSS2DObject(el);
      obj.position.copy(worldToScene(m, issue.position));
      obj.userData.issue = issue.id;
      this.issuePins.add(obj);
    }
    this.viewer.requestRender();
  }

  issuesForCurrentSite(): Issue[] {
    const m = this.current;
    return [...this.issues.values()].filter((i) => !m || i.site === m.site);
  }

  memberName(id: string): string {
    return this.ctx.members.find((m) => m.id === id)?.name || id;
  }

  // ---- 差分 ----

  async showDiff(on: boolean) {
    const m = this.current;
    if (!m || !this.diff) return;
    this.diffShown = on;
    // 前の版のモデル（削除された要素を赤の半透明で出す）
    for (const lm of [...this.models.models.values()]) if (lm.role === "previous") await this.models.unload(`${lm.datasetFolder}/${lm.key}`);
    for (const lm of this.models.models.values()) {
      await lm.model.resetColor(undefined);
      await lm.model.resetHighlight(undefined);
      if (on) await this.applyDiffColors(lm);
    }
    if (on && this.diff.models.removed.length) {
      const prev = this.datasets.find((d) => d.folder === this.diff!.against);
      if (prev) {
        const byModel = new Map<string, string[]>();
        for (const r of this.diff.models.removed) {
          if (!byModel.has(r.model)) byModel.set(r.model, []);
          byModel.get(r.model)!.push(r.guid);
        }
        for (const [key, guids] of byModel) {
          const entry = prev.models.find((x) => x.key === key);
          if (!entry) continue;
          const buf = await fetchBytes(fileRel(entry.owner, entry.file));
          const lm = await this.models.load(key, prev.folder, buf, "previous");
          // 同じ現場の IFC は同じ座標系なので、表示中の版の座標合わせで置く
          this.models.setPlacement(lm, ifcToScene(m));
          const ids = (await lm.model.getLocalIdsByGuids(guids)).filter((x): x is number => x !== null);
          await lm.model.setVisible(undefined, false);
          await lm.model.setVisible(ids, true);
          await lm.model.highlight(ids, { color: DIFF_COLORS.removed, renderedFaces: FRAGS.RenderedFaces.TWO, opacity: 0.45, transparent: true });
        }
      }
    }
    await this.models.update(true);
    this.emit("diff");
  }

  private async applyDiffColors(lm: LoadedModel) {
    if (!this.diff || lm.role !== "current") return;
    const pick = async (items: { guid: string; model: string }[]) =>
      (await lm.model.getLocalIdsByGuids(items.filter((x) => x.model === lm.key).map((x) => x.guid))).filter((x): x is number => x !== null);
    const added = await pick(this.diff.models.added);
    const changed = await pick(this.diff.models.changed);
    if (added.length) await lm.model.setColor(added, DIFF_COLORS.added);
    if (changed.length) await lm.model.setColor(changed, DIFF_COLORS.changed);
  }

  /** 要素（GlobalId）へ寄る */
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
