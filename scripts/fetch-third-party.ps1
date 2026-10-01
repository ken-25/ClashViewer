# 同梱する外部バイナリ（PotreeConverter 2.x）を third_party/ に取得する。開発時に 1 回だけ実行する。
param([string]$Version = "2.1.5")
$ErrorActionPreference = "Stop"
$dst = Join-Path $PSScriptRoot "..\third_party"
New-Item -ItemType Directory -Force $dst | Out-Null
$zip = Join-Path $dst "PotreeConverter_${Version}_x64_windows.zip"
if (-not (Test-Path $zip)) {
  Invoke-WebRequest "https://github.com/potree/PotreeConverter/releases/download/$Version/PotreeConverter_${Version}_x64_windows.zip" -OutFile $zip
}
Expand-Archive -Force $zip (Join-Path $dst "PotreeConverter")
Write-Host "PotreeConverter $Version を展開しました"
