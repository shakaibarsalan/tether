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

  With the Tether broker (broker/tether-broker.mjs), Chrome asks only once, for
  the broker ("Tether wants Chrome"). Claude Code sessions then connect to the
  broker instead. The broker asks this script who each one is
  (-VerifyClientPort) and shows its decision with -ShowToast:

    Claude is using Chrome        a signed Claude desktop session the broker let
                                  in without asking. Nothing to do.
    Tether blocked ...            anything else that tried the broker. It was
                                  refused; stays on screen so you see it.

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

.PARAMETER VerifyClientPort
  For the broker: find the program on the other end of the local TCP connection
  from this port to -ServerPort, and print as JSON whether to let it in. Yes only
  for chrome-devtools-mcp started by Claude Code (claude.exe signed by Anthropic,
  PBC) that the Claude desktop app (also signed by Anthropic) started.

.PARAMETER SkipSignatures
  With -VerifyClientPort: check everything but the Authenticode signatures and
  return the two paths. The broker checks signatures itself and remembers them,
  because claude.exe is a few hundred MB and each check takes seconds.

.PARAMETER CheckSignature
  Print as JSON whether this file is validly signed by Anthropic, PBC.

.PARAMETER ClaudeExePaths
  Print the paths of the claude.exe programs running now, as JSON (the broker
  checks their signatures ahead of time).

.PARAMETER ShowToast
  Show one notification described by this JSON (Kind, Title, Lines, Hint,
  ProcessId) and log it. The broker uses it to say what it let in or refused.
#>
[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$Notify,
    [int]$ExplainPid = 0,
    [string]$LookupSession = '',
    [string[]]$SessionRoots = @(),
    [int]$VerifyClientPort = 0,
    [int]$ServerPort = 9333,
    [switch]$SkipSignatures,
    [string]$CheckSignature = '',
    [switch]$ClaudeExePaths,
    [string]$ShowToast = '',
    [int]$SessionForPid = 0,
    [switch]$Serve,
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
    # A brand-new session has no id on its command line: match the session the
    # app created just after this claude.exe started.
    if ((-not $s -or -not $s.Title) -and -not $id -and $P.CreationDate) { $s = Find-SessionByStart $P.CreationDate $roots }
    if (-not $s) { $s = [pscustomobject]@{ Id = ''; Title = ''; Folder = ''; Account = '' } }
    $s.Account = $account
    return $s
}

