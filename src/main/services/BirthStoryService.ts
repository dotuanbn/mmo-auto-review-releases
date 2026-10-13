/**
 * BirthStoryService — 7-day new-account warmup ramp.
 *
 * Day is calendar-based from birthStoryStartDate (local date, day 1 = start date).
 * applyPlan(accountId) returns that day's WarmupActivityType, or null when the
 * story is completed / account is missing. warmupLevel >= 55 marks completed.
 */

import { eq } from 'drizzle-orm'
import type { Account } from '../database/schema'
import type { WarmupActivityInput } from '../../shared/warmup-contracts'
import { getDatabase, schema } from '../database'
import { localDateKey } from './AccountWarmupService'

/** Activity type queued into AccountWarmupEngine.start (WarmupActivityType input). */
export type BirthStoryActivityType = Extract<
    WarmupActivityInput,
    'search' | 'maps' | 'youtube' | 'gmail' | 'photos_browse'
>

export interface BirthStoryDayPlan {
    day: number
    activity: BirthStoryActivityType
    durationSeconds: number
}

/** Review-ready gate; birth story ends once the account reaches this level. */
export const BIRTH_STORY_COMPLETE_LEVEL = 55
export const BIRTH_STORY_MAX_DAY = 7

const MS_PER_DAY = 86_400_000

/**
 * Gradual 7-day identity ramp. Durations stay inside the engine clamp (45–300s)
 * and meet the day-1 minimum of 180s.
 */
const BIRTH_STORY_PLANS: Record<number, BirthStoryDayPlan> = {
    1: { day: 1, activity: 'search', durationSeconds: 180 },
    2: { day: 2, activity: 'youtube', durationSeconds: 210 },
    3: { day: 3, activity: 'maps', durationSeconds: 210 },
    4: { day: 4, activity: 'photos_browse', durationSeconds: 240 },
    5: { day: 5, activity: 'gmail', durationSeconds: 240 },
    6: { day: 6, activity: 'maps', durationSeconds: 270 },
    7: { day: 7, activity: 'gmail', durationSeconds: 300 },
}

function asDate(value: Date | number | string | null | undefined): Date | null {
    if (value == null) return null
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value
    }
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** Inclusive local-calendar day index: start date = day 1. */
export function computeBirthStoryDay(start: Date, now: Date = new Date()): number {
    const startParts = localDateKey(start).split('-').map(Number)
    const nowParts = localDateKey(now).split('-').map(Number)
    const startLocal = new Date(startParts[0], startParts[1] - 1, startParts[2])
    const nowLocal = new Date(nowParts[0], nowParts[1] - 1, nowParts[2])
    const diff = Math.round((nowLocal.getTime() - startLocal.getTime()) / MS_PER_DAY)
    return Math.max(1, diff + 1)
}

export class BirthStoryService {
    getPlanForDay(day: number): BirthStoryDayPlan | null {
        if (!Number.isInteger(day) || day < 1 || day > BIRTH_STORY_MAX_DAY) {
            return null
        }
        return BIRTH_STORY_PLANS[day] ?? null
    }

    /** Duration for a birth-story activity (latest matching day wins). */
    durationSecondsFor(activity: BirthStoryActivityType): number {
        for (let day = BIRTH_STORY_MAX_DAY; day >= 1; day -= 1) {
            const plan = BIRTH_STORY_PLANS[day]
            if (plan?.activity === activity) return plan.durationSeconds
        }
        return 180
    }

    /**
     * Compute the current birth-story day and return that day's activity type.
     * Side effects: initializes start date, persists day, marks completed when
     * warmupLevel >= 55 or the 7-day window has elapsed.
     */
    async applyPlan(accountId: number, now: Date = new Date()): Promise<BirthStoryActivityType | null> {
        try {
            const acc = this.loadAccount(accountId)
            if (!acc) return null
            if (acc.birthStoryCompleted) return null

            if ((acc.warmupLevel ?? 0) >= BIRTH_STORY_COMPLETE_LEVEL) {
                this.patchAccount(accountId, { birthStoryCompleted: true })
                return null
            }

            const start = asDate(acc.birthStoryStartDate)
            if (!start) {
                this.patchAccount(accountId, {
                    birthStoryStartDate: now,
                    birthStoryDay: 1,
                    birthStoryCompleted: false,
                })
                return this.getPlanForDay(1)?.activity ?? null
            }

            const day = computeBirthStoryDay(start, now)
            if (day > BIRTH_STORY_MAX_DAY) {
                this.patchAccount(accountId, {
                    birthStoryDay: BIRTH_STORY_MAX_DAY,
                    birthStoryCompleted: true,
                })
                return null
            }

            if (acc.birthStoryDay !== day) {
                this.patchAccount(accountId, { birthStoryDay: day })
            }

            return this.getPlanForDay(day)?.activity ?? null
        } catch (error: unknown) {
            console.error(`[BirthStory] applyPlan failed account=${accountId}: ${errorMessage(error)}`)
            return null
        }
    }

    /**
     * Persist a birth-story day. When `day` is omitted, increments the stored day.
     * Day >= 7 marks the story completed (session-based progress used by tests).
     */
    async progressBirthStory(accountId: number, day?: number): Promise<void> {
        try {
            if (typeof day === 'number' && Number.isFinite(day)) {
                const nextDay = Math.max(0, Math.floor(day))
                const completed = nextDay >= BIRTH_STORY_MAX_DAY
                this.patchAccount(accountId, {
                    birthStoryDay: Math.min(BIRTH_STORY_MAX_DAY, nextDay),
                    birthStoryCompleted: completed,
                })
                return
            }

            const acc = this.loadAccount(accountId)
            if (!acc || acc.birthStoryCompleted) return

            if ((acc.warmupLevel ?? 0) >= BIRTH_STORY_COMPLETE_LEVEL) {
                this.patchAccount(accountId, { birthStoryCompleted: true })
                return
            }

            const currentDay = acc.birthStoryDay || 0
            if (currentDay === 0) {
                this.patchAccount(accountId, {
                    birthStoryDay: 1,
                    birthStoryStartDate: new Date(),
                })
                return
            }

            const nextDay = currentDay + 1
            if (nextDay >= BIRTH_STORY_MAX_DAY) {
                this.patchAccount(accountId, {
                    birthStoryDay: BIRTH_STORY_MAX_DAY,
                    birthStoryCompleted: true,
                })
            } else {
                this.patchAccount(accountId, {
                    birthStoryDay: nextDay,
                    birthStoryCompleted: false,
                })
            }
        } catch (error: unknown) {
            console.error(
                `[BirthStory] progressBirthStory failed account=${accountId}: ${errorMessage(error)}`,
            )
        }
    }

    private loadAccount(accountId: number): Account | undefined {
        const db = getDatabase()
        return db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()
    }

    private patchAccount(
        accountId: number,
        patch: Partial<
            Pick<Account, 'birthStoryDay' | 'birthStoryStartDate' | 'birthStoryCompleted'>
        >,
    ): void {
        const db = getDatabase()
        db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, accountId)).run()
    }
}

export const birthStoryService = new BirthStoryService()
