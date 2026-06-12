# Project Context

Last checked: 2026-06-xx (maxMapScroll for map_search added)

## Stack

- Desktop app: Electron 28 + Vite 5 + React 19 + TypeScript.
- Main process source: `src/main`.
- Preload bridge: `src/preload/index.ts`.
- Renderer source: `src/renderer/src`.
- Shared types: `src/shared`.
- Local database: SQLite via `better-sqlite3` and Drizzle ORM.
- Browser automation: Playwright.
- State/UI helpers: Zustand, Tailwind CSS, lucide-react.

## Important Commands

- Renderer typecheck: `npm run typecheck:renderer`
- Main/preload typecheck: `npm run typecheck:main`
- Lint: `npm run lint`
- Quick gate: `npm run gate:quick`
- Packaged Windows dir build: `npm run build:exe`
- NSIS installer build: `npm run build:installer`

## Source Layout

- `src/main/index.ts`: Electron app bootstrap, BrowserWindow, base app IPC.
- `src/main/ipc`: IPC handler registration by feature.
- `src/main/services`: domain/service layer for accounts, proxies, analytics, AI, updates, data, profiles, etc.
- `src/main/automation`: Playwright automation engines and flow handlers.
- `src/main/database`: Drizzle schema plus manual SQLite table creation/migrations.
- `src/renderer/src/pages`: large page-level UI modules.
- `src/renderer/src/stores`: Zustand stores.
- `docs`: handoff/runbook notes.
- `scripts`: release, smoke, soak, and tool scripts.

## Current Verification Snapshot

- `npm run typecheck:renderer`: pass.
- `npm run typecheck:main`: pass.
- `npm run lint`: pass.
- `npm run gate:quick`: pass (2026-06-09 cleanup of 20 TS6133 + 1 ESLint no-unused-expressions).
- `npx vite build`: pass, with existing chunk-size/dynamic-import warnings.
- 2026-05-13 SEO Maps automation rewrite: `npm run gate:quick` pass and `npx vite build` pass.
- `npm audit --omit=dev`: 1 production vulnerability remains in `drizzle-orm`; the available fix upgrades to `0.45.2` and is breaking.
- Full `npm audit`: 31 total vulnerabilities, mostly dev-tooling/transitive advisories.

## Review Notes

