import * as THREE from "three";
import type { App, NavTarget } from "../app";
import type { ViewKind } from "../scene/viewer3d";
import { h } from "./dom";

/**
 * 位置の目印。自分がどこを見ていて、見えていない点群・モデル・原点がどこにあるかを示す。
 *
 * - 画面端の目印: 画面外（または遠くて数ピクセルにしか見えない）ものの方向と距離。押すとそこへ移動
 * - 小地図: 真上から見た配置（上が +Y）。カメラの位置と向き、点群・モデルの範囲、原点。押すと移動
 * - 方位: 画面の向きに対する X/Y/Z。押すとその軸の側から見る
 *
 * 描くたびに更新する（描画は必要なときだけなので、止まっている間は何もしない）。
 */

const KIND_ORDER: Record<NavTarget["kind"], number> = { cloud: 0, model: 1, frameOrigin: 2, worldOrigin: 3 };

/** これより小さく映っているものは「見えている」とみなさず目印を出す（px、対角） */
const MIN_VISIBLE_PX = 36;

export function fmtDistance(d: number): string {
  if (d < 1) return "ここ";
  if (d < 1000) return `${d.toFixed(0)} m`;
  return `${(d / 1000).toFixed(1)} km`;
}

function isPoint(b: THREE.Box3): boolean {
  return b.min.equals(b.max);
}

function unionOf(targets: NavTarget[]): THREE.Box3 {
  const b = new THREE.Box3();
  for (const t of targets) b.union(t.box);
  return b;
}

/** 同じ所に重なる目印をまとめた名前（点群・モデル 3 件・世界原点 など） */
function groupLabel(targets: NavTarget[]): string {
  const models = targets.filter((t) => t.kind === "model");
  const parts: string[] = [];
  for (const t of targets.filter((x) => x.kind === "cloud")) parts.push(t.label);
  if (models.length === 1) parts.push(models[0].label);
  else if (models.length > 1) parts.push(`モデル ${models.length} 件`);
  for (const t of targets.filter((x) => x.kind === "frameOrigin" || x.kind === "worldOrigin")) parts.push(t.label);
  return parts.join("・");
}

interface Placed {
  targets: NavTarget[];
  x: number;
  y: number;
  /** 画面端に置いたとき、外向きの方向（-1..1、どちらかが ±1）。画面内に置いたときは null */
  out: { x: number; y: number; angle: number } | null;
  dist: number;
}

export class Navigator {
  private readonly layer: HTMLElement;
  private readonly chips = new Map<string, HTMLButtonElement>();
  private readonly chipTargets = new WeakMap<HTMLButtonElement, NavTarget[]>();
  private readonly axes: SVGSVGElement;
  private readonly minimap: HTMLElement;
  private readonly mapSvg: SVGSVGElement;
  private readonly mapStatic: SVGGElement;
  private readonly mapCamera: SVGGElement;
  private mapKey = "";
  /** 小地図の変換（シーン座標の XY → 地図の px） */
  private map: { x0: number; y1: number; s: number; ox: number; oy: number; w: number; h: number; targets: NavTarget[] } | null = null;

  constructor(private readonly app: App) {
    const view = app.viewer.container;
    this.layer = h("div", { id: "nav-layer", "aria-label": "位置の目印" });
    view.appendChild(this.layer);

    this.axes = svg("svg", { id: "nav-axes", viewBox: "-38 -38 76 76", role: "group", "aria-label": "方位（軸を押すとその側から見る）" }) as SVGSVGElement;
    this.axes.addEventListener("click", (e) => {
      // data-view はツールバーの視点ボタンが使うので別の名前にする
      const kind = (e.target as Element).closest("[data-axis-view]")?.getAttribute("data-axis-view") as ViewKind | null;
      if (kind && this.app.current) this.app.viewer.setView(kind, this.app.viewBox());
    });
    view.appendChild(this.axes);

    this.mapSvg = svg("svg", { class: "minimap-svg", width: "220", height: "160", role: "img", "aria-label": "小地図" }) as SVGSVGElement;
    this.mapStatic = svg("g") as SVGGElement;
    this.mapCamera = svg("g") as SVGGElement;
    this.mapSvg.append(this.mapStatic, this.mapCamera);
    this.mapSvg.addEventListener("click", (e) => this.onMapClick(e));
    this.minimap = h(
      "div",
      { id: "minimap" },
      h(
        "div",
        { class: "minimap-head" },
        h("span", { class: "grow" }, "小地図（上が +Y）"),
        h("button", { class: "minimap-close", title: "小地図を閉じる（3D 画面左上の「目印」で戻せます）", "aria-label": "小地図を閉じる", onclick: () => this.app.setNav({ minimap: false }) }, "×"),
      ),
      this.mapSvg,
    );
    view.appendChild(this.minimap);

    app.viewer.onAfterRender(() => this.update());
    app.on("nav", () => {
      this.mapKey = "";
      this.update();
    });
  }

