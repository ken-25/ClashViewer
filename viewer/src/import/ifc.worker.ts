// IFC → Fragments の変換（That Open IfcImporter / web-ifc）。画面を止めないようワーカーで動かす。
// あわせて、形状を持つはずの要素の一覧（取込ログの突き合わせ用）とジオリファレンスを web-ifc で読む。

import * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";

export interface IfcConvertRequest {
  url: string;
  name: string;
}

export interface IfcInventory {
  schema: string;
  application: string;
  unitScale: number; // 長さの単位 → m
  products: { guid: string; cls: string; name: string }[]; // 形状表現を持つ表示対象の要素
  mapConversion: {
    eastings: number;
    northings: number;
    orthogonalHeight: number;
    xAxisAbscissa: number;
    xAxisOrdinate: number;
    scale: number;
    mapUnitScale: number; // 地図座標の単位 → m
    crsName: string | null;
  } | null;
}

export type IfcWorkerMessage =
  | { type: "progress"; stage: string; done: number; total: number; message?: string }
  | { type: "done"; frag: Uint8Array; inventory: IfcInventory; seconds: number }
  | { type: "error"; message: string };

// 形状を表示しない（無くても取込失敗にしない）クラス
const NON_DISPLAY = new Set([
  "IFCOPENINGELEMENT",
  "IFCOPENINGSTANDARDCASE",
  "IFCSPACE",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPATIALZONE",
  "IFCANNOTATION",
  "IFCGRID",
  "IFCVIRTUALELEMENT",
  "IFCPROJECT",
  "IFCEXTERNALSPATIALELEMENT",
]);

const post = (m: IfcWorkerMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function val(v: any): any {
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

function lengthUnitScale(api: WEBIFC.IfcAPI, modelID: number, unitRef?: any): number {
  // IfcSIUnit（LENGTHUNIT）の接頭辞から m への倍率を求める
  const prefix: Record<string, number> = { MILLI: 0.001, CENTI: 0.01, DECI: 0.1, KILO: 1000 };
  const fromUnit = (u: any): number | null => {
    if (!u) return null;
    if (u.type === WEBIFC.IFCSIUNIT && val(u.UnitType) === "LENGTHUNIT") return prefix[val(u.Prefix)] ?? 1;
    if (u.type === WEBIFC.IFCCONVERSIONBASEDUNIT && val(u.UnitType) === "LENGTHUNIT") {
      const f = api.GetLine(modelID, val(u.ConversionFactor));
      const v = api.GetLine(modelID, val(f.ValueComponent)) ?? f.ValueComponent;
      const base = api.GetLine(modelID, val(f.UnitComponent));
      return Number(val(v) ?? val(f.ValueComponent)) * (fromUnit(base) ?? 1);
    }
    return null;
  };
  if (unitRef) {
    const s = fromUnit(api.GetLine(modelID, val(unitRef)));
    if (s) return s;
  }
  const ids = api.GetLineIDsWithType(modelID, WEBIFC.IFCUNITASSIGNMENT);
  for (let i = 0; i < ids.size(); i++) {
    const ua = api.GetLine(modelID, ids.get(i));
    for (const u of ua.Units ?? []) {
      const s = fromUnit(api.GetLine(modelID, val(u)));
      if (s) return s;
    }
  }
  return 1;
}

function inventory(api: WEBIFC.IfcAPI, bytes: Uint8Array): IfcInventory {
  const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  try {
    const schema = api.GetModelSchema(id);
    let application = "";
    try {
      const fileName = api.GetHeaderLine(id, WEBIFC.FILE_NAME);
      const args = fileName?.arguments ?? [];
      application = [val(args[5]), val(args[4])].filter((s) => s && String(s).trim()).join(" / ");
    } catch {
      // ヘッダーが壊れていても続ける
    }
    const unitScale = lengthUnitScale(api, id);
    const products: IfcInventory["products"] = [];
    const ids = api.GetLineIDsWithType(id, WEBIFC.IFCPRODUCT, true);
    for (let i = 0; i < ids.size(); i++) {
      const line = api.GetLine(id, ids.get(i));
      if (!line?.Representation) continue;
      const cls = api.GetNameFromTypeCode(line.type);
      if (NON_DISPLAY.has(cls.toUpperCase())) continue;
      products.push({ guid: val(line.GlobalId), cls, name: String(val(line.Name) ?? "") });
    }
    let mapConversion: IfcInventory["mapConversion"] = null;
    const mc = api.GetLineIDsWithType(id, WEBIFC.IFCMAPCONVERSION);
    if (mc.size() > 0) {
      const m = api.GetLine(id, mc.get(0));
      let mapUnitScale = unitScale;
      let crsName: string | null = null;
      const crs = m.TargetCRS ? api.GetLine(id, val(m.TargetCRS)) : null;
      if (crs) {
        crsName = val(crs.Name) ?? null;
        if (crs.MapUnit) mapUnitScale = lengthUnitScale(api, id, crs.MapUnit);
      }
      mapConversion = {
        eastings: Number(val(m.Eastings) ?? 0),
        northings: Number(val(m.Northings) ?? 0),
        orthogonalHeight: Number(val(m.OrthogonalHeight) ?? 0),
        xAxisAbscissa: Number(val(m.XAxisAbscissa) ?? 1),
        xAxisOrdinate: Number(val(m.XAxisOrdinate) ?? 0),
        scale: Number(val(m.Scale) ?? 1),
        mapUnitScale,
        crsName,
      };
    }
    return { schema, application, unitScale, products, mapConversion };
  } finally {
    api.CloseModel(id);
  }
}

self.onmessage = async (e: MessageEvent<IfcConvertRequest>) => {
  const t0 = performance.now();
  try {
    post({ type: "progress", stage: "read", done: 0, total: 1, message: `${e.data.name} を読込中` });
    const r = await fetch(e.data.url);
    if (!r.ok) throw new Error(`${e.data.name} を読めません（${r.status}）`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    post({ type: "progress", stage: "read", done: 1, total: 1 });

    const wasmPath = `${self.location.origin}/wasm/`;
    const api = new WEBIFC.IfcAPI();
    api.SetWasmPath(wasmPath, true);
    await api.Init();
    post({ type: "progress", stage: "inventory", done: 0, total: 1, message: "要素の一覧を作成中" });
    const inv = inventory(api, bytes);
    api.Dispose?.();
    post({ type: "progress", stage: "inventory", done: 1, total: 1 });

    const importer = new FRAGS.IfcImporter();
    importer.wasm = { path: wasmPath, absolute: true };
    let last = 0;
    const frag = await importer.process({
      bytes,
      raw: false,
      progressCallback: (p: number, d: FRAGS.ProgressData) => {
        const now = performance.now();
        if (now - last < 200 && p < 1) return;
        last = now;
        const label = { geometries: "形状", attributes: "属性", relations: "関係", conversion: "変換" }[d.process] ?? d.process;
        post({ type: "progress", stage: "convert", done: p, total: 1, message: `${label}${d.class ? `（${d.class}）` : ""}` });
      },
    });
    post({ type: "done", frag, inventory: inv, seconds: (performance.now() - t0) / 1000 }, [frag.buffer]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
