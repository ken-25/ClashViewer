# 3D施工検討Viewer Kasane PoC 結果（2026-10-01）

要件定義.md の 6 章の機能を一通り実装し、E2E テスト（実際の exe を起動して WebView2 を操作）で動作を確認した。
実データ（E57・Revit 以外の IFC）はまだ無いため、公開サンプル IFC とそこから合成した点群で測っている。

## 動かし方

```
scripts/fetch-third-party.ps1   # 初回だけ（PotreeConverter 2.1.5 を取得）
scripts/build.ps1               # dist/ に配布一式を作る（アプリ一式 181 MB）
scripts/run.ps1                 # dist/ の exe を dev/share のデータで起動
```

| 場所 | 内容 |
|---|---|
| `app/Kasane.Host` | exe（.NET 10 / WinForms / WebView2、ランタイム同梱の単一ファイル 50 MB） |
| `viewer/` | 画面（three.js 0.186 / Fragments 3.4.7 / web-ifc 0.0.77）。Potree 2.0 ローダーは `src/pointcloud` に自前実装 |
| `converter/` | 変換エンジン（uv 管理、PyInstaller で `tools/converter/` に 56 MB） |
| `e2e/` | `smoke.mjs`（Range・書込権限）、`import.mjs`（取込）、`features.mjs`（全機能・2 人分）、`perf.mjs`（性能） |
| `viewer/tests` | 差分・3点合わせ・指摘の単体テスト（`npm test`） |

## 要件どおりでない・追加で決めたこと

- IFC の変換は converter.exe ではなく画面側のワーカー（web-ifc）で行う。That Open の IfcImporter が JS なので Python 側に置く意味がない。
- 新しい版で点群・モデルを差し替えない場合は、前の版のファイルを新しい版のフォルダへ複製する（版どうしでファイルを共有しないので、古い版を消しても新しい版は開ける）。複製は exe が行い、進捗に出す。2,000 万点（540 MB）の複製を含む取込で 31 秒。
- 差分用に `model/<名前>.elements.json`（要素ごとの GlobalId・外形・属性の署名）を保存する。
- 利用者は Windows のログオン名で識別し、表示名は `config/members/` に置く。
- GPU が 2 つある PC では外部 GPU を使う（WebView2 は既定で内蔵 GPU を選んでいた）。

## 懸念点の結果

| # | 結果 |
|---|---|
| 1 Box Drive | **未確認**（利用者が実施する）。`e2e/perf.mjs <フォルダ> --root <Box 上の共有フォルダ>` で同じ項目を測れる |
| 2 Range | 自前の応答（`WebResourceRequested`）・仮想ホスト割り当てのどちらも 206 で応える。アクセス範囲を制限できるので自前の応答を採用 |
| 3 IFC の品質 | Revit 2021・2024・SketchUp の IFC で、表示対象の要素は 100% 取り込めた（形状が無いのは開口要素だけ）。IfcOpenShell による補完は今のところ不要。Rebro / Tfas / CADWe'll / ArchiCAD は未検証 |
| 4 座標のずれ | 測量座標へ 23.5° 回転・約 37 km 移動した点群に対し、3点合わせ（水平を保つ）で回転誤差 0.006°、建物中心で 31 mm。点群・モデルの範囲が重ならないときは取込時に警告を出す。IfcMapConversion があれば自動で使う |
| 5 点群描画 | 1 億点（octree.bin 2.7 GB）で初回表示 3 秒。描画は 1 フレーム 1〜4 ms。カメラを 40 回動かしても読込済みは約 750 万点で頭打ちになり、メモリは増え続けない |
| 6 変換エンジン | PyInstaller の onedir で 56 MB（IfcOpenShell を含めないので数百 MB にはならない）。この PC はウイルス対策が動いていないため誤検知は確認できない。Nuitka は未比較 |
| 7 取込時間 | 200 万点 6 秒、2,000 万点 42 秒、1 億点 3 分 7 秒（読込 83 秒・LOD 化 104 秒）。保存サイズは 1 点 27 バイトで、50 GB の上限は約 18 億点 |
| 8 同時取込 | ID 付きフォルダ・作業用フォルダから改名で公開・`ready` だけを一覧に出す、を実装。同時に取り込む試験はしていない |
| 9 描画性能 | 内蔵 GPU（Intel UHD）でも既定の 300 万点なら近接表示で 1.5 ms。既定値 300 万点のままでよい |
| 10 距離色分け | 第 2 段階のため未着手 |

計測 PC: Core 24 スレッド / 64 GB / RTX A3000 Laptop + Intel UHD / ローカル SSD。

## 決めたこと（2026-10-01 相談）

1. 版を引き継ぐときは複製する（古い版を消すことがあるため。Box の総容量は無制限、1 ファイル 50 GB まで）。
2. Box Drive での計測は利用者が行う。
3. 3点合わせは誰でも行ってよい（前の値は manifest の `alignmentHistory` に残る）。
4. 実データ（Rebro / Tfas / CADWe'll / ArchiCAD の IFC、実際の E57）での確認は後日。

## 残っていること

- 実データでの確認（懸念 3・7）、Box Drive での計測（懸念 1）、ウイルス対策・Nuitka の確認（懸念 6）、同時取込の試験（懸念 8）。
- 取込中に exe を強制終了すると `datasets/.importing/<ID>/` が残る。一覧には出ないが、自動では消えない（手で消す）。
- PoC 初期に作った `20261001_改修A棟_baa52c` は前の版のファイルを参照する形式のまま。データタブに「〜を参照（その版を消すと開けません）」と出る。