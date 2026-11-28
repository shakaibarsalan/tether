<#
.SYNOPSIS
  Tell every Claude Code session how the browser works here, at its start.

.DESCRIPTION
  Adds hooks/session-start.mjs to ~/.claude/settings.json as a SessionStart
  hook (a new chat, a fork, a resumed chat, /clear, compaction). Each session
  then knows to use Tether's chrome-devtools tools and never the Claude in
  Chrome extension (or to ask you to reconnect it), how tabs work, and your
  Chrome profiles: which one has the Tether extension, where its new tabs open.
  Also denies the extension's tools (mcp__claude-in-chrome), so no chat keeps
  trying them. Backs up settings.json.

.PARAMETER Undo
  Remove the hook and the deny rule.
#>
[CmdletBinding()]
param(
    [switch]$Undo,
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20.19 or newer is needed: https://nodejs.org' }
$tool = Join-Path $PSScriptRoot 'lib\claude-settings.mjs'
$argsList = @($tool, 'session-start', '--node', $node.Source, '--claude-dir', $ClaudeDir)
if ($Undo) { $argsList += '--undo' }
& $node.Source @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Undo) { Write-Host 'Session start hook removed; the Claude in Chrome tools are no longer denied.' }
else { Write-Host 'Every new Claude Code session now starts knowing how the browser works here.' -ForegroundColor Green }
