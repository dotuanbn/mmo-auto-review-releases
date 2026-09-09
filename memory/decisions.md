# Architecture Decisions

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
