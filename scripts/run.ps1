<#
.SYNOPSIS
  開発用に dist/干渉ビューア.exe を起動する。データは dev/share（既定）を使い、dist/ には何も書かない。

.PARAMETER Root
  共有データのルート（既定: dev/share）。Box 上の共有フォルダを指定すれば、手元のビルドで本番データを見られる。
.PARAMETER NoDev
  開発モード（開発者ツール等）を付けずに起動する。
#>
param(
  [string]$Root = (Join-Path $PSScriptRoot "..\dev\share"),
  [switch]$NoDev
)
$ErrorActionPreference = "Stop"
$exe = Join-Path $PSScriptRoot "..\dist\干渉ビューア.exe"
if (-not (Test-Path $exe)) { throw "dist/干渉ビューア.exe がありません（scripts/build.ps1 を実行）" }
New-Item -ItemType Directory -Force $Root | Out-Null
# Start-Process は配列を空白でつなぐだけなので、空白を含むパスは自分で囲む
$args_ = @("--root", ('"{0}"' -f (Resolve-Path $Root).Path))
if (-not $NoDev) { $args_ += "--dev" }
Start-Process $exe -ArgumentList $args_
