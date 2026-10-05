# 干渉ビューア（ClashViewer）

点群（E57）と3Dモデル（IFC）を1つの画面に重ね、干渉・近接を目視確認する軽量ビューア。
利用者は MSI をダブルクリックして入れる（ユーザーごと・管理者権限なし）。データは各 PC のローカルに置く。

- 何を作るか・なぜその技術か: [要件定義.md](要件定義.md)
- PoC で確認した動作・性能・残課題: [PoC結果.md](PoC結果.md)
- 変換エンジンの使い方（CLI 仕様）: [converter/README.md](converter/README.md)

このファイルは「開発環境のセットアップ」と「ビルド・リリース手順」の入口。
機能仕様や技術選定の理由は上のリンク先にあり、ここでは繰り返さない。

## 構成

| 場所 | 役割 | 技術 |
|---|---|---|
| `app/ClashViewer.Host` | ビューア exe（WebView2 ホスト） | C# / .NET 10 / WinForms |
| `viewer/` | 画面（HTML/JS/CSS） | three.js / Fragments / web-ifc + Vite |
| `converter/` | 変換エンジン（E57 → LAS → Potree 2.0） | Python（uv 管理）/ PyInstaller |
| `e2e/` | E2E テスト（実 exe を起動して WebView2 を操作） | Node + playwright-core |
| `scripts/` | ビルド・配布スクリプト | PowerShell |
| `third_party/` | 同梱外部バイナリ（PotreeConverter）。取得物のため未コミット | — |
| `installer/` | インストーラーの定義（MSI） | WiX Toolset 7 |
| `VERSION` | 製品のバージョン（唯一の正。exe・変換エンジン・MSI はここから決まる） | — |
| `dist/` | 配布一式（`干渉ビューア.exe`・`viewer/`・`tools/`）。MSI の中身。未コミット | — |
| `release/` | インストーラー（`干渉ビューア-<版>.msi`）。未コミット | — |
| `dev/share/` | 開発・E2E 用のデータ（`config/`・`datasets/`・`events/`・`issues/`）。未コミット | — |
| `dev/screenshots/` | E2E のスクリーンショット。未コミット | — |

インストール先とデータの置き場所は [要件定義.md 5章](要件定義.md) を参照。

## 必要なもの

| ツール | 用途 |
|---|---|
| .NET 10 SDK | ビューア exe のビルド |
| Node.js（18+） | 画面のビルド・E2E |
| uv | 変換エンジンの依存管理・ビルド |
| WiX Toolset 7（`dotnet tool install --global wix --version 7.0.0`） | MSI のビルド。初回は利用条件（OSMF EULA）の確認と `wix eula accept wix7` が要る |
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

配布一式（`干渉ビューア.exe`・`viewer/`・`tools/`）を `dist/` に作り、それを入れた MSI を `release/` に作る。

```powershell
scripts/build.ps1                  # dist/ を作り直し、release/干渉ビューア-<版>.msi を作る
scripts/build.ps1 -SkipMsi         # dist/ だけ（開発・E2E 用）
scripts/build.ps1 -SkipConverter   # 変換エンジンは前回のビルド（build/converter-dist）を使う（版が違えば作り直す）
scripts/build.ps1 -SkipHost        # ビューア exe は前回のビルド（build/host）を使う（版が違えば作り直す）
```

`build.ps1` が行うこと: `VERSION` を検査 → `dist/` を空にする → 画面を Vite でビルド → exe を `dotnet publish -c Release` → PotreeConverter と変換エンジン（PyInstaller onedir）を `tools/` に配置 → `wix build` で MSI を作り `wix msi validate` で検査。
`dist/` にはデータ（`config/`・`datasets/`・`events/`・`issues/`）を入れない。データのフォルダが見つかったら消さずに止まる。

### バージョン

`VERSION`（`x.y.z`）だけを書き換える。exe は csproj が直接読み、変換エンジンは開発時は `VERSION` を読み、exe 化するときは `build.ps1` が生成する `_version.py`（未コミット）を使う。MSI には `-d Version` で渡す。
`viewer/package.json`・`converter/pyproject.toml` には製品のバージョンを書かない。

### リリース

`release/干渉ビューア-<版>.msi` を配る（Box に置いて各自がダウンロードし、ダブルクリック）。

