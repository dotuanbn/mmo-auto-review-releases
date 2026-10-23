import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserResourceGovernor, BrowserResourceReservation } from '../src/main/services/BrowserResourceGovernor'
import { settingsPatchSchema } from '../src/shared/ipc-schemas'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => vi.useRealTimers())

function fixture(freeMB = 1700) {
    const memory = { freeMB, totalMB: 8192 }
    const governor = new BrowserResourceGovernor(() => memory)
    governor.configure(true)
    return { governor, memory }
}

describe('throughput-preserving low-resource mode', () => {
    it('admits all requested owners immediately without a context cap or launch spacing', async () => {
        const { governor } = fixture()
        const releases = await Promise.all(Array.from({ length: 100 }, () => governor.acquire()))
        expect(Date.now()).toBe(0)
        expect(governor.getSnapshot()).toMatchObject({ activeContexts: 100, queuedLaunches: 0, maxContexts: null })
        expect(vi.getTimerCount()).toBe(0)
        releases.forEach(release => { release(); release() })
        expect(governor.getSnapshot()).toMatchObject({ activeContexts: 0, queuedLaunches: 0 })
    })

    it('reports low RAM as advisory and never waits for memory to recover', async () => {
        const { governor, memory } = fixture(500)
        const releases = await Promise.all([governor.acquire(), governor.acquire(), governor.acquire()])
        expect(governor.getSnapshot()).toMatchObject({ memoryPressure: true, activeContexts: 3, queuedLaunches: 0 })
        memory.freeMB = 1000
        expect(governor.getSnapshot().memoryPressure).toBe(true)
        memory.freeMB = 1300
        expect(governor.getSnapshot().memoryPressure).toBe(false)
        releases.forEach(release => release())
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps active and new sessions unaffected when enabling or disabling the mode', async () => {
        const governor = new BrowserResourceGovernor(() => ({ freeMB: 0, totalMB: 8192 }))
        const releases = await Promise.all([governor.acquire(), governor.acquire(), governor.acquire()])
        governor.configure(true)
        const fourth = await governor.acquire()
        expect(governor.getSnapshot()).toMatchObject({ activeContexts: 4, queuedLaunches: 0, maxContexts: null })
        governor.configure(false)
        const fifth = await governor.acquire()
        expect(governor.getSnapshot()).toMatchObject({ activeContexts: 5, memoryPressure: false })
        releases.forEach((release) => release())
        fourth()
        fifth()
        expect(governor.getSnapshot().activeContexts).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('rejects already cancelled launches without adding listeners or counters', async () => {
        const { governor } = fixture(500)
        const controller = new AbortController()
        const add = vi.spyOn(controller.signal, 'addEventListener')
        controller.abort()
        await expect(governor.acquire({ signal: controller.signal })).rejects.toThrow('Browser launch cancelled')
        expect(add).not.toHaveBeenCalled()
        expect(governor.getSnapshot()).toMatchObject({ activeContexts: 0, queuedLaunches: 0 })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('observes stop predicates immediately', async () => {
        const { governor } = fixture(500)
        await expect(governor.acquire({ shouldAbort: () => true })).rejects.toThrow('Browser launch cancelled')
        expect(governor.getSnapshot().activeContexts).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('propagates stop-predicate errors without leaking resource accounting', async () => {
        const { governor } = fixture()
        await expect(governor.acquire({ shouldAbort: () => { throw new Error('stop-check failed') } })).rejects.toThrow('stop-check failed')
        expect(governor.getSnapshot()).toMatchObject({ activeContexts: 0, queuedLaunches: 0 })
        expect(vi.getTimerCount()).toBe(0)
    })

    it('reservations are single-use and cannot free a slot owned by a live context', async () => {
        const { governor } = fixture()
        const reservation = new BrowserResourceReservation(governor, await governor.acquire())
        expect(() => reservation.consume(new BrowserResourceGovernor())).toThrow(/Invalid/)
        const release = reservation.consume(governor)
        reservation.releaseUnused()
        expect(governor.getSnapshot().activeContexts).toBe(1)
        expect(() => reservation.consume(governor)).toThrow(/consumed/)
        release()
        expect(governor.getSnapshot().activeContexts).toBe(0)
    })

    it('releases unused reservations idempotently after proxy acquisition fails', async () => {
        const { governor } = fixture()
        const reservation = new BrowserResourceReservation(governor, await governor.acquire())
        reservation.releaseUnused()
        reservation.releaseUnused()
        expect(governor.getSnapshot().activeContexts).toBe(0)
        expect(() => reservation.consume(governor)).toThrow(/Invalid/)
    })

    it('simulates 24 hours of parallel launches, low RAM and mode changes without accumulating state', async () => {
        const { governor, memory } = fixture()
        for (let minute = 0; minute < 24 * 60; minute += 1) {
            memory.freeMB = minute % 20 === 0 ? 500 : 1700
            const releases = await Promise.all(Array.from({ length: 8 }, () => governor.acquire()))
            expect(governor.getSnapshot()).toMatchObject({ activeContexts: 8, queuedLaunches: 0 })
            releases.forEach(release => release())
            if (minute % 60 === 0) { governor.configure(false); governor.configure(true) }
            await vi.advanceTimersByTimeAsync(60_000)
            expect(governor.getSnapshot()).toMatchObject({ activeContexts: 0, queuedLaunches: 0 })
            expect(vi.getTimerCount()).toBe(0)
        }
    })

    it('requires a boolean through the settings boundary', () => {
        expect(settingsPatchSchema.parse({ lowResourceMode: true })).toEqual({ lowResourceMode: true })
        expect(settingsPatchSchema.safeParse({ lowResourceMode: 'true' }).success).toBe(false)
    })
})
