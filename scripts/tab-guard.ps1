<#
.SYNOPSIS
  Keep Claude out of the tab you're using: it has to open its own.

.DESCRIPTION
  Adds hooks/tab-guard.mjs to ~/.claude/settings.json as a PreToolUse hook on
  every chrome-devtools tool and a PostToolUse hook on new_page. Claude can
  look at any tab, but before it navigates, clicks or types it has to open its
  own tab (new_page) or deliberately pick one (select_page). Picking or closing
  a tab it didn't open is refused once with the reason; Claude repeats the call
  only when you asked for that tab.

  Applies to new tool calls in all Claude Code sessions. Backs up settings.json.

.PARAMETER Undo
  Remove the hooks.

.PARAMETER Server
  Name of the chrome-devtools MCP server in Claude Code.
#>
[CmdletBinding()]
param(
    [switch]$Undo,
    [string]$Server = 'chrome-devtools',
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude'),
    [string]$Node = ''
)

$ErrorActionPreference = 'Stop'
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch {}

$settingsPath = Join-Path $ClaudeDir 'settings.json'
$guard = (Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\tab-guard.mjs') -replace '\\', '/'
if (-not $Node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd -and -not $Undo) { throw 'Node.js is needed for the tab guard: https://nodejs.org' }
    if ($cmd) { $Node = $cmd.Source }
}
$Node = $Node -replace '\\', '/'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Test-IsGuardEntry($Entry) {
    foreach ($h in @($Entry.hooks)) {
        if ($null -ne $h -and (@($h.args) -join ' ') -match 'tab-guard\.mjs') { return $true }
    }
    return $false
}

$settings = [pscustomobject]@{}
$backup = $null
if (Test-Path -LiteralPath $settingsPath) {
    $text = [IO.File]::ReadAllText($settingsPath)
    $backup = "$settingsPath.before-tab-guard-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $settingsPath -Destination $backup -Force
    if ($text.Trim()) {
        try { $settings = ConvertFrom-Json -InputObject $text }
        catch { throw "Couldn't read $settingsPath (is it valid JSON?). Nothing was changed. Details: $($_.Exception.Message)" }
    }
}
if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
}

$hook = [pscustomobject][ordered]@{ type = 'command'; command = $Node; args = @($guard); timeout = 10 }
$wanted = @{
    PreToolUse  = [pscustomobject]@{ matcher = "mcp__$($Server)__.*"; hooks = @($hook) }
    PostToolUse = [pscustomobject]@{ matcher = "mcp__$($Server)__new_page"; hooks = @($hook) }
}
foreach ($event in 'PreToolUse', 'PostToolUse') {
    $list = @()
    if ($settings.hooks.PSObject.Properties[$event]) {
        $list = @(@($settings.hooks.$event) | Where-Object { $null -ne $_ -and -not (Test-IsGuardEntry $_) })
    }
    if (-not $Undo) { $list = @($list) + @($wanted[$event]) }
    if ($list.Count -eq 0) {
        if ($settings.hooks.PSObject.Properties[$event]) { $settings.hooks.PSObject.Properties.Remove($event) }
    } elseif ($settings.hooks.PSObject.Properties[$event]) {
        $settings.hooks.$event = $list
    } else {
        $settings.hooks | Add-Member -NotePropertyName $event -NotePropertyValue $list
    }
}
if (@($settings.hooks.PSObject.Properties).Count -eq 0) { $settings.PSObject.Properties.Remove('hooks') }

$json = ConvertTo-Json -InputObject $settings -Depth 64
$null = ConvertFrom-Json -InputObject $json  # refuse to write anything unreadable
[IO.File]::WriteAllText($settingsPath, $json, $utf8)

if ($Undo) { Write-Host 'Tab guard removed.' } else { Write-Host 'Tab guard installed. Claude now opens its own tab before acting.' }
if ($backup) { Write-Host "Settings backup: $backup" }
