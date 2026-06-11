# MMO Auto Review - Current Handoff (2026-03-19)

Owner handoff target: new dev takes over from this snapshot.

## 1) Read this first
- This file: `docs/HANDOFF_CURRENT_2026-03-19.md`
- Updater runbook: `docs/UPDATER_GITHUB_RELEASE.md`
- Previous deep history: `docs/HANDOFF_V2_2026-03-15.md`
- AI login specific notes: `docs/HANDOFF_AI_LOGIN_2026-03-16.md`

## 2) Current release/update status (DONE)
- In-app auto update implemented for Windows NSIS installer flow.
- Portable/win-unpacked build is intentionally disabled for auto update.
- GitHub Releases provider is configured in `package.json`:
  - owner: `dotuanbn`
  - repo: `mmo-auto-review-releases`
- Current app version in source: `1.0.1`
- Latest published release already created: `v1.0.1`

Expected release artifacts for updater:
- `MMO-Auto-Review-Setup-<version>.exe`
- `latest.yml`
- `*.blockmap`

## 3) Files that matter for updater/release
- `src/main/services/UpdateService.ts`
  - updater state machine: `idle/checking/available/downloading/downloaded/error/disabled`
  - blocks install while campaign is running (`pendingInstall`)
  - disables updater on dev and portable/win-unpacked
- `src/main/ipc/updates.ts`
  - IPC: `updates:getState`, `updates:check`, `updates:checkAndDownload`, `updates:download`, `updates:install`
- `src/preload/index.ts`
  - exposes updater IPC to renderer
- `src/renderer/src/pages/Settings.tsx`
  - UI buttons: check/download, install after downloaded, updater status/progress
- `package.json`
  - build target `nsis`
  - publish provider github
  - scripts: `release:github`, `release:archive-local`
- `scripts/archive-release.cjs`
  - local archive of each release into `release-history/`
- `scripts/release-manager.ps1`
- `Release-Manager.bat`
  - click menu for non-command release flow on machine A

## 4) Machine A / Machine B operational model

### Machine A (build and publish)
- Run `Release-Manager.bat` and choose one option:
  - `1`: bump patch + publish + archive
  - `2`: publish current version + archive
  - `3`: build installer only
- Local archive is stored in:
  - `release-history/index.json`
  - `release-history/v<version>/...`

### Machine B (client update)
- Must install NSIS setup build first (not win-unpacked).
- In app Settings:
  - click `Kiem tra & Tai cap nhat`
  - after downloaded, click `Khoi dong lai de cap nhat`
- If campaign is running:
  - update can download
  - install is deferred until campaign is idle

## 5) Known open items (NOT DONE / need next dev)
From recent user feedback, these still need focused work and verification:
- Traffic engine still reports fail visits in some runs (watchdog/proxy/captcha/recovery path needs deeper tuning).
- User expects strict continuous thread refill (when one visit/context ends, next must start immediately) across all traffic modes.
- User expects browser window tiling to stay stable by thread count for entire campaign (2, 3, 4, ... layouts).
- Direct URL traffic mode needs parity with organic mode for map control behavior.
- Campaign list UX: bulk select + bulk delete requested.
- Proxy test can pass in settings but runtime visits still fail with `ERR_PROXY_CONNECTION_FAILED` in some cases.
- User requested stronger control over action count strategy (fixed/random ranges, up to high counts).
- User requested traffic profile targeting specific Google Business Performance metrics (needs product + compliance decision first).

## 6) Suggested next-dev priority order
1. Reproduce and fix proxy runtime mismatch (`settings test ok` but visit fail).
2. Harden traffic fail-path telemetry to identify exact fail reason buckets.
3. Enforce continuous thread refill policy with zero inter-visit idle gaps.
4. Complete direct-mode map interaction parity.
5. Implement campaign bulk-select/bulk-delete UI.
6. Add action-count policy UI/engine alignment and cap strategy.

## 7) Quick verification checklist for next dev
- Updater:
  - check state API works in packaged NSIS build
  - confirm download + restart install path
  - confirm install blocked while campaign running
- Traffic stability:
  - run 2-4 threads for at least 30-60 min
  - verify no deadlock/hang and no silent stalled thread
- Proxy:
  - run same proxy in settings test and in real visit flow
  - compare failure logs for auth/connectivity/rotation

## 8) Security note (important)
- A GitHub token was shared in chat during setup.
- Action required: revoke old token immediately and create a new token.
- Do not hardcode/store GH_TOKEN in source files or committed scripts.

## 9) Build and support notes
- This workspace currently appears without `.git` metadata in local folder snapshot.
- If continuing development, re-attach to git repository before new feature work.
