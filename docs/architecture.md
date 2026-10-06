# 拡張の基盤（完成形と引き継ぎ）

将来要件（要件定義 9 章 F1〜F5）を載せるための基盤。機能そのものはまだ無い。

## 完成形

| 層 | 役割 | 拡張の仕方 |
|---|---|---|
| 画面のツール | 作業のモード（クリック・キー・右パネル・案内・スナップ） | `ToolDefinition` を書いて `registerTool`（`viewer/src/tools/toolRegistry.ts`） |
| 画面の左タブ | 対象（レイヤー）と成果（計測・指摘・差分） | `LeftTabDefinition` を書いて `registerLeftTab`（`viewer/src/ui/panelRegistry.ts`） |
| 画面の見え方 | 3D 左上 view-bar のボタン・メニュー | `ViewBarItemDefinition` を書いて `registerViewBarItem`（同上） |
| 機能の状態 | 計測・UCS・断面・3点合わせ・指摘・差分の状態と操作 | `viewer/src/features/` に `AppFeature` のクラス（版を開く・閉じるで `onOpen` / `onClose`）。`App` の constructor で 1 行足す |
| 画面の通知 | 状態の変化をパネルへ伝える | `AppTopic`（`viewer/src/app.ts`）に名前を足す |
| 処理（ジョブ） | 公開済みの版に対する重い計算 | 変換エンジンに `@job` のサブコマンド＋`JobService.Kinds` に 1 行 |
| 結果の保存 | 派生成果物 | `datasets/<版>/derived/<ID>/` と manifest の `derived`（追記のみ） |
| 点群の入力 | 計算の入力 | `PotreeReader`（保存済みの版から全点。元の E57 は使わない） |
| 点の属性 | 分類・距離などの重ね表示 | `PotreePointCloud` の `extraAttributes` → geometry の `attr:<名前>` |

ジョブの流れ:

```
画面 app.startJob(kind, folder, params)
  → RPC jobStart → JobService（work/job-<ID>/ を作り裏で実行）
  → converter.exe <kind> --manifest --datasets --params --out --work（JSON 行で進捗）
  → out/ を derived/<ID>.part に写して改名 → DatasetStore.AddDerived（manifest に追記）
  → 通知 job.progress（stage/progress/log/error/done/failed/aborted）→ app.jobs と "jobs" 通知
```

### 決めごと

- 公開済みの版の本体（点群・モデル）は書き換えない（要件定義 5.2）。公開後に変えるのは `alignment` と `derived` の追記だけ。
- 点群そのものを変える処理（F5 の削除・清掃）は**新しい版**として公開し、`parent` に元の版を残す。
- manifest は `schema: 2`。古い版（schema 1）は画面の `migrateManifest` で補って読む。ファイルは書き換えない。新しすぎる schema の版は一覧から外す。
- ジョブは変換エンジン（Python）で動かす。画面の Web Worker は、表示中の範囲だけで済む対話的な計算に使う（読み込めているのは LOD の一部だけ）。
- 重い依存（Open3D・SciPy など）は、各機能を作るときに要否を判断する。exe のサイズとウイルス対策の誤検知（懸念 #6）に影響する。

## 今回入れたもの

- Host: `ConverterProcess`（取込とジョブで共通の起動と JSON 行の処理）、`JobService`、`Manifest`（schema 2）、`DatasetStore.AddDerived`、RPC `jobKinds` / `jobList` / `jobStart` / `jobAbort`、通知 `job.progress`
- converter: `jobs/`（登録式と共通の引数・`JobContext`）、`potree_reader.py`、`selftest`（開発モードだけの疎通確認）、pytest
- viewer: ツールの登録口、標準 6 ツールの移行（`modes/builtinTools.ts`。ツールバーのボタンも登録から作る）、型付きの通知、`app.jobs`、manifest の移行、点群の追加属性の読み込み
- テスト: `viewer/tests/{dataset,toolRegistry}.test.mjs`、`converter/tests/`、`e2e/jobs.mjs`

### H6・H7（画面の土台）

- 左タブ・見え方の登録口（`ui/panelRegistry.ts`）と、登録から DOM を作る `ui/panelHost.ts`。標準の 4 タブと 4 項目は `modes/builtinPanels.ts`。`index.html` には枠（`nav.tabs`・`#view-bar`）だけ残す。描き直しは各定義の `topics` で行い、`main.ts` からタブごとの描画呼び出しを消した
- `App`（1,058 → 約 590 行）から機能の状態を `features/` へ移した: `measureMode`（軸の固定・吸着）、`ucs`、`section`（切断メニューと面に合わせた断面）、`align`（3点合わせの解と保存）、`issues`（イベントとピン）、`diff`（差分の読み込みと色分け）、`viewState`（視点の保存・再現）。版を開く・閉じるときの後始末は各機能の `onOpen` / `onClose`
- 標準ツールの右パネルと計測タブは `ui/toolPanels.ts` へ（`viewPanels.ts` はレイヤー・属性・切断パネル）
- 投影の切替は `app.toggleProjection()` と通知 `projection`
- テスト: `viewer/tests/panelRegistry.test.mjs`、`e2e/panels.mjs`（タブ・見え方・機能の後始末。マウスで 3D を狙わない）

## 引き継ぎ（未実装）

| # | 項目 | 内容 |
|---|---|---|
| H1 | 新しい版を作るジョブ | `target=newVersion`。`ImportService.Begin` / `Finish` に `parent` を渡し、変換エンジンが Potree を作り直す（PotreeConverter に LAS を渡す。`potree_reader` → LAS 書き出し → 既存の `run_potree`） |
| H2 | 処理の UI | 起動（右パネル）・進捗と結果の一覧（左タブ「成果」）・中断。配置は ui-rules の 4 分類に従う |
| H3 | 結果レイヤー | `derived` を左タブ「レイヤー」に出す共通の枠（メッシュ GLB・干渉・分類）。タブは登録式になったが、タブの中の行（点群・モデル）は `viewPanels.renderLayers` に直書き |
| H4 | 点の属性の表示 | `material.ts` に「分類」「スカラー値」の色の方法と、分類ごとの表示切替。`extraAttributes` を設定から決める |
| H5 | 派生成果物の扱い | 版の書き出し（5.3）に derived を含めるか、derived の削除・作り直し、ジョブの種類ごとの result の型 |
| H6 | 右パネル・左タブの登録口 | 済（上記）。右パネルの下段（#clip-panel）だけは切断専用のまま |
| H7 | App の分割 | 済（上記）。`App` に残るのは版・点群・モデル・視点・切断の土台・ツールの切替・選択・処理 |
| H8 | テスト | C# の単体テストは無い。`e2e/features.mjs` はマウス操作が不安定で、HEAD でも 3点合わせ・切断ボックス（外側のクリックがモデルを拾う）で落ちることがある。`features.mjs` は改修A棟（測量座標の点群）の版向けで、e2e-base の版では 3点合わせの候補点が足りず落ちる。版を開き直す・差分の色分けを切るとき、Fragments が破棄済みのモデルを更新して「Model not found」をコンソールに出すことがある（HEAD でも出る。表示への影響は未確認） |
| H9 | 同時実行 | ジョブは数の制限なしで並行して走る。重い処理を足すときは 1 本ずつ流す待ち行列を入れる |
