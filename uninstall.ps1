<#
.SYNOPSIS
  Undo install.ps1: remove the DevTools MCP server and the bridge block.
#>
[CmdletBinding()]
param()

$scripts = Join-Path $PSScriptRoot 'scripts'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'devtools-setup.ps1') -Undo
Write-Host ''
Write-Host 'Removing the bridge block (Windows will ask for admin) ...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'bridge-block.ps1') -Undo
