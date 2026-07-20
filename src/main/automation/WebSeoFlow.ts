/**
 * Web SEO organic browse flow — fail-closed target resolution, SERP discovery,
 * single direct fallback, read-only same-site actions, canonical quality scoring.
 */

import { Page } from 'playwright'
import { HumanBehavior } from './HumanBehavior'
import { DOMUtils, ObservedElementSummary } from './DOMUtils'
import { contextualInterruptionResolver, ContextualInterruptionResolveResult } from './ContextualInterruptionResolver'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'
import { captchaSolverService } from '../services/CaptchaSolverService'
import {
    type WebSeoFlowConfig,
    type WebSeoFlowResult,
    type WebSeoActionRecord,
    type WebSeoErrorCode,
    type WebSeoDiscoverySource,
    type WebSeoSiteType,
    resolveWebSeoTarget,
    isSameWebSeoSite,
    extractWebSeoDestination,
    buildWebSeoFallbackUrls,
    createEmptyWebSeoFlowResult,
} from '../../shared/web-seo-contracts'
import {
    classifyWebSeoSite,
    buildWebSeoActionPlan,
    isWebSeoSafeActionId,
    type WebSeoSafeActionId,
} from './web-seo/WebSeoActionPolicy'
import { assessWebSeoQuality } from './web-seo/WebSeoQualityPolicy'
import { CaptchaDetector } from '../../shared/captcha/CaptchaDetector'

/** TrafficBoostEngine compile aliases (stable public names). */
export type SeoFlowConfig = WebSeoFlowConfig
export type SeoFlowResult = WebSeoFlowResult

export type StatusCallback = (status: {
    action: string
    success: boolean
    message?: string
}) => void

type CaptchaStrategy = NonNullable<WebSeoFlowConfig['captchaStrategy']>

type FlowRuntime = {
    targetUrl: string
    targetHost: string
    deadlineAt?: number
    shouldStop?: () => boolean
    captchaStrategy: CaptchaStrategy
    safeHomeUrl: string
}

function clampDwellSeconds(value: number, floor = 10, ceiling = 300): number {
    if (!Number.isFinite(value)) return floor
    return Math.max(floor, Math.min(ceiling, Math.round(value)))
}

function unknownErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error == null) return 'Unknown error'
    try {
        return String(error)
    } catch {
        return 'Unknown error'
    }
}

function hostFromUrl(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    } catch {
        return ''
    }
}

function safeUrlForLog(url: string): string {
    try {
        const parsed = new URL(url)
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    } catch {
        return '[invalid-url]'
    }
}

function isDangerousInteractiveTarget(label: string, href: string): boolean {
    const signal = `${label} ${href}`.toLowerCase()
    return /(add.?to.?cart|buy now|mua ngay|checkout|payment|thanh toan|place order|dat hang|sign in|login|register|signup|submit)/i.test(signal)
}

export class WebSeoFlow {
    private onStatus: StatusCallback
    private actionsLog: WebSeoActionRecord[] = []
    private runtime: FlowRuntime | null = null

    constructor(onStatus?: StatusCallback) {
        this.onStatus = onStatus || (() => { })
    }

