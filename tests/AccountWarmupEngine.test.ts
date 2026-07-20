import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'

// Electron is not available under vitest — stub before engine import graph loads.
vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => path.join(os.tmpdir(), 'mmo-warmup-test', name),
        isReady: () => true,
        on: vi.fn(),
    },
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
    },
}))

import {
    WarmupSessionRegistry,
    type RunningSession,
} from '../src/main/automation/AccountWarmupEngine'

describe('WarmupSessionRegistry — atomic reservation (no TOCTOU)', () => {
    it('reserves once per accountId; second tryReserve returns null', () => {
        const reg = new WarmupSessionRegistry()
        const a = reg.tryReserve(1, 'google_search')
        const b = reg.tryReserve(1, 'maps_browse')

        expect(a).not.toBeNull()
        expect(b).toBeNull()
        expect(reg.isRunning(1)).toBe(true)
        expect(a?.activityType).toBe('google_search')
        expect(a?.generation).toBeGreaterThan(0)
    })

    it('allows concurrent reserve races: exactly one winner per account', () => {
        const reg = new WarmupSessionRegistry()
        // Sync loop models interleaving without await gaps (same as engine.start reservation).
        const winners: RunningSession[] = []
        const losers: null[] = []
        for (let i = 0; i < 20; i++) {
            const r = reg.tryReserve(42, 'youtube_browse')
            if (r) winners.push(r)
            else losers.push(null)
        }
        expect(winners).toHaveLength(1)
        expect(losers).toHaveLength(19)
        expect(reg.get(42)?.generation).toBe(winners[0].generation)
    })

    it('allows different accounts in parallel', () => {
        const reg = new WarmupSessionRegistry()
        const a = reg.tryReserve(1, 'google_search')
        const b = reg.tryReserve(2, 'maps_browse')
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
        expect(a!.generation).not.toBe(b!.generation)
        expect(reg.getRunningIds()).toEqual(new Set([1, 2]))
    })

    it('releaseIfSame frees the slot so a new generation can reserve', () => {
        const reg = new WarmupSessionRegistry()
        const first = reg.tryReserve(7, 'google_search')
        expect(first).not.toBeNull()
        expect(reg.releaseIfSame(first!)).toBe(true)
        expect(reg.isRunning(7)).toBe(false)

        const second = reg.tryReserve(7, 'maps_browse')
        expect(second).not.toBeNull()
        expect(second!.generation).toBeGreaterThan(first!.generation)
    })

    it('releaseIfSame is a no-op for stale session objects', () => {
        const reg = new WarmupSessionRegistry()
        const first = reg.tryReserve(3, 'google_search')!
        reg.releaseIfSame(first)
        const second = reg.tryReserve(3, 'youtube_browse')!
        expect(reg.releaseIfSame(first)).toBe(false)
        expect(reg.isRunning(3)).toBe(true)
        expect(reg.get(3)?.generation).toBe(second.generation)
    })
})

describe('WarmupSessionRegistry — cancel / generation live gate', () => {
    it('isLive is true only for the reserved non-cancelled session', () => {
        const reg = new WarmupSessionRegistry()
        const session = reg.tryReserve(9, 'google_search')!
        expect(reg.isLive(session)).toBe(true)
    })

    it('isLive becomes false after markCancelled (credit must not proceed)', () => {
        const reg = new WarmupSessionRegistry()
        const session = reg.tryReserve(9, 'google_search')!
        const marked = reg.markCancelled(9)
        expect(marked).toBe(session)
        expect(session.cancelled).toBe(true)
        expect(reg.isLive(session)).toBe(false)
        // Slot still present until release (running=true during cancel wind-down)
        expect(reg.isRunning(9)).toBe(true)
    })

    it('isLive becomes false after release (stale generation)', () => {
        const reg = new WarmupSessionRegistry()
        const session = reg.tryReserve(11, 'maps_browse')!
        reg.releaseIfSame(session)
        expect(reg.isLive(session)).toBe(false)
    })

    it('isLive is false for an old generation after re-reserve', () => {
        const reg = new WarmupSessionRegistry()
        const old = reg.tryReserve(15, 'google_search')!
        reg.releaseIfSame(old)
        const next = reg.tryReserve(15, 'youtube_browse')!
        expect(reg.isLive(old)).toBe(false)
        expect(reg.isLive(next)).toBe(true)
        expect(next.generation).toBeGreaterThan(old.generation)
    })

    it('simulates credit gate order: cancel between login check and completeSession', () => {
        const reg = new WarmupSessionRegistry()
        const session = reg.tryReserve(20, 'google_search')!

        // Gate 1: live before login check
        expect(reg.isLive(session)).toBe(true)

        // Simulated isGoogleLoggedIn = true (external)
        const googleLoggedIn = true
        expect(googleLoggedIn).toBe(true)

        // Cancel arrives before completeSession
        reg.markCancelled(20)

        // Gate 3: re-check immediately before completeSession — MUST refuse credit
        expect(reg.isLive(session)).toBe(false)
    })

    it('shouldCommit commit-token mirrors isLive across cancel mid-await', () => {
        const reg = new WarmupSessionRegistry()
        const session = reg.tryReserve(21, 'maps_browse')!

        // Engine wires: { shouldCommit: () => registry.isLive(session) }
        const shouldCommit = (): boolean => reg.isLive(session)
        expect(shouldCommit()).toBe(true)

        // Cancel while completeSession would be suspended on getWarmupData
        reg.markCancelled(21)

        // Guard re-check post-load / pre-commit must refuse
        expect(shouldCommit()).toBe(false)
        expect(reg.isLive(session)).toBe(false)
    })

    it('shouldCommit is false for stale generation after re-reserve', () => {
        const reg = new WarmupSessionRegistry()
        const old = reg.tryReserve(22, 'youtube_browse')!
        const shouldCommitOld = (): boolean => reg.isLive(old)
        expect(shouldCommitOld()).toBe(true)

        reg.releaseIfSame(old)
        const next = reg.tryReserve(22, 'google_search')!
        expect(shouldCommitOld()).toBe(false)
        expect(reg.isLive(next)).toBe(true)
    })

    it('markCancelled on missing account returns undefined', () => {
        const reg = new WarmupSessionRegistry()
        expect(reg.markCancelled(999)).toBeUndefined()
    })
})

describe('WarmupSessionRegistry — cleanup on failed start path', () => {
    it('failed pre-run validation can release reservation so start can retry', () => {
        const reg = new WarmupSessionRegistry()
        const reserved = reg.tryReserve(5, 'google_search')!
        // Simulate: account not found / cooldown / daily cap → releaseIfSame
        expect(reg.releaseIfSame(reserved)).toBe(true)
        expect(reg.isRunning(5)).toBe(false)
        const retry = reg.tryReserve(5, 'maps_browse')
        expect(retry).not.toBeNull()
        expect(reg.isLive(retry!)).toBe(true)
    })
})
