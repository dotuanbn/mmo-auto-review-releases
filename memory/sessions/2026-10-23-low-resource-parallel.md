# 2026-10-23 — Throughput-preserving low-resource mode

Task: Preserve user-configured parallel browsers/maps and new visits while keeping auxiliary performance optimisations. Supersedes the earlier one-browser/RAM-wait policy.

Ownership: Codex only. Grok quota exhausted; no Grok or subagents. Preserve unrelated FProxy/Sprint 3 edits. No commit/push, production data, account actions or OTA publication.

Current state: Governor is accounting-only with advisory RAM warnings, immediate admission and no timer/queue. Removed extra caps/deferral from Traffic, Automation and background workers. Kept idle cleanup, viewport, model/thread and UI/log optimisations. Browser idle handoff now rechecks ownership under the lock to protect parallel launches.

Tests run: Final full suite 71 files, 1065 passed, 0 failed, 1 Windows-skipped POSIX test. Report: output/performance-parallel-unit-20261023.json. Targeted six-file regression: 60/60 passed before the final night-time Scheduler case. Main/renderer typecheck, ESLint (0 warnings), JS syntax checks and Vite build passed.

Scheduler fixture: Reproduced missing Electron app mock errors. Tests could pass outside the default rest-hour window despite those errors; the earlier eight failures were time-dependent. Isolated this scheduling test from real settings by explicitly disabling rest hours in its settings mock, plus a 23:30 fake-clock regression. No production scheduler policy changed.

Runtime result: output/performance-soak/2026-10-23T01-40-04-624Z/result.json completed successfully: 153 cycles, 3 real Chrome contexts each cycle (persistent + ephemeral), all 7 gates true, 0 page errors. Injected RAM alternated 500/1700 MB free of 8192 MB; app and Chrome CDP CPU throttle 4x. Main heap steady samples 77.2 -> 81 MB; max main RSS 199 MB; max Electron working set 672 MB EXCLUDES external Chrome. Idle browser reclaimed, no contexts/waiters remained, toggle persisted/reloaded/restored. Actual host i7-13700H/16GB; not target-machine or real-account campaign evidence.

Failed attempt retained: output/performance-soak/2026-10-23T01-36-42-186Z/result.json failed before the load loop, when system Chrome exited during launch. Standalone Chrome probes (default flags, feature override, full app flags with 3 pages) passed. A diagnostic rerun of the unchanged app passed the full soak. Cause remains unconfirmed; do not claim a startup bug was fixed. Diagnostic log is in the successful run's isolated-runtime.log.

Package: output/performance-parallel-20261023/MMO-Auto-Review-Setup-1.0.18.exe, 988171764 bytes; SHA256 BCCF2A7D1AAEFFB904B7D36726C85F3F2566FA5A18ED3D4C33A0046F594E4ACA. Built with electron-builder --win nsis --publish never. Installer and sidecar are NotSigned; installer install/upgrade was not run.

Packaged feature smoke: 25/25 passed, 0 page/console errors. Exact report: C:/Users/Tuan/AppData/Local/Temp/mmo-packaged-smoke/20261023-014356-b49ad89d/output/result.json. Confirms saved mode, maxContexts=null, queuedLaunches=0, boolean IPC guard and unchanged user concurrency preference. Uses the new win-unpacked package only.

Provenance: packaged main/preload entries, renderer index, active BrowserService-DUz6q8tG.js and TrafficBoostEngine-DI68MN_O.js hashes match the local build. Laya sidecar manifest passed all 5082 files; source 5a2a7cf15cbfc26de21385a3b7de7844aec4d83a166981aa4e669110d1747e9b. Release source guard passed local/non-tag version 1.0.18. Older 2026-10-21 packages/reports implement the superseded cap and are not validation of this revision.

Blockers/residual risks: No real i3/8 GB all-day measurement, NSIS install/upgrade validation, real-account QA or signing certificate. Initial Chrome startup exit has not been explained. No guarantee for unlimited load on finite hardware. General customer/OTA readiness is not implied by local checks.

Next action: User-directed target-machine QA at the desired concurrency; use --minutes=480 or 1440 and --parallel=<requested load> for the isolated harness. Review any repeat startup failure with logs. Do not install, publish or modify account data without authorization.

## Follow-up — User defers code signing

Task: Remove certificate acquisition from the current required scope; user accepts unsigned installers for customers.

Current state: Signing is optional/deferred for manual distribution, superseding the signing requirement in the blocker snapshot above. Existing `release:unsigned` path verified in package.json. `release:github` and Windows CI still require sidecar signing; no updater or release gate was changed.

Changed files: context.md, docs/UPDATER_GITHUB_RELEASE.md, memory/decisions.md, memory/index.md and this session note. Documentation only; no new binary, runtime change or external publication.

Verification scope: Inspect unsigned/signed npm scripts, Windows workflow and updater source; check documentation diff/whitespace. Prior test/build/soak results above are recorded evidence, not rerun by this documentation checkpoint.

Fresh verification: `git -c core.safecrlf=false diff --check` passed; package.json parsed successfully, unsigned script exists and signed release still requires `--require-signature`. context.md remains 37 lines. No code tests rerun for this documentation-only change.

Residual risks: SmartScreen continuation is conditional; enterprise policy or Windows 11 Smart App Control can block unsigned apps. Do not tell customers to disable protection or ignore malware detections. Real target-machine and install/upgrade QA remain open.

Next action: Continue functional/performance QA without waiting for a certificate. Any future OTA policy change needs its own explicit scope and update validation.
