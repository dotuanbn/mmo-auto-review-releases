stack: Electron 28 + Vite 5 + React 19 + TypeScript + SQLite/Drizzle + Playwright
structure: main=src/main; preload=src/preload; renderer=src/renderer/src; shared=src/shared; tests=tests
conventions: strict IPC validation; public DTOs redact secrets; minimal diffs; comments in English; no any mới
phase: production release hardening + operational durability complete
verification: gate:quick pass; 845 tests pass; source/unpacked/NSIS smoke 23/23; NSIS+portable build pass on 2026-07-15
---
recent_decisions:
- [2026-07-15] Packaged smoke configures temp-only data root before runtime imports -> never touches real app data
- [2026-07-15] Backup/restore requires RESTORE, checksums, SQLite integrity, pre-snapshot, and symlink-safe targets
- [2026-07-15] Review submitting/unconfirmed intents require atomic manual reconciliation before retry/success
- [2026-07-15] Traffic uses durable per-visit seed/claim/lease/retry/recovery with terminal-state counters
- [2026-07-15] Release jobs depend on reusable quality gate and upload only after unpacked + NSIS smoke
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
- [x] Add manual reconciliation UI for submitting/unconfirmed review intents
- [x] Add packaged win-unpacked/NSIS smoke and make release workflow depend on quality gates
- [x] Add user-facing backup/restore and compliance audit history
- [x] Durable per-visit Traffic atomic claim/recovery (seed/claim/complete/pause/resume/stop)
- [x] Add rollback parity for remaining JobQueue transitions

blockers: none
