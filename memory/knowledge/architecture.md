# Architecture (L3)

Electron desktop app tự động review / traffic Google Maps. Main process sở hữu DB, secrets, Playwright; renderer chỉ UI + IPC.

## Process topology

```
Renderer (React 19, Vite 5, Zustand)
    ↕ contextBridge (preload, no nodeIntegration)
Main (Electron 28)
    ├─ ipc/*          Zod-validated handlers
    ├─ services/*     domain (accounts, proxy, warmup, FProxy, secrets)
    ├─ automation/*   Playwright engines (review, traffic, warmup)
    ├─ database/      better-sqlite3 + Drizzle, versioned migrations
    ├─ runtime/v2     network orchestrator + policy
    └─ workers/       HF inference (separate)
```

- `src/main` — Node/Electron; `src/preload` — `contextBridge` whitelist; `src/renderer/src` — pages (Dashboard, Accounts, Traffic, Campaigns, Settings, …); `src/shared` — Zod contracts/DTOs dùng chung.
- Window: `nodeIntegration: false`, `contextIsolation: true`, `backgroundThrottling: false`. Single-instance lock. Hardware acceleration disabled (Windows occlude/repaint).
- Boot (`src/main/index.ts`): DataRoot → `initDatabase` → register IPC → create window → wire `SchedulerService` + start `WarmupSchedulerService`.

## IPC

- Registry: `src/main/ipc/index.ts` → `registerAllHandlers()`.
- Mọi payload parse qua Zod (`src/shared/ipc-schemas.ts` + per-domain `*-contracts.ts`). Wrapper: `parseIpcPayload` / `parseIpcArgs` / `withIpcValidation` (`ipc/validate.ts`).
- Path/URL fail-closed: profile paths phải là con của profile root; HTTP(S) only cho URL ngoài.
- Public DTO **không** lộ secrets: password/TOTP/API key → `********` hoặc `hasSecret: boolean`. Renderer không set `profilePath` trực tiếp.
- Warmup channels: `warmup:getStatus`, `warmup:getAllStatuses`, `warmup:start`, `warmup:cancel`.

## Database

- Engine: `better-sqlite3` + Drizzle. File: `{userData}/data/mmo-review.db`. WAL + `busy_timeout=5000`.
- Init fail-closed (`database/index.ts`): re-entrancy guard → open → pragmas → `PRAGMA integrity_check` → snapshot pre-migrate (max 3) → legacy + versioned migrations → default settings → **mới publish singleton**. Lỗi → close handle, cho retry sạch.
- Migrations (không renumber):
  1. accounts warmup/style
  2. web SEO quality
  3. captcha metrics
  4. operations durability (JobQueue + traffic visit queue)
  5. FProxy pool (`fproxy_keys`)
  6. birth story + `auto_warmup_enabled`
- Bảng chính: `accounts`, `proxies`, `fproxy_keys`, `locations`, `campaigns` / `traffic_campaigns`, `traffic_logs`, `traffic_visit_queue`, `job_queue`, `review_history`, `settings`. Runtime FProxy lease **không** persist.

## Encryption (SecretVault)

- Format: `enc:v1:<base64(safeStorage.encryptString)>`. OS keychain qua Electron `safeStorage`.
- Seal: account password, TOTP, proxy password, FProxy API keys, settings API keys.
- Write fail-closed nếu encryption unavailable. Legacy plaintext migrate lazy on read. Decrypt fail (máy khác) → `''`.
- Public snapshots / IPC / logs **cấm** raw keys. Không ghi secrets vào `memory/`, docs, CHANGELOG.

## Browser lifecycle (`BrowserService`)

Hai loại context, tracked riêng:

| | Persistent | Ephemeral |
|--|------------|-----------|
| Dùng cho | Login, warmup, review (profile ổ đĩa) | Traffic Maps multi-IP (in-memory) |
| Lock | `ProfileLockService` exclusive trước launch | Không lock profile |
| Proxy | `ProxyBridgeService` (proxy-chain anonymize, refcount) | Cùng bridge; share theo key |

- Dispose **idempotent**: xóa maps → release profile lock → `proxyBridgeService.release`. Shared-browser disconnect **chỉ** dọn ephemeral; persistent lock/bridge giữ nguyên.
- Close order khi traffic/automation: **BrowserContext close trước**, rồi FProxy lease `release`. Rotate-per-visit: lease cuối cùng trên slot mới set `rotationPending`.
- Fingerprint: `FingerprintService` SSOT (UA / Client Hints / WebGL). Stealth một patch path (`StealthPatcher`), không marker `__mmor_*`.
- `JobQueue.claimNextJob` atomic pending→running, persist trước return. Done/cancelled immutable. Boot recovery chỉ requeue job `running` bị cắt.

## Engines (tóm tắt)

- **Review**: `AutomationController` + `ReviewAutomationEngine` / Agentic handlers. Intent `review_history` status `submitting` trước submit; success / `unconfirmed` (không auto-repost).
- **Traffic**: `TrafficBoostEngine` + durable `TrafficVisitQueue` — xem `traffic-concurrency.md`.
- **Warmup**: `AccountWarmupEngine` + `WarmupSchedulerService` + `BirthStoryService` — xem `warmup-engine.md`.
- **Scheduler**: due schedule gọi start/resume qua injected automation port; timestamp chỉ advance khi controller nhận start.

## Release

- `asar: false` cho native `better-sqlite3` / HF workers. electron-builder NSIS + portable; OTA chỉ NSIS (`electron-updater`, GitHub Releases). Portable/dev updater disabled. Campaign đang chạy → download OK, install deferred.
- Gate: `npm run typecheck` + tests; packaged smoke unpacked + NSIS với data-root temp-only.

Related: `src/main/index.ts`, `ipc/`, `database/`, `services/SecretVault.ts`, `automation/BrowserService.ts`, `services/ProxyBridgeService.ts`, `services/ProfileLockService.ts`.
