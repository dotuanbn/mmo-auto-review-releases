/**
 * AccountWarmupEngine — bounded safe Google activity sessions for account aging.
 *
 * Session types: google_search | maps_browse | youtube_browse
 * Uses account persistent profile via BrowserService + HumanBehavior.
 * Always closes Playwright context in finally. Supports per-account cancel.
 *
 * P0 guarantees:
 *  - start(account) is atomic via reservation + generation token (no TOCTOU).
 *  - cancel is re-checked immediately before completeSession; stale gen never credits.
 *  - completeSession receives shouldCommit=() => registry.isLive(session) so cancel
 *    during the service's getWarmupData await still aborts credit before DB update.
 *  - credit only when BrowserService.isGoogleLoggedIn confirms Google login.
 *  - nextWarmupAt cooldown + daily local-date cap enforced at start.
 */

import type { Page } from 'playwright'
import { browserService } from './BrowserService'
import { HumanBehavior } from './HumanBehavior'
import { accountService } from '../services/AccountService'
import { profileService } from '../services/ProfileService'
import {
    accountWarmupService,
    type AccountWarmupStatus,
    type WarmupSessionType,
} from '../services/AccountWarmupService'
import { loadSettings } from '../ipc/settings'
import type { WarmupActionErrorCode } from '../../shared/warmup-contracts'
import {
    boundedWaitExact,
    buildSessionWarmupPlan,
    evaluateTimeOfDay,
    type SessionWarmupPlan,
} from './CaptchaAvoidancePolicy'

export interface WarmupStartOptions {
    activityType?: WarmupSessionType | 'search' | 'maps' | 'youtube'
    durationSeconds?: number
}

export interface WarmupActionResult {
    success: boolean
    message?: string
    code?: WarmupActionErrorCode
    status?: AccountWarmupStatus
}

/** In-flight session with generation token for stale/cancel safety. */
export interface RunningSession {
    accountId: number
    /** Monotonic generation; completeSession only credits matching live token. */
    generation: number
    cancelled: boolean
    contextId: number | null
    activityType: WarmupSessionType
    startedAt: number
}

const DEFAULT_DURATION_SEC = 90
const MIN_DURATION_SEC = 45
const MAX_DURATION_SEC = 300

const SAFE_SEARCH_QUERIES = [
    'thoi tiet ha noi hom nay',
    'cach nau pho bo',
    'tin tuc cong nghe 2026',
    'dia diem du lich da lat',
    'cong thuc mon an viet nam',
    'ban do giao thong tphcm',
    'lich su viet nam tom tat',
]

const SAFE_MAPS_QUERIES = [
    'quan cafe ha noi',
    'nha hang gan day',
    'sieu thi mini',
    'cong vien thanh pho',
    'benh vien da khoa',
]

const SAFE_YOUTUBE_QUERIES = [
    'nhac chill viet',
    'travel vlog vietnam',
    'cooking vietnamese food',
    'nature documentary short',
]

function normalizeSessionType(
    raw: WarmupStartOptions['activityType'] | undefined,
): WarmupSessionType {
    switch (raw) {
        case 'maps':
        case 'maps_browse':
            return 'maps_browse'
        case 'youtube':
        case 'youtube_browse':
            return 'youtube_browse'
        case 'search':
        case 'google_search':
            return 'google_search'
        default:
            return pickRandomSessionType()
    }
}

function pickRandomSessionType(): WarmupSessionType {
    const types: WarmupSessionType[] = ['google_search', 'maps_browse', 'youtube_browse']
    return types[Math.floor(Math.random() * types.length)]
}

function clampDuration(seconds: number | undefined): number {
    const n = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.floor(seconds) : DEFAULT_DURATION_SEC
    return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, n))
}

function pickOne(list: string[]): string {
    return list[Math.floor(Math.random() * list.length)]
}

/**
 * Sync in-memory session registry.
 * Exported for unit tests (atomic reserve / generation / cancel).
 */
export class WarmupSessionRegistry {
    private sessions = new Map<number, RunningSession>()
    private generationSeq = 0

    isRunning(accountId: number): boolean {
        return this.sessions.has(accountId)
    }

    get(accountId: number): RunningSession | undefined {
        return this.sessions.get(accountId)
    }

    getRunningIds(): ReadonlySet<number> {
        return new Set(this.sessions.keys())
    }

