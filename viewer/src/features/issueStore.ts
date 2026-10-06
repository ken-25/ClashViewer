// 指摘: イベントの読み込み（追記のみのログを畳む）・追記と、3D 画面のピン。
// 一覧・詳細の画面は ui/issuePanel.ts。

import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { App } from "../app";
import { worldToScene } from "../data/dataset";
import { host } from "../host";
import { foldIssues, type Issue, type IssueEvent } from "../issues/issues";
import type { AppFeature } from "./feature";

export class IssueStore implements AppFeature {
  /** 全プロジェクトの指摘。id → 指摘 */
  all = new Map<string, Issue>();
  /** 詳細を開いている指摘 */
  selected: string | null = null;
  private events: IssueEvent[] = [];
  private offsets: Record<string, number> | null = null;
  private readonly pins = new THREE.Group();

  constructor(private readonly app: App) {
    this.pins.name = "issues";
    app.viewer.overlay.add(this.pins);
  }

  onOpen() {
    this.renderPins();
  }

  /** 前回の続きからイベントを読み、変わっていれば畳み直す */
  async refresh() {
    const r = await host.eventsRead(this.offsets);
    this.offsets = r.offsets;
    if (r.events.length) {
      this.events.push(...(r.events as IssueEvent[]));
      this.all = foldIssues(this.events);
      this.renderPins();
      this.app.emit("issues");
    }
  }

  async append(e: Partial<IssueEvent>) {
    await host.eventsAppend(e);
    await this.refresh();
  }

  /** 開いているプロジェクト（全ての版）の指摘 */
  forCurrentSite(): Issue[] {
    const m = this.app.current;
    return [...this.all.values()].filter((i) => !m || i.site === m.site);
  }

  /** 同じプロジェクト（全ての版）の指摘を位置に重ねて表示する */
  renderPins() {
    for (const c of [...this.pins.children]) {
      this.pins.remove(c);
      if (c instanceof CSS2DObject) c.element.remove();
    }
    const m = this.app.current;
    if (!m) return;
    let n = 0;
    for (const issue of this.all.values()) {
      if (issue.site !== m.site || !issue.position) continue;
      n++;
      const el = document.createElement("div");
      el.className = `issue-pin s-${issue.status}${issue.dataset !== m.folder ? " other-version" : ""}`;
      el.title = `${issue.title}（${issue.status}${issue.dataset !== m.folder ? `・第${issue.datasetVersion}版で登録` : ""}）`;
      el.appendChild(Object.assign(document.createElement("span"), { textContent: String(n) }));
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selected = issue.id;
        this.app.emit("issue:open");
      });
      const obj = new CSS2DObject(el);
      obj.position.copy(worldToScene(m, issue.position));
      obj.userData.issue = issue.id;
      this.pins.add(obj);
    }
    this.app.viewer.requestRender();
  }
}