function Find-SessionByStart([datetime]$Start, [string[]]$Roots) {
    $best = $null
    $bestGap = 61
    foreach ($root in $Roots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
        $files = Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'local_*.json' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $Start.AddMinutes(-1) }
        foreach ($f in $files) {
            $j = Read-SessionFile $f.FullName
            if (-not $j -or -not $j.createdAt) { continue }
            $created = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$j.createdAt).LocalDateTime
            $gap = ($created - $Start).TotalSeconds
            if ($gap -ge -5 -and $gap -lt $bestGap) { $best = $j; $bestGap = $gap }
        }
    }
    if (-not $best) { return $null }
    return [pscustomobject]@{ Id = [string]$best.cliSessionId; Title = [string]$best.title; Folder = [string]$best.cwd; Account = '' }
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

    $info = [ordered]@{ Kind = ''; ProcessId = $ProcId; Program = $name; Chain = $chainText; Session = $null; Title = ''; Lines = @(); Hint = '';
                        ClaudePath = ''; AppPath = ''; ClaudePid = 0 }
    if ($claudeAt -ge 0) {
        $info.ClaudePath = [string]$chain[$claudeAt].ExecutablePath
        $info.ClaudePid = [int]$chain[$claudeAt].ProcessId
        if ($claudeAt + 1 -lt $chain.Count) { $info.AppPath = [string]$chain[$claudeAt + 1].ExecutablePath }
    }
    if ($self -and [string]$self.CommandLine -match 'tether-broker\.mjs') {
        $info.Kind = 'tether-broker'
        $info.Title = 'Tether wants Chrome'
        $info.Lines = @('Allow once: your Claude sessions then get in without asking', "Until Chrome closes. node.exe, pid $ProcId")
        $info.Hint = 'Allow. This is the Tether broker.'
    } elseif ($claudeAt -ge 0) {
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

# Notifications are off unless %USERPROFILE%\.tether\config.json says
# { "notifications": true }. Everything is still written to the log.
function Test-NotificationsOn {
    try {
        $cfg = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.tether\config.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        return [bool]$cfg.notifications
    } catch { return $false }
}

function Show-Toast($Info) {
    if (-not (Test-NotificationsOn)) { return $false }
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $esc = { param($s) [Security.SecurityElement]::Escape([string]$s) }
        $texts = "<text>$(& $esc $Info.Title)</text>"
        foreach ($l in @($Info.Lines)) { $texts += "<text>$(& $esc $l)</text>" }
        $texts += "<text placement=`"attribution`">$(& $esc ('Tether: ' + $Info.Hint))</text>"
        $urgent = @('claude-tool', 'tether-broker', 'broker-allowed') -notcontains $Info.Kind
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
    if (@('unknown', 'broker-blocked') -notcontains $Info.Kind) { $text += " | started by $($Info.Chain)" }  # those already say it
    return $text
}

# ---- who may use the broker -------------------------------------------------

$SigCache = @{}
function Test-AnthropicSigned([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path
    $key = '{0}|{1}|{2}' -f $Path.ToLowerInvariant(), $item.Length, $item.LastWriteTimeUtc.Ticks
    if ($SigCache.ContainsKey($key)) { return $SigCache[$key] }
    $ok = $false
    try {
        $sig = Get-AuthenticodeSignature -LiteralPath $Path
        $ok = ($sig.Status -eq 'Valid' -and [string]$sig.SignerCertificate.Subject -match '(^|, )O="?Anthropic, PBC"?(,|$)')
    } catch {}
    $SigCache[$key] = $ok
    return $ok
}

$DesktopApp = '\\WindowsApps\\Claude_[^\\]+\\app\\claude\.exe$'

# Yes only for chrome-devtools-mcp started by Claude Code, where Claude Code
# (claude.exe) and the Claude desktop app that started it are both signed by
# Anthropic. A script Claude ran, a terminal session or anything else: no.
function Test-ClientAllowed($Info, [bool]$Signatures = $true) {
    $no = { param($why) [pscustomobject]@{ Allowed = $false; Reason = $why } }
    if ($Info.Kind -ne 'claude-tool') { return & $no "not Claude's chrome-devtools-mcp ($($Info.Kind))" }
    if ($Info.AppPath -notmatch $DesktopApp) { return & $no "not started by the Claude desktop app ($($Info.AppPath))" }
    if ($Signatures) {
        if (-not (Test-AnthropicSigned $Info.ClaudePath)) { return & $no "Claude Code isn't signed by Anthropic ($($Info.ClaudePath))" }
        if (-not (Test-AnthropicSigned $Info.AppPath)) { return & $no "the Claude app isn't signed by Anthropic ($($Info.AppPath))" }
    }
    return [pscustomobject]@{ Allowed = $true; Reason = 'chrome-devtools-mcp from a signed Claude desktop session' }
}

function Get-SessionLabel($Info) {
    if ($Info.Session -and $Info.Session.Title) { return $Info.Session.Title }
    if ($Info.Session -and $Info.Session.Id) { return 'session ' + $Info.Session.Id.Substring(0, 8) }
    return 'a Claude Code session'
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
    $info = Get-ConnectionInfo $ExplainPid $null
    $info | Add-Member -NotePropertyName BrokerVerdict -NotePropertyValue (Test-ClientAllowed $info)
    Write-Utf8Out (ConvertTo-Json -InputObject $info -Depth 4 -Compress)
    exit 0
}

function Get-VerifyAnswer([int]$ClientPort, [int]$Port, [bool]$Signatures) {
    $conn = Get-NetTCPConnection -LocalPort $ClientPort -RemotePort $Port -State Established -ErrorAction SilentlyContinue | Select-Object -First 1
    $answer = [ordered]@{ Allowed = $false; Reason = 'connection not found'; Label = "client :$ClientPort"; Kind = '';
                          Program = ''; ProcessId = 0; Chain = ''; Session = ''; Folder = ''; ClaudePath = ''; AppPath = ''; ClaudePid = 0; Title = '' }
    if ($conn) {
        $info = Get-ConnectionInfo ([int]$conn.OwningProcess) $null
        $v = Test-ClientAllowed $info $Signatures
        $answer.Allowed = [bool]$v.Allowed
        $answer.Reason = $v.Reason
        $answer.Kind = $info.Kind
        $answer.Program = $info.Program
        $answer.ProcessId = $info.ProcessId
        $answer.Chain = $info.Chain
        $answer.ClaudePath = $info.ClaudePath
        $answer.AppPath = $info.AppPath
        $answer.ClaudePid = $info.ClaudePid
        if ($info.Session) { $answer.Title = [string]$info.Session.Title }
        if ($info.Kind -like 'claude-*') {
            $answer.Session = Get-SessionLabel $info
            $answer.Folder = if ($info.Session -and $info.Session.Folder) { $info.Session.Folder } else { '' }
            $answer.Label = "Claude session '$($answer.Session)' ($($info.Program), pid $($info.ProcessId))"
        } else {
            $answer.Label = "$($info.Program) (pid $($info.ProcessId))"
        }
    }
    return $answer
}

function Get-SessionAnswer([int]$ClaudePid) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ClaudePid" -ErrorAction SilentlyContinue
    $s = if ($p) { Get-ClaudeSessionUncached $p } else { $null }
    return [ordered]@{ Title = [string]$s.Title; Folder = [string]$s.Folder; Id = [string]$s.Id }
}

# For the broker: one long-running PowerShell that answers line by line, so a
# check doesn't pay for starting PowerShell every time (seconds on a busy PC).
# Requests: "verify <clientPort>", "session <claudePid>", "sig <path>", "paths",
# "toast <json>". Each answer is one line of JSON.
if ($Serve) {
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $cmd, $arg = ($line.Trim() -split ' ', 2)
        try {
            $out = switch ($cmd) {
                'verify'  { Get-VerifyAnswer ([int]$arg) $ServerPort $false }
                'session' { Get-SessionAnswer ([int]$arg) }
                'sig'     { [ordered]@{ Path = $arg; Signed = (Test-AnthropicSigned $arg) } }
                'paths'   { [ordered]@{ Paths = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { [string]$_.ExecutablePath } | Where-Object { $_ } | Sort-Object -Unique) } }
                'toast'   { $t = $arg | ConvertFrom-Json
                            $i = [pscustomobject]@{ Kind = [string]$t.Kind; Title = [string]$t.Title; Lines = @($t.Lines); Hint = [string]$t.Hint; ProcessId = [int]$t.ProcessId; Chain = '' }
                            Write-Log ("broker: " + (Format-Info $i)); [ordered]@{ Shown = (Show-Toast $i) } }
                default   { [ordered]@{ Error = "unknown request: $cmd" } }
            }
        } catch {
            $out = [ordered]@{ Error = $_.Exception.Message }
        }
        Write-Utf8Out ((ConvertTo-Json -InputObject $out -Compress -Depth 4) + "`n")
    }
    exit 0
}

