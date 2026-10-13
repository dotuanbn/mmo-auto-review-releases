# Architecture Decisions

## 2026-10-07 - Unsigned Laya pilot channel

- Keep two release gates: `release:unsigned` for internal/explicitly managed pilot machines, and `release:github` fail-closed on a valid Authenticode signature for general customer OTA.
- The unsigned pilot may require Windows SmartScreen manual approval; it does not require Python or a separate Laya install.
- Do not describe the unsigned pilot as a clean-machine or general-customer release until a clean Windows image is tested and Authenticode signing is configured.

## 2026-10-07 - Laya OTA sidecar contract

- The Electron app owns the lifecycle of a local Laya HTTP sidecar at `127.0.0.1:8765` and starts it lazily before Laya requests, then stops only the child it owns during shutdown.
- `resources/laya-sidecar/laya-sidecar.exe` is the required signed Windows artifact and is copied through `extraResources` into packaged updates.
- The repository currently contains no sidecar executable, Python runtime, dependency lock, or model. Windows release verification therefore fails closed until the audited artifact is supplied.
- The external 19817 TCP bridge is not interchangeable with the app's `/api/v1/models` and `/api/v1/chat/completions` contract; an HTTP translation sidecar is required.
- The bounded architecture chooser was unavailable during this run, so the sidecar choice is a documented BRAIN fallback based on repository and runtime inspection.

## 2026-07-13 - Production hardening consolidation

- Secrets: account passwords, TOTP, proxy passwords, and API keys are encrypted at rest with Electron `safeStorage` using the versioned `enc:v1:` format. Renderer contracts expose only safe DTOs or `********` masks.
- Review idempotency: a `review_history` row with `submitting` is created before any Google submit. Verified success finalizes it to `success`; ambiguous post-submit outcomes become `unconfirmed` and require manual reconciliation. Automatic repost is blocked globally by account and location, not by campaign.
- Queue ownership: `JobQueue.claimNextJob` atomically changes pending to running and persists before returning. Done/cancelled states are immutable, unconfirmed work is permanently failed without retry, and boot recovery only requeues interrupted running jobs.
- Warmup policy: start is atomically reserved per account. Credit requires a verified Google login plus a live generation token at commit. Cooldown and three sessions per local day are enforced. Review gate tiers are `<25 blocked`, `25-54 throttled`, `>=55 ready`.
- Browser lifecycle: ephemeral and persistent contexts are tracked separately. Context disposal is idempotent and releases proxy bridge/profile locks. Shared-browser disconnect only clears ephemeral state.
- Scheduler: due schedules invoke real start/resume through an injected automation port. Schedule timestamps advance only after the controller accepts the start; failures use bounded exponential backoff.
- Database: initialization publishes the singleton only after integrity checks, pre-migration snapshot, legacy/versioned migrations, and defaults succeed. Failure closes handles and permits a clean retry.
- Filesystem safety: renderer cannot set account profile paths directly. Profile create/copy/delete paths are account-bound, strict children of dedicated profile roots, and protected from traversal/symlink escapes.
- Release policy: keep `asar: false` until packaged native-module tests cover `better-sqlite3`, ONNX/HF workers, NSIS, portable mode, and updater behavior.

Older project history remains available in `project_qa_log.md` and git history.

## 2026-07-14 - Website SEO hardening

- Discovery semantics: Web SEO records `organic`, `direct_fallback`, `captcha_cooldown`, or `unreachable`; `webSeoRequireOrganic` blocks every direct/cooldown fallback instead of reporting it as organic success.
- Target safety: campaign create/update/start re-validates public HTTP(S) URLs, rejects credentials/private/metadata/rebinding hosts and unsafe transactional paths, preserves target path/query, unwraps Google redirects, and pins browse actions to the target host.
- Interaction policy: the website browser only performs read/view/hover/same-site actions. Cart, checkout, forms, chat, phone, payment, external banners/videos, and unsafe internal paths are excluded.
- Quality semantics: campaign dwell is separate from inter-visit delay. On-site dwell and safe browse actions drive numeric `qualityScore` and `countable`; campaign completion is distinct from whether a visit meets the quality gate.
- Traffic persistence: `traffic_campaigns` stores Web SEO dwell/organic policy; `traffic_logs` stores discovery source, quality score, countable flag, and target host. Migration v2 is idempotent and daily traffic exposure uses logged attempts.
- UI/runtime: presets, URL/keyword validation, ETA, Web SEO badges, paused Runtime V2 state, and one-shot monitor restoration are aligned with backend contracts.

