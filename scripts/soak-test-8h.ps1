param(
    [string]$AppPath = ".\release\win-unpacked\MMO Auto Review.exe",
    [int]$DurationHours = 8,
    [int]$IntervalSeconds = 30,
    [string]$Tag = "manual",
    [switch]$Wait
)

$ErrorActionPreference = "Stop"

function Resolve-ExecutablePath {
    param([string]$PathInput)
    if ([System.IO.Path]::IsPathRooted($PathInput)) {
        return $PathInput
    }
    return (Join-Path (Get-Location) $PathInput)
}

$resolvedAppPath = Resolve-ExecutablePath -PathInput $AppPath
if (-not (Test-Path $resolvedAppPath)) {
    throw "Không tìm thấy EXE: $resolvedAppPath"
}

$appDir = Split-Path -Parent $resolvedAppPath
if ([string]::IsNullOrWhiteSpace($appDir)) {
    $appDir = Get-Location
}

$env:MMO_SOAK_TEST_AUTO = "1"
$env:MMO_SOAK_TEST_HOURS = [string]$DurationHours
$env:MMO_SOAK_TEST_INTERVAL_SECONDS = [string]$IntervalSeconds
$env:MMO_SOAK_TEST_TAG = $Tag

Write-Host "Starting soak test..." -ForegroundColor Cyan
Write-Host "  EXE: $resolvedAppPath"
Write-Host "  Duration: $DurationHours hour(s)"
Write-Host "  Interval: $IntervalSeconds second(s)"
Write-Host "  Tag: $Tag"
Write-Host ""
Write-Host "Environment:"
Write-Host "  MMO_SOAK_TEST_AUTO=1"
Write-Host "  MMO_SOAK_TEST_HOURS=$DurationHours"
Write-Host "  MMO_SOAK_TEST_INTERVAL_SECONDS=$IntervalSeconds"
Write-Host "  MMO_SOAK_TEST_TAG=$Tag"
Write-Host ""
Write-Host "Log output path mặc định:"
Write-Host "  %APPDATA%\MMO Auto Review\logs\soak-tests"
Write-Host "Portable mode:"
Write-Host "  <folder EXE>\data\logs\soak-tests"
Write-Host ""

$proc = Start-Process -FilePath $resolvedAppPath -WorkingDirectory $appDir -PassThru
Write-Host "Started PID: $($proc.Id)" -ForegroundColor Green

if ($Wait) {
    Write-Host "Waiting for process to exit..." -ForegroundColor Yellow
    Wait-Process -Id $proc.Id
    Write-Host "Process exited." -ForegroundColor Yellow
}

