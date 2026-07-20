/**
 * Scheduler IPC contracts — runtime Zod schemas for untrusted renderer payloads.
 * Handlers coerce date/string → Date, reject unknown keys / Invalid Date, and
 * enforce endDate >= scheduledAt when both are present in the payload.
 */

import { z } from 'zod'
import { idSchema } from './ipc-schemas'

// ---------------------------------------------------------------------------
// Domain constants / types
// ---------------------------------------------------------------------------

export const SCHEDULE_REPEAT_TYPES = ['once', 'daily', 'weekly', 'custom'] as const

export type ScheduleRepeatType = (typeof SCHEDULE_REPEAT_TYPES)[number]

/** Weekday index matching JS Date.getDay(): 0 = Sunday … 6 = Saturday. */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Max unique weekdays (Sun–Sat). */
export const SCHEDULE_REPEAT_DAYS_MAX = 7

/** Weekday lower/upper bounds (inclusive). */
export const SCHEDULE_WEEKDAY_MIN = 0
export const SCHEDULE_WEEKDAY_MAX = 6

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Positive schedule row id (delete / toggle / update). */
export const scheduleIdSchema = idSchema

/** Positive campaign id (create / getForCampaign). */
export const scheduleCampaignIdSchema = idSchema

export const scheduleRepeatTypeSchema = z.enum(SCHEDULE_REPEAT_TYPES)

/**
 * Coerce Date | ISO/date string | epoch ms → valid Date.
 * Rejects Invalid Date, empty strings, and non-date types.
 */
export const scheduleDateSchema = z
    .union([z.date(), z.string().min(1), z.number().finite()])
    .transform((value, ctx): Date => {
        const date = value instanceof Date ? value : new Date(value)
        if (Number.isNaN(date.getTime())) {
            ctx.addIssue({
                code: 'custom',
                message: 'Invalid Date',
            })
            return z.NEVER
        }
        return date
    })

/** Single weekday index 0..6. */
export const scheduleWeekdaySchema = z
    .number()
    .int()
    .min(SCHEDULE_WEEKDAY_MIN)
    .max(SCHEDULE_WEEKDAY_MAX)

/**
 * Unique weekday list, max 7 entries, each 0..6.
 * Empty array is allowed (service / UI decide custom-repeat rules).
 */
export const scheduleRepeatDaysSchema = z
    .array(scheduleWeekdaySchema)
    .max(SCHEDULE_REPEAT_DAYS_MAX)
    .refine((days) => new Set(days).size === days.length, {
        message: 'repeatDays must be unique',
    })

function assertEndOnOrAfterScheduled(
    scheduledAt: Date | undefined,
    endDate: Date | null | undefined,
    ctx: z.RefinementCtx,
): void {
    if (scheduledAt === undefined || endDate === undefined || endDate === null) {
        return
    }
    if (endDate.getTime() < scheduledAt.getTime()) {
        ctx.addIssue({
            code: 'custom',
            message: 'endDate must be >= scheduledAt',
            path: ['endDate'],
        })
    }
}

// ---------------------------------------------------------------------------
// Create / update payloads (strict — reject unknown keys)
// ---------------------------------------------------------------------------

/**
 * scheduler:create payload.
 * scheduledAt required; endDate optional; isActive required boolean.
 */
export const scheduleCreateSchema = z
    .object({
        campaignId: scheduleCampaignIdSchema,
        scheduledAt: scheduleDateSchema,
        repeatType: scheduleRepeatTypeSchema,
        repeatDays: scheduleRepeatDaysSchema.optional(),
        endDate: scheduleDateSchema.optional(),
        isActive: z.boolean(),
    })
    .strict()
    .superRefine((data, ctx) => {
        assertEndOnOrAfterScheduled(data.scheduledAt, data.endDate, ctx)
    })

/**
 * scheduler:update partial payload.
 * endDate may be null to clear; when both scheduledAt and endDate are present
 * and non-null, endDate must be >= scheduledAt.
 */
export const scheduleUpdateSchema = z
    .object({
        scheduledAt: scheduleDateSchema.optional(),
        repeatType: scheduleRepeatTypeSchema.optional(),
        repeatDays: scheduleRepeatDaysSchema.optional(),
        endDate: z.union([scheduleDateSchema, z.null()]).optional(),
        isActive: z.boolean().optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        assertEndOnOrAfterScheduled(data.scheduledAt, data.endDate, ctx)
    })

// ---------------------------------------------------------------------------
// Arg tuples / single-arg channels
// ---------------------------------------------------------------------------

/** scheduler:update(id, config) */
export const scheduleUpdateArgsSchema = z.tuple([scheduleIdSchema, scheduleUpdateSchema])

/** scheduler:delete(id) — single positive id */
export const scheduleDeleteArgsSchema = z.tuple([scheduleIdSchema])

/** scheduler:toggle(id) */
export const scheduleToggleArgsSchema = z.tuple([scheduleIdSchema])

/** scheduler:getForCampaign(campaignId) */
export const scheduleGetForCampaignArgsSchema = z.tuple([scheduleCampaignIdSchema])

// ---------------------------------------------------------------------------
// Inferred output types (post-transform, for handlers)
// ---------------------------------------------------------------------------

export type ScheduleCreateInput = z.output<typeof scheduleCreateSchema>
export type ScheduleUpdateInput = z.output<typeof scheduleUpdateSchema>
export type ScheduleUpdateArgs = z.output<typeof scheduleUpdateArgsSchema>
