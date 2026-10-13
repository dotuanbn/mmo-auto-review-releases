/**
 * Dashboard overview aggregator.
 * better-sqlite3 is synchronous, so every read here is a single aggregate query.
 * created_at columns use Drizzle timestamp mode (unix seconds). Sparkline days
 * follow SQLite date(created_at, 'unixepoch'), which is UTC.
 */

import { and, avg, count, desc, eq, gte, sql } from 'drizzle-orm'
import { getDatabase, schema } from '../database'

const SPARKLINE_DAYS = 30
const MS_PER_DAY = 86_400_000

export interface DashboardOverview {
    traffic: {
        totalVisits: number
        successVisits: number
        failedVisits: number
        avgQualityScore: number
        avgDurationSeconds: number
        organicPercent: number
        /** Daily visit counts for the last 30 UTC days, oldest first. Missing days are 0. */
        sparkline30d: number[]
    }
    reviews: {
        totalReviews: number
        successReviews: number
        failedReviews: number
        successRate: number
        /** All statuses since local midnight. */
        reviewsToday: number
        /** All statuses since local Monday 00:00 (ISO week). */
        reviewsThisWeek: number
        /** All statuses since local midnight on the 1st of this month. */
        reviewsThisMonth: number
        avgRating: number
        /** Daily review counts for the last 30 UTC days, oldest first. Missing days are 0. */
        sparkline30d: number[]
    }
    accounts: {
        total: number
        active: number
        banned: number
        suspended: number
        tiers: {
            /** warmupLevel < 25 */
            blocked: number
            /** warmupLevel 25–54 */
            throttled: number
            /** warmupLevel >= 55 */
            ready: number
        }
        avgWarmupLevel: number
        birthStoryCompletePercent: number
        /** Accounts with auto warmup enabled (count, not a percent). */
        autoWarmupEnabled: number
    }
    campaigns: {
        total: number
        running: number
        paused: number
        done: number
    }
    captcha: {
        totalAttempts: number
        successRate: number
        avgSolveTimeMs: number
    }
    /** Review survival tracking metrics. */
    survival: ReviewSurvivalStats
    /** Top 5 failed review_history error messages. */
    recentFailures: Array<{ error: string; count: number }>
}

/** Aggregate metrics for review survival (anti-detection effectiveness). */
export interface ReviewSurvivalStats {
    /** Total reviews that have been verified at least once. */
    totalVerified: number
    /** Reviews confirmed still live on Google Maps. */
    liveCount: number
    /** Reviews confirmed removed by Google. */
    removedCount: number
    /** Reviews not yet checked (status = 'pending'). */
    pendingCount: number
    /** Overall survival rate of verified reviews (%). */
    overallSurvivalRate: number
    /** Average days a verified review has survived. */
    avgSurvivalDays: number
    /** Survival rate for reviews where per-account style was applied (%). */
    styledSurvivalRate: number
    /** Survival rate for reviews where style was NOT applied (%). */
    unstyledSurvivalRate: number
    /** Survival rates by account warmup tier (%). */
    survivalByWarmupTier: {
        blocked: number
        throttled: number
        ready: number
    }
}

type AppDatabase = ReturnType<typeof getDatabase>
type DailyCountRow = { day: unknown; total: unknown }

function toFinite(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0
    if (typeof value === 'bigint') return Number(value)
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
}

function toCount(value: unknown): number {
    return Math.max(0, Math.trunc(toFinite(value)))
}

/** One decimal, matching the existing review success-rate display. */
function round1(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.round(value * 10) / 10
}

function percent(part: number, total: number): number {
    if (total <= 0 || part <= 0) return 0
    return round1(Math.min(100, (part / total) * 100))
}

function normalizeDay(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
    return match?.[1] ?? null
}

function startOfLocalDay(now: Date): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Monday 00:00 local. Sunday belongs to the week that started the previous Monday. */
function startOfLocalIsoWeek(now: Date): Date {
    const start = startOfLocalDay(now)
    const daysFromMonday = start.getDay() === 0 ? 6 : start.getDay() - 1
    start.setDate(start.getDate() - daysFromMonday)
    return start
}

function startOfLocalMonth(now: Date): Date {
    return new Date(now.getFullYear(), now.getMonth(), 1)
}

function unixSeconds(date: Date): number {
    return Math.floor(date.getTime() / 1000)
}

/**
 * 30 UTC calendar days ending today. Index 0 is the oldest day.
 * Bounds are [since, end) so they line up with date(created_at, 'unixepoch').
 */
