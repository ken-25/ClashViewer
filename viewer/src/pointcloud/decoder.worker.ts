// 点群ノードのデコード（Potree 2.0 形式・圧縮なし）。octree.bin を範囲指定で読み、
// 位置をノードの最小点からの相対値（float32）に、色・強度を GPU 向けの配列にする。
//
// 形式は Potree（BSD-2-Clause, Markus Schütz）の OctreeLoader / DecoderWorker を参考にした。

export interface DecodeRequest {
  id: number;
  url: string;
  byteOffset: number;
  byteSize: number;
  numPoints: number;
  bytesPerPoint: number;
  positionOffset: number;
  rgbOffset: number; // -1 なら無し
  rgbShift: number; // 16bit 色なら 8
  intensityOffset: number; // -1 なら無し
  /** 位置・色・強度のほかに読む属性（分類・距離など。1 要素の数値だけ） */
  extras: ExtraAttributeLayout[];
  scale: [number, number, number];
  offset: [number, number, number];
  nodeMin: [number, number, number]; // 世界座標
}

/** 追加属性の読み方。type は metadata.json の型名 */
export interface ExtraAttributeLayout {
  name: string;
  offset: number;
  type: ExtraAttributeType;
}

export type ExtraAttributeType = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float" | "double";

export type ExtraArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array;

export interface DecodeResponse {
  id: number;
  position: Float32Array;
  color: Uint8Array | null;
  intensity: Uint16Array | null;
  /** 属性名 → 点ごとの値（double は float32 に落とす） */
  extras: Record<string, ExtraArray>;
  error?: string;
}

function readExtra(view: DataView, n: number, stride: number, a: ExtraAttributeLayout): ExtraArray {
  const o = a.offset;
  switch (a.type) {
    case "int8": { const r = new Int8Array(n); for (let i = 0; i < n; i++) r[i] = view.getInt8(i * stride + o); return r; }
    case "uint8": { const r = new Uint8Array(n); for (let i = 0; i < n; i++) r[i] = view.getUint8(i * stride + o); return r; }
    case "int16": { const r = new Int16Array(n); for (let i = 0; i < n; i++) r[i] = view.getInt16(i * stride + o, true); return r; }
    case "uint16": { const r = new Uint16Array(n); for (let i = 0; i < n; i++) r[i] = view.getUint16(i * stride + o, true); return r; }
    case "int32": { const r = new Int32Array(n); for (let i = 0; i < n; i++) r[i] = view.getInt32(i * stride + o, true); return r; }
    case "uint32": { const r = new Uint32Array(n); for (let i = 0; i < n; i++) r[i] = view.getUint32(i * stride + o, true); return r; }
    case "float": { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = view.getFloat32(i * stride + o, true); return r; }
    case "double": { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = view.getFloat64(i * stride + o, true); return r; }
  }
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const q = e.data;
  try {
    const end = q.byteOffset + q.byteSize - 1;
    const r = await fetch(q.url, { headers: { Range: `bytes=${q.byteOffset}-${end}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`octree.bin を読めません（${r.status}）`);
    let buf = await r.arrayBuffer();
    if (r.status === 200) buf = buf.slice(q.byteOffset, q.byteOffset + q.byteSize);
    const view = new DataView(buf);
    const n = Math.min(q.numPoints, Math.floor(buf.byteLength / q.bytesPerPoint));
    const position = new Float32Array(n * 3);
    const [sx, sy, sz] = q.scale;
    const ox = q.offset[0] - q.nodeMin[0];
    const oy = q.offset[1] - q.nodeMin[1];
    const oz = q.offset[2] - q.nodeMin[2];
    for (let i = 0; i < n; i++) {
      const p = i * q.bytesPerPoint + q.positionOffset;
      position[i * 3] = view.getInt32(p, true) * sx + ox;
      position[i * 3 + 1] = view.getInt32(p + 4, true) * sy + oy;
      position[i * 3 + 2] = view.getInt32(p + 8, true) * sz + oz;
    }
    let color: Uint8Array | null = null;
    if (q.rgbOffset >= 0) {
      color = new Uint8Array(n * 4);
      const sh = q.rgbShift;
      for (let i = 0; i < n; i++) {
        const p = i * q.bytesPerPoint + q.rgbOffset;
        color[i * 4] = view.getUint16(p, true) >> sh;
        color[i * 4 + 1] = view.getUint16(p + 2, true) >> sh;
        color[i * 4 + 2] = view.getUint16(p + 4, true) >> sh;
        color[i * 4 + 3] = 255;
      }
    }
    let intensity: Uint16Array | null = null;
    if (q.intensityOffset >= 0) {
      intensity = new Uint16Array(n);
      for (let i = 0; i < n; i++) intensity[i] = view.getUint16(i * q.bytesPerPoint + q.intensityOffset, true);
    }
    const extras: Record<string, ExtraArray> = {};
    for (const a of q.extras) extras[a.name] = readExtra(view, n, q.bytesPerPoint, a);
    const res: DecodeResponse = { id: q.id, position, color, intensity, extras };
    const transfer: Transferable[] = [position.buffer];
    if (color) transfer.push(color.buffer);
    if (intensity) transfer.push(intensity.buffer);
    for (const v of Object.values(extras)) transfer.push(v.buffer);
    (self as unknown as Worker).postMessage(res, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: q.id, position: new Float32Array(0), color: null, intensity: null, extras: {}, error: String(err) });
  }
};
