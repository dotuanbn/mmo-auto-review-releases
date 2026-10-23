/**
 * Review verification worker lifecycle, queue pacing, and browser cleanup.
 * Browser, database, settings, and the verification service are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {},
}))

vi.mock('../src/main/automation/BrowserService', () => ({
    browserService: {
        createContext: vi.fn(),
        getPage: vi.fn(),
        closeContext: vi.fn(),
    },
}))

vi.mock('../src/main/services/ReviewVerificationService', () => ({
    reviewVerificationService: {
        getVerificationQueue: vi.fn(),
        recordVerificationResult: vi.fn(),
    },
}))

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: vi.fn(() => ({
        enableReviewVerification: false,
        reviewVerificationIntervalMinutes: 30,
        reviewVerificationMaxPerTick: 10,
    })),
}))

import { browserService } from '../src/main/automation/BrowserService'
import { loadSettings } from '../src/main/ipc/settings'
import { reviewVerificationService } from '../src/main/services/ReviewVerificationService'
import { ReviewVerificationWorker } from '../src/main/services/ReviewVerificationWorker'
import type { ReviewVerificationQueueItem } from '../src/shared/review-history-contracts'

const createContext = vi.mocked(browserService.createContext)
const getPage = vi.mocked(browserService.getPage)
const closeContext = vi.mocked(browserService.closeContext)
const getVerificationQueue = vi.mocked(reviewVerificationService.getVerificationQueue)
const recordVerificationResult = vi.mocked(reviewVerificationService.recordVerificationResult)

interface WorkerInternals {
    enabled: boolean
    ticking: boolean
}

function internals(worker: ReviewVerificationWorker): WorkerInternals {
    return worker as unknown as WorkerInternals
}

function makeItem(historyId: number, reviewText = 'Great coffee and friendly staff in the old quarter'): ReviewVerificationQueueItem {
    return {
        historyId,
        accountId: 5,
        accountEmail: 'user@example.com',
        locationId: 9,
        locationName: 'Cafe Test',
        locationUrl: `https://maps.google.com/?cid=${historyId}`,
        rating: 5,
        reviewText,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        lastCheckAt: null,
        checkCount: 0,
        verifiedStatus: 'pending',
        googleReviewId: null,
        styleApplied: false,
    }
}

interface MockMatch {
    count: ReturnType<typeof vi.fn>
    first: ReturnType<typeof vi.fn>
    getAttribute: ReturnType<typeof vi.fn>
    filter: ReturnType<typeof vi.fn>
}

function createMockPage(options: {
    counts: number[]
    reviewId?: string | null
    goto?: () => Promise<unknown>
}): { page: Page; match: MockMatch; locator: ReturnType<typeof vi.fn> } {
    const counts = [...options.counts]
    const match: MockMatch = {
        count: vi.fn(async () => {
            const next = counts.shift()
            return next ?? 0
        }),
        first: vi.fn(),
        getAttribute: vi.fn(async () => options.reviewId ?? null),
        filter: vi.fn(),
    }
    match.first.mockReturnValue(match)
    match.filter.mockReturnValue(match)
    const locator = vi.fn(() => match)
    const page = {
        goto: options.goto ?? vi.fn().mockResolvedValue(undefined),
        locator,
    }
    return { page: page as unknown as Page, match, locator }
}

describe('ReviewVerificationWorker', () => {
    let worker: ReviewVerificationWorker

    beforeEach(() => {
        worker = new ReviewVerificationWorker()
        createContext.mockReset()
        getPage.mockReset()
        closeContext.mockReset()
        getVerificationQueue.mockReset()
        recordVerificationResult.mockReset()
        createContext.mockResolvedValue(11)
        closeContext.mockResolvedValue(undefined)
        getVerificationQueue.mockReturnValue([])
        recordVerificationResult.mockReturnValue({} as never)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(loadSettings().enableReviewVerification).toBe(false)
    })

    afterEach(() => {
        worker.stop()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('start/stop/isRunning lifecycle', () => {
        expect(worker.isRunning()).toBe(false)
        worker.start()
        expect(worker.isRunning()).toBe(true)
        expect(internals(worker).enabled).toBe(true)
        worker.stop()
        expect(worker.isRunning()).toBe(false)
        expect(internals(worker).enabled).toBe(false)
    })

    it('tick skips when ticking guard is active', async () => {
        internals(worker).ticking = true
        internals(worker).enabled = true
        const processSpy = vi.spyOn(worker, 'processQueue').mockResolvedValue(undefined)
        await worker.tick()
        expect(processSpy).not.toHaveBeenCalled()
        expect(internals(worker).ticking).toBe(true)
    })

    it('processQueue with empty queue logs and returns', async () => {
        getVerificationQueue.mockReturnValue([])
        const checkSpy = vi.spyOn(worker, 'checkSingleReview')
        await worker.processQueue()
        expect(getVerificationQueue).toHaveBeenCalledWith(10)
        expect(checkSpy).not.toHaveBeenCalled()
        expect(console.log).toHaveBeenCalledWith('[ReviewVerifier] Verification queue empty')
        expect(createContext).not.toHaveBeenCalled()
    })

    it('processQueue calls checkSingleReview for each item', async () => {
        vi.useFakeTimers()
        internals(worker).enabled = true
        const first = makeItem(1)
        const second = makeItem(2)
        getVerificationQueue.mockReturnValue([first, second])
        const checkSpy = vi.spyOn(worker, 'checkSingleReview').mockResolvedValue(undefined)
        const timeoutSpy = vi.spyOn(global, 'setTimeout')

        const pending = worker.processQueue()
        await vi.runAllTimersAsync()
        await pending

        expect(checkSpy).toHaveBeenCalledTimes(2)
        expect(checkSpy).toHaveBeenNthCalledWith(1, first)
        expect(checkSpy).toHaveBeenNthCalledWith(2, second)
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000)
    })

    it('checkSingleReview records live status when review text found', async () => {
        const item = makeItem(7)
        const { page, locator, match } = createMockPage({ counts: [1], reviewId: 'gid-7' })
        getPage.mockReturnValue(page)

        await worker.checkSingleReview(item)

        expect(createContext).toHaveBeenCalledWith({ headless: true, cleanProfileOnStart: true, shouldAbort: expect.any(Function) })
        expect(locator).toHaveBeenCalledWith('.review-full-text, [data-review-id], .MyEned')
        expect(match.filter).toHaveBeenCalledWith({ hasText: item.reviewText.slice(0, 40) })
        expect(recordVerificationResult).toHaveBeenCalledWith(expect.objectContaining({
            historyId: 7,
            status: 'live',
            googleReviewId: 'gid-7',
        }))
        expect(console.log).toHaveBeenCalledWith(
            '[ReviewVerifier] historyId=7 location=Cafe Test status=live',
        )
        expect(closeContext).toHaveBeenCalledWith(11)
    })

    it('checkSingleReview records removed status when review not found', async () => {
        const item = makeItem(8)
        const { page, locator } = createMockPage({ counts: [0, 0] })
        getPage.mockReturnValue(page)

        await worker.checkSingleReview(item)

        expect(locator).toHaveBeenCalledWith('[class*=review] span, [class*=comment] span')
        expect(recordVerificationResult).toHaveBeenCalledWith(expect.objectContaining({
            historyId: 8,
            status: 'removed',
        }))
        const payload = recordVerificationResult.mock.calls[0]?.[0]
        expect(payload?.googleReviewId).toBeUndefined()
        expect(closeContext).toHaveBeenCalledWith(11)
    })

    it('checkSingleReview records unknown on navigation error', async () => {
        const item = makeItem(9)
        const { page } = createMockPage({
            counts: [1],
            goto: () => Promise.reject(new Error('Navigation timeout')),
        })
        getPage.mockReturnValue(page)

        await worker.checkSingleReview(item)

        expect(recordVerificationResult).toHaveBeenCalledWith(expect.objectContaining({
            historyId: 9,
            status: 'unknown',
        }))
        expect(closeContext).toHaveBeenCalledWith(11)
    })

    it('checkSingleReview always closes browser context', async () => {
        const live = createMockPage({ counts: [1], reviewId: 'gid-live' })
        getPage.mockReturnValue(live.page)
        await worker.checkSingleReview(makeItem(1))
        expect(closeContext).toHaveBeenCalledTimes(1)
        expect(closeContext).toHaveBeenCalledWith(11)

        closeContext.mockClear()
        const broken = createMockPage({
            counts: [],
            goto: () => Promise.reject(new Error('net::ERR')),
        })
        getPage.mockReturnValue(broken.page)
        await worker.checkSingleReview(makeItem(2))
        expect(closeContext).toHaveBeenCalledTimes(1)
        expect(closeContext).toHaveBeenCalledWith(11)
    })

    it('processQueue stops early when worker disabled mid-loop', async () => {
        vi.useFakeTimers()
        internals(worker).enabled = true
        getVerificationQueue.mockReturnValue([makeItem(1), makeItem(2)])
        const checkSpy = vi.spyOn(worker, 'checkSingleReview').mockImplementation(async () => {
            worker.stop()
        })

        const pending = worker.processQueue()
        await vi.runAllTimersAsync()
        await pending

        expect(checkSpy).toHaveBeenCalledTimes(1)
        expect(checkSpy).toHaveBeenCalledWith(expect.objectContaining({ historyId: 1 }))
        expect(worker.isRunning()).toBe(false)
    })
})
