<#
.SYNOPSIS
  Set up Tether: local-only Chrome control for Claude Code, and no remote access.

.DESCRIPTION
  1. scripts\devtools-setup.ps1 - Claude Code drives your real Chrome over
     127.0.0.1 through chrome-devtools-mcp (--autoConnect).
  2. scripts\bridge-block.ps1   - blocks Anthropic's hosted browser bridge in
     the hosts file, so Claude sessions on other computers can't drive this
     Chrome. Asks for admin.

  Run uninstall.ps1 to undo both.

.PARAMETER SkipDevTools
  Only block the bridge.

.PARAMETER SkipBlock
  Only set up the local DevTools connection.
#>
[CmdletBinding()]
param(
    [switch]$SkipDevTools,
    [switch]$SkipBlock
)

$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot 'scripts'

if (-not $SkipDevTools) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'devtools-setup.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host 'DevTools setup failed; the bridge was not blocked.' -ForegroundColor Red; exit 1 }
}

if (-not $SkipBlock) {
    Write-Host ''
    Write-Host 'Blocking the remote browser bridge (Windows will ask for admin) ...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'bridge-block.ps1')
}
