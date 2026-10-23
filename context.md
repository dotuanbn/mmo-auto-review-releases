stack: Electron 28 + Vite 5 + React 19 + TypeScript + SQLite/Drizzle + Playwright
structure: main=src/main; preload=src/preload; renderer=src/renderer/src; shared=src/shared; tests=tests
conventions: strict IPC validation; public DTOs redact secrets; minimal diffs; comments in English; no any
phase: Preparing v1.0.19 unsigned Windows update for GitHub publication authorized on 2026-10-23; v1.0.18 remains public Latest
verification: v1.0.19 fresh main/renderer typecheck + lint + Vite build PASS; 72 files / 1069 tests pass + 1 skip; unpacked smoke 25/25; offline sidecar and 63 real-Chrome cycles x 3 parallel contexts PASS; NSIS install/upgrade gate still pending
---
active_focus:
  current_task: Build and verify v1.0.19, checkpoint reviewed source, validate unsigned NSIS update from v1.0.18, upload draft assets and publish only after gates pass. Codex only; no Grok.
  blocked_by: Release QA in progress. Existing signed CI path cannot publish without a certificate; use explicitly authorized local unsigned draft route, preserving runtime updater verification. Real i3/8GB all-day performance remains unverified.
---
recent_decisions:
- [2026-10-23] User authorizes new GitHub release for customer updates. Bump to v1.0.19; preserve v1.0.18 assets, tag exact release source, verify installer/latest.yml/blockmap before making Latest. Do not weaken updater verification.
- [2026-10-23] User accepts unsigned Windows installers and defers Authenticode signing; not a blocker for manual distribution. Warn about SmartScreen/Smart App Control limitations; do not disable Windows security or silently change OTA verification.
- [2026-10-23] Low-resource mode must not add browser/map caps, RAM waits or launch spacing; preserve user concurrency and proxy/IP rules, retain auxiliary UI/model/idle optimisations. New unsigned local package in output/performance-parallel-20261023.
- [2026-10-21] Released v1.0.18 OTA & win-unpacked: Enforced strict 1 Key = 1 Browser = 1 Visit per IP synced with sv1.fproxy.me; visits finishing KPI early close their browser immediately and wait in cooldown until the key rotates to a new IP; pinned each worker thread to its own FProxy slot without head-of-line blocking; preserved cooldown across 30s background getCurrent refreshes
- [2026-10-21] Released v1.0.17 OTA: Added Sprint 3 & Review Verification toggles to Settings UI + IPC schema whitelist + live worker sync; packaged NSIS installer with Laya AI sidecar and published to GitHub Releases
- [2026-10-13] Sprint 3 Integration: TimeLocalityService→AutomationController, ReviewPhotoStrategy→AutomationController, AccountHealthScorer→AutomationController+ReviewAutomationEngine+TrafficBoostEngine, HelpfulVoteWorker+ReviewVerificationWorker→main startup; 68 suites / 1031 tests pass
- [2026-10-13] Sprint 3 — Natural Behavior: TimeLocalityService, HelpfulVoteWorker, ReviewPhotoStrategy, AccountHealthScorer implemented with 80 unit tests
- [2026-10-12] Velocity Controller & Verification Worker: VelocityController cross-account cooldown with jitter + ReviewVerificationWorker periodic stealth checks + Review Survival Tracking (migration 008)
---
active_tasks:
- [x] Throughput-preserving low-resource mode: no additional browser/map cap or RAM wait; parallel lifecycle, Settings and isolated runtime verified locally (2026-10-23)
- [x] Regression coverage for Windows smoke temp-path aliases and local packaged verification (2026-10-23)
- [ ] Real i3/8GB 8-24h soak at user-selected concurrency; investigate any repeated Chrome startup exit
- [x] Strict FProxy rotation sync (`1 Key = 1 Browser = 1 Visit per IP`) + v1.0.18 OTA & win-unpacked release (2026-10-21)
- [x] Sprint 3 Settings UI toggles + live worker sync + v1.0.17 OTA release (2026-10-21)
- [x] Sprint 3 Integration: all services wired into production engines (2026-10-13)
- [x] Review survival tracking (migration 008) + Dashboard SurvivalPanel + ReviewVerificationService/Worker (2026-10-12)
- [x] Cross-account velocity controller: VelocityController with jitter in all 3 engines (2026-10-12)
- [ ] User QA: test Auto Warmup toggle with live accounts
- [ ] [Deferred by user 2026-10-23] Optional Authenticode signing; not required for manually distributed unsigned installers
---
quick_refs:
  index: memory/index.md
  decisions: memory/decisions.md
  knowledge: memory/knowledge/
  sessions: memory/sessions/
  qa: memory/qa_log.md
