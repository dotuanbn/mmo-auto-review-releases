/**
 * Durable Traffic visit lifecycle integration (queue-level engine contract).
 * Covers seed → claim → complete → pause release → resume recover → stop cancel,
 * no double count, terminal immutable, IPC Zod strict DTOs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
}))

import { getDatabase } from '../src/main/database'
import {
    buildTrafficVisitId,
    isTrafficVisitFreshTransition,
    trafficVisitQueueStatsSchema,
    trafficVisitRecoverResultSchema,
    type TrafficVisitPayload,
} from '../src/shared/traffic-visit-contracts'
import {
    buildTrafficVisitSeedItems,
    TrafficVisitQueue,
} from '../src/main/automation/TrafficVisitQueue'

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

function payload(overrides: Partial<TrafficVisitPayload> = {}): TrafficVisitPayload {
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

/**
 * Mirrors engine success path: complete first, log only on fresh transition.
 * Returns how many times a log would be emitted (0 or 1).
 */
async function engineStyleComplete(
    q: TrafficVisitQueue,
    visitId: string,
): Promise<{ logs: number; done: number }> {
    const first = await q.completeVisit(visitId, { ok: true })
    let logs = 0
    if (isTrafficVisitFreshTransition(first)) logs++
    // Replay complete (crash retry) must not double-log
    const second = await q.completeVisit(visitId, { ok: true })
    if (isTrafficVisitFreshTransition(second)) logs++
    return { logs, done: q.getCampaignCounters(1).done }
}

