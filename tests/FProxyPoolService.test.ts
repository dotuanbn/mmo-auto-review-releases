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
import {
    FProxyPoolError,
    FProxyPoolService,
} from '../src/main/services/FProxyPoolService'
import {
    createDeferred,
    createFakeEndpoint,
    FakeFProxyDatabase,
    FakeFProxyProvider,
} from './helpers/FakeFProxyProvider'

const KEY_A = 'fproxy-key-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'fproxy-key-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbb'
const KEY_C = 'fproxy-key-charlie-ccccccccccccccccccccccccc'

function owner(kind: 'traffic_visit' | 'automation_job', id: string, threadId: number) {
    return { kind, id, threadId }
}

describe('FProxyPoolService multi-key lease', () => {
    let db: FakeFProxyDatabase
    let provider: FakeFProxyProvider
    let pool: FProxyPoolService

    beforeEach(() => {
        db = new FakeFProxyDatabase()
        provider = new FakeFProxyProvider()
        pool = new FProxyPoolService(provider as never)
        vi.mocked(getDatabase).mockReturnValue(db.db as never)
    })

    async function addThreeSlots() {
        await pool.addSlot({ label: 'Slot A', apiKey: KEY_A })
        await pool.addSlot({ label: 'Slot B', apiKey: KEY_B })
        await pool.addSlot({ label: 'Slot C', apiKey: KEY_C })
    }

    it('public snapshot never exposes raw API keys', async () => {
        await pool.addSlot({ label: 'Secret Slot', apiKey: KEY_A })
        const snapshot = await pool.getSnapshot()
        const text = JSON.stringify(snapshot)
        expect(text).not.toContain(KEY_A)
        expect(text).not.toContain('sealed:')
        expect(snapshot.slots[0]?.hasSecret).toBe(true)
        expect(snapshot.slots[0]?.available).toBe(true)
        expect(snapshot.capacity).toBe(1)
    })

    it('rejects duplicate API keys', async () => {
        await pool.addSlot({ label: 'One', apiKey: KEY_A })
        await expect(pool.addSlot({ label: 'Two', apiKey: KEY_A })).rejects.toMatchObject({
            code: 'duplicate_slot',
        })
    })

    it('leases three unique IPs concurrently across three slots', async () => {
        await addThreeSlots()
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(1))
        provider.enqueueEndpoint(KEY_B, 'current', createFakeEndpoint(2))
        provider.enqueueEndpoint(KEY_C, 'current', createFakeEndpoint(3))

        const leases = await Promise.all([
            pool.acquire({ owner: owner('traffic_visit', 'campaign-1:thread-0', 0) }),
            pool.acquire({ owner: owner('traffic_visit', 'campaign-1:thread-1', 1) }),
            pool.acquire({ owner: owner('traffic_visit', 'campaign-1:thread-2', 2) }),
        ])

        const ips = leases.map(lease => lease.observedIp).sort()
        const slots = leases.map(lease => lease.slotId).sort((a, b) => a - b)
        expect(ips).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3'])
        expect(slots).toEqual([1, 2, 3])

        const snapshot = await pool.getSnapshot()
        expect(snapshot.capacity).toBe(0)
        expect(snapshot.slots.every(slot => slot.status === 'leased')).toBe(true)
        expect(snapshot.slots.every(slot => slot.leaseOwner !== null)).toBe(true)

        await Promise.all(leases.map(lease => lease.release('test_done')))
        const after = await pool.getSnapshot()
        expect(after.slots.every(slot => slot.status !== 'leased')).toBe(true)
    })

    it('queues a 4th acquire until a slot is released when capacity is 3', async () => {
        await addThreeSlots()
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(11))
        provider.enqueueEndpoint(KEY_B, 'current', createFakeEndpoint(12))
        provider.enqueueEndpoint(KEY_C, 'current', createFakeEndpoint(13))

        const firstThree = await Promise.all([
            pool.acquire({ owner: owner('traffic_visit', 'c1:t0', 0) }),
            pool.acquire({ owner: owner('traffic_visit', 'c1:t1', 1) }),
            pool.acquire({ owner: owner('traffic_visit', 'c1:t2', 2) }),
        ])

        provider.enqueueEndpoint(KEY_A, 'new', createFakeEndpoint(14, {
            observedIp: '203.0.113.14',
            rotateAllowedAt: Date.now() - 1,
        }))

        let fourthResolved = false
        const fourthPromise = pool.acquire({
            owner: owner('traffic_visit', 'c1:t3', 3),
            timeoutMs: 5_000,
        }).then(lease => {
            fourthResolved = true
            return lease
        })

        await new Promise(resolve => setTimeout(resolve, 40))
        expect(fourthResolved).toBe(false)

        await firstThree[0].release('free_for_fourth')
        const fourth = await fourthPromise
        expect(fourth.observedIp).toBe('203.0.113.14')
        expect(fourth.slotId).toBe(firstThree[0].slotId)

        await Promise.all([
            firstThree[1].release('done'),
            firstThree[2].release('done'),
            fourth.release('done'),
        ])
    })

    it('strict mode rejects same egress IP across concurrent leases', async () => {
        await pool.addSlot({ label: 'A', apiKey: KEY_A })
        await pool.addSlot({ label: 'B', apiKey: KEY_B })
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(21, {
            observedIp: '198.51.100.50',
            proxySnapshot: {
                host: '10.0.0.1',
                port: 20001,
                username: 'u1',
                password: 'p1',
                type: 'http',
            },
        }))
        provider.enqueueEndpoint(KEY_B, 'current', createFakeEndpoint(22, {
            observedIp: '198.51.100.50',
            proxySnapshot: {
                host: '10.0.0.2',
                port: 20002,
                username: 'u2',
                password: 'p2',
                type: 'http',
            },
        }))
        provider.enqueueEndpoint(KEY_B, 'new', createFakeEndpoint(23, {
            observedIp: '198.51.100.50',
            rotateAllowedAt: Date.now() - 1,
            proxySnapshot: {
                host: '10.0.0.3',
                port: 20003,
                username: 'u3',
                password: 'p3',
                type: 'http',
            },
        }))

        const first = await pool.acquire({
            owner: owner('automation_job', 'campaign-9:account-1', 1),
            timeoutMs: 1_000,
        })
        expect(first.observedIp).toBe('198.51.100.50')

        await expect(pool.acquire({
            owner: owner('automation_job', 'campaign-9:account-2', 2),
            timeoutMs: 300,
        })).rejects.toBeInstanceOf(FProxyPoolError)

        await first.release('done')
    })

    it('blocks remove/disable while slot is leased', async () => {
        await pool.addSlot({ label: 'Busy', apiKey: KEY_A })
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(31))
        const lease = await pool.acquire({
            owner: owner('traffic_visit', 'busy-owner', 0),
        })
        await expect(pool.removeSlot(lease.slotId)).rejects.toMatchObject({ code: 'slot_leased' })
        await expect(pool.setEnabled(lease.slotId, false)).rejects.toMatchObject({ code: 'slot_leased' })
        await lease.release('done')
        const after = await pool.removeSlot(lease.slotId)
        expect(after.slots.find(slot => slot.id === lease.slotId)).toBeUndefined()
    })

    it('abort signal cancels a waiting acquire', async () => {
        await pool.addSlot({ label: 'Only', apiKey: KEY_A })
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(41))
        const first = await pool.acquire({
            owner: owner('traffic_visit', 'holder', 0),
        })
        const controller = new AbortController()
        const waiting = pool.acquire({
            owner: owner('traffic_visit', 'waiter', 1),
            timeoutMs: 5_000,
            signal: controller.signal,
        })
        await new Promise(resolve => setTimeout(resolve, 20))
        controller.abort()
        await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
        await first.release('done')
    })

    it('sticky_session reuses the previously used slot for the same owner', async () => {
        await pool.addSlot({ label: 'A', apiKey: KEY_A })
        await pool.addSlot({ label: 'B', apiKey: KEY_B })
        await pool.updatePolicy({ strictUnique: true, rotationPolicy: 'sticky_session' })

        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(51))
        const first = await pool.acquire({
            owner: owner('automation_job', 'sticky-account', 1),
        })
        const stickySlot = first.slotId
        await first.release('mid')

        const second = await pool.acquire({
            owner: owner('automation_job', 'sticky-account', 1),
        })
        expect(second.slotId).toBe(stickySlot)
        await second.release('done')
    })

    it('idempotent release does not crash or re-lease', async () => {
        await pool.addSlot({ label: 'A', apiKey: KEY_A })
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(61))
        const lease = await pool.acquire({
            owner: owner('traffic_visit', 'gen-owner', 0),
        })
        await lease.release('first')
        await lease.release('second')
        const snapshot = await pool.getSnapshot()
        expect(snapshot.slots[0]?.status === 'leased').toBe(false)
    })

    it('blocks rotateSlot during provider cooldown window', async () => {
        await pool.addSlot({ label: 'Cooldown', apiKey: KEY_A })
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(71, {
            rotateAllowedAt: Date.now() + 120_000,
            endpointExpiresAt: Date.now() + 180_000,
        }))
        const result = await pool.testSlot(1)
        expect(result.success).toBe(true)
        await expect(pool.rotateSlot(1)).rejects.toMatchObject({ code: 'slot_cooldown' })
    })

    it('serializes concurrent acquire on a single free slot', async () => {
        await pool.addSlot({ label: 'Single', apiKey: KEY_A })
        const deferred = createDeferred<ReturnType<typeof createFakeEndpoint>>()
        provider.enqueueDeferred(KEY_A, 'current', deferred)

        const firstPromise = pool.acquire({
            owner: owner('traffic_visit', 'race-1', 0),
            timeoutMs: 3_000,
        })
        const secondPromise = pool.acquire({
            owner: owner('traffic_visit', 'race-2', 1),
            timeoutMs: 3_000,
        })

        await new Promise(resolve => setTimeout(resolve, 20))
        deferred.resolve(createFakeEndpoint(81))
        provider.enqueueEndpoint(KEY_A, 'new', createFakeEndpoint(82, {
            observedIp: '203.0.113.82',
            rotateAllowedAt: Date.now() - 1,
        }))

        const first = await firstPromise
        expect(first.slotId).toBe(1)
        expect(first.observedIp).toBe('203.0.113.81')

        let secondDone = false
        const secondWatch = secondPromise.then(lease => {
            secondDone = true
            return lease
        })
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(secondDone).toBe(false)

        await first.release('hand_off')
        const second = await secondWatch
        expect(second.slotId).toBe(1)
        expect(second.observedIp).toBe('203.0.113.82')
        await second.release('done')
    })

    it('supports mixed traffic and automation owners without IP sharing', async () => {
        await addThreeSlots()
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(91))
        provider.enqueueEndpoint(KEY_B, 'current', createFakeEndpoint(92))
        provider.enqueueEndpoint(KEY_C, 'current', createFakeEndpoint(93))

        const [traffic, automation] = await Promise.all([
            pool.acquire({ owner: owner('traffic_visit', 'campaign-map-a:thread-0', 0) }),
            pool.acquire({ owner: owner('automation_job', 'campaign-map-b:account-7', 7) }),
        ])
        expect(traffic.observedIp).not.toBe(automation.observedIp)
        expect(traffic.slotId).not.toBe(automation.slotId)
        await Promise.all([traffic.release('done'), automation.release('done')])
    })

    it('prefers the earliest-ready free key over cooling recently-used keys', async () => {
        await addThreeSlots()
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(101, {
            observedIp: '203.0.113.101',
            rotateAllowedAt: Date.now() + 120_000,
        }))
        provider.enqueueEndpoint(KEY_B, 'current', createFakeEndpoint(102, {
            observedIp: '203.0.113.102',
            rotateAllowedAt: Date.now() + 120_000,
        }))
        provider.enqueueEndpoint(KEY_C, 'current', createFakeEndpoint(103, {
            observedIp: '203.0.113.103',
            rotateAllowedAt: Date.now() - 1,
        }))

        const [leaseA, leaseB] = await Promise.all([
            pool.acquire({ owner: owner('traffic_visit', 'c1:t0', 0) }),
            pool.acquire({ owner: owner('traffic_visit', 'c1:t1', 1) }),
        ])
        await Promise.all([leaseA.release('wave1'), leaseB.release('wave1')])

        const next = await pool.acquire({
            owner: owner('traffic_visit', 'c1:t0', 0),
            timeoutMs: 1_000,
        })
        expect(next.observedIp).toBe('203.0.113.103')
        expect(next.slotId).toBe(3)
        await next.release('done')
    })

    it('when all used keys are cooling, assigns the key that becomes ready first', async () => {
        await pool.addSlot({ label: 'A', apiKey: KEY_A })
        await pool.addSlot({ label: 'B', apiKey: KEY_B })
        const soon = Date.now() + 80
        const later = Date.now() + 5_000
        provider.enqueueEndpoint(KEY_A, 'current', createFakeEndpoint(201, {
            observedIp: '203.0.113.201',
            rotateAllowedAt: later,
        }))
        provider.enqueueEndpoint(KEY_B, 'current', createFakeEndpoint(202, {
            observedIp: '203.0.113.202',
            rotateAllowedAt: soon,
        }))
        const firstWave = await Promise.all([
            pool.acquire({ owner: owner('traffic_visit', 'ready:t0', 0) }),
            pool.acquire({ owner: owner('traffic_visit', 'ready:t1', 1) }),
        ])
        await Promise.all(firstWave.map(lease => lease.release('cool')))

        provider.enqueueEndpoint(KEY_B, 'new', createFakeEndpoint(203, {
            observedIp: '203.0.113.203',
            rotateAllowedAt: Date.now() - 1,
        }))

        const started = Date.now()
        const next = await pool.acquire({
            owner: owner('traffic_visit', 'ready:t2', 2),
            timeoutMs: 2_000,
        })
        expect(next.slotId).toBe(firstWave.find(l => l.observedIp === '203.0.113.202')?.slotId)
        expect(next.observedIp).toBe('203.0.113.203')
        expect(Date.now() - started).toBeLessThan(2500)
        await next.release('done')
    })

})
