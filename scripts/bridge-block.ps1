<#
.SYNOPSIS
  Cut Claude sessions on OTHER computers off from this computer's Chrome.

.DESCRIPTION
  The Claude in Chrome extension takes browser commands from Anthropic's hosted
  bridge, wss://bridge.claudeusercontent.com. Any Claude session signed in to
  the same account can send commands through it, from any computer, and pick
  your browser without a prompt in the browser.

  This script points that one host name at 0.0.0.0 (and ::) in the Windows
  hosts file. The extension can no longer reach the bridge, so nothing outside
  this computer can drive it. The extension stays installed and your logins
  stay as they are. Claude on this computer then drives Chrome over a local
  DevTools connection instead (see devtools-setup.ps1).

  The hosts file is a system file, so the script asks for administrator rights.
  It saves a backup next to the hosts file on every run, and running it twice
  is safe.

.PARAMETER Undo
  Remove the block.

.PARAMETER Status
  Only report whether the block is in place. Changes nothing.

.PARAMETER HostsFile
  Edit this file instead of the system hosts file (used by the tests). No admin
  rights, DNS flush or pause in that case.

.PARAMETER NoPause
  Don't wait for Enter before closing.
#>
[CmdletBinding()]
param(
    [switch]$Undo,
    [switch]$Status,
    [string]$HostsFile,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$BridgeHost = 'bridge.claudeusercontent.com'
$BeginMark = '# >>> tether: claude-remote-browser-block'
$EndMark = '# <<< tether: claude-remote-browser-block'
$Sinkholes = @('0.0.0.0', '::', '127.0.0.1', '::1')

$systemHosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$usingSystemHosts = -not $HostsFile
if ($usingSystemHosts) { $HostsFile = $systemHosts }

function Test-BridgeBlocked([string]$Text) {
    foreach ($line in ($Text -split "`n")) {
        $parts = @((($line -split '#', 2)[0]).Trim() -split '\s+' | Where-Object { $_ })
        if ($parts.Count -ge 2 -and $Sinkholes -contains $parts[0] -and
            (@($parts[1..($parts.Count - 1)] | ForEach-Object { $_.ToLowerInvariant() }) -contains $BridgeHost)) {
            return $true
        }
    }
    return $false
}

function Get-NewHostsText([string]$Text, [bool]$Remove) {
    # Drop any block this script added before, so re-running never duplicates it.
    $pattern = '(?ms)^' + [regex]::Escape($BeginMark) + '.*?^' + [regex]::Escape($EndMark) + '[^\n]*\n?'
    $clean = [regex]::Replace($Text, $pattern, '')
    if (-not $Remove) {
        if ($clean.Length -gt 0 -and -not $clean.EndsWith("`n")) { $clean += "`r`n" }
        $clean += "$BeginMark (added $(Get-Date -Format 'yyyy-MM-dd'))`r`n"
        $clean += "0.0.0.0 $BridgeHost`r`n"
        $clean += ":: $BridgeHost`r`n"
        $clean += "$EndMark`r`n"
    }
    return $clean
}

function Wait-ForEnter {
    if ($NoPause -or -not $usingSystemHosts) { return }
    Write-Host ''
    Write-Host 'Press Enter to close this window.'
    [void][Console]::ReadLine()
}

$current = ''
if (Test-Path -LiteralPath $HostsFile) { $current = [IO.File]::ReadAllText($HostsFile) }

if ($Status) {
    if (Test-BridgeBlocked $current) {
        Write-Host "Blocked: $BridgeHost is pointed at a dead address. Other computers can't drive this Chrome."
    } else {
        Write-Host "Open: $BridgeHost is reachable. Any session on your Claude account can drive this Chrome."
    }
    exit 0
}

if ($usingSystemHosts) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        if ($Undo) { $argList += '-Undo' }
        if ($NoPause) { $argList += '-NoPause' }
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
        exit 0
    }
}

try {
    $backup = $null
    if (Test-Path -LiteralPath $HostsFile) {
        $backup = "$HostsFile.bak-tether-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $HostsFile -Destination $backup -Force
    }

    $updated = Get-NewHostsText $current ([bool]$Undo)
    [IO.File]::WriteAllText($HostsFile, $updated, (New-Object System.Text.UTF8Encoding($false)))

    if ($usingSystemHosts) { ipconfig /flushdns | Out-Null }

    Write-Host ''
    if ($Undo) {
        Write-Host 'Block REMOVED. Claude sessions on other computers can reach this Chrome again.' -ForegroundColor Yellow
    } else {
        Write-Host 'Block ADDED. Claude sessions on other computers can no longer drive this Chrome.' -ForegroundColor Green
    }
    if ($backup) { Write-Host "  Hosts backup: $backup" }
    if ($usingSystemHosts) {
        Write-Host ''
        Write-Host 'NEXT: close ALL Chrome windows, then open Chrome again.' -ForegroundColor Cyan
        Write-Host '      The extension keeps its current bridge connection until Chrome restarts.'
    }
} catch {
    Write-Host ''
    Write-Host "Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nothing else was changed. If antivirus blocked the hosts file, allow it and run again.'
    Wait-ForEnter
    exit 1
}

Wait-ForEnter
exit 0
