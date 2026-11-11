<#
.SYNOPSIS
  Build the Chrome Web Store package: dist\tether-<version>.zip, with
  manifest.json at the top level and only the files the extension ships.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $repo 'extension'
$version = (Get-Content -LiteralPath (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $repo 'dist'
$zip = Join-Path $dist "tether-$version.zip"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

# Ship only what Chrome loads: no README, no tests.
$files = @('manifest.json', 'background.js', 'content.js', 'icons\icon16.png', 'icons\icon32.png', 'icons\icon48.png', 'icons\icon128.png')
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
    foreach ($f in $files) {
        $src = Join-Path $ext $f
        if (-not (Test-Path -LiteralPath $src)) { throw "missing $src" }
        # forward slashes inside the zip, as the store expects
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $src, ($f -replace '\\', '/'), 'Optimal')
    }
} finally { $archive.Dispose() }
Write-Host "Built $zip ($([math]::Round((Get-Item $zip).Length / 1KB, 1)) KB)"
