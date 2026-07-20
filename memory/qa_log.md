# QA Log

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
