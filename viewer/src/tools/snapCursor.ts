import * as THREE from "three";
import type { Picker } from "../scene/picker";
import { SNAP_LABEL, sourceLabel, type SnapCandidate, type SnapKind } from "../scene/snap";
import type { Viewer3D } from "../scene/viewer3d";

/** 候補の印（16px の SVG）。形で種類、色で出所（モデル・点群）を表す */
const ICON: Record<SnapKind, string> = {
  vertex: '<rect x="3" y="3" width="10" height="10"/>',
  corner: '<rect x="3" y="3" width="10" height="10"/><path d="M3 8h3M10 8h3M8 3v3M8 10v3"/>',
  midpoint: '<path d="M8 2.5L13.8 13H2.2Z"/>',
  edge: '<path d="M3 3L13 13M13 3L3 13"/>',
  boundary: '<path d="M8 2L14 8L8 14L2 8Z"/>',
  axis: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  free: '<circle cx="8" cy="8" r="2.5"/><path d="M8 0v4M8 12v4M0 8h4M12 8h4"/>',
};

/**
 * 計測・原点設定・3点合わせで、カーソル付近のスナップ候補を探して印を出す。
 *
 * - カーソルを動かすと候補を探し直す（非同期。探している間に動いたら最後の位置だけ探す）
 * - Tab / Shift+Tab で候補を切り替える。少し動かしても同じ候補が近くにあれば選んだままにする
 * - Alt を押している間と、スナップを切っているときはフリー（カーソル下の面・点そのもの）だけ
 * - クリックしたときは、画面に出ている候補をそのまま使う（出ていなければその場で探す）
 */
export class SnapCursor {
  /** スナップを使う（S で切替、保存する） */
  enabled = localStorage.getItem("snap") !== "off";
  /** Alt を押している間 */
  private freeHeld = false;
  private list: SnapCandidate[] = [];
  private index = 0;
  /** Tab で選んだ候補（探し直しても近くの同じ種類を選び続ける） */
  private sticky: { kind: SnapKind; sx: number; sy: number } | null = null;
  /** 最後に探した位置（client 座標）と、そのあとカメラが動いていないか */
  private at: { x: number; y: number } | null = null;
  private fresh = false;
  private inside = false;
  private busy = false;
  private queued: { x: number; y: number } | null = null;
  private lastKey = "";

  private readonly marker: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly edgeLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;

  /** 候補を探す対象。null ならこの機能は休む（選択ツールなど） */
  options: () => { models: boolean; cloud: boolean } | null = () => null;
  /** 探した候補に足すもの（軸を固定した計測の「軸上」など） */
  augment: ((list: SnapCandidate[], clientX: number, clientY: number) => SnapCandidate[]) | null = null;
  /** 今の候補が変わったとき（仮の線・座標表示を合わせる） */
  onChange: ((c: SnapCandidate | null) => void) | null = null;

  constructor(
    private readonly viewer: Viewer3D,
    private readonly picker: Picker,
  ) {
    this.marker = document.createElement("div");
    this.marker.className = "snap-marker hidden";
    this.tip = document.createElement("div");
    this.tip.className = "snap-tip hidden";
    viewer.container.append(this.marker, this.tip);
    this.edgeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x3ef08a, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.edgeLine.visible = false;
    viewer.overlay.add(this.edgeLine);
    // 候補の印は 3D の点に付いて動く（カメラを動かしても探し直すまで同じ点を指す）
    viewer.onAfterRender(() => this.place());
  }

  get active(): boolean {
    return this.options() !== null;
  }

  /** 今選ばれている候補（スナップ切・Alt ではフリーだけから選ぶ） */
  get current(): SnapCandidate | null {
    const v = this.visible();
    return v[Math.min(this.index, v.length - 1)] ?? null;
  }

  /** スナップしない状態（スナップ切・Alt 押下中）。軸への吸着もしない */
  get isFree(): boolean {
    return !this.enabled || this.freeHeld;
  }

  /** 候補はそのままで、仮表示だけ合わせ直す（Shift・軸の固定を変えたとき） */
  notify() {
    this.emit();
  }

  get count(): number {
    return this.visible().length;
  }

  private visible(): SnapCandidate[] {
    if (this.enabled && !this.freeHeld) return this.list;
    return this.list.filter((c) => c.kind === "free" || c.kind === "axis");
  }

  /** カーソルが動いた */
  request(clientX: number, clientY: number) {
    this.inside = true;
    this.queued = { x: clientX, y: clientY };
    if (!this.busy) void this.run();
  }

  /** 同じ位置で探し直す（カメラ・ツール・表示が変わったあと） */
  refresh() {
    if (this.at && this.inside) this.request(this.at.x, this.at.y);
    else this.emit();
  }

  /** カーソルが 3D 画面から出た・ドラッグを始めた */
  leave() {
    // すでに空なら何も変わらない（回転中の pointermove ごとに描き直させない）
    if (!this.inside && !this.queued && this.list.length === 0 && !this.sticky) {
      this.fresh = false;
      return;
    }
    this.inside = false;
    this.queued = null;
    this.list = [];
    this.index = 0;
    this.sticky = null;
    this.fresh = false;
    this.emit();
  }

  /** カメラが動いた。印は 3D の点に付いて動くが、クリックの前に探し直す */
  cameraMoved() {
    this.fresh = false;
  }

  /** Tab / Shift+Tab */
  cycle(dir: 1 | -1): boolean {
    const v = this.visible();
    if (v.length < 2) return false;
    this.index = (this.index + dir + v.length) % v.length;
    const c = v[this.index];
    this.sticky = { kind: c.kind, sx: c.sx, sy: c.sy };
    this.emit();
    return true;
  }

