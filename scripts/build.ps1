<#
.SYNOPSIS
  開発用ビルド。画面・exe・変換エンジンのうち変わったものだけ作り直し、dist/ を実機確認できる状態にする。

.DESCRIPTION
  何を変えたかを気にせず、これ 1 本を実行すれば dist/ が最新になる（起動は scripts/run.ps1）。
  - 画面（viewer/）: 毎回 型チェック + Vite ビルド
  - exe（app/Kasane.Host）: ソース・csproj・VERSION が前回より新しいときだけ dotnet publish
  - 変換エンジン（converter/）: ソース・依存・VERSION が前回より新しいときだけ PyInstaller
  MSI まで作るのは scripts/release.ps1（全部作り直す）。

  バージョンはリポジトリ直下の VERSION が唯一の正（SSOT）。exe（csproj が直接読む）・変換エンジン（_version.py を生成）・
  MSI（wix build -d Version）はすべてここから決まる。版を上げるときは VERSION だけを書き換える。
  dist/ にはデータ（config/・datasets/・events/・issues/）を入れない。開発・E2E のデータは dev/share に置く。

.PARAMETER Release
  リリース用。dist/ を空にし、すべてを作り直してから release/3D施工検討Viewer_Kasane_<版>.msi を作る。
  直接付けずに scripts/release.ps1 を使う。
#>
param(
  [switch]$Release
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $repo "dist"
$sw = [Diagnostics.Stopwatch]::StartNew()

# ===== バージョン（SSOT） =====
$versionFile = Join-Path $repo "VERSION"
$version = (Get-Content $versionFile -Raw).Trim()
# MSI の ProductVersion の制約（major.minor.build がそれぞれ 255・255・65535 まで）に合わせて x.y.z に限る
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$' -or [int]$Matches[1] -gt 255 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 65535) {
  throw "VERSION は x.y.z（x,y は 0〜255、z は 0〜65535）で書く: '$version'"
}
Write-Host ("== バージョン {0}（{1}）" -f $version, $(if ($Release) { "リリース" } else { "開発" }))

# 指定したファイル群のうち一番新しい更新日時（bin/obj/__pycache__ は見ない）
function Get-Newest([string[]]$paths) {
  $files = foreach ($p in $paths) {
    if (Test-Path $p -PathType Container) {
      Get-ChildItem $p -Recurse -File | Where-Object { $_.FullName -notmatch '\\(bin|obj|__pycache__)\\' }
    } elseif (Test-Path $p) { Get-Item $p }
  }
  ($files | Measure-Object LastWriteTimeUtc -Maximum).Maximum
}

# dist/ の exe・変換エンジンが動いていると上書きできないので、先に止める
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dist + "\", "OrdinalIgnoreCase") }
if ($running) {
  throw "dist/ のアプリが起動中です（$(($running.ProcessName | Sort-Object -Unique) -join ', ')）。閉じてから実行してください"
}

# データが紛れていたら消さずに止める（以前は dist/share をデータ置き場にも使っていたため）
if (Test-Path $dist) {
  $data = Get-ChildItem $dist -Recurse -Directory -Depth 1 | Where-Object { $_.Name -in "datasets", "events", "issues", "config" }
  if ($data) {
    throw "dist/ にデータのフォルダがあります（$($data.FullName -join ', ')）。dev/share へ移してから実行してください"
  }
  if ($Release) { Remove-Item $dist -Recurse -Force }
}
New-Item -ItemType Directory -Force $dist | Out-Null

# ===== 画面 =====
Write-Host "== 画面 (viewer/)"
Push-Location (Join-Path $repo "viewer")
try {
  if (-not (Test-Path node_modules)) { npm ci; if ($LASTEXITCODE -ne 0) { throw "npm ci に失敗" } }
  npm run typecheck --silent
  if ($LASTEXITCODE -ne 0) { throw "画面の型エラー" }
  $env:KASANE_OUT_DIR = Join-Path $dist "viewer"
  npm run build --silent -- --logLevel warn
  if ($LASTEXITCODE -ne 0) { throw "画面のビルドに失敗" }
} finally {
  Remove-Item Env:KASANE_OUT_DIR -ErrorAction SilentlyContinue
  Pop-Location
}

# ===== exe =====
$hostSrc = Join-Path $repo "app\Kasane.Host"
$pub = Join-Path $repo "build\host"
$hostExe = Join-Path $pub "Kasane.exe"
$hostStale = $Release -or -not (Test-Path $hostExe) -or
  ((Get-Item $hostExe).VersionInfo.ProductVersion -split '\+')[0] -ne $version -or
  (Get-Newest @($hostSrc, $versionFile)) -gt (Get-Item $hostExe).LastWriteTimeUtc
