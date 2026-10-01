<#
.SYNOPSIS
  共有フォルダに置く一式（干渉ビューア.exe・viewer/・tools/・config/）を dist/share に作る。

.PARAMETER Out
  出力先（既定: dist/share）。Box Drive の共有フォルダを直接指定してもよい（datasets/ 等は消さない）。
.PARAMETER SkipConverter
  変換エンジン（PyInstaller）の再ビルドを省く（既にあれば）。
.PARAMETER SkipHost
  ビューア exe の再ビルドを省く。
#>
param(
  [string]$Out = (Join-Path $PSScriptRoot "..\dist\share"),
  [switch]$SkipConverter,
  [switch]$SkipHost
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = Resolve-Path $Out

Write-Host "== viewer (HTML/JS)"
Push-Location (Join-Path $repo "viewer")
try {
  if (-not (Test-Path node_modules)) { npm ci }
  $env:CV_OUT_DIR = Join-Path $Out "viewer"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "viewer のビルドに失敗" }
} finally {
  Remove-Item Env:CV_OUT_DIR -ErrorAction SilentlyContinue
  Pop-Location
}

if (-not $SkipHost) {
  Write-Host "== host (干渉ビューア.exe)"
  $pub = Join-Path $repo "build\host"
  dotnet publish (Join-Path $repo "app\ClashViewer.Host\ClashViewer.Host.csproj") -c Release -o $pub --nologo -v quiet
  if ($LASTEXITCODE -ne 0) { throw "host のビルドに失敗" }
  Copy-Item (Join-Path $pub "ClashViewer.exe") (Join-Path $Out "干渉ビューア.exe") -Force
}

Write-Host "== tools/PotreeConverter"
$pcSrc = Get-ChildItem (Join-Path $repo "third_party\PotreeConverter") -Directory | Select-Object -First 1
if (-not $pcSrc) { throw "third_party/PotreeConverter がありません（scripts/fetch-third-party.ps1 を実行）" }
$pcDst = Join-Path $Out "tools\PotreeConverter"
New-Item -ItemType Directory -Force $pcDst | Out-Null
Copy-Item (Join-Path $pcSrc.FullName "*") $pcDst -Recurse -Force

$convDst = Join-Path $Out "tools\converter"
if (-not $SkipConverter -or -not (Test-Path (Join-Path $convDst "converter.exe"))) {
  Write-Host "== tools/converter (PyInstaller onedir)"
  Push-Location (Join-Path $repo "converter")
  try {
    uv sync --frozen 2>$null; if ($LASTEXITCODE -ne 0) { uv sync }
    uv run pyinstaller --noconfirm --clean --onedir --console --name converter `
      --distpath (Join-Path $repo "build\converter-dist") --workpath (Join-Path $repo "build\converter-work") `
      --specpath (Join-Path $repo "build") --collect-all pye57 --paths src pyi_entry.py
    if ($LASTEXITCODE -ne 0) { throw "変換エンジンのビルドに失敗" }
  } finally { Pop-Location }
  if (Test-Path $convDst) { Remove-Item $convDst -Recurse -Force }
  Copy-Item (Join-Path $repo "build\converter-dist\converter") $convDst -Recurse
}

Write-Host "== config"
$cfg = Join-Path $Out "config"
New-Item -ItemType Directory -Force (Join-Path $cfg "members") | Out-Null
$appJson = Join-Path $cfg "app.json"
if (-not (Test-Path $appJson)) {
  @{ pointBudget = 3000000 } | ConvertTo-Json | Set-Content -Encoding utf8 $appJson
}
foreach ($d in "datasets", "events", "issues") { New-Item -ItemType Directory -Force (Join-Path $Out $d) | Out-Null }

$size = (Get-ChildItem $Out -Recurse -File | Where-Object { $_.FullName -notmatch '\\(datasets|events|issues)\\' } | Measure-Object Length -Sum).Sum
Write-Host ("完了: {0}（アプリ一式 {1:N0} MB）" -f $Out, ($size / 1MB))
