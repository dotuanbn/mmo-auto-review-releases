/**
 * MapsWebsiteVisit — Bounded, non-blocking helper for clicking the Maps
 * website button and visiting the destination page.
 *
 * Contract (see memory/tasks/2026-11-26-maps-website-timeout/task.md):
 * - One shared load budget of 8 seconds from action start (includes click,
 *   popup/same-tab discovery, and readiness). No stacked retries on dead sites.
 * - Require a committed HTTP(S) page, document readiness, and positive usable
 *   content; blank pages, browser errors, network failures, and HTTP error
 *   documents (>= 400) must not count as loaded.
 * - Total website work at most 30 seconds plus bounded cleanup/recovery; every
 *   promise respects the remaining deadline and cleans up its timers/listeners.
 * - On load failure: close newly created popups (including late popups),
 *   restore the original Maps URL on same-tab navigation, record
 *   `website_skipped_*`, notify status, and return promptly.
 * - Never close the Maps page or preexisting unrelated tabs; never claim Maps
 *   restoration succeeded if it did not.
 */

import type { BrowserContext, Frame, Locator, Page, Request, Response } from 'playwright'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MapsWebsiteVisitOptions {
    /** Cooperative stop signal checked between and within phases. */
    shouldStop?: () => boolean
    /** Status callback for UI / log updates. */
    onStatus?: (message: string) => void
    /** Optional load budget override (defaults to 8_000 ms). */
    loadBudgetMs?: number
    /** Optional total budget override (defaults to 30_000 ms). */
    totalBudgetMs?: number
    /** Optional dwell range override in ms (defaults to [10_000, 22_000]). */
    dwellRangeMs?: [number, number]
}

export interface MapsWebsiteVisitResult {
    /** Whether the website link was actually clicked. */
    clicked: boolean
    /** Whether the destination page loaded usable content within budget. */
    loaded: boolean
    /** Whether the original Maps page context is intact/restored on return. */
    mapRestored: boolean
    /** Evidence action labels recorded during this visit. */
    actions: string[]
    /** Human-readable outcome detail. */
    detail: string
    /** Elapsed wall-clock milliseconds from entry to return. */
    durationMs: number
    /** Whether the website was skipped (click fail, load failure, stopped, etc.). */
    skipped: boolean
}

interface PageNavigationSignals {
    httpErrorStatus: number | null
    networkErrorText: string | null
    domContentLoadedSeen: boolean
    navigatedUrl: string | null
    closed: boolean
    openedAt: number
}

interface UsablePageCheck {
    usable: boolean
    httpErrorStatus: number | null
}

type UnsubscribeFn = () => void

