# Laya OTA sidecar — unsigned pilot artifact (2026-10-07)

## Current state

- The Electron Windows x64 package bundles `resources/laya-sidecar/laya-sidecar.exe`, its `_internal` runtime, and five pinned multilingual model files through `build.win.extraResources`.
- The app starts the sidecar lazily on a free loopback port and validates the service identity, protocol, PID, and `model_loaded` health response before using it.
- No Python, separate Laya installation, Hugging Face cache, or customer-side setup is required for the bundled runtime.

## Pilot release

- Added `npm run release:unsigned` for internal or explicitly managed pilot machines.
- Archive: `release-history/v1.0.16-r2`.
- Installer: `MMO-Auto-Review-Setup-1.0.16.exe`.
- Installer SHA-256: `8aedb209cd535a9444b87b2e712180de64a99168eb479761706dda77cd0f934b`.
- Installer size: 985,089,295 bytes.
- The pilot is unsigned. Windows SmartScreen may require `More info -> Run anyway`.

## Fresh verification

- Sidecar verification: local PE x64, manifest, source hash, runtime files, model hashes, and protocol passed; Authenticode status is `NotSigned`.
- Direct offline sidecar smoke: passed, including real model inference, invalid input handling, and clean child shutdown.
- Packaged unpacked smoke: 24 passed, 0 failed, 0 page errors, 0 console errors.
- Silent NSIS install smoke: 24 passed, 0 failed, 0 page errors, 0 console errors; uninstall completed.
- `npm run typecheck:renderer`, `npm run typecheck:main`, `npm run lint`, and `npm run test:run`: passed; test run was 60 files and 915 tests.
- No clean VM/customer machine was available; this is a fresh local packaged smoke with isolated temporary user data and no-cache sidecar execution.

## Release boundary

- `release:unsigned` is for pilot distribution only and archives locally; it is not the general-customer OTA path.
- `release:github` remains fail-closed on `--require-signature` until a real Authenticode certificate is configured. No OTA publication was performed.