- インストール先は `%LocalAppData%\Programs\ClashViewer`。スタートメニューとデスクトップに「干渉ビューア」ができる
- 新しい版の MSI を実行すれば前の版と置き換わる。同じ版の作り直しも上書きできる。古い版は入らない（先にアンインストールが要る）
- 起動中に更新すると、閉じるよう求められる
- アンインストールしてもデータ（`%LocalAppData%\ClashViewer`）は残る
- `installer/ClashViewer.wxs` の `UpgradeCode` は変えない（変えると別製品として二重に入る）

### 画面だけ作り直す（開発用の短縮）

exe は隣の `viewer/` フォルダ（開発では `dist/viewer`）の画面を表示する。画面の変更を exe で確かめるときは、`dist/viewer` を作り直してから exe を起動し直す。

```powershell
scripts/build-viewer.ps1           # 型チェック + Vite ビルドして dist/viewer に置く
```

## 開発コマンド

Vite の出力先は環境変数 `CV_OUT_DIR`（未指定なら `viewer/dist`）。`scripts/build.ps1`・`scripts/build-viewer.ps1` は `dist/viewer` を指定して呼ぶ。

| 対象 | コマンド |
|---|---|
| 画面: ビルド（`dist/viewer` へ） | `scripts/build-viewer.ps1` |
| 画面: 変更監視ビルド（`dist/viewer` へ） | `$env:CV_OUT_DIR = "$PWD\dist\viewer"; npm --prefix viewer run watch`（リポジトリ直下で実行） |
| 画面: 型チェック | `npm --prefix viewer run typecheck` |
| 画面: 単体テスト | `npm --prefix viewer test` |
| 変換エンジン: 実行 | `uv run --project converter clash-converter ...` |
| 変換エンジン: テスト | `uv run --project converter pytest` |
| exe: ビルド | `dotnet build app/ClashViewer.Host/ClashViewer.Host.csproj -c Release` |

変換エンジンの CLI 引数は [converter/README.md](converter/README.md) を参照。

## E2E テスト

実際にビルドした exe（`dist/`）を起動し、WebView2 を操作して確認する。先に `scripts/build.ps1` で一式を作っておく。
データは `dev/share/`（環境変数 `CV_SHARE` で変更可）、スクリーンショットは `dev/screenshots/` に書く。

```powershell
npm --prefix e2e ci                # 初回だけ
node e2e/smoke.mjs                             # Range・書込権限
node e2e/import.mjs                            # 取込
node e2e/features.mjs <最新版フォルダ> <前の版フォルダ>   # 全機能（2 人分・版またぎ）
node e2e/perf.mjs <データセットのフォルダ>              # 性能（--root <データフォルダ> を指定可）
```

## 実行

```powershell
scripts/run.ps1                              # dist/ の exe を dev/share のデータで起動（開発モード）
scripts/run.ps1 -Root "<データフォルダ>"       # 別のデータフォルダで起動
```

`dist/干渉ビューア.exe` を直接ダブルクリックすると、インストール版と同じ `%LocalAppData%\ClashViewer\data` を使う。
`--root` で変わるのはデータの場所だけで、`viewer/`・`tools/` は常に exe の隣のものを使う。

保存先は 2 つあり、画面右上の「設定」（またはフッターの「保存先」）から変えられる。保存すると `%LocalAppData%\ClashViewer\settings.json` に書き、再起動で切り替わる。

| 保存先 | 中身 | 既定 | settings.json のキー |
|---|---|---|---|
| プロジェクトフォルダ | `datasets/`・`events/`・`issues/` | `%LocalAppData%\ClashViewer\data` | `dataRoot` |
| 設定データフォルダ | `app.json`・`members/` | プロジェクトフォルダの `config\` | `configRoot` |

- 決まり方: `--root`（開発用。設定データは `<root>\config`、settings.json は見ない）＞ settings.json ＞ 既定。既定と同じ値はキーを書かない
- 保存先を変えても、今あるデータは移動しない。設定データ（app.json・メンバー）だけは、新しい場所に無ければ写すかを選べる
- 設定した保存先が使えない（外付けドライブを外した等）ときは、起動時に「今回だけ既定の保存先で起動するか」を聞く
- `--root` で起動中でも設定画面から保存はできる（`--root` なしの起動で効く）
