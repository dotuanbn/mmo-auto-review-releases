#Requires -Version 5.1
<#
.SYNOPSIS
  Build the isolated Windows x64 Laya sidecar.

.PARAMETER PythonExe
  CPython 3.13 x64 executable. Discovered when omitted.

.PARAMETER SiteDirectory
  Reuse an existing virtual environment or flat site-packages directory.

.PARAMETER ModelSource
  Optional offline directory that already contains the five pinned model files.

.PARAMETER WheelDirectory
  Optional offline wheel directory. Hashes still come from the lock.

.PARAMETER Clean
  Pass PyInstaller's --clean. Normal builds omit it so incremental rebuilds stay fast.
#>
[CmdletBinding()]
param(
    [string]$PythonExe = '',
    [string]$SiteDirectory = '',
    [string]$ModelSource = '',
    [string]$WheelDirectory = '',
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Output = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'output\laya-sidecar-build'))
$Resources = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'resources\laya-sidecar'))
$LockPath = Join-Path $RepoRoot 'scripts\laya-sidecar\requirements-win.lock'
$ModelLockPath = Join-Path $RepoRoot 'scripts\laya-sidecar\model-lock.json'
$SourcePath = Join-Path $RepoRoot 'scripts\laya-sidecar\laya_sidecar.py'
$PinnedRevision = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851'
$ExpectedModel = @(
    'encoder/config.json',
    'model.safetensors',
    'rl_agent_config.json',
    'tokenizer/tokenizer.json',
    'tokenizer/tokenizer_config.json'
)

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$ArgumentList = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $File @ArgumentList 2>&1 | ForEach-Object { Write-Host "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        throw "Command failed with exit code ${code}: $File"
    }
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$ArgumentList = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $File @ArgumentList 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        $tail = ($output | Select-Object -Last 30) -join "`n"
        throw "Command failed with exit code ${code}: $File`n$tail"
    }
    return $output
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child
    )
    $parentFull = [System.IO.Path]::GetFullPath($Parent)
    $childFull = [System.IO.Path]::GetFullPath($Child)
    $root = [System.IO.Path]::GetPathRoot($parentFull)
    if ($parentFull.TrimEnd('\') -eq $root.TrimEnd('\')) {
        throw "Refusing to use drive root as a build parent: $parentFull"
    }
    $prefix = $parentFull.TrimEnd('\') + '\'
    if (-not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to touch a path outside the expected parent: $childFull"
    }
    return $childFull
}

function Remove-ExactChild {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$ChildName
    )
    if ($ChildName -notmatch '^[A-Za-z0-9._-]+$') {
        throw "Refusing to delete unsafe name '$ChildName'."
    }
    $child = Assert-ContainedPath -Parent $Parent -Child (Join-Path $Parent $ChildName)
    if ((Split-Path -Leaf $child) -ne $ChildName) {
        throw "Refusing to delete unexpected path '$child'."
    }
    if (Test-Path -LiteralPath $child) {
        Remove-Item -LiteralPath $child -Recurse -Force
    }
}

function Assert-Python313x64 {
    param([Parameter(Mandatory)][string]$Python)
    Invoke-Native -File $Python -ArgumentList @(
        '-c',
        'import struct, sys; raise SystemExit(0 if sys.version_info[:2] == (3, 13) and struct.calcsize("P") == 8 else 1)'
    )
}

function Resolve-BasePython {
    if ($PythonExe) {
        if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
            throw "PythonExe was not found: $PythonExe"
        }
        return (Resolve-Path -LiteralPath $PythonExe).Path
    }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        $lines = @(Invoke-NativeCapture -File $launcher.Source -ArgumentList @('-3.13', '-c', 'import sys; sys.stdout.write(sys.executable)'))
        $executable = @($lines | Where-Object { $_ -and (Test-Path -LiteralPath $_.Trim() -PathType Leaf) }) | Select-Object -Last 1
        if ($executable) { return $executable.Trim() }
    }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) { return $python.Source }
    throw 'Python 3.13 x64 was not found. Pass -PythonExe.'
}

