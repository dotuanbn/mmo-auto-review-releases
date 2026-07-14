/**
 * TrafficVisitQueue — seed/claim/terminal/backoff/rollback unit tests.
 * DB is mocked; state machine runs in-memory via markLoadedForTests().
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
}))

import { getDatabase } from '../src/main/database'
import {
    buildTrafficVisitId,
    computeTrafficVisitBackoffMs,
    isTrafficVisitClaimable,
    isTrafficVisitTerminal,
} from '../src/shared/traffic-visit-contracts'
import {
    buildTrafficVisitSeedItems,
    TrafficVisitQueue,
} from '../src/main/automation/TrafficVisitQueue'
import type { TrafficVisitPayload, TrafficVisitRow } from '../src/shared/traffic-visit-contracts'

function mockDatabase(): void {
    const emptyAll = async (): Promise<unknown[]> => []
    const emptyGet = async (): Promise<undefined> => undefined
    const noop = async (): Promise<void> => undefined

    vi.mocked(getDatabase).mockReturnValue({
        select: () => ({
            from: () => ({
                all: emptyAll,
                where: () => ({
                    get: emptyGet,
                    all: emptyAll,
                }),
            }),
        }),
        insert: () => ({
            values: () => {
                const p = Promise.resolve(undefined)
                return Object.assign(p, { onConflictDoUpdate: noop })
            },
        }),
        update: () => ({
            set: () => ({
                where: noop,
            }),
        }),
        delete: () => ({
            where: noop,
        }),
    } as never)
}

function makePayload(overrides: Partial<TrafficVisitPayload> = {}): TrafficVisitPayload {
    return {
        locationId: 1,
        accountId: 10,
        round: 1,
        requestedActions: 4,
        forceDirectConnection: false,
        proxyRetryCount: 0,
        watchdogRetryCount: 0,
        ...overrides,
    }
}

function seedOne(q: TrafficVisitQueue, campaignId = 1, visitIndex = 0): Promise<{ seeded: number }> {
    return q.seedCampaign(campaignId, [
        { visitIndex, payload: makePayload({ locationId: visitIndex + 1 }) },
    ])
}

describe('TrafficVisitQueue — contracts helpers', () => {
    it('terminal and claimable sets are disjoint', () => {
        expect(isTrafficVisitTerminal('done')).toBe(true)
        expect(isTrafficVisitTerminal('failed')).toBe(true)
        expect(isTrafficVisitTerminal('cancelled')).toBe(true)
        expect(isTrafficVisitClaimable('pending')).toBe(true)
        expect(isTrafficVisitClaimable('retry')).toBe(true)
        expect(isTrafficVisitClaimable('running')).toBe(false)
        expect(isTrafficVisitTerminal('pending')).toBe(false)
    })

    it('backoff grows and caps', () => {
        expect(computeTrafficVisitBackoffMs(1, 1000, 10_000)).toBe(1000)
        expect(computeTrafficVisitBackoffMs(2, 1000, 10_000)).toBe(2000)
        expect(computeTrafficVisitBackoffMs(5, 1000, 10_000)).toBe(10_000)
    })

    it('buildTrafficVisitSeedItems is deterministic location×round', () => {
        const items = buildTrafficVisitSeedItems({
            locations: [{ id: 1 }, { id: 2 }],
            accountIds: [10, 20],
            visitsPerLocation: 2,
            requestedActions: 3,
        })
        expect(items).toHaveLength(4)
        expect(items[0]).toMatchObject({ visitIndex: 0, payload: { locationId: 1, round: 1 } })
        expect(items[1]).toMatchObject({ visitIndex: 1, payload: { locationId: 2, round: 1 } })
        expect(items[2]).toMatchObject({ visitIndex: 2, payload: { locationId: 1, round: 2 } })
        expect(items.map((i) => i.visitIndex)).toEqual([0, 1, 2, 3])
    })
})

describe('TrafficVisitQueue — seed idempotent', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('seeds once per campaignId+visitIndex', async () => {
        const first = await seedOne(q)
        expect(first.seeded).toBe(1)
        const second = await seedOne(q)
        expect(second.seeded).toBe(0)
        expect(second.skippedExisting).toBe(1)
        expect(q.getCampaignCounters(1).total).toBe(1)
        expect(q.getVisit(buildTrafficVisitId(1, 0))?.status).toBe('pending')
    })
})

describe('TrafficVisitQueue — atomic claim', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('claim sets running + attemptCount + lease before return', async () => {
        await seedOne(q)
        const claimed = await q.claimNextVisit(1, 'w1', 60_000)
        expect(claimed?.status).toBe('running')
        expect(claimed?.workerId).toBe('w1')
        expect(claimed?.attemptCount).toBe(1)
        expect(claimed?.claimedAt).toBeTruthy()
        expect(claimed?.leaseExpiresAt).toBeTruthy()
        expect(await q.claimNextVisit(1, 'w2')).toBeNull()
    })

    it('concurrent claims never hand same visit twice', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 2 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 3 }) },
        ])
        const results = await Promise.all([
            q.claimNextVisit(1, 'a'),
            q.claimNextVisit(1, 'b'),
            q.claimNextVisit(1, 'c'),
            q.claimNextVisit(1, 'd'),
        ])
        const ids = results.filter((v): v is TrafficVisitRow => v != null).map((v) => v.id)
        expect(ids).toHaveLength(3)
        expect(new Set(ids).size).toBe(3)
        expect(await q.claimNextVisit(1, 'e')).toBeNull()
    })

    it('claim persist throw rolls back memory and rethrows', async () => {
        await seedOne(q)
        vi.mocked(getDatabase).mockReturnValue({
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => {
                        throw new Error('persist boom')
                    },
                }),
            }),
        } as never)

        await expect(q.claimNextVisit(1, 'w1')).rejects.toThrow(/persist boom/)
        const after = q.getVisit(buildTrafficVisitId(1, 0))
        expect(after?.status).toBe('pending')
        expect(after?.workerId).toBeNull()
        expect(after?.attemptCount).toBe(0)

        mockDatabase()
        const claimed = await q.claimNextVisit(1, 'w1')
        expect(claimed?.status).toBe('running')
    })
})

describe('TrafficVisitQueue — terminal immutable', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('done blocks fail and cancel', async () => {
        await seedOne(q)
        const c = await q.claimNextVisit(1, 'w')
        await q.completeVisit(c!.id, { ok: true })
        expect((await q.failVisit(c!.id, 'late')).applied).toBe(false)
        expect((await q.cancelVisit(c!.id)).applied).toBe(false)
        expect(q.getVisit(c!.id)?.status).toBe('done')
    })

    it('cancel blocks later complete', async () => {
        await seedOne(q)
        const c = await q.claimNextVisit(1, 'w')
        await q.cancelVisit(c!.id)
        const complete = await q.completeVisit(c!.id)
        expect(complete.applied).toBe(false)
        expect(complete.reason).toBe('blocked_by_cancelled')
        expect(q.getVisit(c!.id)?.status).toBe('cancelled')
    })

    it('complete is idempotent when already done', async () => {
        await seedOne(q)
        const c = await q.claimNextVisit(1, 'w')
        expect((await q.completeVisit(c!.id)).applied).toBe(true)
        const again = await q.completeVisit(c!.id)
        expect(again.applied).toBe(true)
        expect(again.reason).toBe('already_done')
    })
})

describe('TrafficVisitQueue — bounded retry + backoff', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('fail under maxAttempts → retry with availableAt', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload(), maxAttempts: 3 },
        ])
        const c = await q.claimNextVisit(1, 'w')
        const now = new Date('2026-07-14T12:00:00.000Z')
        const result = await q.failVisit(c!.id, 'network', { now })
        expect(result.applied).toBe(true)
        expect(result.status).toBe('retry')
        const row = q.getVisit(c!.id)!
        expect(row.status).toBe('retry')
        expect(row.availableAt).toBeTruthy()
        expect(new Date(row.availableAt!).getTime()).toBeGreaterThan(now.getTime())
    })

    it('immediateRetry makes visit claimable immediately', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload(), maxAttempts: 3 },
        ])
        const c = await q.claimNextVisit(1, 'w')
        await q.failVisit(c!.id, 'proxy', {
            immediateRetry: true,
            mergePayload: { forceDirectConnection: true },
        })
        const again = await q.claimNextVisit(1, 'w2')
        expect(again?.id).toBe(c!.id)
        expect(again?.attemptCount).toBe(2)
        expect(again?.payload).toContain('forceDirectConnection')
    })

    it('exhausted attempts → permanent failed', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload(), maxAttempts: 2 },
        ])
        const first = await q.claimNextVisit(1, 'w')
        await q.failVisit(first!.id, 'e1', { immediateRetry: true })
        const second = await q.claimNextVisit(1, 'w')
        const permanent = await q.failVisit(second!.id, 'e2')
        expect(permanent.status).toBe('failed')
        expect(await q.claimNextVisit(1, 'w')).toBeNull()
        expect(q.getCampaignCounters(1).failed).toBe(1)
    })
})

describe('TrafficVisitQueue — pause / cancel', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('releaseRunningForPause returns visits to retry without extra attempt', async () => {
        await seedOne(q)
        const c = await q.claimNextVisit(1, 'w')
        expect(c?.attemptCount).toBe(1)
        const released = await q.releaseRunningForPause(1)
        expect(released).toBe(1)
        const row = q.getVisit(c!.id)!
        expect(row.status).toBe('retry')
        expect(row.attemptCount).toBe(0)
        expect(row.workerId).toBeNull()
    })

    it('cancelCampaignVisits cancels active only', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 2 }) },
        ])
        const c = await q.claimNextVisit(1, 'w')
        await q.completeVisit(c!.id)
        const cancelled = await q.cancelCampaignVisits(1)
        expect(cancelled).toBe(1)
        expect(q.getCampaignCounters(1).done).toBe(1)
        expect(q.getCampaignCounters(1).cancelled).toBe(1)
    })
})

describe('TrafficVisitQueue — counters from durable queue', () => {
    it('derive done/failed/remaining without double count', async () => {
        mockDatabase()
        const q = new TrafficVisitQueue()
        q.markLoadedForTests()
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 2 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 3 }) },
        ])
        const a = await q.claimNextVisit(1, 'w')
        await q.completeVisit(a!.id)
        const b = await q.claimNextVisit(1, 'w')
        await q.failVisit(b!.id, 'x', { permanent: true })
        const counters = q.getCampaignCounters(1)
        expect(counters.done).toBe(1)
        expect(counters.failed).toBe(1)
        expect(counters.pending).toBe(1)
        expect(counters.remaining).toBe(1)
        expect(counters.total).toBe(3)
        expect(q.isCampaignFullyTerminal(1)).toBe(false)
    })

    it('isCampaignFullyTerminal when remaining is zero (incl. cancelled)', async () => {
        mockDatabase()
        const q = new TrafficVisitQueue()
        q.markLoadedForTests()
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 2 }) },
        ])
        const a = await q.claimNextVisit(1, 'w')
        await q.completeVisit(a!.id)
        await q.cancelCampaignVisits(1)
        expect(q.getCampaignCounters(1).remaining).toBe(0)
        expect(q.isCampaignFullyTerminal(1)).toBe(true)
    })
})

describe('TrafficVisitQueue — complete/fail persist rollback', () => {
    it('completeVisit persist fail rolls back memory', async () => {
        mockDatabase()
        const q = new TrafficVisitQueue()
        q.markLoadedForTests()
        await seedOne(q)
        const c = await q.claimNextVisit(1, 'w')
        vi.mocked(getDatabase).mockReturnValue({
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => {
                        throw new Error('complete boom')
                    },
                }),
            }),
        } as never)
        await expect(q.completeVisit(c!.id)).rejects.toThrow(/complete boom/)
        expect(q.getVisit(c!.id)?.status).toBe('running')
    })

    it('failVisit persist fail rolls back memory', async () => {
        mockDatabase()
        const q = new TrafficVisitQueue()
        q.markLoadedForTests()
        await seedOne(q)
        const c = await q.claimNextVisit(1, 'w')
        vi.mocked(getDatabase).mockReturnValue({
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => {
                        throw new Error('fail boom')
                    },
                }),
            }),
        } as never)
        await expect(q.failVisit(c!.id, 'x')).rejects.toThrow(/fail boom/)
        expect(q.getVisit(c!.id)?.status).toBe('running')
        expect(q.getVisit(c!.id)?.workerId).toBe('w')
    })
})
