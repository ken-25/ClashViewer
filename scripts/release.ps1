<#
.SYNOPSIS
  リリース用ビルド。dist/ を空にして画面・exe・変換エンジンをすべて作り直し、release/3D施工検討Viewer_Kasane_<版>.msi を作る。
  中身は scripts/build.ps1 -Release と同じ。
#>
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "build.ps1") -Release
