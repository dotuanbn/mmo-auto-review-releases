# Laya sidecar packaging

The Windows app starts `resources/laya-sidecar/laya-sidecar.exe` in development and `process.resourcesPath/laya-sidecar/laya-sidecar.exe` when packaged. The process must bind to loopback, honor `--host`, `--port`, and `--model-dir`, and answer `GET /api/v1/models` with `"protocol": 1`. The model directory is `model/multilingual` next to the executable. macOS does not start this executable and does not bundle it: `extraResources` is set only under `build.win`.

## Build

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-laya-sidecar.ps1
```

Optional parameters:

- `-PythonExe` — CPython 3.13 x64. The default is `py -3.13`, then `python.exe`.
- `-SiteDirectory` — reuse a virtual environment or a flat `pip --target` directory such as `output/laya-ota/build-site`. If it is incomplete, the script waits 15 seconds and then installs only into that site.
- `-WheelDirectory` — offline wheels. `pip` still uses `--require-hashes` and `--no-index`.
- `-ModelSource` — offline copy of the five multilingual files, either as that directory or its parent.
- `-Clean` — the only way PyInstaller receives `--clean`.

The work directory is `output/laya-sidecar-build` (gitignored). The script sets `PYTHONNOUSERSITE=1` and `PYTHONUSERBASE` inside that directory. PyInstaller is `--onedir --name laya-sidecar` with `--collect-submodules laya`, `--collect-data laya`, `--collect-binaries` for `torch`, `numpy`, `safetensors`, and `tokenizers`, plus the ModernBERT hidden imports. Output is staged under `output/laya-sidecar-build/dist/laya-sidecar`, then only `laya-sidecar.exe` and `_internal` are copied into `resources/laya-sidecar`. The model directory is preserved. Deletes are limited to those exact child names.

Every native command must exit 0. A nonzero PyInstaller, pip, or download result fails the build.

## Lockfiles

`scripts/laya-sidecar/requirements-win.lock` pins the build-site closure with wheel SHA256 values and `--require-hashes`. FastAPI, Uvicorn, Starlette, Pydantic, and OpenTelemetry are not required by Laya and are not locked. Critical versions are Laya 0.3.20, Torch 2.14.1, Transformers 5.19.0, and PyInstaller 6.22.3 with hooks 2026.8.

`scripts/laya-sidecar/model-lock.json` pins `convaiinnovations/laya` revision `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851` and these five files:

- `encoder/config.json`
- `model.safetensors`
- `rl_agent_config.json`
- `tokenizer/tokenizer.json`
- `tokenizer/tokenizer_config.json`

The build accepts a local copy only when the size and SHA256 match. Otherwise it downloads that exact revision URL and checks the hash before replacing the file. No Hugging Face token or customer cache is read. Runtime inference stays offline against the bundled directory.

## Manifest and licenses

`resources/laya-sidecar/artifact-manifest.json` records `arch` `win32-x64`, `protocol` 1, the adapter source SHA256, build versions, and the size and SHA256 of the executable, runtime tree, and five model files. The Python `LICENSE.txt` is copied to `_internal/licenses/PYTHON_LICENSE.txt`. Package license metadata that the wheels provide is written to `_internal/licenses/packages.json`. The manifest is unsigned (`build.signed: false`) until the sign script refreshes the executable hash.

## Signing

No certificate is created by this repository. Do not self-sign.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\sign-laya-sidecar.ps1 -Thumbprint <thumbprint>
```

Alternatively set `WIN_CSC_THUMBPRINT`, or set `WIN_CSC_LINK` to an existing PFX file or a base64 PFX and set `WIN_CSC_KEY_PASSWORD`. The scripts do not print those secrets, do not export private keys, and fail if no certificate is configured. `signtool.exe` from the Windows SDK signs with SHA256 and an RFC3161 timestamp, then verifies the signature. The manifest executable hash is updated only after Authenticode status is `Valid`.

## Verification and release

`node scripts/verify-laya-sidecar.cjs` checks the PE x64 machine header, manifest protocol, source hash, every declared path, the five model files, and `python313.dll`, `python3.dll`, and `vcruntime140.dll`. Authenticode is queried with the executable path passed as structured PowerShell input. An unsigned local artifact passes with the explicit text `NOT SIGNED`. Existence of the executable is not treated as a signature. `--require-signature` accepts only status `Valid`.

`npm run build:exe` and `npm run build:installer` run verification before `electron-builder`. `npm run release:github` requires a signature, builds with `--publish never`, runs unpacked and NSIS packaged smokes, and archives locally. It does not upload.

For an internal or explicitly managed pilot machine, an unsigned package can be built with:

```powershell
npm run release:unsigned
```

This still runs sidecar inference and both packaged smoke modes, then archives the installer locally. It does not remove Windows SmartScreen warnings and is not a general-customer OTA release path.

The Windows job in `.github/workflows/build-macos.yml` is the publisher. It sets up Python 3.13 x64, builds, signs with `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, or `WIN_CSC_THUMBPRINT`, verifies `--require-signature`, packages, runs both packaged smokes, runs `node scripts/smoke-laya-sidecar.cjs --root=release/win-unpacked/resources/laya-sidecar`, and only then uploads the GitHub release.
