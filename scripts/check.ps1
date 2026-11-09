<#
.SYNOPSIS
  Check that Tether's protection still holds.

.DESCRIPTION
  1. The hosts file still blocks bridge.claudeusercontent.com.
  2. Chrome was restarted after the block. Otherwise the extension may still
     hold a bridge connection it opened before.
  3. Every installed Claude in Chrome extension version only contains remote
     hosts we have already looked at. A new host after an extension update could
     be a new bridge that the block doesn't cover.
  4. Chrome's remote debugging, if it's on, listens on loopback only.
  5. Remote Control is disabled in Claude Code's settings (reported, not required).

  Exit code 0 when everything holds, 1 when something needs attention.
  Extension versions that were already scanned are cached, so repeat runs are fast.

.PARAMETER Hook
  Output for a Claude Code SessionStart hook: nothing when all is well, a JSON
  systemMessage when something needs attention. Always exits 0.

.PARAMETER SkipLive
  Skip the checks that look at running Chrome processes and ports (used by tests).
#>
[CmdletBinding()]
param(
    [switch]$Hook,
    [switch]$SkipLive,
    [string]$HostsFile = (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'),
    [string]$ChromeUserData = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    [string]$ClaudeSettings = (Join-Path $env:USERPROFILE '.claude\settings.json'),
    [string]$CacheFile = (Join-Path $env:LOCALAPPDATA 'tether\check-cache.json')
)

$ErrorActionPreference = 'Stop'

$ExtensionId = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
$BridgeHost = 'bridge.claudeusercontent.com'
$Sinkholes = @('0.0.0.0', '::', '127.0.0.1', '::1')
# Remote hosts seen in extension 1.0.102-1.0.105. Only the bridge carries browser
# commands (see docs/how-it-works.md); the rest are the API, staging and a dev server.
$KnownHosts = @('bridge.claudeusercontent.com', 'bridge-staging.claudeusercontent.com', 'api.anthropic.com', 'localhost')

$problems = New-Object 'System.Collections.Generic.List[string]'
$lines = New-Object 'System.Collections.Generic.List[string]'
function Add-Ok([string]$m) { $lines.Add("OK    $m") }
function Add-Note([string]$m) { $lines.Add("NOTE  $m") }
function Add-Problem([string]$m) { $lines.Add("WARN  $m"); $problems.Add($m) }

# 1. hosts block
$hostsText = ''
if (Test-Path -LiteralPath $HostsFile) { $hostsText = [IO.File]::ReadAllText($HostsFile) }
$blocked = $false
foreach ($line in ($hostsText -split "`n")) {
    $parts = @((($line -split '#', 2)[0]).Trim() -split '\s+' | Where-Object { $_ })
    if ($parts.Count -ge 2 -and $Sinkholes -contains $parts[0] -and
        (@($parts[1..($parts.Count - 1)] | ForEach-Object { $_.ToLowerInvariant() }) -contains $BridgeHost)) { $blocked = $true }
}
if ($blocked) { Add-Ok "hosts file blocks $BridgeHost" }
else { Add-Problem "hosts file does NOT block $BridgeHost. Run Block-Remote.bat." }

# 2. Chrome restarted after the block
if (-not $SkipLive -and $blocked) {
    $chrome = Get-Process chrome -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
    $hostsChanged = (Get-Item -LiteralPath $HostsFile).LastWriteTime
    if (-not $chrome) { Add-Ok 'Chrome is not running (the block applies when it starts)' }
    elseif ($chrome.StartTime -gt $hostsChanged) { Add-Ok 'Chrome was restarted after the block' }
    else { Add-Problem 'Chrome has been running since before the block. Close every Chrome window and open it again.' }
}

# 3. remote hosts in every installed extension version
$cache = @{}
if (Test-Path -LiteralPath $CacheFile) {
    try { (Get-Content -LiteralPath $CacheFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cache[$_.Name] = @($_.Value) } } catch {}
}
$versionDirs = @()
if (Test-Path -LiteralPath $ChromeUserData) {
    $versionDirs = @(Get-ChildItem -LiteralPath $ChromeUserData -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $ext = Join-Path $_.FullName "Extensions\$ExtensionId"
        if (Test-Path -LiteralPath $ext) { Get-ChildItem -LiteralPath $ext -Directory -ErrorAction SilentlyContinue }
    })
}
$seenVersions = @{}
$newHosts = @{}
foreach ($dir in $versionDirs) {
    $version = $dir.Name
    if (-not $cache.ContainsKey($version)) {
        $found = @{}
        Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -Filter *.js -ErrorAction SilentlyContinue | ForEach-Object {
            foreach ($m in [regex]::Matches([IO.File]::ReadAllText($_.FullName), 'wss?://([A-Za-z0-9.-]+)')) {
                $found[$m.Groups[1].Value.ToLowerInvariant()] = $true
            }
        }
        $cache[$version] = @($found.Keys | Sort-Object)
    }
    $seenVersions[$version] = $true
    foreach ($h in $cache[$version]) { if ($KnownHosts -notcontains $h) { $newHosts[$h] = $version } }
}
if ($versionDirs.Count -eq 0) { Add-Note 'Claude in Chrome extension not found in any Chrome profile' }
elseif ($newHosts.Count -eq 0) { Add-Ok ("extension versions {0}: no unknown remote hosts" -f (($seenVersions.Keys | Sort-Object) -join ', ')) }
else {
    foreach ($h in $newHosts.Keys) {
        Add-Problem ("extension {0} talks to a new remote host: {1}. It may be a new bridge that the block doesn't cover. Open an issue at github.com/shakaibarsalan/tether." -f $newHosts[$h], $h)
    }
}
try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $CacheFile) | Out-Null
    [IO.File]::WriteAllText($CacheFile, (ConvertTo-Json -InputObject $cache -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
} catch {}

# 4. remote debugging on loopback only
if (-not $SkipLive) {
    $portFile = Join-Path $ChromeUserData 'DevToolsActivePort'
    $port = $null
    if (Test-Path -LiteralPath $portFile) { $port = ((Get-Content -LiteralPath $portFile -TotalCount 1) -as [int]) }
    $listeners = @()
    if ($port) { $listeners = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue) }
    if (-not $listeners) { Add-Ok 'Chrome remote debugging is not listening' }
    elseif (@($listeners | Where-Object { @('127.0.0.1', '::1') -notcontains $_.LocalAddress }).Count -eq 0) { Add-Ok "Chrome remote debugging is on loopback only (port $port)" }
    else { Add-Problem "Chrome remote debugging listens beyond loopback on port $port. Check how Chrome was started." }

    # 4b. who is connected to it right now
    if ($port -and $listeners) {
        $clients = @(Get-NetTCPConnection -RemotePort $port -State Established -ErrorAction SilentlyContinue |
            Where-Object { @('127.0.0.1', '::1') -contains $_.RemoteAddress })
        if (-not $clients) { Add-Ok 'nothing is connected to Chrome remote debugging right now' }
        foreach ($c in $clients) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
            $chain = @()
            $cursor = $proc
            for ($i = 0; $i -lt 4 -and $cursor; $i++) {
                $cursor = Get-CimInstance Win32_Process -Filter "ProcessId=$($cursor.ParentProcessId)" -ErrorAction SilentlyContinue
                if ($cursor) { $chain += $cursor.Name }
            }
            $what = if ($proc -and $proc.CommandLine -match 'chrome-devtools-mcp') { 'chrome-devtools-mcp' } elseif ($proc) { $proc.Name } else { "pid $($c.OwningProcess)" }
            $by = if ($chain) { $chain -join ' <- ' } else { 'unknown' }
            if ($what -eq 'chrome-devtools-mcp' -and ($chain | Where-Object { $_ -match '^claude(\.exe)?$' })) {
                Add-Ok "connected to Chrome: $what (pid $($c.OwningProcess)), started by $by"
            } else {
                Add-Problem "an unknown program is connected to Chrome remote debugging: $what (pid $($c.OwningProcess)), started by $by. If you didn't start it, close Chrome or turn off chrome://inspect/#remote-debugging."
            }
        }
        $outside = @(Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue |
            Where-Object { @('127.0.0.1', '::1') -notcontains $_.RemoteAddress })
        if ($outside) { Add-Problem "Chrome remote debugging has $($outside.Count) connection(s) from outside this computer." }
    }
}

# 5. Remote Control
$rcOff = $false
try { $rcOff = [bool]((Get-Content -LiteralPath $ClaudeSettings -Raw | ConvertFrom-Json).disableRemoteControl) } catch {}
if ($rcOff) { Add-Ok 'Remote Control is disabled in Claude Code settings' }
else { Add-Note 'Remote Control is not disabled. On a shared account, set "disableRemoteControl": true in ~/.claude/settings.json.' }

if ($Hook) {
    if ($problems.Count) {
        $msg = 'Tether: ' + ($problems -join ' | ')
        $out = [ordered]@{
            systemMessage      = $msg
            hookSpecificOutput = [ordered]@{ hookEventName = 'SessionStart'; additionalContext = "$msg Tell the user before doing any browser work." }
        }
        [Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 4 -Compress))
    }
    exit 0
}

$lines | ForEach-Object { Write-Host $_ }
Write-Host ''
if ($problems.Count) { Write-Host "$($problems.Count) thing(s) need attention." -ForegroundColor Yellow; exit 1 }
Write-Host 'Tether is holding.' -ForegroundColor Green
exit 0
