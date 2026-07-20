/**
 * AccountWarmupService — Phase 2 of Anti-Detection Strategy
 *
 * Tracks warmup level, reputation, session schedule, and history.
 * Safe activity recording is consumed by AccountWarmupEngine.
 * Active review gating is enforced only when settings.enforceAccountWarmup === true.
 *
 * Start eligibility: nextWarmupAt cooldown + daily session cap (local calendar date).
 */

import { getDatabase, schema } from '../database'
import { eq } from 'drizzle-orm'
import type { Account } from '../database/schema'
import type { WarmupActionErrorCode } from '../../shared/warmup-contracts'

/** Persisted activity types (history JSON). */
export type WarmupActivityType =
    | 'gmail'
    | 'youtube'
    | 'youtube_browse'
    | 'search'
    | 'google_search'
    | 'maps_browse'
    | 'photos'
    | 'other'

/** Bounded engine session types (Worker 2). */
export type WarmupSessionType = 'google_search' | 'maps_browse' | 'youtube_browse'

export interface WarmupActivity {
    type: WarmupActivityType
    timestamp: string
    durationSec?: number
    detail?: string
}

export interface WarmupData {
    warmupLevel: number
    reputationScore: number
    warmupSessions: number
    lastWarmupAt: Date | null
    nextWarmupAt: Date | null
    firstReviewDate?: Date
    lastReviewDate?: Date
    history: WarmupActivity[]
}

/** IPC/status shape required by Worker 2 contract. */
export interface AccountWarmupStatus {
    accountId: number
    running: boolean
    warmupLevel: number
    reputationScore: number
    warmupSessions: number
    lastWarmupAt: string | null
    nextWarmupAt: string | null
    isReady: boolean
}

export type WarmupGateTier = 'blocked' | 'throttled' | 'full'

export interface WarmupGateDecision {
    enforce: boolean
    tier: WarmupGateTier
    allowed: boolean
    maxPendingJobs: number | null
    warmupLevel: number
    reason: string
}

/** Result of cooldown + daily-cap checks before starting a session. */
export type WarmupStartEligibility =
    | { allowed: true }
    | { allowed: false; code: Extract<WarmupActionErrorCode, 'cooldown_active' | 'daily_cap_reached'>; message: string }

/**
 * Sync commit guard for completeSession.
 * Engine passes `() => registry.isLive(session)` so cancel/stale gen
 * after recheck but before DB commit never credits.
 */
export type WarmupShouldCommitGuard = () => boolean

/**
 * Optional 5th-arg options for completeSession.
 * Also accepts bare `Date` for backward-compatible `now` callers.
 */
export interface CompleteSessionOptions {
    now?: Date
    /** Re-checked after every await and immediately before DB update. */
    shouldCommit?: WarmupShouldCommitGuard
}

const READY_MIN_LEVEL = 35
const HISTORY_LIMIT = 50
const DEFAULT_NEXT_WARMUP_HOURS = 8

/** Max credited warmup sessions per local calendar day (machine timezone). */
export const MAX_DAILY_WARMUP_SESSIONS = 3

/** Activity types that count toward the daily session cap. */
const SESSION_ACTIVITY_TYPES: ReadonlySet<string> = new Set<WarmupSessionType>([
    'google_search',
    'maps_browse',
    'youtube_browse',
])

function toIso(value: Date | null | undefined): string | null {
    if (!value) return null
    try {
        return value.toISOString()
    } catch {
        return null
    }
}

function parseHistory(raw: string | null | undefined): WarmupActivity[] {
    if (!raw) return []
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item): item is WarmupActivity => {
            if (!item || typeof item !== 'object') return false
            const row = item as Record<string, unknown>
            return typeof row.type === 'string' && typeof row.timestamp === 'string'
        })
    } catch {
        return []
    }
}

function clampLevel(value: number): number {
    return Math.min(100, Math.max(0, Math.floor(value)))
}

function clampScore(value: number): number {
    return Math.min(1000, Math.max(0, Math.floor(value)))
}

