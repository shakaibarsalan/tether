<#
.SYNOPSIS
  Say who is behind Chrome's "Allow?" prompt.

.DESCRIPTION
  With remote debugging on, Chrome asks "Allow?" every time a program connects,
  but it doesn't say which program. With several Claude Code sessions open you
  can't tell which one is asking, or whether it's Claude at all.

  This watches Chrome's debugging port. When a new program connects (the moment
  Chrome shows the prompt), a Windows notification names it:

    Claude wants Chrome           chrome-devtools-mcp started by a Claude Code
                                  session. Shows the session's title and folder.
    A script run by Claude ...    something a session ran from a shell, not the
                                  normal tool. Allow only if you asked for it.
    Unknown program ...           anything else. Stays on screen. Click Block.

  Every connection also goes to the log file. connect-watch-setup.ps1 starts
  this at every login with no window.

.PARAMETER Once
  Look at the current connections once, print them and exit.

.PARAMETER Notify
  With -Once, also show the notifications.

.PARAMETER ExplainPid
  Print what this script would say about one process, as JSON, and exit.

.PARAMETER LookupSession
  Print the title and folder the Claude app stores for a Claude Code session id,
  as JSON, and exit. Searches -SessionRoots.

.PARAMETER SessionRoots
  Extra claude-code-sessions folders to search, besides the one next to each
  Claude Code executable.
#>
[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$Notify,
    [int]$ExplainPid = 0,
    [string]$LookupSession = '',
    [string[]]$SessionRoots = @(),
    [int]$IntervalMs = 500,
    [string]$ChromeUserData = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    [string]$LogFile = (Join-Path $env:USERPROFILE '.tether\connect-watch.log')
)

$ErrorActionPreference = 'Stop'
$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$IdPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

function Write-Log([string]$Message) {
    try {
        $dir = Split-Path -Parent $LogFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 1MB) {
            Move-Item -LiteralPath $LogFile -Destination "$LogFile.old" -Force
        }
        $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message
        [IO.File]::AppendAllText($LogFile, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

function Get-DebugPort {
    $file = Join-Path $ChromeUserData 'DevToolsActivePort'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try { return ((Get-Content -LiteralPath $file -TotalCount 1) -as [int]) } catch { return $null }
}

# Local ports of the programs connected to Chrome's debugging port right now.
function Get-ClientPorts([int]$Port) {
    $ports = @{}
    foreach ($c in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections()) {
        if ($c.RemoteEndPoint.Port -eq $Port -and $c.State -eq 'Established' -and [Net.IPAddress]::IsLoopback($c.RemoteEndPoint.Address)) {
            $ports[$c.LocalEndPoint.Port] = $true
        }
    }
    return $ports
}

function Get-ProcessTable {
    $table = @{}
    foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath, CreationDate) {
        $table[[int]$p.ProcessId] = $p
    }
    return $table
}

# The process and its parents, nearest first. Stops where a parent id was reused
# by a process that started later than its "child".
function Get-Ancestry($Table, [int]$ProcId) {
    $list = @()
    $cur = $Table[$ProcId]
    for ($i = 0; $i -lt 12 -and $cur; $i++) {
        $list += $cur
        $parent = $Table[[int]$cur.ParentProcessId]
        if (-not $parent -or $parent.ProcessId -eq $cur.ProcessId) { break }
        if ($parent.CreationDate -and $cur.CreationDate -and $parent.CreationDate -gt $cur.CreationDate) { break }
        $cur = $parent
    }
    return , $list
}

# A Claude Code process: the CLI the desktop app starts, the native CLI, or the npm CLI.
# Not the desktop app itself (WindowsApps) and not its Electron helpers (--type=...).
function Test-IsClaudeCode($P) {
    $name = [string]$P.Name; $cl = [string]$P.CommandLine; $exe = [string]$P.ExecutablePath
    if ($name -ieq 'claude.exe' -and $exe -notmatch '\\WindowsApps\\' -and $cl -notmatch '\s--type=') { return $true }
    if ($name -ieq 'node.exe' -and $cl -match '@anthropic-ai[\\/]claude-code') { return $true }
    return $false
}

function Read-SessionFile([string]$Path) {
    try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# Title and folder the Claude desktop app keeps for a Claude Code session id.
# With -Fork the id is the session it was forked from, so take the newest fork.
function Find-Session([string]$Id, [bool]$Fork, [string[]]$Roots) {
    if (-not $Id) { return $null }
    foreach ($root in $Roots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
        $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'local_*.json' -ErrorAction SilentlyContinue)
        $hit = $null
        if ($Fork) {
            $recent = @($files | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-2) })
            $hit = @($recent | ForEach-Object { Read-SessionFile $_.FullName } |
                Where-Object { $_ -and [string]$_.forkedFromSessionId -eq "local_$Id" } |
                Sort-Object { [double]$_.createdAt } -Descending) | Select-Object -First 1
        }
        if (-not $hit) {
            $file = $files | Where-Object { $_.Name -ieq "local_$Id.json" } | Select-Object -First 1
            if (-not $file -and $files) {
                $match = $files | Select-String -Pattern ('"cliSessionId"\s*:\s*"' + [regex]::Escape($Id) + '"') -List -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($match) { $file = Get-Item -LiteralPath $match.Path }
            }
            if ($file) { $hit = Read-SessionFile $file.FullName }
        }
        if ($hit) {
            return [pscustomobject]@{ Id = $Id; Title = [string]$hit.title; Folder = [string]$hit.cwd; Account = '' }
        }
    }
    return [pscustomobject]@{ Id = $Id; Title = ''; Folder = ''; Account = '' }
}