if ($hostStale) {
  Write-Host "== exe (Kasane.exe)"
  dotnet publish (Join-Path $hostSrc "Kasane.Host.csproj") -c Release -o $pub --nologo -v quiet
  if ($LASTEXITCODE -ne 0) { throw "exe のビルドに失敗" }
  # 出力が変わらず日時が古いままだと毎回作り直しになるので、作った時刻にそろえる
  (Get-Item $hostExe).LastWriteTimeUtc = [DateTime]::UtcNow
} else {
  Write-Host "== exe: 変更なし（前回のビルドを使う）"
}
Copy-Item $hostExe (Join-Path $dist "Kasane.exe") -Force

# ===== tools/PotreeConverter =====
$pcSrc = Get-ChildItem (Join-Path $repo "third_party\PotreeConverter") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pcSrc) { throw "third_party/PotreeConverter がありません（scripts/fetch-third-party.ps1 を実行）" }
$pcDst = Join-Path $dist "tools\PotreeConverter"
if (-not (Test-Path (Join-Path $pcDst "PotreeConverter.exe"))) {
  Write-Host "== tools/PotreeConverter"
  New-Item -ItemType Directory -Force $pcDst | Out-Null
  # 変換に要るのは exe と laszip.dll だけ。resources/page_template（約 400 ファイル・47 MB）は
  # --generate-page 用の Web ビューア一式で使わないので入れない。ライセンス表示は残す
  foreach ($name in "PotreeConverter.exe", "laszip.dll") {
    $f = Join-Path $pcSrc.FullName $name
    if (-not (Test-Path $f)) { throw "third_party/PotreeConverter に $name がありません" }
    Copy-Item $f $pcDst
  }
  Copy-Item (Join-Path $pcSrc.FullName "licenses") $pcDst -Recurse
}

# ===== tools/converter（PyInstaller onedir） =====
$convDir = Join-Path $repo "converter"
$convBuilt = Join-Path $repo "build\converter-dist\converter"
$convStamp = Join-Path $repo "build\converter-dist\converter.version"
$convInputs = @((Join-Path $convDir "src"), (Join-Path $convDir "pyi_entry.py"), (Join-Path $convDir "pyproject.toml"), (Join-Path $convDir "uv.lock"), $versionFile)
$convStale = $Release -or -not (Test-Path (Join-Path $convBuilt "converter.exe")) -or -not (Test-Path $convStamp) -or
  (Get-Content $convStamp -Raw).Trim() -ne $version -or
  (Get-Newest $convInputs) -gt (Get-Item $convStamp).LastWriteTimeUtc
$convDst = Join-Path $dist "tools\converter"
if ($convStale) {
  Write-Host "== 変換エンジン (tools/converter)"
  # exe 化すると VERSION ファイルを読めないので、版を埋め込んだモジュールを生成する（コミットしない）
  $verPy = Join-Path $convDir "src\kasane_converter\_version.py"
  Set-Content $verPy "# scripts/build.ps1 が VERSION から生成する。編集しない`nVERSION = `"$version`"`n" -Encoding utf8NoBOM
  Push-Location $convDir
  try {
    uv sync --frozen 2>$null; if ($LASTEXITCODE -ne 0) { uv sync }
    uv run pyinstaller --noconfirm --clean --onedir --console --name converter `
      --distpath (Join-Path $repo "build\converter-dist") --workpath (Join-Path $repo "build\converter-work") `
      --specpath (Join-Path $repo "build") --collect-all pye57 --collect-submodules kasane_converter.jobs --paths src pyi_entry.py
    if ($LASTEXITCODE -ne 0) { throw "変換エンジンのビルドに失敗" }
  } finally {
    Pop-Location
    # 開発時（uv run）は VERSION を直接読むので、生成物は残さない
    Remove-Item $verPy -ErrorAction SilentlyContinue
  }
  Set-Content $convStamp $version -Encoding utf8NoBOM
} else {
  Write-Host "== 変換エンジン: 変更なし（前回のビルドを使う）"
}
$convVer = (& (Join-Path $convBuilt "converter.exe") --version).Trim()
if ($convVer -ne $version) { throw "変換エンジンの版（$convVer）が VERSION（$version）と違います" }
# dist/ 側が前回のビルドと同じなら写し直さない（約 100 MB あるため）
$convDstStamp = Join-Path $convDst ".build-stamp"
$builtStamp = (Get-Item $convStamp).LastWriteTimeUtc.Ticks.ToString()
if ($convStale -or -not (Test-Path $convDstStamp) -or (Get-Content $convDstStamp -Raw).Trim() -ne $builtStamp) {
  if (Test-Path $convDst) { Remove-Item $convDst -Recurse -Force }
  Copy-Item $convBuilt $convDst -Recurse
  if (-not $Release) { Set-Content $convDstStamp $builtStamp -Encoding utf8NoBOM }
}

