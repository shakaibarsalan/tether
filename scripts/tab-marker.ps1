<#
.SYNOPSIS
  Mark the Chrome tabs Claude Code is driving: a robot in the title, a thin orange
  frame and a small "Claude" badge.

.DESCRIPTION
  The Claude in Chrome extension put its tabs in an orange "Claude" tab group.
  The DevTools connection doesn't, so you can't see which tab Claude is in.

  This adds a PostToolUse hook to ~/.claude/settings.json. After each
  chrome-devtools action (navigate, new tab, click, type, ...), the hook runs
  hooks/claude-tab-marker.js in the tab Claude just used, through the same
  chrome-devtools MCP server. Other tabs are left alone, and the frame and badge
  never block clicks.

  It needs the server registered with --no-page-id-routing (devtools-setup.ps1
  does that), because hook inputs can't carry a numeric page id. Start a new
  Claude Code session afterwards.

.PARAMETER Undo
  Remove the hook.

.PARAMETER Server
  Name of the chrome-devtools MCP server in Claude Code.
#>
[CmdletBinding()]
param(
    [switch]$Undo,
    [string]$Server = 'chrome-devtools',
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch {}

$settingsPath = Join-Path $ClaudeDir 'settings.json'
$markerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\claude-tab-marker.js'
$markerJs = [IO.File]::ReadAllText($markerPath).Trim()
$utf8 = New-Object System.Text.UTF8Encoding($false)
$matcher = "mcp__$($Server)__(navigate_page|new_page|select_page|click|fill|fill_form|type_text|press_key|hover|drag|upload_file|handle_dialog)"

function Test-IsMarkerEntry($Entry) {
    foreach ($h in @($Entry.hooks)) {
        if ($null -eq $h) { continue }
        if ([string]$h.type -eq 'mcp_tool' -and [string]$h.tool -eq 'evaluate_script' -and
            ([string]$h.input.function) -match '__claudeTabMarker') { return $true }
    }
    return $false
}

$settings = [pscustomobject]@{}
$backup = $null
if (Test-Path -LiteralPath $settingsPath) {
    $text = [IO.File]::ReadAllText($settingsPath)
    $backup = "$settingsPath.before-tab-marker-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $settingsPath -Destination $backup -Force
    if ($text.Trim()) {
        try { $settings = ConvertFrom-Json -InputObject $text }
        catch { throw "Couldn't read $settingsPath (is it valid JSON?). Nothing was changed. Details: $($_.Exception.Message)" }
    }
}
if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
}

$list = @()
if ($settings.hooks.PSObject.Properties['PostToolUse']) {
    $list = @(@($settings.hooks.PostToolUse) | Where-Object { $null -ne $_ -and -not (Test-IsMarkerEntry $_) })
}
if (-not $Undo) {
    $hook = [pscustomobject][ordered]@{
        type          = 'mcp_tool'
        server        = $Server
        tool          = 'evaluate_script'
        input         = [pscustomobject]@{ function = $markerJs }
        timeout       = 15
        statusMessage = "Marking Claude's tab"
    }
    $list = @($list) + @([pscustomobject]@{ matcher = $matcher; hooks = @($hook) })
}

if ($list.Count -eq 0) {
    if ($settings.hooks.PSObject.Properties['PostToolUse']) { $settings.hooks.PSObject.Properties.Remove('PostToolUse') }
} elseif ($settings.hooks.PSObject.Properties['PostToolUse']) {
    $settings.hooks.PostToolUse = $list
} else {
    $settings.hooks | Add-Member -NotePropertyName 'PostToolUse' -NotePropertyValue $list
}
if (@($settings.hooks.PSObject.Properties).Count -eq 0) { $settings.PSObject.Properties.Remove('hooks') }

$json = ConvertTo-Json -InputObject $settings -Depth 64
$null = ConvertFrom-Json -InputObject $json  # refuse to write anything unreadable
[IO.File]::WriteAllText($settingsPath, $json, $utf8)

if ($Undo) { Write-Host 'Tab marker removed.' } else { Write-Host 'Tab marker installed. Start a new Claude Code session.' }
if ($backup) { Write-Host "Settings backup: $backup" }