  update() {
    const app = this.app;
    const on = !!app.current;
    const targets = on ? app.navTargets() : [];
    this.axes.classList.toggle("hidden", !on);
    this.minimap.classList.toggle("hidden", !on || !app.nav.minimap || targets.length === 0);
    if (on) this.updateAxes();
    this.updateChips(on && app.nav.markers ? targets : []);
    if (on && app.nav.minimap) this.updateMinimap(targets);
  }

  // ---- 画面端の目印 ----

  private updateChips(targets: NavTarget[]) {
    const viewer = this.app.viewer;
    const cam = viewer.camera;
    const { width: W, height: H } = viewer.size;
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // 画面端の余白（上は案内文、下は方位・小地図と重なりにくいように）
    const rect = { l: 14, t: 48, r: W - 14, b: H - 14 };

    const placed: Placed[] = [];
    for (const t of [...targets].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])) {
      const p = this.place(t, W, H, rect, frustum);
      if (!p) continue;
      // 近くに置いた目印とまとめる（同じ向きにある点群とモデル、複数のモデルなど）
      const g = placed.find((q) => !!q.out === !!p.out && Math.abs(q.x - p.x) < 110 && Math.abs(q.y - p.y) < 26);
      if (g) {
        g.targets.push(t);
        g.dist = Math.min(g.dist, p.dist);
      } else placed.push(p);
    }

    // 画面端の目印が方位・小地図の下に隠れないよう、その上（または左）へ逃がす
    const obstacles = [this.axes, this.minimap]
      .filter((el) => !el.classList.contains("hidden"))
      .map((el) => this.relRect(el));
    for (const p of placed) {
      if (!p.out) continue;
      for (const o of obstacles) {
        if (p.x < o.l - 20 || p.x > o.r + 20 || p.y < o.t - 14 || p.y > o.b + 14) continue;
        // 障害物の上へ。目印の下の辺をそこに合わせる（横位置の合わせ方はそのまま）
        p.y = o.t - 6;
        p.out = { ...p.out, y: 1 };
      }
    }

    const used = new Set<string>();
    for (const p of placed) {
      const key = `${p.out ? "e" : "a"}:${p.targets.map((t) => t.id).join("|")}`;
      used.add(key);
      let el = this.chips.get(key);
      if (!el) {
        el = h("button", { class: "nav-chip" });
        const chip = el;
        chip.addEventListener("pointerdown", (e) => e.stopPropagation());
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          const ts = this.chipTargets.get(chip);
          if (ts) this.app.focusBox(unionOf(ts));
        });
        this.layer.appendChild(chip);
        this.chips.set(key, chip);
      }
      this.chipTargets.set(el, p.targets);
      const kind = p.targets[0].kind;
      el.className = `nav-chip k-${kind}${p.out ? " edge" : " at"}`;
      const label = groupLabel(p.targets);
      const dist = fmtDistance(p.dist);
      const mark = p.out ? `<span class="nav-arrow" style="transform:rotate(${p.out.angle.toFixed(3)}rad)">➤</span>` : `<span class="nav-dot"></span>`;
      const html = `${mark}<span class="nav-label">${esc(label)}</span><span class="nav-dist">${dist}</span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.title = `${label}（${p.out ? "画面外・" : ""}カメラから ${dist}）\nクリックで移動`;
      el.setAttribute("aria-label", `${label}へ移動（${dist}）`);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      // 画面端では目印の外側の辺を端に合わせる。画面内では点（●）を位置に合わせる
      el.style.transform = p.out ? `translate(${(-50 - 50 * p.out.x).toFixed(1)}%, ${(-50 - 50 * p.out.y).toFixed(1)}%)` : "translate(-7px, -50%)";
    }
    for (const [key, el] of this.chips) {
      if (used.has(key)) continue;
      el.remove();
      this.chips.delete(key);
    }
  }

  /** 3D 画面の中での要素の位置（px） */
  private relRect(el: Element): { l: number; t: number; r: number; b: number } {
    const c = this.app.viewer.container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { l: r.left - c.left, t: r.top - c.top, r: r.right - c.left, b: r.bottom - c.top };
  }

  /** 目印を置く位置。十分大きく見えているものは null（目印は要らない） */
  private place(t: NavTarget, W: number, H: number, rect: { l: number; t: number; r: number; b: number }, frustum: THREE.Frustum): Placed | null {
    const cam = this.app.viewer.camera;
    const box = t.box;
    const dist = box.distanceToPoint(cam.position);
    if (!isPoint(box) && frustum.intersectsBox(box) && this.projectedSize(box, W, H) >= MIN_VISIBLE_PX) return null;
    const center = box.getCenter(new THREE.Vector3());
    const vc = center.clone().applyMatrix4(cam.matrixWorldInverse);
    const inFront = vc.z < -cam.near;
    const ndc = center.clone().project(cam);
    const sx = ((ndc.x + 1) / 2) * W;
    const sy = ((1 - ndc.y) / 2) * H;
    if (inFront && sx >= rect.l && sx <= rect.r && sy >= rect.t && sy <= rect.b) {
      // 設定した原点は 3D の印（軸と「原点」の札）が出ているので重ねない
      if (t.kind === "frameOrigin") return null;
      return { targets: [t], x: sx, y: sy, out: null, dist };
    }
    // 画面外: 画面の中心から見た向きで端に置く。後ろにあるときはカメラ座標の左右・上下で向きを決める
    let dx = inFront ? sx - W / 2 : vc.x;
    let dy = inFront ? sy - H / 2 : -vc.y;
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = 0;
      dy = 1;
    }
    const cx = (rect.l + rect.r) / 2;
    const cy = (rect.t + rect.b) / 2;
    const hw = Math.max((rect.r - rect.l) / 2, 1);
    const hh = Math.max((rect.b - rect.t) / 2, 1);
    const k = Math.min(hw / Math.max(Math.abs(dx), 1e-9), hh / Math.max(Math.abs(dy), 1e-9));
    const x = cx + dx * k;
    const y = cy + dy * k;
    return { targets: [t], x, y, out: { x: (x - cx) / hw, y: (y - cy) / hh, angle: Math.atan2(dy, dx) }, dist };
  }

  /** 画面に映る大きさ（px、対角）。カメラが範囲の中や際にあるときは Infinity */
  private projectedSize(box: THREE.Box3, W: number, H: number): number {
    const cam = this.app.viewer.camera;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      p.applyMatrix4(cam.matrixWorldInverse);
      if (p.z > -cam.near) return Infinity;
      p.applyMatrix4(cam.projectionMatrix);
      const sx = ((p.x + 1) / 2) * W;
      const sy = ((1 - p.y) / 2) * H;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    return Math.hypot(x1 - x0, y1 - y0);
  }

  // ---- 方位 ----

  private updateAxes() {
    const inv = this.app.viewer.camera.quaternion.clone().invert();
    const L = 24;
    const axes = [
      { name: "X", color: "#ff5a5a", v: new THREE.Vector3(1, 0, 0), view: "right", title: "X: +X 側（右）から見る" },
      { name: "Y", color: "#5ad25a", v: new THREE.Vector3(0, 1, 0), view: "back", title: "Y: +Y 側（後ろ）から見る" },
      { name: "Z", color: "#5a9cff", v: new THREE.Vector3(0, 0, 1), view: "top", title: "Z: 真上から見る" },
    ].map((a) => ({ ...a, c: a.v.applyQuaternion(inv) }));
    // 奥（カメラ座標の z が小さい）から描く
    axes.sort((a, b) => a.c.z - b.c.z);
    const parts = [`<circle r="34" class="axes-bg"/>`];
    for (const a of axes) {
      const x = a.c.x * L;
      const y = -a.c.y * L;
      const dim = a.c.z < -0.2 ? 0.55 : 1;
      parts.push(
        `<line x1="${(-x * 0.45).toFixed(1)}" y1="${(-y * 0.45).toFixed(1)}" x2="0" y2="0" stroke="${a.color}" stroke-width="1.5" opacity="0.35"/>`,
        `<g data-axis-view="${a.view}" class="axis" opacity="${dim}"><title>${a.title}</title>`,
        `<line x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${a.color}" stroke-width="2.5" stroke-linecap="round"/>`,
        `<circle cx="${(x * 1.18).toFixed(1)}" cy="${(y * 1.18).toFixed(1)}" r="7" fill="${a.color}"/>`,
        `<text x="${(x * 1.18).toFixed(1)}" y="${(y * 1.18 + 3.5).toFixed(1)}" text-anchor="middle">${a.name}</text></g>`,
      );
    }
    this.axes.innerHTML = parts.join("");
  }

  // ---- 小地図 ----

  private updateMinimap(targets: NavTarget[]) {
    const key = targets.map((t) => `${t.id}:${t.box.min.toArray().map((v) => v.toFixed(1))}:${t.box.max.toArray().map((v) => v.toFixed(1))}`).join("|");
    if (key !== this.mapKey) {
      this.mapKey = key;
      this.buildMapStatic(targets);
    }
    this.drawMapCamera();
  }

  /** 範囲を決めて、点群・モデル・原点を描く。範囲から大きく外れた原点は地図の縁に向きだけ出す */
  private buildMapStatic(targets: NavTarget[]) {
    const W = 220;
    const H = 160;
    const pad = 16;
    const core = unionOf(targets.filter((t) => t.kind === "cloud" || t.kind === "model"));
    const bounds = core.clone();
    if (core.isEmpty()) for (const t of targets) bounds.union(t.box);
    else {
      const span = Math.max(core.max.x - core.min.x, core.max.y - core.min.y, 100);
      for (const t of targets) if (isPoint(t.box) && core.distanceToPoint(t.box.min) < span * 2) bounds.union(t.box);
    }
    if (bounds.isEmpty()) {
      this.map = null;
      this.mapStatic.innerHTML = "";
      return;
    }
    const c = bounds.getCenter(new THREE.Vector3());
    const spanX = Math.max(bounds.max.x - bounds.min.x, 20);
    const spanY = Math.max(bounds.max.y - bounds.min.y, 20);
    const s = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
    const map = { x0: c.x, y1: c.y, s, ox: W / 2, oy: H / 2, w: W, h: H, targets };
    this.map = map;

    const parts: string[] = [];
    const originLabels: MapLabel[] = [];
    // 大きいもの（点群）を先に描く
    for (const t of [...targets].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])) {
      if (isPoint(t.box)) {
        const p = this.toMap(t.box.min.x, t.box.min.y);
        const inside = p.x >= 4 && p.x <= W - 4 && p.y >= 4 && p.y <= H - 4;
        const cls = t.kind === "worldOrigin" ? "mm-world" : "mm-frame";
        if (inside) {
          parts.push(`<g class="${cls}"><title>${esc(t.label)}</title><path d="M${p.x - 5},${p.y}h10M${p.x},${p.y - 5}v10"/><circle cx="${p.x}" cy="${p.y}" r="2"/></g>`);
          originLabels.push({ cls, text: t.label, x: p.x, y: p.y + 12 });
        } else {
          const e = this.clampToMap(p.x, p.y, 8);
          parts.push(`<g class="${cls}"><title>${esc(t.label)}（地図の外）</title><path d="M0,-5L5,4H-5Z" transform="translate(${e.x},${e.y}) rotate(${e.deg + 90})"/></g>`);
          originLabels.push({ cls, text: t.label, x: e.x, y: e.y + (e.y < H / 2 ? 14 : -7) });
        }
        continue;
      }
      const a = this.toMap(t.box.min.x, t.box.max.y);
      const b = this.toMap(t.box.max.x, t.box.min.y);
      // 遠く離れて点にしかならないものも見えるように最小 5 px
      const w = Math.max(b.x - a.x, 5);
      const hh = Math.max(b.y - a.y, 5);
      const x = (a.x + b.x) / 2 - w / 2;
      const y = (a.y + b.y) / 2 - hh / 2;
      parts.push(`<rect class="mm-${t.kind}" data-id="${esc(t.id)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}"><title>${esc(t.label)}</title></rect>`);
    }
    // 名前は点群と、モデルはまとめて 1 つ（小さい地図に何件も書くと読めない）
    const named: [string, string, THREE.Box3][] = [];
    const cloud = targets.find((t) => t.kind === "cloud");
    if (cloud) named.push(["mm-cloud", "点群", cloud.box]);
    const models = unionOf(targets.filter((t) => t.kind === "model"));
    if (!models.isEmpty()) named.push(["mm-model", "モデル", models]);
    const want: MapLabel[] = named.map(([cls, text, box]) => {
      const a = this.toMap(box.min.x, box.max.y);
      const b = this.toMap(box.max.x, box.min.y);
      // 範囲の左上に書く。右寄りにあれば右上に右揃えで書く（地図からはみ出さないように）
      return (a.x + b.x) / 2 > W * 0.6 ? { cls, text, x: Math.max(b.x, a.x + 5), y: a.y - 3 } : { cls, text, x: a.x, y: a.y - 3 };
    });
    const labels = layoutLabels([...want, ...originLabels], W, H);
    // 方角（上が +Y、右が +X）
    parts.push(`<g class="mm-axes"><path d="M12,${H - 10}h16M12,${H - 10}v-16"/><text x="31" y="${H - 7}">X</text><text x="8" y="${H - 29}">Y</text></g>`);
    // 縮尺（右下に 60 px 前後の棒）
    const len = niceLength(60 / s);
    const px = len * s;
    parts.push(
      `<g class="mm-scale"><path d="M${W - 8 - px},${H - 12}v4h${px}v-4"/><text x="${W - 8 - px / 2}" y="${H - 15}" text-anchor="middle">${len >= 1000 ? `${len / 1000} km` : `${len} m`}</text></g>`,
    );
    this.mapStatic.innerHTML = parts.join("") + labels.join("");
  }

  private drawMapCamera() {
    const map = this.map;
    if (!map) {
      this.mapCamera.innerHTML = "";
      return;
    }
    const cam = this.app.viewer.camera;
    const p = this.toMap(cam.position.x, cam.position.y);
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const inside = p.x >= 0 && p.x <= map.w && p.y >= 0 && p.y <= map.h;
    const q = inside ? p : this.clampToMap(p.x, p.y, 6);
    const parts: string[] = [];
    const horiz = Math.hypot(fwd.x, fwd.y);
    if (horiz > 0.05) {
      // 見ている向きと横の画角（地図は y が下向きなので Y を反転）
      const ang = Math.atan2(-fwd.y, fwd.x);
      // 平行投影でも、注視点の奥行きで同じ視野になる透視の画角で描く
      const v = this.app.viewer;
      const hfov = Math.atan(Math.tan(THREE.MathUtils.degToRad(v.fov / 2)) * v.aspect);
      const L = 26;
      const a1 = ang - hfov;
      const a2 = ang + hfov;
      parts.push(`<path class="mm-view" d="M${q.x},${q.y}L${q.x + Math.cos(a1) * L},${q.y + Math.sin(a1) * L}A${L},${L} 0 0 1 ${q.x + Math.cos(a2) * L},${q.y + Math.sin(a2) * L}Z"/>`);
    } else {
      // 真上・真下を向いているときは向きの代わりに輪を出す
      parts.push(`<circle class="mm-view" cx="${q.x}" cy="${q.y}" r="10"/>`);
    }
    parts.push(`<circle class="mm-cam${inside ? "" : " outside"}" cx="${q.x}" cy="${q.y}" r="4"><title>カメラ（いまの視点）</title></circle>`);
    this.mapCamera.innerHTML = parts.join("");
  }

  private onMapClick(e: MouseEvent) {
    const map = this.map;
    if (!map) return;
    const r = this.mapSvg.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    // 押した所の点群・モデル・原点へ移動（重なっていれば小さい方）。何も無ければその場所へ平行移動
    let best: { t: NavTarget; area: number } | null = null;
    for (const t of map.targets) {
      const a = this.toMap(t.box.min.x, t.box.max.y);
      const b = this.toMap(t.box.max.x, t.box.min.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const hw = Math.max((b.x - a.x) / 2, 6);
      const hh = Math.max((b.y - a.y) / 2, 6);
      if (Math.abs(mx - cx) > hw || Math.abs(my - cy) > hh) continue;
      const area = hw * hh;
      if (!best || area < best.area) best = { t, area };
    }
    if (best) {
      this.app.focusBox(best.t.box);
      return;
    }
    const viewer = this.app.viewer;
    const x = map.x0 + (mx - map.ox) / map.s;
    const y = map.y1 - (my - map.oy) / map.s;
    const d = new THREE.Vector3(x - viewer.controls.target.x, y - viewer.controls.target.y, 0);
    viewer.controls.target.add(d);
    viewer.camera.position.add(d);
    viewer.cameraMoved();
  }

  private toMap(x: number, y: number): { x: number; y: number } {
    const m = this.map!;
    return { x: m.ox + (x - m.x0) * m.s, y: m.oy - (y - m.y1) * m.s };
  }

  /** 地図の外の点を、地図の中心から見た向きで縁へ寄せる */
  private clampToMap(x: number, y: number, inset: number): { x: number; y: number; deg: number } {
    const m = this.map!;
    const dx = x - m.w / 2;
    const dy = y - m.h / 2;
    const k = Math.min((m.w / 2 - inset) / Math.max(Math.abs(dx), 1e-9), (m.h / 2 - inset) / Math.max(Math.abs(dy), 1e-9), 1);
    return { x: m.w / 2 + dx * k, y: m.h / 2 + dy * k, deg: (Math.atan2(dy, dx) * 180) / Math.PI };
  }
}

