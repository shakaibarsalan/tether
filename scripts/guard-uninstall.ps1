<#
Removes the Tether guard hook from this computer.

Usage (in PowerShell, from the repo folder):
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\guard-uninstall.ps1

It removes only the guard's own entries from Claude Code's settings (after a
backup) and deletes the guard's files. Everything else is left as it was.
#>
[CmdletBinding()]
param(
    [string]$ClaudeDir = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch {}

$hooksDir = Join-Path $ClaudeDir 'hooks'
$settingsPath = Join-Path $ClaudeDir 'settings.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Test-IsLockEntry($Entry) {
    foreach ($h in @($Entry.hooks)) {
        if ($null -eq $h) { continue }
        $text = ([string]$h.command) + ' ' + ((@($h.args) | ForEach-Object { [string]$_ }) -join ' ')
        if ($text -match 'chrome_browser_guard') { return $true }
    }
    return $false
}

if (Test-Path -LiteralPath $settingsPath) {
    $text = [IO.File]::ReadAllText($settingsPath)
    if ($text.Trim()) {
        $settings = ConvertFrom-Json -InputObject $text
        if ($settings.PSObject.Properties['hooks']) {
            $backup = "$settingsPath.before-tether-guard-removal-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item -LiteralPath $settingsPath -Destination $backup -Force
            foreach ($eventName in @('PreToolUse', 'PostToolUse')) {
                if (-not $settings.hooks.PSObject.Properties[$eventName]) { continue }
                $list = @(@($settings.hooks.$eventName) | Where-Object { $null -ne $_ -and -not (Test-IsLockEntry $_) })
                if ($list.Count -eq 0) {
                    $settings.hooks.PSObject.Properties.Remove($eventName)
                } else {
                    $settings.hooks.$eventName = $list
                }
            }
            if (@($settings.hooks.PSObject.Properties).Count -eq 0) {
                $settings.PSObject.Properties.Remove('hooks')
            }
            $json = ConvertTo-Json -InputObject $settings -Depth 64
            $null = ConvertFrom-Json -InputObject $json
            [IO.File]::WriteAllText($settingsPath, $json, $utf8)
            Write-Host "Removed the guard from $settingsPath (backup: $backup)"
        }
    }
}

foreach ($name in @('chrome_browser_guard.ps1', 'chrome-allowed-devices.txt')) {
    $path = Join-Path $hooksDir $name
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
$stateDir = Join-Path $hooksDir 'chrome-guard-state'
if (Test-Path -LiteralPath $stateDir) { Remove-Item -LiteralPath $stateDir -Recurse -Force }

Write-Host 'Guard removed. Start a new Claude Code session for it to take effect.'
