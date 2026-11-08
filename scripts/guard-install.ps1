<#
.SYNOPSIS
  Install the guard hook: Claude Code on this computer may only drive the
  Chrome browsers you allow.

.DESCRIPTION
  Copies hooks\chrome_browser_guard.ps1 into Claude Code's hooks folder, writes
  the allowed-browsers file, backs up settings.json, adds the hook entries
  (PreToolUse with onFailure=block, PostToolUse to confirm the browser in use),
  and runs a self-test. Running it again is safe: it replaces its own entries
  and keeps everything else.

  Find your deviceId by asking Claude Code to run list_connected_browsers. If
  more than one browser is listed, pick the one on THIS computer.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\guard-install.ps1 -DeviceId 01234567-89ab-cdef-0123-456789abcdef
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DeviceId,
    [string]$Note = 'my own browser',
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch {}

$DeviceId = $DeviceId.Trim().ToLowerInvariant()
if ($DeviceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    throw "That doesn't look like a browser deviceId: '$DeviceId'. Ask Claude Code to run list_connected_browsers and copy your browser's deviceId."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$hooksDir = Join-Path $ClaudeDir 'hooks'
$guardSource = Join-Path $repoRoot 'hooks\chrome_browser_guard.ps1'
$guardPath = Join-Path $hooksDir 'chrome_browser_guard.ps1'
$allowedPath = Join-Path $hooksDir 'chrome-allowed-devices.txt'
$settingsPath = Join-Path $ClaudeDir 'settings.json'
$powershellExe = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -replace '\\', '/'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 1. Copy the guard into Claude's hooks folder.
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
Copy-Item -LiteralPath $guardSource -Destination $guardPath -Force

# 2. Write the allowed-browsers file (keeps any IDs already in it).
$lines = New-Object 'System.Collections.Generic.List[string]'
if (Test-Path -LiteralPath $allowedPath) {
    foreach ($line in [IO.File]::ReadAllLines($allowedPath)) { $lines.Add($line) }
} else {
    $lines.Add('# Tether guard: the ONLY browsers Claude Code on this computer may control.')
    $lines.Add('# One deviceId per line. Anything after # is a note.')
}
$known = @($lines | ForEach-Object { (($_ -split '#', 2)[0].Trim() -split '\s+')[0].ToLowerInvariant() } | Where-Object { $_ })
if ($known -notcontains $DeviceId) {
    $lines.Add("$DeviceId  # $Note (added $(Get-Date -Format 'yyyy-MM-dd'))")
}
[IO.File]::WriteAllLines($allowedPath, [string[]]$lines, $utf8)

# 3. Register the guard in Claude Code's user settings (backup first).
function New-HookEntry([string]$Matcher, [string]$Status, [bool]$BlockOnFailure) {
    $hook = [ordered]@{
        type          = 'command'
        command       = $powershellExe
        args          = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ($guardPath -replace '\\', '/'))
        timeout       = 20
        statusMessage = $Status
    }
    if ($BlockOnFailure) { $hook['onFailure'] = 'block' }
    return [pscustomobject]@{ matcher = $Matcher; hooks = @([pscustomobject]$hook) }
}

function Test-IsGuardEntry($Entry) {
    foreach ($h in @($Entry.hooks)) {
        if ($null -eq $h) { continue }
        $text = ([string]$h.command) + ' ' + ((@($h.args) | ForEach-Object { [string]$_ }) -join ' ')
        if ($text -match 'chrome_browser_guard') { return $true }
    }
    return $false
}

$settings = [pscustomobject]@{}
$backup = $null
if (Test-Path -LiteralPath $settingsPath) {
    $text = [IO.File]::ReadAllText($settingsPath)
    $backup = "$settingsPath.before-tether-guard-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $settingsPath -Destination $backup -Force
    if ($text.Trim()) {
        try { $settings = ConvertFrom-Json -InputObject $text }
        catch { throw "Couldn't read $settingsPath (is it valid JSON?). Nothing was changed in it. Details: $($_.Exception.Message)" }
    }
}