$SessionCache = @{}
function Get-ClaudeSession($P) {
    $key = '{0}@{1}' -f $P.ProcessId, $P.CreationDate
    if ($SessionCache.ContainsKey($key)) { return $SessionCache[$key] }
    $s = Get-ClaudeSessionUncached $P
    if ($s.Title) { $SessionCache[$key] = $s }
    return $s
}

function Get-ClaudeSessionUncached($P) {
    $cl = [string]$P.CommandLine; $exe = [string]$P.ExecutablePath
    $id = $null
    if ($cl -match ('--(?:resume|session-id)[= ]"?(' + $IdPattern + ')')) { $id = $Matches[1] }
    $fork = $cl -match '--fork-session'
    $roots = @($SessionRoots)
    $account = ''
    if ($exe -match '^(.*?)\\claude-code\\') {
        $base = $Matches[1]
        $roots += (Join-Path $base 'claude-code-sessions')
        $leaf = Split-Path -Leaf $base
        if ($leaf -notmatch '^claude_[a-z0-9]+$') { $account = $leaf }
    }
    $s = Find-Session $id $fork $roots
    if (-not $s) { $s = [pscustomobject]@{ Id = ''; Title = ''; Folder = ''; Account = '' } }
    $s.Account = $account
    return $s
}

function Get-ShortCommand($P) {
    $cl = ([string]$P.CommandLine).Trim()
    $cl = $cl -replace '^"[^"]*"\s*', '' -replace '^\S+\.exe\s*', ''
    if ($cl.Length -gt 90) { $cl = $cl.Substring(0, 87) + '...' }
    return $cl
}

# What to say about the program with this process id.
function Get-ConnectionInfo([int]$ProcId, $Table) {
    if (-not $Table) { $Table = Get-ProcessTable }
    $chain = Get-Ancestry $Table $ProcId
    $self = if ($chain.Count) { $chain[0] } else { $null }
    $name = if ($self) { [string]$self.Name } else { "pid $ProcId" }
    $chainText = (@($chain | Select-Object -Skip 1 -First 4 | ForEach-Object { $_.Name }) -join ' <- ')
    if (-not $chainText) { $chainText = 'unknown' }

    $claudeAt = -1
    for ($i = 0; $i -lt $chain.Count; $i++) { if (Test-IsClaudeCode $chain[$i]) { $claudeAt = $i; break } }

    # The normal tool: chrome-devtools-mcp, and every process between it and Claude
    # is part of launching it (for example "cmd /c npx chrome-devtools-mcp").
    $isTool = $false
    if ($claudeAt -gt 0) {
        $isTool = $true
        for ($i = 0; $i -lt $claudeAt; $i++) { if ([string]$chain[$i].CommandLine -notmatch 'chrome-devtools-mcp') { $isTool = $false } }
    }

    $info = [ordered]@{ Kind = ''; ProcessId = $ProcId; Program = $name; Chain = $chainText; Session = $null; Title = ''; Lines = @(); Hint = '' }
    if ($claudeAt -ge 0) {
        $s = Get-ClaudeSession $chain[$claudeAt]
        $info.Session = $s
        $label = if ($s.Title) { $s.Title } elseif ($s.Id) { 'session ' + $s.Id.Substring(0, 8) } else { 'a Claude Code session' }
        $where = if ($s.Folder) { $s.Folder } else { 'folder unknown' }
        if ($s.Account) { $where = "$where ($($s.Account))" }
        if ($isTool) {
            $info.Kind = 'claude-tool'
            $info.Title = "Claude wants Chrome: $label"
            $info.Lines = @("Folder: $where", "chrome-devtools-mcp, pid $ProcId")
            $info.Hint = 'Allow if you just gave this session a browser task.'
        } else {
            $info.Kind = 'claude-script'
            $info.Title = 'A script run by Claude wants Chrome'
            $info.Lines = @("Session: $label - $where", "$name (pid $ProcId): $(Get-ShortCommand $self)")
            $info.Hint = "Not Claude's normal browser tool. Allow only if you asked for it."
        }
    } else {
        $path = if ($self -and $self.ExecutablePath) { [string]$self.ExecutablePath } else { 'path unknown' }
        $info.Kind = 'unknown'
        $info.Title = "Unknown program wants Chrome: $name"
        $info.Lines = @("$path (pid $ProcId)", "Started by: $chainText")
        $info.Hint = 'Click Block in Chrome unless you started this.'
    }
    return [pscustomobject]$info
}

