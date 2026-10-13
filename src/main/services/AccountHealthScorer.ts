/**
 * Account health for smart rotation.
 *
 * Scoring is a pure function. The class only loads account and review_history
 * rows, then delegates. Blocked accounts (score < 20) drop out of the sort.
 * A resting account can still have a high score; pickBestAccount skips those.
 */

import { and, eq, gte, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import * as schema from '../database/schema'

const MS_PER_DAY = 86_400_000
const RECENT_WINDOW_DAYS = 7
/** Unix ms below this are treated as seconds (drizzle integer timestamp mode). */
const SECONDS_THRESHOLD_MS = 1e12

const SCORE_MIN = 0
const SCORE_MAX = 100
const BASE_SCORE = 50
const WARMUP_POINT_CAP = 30
const AGE_POINT_CAP = 10
const REVIEW_POINT_CAP = 10
const SURVIVAL_POINT_CAP = 20
const FAILURE_PENALTY_CAP = 20
const BIRTH_STORY_BONUS = 5
const OVERUSE_TIER_SUCCESS = 5
const OVERUSE_HEAVY_SUCCESS = 8
const OVERUSE_TIER_PENALTY = 10
const OVERUSE_HEAVY_PENALTY = 20
const BLOCKED_SCORE = 20

export interface AccountHealthInput {
    accountId: number
    /** 0–100 */
    warmupLevel: number
    totalReviews: number
    daysSinceCreation: number
    /** Successful reviews in the last 7 days. */
    recentSuccessCount: number
    /** Failed reviews in the last 7 days. */
    recentFailCount: number
    /** 0–1, live reviews / verified (live + removed). */
    survivalRate: number
    lastReviewDate: Date | null
    birthStoryCompleted: boolean
}

export type AccountHealthGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'blocked'

export interface AccountHealthOutput {
    score: number
    grade: AccountHealthGrade
    shouldRest: boolean
    /** Recommended rest length for this score. Meaningful when shouldRest is true. */
    restDays: number
    reasons: string[]
}

function requireFinite(name: string, value: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`calculateAccountHealth: ${name} must be a finite number`)
    }
    return value
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function formatPoints(value: number): string {
    const rounded = Math.round(value * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function gradeFor(score: number): AccountHealthGrade {
    if (score >= 80) return 'excellent'
    if (score >= 60) return 'good'
    if (score >= 40) return 'fair'
    if (score >= 20) return 'poor'
    return 'blocked'
}

/** 1 day at 60+, 2 at 40+, 3 at 20+, otherwise 5. */
function restDaysFor(score: number): number {
    if (score >= 60) return 1
    if (score >= 40) return 2
    if (score >= 20) return 3
    return 5
}

function hasLastReview(value: Date | null): boolean {
    return value instanceof Date && !Number.isNaN(value.getTime())
}

/**
 * Weighted health score.
 * Overuse is tiered: 5–7 recent successes cost 10 points, 8+ cost 20 (not both).
 * Failure penalty is recentFailCount * 5, capped at 20.
 */
export function calculateAccountHealth(input: AccountHealthInput): AccountHealthOutput {
    if (!Number.isInteger(input.accountId) || input.accountId <= 0) {
        throw new Error(`calculateAccountHealth: invalid accountId (${String(input.accountId)})`)
    }

    const warmupLevel = clamp(requireFinite('warmupLevel', input.warmupLevel), 0, 100)
    const totalReviews = Math.max(0, requireFinite('totalReviews', input.totalReviews))
    const daysSinceCreation = Math.max(0, requireFinite('daysSinceCreation', input.daysSinceCreation))
    const recentSuccessCount = Math.max(0, requireFinite('recentSuccessCount', input.recentSuccessCount))
    const recentFailCount = Math.max(0, requireFinite('recentFailCount', input.recentFailCount))
    const survivalRate = clamp(requireFinite('survivalRate', input.survivalRate), 0, 1)

    const warmupBonus = Math.min(warmupLevel * 0.3, WARMUP_POINT_CAP)
    const ageBonus = Math.min(daysSinceCreation * 0.1, AGE_POINT_CAP)
    const birthStoryBonus = input.birthStoryCompleted === true ? BIRTH_STORY_BONUS : 0
    const reviewBonus = Math.min(totalReviews * 0.5, REVIEW_POINT_CAP)
    const survivalBonus = Math.min(survivalRate * SURVIVAL_POINT_CAP, SURVIVAL_POINT_CAP)
    const failurePenalty = Math.min(recentFailCount * 5, FAILURE_PENALTY_CAP)
    // 8+ replaces the 5+ penalty; the two bands do not stack.
    const overusePenalty = recentSuccessCount >= OVERUSE_HEAVY_SUCCESS
        ? OVERUSE_HEAVY_PENALTY
        : recentSuccessCount >= OVERUSE_TIER_SUCCESS
            ? OVERUSE_TIER_PENALTY
            : 0

    const raw = BASE_SCORE
        + warmupBonus
        + ageBonus
        + birthStoryBonus
        + reviewBonus
        + survivalBonus
        - failurePenalty
        - overusePenalty
    const score = clamp(raw, SCORE_MIN, SCORE_MAX)
    const grade = gradeFor(score)
    const shouldRest = recentSuccessCount >= OVERUSE_TIER_SUCCESS || score < 40
    const restDays = restDaysFor(score)

    const reasons: string[] = []
    if (warmupBonus > 0) reasons.push(`Warmup bonus +${formatPoints(warmupBonus)}`)
    else reasons.push('No warmup bonus')
    if (ageBonus > 0) reasons.push(`Age bonus +${formatPoints(ageBonus)}`)
    else reasons.push('No age bonus')
    if (birthStoryBonus > 0) reasons.push(`Birth story completed +${BIRTH_STORY_BONUS}`)
    if (reviewBonus > 0) reasons.push(`Review history bonus +${formatPoints(reviewBonus)}`)
    if (survivalBonus > 0) reasons.push(`Survival rate bonus +${formatPoints(survivalBonus)}`)
    if (failurePenalty > 0) reasons.push(`Recent failures -${formatPoints(failurePenalty)}`)
    if (overusePenalty > 0) reasons.push(`Recent overuse -${formatPoints(overusePenalty)}`)
    if (hasLastReview(input.lastReviewDate)) reasons.push('Last review date is recorded')
    else reasons.push('No last review date')
    if (shouldRest) reasons.push(`Rest recommended for ${restDays} day(s)`)

    return { score, grade, shouldRest, restDays, reasons }
}

/** Descending score. Blocked accounts (score < 20) are removed. Resting accounts stay. */
export function sortAccountsByHealth(accounts: AccountHealthOutput[]): AccountHealthOutput[] {
    return accounts
        .filter((account) => Number.isFinite(account.score) && account.score >= BLOCKED_SCORE)
        .sort((left, right) => right.score - left.score)
}

function resolveNow(now: Date | undefined): Date {
    if (now == null) return new Date()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('AccountHealthScorer: invalid now date')
    }
    return now
}

function readCount(value: unknown): number {
    const numeric = typeof value === 'bigint' ? Number(value) : typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN
    if (!Number.isFinite(numeric) || numeric <= 0) return 0
    return numeric
}

function readOptionalDate(value: unknown): Date | null {
    if (value == null) return null
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null
        const ms = Math.abs(value) < SECONDS_THRESHOLD_MS ? value * 1000 : value
        const date = new Date(ms)
        return Number.isNaN(date.getTime()) ? null : date
    }
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed === '') return null
        const numeric = Number(trimmed)
        if (Number.isFinite(numeric)) return readOptionalDate(numeric)
        const parsed = new Date(trimmed)
        return Number.isNaN(parsed.getTime()) ? null : parsed
    }
    return null
}

