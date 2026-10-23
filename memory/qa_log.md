# QA Log

## 2026-10-07 [release] [testing] [laya]

Q: Có thể đóng gói Laya vào bản Windows để khách thử nghiệm chỉ cập nhật/cài app mà không cài Python hay Laya riêng không?

A: Có cho kênh pilot unsigned. `resources/laya-sidecar` được đưa vào `build.win.extraResources`; app tự khởi động sidecar local trên loopback và model chạy offline. `npm run release:unsigned` đã build installer, sidecar smoke, unpacked smoke và silent NSIS smoke. Kết quả: sidecar inference pass; app packaged 24/24 ở cả unpacked và NSIS; 915/915 unit tests pass; không có page/console errors. Installer archive `release-history/v1.0.16-r2`, SHA-256 `8aedb209cd535a9444b87b2e712180de64a99168eb479761706dda77cd0f934b`. Artifact chưa ký Authenticode, nên Windows có thể yêu cầu `More info -> Run anyway`; chưa được publish OTA đại trà và chưa có clean VM/customer smoke.

## 2026-07-13 [architecture] [security] [testing] [ui] [deploy]

Q: Sau Reliability/Security/Warmup/Review Style/Photo/Operations, dự án cần phát triển gì và các P0 nào phải đóng trước?

A: Đã triển khai production hardening gồm warmup race/auth/credit, review intent chống double-post, Agentic opt-in và positive verification, atomic durable queue, Browser/Profile/Proxy lifecycle, Scheduler thực thi thật, Settings/API secret vault, database integrity/snapshot, recovery banner và IPC/path validation. Kiểm tra cuối: `npm run gate:quick` pass; `npm run test:run` pass 516/516; `npx vite build` pass; Electron feature smoke pass 17/17, 0 page errors, 0 console errors tại `output/electron-feature-smoke/2026-07-13T18-12-09-338Z`.

Next: packaged binary/NSIS smoke + CI release gate, manual reconciliation cho intent unconfirmed, backup/restore, compliance audit trail, JobQueue persist rollback parity, Traffic durability/counting.

## 2026-07-14 [architecture] [security] [testing] [ui] [performance]

Q: Lam sao de luong SEO website hoat dong muot, thong minh va do luong trung thuc?

A: Da tach discovery organic/direct/captcha, them `requireOrganic`, URL/path fail-closed, same-site safe action policy, dwell rieng, numeric quality/countable persistence, account concurrency guard, Web SEO presets/ETA/pause UX va migration v2. Verification: `gate:quick` pass; 558/558 tests pass; Vite build pass; Electron smoke 18/18, 0 page errors, 0 console errors tai `output/electron-feature-smoke/2026-07-14T09-33-28-081Z`. Live Google/CAPTCHA/proxy van la credential-gated smoke, khong chay trong CI.

[2026-07-14] [architecture] Q: Worker5 audit P0/P1 stealth fixes applied?
A: Yes. FingerprintService: NT 11.0->10.0, OS-split WebGL, generateForUserAgent, getRandomUserAgent SSOT. BrowserService: removed applyStealthScripts double-inject; fingerprint syncs with config.userAgent; getRandomUserAgent delegates to FingerprintService. StealthPatcher: window.chrome, CDP userAgentMetadata, removed __mmor_* markers, no CDP permission grant conflict, fixed fullVersionList for Not_A Brand. tsc clean; captcha unit 59 pass.

## 2026-07-14 [architecture] [security] [testing] [ui] [performance]

Q: Đã hoàn tất các hạng mục trong captcha_bypass_research.md như thế nào?

A: Đã thêm bounded Google throttle, adaptive delay/session warming, image-grid solver CapSolver/2Captcha fail-closed, verification sau click/token, metrics SQLite v3 + IPC/preload + Settings dashboard, và smoke coverage. Stealth dùng một patch path, UA/Client Hints/WebGL đồng bộ theo OS; không tuyên bố spoof TLS/JA3 vì Chromium/Electron hiện tại không hỗ trợ an toàn nếu không đổi browser/proxy stack. Verification: `gate:quick` pass; 664/664 tests pass; electron-builder NSIS + portable pass; Electron feature smoke 19/19, 0 page errors, 0 console errors tại `output/electron-feature-smoke/2026-07-14T16-08-38-100Z`.

