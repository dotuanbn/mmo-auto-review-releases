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
    type FProxyLease,
    type FProxyLeaseRequest,
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

describe('FProxyPoolService — strict 1 key = 1 browser = 1 unique IP per visit', () => {
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
        await pool.addSlot({ label: 'Slot 1', apiKey: PROXY_KEY })
    }

    it('never shares a single slot concurrently across distinct locationIds; second visit waits for rotation to a new IP', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, {
            observedIp: '203.0.113.10',
            rotateAllowedAt: Date.now() - 1,
        }))
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(2, {
            observedIp: '203.0.113.20',
            rotateAllowedAt: Date.now() - 1,
        }))

        const leaseA = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        expect(leaseA.observedIp).toBe('203.0.113.10')

        let secondResolved = false
        const secondPromise = pool.acquire({
            owner: trafficOwner('campaign-1:loc-20:t1', 1, 20),
            timeoutMs: 3_000,
        }).then(lease => {
            secondResolved = true
            return lease
        })

        await delay(40)
        expect(secondResolved).toBe(false)

        const snapshotWhileLeased = await pool.getSnapshot()
        expect(snapshotWhileLeased.slots[0]?.status).toBe('leased')
        expect(snapshotWhileLeased.slots[0]?.activeLocationIds).toEqual([10])

        await leaseA.release('visit_1_done')
        const leaseB = await secondPromise
        expect(secondResolved).toBe(true)
        expect(leaseB.slotId).toBe(leaseA.slotId)
        expect(leaseB.observedIp).toBe('203.0.113.20')
        expect(leaseB.observedIp).not.toBe(leaseA.observedIp)
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(2)

        await leaseB.release('visit_2_done')
    })

    it('waits for server cooldown (waiting_time) when a visit completes early before opening the next visit', async () => {
        await addSingleSlot()
        const cooldownEnd = Date.now() + 120
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, {
            observedIp: '203.0.113.11',
            rotateAllowedAt: cooldownEnd,
        }))
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(2, {
            observedIp: '203.0.113.22',
            rotateAllowedAt: Date.now() + 120_000,
        }))

        const visit1 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        expect(visit1.observedIp).toBe('203.0.113.11')
        // KPI completes early while key still has cooldown remaining
        await visit1.release('kpi_done_early')

        const afterRelease = await pool.getSnapshot()
        expect(afterRelease.slots[0]?.status).toBe('cooldown')
        expect(afterRelease.slots[0]?.available).toBe(false)

        let visit2Started = false
        const visit2Promise = pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
            slotId: 1,
            timeoutMs: 3_000,
        }).then(lease => {
            visit2Started = true
            return lease
        })

        await delay(30)
        expect(visit2Started).toBe(false)

        const visit2 = await visit2Promise
        expect(visit2Started).toBe(true)
        expect(visit2.observedIp).toBe('203.0.113.22')
        expect(Date.now()).toBeGreaterThanOrEqual(cooldownEnd - 15)

        await visit2.release('done')
    })

    it('retries if cooldown elapses between the admission probe and wake scheduling on a busy CPU', async () => {
        await addSingleSlot()
        let logicalNow = Date.now()
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => logicalNow)
        const cooldownEnd = logicalNow + 120
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, { rotateAllowedAt: cooldownEnd }))
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(2))
        const first = await pool.acquire({ owner: trafficOwner('busy-cpu-first', 0, 10) })
        await first.release('finished')
        const internal = pool as unknown as { tryAcquire: (request: FProxyLeaseRequest) => Promise<FProxyLease | null> }
        const originalProbe = internal.tryAcquire.bind(pool)
        const probe = vi.spyOn(internal, 'tryAcquire').mockImplementationOnce(async request => {
            const result = await originalProbe(request)
            // Model CPU starvation during the await boundary, without sleeping the test host.
            logicalNow = cooldownEnd + 1
            return result
        })
        try {
            const next = await pool.acquire({ owner: trafficOwner('busy-cpu-next', 0, 10), timeoutMs: 3000 })
            expect(next.observedIp).toBe('203.0.113.2')
            expect(provider.countCalls(PROXY_KEY, 'new')).toBe(2)
            await next.release('done')
        } finally { probe.mockRestore(); clock.mockRestore() }
    })

    it('rejects same IP returned by getnew during server cooldown ("Vui lòng chờ") and waits until IP actually rotates', async () => {
        await addSingleSlot()
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, {
            observedIp: '14.184.172.161',
            rotateAllowedAt: Date.now() - 1,
        }))
        // Second getnew simulates FProxy returning the same old IP with "Vui lòng chờ" and 80ms remaining
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, {
            observedIp: '14.184.172.161',
            coolingDown: true,
            rotateAllowedAt: Date.now() + 80,
        }))
        // Third getnew after cooldown expires returns the fresh rotated IP
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(2, {
            observedIp: '14.184.199.88',
            rotateAllowedAt: Date.now() + 120_000,
        }))

        const visit1 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        expect(visit1.observedIp).toBe('14.184.172.161')
        await visit1.release('visit_1_done')

        const visit2 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
            slotId: 1,
            timeoutMs: 3_000,
        })
        expect(visit2.observedIp).toBe('14.184.199.88')
        expect(provider.countCalls(PROXY_KEY, 'new')).toBe(3)

        await visit2.release('visit_2_done')
    })

    it('preserves cooldown countdown across passive refreshAllSlots() (getCurrent mirror) between visits', async () => {
        await addSingleSlot()
        const rotateTarget = Date.now() + 60_000
        provider.enqueueEndpoint(PROXY_KEY, 'new', createFakeEndpoint(1, {
            observedIp: '203.0.113.50',
            rotateAllowedAt: rotateTarget,
            endpointExpiresAt: Date.now() + 1_800_000,
        }))

        const visit1 = await pool.acquire({
            owner: trafficOwner('campaign-1:loc-10:t0', 0, 10),
        })
        await visit1.release('early_finish')

        // Simulate 30s background UI refreshAllSlots() where getCurrent sanitizes mirrored waiting_time to Date.now()
        provider.enqueueEndpoint(PROXY_KEY, 'current', createFakeEndpoint(1, {
            observedIp: '203.0.113.50',
            rotateAllowedAt: Date.now(),
            endpointExpiresAt: Date.now() + 1_770_000,
        }))
        const snapAfterRefresh = await pool.refreshAllSlots()
        expect(snapAfterRefresh.slots[0]?.status).toBe('cooldown')
        expect(snapAfterRefresh.slots[0]?.cooldownUntil).toBe(rotateTarget)
    })

    it('allows 2 keys pinned to 2 threads to rotate and open browsers independently without head-of-line blocking', async () => {
        const KEY_1 = 'fproxy-key-slot1-1111111111111111111111111'
        const KEY_2 = 'fproxy-key-slot2-2222222222222222222222222'
        await pool.addSlot({ label: 'Key 1', apiKey: KEY_1 })
        await pool.addSlot({ label: 'Key 2', apiKey: KEY_2 })

        // Visit 1 on Key 1 has a long cooldown (60s), Visit 1 on Key 2 has a short cooldown (40ms)
        provider.enqueueEndpoint(KEY_1, 'new', createFakeEndpoint(1, {
            observedIp: '203.0.113.101',
            rotateAllowedAt: Date.now() + 60_000,
        }))
        provider.enqueueEndpoint(KEY_2, 'new', createFakeEndpoint(2, {
            observedIp: '203.0.113.201',
            rotateAllowedAt: Date.now() + 40,
        }))
        provider.enqueueEndpoint(KEY_2, 'new', createFakeEndpoint(3, {
            observedIp: '203.0.113.202',
            rotateAllowedAt: Date.now() + 120_000,
        }))

        const [lease1, lease2] = await Promise.all([
            pool.acquire({ owner: trafficOwner('c1:t0', 0, 10), slotId: 1 }),
            pool.acquire({ owner: trafficOwner('c1:t1', 1, 20), slotId: 2 }),
        ])
        expect(lease1.slotId).toBe(1)
        expect(lease2.slotId).toBe(2)

        await Promise.all([lease1.release('done_1'), lease2.release('done_2')])

        // Thread 0 queues for Slot 1 first (still cooling for 60s); Thread 1 queues for Slot 2 second (ready in 40ms)
        const abortedThread0 = new AbortController()
        const pThread0 = pool.acquire({
            owner: trafficOwner('c1:t0:v2', 0, 10),
            slotId: 1,
            timeoutMs: 5_000,
            signal: abortedThread0.signal,
        })
        const pThread1 = pool.acquire({
            owner: trafficOwner('c1:t1:v2', 1, 20),
            slotId: 2,
            timeoutMs: 2_000,
        })

        // Thread 1 (Slot 2) must acquire its new IP without being blocked behind Thread 0 (Slot 1)
        const nextLease2 = await pThread1
        expect(nextLease2.slotId).toBe(2)
        expect(nextLease2.observedIp).toBe('203.0.113.202')

        abortedThread0.abort()
        await expect(pThread0).rejects.toMatchObject({ code: 'aborted' })
        await nextLease2.release('done')
    })
})
