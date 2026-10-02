<#
.SYNOPSIS
  配布一式（干渉ビューア.exe・viewer/・tools/）を dist/ に作り、インストーラー release/干渉ビューア-<版>.msi を作る。

.DESCRIPTION
  バージョンはリポジトリ直下の VERSION が唯一の正（SSOT）。exe（csproj が直接読む）・変換エンジン（_version.py を生成）・
  MSI（wix build -d Version）はすべてここから決まる。版を上げるときは VERSION だけを書き換える。

  dist/ はこのスクリプトが毎回作り直す（中身は全部消える）。データ（config/・datasets/・events/・issues/）は
  入れない。開発・E2E で使うデータは dev/share に置く（README 参照）。
  リリースは release/ の MSI を配る（利用者がダブルクリックで入れる。管理者権限は要らない）。

.PARAMETER SkipConverter
  変換エンジン（PyInstaller）の再ビルドを省き、前回の build/converter-dist を使う（無い・版が違うときはビルドする）。
.PARAMETER SkipHost
  ビューア exe の再ビルドを省き、前回の build/host を使う（無い・版が違うときはビルドする）。
.PARAMETER SkipMsi
  MSI を作らない（dist/ だけ作る。開発・E2E 用の短縮）。
#>
param(
  [switch]$SkipConverter,
  [switch]$SkipHost,
  [switch]$SkipMsi
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $repo "dist"

# ===== バージョン（SSOT） =====
$version = (Get-Content (Join-Path $repo "VERSION") -Raw).Trim()
# MSI の ProductVersion の制約（major.minor.build がそれぞれ 255・255・65535 まで）に合わせて x.y.z に限る
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$' -or [int]$Matches[1] -gt 255 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 65535) {
  throw "VERSION は x.y.z（x,y は 0〜255、z は 0〜65535）で書く: '$version'"
}
Write-Host "== バージョン $version"

# dist/ は作り直す。データが紛れていたら消さずに止める（以前は dist/share をデータ置き場にも使っていたため）
if (Test-Path $dist) {
  $data = Get-ChildItem $dist -Recurse -Directory -Depth 1 | Where-Object { $_.Name -in "datasets", "events", "issues", "config" }
  if ($data) {
    throw "dist/ にデータのフォルダがあります（$($data.FullName -join ', ')）。dev/share へ移してから実行してください"
  }
  Remove-Item $dist -Recurse -Force
}
New-Item -ItemType Directory -Force $dist | Out-Null

Write-Host "== viewer (HTML/JS)"
Push-Location (Join-Path $repo "viewer")
try {
  if (-not (Test-Path node_modules)) { npm ci }
  $env:CV_OUT_DIR = Join-Path $dist "viewer"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "viewer のビルドに失敗" }
} finally {
  Remove-Item Env:CV_OUT_DIR -ErrorAction SilentlyContinue
  Pop-Location
}

Write-Host "== host (干渉ビューア.exe)"
$pub = Join-Path $repo "build\host"
$hostExe = Join-Path $pub "ClashViewer.exe"
# 前回の exe を使い回すのは、版が VERSION と同じときだけ
$hostStale = -not (Test-Path $hostExe) -or ((Get-Item $hostExe).VersionInfo.ProductVersion -split '\+')[0] -ne $version
if (-not $SkipHost -or $hostStale) {
  dotnet publish (Join-Path $repo "app\ClashViewer.Host\ClashViewer.Host.csproj") -c Release -o $pub --nologo -v quiet
  if ($LASTEXITCODE -ne 0) { throw "host のビルドに失敗" }
}
Copy-Item $hostExe (Join-Path $dist "干渉ビューア.exe")

