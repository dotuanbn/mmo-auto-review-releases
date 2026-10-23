#Requires -Version 5.1
<#
.SYNOPSIS
  Packaged feature smoke for win-unpacked and silent NSIS install.

.DESCRIPTION
  Launches the packaged Electron app against isolated userData/output paths and
  reuses scripts/app-feature-smoke.cjs assertions. Fails hard on missing artifacts,
  install failure, or smoke failure -- never fakes a pass.

.PARAMETER Mode
  unpacked = smoke release\win-unpacked\MMO Auto Review.exe
  nsis     = silent-install Setup into a temp dir, then smoke the installed exe

.PARAMETER RepoRoot
  Repository root (default: current directory)

.PARAMETER UnpackedExe
  Optional path to win-unpacked executable

.PARAMETER SetupExe
  Optional path to NSIS setup (MMO-Auto-Review-Setup-*.exe)

.PARAMETER InstallDir
  Optional install target for NSIS silent mode (default: isolated temp path)

.PARAMETER KeepArtifacts
  Keep temp userData/output/install dirs after the run
#>
param(
    [ValidateSet('unpacked', 'nsis')]
    [string]$Mode = 'unpacked',

    [string]$RepoRoot = (Get-Location).Path,

    [string]$UnpackedExe = '',

    [string]$SetupExe = '',

    [string]$InstallDir = '',

    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-SmokeLog {
    param([string]$Message, [string]$Level = 'INFO')
    $ts = Get-Date -Format 'o'
    Write-Host "[$ts][$Level] $Message"
}

function Resolve-FullPath {
    param([string]$PathInput, [string]$Base)
    if ([string]::IsNullOrWhiteSpace($PathInput)) {
        return $null
    }
    if ([System.IO.Path]::IsPathRooted($PathInput)) {
        return [System.IO.Path]::GetFullPath($PathInput)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $PathInput))
}

function Assert-ExitZero {
    param(
        [Parameter(Mandatory = $true)][AllowNull()]
        [Nullable[int]]$Code,
        [Parameter(Mandatory = $true)][string]$What
    )
    if ($null -eq $Code -or $Code -ne 0) {
        throw "$What failed with exit code $Code"
    }
}

function Find-InstalledExe {
    param([string]$Root)
    $direct = Join-Path $Root 'MMO Auto Review.exe'
    if (Test-Path -LiteralPath $direct) {
        return $direct
    }
    $found = Get-ChildItem -LiteralPath $Root -Filter 'MMO Auto Review.exe' -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $found) {
        throw "Installed executable not found under: $Root"
    }
    return $found.FullName
}

function Invoke-SilentNsisInstall {
    param(
        [Parameter(Mandatory = $true)][string]$SetupPath,
        [Parameter(Mandatory = $true)][string]$TargetDir
    )

    if (-not (Test-Path -LiteralPath $SetupPath)) {
        throw "NSIS setup not found: $SetupPath"
    }

    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    $targetFull = [System.IO.Path]::GetFullPath($TargetDir)

    # electron-builder NSIS: /S silent, /D=absolute path (must be last, no quotes)
    Write-SmokeLog "Silent NSIS install: $SetupPath -> $targetFull"
    $proc = Start-Process -FilePath $SetupPath -ArgumentList @('/S', "/D=$targetFull") -WindowStyle Hidden -Wait -PassThru
    Assert-ExitZero -Code $proc.ExitCode -What 'NSIS silent install'

    # Give installer a moment to flush files on slow CI disks
    Start-Sleep -Seconds 2
    return (Find-InstalledExe -Root $targetFull)
}

function Invoke-FeatureSmoke {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$OutDir,
        [Parameter(Mandatory = $true)][string]$UserDataDir,
        [Parameter(Mandatory = $true)][string]$Root
    )

    if (-not (Test-Path -LiteralPath $Executable)) {
        throw "Executable not found for smoke: $Executable"
    }

    $smokeScript = Join-Path $Root 'scripts\app-feature-smoke.cjs'
    if (-not (Test-Path -LiteralPath $smokeScript)) {
        throw "Smoke script missing: $smokeScript"
    }

    New-Item -ItemType Directory -Force -Path $OutDir, $UserDataDir | Out-Null

    # Critical: Electron must not run as Node under Playwright.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $env:SMOKE_EXECUTABLE = $Executable
    $env:SMOKE_OUT_DIR = $OutDir
    $env:SMOKE_USER_DATA_DIR = $UserDataDir

    Write-SmokeLog "Feature smoke executable: $Executable"
    Write-SmokeLog "Isolated userData: $UserDataDir"
    Write-SmokeLog "Isolated output:   $OutDir"

    $nodeCmd = Get-Command node -ErrorAction Stop
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $nodeCmd.Source $smokeScript
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
        Remove-Item Env:SMOKE_EXECUTABLE -ErrorAction SilentlyContinue
        Remove-Item Env:SMOKE_OUT_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:SMOKE_USER_DATA_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }

    Assert-ExitZero -Code $code -What 'app-feature-smoke (packaged)'
}

# --- main ---
$exitCode = 1
$safeRoot = $null
$createdInstall = $false

