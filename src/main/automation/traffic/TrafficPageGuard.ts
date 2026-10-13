import { BrowserContext, Page } from 'playwright'
import { HumanBehavior } from '../HumanBehavior'
import { OrganicSearchFlow } from '../OrganicSearchFlow'
import {
    contextualInterruptionResolver,
    ContextualInterruptionResolveResult,
} from '../ContextualInterruptionResolver'
import { captchaSolverService } from '../../services/CaptchaSolverService'
import { getRuntimeLogger, type RuntimeLogger } from '../../utils/runtimeLogger'
import { runtimePolicyService } from '../../runtime/v2/runtimePolicy'
import { RuntimeActionEvent } from '../../runtime/v2/types'
import { CaptchaDetector } from '../../../shared/captcha/CaptchaDetector'

// ============================================================
// Types
// ============================================================

/**
 * Per-thread CAPTCHA strike window.
 * lastResolvedAt stays optional: a first detection has no resolve timestamp.
 */
export interface CaptchaThreadStats {
    hits: number
    lastDetectedAt: number
    lastResolvedAt?: number
}

/** Location fields read by direct-mode map recovery. */
export interface PageGuardLocationRef {
    name?: string | null
    address?: string | null
    placeId?: string | null
    url?: string | null
}

/** Status counters previously passed into TrafficBoostEngine.buildStatus. */
export interface PageGuardStatusContext {
    campaignName: string
    currentRound: number
    completedVisits: number
    totalVisits: number
    failedVisits: number
}

export interface PageGuardStatusOverrides extends PageGuardStatusContext {
    message?: string
}

/** Mirrors TrafficBoostEngine ActionContext so the engine can pass it through. */
export interface PageGuardActionContext {
    campaignName: string
    round: number
    campaignId: number
    threadId: number
    accountEmail: string
    locationName: string
    domain?: string
    goal?: string
    riskType?: string
}

/** Mirrors TrafficBoostEngine VisitActionRecord. */
export interface PageGuardActionRecord {
    action: string
    success: boolean
    source?: string
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    threadId?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp?: string
}

/**
 * Orchestrator side effects. Omit a callback to skip that effect.
 * These methods never call emitActionEvent themselves. TrafficBoostEngine.recordAction
 * emits after it appends the action, so pass recordAction to keep that path.
 * emitActionEvent is here for a caller that records actions on its own.
 */
export interface PageGuardHooks {
    setThreadAction?: (threadIndex: number, action: string) => void
    recordAction?: (
        actionsPerformed: PageGuardActionRecord[],
        input: PageGuardActionRecord,
        context: PageGuardActionContext,
    ) => void
    /**
     * Not invoked by this class. Kept so the orchestrator can hold the same
     * callback TrafficBoostEngine.emitActionEvent used. recordAction owns emission.
     */
    emitActionEvent?: (event: RuntimeActionEvent) => void
    /** Forward to TrafficBoostEngine.sendStatus(buildStatus(overrides)). */
    sendStatus?: (overrides: PageGuardStatusOverrides) => void
    updateThreadCurrentUrl?: (threadIndex: number, page: Page) => void
    /** Live value previously read from TrafficBoostEngine.currentQueueDepth. */
    getQueueDepth?: () => number
}

export interface PageGuardDeps {
    captchaSolverService: typeof captchaSolverService
    getRuntimeLogger: typeof getRuntimeLogger
    captchaCooldownWindowMs?: number
}

export interface CaptchaGuardOptions {
    statusContext: PageGuardStatusContext
    actionsPerformed: PageGuardActionRecord[]
    actionContext: PageGuardActionContext
    fallbackUrl: string
    hooks?: PageGuardHooks
}

export interface GoogleLoginGuardOptions {
    statusContext: PageGuardStatusContext
    actionsPerformed: PageGuardActionRecord[]
    actionContext: PageGuardActionContext
    fallbackUrl: string
    hooks?: PageGuardHooks
}

export interface DirectModeMapOptions {
    statusContext: PageGuardStatusContext
    actionsPerformed: PageGuardActionRecord[]
    actionContext: PageGuardActionContext
    hasAccount: boolean
    hooks?: PageGuardHooks
}

export interface StabilizeContextOptions {
    reason: string
    actionsPerformed: PageGuardActionRecord[]
    actionContext: PageGuardActionContext
    statusContext?: PageGuardStatusContext
    hooks?: PageGuardHooks
}

// ============================================================
// Traffic Page Guard
// ============================================================

