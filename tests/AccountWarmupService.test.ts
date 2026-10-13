import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        accounts: { id: 'accounts.id' },
    },
}))

vi.mock('drizzle-orm', () => ({
    eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
}))

import { getDatabase } from '../src/main/database'
import {
    AccountWarmupService,
    MAX_DAILY_WARMUP_SESSIONS,
    countWarmupSessionsOnLocalDate,
    evaluateStartEligibility,
    localDateKey,
    type WarmupActivity,
    type WarmupData,
} from '../src/main/services/AccountWarmupService'

function sessionActivity(
    type: WarmupActivity['type'],
    timestamp: string,
): WarmupActivity {
    return { type, timestamp, durationSec: 60, detail: 'test' }
}

function baseData(overrides: Partial<WarmupData> = {}): Pick<WarmupData, 'nextWarmupAt' | 'history'> {
    return {
        nextWarmupAt: null,
        history: [],
        ...overrides,
    }
}

describe('localDateKey', () => {
    it('formats local calendar date as YYYY-MM-DD', () => {
        const d = new Date(2026, 6, 14, 23, 30, 0) // July 14 2026 local
        expect(localDateKey(d)).toBe('2026-07-14')
    })

    it('uses machine local date boundaries (not UTC shift of the key format)', () => {
        const noon = new Date(2026, 0, 5, 12, 0, 0)
        expect(localDateKey(noon)).toBe('2026-01-05')
    })
})

describe('countWarmupSessionsOnLocalDate', () => {
    it('counts only session-type activities on the given local day', () => {
        const day = localDateKey(new Date(2026, 5, 1, 10, 0, 0))
        const history: WarmupActivity[] = [
            sessionActivity('google_search', new Date(2026, 5, 1, 9, 0, 0).toISOString()),
            sessionActivity('maps_browse', new Date(2026, 5, 1, 15, 0, 0).toISOString()),
            sessionActivity('youtube_browse', new Date(2026, 5, 1, 20, 0, 0).toISOString()),
            sessionActivity('other', new Date(2026, 5, 1, 11, 0, 0).toISOString()), // not a session type
            sessionActivity('google_search', new Date(2026, 5, 2, 9, 0, 0).toISOString()), // other day
        ]
        expect(countWarmupSessionsOnLocalDate(history, day)).toBe(3)
    })

    it('ignores invalid timestamps', () => {
        const day = localDateKey(new Date())
        const history: WarmupActivity[] = [
            sessionActivity('google_search', 'not-a-date'),
            sessionActivity('maps_browse', new Date().toISOString()),
        ]
        expect(countWarmupSessionsOnLocalDate(history, day)).toBe(1)
    })
})

describe('evaluateStartEligibility — cooldown (nextWarmupAt)', () => {
    it('allows start when nextWarmupAt is null', () => {
        expect(evaluateStartEligibility(baseData(), new Date('2026-07-14T12:00:00.000Z'))).toEqual({
            allowed: true,
        })
    })

    it('allows start when nextWarmupAt is in the past', () => {
        const now = new Date('2026-07-14T12:00:00.000Z')
        const result = evaluateStartEligibility(
            baseData({ nextWarmupAt: new Date('2026-07-14T11:00:00.000Z') }),
            now,
        )
        expect(result.allowed).toBe(true)
    })

    it('blocks start when nextWarmupAt is in the future with cooldown_active', () => {
        const now = new Date('2026-07-14T12:00:00.000Z')
        const next = new Date('2026-07-14T18:00:00.000Z')
        const result = evaluateStartEligibility(baseData({ nextWarmupAt: next }), now)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
            expect(result.code).toBe('cooldown_active')
            expect(result.message).toContain(next.toISOString())
            expect(result.message.toLowerCase()).toMatch(/cooldown/)
        }
    })
})