/** Normalize completeSession 5th arg: bare Date (legacy) or options bag. */
function resolveCompleteSessionArgs(
    nowOrOptions?: Date | CompleteSessionOptions,
): { now: Date; shouldCommit?: WarmupShouldCommitGuard } {
    if (nowOrOptions instanceof Date) {
        return { now: nowOrOptions }
    }
    if (nowOrOptions && typeof nowOrOptions === 'object') {
        return {
            now: nowOrOptions.now ?? new Date(),
            shouldCommit: nowOrOptions.shouldCommit,
        }
    }
    return { now: new Date() }
}

/**
 * Local calendar date key YYYY-MM-DD (machine timezone).
 * Exported for unit tests.
 */
export function localDateKey(date: Date = new Date()): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/**
 * Count credited warmup sessions whose timestamp falls on the given local date key.
 * Exported for unit tests.
 */
export function countWarmupSessionsOnLocalDate(
    history: readonly WarmupActivity[],
    dayKey: string,
): number {
    let count = 0
    for (const activity of history) {
        if (!SESSION_ACTIVITY_TYPES.has(activity.type)) continue
        const ts = Date.parse(activity.timestamp)
        if (Number.isNaN(ts)) continue
        if (localDateKey(new Date(ts)) === dayKey) count += 1
    }
    return count
}

/**
 * Pure eligibility: nextWarmupAt cooldown + daily local-date cap.
 * Exported for unit tests.
 */
export function evaluateStartEligibility(
    data: Pick<WarmupData, 'nextWarmupAt' | 'history'>,
    now: Date = new Date(),
): WarmupStartEligibility {
    if (data.nextWarmupAt && data.nextWarmupAt.getTime() > now.getTime()) {
        return {
            allowed: false,
            code: 'cooldown_active',
            message:
                `Warmup cooldown active until ${data.nextWarmupAt.toISOString()}. ` +
                'Wait until nextWarmupAt before starting another session.',
        }
    }

    const dayKey = localDateKey(now)
    const todayCount = countWarmupSessionsOnLocalDate(data.history, dayKey)
    if (todayCount >= MAX_DAILY_WARMUP_SESSIONS) {
        return {
            allowed: false,
            code: 'daily_cap_reached',
            message:
                `Daily warmup cap reached (${todayCount}/${MAX_DAILY_WARMUP_SESSIONS} ` +
                `sessions on local date ${dayKey}). Try again tomorrow.`,
        }
    }

    return { allowed: true }
}

export class AccountWarmupService {
    async getWarmupData(accountId: number): Promise<WarmupData> {
        const acc = this.requireAccount(accountId)
        return this.mapAccountToData(acc)
    }

    /**
     * Build public status DTO. `running` is supplied by the engine (in-memory).
     */
    async getStatus(accountId: number, running = false): Promise<AccountWarmupStatus> {
        const data = await this.getWarmupData(accountId)
        return this.toStatus(accountId, data, running)
    }

    async getAllStatuses(runningIds: ReadonlySet<number> = new Set()): Promise<AccountWarmupStatus[]> {
        const db = getDatabase()
        const rows = db.select().from(schema.accounts).all()
        return rows.map((acc) => {
            const data = this.mapAccountToData(acc)
            return this.toStatus(acc.id, data, runningIds.has(acc.id))
        })
    }

    /**
     * Cooldown + daily cap gate used by AccountWarmupEngine.start.
     */
    async getStartEligibility(
        accountId: number,
        now: Date = new Date(),
    ): Promise<WarmupStartEligibility> {
        const data = await this.getWarmupData(accountId)
        return evaluateStartEligibility(data, now)
    }

    /**
     * Record a safe activity: history + level/score boost.
     * Does not bump warmupSessions (use completeSession for full sessions).
     */
    async recordSafeActivity(accountId: number, activity: WarmupActivity): Promise<void> {
        const db = getDatabase()
        const current = await this.getWarmupData(accountId)
        const newHistory = [...current.history, activity].slice(-HISTORY_LIMIT)

        const boost = this.getActivityBoost(activity.type)
        const newLevel = clampLevel(current.warmupLevel + boost)
        const newScore = clampScore(current.reputationScore + Math.floor(boost * 3))

        db.update(schema.accounts)
            .set({
                warmupLevel: newLevel,
                reputationScore: newScore,
                warmupHistory: JSON.stringify(newHistory),
            })
            .where(eq(schema.accounts.id, accountId))
            .run()

        console.log(
            `[AccountWarmup] activity account=${accountId} type=${activity.type} ` +
            `boost=${boost} level=${newLevel} score=${newScore}`
        )
    }

