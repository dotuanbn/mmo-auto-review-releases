/**
 * Caller integration for a skipped Maps website.
 * Drives AgenticTrafficHandler and AutonomousMapAgent with typed fakes.
 * The shared website helper and KPI skill are stubbed; the caller branches are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Locator, Page } from 'playwright'

vi.mock('electron', () => ({
    app: {
        getPath: () => 'C:\\tmp\\mmo-maps-website-continuation',
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

vi.mock('../src/main/services/OllamaService', () => ({
    ollamaService: {
        chat: vi.fn(),
    },
}))

vi.mock('../src/main/automation/DOMUtils', () => ({
    DOMUtils: {
        extractInteractiveDOM: vi.fn(async () => ({ domText: 'Place panel', summaries: [] })),
        scrollObservedPage: vi.fn(async () => undefined),
        getObservedElementLocator: vi.fn(),
    },
}))

vi.mock('../src/main/automation/BrowserCursorOverlay', () => ({
    moveCursor: vi.fn(async () => undefined),
    clickCursor: vi.fn(async () => undefined),
}))

vi.mock('../src/main/services/CaptchaSolverService', () => ({
    captchaSolverService: {
        solveCaptchaOnPage: vi.fn(async () => false),
    },
}))

vi.mock('../src/main/automation/ContextualInterruptionResolver', () => ({
    contextualInterruptionResolver: {
        resolve: vi.fn(async () => ({ handled: false })),
    },
}))

vi.mock('../src/main/automation/MapsWebsiteVisit', () => ({
    visitMapsWebsite: vi.fn(),
}))

import { DOMUtils } from '../src/main/automation/DOMUtils'
import { ollamaService } from '../src/main/services/OllamaService'
import { visitMapsWebsite } from '../src/main/automation/MapsWebsiteVisit'
import { kpiSkills, type KpiAvailability, type KpiSkillResult, type MapKpiType } from '../src/main/automation/KpiSkills'
import {
    AgenticTrafficHandler,
    type AgenticPerformedAction,
} from '../src/main/automation/AgenticTrafficHandler'
import {
    AutonomousMapAgent,
    type BusinessType,
    type KpiExecutionResult,
    type SessionAction,
} from '../src/main/automation/AutonomousMapAgent'

const MAP_URL = 'https://www.google.com/maps/place/Kaffa/@10.7,106.6,17z'

interface EmptyCaptchaSignals {
    hasRecaptchaV2: boolean
    hasRecaptchaV3: boolean
    hasHcaptcha: boolean
    hasTurnstile: boolean
    hasSorryForm: boolean
    sitekey: null
    typedSitekey: null
    textHit: boolean
}

interface WebsiteVisitOptions {
    shouldStop?: () => boolean
    onStatus?: (message: string) => void
}

interface WebsiteVisitResult {
    clicked: boolean
    loaded: boolean
    mapRestored: boolean
    actions: string[]
    detail: string
    durationMs: number
    skipped: boolean
}

interface FakeLocator {
    isVisible(options?: { timeout?: number }): Promise<boolean>
    first(): FakeLocator
    count(): Promise<number>
    hover(): Promise<void>
    click(options?: { timeout?: number; force?: boolean }): Promise<void>
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number }>
}

interface FakePage {
    isClosed(): boolean
    url(): string
    bringToFront(): Promise<void>
    evaluate(pageFunction: unknown, arg?: unknown): Promise<EmptyCaptchaSignals>
    locator(selector: string): FakeLocator
    context(): { pages(): FakePage[] }
    keyboard: { press(key: string): Promise<void> }
    goBack(options?: { waitUntil?: string; timeout?: number }): Promise<void>
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>
    mouse: {
        move(x: number, y: number, options?: { steps?: number }): Promise<void>
        wheel(deltaX: number, deltaY: number): Promise<void>
    }
    viewportSize(): { width: number; height: number }
    navigations: string[]
}

interface PlannedStepCaller {
    executeStepWithSafety(
        page: Page,
        action: string,
        actionDelaySec: number,
        stepIndex: number,
        totalSteps: number,
        threadId: number,
        targetMapUrl: string,
        actionsPerformed: AgenticPerformedAction[],
        onStatusUpdate: (msg: string) => void,
        shouldStopCheck: () => boolean,
    ): Promise<'ok' | 'stop' | 'captcha'>
}

interface KpiPhaseCaller {
    executeKpiPhase(
        page: Page,
        threadId: number,
        targetMapUrl: string,
        kpiPriority: MapKpiType[],
        actions: SessionAction[],
        kpiResults: KpiExecutionResult[],
        onStatusUpdate: (msg: string) => void,
        shouldStop: () => boolean,
        precomputedAvailability?: KpiAvailability[],
        businessType?: BusinessType,
    ): Promise<void>
}

const EMPTY_CAPTCHA: EmptyCaptchaSignals = {
    hasRecaptchaV2: false,
    hasRecaptchaV3: false,
    hasHcaptcha: false,
    hasTurnstile: false,
    hasSorryForm: false,
    sitekey: null,
    typedSitekey: null,
    textHit: false,
}

function createFakePage(controlsVisible: boolean): FakePage {
    const locator: FakeLocator = {
        isVisible: async () => controlsVisible,
        first() {
            return locator
        },
        count: async () => 0,
        hover: async () => undefined,
        click: async () => undefined,
        boundingBox: async () => ({ x: 10, y: 10, width: 40, height: 16 }),
    }
    const page: FakePage = {
        isClosed: () => false,
        url: () => MAP_URL,
        bringToFront: async () => undefined,
        evaluate: async () => EMPTY_CAPTCHA,
        locator: () => locator,
        context: () => ({ pages: () => [page] }),
        keyboard: { press: async () => undefined },
        goBack: async () => {
            page.navigations.push('goBack')
        },
        goto: async () => {
            page.navigations.push('goto')
        },
        mouse: {
            move: async () => undefined,
            wheel: async () => undefined,
        },
        viewportSize: () => ({ width: 1280, height: 720 }),
        navigations: [],
    }
    return page
}

function asPage(page: FakePage): Page {
    return page as unknown as Page
}

function plannedSteps(handler: AgenticTrafficHandler): PlannedStepCaller {
    return handler as unknown as PlannedStepCaller
}

function kpiPhase(agent: AutonomousMapAgent): KpiPhaseCaller {
    return agent as unknown as KpiPhaseCaller
}

function visitResult(overrides: Partial<WebsiteVisitResult>): WebsiteVisitResult {
    return {
        clicked: false,
        loaded: false,
        mapRestored: true,
        actions: [],
        detail: '',
        durationMs: 25,
        skipped: true,
        ...overrides,
    }
}

function skillResult(overrides: Partial<KpiSkillResult> & { retryable?: boolean }): KpiSkillResult {
    return {
        executed: false,
        verified: false,
        actions: [],
        detail: '',
        durationMs: 15,
        ...overrides,
    }
}

function actionNamed(actions: Array<{ action: string }>, name: string) {
    return actions.find(action => action.action === name)
}

async function runPlannedStep(
    handler: AgenticTrafficHandler,
    page: FakePage,
    action: string,
    delaySeconds: number,
    actions: AgenticPerformedAction[],
    shouldStop: () => boolean,
    onStatus: (message: string) => void,
    stepIndex: number,
): Promise<'ok' | 'stop' | 'captcha'> {
    return plannedSteps(handler).executeStepWithSafety(
        asPage(page),
        action,
        delaySeconds,
        stepIndex,
        2,
        4,
        MAP_URL,
        actions,
        onStatus,
        shouldStop,
    )
}

describe('Maps website continuation', () => {
    let restoreExecuteKpi: (() => void) | undefined

    beforeEach(() => {
        const executeKpi = vi.spyOn(kpiSkills, 'executeKpi')
        executeKpi.mockRejectedValue(new Error('unexpected executeKpi'))
        restoreExecuteKpi = () => executeKpi.mockRestore()
        vi.mocked(DOMUtils.scrollObservedPage).mockClear()
        vi.mocked(ollamaService.chat).mockReset()
        vi.mocked(visitMapsWebsite).mockReset()
    })

    afterEach(() => {
        restoreExecuteKpi?.()
        restoreExecuteKpi = undefined
        vi.useRealTimers()
    })

    it('runs the next planned action after a skipped website without the long reading delay', async () => {
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(true)
        const actions: AgenticPerformedAction[] = []
        const statuses: string[] = []
        let stopArmed = false
        const shouldStop = () => stopArmed
        vi.mocked(visitMapsWebsite).mockImplementation(async (_page: Page, _locator: Locator, options?: WebsiteVisitOptions) => {
            expect(options?.shouldStop).toBe(shouldStop)
            expect(options?.shouldStop?.()).toBe(false)
            stopArmed = true
            expect(options?.shouldStop?.()).toBe(true)
            stopArmed = false
            options?.onStatus?.('website_skipped_timeout: connection timed out')
            return visitResult({
                clicked: true,
                loaded: false,
                mapRestored: true,
                skipped: true,
                actions: ['website_click', 'website_skipped_timeout'],
                detail: 'website_skipped_timeout: connection timed out',
            })
        })

        const started = Date.now()
        const websiteStatus = await runPlannedStep(
            handler,
            page,
            'browse_website',
            30,
            actions,
            shouldStop,
            (message) => statuses.push(message),
            0,
        )
        const scrollStatus = await runPlannedStep(
            handler,
            page,
            'scroll_down',
            0,
            actions,
            shouldStop,
            (message) => statuses.push(message),
            1,
        )

        expect(Date.now() - started).toBeLessThan(5000)
        expect(websiteStatus).toBe('ok')
        expect(scrollStatus).toBe('ok')
        expect(vi.mocked(visitMapsWebsite)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(DOMUtils.scrollObservedPage)).toHaveBeenCalledTimes(1)
        expect(page.navigations).toEqual([])
        expect(actionNamed(actions, 'execute_browse_website')).toMatchObject({
            success: false,
            detail: 'website_skipped_timeout: connection timed out',
        })
        expect(actionNamed(actions, 'website_click')).toMatchObject({ success: true })
        expect(actionNamed(actions, 'website_skipped_timeout')).toMatchObject({
            success: false,
            detail: 'website_skipped_timeout: connection timed out',
        })
        expect(actionNamed(actions, 'execute_scroll_down')).toMatchObject({ success: true })
        expect(statuses.some(message => message.includes('website_skipped_timeout: connection timed out'))).toBe(true)
        const websiteIndex = actions.findIndex(action => action.action === 'execute_browse_website')
        const scrollIndex = actions.findIndex(action => action.action === 'execute_scroll_down')
        expect(scrollIndex).toBeGreaterThan(websiteIndex)
    }, 8000)

    it('records a missing website control as a failed step and still scrolls', async () => {
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(false)
        const actions: AgenticPerformedAction[] = []

        const websiteStatus = await runPlannedStep(handler, page, 'browse_website', 30, actions, () => false, () => undefined, 0)
        const scrollStatus = await runPlannedStep(handler, page, 'scroll_down', 0, actions, () => false, () => undefined, 1)

        expect(websiteStatus).toBe('ok')
        expect(scrollStatus).toBe('ok')
        expect(vi.mocked(visitMapsWebsite)).not.toHaveBeenCalled()
        expect(actionNamed(actions, 'execute_browse_website')).toMatchObject({
            success: false,
            detail: 'website_skipped_no_element: No website button found',
        })
        expect(actionNamed(actions, 'website_skipped_no_element')).toMatchObject({ success: false })
        expect(actionNamed(actions, 'execute_scroll_down')?.success).toBe(true)
        expect(page.navigations).toEqual([])
    }, 8000)

    it('records a loaded website as successful and continues', async () => {
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(true)
        const actions: AgenticPerformedAction[] = []
        vi.mocked(visitMapsWebsite).mockResolvedValue(visitResult({
            clicked: true,
            loaded: true,
            mapRestored: true,
            skipped: false,
            actions: ['website_click', 'website_loaded'],
            detail: 'Website loaded',
        }))

        const websiteStatus = await runPlannedStep(handler, page, 'browse_website', 0, actions, () => false, () => undefined, 0)
        const scrollStatus = await runPlannedStep(handler, page, 'scroll_down', 0, actions, () => false, () => undefined, 1)

        expect(websiteStatus).toBe('ok')
        expect(scrollStatus).toBe('ok')
        expect(vi.mocked(visitMapsWebsite)).toHaveBeenCalledTimes(1)
        expect(actionNamed(actions, 'execute_browse_website')).toMatchObject({
            success: true,
            detail: 'Website loaded',
        })
        expect(actionNamed(actions, 'website_click')).toMatchObject({ success: true })
        expect(actionNamed(actions, 'website_loaded')).toMatchObject({ success: true })
        expect(actionNamed(actions, 'execute_scroll_down')?.success).toBe(true)
        expect(page.navigations).toEqual([])
    }, 8000)

    it('records a loaded website as failed when Maps was not restored', async () => {
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(true)
        const actions: AgenticPerformedAction[] = []
        vi.mocked(visitMapsWebsite).mockResolvedValue(visitResult({
            clicked: true,
            loaded: true,
            mapRestored: false,
            skipped: false,
            actions: ['website_click', 'website_map_not_restored'],
            detail: 'website_map_not_restored: direct navigation failed',
        }))

        const started = Date.now()
        const status = await runPlannedStep(handler, page, 'browse_website', 30, actions, () => false, () => undefined, 0)

        expect(status).toBe('ok')
        expect(Date.now() - started).toBeLessThan(3000)
        expect(actionNamed(actions, 'execute_browse_website')).toMatchObject({
            success: false,
            detail: 'website_map_not_restored: direct navigation failed',
        })
        expect(actionNamed(actions, 'website_click')).toMatchObject({ success: true })
        expect(actionNamed(actions, 'website_map_not_restored')).toMatchObject({ success: false })
        expect(vi.mocked(DOMUtils.scrollObservedPage)).not.toHaveBeenCalled()
        expect(page.navigations).toEqual([])
    }, 4000)

    it('continues the public plan after a skipped website and does not browse it again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(true)
        vi.mocked(ollamaService.chat).mockResolvedValue({
            success: true,
            response: JSON.stringify({
                thought: 'Open the website, then keep reading the map',
                actions: [
                    { action: 'browse_website', delay_seconds: 20 },
                    { action: 'scroll_down', delay_seconds: 1 },
                ],
            }),
        })
        vi.mocked(visitMapsWebsite).mockResolvedValue(visitResult({
            clicked: true,
            loaded: false,
            mapRestored: true,
            skipped: true,
            actions: ['website_click', 'website_skipped_timeout'],
            detail: 'website_skipped_timeout: connection timed out',
        }))

        const pending = handler.performBrowsing(
            asPage(page),
            'Kaffa',
            4,
            4,
            () => undefined,
            () => false,
        )
        await vi.runAllTimersAsync()
        const result = await pending

        expect(vi.mocked(visitMapsWebsite)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(DOMUtils.scrollObservedPage)).toHaveBeenCalledTimes(1)
        expect(actionNamed(result.actionsPerformed, 'execute_browse_website')).toMatchObject({ success: false })
        expect(actionNamed(result.actionsPerformed, 'website_skipped_timeout')).toMatchObject({ success: false })
        expect(actionNamed(result.actionsPerformed, 'website_click')).toMatchObject({ success: true })
        expect(actionNamed(result.actionsPerformed, 'execute_scroll_down')).toMatchObject({ success: true })
        const websiteIndex = result.actionsPerformed.findIndex(action => action.action === 'execute_browse_website')
        const scrollIndex = result.actionsPerformed.findIndex(action => action.action === 'execute_scroll_down')
        expect(scrollIndex).toBeGreaterThan(websiteIndex)
    })

    it('does not retry a non-retryable website KPI and still runs a later planned action', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(true)
        const waits = Array.from({ length: 6 }, () => ({ action: 'wait', delay_seconds: 1 }))
        vi.mocked(ollamaService.chat).mockResolvedValue({
            success: true,
            response: JSON.stringify({
                thought: 'Warm up, run the KPI, then keep browsing',
                actions: waits,
            }),
        })
        vi.mocked(kpiSkills.executeKpi).mockResolvedValue(skillResult({
            executed: true,
            verified: false,
            retryable: false,
            actions: ['website_click', 'website_skipped_timeout'],
            detail: 'website_skipped_timeout: connection timed out',
            durationMs: 40,
        }))

        const pending = handler.performBrowsing(
            asPage(page),
            'Kaffa',
            8,
            4,
            () => undefined,
            () => false,
            'website',
        )
        await vi.runAllTimersAsync()
        const result = await pending

        expect(vi.mocked(kpiSkills.executeKpi)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(visitMapsWebsite)).not.toHaveBeenCalled()
        const kpi = actionNamed(result.actionsPerformed, 'kpi_skill_website')
        expect(kpi).toMatchObject({
            success: false,
            detail: 'website_skipped_timeout: connection timed out',
        })
        expect(actionNamed(result.actionsPerformed, 'website_click')).toMatchObject({ success: true })
        expect(actionNamed(result.actionsPerformed, 'website_skipped_timeout')).toMatchObject({ success: false })
        expect(result.actionsPerformed.some(action => action.action.includes('retry'))).toBe(false)
        const kpiIndex = result.actionsPerformed.findIndex(action => action.action === 'kpi_skill_website')
        const laterWait = result.actionsPerformed.findIndex((action, index) => action.action === 'execute_wait' && index > kpiIndex)
        expect(laterWait).toBeGreaterThan(kpiIndex)
    })

    it('still retries an unverified phone KPI when retryable is absent', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
        const handler = new AgenticTrafficHandler()
        const page = createFakePage(true)
        const waits = Array.from({ length: 6 }, () => ({ action: 'wait', delay_seconds: 1 }))
        vi.mocked(ollamaService.chat).mockResolvedValue({
            success: true,
            response: JSON.stringify({ thought: 'phone retry stays available', actions: waits }),
        })
        vi.mocked(kpiSkills.executeKpi)
            .mockResolvedValueOnce(skillResult({
                executed: true,
                verified: false,
                actions: ['phone_click'],
                detail: 'dial shown',
            }))
            .mockResolvedValueOnce(skillResult({
                executed: true,
                verified: true,
                actions: ['phone_confirmed'],
                detail: 'dial confirmed',
            }))

        const pending = handler.performBrowsing(
            asPage(page),
            'Kaffa',
            8,
            4,
            () => undefined,
            () => false,
            'phone',
        )
        await vi.runAllTimersAsync()
        const result = await pending

        expect(vi.mocked(kpiSkills.executeKpi)).toHaveBeenCalledTimes(2)
        expect(actionNamed(result.actionsPerformed, 'kpi_skill_phone')).toMatchObject({ success: true })
        expect(actionNamed(result.actionsPerformed, 'kpi_skill_retry_phone')).toMatchObject({ success: true })
        expect(result.actionsPerformed.some(action => action.action === 'phone_click')).toBe(false)
    })

    it('keeps autonomous website failure false, does not retry it, and still runs the next KPI', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
        const agent = new AutonomousMapAgent()
        const page = createFakePage(true)
        const actions: SessionAction[] = []
        const kpiResults: KpiExecutionResult[] = []
        let phoneCalls = 0
        vi.mocked(kpiSkills.executeKpi).mockImplementation(async (_page: Page, _threadId: number, target: string) => {
            if (target === 'website') {
                return skillResult({
                    executed: true,
                    verified: false,
                    retryable: false,
                    actions: ['website_click', 'website_skipped_dns'],
                    detail: 'website_skipped_dns: name not resolved',
                    durationMs: 30,
                })
            }
            phoneCalls += 1
            if (phoneCalls === 1) {
                return skillResult({
                    executed: true,
                    verified: false,
                    actions: ['phone_click'],
                    detail: 'dial shown',
                })
            }
            return skillResult({
                executed: true,
                verified: true,
                actions: ['phone_confirmed'],
                detail: 'dial confirmed',
            })
        })

        const pending = kpiPhase(agent).executeKpiPhase(
            asPage(page),
            4,
            MAP_URL,
            ['website', 'phone'],
            actions,
            kpiResults,
            () => undefined,
            () => false,
            [
                { type: 'website', available: true, detail: 'Found website action by selector' },
                { type: 'phone', available: true, detail: 'Found phone action by selector' },
            ],
            'generic',
        )
        await vi.runAllTimersAsync()
        await pending

        const targets = vi.mocked(kpiSkills.executeKpi).mock.calls.map(call => call[2])
        expect(targets).toEqual(['website', 'phone', 'phone'])
        expect(actionNamed(actions, 'kpi_website')).toMatchObject({
            success: false,
            detail: 'website_skipped_dns: name not resolved',
        })
        expect(actionNamed(actions, 'website_click')).toMatchObject({
            success: true,
            detail: 'website_skipped_dns: name not resolved',
        })
        expect(actionNamed(actions, 'website_skipped_dns')).toMatchObject({
            success: false,
            detail: 'website_skipped_dns: name not resolved',
        })
        expect(actions.some(action => action.action === 'kpi_retry_website')).toBe(false)
        expect(actionNamed(actions, 'kpi_phone')).toMatchObject({ success: true })
        expect(actionNamed(actions, 'phone_click')).toMatchObject({
            success: true,
            detail: 'phone: phone_click',
        })
        expect(actionNamed(actions, 'kpi_retry_phone')).toMatchObject({ success: true })
        expect(kpiResults.map(result => ({ type: result.kpiType, executed: result.executed, verified: result.verified }))).toEqual([
            { type: 'website', executed: true, verified: false },
            { type: 'phone', executed: true, verified: true },
        ])
        expect(page.navigations).toEqual([])
    })

    it('keeps a verified autonomous website successful without a second attempt', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
        const agent = new AutonomousMapAgent()
        const page = createFakePage(true)
        const actions: SessionAction[] = []
        const kpiResults: KpiExecutionResult[] = []
        vi.mocked(kpiSkills.executeKpi).mockResolvedValue(skillResult({
            executed: true,
            verified: true,
            actions: ['website_click', 'website_loaded'],
            detail: 'Website loaded',
            durationMs: 50,
        }))

        const pending = kpiPhase(agent).executeKpiPhase(
            asPage(page),
            4,
            MAP_URL,
            ['website'],
            actions,
            kpiResults,
            () => undefined,
            () => false,
            [{ type: 'website', available: true, detail: 'Found website action by selector' }],
            'generic',
        )
        await vi.runAllTimersAsync()
        await pending

        expect(vi.mocked(kpiSkills.executeKpi)).toHaveBeenCalledTimes(1)
        expect(actionNamed(actions, 'kpi_website')).toMatchObject({ success: true, detail: 'Website loaded' })
        expect(actionNamed(actions, 'website_click')).toMatchObject({ success: true })
        expect(actionNamed(actions, 'website_loaded')).toMatchObject({ success: true, detail: 'Website loaded' })
        expect(actions.some(action => action.action.includes('retry'))).toBe(false)
        expect(kpiResults).toEqual([
            expect.objectContaining({ kpiType: 'website', executed: true, verified: true, detail: 'Website loaded' }),
        ])
    })
})
