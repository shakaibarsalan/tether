<#
Claude in Chrome browser lock (Windows PowerShell version).

Runs as a Claude Code PreToolUse and PostToolUse hook on the
mcp__claude-in-chrome__* tools. Several people's Chrome browsers can be
connected to the same Claude account, and without this lock a Claude session
can attach to someone else's browser and open their Gmail.

Rules:
  * Only device IDs listed in chrome-allowed-devices.txt (next to this file)
    may be controlled.
  * switch_browser is always refused: it sends a connect request to every
    browser on the account.
  * select_browser is refused for any device not in the allowed list.
  * Every other browser tool is refused until list_connected_browsers has
    shown, in this session, that the browser in use is an allowed one. That
    check stays valid for 30 minutes, and choosing a browser again resets it.

It fails closed: if anything goes wrong while checking, the browser action is
refused rather than let through.
#>

$ErrorActionPreference = 'Stop'
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch {}

$Prefix = 'mcp__claude-in-chrome__'
$AllowedFile = Join-Path $PSScriptRoot 'chrome-allowed-devices.txt'
$StateDir = Join-Path $PSScriptRoot 'chrome-guard-state'
$VerifyTtlSeconds = 30 * 60
$StateMaxAgeSeconds = 24 * 60 * 60

function Write-Deny([string]$Reason) {
    $out = [ordered]@{
        hookSpecificOutput = [ordered]@{
            hookEventName            = 'PreToolUse'
            permissionDecision       = 'deny'
            permissionDecisionReason = $Reason
        }
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 5 -Compress))
    exit 0
}

function Get-AllowedIds {
    $ids = @{}
    if (Test-Path -LiteralPath $AllowedFile) {
        foreach ($line in [IO.File]::ReadAllLines($AllowedFile)) {
            $token = ($line -split '#', 2)[0].Trim()
            if ($token) { $ids[($token -split '\s+')[0].ToLowerInvariant()] = $true }
        }
    }
    return $ids
}

function Get-StatePath([string]$SessionId) {
    if (-not $SessionId) { $SessionId = 'no-session' }
    return (Join-Path $StateDir ($SessionId -replace '[^A-Za-z0-9_-]', '_'))
}

function Test-Verified([string]$SessionId, $Ids) {
    $path = Get-StatePath $SessionId
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $age = ((Get-Date) - (Get-Item -LiteralPath $path).LastWriteTime).TotalSeconds
    if ($age -gt $VerifyTtlSeconds) { return $false }
    $device = ([IO.File]::ReadAllText($path)).Trim().ToLowerInvariant()
    return [bool]($device -and $Ids.ContainsKey($device))
}

function Set-Verified([string]$SessionId, [string]$DeviceId) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    [IO.File]::WriteAllText((Get-StatePath $SessionId), $DeviceId.ToLowerInvariant())
}

function Clear-Verified([string]$SessionId) {
    $path = Get-StatePath $SessionId
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function Remove-OldState {
    if (-not (Test-Path -LiteralPath $StateDir)) { return }
    Get-ChildItem -LiteralPath $StateDir -File |
        Where-Object { ((Get-Date) - $_.LastWriteTime).TotalSeconds -gt $StateMaxAgeSeconds } |
        Remove-Item -Force
}

function Get-ShortName([string]$Name) {
    if ($Name -and $Name.StartsWith($Prefix)) { return $Name.Substring($Prefix.Length) }
    return [string]$Name
}

function Get-UnlockHelp($Ids) {
    $listed = (@($Ids.Keys) | Sort-Object) -join ', '
    if (-not $listed) { $listed = '(none configured)' }
    return ("Claude in Chrome on this laptop is locked to its owner's own browser " +
        "(allowed deviceId: $listed). Call list_connected_browsers on its own. " +
        "If the allowed device is listed but not marked inUse, call select_browser " +
        "with that deviceId, then list_connected_browsers again so this lock can " +
        "confirm it. If the allowed device is not listed, stop and ask the user. " +
        "Never use any other browser: other people's browsers can be connected " +
        "to the same Claude account.")
}

function Invoke-Pre($Payload) {
    $ids = Get-AllowedIds
    $name = Get-ShortName ([string]$Payload.tool_name)
    $toolInput = $Payload.tool_input
    $sessionId = [string]$Payload.session_id

    if ($name -eq 'list_connected_browsers') { return }

    if ($name -eq 'switch_browser') {
        Write-Deny ("Blocked: switch_browser sends a connect request to every Chrome " +
            "on this Claude account, including other people's. " + (Get-UnlockHelp $ids))
    }

    if ($name -eq 'select_browser') {
        $device = ([string]$toolInput.deviceId).Trim().ToLowerInvariant()
        if ($device -and $ids.ContainsKey($device)) { return }
        if (-not $device) { $device = '?' }
        Write-Deny ("Blocked: device '$device' is not this laptop owner's browser. " + (Get-UnlockHelp $ids))
    }

    if ($name -eq 'browser_batch') {
        foreach ($action in @($toolInput.actions)) {
            if ($null -eq $action) { continue }
            $inner = Get-ShortName ([string]$action.name)
            if ($inner -eq 'switch_browser' -or $inner -eq 'select_browser') {
                Write-Deny ("Blocked: choose the browser with select_browser and " +
                    "list_connected_browsers on their own, never inside browser_batch. " +
                    (Get-UnlockHelp $ids))
            }
        }
    }

    if (-not (Test-Verified $sessionId $ids)) {
        Write-Deny ("Blocked: the browser in use has not been confirmed. " + (Get-UnlockHelp $ids))
    }
}

function Add-Strings($Value, [System.Collections.Generic.List[string]]$Out) {
    if ($null -eq $Value) { return }
    if ($Value -is [string]) { $Out.Add($Value); return }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $Value.PSObject.Properties) { Add-Strings $prop.Value $Out }
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) { Add-Strings $item $Out }
    }
}