    /**
     * Atomic check-and-set reservation (sync, no await gaps).
     * Returns null if account already has a live session.
     */
    tryReserve(accountId: number, activityType: WarmupSessionType): RunningSession | null {
        if (this.sessions.has(accountId)) return null
        this.generationSeq += 1
        const session: RunningSession = {
            accountId,
            generation: this.generationSeq,
            cancelled: false,
            contextId: null,
            activityType,
            startedAt: Date.now(),
        }
        this.sessions.set(accountId, session)
        return session
    }

    /** Release only if the same object/generation is still mapped. */
    releaseIfSame(session: RunningSession): boolean {
        const current = this.sessions.get(session.accountId)
        if (current !== session) return false
        if (current.generation !== session.generation) return false
        this.sessions.delete(session.accountId)
        return true
    }

    /**
     * Live = same map entry, same generation, not cancelled.
     * Used before credit to block cancelled / stale generation paths.
     */
    isLive(session: RunningSession): boolean {
        const current = this.sessions.get(session.accountId)
        if (!current) return false
        if (current !== session) return false
        if (current.generation !== session.generation) return false
        if (session.cancelled || current.cancelled) return false
        return true
    }

    markCancelled(accountId: number): RunningSession | undefined {
        const session = this.sessions.get(accountId)
        if (!session) return undefined
        session.cancelled = true
        return session
    }
}

class AccountWarmupEngine {
    /** @internal registry — exposed for tests via getRegistry() */
    private readonly registry = new WarmupSessionRegistry()

    /** Test hook: access the session registry without breaking encapsulation for prod. */
    getRegistry(): WarmupSessionRegistry {
        return this.registry
    }

    isRunning(accountId: number): boolean {
        return this.registry.isRunning(accountId)
    }

    getRunningIds(): ReadonlySet<number> {
        return this.registry.getRunningIds()
    }

    async getStatus(accountId: number): Promise<AccountWarmupStatus> {
        return accountWarmupService.getStatus(accountId, this.isRunning(accountId))
    }

    async getAllStatuses(): Promise<AccountWarmupStatus[]> {
        return accountWarmupService.getAllStatuses(this.getRunningIds())
    }

    async cancel(accountId: number): Promise<WarmupActionResult> {
        const session = this.registry.markCancelled(accountId)
        if (!session) {
            return {
                success: true,
                message: 'No running warmup session',
                status: await this.getStatus(accountId),
            }
        }

        console.log(
            `[AccountWarmup] cancel requested account=${accountId} generation=${session.generation}`
        )

        if (session.contextId != null) {
            try {
                await browserService.closeContext(session.contextId)
            } catch {
                // context may already be closing
            }
            session.contextId = null
        }

        return {
            success: true,
            message: 'Warmup cancel signalled',
            status: await this.getStatus(accountId),
        }
    }

    async start(accountId: number, options: WarmupStartOptions = {}): Promise<WarmupActionResult> {
        const activityType = normalizeSessionType(options.activityType)
        const durationSeconds = clampDuration(options.durationSeconds)

        // 1) Atomic reservation FIRST — no await before Map write (kills TOCTOU).
        const session = this.registry.tryReserve(accountId, activityType)
        if (!session) {
            return {
                success: false,
                message: 'Warmup already running for this account',
                code: 'already_running',
                status: await this.getStatus(accountId),
            }
        }

        try {
            const account = await accountService.getById(accountId)
            if (!account) {
                this.registry.releaseIfSame(session)
                return {
                    success: false,
                    message: `Account not found: ${accountId}`,
                    code: 'account_not_found',
                }
            }

            // 2) Cooldown + daily cap (local date) before fire-and-forget run.
            const eligibility = await accountWarmupService.getStartEligibility(accountId)
            if (!eligibility.allowed) {
                this.registry.releaseIfSame(session)
                return {
                    success: false,
                    message: eligibility.message,
                    code: eligibility.code,
                    status: await this.getStatus(accountId),
                }
            }

            // 3) Fire-and-forget; IPC returns immediately with running status.
            void this.runSession(account, session, durationSeconds).catch((error: unknown) => {
                const msg = error instanceof Error ? error.message : String(error)
                console.error(
                    `[AccountWarmup] unhandled session error account=${accountId} ` +
                    `generation=${session.generation}: ${msg}`
                )
            })

            return {
                success: true,
                message: `Warmup started (${activityType}, ~${durationSeconds}s)`,
                status: await this.getStatus(accountId),
            }
        } catch (error: unknown) {
            // Cleanup reservation on any pre-run failure.
            this.registry.releaseIfSame(session)
            const msg = error instanceof Error ? error.message : String(error)
            console.error(`[AccountWarmup] start failed account=${accountId}: ${msg}`)
            return {
                success: false,
                message: msg,
                status: await this.getStatus(accountId).catch(() => undefined),
            }
        }
    }