try {
    $RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
        throw "RepoRoot does not look like the project root: $RepoRoot"
    }

    # Isolate all smoke state under TEMP -- never touch the developer's real userData.
    $runId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $safeRoot = Join-Path ([System.IO.Path]::GetTempPath()) (Join-Path 'mmo-packaged-smoke' $runId)
    $outDir = Join-Path $safeRoot 'output'
    $userDataDir = Join-Path $safeRoot 'user-data'
    New-Item -ItemType Directory -Force -Path $outDir, $userDataDir | Out-Null

    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    $exeToSmoke = $null

    if ($Mode -eq 'unpacked') {
        if ([string]::IsNullOrWhiteSpace($UnpackedExe)) {
            $UnpackedExe = Join-Path $RepoRoot 'release\win-unpacked\MMO Auto Review.exe'
        }
        else {
            $UnpackedExe = Resolve-FullPath -PathInput $UnpackedExe -Base $RepoRoot
        }

        if (-not (Test-Path -LiteralPath $UnpackedExe)) {
            throw "win-unpacked executable not found: $UnpackedExe"
        }
        $exeToSmoke = $UnpackedExe
        Write-SmokeLog "Mode=unpacked exe=$exeToSmoke"
    }
    else {
        if ([string]::IsNullOrWhiteSpace($SetupExe)) {
            $releaseDir = Join-Path $RepoRoot 'release'
            if (-not (Test-Path -LiteralPath $releaseDir)) {
                throw "release/ directory not found: $releaseDir"
            }
            $setupHit = Get-ChildItem -LiteralPath $releaseDir -Filter 'MMO-Auto-Review-Setup-*.exe' -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($null -eq $setupHit) {
                throw "NSIS setup not found (expected release/MMO-Auto-Review-Setup-*.exe)"
            }
            $SetupExe = $setupHit.FullName
        }
        else {
            $SetupExe = Resolve-FullPath -PathInput $SetupExe -Base $RepoRoot
        }

        if ([string]::IsNullOrWhiteSpace($InstallDir)) {
            $InstallDir = Join-Path $safeRoot 'install'
            $createdInstall = $true
        }
        else {
            $InstallDir = Resolve-FullPath -PathInput $InstallDir -Base $RepoRoot
        }

        # Safety: refuse silent-install into drive root / Windows / Program Files roots
        $installFull = [System.IO.Path]::GetFullPath($InstallDir)
        $unsafeRoots = @(
            ($env:SystemDrive + '\'),
            $env:SystemRoot,
            $env:ProgramFiles,
            ${env:ProgramFiles(x86)}
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            [System.IO.Path]::GetFullPath($_)
        }

        foreach ($badFull in $unsafeRoots) {
            $normalizedBad = $badFull.TrimEnd('\')
            if ($installFull.Equals($badFull, [System.StringComparison]::OrdinalIgnoreCase) -or
                $installFull.Equals($normalizedBad, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing unsafe InstallDir: $installFull"
            }
        }
        if ($installFull -match '^[A-Za-z]:\\$') {
            throw "Refusing unsafe InstallDir: $installFull"
        }

        $exeToSmoke = Invoke-SilentNsisInstall -SetupPath $SetupExe -TargetDir $InstallDir
        Write-SmokeLog "Mode=nsis installed exe=$exeToSmoke"
    }

    Invoke-FeatureSmoke -Executable $exeToSmoke -OutDir $outDir -UserDataDir $userDataDir -Root $RepoRoot

    Write-SmokeLog "Packaged feature smoke PASSED (mode=$Mode)" 'PASS'
    $exitCode = 0
}
catch {
    Write-SmokeLog ("Packaged feature smoke FAILED: " + $_.Exception.Message) 'FAIL'
    if ($_.ScriptStackTrace) {
        Write-Host $_.ScriptStackTrace
    }
    $exitCode = 1
}
finally {
    # Best-effort cleanup of isolated install/userData (optional keep for diagnosis).
    # Safety: only delete paths under TEMP\mmo-packaged-smoke -- never touch real user data.
    if (-not $KeepArtifacts -and $null -ne $safeRoot -and (Test-Path -LiteralPath $safeRoot)) {
        try {
            $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
            $safeFull = [System.IO.Path]::GetFullPath($safeRoot)
            $marker = [System.IO.Path]::Combine($tempRoot, 'mmo-packaged-smoke')
            $underTempSmoke = $safeFull.StartsWith($marker, [System.StringComparison]::OrdinalIgnoreCase)

            if (-not $underTempSmoke) {
                Write-SmokeLog "Skipping cleanup -- path not under TEMP\mmo-packaged-smoke: $safeFull" 'WARN'
            }
            else {
                if ($createdInstall -or $Mode -eq 'nsis') {
                    $uninstaller = Get-ChildItem -LiteralPath $safeRoot -Filter 'Uninstall*.exe' -Recurse -File -ErrorAction SilentlyContinue |
                        Select-Object -First 1
                    if ($null -ne $uninstaller) {
                        Write-SmokeLog "Silent uninstall: $($uninstaller.FullName)"
                        $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue
                        if ($null -ne $u -and $u.ExitCode -ne 0) {
                            Write-SmokeLog "Uninstaller exit $($u.ExitCode) (ignored for cleanup)" 'WARN'
                        }
                        Start-Sleep -Seconds 1
                    }
                }
                Remove-Item -LiteralPath $safeRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-SmokeLog "Cleanup warning: $($_.Exception.Message)" 'WARN'
        }
    }
    elseif ($KeepArtifacts -and $null -ne $safeRoot) {
        Write-SmokeLog "Kept artifacts at: $safeRoot"
    }
}

# Strict: non-zero always means real failure (no fake pass).
exit $exitCode