function Test-BrowserList($Value) {
    $items = @($Value)
    if ($items.Count -eq 0) { return $false }
    foreach ($item in $items) {
        if (-not ($item -is [System.Management.Automation.PSCustomObject])) { return $false }
        if (-not ($item.PSObject.Properties.Name -contains 'deviceId')) { return $false }
    }
    return $true
}

function Get-Browsers($Response) {
    if ((-not ($Response -is [string])) -and (Test-BrowserList $Response)) { return @($Response) }
    $strings = New-Object 'System.Collections.Generic.List[string]'
    Add-Strings $Response $strings
    foreach ($text in $strings) {
        $candidates = @($text) + @([regex]::Matches($text, '\[.*\]', 'Singleline') | ForEach-Object { $_.Value })
        foreach ($candidate in $candidates) {
            try { $parsed = ConvertFrom-Json -InputObject $candidate } catch { continue }
            if (Test-BrowserList $parsed) { return @($parsed) }
        }
    }
    return @()
}

function Invoke-Post($Payload) {
    $name = Get-ShortName ([string]$Payload.tool_name)
    $sessionId = [string]$Payload.session_id

    if ($name -eq 'select_browser') {
        Clear-Verified $sessionId  # must be confirmed again by list_connected_browsers
        return
    }

    if ($name -eq 'list_connected_browsers') {
        $ids = Get-AllowedIds
        $inUse = @(Get-Browsers $Payload.tool_response |
            Where-Object { $_.inUse -eq $true } |
            ForEach-Object { ([string]$_.deviceId).ToLowerInvariant() })
        if ($inUse.Count -eq 1 -and $ids.ContainsKey($inUse[0])) {
            Set-Verified $sessionId $inUse[0]
        } else {
            Clear-Verified $sessionId
        }
        Remove-OldState
    }
}

function Read-HookInput {
    # Read raw bytes so the console's code page never garbles the JSON.
    $stream = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stream.CopyTo($buffer)
    $bytes = $buffer.ToArray()
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $text = [Text.Encoding]::Unicode.GetString($bytes)
    } else {
        $text = (New-Object System.Text.UTF8Encoding($false)).GetString($bytes)
    }
    $text = $text.TrimStart([char]0xFEFF)
    $start = $text.IndexOf('{')
    if ($start -gt 0) { $text = $text.Substring($start) }
    return $text
}

# --- main ---
$raw = $null
try { $raw = Read-HookInput } catch {}
$payload = $null
try { if ($raw) { $payload = ConvertFrom-Json -InputObject $raw } } catch { $payload = $null }
$hookEvent = ''
if ($null -ne $payload) { $hookEvent = [string]$payload.hook_event_name }

if ($hookEvent -eq 'PostToolUse') {
    try { Invoke-Post $payload } catch {}  # a failed check only means the browser stays locked
    exit 0
}

# PreToolUse, or anything unexpected: decide, and refuse on any error.
try {
    if ($null -eq $payload) { throw 'unreadable hook input' }
    Invoke-Pre $payload
} catch {
    Write-Deny "Blocked: the Chrome browser lock could not check this call ($($_.Exception.Message))."
}
exit 0