describe('evaluateStartEligibility — daily local-date cap', () => {
    it(`allows start when today has fewer than ${MAX_DAILY_WARMUP_SESSIONS} sessions`, () => {
        const now = new Date(2026, 6, 14, 12, 0, 0)
        const history: WarmupActivity[] = []
        for (let i = 0; i < MAX_DAILY_WARMUP_SESSIONS - 1; i++) {
            history.push(
                sessionActivity(
                    'google_search',
                    new Date(2026, 6, 14, 8 + i, 0, 0).toISOString(),
                ),
            )
        }
        const result = evaluateStartEligibility(baseData({ history }), now)
        expect(result.allowed).toBe(true)
    })

    it(`blocks start at ${MAX_DAILY_WARMUP_SESSIONS} sessions with daily_cap_reached`, () => {
        const now = new Date(2026, 6, 14, 20, 0, 0)
        const history: WarmupActivity[] = []
        for (let i = 0; i < MAX_DAILY_WARMUP_SESSIONS; i++) {
            history.push(
                sessionActivity(
                    'maps_browse',
                    new Date(2026, 6, 14, 8 + i, 0, 0).toISOString(),
                ),
            )
        }
        const result = evaluateStartEligibility(baseData({ history }), now)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
            expect(result.code).toBe('daily_cap_reached')
            expect(result.message).toMatch(/Daily warmup cap/)
            expect(result.message).toContain(`${MAX_DAILY_WARMUP_SESSIONS}/${MAX_DAILY_WARMUP_SESSIONS}`)
            expect(result.message).toContain(localDateKey(now))
        }
    })

    it('does not count sessions from a different local day toward the cap', () => {
        const now = new Date(2026, 6, 15, 10, 0, 0)
        const history: WarmupActivity[] = []
        for (let i = 0; i < MAX_DAILY_WARMUP_SESSIONS; i++) {
            history.push(
                sessionActivity(
                    'youtube_browse',
                    new Date(2026, 6, 14, 9 + i, 0, 0).toISOString(),
                ),
            )
        }
        const result = evaluateStartEligibility(baseData({ history }), now)
        expect(result.allowed).toBe(true)
    })

    it('prefers cooldown error when both cooldown and daily cap would fail', () => {
        const now = new Date(2026, 6, 14, 12, 0, 0)
        const history: WarmupActivity[] = []
        for (let i = 0; i < MAX_DAILY_WARMUP_SESSIONS; i++) {
            history.push(
                sessionActivity(
                    'google_search',
                    new Date(2026, 6, 14, 8 + i, 0, 0).toISOString(),
                ),
            )
        }
        const result = evaluateStartEligibility(
            baseData({
                history,
                nextWarmupAt: new Date(2026, 6, 14, 18, 0, 0),
            }),
            now,
        )
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
            expect(result.code).toBe('cooldown_active')
        }
    })
})

// ─── completeSession commit guard (cancel race before DB credit) ───────────

interface AccountRow {
    id: number
    warmupLevel: number
    reputationScore: number
    warmupSessions: number
    warmupHistory: string | null
    lastWarmupAt: Date | null
    nextWarmupAt: Date | null
    firstReviewDate?: Date | null
    lastReviewDate?: Date | null
}

function baseAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
    return {
        id: 1,
        warmupLevel: 10,
        reputationScore: 30,
        warmupSessions: 2,
        warmupHistory: null,
        lastWarmupAt: null,
        nextWarmupAt: null,
        ...overrides,
    }
}

function createAccountDbMock(account: AccountRow) {
    let updateCount = 0
    let lastPatch: Record<string, unknown> | null = null

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    get: () => account,
                }),
                get: () => account,
                all: () => [account],
            }),
        }),
        update: () => ({
            set: (patch: Record<string, unknown>) => ({
                where: () => ({
                    run: () => {
                        updateCount += 1
                        lastPatch = patch
                        if (typeof patch.warmupLevel === 'number') {
                            account.warmupLevel = patch.warmupLevel
                        }
                        if (typeof patch.reputationScore === 'number') {
                            account.reputationScore = patch.reputationScore
                        }
                        if (typeof patch.warmupSessions === 'number') {
                            account.warmupSessions = patch.warmupSessions
                        }
                        if (typeof patch.warmupHistory === 'string') {
                            account.warmupHistory = patch.warmupHistory
                        }
                        if (patch.lastWarmupAt instanceof Date) {
                            account.lastWarmupAt = patch.lastWarmupAt
                        }
                        if (patch.nextWarmupAt instanceof Date) {
                            account.nextWarmupAt = patch.nextWarmupAt
                        }
                    },
                }),
            }),
        }),
    }

    return {
        db,
        get updateCount() {
            return updateCount
        },
        get lastPatch() {
            return lastPatch
        },
    }
}