function sparklineWindow(now: Date): { since: Date; endExclusiveSec: number; labels: string[] } {
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const startMs = todayUtcMs - (SPARKLINE_DAYS - 1) * MS_PER_DAY
    const labels: string[] = []
    for (let i = 0; i < SPARKLINE_DAYS; i++) {
        labels.push(new Date(startMs + i * MS_PER_DAY).toISOString().slice(0, 10))
    }
    return {
        since: new Date(startMs),
        endExclusiveSec: Math.floor((startMs + SPARKLINE_DAYS * MS_PER_DAY) / 1000),
        labels,
    }
}

function padSparkline(rows: readonly DailyCountRow[], labels: readonly string[]): number[] {
    const byDay = new Map<string, number>()
    for (const row of rows) {
        const day = normalizeDay(row.day)
        if (!day) continue
        byDay.set(day, (byDay.get(day) ?? 0) + toCount(row.total))
    }
    return labels.map((day) => byDay.get(day) ?? 0)
}

function queryTrafficSparkline(db: AppDatabase, since: Date, endExclusiveSec: number): DailyCountRow[] {
    const createdAt = schema.trafficLogs.createdAt
    const dayExpr = sql<string>`date(${createdAt}, 'unixepoch')`
    return db
        .select({ day: dayExpr, total: count() })
        .from(schema.trafficLogs)
        .where(and(gte(createdAt, since), sql`${createdAt} < ${endExclusiveSec}`))
        .groupBy(dayExpr)
        .all()
}

function queryReviewSparkline(db: AppDatabase, since: Date, endExclusiveSec: number): DailyCountRow[] {
    const createdAt = schema.reviewHistory.createdAt
    const dayExpr = sql<string>`date(${createdAt}, 'unixepoch')`
    return db
        .select({ day: dayExpr, total: count() })
        .from(schema.reviewHistory)
        .where(and(gte(createdAt, since), sql`${createdAt} < ${endExclusiveSec}`))
        .groupBy(dayExpr)
        .all()
}

function loadTraffic(db: AppDatabase, now: Date): DashboardOverview['traffic'] {
    const row = db
        .select({
            total: count(),
            successVisits: sql<number>`sum(case when ${schema.trafficLogs.status} = 'success' then 1 else 0 end)`,
            failedVisits: sql<number>`sum(case when ${schema.trafficLogs.status} = 'failed' then 1 else 0 end)`,
            avgQualityScore: avg(schema.trafficLogs.qualityScore),
            avgDurationSeconds: avg(schema.trafficLogs.duration),
            organicVisits: sql<number>`sum(case when ${schema.trafficLogs.discoverySource} = 'organic' then 1 else 0 end)`,
        })
        .from(schema.trafficLogs)
        .get()

    const totalVisits = toCount(row?.total)
    const window = sparklineWindow(now)

    return {
        totalVisits,
        successVisits: toCount(row?.successVisits),
        failedVisits: toCount(row?.failedVisits),
        avgQualityScore: round1(toFinite(row?.avgQualityScore)),
        avgDurationSeconds: round1(toFinite(row?.avgDurationSeconds)),
        organicPercent: percent(toCount(row?.organicVisits), totalVisits),
        sparkline30d: padSparkline(
            queryTrafficSparkline(db, window.since, window.endExclusiveSec),
            window.labels,
        ),
    }
}

function loadReviews(db: AppDatabase, now: Date): DashboardOverview['reviews'] {
    const createdAt = schema.reviewHistory.createdAt
    const todaySec = unixSeconds(startOfLocalDay(now))
    const weekSec = unixSeconds(startOfLocalIsoWeek(now))
    const monthSec = unixSeconds(startOfLocalMonth(now))

    const row = db
        .select({
            total: count(),
            successReviews: sql<number>`sum(case when ${schema.reviewHistory.status} = 'success' then 1 else 0 end)`,
            failedReviews: sql<number>`sum(case when ${schema.reviewHistory.status} = 'failed' then 1 else 0 end)`,
            avgRating: avg(schema.reviewHistory.rating),
            reviewsToday: sql<number>`sum(case when ${createdAt} >= ${todaySec} then 1 else 0 end)`,
            reviewsThisWeek: sql<number>`sum(case when ${createdAt} >= ${weekSec} then 1 else 0 end)`,
            reviewsThisMonth: sql<number>`sum(case when ${createdAt} >= ${monthSec} then 1 else 0 end)`,
        })
        .from(schema.reviewHistory)
        .get()

    const totalReviews = toCount(row?.total)
    const successReviews = toCount(row?.successReviews)
    const window = sparklineWindow(now)

    return {
        totalReviews,
        successReviews,
        failedReviews: toCount(row?.failedReviews),
        successRate: percent(successReviews, totalReviews),
        reviewsToday: toCount(row?.reviewsToday),
        reviewsThisWeek: toCount(row?.reviewsThisWeek),
        reviewsThisMonth: toCount(row?.reviewsThisMonth),
        avgRating: round1(toFinite(row?.avgRating)),
        sparkline30d: padSparkline(
            queryReviewSparkline(db, window.since, window.endExclusiveSec),
            window.labels,
        ),
    }
}

