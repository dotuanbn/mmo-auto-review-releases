# Laya sidecar artifact

Windows x64 releases ship a signed `laya-sidecar.exe` beside `_internal` and the five pinned multilingual model files. The executable listens only on `127.0.0.1`, accepts `--host=127.0.0.1`, `--port=<port>`, and `--model-dir=<dir>`, and exposes `GET /api/v1/models` plus `POST /api/v1/chat/completions`.

These generated files are intentionally untracked:

- `laya-sidecar.exe`
- `_internal/`
- `model/`
- `artifact-manifest.json`

Build them with `npm run build:laya-sidecar`. That uses an isolated CPython 3.13 x64 environment and `scripts/laya-sidecar/requirements-win.lock`. It does not install into the global Python. A local unsigned build can be checked with `npm run verify:laya-sidecar`; verification says `NOT SIGNED` unless Authenticode status is `Valid`.

`npm run build:exe` and `npm run build:installer` run that check before Electron packaging. `npm run release:github` requires a valid signature and both packaged smoke modes, then archives locally. It does not upload. The tagged GitHub workflow signs the sidecar, verifies it, packages Windows, runs both packaged smokes plus `node scripts/smoke-laya-sidecar.cjs`, and only then uploads.

macOS packages do not bundle this Windows executable. See `docs/LAYA_SIDECAR_PACKAGING.md`.
