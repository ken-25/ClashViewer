# 干渉ビューア（ClashViewer）

点群（E57）と3Dモデル（IFC）を1つの画面に重ね、干渉・近接を目視確認する軽量ビューア。
共有フォルダ（Box Drive）に置いた `干渉ビューア.exe` をダブルクリックするだけで、誰でも同じデータを見られる。

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
| `dist/` | 配布一式（`干渉ビューア.exe`・`viewer/`・`tools/`）。共有フォルダへ上書きコピーしてよいものだけ。未コミット | — |
| `dev/share/` | 開発・E2E 用の共有データ（`config/`・`datasets/`・`events/`・`issues/`）。未コミット | — |
| `dev/screenshots/` | E2E のスクリーンショット。未コミット | — |

共有フォルダ上のフォルダ構成は [要件定義.md 5章](要件定義.md) を参照。

## 必要なもの

| ツール | 用途 |
|---|---|
| .NET 10 SDK | ビューア exe のビルド |
| Node.js（18+） | 画面のビルド・E2E |
| uv | 変換エンジンの依存管理・ビルド |
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

配布一式（`干渉ビューア.exe`・`viewer/`・`tools/`）を `dist/` に作る。

```powershell
scripts/build.ps1                  # dist/ を作り直す
scripts/build.ps1 -SkipConverter   # 変換エンジンは前回のビルド（build/converter-dist）を使う
scripts/build.ps1 -SkipHost        # ビューア exe は前回のビルド（build/host）を使う
```

`build.ps1` が行うこと: `dist/` を空にする → 画面を Vite でビルド → exe を `dotnet publish -c Release` → PotreeConverter と変換エンジン（PyInstaller onedir）を `tools/` に配置。
`dist/` にはデータ（`config/`・`datasets/`・`events/`・`issues/`）を入れない。データのフォルダが見つかったら消さずに止まる。

### リリース

`dist/` の中身を共有フォルダへ手動で上書きコピーする。共有フォルダの `config/`・`datasets/`・`events/`・`issues/` は触らない（`dist/` に無いので上書きされない）。
起動中の人がいると exe の置き換えが保留されるので、コピー後に再起動を案内する。

`viewer/assets/` の古いファイル（ファイル名にハッシュ付き）は共有フォルダに残るが、新しい `index.html` からは参照されないので害はない。気になるときは `viewer/` を消してからコピーする。

### 画面だけ作り直す（開発用の短縮）

```powershell
scripts/build-viewer.ps1           # 型チェック + Vite ビルドして dist/viewer に置く
```

## 開発コマンド

| 対象 | コマンド |
|---|---|
| 画面: ビルド | `npm --prefix viewer run build` |
| 画面: 変更監視ビルド | `npm --prefix viewer run watch` |
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
node e2e/perf.mjs <データセットのフォルダ>              # 性能（--root <共有フォルダ> を指定可）
```

## 実行

```powershell
scripts/run.ps1                              # dist/ の exe を dev/share のデータで起動（開発モード）
scripts/run.ps1 -Root "<Box の共有フォルダ>"  # 手元のビルドで共有フォルダのデータを見る
```

`dist/干渉ビューア.exe` を直接ダブルクリックしない。exe の隣（`dist/`）にデータのフォルダが作られ、`dist/` が配布物だけでなくなる。
`--root` で変わるのはデータの場所だけで、`viewer/`・`tools/` は常に exe の隣のものを使う。

利用者は共有フォルダ上の `干渉ビューア.exe` をダブルクリックする（exe の隣がデータのルートになる）。
