import { h, mount } from "./dom";

/** 操作キーの一覧（ツールバーの「?」・F1）。キーの説明はここに集め、案内文には今の手順で使うキーだけを出す */
const SECTIONS: { title: string; rows: [string[], string][] }[] = [
  {
    title: "3D 画面",
    rows: [
      [["左ドラッグ"], "カーソル下を中心に回転"],
      [["右ドラッグ", "中ドラッグ", "Ctrl/Shift+左ドラッグ"], "平行移動"],
      [["ホイール"], "カーソル下の物に向かって寄る・離れる"],
      [["ダブルクリック"], "そこを回転の中心にする"],
      [["P"], "平行投影と透視を切り替える"],
    ],
  },
  {
    title: "ツール共通",
    rows: [
      [["Esc"], "ツールを終えて選択に戻る（開いているメニューがあれば先に閉じる）"],
      [["Tab", "Shift+Tab"], "スナップ候補を切り替える"],
      [["Alt"], "押している間はスナップしない（フリー）"],
      [["S"], "スナップのオン・オフ"],
    ],
  },
  {
    title: "計測",
    rows: [
      [["X", "Y", "Z"], "その軸の方向だけを測る（もう一度で解除）"],
      [["Shift"], "押している間、いちばん大きく動いた軸に固定"],
      [["Esc"], "距離: 1点目を取り消す／折れ線: そこまでで確定。もう一度で終了"],
      [["Enter", "ダブルクリック"], "折れ線を確定"],
      [["Backspace"], "折れ線の 1 点を戻す"],
    ],
  },
  {
    title: "切断ボックス",
    rows: [
      [["ドラッグ"], "手前の面を動かす"],
      [["Shift+ドラッグ"], "奥の面（箱の内側）を動かす"],
    ],
  },
  {
    title: "その他",
    rows: [[["F1", "?"], "この一覧を開く"]],
  },
];

export function openHelp() {
  const dlg = document.getElementById("dlg-help") as HTMLDialogElement;
  if (dlg.open) return;
  mount(
    dlg,
    h("h2", null, "操作キーの一覧"),
    SECTIONS.map((s) =>
      h(
        "section",
        { class: "help-section" },
        h("h3", null, s.title),
        h("table", { class: "help-keys" },
          s.rows.map(([keys, text]) =>
            h("tr", null,
              h("td", null, keys.map((k, i) => [i ? " / " : "", h("kbd", null, k)])),
              h("td", null, text)))),
      ),
    ),
    h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => dlg.close() }, "閉じる")),
  );
  dlg.showModal();
}
