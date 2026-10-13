#Requires -Version 5.1
<#
.SYNOPSIS
  Authenticode-sign the Windows Laya sidecar and refresh its manifest hash.

.DESCRIPTION
  Accepts -Thumbprint or WIN_CSC_THUMBPRINT, otherwise WIN_CSC_LINK as an
  existing PFX file or a base64 PFX plus WIN_CSC_KEY_PASSWORD. Secrets are not
  printed. A missing certificate is an error. This script never creates a
  self-signed certificate and never exports a private key.
#>
[CmdletBinding()]
param(
    [string]$Thumbprint = '',
    [string]$ExePath = '',
    [string]$ManifestPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ExePath) {
    $ExePath = Join-Path $RepoRoot 'resources\laya-sidecar\laya-sidecar.exe'
}
if (-not $ManifestPath) {
    $ManifestPath = Join-Path $RepoRoot 'resources\laya-sidecar\artifact-manifest.json'
}
$ExePath = [System.IO.Path]::GetFullPath($ExePath)
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)

function Remove-OwnedCertTemp {
    param([string]$Directory)
    if (-not $Directory) { return }
    $full = [System.IO.Path]::GetFullPath($Directory)
    $root = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'laya-sidecar-sign'))
    $prefix = $root.TrimEnd('\') + '\'
    $leaf = Split-Path -Leaf $full
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or $leaf -notmatch '^[a-f0-9]{32}$') {
        throw 'Refusing to delete a certificate temp directory that this script did not create.'
    }
    if (Test-Path -LiteralPath $full) {
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}

function Invoke-SignTool {
    param(
        [Parameter(Mandatory)][string]$SignTool,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [string[]]$Redact = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $SignTool @ArgumentList 2>&1 | ForEach-Object {
            $text = "$_"
            foreach ($secret in $Redact) {
                if ($secret) { $text = $text.Replace($secret, '***') }
            }
            $text
        })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        $tail = ($output | Select-Object -Last 30) -join "`n"
        throw "signtool failed with exit code ${code}.`n$tail"
    }
}

function Get-SignToolPath {
    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
    )
    $found = foreach ($root in $roots) {
        if ($root -and (Test-Path -LiteralPath $root)) {
            Get-ChildItem -LiteralPath $root -Filter signtool.exe -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' }
        }
    }
    $best = $found | Sort-Object -Property @{ Expression = { $_.FullName } } -Descending | Select-Object -First 1
    if ($best) { return $best.FullName }
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'signtool.exe was not found. Install the Windows SDK signing tools. Refusing to self-sign.'
}

function Resolve-PfxPath {
    param(
        [Parameter(Mandatory)][string]$Link,
        [string]$TempDirectory
    )
    $trimmed = $Link.Trim()
    if ($trimmed -match '^[a-zA-Z][a-zA-Z0-9+.-]*://' -and -not $trimmed.StartsWith('file://')) {
        throw 'WIN_CSC_LINK URLs are not accepted. Pass -Thumbprint, or set WIN_CSC_LINK to a local PFX file or a base64 PFX. Refusing to download or self-sign.'
    }
    $candidate = $trimmed
    if ($trimmed.StartsWith('file://')) {
        $candidate = ([Uri]$trimmed).LocalPath
    }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    $looksLikePath = $candidate -match '^[a-zA-Z]:[\\/]' -or $candidate.StartsWith('\\') -or $candidate.StartsWith('.') -or $candidate.StartsWith('/')
    if ($looksLikePath) {
        throw 'WIN_CSC_LINK points at a PFX path that does not exist. Refusing to self-sign.'
    }
    $compact = ($trimmed -replace '\s', '')
    if ($compact -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or $compact.Length -lt 128) {
        throw 'WIN_CSC_LINK is neither an existing PFX file nor a base64 PFX. Set -Thumbprint or WIN_CSC_THUMBPRINT instead. Refusing to self-sign.'
    }
    $bytes = [Convert]::FromBase64String($compact)
    $pfx = Join-Path $TempDirectory 'sidecar.pfx'
    [System.IO.File]::WriteAllBytes($pfx, $bytes)
    return $pfx
}