export class TrafficPageGuard {
    private readonly logger: RuntimeLogger
    private readonly captchaSolver: typeof captchaSolverService
    private readonly captchaCooldownWindowMs: number
    private captchaThreadStats: Map<number, CaptchaThreadStats> = new Map()
    /** Snapshot, same as TrafficBoostEngine.runtimePolicy. Refresh at campaign start. */
    private runtimePolicy = runtimePolicyService.getPolicy()

    constructor(deps: Partial<PageGuardDeps> = {}) {
        const createLogger = deps.getRuntimeLogger ?? getRuntimeLogger
        this.logger = createLogger({ module: 'traffic-page-guard' })
        this.captchaSolver = deps.captchaSolverService ?? captchaSolverService
        this.captchaCooldownWindowMs = deps.captchaCooldownWindowMs ?? 12 * 60 * 1000
    }

    /**
     * Re-read captcha strike threshold.
     * TrafficBoostEngine.refreshRuntimePolicy does this at campaign start.
     */
    refreshRuntimePolicy(): void {
        this.runtimePolicy = runtimePolicyService.getPolicy()
        this.logger.debug({
            event: 'page_guard_policy_refreshed',
            captchaAutoSkipMaxStrikes: this.runtimePolicy.captchaAutoSkipMaxStrikes,
        })
    }

    private setThreadAction(threadIdx: number, action: string, hooks?: PageGuardHooks): void {
        hooks?.setThreadAction?.(threadIdx, action)
    }

    private recordAction(
        actionsPerformed: PageGuardActionRecord[],
        input: PageGuardActionRecord,
        context: PageGuardActionContext,
        hooks?: PageGuardHooks,
    ): void {
        hooks?.recordAction?.(actionsPerformed, input, context)
    }

    private buildStatus(overrides: PageGuardStatusOverrides): PageGuardStatusOverrides {
        return overrides
    }

    private sendStatus(status: PageGuardStatusOverrides, hooks?: PageGuardHooks): void {
        hooks?.sendStatus?.(status)
    }

    private updateThreadCurrentUrl(threadIdx: number, page: Page, hooks?: PageGuardHooks): void {
        hooks?.updateThreadCurrentUrl?.(threadIdx, page)
    }

    private queueDepth(hooks?: PageGuardHooks): number | undefined {
        return hooks?.getQueueDepth?.()
    }

    isGoogleLoginUrl(rawUrl: string): boolean {
        const url = (rawUrl || '').toLowerCase()
        if (!url.includes('google.com')) {
            return false
        }
        return url.includes('accounts.google.com')
            || url.includes('/servicelogin')
            || url.includes('/v3/signin')
            || url.includes('signin/identifier')
            || url.includes('consent.google.com')
    }

