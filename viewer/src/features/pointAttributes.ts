// 点の属性の表示（分類・値の色分けと、分類ごとの表示切替）。
// 点群の追加属性（PotreePointCloud.extraAttributes）を、選んだ色の方法に合わせて読み、シェーダーへ渡す。
//
// 読む属性は次の和（読む属性が増えるとメモリと読込量が増えるので、使うものだけにする）
// - config/app.json の pointcloud.extraAttributes（いつも読む）
// - 分類で色分け・分類を隠している: 分類の属性（classification）
// - 値で色分け: 選んだ属性
// 色の方法と選んだ属性はこの PC に覚え、次に版を開くときは最初から読む（開いた後の読み直しを避ける）。

import type { App } from "../app";
import type { Manifest } from "../data/dataset";
import { classInfo, classTable, parseClassOverrides, type PointClassInfo } from "../data/pointClasses";
import { ColorMode } from "../pointcloud/material";
import type { PointAttributeInfo } from "../pointcloud/potree";
import type { AppFeature } from "./feature";

/** 分類として扱う属性の名前（LAS の classification） */
export const CLASSIFICATION = "classification";

const STORE = "pointAttributes";

interface Stored {
  colorMode?: ColorMode;
  scalar?: string;
}

export interface ClassRow extends PointClassInfo {
  /** 版の manifest に記録した点数（新しい版を作る処理が数えたもの）。無ければ null */
  count: number | null;
  hidden: boolean;
}

export class PointAttributes implements AppFeature {
  /** 値の色に使う属性（点群に無ければ null） */
  scalar: string | null = null;
  /** 値の色の帯の範囲（属性の最小・最大が既定） */
  scalarRange: [number, number] = [0, 1];
  /** 非表示の分類 */
  readonly hidden = new Set<number>();
  private stored: Stored;

  constructor(private readonly app: App) {
    try {
      this.stored = JSON.parse(localStorage.getItem(STORE) ?? "{}") ?? {};
    } catch {
      this.stored = {};
    }
  }

  private get overrides() {
    return parseClassOverrides(this.app.ctx?.config?.pointcloud?.classes);
  }

  /** 設定でいつも読む属性 */
  private configAttributes(): string[] {
    const a = this.app.ctx?.config?.pointcloud?.extraAttributes;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  }

  /** 版を開くときに読む追加属性（PotreePointCloud.load の extraAttributes） */
  wantedOnOpen(): string[] {
    const s = new Set(this.configAttributes());
    if (this.stored.colorMode === ColorMode.Classification) s.add(CLASSIFICATION);
    if (this.stored.colorMode === ColorMode.Scalar && this.stored.scalar) s.add(this.stored.scalar);
    return [...s];
  }

  /** 分類の属性があるか */
  get hasClasses(): boolean {
    return !!this.app.pc?.attributes.some((a) => a.name === CLASSIFICATION);
  }

  /** 値の色に使える属性（分類と、位置・色・強度を除く 1 要素の数値。全点が同じ値の属性は色分けにならないので出さない） */
  get scalarCandidates(): PointAttributeInfo[] {
    return this.app.pc?.attributes.filter((a) => a.name !== CLASSIFICATION && a.max > a.min) ?? [];
  }

  get colorMode(): ColorMode {
    return (this.app.pc?.material.uniforms.uColorMode.value as ColorMode) ?? ColorMode.RGB;
  }

  onClose() {
    this.hidden.clear();
    this.scalar = null;
  }

  onOpen(_m: Manifest) {
    const pc = this.app.pc;
    if (!pc) return;
    pc.onClassesSeen = () => this.app.emit("display");
    const mode = this.stored.colorMode;
    const scalar = this.stored.scalar && pc.attributes.some((a) => a.name === this.stored.scalar) ? this.stored.scalar : this.scalarCandidates[0]?.name ?? null;
    this.scalar = scalar;
    this.resetScalarRange();
    if (mode === ColorMode.Classification && this.hasClasses) this.setColorMode(ColorMode.Classification);
    else if (mode === ColorMode.Scalar && scalar) this.setColorMode(ColorMode.Scalar);
    else this.apply();
  }

  /** 色の方法を変える（分類・値は要る属性を読み直す） */
  setColorMode(mode: ColorMode) {
    const pc = this.app.pc;
    if (!pc) return;
    if (mode === ColorMode.Classification && !this.hasClasses) mode = ColorMode.RGB;
    if (mode === ColorMode.Scalar && !this.scalar) mode = ColorMode.RGB;
    pc.setColorMode(mode);
    this.stored.colorMode = mode;
    this.save();
    this.apply();
  }

  /** 値の色に使う属性を変える（範囲は属性の最小・最大に戻す） */
  setScalar(name: string) {
    if (!this.app.pc?.attributes.some((a) => a.name === name)) return;
    this.scalar = name;
    this.stored.scalar = name;
    this.save();
    this.resetScalarRange();
    this.apply();
  }

  setScalarRange(lo: number, hi: number) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    this.scalarRange = lo <= hi ? [lo, hi] : [hi, lo];
    this.apply();
  }

  resetScalarRange() {
    const a = this.app.pc?.attributes.find((x) => x.name === this.scalar);
    this.scalarRange = a ? [a.min, a.max > a.min ? a.max : a.min + 1] : [0, 1];
  }

  setClassHidden(code: number, hidden: boolean) {
    if (hidden) this.hidden.add(code);
    else this.hidden.delete(code);
    this.apply();
  }

  showAllClasses() {
    this.hidden.clear();
    this.apply();
  }

  /** 分類の一覧（manifest の点数と、読み込んだ点に現れた分類の和。番号順） */
  classes(): ClassRow[] {
    const m = this.app.current;
    const counts = m?.pointcloud?.classCounts ?? null;
    const codes = new Set<number>();
    if (counts) for (const k of Object.keys(counts)) codes.add(Number(k));
    for (const k of this.app.pc?.classHistogram.keys() ?? []) codes.add(k);
    for (const k of this.hidden) codes.add(k);
    const ov = this.overrides;
    return [...codes].sort((a, b) => a - b).map((code) => ({
      ...classInfo(code, ov),
      count: counts ? counts[String(code)] ?? 0 : null,
      hidden: this.hidden.has(code),
    }));
  }

  /** 今の選択に合わせて、読む属性・シェーダーの属性・色の表を揃える */
  private apply() {
    const pc = this.app.pc;
    if (!pc) return;
    const mode = this.colorMode;
    const useClass = this.hasClasses && (mode === ColorMode.Classification || this.hidden.size > 0);
    const useScalar = mode === ColorMode.Scalar && !!this.scalar;
    const want = new Set(this.configAttributes());
    if (useClass) want.add(CLASSIFICATION);
    if (useScalar) want.add(this.scalar!);
    pc.setExtraAttributes([...want]);
    pc.setClassAttribute(useClass ? CLASSIFICATION : null);
    pc.setScalarAttribute(useScalar ? this.scalar : null, this.scalarRange);
    pc.setClassTable(classTable(this.hidden, this.overrides), this.hidden);
    pc.invalidate();
    this.app.viewer.requestRender();
    // クリック・スナップの候補も変わる（隠した分類の点は拾わない）
    this.app.snap.refresh();
    this.app.emit("display");
  }

  private save() {
    localStorage.setItem(STORE, JSON.stringify(this.stored));
  }
}