    /**
     * Complete a bounded warmup session: activity + schedule + session counter.
     *
     * Defense-in-depth:
     *  - refuses credit when daily local-date cap is already full
     *  - optional `shouldCommit` guard re-checked after every await and
     *    immediately before DB update (closes cancel race during getWarmupData)
     *
     * Returns current data unchanged on refuse; does not throw.
     * 5th arg accepts `Date` (legacy) or `CompleteSessionOptions`.
     */
    async completeSession(
        accountId: number,
        sessionType: WarmupSessionType,
        durationSec: number,
        detail?: string,
        nowOrOptions?: Date | CompleteSessionOptions,
    ): Promise<WarmupData> {
        const { now, shouldCommit } = resolveCompleteSessionArgs(nowOrOptions)

        // Gate before any yield: cancelled/stale callers skip load+credit entirely.
        if (!this.passesCommitGuard(shouldCommit, accountId, 'pre-load')) {
            return this.mapAccountToData(this.requireAccount(accountId))
        }

        const db = getDatabase()
        const current = await this.getWarmupData(accountId)

        // Re-check after await — cancel may have landed during getWarmupData.
        if (!this.passesCommitGuard(shouldCommit, accountId, 'post-load')) {
            return current
        }

        // Do not re-check nextWarmupAt here: that gate applies only to *starting*
        // a new session. Crediting the session that just finished must still work.
        const dayKey = localDateKey(now)
        const todayCount = countWarmupSessionsOnLocalDate(current.history, dayKey)
        if (todayCount >= MAX_DAILY_WARMUP_SESSIONS) {
            console.warn(
                `[AccountWarmup] refuse credit account=${accountId}: daily cap ` +
                `${todayCount}/${MAX_DAILY_WARMUP_SESSIONS} on ${dayKey}`
            )
            return current
        }

        const activity: WarmupActivity = {
            type: sessionType,
            timestamp: now.toISOString(),
            durationSec,
            detail,
        }
        const newHistory = [...current.history, activity].slice(-HISTORY_LIMIT)
        const boost = this.getActivityBoost(sessionType)
        const newLevel = clampLevel(current.warmupLevel + boost)
        const newScore = clampScore(current.reputationScore + Math.floor(boost * 3))
        const sessions = (current.warmupSessions || 0) + 1
        const nextWarmupAt = this.computeNextWarmupAt(now, newLevel)

        // Final re-check immediately before DB commit — absolute no-credit on cancel.
        if (!this.passesCommitGuard(shouldCommit, accountId, 'pre-commit')) {
            return current
        }

        db.update(schema.accounts)
            .set({
                warmupLevel: newLevel,
                reputationScore: newScore,
                warmupHistory: JSON.stringify(newHistory),
                warmupSessions: sessions,
                lastWarmupAt: now,
                nextWarmupAt,
            })
            .where(eq(schema.accounts.id, accountId))
            .run()

        console.log(
            `[AccountWarmup] session complete account=${accountId} type=${sessionType} ` +
            `durationSec=${durationSec} sessions=${sessions} level=${newLevel} next=${nextWarmupAt.toISOString()}`
        )

        return this.getWarmupData(accountId)
    }

    /**
     * Sync shouldCommit evaluation. Missing guard = always allow (BC for legacy callers).
     */
    private passesCommitGuard(
        shouldCommit: WarmupShouldCommitGuard | undefined,
        accountId: number,
        phase: string,
    ): boolean {
        if (!shouldCommit) return true
        if (shouldCommit()) return true
        console.warn(
            `[AccountWarmup] refuse credit account=${accountId}: shouldCommit=false (${phase})`
        )
        return false
    }

    async isReadyForRealWork(accountId: number, minLevel = READY_MIN_LEVEL): Promise<boolean> {
        const data = await this.getWarmupData(accountId)
        return data.warmupLevel >= minLevel
    }

