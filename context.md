stack: Electron 28 + Vite 5 + React 19 + TypeScript + SQLite/Drizzle + Playwright
structure: main=src/main; preload=src/preload; renderer=src/renderer/src; shared=src/shared; tests=tests
conventions: strict IPC validation; public DTOs redact secrets; minimal diffs; comments in English; no any moi
phase: v1.0.12; map search direct fallback & realtime timer parity published to GitHub Releases
verification: 2026-09-09 published v1.0.12 with latest.yml, NSIS installer, portable exe; OTA verified 200 OK
---
recent_decisions:
- [2026-08-28] Map search & organic search fallback cleanly navigates directly to map URL + executes full warm-up/KPI/cool-down
- [2026-08-28] Thread timing card prioritizes live proxyRotateAt/proxyIpExpiresAt over internal watchdog buffer
- [2026-08-28] Leased slot refresh preserves active rotate countdown when getCurrent returns 0
- [2026-07-24] UI/runtime split: Xoay IP=waiting_time, IP con=time_die; visit budget uses rotate window only
- [2026-07-24] Settings save whitelist-only + FProxy encrypted multi-key pool
---
active_tasks:
- [x] Map search / organic search fallback to direct map navigation with full KPI engagement
- [x] Fix leased slot refresh in FProxyPoolService
- [x] Align Thread timer in Traffic UI to Xoay IP con & IP con
- [x] Rebuild win-unpacked (2026-08-28 14:49)
- [ ] User retest: live countdown parity with sv1.fproxy.me dashboard
- [ ] Multi-IP same-map concurrent QA
- [ ] Aeon first-visit Directions QA

blockers: User live retest; never store API keys in docs/memory/logs