interface EmitterLike {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    off(event: string, listener: (...args: unknown[]) => void): unknown
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOAD_BUDGET_MS = 8_000
const DEFAULT_TOTAL_BUDGET_MS = 30_000
const DEFAULT_MIN_DWELL_MS = 10_000
const DEFAULT_MAX_DWELL_MS = 22_000
const POPUP_BLANK_GRACE_MS = 2_500
const POLL_INTERVAL_MS = 120
const RESTORE_GOTO_TIMEOUT_MS = 8_000
const RESTORE_GOBACK_TIMEOUT_MS = 6_000
const POPUP_CLOSE_TIMEOUT_MS = 2_500

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomInt(min: number, max: number): number {
    if (max <= min) return min
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function remainingMs(deadlineMs: number): number {
    return Math.max(0, deadlineMs - Date.now())
}

function isMapsUrl(url: string): boolean {
    const lower = (url || '').toLowerCase()
    return lower.includes('google.') && lower.includes('map')
}

function isErrorUrl(url: string): boolean {
    const lower = (url || '').toLowerCase()
    return lower.startsWith('chrome-error://')
        || lower.startsWith('edge-error://')
        || lower.startsWith('about:neterror')
        || lower === 'about:blank'
}

function isGoogleInterstitialUrl(url: string): boolean {
    const lower = (url || '').toLowerCase()
    if (!/^https?:\/\//i.test(lower)) return false
    if (isMapsUrl(lower)) return false
    try {
        const host = new URL(lower).hostname
        return host === 'google.com' || host.endsWith('.google.com') || /^www\.google\./i.test(host)
    } catch {
        return lower.includes('google.')
    }
}

function isSamePageOrigin(currentUrl: string, originalUrl: string): boolean {
    if (!currentUrl) return false
    if (currentUrl === originalUrl) return true
    if (isMapsUrl(originalUrl)) {
        return isMapsUrl(currentUrl)
    }
    try {
        const cur = new URL(currentUrl)
        const orig = new URL(originalUrl)
        return cur.origin === orig.origin && cur.pathname === orig.pathname
    } catch {
        return false
    }
}

function classifyNetworkSkipAction(errorText: string): string {
    const upper = errorText.toUpperCase()
    if (upper.includes('ERR_NAME_NOT_RESOLVED') || upper.includes('DNS')) {
        return 'website_skipped_dns'
    }
    if (upper.includes('PROXY') || upper.includes('TUNNEL')) {
        return 'website_skipped_proxy'
    }
    if (upper.includes('TIMED_OUT') || upper.includes('TIMEOUT')) {
        return 'website_skipped_timeout'
    }
    return 'website_skipped_network'
}

function asEmitter(target: unknown): EmitterLike | null {
    if (!target || typeof target !== 'object') return null
    const candidate = target as Partial<EmitterLike>
    if (typeof candidate.on === 'function' && typeof candidate.off === 'function') {
        return candidate as EmitterLike
    }
    return null
}

function attachListener(
    target: unknown,
    event: string,
    handler: (...args: unknown[]) => void
): UnsubscribeFn {
    const emitter = asEmitter(target)
    if (!emitter) return () => {}
    emitter.on(event, handler)
    return () => {
        try {
            emitter.off(event, handler)
        } catch {
            // Best-effort listener detachment.
        }
    }
}

/**
 * Race an async Playwright operation against a hard millisecond budget while
 * always clearing the timeout handle and swallowing post-timeout rejections.
 */
async function withBoundedTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    fallbackValue: T
): Promise<{ timedOut: boolean; value: T }> {
    if (timeoutMs <= 0) {
        operation.catch(() => {})
        return { timedOut: true, value: fallbackValue }
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    return new Promise<{ timedOut: boolean; value: T }>((resolve) => {
        timer = setTimeout(() => {
            if (settled) return
            settled = true
            operation.catch(() => {})
            resolve({ timedOut: true, value: fallbackValue })
        }, timeoutMs)

        operation.then(
            (value) => {
                if (settled) return
                settled = true
                if (timer) clearTimeout(timer)
                resolve({ timedOut: false, value })
            },
            () => {
                if (settled) return
                settled = true
                if (timer) clearTimeout(timer)
                resolve({ timedOut: false, value: fallbackValue })
            }
        )
    })
}

/** Sleep up to `durationMs` while waking early if stopped or page closed. */
async function sleepInterruptible(
    durationMs: number,
    shouldWake: () => boolean
): Promise<void> {
    if (durationMs <= 0 || shouldWake()) return
    const deadline = Date.now() + durationMs

    while (!shouldWake()) {
        const left = deadline - Date.now()
        if (left <= 0) break
        const step = Math.min(left, POLL_INTERVAL_MS)
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, step)
            // Unref not used so Node/Vitest fake timers work deterministically.
            void timer
        })
    }
}

function safeRequestFrame(target: { frame?: () => Frame } | null | undefined): Frame | null {
    if (!target || typeof target.frame !== 'function') return null
    try {
        return target.frame()
    } catch {
        // Playwright throws on provisional popup navigation requests before frame creation.
        return null
    }
}

function safeFramePage(frame: Frame | null | undefined): Page | null {
    if (!frame) return null
    const maybeFrame = frame as unknown as { page?: () => Page }
    if (typeof maybeFrame.page !== 'function') return null
    try {
        return maybeFrame.page()
    } catch {
        return null
    }
}

/**
 * Attach main-frame navigation listeners (`response`, `requestfailed`,
 * `framenavigated`, `domcontentloaded`, `close`) and return signals + cleanup.
 */
function safeMainFrame(targetPage: Page): Frame | null {
    const maybePage = targetPage as unknown as { mainFrame?: () => Frame }
    if (typeof maybePage.mainFrame !== 'function') return null
    try {
        return maybePage.mainFrame()
    } catch {
        return null
    }
}

