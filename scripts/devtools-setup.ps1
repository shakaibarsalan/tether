<#
.SYNOPSIS
  Let Claude Code drive your real Chrome over a local DevTools connection.

.DESCRIPTION
  Installs chrome-devtools-mcp (Google's official DevTools MCP server), pinned
  to one version, and registers it in Claude Code's user config with
  --autoConnect. Claude Code then attaches to the Chrome you already have open,
  with all your profiles and logins, over 127.0.0.1. Nothing goes through a
  Claude account, so nobody on another computer can use this path.

  Why a global npm install instead of npx: disk cleaners often wipe the npx
  cache, and a pinned global install starts faster and never changes under you.

  After running this, turn on chrome://inspect/#remote-debugging in Chrome once.
  Chrome then asks "Allow?" each time a new Claude Code session connects.

.PARAMETER Version
  chrome-devtools-mcp version to install. Pinned on purpose.

.PARAMETER Name
  Name of the MCP server in Claude Code.

.PARAMETER Undo
  Unregister the MCP server and uninstall the npm package.
#>
[CmdletBinding()]
param(
    [string]$Version = '1.12.0',
    [string]$Name = 'chrome-devtools',
    [switch]$Undo
)

$ErrorActionPreference = 'Stop'

function Stop-With([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Stop-With 'Claude Code (the "claude" command) was not found. Install Claude Code first.' }

if ($Undo) {
    & $claude.Source mcp remove $Name -s user 2>$null | Out-Null
    & npm uninstall -g chrome-devtools-mcp 2>$null | Out-Null
    Write-Host "Removed the '$Name' MCP server and uninstalled chrome-devtools-mcp."
    Write-Host 'You can also turn off chrome://inspect/#remote-debugging in Chrome.'
    exit 0
}

# Node.js 20.19+ (chrome-devtools-mcp's own requirement).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Stop-With 'Node.js 20.19 or newer is needed: https://nodejs.org' }
$nodeVersion = [version](((& $node.Source -v) -replace '^v', '').Trim())
if ($nodeVersion -lt [version]'20.19.0') { Stop-With "Node.js $nodeVersion is too old. Install 20.19 or newer." }

# Chrome 144+ (needed for --autoConnect).
$chromeVersion = $null
try { $chromeVersion = [version](Get-ItemProperty 'HKCU:\Software\Google\Chrome\BLBeacon' -ErrorAction Stop).version } catch {}
if ($chromeVersion -and $chromeVersion.Major -lt 144) {
    Stop-With "Chrome $chromeVersion is too old for --autoConnect. Update Chrome to 144 or newer."
}

Write-Host "Installing chrome-devtools-mcp@$Version ..."
& npm install -g "chrome-devtools-mcp@$Version" | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-With 'npm install failed.' }

$npmRoot = (& npm root -g).Trim()
$entry = Join-Path $npmRoot 'chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js'
if (-not (Test-Path -LiteralPath $entry)) { Stop-With "Installed, but the entry file is missing: $entry" }

Write-Host "Registering the '$Name' MCP server in Claude Code (user scope) ..."
& $claude.Source mcp remove $Name -s user 2>$null | Out-Null
# --no-page-id-routing: tools act on the tab Claude last used, so hooks (like
# tab-marker.ps1) can call them without a numeric page id. Each Claude Code
# session runs its own server, so sessions still don't share a "current tab".
& $claude.Source mcp add --scope user $Name `
    -e CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 `
    -- ($node.Source -replace '\\', '/') ($entry -replace '\\', '/') `
    --autoConnect --no-page-id-routing --no-usage-statistics --no-performance-crux `
    --screenshotFormat=jpeg --screenshotMaxWidth=1400 | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-With 'claude mcp add failed.' }

Write-Host ''
Write-Host 'Done. Two steps left, once:' -ForegroundColor Green
Write-Host '  1. In Chrome, open  chrome://inspect/#remote-debugging  and tick'
Write-Host '     "Allow remote debugging for this browser instance".'
Write-Host '  2. Start a NEW Claude Code session. The first time it uses the browser,'
Write-Host '     Chrome asks "Allow?" - click Allow.'
Write-Host ''
Write-Host 'Tip: before leaving Claude to work on its own, ask it to connect to the'
Write-Host 'browser first, so the Allow prompt comes up while you are still there.'
exit 0
