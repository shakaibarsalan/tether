<#
.SYNOPSIS
  Undo install.ps1: remove the broker, the DevTools MCP server, the connect watch and the bridge block.
#>
[CmdletBinding()]
param()

$scripts = Join-Path $PSScriptRoot 'scripts'
if (Get-ScheduledTask -TaskName 'Tether broker' -ErrorAction SilentlyContinue) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'broker-setup.ps1') -Undo
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'devtools-setup.ps1') -Undo
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'connect-watch-setup.ps1') -Undo
Write-Host ''
Write-Host 'Removing the bridge block (Windows will ask for admin) ...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'bridge-block.ps1') -Undo