function observePageNavigation(
    targetPage: Page,
    options: { ignoreUrlCheck?: (url: string) => boolean; initialUrl?: string } = {}
): { signals: PageNavigationSignals; dispose: UnsubscribeFn } {
    const signals: PageNavigationSignals = {
        httpErrorStatus: null,
        networkErrorText: null,
        domContentLoadedSeen: false,
        navigatedUrl: options.initialUrl ?? null,
        closed: targetPage.isClosed(),
        openedAt: Date.now(),
    }

    const mainFrame = safeMainFrame(targetPage)
    const isMainFrame = (frame: Frame | null | undefined): boolean => {
        if (!mainFrame || !frame) return true
        return frame === mainFrame
    }

    const onResponse = (rawRes: unknown): void => {
        const res = rawRes as Partial<Response>
        if (!res || typeof res.status !== 'function') return
        const req = typeof res.request === 'function' ? res.request() : null
        const reqUrl = req && typeof req.url === 'function'
            ? req.url()
            : (typeof res.url === 'function' ? res.url() : '')
        if (req && typeof req.isNavigationRequest === 'function' && !req.isNavigationRequest()) {
            return
        }
        const frame = safeRequestFrame(res as { frame?: () => Frame })
        if (!isMainFrame(frame)) return
        if (options.ignoreUrlCheck && reqUrl && options.ignoreUrlCheck(reqUrl)) return

        const status = res.status()
        if (status >= 400) {
            signals.httpErrorStatus = status
        }
    }

    const onRequestFailed = (rawReq: unknown): void => {
        const req = rawReq as Partial<Request>
        if (!req) return
        if (typeof req.isNavigationRequest === 'function' && !req.isNavigationRequest()) {
            return
        }
        const frame = safeRequestFrame(req as { frame?: () => Frame })
        if (!isMainFrame(frame)) return
        const reqUrl = typeof req.url === 'function' ? req.url() : ''
        if (options.ignoreUrlCheck && reqUrl && options.ignoreUrlCheck(reqUrl)) return

        const failure = typeof req.failure === 'function' ? req.failure() : null
        const errorText = failure?.errorText || 'net::ERR_FAILED'
        if (!/ERR_ABORTED/i.test(errorText)) {
            signals.networkErrorText = errorText
        }
    }

    const onFrameNavigated = (rawFrame: unknown): void => {
        const frame = rawFrame as Partial<Frame>
        if (!isMainFrame(frame as Frame)) return
        if (typeof frame?.url === 'function') {
            signals.navigatedUrl = frame.url()
        } else {
            signals.navigatedUrl = targetPage.url()
        }
        signals.domContentLoadedSeen = false
    }

    const onDomContentLoaded = (): void => {
        signals.domContentLoadedSeen = true
    }

    const onClose = (): void => {
        signals.closed = true
    }

    const unsubs: UnsubscribeFn[] = [
        attachListener(targetPage, 'response', onResponse),
        attachListener(targetPage, 'requestfailed', onRequestFailed),
        attachListener(targetPage, 'framenavigated', onFrameNavigated),
        attachListener(targetPage, 'domcontentloaded', onDomContentLoaded),
        attachListener(targetPage, 'close', onClose),
    ]

    return {
        signals,
        dispose: () => {
            for (const unsub of unsubs) {
                unsub()
            }
        },
    }
}

/**
 * Inspect committed URL, HTTP status (via PerformanceNavigationTiming), DOM
 * readiness, and visible body text (> 50 chars).
 */
async function checkUsablePage(
    targetPage: Page,
    maxWaitMs: number,
    originalMapsUrl: string
): Promise<UsablePageCheck> {
    if (targetPage.isClosed() || maxWaitMs <= 0) {
        return { usable: false, httpErrorStatus: null }
    }
    const url = targetPage.url()
    if (!url || isErrorUrl(url)) {
        return { usable: false, httpErrorStatus: null }
    }
    if (!/^https?:\/\//i.test(url)) {
        return { usable: false, httpErrorStatus: null }
    }
    if (isSamePageOrigin(url, originalMapsUrl) || isGoogleInterstitialUrl(url)) {
        return { usable: false, httpErrorStatus: null }
    }

    const result = await withBoundedTimeout<UsablePageCheck>(
        targetPage.evaluate(() => {
            const navEntries = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
                ? performance.getEntriesByType('navigation')
                : []
            const firstNav = navEntries[0] as { responseStatus?: number } | undefined
            const status = firstNav && typeof firstNav.responseStatus === 'number'
                ? firstNav.responseStatus
                : null
            if (status !== null && status >= 400) {
                return { usable: false, httpErrorStatus: status }
            }

            const readyState = document.readyState
            if (readyState !== 'interactive' && readyState !== 'complete') {
                return { usable: false, httpErrorStatus: null }
            }
            const text = (document.body?.innerText || '').trim()
            return { usable: text.length > 50, httpErrorStatus: null }
        }).then((raw) => {
            // Backward compatibility with minimal unit test stubs returning boolean.
            if (typeof raw === 'boolean') {
                return { usable: raw, httpErrorStatus: null }
            }
            if (raw && typeof raw === 'object') {
                return raw
            }
            return { usable: false, httpErrorStatus: null }
        }),
        Math.min(maxWaitMs, 1_500),
        { usable: false, httpErrorStatus: null }
    )

    return result.value
}

function getSafeContextPages(context: BrowserContext): Page[] {
    try {
        return context.pages()
    } catch {
        return []
    }
}

function isInterceptionClickError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    return /intercept|obscur|pointer events|not visible|waiting for/i.test(msg) && !/timeout/i.test(msg)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Click the Maps website locator, wait for the destination page within a
 * bounded 8s load budget, perform bounded organic browsing if loaded (<= 30s
 * total), close newly opened popups, and restore Maps on same-tab navigation.
 *
 * On any load failure the function returns promptly with `loaded: false`,
 * `skipped: true`, and a `website_skipped_*` action — never retrying the dead site.
 */
