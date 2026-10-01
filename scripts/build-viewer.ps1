# 画面（viewer/）だけを作り直して dist/share/viewer に置く（開発用の短縮版）
param([string]$Out = (Join-Path $PSScriptRoot "..\dist\share"))
$ErrorActionPreference = "Stop"
Push-Location (Join-Path $PSScriptRoot "..\viewer")
try {
  npx tsc --noEmit
  if ($LASTEXITCODE -ne 0) { throw "型エラー" }
  $env:CV_OUT_DIR = Join-Path (Resolve-Path $Out) "viewer"
  npx vite build --logLevel warn
  if ($LASTEXITCODE -ne 0) { throw "ビルド失敗" }
} finally {
  Remove-Item Env:CV_OUT_DIR -ErrorAction SilentlyContinue
  Pop-Location
}
