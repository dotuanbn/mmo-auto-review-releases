/**
 * Multi-map / multi-IP concurrency contracts:
 * - TrafficVisitQueue skips a location that already has a running visit.
 * - FProxyPoolService shares one proxy slot across distinct locationIds and
 *   rotates only after the last lease on that slot is released.
 *
 * DB and FProxy provider are mocked; no real network or SQLite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        fproxyKeys: { __table: 'fproxyKeys', id: 'fproxyKeys.id' },
        settings: { __table: 'settings', key: 'settings.key' },
    },
}))

vi.mock('drizzle-orm', () => ({
    eq: vi.fn((_column: unknown, value: unknown) => ({ value })),
}))

vi.mock('../src/main/services/SecretVault', () => ({
    secretVault: {
        seal: (value: string) => (value ? `sealed:${value}` : ''),
        decrypt: (value: string | null | undefined) => {
            if (!value) return ''
            return value.startsWith('sealed:') ? value.slice('sealed:'.length) : value
        },
    },
}))

import { getDatabase } from '../src/main/database'
import { TrafficVisitQueue } from '../src/main/automation/TrafficVisitQueue'
import {
    parseTrafficVisitPayload,
    type TrafficVisitPayload,
    type TrafficVisitRow,
} from '../src/shared/traffic-visit-contracts'
import {
    FProxyPoolError,
    FProxyPoolService,
} from '../src/main/services/FProxyPoolService'
import type { FProxyLeaseOwnerDto } from '../src/shared/fproxy-pool-contracts'
import {
    createFakeEndpoint,
    FakeFProxyDatabase,
    FakeFProxyProvider,
} from './helpers/FakeFProxyProvider'

const CLAIM_LEASE_MS = 60_000
const PROXY_KEY = 'fproxy-key-multimap-aaaaaaaaaaaaaaaaaaaaaaaa'

function mockVisitDatabase(): void {
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

function locationOf(visit: TrafficVisitRow | null): number | null {
    if (!visit) return null
    return parseTrafficVisitPayload(visit.payload)?.locationId ?? null
}

function claimExclusive(
    queue: TrafficVisitQueue,
    campaignId: number,
    workerId: string,
    now: Date = new Date(),
    extraDisallowed?: Set<number>,
): Promise<TrafficVisitRow | null> {
    return queue.claimNextVisit(campaignId, workerId, CLAIM_LEASE_MS, now, {
        disallowRunningLocations: true,
        disallowedLocationIds: extraDisallowed,
    })
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

function trafficOwner(id: string, threadId: number, locationId: number): FProxyLeaseOwnerDto {
    return { kind: 'traffic_visit', id, threadId, locationId }
}

describe('TrafficVisitQueue — disallowRunningLocations', () => {
    let queue: TrafficVisitQueue

    beforeEach(() => {
        mockVisitDatabase()
        queue = new TrafficVisitQueue()
        queue.markLoadedForTests()
    })

    it('skips a pending visit whose locationId is already running', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 10, accountId: 1, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 20, accountId: 2, round: 1 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 10, accountId: 3, round: 2 }) },
        ])

        const first = await claimExclusive(queue, 1, 'worker-a')
        expect(first).not.toBeNull()
        expect(locationOf(first)).toBe(10)
        expect(first?.status).toBe('running')

        const second = await claimExclusive(queue, 1, 'worker-b')
        expect(second).not.toBeNull()
        expect(locationOf(second)).toBe(20)
        expect(second?.visitIndex).toBe(1)
        expect(second?.id).not.toBe(first?.id)
    })

    it('returns null when every remaining claimable visit shares a running locationId', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 99, accountId: 1, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 99, accountId: 2, round: 2 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 99, accountId: 3, round: 3 }) },
        ])

        const running = await claimExclusive(queue, 1, 'worker-a')
        expect(locationOf(running)).toBe(99)
        expect(queue.getCampaignCounters(1).running).toBe(1)
        expect(queue.getCampaignCounters(1).pending).toBe(2)

        expect(await claimExclusive(queue, 1, 'worker-b')).toBeNull()
        expect(await claimExclusive(queue, 1, 'worker-c')).toBeNull()
        expect(queue.getCampaignCounters(1).running).toBe(1)
    })

    it('returns null while mixed remaining visits all collide with currently running locations', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 10, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 20, round: 1 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 10, round: 2 }) },
            { visitIndex: 3, payload: makePayload({ locationId: 20, round: 2 }) },
        ])

        const loc10 = await claimExclusive(queue, 1, 'w-10')
        const loc20 = await claimExclusive(queue, 1, 'w-20')
        expect(locationOf(loc10)).toBe(10)
        expect(locationOf(loc20)).toBe(20)

        expect(await claimExclusive(queue, 1, 'w-blocked')).toBeNull()
        expect(queue.getCampaignCounters(1).running).toBe(2)
        expect(queue.getCampaignCounters(1).pending).toBe(2)
    })

    it('allows the same locationId to be claimed again after the running visit completes', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 44, accountId: 1, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 44, accountId: 2, round: 2 }) },
        ])

        const first = await claimExclusive(queue, 1, 'worker-a')
        expect(first).not.toBeNull()
        expect(await claimExclusive(queue, 1, 'worker-b')).toBeNull()

        const completed = await queue.completeVisit(first!.id, { ok: true })
        expect(completed.applied).toBe(true)
        expect(queue.getVisit(first!.id)?.status).toBe('done')

        const reclaimed = await claimExclusive(queue, 1, 'worker-c')
        expect(reclaimed).not.toBeNull()
        expect(reclaimed?.id).not.toBe(first?.id)
        expect(reclaimed?.visitIndex).toBe(1)
        expect(locationOf(reclaimed)).toBe(44)
        expect(reclaimed?.status).toBe('running')
    })

    it('reclaims a location after one of two running maps completes, while the other stays excluded', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 10, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 20, round: 1 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 10, round: 2 }) },
            { visitIndex: 3, payload: makePayload({ locationId: 20, round: 2 }) },
        ])

        const loc10 = await claimExclusive(queue, 1, 'w-10')
        const loc20 = await claimExclusive(queue, 1, 'w-20')
        expect(await claimExclusive(queue, 1, 'w-idle')).toBeNull()

        await queue.completeVisit(loc10!.id)
        const next = await claimExclusive(queue, 1, 'w-10-next')
        expect(locationOf(next)).toBe(10)
        expect(next?.visitIndex).toBe(2)

        // Location 20 is still running, so its second round must wait.
        expect(await claimExclusive(queue, 1, 'w-still-blocked')).toBeNull()

        await queue.completeVisit(loc20!.id)
        const loc20Next = await claimExclusive(queue, 1, 'w-20-next')
        expect(locationOf(loc20Next)).toBe(20)
        expect(loc20Next?.visitIndex).toBe(3)
    })

    it('does not exclude the same locationId when disallowRunningLocations is omitted', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 7, accountId: 1, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 7, accountId: 2, round: 2 }) },
        ])

        const first = await queue.claimNextVisit(1, 'w1', CLAIM_LEASE_MS)
        const second = await queue.claimNextVisit(1, 'w2', CLAIM_LEASE_MS)
        expect(locationOf(first)).toBe(7)
        expect(locationOf(second)).toBe(7)
        expect(first?.id).not.toBe(second?.id)
        expect(queue.getCampaignCounters(1).running).toBe(2)
    })

    it('serializes concurrent exclusive claims so two workers never share a locationId', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 1, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 2, round: 1 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 3, round: 1 }) },
            { visitIndex: 3, payload: makePayload({ locationId: 1, round: 2 }) },
            { visitIndex: 4, payload: makePayload({ locationId: 2, round: 2 }) },
            { visitIndex: 5, payload: makePayload({ locationId: 3, round: 2 }) },
        ])

        const results = await Promise.all([
            claimExclusive(queue, 1, 'a'),
            claimExclusive(queue, 1, 'b'),
            claimExclusive(queue, 1, 'c'),
            claimExclusive(queue, 1, 'd'),
        ])
        const claimed = results.filter((row): row is TrafficVisitRow => row != null)
        const locationIds = claimed.map(row => locationOf(row))

        expect(claimed).toHaveLength(3)
        expect(new Set(locationIds).size).toBe(3)
        expect(new Set(locationIds)).toEqual(new Set([1, 2, 3]))
        expect(await claimExclusive(queue, 1, 'e')).toBeNull()
    })

    it('merges explicit disallowedLocationIds with currently running locations', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 10, round: 1 }) },
            { visitIndex: 1, payload: makePayload({ locationId: 20, round: 1 }) },
            { visitIndex: 2, payload: makePayload({ locationId: 30, round: 1 }) },
        ])

        const running = await claimExclusive(queue, 1, 'w-10')
        expect(locationOf(running)).toBe(10)

        const next = await claimExclusive(queue, 1, 'w-skip-20', new Date(), new Set([20]))
        expect(locationOf(next)).toBe(30)
        expect(await claimExclusive(queue, 1, 'w-blocked', new Date(), new Set([20]))).toBeNull()
    })

    it('does not let a running location in another campaign block this campaign', async () => {
        await queue.seedCampaign(1, [
            { visitIndex: 0, payload: makePayload({ locationId: 55, accountId: 1 }) },
        ])
        await queue.seedCampaign(2, [
            { visitIndex: 0, payload: makePayload({ locationId: 55, accountId: 2 }) },
        ])

        const campaign1 = await claimExclusive(queue, 1, 'c1')
        expect(locationOf(campaign1)).toBe(55)

        const campaign2 = await claimExclusive(queue, 2, 'c2')
        expect(campaign2).not.toBeNull()
        expect(locationOf(campaign2)).toBe(55)
        expect(campaign2?.campaignId).toBe(2)
    })
})

describe('FProxyPoolService — one slot shared across locationIds', () => {
    let db: FakeFProxyDatabase
    let provider: FakeFProxyProvider
    let pool: FProxyPoolService

    beforeEach(() => {
        db = new FakeFProxyDatabase()
        provider = new FakeFProxyProvider()
        pool = new FProxyPoolService(provider as never)
        vi.mocked(getDatabase).mockReturnValue(db.db as never)
    })

    async function addSingleSlot(): Promise<void> {
        await pool.addSlot({ label: 'Shared Slot', apiKey: PROXY_KEY })
    }

    it('issues concurrent leases on one slot for distinct locationIds and reuses the same egress IP', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, {
            observedIp: '203.0.113.10',
            rotateAllowedAt: Date.now() - 1,
        }))

        const [leaseA, leaseB, leaseC] = await Promise.all([
            pool.acquire({ owner: trafficOwner('campaign-1:loc-10:t0', 0, 10) }),
            pool.acquire({ owner: trafficOwner('campaign-1:loc-20:t1', 1, 20) }),
            pool.acquire({ owner: trafficOwner('campaign-1:loc-30:t2', 2, 30) }),
        ])

        expect(new Set([leaseA.slotId, leaseB.slotId, leaseC.slotId]).size).toBe(1)
        expect(leaseA.observedIp).toBe('203.0.113.10')
        expect(leaseB.observedIp).toBe(leaseA.observedIp)
        expect(leaseC.observedIp).toBe(leaseA.observedIp)
        expect(new Set([leaseA.leaseId, leaseB.leaseId, leaseC.leaseId]).size).toBe(3)
        expect(leaseB.generation).toBe(leaseA.generation)
        expect(leaseC.generation).toBe(leaseA.generation)
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)
        expect(provider.countCalls(PROXY_KEY, 'current')).toBe(0)

        const snapshot = await pool.getSnapshot()
        expect(snapshot.slots).toHaveLength(1)
        expect(snapshot.slots[0]?.status).toBe('leased')
        expect(snapshot.slots[0]?.available).toBe(false)
        expect(snapshot.slots[0]?.currentEgress?.ip).toBe('203.0.113.10')
        expect(snapshot.slots[0]?.activeLocationIds?.slice().sort((a, b) => a - b)).toEqual([10, 20, 30])

        await Promise.all([leaseA.release('done'), leaseB.release('done'), leaseC.release('done')])
    })

    it('waits then times out when the same locationId already holds a lease on the only slot', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(2, {
            observedIp: '203.0.113.20',
            rotateAllowedAt: Date.now() - 1,
        }))

        const held = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })

        let secondResolved = false
        const waiting = pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t1', 1, 10),
            timeoutMs: 1_000,
        }).then(lease => {
            secondResolved = true
            return lease
        })

        await delay(40)
        expect(secondResolved).toBe(false)
        await expect(waiting).rejects.toBeInstanceOf(FProxyPoolError)
        await expect(
            pool.acquire({
                owner: trafficOwner('campaign-1:loc-10:t2', 2, 10),
                timeoutMs: 1_000,
            }),
        ).rejects.toMatchObject({ code: 'no_slot_available' })

        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)
        const snapshot = await pool.getSnapshot()
        expect(snapshot.slots[0]?.activeLocationIds).toEqual([10])
        expect(secondResolved).toBe(false)

        await held.release('done')
    })

    it('lets a waiting same-location acquire proceed once that locationId is free, without rotating while another location still holds the slot', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(3, {
            observedIp: '203.0.113.30',
            rotateAllowedAt: Date.now() - 1,
        }))

        const loc10 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        const loc20 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-20:t1', 1, 20),
        })
        expect(loc10.observedIp).toBe(loc20.observedIp)
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)

        let waitingResolved = false
        const waiting = pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t2', 2, 10),
            timeoutMs: 5_000,
        }).then(lease => {
            waitingResolved = true
            return lease
        })

        await delay(40)
        expect(waitingResolved).toBe(false)

        await loc10.release('partial_free')
        const loc10Again = await waiting
        expect(waitingResolved).toBe(true)
        expect(loc10Again.slotId).toBe(loc20.slotId)
        expect(loc10Again.observedIp).toBe('203.0.113.30')
        expect(loc10Again.leaseId).not.toBe(loc10.leaseId)
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)

        const snapshot = await pool.getSnapshot()
        expect(snapshot.slots[0]?.status).toBe('leased')
        expect(snapshot.slots[0]?.activeLocationIds?.slice().sort((a, b) => a - b)).toEqual([10, 20])

        await Promise.all([loc20.release('done'), loc10Again.release('done')])
    })

    it('does not rotate on a partial release; last lease release is what arms rotate_per_visit', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(4, {
            observedIp: '203.0.113.40',
            rotateAllowedAt: Date.now() - 1,
        }))

        const loc10 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        const loc20 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-20:t1', 1, 20),
        })
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)

        await loc10.release('still_shared')
        await delay(30)

        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)
        const afterPartial = await pool.getSnapshot()
        expect(afterPartial.slots[0]?.status).toBe('leased')
        expect(afterPartial.slots[0]?.currentEgress?.ip).toBe('203.0.113.40')
        expect(afterPartial.slots[0]?.activeLocationIds).toEqual([20])
        expect(loc20.observedIp).toBe('203.0.113.40')

        const loc30 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-30:t2', 2, 30),
        })
        expect(loc30.observedIp).toBe('203.0.113.40')
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)

        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(5, {
            observedIp: '203.0.113.50',
            rotateAllowedAt: Date.now() - 1,
        }))

        await Promise.all([loc20.release('last_wave'), loc30.release('last_wave')])
        const afterLast = await pool.getSnapshot()
        expect(afterLast.slots[0]?.status).not.toBe('leased')
        expect(afterLast.slots[0]?.activeLocationIds ?? []).toEqual([])
        // Rotation is armed on last release; getNew runs on the next acquire.
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(1)

        const next = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-40:t3', 3, 40),
            timeoutMs: 3_000,
        })
        expect(next.observedIp).toBe('203.0.113.50')
        expect(next.slotId).toBe(loc10.slotId)
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(2)

        await next.release('done')
    })

    it('rotates after the last exclusive lease is released even when a same-location waiter is queued', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(6, {
            observedIp: '203.0.113.60',
            rotateAllowedAt: Date.now() - 1,
        }))
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(7, {
            observedIp: '203.0.113.70',
            rotateAllowedAt: Date.now() - 1,
        }))

        const first = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        expect(first.observedIp).toBe('203.0.113.60')

        const waiting = pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t1', 1, 10),
            timeoutMs: 5_000,
        })
        await delay(40)

        await first.release('last_exclusive')
        const rotated = await waiting
        expect(rotated.observedIp).toBe('203.0.113.70')
        expect(rotated.leaseId).not.toBe(first.leaseId)
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(2)

        await rotated.release('done')
    })
})