  setFreeHeld(on: boolean) {
    if (this.freeHeld === on) return;
    this.freeHeld = on;
    this.index = 0;
    this.sticky = null;
    this.emit();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    localStorage.setItem("snap", on ? "on" : "off");
    this.index = 0;
    this.sticky = null;
    this.emit();
  }

  /**
   * クリックした位置の点。画面に出ている候補がその位置のもの（3px 以内・カメラが動いていない）なら
   * それを使い、違えばその場で探して先頭（スナップ切・Alt ならフリー）を使う。
   */
  async resolve(clientX: number, clientY: number): Promise<SnapCandidate | null> {
    if (this.fresh && this.at && Math.hypot(clientX - this.at.x, clientY - this.at.y) <= 3) return this.current;
    const opt = this.options();
    if (!opt) return null;
    const list = await this.find(clientX, clientY, opt);
    this.apply({ x: clientX, y: clientY }, list);
    return this.current;
  }

  private async find(x: number, y: number, opt: { models: boolean; cloud: boolean }): Promise<SnapCandidate[]> {
    let list = await this.picker.candidates(x, y, opt);
    if (this.augment) list = this.augment(list, x, y);
    return list;
  }

  private async run() {
    this.busy = true;
    try {
      while (this.queued) {
        const q = this.queued;
        this.queued = null;
        const opt = this.options();
        if (!opt) {
          this.list = [];
          this.emit();
          continue;
        }
        const list = await this.find(q.x, q.y, opt).catch((e) => {
          console.warn(e);
          return [] as SnapCandidate[];
        });
        // 探している間に外へ出た・ツールを変えたら捨てる
        if (!this.inside || !this.options()) continue;
        this.apply(q, list);
      }
    } finally {
      this.busy = false;
    }
  }

  private apply(at: { x: number; y: number }, list: SnapCandidate[]) {
    this.at = at;
    this.fresh = true;
    this.list = list;
    this.index = 0;
    if (this.sticky) {
      const s = this.sticky;
      const v = this.visible();
      let best = -1;
      let bestD = 8;
      v.forEach((c, i) => {
        const d = Math.hypot(c.sx - s.sx, c.sy - s.sy);
        if (c.kind === s.kind && d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        this.index = best;
        this.sticky = { kind: s.kind, sx: v[best].sx, sy: v[best].sy };
      } else {
        this.sticky = null;
      }
    }
    this.emit();
  }

  private emit() {
    const c = this.inside && this.active ? this.current : null;
    this.updateTip(c);
    const edge = c?.edge && (c.kind === "edge" || c.kind === "midpoint") ? c.edge : null;
    this.edgeLine.visible = !!edge;
    if (edge) {
      const pos = this.edgeLine.geometry.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, edge[0].x, edge[0].y, edge[0].z);
      pos.setXYZ(1, edge[1].x, edge[1].y, edge[1].z);
      pos.needsUpdate = true;
      this.edgeLine.geometry.computeBoundingSphere();
      this.edgeLine.material.color.setHex(0x3ef08a);
    }
    this.onChange?.(c);
    this.viewer.requestRender();
    this.place();
  }

  private updateTip(c: SnapCandidate | null) {
    if (!c) {
      this.marker.classList.add("hidden");
      this.tip.classList.add("hidden");
      this.lastKey = "";
      return;
    }
    const key = `${c.kind}|${c.source}`;
    if (key !== this.lastKey) {
      this.marker.className = `snap-marker ${c.source} ${c.kind}`;
      this.marker.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${ICON[c.kind]}</svg>`;
      // 種類が変わったことが分かるよう、印を一瞬大きくする
      this.marker.animate([{ transform: "translate(-50%, -50%) scale(1.5)" }, { transform: "translate(-50%, -50%) scale(1)" }], {
        duration: 140,
        easing: "ease-out",
      });
      this.lastKey = key;
    }
    this.marker.classList.remove("hidden");
    const name = c.kind === "free" ? `フリー（${sourceLabel(c)}）` : c.kind === "axis" ? `軸上 ${c.detail ?? ""}` : `${SNAP_LABEL[c.kind]}${c.detail ? ` ${c.detail}` : ""}・${sourceLabel(c)}`;
    const n = this.count;
    const chip = !this.enabled ? "スナップ切（S）" : this.freeHeld ? "Alt: フリー" : n > 1 ? `${this.index + 1}/${n}  Tab` : "";
    this.tip.replaceChildren();
    const t = document.createElement("span");
    t.textContent = name;
    this.tip.append(t);
    if (chip) {
      const k = document.createElement("span");
      k.className = "chip";
      k.textContent = chip;
      this.tip.append(k);
    }
    this.tip.classList.remove("hidden");
  }

  /** 印を候補の 3D の点の画面位置へ */
  private place() {
    const c = this.inside && this.active ? this.current : null;
    if (!c) return;
    const s = this.picker.project(c.point);
    this.marker.style.translate = `${s.x.toFixed(1)}px ${s.y.toFixed(1)}px`;
    // 画面の端では反対側に出す
    const { width, height } = this.viewer.size;
    const tx = s.x + 14 + this.tip.offsetWidth > width ? s.x - 14 - this.tip.offsetWidth : s.x + 14;
    const ty = s.y + 12 + this.tip.offsetHeight > height ? s.y - 12 - this.tip.offsetHeight : s.y + 12;
    this.tip.style.translate = `${tx.toFixed(1)}px ${ty.toFixed(1)}px`;
  }
}
