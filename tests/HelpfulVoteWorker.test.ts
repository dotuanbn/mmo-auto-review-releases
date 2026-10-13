/**
 * Helpful vote candidate selection, per-account rate limits, and browser cleanup.
 * Database, browser, and settings are mocked. No Electron and no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        reviewHistory: {
            id: 'reviewHistory.id',
            accountId: 'reviewHistory.accountId',
            locationId: 'reviewHistory.locationId',
            rating: 'reviewHistory.rating',
            reviewText: 'reviewHistory.reviewText',
            status: 'reviewHistory.status',
            createdAt: 'reviewHistory.createdAt',
            verifiedStatus: 'reviewHistory.verifiedStatus',
            googleReviewId: 'reviewHistory.googleReviewId',
        },
        accounts: {
            id: 'accounts.id',
            email: 'accounts.email',
            status: 'accounts.status',
            warmupLevel: 'accounts.warmupLevel',
        },
        locations: {
            id: 'locations.id',
            name: 'locations.name',
            url: 'locations.url',
        },
    },
}))

vi.mock('../src/main/automation/BrowserService', () => ({
    browserService: {
        createContext: vi.fn(),
        getPage: vi.fn(),
        closeContext: vi.fn(),
    },
}))

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: vi.fn(() => ({})),
}))

import { browserService } from '../src/main/automation/BrowserService'
import { getDatabase, schema } from '../src/main/database'
import { HelpfulVoteService, helpfulVoteService } from '../src/main/services/HelpfulVoteService'
import { HelpfulVoteWorker } from '../src/main/services/HelpfulVoteWorker'
import type { HelpfulVoteCandidate } from '../src/shared/helpful-vote-contracts'

const createContext = vi.mocked(browserService.createContext)
const getPage = vi.mocked(browserService.getPage)
const closeContext = vi.mocked(browserService.closeContext)
const getDatabaseMock = vi.mocked(getDatabase)

const NOW = new Date('2026-10-13T12:00:00.000Z')
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000

function daysBefore(days: number, from: Date = NOW): Date {
    return new Date(from.getTime() - days * MS_PER_DAY)
}

interface CandidateQueryRow {
    historyId: number
    reviewAccountId: number
    reviewAccountEmail: string
    locationId: number
    locationName: string
    locationUrl: string
    reviewText: string
    rating: number
    reviewCreatedAt: Date
    verifiedStatus: 'live' | 'pending' | 'removed' | 'unknown' | null
    googleReviewId: string | null
    status: 'success' | 'failed'
}

interface AccountQueryRow {
    id: number
    email: string
    status: 'active' | 'banned' | 'pending' | 'suspended' | 'checking'
    warmupLevel: number
}

interface ServiceMemory {
    votedReviews: Set<number>
    accountVotesToday: Map<number, { count: number; lastVoteAt: Date }>
}

interface WorkerInternals {
    enabled: boolean
    ticking: boolean
}

function memory(service: HelpfulVoteService): ServiceMemory {
    return service as unknown as ServiceMemory
}

function internals(worker: HelpfulVoteWorker): WorkerInternals {
    return worker as unknown as WorkerInternals
}

function candidateRow(overrides: Partial<CandidateQueryRow> & Pick<CandidateQueryRow, 'historyId'>): CandidateQueryRow {
    return {
        reviewAccountId: 8,
        reviewAccountEmail: 'author@example.com',
        locationId: 4,
        locationName: 'Cafe Test',
        locationUrl: 'https://maps.example/cafe',
        reviewText: 'Excellent pho and quick service near the lake',
        rating: 5,
        reviewCreatedAt: daysBefore(10),
        verifiedStatus: 'live',
        googleReviewId: null,
        status: 'success',
        ...overrides,
    }
}

function accountRow(overrides: Partial<AccountQueryRow> & Pick<AccountQueryRow, 'id' | 'email'>): AccountQueryRow {
    return {
        status: 'active',
        warmupLevel: 40,
        ...overrides,
    }
}

function installDb(options: {
    candidates?: CandidateQueryRow[]
    accounts?: AccountQueryRow[]
    locationAuthors?: { accountId: number }[]
}): void {
    const select = vi.fn(() => ({
        from: (table: unknown) => {
            if (table === schema.accounts) {
                return {
                    where: () => ({
                        all: () => options.accounts ?? [],
                    }),
                }
            }
            return {
                innerJoin: () => ({
                    innerJoin: () => ({
                        where: () => ({
                            orderBy: () => ({
                                all: () => options.candidates ?? [],
                            }),
                        }),
                    }),
                }),
                where: () => ({
                    all: () => options.locationAuthors ?? [],
                }),
            }
        },
    }))
    getDatabaseMock.mockReturnValue({ select } as never)
}

function makeCandidate(
    historyId: number,
    reviewText = 'Great coffee and friendly staff in the old quarter today',
): HelpfulVoteCandidate {
    return {
        historyId,
        reviewAccountId: 5,
        reviewAccountEmail: 'author@example.com',
        locationId: 9,
        locationName: 'Cafe Test',
        locationUrl: `https://maps.google.com/?cid=${historyId}`,
        reviewText,
        rating: 5,
        reviewCreatedAt: daysBefore(10),
        verifiedStatus: 'live',
        googleReviewId: null,
    }
}

const voter = { accountId: 4, email: 'voter@example.com' }

interface CountableLocator {
    count: ReturnType<typeof vi.fn>
    click: ReturnType<typeof vi.fn>
    first: ReturnType<typeof vi.fn>
    filter: ReturnType<typeof vi.fn>
    locator: ReturnType<typeof vi.fn>
}

function createMockPage(options: {
    reviewCounts: number[]
    buttonCounts?: number[]
    goto?: () => Promise<unknown>
    click?: () => Promise<unknown>
}): {
    page: Page
    goto: ReturnType<typeof vi.fn>
    locator: ReturnType<typeof vi.fn>
    review: CountableLocator
    button: CountableLocator
} {
    const reviewCounts = [...options.reviewCounts]
    const buttonCounts = [...(options.buttonCounts ?? [])]
    const button: CountableLocator = {
        count: vi.fn(async () => buttonCounts.shift() ?? 0),
        click: vi.fn(options.click ?? (async () => undefined)),
        first: vi.fn(),
        filter: vi.fn(),
        locator: vi.fn(),
    }
    button.first.mockReturnValue(button)
    button.filter.mockReturnValue(button)
    button.locator.mockReturnValue(button)

    const review: CountableLocator = {
        count: vi.fn(async () => reviewCounts.shift() ?? 0),
        click: vi.fn(async () => undefined),
        first: vi.fn(),
        filter: vi.fn(),
        locator: vi.fn((selector: string) => (selector === '..' ? review : button)),
    }
    review.first.mockReturnValue(review)
    review.filter.mockReturnValue(review)

    const locator = vi.fn(() => review)
    const goto = vi.fn(options.goto ?? (async () => undefined))
    const page = { goto, locator } as unknown as Page
    return { page, goto, locator, review, button }
}

describe('HelpfulVoteService', () => {
    let service: HelpfulVoteService

    beforeEach(() => {
        service = new HelpfulVoteService()
        getDatabaseMock.mockReset()
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('getVoteCandidates returns eligible reviews inside the age window, oldest first', () => {
        expect(HelpfulVoteService.MIN_AGE_DAYS).toBe(3)
        expect(HelpfulVoteService.MAX_AGE_DAYS).toBe(30)

        const oldest = candidateRow({
            historyId: 3,
            reviewCreatedAt: daysBefore(30),
            verifiedStatus: 'live',
            googleReviewId: 'gid-3',
        })
        const middle = candidateRow({
            historyId: 10,
            reviewCreatedAt: daysBefore(10),
            verifiedStatus: 'pending',
        })
        const youngest = candidateRow({
            historyId: 2,
            reviewCreatedAt: daysBefore(3),
            verifiedStatus: 'pending',
        })
        installDb({
            candidates: [
                youngest,
                candidateRow({ historyId: 1, reviewCreatedAt: daysBefore(2) }),
                oldest,
                candidateRow({
                    historyId: 4,
                    reviewCreatedAt: new Date(NOW.getTime() - 30 * MS_PER_DAY - 1),
                }),
                candidateRow({ historyId: 5, status: 'failed' }),
                candidateRow({ historyId: 6, verifiedStatus: 'removed' }),
                candidateRow({
                    historyId: 7,
                    reviewCreatedAt: new Date(NOW.getTime() - 3 * MS_PER_DAY + 1),
                }),
                candidateRow({ historyId: 8, verifiedStatus: 'unknown' }),
                candidateRow({ historyId: 9, verifiedStatus: null }),
                middle,
            ],
        })

        const limited = service.getVoteCandidates(1, NOW)
        expect(limited.map((row) => row.historyId)).toEqual([3])
        expect(limited[0]).toEqual({
            historyId: 3,
            reviewAccountId: 8,
            reviewAccountEmail: 'author@example.com',
            locationId: 4,
            locationName: 'Cafe Test',
            locationUrl: 'https://maps.example/cafe',
            reviewText: 'Excellent pho and quick service near the lake',
            rating: 5,
            reviewCreatedAt: oldest.reviewCreatedAt,
            verifiedStatus: 'live',
            googleReviewId: 'gid-3',
        })

        expect(service.getVoteCandidates(20, NOW).map((row) => row.historyId)).toEqual([3, 10, 2])
    })

    it('pickVoterAccount excludes the review author and rate-limited accounts', () => {
        installDb({
            accounts: [
                accountRow({ id: 4, email: 'cold@example.com', warmupLevel: 10 }),
                accountRow({ id: 1, email: 'author@example.com', warmupLevel: 99 }),
                accountRow({ id: 2, email: 'limited@example.com', warmupLevel: 80 }),
                accountRow({ id: 3, email: 'voter@example.com', warmupLevel: 40 }),
            ],
            locationAuthors: [],
        })
        const cooledAt = new Date(NOW.getTime() - HelpfulVoteService.VOTE_COOLDOWN_HOURS * MS_PER_HOUR)
        for (let index = 0; index < HelpfulVoteService.MAX_VOTES_PER_ACCOUNT_PER_DAY; index += 1) {
            service.recordVote({
                historyId: 500 + index,
                voterAccountId: 2,
                votedAt: cooledAt,
                success: true,
            })
        }

        expect(service.pickVoterAccount(1, 9, NOW)).toEqual({
            accountId: 3,
            email: 'voter@example.com',
        })
    })

    it('pickVoterAccount returns null when no eligible voter exists', () => {
        installDb({
            accounts: [
                accountRow({ id: 1, email: 'author@example.com', warmupLevel: 100 }),
                accountRow({ id: 2, email: 'banned@example.com', status: 'banned', warmupLevel: 90 }),
                accountRow({ id: 3, email: 'same-place@example.com', warmupLevel: 80 }),
                accountRow({ id: 4, email: 'pending@example.com', status: 'pending', warmupLevel: 70 }),
            ],
            locationAuthors: [{ accountId: 3 }],
        })

        expect(service.pickVoterAccount(1, 9, NOW)).toBeNull()
    })

    it('recordVote marks the review as voted and tracks the account count', () => {
        const createdAt = daysBefore(10)
        installDb({
            candidates: [candidateRow({ historyId: 42, reviewCreatedAt: createdAt })],
        })

        expect(service.getVoteCandidates(20, NOW).map((row) => row.historyId)).toEqual([42])
        service.recordVote({
            historyId: 42,
            voterAccountId: 7,
            votedAt: NOW,
            success: true,
        })
        service.recordVote({
            historyId: 43,
            voterAccountId: 7,
            votedAt: NOW,
            success: false,
            errorMessage: 'skipped: review not found',
        })

        expect(service.getVoteCandidates(20, NOW)).toEqual([])
        expect(memory(service).votedReviews.has(42)).toBe(true)
        expect(memory(service).votedReviews.has(43)).toBe(true)
        expect(memory(service).accountVotesToday.get(7)).toEqual({ count: 2, lastVoteAt: NOW })
        expect(console.log).toHaveBeenCalledWith(
            '[HelpfulVote] recorded historyId=42 voterAccountId=7 success=true dailyCount=1',
        )
    })

    it('rate limiting: account cannot vote more than MAX_VOTES_PER_ACCOUNT_PER_DAY', () => {
        expect(HelpfulVoteService.MAX_VOTES_PER_ACCOUNT_PER_DAY).toBe(3)
        installDb({
            accounts: [
                accountRow({ id: 1, email: 'author@example.com', warmupLevel: 10 }),
                accountRow({ id: 2, email: 'voter@example.com', warmupLevel: 50 }),
            ],
            locationAuthors: [],
        })
        const cooledAt = new Date(NOW.getTime() - HelpfulVoteService.VOTE_COOLDOWN_HOURS * MS_PER_HOUR)

        const underCap = new HelpfulVoteService()
        for (let index = 0; index < HelpfulVoteService.MAX_VOTES_PER_ACCOUNT_PER_DAY - 1; index += 1) {
            underCap.recordVote({
                historyId: 200 + index,
                voterAccountId: 2,
                votedAt: cooledAt,
                success: true,
            })
        }
        expect(underCap.pickVoterAccount(1, 9, NOW)).toEqual({
            accountId: 2,
            email: 'voter@example.com',
        })

        for (let index = 0; index < HelpfulVoteService.MAX_VOTES_PER_ACCOUNT_PER_DAY; index += 1) {
            service.recordVote({
                historyId: 300 + index,
                voterAccountId: 2,
                votedAt: cooledAt,
                success: true,
            })
        }
        expect(memory(service).accountVotesToday.get(2)?.count).toBe(3)
        expect(service.pickVoterAccount(1, 9, NOW)).toBeNull()
    })

    it('enforces an 8 hour cooldown and resets the daily count on the next UTC day', () => {
        expect(HelpfulVoteService.VOTE_COOLDOWN_HOURS).toBe(8)
        installDb({
            accounts: [
                accountRow({ id: 1, email: 'author@example.com', warmupLevel: 10 }),
                accountRow({ id: 2, email: 'voter@example.com', warmupLevel: 50 }),
            ],
            locationAuthors: [],
        })

        const cooling = new HelpfulVoteService()
        cooling.recordVote({
            historyId: 1,
            voterAccountId: 2,
            votedAt: new Date(NOW.getTime() - 8 * MS_PER_HOUR + 1),
            success: true,
        })
        expect(cooling.pickVoterAccount(1, 9, NOW)).toBeNull()

        const ready = new HelpfulVoteService()
        ready.recordVote({
            historyId: 2,
            voterAccountId: 2,
            votedAt: new Date(NOW.getTime() - 8 * MS_PER_HOUR),
            success: true,
        })
        expect(ready.pickVoterAccount(1, 9, NOW)).toEqual({
            accountId: 2,
            email: 'voter@example.com',
        })

        const nextDay = new HelpfulVoteService()
        const yesterday = new Date(NOW.getTime() - 25 * MS_PER_HOUR)
        for (let index = 0; index < HelpfulVoteService.MAX_VOTES_PER_ACCOUNT_PER_DAY; index += 1) {
            nextDay.recordVote({
                historyId: 400 + index,
                voterAccountId: 2,
                votedAt: yesterday,
                success: true,
            })
        }
        expect(nextDay.pickVoterAccount(1, 9, NOW)).toEqual({
            accountId: 2,
            email: 'voter@example.com',
        })
    })
})

describe('HelpfulVoteWorker', () => {
    let worker: HelpfulVoteWorker

    beforeEach(() => {
        worker = new HelpfulVoteWorker()
        createContext.mockReset()
        getPage.mockReset()
        closeContext.mockReset()
        getDatabaseMock.mockReset()
        createContext.mockResolvedValue(11)
        closeContext.mockResolvedValue(undefined)
        const state = memory(helpfulVoteService)
        state.votedReviews.clear()
        state.accountVotesToday.clear()
        vi.spyOn(helpfulVoteService, 'recordVote')
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        worker.stop()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('start/stop/isRunning lifecycle', () => {
        vi.useFakeTimers()
        const intervalSpy = vi.spyOn(global, 'setInterval')
        const timeoutSpy = vi.spyOn(global, 'setTimeout')

        expect(worker.isRunning()).toBe(false)
        worker.start()
        expect(worker.isRunning()).toBe(true)
        expect(internals(worker).enabled).toBe(true)
        expect(HelpfulVoteWorker.TICK_INTERVAL_MS).toBe(60 * 60 * 1000)
        expect(HelpfulVoteWorker.STARTUP_DELAY_MS).toBe(5 * 60 * 1000)
        expect(HelpfulVoteWorker.MAX_VOTES_PER_TICK).toBe(5)
        expect(HelpfulVoteWorker.DELAY_BETWEEN_VOTES_MS).toBe(30_000)
        expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000)
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000)
        worker.start()
        expect(intervalSpy).toHaveBeenCalledTimes(1)
        worker.stop()
        expect(worker.isRunning()).toBe(false)
        expect(internals(worker).enabled).toBe(false)
        expect(console.log).toHaveBeenCalledWith('[HelpfulVote] Started')
        expect(console.log).toHaveBeenCalledWith('[HelpfulVote] Stopped')
    })

    it('tick skips when the ticking guard is active', async () => {
        internals(worker).ticking = true
        internals(worker).enabled = true
        const processSpy = vi.spyOn(worker, 'processVoteQueue').mockResolvedValue(undefined)
        await worker.tick()
        expect(processSpy).not.toHaveBeenCalled()
        expect(internals(worker).ticking).toBe(true)
    })

    it('processVoteQueue with empty candidates logs and returns', async () => {
        const getSpy = vi.spyOn(helpfulVoteService, 'getVoteCandidates').mockReturnValue([])
        const castSpy = vi.spyOn(worker, 'castVote')
        await worker.processVoteQueue()
        expect(getSpy).toHaveBeenCalledWith(5)
        expect(castSpy).not.toHaveBeenCalled()
        expect(console.log).toHaveBeenCalledWith('[HelpfulVote] Vote queue empty')
        expect(createContext).not.toHaveBeenCalled()
    })

    it('waits 30 seconds between votes', async () => {
        vi.useFakeTimers()
        internals(worker).enabled = true
        const first = makeCandidate(1)
        const second = makeCandidate(2)
        vi.spyOn(helpfulVoteService, 'getVoteCandidates').mockReturnValue([first, second])
        vi.spyOn(helpfulVoteService, 'pickVoterAccount').mockReturnValue(voter)
        const castSpy = vi.spyOn(worker, 'castVote').mockResolvedValue(undefined)
        const timeoutSpy = vi.spyOn(global, 'setTimeout')

        const pending = worker.processVoteQueue()
        await vi.runAllTimersAsync()
        await pending

        expect(castSpy).toHaveBeenCalledTimes(2)
        expect(castSpy).toHaveBeenNthCalledWith(1, first, voter)
        expect(castSpy).toHaveBeenNthCalledWith(2, second, voter)
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    })

    it('castVote records success when the review and Helpful button are found', async () => {
        vi.useFakeTimers()
        const reviewText = 'Great coffee and friendly staff in the old quarter today'
        const candidate = makeCandidate(7, reviewText)
        const mocked = createMockPage({ reviewCounts: [1], buttonCounts: [1] })
        getPage.mockReturnValue(mocked.page)
        const timeoutSpy = vi.spyOn(global, 'setTimeout')

        const pending = worker.castVote(candidate, voter)
        await vi.runAllTimersAsync()
        await pending

        expect(createContext).toHaveBeenCalledWith({ headless: true, cleanProfileOnStart: true })
        expect(mocked.goto).toHaveBeenCalledWith(candidate.locationUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        })
        expect(mocked.locator).toHaveBeenCalledWith('[class*="review"] span, .review-full-text')
        expect(mocked.review.filter).toHaveBeenCalledWith({ hasText: reviewText.slice(0, 40) })
        expect(mocked.review.locator).toHaveBeenCalledWith('..')
        expect(mocked.review.locator).toHaveBeenCalledWith(
            'button[aria-label*="elpful"], button[aria-label*="seful"], [data-tooltip*="elpful"]',
        )
        expect(mocked.button.click).toHaveBeenCalledTimes(1)
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_500)
        const payload = vi.mocked(helpfulVoteService.recordVote).mock.calls.at(-1)?.[0]
        expect(payload).toEqual(expect.objectContaining({
            historyId: 7,
            voterAccountId: 4,
            success: true,
        }))
        expect(payload?.errorMessage).toBeUndefined()
        expect(payload?.votedAt).toBeInstanceOf(Date)
        expect(closeContext).toHaveBeenCalledWith(11)
    })

    it('castVote records skipped when the review is not found', async () => {
        const candidate = makeCandidate(8)
        const mocked = createMockPage({ reviewCounts: [0, 0] })
        getPage.mockReturnValue(mocked.page)

        await worker.castVote(candidate, voter)

        expect(mocked.locator).toHaveBeenCalledWith('[class*="review"] span, .review-full-text')
        expect(mocked.locator).toHaveBeenCalledWith('.MyEned, [data-review-id]')
        expect(mocked.button.click).not.toHaveBeenCalled()
        expect(helpfulVoteService.recordVote).toHaveBeenCalledWith(expect.objectContaining({
            historyId: 8,
            voterAccountId: 4,
            success: false,
            errorMessage: 'skipped: review not found',
        }))
        expect(console.log).toHaveBeenCalledWith(
            '[HelpfulVote] historyId=8 voter=voter@example.com status=skipped',
        )
        expect(closeContext).toHaveBeenCalledWith(11)
    })

    it('castVote always closes the browser context on success and on error', async () => {
        vi.useFakeTimers()
        const success = createMockPage({ reviewCounts: [1], buttonCounts: [1] })
        getPage.mockReturnValue(success.page)
        const pendingOk = worker.castVote(makeCandidate(1), voter)
        await vi.runAllTimersAsync()
        await pendingOk
        expect(closeContext).toHaveBeenCalledTimes(1)
        expect(closeContext).toHaveBeenCalledWith(11)

        closeContext.mockClear()
        const navigationError = createMockPage({
            reviewCounts: [],
            buttonCounts: [],
            goto: () => Promise.reject(new Error('net::ERR')),
        })
        getPage.mockReturnValue(navigationError.page)
        await worker.castVote(makeCandidate(2), voter)
        expect(closeContext).toHaveBeenCalledTimes(1)
        expect(closeContext).toHaveBeenCalledWith(11)
        expect(helpfulVoteService.recordVote).toHaveBeenCalledWith(expect.objectContaining({
            historyId: 2,
            voterAccountId: 4,
            success: false,
            errorMessage: 'net::ERR',
        }))

        closeContext.mockClear()
        const clickError = createMockPage({
            reviewCounts: [1],
            buttonCounts: [1],
            click: () => Promise.reject(new Error('click failed')),
        })
        getPage.mockReturnValue(clickError.page)
        await worker.castVote(makeCandidate(3), voter)
        expect(closeContext).toHaveBeenCalledTimes(1)
        expect(closeContext).toHaveBeenCalledWith(11)
        expect(helpfulVoteService.recordVote).toHaveBeenCalledWith(expect.objectContaining({
            historyId: 3,
            success: false,
            errorMessage: 'click failed',
        }))
    })
})
