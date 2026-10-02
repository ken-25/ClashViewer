import { h } from "./dom";

export interface RangeSliderOptions {
  label: string;
  lo: number;
  hi: number;
  /** 最小と最大の最小の間隔 */
  minGap: number;
  get: () => { min: number; max: number };
  set: (min: number, max: number) => void;
  /** 値の横に出す文字（幅など） */
  format?: (min: number, max: number) => string;
}

export interface RangeSlider {
  el: HTMLElement;
  /** 外から値が変わったとき（3D で面を動かした等）に表示を合わせる */
  sync: () => void;
}

/** つまみをこの距離（px）以内で押したら、そのつまみを掴む */
const GRAB_PX = 8;

/**
 * 最小と最大を 1 本に収めた範囲スライダー。
 * つまみをドラッグ: その端だけ動かす。つまみの間（帯）をドラッグ: 幅を保ったまま両端を動かす。
 * 帯の外を押す: 近い方のつまみがそこへ移り、そのままドラッグできる。
 * キーボード: 矢印で動かす（Shift で 10 倍）、Home / End で端へ。
 */
export function rangeSlider(o: RangeSliderOptions): RangeSlider {
  const span = Math.max(o.hi - o.lo, 1e-9);
  const keyStep = span / 200;
  const fill = h("div", { class: "rs-fill" });
  const mkThumb = (which: "min" | "max") =>
    h("div", {
      class: `rs-thumb rs-${which}`,
      role: "slider",
      tabindex: "0",
      "aria-label": `${o.label} ${which === "min" ? "最小" : "最大"}`,
      "aria-valuemin": String(o.lo),
      "aria-valuemax": String(o.hi),
    });
  const tMin = mkThumb("min");
  const tMax = mkThumb("max");
  const track = h("div", { class: "rs-track" }, fill, tMin, tMax);
  const value = h("span", { class: "rs-value" });
  const el = h("div", { class: "rs row small", role: "group", "aria-label": `${o.label} の範囲` }, h("label", null, o.label), track, value);

  const pct = (v: number) => Math.min(100, Math.max(0, ((v - o.lo) / span) * 100));
  const sync = () => {
    const { min, max } = o.get();
    const a = pct(min);
    const b = pct(max);
    tMin.style.left = `${a}%`;
    tMax.style.left = `${b}%`;
    fill.style.left = `${a}%`;
    fill.style.width = `${Math.max(0, b - a)}%`;
    tMin.setAttribute("aria-valuenow", min.toFixed(2));
    tMax.setAttribute("aria-valuenow", max.toFixed(2));
    value.textContent = o.format ? o.format(min, max) : `${min.toFixed(2)} – ${max.toFixed(2)}`;
  };

  /** 値を範囲内に収めて渡す。which: 動かした端（both は帯ごと） */
  const commit = (which: "min" | "max" | "both", a: number, b: number) => {
    const cur = o.get();
    let min = cur.min;
    let max = cur.max;
    if (which === "min") min = Math.min(Math.max(a, Math.min(o.lo, cur.min)), max - o.minGap);
    else if (which === "max") max = Math.max(Math.min(b, Math.max(o.hi, cur.max)), min + o.minGap);
    else {
      const w = b - a;
      min = Math.min(Math.max(a, o.lo), o.hi - w);
      max = min + w;
    }
    o.set(min, max);
    sync();
  };

  const valueAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return o.lo + ((clientX - r.left) / Math.max(r.width, 1)) * span;
  };

  let drag: { which: "min" | "max" | "both"; v0: number; min0: number; max0: number; id: number } | null = null;
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = track.getBoundingClientRect();
    const { min, max } = o.get();
    const xMin = r.left + (pct(min) / 100) * r.width;
    const xMax = r.left + (pct(max) / 100) * r.width;
    const dMin = Math.abs(e.clientX - xMin);
    const dMax = Math.abs(e.clientX - xMax);
    let which: "min" | "max" | "both";
    if (Math.min(dMin, dMax) <= GRAB_PX) {
      // 重なっているときは、押した位置が中点のどちら側かで決める
      which = dMin < dMax ? "min" : dMax < dMin ? "max" : e.clientX < (xMin + xMax) / 2 ? "min" : "max";
    } else if (e.clientX > xMin && e.clientX < xMax) which = "both";
    else which = dMin < dMax ? "min" : "max";
    const v = valueAt(e.clientX);
    drag = { which, v0: v, min0: min, max0: max, id: e.pointerId };
    track.setPointerCapture(e.pointerId);
    (which === "max" ? tMax : tMin).focus({ preventScroll: true });
    track.classList.add("dragging");
    if (which !== "both") commit(which, v, v);
  });
  track.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const v = valueAt(e.clientX);
    if (drag.which === "both") {
      const dv = v - drag.v0;
      commit("both", drag.min0 + dv, drag.max0 + dv);
    } else commit(drag.which, v, v);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    track.classList.remove("dragging");
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  const onKey = (which: "min" | "max") => (e: KeyboardEvent) => {
    const { min, max } = o.get();
    const cur = which === "min" ? min : max;
    const step = keyStep * (e.shiftKey ? 10 : 1);
    let v: number;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        v = cur - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        v = cur + step;
        break;
      case "PageDown":
        v = cur - step * 10;
        break;
      case "PageUp":
        v = cur + step * 10;
        break;
      case "Home":
        v = o.lo;
        break;
      case "End":
        v = o.hi;
        break;
      default:
        return;
    }
    e.preventDefault();
    commit(which, v, v);
  };
  tMin.addEventListener("keydown", onKey("min"));
  tMax.addEventListener("keydown", onKey("max"));

  sync();
  return { el, sync };
}
