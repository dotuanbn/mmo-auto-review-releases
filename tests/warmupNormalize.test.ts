import { describe, expect, it } from 'vitest'
import {
    deriveWarmupTier,
    normalizeWarmupStatus,
    normalizeWarmupStatusMap,
    WARMUP_READY_MIN_LEVEL,
} from '../src/renderer/src/components/accounts/types'
import {
    deriveWarmupFromAccount,
    extractWarmupErrorCode,
    isWarmupCooldownActive,
    mapWarmupErrorMessage,
} from '../src/renderer/src/components/accounts/formatWarmup'
import type { PublicAccount } from '../src/shared/account-contracts'

/** Minimal PublicAccount for deriveWarmupFromAccount tests. */
function baseAccount(overrides: Partial<PublicAccount> = {}): PublicAccount {
    return {
        id: 42,
        email: 'user@example.com',
        loginType: 'auto',
        status: 'active',
        totalReviews: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        hasPassword: true,
        hasTwoFactorSecret: false,
        ...overrides,
    }
}

const t = (key: string, fallback?: string): string => fallback ?? key

describe('normalizeWarmupStatus — canonical backend fields', () => {
    it('maps AccountWarmupStatusDto fields (warmupLevel, reputationScore, warmupSessions, lastWarmupAt, nextWarmupAt, isReady, running)', () => {
        const status = normalizeWarmupStatus({
            accountId: 7,
            running: true,
            warmupLevel: 48,
            reputationScore: 120,
            warmupSessions: 3,
            lastWarmupAt: '2026-06-01T10:00:00.000Z',
            nextWarmupAt: '2026-06-02T10:00:00.000Z',
            isReady: true,
            progress: 55,
            activityType: 'maps',
        })

        expect(status).toEqual({
            accountId: 7,
            level: 48,
            reputation: 120,
            sessions: 3,
            readiness: true,
            progress: 55,
            lastActivityAt: '2026-06-01T10:00:00.000Z',
            nextActivityAt: '2026-06-02T10:00:00.000Z',
            state: 'running',
            activityType: 'maps',
            error: null,
        })
    })

    it('uses running=true to force state running even when status string is idle', () => {
        const status = normalizeWarmupStatus({
            accountId: 1,
            running: true,
            warmupLevel: 10,
            reputationScore: 0,
            warmupSessions: 0,
            lastWarmupAt: null,
            nextWarmupAt: null,
            isReady: false,
            state: 'idle',
        })
        expect(status?.state).toBe('running')
        expect(status?.readiness).toBe(false)
        expect(status?.progress).toBe(10)
    })

    it('when idle, progress falls back to level (not progress field)', () => {
        const status = normalizeWarmupStatus({
            accountId: 2,
            running: false,
            warmupLevel: 40,
            reputationScore: 10,
            warmupSessions: 1,
            lastWarmupAt: null,
            nextWarmupAt: null,
            isReady: true,
            progress: 90,
        })
        expect(status?.state).toBe('idle')
        expect(status?.progress).toBe(40)
        expect(status?.level).toBe(40)
        expect(status?.readiness).toBe(true)
    })

    it('derives readiness from isReady; clamps level; floors sessions', () => {
        const status = normalizeWarmupStatus({
            accountId: 3,
            warmupLevel: 150,
            reputationScore: 5,
            warmupSessions: 2.9,
            isReady: false,
            lastWarmupAt: null,
            nextWarmupAt: null,
            running: false,
        })
        expect(status?.level).toBe(100)
        expect(status?.sessions).toBe(2)
        expect(status?.readiness).toBe(false)
    })

    it('infers readiness from level >= 55 when isReady/ready/readiness absent (not 35)', () => {
        const atLegacy = normalizeWarmupStatus({ accountId: 4, warmupLevel: 35 })
        const at54 = normalizeWarmupStatus({ accountId: 5, warmupLevel: 54 })
        const ready = normalizeWarmupStatus({ accountId: 6, warmupLevel: WARMUP_READY_MIN_LEVEL })
        const notReady = normalizeWarmupStatus({ accountId: 7, warmupLevel: 34 })
        expect(atLegacy?.readiness).toBe(false)
        expect(at54?.readiness).toBe(false)
        expect(ready?.readiness).toBe(true)
        expect(notReady?.readiness).toBe(false)
    })
})

