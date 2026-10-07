# 拡張の基盤（完成形と引き継ぎ）

将来要件（要件定義 9 章 F1〜F6）を載せるための基盤。F1〜F5 の機能そのものはまだ無い（開発モードの疎通確認用の処理だけ）。F6（撮影ポイント）は下の「F6 撮影ポイント」。

## 完成形

| 層 | 役割 | 拡張の仕方 |
|---|---|---|
| 画面のツール | 作業のモード（クリック・キー・右パネル・案内・スナップ） | `ToolDefinition` を書いて `registerTool`（`viewer/src/tools/toolRegistry.ts`） |
| 画面の左タブ | 対象（レイヤー）と成果（計測・指摘・差分） | `LeftTabDefinition` を書いて `registerLeftTab`（`viewer/src/ui/panelRegistry.ts`） |
| 画面の見え方 | 3D 左上 view-bar のボタン・メニュー | `ViewBarItemDefinition` を書いて `registerViewBarItem`（同上） |
| 機能の状態 | 計測・UCS・断面・3点合わせ・指摘・差分の状態と操作 | `viewer/src/features/` に `AppFeature` のクラス（版を開く・閉じるで `onOpen` / `onClose`）。`App` の constructor で 1 行足す |
| 画面の通知 | 状態の変化をパネルへ伝える | `AppTopic`（`viewer/src/app.ts`）に名前を足す |
| 処理（ジョブ） | 公開済みの版に対する重い計算 | 変換エンジンに `@job` のサブコマンド＋`JobService.Kinds` に 1 行（`Target`・`ParamsJson`）。画面は登録から自動で出る |
| 結果の保存 | 派生成果物 | `Target=Derived`: `datasets/<版>/derived/<ID>/` と manifest の `derived`（追記のみ） |
| 新しい版 | 点群を作り直す処理（F5 など） | `Target=NewVersion`: ジョブで `ctx.new_pointcloud()` に書くだけ。公開は Host（`NewVersion.cs`） |
| 結果の表示 | derived を 3D に重ねる | `registerDerivedLayerKind`（`features/derivedLayers.ts`）。行は「レイヤー」の「処理の結果」に出る |
| レイヤーの行 | 左タブ「レイヤー」の行の種類 | `registerLayerSource`（`ui/layerRegistry.ts`） |
| 点群の入力 | 計算の入力 | `ctx.reader()`（`PotreeReader`。保存済みの版から全点。元の E57 は使わない） |
| 点の属性 | 分類・値の色分け、分類ごとの表示 | `features/pointAttributes.ts`。要る属性だけ `setExtraAttributes` で読む。分類の名前・色は `data/pointClasses.ts`（`config/app.json` の `pointcloud.classes` で上書き） |

ジョブの流れ:

```
画面 右パネル「処理」→ app.startJob(kind, folder, params)
  → RPC jobStart → JobService（work/job-<ID>/ を作り待ち行列へ。同時に動くのは 1 本）
  → 順番が来たら converter.exe <kind> --manifest --datasets --params --out --work [--potree]（JSON 行で進捗）
  → Derived:    out/ を derived/<ID>.part に写して改名 → DatasetStore.AddDerived（manifest に追記）
    NewVersion: out/pointcloud/ ＋元の版のモデルを .importing/ に組み立て → ImportService.Finish(parent 付き)
  → 通知 job.progress（queued/started/stage/progress/log/error/done/failed/aborted）
  → data/jobs.ts の reduceJob で app.jobs に畳む → "jobs" 通知 → 左タブ「成果」・右パネル
```

### 処理の入力欄（ParamsJson）

`JobService.Kinds` の `ParamsJson` は JSON 配列。画面の右パネル「処理」がこれから入力欄を作り、`data/jobs.ts` の `checkParams` で確かめてから `params` として渡す。

```json
[{"key":"step","label":"間引き","type":"number","default":1,"min":1,"max":1000,"step":1},
 {"key":"note","label":"メモ","type":"text"},
 {"key":"on","label":"…","type":"checkbox"},
 {"key":"mode","label":"…","type":"select","options":[{"value":"a","label":"A"}]}]
```

`params.note` は新しい版の `parent.note` と `comment` にも入る。

### 新しい版（NewVersion）の中身

- 点群: 処理の結果。`sources`（元の E57 の記録）は引き継ぎ、`derivedFrom`・`classCounts`・`attributes` を足す
- モデル・原点・座標合わせ: 元の版と同じ（ファイルは新しい版へ複製）
- `version`: 同じプロジェクトの最大の版 + 1。`previous`・`parent.folder`: 元の版。`diff.json` は元の版との比較（モデルは変化なし）
- `derived`: 空（入力が変わるので引き継がない）

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

### H1〜H4・H8・H9（処理の UI・結果・新しい版）

- H9 待ち行列: `JobService` は始めた順に 1 本ずつ動かす（`maxParallel`）。待っている処理は取り消すだけ、動いている処理は変換エンジンごと止める。失敗・中断しても次が始まる。処理の実行中は再起動・保存先の変更を断る
- H2 処理の UI: ツールバー「処理」（使える処理が無ければ出さない）→ 右パネルで種類・設定・開始と、この版の進み具合。左タブ「成果」に実行中・待機中・この版の成果・処理で作った版（元の版／作った版を開く）・終わった処理。ツールの右パネルは `panelTopics` / `refreshPanel` で一部だけ描き直す（入力中の欄を壊さない）
- H3 結果レイヤー: レイヤーの行は `registerLayerSource` から作る（点群・モデルも同じ形）。処理の結果は初めて表示するときに読み、版を閉じると `dispose`。標準は `selftest`（範囲の枠）だけ
- H4 点の属性: 色の方法に「分類」「値（属性）」。分類はレイヤーの点群の行で 1 つずつ隠せる（描かず、クリック・スナップでも拾わない）。読む属性は色の方法から決め、変えたときだけ読み直す。前回の方法はこの PC に覚え、次に開くときは最初から読む
- H1 新しい版: 上の「新しい版（NewVersion）の中身」。疎通確認は `selftest-version`（間引き＋高さで分類と値を付ける）
- H8 テスト: `app/Kasane.Host.Tests`（xUnit。待ち行列・中断・失敗・derived・newVersion の公開・受付の検査）、`converter/tests/test_jobs.py`（新しい版の点群の書き出し。PotreeConverter が無ければ飛ばす）、`viewer/tests/jobs.test.mjs`（通知の畳み込み・入力値・分類の色）、`e2e/jobs.mjs`（待ち行列・画面・新しい版・分類の表示まで通し）

