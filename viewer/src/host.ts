// exe（WebView2 ホスト）との通信。RPC は postMessage、データの読み書きは https://cv.local/ への fetch。

export interface LocalFile {
  token: string;
  name: string;
  path: string;
  size: number;
  kind: "e57" | "ifc" | "other";
  url: string;
}

export interface Member {
  id: string;
  name: string;
}

export interface HostContext {
  user: string;
  displayName: string;
  members: Member[];
  root: string;
  dev: boolean;
  appVersion: string;
  config: Record<string, any>;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

interface WebView {
  postMessage(msg: unknown): void;
  postMessageWithAdditionalObjects(msg: unknown, objs: ArrayLike<unknown>): void;
  addEventListener(type: "message", cb: (e: MessageEvent) => void): void;
}

const webview: WebView | undefined = (window as any).chrome?.webview;
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(data: any) => void>>();
let nextId = 1;

webview?.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data;
  if (msg && typeof msg.id === "number" && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } else if (msg && typeof msg.event === "string") {
    listeners.get(msg.event)?.forEach((cb) => cb(msg.data));
  }
});

export const isHosted = !!webview;

export function call<T = any>(method: string, params: Record<string, unknown> = {}, extra?: ArrayLike<unknown>): Promise<T> {
  if (!webview) return Promise.reject(new Error("干渉ビューア.exe から開いてください"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const msg = { id, method, params };
    if (extra) webview.postMessageWithAdditionalObjects(msg, extra);
    else webview.postMessage(msg);
  });
}

export function on(event: string, cb: (data: any) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)!.delete(cb);
}

/** 共有フォルダ相対パスの URL */
export function dataUrl(rel: string): string {
  return "/data/" + rel.split("/").map(encodeURIComponent).join("/");
}

export async function fetchJson<T = any>(rel: string): Promise<T> {
  const r = await fetch(dataUrl(rel), { cache: "no-cache" });
  if (!r.ok) throw new Error(`${rel} を読めません（${r.status}）`);
  return r.json();
}

export async function fetchBytes(rel: string): Promise<ArrayBuffer> {
  const r = await fetch(dataUrl(rel));
  if (!r.ok) throw new Error(`${rel} を読めません（${r.status}）`);
  return r.arrayBuffer();
}

/** 範囲読み。end は含まない（[start, end)）。 */
export async function fetchRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (r.status !== 206 && r.status !== 200) throw new Error(`範囲読みに失敗しました（${r.status}）`);
  const buf = await r.arrayBuffer();
  if (r.status === 200) return buf.slice(start, end); // Range 非対応の応答（懸念2）
  return buf;
}

/** 取込中データセット・指摘画像へ書く */
export async function writeFile(rel: string, body: ArrayBuffer | Uint8Array | Blob | string): Promise<{ path: string; size: number }> {
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const r = await fetch(`/api/write?path=${encodeURIComponent(rel)}`, { method: "PUT", body: data as BodyInit });
  if (!r.ok) throw new Error(`${rel} に書けません: ${await r.text()}`);
  return r.json();
}

export const host = {
  getContext: () => call<HostContext>("getContext"),
  setMyName: (name: string) => call<HostContext>("setMyName", { name }),
  listDatasets: () => call<any[]>("listDatasets"),
  pickFiles: () => call<LocalFile[]>("pickFiles"),
  dropFiles: (files: FileList) => call<LocalFile[]>("dropFiles", {}, files),
  devRegisterPaths: (paths: string[]) => call<LocalFile[]>("devRegisterPaths", { paths }),
  importBegin: (name: string) => call<{ id: string; folder: string; dir: string }>("importBegin", { name }),
  importPointcloud: (id: string, tokens: string[]) => call<any>("importPointcloud", { id, tokens }),
  importCarry: (id: string, files: { folder: string; rel: string }[], task: string) =>
    call<{ files: number; bytes: number }>("importCarry", { id, files, task }),
  importFinish: (id: string, manifest: any) => call<any>("importFinish", { id, manifest }),
  importAbort: (id: string) => call<boolean>("importAbort", { id }),
  updateAlignment: (folder: string, alignment: any) => call<any>("updateAlignment", { folder, alignment }),
  eventsAppend: (event: any) => call<any>("eventsAppend", { event }),
  eventsRead: (offsets: Record<string, number> | null) =>
    call<{ events: any[]; offsets: Record<string, number> }>("eventsRead", { offsets }),
  openDevTools: () => call("openDevTools"),
};
