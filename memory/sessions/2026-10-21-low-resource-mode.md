# 2026-10-21 — Low-resource mode (local implementation)

Superseded on 2026-10-23: User requested preserving parallel browsers/maps and new visits. The one-context cap, RAM admission waits and launch spacing below are historical, not the current policy. See memory/sessions/2026-10-23-low-resource-parallel.md and docs/LOW_RESOURCE_MODE.md. Earlier statements of a fully green final suite were contradicted by output/performance-final-unit.json (8 Scheduler failures); use fresh dated verification instead.

Task: Complete safe local release follow-ups and add a Settings toggle for stable operation on an i3-2130 / 8 GB PC.

Execution: Codex directly; Grok quota exhausted, no Grok or subagents invoked. One owner (Codex) for all changed files. Existing FProxy/Sprint 3 edits preserved; no commit, push, release upload, real-account writes or production data changes.

Architecture: Central BrowserResourceGovernor rather than independent per-engine limits. Laya bounded decision returned needs_fallback, confidence 0.5353; host selected the shared governor because all workers must share one enforceable budget. Defaults remain off; existing active sessions drain safely. See docs/LOW_RESOURCE_MODE.md.

Scope: shared performance DTO/limits; governor and BrowserService lifecycle/reservations; Settings IPC/preload/UI; worker admission/cancellation; resource deferral in durable queues; Laya memory/thread/idle policy; lazy pages and bounded hidden monitor buffers; Windows smoke path canonicalization and release source guard; tests and offline soak harness.

Acceptance: Boolean setting persists and broadcasts; aggregate admission capped at one in low mode; insufficient RAM does not consume job retry budget; cancellation/error releases permits/locks/proxies; idle browsers/models released; disabling restores normal admission without rewriting preferences; source gates plus isolated packaged/runtime evidence.

Checkpoint: 69 suites / 1054 tests passed before the final path/provenance regression additions. Typechecks, lint and Vite build passed. First packaged feature smoke passed 25/25 with zero page/console errors at C:/Users/Tuan/AppData/Local/Temp/mmo-packaged-smoke/20261021-154528-cd57a1bc/output/result.json. Final build and sustained-runtime verification still in progress.

Known limits: Actual host is i7-13700H / 16 GB. Memory pressure is injected; CPU throttling is an approximation. A short soak or simulated day does not prove 8–24 hours on the target i3. Signing certificate, live-account Auto Warmup and customer OTA remain unverified. Remote release CI still needs reviewed source to be pushed/tagged with explicit authorization.

Additional finding: Parallel build/test load exposed an FProxy wake race: cooldown could expire between tryAcquire and scheduleNextWake, leaving no future timer and timing out a valid waiter. Added a bounded 1-second wake only for a previously cooling, now-ready, error-free slot. Leased/busy/error slots do not gain blind provider retries. New regression advances the logical clock across that await boundary; existing pool tests and full suite passed after repair.

Latest source verification: 70 suites, 1059 passed + 1 POSIX-only test skipped on Windows; lint, main typecheck and renderer typecheck passed. Vite main renderer entry reduced from 894.62 KB to 361.90 KB (raw bundle size; not a measured speedup).

Preliminary runtime: output/performance-soak/2026-10-21T15-47-09-435Z/result.json passed 41 real Chrome create/close cycles with injected 8 GB memory, renderer CPU throttle 4x; zero leaked contexts/waiters and all UI gates passed. Main heap samples 69.2 to 73 MB, max Electron working set 502 MB (does not include the external Chrome process). This preceded the final idle-handoff/viewport refinement; final packaged soak remains pending.