describe('normalizeWarmupStatus — aliases', () => {
    it('accepts id, level, reputation, sessions, readiness aliases', () => {
        const status = normalizeWarmupStatus({
            id: 9,
            level: 60,
            reputation: 80,
            sessions: 4,
            readiness: true,
            lastActivityAt: '2026-05-01T00:00:00.000Z',
            nextActivityAt: '2026-05-02T00:00:00.000Z',
            state: 'completed',
            activity: 'youtube',
        })

        expect(status).toMatchObject({
            accountId: 9,
            level: 60,
            reputation: 80,
            sessions: 4,
            readiness: true,
            lastActivityAt: '2026-05-01T00:00:00.000Z',
            nextActivityAt: '2026-05-02T00:00:00.000Z',
            state: 'completed',
            activityType: 'youtube',
        })
        expect(status?.progress).toBe(60)
    })

    it('accepts sessionCount, ready, lastActivity/lastAt, nextActivity/nextAt', () => {
        const status = normalizeWarmupStatus({
            accountId: 11,
            sessionCount: 6,
            ready: true,
            lastActivity: '2026-04-01T12:00:00.000Z',
            nextActivity: '2026-04-02T12:00:00.000Z',
            status: 'failed',
            message: '  network blip  ',
        })

        expect(status).toMatchObject({
            accountId: 11,
            sessions: 6,
            readiness: true,
            lastActivityAt: '2026-04-01T12:00:00.000Z',
            nextActivityAt: '2026-04-02T12:00:00.000Z',
            state: 'failed',
            error: 'network blip',
        })
    })

    it('maps lastAt/nextAt and in_progress/active run aliases to running', () => {
        const inProgress = normalizeWarmupStatus({
            accountId: 12,
            lastAt: 't1',
            nextAt: 't2',
            runState: 'in_progress',
            level: 20,
        })
        const active = normalizeWarmupStatus({
            accountId: 13,
            status: 'active',
            level: 20,
        })
        expect(inProgress).toMatchObject({
            lastActivityAt: 't1',
            nextActivityAt: 't2',
            state: 'running',
        })
        expect(active?.state).toBe('running')
    })

    it('uses fallbackId when accountId/id missing; returns null for invalid payloads', () => {
        expect(normalizeWarmupStatus({ warmupLevel: 10 }, 99)?.accountId).toBe(99)
        expect(normalizeWarmupStatus(null)).toBeNull()
        expect(normalizeWarmupStatus(undefined)).toBeNull()
        expect(normalizeWarmupStatus('nope')).toBeNull()
        expect(normalizeWarmupStatus({ warmupLevel: 10 })).toBeNull()
        expect(normalizeWarmupStatus({})).toBeNull()
    })

    it('converts Date values for activity timestamps to ISO strings', () => {
        const last = new Date('2026-03-15T08:30:00.000Z')
        const next = new Date('2026-03-16T08:30:00.000Z')
        const status = normalizeWarmupStatus({
            accountId: 14,
            lastWarmupAt: last,
            nextWarmupAt: next,
        })
        expect(status?.lastActivityAt).toBe(last.toISOString())
        expect(status?.nextActivityAt).toBe(next.toISOString())
    })

    it('prefers short aliases over backend names when both present (?? order)', () => {
        // Implementation: level ?? warmupLevel, reputation ?? reputationScore, etc.
        const status = normalizeWarmupStatus({
            accountId: 15,
            id: 999,
            warmupLevel: 70,
            level: 10,
            reputationScore: 200,
            reputation: 1,
            warmupSessions: 8,
            sessions: 1,
            isReady: true,
            ready: false,
            lastWarmupAt: 'canonical-last',
            lastActivityAt: 'alias-last',
            nextWarmupAt: 'canonical-next',
            nextActivityAt: 'alias-next',
            running: false,
            state: 'completed',
        })
        expect(status).toMatchObject({
            accountId: 15,
            level: 10,
            reputation: 1,
            sessions: 1,
            readiness: false,
            lastActivityAt: 'alias-last',
            nextActivityAt: 'alias-next',
            state: 'completed',
        })
    })
})

