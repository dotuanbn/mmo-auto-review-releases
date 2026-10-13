/**
 * Cross-account review velocity.
 *
 * A location that just received a successful review from one account should not
 * receive another account's review until the configured window elapses.
 * Settings are read on every call so a UI change is not stuck behind a cache.
 * Query failures propagate; AutomationController fails open, campaign engines do not.
 */

import { and, desc, eq, gt, ne, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { loadSettings } from '../ipc/settings'

const DEFAULT_COOLDOWN_MINUTES = 120
const DEFAULT_JITTER_PERCENT = 0.3
const MS_PER_MINUTE = 60_000
/** Unix ms below this are treated as seconds (Drizzle integer timestamp mode). */
const SECONDS_THRESHOLD_MS = 1e12

export interface CooldownCheckResult {
    allowed: boolean
    /** Milliseconds until the newest other-account success falls out of the window. */
    retryAfterMs?: number
    /** Other-account successes inside the window. Present when blocked. */
    recentSuccessCount?: number
}

interface CountRow {
    count: number | null
}

interface CreatedAtRow {
    createdAt: Date | number | string | null
}

interface LocationIdRow {
    locationId: number
}

function resolveNowMs(now?: number | Date): number {
    if (now == null) return Date.now()
    if (now instanceof Date) {
        const ms = now.getTime()
        if (!Number.isFinite(ms)) {
            throw new Error('VelocityController: invalid now date')
        }
        return ms
    }
    if (typeof now === 'number' && Number.isFinite(now)) return now
    throw new Error('VelocityController: invalid now')
}

function readCreatedAt(value: Date | number | string | null | undefined): Date | null {
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
    const trimmed = value.trim()
    if (trimmed === '') return null
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return readCreatedAt(numeric)
    const parsed = new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Remaining wait, clamped to the window. Unknown timestamps use the full window. */
function remainingCooldownMs(successAtMs: number | null, windowMs: number, nowMs: number): number {
    if (successAtMs == null || !Number.isFinite(successAtMs)) return windowMs
    const remaining = successAtMs + windowMs - nowMs
    if (!Number.isFinite(remaining) || remaining > windowMs) return windowMs
    if (remaining <= 0) return 0
    return remaining
}

/**
 * baseDelayMs plus a uniform extra in [0, baseDelayMs * jitterPercent].
 * Spreads retries so accounts do not wake on the same cooldown boundary.
 */
export function addJitter(baseDelayMs: number, jitterPercent = DEFAULT_JITTER_PERCENT): number {
    if (!Number.isFinite(baseDelayMs)) {
        throw new Error(`VelocityController.addJitter: invalid baseDelayMs (${String(baseDelayMs)})`)
    }
    const base = Math.max(0, baseDelayMs)
    const percent = Number.isFinite(jitterPercent) ? Math.max(0, jitterPercent) : 0
    const cap = base * (1 + percent)
    const withJitter = base + Math.random() * base * percent
    return Math.min(withJitter, cap)
}

/**
 * True when a different account has a successful review for this location
 * inside the cooldown window. Non-positive windows are disabled.
 */
export function isLocationInCooldown(
    locationId: number,
    currentAccountId: number,
    cooldownMinutes: number,
    now?: number | Date,
): boolean {
    return countOtherAccountSuccesses(locationId, currentAccountId, cooldownMinutes, now) > 0
}

/**
 * Location ids with any successful review inside the window.
 * Duplicate rows collapse to one id. Empty when the window is disabled.
 */
export function listCooldownLocationIds(cooldownMinutes: number, now?: number | Date): number[] {
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes <= 0) return []

    const cutoff = new Date(resolveNowMs(now) - cooldownMinutes * MS_PER_MINUTE)
    const db = getDatabase()
    const rows = db.select({ locationId: schema.reviewHistory.locationId })
        .from(schema.reviewHistory)
        .where(and(
            gt(schema.reviewHistory.createdAt, cutoff),
            eq(schema.reviewHistory.status, 'success'),
        ))
        .all()

    const ids = new Set<number>()
    for (const row of rows as LocationIdRow[]) {
        if (typeof row.locationId === 'number' && Number.isFinite(row.locationId)) {
            ids.add(row.locationId)
        }
    }
    return Array.from(ids)
}

function countOtherAccountSuccesses(
    locationId: number,
    currentAccountId: number,
    cooldownMinutes: number,
    now?: number | Date,
): number {
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes <= 0) return 0

    const cutoff = new Date(resolveNowMs(now) - cooldownMinutes * MS_PER_MINUTE)
    const db = getDatabase()
    const row = db.select({ count: sql<number>`count(*)` })
        .from(schema.reviewHistory)
        .where(and(
            eq(schema.reviewHistory.locationId, locationId),
            ne(schema.reviewHistory.accountId, currentAccountId),
            gt(schema.reviewHistory.createdAt, cutoff),
            eq(schema.reviewHistory.status, 'success'),
        ))
        .get() as CountRow | undefined

    const count = Number(row?.count ?? 0)
    if (!Number.isFinite(count) || count <= 0) return 0
    return count
}

