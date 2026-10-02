# 画面（viewer/）だけを作り直して dist/viewer に置く（開発用の短縮版。exe・tools/ は scripts/build.ps1 で作っておく）
$ErrorActionPreference = "Stop"
$dist = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "dist"
Push-Location (Join-Path $PSScriptRoot "..\viewer")
try {
  npx tsc --noEmit
  if ($LASTEXITCODE -ne 0) { throw "型エラー" }
  $env:CV_OUT_DIR = Join-Path $dist "viewer"
  npx vite build --logLevel warn
  if ($LASTEXITCODE -ne 0) { throw "ビルド失敗" }
} finally {
  Remove-Item Env:CV_OUT_DIR -ErrorAction SilentlyContinue
  Pop-Location
}