describe('normalizeWarmupStatusMap', () => {
    it('normalizes an array of backend status DTOs keyed by accountId', () => {
        const map = normalizeWarmupStatusMap([
            {
                accountId: 1,
                running: false,
                warmupLevel: 40,
                reputationScore: 10,
                warmupSessions: 2,
                lastWarmupAt: null,
                nextWarmupAt: null,
                isReady: true,
            },
            {
                accountId: 2,
                running: true,
                warmupLevel: 15,
                reputationScore: 0,
                warmupSessions: 0,
                lastWarmupAt: '2026-01-01T00:00:00.000Z',
                nextWarmupAt: null,
                isReady: false,
            },
        ])

        expect(Object.keys(map).map(Number).sort()).toEqual([1, 2])
        expect(map[1]).toMatchObject({
            accountId: 1,
            level: 40,
            reputation: 10,
            sessions: 2,
            readiness: true,
            state: 'idle',
        })
        expect(map[2]).toMatchObject({
            accountId: 2,
            level: 15,
            state: 'running',
            lastActivityAt: '2026-01-01T00:00:00.000Z',
            readiness: false,
        })
    })

    it('normalizes a record keyed by id, using key as fallbackId for partial values', () => {
        const map = normalizeWarmupStatusMap({
            '10': {
                warmupLevel: 50,
                reputationScore: 5,
                warmupSessions: 1,
                isReady: true,
                running: false,
                lastWarmupAt: null,
                nextWarmupAt: null,
            },
            '20': {
                accountId: 20,
                level: 25,
                reputation: 3,
                sessions: 0,
            },
        })

        expect(map[10]).toMatchObject({
            accountId: 10,
            level: 50,
            reputation: 5,
            sessions: 1,
            readiness: true,
        })
        expect(map[20]).toMatchObject({
            accountId: 20,
            level: 25,
            reputation: 3,
            sessions: 0,
            readiness: false,
        })
    })

    it('skips invalid entries and returns empty object for non-objects', () => {
        expect(normalizeWarmupStatusMap(null)).toEqual({})
        expect(normalizeWarmupStatusMap(undefined)).toEqual({})
        expect(normalizeWarmupStatusMap(42)).toEqual({})
        expect(
            normalizeWarmupStatusMap([
                null,
                { warmupLevel: 10 },
                { accountId: 3, warmupLevel: 12 },
            ]),
        ).toEqual({
            3: expect.objectContaining({ accountId: 3, level: 12 }),
        })
    })
})

