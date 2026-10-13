/**
 * DashboardService.getOverview survival aggregation.
 * The SQL is not executed: the mock returns the aggregate row loadSurvival reads
 * after the only leftJoin in the overview (review_history → accounts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        trafficLogs: {
            createdAt: 'trafficLogs.createdAt',
            status: 'trafficLogs.status',
            qualityScore: 'trafficLogs.qualityScore',
            duration: 'trafficLogs.duration',
            discoverySource: 'trafficLogs.discoverySource',
        },
        reviewHistory: {
            createdAt: 'reviewHistory.createdAt',
            status: 'reviewHistory.status',
            rating: 'reviewHistory.rating',
            errorMessage: 'reviewHistory.errorMessage',
            verifiedStatus: 'reviewHistory.verifiedStatus',
            survivalDays: 'reviewHistory.survivalDays',
            styleApplied: 'reviewHistory.styleApplied',
            accountId: 'reviewHistory.accountId',
        },
        accounts: {
            id: 'accounts.id',
            warmupLevel: 'accounts.warmupLevel',
            status: 'accounts.status',
            birthStoryCompleted: 'accounts.birthStoryCompleted',
            autoWarmupEnabled: 'accounts.autoWarmupEnabled',
        },
        campaigns: {
            status: 'campaigns.status',
        },
        captchaMetrics: {
            success: 'captchaMetrics.success',
            durationMs: 'captchaMetrics.durationMs',
        },
    },
}))

import { getDatabase } from '../src/main/database'
import { DashboardService } from '../src/main/services/DashboardService'

const getDatabaseMock = vi.mocked(getDatabase)

interface QueryChain {
    get: () => unknown
    all: () => unknown[]
    where: () => QueryChain
    groupBy: () => QueryChain
    orderBy: () => QueryChain
    limit: () => QueryChain
    leftJoin: () => QueryChain
}

function chain(getResult: unknown): QueryChain {
    const node: QueryChain = {
        get: () => getResult,
        all: () => [],
        where: () => node,
        groupBy: () => node,
        orderBy: () => node,
        limit: () => node,
        leftJoin: () => node,
    }
    return node
}

/**
 * Non-survival overview queries terminate on the base chain (empty / zero).
 * loadSurvival is the only caller that left-joins, so that branch returns the fixture.
 */
function createOverviewDb(survivalRow: unknown) {
    const survival = chain(survivalRow)
    const base = chain(undefined)
    base.leftJoin = () => survival
    return {
        select: () => ({
            from: () => base,
        }),
    }
}

const EMPTY_SURVIVAL_ROW = {
    totalVerified: null,
    liveCount: null,
    removedCount: null,
    pendingCount: null,
    avgSurvivalDays: null,
    styledVerified: null,
    styledLive: null,
    unstyledVerified: null,
    unstyledLive: null,
    blockedVerified: null,
    blockedLive: null,
    throttledVerified: null,
    throttledLive: null,
    readyVerified: null,
    readyLive: null,
}

describe('DashboardService survival aggregation', () => {
    let service: DashboardService

    beforeEach(() => {
        vi.clearAllMocks()
        service = new DashboardService()
    })

    it('returns zeros and does not throw when there are no verified reviews', () => {
        getDatabaseMock.mockReturnValue(createOverviewDb(EMPTY_SURVIVAL_ROW) as never)

        const overview = service.getOverview(new Date('2026-10-12T12:00:00.000Z'))

        expect(overview.survival).toEqual({
            totalVerified: 0,
            liveCount: 0,
            removedCount: 0,
            pendingCount: 0,
            overallSurvivalRate: 0,
            avgSurvivalDays: 0,
            styledSurvivalRate: 0,
            unstyledSurvivalRate: 0,
            survivalByWarmupTier: {
                blocked: 0,
                throttled: 0,
                ready: 0,
            },
        })
    })

    it('calculates overall, styled, unstyled, and warmup-tier survival rates', () => {
        // 3 live + 1 removed = 4 verified. 2 pending are excluded from the rate denominator.
        // Styled 2/2 live, unstyled 1/2 live. Tiers: blocked 0/1, throttled 1/1, ready 2/2.
        getDatabaseMock.mockReturnValue(createOverviewDb({
            totalVerified: 4,
            liveCount: 3,
            removedCount: 1,
            pendingCount: 2,
            avgSurvivalDays: 12.34,
            styledVerified: 2,
            styledLive: 2,
            unstyledVerified: 2,
            unstyledLive: 1,
            blockedVerified: 1,
            blockedLive: 0,
            throttledVerified: 1,
            throttledLive: 1,
            readyVerified: 2,
            readyLive: 2,
        }) as never)

        const survival = service.getOverview().survival

        expect(survival.totalVerified).toBe(4)
        expect(survival.liveCount).toBe(3)
        expect(survival.removedCount).toBe(1)
        expect(survival.pendingCount).toBe(2)
        expect(survival.overallSurvivalRate).toBe(75)
        expect(survival.avgSurvivalDays).toBe(12.3)
        expect(survival.styledSurvivalRate).toBe(100)
        expect(survival.unstyledSurvivalRate).toBe(50)
        expect(survival.survivalByWarmupTier).toEqual({
            blocked: 0,
            throttled: 100,
            ready: 100,
        })
    })
})