$size = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("dist: {0}（{1:N0} MB）" -f $dist, ($size / 1MB))

if (-not $Release) {
  Write-Host ("完了（{0:N0} 秒）。起動は scripts/run.ps1" -f $sw.Elapsed.TotalSeconds)
  return
}

# ===== MSI =====
Write-Host "== インストーラー (MSI)"
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
  throw "wix がありません（dotnet tool install --global wix --version 7.0.0）"
}
$releaseDir = Join-Path $repo "release"
New-Item -ItemType Directory -Force $releaseDir | Out-Null
# ファイル名は表示名（製品名）と版。コマンドでの導入で引用符の付け忘れが起きないよう、空白は _ にする
$msi = Join-Path $releaseDir "3D施工検討Viewer_Kasane_$version.msi"
# ICE38/64/91 はユーザープロファイルへ入れる部品に「HKCU の値を KeyPath にする」「フォルダごとに RemoveFolder」を求める。
# ローミングしないユーザーごとのインストールでは不要で、フォルダ丸ごとの取り込み（Files）とは両立しないので外す。
# ICE61 は同じ版での上書き（AllowSameVersionUpgrades）を許したことへの警告
# 画面（UI）と完了後の起動（Util）の拡張。版は wix 本体と同じ 7.0.0 にそろえる
$wixExts = "WixToolset.UI.wixext", "WixToolset.Util.wixext"
$installedExts = (wix extension list -g) -join "`n"
foreach ($ext in $wixExts) {
  if ($installedExts -notmatch [regex]::Escape($ext)) {
    throw "wix の拡張 $ext がありません（wix extension add -g $ext/7.0.0）"
  }
}

# 利用規約は installer/license.txt（UTF-8 のプレーンテキスト）を正とし、インストーラー画面用の RTF をここで作る。
# {VERSION} は VERSION の値に置き換える。日本語は \uN（符号付き 16 bit）で書くので RTF のコードページに依存しない
$licenseTxt = Join-Path $repo "installer\license.txt"
$licenseRtf = Join-Path $repo "build\license.rtf"
$sb = [Text.StringBuilder]::new()
[void]$sb.Append('{\rtf1\ansi\ansicpg932\deff0{\fonttbl{\f0\fnil\fcharset128 Meiryo UI;}}\viewkind4\uc1\pard\f0\fs18 ')
$text = (Get-Content $licenseTxt -Raw -Encoding utf8).Replace("{VERSION}", $version) -replace "`r`n", "`n"
foreach ($ch in $text.ToCharArray()) {
  $c = [int]$ch
  if ($ch -eq "`n") { [void]$sb.Append("\par`r`n") }
  elseif ($ch -in '\', '{', '}') { [void]$sb.Append('\' + $ch) }
  elseif ($c -lt 0x80) { [void]$sb.Append($ch) }
  else { [void]$sb.Append('\u' + $(if ($c -gt 32767) { $c - 65536 } else { $c }) + '?') }
}
[void]$sb.Append('}')
New-Item -ItemType Directory -Force (Split-Path $licenseRtf) | Out-Null
Set-Content $licenseRtf $sb.ToString() -Encoding ascii -NoNewline

$wixArgs = @("-d", "Version=$version", "-d", "DistDir=$dist", "-d", "LicenseRtf=$licenseRtf",
  "-ext", "WixToolset.UI.wixext", "-ext", "WixToolset.Util.wixext", "-culture", "ja-JP")
# アイコン（exe と同じ app.ico）があれば「アプリと機能」にも出す
$appIcon = Join-Path $hostSrc "app.ico"
if (Test-Path $appIcon) { $wixArgs += @("-d", "IconFile=$appIcon") }
wix build (Join-Path $repo "installer\Kasane.wxs") -nologo -arch x64 @wixArgs -o $msi
if ($LASTEXITCODE -ne 0) { throw "MSI のビルドに失敗" }
wix msi validate $msi -nologo -sice ICE38 -sice ICE64 -sice ICE91 -sice ICE61
if ($LASTEXITCODE -ne 0) { throw "MSI の検証に失敗" }
Remove-Item ([IO.Path]::ChangeExtension($msi, ".wixpdb")) -ErrorAction SilentlyContinue
Write-Host ("完了（{0:N0} 秒）: {1}（{2:N0} MB）。これを配る" -f $sw.Elapsed.TotalSeconds, $msi, ((Get-Item $msi).Length / 1MB))