function loadAccounts(db: AppDatabase): DashboardOverview['accounts'] {
    const warmup = schema.accounts.warmupLevel
    const row = db
        .select({
            total: count(),
            active: sql<number>`sum(case when ${schema.accounts.status} = 'active' then 1 else 0 end)`,
            banned: sql<number>`sum(case when ${schema.accounts.status} = 'banned' then 1 else 0 end)`,
            suspended: sql<number>`sum(case when ${schema.accounts.status} = 'suspended' then 1 else 0 end)`,
            blocked: sql<number>`sum(case when ${warmup} < 25 then 1 else 0 end)`,
            throttled: sql<number>`sum(case when ${warmup} >= 25 and ${warmup} <= 54 then 1 else 0 end)`,
            ready: sql<number>`sum(case when ${warmup} >= 55 then 1 else 0 end)`,
            avgWarmupLevel: avg(warmup),
            birthComplete: sql<number>`sum(case when ${schema.accounts.birthStoryCompleted} = 1 then 1 else 0 end)`,
            autoWarmupEnabled: sql<number>`sum(case when ${schema.accounts.autoWarmupEnabled} = 1 then 1 else 0 end)`,
        })
        .from(schema.accounts)
        .get()

    const total = toCount(row?.total)
    return {
        total,
        active: toCount(row?.active),
        banned: toCount(row?.banned),
        suspended: toCount(row?.suspended),
        tiers: {
            blocked: toCount(row?.blocked),
            throttled: toCount(row?.throttled),
            ready: toCount(row?.ready),
        },
        avgWarmupLevel: round1(toFinite(row?.avgWarmupLevel)),
        birthStoryCompletePercent: percent(toCount(row?.birthComplete), total),
        autoWarmupEnabled: toCount(row?.autoWarmupEnabled),
    }
}

function loadCampaigns(db: AppDatabase): DashboardOverview['campaigns'] {
    const rows = db
        .select({
            status: schema.campaigns.status,
            total: count(),
        })
        .from(schema.campaigns)
        .groupBy(schema.campaigns.status)
        .all()

    return rows.reduce<DashboardOverview['campaigns']>((acc, row) => {
        const n = toCount(row.total)
        acc.total += n
        if (row.status === 'running') acc.running = n
        if (row.status === 'paused') acc.paused = n
        if (row.status === 'done') acc.done = n
        return acc
    }, { total: 0, running: 0, paused: 0, done: 0 })
}

function loadCaptcha(db: AppDatabase): DashboardOverview['captcha'] {
    const row = db
        .select({
            total: count(),
            successAttempts: sql<number>`sum(case when ${schema.captchaMetrics.success} = 1 then 1 else 0 end)`,
            avgSolveTimeMs: avg(schema.captchaMetrics.durationMs),
        })
        .from(schema.captchaMetrics)
        .get()

    const totalAttempts = toCount(row?.total)
    return {
        totalAttempts,
        successRate: percent(toCount(row?.successAttempts), totalAttempts),
        avgSolveTimeMs: Math.max(0, Math.round(toFinite(row?.avgSolveTimeMs))),
    }
}

function loadRecentFailures(db: AppDatabase): DashboardOverview['recentFailures'] {
    const errorExpr = sql<string>`coalesce(nullif(${schema.reviewHistory.errorMessage}, ''), 'Unknown error')`
    const rows = db
        .select({
            error: errorExpr,
            total: count(),
        })
        .from(schema.reviewHistory)
        .where(eq(schema.reviewHistory.status, 'failed'))
        .groupBy(errorExpr)
        .orderBy(desc(count()))
        .limit(5)
        .all()

    return rows.map((row) => ({
        error: typeof row.error === 'string' && row.error.length > 0 ? row.error : 'Unknown error',
        count: toCount(row.total),
    }))
}