if ($VerifyClientPort) {
    Write-Utf8Out (ConvertTo-Json -InputObject (Get-VerifyAnswer $VerifyClientPort $ServerPort (-not $SkipSignatures)) -Compress)
    exit 0
}

if ($CheckSignature) {
    Write-Utf8Out (ConvertTo-Json -InputObject ([ordered]@{ Path = $CheckSignature; Signed = (Test-AnthropicSigned $CheckSignature) }) -Compress)
    exit 0
}

if ($SessionForPid) {
    # The title and folder of the Claude Code session running as this claude.exe
    # (the broker refreshes tab-group names with it: new sessions get a title later).
    Write-Utf8Out (ConvertTo-Json -InputObject (Get-SessionAnswer $SessionForPid) -Compress)
    exit 0
}

if ($ClaudeExePaths) {
    $paths = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { [string]$_.ExecutablePath } |
        Where-Object { $_ } | Sort-Object -Unique)
    Write-Utf8Out (ConvertTo-Json -InputObject $paths -Compress)
    exit 0
}

if ($ShowToast) {
    $t = $ShowToast | ConvertFrom-Json
    $info = [pscustomobject]@{ Kind = [string]$t.Kind; Title = [string]$t.Title; Lines = @($t.Lines); Hint = [string]$t.Hint; ProcessId = [int]$t.ProcessId; Chain = '' }
    Write-Log ("broker: " + (Format-Info $info))
    $null = Show-Toast $info
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
# Chrome's debugging port. (Connections to the Tether broker are reported by the
# broker itself, through -ShowToast, so the notification says what it decided.)
$doors = @(
    @{ Name = 'chrome'; Port = $null; Seen = @{}; Baseline = $true }
)
$lastToast = @{}
$portReadAt = [datetime]::MinValue

while ($true) {
    try {
        if (((Get-Date) - $portReadAt).TotalSeconds -ge 5) {
            $newPort = Get-DebugPort
            if ($newPort -ne $doors[0].Port) {
                $doors[0].Seen = @{}; $doors[0].Baseline = $true
                if ($newPort) { Write-Log "Chrome debugging port $newPort" }
            }
            $doors[0].Port = $newPort
            $portReadAt = Get-Date
        }
        foreach ($door in $doors) {
            if (-not $door.Port) { continue }
            $ports = Get-ClientPorts $door.Port
            $fresh = @($ports.Keys | Where-Object { -not $door.Seen.ContainsKey($_) })
            if ($fresh.Count) {
                $table = Get-ProcessTable
                foreach ($lp in $fresh) {
                    $door.Seen[$lp] = $true
                    $owner = (Get-NetTCPConnection -LocalPort $lp -RemotePort $door.Port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
                    if (-not $owner) { continue }
                    $owner = [int]$owner
                    $info = Get-ConnectionInfo $owner $table
                    if ($door.Baseline) { Write-Log ("already connected ($($door.Name)): " + (Format-Info $info)); continue }
                    Write-Log ("new connection ($($door.Name)): " + (Format-Info $info))
                    # one program often opens more than one connection: one notification is enough
                    $key = "$($door.Name)/$owner"
                    if ($lastToast.ContainsKey($key) -and ((Get-Date) - $lastToast[$key]).TotalSeconds -lt 60) { continue }
                    $lastToast[$key] = Get-Date
                    $null = Show-Toast $info
                }
            }
            foreach ($k in @($door.Seen.Keys)) { if (-not $ports.ContainsKey($k)) { $door.Seen.Remove($k) } }
            $door.Baseline = $false
        }
    } catch {
        Write-Log "error: $($_.Exception.Message)"
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Milliseconds $IntervalMs
}
