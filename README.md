# 3D施工検討Viewer Kasane

点群（E57）と3Dモデル（IFC）を1つの画面に重ねて表示し、干渉・搬入計画などの施工検討を行う軽量ビューア。
コードネーム・英字 ID は `Kasane`（exe・フォルダ・名前空間・パッケージ名に使う）。
利用者は MSI をダブルクリックして入れる（ユーザーごと・管理者権限なし）。データは各 PC のローカルに置く。

- 何を作るか・なぜその技術か: [要件定義.md](要件定義.md)
- PoC で確認した動作・性能・残課題: [PoC結果.md](PoC結果.md)
- 変換エンジンの使い方（CLI 仕様）: [converter/README.md](converter/README.md)

このファイルは「開発環境のセットアップ」と「ビルド・リリース手順」の入口。
機能仕様や技術選定の理由は上のリンク先にあり、ここでは繰り返さない。

## 構成

| 場所 | 役割 | 技術 |
|---|---|---|
| `app/Kasane.Host` | ビューア exe（WebView2 ホスト） | C# / .NET 10 / WinForms |
| `viewer/` | 画面（HTML/JS/CSS） | three.js / Fragments / web-ifc + Vite |
| `converter/` | 変換エンジン（E57 → LAS → Potree 2.0） | Python（uv 管理）/ PyInstaller |
| `e2e/` | E2E テスト（実 exe を起動して WebView2 を操作） | Node + playwright-core |
| `scripts/` | ビルド・配布スクリプト | PowerShell |
| `third_party/` | 同梱外部バイナリ（PotreeConverter）。取得物のため未コミット | — |
| `installer/` | インストーラーの定義（MSI） | WiX Toolset 7 |
| `VERSION` | 製品のバージョン（唯一の正。exe・変換エンジン・MSI はここから決まる） | — |
| `dist/` | 配布一式（`Kasane.exe`・`viewer/`・`tools/`）。MSI の中身。未コミット | — |
| `release/` | インストーラー（`3D施工検討Viewer_Kasane_<版>.msi`）。未コミット | — |
| `dev/share/` | 開発・E2E 用のデータ（`config/`・`datasets/`・`events/`・`issues/`）。未コミット | — |
| `dev/screenshots/` | E2E のスクリーンショット。未コミット | — |

インストール先とデータの置き場所は [要件定義.md 5章](要件定義.md) を参照。機能を足すときの基盤（ツールの登録・ジョブ・派生成果物）は [docs/architecture.md](docs/architecture.md)。

## 必要なもの

| ツール | 用途 |
|---|---|
| .NET 10 SDK | ビューア exe のビルド |
| Node.js（18+） | 画面のビルド・E2E |
| uv | 変換エンジンの依存管理・ビルド |
| WiX Toolset 7（`dotnet tool install --global wix --version 7.0.0`） | MSI のビルド。初回は利用条件（OSMF EULA）の確認と `wix eula accept wix7` が要る。拡張も入れる: `wix extension add -g WixToolset.UI.wixext/7.0.0` と `wix extension add -g WixToolset.Util.wixext/7.0.0`（インストール画面・完了後の起動） |
| WebView2 Runtime | 実行（Windows に導入済みが前提） |

## 初回セットアップ

```powershell
scripts/fetch-third-party.ps1      # PotreeConverter 2.1.5 を third_party/ に取得（初回だけ）
```

依存の取得（`scripts/build.ps1` が未取得時に自動で行うが、手動なら以下）。

```powershell
npm --prefix viewer ci             # 画面の依存
uv sync --project converter        # 変換エンジンの依存
```

## ビルド・リリース

使うコマンドは 3 つだけ。

```powershell

# 1. 開発用ビルド（画面・exe・変換エンジンのどれを変えてもこれで dist/ が最新になる）
scripts/build.ps1

# 2. dist/ の exe を開発モードで起動（データは dev/share）
scripts/run.ps1

# 3. 全部作り直して release/3D施工検討Viewer_Kasane_<版>.msi を作る
scripts/release.ps1

```

- `build.ps1`: 画面は毎回 型チェック + Vite ビルド。exe と変換エンジンは、ソース・依存・`VERSION` が前回のビルドより新しいときだけ作り直す（変わっていなければ数十秒で終わる）。dist/ のアプリが起動中なら止まるので、閉じてから実行する
- `release.ps1`: `dist/` を空にし、画面・exe（`dotnet publish -c Release`）・PotreeConverter・変換エンジン（PyInstaller onedir）をすべて作り直してから `wix build` で MSI を作り `wix msi validate` で検査する

`dist/` にはデータ（`config/`・`datasets/`・`events/`・`issues/`）を入れない。データのフォルダが見つかったら消さずに止まる。

### バージョン