## 2026-07-15 [architecture] [security] [testing] [ui] [deploy]

Q: How were release hardening, durable operations, reconciliation, backup/restore, and compliance audit completed?

A: Added reusable release quality gates; packaged unpacked/NSIS smoke with temp-only data-root override before runtime imports; atomic review-intent reconciliation; durable Traffic visit queue and JobQueue persist rollback; user-facing backup/restore with RESTORE confirmation, checksum/SQLite/symlink guards and pre-restore snapshot; exact-count compliance audit pagination. Verification: `npm run gate:quick` pass; `npm run test:run` pass 845/845; source, win-unpacked, and silent NSIS smoke each pass 23/23 with 0 page/console errors; NSIS and portable builds pass. Live credential-gated Google/proxy/provider flows remain outside deterministic smoke.

## 2026-07-20 [deploy] [testing] [config]

Q: CI Windows packaged smoke fails on v1.0.9 and v1.0.10 with "Smoke userData must be under the OS temp mmo-packaged-smoke root" — what was the root cause and fix?

A: GitHub Actions Windows runners return `tmpdir()` as 8.3 short path (`RUNNER~1`) or with mismatched drive letter casing (`c:` vs `C:`). `path.relative()` treats different casing as different drives, breaking the safety check. Fix in `DataRootService.resolveSmokeDataRootOverride`: use `realpathSync` for both tempPath and requested path, normalize to lowercase + forward slashes, replace `relative()` with `startsWith` comparison. v1.0.9 failed → v1.0.10 failed (same root cause, realpathSync alone insufficient) → v1.0.11 passed all CI steps (quality gate, Windows unpacked+NSIS smoke, macOS build, artifact upload). Local NSIS build also confirmed working. Released via: master commit → push → merge to main → tag v1.0.11 on main → CI publish to GitHub Releases.


## 2026-07-24 [architecture] [testing] [ui] [api]

Q: Can the app run many concurrent map/thread workers with multiple rotating FProxy.me keys and keep unique IPs?

A: Yes with the multi-key FProxy pool. Add N API keys as slots in Settings > FProxy Pool, enable Use Proxy, keep Strict unique IP + Rotate per visit. Capacity for simultaneous unique IPs equals enabled healthy slots (3 keys => up to 3 concurrent unique IPs). Extra threads wait for a free slot. Traffic and Automation acquire/release leases around browser contexts; no shared IP in strict mode. Verification: unit tests 15/15 for concurrency/security/contracts; typecheck main+renderer pass; lint pass; live concurrent getcurrent for 3 keys returned 3 unique IPs; getnew returns ~120s waiting_time cooldown. Electron UI QA with the 3 real keys still pending. Secrets are not stored in docs/memory/logs.

## 2026-07-24 [config] [ui]
Q: Settings save fails when toggling headless (Chế độ chạy ngầm).
A: Root cause: packaged UI sent full settings including legacy disk extras (googleOAuth*, geminiApiKey) into settings:saveAll, rejected by settingsPatchSchema.strict(). Fixed renderer whitelist-only patch + main strip-unknown-before-parse; runtime updatePolicy best-effort. Rebuilt win-unpacked 2026-07-24 11:10. Typecheck main+renderer pass; settings tests 84/84 pass.

## 2026-07-24 [automation] [testing]
Q: Automation misclick/stop/close before KPI.
A: Hardened safe thread status, place-aware recovery, safer KPI clicks, FProxy/browser crash requeue. typecheck main pass; traffic tests 46/46; win-unpacked 11:37.


## 2026-07-24 [automation] [testing]
Q: Campaign 24/7/2026 11:55 directions still buggy.
A: Root cause: after Directions click Maps often lands bare /maps/@lat,lng viewport; recovery treated it as on-target so phone/website KPIs failed. Fixed place-action visibility gate, preflight navigate to place URL, stronger post-direction restore, reject bare viewport. Tests 4/4; typecheck main pass; rebuilt win-unpacked 12:03.