function selectLatestOtherAccountSuccess(
    locationId: number,
    currentAccountId: number,
    cooldownMinutes: number,
    nowMs: number,
): Date | null {
    const cutoff = new Date(nowMs - cooldownMinutes * MS_PER_MINUTE)
    const db = getDatabase()
    const row = db.select({ createdAt: schema.reviewHistory.createdAt })
        .from(schema.reviewHistory)
        .where(and(
            eq(schema.reviewHistory.locationId, locationId),
            ne(schema.reviewHistory.accountId, currentAccountId),
            gt(schema.reviewHistory.createdAt, cutoff),
            eq(schema.reviewHistory.status, 'success'),
        ))
        .orderBy(desc(schema.reviewHistory.createdAt))
        .limit(1)
        .get() as CreatedAtRow | undefined

    return readCreatedAt(row?.createdAt)
}

function selectLatestLocationSuccess(
    locationId: number,
    cooldownMinutes: number,
    nowMs: number,
): Date | null {
    const cutoff = new Date(nowMs - cooldownMinutes * MS_PER_MINUTE)
    const db = getDatabase()
    const row = db.select({ createdAt: schema.reviewHistory.createdAt })
        .from(schema.reviewHistory)
        .where(and(
            eq(schema.reviewHistory.locationId, locationId),
            gt(schema.reviewHistory.createdAt, cutoff),
            eq(schema.reviewHistory.status, 'success'),
        ))
        .orderBy(desc(schema.reviewHistory.createdAt))
        .limit(1)
        .get() as CreatedAtRow | undefined

    return readCreatedAt(row?.createdAt)
}

export class VelocityController {
    constructor() {
        // Stateless on purpose. Cooldown minutes come from loadSettings() per call.
    }

    /**
     * Cooldown length in minutes. Missing or non-numeric settings fall back to 120.
     * Zero or negative disables the window.
     */
    readCooldownMinutes(): number {
        const settings: unknown = loadSettings()
        if (settings == null || typeof settings !== 'object') return DEFAULT_COOLDOWN_MINUTES
        const raw = (settings as Record<string, unknown>).crossAccountCooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_COOLDOWN_MINUTES
        return raw
    }

    /**
     * Whether this account may review the location right now.
     * Blocked results include an approximate retry delay from the newest other success.
     */
    checkCooldown(locationId: number, currentAccountId: number): CooldownCheckResult {
        const cooldownMinutes = this.readCooldownMinutes()
        if (cooldownMinutes <= 0) return { allowed: true }

        const nowMs = Date.now()
        const recentSuccessCount = countOtherAccountSuccesses(
            locationId,
            currentAccountId,
            cooldownMinutes,
            nowMs,
        )
        if (recentSuccessCount <= 0) return { allowed: true }

        const latest = selectLatestOtherAccountSuccess(
            locationId,
            currentAccountId,
            cooldownMinutes,
            nowMs,
        )
        const retryAfterMs = remainingCooldownMs(
            latest?.getTime() ?? null,
            cooldownMinutes * MS_PER_MINUTE,
            nowMs,
        )
        return { allowed: false, retryAfterMs, recentSuccessCount }
    }

    /** Location ids currently inside the cross-account window. */
    getCooldownLocationIds(): number[] {
        return listCooldownLocationIds(this.readCooldownMinutes())
    }

    /**
     * Suggested wait before retrying this location, including jitter.
     * Base delay is the time left until the newest success ages out of the window.
     */
    getRecommendedDelay(locationId: number): number {
        const cooldownMinutes = this.readCooldownMinutes()
        if (cooldownMinutes <= 0) return 0

        const nowMs = Date.now()
        const latest = selectLatestLocationSuccess(locationId, cooldownMinutes, nowMs)
        if (!latest) return addJitter(0)

        const remaining = remainingCooldownMs(
            latest.getTime(),
            cooldownMinutes * MS_PER_MINUTE,
            nowMs,
        )
        return addJitter(remaining)
    }
}

export const velocityController = new VelocityController()
