/**
 * TrafficVisitQueue recovery: expired lease requeue on boot/resume.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
}))

import { getDatabase } from '../src/main/database'
import { buildTrafficVisitId } from '../src/shared/traffic-visit-contracts'
import { TrafficVisitQueue } from '../src/main/automation/TrafficVisitQueue'
import type { TrafficVisitPayload } from '../src/shared/traffic-visit-contracts'

function mockDatabase(): void {
    const noop = async (): Promise<void> => undefined
    vi.mocked(getDatabase).mockReturnValue({
        select: () => ({
            from: () => ({
                all: async () => [],
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

function payload(): TrafficVisitPayload {
    return {
        locationId: 1,
        accountId: 10,
        round: 1,
        requestedActions: 4,
    }
}

describe('TrafficVisitQueue — lease recovery', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('recoverExpiredLeases requeues only expired running', async () => {
        const now = new Date('2026-07-14T12:00:00.000Z')
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: payload() },
            { visitIndex: 1, payload: payload() },
        ])

        // Visit 0: expired lease
        const expired = await q.claimNextVisit(1, 'dead-worker', 1, new Date(now.getTime() - 60_000))
        expect(expired?.status).toBe('running')
        // Force lease in the past (claim sets lease relative to now arg)
        const expiredRow = q.getVisit(expired!.id)!
        q.putVisitForTests({
            ...expiredRow,
            leaseExpiresAt: new Date(now.getTime() - 1_000).toISOString(),
        })

        // Visit 1: still valid lease
        const live = await q.claimNextVisit(1, 'live-worker', 300_000, now)
        expect(live?.status).toBe('running')

        const result = await q.recoverExpiredLeases(1, now)
        expect(result.requeued).toBe(1)
        expect(result.campaignIds).toEqual([1])
        expect(q.getVisit(expired!.id)?.status).toBe('retry')
        expect(q.getVisit(expired!.id)?.workerId).toBeNull()
        expect(q.getVisit(live!.id)?.status).toBe('running')
        expect(q.getLastRecoveredCount()).toBe(1)
    })

    it('recovered visit is claimable again (resume path)', async () => {
        const now = new Date('2026-07-14T15:00:00.000Z')
        await q.seedCampaign(7, [{ visitIndex: 0, payload: payload() }])
        const claimed = await q.claimNextVisit(7, 'crashed', 1, now)
        q.putVisitForTests({
            ...q.getVisit(claimed!.id)!,
            leaseExpiresAt: new Date(now.getTime() - 5_000).toISOString(),
        })

        await q.recoverExpiredLeases(7, now)
        const reclaimed = await q.claimNextVisit(7, 'resume-worker', 60_000, now)
        expect(reclaimed?.id).toBe(claimed!.id)
        expect(reclaimed?.workerId).toBe('resume-worker')
        expect(reclaimed?.status).toBe('running')
        expect(reclaimed!.attemptCount).toBeGreaterThanOrEqual(2)
    })

    it('does not recover terminals or non-expired running', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: payload() },
            { visitIndex: 1, payload: payload() },
        ])
        const doneClaim = await q.claimNextVisit(1, 'w')
        await q.completeVisit(doneClaim!.id)

        const live = await q.claimNextVisit(1, 'w2', 600_000)
        const recovered = await q.recoverExpiredLeases(1)
        expect(recovered.requeued).toBe(0)
        expect(q.getVisit(doneClaim!.id)?.status).toBe('done')
        expect(q.getVisit(live!.id)?.status).toBe('running')
    })

    it('ensureLoaded rethrows on DB failure (no fake empty queue)', async () => {
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => {
                        throw new Error('db down')
                    },
                }),
            }),
        } as never)
        const q2 = new TrafficVisitQueue()
        await expect(q2.ensureLoaded()).rejects.toThrow(/db down/)
        expect(q2.isLoaded()).toBe(false)
    })

    it('load restores rows then recoverExpired requeues running with stale lease', async () => {
        const now = new Date('2026-07-14T18:00:00.000Z')
        const staleLease = new Date(now.getTime() - 10_000).toISOString()
        const row = {
            id: buildTrafficVisitId(42, 0),
            campaignId: 42,
            visitIndex: 0,
            status: 'running' as const,
            payload: JSON.stringify(payload()),
            attemptCount: 1,
            maxAttempts: 3,
            workerId: 'old',
            claimedAt: staleLease,
            leaseExpiresAt: staleLease,
            availableAt: null,
            lastError: null,
            result: null,
            createdAt: staleLease,
            updatedAt: staleLease,
        }

        const noop = async (): Promise<void> => undefined
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => [row],
                }),
            }),
            insert: () => ({
                values: () => {
                    const p = Promise.resolve(undefined)
                    return Object.assign(p, { onConflictDoUpdate: noop })
                },
            }),
        } as never)

        const q3 = new TrafficVisitQueue()
        await q3.ensureLoaded()
        expect(q3.isLoaded()).toBe(true)
        expect(q3.getVisit(row.id)?.status).toBe('running')

        const recovered = await q3.recoverExpiredLeases(42, now)
        expect(recovered.requeued).toBe(1)
        expect(q3.getVisit(row.id)?.status).toBe('retry')
        expect(q3.getCampaignCounters(42).retry).toBe(1)
    })
})

describe('TrafficVisitQueue — pause then resume recovery composition', () => {
    it('pause release + recover leaves claimable work without duplicate terminals', async () => {
        mockDatabase()
        const q = new TrafficVisitQueue()
        q.markLoadedForTests()
        await q.seedCampaign(3, [
            { visitIndex: 0, payload: payload() },
            { visitIndex: 1, payload: payload() },
        ])
        const a = await q.claimNextVisit(3, 't0')
        await q.completeVisit(a!.id)
        const b = await q.claimNextVisit(3, 't1')
        await q.releaseRunningForPause(3)
        await q.recoverExpiredLeases(3)
        const counters = q.getCampaignCounters(3)
        expect(counters.done).toBe(1)
        expect(counters.retry).toBe(1)
        expect(counters.running).toBe(0)
        expect(counters.remaining).toBe(1)
        const reclaimed = await q.claimNextVisit(3, 't1-resume')
        expect(reclaimed?.id).toBe(b!.id)
    })

    it('stop cancel nonterminal leaves terminals immutable', async () => {
        mockDatabase()
        const q = new TrafficVisitQueue()
        q.markLoadedForTests()
        await q.seedCampaign(9, [
            { visitIndex: 0, payload: payload() },
            { visitIndex: 1, payload: payload() },
            { visitIndex: 2, payload: payload() },
        ])
        const done = await q.claimNextVisit(9, 'w')
        await q.completeVisit(done!.id)
        const running = await q.claimNextVisit(9, 'w2')
        const n = await q.cancelCampaignVisits(9)
        expect(n).toBe(2) // running + pending
        expect(q.getVisit(done!.id)?.status).toBe('done')
        expect(q.getVisit(running!.id)?.status).toBe('cancelled')
        expect((await q.completeVisit(running!.id)).applied).toBe(false)
        expect((await q.failVisit(done!.id, 'nope')).applied).toBe(false)
        expect(q.isCampaignFullyTerminal(9)).toBe(true)
    })
})