    private report(
        action: string,
        success: boolean,
        detail?: string,
        durationMs?: number,
    ): void {
        const record: WebSeoActionRecord = { action, success }
        if (detail) record.detail = detail
        if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
            record.durationMs = Math.max(0, Math.round(durationMs))
        }
        this.onStatus({ action, success, message: detail })
        this.actionsLog.push(record)
    }

    private isCancelled(): boolean {
        const rt = this.runtime
        if (!rt) return false
        if (typeof rt.shouldStop === 'function') {
            try {
                if (rt.shouldStop()) return true
            } catch {
                // ignore shouldStop errors
            }
        }
        if (typeof rt.deadlineAt === 'number' && Number.isFinite(rt.deadlineAt)) {
            if (Date.now() >= rt.deadlineAt) return true
        }
        return false
    }

    private remainingMs(): number {
        const rt = this.runtime
        if (!rt || typeof rt.deadlineAt !== 'number' || !Number.isFinite(rt.deadlineAt)) {
            return Number.POSITIVE_INFINITY
        }
        return Math.max(0, rt.deadlineAt - Date.now())
    }

    private async cleanupExtraTabs(activePage: Page, reason: string): Promise<void> {
        if (activePage.isClosed()) return

        const pages = activePage.context().pages()
        let closedCount = 0

        for (const tab of pages) {
            if (tab === activePage || tab.isClosed()) continue
            try {
                await tab.close({ runBeforeUnload: false })
                closedCount++
            } catch {
                // Ignore tabs that cannot be closed.
            }
        }

        if (closedCount > 0) {
            this.report('tab_cleanup', true, `Closed ${closedCount} background tab(s) (${reason})`)
        }

        await activePage.bringToFront().catch(() => { })
    }

    private normalizeText(value?: string): string {
        if (!value) return ''
        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
    }

    private summaryText(summary?: ObservedElementSummary): string {
        if (!summary) return ''
        return this.normalizeText([
            summary.textContent,
            summary.ariaLabel,
            summary.title,
            summary.placeholder,
            summary.href,
            summary.role,
            summary.tagName,
            summary.type,
        ].filter(Boolean).join(' '))
    }

    private isLikelyBlockingPrompt(text: string): boolean {
        if (!text) return false
        return /(vi tri chinh xac|location|near your location|cookie|consent|thong bao|notification|sign in|dang nhap|allow|cho phep)/i.test(text)
    }

    private scorePromptCandidate(summary: ObservedElementSummary): number {
        const text = this.summaryText(summary)
        if (!text) return -99

        let score = 0
        if (summary.tagName === 'button' || summary.role === 'button') score += 2
        if (/(de sau|later|not now|skip|close|dismiss|cancel|dong|ok|got it|continue|da hieu|hieu roi|xong)/i.test(text)) score += 8
        if (/(accept|i agree|dong y|chap nhan|allow once)/i.test(text)) score += 3
        if (/(su dung vi tri chinh xac|use precise location|always allow|allow location|cho phep vi tri)/i.test(text)) score -= 8
        if (/(dang nhap|sign in|login|create account|tao tai khoan|submit|publish|post|upload)/i.test(text)) score -= 10
        if (summary.href && /^https?:\/\//i.test(summary.href)) score -= 3

        return score
    }

    private async clickObservedCandidate(page: Page, elementId: number): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        const count = await locator.count().catch(() => 0)
        if (count === 0) {
            throw new Error(`Prompt candidate ${elementId} not found`)
        }

        await locator.waitFor({ state: 'visible', timeout: 2000 })
        await locator.scrollIntoViewIfNeeded().catch(() => { })
        await HumanBehavior.randomDelay(120, 260)
        await locator.click({ timeout: 1500 }).catch(async () => {
            await locator.click({ timeout: 1500, force: true })
        })
    }

    private async resolveBlockingPrompt(page: Page, reason: string): Promise<boolean> {
        if (this.isCancelled()) return false

        const sharedRecovery = await contextualInterruptionResolver.resolve(page, {
            reason: `web_seo_${reason}`,
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 2,
            goal: 'website_browse',
            campaignType: 'web_seo',
            domain: page.url(),
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))

        if (sharedRecovery.handled) {
            this.report('prompt_resolved', true, `${reason}: resolved by shared context resolver (${sharedRecovery.via || 'unknown'})`)
            return true
        }

        const signal = await page.evaluate(() => {
            const dialogEl = document.querySelector('[role="dialog"], [aria-modal="true"], [role="alertdialog"]') as HTMLElement | null
            const rect = dialogEl?.getBoundingClientRect()
            const hasVisibleDialog = !!dialogEl && !!rect && rect.width > 0 && rect.height > 0
            const rawText = (dialogEl?.innerText || document.body?.innerText || '').slice(0, 1800)
            return { hasVisibleDialog, text: rawText.replace(/\s+/g, ' ').trim() }
        }).catch(() => ({ hasVisibleDialog: false, text: '' }))

        const normalizedSignal = this.normalizeText(signal.text)
        if (!signal.hasVisibleDialog && !this.isLikelyBlockingPrompt(normalizedSignal)) {
            return false
        }

        const snapshot = await DOMUtils.extractInteractiveDOM(page)
        const candidates = snapshot.summaries
            .filter(summary => {
                const tag = (summary.tagName || '').toLowerCase()
                const role = (summary.role || '').toLowerCase()
                if (tag === 'input' || tag === 'textarea' || tag === 'select') return false
                return tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'menuitem'
            })
            .map(summary => ({
                summary,
                score: this.scorePromptCandidate(summary),
                label: this.summaryText(summary).slice(0, 100),
            }))
            .sort((a, b) => b.score - a.score)

        for (const candidate of candidates.slice(0, 6)) {
            if (candidate.score < 4) continue
            try {
                await this.clickObservedCandidate(page, candidate.summary.id)
                await HumanBehavior.randomDelay(220, 480)
                this.report('prompt_resolved', true, `${reason}: resolved with "${candidate.label || candidate.summary.id}"`)
                return true
            } catch {
                // Try next candidate.
            }
        }

        if (signal.hasVisibleDialog) {
            await page.keyboard.press('Escape').catch(() => { })
            await HumanBehavior.randomDelay(160, 360)
            this.report('prompt_escape', true, `${reason}: fallback escape`)
            return true
        }

        return false
    }

    private verifyPageHost(page: Page, target: string): boolean {
        if (page.isClosed()) return false
        try {
            return isSameWebSeoSite(page.url(), target)
        } catch {
            return false
        }
    }

    private async ensureSameSite(page: Page, target: string, actionId: string): Promise<boolean> {
        if (this.verifyPageHost(page, target)) return true

        this.report(actionId, false, 'Left target site — recovering')
        try {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => { })
            await HumanBehavior.randomDelay(300, 700)
            if (this.verifyPageHost(page, target)) {
                await this.cleanupExtraTabs(page, `same_site_recover_${actionId}`)
                return false
            }
        } catch {
            // fall through to safe home
        }

        const home = this.runtime?.safeHomeUrl || target
        try {
            await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 15000 })
            await HumanBehavior.randomDelay(400, 900)
        } catch {
            // recovery failed
        }
        await this.cleanupExtraTabs(page, `same_site_goto_${actionId}`)
        return false
    }

    // ==================== PUBLIC API ====================

    async execute(page: Page, config: WebSeoFlowConfig): Promise<WebSeoFlowResult> {
        this.actionsLog = []
        const startedAt = Date.now()
        const result = createEmptyWebSeoFlowResult()
        const minDwell = clampDwellSeconds(config.minTimeOnPageSeconds)
        const maxDwell = clampDwellSeconds(
            Math.max(config.minTimeOnPageSeconds, config.maxTimeOnPageSeconds),
            minDwell,
            300,
        )

        const resolved = resolveWebSeoTarget(config.targetDomain)
        if (!resolved.ok) {
            result.errorCode = resolved.error
            result.message = `Invalid target: ${resolved.error}`
            result.actionsPerformed = [...this.actionsLog]
            result.durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
            return result
        }

        this.runtime = {
            targetUrl: resolved.url,
            targetHost: resolved.host,
            deadlineAt: config.deadlineAt,
            shouldStop: config.shouldStop,
            captchaStrategy: config.captchaStrategy || 'manual',
            safeHomeUrl: resolved.url,
        }

        let discoverySource: WebSeoDiscoverySource = 'unreachable'
        let organicHit = false
        let hostVerified = false
        let foundWebsite = false
        let siteType: WebSeoSiteType = 'generic'
        let errorCode: WebSeoErrorCode | undefined
        let interrupted = false
        let onSiteStartedAt: number | null = null

        try {
            if (this.isCancelled()) {
                interrupted = true
                result.success = false
                result.errorCode = 'cancelled'
                result.message = 'Cancelled before start'
                result.actionsPerformed = [...this.actionsLog]
                result.durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
                result.qualityScore = 0
                result.countable = false
                return result
            }

            await HumanBehavior.randomDelay(800, 1600)
            await this.cleanupExtraTabs(page, 'execute_start')
            await this.resolveBlockingPrompt(page, 'execute_start')

            const captchaStrategy = this.runtime.captchaStrategy

            // 1) Google search
            this.report('search', true, `Searching: ${config.keyword}`)
            const searchOk = await this.searchOnGoogle(page, config.keyword, captchaStrategy)

            // 2) SERP target click + host verify
            if (searchOk && !this.isCancelled()) {
                this.report('find_website', true, `Looking for: ${resolved.host}`)
                const found = await this.findAndClickTargetWebsite(page, resolved.url, captchaStrategy)
                if (found && this.verifyPageHost(page, resolved.url)) {
                    organicHit = true
                    hostVerified = true
                    foundWebsite = true
                    discoverySource = 'organic'
                    onSiteStartedAt = Date.now()
                    this.runtime.safeHomeUrl = page.url()
                    this.report('browse', true, 'Website found via Google SERP')
                    await this.cleanupExtraTabs(page, 'after_organic_hit')
                } else if (found && !this.verifyPageHost(page, resolved.url)) {
                    this.report('host_mismatch', false, 'SERP click landed off-target')
                    errorCode = 'host_mismatch'
                }
            }

            // 3) Direct fallback (once) — blocked when requireOrganic
            if (!foundWebsite && !this.isCancelled()) {
                if (config.requireOrganic) {
                    errorCode = 'organic_required'
                    this.report('organic_required', false, 'Direct fallback disabled (requireOrganic)')
                } else {
                    const fallbackOk = await this.tryDirectFallback(page, resolved.url)
                    if (fallbackOk) {
                        hostVerified = true
                        foundWebsite = true
                        discoverySource = 'direct_fallback'
                        organicHit = false
                        errorCode = undefined
                        onSiteStartedAt = Date.now()
                        this.runtime.safeHomeUrl = page.url()
                    } else if (!errorCode) {
                        errorCode = 'unreachable'
                    }
                }
            }

            if (this.isCancelled() && !foundWebsite) {
                interrupted = true
                errorCode = errorCode || 'cancelled'
            }

            // 4) Browse when on target
            if (foundWebsite && hostVerified && !page.isClosed()) {
                siteType = await this.classifyCurrentPage(page)
                const browseOk = await this.runBrowsePlan(page, config, siteType, minDwell, maxDwell)
                if (this.isCancelled()) interrupted = true

                const onSiteDurationSeconds = Math.max(
                    0,
                    Math.round((Date.now() - (onSiteStartedAt ?? Date.now())) / 1000),
                )
                const meaningfulActions = this.actionsLog.filter((action) =>
                    isWebSeoSafeActionId(action.action),
                )

                const quality = assessWebSeoQuality({
                    discoverySource,
                    organicHit,
                    hostVerified,
                    durationSeconds: onSiteDurationSeconds,
                    minTimeOnPageSeconds: minDwell,
                    actionsPerformed: meaningfulActions,
                    requireOrganic: Boolean(config.requireOrganic),
                    siteType,
                    interrupted,
                })

                result.success = browseOk && foundWebsite && hostVerified && !interrupted
                result.foundWebsite = true
                result.organicHit = organicHit
                result.discoverySource = discoverySource
                result.hostVerified = hostVerified
                result.finalUrl = page.isClosed() ? '' : page.url()
                result.siteType = siteType
                result.actionsPerformed = [...this.actionsLog]
                result.durationSeconds = onSiteDurationSeconds
                result.qualityScore = quality.qualityScore
                result.countable = result.success && quality.countable
                result.message = result.success
                    ? (result.countable
                        ? 'SEO flow completed successfully'
                        : 'SEO flow completed but did not meet the quality gate')
                    : 'SEO browsing did not complete'
                if (errorCode) result.errorCode = errorCode
                return result
            }

            // Unreachable / organic_required path
            result.success = false
            result.foundWebsite = foundWebsite
            result.organicHit = organicHit
            result.discoverySource = discoverySource
            result.hostVerified = hostVerified
            result.finalUrl = page.isClosed() ? '' : page.url()
            result.siteType = siteType
            result.actionsPerformed = [...this.actionsLog]
            result.durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
            result.qualityScore = 0
            result.countable = false
            result.errorCode = errorCode
                || (config.requireOrganic && !organicHit ? 'organic_required' : 'unreachable')
            result.message = result.errorCode === 'organic_required'
                ? 'Organic hit required but not found'
                : result.errorCode === 'cancelled'
                    ? 'Cancelled before reaching target'
                    : 'Could not reach website via search or direct URL'
            return result
        } catch (error: unknown) {
            console.error('Error in WebSeoFlow:', error)
            result.success = false
            result.foundWebsite = foundWebsite
            result.organicHit = organicHit
            result.discoverySource = discoverySource
            result.hostVerified = hostVerified
            result.finalUrl = page.isClosed() ? '' : (() => {
                try { return page.url() } catch { return '' }
            })()
            result.siteType = siteType
            result.actionsPerformed = [...this.actionsLog]
            result.durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
            result.qualityScore = 0
            result.countable = false
            result.errorCode = errorCode || 'unknown'
            result.message = unknownErrorMessage(error)
            return result
        } finally {
            this.runtime = null
        }
    }

    /**
     * Public typed browse path for captcha-cooldown engine.
     * Returns boolean success for cooldown accounting.
     */
    async browseWebsiteLikeRealUser(page: Page, config: WebSeoFlowConfig): Promise<boolean> {
        this.actionsLog = []
        const resolved = resolveWebSeoTarget(config.targetDomain)
        if (!resolved.ok) {
            this.report('browse_invalid_target', false, `Invalid target: ${resolved.error}`)
            return false
        }

        const prevRuntime = this.runtime
        this.runtime = {
            targetUrl: resolved.url,
            targetHost: resolved.host,
            deadlineAt: config.deadlineAt,
            shouldStop: config.shouldStop,
            captchaStrategy: config.captchaStrategy || 'manual',
            safeHomeUrl: page.isClosed() ? resolved.url : (this.verifyPageHost(page, resolved.url) ? page.url() : resolved.url),
        }

        try {
            if (page.isClosed()) return false
            if (!this.verifyPageHost(page, resolved.url)) {
                try {
                    await page.goto(resolved.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
                } catch {
                    return false
                }
                if (!this.verifyPageHost(page, resolved.url)) return false
            }

            const minDwell = clampDwellSeconds(config.minTimeOnPageSeconds)
            const maxDwell = clampDwellSeconds(
                Math.max(config.minTimeOnPageSeconds, config.maxTimeOnPageSeconds),
                minDwell,
                300,
            )
            const siteType = await this.classifyCurrentPage(page)
            return await this.runBrowsePlan(page, config, siteType, minDwell, maxDwell)
        } catch (error: unknown) {
            console.error('Error in browseWebsiteLikeRealUser:', error)
            return false
        } finally {
            this.runtime = prevRuntime
        }
    }

    // ==================== CAPTCHA HANDLING ====================

    private isCaptchaOrConsentUrl(url: string): boolean {
        return CaptchaDetector.isCaptchaUrl(url) || (url || '').toLowerCase().includes('consent.google')
    }

    private async hasVisibleCaptchaChallenge(page: Page): Promise<boolean> {
        return CaptchaDetector.isCaptchaPage(page)
    }

    private async tryDismissGoogleConsent(page: Page): Promise<boolean> {
        try {
            const acceptBtn = await page.$(
                'button[id*="accept"], button[id="L2AGLb"], button[aria-label*="Accept"], button:has-text("Accept"), button:has-text("I agree")',
            )
            if (acceptBtn) {
                await acceptBtn.click()
                await HumanBehavior.randomDelay(1000, 2500)
                return true
            }
        } catch {
            // ignore
        }
        return false
    }

    private async detectAndHandleCaptcha(
        page: Page,
        strategy: CaptchaStrategy,
    ): Promise<boolean> {
        try {
            if (this.isCancelled()) return false

            let currentUrl = page.url()

            // Consent page first (live URL)
            if (currentUrl.toLowerCase().includes('consent.google') && !currentUrl.includes('/sorry')) {
                const dismissed = await this.tryDismissGoogleConsent(page)
                currentUrl = page.url()
                if (dismissed && !this.isCaptchaOrConsentUrl(currentUrl)) {
                    this.report('consent_dismissed', true, 'Google consent dismissed')
                    return true
                }
                // Still on consent/sorry — continue into captcha path
            }

            if (!this.isCaptchaOrConsentUrl(currentUrl)) {
                // Ignore passive reCAPTCHA widgets; only a visible challenge with matching text blocks.
                if (!(await this.hasVisibleCaptchaChallenge(page))) return true
            }

            if (strategy === 'auto_skip') {
                this.report('captcha_auto_skip', false, 'Google CAPTCHA detected. Auto-skip search flow.')
                return false
            }

            let hasCaptchaProvider = false
            try {
                const { loadSettings: loadCaptchaSettings } = await import('../ipc/settings')
                const captchaSettings = loadCaptchaSettings()
                hasCaptchaProvider = Boolean(
                    captchaSettings.captchaSolverProvider
                    && captchaSettings.captchaSolverProvider !== 'none'
                    && captchaSettings.captchaSolverApiKey,
                )
            } catch {
                hasCaptchaProvider = false
            }

            if (!hasCaptchaProvider) {
                this.report('captcha_auto_skip', false, 'No CAPTCHA solver configured. Skipping manual solve.')
                return false
            }

            // Auto-solve attempt for interactive/manual mode only.
            this.report('captcha_auto_solve_attempt', true, 'Trying to auto-solve CAPTCHA via API...')
            const solved = await captchaSolverService.solveCaptchaOnPage(page)
            if (solved) {
                await HumanBehavior.randomDelay(1500, 3000)
                const afterSolveUrl = page.url()
                if (!this.isCaptchaOrConsentUrl(afterSolveUrl) && !(await this.hasVisibleCaptchaChallenge(page))) {
                    this.report('captcha_auto_solved', true, 'CAPTCHA solved automatically via API')
                    return true
                }
            }

            // Manual poll — deadline / shouldStop win
            this.report('captcha_detected', false, 'Google CAPTCHA detected. Please solve manually.')
            const start = Date.now()
            const timeoutMs = Math.min(180_000, this.remainingMs())

            while (Date.now() - start < timeoutMs) {
                if (this.isCancelled()) {
                    this.report('captcha_cancelled', false, 'CAPTCHA wait cancelled by deadline/stop')
                    return false
                }
                await HumanBehavior.randomDelay(2000, 3000)
                const live = page.url()
                const stillBlocked = this.isCaptchaOrConsentUrl(live)
                if (!stillBlocked && !(await this.hasVisibleCaptchaChallenge(page))) {
                    this.report('captcha_solved_manual', true, 'Manual CAPTCHA verification completed')
                    await HumanBehavior.randomDelay(1500, 2500)
                    return true
                }
            }

            this.report('captcha_failed', false, 'CAPTCHA was not solved within timeout window')
            return false
        } catch (error: unknown) {
            // Fail-closed: treat captcha handling errors as blocked
            this.report('captcha_error', false, unknownErrorMessage(error))
            return false
        }
    }

    // ==================== GOOGLE SEARCH ====================

    private async searchOnGoogle(
        page: Page,
        keyword: string,
        captchaStrategy: CaptchaStrategy,
    ): Promise<boolean> {
        try {
            if (this.isCancelled()) return false

            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 })
            await HumanBehavior.randomDelay(1000, 2500)
            if (this.isCancelled()) return false

            await this.resolveBlockingPrompt(page, 'search_google_landing')
            await this.tryDismissGoogleConsent(page)
            await this.resolveBlockingPrompt(page, 'search_google_post_consent')

            const captchaOk = await this.detectAndHandleCaptcha(page, captchaStrategy)
            if (!captchaOk || this.isCancelled()) return false

            const searchBox = await page.$('textarea[name="q"], input[name="q"]')
            if (!searchBox) return false

            await HumanBehavior.humanType(page, 'textarea[name="q"], input[name="q"]', keyword)
            await HumanBehavior.randomDelay(500, 1200)
            if (this.isCancelled()) return false

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { }),
                page.keyboard.press('Enter'),
            ])
            await HumanBehavior.randomDelay(2000, 3500)
            if (this.isCancelled()) return false

            await this.resolveBlockingPrompt(page, 'search_results_loaded')
            const captchaOkAfter = await this.detectAndHandleCaptcha(page, captchaStrategy)
            return captchaOkAfter && !this.isCancelled()
        } catch (error: unknown) {
            console.error('Error searching on Google:', error)
            return false
        }
    }

    // ==================== FIND & CLICK TARGET ====================

    private async findAndClickTargetWebsite(
        page: Page,
        targetUrl: string,
        captchaStrategy: CaptchaStrategy,
    ): Promise<boolean> {
        const MAX_PAGES = 3
        const baseUrl = page.url()

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            if (this.isCancelled()) return false
            await this.resolveBlockingPrompt(page, `find_target_page_${pageNum}`)

            const captchaOk = await this.detectAndHandleCaptcha(page, captchaStrategy)
            if (!captchaOk) return false
            if (this.isCancelled()) return false

            await HumanBehavior.randomScroll(page, 2)
            await HumanBehavior.randomDelay(500, 1200)

            const rawLinks = await page.evaluate(() => {
                const selectors = [
                    '#search a[href]',
                    'div.g a[href]',
                    '#rso a[href]',
                    'div[data-sokoban-container] a[href]',
                    '.yuRUbf a[href]',
                ]
                const allLinks: { href: string; text: string }[] = []
                const seen = new Set<string>()
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach((el) => {
                        const anchor = el as HTMLAnchorElement
                        const href = anchor.href
                        if (!href || seen.has(href)) return
                        seen.add(href)
                        allLinks.push({
                            href,
                            text: (anchor.textContent || '').substring(0, 100),
                        })
                    })
                }
                return allLinks
            }).catch(() => [] as { href: string; text: string }[])

            let match: { href: string; dest: string; text: string } | null = null
            for (const link of rawLinks) {
                const dest = extractWebSeoDestination(link.href, baseUrl || page.url())
                if (!dest) continue
                if (isSameWebSeoSite(dest, targetUrl)) {
                    match = { href: link.href, dest, text: link.text }
                    break
                }
            }

            if (match) {
                this.report('found_result', true, `Found: "${match.text || match.dest}"`)
                const clicked = await this.clickSerpResult(page, match.href, match.dest, targetUrl)
                if (clicked) return true
            }

            const nextButton = await page.$('a#pnnext, a[aria-label="Next"]')
            if (nextButton && pageNum < MAX_PAGES && !this.isCancelled()) {
                this.report('next_page', true, `Page ${pageNum}: not found, going next...`)
                await nextButton.hover().catch(() => { })
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { }),
                    nextButton.click(),
                ])
                await HumanBehavior.randomDelay(2000, 3500)
            } else {
                break
            }
        }

        return false
    }

    private async clickSerpResult(
        page: Page,
        href: string,
        dest: string,
        targetUrl: string,
    ): Promise<boolean> {
        try {
            // Prefer selector match on original href
            let targetLink = await page.$(`a[href="${href}"]`)
            if (!targetLink) {
                // Fallback: any anchor whose extracted dest matches
                const anchors = await page.$$('a[href]')
                for (const a of anchors) {
                    const h = await a.evaluate((n) => (n as HTMLAnchorElement).href).catch(() => '')
                    if (!h) continue
                    const d = extractWebSeoDestination(h, page.url())
                    if (d && isSameWebSeoSite(d, targetUrl)) {
                        targetLink = a
                        break
                    }
                }
            }

            if (targetLink) {
                await targetLink.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(400, 900)
                await targetLink.hover().catch(() => { })
                await HumanBehavior.randomDelay(250, 600)
                await targetLink.evaluate((node) => {
                    const anchor = node as HTMLAnchorElement
                    if (anchor && anchor.tagName === 'A') {
                        anchor.target = '_self'
                        anchor.rel = 'noreferrer'
                    }
                }).catch(() => { })

                const [popupPage] = await Promise.all([
                    page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
                    Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { }),
                        targetLink.click(),
                    ]),
                ])

                if (popupPage && !popupPage.isClosed()) {
                    await popupPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { })
                    const popupUrl = popupPage.url()
                    if (isSameWebSeoSite(popupUrl, targetUrl)) {
                        // Navigate original page to popup URL, then close popup
                        await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(async () => {
                            await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { })
                        })
                        await popupPage.close({ runBeforeUnload: false }).catch(() => { })
                    } else {
                        // Off-site popup — close only
                        await popupPage.close({ runBeforeUnload: false }).catch(() => { })
                    }
                }

                await this.cleanupExtraTabs(page, 'after_target_click')
                await HumanBehavior.randomDelay(2000, 4000)

                if (this.verifyPageHost(page, targetUrl)) return true

                // If still on Google, try direct dest navigation
                if (!this.verifyPageHost(page, targetUrl)) {
                    await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 20000 })
                    await HumanBehavior.randomDelay(2000, 4000)
                    await this.cleanupExtraTabs(page, 'serp_goto_dest')
                    return this.verifyPageHost(page, targetUrl)
                }
                return true
            }

            // Last resort: goto unwrapped destination
            await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 20000 })
            await HumanBehavior.randomDelay(2000, 4000)
            await this.cleanupExtraTabs(page, 'fallback_goto_target')
            return this.verifyPageHost(page, targetUrl)
        } catch (error: unknown) {
            this.report('serp_click_error', false, unknownErrorMessage(error))
            return false
        }
    }

    // ==================== DIRECT FALLBACK (single path) ====================

    private async tryDirectFallback(page: Page, targetUrl: string): Promise<boolean> {
        const urls = buildWebSeoFallbackUrls(targetUrl)
        if (urls.length === 0) {
            this.report('fallback_failed', false, 'No safe fallback URLs')
            return false
        }

        this.report('fallback_direct', true, `Navigating directly to ${hostFromUrl(targetUrl) || targetUrl}`)

        for (const url of urls) {
            if (this.isCancelled()) return false
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
                await HumanBehavior.randomDelay(2000, 4000)
                await this.cleanupExtraTabs(page, 'fallback_direct')
                if (this.verifyPageHost(page, targetUrl)) {
                    this.report('fallback_success', true, `Reached via ${url}`)
                    return true
                }
                this.report('fallback_host_mismatch', false, `Landed off-target: ${safeUrlForLog(page.url())}`)
            } catch {
                // try next variant
            }
        }

        this.report('fallback_failed', false, 'Could not reach website via direct URL')
        return false
    }

    // ==================== CLASSIFY + BROWSE PLAN ====================

    private async classifyCurrentPage(page: Page): Promise<WebSeoSiteType> {
        try {
            const sample = await page.evaluate(() => {
                const title = document.title || ''
                const body = (document.body?.innerText || '').slice(0, 2500)
                const hints: string[] = []
                document.querySelectorAll('[itemtype], [class*="product"], [class*="price"], article, .blog').forEach((el) => {
                    const cls = (el as HTMLElement).className
                    if (typeof cls === 'string' && cls) hints.push(cls.slice(0, 80))
                    const itemtype = el.getAttribute('itemtype')
                    if (itemtype) hints.push(itemtype)
                })
                return { title, body, hints: hints.slice(0, 20) }
            })
            return classifyWebSeoSite({
                url: page.url(),
                title: sample.title,
                textSample: sample.body,
                htmlHints: sample.hints,
            })
        } catch {
            return classifyWebSeoSite({ url: page.url() })
        }
    }

    private async runBrowsePlan(
        page: Page,
        config: WebSeoFlowConfig,
        siteType: WebSeoSiteType,
        minDwell: number,
        maxDwell: number,
    ): Promise<boolean> {
        const target = this.runtime?.targetUrl || config.targetDomain
        const dwellSeconds = Math.floor(Math.random() * (maxDwell - minDwell + 1)) + minDwell
        let timeBudgetMs = dwellSeconds * 1000

        // Deadline wins over dwell
        const remaining = this.remainingMs()
        if (Number.isFinite(remaining)) {
            timeBudgetMs = Math.min(timeBudgetMs, remaining)
        }

        const startTime = Date.now()
        const maxActions = Math.min(16, Math.max(6, Math.floor(timeBudgetMs / 4000) + 4))
        const plan = buildWebSeoActionPlan(siteType, {
            maxActions,
            keyword: config.keyword,
            targetHost: this.runtime?.targetHost,
        })

        // Deduplicate plan (policy already unique; defense in depth)
        const seen = new Set<WebSeoSafeActionId>()
        const uniquePlan: WebSeoSafeActionId[] = []
        for (const id of plan) {
            if (seen.has(id)) continue
            seen.add(id)
            uniquePlan.push(id)
        }

        let actionsDone = 0
        try {
            for (const actionId of uniquePlan) {
                if (this.isCancelled()) break
                if (Date.now() - startTime >= timeBudgetMs) break
                if (page.isClosed()) break

                await this.resolveBlockingPrompt(page, `browse_${actionId}`)
                if (this.isCancelled()) break

                const actionStart = Date.now()
                let ok = true
                try {
                    await this.runSafeAction(page, actionId, target)
                } catch {
                    ok = false
                }

                // Same-site guard after every action
                const stillOnSite = await this.ensureSameSite(page, target, actionId)
                if (!stillOnSite && !this.verifyPageHost(page, target)) {
                    ok = false
                } else if (!this.verifyPageHost(page, target)) {
                    ok = false
                }

                const durationMs = Date.now() - actionStart
                // Update last log entry duration if report was called inside action
                if (this.actionsLog.length > 0) {
                    const last = this.actionsLog[this.actionsLog.length - 1]
                    if (last.action === actionId || last.action.startsWith(actionId)) {
                        last.durationMs = durationMs
                        if (!ok) last.success = false
                    } else {
                        this.report(actionId, ok, ok ? undefined : 'action failed or left site', durationMs)
                    }
                } else {
                    this.report(actionId, ok, undefined, durationMs)
                }

                await this.cleanupExtraTabs(page, `browse_action_${actionId}`)
                actionsDone++
                if (this.isCancelled()) break
                await HumanBehavior.randomDelay(800, 2000)
            }

            // Keep a real on-site dwell window even when site-specific actions finish quickly.
            while (!this.isCancelled() && !page.isClosed() && Date.now() - startTime < timeBudgetMs) {
                const remainingBudget = timeBudgetMs - (Date.now() - startTime)
                if (remainingBudget <= 0) break
                if (Math.random() > 0.55) {
                    await page.evaluate(() => window.scrollBy({
                        top: 80 + Math.random() * 180,
                        behavior: 'smooth',
                    })).catch(() => { })
                }
                const pauseMs = Math.min(remainingBudget, 900 + Math.floor(Math.random() * 1100))
                await new Promise((resolve) => setTimeout(resolve, pauseMs))
            }

            if (!this.isCancelled() && Math.random() > 0.4 && !page.isClosed()) {
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => { })
                await HumanBehavior.randomDelay(600, 1200)
            }

            const elapsed = Math.round((Date.now() - startTime) / 1000)
            const completed = !this.isCancelled() && actionsDone > 0 && this.verifyPageHost(page, target)
            this.report('browse_complete', completed, `Done: ${elapsed}s, ${actionsDone} actions`)
            return completed
        } catch (error: unknown) {
            console.error('Error browsing website:', error)
            return false
        }
    }

    // ==================== SAFE READ-ONLY ACTIONS ====================

    private async runSafeAction(page: Page, actionId: WebSeoSafeActionId, target: string): Promise<void> {
        switch (actionId) {
            case 'scroll_read':
                return this.actionScrollReadContent(page)
            case 'scroll_updown':
                return this.actionScrollUpDown(page)
            case 'mouse_move':
                return this.actionRandomMouseMovement(page)
            case 'view_images':
                return this.actionViewImages(page)
            case 'gallery_browse':
                return this.actionClickProductImageGallery(page)
            case 'hover_elements':
                return this.actionHoverElements(page)
            case 'read_details':
                return this.actionReadProductDetails(page)
            case 'check_price':
                return this.actionCheckPricing(page)
            case 'product_tabs':
                return this.actionClickProductTabs(page)
            case 'read_reviews':
                return this.actionReadReviews(page)
            case 'expand_faq':
                return this.actionExpandAccordionFAQ(page)
            case 'scroll_section':
                return this.actionScrollToSpecificSection(page)
            case 'view_breadcrumb':
                return this.actionViewBreadcrumb(page)
            case 'view_policy':
                return this.actionViewPolicyPages(page, target)
            case 'click_internal':
                return this.actionClickInternalLink(page, target)
            case 'view_footer':
                return this.actionScrollToFooter(page)
            case 'zoom_image':
                return this.actionZoomImage(page)
            case 'highlight_text':
                return this.actionHighlightText(page)
            case 'related_hover':
                return this.actionViewRelatedProductsHover(page)
            case 'view_social':
                return this.actionViewSocialLinks(page)
            case 'view_menu':
                return this.actionViewMenuNav(page)
            case 'resize_scroll':
                return this.actionResizeAndScroll(page)
            default: {
                // Exhaustive guard — never run unknown / dangerous actions
                const _never: never = actionId
                void _never
                this.report('unknown_action', false, `Skipped unsafe/unknown action`)
            }
        }
    }

    private async actionScrollReadContent(page: Page): Promise<void> {
        this.report('scroll_read', true, 'Reading page content...')
        const count = Math.floor(Math.random() * 4) + 2
        for (let i = 0; i < count; i++) {
            if (this.isCancelled()) return
            await page.evaluate(() => window.scrollBy({ top: 150 + Math.random() * 350, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(1200, 2800)
        }
    }

    private async actionScrollUpDown(page: Page): Promise<void> {
        this.report('scroll_updown', true, 'Scrolling up and down...')
        await page.evaluate(() => window.scrollBy({ top: 400 + Math.random() * 500, behavior: 'smooth' }))
        await HumanBehavior.randomDelay(800, 1500)
        await page.evaluate(() => window.scrollBy({ top: -(200 + Math.random() * 300), behavior: 'smooth' }))
        await HumanBehavior.randomDelay(800, 1500)
        await page.evaluate(() => window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'smooth' }))
        await HumanBehavior.randomDelay(600, 1200)
    }

    private async actionRandomMouseMovement(page: Page): Promise<void> {
        this.report('mouse_move', true, 'Moving mouse naturally...')
        try {
            const vp = page.viewportSize()
            if (!vp) return
            for (let i = 0; i < 4; i++) {
                if (this.isCancelled()) return
                const mx = Math.floor(Math.random() * vp.width)
                const my = Math.floor(Math.random() * vp.height)
                await moveCursor(page, mx, my)
                await page.mouse.move(mx, my, { steps: 10 + Math.floor(Math.random() * 20) })
                await HumanBehavior.randomDelay(150, 400)
            }
        } catch {
            // ignore
        }
    }

    private async actionScrollToFooter(page: Page): Promise<void> {
        this.report('view_footer', true, 'Viewing footer section...')
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }))
        await HumanBehavior.randomDelay(1500, 3000)
        const links = await page.$$('footer a')
        if (links.length > 0) {
            const l = links[Math.floor(Math.random() * Math.min(links.length, 5))]
            await l.hover().catch(() => { })
            await HumanBehavior.randomDelay(400, 1000)
        }
    }

    private async actionViewImages(page: Page): Promise<void> {
        this.report('view_images', true, 'Viewing images...')
        const sels = [
            '.product-image img', '.gallery img', '.swiper-slide img',
            '.product-gallery img', '.thumbnail img', 'figure img', 'img[alt]',
        ]
        for (const sel of sels) {
            const imgs = await page.$$(sel)
            if (imgs.length === 0) continue
            const img = imgs[Math.floor(Math.random() * Math.min(imgs.length, 5))]
            await img.scrollIntoViewIfNeeded().catch(() => { })
            await HumanBehavior.randomDelay(400, 900)
            await img.hover().catch(() => { })
            await HumanBehavior.randomDelay(800, 1600)
            return
        }
    }

    private async actionClickProductImageGallery(page: Page): Promise<void> {
        this.report('gallery_browse', true, 'Browsing image gallery...')
        const thumbSels = [
            '.thumbnail img', '.product-thumbnails img', '.slick-dots li',
            '.swiper-pagination-bullet', '.owl-dot', '.gallery-thumb img',
        ]
        for (const sel of thumbSels) {
            const thumbs = await page.$$(sel)
            if (thumbs.length < 2) continue
            const count = Math.min(thumbs.length, 3)
            for (let i = 0; i < count; i++) {
                if (this.isCancelled()) return
                await thumbs[i].click().catch(() => { })
                await HumanBehavior.randomDelay(700, 1500)
            }
            return
        }
        const navBtns = await page.$$('.swiper-button-next, .slick-next, .owl-next, .gallery-next')
        if (navBtns.length > 0) {
            await navBtns[0].click().catch(() => { })
            await HumanBehavior.randomDelay(700, 1400)
        }
    }

    private async actionZoomImage(page: Page): Promise<void> {
        this.report('zoom_image', true, 'Inspecting product image...')
        const imgSels = ['.product-image img', '.main-image img', '.product img', 'figure img']
        for (const sel of imgSels) {
            const img = await page.$(sel)
            if (!img) continue
            await img.scrollIntoViewIfNeeded().catch(() => { })
            await img.hover().catch(() => { })
            await HumanBehavior.randomDelay(400, 800)
            // Hover-only zoom simulation — avoid external lightbox navigation
            const box = await img.boundingBox().catch(() => null)
            if (box) {
                const centerX = box.x + box.width / 2
                const centerY = box.y + box.height / 2
                await moveCursor(page, centerX, centerY)
                await page.mouse.move(centerX, centerY).catch(() => { })
                await page.mouse.wheel(0, -180).catch(() => { })
                await HumanBehavior.randomDelay(400, 800)
                await page.mouse.wheel(0, 160).catch(() => { })
            }
            return
        }
    }

    private async actionReadProductDetails(page: Page): Promise<void> {
        this.report('read_details', true, 'Reading details...')
        const sels = [
            '.product-description', '.product-detail', '.product-info',
            '.description', '.chi-tiet', '.mo-ta', 'article', '.entry-content',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (!el) continue
            await el.scrollIntoViewIfNeeded().catch(() => { })
            await HumanBehavior.randomDelay(800, 1500)
            for (let i = 0; i < 3; i++) {
                if (this.isCancelled()) return
                await page.evaluate(() => window.scrollBy({ top: 180, behavior: 'smooth' }))
                await HumanBehavior.randomDelay(1000, 2200)
            }
            return
        }
        for (let i = 0; i < 2; i++) {
            await page.evaluate(() => window.scrollBy({ top: 250, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(1000, 2000)
        }
    }

    private async actionCheckPricing(page: Page): Promise<void> {
        this.report('check_price', true, 'Checking price...')
        const sels = [
            '.price', '.product-price', '.gia', '.current-price', '.sale-price',
            '[class*="price"]', '[class*="gia"]',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (!el) continue
            await el.scrollIntoViewIfNeeded().catch(() => { })
            await el.hover().catch(() => { })
            await HumanBehavior.randomDelay(1000, 2000)
            return
        }
    }

    private async actionClickProductTabs(page: Page): Promise<void> {
        this.report('product_tabs', true, 'Viewing product tabs...')
        const tabSels = [
            '.product-tabs a', '.tab-link', '.nav-tabs a', '.tab-title',
            '[role="tab"]', '.tabs a',
        ]
        for (const sel of tabSels) {
            const tabs = await page.$$(sel)
            if (tabs.length < 2) continue
            const count = Math.min(tabs.length, 2)
            for (let i = 0; i < count; i++) {
                if (this.isCancelled()) return
                const tab = tabs[Math.floor(Math.random() * tabs.length)]
                const signal = await tab.evaluate((node) => ({
                    label: (node.textContent || '').trim(),
                    href: node instanceof HTMLAnchorElement ? node.href : '',
                })).catch(() => ({ label: '', href: '' }))
                if (isDangerousInteractiveTarget(signal.label, signal.href)) continue
                await tab.scrollIntoViewIfNeeded().catch(() => { })
                await tab.click().catch(() => { })
                await HumanBehavior.randomDelay(1200, 2400)
            }
            return
        }
    }

    private async actionReadReviews(page: Page): Promise<void> {
        this.report('read_reviews', true, 'Reading reviews...')
        const reviewSels = [
            '.reviews', '.product-reviews', '.customer-reviews',
            '#reviews', '.comment-list', '.danh-gia', '[class*="review"]',
        ]
        for (const sel of reviewSels) {
            const el = await page.$(sel)
            if (!el) continue
            await el.scrollIntoViewIfNeeded().catch(() => { })
            await HumanBehavior.randomDelay(800, 1600)
            for (let i = 0; i < 2; i++) {
                await page.evaluate(() => window.scrollBy({ top: 180, behavior: 'smooth' }))
                await HumanBehavior.randomDelay(1000, 2000)
            }
            return
        }
    }

    private async actionExpandAccordionFAQ(page: Page): Promise<void> {
        this.report('expand_faq', true, 'Reading FAQ / accordion...')
        const sels = [
            '.accordion-header', '.faq-question', '.collapse-header',
            '[data-toggle="collapse"]', '.accordion-button', 'details summary',
        ]
        for (const sel of sels) {
            const items = await page.$$(sel)
            if (items.length === 0) continue
            const count = Math.min(items.length, 2)
            for (let i = 0; i < count; i++) {
                if (this.isCancelled()) return
                const item = items[Math.floor(Math.random() * items.length)]
                const signal = await item.evaluate((node) => ({
                    label: (node.textContent || '').trim(),
                    href: node instanceof HTMLAnchorElement ? node.href : '',
                })).catch(() => ({ label: '', href: '' }))
                if (isDangerousInteractiveTarget(signal.label, signal.href)) continue
                await item.scrollIntoViewIfNeeded().catch(() => { })
                await item.click().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
            }
            return
        }
    }

    private async actionHighlightText(page: Page): Promise<void> {
        this.report('highlight_text', true, 'Selecting text to read...')
        try {
            const paragraphs = await page.$$('p, .description, .product-content, article')
            if (paragraphs.length === 0) return
            const p = paragraphs[Math.floor(Math.random() * Math.min(paragraphs.length, 5))]
            await p.scrollIntoViewIfNeeded().catch(() => { })
            const box = await p.boundingBox()
            if (!box) return
            await moveCursor(page, box.x + 10, box.y + box.height / 2)
            await page.mouse.move(box.x + 10, box.y + box.height / 2)
            await page.mouse.down()
            await page.mouse.move(box.x + Math.min(box.width * 0.6, 250), box.y + box.height / 2, { steps: 12 })
            await HumanBehavior.randomDelay(600, 1200)
            await page.mouse.up()
            await HumanBehavior.randomDelay(600, 1200)
            await clickCursor(page, box.x + box.width / 2, box.y + box.height + 16).catch(() => { })
            await page.mouse.click(box.x + box.width / 2, box.y + box.height + 16).catch(() => { })
        } catch {
            // ignore
        }
    }

    private async actionScrollToSpecificSection(page: Page): Promise<void> {
        this.report('scroll_section', true, 'Jumping to section...')
        const sels = [
            '#description', '#reviews', '#specifications', '#details',
            '.product-description', '.about-section', '.features', 'h2', 'h3',
        ]
        const randomSel = sels[Math.floor(Math.random() * sels.length)]
        try {
            const el = await page.$(randomSel)
            if (!el) return
            await el.scrollIntoViewIfNeeded().catch(() => { })
            await HumanBehavior.randomDelay(1200, 2400)
            await page.evaluate(() => window.scrollBy({ top: 160, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(800, 1500)
        } catch {
            // ignore
        }
    }

    private async actionViewBreadcrumb(page: Page): Promise<void> {
        this.report('view_breadcrumb', true, 'Viewing breadcrumb...')
        const bcSels = ['.breadcrumb a', '.breadcrumbs a', '[class*="breadcrumb"] a', 'nav[aria-label="Breadcrumb"] a']
        for (const sel of bcSels) {
            const items = await page.$$(sel)
            if (items.length < 1) continue
            const mid = items[Math.floor(Math.random() * items.length)]
            await mid.hover().catch(() => { })
            await HumanBehavior.randomDelay(500, 1000)
            // Hover only — avoid accidental off-site or deep navigation
            return
        }
    }

    private async actionViewPolicyPages(page: Page, target: string): Promise<void> {
        this.report('view_policy', true, 'Viewing policy page...')
        const sels = [
            'a[href*="chinh-sach"]', 'a[href*="policy"]', 'a[href*="bao-hanh"]',
            'a[href*="doi-tra"]', 'a[href*="shipping"]', 'a[href*="van-chuyen"]',
            'a[href*="return"]', 'a[href*="warranty"]', 'a[href*="terms"]',
        ]
        for (const sel of sels) {
            try {
                const el = await page.$(sel)
                if (!el || !(await el.isVisible().catch(() => false))) continue
                const href = await el.evaluate((n) => (n as HTMLAnchorElement).href).catch(() => '')
                if (href && !isSameWebSeoSite(href, target)) continue
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(400, 800)
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                    el.click(),
                ]).catch(() => { })
                await HumanBehavior.randomDelay(1500, 3000)
                if (!this.verifyPageHost(page, target)) {
                    await page.goBack().catch(() => { })
                    return
                }
                await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'smooth' }))
                await HumanBehavior.randomDelay(1000, 2000)
                await page.goBack().catch(() => { })
                await HumanBehavior.randomDelay(600, 1200)
                return
            } catch {
                // next
            }
        }
    }

    private async actionClickInternalLink(page: Page, target: string): Promise<void> {
        this.report('click_internal', true, 'Clicking internal link...')
        const links = await page.$$('a[href]')
        const internal: typeof links = []
        for (const l of links) {
            try {
                const href = await l.evaluate((n) => (n as HTMLAnchorElement).href)
                if (!href || href.includes('#') || /^(javascript|tel|mailto):/i.test(href)) continue
                if (!isSameWebSeoSite(href, target)) continue
                if (!(await l.isVisible().catch(() => false))) continue
                internal.push(l)
            } catch {
                // stale
            }
        }
        if (internal.length === 0) return
        const link = internal[Math.floor(Math.random() * internal.length)]
        await link.scrollIntoViewIfNeeded().catch(() => { })
        await link.hover().catch(() => { })
        await HumanBehavior.randomDelay(400, 800)
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => { }),
            link.click(),
        ]).catch(() => { })
        await HumanBehavior.randomDelay(1200, 2400)
    }

    private async actionViewRelatedProductsHover(page: Page): Promise<void> {
        this.report('related_hover', true, 'Viewing related products...')
        const sels = [
            '.related-products a', '.product-related a', '.upsell a',
            '.san-pham-lien-quan a', '[class*="related"] a', '.also-like a',
        ]
        for (const sel of sels) {
            const items = await page.$$(sel)
            if (items.length === 0) continue
            const item = items[Math.floor(Math.random() * Math.min(items.length, 5))]
            await item.scrollIntoViewIfNeeded().catch(() => { })
            await item.hover().catch(() => { })
            await HumanBehavior.randomDelay(1000, 2000)
            // Hover only — no navigation to avoid off-site / deep trees
            return
        }
    }

    private async actionViewSocialLinks(page: Page): Promise<void> {
        this.report('view_social', true, 'Viewing social media links...')
        const sels = [
            'a[href*="facebook.com"]', 'a[href*="instagram.com"]',
            'a[href*="youtube.com"]', 'a[href*="tiktok.com"]',
            '.social a', '.social-links a',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (!el) continue
            await el.scrollIntoViewIfNeeded().catch(() => { })
            await el.hover().catch(() => { })
            await HumanBehavior.randomDelay(800, 1600)
            // Hover only — never click external social
            return
        }
    }

    private async actionViewMenuNav(page: Page): Promise<void> {
        this.report('view_menu', true, 'Browsing menu...')
        const sels = ['nav a', '.navbar a', '.main-menu a', '.menu a', 'header a', '.nav-link']
        for (const sel of sels) {
            const items = await page.$$(sel)
            const visible = []
            for (const it of items) {
                if (await it.isVisible().catch(() => false)) visible.push(it)
            }
            if (visible.length === 0) continue
            const t = visible[Math.floor(Math.random() * visible.length)]
            await t.hover().catch(() => { })
            await HumanBehavior.randomDelay(600, 1200)
            // Prefer hover; light same-site click only when href is same-site
            const href = await t.evaluate((n) => (n as HTMLAnchorElement).href).catch(() => '')
            const target = this.runtime?.targetUrl
            if (href && target && isSameWebSeoSite(href, target) && Math.random() > 0.5) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                    t.click(),
                ]).catch(() => { })
                await HumanBehavior.randomDelay(1200, 2200)
            }
            return
        }
    }

    private async actionHoverElements(page: Page): Promise<void> {
        this.report('hover_elements', true, 'Hovering interactive elements...')
        const sels = [
            'a.btn, button.btn',
            'a[href*="product"]', 'a[href*="san-pham"]',
            '.card', '.product-card', 'nav a', '.menu a',
        ]
        for (const sel of sels) {
            const els = await page.$$(sel)
            if (els.length === 0) continue
            const el = els[Math.floor(Math.random() * Math.min(els.length, 5))]
            await el.scrollIntoViewIfNeeded().catch(() => { })
            await el.hover().catch(() => { })
            await HumanBehavior.randomDelay(600, 1400)
            return
        }
    }

    private async actionResizeAndScroll(page: Page): Promise<void> {
        this.report('resize_scroll', true, 'Adjusting view...')
        try {
            const height = await page.evaluate(() => document.body.scrollHeight)
            const randomPos = Math.floor(Math.random() * height * 0.7)
            await page.evaluate((pos) => window.scrollTo({ top: pos, behavior: 'smooth' }), randomPos)
            await HumanBehavior.randomDelay(1200, 2400)
            await page.evaluate(() => window.scrollBy({ top: -200, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(600, 1200)
        } catch {
            // ignore
        }
    }
}
