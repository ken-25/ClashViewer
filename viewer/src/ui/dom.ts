// 小さな DOM ヘルパー（フレームワークを使わない）

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k in el && typeof v !== "string") (el as any)[k] = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el: HTMLElement, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`要素がありません: ${sel}`);
  return el as HTMLElement;
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  return `${Math.floor(sec / 3600)} 時間 ${Math.round((sec % 3600) / 60)} 分`;
}

/** 簡易メッセージ（alert の代わり。WebView2 の既定ダイアログは見た目がそろわない） */
export function showMessage(title: string, body: string | Node, buttons: { label: string; value: string; primary?: boolean }[] = [{ label: "閉じる", value: "ok", primary: true }]): Promise<string> {
  const dlg = document.getElementById("dlg-message") as HTMLDialogElement;
  return new Promise((resolve) => {
    mount(
      dlg,
      h("h2", null, title),
      typeof body === "string" ? h("div", { style: "white-space:pre-wrap" }, body) : body,
      h(
        "div",
        { class: "actions" },
        buttons.map((b) =>
          h("button", { class: b.primary ? "primary" : "", onclick: () => { dlg.close(); resolve(b.value); } }, b.label),
        ),
      ),
    );
    dlg.onclose = () => resolve("cancel");
    dlg.showModal();
  });
}

export async function confirmDialog(title: string, body: string, ok = "OK"): Promise<boolean> {
  return (await showMessage(title, body, [
    { label: "やめる", value: "cancel" },
    { label: ok, value: "ok", primary: true },
  ])) === "ok";
}