    private async runSession(
        account: { id: number; email: string; profilePath?: string | null },
        session: RunningSession,
        durationSeconds: number,
    ): Promise<void> {
        const accountId = account.id
        let contextId: number | null = null
        const startedMs = Date.now()

        try {
            console.log(
                `[AccountWarmup] start account=${accountId} generation=${session.generation} ` +
                `email=${account.email} type=${session.activityType} duration=${durationSeconds}s`
            )

            if (!this.registry.isLive(session)) {
                console.log(`[AccountWarmup] aborted before browser account=${accountId} (cancelled/stale)`)
                return
            }

            const profilePath =
                account.profilePath ||
                (await profileService.createProfile(accountId, account.email))

            const settings = loadSettings()
            const headless = settings.headless === true

            contextId = await browserService.createContext({
                headless,
                profilePath,
                saveProfiles: true,
            })
            session.contextId = contextId

            if (!this.registry.isLive(session)) {
                throw new Error('Cancelled before navigation')
            }

            const page = browserService.getPage(contextId)
            if (!page) {
                throw new Error('No page available for warmup context')
            }

            await this.executeActivity(page, session, durationSeconds)

            await this.tryCreditSession(accountId, session, contextId, startedMs)
        } catch (error: unknown) {
            if (session.cancelled || !this.registry.isLive(session)) {
                console.log(
                    `[AccountWarmup] cancelled mid-session account=${accountId} ` +
                    `generation=${session.generation}`
                )
            } else {
                const msg = error instanceof Error ? error.message : String(error)
                console.error(
                    `[AccountWarmup] failed account=${accountId} generation=${session.generation}: ${msg}`
                )
            }
        } finally {
            await this.closeContextSafe(contextId)
            this.registry.releaseIfSame(session)
            console.log(
                `[AccountWarmup] context closed account=${accountId} generation=${session.generation}`
            )
        }
    }

    /**
     * Credit gate: live generation → Google logged-in → re-check live → completeSession.
     * Absolute no credit on cancel / stale generation / not logged in.
     */
    private async tryCreditSession(
        accountId: number,
        session: RunningSession,
        contextId: number,
        startedMs: number,
    ): Promise<void> {
        // Gate 1: cancel / stale generation before any side-effect.
        if (!this.registry.isLive(session)) {
            console.log(
                `[AccountWarmup] skip credit account=${accountId} generation=${session.generation} ` +
                `(cancelled or stale before login check)`
            )
            return
        }

        // Gate 2: only credit when BrowserService confirms Google login.
        const loggedIn = await browserService.isGoogleLoggedIn(contextId).catch(() => false)
        if (!loggedIn) {
            console.log(
                `[AccountWarmup] skip credit account=${accountId} generation=${session.generation} ` +
                `(isGoogleLoggedIn=false)`
            )
            return
        }

        // Gate 3: re-check cancel/generation IMMEDIATELY before completeSession.
        if (!this.registry.isLive(session)) {
            console.log(
                `[AccountWarmup] skip credit account=${accountId} generation=${session.generation} ` +
                `(cancelled or stale immediately before completeSession)`
            )
            return
        }

        const elapsedSec = Math.max(1, Math.round((Date.now() - startedMs) / 1000))
        // Commit token: re-checked inside completeSession after every await and
        // immediately before DB update — closes cancel race during getWarmupData.
        await accountWarmupService.completeSession(
            accountId,
            session.activityType,
            elapsedSec,
            `bounded_${session.activityType}`,
            { shouldCommit: () => this.registry.isLive(session) },
        )
        console.log(
            `[AccountWarmup] done account=${accountId} generation=${session.generation} ` +
            `elapsed=${elapsedSec}s`
        )
    }