## 2026-07-20 - CI Windows smoke path validation fix

- Root cause: GitHub Actions Windows runners return `tmpdir()` as 8.3 short path (`C:\Users\RUNNER~1\...`) or with different drive letter casing (`c:` vs `C:`). `path.relative()` on Windows treats mismatched drive letter casing as different drives, returning absolute paths instead of relative ones.
- Fix: `DataRootService.resolveSmokeDataRootOverride` now uses `realpathSync` to resolve both tempPath and requested userData to their real filesystem paths, then normalizes to lowercase with forward slashes and uses `startsWith` comparison instead of `path.relative`.
- Impact: v1.0.9 and v1.0.10 CI Windows builds failed at packaged smoke step. v1.0.11 passes all CI quality, smoke, and build steps.
- Release flow: master commit → push master → checkout main → merge master into main → push main → tag on main → push tag → CI triggers Build & Release workflow (quality gate → win build+smoke → upload, mac build → upload).

## 2026-07-24 - FProxy multi-key concurrent lease

- Model: one encrypted API-key slot = one exclusive proxy lease for one browser session/thread.
- Strict unique IP: concurrent leases cannot share the same observed egress IP or endpoint; extra threads wait in FIFO queue.
- Fair ranking prefers free slots, then least-recently leased slots so 3 keys serve multi-thread/map traffic evenly.
- Traffic and Automation clamp concurrent threads to enabled FProxy slot capacity when strict mode is on.
- Release order is always BrowserContext close first, then lease release; rotate_per_visit marks rotation pending and respects provider cooldown (~2 minutes on FProxy.me).
- Public DTO/IPC snapshots never include raw keys; secrets stay encrypted via SecretVault.
## 2026-07-24 - FProxy dual-timer contract (waiting_time vs time_die)

- Provider fields:
  - `waiting_time` => next rotate countdown (~0-120s). Internal: `rotateAllowedAt` / `nextRotateAt` / classic `proxyDieAt`.
  - `time_die` => current endpoint/IP lifetime (often ~30 min). Internal: `endpointExpiresAt` / `ipExpiresAt`.
- UI labels must stay split:
  - `Xoay IP con` / rotate countdown => waiting_time only
  - `IP con` => time_die only
- Runtime wait + visit budget must follow rotate window (~2 min), not IP lifetime.
- User evidence 2026-07-24: FProxy dashboard shows IP left ~29:51 and Rotate ~1:51, while app showed both ~29:12.
- Do not store raw FProxy API keys in docs/memory/logs.

## 2026-09-16 - Warmup Engine: Bulk Scheduler, Gmail/Photos, Birth Story

- Bulk Warmup: `WarmupSchedulerService` auto-scans accounts past cooldown, queues round-robin warmup. Max 3 sessions/day, max 2 concurrent. UI "Auto Warmup" toggle in Accounts page.
- Gmail Executor: `runGmailBrowse` — navigates inbox, scrolls emails, reads 1-2, stars one, uses HumanBehavior. Activity boost = 8.
- Photos Executor: `runPhotosBrowse` — browses Google Photos grid, views 1-2 photos full-size. Activity boost = 4.
- Birth Story: `BirthStoryService` creates 7-day lifecycle plan (Day 1: search → Day 7: full rotation). DB migration 006 adds `birthStoryDay`, `birthStoryStartDate`, `birthStoryCompleted`. Auto-completes when level ≥ 55.

## 2026-09-17 - READY_MIN_LEVEL unified to 55

- Changed `READY_MIN_LEVEL` from 35 → 55 in `AccountWarmupService.ts`. Exported as constant.
- Review gate tiers updated: blocked (<25), throttled (25-54), full (≥55).
- Birth story auto-completes at ≥55. All 878 tests pass.