if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
}
$wanted = @{
    PreToolUse  = (New-HookEntry 'mcp__claude-in-chrome__.*' 'Checking Chrome browser lock' $true)
    PostToolUse = (New-HookEntry 'mcp__claude-in-chrome__(select_browser|list_connected_browsers)' 'Confirming Chrome browser' $false)
}
foreach ($eventName in @('PreToolUse', 'PostToolUse')) {
    $list = @()
    if ($settings.hooks.PSObject.Properties[$eventName]) {
        $list = @(@($settings.hooks.$eventName) | Where-Object { $null -ne $_ -and -not (Test-IsGuardEntry $_) })
    }
    $list = @($list) + @($wanted[$eventName])
    if ($settings.hooks.PSObject.Properties[$eventName]) {
        $settings.hooks.$eventName = $list
    } else {
        $settings.hooks | Add-Member -NotePropertyName $eventName -NotePropertyValue $list
    }
}

$json = ConvertTo-Json -InputObject $settings -Depth 64
$null = ConvertFrom-Json -InputObject $json  # refuse to write anything unreadable
[IO.File]::WriteAllText($settingsPath, $json, $utf8)

# 4. Self-test the installed guard.
$testSession = 'tether-selftest-' + [guid]::NewGuid().ToString('N')
$foreignId = [guid]::NewGuid().ToString()
$OutputEncoding = $utf8
function Invoke-Guard([hashtable]$Payload) {
    $Payload['session_id'] = $testSession
    $body = ConvertTo-Json -InputObject $Payload -Depth 10 -Compress
    $out = $body | & $powershellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $guardPath
    $out = (@($out) -join '').Trim()
    if (-not $out) { return 'allow' }
    return (ConvertFrom-Json -InputObject $out).hookSpecificOutput.permissionDecision
}
$listText = ConvertTo-Json -InputObject @([ordered]@{ deviceId = $DeviceId; inUse = $true }) -Compress
$results = [ordered]@{}
$results['browser blocked before check'] = (Invoke-Guard @{ hook_event_name = 'PreToolUse'; tool_name = 'mcp__claude-in-chrome__navigate'; tool_input = @{ url = 'https://example.com' } }) -eq 'deny'
$results['broadcast connect blocked'] = (Invoke-Guard @{ hook_event_name = 'PreToolUse'; tool_name = 'mcp__claude-in-chrome__switch_browser'; tool_input = @{} }) -eq 'deny'
$results['another browser blocked'] = (Invoke-Guard @{ hook_event_name = 'PreToolUse'; tool_name = 'mcp__claude-in-chrome__select_browser'; tool_input = @{ deviceId = $foreignId } }) -eq 'deny'
$null = Invoke-Guard @{ hook_event_name = 'PostToolUse'; tool_name = 'mcp__claude-in-chrome__list_connected_browsers'; tool_input = @{}; tool_response = @(@{ type = 'text'; text = $listText }) }
$results['your browser allowed after check'] = (Invoke-Guard @{ hook_event_name = 'PreToolUse'; tool_name = 'mcp__claude-in-chrome__navigate'; tool_input = @{ url = 'https://example.com' } }) -eq 'allow'
$stateFile = Join-Path (Join-Path $hooksDir 'chrome-guard-state') $testSession
if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }

Write-Host ''
Write-Host 'Guard installed.'
Write-Host "  Allowed browser : $DeviceId"
Write-Host "  Guard           : $guardPath"
Write-Host "  Settings        : $settingsPath"
if ($backup) { Write-Host "  Settings backup : $backup" }
Write-Host ''
$failed = 0
foreach ($k in $results.Keys) {
    if ($results[$k]) { Write-Host "  PASS  $k" } else { Write-Host "  FAIL  $k"; $failed++ }
}
Write-Host ''
if ($failed) {
    Write-Host "$failed self-test(s) failed. Run scripts\guard-uninstall.ps1 and open an issue."
    exit 1
}
Write-Host 'All self-tests passed. Start a NEW Claude Code session so the guard loads.'
