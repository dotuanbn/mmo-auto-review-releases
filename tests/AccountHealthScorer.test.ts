/**
 * Account health scoring. Database and settings are mocked; SQL is not executed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock, allMock, loadSettingsMock } = vi.hoisted(() => ({
    getMock: vi.fn(),
    allMock: vi.fn(),
    loadSettingsMock: vi.fn(),
}))

vi.mock('../src/main/database', () => {
    function chain(): {
        from: () => ReturnType<typeof chain>
        where: () => ReturnType<typeof chain>
        orderBy: () => ReturnType<typeof chain>
        limit: () => ReturnType<typeof chain>
        get: () => unknown
        all: () => unknown
    } {
        return {
            from: () => chain(),
            where: () => chain(),
            orderBy: () => chain(),
            limit: () => chain(),
            get: () => getMock(),
            all: () => allMock(),
        }
    }

    return {
        getDatabase: () => ({
            select: () => chain(),
        }),
    }
})

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: () => loadSettingsMock(),
}))

import {
    AccountHealthScorer,
    accountHealthScorer,
    calculateAccountHealth,
    sortAccountsByHealth,
    type AccountHealthInput,
    type AccountHealthOutput,
} from '../src/main/services/AccountHealthScorer'

const NOW = new Date('2026-06-15T12:00:00.000Z')
const MS_PER_DAY = 86_400_000

function input(overrides: Partial<AccountHealthInput> = {}): AccountHealthInput {
    return {
        accountId: 1,
        warmupLevel: 0,
        totalReviews: 0,
        daysSinceCreation: 0,
        recentSuccessCount: 0,
        recentFailCount: 0,
        survivalRate: 0,
        lastReviewDate: null,
        birthStoryCompleted: false,
        ...overrides,
    }
}

function output(overrides: Partial<AccountHealthOutput> & Pick<AccountHealthOutput, 'score' | 'grade'>): AccountHealthOutput {
    return {
        shouldRest: false,
        restDays: 1,
        reasons: [],
        ...overrides,
    }
}

function createdDaysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * MS_PER_DAY)
}

describe('calculateAccountHealth', () => {
    it('scores high warmup and strong survival as excellent', () => {
        const result = calculateAccountHealth(input({
            accountId: 1,
            warmupLevel: 80,
            totalReviews: 2,
            daysSinceCreation: 10,
            recentSuccessCount: 0,
            recentFailCount: 0,
            survivalRate: 0.75,
            lastReviewDate: new Date('2026-06-01T00:00:00.000Z'),
            birthStoryCompleted: true,
        }))

        // 50 + 24 warmup + 1 age + 5 birth + 1 reviews + 15 survival = 96
        expect(result.score).toBe(96)
        expect(result.grade).toBe('excellent')
        expect(result.shouldRest).toBe(false)
        expect(result.restDays).toBe(1)
        expect(result.reasons.some((reason) => reason.includes('Warmup'))).toBe(true)
        expect(result.reasons.some((reason) => reason.includes('Survival'))).toBe(true)
    })

    it('keeps a new account with no warmup at the base score (fair)', () => {
        const result = calculateAccountHealth(input({
            accountId: 2,
            warmupLevel: 0,
            daysSinceCreation: 1,
            birthStoryCompleted: false,
        }))

        // Base 50 plus a tenth of a point for a one-day-old account. No warmup bonus.
        expect(result.score).toBeCloseTo(50.1, 5)
        expect(result.grade).toBe('fair')
        expect(result.shouldRest).toBe(false)
        expect(result.restDays).toBe(2)
        expect(result.reasons).toContain('No warmup bonus')
    })

    it('marks overuse as rest, with a heavier penalty at 8 recent successes', () => {
        const five = calculateAccountHealth(input({ recentSuccessCount: 5 }))
        expect(five.score).toBe(40)
        expect(five.shouldRest).toBe(true)
        expect(five.restDays).toBe(2)
        expect(five.grade).toBe('fair')

        const eight = calculateAccountHealth(input({ recentSuccessCount: 8 }))
        expect(eight.score).toBe(30)
        expect(eight.shouldRest).toBe(true)
        expect(eight.grade).toBe('poor')
        expect(eight.restDays).toBe(3)
    })

    it('reduces the score for recent failures and caps the penalty at 20', () => {
        const baseline = calculateAccountHealth(input())
        const threeFails = calculateAccountHealth(input({ recentFailCount: 3 }))
        expect(threeFails.score).toBe(baseline.score - 15)
        expect(threeFails.grade).toBe('poor')
        expect(threeFails.shouldRest).toBe(true)
        expect(threeFails.restDays).toBe(3)

        const capped = calculateAccountHealth(input({ recentFailCount: 10 }))
        expect(capped.score).toBe(baseline.score - 20)
    })

    it('clamps the score to 0-100', () => {
        const high = calculateAccountHealth(input({
            warmupLevel: 100,
            totalReviews: 40,
            daysSinceCreation: 200,
            survivalRate: 1,
            birthStoryCompleted: true,
            lastReviewDate: new Date('2026-06-01T00:00:00.000Z'),
        }))
        expect(high.score).toBe(100)
        expect(high.grade).toBe('excellent')
        expect(high.score).toBeLessThanOrEqual(100)

        const low = calculateAccountHealth(input({
            recentFailCount: 100,
            recentSuccessCount: 8,
        }))
        expect(low.score).toBe(10)
        expect(low.score).toBeGreaterThanOrEqual(0)
        expect(low.score).toBeLessThanOrEqual(100)
        expect(low.grade).toBe('blocked')
    })

    it('rejects a non-finite warmup level', () => {
        expect(() => calculateAccountHealth(input({ warmupLevel: Number.NaN }))).toThrow(/warmupLevel/)
    })
})

describe('sortAccountsByHealth', () => {
    it('sorts descending by score and removes blocked accounts', () => {
        const blocked = output({ score: 10, grade: 'blocked', shouldRest: true, restDays: 5 })
        const restingExcellent = output({ score: 90, grade: 'excellent', shouldRest: true, restDays: 1 })
        const fair = output({ score: 50, grade: 'fair', shouldRest: false, restDays: 2 })
        const poor = output({ score: 20, grade: 'poor', shouldRest: true, restDays: 3 })
        const source = [blocked, fair, restingExcellent, poor]

        expect(sortAccountsByHealth(source).map((row) => row.score)).toEqual([90, 50, 20])
        expect(source.map((row) => row.score)).toEqual([10, 50, 90, 20])
    })
})

describe('AccountHealthScorer', () => {
    const scorer = new AccountHealthScorer()

    beforeEach(() => {
        getMock.mockReset()
        allMock.mockReset()
        loadSettingsMock.mockReset()
    })

    it('queries the account and review history and returns the pure score', () => {
        const lastReviewDate = new Date('2026-06-10T00:00:00.000Z')
        const createdAt = createdDaysAgo(10)
        getMock
            .mockReturnValueOnce({
                warmupLevel: 40,
                totalReviews: 4,
                createdAt,
                birthStoryCompleted: true,
                lastReviewDate,
            })
            .mockReturnValueOnce({ successCount: 1, failCount: 1 })
            .mockReturnValueOnce({ liveCount: 1, verifiedCount: 2 })

        const actual = scorer.evaluateAccount(7, NOW)
        const expected = calculateAccountHealth(input({
            accountId: 7,
            warmupLevel: 40,
            totalReviews: 4,
            daysSinceCreation: 10,
            recentSuccessCount: 1,
            recentFailCount: 1,
            survivalRate: 0.5,
            lastReviewDate,
            birthStoryCompleted: true,
        }))

        // 50 + 12 warmup + 1 age + 5 birth + 2 reviews + 10 survival - 5 failures = 75
        expect(actual.score).toBe(75)
        expect(actual).toEqual(expected)
        expect(getMock).toHaveBeenCalledTimes(3)
        expect(allMock).not.toHaveBeenCalled()
        expect(loadSettingsMock).not.toHaveBeenCalled()
    })

    it('throws when the account row is missing', () => {
        getMock.mockReturnValueOnce(undefined)
        expect(() => scorer.evaluateAccount(5, NOW)).toThrow(/account 5 not found/)
    })

    it('picks the highest scoring account that is not resting', () => {
        // id 11: score 100 but 6 recent successes → rest.
        getMock
            .mockReturnValueOnce({
                warmupLevel: 100,
                totalReviews: 20,
                createdAt: createdDaysAgo(100),
                birthStoryCompleted: true,
                lastReviewDate: new Date('2026-06-14T00:00:00.000Z'),
            })
            .mockReturnValueOnce({ successCount: 6, failCount: 0 })
            .mockReturnValueOnce({ liveCount: 5, verifiedCount: 5 })
            // id 22: score 78, not resting.
            .mockReturnValueOnce({
                warmupLevel: 40,
                totalReviews: 4,
                createdAt: createdDaysAgo(40),
                birthStoryCompleted: false,
                lastReviewDate: null,
            })
            .mockReturnValueOnce({ successCount: 2, failCount: 0 })
            .mockReturnValueOnce({ liveCount: 1, verifiedCount: 2 })
            // id 33: score 50.1, not resting.
            .mockReturnValueOnce({
                warmupLevel: 0,
                totalReviews: 0,
                createdAt: createdDaysAgo(1),
                birthStoryCompleted: false,
                lastReviewDate: null,
            })
            .mockReturnValueOnce({ successCount: 0, failCount: 0 })
            .mockReturnValueOnce({ liveCount: 0, verifiedCount: 0 })

        expect(scorer.pickBestAccount([11, 22, 33], NOW)).toBe(22)
        expect(calculateAccountHealth(input({
            accountId: 11,
            warmupLevel: 100,
            totalReviews: 20,
            daysSinceCreation: 100,
            recentSuccessCount: 6,
            survivalRate: 1,
            birthStoryCompleted: true,
            lastReviewDate: new Date('2026-06-14T00:00:00.000Z'),
        })).shouldRest).toBe(true)
        expect(calculateAccountHealth(input({
            accountId: 22,
            warmupLevel: 40,
            totalReviews: 4,
            daysSinceCreation: 40,
            recentSuccessCount: 2,
            survivalRate: 0.5,
        })).score).toBe(78)
    })

    it('returns null when every candidate should rest or the list is empty', () => {
        expect(scorer.pickBestAccount([], NOW)).toBeNull()

        getMock
            .mockReturnValueOnce({
                warmupLevel: 0,
                totalReviews: 0,
                createdAt: NOW,
                birthStoryCompleted: false,
                lastReviewDate: null,
            })
            .mockReturnValueOnce({ successCount: 5, failCount: 0 })
            .mockReturnValueOnce({ liveCount: 0, verifiedCount: 0 })

        expect(scorer.pickBestAccount([9], NOW)).toBeNull()
    })

    it('evaluates every active account into a map', () => {
        allMock.mockReturnValueOnce([{ id: 4 }])
        getMock
            .mockReturnValueOnce({
                warmupLevel: 80,
                totalReviews: 2,
                createdAt: createdDaysAgo(10),
                birthStoryCompleted: true,
                lastReviewDate: new Date('2026-06-01T00:00:00.000Z'),
            })
            .mockReturnValueOnce({ successCount: 0, failCount: 0 })
            .mockReturnValueOnce({ liveCount: 3, verifiedCount: 4 })

        const scored = scorer.evaluateAll(NOW)
        expect(scored.size).toBe(1)
        expect(scored.get(4)?.score).toBe(96)
        expect(scored.get(4)?.grade).toBe('excellent')
        expect(accountHealthScorer).toBeInstanceOf(AccountHealthScorer)
    })
})
