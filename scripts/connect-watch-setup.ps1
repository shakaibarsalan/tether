<#
.SYNOPSIS
  Start connect-watch.ps1 at every login, with no window.

.DESCRIPTION
  Registers a Task Scheduler task for the current user that runs
  connect-watch.vbs (which runs connect-watch.ps1 hidden) at login, and starts
  it now. No admin needed.

  The watcher pops up a notification naming the program behind each "Allow?"
  prompt from Chrome's remote debugging. See connect-watch.ps1.

.PARAMETER Undo
  Remove the task and stop the watcher.

.PARAMETER Status
  Show the task, the running watcher and the last lines of its log.
#>
[CmdletBinding()]
param(
    [switch]$Undo,
    [switch]$Status,
    [string]$TaskName = 'Tether connect watch',
    [string]$LogFile = (Join-Path $env:USERPROFILE '.tether\connect-watch.log')
)

$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'connect-watch.vbs'
$user = "$env:USERDOMAIN\$env:USERNAME"

function Get-Watchers {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='wscript.exe'" |
        Where-Object { [string]$_.CommandLine -match 'connect-watch\.(ps1|vbs)' -and [string]$_.CommandLine -notmatch '-(Once|ExplainPid|LookupSession)\b' })
}

function Stop-Watchers {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    foreach ($p in Get-Watchers) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    # wait until Task Scheduler sees the old run end; otherwise it ignores the next start
    for ($i = 0; $i -lt 20; $i++) {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not @(Get-Watchers).Count -and (-not $task -or $task.State -ne 'Running')) { return }
        Start-Sleep -Milliseconds 500
    }
}

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Write-Host "Task '$TaskName': $($task.State)" } else { Write-Host "Task '$TaskName' is not installed." }
    $running = @(Get-Watchers | Where-Object { $_.Name -eq 'powershell.exe' })
    if ($running) { Write-Host ("Watcher running: pid {0}" -f (($running | ForEach-Object { $_.ProcessId }) -join ', ')) } else { Write-Host 'Watcher is not running.' }
    if (Test-Path -LiteralPath $LogFile) {
        Write-Host ''
        Write-Host "Last lines of $($LogFile):"
        Get-Content -LiteralPath $LogFile -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
    }
    exit 0
}

if ($Undo) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-Watchers
    Write-Host 'Connect watch removed.'
    exit 0
}

if (-not (Test-Path -LiteralPath $vbs)) { throw "Missing $vbs" }

$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "//B //NoLogo `"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Tether: names the program behind Chrome's remote debugging 'Allow?' prompt." -Force | Out-Null

Stop-Watchers
Start-ScheduledTask -TaskName $TaskName
$started = $false
for ($i = 0; $i -lt 20 -and -not $started; $i++) {
    Start-Sleep -Milliseconds 500
    $started = [bool]@(Get-Watchers | Where-Object { $_.Name -eq 'powershell.exe' }).Count
}
if ($started) {
    Write-Host "Connect watch installed and running. It starts at every login. Log: $LogFile"
} else {
    Write-Host "Task '$TaskName' is registered but the watcher didn't start. Run with -Status, or check Task Scheduler." -ForegroundColor Yellow
    exit 1
}
