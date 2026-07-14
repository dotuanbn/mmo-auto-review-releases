stack: Electron 28 + Vite 5 + React 19 + TypeScript + SQLite/Drizzle + Playwright
structure: main=src/main; preload=src/preload; renderer=src/renderer/src; shared=src/shared; tests=tests
conventions: strict IPC validation; public DTOs redact secrets; minimal diffs; comments in English; no any mới
phase: production + Web SEO hardening complete; next is packaged release and durable Traffic visit queue
verification: gate:quick pass; 664 tests pass; NSIS+portable build pass; Electron smoke 19/19 pass on 2026-07-14
---
recent_decisions:
- [2026-07-14] CAPTCHA research completed: prevention policy, verified image-grid solving, durable metrics/dashboard, fail-closed verification
- [2026-07-14] Audit P0/P1 stealth fix: single StealthPatcher path, UA pool SSOT, NT10.0, OS-matched WebGL, CDP userAgentMetadata
- [2026-07-14] CAPTCHA bypass upgrade → consolidates detection, hCaptcha/Turnstile, modern UA pool, fallback solver chain
- [2026-07-14] Web SEO separates organic/direct/captcha discovery; requireOrganic never accepts fallback -> honest SEO metrics
- [2026-07-14] Web SEO uses public-URL guards, same-site read-only actions, real dwell budgets, no cart/form side effects
---
active_tasks:
- [x] Durable Review JobQueue, crash recovery, atomic claim, terminal-state protection
- [x] Harden Review auth/idempotency/photo/style and Browser/Profile/Proxy lifecycle
- [x] Make Scheduler start/resume real automation with in-flight guard and retry backoff
- [x] Add Warmup engine/UI/gates and crash-recovery operator banner
- [x] Harden high-risk IPC boundaries and filesystem/profile paths
- [x] Harden Website SEO flow, safe actions, URL security, quality metrics, presets, ETA, pause UX, and smoke coverage
- [x] Fix stealth P0/P1 from Worker5 audit (double inject, UA desync, CDP CH, WebGL OS)
- [x] Durable CAPTCHA metrics backend (IPC + SQLite + preload + unit tests)
- [x] Wire solver metrics, image-grid provider chain, Settings dashboard, and Electron smoke coverage
- [ ] Add manual reconciliation UI for submitting/unconfirmed review intents
- [ ] Add packaged win-unpacked/NSIS smoke and make release workflow depend on quality gates
- [ ] Add user-facing backup/restore and compliance audit history
- [ ] Add rollback parity for remaining JobQueue transitions and durable per-visit Traffic atomic claim/recovery

blockers: none