### F6 撮影ポイント

取込で E57 の器械点と画像を記録し、画面で「立って見回す」ツールにした。処理（ジョブ）ではなく取込の一部。

- 取込: 変換エンジンが `images2D`（spherical / pinhole / cylindrical の JPEG・PNG。参考画像は除く）を `--images` へそのまま書き出し、`sources[].images[]` に記録する（`cli.py` の `image_entry`）。スキャンごとの範囲 `scans[].bounds` も足した。Host は画像を版の `images/` へ写す。前の版からの引き継ぎ（`carryList`）と新しい版（`NewVersion.ImageFiles`）でも画像を複製する
- 一覧: `data/scanPoints.ts`。器械点がスキャンの範囲（無ければ点群全体）から外れていれば「位置不明」（点を世界座標で持ち、姿勢が原点のままの E57）。画像は `associatedData3DGuid` でスキャンに結び付け、画像に姿勢が無ければスキャンの姿勢で貼る
- 画面: ツールバー「撮影ポイント」（立っている間は左ドラッグ＝見回す・ホイール＝画角・クリック＝近くの撮影ポイントへ・N / Shift+N で巡る）。右パネルに前後・順に巡る・画像の濃さと向きの補正・一覧。左タブ「レイヤー」に目印の表示と一覧（〜へ移動）。3D の目印を押すとツールに入る。出ると入る前の視点に戻る
- 画像は重ね描き（`viewer.overlay`。切断を受けない・深度なし）に球（360 画像）・面（写真）で貼り、濃さで点群と見比べる。GPU の上限を超える画像は読むときに縮める
- 向きの決めごと（360 画像は中央の列が +X・右へ時計回り、写真は −Z を向く）は規格と公開コードからの想定で、**画像付きの実データでは未確認**。ずれるデータのために右パネルで 90° ごとの方位の補正を掛けられる（プロジェクトごとにこの PC に保存）
- テスト: `converter/tests/test_e57_images.py`、`viewer/tests/scanPoints.test.mjs`、`Kasane.Host.Tests`（新しい版で画像を複製）、`e2e/scanpoints.mjs`（画像付きの E57 は `converter/dev/add_station_images.py` で作る。点群の色を器械点から投影した 360 画像なので、取込から表示までの向きの扱いがそろっているかは確かめられるが、実機の向きの確認にはならない）

## 引き継ぎ（未実装）

| # | 項目 | 内容 |
|---|---|---|
| H5 | 派生成果物の扱い | 版の書き出し（5.3）に derived を含めるか、derived の削除・作り直し、ジョブの種類ごとの result の型。処理で作った版の削除と、元の版を消したときの `parent` の扱いも未定（今は「元の版は見つかりません」と出すだけ） |
| H6 | 右パネル・左タブの登録口 | 済。右パネルの下段（#clip-panel）だけは切断専用のまま |
| H7 | App の分割 | 済。`App` に残るのは版・点群・モデル・視点・切断の土台・ツールの切替・選択・処理 |
| H8' | テストの残り | `e2e/features.mjs` はマウス操作が不安定で、HEAD でも 3点合わせ・切断ボックスで落ちることがある。改修A棟の版向けで、e2e-base の版では 3点合わせの候補点が足りず落ちる。版を開き直す・差分の色分けを切るとき「Model not found」がコンソールに出ることがある（表示への影響は未確認）。分類を隠した描画の見た目は目視のみ |
| H10 | 処理の結果の型 | `registerDerivedLayerKind` は selftest だけ。メッシュ（GLB）・干渉結果の出し方は各機能（F1〜F4）を作るときに足す |
| H12 | 処理・成果の置き場所（UX） | 今はツールバー「処理」（右パネルで開始）＋左タブ「成果」。F1〜F5 の実物ができた段階で、置き場所を見直す。論点: 処理はツール（モード）なのか、版に対する操作なのか／F2・F4 のように範囲や対象を 3D で指定する処理と、F5 のように版全体にかける処理で入口を分けるか／成果を左タブに独立させるか、計測・指摘・差分と同じ「成果」に寄せるか／実行中の進み具合を、タブを開かなくても見える場所（状態表示など）に出すか |
| H13 | 撮影ポイントの残り | 画像付きの実データ（FARO・Leica・Trimble など）で 360 画像・写真の向きを確かめる（必要なら機種ごとの補正を決める）。画像は元の解像度のまま保存するので、巨大な 360 画像は表示のたびに縮めている（取込時に縮小版を作るかは実データの大きさ次第）。円筒画像は形だけ対応し、実データで未確認。巡回は等間隔のみ（経路・順番の指定はなし） |
| H11 | 大きな点群 | 新しい版のジョブは LAS 1.4 に全点を書いてから PotreeConverter に渡す。作業用フォルダに点群と同程度の空きが要る（数億点で数十 GB）。分類の点数は manifest の `classCounts`（処理で作った版だけ。取込した版は読み込んだ点に現れた分類を出す） |
