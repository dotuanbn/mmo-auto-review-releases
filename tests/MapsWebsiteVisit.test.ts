/**
 * MapsWebsiteVisit & KpiSkills website regression tests.
 *
 * Strictly typed fakes matching Playwright Page / BrowserContext / Locator event
 * lifecycles (no `any`). Tests cover:
 * 1. Closed Maps page & stop request early outs
 * 2. Click failures & listener/popup cleanup
 * 3. Hung / unresponsive popup hitting the 8s shared load budget cleanly
 * 4. Initial about:blank popup transitioning into a real usable website
 * 5. Delayed popup arrival & late popup sweeping
 * 6. Main-frame DNS / proxy / HTTP 500 error responses rejected promptly
 * 7. No-navigation / blocked popup marked skipped (not retried)
 * 8. Same-tab navigation (healthy restore, error restore, explicit restore failure)
 * 9. Total 30s dwell budget enforcement & preservation of unrelated preexisting tabs
 * 10. KpiSkills.executeWebsiteClick & executeAvailableKpis continuation/retryable contract
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Locator, Page } from 'playwright'

vi.mock('electron', () => ({
    app: {
        getPath: () => 'C:\\tmp\\mmo-maps-website-visit',
        isPackaged: false,
    },
    BrowserWindow: {
        getAllWindows: () => [],
    },
    ipcMain: {
        handle: () => undefined,
        on: () => undefined,
    },
}))

vi.mock('../src/main/utils/agenticLog', () => ({
    writeAgenticLog: () => undefined,
}))

vi.mock('../src/main/automation/DOMUtils', () => ({
    DOMUtils: {
        extractInteractiveDOM: vi.fn(async () => ({ domText: 'Place', summaries: [] })),
        getObservedElementLocator: vi.fn(),
    },
}))

vi.mock('../src/main/automation/BrowserCursorOverlay', () => ({
    moveCursor: vi.fn(async () => undefined),
    clickCursor: vi.fn(async () => undefined),
}))

import { visitMapsWebsite } from '../src/main/automation/MapsWebsiteVisit'
import { KpiSkills } from '../src/main/automation/KpiSkills'

// ---------------------------------------------------------------------------
// Strictly typed event emitter & Playwright fakes (no `any`)
// ---------------------------------------------------------------------------

type EventListener = (...args: unknown[]) => void

class TypedEmitter {
    private readonly listeners = new Map<string, Set<EventListener>>()

    on = (event: string, listener: EventListener): this => {
        let bucket = this.listeners.get(event)
        if (!bucket) {
            bucket = new Set<EventListener>()
            this.listeners.set(event, bucket)
        }
        bucket.add(listener)
        return this
    }

    off = (event: string, listener: EventListener): this => {
        this.listeners.get(event)?.delete(listener)
        return this
    }

    emit(event: string, ...args: unknown[]): void {
        const bucket = this.listeners.get(event)
        if (!bucket) return
        for (const fn of Array.from(bucket)) {
            fn(...args)
        }
    }

    listenerCount(event?: string): number {
        if (event) return this.listeners.get(event)?.size ?? 0
        let total = 0
        for (const bucket of this.listeners.values()) {
            total += bucket.size
        }
        return total
    }
}

interface FakeFrame {
    url: () => string
}

interface FakeRequest {
    isNavigationRequest: () => boolean
    frame: () => FakeFrame
    failure: () => { errorText: string } | null
    url: () => string
}

interface FakeResponse {
    status: () => number
    request: () => FakeRequest
    frame: () => FakeFrame
    url: () => string
}

interface FakePageOptions {
    url?: string
    closed?: boolean
    bodyText?: string
    readyState?: DocumentReadyState
    gotoResult?: 'ok' | 'fail'
    goBackResult?: 'ok' | 'fail'
    waitForLoadMode?: 'resolve' | 'hang'
    initialContextPages?: FakePlaywrightPage[]
}

class FakePlaywrightPage extends TypedEmitter {
    private currentUrl: string
    private closed: boolean
    private bodyText: string
    private readyState: DocumentReadyState
    private readonly mainFrameObj: FakeFrame
    private readonly waitForLoadMode: 'resolve' | 'hang'
    private readonly gotoMode: 'ok' | 'fail'
    private readonly goBackMode: 'ok' | 'fail'
    private ownerContext: FakeBrowserContext | null = null

    readonly gotoCalls: string[] = []
    readonly goBackCalls: number[] = []
    readonly bringToFrontCalls: number[] = []
    readonly closeCalls: number[] = []
    readonly wheelCalls: Array<[number, number]> = []

    readonly mouse = {
        wheel: vi.fn(async (dx: number, dy: number): Promise<void> => {
            this.wheelCalls.push([dx, dy])
        }),
        move: vi.fn(async (): Promise<void> => undefined),
        click: vi.fn(async (): Promise<void> => undefined),
    }

    readonly keyboard = {
        press: vi.fn(async (): Promise<void> => undefined),
        type: vi.fn(async (): Promise<void> => undefined),
    }

    constructor(opts: FakePageOptions = {}) {
        super()
        this.currentUrl = opts.url ?? 'https://www.google.com/maps/place/TestBusiness'
        this.closed = opts.closed ?? false
        this.bodyText = opts.bodyText ?? 'Sample business website with detailed service information and content.'
        this.readyState = opts.readyState ?? 'complete'
        this.waitForLoadMode = opts.waitForLoadMode ?? 'resolve'
        this.gotoMode = opts.gotoResult ?? 'ok'
        this.goBackMode = opts.goBackResult ?? 'ok'
        this.mainFrameObj = { url: () => this.currentUrl }

        if (!opts.initialContextPages) {
            this.ownerContext = new FakeBrowserContext([this])
        }
    }

    bindContext(ctx: FakeBrowserContext): void {
        this.ownerContext = ctx
    }

    context = (): FakeBrowserContext => {
        if (!this.ownerContext) {
            this.ownerContext = new FakeBrowserContext([this])
        }
        return this.ownerContext
    }

    mainFrame = (): FakeFrame => this.mainFrameObj
    isClosed = (): boolean => this.closed
    url = (): string => this.currentUrl
    viewportSize = (): { width: number; height: number } => ({ width: 1280, height: 720 })

    setState(next: { url?: string; bodyText?: string; readyState?: DocumentReadyState }): void {
        if (next.url !== undefined) this.currentUrl = next.url
        if (next.bodyText !== undefined) this.bodyText = next.bodyText
        if (next.readyState !== undefined) this.readyState = next.readyState
    }

    emitNavigationResponse(status: number, url?: string, isNavigation = true): void {
        const targetUrl = url ?? this.currentUrl
        const frame = this.mainFrameObj
        const req: FakeRequest = {
            isNavigationRequest: () => isNavigation,
            frame: () => frame,
            failure: () => null,
            url: () => targetUrl,
        }
        const res: FakeResponse = {
            status: () => status,
            request: () => req,
            frame: () => frame,
            url: () => targetUrl,
        }
        this.emit('response', res)
        this.ownerContext?.emit('response', res)
    }

    emitNavigationFailure(errorText: string, url?: string, isNavigation = true): void {
        const targetUrl = url ?? this.currentUrl
        const frame = this.mainFrameObj
        const req: FakeRequest = {
            isNavigationRequest: () => isNavigation,
            frame: () => frame,
            failure: () => ({ errorText }),
            url: () => targetUrl,
        }
        this.emit('requestfailed', req)
        this.ownerContext?.emit('requestfailed', req)
    }

    waitForLoadState = vi.fn(async (): Promise<void> => {
        if (this.waitForLoadMode === 'hang') {
            return new Promise<void>(() => {
                // Intentionally never resolves to simulate a hanging server.
            })
        }
    })

    evaluate = vi.fn(async (): Promise<boolean> => {
        if (this.closed) return false
        if (this.readyState !== 'interactive' && this.readyState !== 'complete') return false
        return this.bodyText.trim().length > 50
    })

    goto = vi.fn(async (target: string): Promise<void> => {
        this.gotoCalls.push(target)
        if (this.gotoMode === 'fail') throw new Error('goto failed')
        this.currentUrl = target
    })

    goBack = vi.fn(async (): Promise<void> => {
        this.goBackCalls.push(Date.now())
        if (this.goBackMode === 'fail') throw new Error('goBack failed')
    })

    bringToFront = vi.fn(async (): Promise<void> => {
        this.bringToFrontCalls.push(Date.now())
    })

    close = vi.fn(async (): Promise<void> => {
        this.closeCalls.push(Date.now())
        this.closed = true
        this.emit('close')
    })

    locator = vi.fn((): FakeLocator => {
        return new FakeLocator()
    })

    asPlaywrightPage(): Page {
        return this as unknown as Page
    }
}

class FakeBrowserContext extends TypedEmitter {
    private readonly openPages: FakePlaywrightPage[] = []

    constructor(initialPages: FakePlaywrightPage[]) {
        super()
        for (const p of initialPages) {
            this.openPages.push(p)
            p.bindContext(this)
        }
    }

    pages = (): FakePlaywrightPage[] => [...this.openPages]

    spawnPopup(opts: FakePageOptions = {}): FakePlaywrightPage {
        const popup = new FakePlaywrightPage({ ...opts, initialContextPages: [] })
        popup.bindContext(this)
        this.openPages.push(popup)
        this.emit('page', popup)
        return popup
    }

    waitForEvent = vi.fn(async (): Promise<FakePlaywrightPage> => {
        throw new Error('Not used when TypedEmitter.on exists')
    })
}

class FakeLocator {
    private onClickFn?: () => Promise<void> | void
    private clickError?: Error
    private visible: boolean

    readonly clickCalls: Array<{ timeout?: number; force?: boolean }> = []
    readonly scrollCalls: number[] = []

    constructor(opts: {
        visible?: boolean
        clickError?: Error
        onClick?: () => Promise<void> | void
    } = {}) {
        this.visible = opts.visible ?? true
        this.clickError = opts.clickError
        this.onClickFn = opts.onClick
    }

    first = (): FakeLocator => this
    count = async (): Promise<number> => (this.visible ? 1 : 0)
    isVisible = async (): Promise<boolean> => this.visible

    scrollIntoViewIfNeeded = vi.fn(async (): Promise<void> => {
        this.scrollCalls.push(Date.now())
    })

    click = vi.fn(async (opts: { timeout?: number; force?: boolean } = {}): Promise<void> => {
        this.clickCalls.push(opts)
        if (this.onClickFn) {
            await this.onClickFn()
        }
        if (this.clickError) {
            throw this.clickError
        }
    })

    asPlaywrightLocator(): Locator {
        return this as unknown as Locator
    }
}

function createFakePageWithUnrelatedTab(): {
    mapsPage: FakePlaywrightPage
    unrelatedTab: FakePlaywrightPage
    context: FakeBrowserContext
} {
    const mapsPage = new FakePlaywrightPage({ url: 'https://www.google.com/maps/place/TestBusiness', initialContextPages: [] })
    const unrelatedTab = new FakePlaywrightPage({ url: 'https://example.org/preexisting', initialContextPages: [] })
    const context = new FakeBrowserContext([mapsPage, unrelatedTab])
    return { mapsPage, unrelatedTab, context }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('MapsWebsiteVisit', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-11-26T10:00:00Z'))
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('returns immediately when Maps page is already closed', async () => {
        const page = new FakePlaywrightPage({ closed: true })
        const locator = new FakeLocator()

        const result = await visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator())

        expect(result.clicked).toBe(false)
        expect(result.loaded).toBe(false)
        expect(result.mapRestored).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.actions).toEqual(['website_skipped_closed'])
        expect(locator.clickCalls).toHaveLength(0)
    })

    it('returns immediately when shouldStop is true before click', async () => {
        const page = new FakePlaywrightPage()
        const locator = new FakeLocator()

        const result = await visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator(), {
            shouldStop: () => true,
        })

        expect(result.clicked).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.mapRestored).toBe(true)
        expect(result.actions).toEqual(['website_skipped_stopped'])
        expect(locator.clickCalls).toHaveLength(0)
    })

    it('skips non-retryably when click fails and leaves zero dangling listeners', async () => {
        const page = new FakePlaywrightPage()
        const locator = new FakeLocator({ clickError: new Error('Target closed') })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator())
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result.clicked).toBe(false)
        expect(result.loaded).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.actions).toContain('website_click_failed')
        expect(result.actions).toContain('website_skipped_click_failed')
        expect(result.detail).toContain('website_skipped_click_failed')
        expect(page.listenerCount()).toBe(0)
        expect(page.context().listenerCount()).toBe(0)
    })

    it('bounds an unresponsive/hanging popup to the 8s load budget, closes it, and preserves unrelated tabs', async () => {
        const { mapsPage, unrelatedTab, context } = createFakePageWithUnrelatedTab()
        let popup!: FakePlaywrightPage

        const locator = new FakeLocator({
            onClick: () => {
                popup = context.spawnPopup({
                    url: 'https://slow-dead-site.example/',
                    waitForLoadMode: 'hang',
                    bodyText: '',
                    readyState: 'loading',
                })
            },
        })
        const statuses: string[] = []

        const promise = visitMapsWebsite(mapsPage.asPlaywrightPage(), locator.asPlaywrightLocator(), {
            onStatus: (msg) => statuses.push(msg),
        })
        await vi.advanceTimersByTimeAsync(12_000)
        const result = await promise

        expect(result.clicked).toBe(true)
        expect(result.loaded).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.mapRestored).toBe(true)
        expect(result.durationMs).toBeLessThan(10_500)
        expect(result.actions).toContain('website_skipped_timeout')
        expect(popup.isClosed()).toBe(true)
        expect(mapsPage.isClosed()).toBe(false)
        expect(unrelatedTab.isClosed()).toBe(false)
        expect(mapsPage.listenerCount()).toBe(0)
        expect(context.listenerCount()).toBe(0)
        expect(statuses.length).toBeGreaterThan(0)
    })

    it('waits past initial about:blank and succeeds when delayed navigation renders usable content', async () => {
        const page = new FakePlaywrightPage()
        let popup!: FakePlaywrightPage

        const locator = new FakeLocator({
            onClick: () => {
                popup = page.context().spawnPopup({
                    url: 'about:blank',
                    bodyText: '',
                    readyState: 'complete',
                })
                setTimeout(() => {
                    popup.setState({
                        url: 'https://healthy-site.example/about',
                        bodyText: 'Authentic restaurant menu, opening hours, customer reviews, and location information.',
                        readyState: 'complete',
                    })
                }, 400)
            },
        })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator(), {
            dwellRangeMs: [2_000, 3_000],
        })
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result.clicked).toBe(true)
        expect(result.loaded).toBe(true)
        expect(result.skipped).toBe(false)
        expect(result.mapRestored).toBe(true)
        expect(result.actions).toContain('website_popup_opened')
        expect(result.actions).toContain('website_loaded')
        expect(result.actions).toContain('website_browse_start')
        expect(popup.wheelCalls.length).toBeGreaterThan(0)
        expect(popup.isClosed()).toBe(true)
        expect(popup.listenerCount()).toBe(0)
    })

    it('handles delayed popup event firing after click and cleans up late tabs', async () => {
        const page = new FakePlaywrightPage()
        let delayedPopup!: FakePlaywrightPage
        let strayLatePopup!: FakePlaywrightPage

        const locator = new FakeLocator({
            onClick: () => {
                setTimeout(() => {
                    delayedPopup = page.context().spawnPopup({
                        url: 'https://delayed-site.example/',
                        bodyText: 'Complete website page content rendered properly after popup event arrived late.',
                        readyState: 'complete',
                    })
                    strayLatePopup = page.context().spawnPopup({
                        url: 'about:blank',
                    })
                }, 600)
            },
        })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator(), {
            dwellRangeMs: [2_000, 2_000],
        })
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result.clicked).toBe(true)
        expect(result.loaded).toBe(true)
        expect(delayedPopup.isClosed()).toBe(true)
        expect(strayLatePopup.isClosed()).toBe(true)
        expect(page.context().listenerCount()).toBe(0)
    })

    it('skips DNS and proxy network failures immediately without waiting for full budget', async () => {
        const dnsPage = new FakePlaywrightPage()
        let dnsPopup!: FakePlaywrightPage
        const dnsLocator = new FakeLocator({
            onClick: () => {
                dnsPopup = dnsPage.context().spawnPopup({ url: 'about:blank' })
                setTimeout(() => {
                    dnsPopup.emitNavigationFailure('net::ERR_NAME_NOT_RESOLVED', 'https://missing-domain.invalid/')
                }, 150)
            },
        })

        const dnsPromise = visitMapsWebsite(dnsPage.asPlaywrightPage(), dnsLocator.asPlaywrightLocator())
        await vi.runAllTimersAsync()
        const dnsResult = await dnsPromise

        expect(dnsResult.clicked).toBe(true)
        expect(dnsResult.loaded).toBe(false)
        expect(dnsResult.skipped).toBe(true)
        expect(dnsResult.actions).toContain('website_skipped_dns')
        expect(dnsResult.durationMs).toBeLessThan(2_000)
        expect(dnsPopup.wheelCalls).toHaveLength(0)
        expect(dnsPopup.isClosed()).toBe(true)

        const proxyPage = new FakePlaywrightPage()
        const proxyLocator = new FakeLocator({
            onClick: () => {
                const p = proxyPage.context().spawnPopup({ url: 'about:blank' })
                setTimeout(() => {
                    p.emitNavigationFailure('net::ERR_TUNNEL_CONNECTION_FAILED', 'https://unreachable.example/')
                }, 150)
            },
        })
        const proxyPromise = visitMapsWebsite(proxyPage.asPlaywrightPage(), proxyLocator.asPlaywrightLocator())
        await vi.runAllTimersAsync()
        const proxyResult = await proxyPromise

        expect(proxyResult.skipped).toBe(true)
        expect(proxyResult.actions).toContain('website_skipped_proxy')
    })

    it('rejects HTTP 4xx/5xx error documents even when error body has long text', async () => {
        const page = new FakePlaywrightPage()
        let popup!: FakePlaywrightPage

        const locator = new FakeLocator({
            onClick: () => {
                popup = page.context().spawnPopup({
                    url: 'about:blank',
                    bodyText: '',
                    readyState: 'loading',
                })
                setTimeout(() => {
                    popup.emitNavigationResponse(502, 'https://broken-app.example/')
                    popup.setState({
                        url: 'https://broken-app.example/',
                        bodyText: '502 Bad Gateway - nginx reverse proxy cannot reach upstream server right now.',
                        readyState: 'complete',
                    })
                }, 100)
            },
        })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator())
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result.clicked).toBe(true)
        expect(result.loaded).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.actions).toContain('website_skipped_http_error')
        expect(result.actions).not.toContain('website_loaded')
        expect(popup.wheelCalls).toHaveLength(0)
        expect(popup.isClosed()).toBe(true)
    })

    it('rejects provisional context-level HTTP 502 emitted before popup page event', async () => {
        const page = new FakePlaywrightPage()
        let popup!: FakePlaywrightPage

        const locator = new FakeLocator({
            onClick: () => {
                // Emits response on context BEFORE spawning popup (Chromium rel=noopener behavior).
                page.context().emit('response', {
                    status: () => 502,
                    url: () => 'https://early-502.example/',
                    frame: () => {
                        throw new Error('Frame for this navigation request is not available')
                    },
                    request: () => ({
                        isNavigationRequest: () => true,
                        url: () => 'https://early-502.example/',
                        frame: () => {
                            throw new Error('Frame for this navigation request is not available')
                        },
                        failure: () => null,
                    }),
                })
                popup = page.context().spawnPopup({
                    url: 'https://early-502.example/',
                    bodyText: '502 Bad Gateway stub page with over fifty characters of error content.',
                    readyState: 'complete',
                })
            },
        })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator())
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result.clicked).toBe(true)
        expect(result.loaded).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.actions).toContain('website_skipped_http_error')
        expect(popup.isClosed()).toBe(true)
    })

    it('skips when link click causes neither popup nor same-tab navigation', async () => {
        const page = new FakePlaywrightPage()
        const locator = new FakeLocator()

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator())
        await vi.advanceTimersByTimeAsync(9_000)
        const result = await promise

        expect(result.clicked).toBe(true)
        expect(result.loaded).toBe(false)
        expect(result.skipped).toBe(true)
        expect(result.mapRestored).toBe(true)
        expect(result.actions).toContain('website_no_navigation')
        expect(result.actions).toContain('website_skipped_no_navigation')
        expect(result.detail).toContain('website_skipped_no_navigation')
    })

    it('restores Maps URL after same-tab error navigation and marks unrestored failure explicitly', async () => {
        // Case A: Same-tab transitions to chrome-error:// -> must detect and restore Maps URL
        const errorTabPage = new FakePlaywrightPage({ url: 'https://www.google.com/maps/place/TestBusiness' })
        const errorTabLocator = new FakeLocator({
            onClick: () => {
                errorTabPage.setState({
                    url: 'chrome-error://chromewebdata/',
                    bodyText: '',
                    readyState: 'complete',
                })
            },
        })

        const promiseA = visitMapsWebsite(errorTabPage.asPlaywrightPage(), errorTabLocator.asPlaywrightLocator())
        await vi.runAllTimersAsync()
        const resultA = await promiseA

        expect(resultA.clicked).toBe(true)
        expect(resultA.loaded).toBe(false)
        expect(resultA.skipped).toBe(true)
        expect(resultA.mapRestored).toBe(true)
        expect(resultA.actions).toContain('website_same_tab')
        expect(resultA.actions).toContain('website_skipped_error_page')
        expect(resultA.actions).toContain('website_maps_restored')
        expect(errorTabPage.gotoCalls).toEqual(['https://www.google.com/maps/place/TestBusiness'])

        // Case B: Healthy same-tab visit whose Maps restore fails -> mapRestored must be false
        const unrestorablePage = new FakePlaywrightPage({
            url: 'https://www.google.com/maps/place/TestBusiness',
            gotoResult: 'fail',
            goBackResult: 'fail',
        })
        const unrestorableLocator = new FakeLocator({
            onClick: () => {
                unrestorablePage.setState({
                    url: 'https://same-tab-business.example/',
                    bodyText: 'Detailed landing page with full services, catalog, and business overview.',
                    readyState: 'complete',
                })
            },
        })

        const promiseB = visitMapsWebsite(unrestorablePage.asPlaywrightPage(), unrestorableLocator.asPlaywrightLocator(), {
            dwellRangeMs: [2_000, 2_000],
        })
        await vi.runAllTimersAsync()
        const resultB = await promiseB

        expect(resultB.loaded).toBe(true)
        expect(resultB.mapRestored).toBe(false)
        expect(resultB.actions).toContain('website_map_not_restored')
        expect(resultB.detail).toContain('website_map_not_restored')
    })

    it('enforces the 30s total budget during healthy reading and honors mid-browse cancellation', async () => {
        const page = new FakePlaywrightPage()
        let stop = false

        const locator = new FakeLocator({
            onClick: () => {
                page.context().spawnPopup({
                    url: 'https://long-read.example/',
                    bodyText: 'Very detailed business article page with plenty of readable text for browsing.',
                    readyState: 'complete',
                })
                setTimeout(() => {
                    stop = true
                }, 4_500)
            },
        })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator(), {
            shouldStop: () => stop,
            dwellRangeMs: [25_000, 25_000],
        })
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result.loaded).toBe(true)
        expect(result.durationMs).toBeLessThan(10_000)
        expect(result.mapRestored).toBe(true)
    })

    it('caps default 30s total budget even when dwell attempts would exceed remaining window', async () => {
        const page = new FakePlaywrightPage()
        const locator = new FakeLocator({
            onClick: () => {
                page.context().spawnPopup({
                    url: 'https://healthy.example/',
                    bodyText: 'Healthy site with enough visible content for engaged website browsing validation.',
                    readyState: 'complete',
                })
            },
        })

        const promise = visitMapsWebsite(page.asPlaywrightPage(), locator.asPlaywrightLocator())
        await vi.advanceTimersByTimeAsync(35_000)
        const result = await promise

        expect(result.loaded).toBe(true)
        expect(result.durationMs).toBeLessThanOrEqual(30_000)
    })
})

describe('KpiSkills website & executeAvailableKpis continuation', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('executeWebsiteClick sets retryable=false on skipped website and keeps click distinct from verified', async () => {
        const page = new FakePlaywrightPage()
        const skills = new KpiSkills()

        // Make page.locator return a visible website element that pops open an unreachable site.
        const websiteLoc = new FakeLocator({
            onClick: () => {
                const p = page.context().spawnPopup({ url: 'about:blank' })
                setTimeout(() => {
                    p.emitNavigationFailure('net::ERR_CONNECTION_TIMED_OUT', 'https://dead.example/')
                }, 50)
            },
        })
        page.locator.mockImplementation(() => websiteLoc)

        const pending = skills.executeWebsiteClick(page.asPlaywrightPage(), 1)
        await vi.runAllTimersAsync()
        const res = await pending

        expect(res.executed).toBe(true)
        expect(res.verified).toBe(false)
        expect(res.retryable).toBe(false)
        expect(res.actions).toContain('website_skipped_timeout')
    })

    it('executeAvailableKpis continues to remaining KPIs when website fails and propagates retryable=false if only website ran unverified', async () => {
        const page = new FakePlaywrightPage()
        const skills = new KpiSkills()

        vi.spyOn(skills, 'detectAvailableKpis').mockResolvedValue([
            { type: 'website', available: true, detail: 'Found website' },
            { type: 'phone', available: true, detail: 'Found phone' },
        ])

        const callOrder: string[] = []
        vi.spyOn(skills, 'executeKpi').mockImplementation(async (_p, _tid, target) => {
            callOrder.push(target)
            if (target === 'website') {
                return {
                    executed: true,
                    verified: false,
                    actions: ['website_click', 'website_skipped_dns'],
                    detail: 'website_skipped_dns',
                    durationMs: 100,
                    retryable: false,
                }
            }
            return {
                executed: true,
                verified: true,
                actions: ['phone_click', 'phone_verified'],
                detail: 'Phone click VERIFIED',
                durationMs: 200,
            }
        })

        const pending = skills.executeAvailableKpis(page.asPlaywrightPage(), 2, {
            preferredOrder: ['website', 'phone'],
        })
        await vi.runAllTimersAsync()
        const combined = await pending

        expect(callOrder).toEqual(['website', 'phone'])
        expect(combined.executed).toBe(true)
        expect(combined.verified).toBe(true)
        expect(combined.actions).toContain('website_skipped_dns')
        expect(combined.actions).toContain('phone_verified')

        // When only non-retryable website ran and stayed unverified, combined result is retryable=false.
        vi.spyOn(skills, 'detectAvailableKpis').mockResolvedValue([
            { type: 'website', available: true, detail: 'Found website' },
        ])
        vi.spyOn(skills, 'executeKpi').mockResolvedValue({
            executed: true,
            verified: false,
            actions: ['website_click', 'website_skipped_timeout'],
            detail: 'website_skipped_timeout',
            durationMs: 100,
            retryable: false,
        })

        const onlyWebsitePending = skills.executeAvailableKpis(page.asPlaywrightPage(), 3)
        await vi.runAllTimersAsync()
        const onlyWebsiteRes = await onlyWebsitePending

        expect(onlyWebsiteRes.executed).toBe(true)
        expect(onlyWebsiteRes.verified).toBe(false)
        expect(onlyWebsiteRes.retryable).toBe(false)
    })
})