    /**
     * Close tabs other than the thread's active page.
     * `context` is the thread BrowserContext (previously read via page.context()).
     * `reason` is kept because the original log line includes it.
     */
    async cleanupExtraTabsForThread(
        context: BrowserContext,
        page: Page,
        threadIndex: number,
        reason: string,
    ): Promise<void> {
        const threadIdx = threadIndex
        if (page.isClosed()) {
            return
        }

        const tabs = context.pages()
        let closedCount = 0

        for (const tab of tabs) {
            if (tab === page || tab.isClosed()) {
                continue
            }

            try {
                await tab.close({ runBeforeUnload: false })
                closedCount++
            } catch {
                // Ignore close failures for stubborn tabs.
            }
        }

        if (closedCount > 0) {
            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Closed ${closedCount} extra tab(s) (${reason})`)
        }

        await page.bringToFront().catch(() => { })
    }

    private isGoogleMapsUrl(url: string): boolean {
        const normalized = String(url || '').toLowerCase()
        return normalized.includes('google.com/maps')
            || /:\/\/maps\.google\./.test(normalized)
            || normalized.includes('/maps/place')
            || normalized.includes('/maps/search')
            || normalized.includes('/maps/dir')
    }

    async isMapUiReady(page: Page): Promise<boolean> {
        if (page.isClosed()) {
            return false
        }

        const currentUrl = page.url()
        if (this.isGoogleLoginUrl(currentUrl)) {
            return false
        }

        if (!this.isGoogleMapsUrl(currentUrl)) {
            return false
        }

        const quickSignalCount = await page
            .locator('#searchboxinput, button[data-value="Directions"], div[role="main"], button[jsaction*="pane.placeActions.directions"]')
            .count()
            .catch(() => 0)
        if (quickSignalCount > 0) {
            return true
        }

        const pageTitle = await page.title().catch(() => '')
        return /google maps|maps|bản đồ/i.test(pageTitle)
    }

    async hasVisibleBlockingDialog(page: Page): Promise<boolean> {
        if (page.isClosed()) {
            return false
        }

        return page.evaluate(() => {
            const selectors = '[role="dialog"], [aria-modal="true"], [role="alertdialog"]'
            const dialogs = Array.from(document.querySelectorAll<HTMLElement>(selectors))
            return dialogs.some(dialog => {
                const rect = dialog.getBoundingClientRect()
                const style = window.getComputedStyle(dialog)
                return rect.width > 20
                    && rect.height > 20
                    && style.visibility !== 'hidden'
                    && style.display !== 'none'
                    && style.opacity !== '0'
            })
        }).catch(() => false)
    }

    async ensureDirectModeMapReady(
        page: Page,
        location: PageGuardLocationRef,
        threadIndex: number,
        opts: DirectModeMapOptions,
    ): Promise<void> {
        const threadIdx = threadIndex
        const {
            statusContext,
            actionsPerformed,
            actionContext,
            hasAccount,
            hooks,
        } = opts

        if (await this.isMapUiReady(page)) {
            return
        }

        const locationName = String(location?.name || '').trim()
        const locationAddress = String(location?.address || '').trim()
        const locationPlaceId = String(location?.placeId || '').trim()
        const fallbackQuery = [locationName, locationAddress].filter(Boolean).join(' ').trim()
        const fallbackQueryUrl = fallbackQuery
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackQuery)}`
            : 'https://www.google.com/maps'

        this.setThreadAction(threadIdx, 'Direct mode: recovering map context', hooks)
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: Direct mode fallback to map recovery`,
        }), hooks)
        this.recordAction(actionsPerformed, {
            action: 'direct_mode_recover_start',
            success: true,
            source: 'runtime',
            detail: `Initial URL not map-ready: ${page.url()}`,
            threadId: threadIdx,
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)

        let recovered = false

        if (locationPlaceId) {
            const placeIdUrl = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(locationPlaceId)}`
            await page.goto(placeIdUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => { })
            await HumanBehavior.randomDelay(900, 1800)
            recovered = await this.isMapUiReady(page)
        }

        if (!recovered && fallbackQuery) {
            try {
                const organicFlow = new OrganicSearchFlow((status) => {
                    this.setThreadAction(threadIdx, status, hooks)
                })
                const organicResult = await organicFlow.execute(page, fallbackQuery, {
                    name: locationName || fallbackQuery,
                    address: locationAddress || locationName || fallbackQuery,
                    placeId: locationPlaceId || undefined,
                    url: String(location?.url || fallbackQueryUrl),
                }, hasAccount)

                for (const organicAction of organicResult.actionsPerformed) {
                    this.recordAction(actionsPerformed, {
                        action: `direct_recover_organic:${organicAction.action}`,
                        success: organicAction.success,
                        source: 'organic',
                        detail: `Direct fallback organic action: ${organicAction.action}`,
                        threadId: threadIdx,
                        queueDepth: this.queueDepth(hooks),
                        timestamp: new Date().toISOString(),
                    }, actionContext, hooks)
                }
                recovered = organicResult.foundMap || await this.isMapUiReady(page)
            } catch {
                // Ignore organic fallback exceptions and continue with URL fallback.
            }
        }

        if (!recovered) {
            await page.goto(fallbackQueryUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => { })
            await HumanBehavior.randomDelay(1000, 2200)
            recovered = await this.isMapUiReady(page)
        }

        this.recordAction(actionsPerformed, {
            action: recovered ? 'direct_mode_recover_success' : 'direct_mode_recover_failed',
            success: recovered,
            source: 'runtime',
            detail: recovered
                ? `Recovered map context via direct fallback (${page.url()})`
                : `Direct fallback failed to restore map context (${page.url()})`,
            threadId: threadIdx,
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)

        if (!recovered) {
            throw new Error('DIRECT_MODE_MAP_NOT_READY')
        }
    }

    async handleGoogleLoginIfNeeded(
        page: Page,
        threadIndex: number,
        opts: GoogleLoginGuardOptions,
    ): Promise<void> {
        const threadIdx = threadIndex
        const {
            statusContext,
            actionsPerformed,
            actionContext,
            fallbackUrl,
            hooks,
        } = opts

        if (page.isClosed()) {
            return
        }

        this.updateThreadCurrentUrl(threadIdx, page, hooks)
        if (!this.isGoogleLoginUrl(page.url())) {
            return
        }

        this.setThreadAction(threadIdx, 'Google Login gate detected', hooks)
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: Google login gate detected, auto-recovering`,
        }), hooks)
        this.recordAction(actionsPerformed, {
            action: 'google_login_detected',
            success: false,
            source: 'safety',
            detail: page.url(),
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)

        const resolved = await contextualInterruptionResolver.resolve(page, {
            threadId: threadIdx,
            reason: 'google_login_gate',
            useLlmFallback: true,
            llmTimeoutMs: 2200,
            useEscapeFallback: true,
            maxPasses: 3,
            goal: 'map_interaction',
            campaignType: 'traffic',
            campaignId: actionContext.campaignId,
            domain: page.url(),
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
        if (resolved.handled) {
            await HumanBehavior.randomDelay(140, 280)
            this.updateThreadCurrentUrl(threadIdx, page, hooks)
            if (!this.isGoogleLoginUrl(page.url())) {
                this.recordAction(actionsPerformed, {
                    action: 'context_recover_map_success',
                    success: true,
                    source: 'runtime',
                    detail: `Recovered by interruption resolver (${resolved.via || 'unknown'})`,
                    threadId: threadIdx,
                    retryCategory: 'google_login',
                    recoverPath: resolved.via,
                    queueDepth: this.queueDepth(hooks),
                    timestamp: new Date().toISOString(),
                }, actionContext, hooks)
                return
            }
        }

        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3500 }).catch(() => { })
        await HumanBehavior.randomDelay(180, 420)
        this.updateThreadCurrentUrl(threadIdx, page, hooks)
        if (!this.isGoogleLoginUrl(page.url())) {
            this.recordAction(actionsPerformed, {
                action: 'context_recover_map_success',
                success: true,
                source: 'runtime',
                detail: 'Recovered by goBack',
                threadId: threadIdx,
                retryCategory: 'google_login',
                queueDepth: this.queueDepth(hooks),
                timestamp: new Date().toISOString(),
            }, actionContext, hooks)
            return
        }

        await page.goto(fallbackUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => { })
        await this.stabilizeContextIfNeeded(page, threadIdx, {
            reason: 'google_login_fallback_navigation',
            actionsPerformed,
            actionContext,
            statusContext,
            hooks,
        })
        await HumanBehavior.randomDelay(220, 560)
        this.updateThreadCurrentUrl(threadIdx, page, hooks)
        if (!this.isGoogleLoginUrl(page.url())) {
            this.recordAction(actionsPerformed, {
                action: 'context_recover_map_success',
                success: true,
                source: 'runtime',
                detail: 'Recovered by fallback navigation',
                threadId: threadIdx,
                retryCategory: 'google_login',
                queueDepth: this.queueDepth(hooks),
                timestamp: new Date().toISOString(),
            }, actionContext, hooks)
            return
        }

        this.setThreadAction(threadIdx, 'Google Login blocked (skip visit)', hooks)
        this.recordAction(actionsPerformed, {
            action: 'context_recover_map_failed',
            success: false,
            source: 'runtime',
            detail: 'Failed to return to map after resolver/goBack/fallback navigation',
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)
        this.recordAction(actionsPerformed, {
            action: 'google_login_blocked',
            success: false,
            source: 'safety',
            detail: 'Unable to leave Google login page',
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)
        this.recordAction(actionsPerformed, {
            action: 'visit_skipped_unrecoverable_login',
            success: false,
            source: 'safety',
            detail: 'Skipping visit because Google login gate could not be recovered',
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)
        throw new Error('GOOGLE_LOGIN_BLOCKED')
    }

    /**
     * Full page check (URL + DOM), same as TrafficBoostEngine.isCaptchaOrSorryPage.
     * Not a URL-only test: that lives on CaptchaDetector.isCaptchaUrl.
     */
    async isCaptchaOrSorryPage(page: Page): Promise<boolean> {
        return CaptchaDetector.isCaptchaPage(page)
    }

    async handleCaptchaIfNeeded(
        page: Page,
        threadIndex: number,
        opts: CaptchaGuardOptions,
    ): Promise<void> {
        const threadIdx = threadIndex
        const {
            statusContext,
            actionsPerformed,
            actionContext,
            fallbackUrl,
            hooks,
        } = opts

        const captchaDetected = await this.isCaptchaOrSorryPage(page)
        if (!captchaDetected) {
            return
        }

        const captchaStats = this.markCaptchaDetected(threadIdx)

        await page.bringToFront().catch(() => { })
        this.recordAction(actionsPerformed, {
            action: 'captcha_detected',
            success: false,
            source: 'safety',
            detail: `Google CAPTCHA/sorry page detected (strike=${captchaStats.hits})`,
            threadId: threadIdx,
            attempt: captchaStats.hits,
            retryCategory: 'captcha',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)

        // === TRY AUTO-SOLVE CAPTCHA VIA API ===
        this.setThreadAction(threadIdx, 'Đang giải CAPTCHA tự động...', hooks)
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: CAPTCHA detected → trying auto-solve via API...`,
        }), hooks)

        const solveSuccess = await this.captchaSolver.solveCaptchaOnPage(page, threadIdx)
        if (solveSuccess) {
            await HumanBehavior.randomDelay(1500, 3000)
            const stillBlocked = await this.isCaptchaOrSorryPage(page)
            if (!stillBlocked) {
                this.markCaptchaResolved(threadIdx)
                this.recordAction(actionsPerformed, {
                    action: 'captcha_auto_solved',
                    success: true,
                    source: 'captcha_solver',
                    detail: `CAPTCHA solved automatically via API solver`,
                    threadId: threadIdx,
                    attempt: captchaStats.hits,
                    retryCategory: 'captcha',
                    queueDepth: this.queueDepth(hooks),
                    timestamp: new Date().toISOString(),
                }, actionContext, hooks)
                this.setThreadAction(threadIdx, 'CAPTCHA solved ✓ - continuing visit', hooks)
                return
            }
        }

        // === FALLBACK: AUTO-SKIP (old behavior) ===
        this.setThreadAction(threadIdx, 'CAPTCHA auto-skip: recovering context', hooks)
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: CAPTCHA auto-solve failed (strike ${captchaStats.hits}), fallback to auto-skip`,
        }), hooks)
        this.recordAction(actionsPerformed, {
            action: 'captcha_auto_skip',
            success: true,
            source: 'safety',
            detail: `Auto-solve failed → fallback to auto-skip (strike ${captchaStats.hits})`,
            threadId: threadIdx,
            attempt: captchaStats.hits,
            retryCategory: 'captcha',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)

        const confirmRecovered = async (recoverPath: string, detail: string): Promise<boolean> => {
            this.updateThreadCurrentUrl(threadIdx, page, hooks)
            const stillBlocked = await this.isCaptchaOrSorryPage(page)
            if (stillBlocked) {
                return false
            }

            this.markCaptchaResolved(threadIdx)
            this.recordAction(actionsPerformed, {
                action: 'context_recover_map_success',
                success: true,
                source: 'runtime',
                detail,
                threadId: threadIdx,
                attempt: captchaStats.hits,
                retryCategory: 'captcha',
                recoverPath,
                queueDepth: this.queueDepth(hooks),
                timestamp: new Date().toISOString(),
            }, actionContext, hooks)
            this.setThreadAction(threadIdx, 'CAPTCHA recovered - continuing visit', hooks)
            return true
        }

        const resolved = await contextualInterruptionResolver.resolve(page, {
            threadId: threadIdx,
            reason: 'captcha_gate',
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 3,
            goal: 'map_interaction',
            campaignType: 'traffic',
            campaignId: actionContext.campaignId,
            domain: page.url(),
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
        if (resolved.handled) {
            await HumanBehavior.randomDelay(140, 280)
            if (await confirmRecovered(
                resolved.via || 'interruption_resolver',
                `Recovered from CAPTCHA via interruption resolver (${resolved.via || 'unknown'})`
            )) {
                return
            }
        }

        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3500 }).catch(() => { })
        await HumanBehavior.randomDelay(180, 420)
        if (await confirmRecovered('go_back', 'Recovered from CAPTCHA via goBack')) {
            return
        }

        await page.goto(fallbackUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => { })
        await this.stabilizeContextIfNeeded(page, threadIdx, {
            reason: 'captcha_fallback_navigation',
            actionsPerformed,
            actionContext,
            statusContext,
            hooks,
        })
        await HumanBehavior.randomDelay(220, 560)
        if (await confirmRecovered('goto_fallback', 'Recovered from CAPTCHA via fallback navigation')) {
            return
        }

        this.setThreadAction(threadIdx, 'CAPTCHA unrecoverable (skip visit)', hooks)
        this.recordAction(actionsPerformed, {
            action: 'context_recover_map_failed',
            success: false,
            source: 'runtime',
            detail: 'Failed to recover from CAPTCHA after resolver/goBack/fallback navigation',
            threadId: threadIdx,
            attempt: captchaStats.hits,
            retryCategory: 'captcha',
            queueDepth: this.queueDepth(hooks),
            timestamp: new Date().toISOString(),
        }, actionContext, hooks)
        throw new Error('CAPTCHA_UNRECOVERABLE')
    }

    markCaptchaDetected(threadIndex: number): CaptchaThreadStats {
        const threadIdx = threadIndex
        const current = this.captchaThreadStats.get(threadIdx)
        const now = Date.now()
        const next = {
            hits: Math.min(8, (current?.hits || 0) + 1),
            lastDetectedAt: now,
            lastResolvedAt: current?.lastResolvedAt,
        }
        this.captchaThreadStats.set(threadIdx, next)
        return next
    }

    markCaptchaResolved(threadIndex: number): void {
        const threadIdx = threadIndex
        const current = this.captchaThreadStats.get(threadIdx)
        if (!current) {
            return
        }
        const next = {
            hits: Math.max(0, current.hits - 1),
            lastDetectedAt: current.lastDetectedAt,
            lastResolvedAt: Date.now(),
        }
        this.captchaThreadStats.set(threadIdx, next)
    }

    shouldAvoidGoogleSearch(threadIndex: number): boolean {
        const threadIdx = threadIndex
        const stats = this.captchaThreadStats.get(threadIdx)
        if (!stats) {
            return false
        }
        const policy = this.runtimePolicy
        const threshold = Math.max(1, policy.captchaAutoSkipMaxStrikes)
        const now = Date.now()
        return stats.hits >= threshold && (now - stats.lastDetectedAt) < this.captchaCooldownWindowMs
    }

    getAdaptiveDelayFactor(threadIndex: number): number {
        const threadIdx = threadIndex
        const stats = this.captchaThreadStats.get(threadIdx)
        if (!stats || stats.hits <= 0) {
            return 1
        }
        return Math.min(2.4, 1 + (stats.hits * 0.35))
    }

    async stabilizeContextIfNeeded(
        page: Page,
        threadIndex: number,
        opts: StabilizeContextOptions,
    ): Promise<void> {
        const threadIdx = threadIndex
        const {
            reason,
            actionsPerformed,
            actionContext,
            statusContext,
            hooks,
        } = opts

        if (page.isClosed()) {
            return
        }

        const mapReady = await this.isMapUiReady(page).catch(() => false)
        const blockingDialog = mapReady
            ? await this.hasVisibleBlockingDialog(page).catch(() => false)
            : false
        if (mapReady && !blockingDialog) {
            return
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            const resolved = await contextualInterruptionResolver.resolve(page, {
                threadId: threadIdx,
                reason: `traffic_${reason}_${attempt}`,
                useLlmFallback: attempt === 1,
                llmTimeoutMs: 2200,
                useEscapeFallback: true,
                maxPasses: 2,
                goal: 'map_interaction',
                campaignType: 'traffic',
                campaignId: actionContext.campaignId,
                domain: actionContext.domain,
            }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))

            if (!resolved.handled) {
                break
            }

            this.setThreadAction(threadIdx, `Resolving prompt (${reason})`, hooks)
            if (statusContext) {
                this.sendStatus(this.buildStatus({
                    campaignName: statusContext.campaignName,
                    currentRound: statusContext.currentRound,
                    completedVisits: statusContext.completedVisits,
                    totalVisits: statusContext.totalVisits,
                    failedVisits: statusContext.failedVisits,
                }), hooks)
            }

            this.recordAction(actionsPerformed, {
                action: 'context_recovered',
                success: true,
                source: 'runtime',
                detail: `${reason}:${resolved.via || 'unknown'}${resolved.detail ? `:${resolved.detail}` : ''}`,
                durationMs: resolved.latencyMs,
                decisionSource: resolved.decisionSource,
                ragUsed: resolved.ragUsed,
                ragHitCount: resolved.ragHitCount,
                ragEvidenceIds: resolved.ragEvidenceIds,
                decisionLatencyMs: resolved.decisionLatencyMs,
                recoverPath: resolved.via,
                threadId: threadIdx,
                timestamp: new Date().toISOString(),
            }, actionContext, hooks)

            await HumanBehavior.randomDelay(160, 360)
        }
    }
}

export const trafficPageGuard = new TrafficPageGuard()