    private async closeContextSafe(contextId: number | null): Promise<void> {
        if (contextId == null) return
        try {
            await browserService.closeContext(contextId)
        } catch {
            // ignore close races
        }
    }

    private async executeActivity(
        page: Page,
        session: RunningSession,
        durationSeconds: number,
    ): Promise<void> {
        const hour = new Date().getHours()
        const timePolicy = evaluateTimeOfDay({ hour })
        // Off-hours: slightly shorter active window to look less bot-like 24/7.
        const scaledDuration = Math.max(
            MIN_DURATION_SEC,
            Math.floor(durationSeconds * timePolicy.activityMultiplier),
        )
        const deadline = Date.now() + scaledDuration * 1000
        const warmupPlan = buildSessionWarmupPlan({
            hour,
            maxWarmupMs: Math.min(20_000, scaledDuration * 250),
        })

        await this.applySessionWarmup(page, session, warmupPlan)

        switch (session.activityType) {
            case 'google_search':
                await this.runGoogleSearch(page, session, deadline, warmupPlan)
                break
            case 'maps_browse':
                await this.runMapsBrowse(page, session, deadline, warmupPlan)
                break
            case 'youtube_browse':
                await this.runYoutubeBrowse(page, session, deadline, warmupPlan)
                break
            default:
                await this.runGoogleSearch(page, session, deadline, warmupPlan)
        }
        await this.dwellUntilDeadline(page, session, deadline, warmupPlan)
    }

    /**
     * Natural pre-activity warming: partial scroll depth + optional tab switch + dwell.
     * Delays use boundedWaitExact so callers can cancel via session lifecycle.
     */
    private async applySessionWarmup(
        page: Page,
        session: RunningSession,
        plan: SessionWarmupPlan,
    ): Promise<void> {
        this.assertNotCancelled(session)
        console.log(
            `[AccountWarmup] session warmup scrollDepth=${plan.scroll.targetDepth} ` +
            `tabs=${plan.tabSwitch.switchCount} activeHours=${plan.timeOfDay.isActiveHours} ` +
            `dwellMs=${plan.plannedDwellMs}`,
        )

        await HumanBehavior.scrollToDepth(page, plan.scroll.targetDepth, {
            steps: plan.scroll.steps,
        }).catch(() => undefined)
        this.assertNotCancelled(session)

        if (plan.tabSwitch.shouldSwitch && plan.tabSwitch.switchCount > 0) {
            await this.simulateTabSwitch(page, session, plan)
        }

        const dwell = Math.min(plan.maxWarmupMs, plan.plannedDwellMs)
        if (dwell > 0) {
            await boundedWaitExact(dwell, { maxBoundMs: plan.maxWarmupMs })
        }
        this.assertNotCancelled(session)
    }

