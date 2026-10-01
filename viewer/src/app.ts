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
import { Picker, type Pick } from "./scene/picker";
import { Viewer3D } from "./scene/viewer3d";
import { Clipping } from "./tools/clipping";
import { LocalFrame, MeasureTool } from "./tools/measure";
import { $ } from "./ui/dom";

export type Tool = "select" | "measure" | "ortho" | "origin" | "issue" | "align";

export interface AlignPick {
  model: THREE.Vector3[]; // IFC 座標
  cloud: THREE.Vector3[]; // 世界座標
  modelScene: THREE.Vector3[];
  cloudScene: THREE.Vector3[];
}

const SELECT_COLOR = new THREE.Color(0x3399ff);
const DIFF_COLORS = { added: new THREE.Color(0x3cc85a), changed: new THREE.Color(0xf2c01e), removed: new THREE.Color(0xe5534b) };

/** 画面全体の状態と操作。各パネルはこれを参照して描く。 */
export class App {
  ctx!: HostContext;
  readonly viewer: Viewer3D;
  readonly models: ModelManager;
  readonly picker: Picker;
  readonly clipping: Clipping;
  readonly frame: LocalFrame;
  readonly measure: MeasureTool;
  datasets: Manifest[] = [];
  current: Manifest | null = null;
  pc: PotreePointCloud | null = null;
  tool: Tool = "select";
  orthoAxis: "auto" | "x" | "y" | "z" = "auto";
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
  private listeners = new Map<string, Set<() => void>>();
  private originStep = 0;

  constructor() {
    this.viewer = new Viewer3D($("#view"));
    this.models = new ModelManager(this.viewer);
    this.picker = new Picker(this.viewer, this.models);
    this.clipping = new Clipping(this.viewer);
    this.frame = new LocalFrame(this.viewer);
    this.measure = new MeasureTool(this.viewer, this.frame);
    this.measure.onChange = () => this.emit("measures");
    this.clipping.onChange = () => {
      if (this.pc) this.pc.clipBox = this.clipping.mode === "box" ? this.clipping.box : null;
      this.pc?.invalidate();
      void this.models.update(true);
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

  setMessage(msg: string) {
    $("#st-msg").textContent = msg;
  }

  setHint(msg: string) {
    $("#hint").textContent = msg;
  }

  setLoading(msg: string | null) {
    const el = $("#loading");
    el.textContent = msg ?? "";
    el.classList.toggle("hidden", !msg);
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
      $("#current-title").textContent = `${m.name} 第${m.version}版`;
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
          lm.hiddenCategories.add("IFCSPACE");
          await this.models.applyCategoryStates(lm);
        }
      }
      const extent = this.sceneBox();
      this.clipping.extent = extent.clone();
      this.clipping.box.copy(extent);
      this.frame.restore(JSON.parse(localStorage.getItem(`frame:${m.site}`) ?? "null"), origin);
      this.viewer.fit(extent);
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
    this.alignPreview = null;
    this.align = { model: [], cloud: [], modelScene: [], cloudScene: [] };
    this.viewer.requestRender();
  }

  sceneBox(): THREE.Box3 {
    const b = new THREE.Box3();
    if (this.pc && this.pc.group.visible) b.union(this.pc.boxDisplay);
    b.union(this.models.box());
    if (b.isEmpty()) b.set(new THREE.Vector3(-10, -10, -2), new THREE.Vector3(10, 10, 10));
    return b;
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
    const hints: Record<Tool, string> = {
      select: "",
      measure: "1点目をクリック（点群・モデルのどちらでも）",
      ortho: "直交計測: 1点目をクリック。2点目は局所座標の X/Y/Z のうち最も大きい方向だけを測ります（X/Y/Z キーで固定）",
      origin: "原点にする点をクリック",
      issue: "指摘する位置をクリック",
      align: "3点合わせ: 右上のパネルの手順に従ってください",
    };
    this.setHint(hints[t]);
    this.emit("tool");
  }

  async handleClick(e: MouseEvent) {
    const t = this.tool;
    const snap = t === "measure" || t === "ortho" || t === "origin" || t === "align";
    let opt = { models: true, cloud: true, snap };
    if (t === "align") {
      const needModel = this.align.model.length <= this.align.cloud.length;
      opt = { models: needModel, cloud: !needModel, snap: true };
    }
    const p = await this.picker.pick(e.clientX, e.clientY, opt);
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
      case "measure":
      case "ortho": {
        const m = this.measure.add(p.point, p.source === "model" ? "モデル" : "点群", t === "ortho" ? this.orthoAxis : null);
        this.setHint(m ? "続けて 1点目をクリック（Esc で終了）" : "2点目をクリック");
        break;
      }
      case "origin":
        if (this.originStep === 0) {
          this.frame.set(p.point);
          this.originStep = 1;
          this.setHint("X 軸の向きにする点をクリック（Esc で向きは変えずに終了）");
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
    el.textContent = `${p.source === "model" ? "モデル" : "点群"}  局所 X ${f(l.x)} Y ${f(l.y)} Z ${f(l.z)}  ／ 世界 ${w.map(f).join(", ")}`;
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
      visibility.models[lm.key] = { visible: lm.visible, opacity: lm.opacity, hidden: [...lm.hiddenCategories], ghost: [...lm.ghostCategories] };
    }
    return {
      camera: {
        position: sceneToWorld(m, this.viewer.camera.position),
        target: sceneToWorld(m, this.viewer.controls.target),
        fov: this.viewer.camera.fov,
      },
      clip: this.clipping.serialize(m.origin),
      visibility,
      frame: this.frame.serialize(m.origin),
    };
  }

  async restoreView(v: IssueView) {
    const m = this.current;
    if (!m || !v) return;
    this.viewer.camera.position.copy(worldToScene(m, v.camera.position));
    this.viewer.controls.target.copy(worldToScene(m, v.camera.target));
    this.viewer.camera.fov = v.camera.fov || this.viewer.camera.fov;
    this.viewer.camera.updateProjectionMatrix();
    this.viewer.controls.update();
    this.clipping.restore(v.clip, m.origin);
    if (v.visibility?.pointcloud && this.pc) {
      this.pc.group.visible = v.visibility.pointcloud.visible;
      this.pc.setColorMode(v.visibility.pointcloud.colorMode);
    }
    for (const lm of this.models.models.values()) {
      const s = v.visibility?.models?.[lm.key];
      if (!s || lm.role !== "current") continue;
      lm.hiddenCategories = new Set(s.hidden);
      lm.ghostCategories = new Set(s.ghost);
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
