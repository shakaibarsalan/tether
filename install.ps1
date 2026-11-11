<#
.SYNOPSIS
  Set up Tether: local-only Chrome control for Claude Code, and no remote access.

.DESCRIPTION
  1. scripts\devtools-setup.ps1 - Claude Code drives your real Chrome over
     127.0.0.1 through chrome-devtools-mcp (--autoConnect).
  2. scripts\connect-watch-setup.ps1 - a background watcher, started at every
     login, that names the program behind each "Allow?" prompt from Chrome.
  3. scripts\bridge-block.ps1   - blocks Anthropic's hosted browser bridge in
     the hosts file, so Claude sessions on other computers can't drive this
     Chrome. Asks for admin.

  Run uninstall.ps1 to undo all of it.

.PARAMETER SkipDevTools
  Only block the bridge.

.PARAMETER SkipWatch
  Don't install the connect watch.

.PARAMETER Broker
  Also set up the Tether broker (scripts\broker-setup.ps1): Chrome asks "Allow?"
  once per Chrome start, and signed Claude desktop sessions get in without asking.

.PARAMETER SkipBlock
  Only set up the local DevTools connection.
#>
[CmdletBinding()]
param(
    [switch]$SkipDevTools,
    [switch]$SkipWatch,
    [switch]$Broker,
    [switch]$SkipBlock
)

$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot 'scripts'

if (-not $SkipDevTools) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'devtools-setup.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host 'DevTools setup failed; the bridge was not blocked.' -ForegroundColor Red; exit 1 }

    if (-not $SkipWatch) {
        Write-Host ''
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'connect-watch-setup.ps1')
        if ($LASTEXITCODE -ne 0) { Write-Host 'The connect watch did not start (the rest of the setup is fine).' -ForegroundColor Yellow }
    }

    if ($Broker) {
        Write-Host ''
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'broker-setup.ps1')
        if ($LASTEXITCODE -ne 0) { Write-Host 'The broker did not start; Claude Code still connects straight to Chrome.' -ForegroundColor Yellow }
    }
}

if (-not $SkipBlock) {
    Write-Host ''
    Write-Host 'Blocking the remote browser bridge (Windows will ask for admin) ...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'bridge-block.ps1')
}