[2026-07-24] [performance] [ui]
Q: 1 map + 2 threads + 2 visits only ran serially; Aeon first-visit directions wrong then OK on second visit.
A: Root cause serial = account/profile exclusivity lock when same account selected. Fix maps multi-IP path to ephemeral contexts + skip lock; seed accounts by visitIndex. Directions: warm-up skip deep photos, ensure place restore before KPI, stronger directions preflight. Packaged win-unpacked 12:30.

[2026-07-24] [performance] [proxy]
Q: Align thread visit timing with FProxy rotating IP window (~2 min).
A: Wait for rotateAllowedAt/cooldown before visit; acquire outside watchdog; cap visit soft/hard budget to lease time_die; compact warm-up/KPI session; packaged 13:00.

## 2026-07-24 [proxy] [ui] [performance]
Q: App countdown still wrong after classic sync restore; UI shows Xoay IP ~29 minutes though FProxy rotates every 2 minutes.
A: Root cause: FProxy returns two timers. `waiting_time` is rotate countdown (~2 min). `time_die` is IP/endpoint remaining life (~30 min). User dashboard shows both (e.g. 29:51 IP left + Rotate 1:51). App currently maps/labels poorly so both UI rows can show ~29 min; visit budget must also cap by rotate window, not time_die. Next fix: force Xoay IP = waiting_time/nextRotateAt/cooldown, IP con = time_die/ipExpiresAt; recheck leased slots; rebuild win-unpacked; live QA vs https://sv1.fproxy.me/. Secrets not stored in docs/memory/logs.

## 2026-07-24 [proxy] [ui] [performance]
Q: Fixed dual-timer bug after live API probe — why did UI show ~29 min rotate?
A: Live FProxy getcurrent returns waiting_time == time_die (~1781s). getnew returns real waiting_time (~120s) and time_die (~1800s). App previously treated waiting_time literally, so Xoay IP showed ~29 min. Fix: resolveFProxyDeadlines() sanitizes mirrored waiting_time; fetchInitialEndpoint prefers getnew; UI caps rotate display >5 min as ready; visit budget uses rotate window (~2 min) not IP life. Packaged win-unpacked 15:58. Tests: dual-timer 5/5 + pool 17/17 pass. No secrets in docs/memory.

## 2026-10-21 [proxy] [automation] [release]
Q: Tại sao khi visit chạy xong KPI sớm thì app lại mở luôn visit mới mà không chờ FProxy xoay sang IP mới trên sv1.fproxy.me, và làm sao để đảm bảo đúng quy luật 1 Key = 1 Browser = 1 Visit / 1 IP khi chạy 1 hoặc nhiều Key?
A: Có 3 nguyên nhân gốc trong code cũ:
1) `FProxyRuntimePoolPanel` gọi `refreshAll()` ngầm mỗi 30s (`getCurrent`), trong đó `resolveFProxyDeadlines()` sanitize `waiting_time == time_die` thành `rotateAllowedAt = Date.now()`. Khi key vừa đóng browser sau Visit 1 và đang ở trạng thái `cooldown` (`runtime.lease === null`), `refreshSlot()` gọi `acceptEndpoint()` ghi đè `rotateAllowedAt` về `Date.now()`, làm mất bộ đếm chờ xoay IP.
2) Khi gọi `getnew` sớm lúc server chưa hết cooldown, FProxy trả về `"Vui lòng chờ X giây"` kèm lại chính IP cũ và `time_die ~ 1745s` (không có trường `data.ip` riêng, IP nằm ở `httpuserpass` host). Code cũ chỉ kiểm tra `endpointExpiresAt - now >= minRemaining` nên nhận luôn IP cũ cho Visit 2.
3) Multi-map từng cho phép 1 key chia sẻ nhiều lease song song (`canShareSlot`) và `drainWaiters()` chỉ kiểm tra `this.waiters[0]` gây head-of-line blocking khi chạy nhiều key.
Fix (v1.0.18):
- Bắt buộc `1 Key = 1 Browser = 1 Visit / 1 IP`: gỡ bỏ multi-location slot sharing, clamp `safeThreadCount <= enabledPoolSlotCount`, ghim mỗi luồng `threadIdx` vào `assignedSlotId` riêng, và sửa `drainWaiters()` duyệt độc lập từng waiter.
- Lưu `lastUsedIp` cho mỗi slot; nếu `getnew` trả về IP trùng `lastUsedIp`, hoặc có cờ `coolingDown` (`"Vui lòng chờ X giây"`), hoặc báo `"WAITING"`, slot cập nhật lại `rotateAllowedAt` và tiếp tục chờ ở trạng thái `cooldown` (browser vẫn đóng) cho tới khi nhận được IP mới thực sự.
- Sửa `refreshSlot()` không bao giờ ghi đè `rotateAllowedAt` hay xóa `rotationPending` khi slot đang `cooldown`.
- Đã cập nhật `release/win-unpacked/MMO Auto Review.exe` và publish OTA `v1.0.18` lên `dotuanbn/mmo-auto-review-releases` (68 test files / 1031 tests pass).