    /**
     * Lightweight tab-switch pattern: open a blank page, dwell, close, return.
     * Uses Playwright pages within the same context (no extra BrowserService APIs).
     */
    private async simulateTabSwitch(
        page: Page,
        session: RunningSession,
        plan: SessionWarmupPlan,
    ): Promise<void> {
        const context = page.context()
        const switches = Math.min(2, Math.max(1, plan.tabSwitch.switchCount))
        for (let i = 0; i < switches; i++) {
            this.assertNotCancelled(session)
            let extra: Page | null = null
            try {
                extra = await context.newPage()
                await extra.goto('https://www.google.com.vn', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15_000,
                }).catch(() => undefined)
                const dwell = HumanBehavior.getRandomDelay(
                    plan.tabSwitch.dwellPerTabMs.min,
                    plan.tabSwitch.dwellPerTabMs.max,
                )
                await boundedWaitExact(dwell, { maxBoundMs: 8_000 })
                await HumanBehavior.scrollToDepth(extra, Math.min(0.4, plan.scroll.targetDepth), {
                    steps: 2,
                }).catch(() => undefined)
            } catch {
                // non-fatal
            } finally {
                if (extra) {
                    await extra.close().catch(() => undefined)
                }
            }
            await page.bringToFront().catch(() => undefined)
            await boundedWaitExact(400, { maxBoundMs: 1_000 })
        }
    }

    private assertNotCancelled(session: RunningSession): void {
        if (session.cancelled || !this.registry.isLive(session)) {
            throw new Error('Warmup cancelled')
        }
    }

    private async dwellUntilDeadline(
        page: Page,
        session: RunningSession,
        deadline: number,
        plan?: SessionWarmupPlan,
    ): Promise<void> {
        const delayFactor = plan?.timeOfDay.delayFactor ?? 1
        while (Date.now() < deadline) {
            this.assertNotCancelled(session)
            const depth = plan?.scroll.targetDepth ?? 0.5
            await HumanBehavior.scrollToDepth(page, depth * (0.6 + Math.random() * 0.4), {
                steps: 1,
            }).catch(() => undefined)
            await HumanBehavior.randomDelay(
                Math.floor(1500 * delayFactor),
                Math.floor(3500 * delayFactor),
            )
            if (Date.now() + 2000 >= deadline) break
            await HumanBehavior.readingSimulation(page, 1).catch(() => undefined)
            await HumanBehavior.randomDelay(
                Math.floor(1000 * delayFactor),
                Math.floor(2500 * delayFactor),
            )
        }
    }

    private async dismissConsent(page: Page): Promise<void> {
        try {
            const btn = await page.$(
                'button:has-text("Accept all"), button:has-text("Đồng ý"), ' +
                'button:has-text("Accept"), button:has-text("I agree"), ' +
                'button:has-text("Reject all"), button:has-text("Từ chối tất cả")'
            )
            if (btn) {
                await btn.click().catch(() => undefined)
                await HumanBehavior.randomDelay(400, 900)
            }
        } catch {
            // no consent dialog
        }
    }

    private async runGoogleSearch(
        page: Page,
        session: RunningSession,
        deadline: number,
        plan?: SessionWarmupPlan,
    ): Promise<void> {
        this.assertNotCancelled(session)
        const query = pickOne(SAFE_SEARCH_QUERIES)
        const delayFactor = plan?.timeOfDay.delayFactor ?? 1
        const scrollDepth = plan?.scroll.targetDepth ?? 0.55

        await page.goto('https://www.google.com.vn', {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        })
        await HumanBehavior.randomDelay(
            Math.floor(1200 * delayFactor),
            Math.floor(2500 * delayFactor),
        )
        await this.dismissConsent(page)
        this.assertNotCancelled(session)

        const searchSelector = 'textarea[name="q"], input[name="q"]'
        const box = await page.$(searchSelector)
        if (!box) {
            await HumanBehavior.scrollToDepth(page, scrollDepth, { steps: 2 }).catch(() => undefined)
            return
        }

        await HumanBehavior.humanClick(page, searchSelector).catch(async () => {
            await page.click(searchSelector)
        })
        await HumanBehavior.randomDelay(300, 700)
        await HumanBehavior.humanType(page, searchSelector, query, {
            minDelay: 45,
            maxDelay: 140,
            mistakeRate: 0.02,
        })
        await HumanBehavior.randomDelay(500, 1200)
        await page.keyboard.press('Enter')
        await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => undefined)
        await HumanBehavior.randomDelay(
            Math.floor(1500 * delayFactor),
            Math.floor(3000 * delayFactor),
        )
        this.assertNotCancelled(session)

        await HumanBehavior.scrollToDepth(page, scrollDepth, {
            steps: plan?.scroll.steps ?? 2,
        }).catch(() => undefined)
        await HumanBehavior.readingSimulation(page, 2).catch(() => undefined)

        // Optional light click into a non-sensitive organic result (first result area)
        if (Date.now() + 8000 < deadline && Math.random() > 0.4) {
            try {
                const link = await page.$('#search a h3, #rso a h3')
                if (link) {
                    await link.click({ timeout: 3000 }).catch(() => undefined)
                    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
                    await HumanBehavior.randomDelay(2000, 4000)
                    await HumanBehavior.scrollToDepth(page, Math.min(0.7, scrollDepth + 0.1), {
                        steps: 2,
                    }).catch(() => undefined)
                    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined)
                }
            } catch {
                // stay on SERP
            }
        }
    }

    private async runMapsBrowse(
        page: Page,
        session: RunningSession,
        deadline: number,
        plan?: SessionWarmupPlan,
    ): Promise<void> {
        this.assertNotCancelled(session)
        const query = pickOne(SAFE_MAPS_QUERIES)
        const delayFactor = plan?.timeOfDay.delayFactor ?? 1
        const scrollDepth = plan?.scroll.targetDepth ?? 0.5

        await page.goto('https://www.google.com/maps', {
            waitUntil: 'domcontentloaded',
            timeout: 35_000,
        })
        await HumanBehavior.randomDelay(
            Math.floor(2000 * delayFactor),
            Math.floor(4000 * delayFactor),
        )
        await this.dismissConsent(page)
        this.assertNotCancelled(session)

        const searchSelector =
            'input#searchboxinput, input[name="q"], input[aria-label*="Search"], input[aria-label*="Tìm"]'
        const box = await page.$(searchSelector)
        if (box) {
            await HumanBehavior.humanClick(page, searchSelector).catch(async () => {
                await page.click(searchSelector)
            })
            await HumanBehavior.randomDelay(300, 700)
            await HumanBehavior.humanType(page, searchSelector, query, {
                minDelay: 50,
                maxDelay: 150,
                mistakeRate: 0.015,
            })
            await HumanBehavior.randomDelay(400, 900)
            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
            await HumanBehavior.randomDelay(
                Math.floor(2500 * delayFactor),
                Math.floor(4500 * delayFactor),
            )
        }

        this.assertNotCancelled(session)
        await HumanBehavior.scrollToDepth(page, scrollDepth, {
            steps: plan?.scroll.steps ?? 3,
        }).catch(() => undefined)
        await HumanBehavior.readingSimulation(page, 2).catch(() => undefined)

        // Bounded pan simulation via wheel only — no review / KPI / place spam
        if (Date.now() + 5000 < deadline) {
            await page.mouse.wheel(0, HumanBehavior.getRandomDelay(200, 500)).catch(() => undefined)
            await HumanBehavior.randomDelay(1500, 3000)
            await page.mouse.wheel(0, -HumanBehavior.getRandomDelay(100, 300)).catch(() => undefined)
        }
    }

    private async runYoutubeBrowse(
        page: Page,
        session: RunningSession,
        deadline: number,
        plan?: SessionWarmupPlan,
    ): Promise<void> {
        this.assertNotCancelled(session)
        const query = pickOne(SAFE_YOUTUBE_QUERIES)
        const delayFactor = plan?.timeOfDay.delayFactor ?? 1
        const scrollDepth = plan?.scroll.targetDepth ?? 0.5

        await page.goto('https://www.youtube.com', {
            waitUntil: 'domcontentloaded',
            timeout: 35_000,
        })
        await HumanBehavior.randomDelay(
            Math.floor(2000 * delayFactor),
            Math.floor(4000 * delayFactor),
        )
        await this.dismissConsent(page)
        this.assertNotCancelled(session)

        // Prefer search path when search box is available
        const searchSelector =
            'input#search, input[name="search_query"], input[aria-label*="Search"]'
        const box = await page.$(searchSelector)
        if (box) {
            await HumanBehavior.humanClick(page, searchSelector).catch(async () => {
                await page.click(searchSelector)
            })
            await HumanBehavior.randomDelay(300, 700)
            await HumanBehavior.humanType(page, searchSelector, query, {
                minDelay: 45,
                maxDelay: 130,
                mistakeRate: 0.02,
            })
            await HumanBehavior.randomDelay(400, 900)
            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
            await HumanBehavior.randomDelay(
                Math.floor(2000 * delayFactor),
                Math.floor(4000 * delayFactor),
            )
        }

        this.assertNotCancelled(session)
        await HumanBehavior.scrollToDepth(page, scrollDepth, {
            steps: plan?.scroll.steps ?? 3,
        }).catch(() => undefined)
        await HumanBehavior.readingSimulation(page, 2).catch(() => undefined)

        // Optional: open first video thumbnail briefly (watch only — no comments/likes)
        if (Date.now() + 12_000 < deadline && Math.random() > 0.35) {
            try {
                const thumb = await page.$('ytd-video-renderer a#thumbnail, a#thumbnail')
                if (thumb) {
                    await thumb.click({ timeout: 3000 }).catch(() => undefined)
                    await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => undefined)
                    await HumanBehavior.randomDelay(5000, 10_000)
                    await HumanBehavior.scrollToDepth(page, Math.min(0.6, scrollDepth), {
                        steps: 1,
                    }).catch(() => undefined)
                }
            } catch {
                // remain on browse page
            }
        }
    }
}

export const accountWarmupEngine = new AccountWarmupEngine()
