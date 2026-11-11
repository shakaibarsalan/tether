<#
.SYNOPSIS
  Click "Allow?" once per Chrome start, not once per Claude session.

.DESCRIPTION
  Sets up the Tether broker (broker\tether-broker.mjs):

  1. Installs its one dependency (ws, pinned in broker\package-lock.json).
  2. Registers a Task Scheduler task for your user that starts it at login with
     no window, and starts it now. No admin needed.
  3. Re-registers Claude Code's chrome-devtools server to connect to the broker
     (ws://127.0.0.1:9333) instead of straight to Chrome.

  The broker connects to Chrome once; Chrome asks "Allow?" and the connect
  watch shows "Tether wants Chrome". After that, Claude Code sessions get in
  without a prompt, but only chrome-devtools-mcp started by a Claude desktop
  session whose claude.exe and app are both signed by Anthropic. Anything else
  is refused, and you get a notification either way.

  Sessions that are already open keep connecting straight to Chrome until you
  start them again.

.PARAMETER Undo
  Remove the task, stop the broker and point Claude Code straight at Chrome
  again (--autoConnect).

.PARAMETER Status
  Show the task, the broker's state and the last lines of its log.
#>
[CmdletBinding()]
param(
    [switch]$Undo,
    [switch]$Status,
    [string]$TaskName = 'Tether broker',
    [int]$Port = 9333,
    [string]$LogFile = (Join-Path $env:USERPROFILE '.tether\broker.log')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'broker.vbs'
$brokerDir = Join-Path $repo 'broker'
$devtools = Join-Path $PSScriptRoot 'devtools-setup.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

# The broker this sets up runs without --port; test brokers always pass one.
function Get-Brokers {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='wscript.exe'" |
        Where-Object { $cl = [string]$_.CommandLine; ($cl -match 'tether-broker\.mjs' -and $cl -notmatch '--port') -or $cl -match 'broker\.vbs' })
}

function Stop-Brokers {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    foreach ($p in Get-Brokers) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 20; $i++) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not @(Get-Brokers).Count -and (-not $task -or $task.State -ne 'Running')) { return }
        Start-Sleep -Milliseconds 500
    }
}

function Get-BrokerStatus {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 3 } catch { return $null }
}

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Write-Host "Task '$TaskName': $($task.State)" } else { Write-Host "Task '$TaskName' is not installed." }
    $s = Get-BrokerStatus
    if ($s) {
        Write-Host "Broker: Chrome $($s.chrome); sessions in: $(@($s.clients).Count)"
        foreach ($c in @($s.clients)) { Write-Host "  $c" }
    } else {
        Write-Host "Broker is not answering on 127.0.0.1:$Port."
    }
    if (Test-Path -LiteralPath $LogFile) {
        Write-Host ''
        Write-Host "Last lines of $($LogFile):"
        Get-Content -LiteralPath $LogFile -Tail 10 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
    }
    exit 0
}

if ($Undo) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-Brokers
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $devtools
    Write-Host 'Broker removed. New Claude Code sessions connect straight to Chrome again (Allow? per session).'
    exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20.19 or newer is needed: https://nodejs.org' }

Write-Host 'Installing the broker dependency (ws, pinned) ...'
Push-Location $brokerDir
try {
    & npm ci --omit=dev --no-audit --no-fund 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in broker\' }
} finally { Pop-Location }

$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "//B //NoLogo `"$vbs`" `"$($node.Source)`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Tether: one DevTools connection to Chrome, shared by signed Claude desktop sessions.' -Force | Out-Null

Stop-Brokers
Start-ScheduledTask -TaskName $TaskName
$up = $null
for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; $up = Get-BrokerStatus }
if (-not $up) {
    Write-Host "Task '$TaskName' is registered but the broker isn't answering. Run with -Status." -ForegroundColor Yellow
    exit 1
}

Write-Host 'Pointing Claude Code at the broker ...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $devtools -Broker -BrokerPort $Port
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host 'Broker running. It starts at every login.' -ForegroundColor Green
Write-Host 'Chrome asks "Allow?" once now (the notification says "Tether wants Chrome"). Click Allow.'
Write-Host 'After that, new Claude Code sessions use Chrome without asking. Open sessions: start them again.'
Write-Host "Log: $LogFile"