describe('AccountWarmupService.completeSession — commit guard', () => {
    beforeEach(() => {
        vi.mocked(getDatabase).mockReset()
    })

    it('credits when shouldCommit is omitted (BC) and daily cap allows', async () => {
        const row = baseAccountRow()
        const mock = createAccountDbMock(row)
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        const service = new AccountWarmupService()
        const beforeLevel = row.warmupLevel
        const beforeSessions = row.warmupSessions

        const result = await service.completeSession(1, 'google_search', 90, 'bc_test')

        expect(mock.updateCount).toBe(1)
        expect(result.warmupSessions).toBe(beforeSessions + 1)
        expect(result.warmupLevel).toBeGreaterThan(beforeLevel)
        expect(result.history).toHaveLength(1)
        expect(result.history[0]?.type).toBe('google_search')
    })

    it('accepts bare Date as 5th arg (legacy now BC)', async () => {
        const row = baseAccountRow()
        const mock = createAccountDbMock(row)
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        const service = new AccountWarmupService()
        const now = new Date(2026, 6, 14, 12, 0, 0)
        await service.completeSession(1, 'maps_browse', 60, 'legacy_now', now)

        expect(mock.updateCount).toBe(1)
        expect(mock.lastPatch?.lastWarmupAt).toEqual(now)
    })

    it('refuses credit when shouldCommit returns false before load', async () => {
        const row = baseAccountRow({ warmupLevel: 20, warmupSessions: 5 })
        const mock = createAccountDbMock(row)
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        const service = new AccountWarmupService()
        const result = await service.completeSession(1, 'youtube_browse', 45, 'pre', {
            shouldCommit: () => false,
        })

        expect(mock.updateCount).toBe(0)
        expect(result.warmupLevel).toBe(20)
        expect(result.warmupSessions).toBe(5)
        expect(result.history).toEqual([])
    })

    it('race: cancel while service awaits getWarmupData → no history/session/level update', async () => {
        const row = baseAccountRow({
            warmupLevel: 12,
            reputationScore: 40,
            warmupSessions: 3,
            warmupHistory: null,
        })
        const mock = createAccountDbMock(row)
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        const service = new AccountWarmupService()
        const baseline: WarmupData = {
            warmupLevel: 12,
            reputationScore: 40,
            warmupSessions: 3,
            lastWarmupAt: null,
            nextWarmupAt: null,
            history: [],
        }

        let resolveLoad!: (data: WarmupData) => void
        const deferredLoad = new Promise<WarmupData>((resolve) => {
            resolveLoad = resolve
        })
        const spy = vi.spyOn(service, 'getWarmupData').mockReturnValueOnce(deferredLoad)

        let live = true
        const completePromise = service.completeSession(
            1,
            'google_search',
            75,
            'race_deferred',
            { shouldCommit: () => live },
        )

        // Cancel lands while completeSession is suspended on getWarmupData.
        live = false
        resolveLoad(baseline)

        const result = await completePromise

        expect(mock.updateCount).toBe(0)
        expect(result.warmupLevel).toBe(12)
        expect(result.reputationScore).toBe(40)
        expect(result.warmupSessions).toBe(3)
        expect(result.history).toEqual([])
        expect(row.warmupLevel).toBe(12)
        expect(row.warmupSessions).toBe(3)
        expect(row.warmupHistory).toBeNull()

        spy.mockRestore()
    })

    it('credits when shouldCommit stays true through commit', async () => {
        const row = baseAccountRow({ warmupLevel: 8, warmupSessions: 1 })
        const mock = createAccountDbMock(row)
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        const service = new AccountWarmupService()
        const result = await service.completeSession(1, 'maps_browse', 80, 'ok', {
            shouldCommit: () => true,
        })

        expect(mock.updateCount).toBe(1)
        expect(result.warmupSessions).toBe(2)
        expect(result.history).toHaveLength(1)
        expect(result.warmupLevel).toBeGreaterThan(8)
    })

    it('still enforces daily cap with shouldCommit present', async () => {
        const now = new Date(2026, 6, 14, 20, 0, 0)
        const history: WarmupActivity[] = []
        for (let i = 0; i < MAX_DAILY_WARMUP_SESSIONS; i++) {
            history.push(
                sessionActivity(
                    'google_search',
                    new Date(2026, 6, 14, 8 + i, 0, 0).toISOString(),
                ),
            )
        }
        const row = baseAccountRow({
            warmupLevel: 50,
            warmupSessions: MAX_DAILY_WARMUP_SESSIONS,
            warmupHistory: JSON.stringify(history),
        })
        const mock = createAccountDbMock(row)
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        const service = new AccountWarmupService()
        const result = await service.completeSession(1, 'youtube_browse', 50, 'cap', {
            now,
            shouldCommit: () => true,
        })

        expect(mock.updateCount).toBe(0)
        expect(result.warmupSessions).toBe(MAX_DAILY_WARMUP_SESSIONS)
        expect(result.history).toHaveLength(MAX_DAILY_WARMUP_SESSIONS)
    })
})