function readRequiredDate(value: unknown, label: string): Date {
    const date = readOptionalDate(value)
    if (!date) {
        throw new Error(`AccountHealthScorer: ${label} is missing or invalid`)
    }
    return date
}

function readFlag(value: unknown): boolean {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'bigint') return value !== BigInt(0)
    return false
}

function daysSince(createdAt: Date, now: Date): number {
    const elapsed = now.getTime() - createdAt.getTime()
    if (!Number.isFinite(elapsed)) return 0
    return Math.max(0, Math.floor(elapsed / MS_PER_DAY))
}

function assertAccountId(accountId: number): void {
    if (!Number.isInteger(accountId) || accountId <= 0) {
        throw new Error(`AccountHealthScorer: invalid accountId (${String(accountId)})`)
    }
}

interface RankedAccount {
    accountId: number
    health: AccountHealthOutput
}

export class AccountHealthScorer {
    /**
     * Load one account, its 7-day success/fail counts, and its survival rate.
     * Survival is live / (live + removed). Pending and unknown rows are not verified.
     * No verified rows → survival rate 0 (no bonus).
     */
    evaluateAccount(accountId: number, now?: Date): AccountHealthOutput {
        assertAccountId(accountId)
        const instant = resolveNow(now)

        try {
            const db = getDatabase()
            const account = db
                .select({
                    warmupLevel: schema.accounts.warmupLevel,
                    totalReviews: schema.accounts.totalReviews,
                    createdAt: schema.accounts.createdAt,
                    birthStoryCompleted: schema.accounts.birthStoryCompleted,
                    lastReviewDate: schema.accounts.lastReviewDate,
                })
                .from(schema.accounts)
                .where(eq(schema.accounts.id, accountId))
                .get()

            if (!account) {
                throw new Error(`AccountHealthScorer: account ${accountId} not found`)
            }

            const createdAt = readRequiredDate(account.createdAt, `account ${accountId} createdAt`)
            const cutoff = new Date(instant.getTime() - RECENT_WINDOW_DAYS * MS_PER_DAY)

            const recent = db
                .select({
                    successCount: sql<number>`coalesce(sum(case when ${schema.reviewHistory.status} = 'success' then 1 else 0 end), 0)`,
                    failCount: sql<number>`coalesce(sum(case when ${schema.reviewHistory.status} = 'failed' then 1 else 0 end), 0)`,
                })
                .from(schema.reviewHistory)
                .where(and(
                    eq(schema.reviewHistory.accountId, accountId),
                    gte(schema.reviewHistory.createdAt, cutoff),
                ))
                .get()

            const survival = db
                .select({
                    liveCount: sql<number>`coalesce(sum(case when ${schema.reviewHistory.verifiedStatus} = 'live' then 1 else 0 end), 0)`,
                    verifiedCount: sql<number>`coalesce(sum(case when ${schema.reviewHistory.verifiedStatus} in ('live', 'removed') then 1 else 0 end), 0)`,
                })
                .from(schema.reviewHistory)
                .where(eq(schema.reviewHistory.accountId, accountId))
                .get()

            const liveCount = readCount(survival?.liveCount)
            const verifiedCount = readCount(survival?.verifiedCount)
            const survivalRate = verifiedCount > 0 ? Math.min(1, liveCount / verifiedCount) : 0

            return calculateAccountHealth({
                accountId,
                warmupLevel: readCount(account.warmupLevel),
                totalReviews: readCount(account.totalReviews),
                daysSinceCreation: daysSince(createdAt, instant),
                recentSuccessCount: readCount(recent?.successCount),
                recentFailCount: readCount(recent?.failCount),
                survivalRate,
                lastReviewDate: readOptionalDate(account.lastReviewDate),
                birthStoryCompleted: readFlag(account.birthStoryCompleted),
            })
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('AccountHealthScorer:')) {
                throw error
            }
            if (error instanceof Error && error.message.startsWith('calculateAccountHealth:')) {
                throw error
            }
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`AccountHealthScorer: failed to evaluate account ${accountId}: ${message}`)
        }
    }

    /** Every status='active' account, keyed by id. Pending and banned rows are excluded. */
    evaluateAll(now?: Date): Map<number, AccountHealthOutput> {
        const instant = resolveNow(now)
        const db = getDatabase()
        let rows: Array<{ id: number }>
        try {
            rows = db
                .select({ id: schema.accounts.id })
                .from(schema.accounts)
                .where(eq(schema.accounts.status, 'active'))
                .all()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`AccountHealthScorer: failed to list active accounts: ${message}`)
        }

        const scored = new Map<number, AccountHealthOutput>()
        for (const row of rows) {
            assertAccountId(row.id)
            scored.set(row.id, this.evaluateAccount(row.id, instant))
        }
        return scored
    }

    /**
     * Highest-scoring candidate that is not resting and not blocked.
     * Null when every candidate is resting, blocked, or the list is empty.
     */
    pickBestAccount(accountIds: number[], now?: Date): number | null {
        if (accountIds.length === 0) return null
        const instant = resolveNow(now)
        const ranked: RankedAccount[] = []

        for (const accountId of accountIds) {
            const health = this.evaluateAccount(accountId, instant)
            if (health.shouldRest) continue
            if (health.score < BLOCKED_SCORE) continue
            ranked.push({ accountId, health })
        }

        ranked.sort((left, right) => right.health.score - left.health.score)
        return ranked[0]?.accountId ?? null
    }
}

export const accountHealthScorer = new AccountHealthScorer()