function Test-VirtualEnv {
    param([string]$Directory)
    if (-not $Directory) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Directory 'pyvenv.cfg')) -and
        (Test-Path -LiteralPath (Join-Path $Directory 'Scripts\python.exe') -PathType Leaf)
}

function Get-Sha256Lower {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-ModelCandidate {
    param([string]$Source, [Parameter(Mandatory)][string]$RelativePath)
    if (-not $Source) { return $null }
    $leaf = $RelativePath.Replace('/', '\')
    $direct = Join-Path $Source $leaf
    if (Test-Path -LiteralPath $direct -PathType Leaf) { return $direct }
    $nested = Join-Path (Join-Path $Source 'multilingual') $leaf
    if (Test-Path -LiteralPath $nested -PathType Leaf) { return $nested }
    return $null
}

if (-not $Output.EndsWith('\output\laya-sidecar-build', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an unexpected build directory: $Output"
}
if (-not $Resources.EndsWith('\resources\laya-sidecar', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to update an unexpected sidecar directory: $Resources"
}
foreach ($required in @($LockPath, $ModelLockPath, $SourcePath, (Join-Path $Resources 'README.md'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required sidecar input is missing: $required"
    }
}
$lockText = Get-Content -Raw -LiteralPath $LockPath
if ($lockText -notmatch '(?m)^--require-hashes\s*$') {
    throw 'requirements-win.lock is missing --require-hashes.'
}

$env:PYTHONNOUSERSITE = '1'
$env:PYTHONUSERBASE = Join-Path $Output 'userbase'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONWARNINGS = 'ignore'
New-Item -ItemType Directory -Force -Path $Output, $env:PYTHONUSERBASE | Out-Null

$helper = @'
import hashlib
import json
import os
import platform
import sys
from pathlib import Path

REQUIRED = {
    "laya": "0.3.20",
    "torch": "2.14.1",
    "transformers": "5.19.0",
    "pyinstaller": "6.22.3",
    "pyinstaller-hooks-contrib": "2026.8",
}
RUNTIME_DLLS = ("python313.dll", "python3.dll", "vcruntime140.dll")
REPARSE = 0x400
PINNED_REVISION = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851"


def norm(name):
    return name.lower().replace("_", "-")


def read_lock(path):
    reqs = {}
    lines = path.read_text(encoding="utf-8").splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if "==" in line and not line.startswith("#") and not line.startswith("--"):
            name, version = line.rstrip("\\").strip().split("==", 1)
            digest = ""
            if index + 1 < len(lines) and "--hash=sha256:" in lines[index + 1]:
                digest = lines[index + 1].split("sha256:", 1)[1].strip().lower()
            if len(digest) != 64:
                raise SystemExit(f"lock entry is missing a sha256 hash: {name}")
            reqs[norm(name)] = version.strip()
        index += 1
    if len(reqs) < 5:
        raise SystemExit("requirements lock did not contain pinned packages")
    for name, version in REQUIRED.items():
        if reqs.get(norm(name)) != version:
            raise SystemExit(f"requirements lock drifted for {name}: expected {version}")
    return reqs


def dist_versions(site):
    found = {}
    if not site.is_dir():
        return found
    for dist in site.glob("*.dist-info"):
        metadata = dist / "METADATA"
        if not metadata.is_file():
            continue
        name = version = None
        header = metadata.read_text(encoding="utf-8", errors="replace").split("\n\n", 1)[0]
        for row in header.splitlines():
            if row.lower().startswith("name:"):
                name = row.split(":", 1)[1].strip()
            elif row.lower().startswith("version:"):
                version = row.split(":", 1)[1].strip()
        if name and version:
            found[norm(name)] = version
    return found


def check_site(site, lock_path):
    reqs = read_lock(lock_path)
    found = dist_versions(site)
    missing = [name for name, version in reqs.items() if found.get(name) != version]
    print("SITE_MISSING" if missing else "SITE_OK")
    return 0


def show_versions(lock_path, dest):
    import importlib.metadata as metadata

    reqs = read_lock(lock_path)
    found = {}
    display = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        key = norm(name)
        if key in reqs and key not in found:
            found[key] = dist.version
            display[name] = dist.version
    missing = [name for name, version in sorted(reqs.items()) if found.get(name) != version]
    if missing:
        raise SystemExit("installed environment does not match the lock: " + ", ".join(missing[:8]))
    payload = {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "machine": platform.machine(),
        "platform": sys.platform,
        "versions": {name: found[norm(name)] for name in REQUIRED},
    }
    dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("VERSIONS_OK")
    return 0


def license_of(dist):
    meta = dist.metadata
    expression = (meta.get("License-Expression") or "").strip()
    if expression:
        return expression
    raw = (meta.get("License") or "").strip()
    if raw and len(raw) <= 160 and "\n" not in raw:
        return raw
    classifiers = [item for item in (meta.get_all("Classifier") or []) if item.startswith("License ::")]
    if len(classifiers) == 1:
        return classifiers[0]
    return None


def write_licenses(lock_path, dest):
    import importlib.metadata as metadata

    reqs = read_lock(lock_path)
    rows = []
    seen = set()
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        key = norm(name)
        if key not in reqs or key in seen:
            continue
        seen.add(key)
        rows.append({"name": name, "version": dist.version, "license": license_of(dist)})
    if len(rows) != len(reqs):
        raise SystemExit("could not read metadata for every locked package")
    rows.sort(key=lambda row: row["name"].lower())
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    print(f"LICENSES_OK {len(rows)}")
    return 0


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_regular(path):
    stat_result = path.lstat()
    if getattr(stat_result, "st_file_attributes", 0) & REPARSE:
        raise SystemExit(f"refusing to hash a reparse point: {path}")
    if not stat_result.st_mode & 0x8000:
        raise SystemExit(f"refusing to hash a non-file: {path}")


def add_file(files, root, full):
    assert_regular(full)
    relative = full.relative_to(root).as_posix()
    files[relative] = {"sha256": sha256(full), "size": full.lstat().st_size}


def write_manifest(root, manifest_path, source, model_lock_path, versions_path):
    if platform.machine() not in ("AMD64", "x86_64") or sys.platform != "win32" or sys.version_info[:2] != (3, 13):
        raise SystemExit("refusing to write a manifest from a Python that is not Windows CPython 3.13 x64")
    root = root.resolve()
    files = {}
    add_file(files, root, root / "laya-sidecar.exe")
    internal = root / "_internal"
    if not internal.is_dir():
        raise SystemExit("staged sidecar is missing _internal")
    for dirpath, dirnames, filenames in os.walk(internal, followlinks=False):
        current = Path(dirpath)
        assert_regular(current) if current.is_file() else None
        if getattr(current.lstat(), "st_file_attributes", 0) & REPARSE:
            raise SystemExit(f"refusing to walk a reparse point: {current}")
        kept = []
        for name in dirnames:
            child = current / name
            if getattr(child.lstat(), "st_file_attributes", 0) & REPARSE:
                raise SystemExit(f"refusing to walk a reparse point: {child}")
            kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            add_file(files, root, current / name)
    model_lock = json.loads(model_lock_path.read_text(encoding="utf-8"))
    if model_lock.get("repository") != "convaiinnovations/laya" or model_lock.get("revision") != PINNED_REVISION:
        raise SystemExit("model lock is not the pinned revision")
    if model_lock.get("path") != "multilingual" or len(model_lock.get("files") or []) != 5:
        raise SystemExit("model lock must list the multilingual 5-file set")
    model_files = []
    for item in model_lock["files"]:
        relative_text = item["path"].replace("\\", "/")
        if ".." in relative_text.split("/"):
            raise SystemExit(f"unsafe model path: {relative_text}")
        full = root.joinpath("model", "multilingual", *relative_text.split("/"))
        add_file(files, root, full)
        relative = f"model/multilingual/{relative_text}"
        record = files[relative]
        if record["sha256"] != item["sha256"].lower() or record["size"] != item["size"]:
            raise SystemExit(f"model file does not match the lock: {relative}")
        model_files.append({"path": relative_text, "sha256": record["sha256"], "size": record["size"]})
    lowered = {key.lower() for key in files}
    for dll in RUNTIME_DLLS:
        if not any(key.endswith("/" + dll) for key in lowered):
            raise SystemExit(f"runtime DLL missing from sidecar: {dll}")
    versions = json.loads(versions_path.read_text(encoding="utf-8"))
    manifest = {
        "schema": 1,
        "arch": "win32-x64",
        "protocol": 1,
        "source": {"path": "scripts/laya-sidecar/laya_sidecar.py", "sha256": sha256(source)},
        "model": {
            "repository": "convaiinnovations/laya",
            "revision": PINNED_REVISION,
            "path": "multilingual",
            "files": model_files,
        },
        "build": {
            "python": versions["python"],
            "implementation": versions["implementation"],
            "machine": "AMD64",
            "platform": "win32",
            "signed": False,
            "versions": versions["versions"],
        },
        "licenses": {
            "python": {"name": "Python", "license": "PSF-2.0", "file": "_internal/licenses/PYTHON_LICENSE.txt"},
            "packagesFile": "_internal/licenses/packages.json",
        },
        "files": dict(sorted(files.items())),
    }
    for required in ("_internal/licenses/PYTHON_LICENSE.txt", "_internal/licenses/packages.json"):
        if required not in files:
            raise SystemExit(f"license file was not staged: {required}")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"MANIFEST_OK {len(files)}")
    return 0


def main():
    command = sys.argv[1]
    if command == "check-site":
        raise SystemExit(check_site(Path(sys.argv[2]), Path(sys.argv[3])))
    if command == "show-versions":
        raise SystemExit(show_versions(Path(sys.argv[2]), Path(sys.argv[3])))
    if command == "write-licenses":
        raise SystemExit(write_licenses(Path(sys.argv[2]), Path(sys.argv[3])))
    if command == "write-manifest":
        raise SystemExit(write_manifest(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), Path(sys.argv[5]), Path(sys.argv[6])))
    raise SystemExit(f"unknown helper command: {command}")


if __name__ == "__main__":
    main()
'@
$helperPath = Join-Path $Output 'helper.py'
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($helperPath, $helper, $utf8)

$basePython = Resolve-BasePython
Assert-Python313x64 -Python $basePython
$siteFull = if ($SiteDirectory) { [System.IO.Path]::GetFullPath($SiteDirectory) } else { '' }
if ($siteFull -and -not (Test-Path -LiteralPath $siteFull -PathType Container)) {
    throw "SiteDirectory was not found: $siteFull"
}
$siteIsVenv = Test-VirtualEnv -Directory $siteFull
if ($siteIsVenv) {
    $BuildPython = Join-Path $siteFull 'Scripts\python.exe'
    Assert-Python313x64 -Python $BuildPython
    $sitePackages = Join-Path $siteFull 'Lib\site-packages'
} else {
    $venv = Join-Path $Output 'venv'
    $BuildPython = Join-Path $venv 'Scripts\python.exe'
    if (Test-Path -LiteralPath $BuildPython -PathType Leaf) {
        Assert-Python313x64 -Python $BuildPython
    } else {
        Invoke-Native -File $basePython -ArgumentList @('-m', 'venv', $venv)
        Assert-Python313x64 -Python $BuildPython
    }
    $sitePackages = if ($siteFull) { $siteFull } else { Join-Path $venv 'Lib\site-packages' }
    $pth = Join-Path $venv 'Lib\site-packages\laya-build-site.pth'
    if ($siteFull) {
        [System.IO.File]::WriteAllText($pth, $siteFull + "`n", $utf8)
    } elseif (Test-Path -LiteralPath $pth) {
        Remove-Item -LiteralPath $pth -Force
    }
}

function Test-SiteReady {
    $lines = @(Invoke-NativeCapture -File $BuildPython -ArgumentList @($helperPath, 'check-site', $sitePackages, $LockPath))
    $text = $lines -join "`n"
    if ($text -match '(?m)^SITE_OK$') { return $true }
    if ($text -match '(?m)^SITE_MISSING$') { return $false }
    throw "Site check returned an unexpected result.`n$text"
}

$ready = Test-SiteReady
if (-not $ready -and $siteFull) {
    foreach ($attempt in 1..3) {
        Write-Host "Pinned build site does not satisfy the lock yet. Waiting 15 seconds ($attempt/3)."
        Start-Sleep -Seconds 15
        $ready = Test-SiteReady
        if ($ready) { break }
    }
}
if (-not $ready) {
    $pipArgs = @(
        '-m', 'pip', 'install', '--isolated', '--disable-pip-version-check', '--no-compile', '--no-deps',
        '--no-user', '--require-hashes', '--only-binary=:all:', '--requirement', $LockPath
    )
    if ($WheelDirectory) {
        if (-not (Test-Path -LiteralPath $WheelDirectory -PathType Container)) {
            throw "WheelDirectory was not found: $WheelDirectory"
        }
        $pipArgs += @('--no-index', '--find-links', ([System.IO.Path]::GetFullPath($WheelDirectory)))
    }
    if ($siteFull -and -not $siteIsVenv) {
        $pipArgs += @('--target', $siteFull)
    }
    Invoke-Native -File $BuildPython -ArgumentList $pipArgs
    if (-not (Test-SiteReady)) {
        throw 'The isolated environment still does not match requirements-win.lock.'
    }
}

$versionFile = Join-Path $Output 'versions.json'
Invoke-Native -File $BuildPython -ArgumentList @($helperPath, 'show-versions', $LockPath, $versionFile)

$model = Get-Content -Raw -LiteralPath $ModelLockPath | ConvertFrom-Json
if ($model.repository -ne 'convaiinnovations/laya' -or $model.revision -ne $PinnedRevision -or $model.path -ne 'multilingual') {
    throw 'model-lock.json is not the pinned convaiinnovations/laya multilingual revision.'
}
$modelFiles = @($model.files)
if ($modelFiles.Count -ne 5) { throw 'model-lock.json must contain exactly 5 files.' }
$seenModel = @{}
$modelRoot = Join-Path $Resources 'model\multilingual'
$prefix = "https://huggingface.co/convaiinnovations/laya/resolve/$PinnedRevision/multilingual/"
foreach ($file in $modelFiles) {
    $relative = ([string]$file.path).Replace('\', '/')
    if ($ExpectedModel -notcontains $relative -or $relative -match '(^|/)\.\.(/|$)') {
        throw "model-lock.json contains an unexpected path: $relative"
    }
    if ($seenModel.ContainsKey($relative)) { throw "model-lock.json repeats $relative" }
    $seenModel[$relative] = $true
    $url = [string]$file.url
    if ($url -ne ($prefix + $relative)) { throw "model-lock.json URL is not the pinned revision URL for $relative" }
    $expectedHash = ([string]$file.sha256).ToLowerInvariant()
    $expectedSize = [int64]$file.size
    $destination = Assert-ContainedPath -Parent $modelRoot -Child (Join-Path $modelRoot ($relative.Replace('/', '\')))
    $candidate = Resolve-ModelCandidate -Source $ModelSource -RelativePath $relative
    $selected = $null
    foreach ($path in @($candidate, $destination)) {
        if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $length = [int64](Get-Item -LiteralPath $path).Length
        if ($length -eq $expectedSize -and (Get-Sha256Lower -Path $path) -eq $expectedHash) {
            $selected = $path
            break
        }
    }
    if (-not $selected) {
        $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
        if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) {
            throw 'curl.exe is required to download a missing pinned model file. No Hugging Face credentials are used.'
        }
        $downloadDir = Join-Path $Output 'download'
        New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
        $temp = Join-Path $downloadDir (($relative.Replace('/', '__')) + '.download')
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
        Write-Host "Downloading pinned model file $relative"
        Invoke-Native -File $curl -ArgumentList @(
            '--fail', '--location', '--silent', '--show-error', '--proto', '=https',
            '--retry', '3', '--retry-delay', '2', '--output', $temp, $url
        )
        $length = [int64](Get-Item -LiteralPath $temp).Length
        $hash = Get-Sha256Lower -Path $temp
        if ($length -ne $expectedSize -or $hash -ne $expectedHash) {
            Remove-Item -LiteralPath $temp -Force
            throw "Downloaded model file failed the pinned SHA256 check: $relative"
        }
        $selected = $temp
    }
    if (([System.IO.Path]::GetFullPath($selected)) -ne ([System.IO.Path]::GetFullPath($destination))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $selected -Destination $destination -Force
        if ((Get-Sha256Lower -Path $destination) -ne $expectedHash) {
            throw "Staged model file failed the pinned SHA256 check: $relative"
        }
    }
}

$dist = Join-Path $Output 'dist'
$work = Join-Path $Output 'work'
$spec = Join-Path $Output 'spec'
New-Item -ItemType Directory -Force -Path $dist, $work, $spec | Out-Null
$pyinstaller = @(
    '-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'laya-sidecar',
    '--distpath', $dist, '--workpath', $work, '--specpath', $spec,
    '--collect-submodules', 'laya',
    '--collect-data', 'laya',
    '--collect-binaries', 'torch',
    '--collect-binaries', 'numpy',
    '--collect-binaries', 'safetensors',
    '--collect-binaries', 'tokenizers',
    '--hidden-import', 'transformers.models.modernbert.modeling_modernbert',
    '--hidden-import', 'transformers.models.modernbert.configuration_modernbert'
)
if ($Clean) { $pyinstaller += '--clean' }
$pyinstaller += $SourcePath
Invoke-Native -File $BuildPython -ArgumentList $pyinstaller

$stage = Join-Path $dist 'laya-sidecar'
$stageExe = Join-Path $stage 'laya-sidecar.exe'
$stageInternal = Join-Path $stage '_internal'
if (-not (Test-Path -LiteralPath $stageExe -PathType Leaf) -or -not (Test-Path -LiteralPath $stageInternal -PathType Container)) {
    throw "PyInstaller did not stage laya-sidecar.exe and _internal under $stage"
}
$licenseDir = Join-Path $stageInternal 'licenses'
New-Item -ItemType Directory -Force -Path $licenseDir | Out-Null
$prefixLine = @(Invoke-NativeCapture -File $BuildPython -ArgumentList @('-c', 'import sys; sys.stdout.write(sys.base_prefix)'))
$pythonPrefix = @($prefixLine | Where-Object { $_ -and (Test-Path -LiteralPath $_.Trim() -PathType Container) } | Select-Object -Last 1)
if (-not $pythonPrefix) { throw 'Could not resolve the base Python prefix needed for LICENSE.txt.' }
$pythonPrefix = $pythonPrefix.Trim()
$pythonLicense = Join-Path $pythonPrefix 'LICENSE.txt'
if (-not (Test-Path -LiteralPath $pythonLicense -PathType Leaf)) {
    throw "Python license was not found at $pythonLicense"
}
Copy-Item -LiteralPath $pythonLicense -Destination (Join-Path $licenseDir 'PYTHON_LICENSE.txt') -Force
Invoke-Native -File $BuildPython -ArgumentList @($helperPath, 'write-licenses', $LockPath, (Join-Path $licenseDir 'packages.json'))

Remove-ExactChild -Parent $Resources -ChildName 'laya-sidecar.exe.new'
Remove-ExactChild -Parent $Resources -ChildName '_internal.new'
Copy-Item -LiteralPath $stageExe -Destination (Join-Path $Resources 'laya-sidecar.exe.new') -Force
Copy-Item -LiteralPath $stageInternal -Destination (Join-Path $Resources '_internal.new') -Recurse -Force
Remove-ExactChild -Parent $Resources -ChildName 'laya-sidecar.exe'
Remove-ExactChild -Parent $Resources -ChildName '_internal'
Rename-Item -LiteralPath (Join-Path $Resources 'laya-sidecar.exe.new') -NewName 'laya-sidecar.exe'
Rename-Item -LiteralPath (Join-Path $Resources '_internal.new') -NewName '_internal'

$manifest = Join-Path $Resources 'artifact-manifest.json'
Remove-ExactChild -Parent $Resources -ChildName 'artifact-manifest.json'
Invoke-Native -File $BuildPython -ArgumentList @(
    $helperPath, 'write-manifest', $Resources, $manifest, $SourcePath, $ModelLockPath, $versionFile
)
Write-Host "Laya sidecar staged at $Resources. The executable is NOT signed. Run scripts/sign-laya-sidecar.ps1 before a release."