## 2026-10-23 [performance] [concurrency] [local-only]
Q: Bật tiết kiệm tài nguyên nhưng giữ nguyên số luồng trình duyệt/map song song và không hoãn lượt mới?
A: Đã bỏ cap một phiên, RAM admission wait, launch spacing và giảm luồng/nhường lượt do low-resource mode trong Traffic, Automation và worker nền. Giữ cấu hình người dùng, proxy/IP, khóa profile và lịch nghiệp vụ. Giữ tối ưu UI/log, viewport, AI nhàn rỗi và thu hồi Chrome thực sự không còn người dùng.
Verification: typecheck main/renderer, lint, Vite build đạt; 71 test files / 1065 pass + 1 POSIX skip; packaged smoke 25/25; 153 vòng Chrome thật với 3 context song song, 7/7 gates đạt. Báo cáo: output/performance-parallel-unit-20261023.json và output/performance-soak/2026-10-23T01-40-04-624Z/result.json. Một lần Chrome thoát khi khởi động chưa tái hiện/nguyên nhân chưa rõ, giữ báo cáo lỗi riêng. Đây là thử ngắn trên i7/16GB với RAM tiêm/CPU CDP, chưa chứng minh i3 chạy cả ngày.
Artifact: output/performance-parallel-20261023/MMO-Auto-Review-Setup-1.0.18.exe (NotSigned, local only, chưa cài/nâng cấp hoặc OTA). Xem memory/sessions/2026-10-23-low-resource-parallel.md.

## 2026-10-23 [release] [updater] [unsigned]
Q: Đưa bản tối ưu giữ nguyên song song lên GitHub để khách cập nhật?
A: Published v1.0.19 Latest at 03:32:45Z, tag/source 05b21d8c0dbd1034c6fc6ce7e6d75a3adbf08854. Signed CI requirements and updater checks unchanged; this manual unsigned release is explicitly owner-authorized. Setup 1043199338 bytes, SHA256 e7dc95a41b2c98e951d0c56836557445bfe271e6a2eb734caff00f3b5855d576; all 5 public asset digests matched. Existing v1.0.18 assets preserved.
Fresh QA: Linux GitHub Quality 39895077017 passed 1070 tests / 72 files; Windows 1069 + 1 POSIX skip; typecheck/lint/build passed. Unpacked and upgraded-installed smoke each passed 25/25, no page/console errors; offline Laya passed. Fixed the legacy NSIS unsafe shell-path copy and same-millisecond cooldown regression discovered during QA.
Upgrade: original v1.0.18 client downloaded the exact setup via real IPC, NSIS upgrade returned 0, fixture settings/marker preserved. Post-publication v1.0.18 client with fresh isolated cache/userData and GitHub token variables removed detected/downloaded v1.0.19 from the real GitHub feed; SHA256 matched. Reports: output/ota-smoke/ota-v1.0.19-final/{local,upgraded}/result.json and output/ota-smoke/ota-v1.0.19-github/github/result.json.
Limits: full-download fallback was exercised, not a claim of differential transport success; original v1.0.18 fresh-install bootstrap still has the upstream crash, while new NSIS installation/upgrade passed. No real-account or all-day i3/8GB acceptance claim. Tag build 39895584230 was intentionally cancelled before packaging to prevent duplicate uploads; separate source Quality was green.