`VERSION`（`x.y.z`）だけを書き換える。exe は csproj が直接読み、変換エンジンは開発時は `VERSION` を読み、exe 化するときは `build.ps1` が生成する `_version.py`（未コミット）を使う。MSI には `-d Version` で渡す。
`viewer/package.json`・`converter/pyproject.toml` には製品のバージョンを書かない。

### リリース

`release/3D施工検討Viewer_Kasane_<版>.msi` を配る（Box に置いて各自がダウンロードし、ダブルクリック）。

- インストール先は `%LocalAppData%\Programs\Kasane`。スタートメニューとデスクトップに「3D施工検討Viewer Kasane」ができる
- 新しい版の MSI を実行すれば前の版と置き換わる。同じ版の作り直しも上書きできる。古い版は入らない（先にアンインストールが要る）
- 起動中に更新すると、閉じるよう求められる
- アンインストールしてもデータ（`%LocalAppData%\Kasane`）は残る
- アプリのアイコンは `app/Kasane.Host/app.ico`。置けば exe・ウィンドウ・ショートカット・「アプリと機能」に使われる（無ければ既定のアイコン）
- `installer/Kasane.wxs` の `UpgradeCode` は変えない（変えると別製品として二重に入る）

## 個別のコマンド

普段は上の 3 つで足りる。部分的に回したいときだけ使う。
Vite の出力先は環境変数 `KASANE_OUT_DIR`（未指定なら `viewer/dist`）。`scripts/build.ps1` は `dist/viewer` を指定して呼ぶ。

| 対象 | コマンド |
|---|---|
| 画面: 変更監視ビルド（`dist/viewer` へ） | `$env:KASANE_OUT_DIR = "$PWD\dist\viewer"; npm --prefix viewer run watch`（リポジトリ直下で実行） |
| 画面: 型チェック | `npm --prefix viewer run typecheck` |
| 画面: 単体テスト | `npm --prefix viewer test` |
| 変換エンジン: 実行 | `uv run --project converter kasane-converter ...` |
| 変換エンジン: テスト | `uv run --project converter pytest` |
| exe: ビルド | `dotnet build app/Kasane.Host/Kasane.Host.csproj -c Release` |
| exe: 単体テスト（JobService の待ち行列・結果の公開） | `dotnet test app/Kasane.Host.Tests` |

変換エンジンの CLI 引数は [converter/README.md](converter/README.md) を参照。

## E2E テスト

実際にビルドした exe（`dist/`）を起動し、WebView2 を操作して確認する。先に `scripts/build.ps1` で一式を作っておく。
データは `dev/share/`（環境変数 `KASANE_SHARE` で変更可）、スクリーンショットは `dev/screenshots/` に書く。

```powershell
npm --prefix e2e ci                # 初回だけ
node e2e/smoke.mjs                             # Range・書込権限
node e2e/import.mjs                            # 取込
node e2e/features.mjs <最新版フォルダ> <前の版フォルダ>   # 全機能（2 人分・版またぎ）
node e2e/perf.mjs <データセットのフォルダ>              # 性能（--root <データフォルダ> を指定可）
node e2e/jobs.mjs <点群のある版のフォルダ>              # 処理（ジョブ）基盤・画面・分類の表示（derived が 4 件・版が 1 つ増える）
node e2e/panels.mjs <差分のある版フォルダ>              # 左タブ・見え方・機能の後始末
```

## 実行

```powershell
scripts/run.ps1                              # dist/ の exe を dev/share のデータで起動（開発モード）
scripts/run.ps1 -Root "<データフォルダ>"       # 別のデータフォルダで起動
scripts/run.ps1 -NoDev                       # 開発モード（開発者ツール等）なしで起動
```

`dist/Kasane.exe` を直接ダブルクリックすると、インストール版と同じ `%LocalAppData%\Kasane\data` を使う。
`--root` で変わるのはデータの場所だけで、`viewer/`・`tools/` は常に exe の隣のものを使う。

保存先は 2 つあり、画面右上の「設定」（またはフッターの「保存先」）から変えられる。保存すると `%LocalAppData%\Kasane\settings.json` に書き、再起動で切り替わる。

| 保存先 | 中身 | 既定 | settings.json のキー |
|---|---|---|---|
| プロジェクトフォルダ | `datasets/`・`events/`・`issues/` | `%LocalAppData%\Kasane\data` | `dataRoot` |
| 設定データフォルダ | `app.json`・`members/` | プロジェクトフォルダの `config\` | `configRoot` |

- 決まり方: `--root`（開発用。設定データは `<root>\config`、settings.json は見ない）＞ settings.json ＞ 既定。既定と同じ値はキーを書かない
- 保存先を変えても、今あるデータは移動しない。設定データ（app.json・メンバー）だけは、新しい場所に無ければ写すかを選べる
- 設定した保存先が使えない（外付けドライブを外した等）ときは、起動時に「今回だけ既定の保存先で起動するか」を聞く
- `--root` で起動中でも設定画面から保存はできる（`--root` なしの起動で効く）
