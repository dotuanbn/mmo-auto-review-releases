# Warmup Engine (L3)

Phase 2 anti-detection: già hóa tài khoản Google bằng session an toàn, lịch ngầm, và ramp 7 ngày. Review gate chỉ siết khi `settings.enforceAccountWarmup === true`.

## Thành phần

| Module | Vai trò |
|--------|---------|
| `WarmupSchedulerService` | Vòng ngầm scan + queue |
| `AccountWarmupEngine` | Playwright session (persistent profile) |
| `AccountWarmupService` | Level, reputation, cooldown, daily cap, review gate |
| `BirthStoryService` | Kế hoạch 7 ngày theo lịch local |
| IPC `warmup:*` | getStatus / getAllStatuses / start / cancel |
| UI Accounts | Toggle **Auto Warmup** (`autoWarmupEnabled`), badge Day n/7 |

Constant SSOT: `READY_MIN_LEVEL = 55` (`AccountWarmupService`) = `WARMUP_READY_MIN_LEVEL` (renderer) = `BIRTH_STORY_COMPLETE_LEVEL`.

## Auto Warmup scheduler

Boot: delay 5s rồi tick; interval **5 phút**. `start()` từ `src/main/index.ts` cùng Scheduler; `stop()` khi window-all-closed.

Mỗi tick (crash-safe, skip nếu tick trước chưa xong):

1. Nếu `accountWarmupEngine.getRunningIds().size >= 2` → return (`MAX_CONCURRENT_WARMUPS=2`).
2. Load account `status=active` AND `autoWarmupEnabled=true` AND (`nextWarmupAt` null hoặc < now).
3. Per-account: `evaluateStartEligibility` (cooldown + daily cap) → nếu birth story chưa xong, `birthStoryService.applyPlan` chọn type/duration → `accountWarmupEngine.start`.
4. Lỗi một account không abort scan. Reservation in-memory; crash = mất reservation, engine re-reserve lần start sau.

Daily cap: **3 session / ngày local** (`MAX_DAILY_WARMUP_SESSIONS`). Cooldown `nextWarmupAt` theo level (xem dưới).

## Engine session

Types: `google_search` | `maps_browse` | `youtube_browse` | `gmail` | `photos_browse`. Duration clamp 45–300s (default 90; birth-story day 1 min 180s). Off-hours rút duration (`CaptchaAvoidancePolicy.evaluateTimeOfDay`).

P0:

- `start(account)` atomic: reservation + generation token (không TOCTOU).
- Cancel re-check trước `completeSession`; `shouldCommit = () => registry.isLive(session)`.
- Credit **chỉ** khi `BrowserService.isGoogleLoggedIn` + generation còn live.
- Persistent context + `HumanBehavior`; luôn `closeContext` trong `finally`.
- Pre-activity: scroll nông, optional tab switch, dwell bounded.

## Gmail & Photos executors

| Executor | URL | Boost | Safe actions (không compose/upload/delete/share) |
|----------|-----|-------|--------------------------------------------------|
| `runGmailBrowse` | `https://mail.google.com` | **8** | `read_newsletter`, `archive_promotions`, `star_important` |
| `runPhotosBrowse` | `https://photos.google.com` | **4** | `scroll_timeline`, `view_album`, `favorite_photo` |

Boost khác: maps_browse=7, youtube=6, search=5, default=3. `reputationScore += floor(boost * 3)`. History JSON, giữ 50 mục.

Gmail: chờ inbox (`tr.zA` / `div[role=main]`), scroll, reading simulation, 1 action nếu còn ≥8s deadline, `goBack`. Photos: chờ grid (`div[data-media-key]`), tương tự.

## 7-Day Birth Story

Migration **006**: `birth_story_day`, `birth_story_start_date`, `birth_story_completed`, `auto_warmup_enabled` + index `(auto_warmup_enabled, status)`.

Ngày = calendar local từ `birthStoryStartDate` (start = day 1), không phải wall-clock 24h tuyệt đối.

| Day | Activity | Duration |
|-----|----------|----------|
| 1 | `search` | 180s |
| 2 | `youtube` | 210s |
| 3 | `maps` | 210s |
| 4 | `photos_browse` | 240s |
| 5 | `gmail` | 240s |
| 6 | `maps` | 270s |
| 7 | `gmail` | 300s |

`applyPlan`: init start date nếu trống; persist day; **complete** khi `warmupLevel >= 55` **hoặc** day > 7. Scheduler chỉ inject type khi `!birthStoryCompleted`. UI badge Day n/7 khi day>0 và chưa complete.

## Reputation & review gate

`evaluateReviewGate(level, enforce)`:

| Level | Tier | Review |
|-------|------|--------|
| `< 25` | `blocked` | `allowed=false`, `maxPendingJobs=0` |
| `25–54` | `throttled` | `allowed=true`, `maxPendingJobs=1` |
| `≥ 55` (`READY_MIN_LEVEL`) | `full` | unlimited (`maxPendingJobs=null`) |

`enforce=false` → luôn `full` (legacy). Gate fail-closed nếu không đọc được warmup data.

Cooldown sau session (`computeNextWarmupAt`, + jitter 0–1h):

| Level | Hours |
|-------|-------|
| `< 25` | 4 |
| `25–54` | 8 |
| `≥ 55` | 16 |

`isReady` / renderer readiness = `warmupLevel >= 55`. Real review: `reputationScore += 5`.

Related: `WarmupSchedulerService.ts`, `AccountWarmupEngine.ts`, `AccountWarmupService.ts`, `BirthStoryService.ts`, `database/migrations/006_birth_story_scheduler.ts`, `shared/warmup-contracts.ts`, `tests/unit/WarmupSchedulerService.test.ts`, `tests/unit/BirthStoryService.test.ts`, `tests/AccountWarmupEngine.test.ts`, `tests/RuntimeWarmupGate.test.ts`.
