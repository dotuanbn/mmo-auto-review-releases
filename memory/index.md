# Memory Index (L1)

Bản đồ điều hướng Adaptive Memory System 5 tầng. Đọc L0 trước mỗi session; nhảy L3/L4 theo task, không nhồi toàn bộ vào working memory.

## Tầng

| Tầng | Vai trò | File | Load khi |
|------|---------|------|----------|
| **L0 Working Memory** | Snapshot nóng: stack, phase, focus, task chưa xong | [`context.md`](../context.md) | **Luôn** — giữ <60 dòng |
| **L1 Memory Index** | Bản đồ này | [`memory/index.md`](index.md) | Khi cần tìm đúng file L2–L4 |
| **L2 Session Memory** | Tóm tắt phiên làm việc | [`memory/sessions/`](sessions/) | Tiếp session gần / handoff |
| **L3 Long-term Knowledge** | Kiến trúc & domain bền | [`memory/knowledge/`](knowledge/) | Task đụng module tương ứng |
| **L4 Decisions & QA** | Quyết định + câu hỏi đã trả lời | [`decisions.md`](decisions.md), [`qa_log.md`](qa_log.md) | Trước khi đổi contract / policy |

Quy tắc: L0 chỉ task **chưa làm**. Quyết định mới → append L4, rồi rút 5 mục gần nhất lên L0. Không ghi API keys / secrets vào bất kỳ tầng nào.

## L0 — Working Memory

- [`../context.md`](../context.md) — stack, phase v1.1.0-dev, `active_focus`, 5 `recent_decisions`, `active_tasks`, `quick_refs`

## L2 — Sessions

| File | Nội dung |
|------|----------|
| [`sessions/2026-09-21-summary.md`](sessions/2026-09-21-summary.md) | Release v1.0.13: multi-map parallel, Auto Warmup, Gmail/Photos, birth story, READY_MIN_LEVEL=55; 892 tests; OTA pending |
| [`sessions/2026-10-07-laya-ota-unsigned.md`](sessions/2026-10-07-laya-ota-unsigned.md) | Laya bundled Windows x64 sidecar, unsigned pilot installer, fresh packaged smoke evidence, and Authenticode release blocker |
| [`sessions/2026-10-12-sprint123-summary.md`](sessions/2026-10-12-sprint123-summary.md) | Sprint 1–3: ReviewStyle parity, migration 008, dashboard survival, VelocityController, ReviewVerificationWorker, TimeLocality, PhotoStrategy, HelpfulVote, AccountHealth; 68 suites / 1031 tests |

## L3 — Knowledge

| File | Đọc khi |
|------|---------| 
| [`knowledge/architecture.md`](knowledge/architecture.md) | IPC, SQLite/Drizzle, SecretVault, BrowserService lifecycle, sơ đồ process |
| [`knowledge/traffic-concurrency.md`](knowledge/traffic-concurrency.md) | 1 key × N map song song, SlotRuntime lease share, same-map exclusion, TrafficVisitQueue |
| [`knowledge/warmup-engine.md`](knowledge/warmup-engine.md) | WarmupScheduler ngầm, Gmail/Photos, 7-Day Birth Story, reputation tiers, READY_MIN_LEVEL=55 |

## L4 — Decisions & QA

| File | Nội dung |
|------|----------|
| [`decisions.md`](decisions.md) | ADR: secrets, review idempotency, JobQueue, warmup gate, FProxy pool/dual-timer, multi-map, v1.0.13, Sprint 1–3 anti-detection |
| [`qa_log.md`](qa_log.md) | Hỏi-đáp đã đóng: hardening, Web SEO, FProxy, dual-timer, CI Windows smoke |

Lịch sử dài hơn (không phải memory nóng): `project_qa_log.md`, `docs/HANDOFF_CURRENT_2026-03-19.md`, `docs/ANTI_DETECTION_STRATEGY.md`, `CHANGELOG.md`.

## Routing nhanh theo task

| Task | Đọc |
|------|-----|
| Sửa IPC / preload / DTO | L3 architecture → `src/main/ipc`, `src/shared/*-contracts.ts` |
| Proxy / FProxy / thread | L3 traffic-concurrency + L4 FProxy decisions |
| Traffic campaign / visit queue | L3 traffic-concurrency → `TrafficBoostEngine`, `TrafficVisitQueue` |
| Warmup / birth story / review gate | L3 warmup-engine + L4 2026-09-16/17 |
| Encryption / settings secrets | L3 architecture (SecretVault) + L4 2026-07-13 |
| Browser crash / profile lock | L3 architecture (browser lifecycle) |
| Release / OTA | L0 phase + `docs/UPDATER_GITHUB_RELEASE.md` + session 2026-09-21 |
| Review velocity / cross-account timing | L4 2026-10-12 Sprint 2 + `VelocityController.ts`, `TimeLocalityService.ts` |
| Review survival / verification | L4 2026-10-12 Sprint 1–2 + `ReviewVerificationService.ts`, `ReviewVerificationWorker.ts` |
| Photo strategy / content naturalness | L4 2026-10-13 Sprint 3 + `ReviewPhotoStrategy.ts`, `ReviewPhotoService.ts` |
| Account health / rotation | L4 2026-10-13 Sprint 3 + `AccountHealthScorer.ts`, `LayaAccountHealthService.ts` |
| Helpful vote / cross-account interaction | L4 2026-10-13 Sprint 3 + `HelpfulVoteWorker.ts`, `HelpfulVoteService.ts` |

## Phase hiện tại (v1.1.0-dev)

Đã ship (code): multi-map parallel 1-key, Auto Warmup scheduler, Gmail/Photos executors, 7-day birth story (migration 006), READY_MIN_LEVEL=55, ReviewStyle all-path parity, review survival tracking (migration 008), VelocityController cross-account cooldown, ReviewVerificationWorker, TimeLocalityService, ReviewPhotoStrategy, HelpfulVoteWorker, AccountHealthScorer.
Chưa đóng: Sprint 3 integration vào engines, live QA Auto Warmup, verify OTA, Authenticode signing.