describe('deriveWarmupFromAccount', () => {
    it('maps PublicAccount canonical warmup fields', () => {
        const account = baseAccount({
            id: 55,
            warmupLevel: 42,
            reputationScore: 99,
            warmupSessions: 7,
            lastWarmupAt: '2026-07-01T09:00:00.000Z',
            nextWarmupAt: '2026-07-02T09:00:00.000Z',
        })

        const status = deriveWarmupFromAccount(account)

        expect(status).toEqual({
            accountId: 55,
            level: 42,
            reputation: 99,
            sessions: 7,
            readiness: false,
            progress: 42,
            lastActivityAt: '2026-07-01T09:00:00.000Z',
            nextActivityAt: '2026-07-02T09:00:00.000Z',
            state: 'idle',
            activityType: null,
            error: null,
        })
    })

    it('defaults missing fields; readiness false below 55; clamps level', () => {
        const missing = deriveWarmupFromAccount(baseAccount({ id: 1 }))
        expect(missing).toMatchObject({
            accountId: 1,
            level: 0,
            reputation: 0,
            sessions: 0,
            readiness: false,
            progress: 0,
            lastActivityAt: null,
            nextActivityAt: null,
            state: 'idle',
            activityType: null,
            error: null,
        })

        expect(deriveWarmupFromAccount(baseAccount({ warmupLevel: 34 })).readiness).toBe(false)
        expect(deriveWarmupFromAccount(baseAccount({ warmupLevel: 35 })).readiness).toBe(false)
        expect(deriveWarmupFromAccount(baseAccount({ warmupLevel: 54 })).readiness).toBe(false)
        expect(deriveWarmupFromAccount(baseAccount({ warmupLevel: 55 })).readiness).toBe(true)
        expect(deriveWarmupFromAccount(baseAccount({ warmupLevel: 200 })).level).toBe(100)
        expect(deriveWarmupFromAccount(baseAccount({ warmupLevel: -5 })).level).toBe(0)
    })

    it('stringifies Date lastWarmupAt / nextWarmupAt', () => {
        const last = new Date('2026-02-10T15:00:00.000Z')
        const next = new Date('2026-02-11T15:00:00.000Z')
        const status = deriveWarmupFromAccount(
            baseAccount({
                lastWarmupAt: last,
                nextWarmupAt: next,
                warmupLevel: 50,
            }),
        )
        expect(status.lastActivityAt).toBe(String(last))
        expect(status.nextActivityAt).toBe(String(next))
    })
})

describe('deriveWarmupTier', () => {
    it('maps level bands to blocked / throttled / ready', () => {
        expect(deriveWarmupTier(0)).toBe('blocked')
        expect(deriveWarmupTier(24)).toBe('blocked')
        expect(deriveWarmupTier(25)).toBe('throttled')
        expect(deriveWarmupTier(35)).toBe('throttled')
        expect(deriveWarmupTier(54)).toBe('throttled')
        expect(deriveWarmupTier(55)).toBe('ready')
        expect(deriveWarmupTier(100)).toBe('ready')
    })
})

describe('isWarmupCooldownActive', () => {
    it('returns true only for valid future nextWarmupAt', () => {
        const now = new Date('2026-06-01T12:00:00.000Z')
        expect(isWarmupCooldownActive('2026-06-01T13:00:00.000Z', now)).toBe(true)
        expect(isWarmupCooldownActive('2026-06-01T11:00:00.000Z', now)).toBe(false)
        expect(isWarmupCooldownActive(null, now)).toBe(false)
        expect(isWarmupCooldownActive('not-a-date', now)).toBe(false)
    })
})

describe('mapWarmupErrorMessage', () => {
    it('maps known codes and backend message heuristics to friendly text', () => {
        expect(extractWarmupErrorCode('cooldown_active')).toBe('cooldown_active')
        expect(extractWarmupErrorCode('not_logged_in')).toBe('not_authenticated')
        expect(extractWarmupErrorCode('daily_cap_reached')).toBe('daily_cap_reached')
        expect(extractWarmupErrorCode('already_running')).toBe('already_running')
        expect(extractWarmupErrorCode('not_authenticated')).toBe('not_authenticated')

        expect(mapWarmupErrorMessage('cooldown_active', t)).toMatch(/cooldown/i)
        expect(mapWarmupErrorMessage('daily_cap_reached', t)).toMatch(/Daily warmup cap/i)
        expect(mapWarmupErrorMessage('already_running', t)).toMatch(/already running/i)
        expect(mapWarmupErrorMessage('not_authenticated', t)).toMatch(/not logged in/i)
        expect(
            mapWarmupErrorMessage(
                'Warmup cooldown active until 2026-06-02T10:00:00.000Z. Wait until nextWarmupAt',
                t,
            ),
        ).toMatch(/cooldown/i)
        expect(mapWarmupErrorMessage('unknown failure', t)).toBe('unknown failure')
    })
})