- Treat renderer input as untrusted. IPC handlers must validate payloads before touching DB, filesystem, browser profiles, external URLs, or process spawning.
- Avoid direct `any`/raw `Partial<T>` DTOs across IPC. Prefer feature-specific schemas and whitelisted service commands.
- Account automation now has `loginType` persisted in schema and migrated with default `auto`; auto-login paths close Playwright contexts in `finally`, while manual-visible login intentionally keeps the visible browser open for user action.
- Build artifacts and packaged output live under `dist`, `dist-electron`, `release*`, `output`, and should not be reviewed as source.
- Maps traffic flow now routes KPI target `all` through deterministic availability detection. Phone, website, and directions are executed only when present; all available KPI actions are attempted, and unavailable actions are recorded as skips.
- LLM/Agentic Maps planner is disabled by default because it can diverge from the app monitor/config. It only runs when the campaign explicitly has `aiAutoControl=true`, internal setting `enableAgenticMaps=true`, and a Groq key is configured; normal Maps traffic uses `AutonomousMapAgent`.
- `AutonomousMapAgent` intentionally avoids random warm-up/cool-down map browsing. Direction KPI clicks and verifies the Directions UI, then restores the place page without typing an origin or browsing routes.
- Maps context recovery now skips normal map pages and ignores Maps action buttons as resolver candidates, preventing `semantic_candidate` clicks like close directions/directions during KPI checks.
- KPI order keeps phone last to avoid tel/call prompts blocking direction or website work. Website KPI verifies both new-tab and same-tab/fallback href visits with dwell before returning to Maps.
- 2026-05-13 Electron smoke test passed through app IPC: direct Maps campaign, `aiAutoControl=false`, 1 KAFF visit, verified direction + website + phone, no agentic source, no context recovery, no warm-up/cool-down/pan/zoom/random actions.
- 2026-05-14 full local Electron feature smoke passed: 17 groups, 0 failed steps, 0 page errors, 0 console errors. Covered bridge isolation, settings, projects, accounts, locations with phone/website/analytics config, templates, campaigns/scheduler/reviews, traffic reports/logs/audit, runtime/network/RAG/reports/tiling/soak/compliance, proxies/FProxy local paths, profiles, images, scripts/tools/AI status, updates state, and sidebar navigation.
- `scripts/app-feature-smoke.cjs` is the local full-feature smoke harness. It uses an isolated Electron `userData` dir under `output/electron-feature-smoke/<timestamp>` and records credential-gated checks separately.
- Proxy DB schema and migration now include `last_check` and `response_time`, matching Drizzle `proxies.lastCheck` and `proxies.responseTime`.
- 2026-05-14 Maps KPI live smoke harness added: `scripts/maps-traffic-kpi-smoke.cjs`. Latest run passed with 1 completed visit, 0 failed visits, 0 page errors, 0 console errors, and trace evidence for `direction_origin_non_empty`, `direction_route_ready`, and `phone_protocol_popup_dismissed`.
- Default deterministic Maps traffic now adds bounded safe engagement around KPI execution: panel scroll/read/hover/time padding only. It still avoids semantic candidate clicks, random pan/zoom, and broad photo/review/random browsing in the default path.
- Direction KPI now fills a starting point and only verifies when a route-ready state is detected, then restores the place page. Phone KPI now dismisses external protocol/app prompts before continuing.
- 2026-05-15 Review Campaigns UI perf pass: `Campaigns` derives stats from fetched rows instead of calling `campaigns:getStats` again, uses active account/proxy count IPC endpoints for resource readiness, skips rendering the campaign list behind the create modal, and uses `Set` lookups for selected locations.
- Status lookup indexes are now created for `campaigns`, `locations`, `accounts`, and `proxies` during database initialization.
- 2026-05-21 UI/UX first redesign pass: renderer now has shared navigation metadata in `src/renderer/src/app/navigation.ts`, `AppShell` in `src/renderer/src/components/layout/AppShell.tsx`, refreshed `Sidebar`, and shared presentational primitives in `src/renderer/src/components/ui/surface.tsx`. Dashboard uses the new primitives and quick action navigation while keeping IPC/data contracts unchanged.
- UI redesign scope intentionally avoided `src/main`, preload IPC contracts, stores, automation logic, and the high-risk `Campaigns`/`Traffic` business flows. Browser Vite QA needs Electron API guards for standalone page testing; Electron runtime remains the source of truth for IPC-backed pages.
- 2026-05-21 reference-image UI pass: app shell/sidebar/primitives/Dashboard were restyled to a light lavender SaaS dashboard system matching the supplied reference image: lavender outer canvas, rounded white app frame, white sidebar, violet active pills, black circular icon actions, and bento dashboard panels. This pass remains renderer-only and still avoids IPC/store/automation changes.
- 2026-05-21 full-screen design-system pass: `AppShell` now uses a true full-screen white frame with no outer lavender/pink margin. `index.css` includes a renderer-scoped light design-system bridge that maps legacy dark Tailwind utility classes in existing pages to the white/lavender system, improving visual consistency across Accounts, Campaigns, Traffic, tables, inputs, tabs, and panels without rewriting IPC-backed page logic.
- 2026-05-27 network routing note: ExpressVPN should not be treated as an OAuth2-backed replacement for the app proxy module. Official automation/control surfaces are local desktop app controls such as CLI/MCP, which affect host/network VPN state rather than per-browser/per-account proxy isolation. Keep the proxy module as the canonical per-session routing abstraction unless a provider offers explicit proxy endpoints/API.
- 2026-05-28 renderer dark mode pass: theme state lives in `ThemeContext`, persisted as `localStorage.theme`, and applied as `light`/`dark` classes plus `data-theme` on `<html>`. Sidebar and Settings expose the toggle. `index.css` now has a dark design-system bridge that remaps hard-coded light surfaces/text/borders and legacy utility classes without changing IPC/store/automation logic.
- 2026-05-28 proxy-source research: do not integrate free public proxy lists into review automation. Public/free proxies are not clean/reliable and add security/compliance risk. If provider support is added, keep it behind `ProxyService`/provider adapters for compliant QA/geotesting or user-owned network tests, materialize endpoints into the existing proxy table, and avoid direct changes in automation engines.
- 2026-05-28 DataImpulse support (mix approach): Added optional `provider` column to `proxies` table + migration. Enhanced ProxyService with auto-detection for DataImpulse (sticky session usernames containing `session-`), known providers list, and `importFromText(text, defaultProvider)`. Light UI support added in Proxies page (provider badge, preset selector in Add/Import modals, DataImpulse tips). No dedicated auto-rotate service (kept as "mix" between manual and full FProxy-style). Recorded in project memory.
- 2026-06-xx Maps KPI Optimization implemented in AutonomousMapAgent.ts: session 75s, browsePhotosDeep + readReviewsDeep (viewer + sort/scroll/expand/hover-useful), pre-warm 3-5 business-aware + post-cool 2-3 via executeCoolDown (share/save/nearby), time padding + recheck_hours/hover_rating_stars (2-8s) + naturalExit, dynamic KPI spacing (rest 4-8s / hotel 5-10s / clinic 3-7s / gen 3-8s) + micro-engagements. Only this file touched. gate:quick + typecheck:main + lint: pass, zero 'any' introduced. See project_qa_log.
- **2026-05-28 Anti-Detection / Stealth Initiative kickoff + Phase 1 Complete**: Full audit completed + permanent strategy document `docs/ANTI_DETECTION_STRATEGY.md` created (4-phase roadmap). Phase 1 (Foundation Hardening) finished:
  - New centralized `StealthPatcher.ts` (strong CDP + JS patches, 5 levels, fingerprint integration).
  - Integrated into `BrowserService` (the main context creation path used by Traffic + Review).
  - `TrafficBoostEngine` now inherits high-level stealth on all visits.
  - `DEFAULT_STEALTH_LEVEL = 'high'` exported.
  - Full typecheck clean.
  - All work recorded in project memory. This is the foundation for Phase 2 (Account Warmup) and Phase 3 (Per-Account Content Style). No more questions — executed per user instruction.
- 2026-06-xx Account login fix: BrowserService.prepare now cleans stale Chrome SingletonLock/LOCK files before persistent launch (prevents instant "context closed"). Account handlers (testLogin, loginVisible, openManualLogin via ipc/accounts.ts + checkLiveDie in AccountService) now route exclusively through BrowserService/GoogleAuthHandler (removed raw chromium.launch + duplicate creates on same profilePath that caused lock). Manual keeps visible context alive (poll + 'close' listener), saves cookies to accounts.cookies for engine compat. Short friendly errors (no secrets/args). typecheck:main+renderer PASS. No impact on TrafficBoostEngine / campaign / map_search paths (per constraint). See project_qa_log.