export async function visitMapsWebsite(
    page: Page,
    locator: Locator,
    options?: MapsWebsiteVisitOptions
): Promise<MapsWebsiteVisitResult> {
    const start = Date.now()
    const loadBudgetMs = Math.max(500, options?.loadBudgetMs ?? DEFAULT_LOAD_BUDGET_MS)
    const totalBudgetMs = Math.max(loadBudgetMs, options?.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS)
    const minDwellMs = options?.dwellRangeMs?.[0] ?? DEFAULT_MIN_DWELL_MS
    const maxDwellMs = options?.dwellRangeMs?.[1] ?? DEFAULT_MAX_DWELL_MS

    const loadDeadline = start + loadBudgetMs
    const totalDeadline = start + totalBudgetMs
    const actions: string[] = []
    const shouldStop = options?.shouldStop ?? (() => false)
    const status = options?.onStatus ?? (() => {})

    const duration = (): number => Math.max(0, Date.now() - start)

    // -----------------------------------------------------------------------
    // 0. Pre-flight
    // -----------------------------------------------------------------------
    if (page.isClosed()) {
        return {
            clicked: false,
            loaded: false,
            mapRestored: false,
            actions: ['website_skipped_closed'],
            detail: 'website_skipped_closed: Maps page already closed',
            durationMs: duration(),
            skipped: true,
        }
    }
    if (shouldStop()) {
        return {
            clicked: false,
            loaded: false,
            mapRestored: true,
            actions: ['website_skipped_stopped'],
            detail: 'website_skipped_stopped: Stop requested before click',
            durationMs: duration(),
            skipped: true,
        }
    }

    const originalMapsUrl = page.url()
    const context = page.context()
    const pagesBeforeClick = new Set<Page>(getSafeContextPages(context))
    const ownedPopups = new Set<Page>()
    const popupObservers = new Map<Page, { signals: PageNavigationSignals; dispose: UnsubscribeFn }>()
    const disposers: UnsubscribeFn[] = []

    // Seed any unexpected page added asynchronously right after click trigger.
    const registerPopup = (candidate: Page): void => {
        if (!candidate || candidate === page || pagesBeforeClick.has(candidate)) return
        if (!ownedPopups.has(candidate)) {
            ownedPopups.add(candidate)
            const observer = observePageNavigation(candidate)
            popupObservers.set(candidate, observer)
            disposers.push(observer.dispose)
        }
    }

    // Track same-tab navigation / errors only for requests that aren't the Maps host itself.
    const mainObserver = observePageNavigation(page, {
        ignoreUrlCheck: (url) => isMapsUrl(url) || isSamePageOrigin(url, originalMapsUrl),
        initialUrl: originalMapsUrl,
    })
    disposers.push(mainObserver.dispose)

    // Context-level network observers catch provisional popup navigation events
    // that arrive before Playwright emits `context.on('page')`.
    let sawExternalNavigationRequest = false
    let contextHttpErrorStatus: number | null = null
    let contextNetworkErrorText: string | null = null

    const isForeignTabFrame = (frame: Frame | null | undefined): boolean => {
        const framePage = safeFramePage(frame)
        return framePage !== null && framePage !== page && pagesBeforeClick.has(framePage)
    }

    const isTargetExternalUrl = (url: string): boolean => {
        if (!url) return false
        if (isMapsUrl(url) || isSamePageOrigin(url, originalMapsUrl)) return false
        if (url === 'about:blank') return false
        return true
    }

    // Prefer direct BrowserContext subscription so cleanup detaches immediately.
    const contextEmitter = asEmitter(context)
    let fallbackPopupWaitStarted = false
    if (contextEmitter) {
        disposers.push(
            attachListener(context, 'page', (rawPage: unknown) => {
                registerPopup(rawPage as Page)
            }),
            attachListener(context, 'request', (rawReq: unknown) => {
                const req = rawReq as Partial<Request>
                if (!req || (typeof req.isNavigationRequest === 'function' && !req.isNavigationRequest())) return
                const frame = safeRequestFrame(req as { frame?: () => Frame })
                if (isForeignTabFrame(frame)) return
                const reqUrl = typeof req.url === 'function' ? req.url() : ''
                if (isTargetExternalUrl(reqUrl)) {
                    sawExternalNavigationRequest = true
                }
            }),
            attachListener(context, 'response', (rawRes: unknown) => {
                const res = rawRes as Partial<Response>
                if (!res || typeof res.status !== 'function') return
                const req = typeof res.request === 'function' ? res.request() : null
                if (req && typeof req.isNavigationRequest === 'function' && !req.isNavigationRequest()) return
                const frame = safeRequestFrame(res as { frame?: () => Frame })
                if (isForeignTabFrame(frame)) return
                const resUrl = req && typeof req.url === 'function'
                    ? req.url()
                    : (typeof res.url === 'function' ? res.url() : '')
                if (!isTargetExternalUrl(resUrl)) return
                if (res.status() >= 400) {
                    contextHttpErrorStatus = res.status()
                }
            }),
            attachListener(context, 'requestfailed', (rawReq: unknown) => {
                const req = rawReq as Partial<Request>
                if (!req || (typeof req.isNavigationRequest === 'function' && !req.isNavigationRequest())) return
                const frame = safeRequestFrame(req as { frame?: () => Frame })
                if (isForeignTabFrame(frame)) return
                const reqUrl = typeof req.url === 'function' ? req.url() : ''
                if (!isTargetExternalUrl(reqUrl)) return
                const failure = typeof req.failure === 'function' ? req.failure() : null
                const errText = failure?.errorText || 'net::ERR_FAILED'
                if (!/ERR_ABORTED/i.test(errText)) {
                    contextNetworkErrorText = errText
                }
            })
        )
    }

    let clicked = false
    let loaded = false
    let openedInPopup = false
    let destinationPage: Page | null = null
    let clickFailedReason: string | null = null
    let mapRestored = !page.isClosed()
    let leftMapsInSameTab = false

    const ensurePopupObservation = (): Page | null => {
        for (const p of getSafeContextPages(context)) {
            if (p !== page && !pagesBeforeClick.has(p)) {
                registerPopup(p)
            }
        }
        for (const p of Array.from(ownedPopups)) {
            if (!p.isClosed()) return p
        }
        return ownedPopups.size > 0 ? Array.from(ownedPopups)[0] : null
    }

    try {
        // -------------------------------------------------------------------
        // 1. Click the website element (strictly within loadDeadline)
        // -------------------------------------------------------------------
        status('Clicking website link...')

        const scrollWait = Math.min(1_000, remainingMs(loadDeadline))
        if (scrollWait > 100 && !shouldStop() && !page.isClosed()) {
            await withBoundedTimeout(
                locator.scrollIntoViewIfNeeded({ timeout: scrollWait }),
                scrollWait + 100,
                undefined
            )
        }

        const settleMs = Math.min(randomInt(150, 350), remainingMs(loadDeadline))
        await sleepInterruptible(settleMs, () => shouldStop() || page.isClosed())

        // Re-check stop/closed before clicking.
        if (page.isClosed()) {
            actions.push('website_skipped_closed')
        } else if (shouldStop()) {
            actions.push('website_skipped_stopped')
        } else {
            // Stripped test mocks without `.on()` rely on `waitForEvent('page')`.
            if (!contextEmitter && typeof context.waitForEvent === 'function' && !fallbackPopupWaitStarted) {
                fallbackPopupWaitStarted = true
                const waitBudget = Math.max(200, remainingMs(loadDeadline))
                context.waitForEvent('page', { timeout: waitBudget })
                    .then((p) => { registerPopup(p) })
                    .catch(() => {})
            }

            const clickBudget = Math.max(250, Math.min(3_500, remainingMs(loadDeadline)))
            if (remainingMs(loadDeadline) > 0) {
                try {
                    const clickAttempt = await withBoundedTimeout(
                        locator.click({ timeout: clickBudget }).then(() => true),
                        clickBudget + 200,
                        false
                    )
                    if (clickAttempt.value) {
                        clicked = true
                        actions.push('website_click')
                    } else {
                        throw new Error(clickAttempt.timedOut ? 'Click timed out' : 'Click failed')
                    }
                } catch (firstErr) {
                    const earlyPopup = ensurePopupObservation()
                    const earlyUrl = page.isClosed() ? originalMapsUrl : page.url()
                    const alreadyLeftMaps = !isSamePageOrigin(earlyUrl, originalMapsUrl)

                    if (earlyPopup || alreadyLeftMaps) {
                        // Click already triggered navigation before throwing.
                        clicked = true
                        actions.push('website_click')
                    } else if (
                        isInterceptionClickError(firstErr)
                        && !shouldStop()
                        && !page.isClosed()
                        && remainingMs(loadDeadline) >= 800
                    ) {
                        const forceBudget = Math.min(1_500, remainingMs(loadDeadline))
                        const forceAttempt = await withBoundedTimeout(
                            locator.click({ timeout: forceBudget, force: true }).then(() => true),
                            forceBudget + 150,
                            false
                        )
                        if (forceAttempt.value) {
                            clicked = true
                            actions.push('website_click_force')
                        } else {
                            clickFailedReason = 'Website click blocked/timed out'
                        }
                    } else {
                        clickFailedReason = firstErr instanceof Error ? firstErr.message : String(firstErr)
                    }
                }
            } else {
                clickFailedReason = 'Load budget expired before click'
            }

            if (!clicked && !actions.some(a => a.startsWith('website_skipped_'))) {
                actions.push('website_click_failed')
                actions.push('website_skipped_click_failed')
            }
        }

        // -------------------------------------------------------------------
        // 2 & 3. Bounded Discovery + Readiness Check within ONE loadDeadline
        // -------------------------------------------------------------------
        if (clicked && !page.isClosed() && !shouldStop()) {
            status('Waiting for website to load...')

            let skipRecorded = false
            const recordSkip = (actionCode: string, statusMessage?: string): void => {
                if (skipRecorded) return
                skipRecorded = true
                if (!actions.includes(actionCode)) {
                    actions.push(actionCode)
                }
                if (statusMessage) {
                    status(statusMessage)
                }
            }

            let waitForLoadCalledOn: Page | null = null

            while (Date.now() < loadDeadline && !skipRecorded) {
                if (page.isClosed()) {
                    recordSkip('website_skipped_closed', 'Maps page closed while waiting for website')
                    break
                }
                if (shouldStop()) {
                    recordSkip('website_skipped_stopped', 'Website load cancelled due to stop request')
                    break
                }

                // Check popup or same-tab discovery on each iteration.
                const popup = ensurePopupObservation()
                if (popup) {
                    if (!destinationPage) {
                        destinationPage = popup
                        openedInPopup = true
                        actions.push('website_popup_opened')
                    }
                } else {
                    const currentUrl = page.url()
                    const leftMaps = !isSamePageOrigin(currentUrl, originalMapsUrl)
                        || mainObserver.signals.networkErrorText !== null
                        || mainObserver.signals.httpErrorStatus !== null
                        || (mainObserver.signals.navigatedUrl !== null && !isSamePageOrigin(mainObserver.signals.navigatedUrl, originalMapsUrl))

                    if (leftMaps) {
                        leftMapsInSameTab = true
                        if (!destinationPage && !isGoogleInterstitialUrl(currentUrl)) {
                            destinationPage = page
                            openedInPopup = false
                            actions.push('website_same_tab')
                        }
                    }
                }

                // Fail immediately if provisional popup navigation already hit DNS/HTTP error.
                if (contextNetworkErrorText) {
                    recordSkip(
                        classifyNetworkSkipAction(contextNetworkErrorText),
                        `Website network error: ${contextNetworkErrorText}`
                    )
                    break
                }
                if (contextHttpErrorStatus !== null) {
                    recordSkip(
                        'website_skipped_http_error',
                        `Website returned HTTP ${contextHttpErrorStatus}`
                    )
                    break
                }

                // Evaluate current destination page signals.
                if (destinationPage) {
                    const destSignals = openedInPopup
                        ? popupObservers.get(destinationPage)?.signals
                        : mainObserver.signals

                    if (openedInPopup && (destinationPage.isClosed() || destSignals?.closed)) {
                        recordSkip('website_skipped_popup_closed', 'Website tab closed before loading')
                        break
                    }

                    const netErr = destSignals?.networkErrorText ?? contextNetworkErrorText
                    if (netErr) {
                        const netAction = classifyNetworkSkipAction(netErr)
                        recordSkip(netAction, `Website network error: ${netErr}`)
                        break
                    }

                    const httpErr = destSignals?.httpErrorStatus ?? contextHttpErrorStatus
                    if (httpErr !== null && httpErr !== undefined) {
                        recordSkip(
                            'website_skipped_http_error',
                            `Website returned HTTP ${httpErr}`
                        )
                        break
                    }

                    const destUrl = destinationPage.url()
                    if (
                        destUrl.startsWith('chrome-error://')
                        || destUrl.startsWith('edge-error://')
                        || destUrl.startsWith('about:neterror')
                    ) {
                        recordSkip('website_skipped_error_page', `Browser error page: ${destUrl.slice(0, 80)}`)
                        break
                    }

                    const stillBlank = !destUrl || destUrl === 'about:blank'
                    if (!stillBlank) {
                        // Kick off one bounded waitForLoadState if not done yet for this page.
                        if (waitForLoadCalledOn !== destinationPage && remainingMs(loadDeadline) > 100) {
                            waitForLoadCalledOn = destinationPage
                            const waitCap = Math.min(1_500, remainingMs(loadDeadline))
                            await withBoundedTimeout(
                                destinationPage.waitForLoadState('domcontentloaded', { timeout: waitCap }),
                                waitCap + 100,
                                undefined
                            )
                            // Re-check immediate failure signals right after waitForLoadState.
                            if (openedInPopup && destinationPage.isClosed()) {
                                recordSkip('website_skipped_popup_closed')
                                break
                            }
                            const postNetErr = destSignals?.networkErrorText ?? contextNetworkErrorText
                            if (postNetErr) {
                                recordSkip(classifyNetworkSkipAction(postNetErr))
                                break
                            }
                            const postHttpErr = destSignals?.httpErrorStatus ?? contextHttpErrorStatus
                            if (postHttpErr !== null && postHttpErr !== undefined) {
                                recordSkip('website_skipped_http_error', `Website returned HTTP ${postHttpErr}`)
                                break
                            }
                            if (shouldStop()) {
                                recordSkip('website_skipped_stopped')
                                break
                            }
                        }

                        const check = await checkUsablePage(destinationPage, remainingMs(loadDeadline), originalMapsUrl)
                        if (check.httpErrorStatus !== null && check.httpErrorStatus >= 400) {
                            recordSkip('website_skipped_http_error', `Website returned HTTP ${check.httpErrorStatus}`)
                            break
                        }
                        if (check.usable) {
                            const finalHttpErr = destSignals?.httpErrorStatus ?? contextHttpErrorStatus
                            if (finalHttpErr !== null && finalHttpErr !== undefined) {
                                recordSkip('website_skipped_http_error', `Website returned HTTP ${finalHttpErr}`)
                                break
                            }
                            const finalNetErr = destSignals?.networkErrorText ?? contextNetworkErrorText
                            if (finalNetErr) {
                                recordSkip(classifyNetworkSkipAction(finalNetErr))
                                break
                            }
                            loaded = true
                            actions.push('website_loaded')
                            status('Website loaded successfully')
                            break
                        }
                    } else if (openedInPopup) {
                        // Real Chromium opens popups at about:blank briefly before committing URL.
                        const openedAge = Date.now() - (destSignals?.openedAt ?? start)
                        const looksBlankAndStalled = openedAge >= Math.min(POPUP_BLANK_GRACE_MS, loadBudgetMs)
                        if (looksBlankAndStalled) {
                            recordSkip('website_skipped_blank', 'Website popup remained blank')
                            break
                        }
                    }
                }

                const stepWait = Math.min(POLL_INTERVAL_MS, remainingMs(loadDeadline))
                if (stepWait <= 0) break
                await sleepInterruptible(stepWait, () => {
                    if (shouldStop() || page.isClosed()) return true
                    if (contextNetworkErrorText !== null || contextHttpErrorStatus !== null) return true
                    if (destinationPage && openedInPopup) {
                        const sig = popupObservers.get(destinationPage)?.signals
                        if (destinationPage.isClosed() || sig?.closed || sig?.networkErrorText || sig?.httpErrorStatus !== null) {
                            return true
                        }
                    }
                    return false
                })
            }

            // Budget exhausted without loading -> record accurate terminal skip action.
            if (!loaded && !skipRecorded) {
                if (page.isClosed()) {
                    recordSkip('website_skipped_closed', 'Maps page closed')
                } else if (shouldStop()) {
                    recordSkip('website_skipped_stopped', 'Stop requested')
                } else if (contextNetworkErrorText) {
                    recordSkip(classifyNetworkSkipAction(contextNetworkErrorText), `Website network error: ${contextNetworkErrorText}`)
                } else if (contextHttpErrorStatus !== null) {
                    recordSkip('website_skipped_http_error', `Website returned HTTP ${contextHttpErrorStatus}`)
                } else if (!destinationPage && sawExternalNavigationRequest) {
                    // Navigation request started (e.g. target=_blank rel=noopener) but server never sent headers.
                    recordSkip('website_skipped_timeout', `Website did not respond within ${Math.round(loadBudgetMs / 1000)}s`)
                } else if (!destinationPage) {
                    actions.push('website_no_navigation')
                    recordSkip('website_skipped_no_navigation', 'Website link did not open a page')
                } else {
                    const finalDestUrl = destinationPage.isClosed() ? '' : destinationPage.url()
                    if (!finalDestUrl || finalDestUrl === 'about:blank') {
                        recordSkip('website_skipped_blank', 'Website did not leave blank page')
                    } else if (isErrorUrl(finalDestUrl)) {
                        recordSkip('website_skipped_error_page', `Website showed error page: ${finalDestUrl.slice(0, 80)}`)
                    } else {
                        recordSkip('website_skipped_timeout', `Website did not become ready within ${Math.round(loadBudgetMs / 1000)}s`)
                    }
                }
            }
        }

        // -------------------------------------------------------------------
        // 4. Organic browsing ONLY on usable loaded pages (<= totalDeadline)
        // -------------------------------------------------------------------
        if (loaded && destinationPage && !destinationPage.isClosed() && !shouldStop() && !page.isClosed()) {
            actions.push('website_browse_start')
            status('Browsing website content...')

            const cleanupReserveMs = Math.min(3_000, Math.floor(totalBudgetMs * 0.2))
            const targetDwellMs = randomInt(minDwellMs, Math.max(minDwellMs, maxDwellMs))
            const browseEnd = Math.min(
                Date.now() + targetDwellMs,
                totalDeadline - cleanupReserveMs
            )
            const scrollRounds = randomInt(4, 10)
            const browseStart = Date.now()

            const browseShouldStop = (): boolean =>
                shouldStop() || page.isClosed() || destinationPage === null || destinationPage.isClosed() || Date.now() >= browseEnd

            for (let i = 0; i < scrollRounds && !browseShouldStop(); i++) {
                const wheelBudget = Math.min(600, remainingMs(browseEnd))
                if (wheelBudget <= 0) break

                await withBoundedTimeout(
                    destinationPage.mouse.wheel(0, randomInt(150, 450)),
                    wheelBudget,
                    undefined
                )

                const readPause = Math.min(randomInt(1_200, 3_000), remainingMs(browseEnd))
                await sleepInterruptible(readPause, browseShouldStop)
                if (browseShouldStop()) break

                if (Math.random() > 0.7 && remainingMs(browseEnd) > 300) {
                    await withBoundedTimeout(
                        destinationPage.mouse.wheel(0, -randomInt(80, 200)),
                        Math.min(500, remainingMs(browseEnd)),
                        undefined
                    )
                    const smallPause = Math.min(randomInt(600, 1_500), remainingMs(browseEnd))
                    await sleepInterruptible(smallPause, browseShouldStop)
                    if (browseShouldStop()) break
                }

                if (Math.random() > 0.5 && remainingMs(browseEnd) > 300) {
                    const vp = destinationPage.viewportSize()
                    if (vp && vp.width > 200 && vp.height > 200) {
                        await withBoundedTimeout(
                            destinationPage.mouse.move(
                                randomInt(100, vp.width - 100),
                                randomInt(100, vp.height - 100),
                                { steps: randomInt(4, 8) }
                            ),
                            Math.min(800, remainingMs(browseEnd)),
                            undefined
                        )
                    }
                }
            }

            const dwellSec = Math.max(0, Math.round((Date.now() - browseStart) / 1000))
            actions.push(`website_browsed_${dwellSec}s`)
        }
    } finally {
        // -------------------------------------------------------------------
        // 5. Cleanup: detach listeners, close new popups, restore Maps URL
        // -------------------------------------------------------------------
        if (!page.isClosed()) {
            status('Cleaning up and returning to Maps...')
        }

        // If a provisional context-level HTTP/network error fired right before
        // Playwright emitted the popup's `page` event, give Chromium up to 250ms
        // to materialize that tab so we close it cleanly before returning.
        if (
            ownedPopups.size === 0
            && !leftMapsInSameTab
            && !page.isClosed()
            && !shouldStop()
            && (contextHttpErrorStatus !== null || contextNetworkErrorText !== null)
        ) {
            await sleepInterruptible(250, () => {
                for (const candidate of getSafeContextPages(context)) {
                    if (candidate !== page && !pagesBeforeClick.has(candidate)) {
                        ownedPopups.add(candidate)
                    }
                }
                return ownedPopups.size > 0 || shouldStop() || page.isClosed()
            })
        }

        for (const unsub of disposers) {
            unsub()
        }

        // Sweep context one more time so late popups are captured and closed.
        for (const candidate of getSafeContextPages(context)) {
            if (candidate !== page && !pagesBeforeClick.has(candidate)) {
                ownedPopups.add(candidate)
            }
        }

        let closedAnyPrimaryPopup = false
        for (const popup of Array.from(ownedPopups)) {
            if (!popup.isClosed()) {
                const closeResult = await withBoundedTimeout(
                    popup.close({ runBeforeUnload: false }).then(() => true),
                    POPUP_CLOSE_TIMEOUT_MS,
                    false
                )
                if (popup === destinationPage && openedInPopup) {
                    actions.push(closeResult.value ? 'website_popup_closed' : 'website_popup_close_failed')
                    closedAnyPrimaryPopup = true
                }
            } else if (popup === destinationPage && openedInPopup && !closedAnyPrimaryPopup) {
                actions.push('website_popup_closed')
                closedAnyPrimaryPopup = true
            }
        }

        if (page.isClosed()) {
            mapRestored = false
        } else {
            const currentUrl = page.url()
            const needsRestore = leftMapsInSameTab || !isSamePageOrigin(currentUrl, originalMapsUrl)

            if (needsRestore) {
                let restored = false
                const gotoResult = await withBoundedTimeout(
                    page.goto(originalMapsUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: RESTORE_GOTO_TIMEOUT_MS,
                    }).then(() => true),
                    RESTORE_GOTO_TIMEOUT_MS + 500,
                    false
                )

                if (gotoResult.value && !page.isClosed() && isSamePageOrigin(page.url(), originalMapsUrl)) {
                    restored = true
                    actions.push('website_maps_restored')
                } else if (!page.isClosed()) {
                    const backResult = await withBoundedTimeout(
                        page.goBack({
                            waitUntil: 'domcontentloaded',
                            timeout: RESTORE_GOBACK_TIMEOUT_MS,
                        }).then(() => true),
                        RESTORE_GOBACK_TIMEOUT_MS + 500,
                        false
                    )
                    if (backResult.value && !page.isClosed() && isSamePageOrigin(page.url(), originalMapsUrl)) {
                        restored = true
                        actions.push('website_maps_restored_goback')
                    }
                }

                if (!restored) {
                    actions.push('website_map_not_restored')
                }
                mapRestored = restored
            } else {
                mapRestored = true
            }

            if (!page.isClosed()) {
                await withBoundedTimeout(page.bringToFront(), 1_000, undefined)
            }
        }
    }

    // -----------------------------------------------------------------------
    // 6. Build final result
    // -----------------------------------------------------------------------
    const skipped = !loaded
    const success = loaded && mapRestored
    const elapsedSec = Math.round(duration() / 1000)

    let detail: string
    if (success) {
        detail = `Website visit loaded and Maps context restored (${elapsedSec}s)`
    } else if (!loaded) {
        const failAction = actions.find(a => a.startsWith('website_skipped_')) || 'website_skipped_unknown'
        const reasonSuffix = clickFailedReason ? `: ${clickFailedReason}` : ': Website did not load within budget'
        detail = `${failAction}${reasonSuffix}`
    } else {
        detail = 'website_map_not_restored: Maps page was not restored after website visit'
    }

    return {
        clicked,
        loaded,
        mapRestored,
        actions,
        detail,
        durationMs: duration(),
        skipped,
    }
}