function Show-Toast($Info) {
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $esc = { param($s) [Security.SecurityElement]::Escape([string]$s) }
        $texts = "<text>$(& $esc $Info.Title)</text>"
        foreach ($l in @($Info.Lines)) { $texts += "<text>$(& $esc $l)</text>" }
        $texts += "<text placement=`"attribution`">$(& $esc ('Tether: ' + $Info.Hint))</text>"
        $urgent = $Info.Kind -ne 'claude-tool'
        $scenario = if ($urgent) { ' scenario="reminder"' } else { '' }
        $actions = if ($urgent) { '<actions><action activationType="system" arguments="dismiss" content=""/></actions>' } else { '' }
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast$scenario><visual><binding template=`"ToastGeneric`">$texts</binding></visual>$actions</toast>")
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        $toast.Tag = "tether-$($Info.ProcessId)"
        $toast.Group = 'tether'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
        return $true
    } catch {
        Write-Log "notification failed: $($_.Exception.Message)"
        return $false
    }
}

function Format-Info($Info) {
    $text = '{0,-13} {1} | {2}' -f $Info.Kind, $Info.Title, (@($Info.Lines) -join ' | ')
    if ($Info.Kind -ne 'unknown') { $text += " | started by $($Info.Chain)" }  # unknown already says it
    return $text
}

# ---- one-shot modes ---------------------------------------------------------

# UTF-8 bytes straight to stdout: the console code page would turn titles with
# emoji or non-Latin letters into "?".
function Write-Utf8Out([string]$Text) {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text)
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}

if ($LookupSession) {
    $s = Find-Session $LookupSession $false $SessionRoots
    Write-Utf8Out (ConvertTo-Json -InputObject $s -Compress)
    exit 0
}

if ($ExplainPid) {
    Write-Utf8Out (ConvertTo-Json -InputObject (Get-ConnectionInfo $ExplainPid $null) -Depth 4 -Compress)
    exit 0
}

if ($Once) {
    $port = Get-DebugPort
    if (-not $port) { Write-Host 'Chrome remote debugging is not on (no DevToolsActivePort).'; exit 0 }
    $ports = Get-ClientPorts $port
    if (-not $ports.Count) { Write-Host "Nothing is connected to Chrome's debugging port ($port)."; exit 0 }
    $table = Get-ProcessTable
    $done = @{}
    foreach ($lp in $ports.Keys) {
        $owner = (Get-NetTCPConnection -LocalPort $lp -RemotePort $port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
        if (-not $owner -or $done[[int]$owner]) { continue }
        $done[[int]$owner] = $true
        $info = Get-ConnectionInfo ([int]$owner) $table
        Write-Host (Format-Info $info)
        if ($Notify) { $null = Show-Toast $info }
    }
    exit 0
}

# ---- watch ------------------------------------------------------------------

$mutex = New-Object System.Threading.Mutex($false, 'Local\TetherConnectWatch')
try { $owned = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $owned = $true }  # the last watcher was killed
if (-not $owned) { exit 0 }  # already running

Write-Log "watching (pid $PID)"
$seen = @{}
$lastToast = @{}
$port = $null
$portReadAt = [datetime]::MinValue
$baseline = $true

while ($true) {
    try {
        if (-not $port -or ((Get-Date) - $portReadAt).TotalSeconds -ge 5) {
            $newPort = Get-DebugPort
            if ($newPort -ne $port) { $seen = @{}; $baseline = $true; if ($newPort) { Write-Log "Chrome debugging port $newPort" } }
            $port = $newPort
            $portReadAt = Get-Date
        }
        if ($port) {
            $ports = Get-ClientPorts $port
            $fresh = @($ports.Keys | Where-Object { -not $seen.ContainsKey($_) })
            if ($fresh.Count) {
                $table = Get-ProcessTable
                foreach ($lp in $fresh) {
                    $seen[$lp] = $true
                    $owner = (Get-NetTCPConnection -LocalPort $lp -RemotePort $port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
                    if (-not $owner) { continue }
                    $owner = [int]$owner
                    $info = Get-ConnectionInfo $owner $table
                    if ($baseline) { Write-Log ('already connected: ' + (Format-Info $info)); continue }
                    Write-Log ('new connection: ' + (Format-Info $info))
                    # one program often opens more than one connection: one notification is enough
                    if ($lastToast.ContainsKey($owner) -and ((Get-Date) - $lastToast[$owner]).TotalSeconds -lt 60) { continue }
                    $lastToast[$owner] = Get-Date
                    $null = Show-Toast $info
                }
            }
            foreach ($k in @($seen.Keys)) { if (-not $ports.ContainsKey($k)) { $seen.Remove($k) } }
            $baseline = $false
        }
    } catch {
        Write-Log "error: $($_.Exception.Message)"
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Milliseconds $IntervalMs
}