Write-Host "== tools/PotreeConverter"
$pcSrc = Get-ChildItem (Join-Path $repo "third_party\PotreeConverter") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pcSrc) { throw "third_party/PotreeConverter がありません（scripts/fetch-third-party.ps1 を実行）" }
$pcDst = Join-Path $dist "tools\PotreeConverter"
New-Item -ItemType Directory -Force $pcDst | Out-Null
# 変換に要るのは exe と laszip.dll だけ。resources/page_template（約 400 ファイル・47 MB）は
# --generate-page 用の Web ビューア一式で使わないので入れない。ライセンス表示は残す
foreach ($name in "PotreeConverter.exe", "laszip.dll") {
  $f = Join-Path $pcSrc.FullName $name
  if (-not (Test-Path $f)) { throw "third_party/PotreeConverter に $name がありません" }
  Copy-Item $f $pcDst
}
Copy-Item (Join-Path $pcSrc.FullName "licenses") $pcDst -Recurse

Write-Host "== tools/converter (PyInstaller onedir)"
$convBuilt = Join-Path $repo "build\converter-dist\converter"
$convStamp = Join-Path $repo "build\converter-dist\converter.version"
$convStale = -not (Test-Path (Join-Path $convBuilt "converter.exe")) -or -not (Test-Path $convStamp) -or (Get-Content $convStamp -Raw).Trim() -ne $version
if (-not $SkipConverter -or $convStale) {
  # exe 化すると VERSION ファイルを読めないので、版を埋め込んだモジュールを生成する（コミットしない）
  $verPy = Join-Path $repo "converter\src\clash_converter\_version.py"
  Set-Content $verPy "# scripts/build.ps1 が VERSION から生成する。編集しない`nVERSION = `"$version`"`n" -Encoding utf8NoBOM
  Push-Location (Join-Path $repo "converter")
  try {
    uv sync --frozen 2>$null; if ($LASTEXITCODE -ne 0) { uv sync }
    uv run pyinstaller --noconfirm --clean --onedir --console --name converter `
      --distpath (Join-Path $repo "build\converter-dist") --workpath (Join-Path $repo "build\converter-work") `
      --specpath (Join-Path $repo "build") --collect-all pye57 --paths src pyi_entry.py
    if ($LASTEXITCODE -ne 0) { throw "変換エンジンのビルドに失敗" }
  } finally {
    Pop-Location
    # 開発時（uv run）は VERSION を直接読むので、生成物は残さない
    Remove-Item $verPy -ErrorAction SilentlyContinue
  }
  Set-Content $convStamp $version -Encoding utf8NoBOM
}
$convVer = (& (Join-Path $convBuilt "converter.exe") --version).Trim()
if ($convVer -ne $version) { throw "変換エンジンの版（$convVer）が VERSION（$version）と違います" }
Copy-Item $convBuilt (Join-Path $dist "tools\converter") -Recurse

$size = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("dist: {0}（{1:N0} MB）" -f $dist, ($size / 1MB))

if ($SkipMsi) { return }

Write-Host "== installer (MSI)"
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
  throw "wix がありません（dotnet tool install --global wix --version 7.0.0）"
}
$release = Join-Path $repo "release"
New-Item -ItemType Directory -Force $release | Out-Null
$msi = Join-Path $release "干渉ビューア-$version.msi"
# ICE38/64/91 はユーザープロファイルへ入れる部品に「HKCU の値を KeyPath にする」「フォルダごとに RemoveFolder」を求める。
# ローミングしないユーザーごとのインストールでは不要で、フォルダ丸ごとの取り込み（Files）とは両立しないので外す。
# ICE61 は同じ版での上書き（AllowSameVersionUpgrades）を許したことへの警告
wix build (Join-Path $repo "installer\ClashViewer.wxs") -nologo -arch x64 `
  -d "Version=$version" -d "DistDir=$dist" -o $msi
if ($LASTEXITCODE -ne 0) { throw "MSI のビルドに失敗" }
wix msi validate $msi -nologo -sice ICE38 -sice ICE64 -sice ICE91 -sice ICE61
if ($LASTEXITCODE -ne 0) { throw "MSI の検証に失敗" }
Remove-Item ([IO.Path]::ChangeExtension($msi, ".wixpdb")) -ErrorAction SilentlyContinue
Write-Host ("完了: {0}（{1:N0} MB）。これを配る" -f $msi, ((Get-Item $msi).Length / 1MB))
