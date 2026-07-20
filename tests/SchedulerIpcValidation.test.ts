/**
 * Scheduler IPC boundary — Zod schema unit tests.
 * Pure contracts only (no Electron / DB). Handlers use these via withIpcValidation.
 */
import { describe, expect, it } from 'vitest'
import {
    SCHEDULE_REPEAT_DAYS_MAX,
    scheduleCampaignIdSchema,
    scheduleCreateSchema,
    scheduleDateSchema,
    scheduleDeleteArgsSchema,
    scheduleGetForCampaignArgsSchema,
    scheduleIdSchema,
    scheduleRepeatDaysSchema,
    scheduleRepeatTypeSchema,
    scheduleToggleArgsSchema,
    scheduleUpdateArgsSchema,
    scheduleUpdateSchema,
} from '../src/shared/scheduler-contracts'

function expectOk<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    input: unknown,
): T {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
    return result.data as T
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
}

const validCreate = {
    campaignId: 1,
    scheduledAt: '2026-07-14T10:00:00.000Z',
    repeatType: 'once' as const,
    isActive: true,
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

describe('scheduleIdSchema / scheduleCampaignIdSchema', () => {
    it('accepts positive integers', () => {
        expectOk(scheduleIdSchema, 1)
        expectOk(scheduleIdSchema, 99)
        expectOk(scheduleCampaignIdSchema, 1)
        expectOk(scheduleCampaignIdSchema, 42)
    })

    it('rejects zero, negative, float, string, null', () => {
        for (const bad of [0, -1, 1.5, NaN, '1', null, undefined, {}, [], true]) {
            expectFail(scheduleIdSchema, bad)
            expectFail(scheduleCampaignIdSchema, bad)
        }
    })
})

// ---------------------------------------------------------------------------
// Date coercion
// ---------------------------------------------------------------------------

describe('scheduleDateSchema', () => {
    it('accepts Date instances and ISO strings', () => {
        const fromDate = expectOk(scheduleDateSchema, new Date('2026-01-15T12:00:00.000Z'))
        expect(fromDate).toBeInstanceOf(Date)
        expect(fromDate.toISOString()).toBe('2026-01-15T12:00:00.000Z')

        const fromIso = expectOk(scheduleDateSchema, '2026-07-14T08:30:00.000Z')
        expect(fromIso).toBeInstanceOf(Date)
        expect(fromIso.toISOString()).toBe('2026-07-14T08:30:00.000Z')
    })

    it('accepts finite epoch milliseconds', () => {
        const ms = Date.UTC(2026, 0, 1, 0, 0, 0)
        const parsed = expectOk(scheduleDateSchema, ms)
        expect(parsed.getTime()).toBe(ms)
    })

    it('rejects Invalid Date, empty string, garbage', () => {
        expectFail(scheduleDateSchema, new Date('not-a-date'))
        expectFail(scheduleDateSchema, 'not-a-date')
        expectFail(scheduleDateSchema, '')
        expectFail(scheduleDateSchema, '   ')
        expectFail(scheduleDateSchema, Infinity)
        expectFail(scheduleDateSchema, null)
        expectFail(scheduleDateSchema, undefined)
        expectFail(scheduleDateSchema, {})
        expectFail(scheduleDateSchema, true)
    })
})

// ---------------------------------------------------------------------------
// repeatType / repeatDays
// ---------------------------------------------------------------------------

describe('scheduleRepeatTypeSchema', () => {
    it('accepts once | daily | weekly | custom', () => {
        for (const t of ['once', 'daily', 'weekly', 'custom'] as const) {
            expectOk(scheduleRepeatTypeSchema, t)
        }
    })

    it('rejects unknown repeat types', () => {
        expectFail(scheduleRepeatTypeSchema, 'monthly')
        expectFail(scheduleRepeatTypeSchema, 'ONCE')
        expectFail(scheduleRepeatTypeSchema, '')
        expectFail(scheduleRepeatTypeSchema, 1)
    })
})

describe('scheduleRepeatDaysSchema', () => {
    it('accepts unique weekdays 0..6', () => {
        expectOk(scheduleRepeatDaysSchema, [])
        expectOk(scheduleRepeatDaysSchema, [0])
        expectOk(scheduleRepeatDaysSchema, [1, 2, 3, 4, 5])
        expectOk(scheduleRepeatDaysSchema, [0, 1, 2, 3, 4, 5, 6])
    })

    it('rejects out-of-range, duplicates, oversized, non-int', () => {
        expectFail(scheduleRepeatDaysSchema, [-1])
        expectFail(scheduleRepeatDaysSchema, [7])
        expectFail(scheduleRepeatDaysSchema, [1.5])
        expectFail(scheduleRepeatDaysSchema, [1, 1])
        expectFail(scheduleRepeatDaysSchema, [0, 1, 2, 3, 4, 5, 6, 0])
        expectFail(scheduleRepeatDaysSchema, Array.from({ length: SCHEDULE_REPEAT_DAYS_MAX + 1 }, (_, i) => i % 7))
        expectFail(scheduleRepeatDaysSchema, '1')
        expectFail(scheduleRepeatDaysSchema, null)
    })
})

// ---------------------------------------------------------------------------
// Create schema
// ---------------------------------------------------------------------------

describe('scheduleCreateSchema', () => {
    it('accepts minimal valid create payload (string dates coerced)', () => {
        const data = expectOk(scheduleCreateSchema, validCreate)
        expect(data.campaignId).toBe(1)
        expect(data.scheduledAt).toBeInstanceOf(Date)
        expect(data.repeatType).toBe('once')
        expect(data.isActive).toBe(true)
        expect(data.endDate).toBeUndefined()
        expect(data.repeatDays).toBeUndefined()
    })

    it('accepts full payload with endDate >= scheduledAt and repeatDays', () => {
        const data = expectOk(scheduleCreateSchema, {
            campaignId: 5,
            scheduledAt: '2026-07-14T10:00:00.000Z',
            endDate: '2026-08-14T10:00:00.000Z',
            repeatType: 'custom',
            repeatDays: [0, 2, 4],
            isActive: false,
        })
        expect(data.endDate).toBeInstanceOf(Date)
        expect(data.endDate!.getTime()).toBeGreaterThan(data.scheduledAt.getTime())
        expect(data.repeatDays).toEqual([0, 2, 4])
        expect(data.isActive).toBe(false)
    })

    it('accepts endDate equal to scheduledAt', () => {
        const iso = '2026-07-14T10:00:00.000Z'
        expectOk(scheduleCreateSchema, {
            ...validCreate,
            scheduledAt: iso,
            endDate: iso,
        })
    })

    it('rejects endDate before scheduledAt', () => {
        expectFail(scheduleCreateSchema, {
            ...validCreate,
            scheduledAt: '2026-07-14T10:00:00.000Z',
            endDate: '2026-07-13T10:00:00.000Z',
        })
    })

    it('rejects missing required fields', () => {
        expectFail(scheduleCreateSchema, {})
        expectFail(scheduleCreateSchema, { campaignId: 1 })
        expectFail(scheduleCreateSchema, {
            campaignId: 1,
            scheduledAt: '2026-07-14T10:00:00.000Z',
            repeatType: 'once',
        })
        expectFail(scheduleCreateSchema, {
            scheduledAt: '2026-07-14T10:00:00.000Z',
            repeatType: 'once',
            isActive: true,
        })
    })

    it('rejects non-positive campaignId, bad isActive, Invalid Date', () => {
        expectFail(scheduleCreateSchema, { ...validCreate, campaignId: 0 })
        expectFail(scheduleCreateSchema, { ...validCreate, campaignId: -1 })
        expectFail(scheduleCreateSchema, { ...validCreate, isActive: 'true' })
        expectFail(scheduleCreateSchema, { ...validCreate, isActive: 1 })
        expectFail(scheduleCreateSchema, { ...validCreate, scheduledAt: 'not-a-date' })
        expectFail(scheduleCreateSchema, { ...validCreate, endDate: 'garbage' })
    })

    it('rejects unknown keys (strict)', () => {
        expectFail(scheduleCreateSchema, { ...validCreate, inject: true })
        expectFail(scheduleCreateSchema, { ...validCreate, campaign_id: 1 })
        expectFail(scheduleCreateSchema, { ...validCreate, id: 9 })
    })
})

// ---------------------------------------------------------------------------
// Update schema
// ---------------------------------------------------------------------------

describe('scheduleUpdateSchema', () => {
    it('accepts empty partial (no-op update)', () => {
        expectOk(scheduleUpdateSchema, {})
    })

    it('accepts partial fields with date coercion', () => {
        const data = expectOk(scheduleUpdateSchema, {
            scheduledAt: '2026-07-20T00:00:00.000Z',
            isActive: false,
            repeatType: 'weekly',
        })
        expect(data.scheduledAt).toBeInstanceOf(Date)
        expect(data.isActive).toBe(false)
        expect(data.repeatType).toBe('weekly')
    })

    it('accepts endDate null (clear)', () => {
        const data = expectOk(scheduleUpdateSchema, { endDate: null })
        expect(data.endDate).toBeNull()
    })

    it('rejects endDate < scheduledAt when both present', () => {
        expectFail(scheduleUpdateSchema, {
            scheduledAt: '2026-07-14T10:00:00.000Z',
            endDate: '2026-07-01T00:00:00.000Z',
        })
    })

    it('allows endDate alone without scheduledAt (boundary cannot compare store)', () => {
        expectOk(scheduleUpdateSchema, { endDate: '2026-07-01T00:00:00.000Z' })
    })

    it('rejects unknown keys and Invalid Date', () => {
        expectFail(scheduleUpdateSchema, { inject: true })
        expectFail(scheduleUpdateSchema, { campaignId: 1 })
        expectFail(scheduleUpdateSchema, { scheduledAt: 'nope' })
        expectFail(scheduleUpdateSchema, { repeatDays: [1, 1] })
        expectFail(scheduleUpdateSchema, { isActive: 'yes' })
    })
})

// ---------------------------------------------------------------------------
// Arg tuples / id channels
// ---------------------------------------------------------------------------

describe('schedule arg tuples', () => {
    it('update requires positive id + strict config', () => {
        expectOk(scheduleUpdateArgsSchema, [1, { isActive: true }])
        expectOk(scheduleUpdateArgsSchema, [3, {}])
        expectFail(scheduleUpdateArgsSchema, [0, {}])
        expectFail(scheduleUpdateArgsSchema, [-1, { isActive: true }])
        expectFail(scheduleUpdateArgsSchema, [1, { inject: true }])
        expectFail(scheduleUpdateArgsSchema, [1])
        expectFail(scheduleUpdateArgsSchema, ['1', {}])
    })

    it('delete / toggle require positive id only', () => {
        expectOk(scheduleDeleteArgsSchema, [1])
        expectOk(scheduleToggleArgsSchema, [99])
        expectFail(scheduleDeleteArgsSchema, [0])
        expectFail(scheduleToggleArgsSchema, [-1])
        expectFail(scheduleDeleteArgsSchema, [1.5])
        expectFail(scheduleToggleArgsSchema, ['1'])
        expectFail(scheduleDeleteArgsSchema, [])
        expectFail(scheduleToggleArgsSchema, [1, true])
    })

    it('getForCampaign requires positive campaignId', () => {
        expectOk(scheduleGetForCampaignArgsSchema, [1])
        expectOk(scheduleGetForCampaignArgsSchema, [42])
        expectFail(scheduleGetForCampaignArgsSchema, [0])
        expectFail(scheduleGetForCampaignArgsSchema, [-5])
        expectFail(scheduleGetForCampaignArgsSchema, ['1'])
        expectFail(scheduleGetForCampaignArgsSchema, [1, 2])
    })
})