if ((Split-Path -Leaf $ExePath) -ne 'laya-sidecar.exe') {
    throw 'Refusing to sign a file that is not named laya-sidecar.exe.'
}
if ((Split-Path -Leaf $ManifestPath) -ne 'artifact-manifest.json') {
    throw 'Refusing to update a file that is not named artifact-manifest.json.'
}
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    throw "Sidecar executable is missing: $ExePath. Build it before signing."
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Sidecar manifest is missing: $ManifestPath. Build the sidecar before signing."
}

$signTool = Get-SignToolPath
$selectedThumbprint = if ($Thumbprint) { $Thumbprint } elseif ($env:WIN_CSC_THUMBPRINT) { $env:WIN_CSC_THUMBPRINT } else { '' }
$selectedThumbprint = ($selectedThumbprint -replace '\s', '').ToUpperInvariant()
$tempDir = $null
try {
    if ($selectedThumbprint) {
        if ($selectedThumbprint -notmatch '^[0-9A-F]{40}$') {
            throw 'Certificate thumbprint must be 40 hexadecimal characters. Refusing to self-sign.'
        }
        $arguments = @(
            'sign', '/sha1', $selectedThumbprint, '/fd', 'SHA256', '/td', 'SHA256',
            '/tr', 'http://timestamp.digicert.com', $ExePath
        )
        try {
            Invoke-SignTool -SignTool $signTool -ArgumentList $arguments
        } catch {
            $reason = "$_"
            if ($reason -notmatch 'No certificates were found|cannot find the certificate|No private key') { throw }
            $machineArgs = @('sign', '/sm') + $arguments[1..($arguments.Length - 1)]
            Invoke-SignTool -SignTool $signTool -ArgumentList $machineArgs
        }
    } else {
        $link = $env:WIN_CSC_LINK
        if (-not $link -or -not $link.Trim()) {
            throw 'No code signing certificate is configured. Set -Thumbprint or WIN_CSC_THUMBPRINT, or set WIN_CSC_LINK to an existing PFX file or a base64 PFX and set WIN_CSC_KEY_PASSWORD. Refusing to self-sign.'
        }
        $password = $env:WIN_CSC_KEY_PASSWORD
        if (-not $password) {
            throw 'WIN_CSC_KEY_PASSWORD is required when WIN_CSC_LINK is a PFX. Refusing to prompt. The password was not printed.'
        }
        $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'laya-sidecar-sign'
        New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
        $tempDir = Join-Path $tempRoot ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
        $pfx = Resolve-PfxPath -Link $link -TempDirectory $tempDir
        Invoke-SignTool -SignTool $signTool -Redact @($password, $link, $pfx) -ArgumentList @(
            'sign', '/f', $pfx, '/p', $password, '/fd', 'SHA256', '/td', 'SHA256',
            '/tr', 'http://timestamp.digicert.com', $ExePath
        )
    }

    Invoke-SignTool -SignTool $signTool -ArgumentList @('verify', '/pa', $ExePath)
    $signature = Get-AuthenticodeSignature -LiteralPath $ExePath
    if ($signature.Status -ne 'Valid') {
        throw "Authenticode status after signing is $($signature.Status). Expected Valid."
    }

    $hash = (Get-FileHash -LiteralPath $ExePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = [string](Get-Item -LiteralPath $ExePath).Length
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node.exe is required to refresh the sidecar manifest hash.' }
    $updater = @'
const fs = require('fs')
const [manifestPath, sha256, sizeText] = process.argv.slice(1)
if (!/^[0-9a-f]{64}$/.test(sha256 || '') || !/^[0-9]+$/.test(sizeText || '')) {
  console.error('manifest refresh arguments are invalid')
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entry = manifest.files && manifest.files['laya-sidecar.exe']
if (!entry) {
  console.error('artifact manifest does not list laya-sidecar.exe')
  process.exit(1)
}
entry.sha256 = sha256
entry.size = Number(sizeText)
manifest.build = manifest.build || {}
manifest.build.signed = true
manifest.build.signature = { digest: 'SHA256', timestamp: 'RFC3161' }
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
'@
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $node.Source -e $updater $ManifestPath $hash $size | Out-Host
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "Manifest refresh failed with exit code $code." }
} finally {
    Remove-OwnedCertTemp -Directory $tempDir
}

Write-Host "Signed laya-sidecar.exe and refreshed the manifest hash. Authenticode status: Valid."