function loadSurvival(db: AppDatabase): ReviewSurvivalStats {
    const rh = schema.reviewHistory
    const acc = schema.accounts

    // Main survival aggregation — single query with a join to accounts for warmup tier
    const row = db
        .select({
            // Overall counts
            totalVerified: sql<number>`sum(case when ${rh.verifiedStatus} in ('live', 'removed') then 1 else 0 end)`,
            liveCount: sql<number>`sum(case when ${rh.verifiedStatus} = 'live' then 1 else 0 end)`,
            removedCount: sql<number>`sum(case when ${rh.verifiedStatus} = 'removed' then 1 else 0 end)`,
            pendingCount: sql<number>`sum(case when ${rh.verifiedStatus} = 'pending' or ${rh.verifiedStatus} is null then 1 else 0 end)`,
            avgSurvivalDays: avg(rh.survivalDays),
            // Style A/B: styled
            styledVerified: sql<number>`sum(case when ${rh.styleApplied} = 1 and ${rh.verifiedStatus} in ('live', 'removed') then 1 else 0 end)`,
            styledLive: sql<number>`sum(case when ${rh.styleApplied} = 1 and ${rh.verifiedStatus} = 'live' then 1 else 0 end)`,
            // Style A/B: unstyled
            unstyledVerified: sql<number>`sum(case when (${rh.styleApplied} = 0 or ${rh.styleApplied} is null) and ${rh.verifiedStatus} in ('live', 'removed') then 1 else 0 end)`,
            unstyledLive: sql<number>`sum(case when (${rh.styleApplied} = 0 or ${rh.styleApplied} is null) and ${rh.verifiedStatus} = 'live' then 1 else 0 end)`,
            // Warmup tier: blocked (<25)
            blockedVerified: sql<number>`sum(case when ${acc.warmupLevel} < 25 and ${rh.verifiedStatus} in ('live', 'removed') then 1 else 0 end)`,
            blockedLive: sql<number>`sum(case when ${acc.warmupLevel} < 25 and ${rh.verifiedStatus} = 'live' then 1 else 0 end)`,
            // Warmup tier: throttled (25-54)
            throttledVerified: sql<number>`sum(case when ${acc.warmupLevel} >= 25 and ${acc.warmupLevel} <= 54 and ${rh.verifiedStatus} in ('live', 'removed') then 1 else 0 end)`,
            throttledLive: sql<number>`sum(case when ${acc.warmupLevel} >= 25 and ${acc.warmupLevel} <= 54 and ${rh.verifiedStatus} = 'live' then 1 else 0 end)`,
            // Warmup tier: ready (>=55)
            readyVerified: sql<number>`sum(case when ${acc.warmupLevel} >= 55 and ${rh.verifiedStatus} in ('live', 'removed') then 1 else 0 end)`,
            readyLive: sql<number>`sum(case when ${acc.warmupLevel} >= 55 and ${rh.verifiedStatus} = 'live' then 1 else 0 end)`,
        })
        .from(rh)
        .leftJoin(acc, eq(rh.accountId, acc.id))
        .where(eq(rh.status, 'success'))
        .get()

    const totalVerified = toCount(row?.totalVerified)
    const liveCount = toCount(row?.liveCount)

    return {
        totalVerified,
        liveCount,
        removedCount: toCount(row?.removedCount),
        pendingCount: toCount(row?.pendingCount),
        overallSurvivalRate: percent(liveCount, totalVerified),
        avgSurvivalDays: round1(toFinite(row?.avgSurvivalDays)),
        styledSurvivalRate: percent(toCount(row?.styledLive), toCount(row?.styledVerified)),
        unstyledSurvivalRate: percent(toCount(row?.unstyledLive), toCount(row?.unstyledVerified)),
        survivalByWarmupTier: {
            blocked: percent(toCount(row?.blockedLive), toCount(row?.blockedVerified)),
            throttled: percent(toCount(row?.throttledLive), toCount(row?.throttledVerified)),
            ready: percent(toCount(row?.readyLive), toCount(row?.readyVerified)),
        },
    }
}

export class DashboardService {
    /** Sync read. better-sqlite3 does not need a Promise here. */
    getOverview(now: Date = new Date()): DashboardOverview {
        const db = getDatabase()
        return {
            traffic: loadTraffic(db, now),
            reviews: loadReviews(db, now),
            accounts: loadAccounts(db),
            campaigns: loadCampaigns(db),
            captcha: loadCaptcha(db),
            survival: loadSurvival(db),
            recentFailures: loadRecentFailures(db),
        }
    }
}

export const dashboardService = new DashboardService()