describe('TrafficBoost durable integration', () => {
    let q: TrafficVisitQueue

    beforeEach(() => {
        mockDatabase()
        q = new TrafficVisitQueue()
        q.markLoadedForTests()
    })

    it('seed is idempotent then claim drains until remaining=0', async () => {
        const items = buildTrafficVisitSeedItems({
            locations: [{ id: 1 }, { id: 2 }],
            accountIds: [10],
            visitsPerLocation: 2,
            requestedActions: 3,
        })
        expect(items).toHaveLength(4)
        const s1 = await q.seedCampaign(1, items)
        const s2 = await q.seedCampaign(1, items)
        expect(s1.seeded).toBe(4)
        expect(s2.seeded).toBe(0)
        expect(s2.skippedExisting).toBe(4)

        const claimedIds = new Set<string>()
        while (true) {
            const claimed = await q.claimNextVisit(1, 'worker-a', 60_000)
            if (!claimed) break
            expect(claimedIds.has(claimed.id)).toBe(false)
            claimedIds.add(claimed.id)
            await q.completeVisit(claimed.id, { success: true })
        }
        expect(claimedIds.size).toBe(4)
        const counters = q.getCampaignCounters(1)
        expect(counters.done).toBe(4)
        expect(counters.remaining).toBe(0)
        expect(q.isCampaignFullyTerminal(1)).toBe(true)
        expect(await q.claimNextVisit(1, 'worker-b')).toBeNull()
    })

    it('no double count/log on complete replay', async () => {
        await q.seedCampaign(1, [{ visitIndex: 0, payload: payload() }])
        const c = await q.claimNextVisit(1, 'w')
        const { logs, done } = await engineStyleComplete(q, c!.id)
        expect(logs).toBe(1)
        expect(done).toBe(1)
        expect(q.getCampaignCounters(1).done).toBe(1)
    })

    it('pause release lease then resume recover reclaims without terminal overwrite', async () => {
        await q.seedCampaign(5, [
            { visitIndex: 0, payload: payload({ locationId: 1 }) },
            { visitIndex: 1, payload: payload({ locationId: 2 }) },
        ])
        const a = await q.claimNextVisit(5, 't0')
        await q.completeVisit(a!.id)
        const b = await q.claimNextVisit(5, 't1')
        expect(b?.attemptCount).toBe(1)

        // pauseCampaign semantics
        const released = await q.releaseRunningForPause(5)
        expect(released).toBe(1)
        expect(q.getVisit(b!.id)?.status).toBe('retry')
        expect(q.getVisit(b!.id)?.attemptCount).toBe(0)
        // mid-visit complete after pause must not overwrite retry
        expect((await q.completeVisit(b!.id)).applied).toBe(false)

        // resumeCampaign semantics
        await q.recoverExpiredLeases(5)
        const reclaimed = await q.claimNextVisit(5, 't1-resume')
        expect(reclaimed?.id).toBe(b!.id)
        await q.completeVisit(reclaimed!.id)
        expect(q.getCampaignCounters(5).done).toBe(2)
        expect(q.getCampaignCounters(5).remaining).toBe(0)
    })

    it('stop cancels nonterminal only; delete-path cancel is safe on terminals', async () => {
        await q.seedCampaign(8, [
            { visitIndex: 0, payload: payload() },
            { visitIndex: 1, payload: payload() },
            { visitIndex: 2, payload: payload() },
        ])
        const done = await q.claimNextVisit(8, 'w')
        await q.completeVisit(done!.id)
        const run = await q.claimNextVisit(8, 'w2')
        // stopCampaign / deleteCampaign path
        const cancelled = await q.cancelCampaignVisits(8)
        expect(cancelled).toBe(2)
        expect(q.getVisit(done!.id)?.status).toBe('done')
        expect(q.getVisit(run!.id)?.status).toBe('cancelled')
        // second cancel (delete after stop) does not re-cancel terminals
        expect(await q.cancelCampaignVisits(8)).toBe(0)
        expect(q.getCampaignCounters(8).done).toBe(1)
        expect(q.getCampaignCounters(8).cancelled).toBe(2)
        expect(q.getCampaignCounters(8).remaining).toBe(0)
    })

    it('permanent fail logs once; retry does not count as failed', async () => {
        await q.seedCampaign(1, [
            { visitIndex: 0, payload: payload(), maxAttempts: 2 },
        ])
        const c1 = await q.claimNextVisit(1, 'w')
        const r1 = await q.failVisit(c1!.id, 'net', { immediateRetry: true })
        expect(r1.status).toBe('retry')
        expect(isTrafficVisitFreshTransition(r1)).toBe(true)
        // retry must not look like permanent failed for logging
        expect(r1.status === 'failed' && isTrafficVisitFreshTransition(r1)).toBe(false)
        expect(q.getCampaignCounters(1).failed).toBe(0)

        const c2 = await q.claimNextVisit(1, 'w')
        const r2 = await q.failVisit(c2!.id, 'net2')
        expect(r2.status).toBe('failed')
        expect(isTrafficVisitFreshTransition(r2)).toBe(true)
        const r3 = await q.failVisit(c2!.id, 'net3')
        expect(r3.reason).toBe('already_failed')
        expect(isTrafficVisitFreshTransition(r3)).toBe(false)
        expect(q.getCampaignCounters(1).failed).toBe(1)
    })

    it('IPC stats/recover DTOs pass strict Zod schemas', () => {
        const stats = trafficVisitQueueStatsSchema.safeParse({
            campaignId: 1,
            counters: {
                total: 3,
                pending: 1,
                retry: 0,
                running: 0,
                done: 1,
                failed: 1,
                cancelled: 0,
                remaining: 1,
            },
            recoveredOnBoot: 0,
        })
        expect(stats.success).toBe(true)

        const rejectExtra = trafficVisitQueueStatsSchema.safeParse({
            campaignId: 1,
            counters: {
                total: 1,
                pending: 1,
                retry: 0,
                running: 0,
                done: 0,
                failed: 0,
                cancelled: 0,
                remaining: 1,
                extra: 99,
            },
        })
        expect(rejectExtra.success).toBe(false)

        const recover = trafficVisitRecoverResultSchema.safeParse({
            requeued: 2,
            campaignIds: [1, 2],
        })
        expect(recover.success).toBe(true)
        expect(
            trafficVisitRecoverResultSchema.safeParse({ requeued: -1, campaignIds: [] }).success,
        ).toBe(false)
    })

    it('seed items map location×round deterministically for engine wiring', () => {
        const items = buildTrafficVisitSeedItems({
            locations: [{ id: 100 }, { id: 200 }],
            accountIds: [1, 2],
            visitsPerLocation: 1,
            requestedActions: 4,
        })
        expect(items[0].visitIndex).toBe(0)
        expect(items[0].payload.locationId).toBe(100)
        expect(items[1].payload.locationId).toBe(200)
        expect(buildTrafficVisitId(42, 3)).toBe('tv:42:3')
    })
})