    /**
     * Active review gate decision for AutomationController.
     * When enforce is false, always full access (legacy path).
     */
    evaluateReviewGate(warmupLevel: number, enforce: boolean): WarmupGateDecision {
        if (!enforce) {
            return {
                enforce: false,
                tier: 'full',
                allowed: true,
                maxPendingJobs: null,
                warmupLevel,
                reason: 'enforceAccountWarmup=false (legacy, no gate)',
            }
        }

        const level = clampLevel(warmupLevel)
        if (level < 25) {
            return {
                enforce: true,
                tier: 'blocked',
                allowed: false,
                maxPendingJobs: 0,
                warmupLevel: level,
                reason: `warmupLevel=${level}<25 — skip reviews until more warmup`,
            }
        }
        if (level < 55) {
            return {
                enforce: true,
                tier: 'throttled',
                allowed: true,
                maxPendingJobs: 1,
                warmupLevel: level,
                reason: `warmupLevel=${level} (25-54) — max 1 pending job/account`,
            }
        }
        return {
            enforce: true,
            tier: 'full',
            allowed: true,
            maxPendingJobs: null,
            warmupLevel: level,
            reason: `warmupLevel=${level}>=55 — normal review velocity`,
        }
    }

    async evaluateReviewGateForAccount(accountId: number, enforce: boolean): Promise<WarmupGateDecision> {
        try {
            const data = await this.getWarmupData(accountId)
            return this.evaluateReviewGate(data.warmupLevel, enforce)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
                enforce,
                tier: 'blocked',
                allowed: !enforce,
                maxPendingJobs: enforce ? 0 : null,
                warmupLevel: 0,
                reason: `warmup data unavailable: ${message}`,
            }
        }
    }

    async recordRealReview(accountId: number): Promise<void> {
        const db = getDatabase()
        const now = new Date()
        const acc = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()
        if (!acc) return

        const updates: Partial<Account> & {
            lastReviewDate: Date
            totalReviews: number
            reputationScore: number
            firstReviewDate?: Date
        } = {
            lastReviewDate: now,
            totalReviews: (acc.totalReviews || 0) + 1,
            reputationScore: clampScore((acc.reputationScore || 0) + 5),
        }

        if (!acc.firstReviewDate) {
            updates.firstReviewDate = now
        }

        db.update(schema.accounts)
            .set(updates)
            .where(eq(schema.accounts.id, accountId))
            .run()
    }

    private getActivityBoost(type: WarmupActivityType): number {
        switch (type) {
            case 'gmail':
                return 8
            case 'youtube':
            case 'youtube_browse':
                return 6
            case 'search':
            case 'google_search':
                return 5
            case 'maps_browse':
                return 7
            case 'photos':
                return 4
            default:
                return 3
        }
    }

    private computeNextWarmupAt(from: Date, level: number): Date {
        // Lower level → more frequent warmup; mature accounts space out sessions.
        let hours = DEFAULT_NEXT_WARMUP_HOURS
        if (level < 25) hours = 4
        else if (level < 55) hours = 8
        else hours = 16
        const jitterMs = Math.floor(Math.random() * 60 * 60 * 1000)
        return new Date(from.getTime() + hours * 60 * 60 * 1000 + jitterMs)
    }

    private requireAccount(accountId: number): Account {
        const db = getDatabase()
        const acc = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()
        if (!acc) throw new Error(`Account not found: ${accountId}`)
        return acc
    }

    private mapAccountToData(acc: Account): WarmupData {
        return {
            warmupLevel: acc.warmupLevel ?? 0,
            reputationScore: acc.reputationScore ?? 0,
            warmupSessions: acc.warmupSessions ?? 0,
            lastWarmupAt: acc.lastWarmupAt ? new Date(acc.lastWarmupAt) : null,
            nextWarmupAt: acc.nextWarmupAt ? new Date(acc.nextWarmupAt) : null,
            firstReviewDate: acc.firstReviewDate ? new Date(acc.firstReviewDate) : undefined,
            lastReviewDate: acc.lastReviewDate ? new Date(acc.lastReviewDate) : undefined,
            history: parseHistory(acc.warmupHistory),
        }
    }

    private toStatus(accountId: number, data: WarmupData, running: boolean): AccountWarmupStatus {
        return {
            accountId,
            running,
            warmupLevel: data.warmupLevel,
            reputationScore: data.reputationScore,
            warmupSessions: data.warmupSessions,
            lastWarmupAt: toIso(data.lastWarmupAt),
            nextWarmupAt: toIso(data.nextWarmupAt),
            isReady: data.warmupLevel >= READY_MIN_LEVEL,
        }
    }
}

export const accountWarmupService = new AccountWarmupService()