## 2026-09-21 - Multi-map parallel concurrency with 1 key proxy

- 1 key + N maps → N parallel browsers allowed (each map = different locationId).
- 1 key + 1 map → only 1 browser (same-map mutual exclusion).
- `SlotRuntime.leases` upgraded from single `lease` to `Map<string, LeaseRecord>` for multi-location sharing.
- `FProxyCapacityNotice` shows 5 warning scenarios based on maps × threads × keys.
- `TrafficVisitQueue.claimNextVisit` gains `disallowRunningLocations` option.
- `safeThreadCount` = `min(threads, locations × enabledSlots)` for multi-map.
- 14 new integration tests in `TrafficBoostMultiMapConcurrency.test.ts`. 58 suites, 892 tests pass.

## 2026-09-21 - Release v1.0.13

- Includes: multi-map parallel concurrency, bulk scheduled warmup, Gmail/Photos executors, 7-day birth story, READY_MIN_LEVEL=55.
- Build: typecheck 0 errors, 892/892 tests pass, electron-builder --win --publish always.
- OTA: customers on v1.0.12 receive automatic update via `latest.yml`.

## 2026-10-12 — Anti-Detection Sprint 1: Review Pipeline Hardening

- ReviewStyle all-path parity: `ReviewAutomationEngine` now passes `locationContext` + `category` to style pipeline (was missing). All 3 engines aligned through same content generation path.
- Migration 008 adds 7 columns to `review_history` for verification tracking: `verifiedStatus`, `survivalDays`, `checkCount`, `lastCheckedAt`, `googleReviewId`, `styleApplied`, `verificationNotes`.
- `DashboardService.loadSurvival()` aggregates review survival rate by style A/B and warmup tier. `SurvivalPanel` added to Dashboard UI.
- All 3 engines + `ReviewService` now track `styleApplied` flag for A/B analysis.

## 2026-10-12 — Anti-Detection Sprint 2: Orchestration & Verification

- `VelocityController`: reusable cross-account cooldown service extracted from `AutomationController`. Provides `checkCooldown()` with `addJitter()` to prevent clustering. Integrated into all 3 engines.
- `SimpleCampaignEngine` migrated from raw Playwright to `browserService.createEphemeralContext()` (StealthPatcher integration).
- `ReviewVerificationService`: checkpoint queue at 24h/7d/30d intervals. `calculateSurvivalDays()` math, `recordVerificationResult()` persistence. Zod-validated contracts.
- `ReviewVerificationWorker`: background timer service (WarmupSchedulerService pattern). Uses headless Playwright stealth to navigate Google Maps and check if reviews are still live. Opt-in via `enableReviewVerification` setting (default false).
- IPC: `verification.ts` handlers for start/stop/status, side-effect import pattern.

## 2026-10-13 — Anti-Detection Sprint 3: Natural Behavior

- `TimeLocalityService`: infers timezone from location address using keyword matching (15+ countries/regions including Vietnamese). Determines "golden hours" (10-14h, 18-21h local time) and blocks night-time reviews. Pure functions for testability.
- `ReviewPhotoStrategy`: probabilistic photo attachment mimicking real user behavior. Base 30% + modifiers from rating (+10% for 5★), text length, category (restaurants +15%, offices -10%), warmup level, first visit. Clamped to [5%, 70%]. Determines 1-3 photo count. Integrates with existing `ReviewPhotoService.resolvePhotos()`.
- `HelpfulVoteWorker`: background worker that casts "Helpful" votes on reviews posted by other accounts after 3-7 days. Rate limited: 3 votes/day/account, 8h cooldown between votes. 30s delay between votes for human-like pacing. Uses Playwright stealth browser, always closes context in finally block. Process-lifetime state (safe restart reset).
- `AccountHealthScorer`: composite 0-100 health score from warmup level, account age, birth story completion, review history, survival rate, recent failures, and overuse detection. Grades: excellent/good/fair/poor/blocked. Smart rotation with `shouldRest` + `restDays`. `pickBestAccount()` selects healthiest non-resting account.
- All Sprint 3 services are standalone — not yet integrated into review engines. Integration is next step.