interface MapLabel {
  cls: string;
  text: string;
  /** 文字の基準点（右寄りなら右端、それ以外は左端） */
  x: number;
  y: number;
}

/**
 * 小地図の名前を、地図からはみ出さず互いに重ならないように並べる（先に来たものを優先）。
 * 幅は 1 文字 10 px で見積もる。重なれば 12 px ずつ上下にずらし、置けなければ書かない。
 */
function layoutLabels(list: MapLabel[], W: number, H: number): string[] {
  // 左下の方角・右下の縮尺には書かない
  const placed: { l: number; r: number; t: number; b: number }[] = [
    { l: 0, r: 40, t: H - 34, b: H },
    { l: W - 80, r: W, t: H - 26, b: H },
  ];
  const out: string[] = [];
  for (const lb of list) {
    const w = [...lb.text].length * 10;
    const right = lb.x > W * 0.6;
    let l = right ? lb.x - w : lb.x;
    l = THREE.MathUtils.clamp(l, 2, W - 2 - w);
    for (const dy of [0, 12, -12, 24, -24]) {
      const y = THREE.MathUtils.clamp(lb.y + dy, 11, H - 3);
      const box = { l, r: l + w, t: y - 10, b: y + 2 };
      if (placed.some((p) => p.l < box.r && box.l < p.r && p.t < box.b && box.t < p.b)) continue;
      placed.push(box);
      out.push(`<text class="${lb.cls}" x="${l.toFixed(1)}" y="${y.toFixed(1)}">${esc(lb.text)}</text>`);
      break;
    }
  }
  return out;
}

/** m 以下で最も大きい切りの良い長さ（1・2・5 × 10^n） */
function niceLength(m: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= m) ?? p;
}

function svg(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
