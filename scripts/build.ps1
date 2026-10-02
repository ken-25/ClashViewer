<#
.SYNOPSIS
  共有フォルダへそのまま上書きコピーしてよい配布一式（干渉ビューア.exe・viewer/・tools/）を dist/ に作る。

.DESCRIPTION
  dist/ はこのスクリプトが毎回作り直す（中身は全部消える）。データ（config/・datasets/・events/・issues/）は
  入れない。開発・E2E で使うデータは dev/share に置く（README 参照）。
  リリースは dist/ の中身を共有フォルダへ手動でコピーする。

.PARAMETER SkipConverter
  変換エンジン（PyInstaller）の再ビルドを省き、前回の build/converter-dist を使う（無ければビルドする）。
.PARAMETER SkipHost
  ビューア exe の再ビルドを省き、前回の build/host を使う（無ければビルドする）。
#>
param(
  [switch]$SkipConverter,
  [switch]$SkipHost
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $repo "dist"

# dist/ は作り直す。共有データが紛れていたら消さずに止める（以前は dist/share をデータ置き場にも使っていたため）
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
if (-not $SkipHost -or -not (Test-Path $hostExe)) {
  dotnet publish (Join-Path $repo "app\ClashViewer.Host\ClashViewer.Host.csproj") -c Release -o $pub --nologo -v quiet
  if ($LASTEXITCODE -ne 0) { throw "host のビルドに失敗" }
}
Copy-Item $hostExe (Join-Path $dist "干渉ビューア.exe")

Write-Host "== tools/PotreeConverter"
$pcSrc = Get-ChildItem (Join-Path $repo "third_party\PotreeConverter") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pcSrc) { throw "third_party/PotreeConverter がありません（scripts/fetch-third-party.ps1 を実行）" }
$pcDst = Join-Path $dist "tools\PotreeConverter"
New-Item -ItemType Directory -Force $pcDst | Out-Null
Copy-Item (Join-Path $pcSrc.FullName "*") $pcDst -Recurse

Write-Host "== tools/converter (PyInstaller onedir)"
$convBuilt = Join-Path $repo "build\converter-dist\converter"
if (-not $SkipConverter -or -not (Test-Path (Join-Path $convBuilt "converter.exe"))) {
  Push-Location (Join-Path $repo "converter")
  try {
    uv sync --frozen 2>$null; if ($LASTEXITCODE -ne 0) { uv sync }
    uv run pyinstaller --noconfirm --clean --onedir --console --name converter `
      --distpath (Join-Path $repo "build\converter-dist") --workpath (Join-Path $repo "build\converter-work") `
      --specpath (Join-Path $repo "build") --collect-all pye57 --paths src pyi_entry.py
    if ($LASTEXITCODE -ne 0) { throw "変換エンジンのビルドに失敗" }
  } finally { Pop-Location }
}
Copy-Item $convBuilt (Join-Path $dist "tools\converter") -Recurse

$size = (Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("完了: {0}（{1:N0} MB）。中身を共有フォルダへ上書きコピーすればリリースになる" -f $dist, ($size / 1MB))
Get-ChildItem $dist | ForEach-Object { Write-Host "  $($_.Name)" }
