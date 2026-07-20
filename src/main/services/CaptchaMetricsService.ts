/**
 * CaptchaMetricsService — durable CAPTCHA solve metrics.
 *
 * Stores attempt outcomes (type, provider, success, duration, retries).
 * Never persists secrets, API keys, tokens, sitekeys, or full page URLs.
 */

import { asc, desc, inArray } from 'drizzle-orm'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import {
    CAPTCHA_METRICS_ERROR_CODE_MAX,
    CAPTCHA_METRICS_MAX_ROWS,
    CAPTCHA_METRICS_RECENT_LIMIT,
    emptyCaptchaMetricsSnapshot,
    type CaptchaAttemptRecordInput,
    type CaptchaMetricProvider,
    type CaptchaMetricType,
    type CaptchaMetricsBucket,
    type CaptchaMetricsResetResult,
    type CaptchaMetricsSnapshot,
    type CaptchaMetricsTotals,
    type CaptchaRecentAttempt,
} from '../../shared/captcha-metrics-contracts'

const KNOWN_TYPES = new Set<CaptchaMetricType>([
    'recaptchav2',
    'recaptchav3',
    'hcaptcha',
    'turnstile',
    'image-grid',
    'unknown',
])

const KNOWN_PROVIDERS = new Set<CaptchaMetricProvider>([
    'none',
    '2captcha',
    'capsolver',
    'local-ai',
    'unknown',
])

/** Minimal row shape used for aggregation (DB or test repo). */
export interface CaptchaMetricRowView {
    id: number
    captchaType: string
    provider: string
    success: boolean
    durationMs: number
    retryCount: number
    errorCode: string | null
    createdAt: Date | number | string
}

/** Injectable repository for unit tests / alternate stores. */
export interface CaptchaMetricsRepository {
    insert(row: {
        captchaType: CaptchaMetricType
        provider: CaptchaMetricProvider
        success: boolean
        durationMs: number
        retryCount: number
        errorCode: string | null
    }): CaptchaMetricRowView
    listAll(): CaptchaMetricRowView[]
    deleteAll(): number
    pruneOldest(keepMax: number): number
}

function createDbRepository(): CaptchaMetricsRepository {
    return {
        insert: insertCaptchaMetricRow,
        listAll: listCaptchaMetricRows,
        deleteAll: deleteAllCaptchaMetricRows,
        pruneOldest: pruneOldestCaptchaMetricRows,
    }
}

function insertCaptchaMetricRow(row: {
    captchaType: CaptchaMetricType
    provider: CaptchaMetricProvider
    success: boolean
    durationMs: number
    retryCount: number
    errorCode: string | null
}): CaptchaMetricRowView {
    const db = getDatabase()
    const inserted = db
        .insert(schema.captchaMetrics)
        .values({
            captchaType: row.captchaType,
            provider: row.provider,
            success: row.success,
            durationMs: row.durationMs,
            retryCount: row.retryCount,
            errorCode: row.errorCode,
        })
        .returning()
        .get()
    return toRowView(inserted)
}

function listCaptchaMetricRows(): CaptchaMetricRowView[] {
    const db = getDatabase()
    return db
        .select()
        .from(schema.captchaMetrics)
        .orderBy(desc(schema.captchaMetrics.createdAt), desc(schema.captchaMetrics.id))
        .all()
        .map(toRowView)
}

function deleteAllCaptchaMetricRows(): number {
    const db = getDatabase()
    const result = db.delete(schema.captchaMetrics).run()
    return Number(result.changes ?? 0)
}

function pruneOldestCaptchaMetricRows(keepMax: number): number {
    if (keepMax < 1) return 0
    const db = getDatabase()
    const allIds = db
        .select({ id: schema.captchaMetrics.id })
        .from(schema.captchaMetrics)
        .orderBy(asc(schema.captchaMetrics.createdAt), asc(schema.captchaMetrics.id))
        .all()
    if (allIds.length <= keepMax) return 0
    const excessIds = allIds.slice(0, allIds.length - keepMax).map((r) => r.id)
    if (excessIds.length === 0) return 0
    const result = db
        .delete(schema.captchaMetrics)
        .where(inArray(schema.captchaMetrics.id, excessIds))
        .run()
    return Number(result.changes ?? excessIds.length)
}

function toRowView(row: {
    id: number
    captchaType: string
    provider: string
    success: boolean
    durationMs: number
    retryCount: number
    errorCode: string | null
    createdAt: Date | number | string | null
}): CaptchaMetricRowView {
    return {
        id: row.id,
        captchaType: row.captchaType,
        provider: row.provider,
        success: !!row.success,
        durationMs: row.durationMs,
        retryCount: row.retryCount,
        errorCode: row.errorCode,
        createdAt: row.createdAt ?? new Date(),
    }
}

export function normalizeCaptchaType(raw: string): CaptchaMetricType {
    const key = raw.trim().toLowerCase() as CaptchaMetricType
    return KNOWN_TYPES.has(key) ? key : 'unknown'
}

export function normalizeCaptchaProvider(raw: string): CaptchaMetricProvider {
    const key = raw.trim().toLowerCase() as CaptchaMetricProvider
    return KNOWN_PROVIDERS.has(key) ? key : 'unknown'
}

export function sanitizeErrorCode(raw: string | null | undefined): string | null {
    if (raw == null) return null
    const trimmed = raw.replace(/\s+/g, ' ').trim()
    if (!trimmed) return null
    // Drop anything that looks like a token/key fragment.
    if (/api[_-]?key|token|secret|password|bearer\s/i.test(trimmed)) {
        return 'redacted'
    }
    return trimmed.slice(0, CAPTCHA_METRICS_ERROR_CODE_MAX)
}

export function clampDurationMs(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0
    return Math.min(Math.round(value), 3_600_000)
}

export function clampRetryCount(value: number | undefined): number {
    if (value == null || !Number.isFinite(value) || value < 0) return 0
    return Math.min(Math.round(value), 20)
}

function emptyBucket(): CaptchaMetricsBucket {
    return {
        attempts: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        averageDurationMs: 0,
    }
}

function rate(successes: number, attempts: number): number {
    if (attempts <= 0) return 0
    return Math.round((successes / attempts) * 10000) / 100
}

function avgDuration(sumMs: number, attempts: number): number {
    if (attempts <= 0) return 0
    return Math.round(sumMs / attempts)
}

function toIso(createdAt: Date | number | string): string {
    if (createdAt instanceof Date) return createdAt.toISOString()
    if (typeof createdAt === 'number') {
        // SQLite integer mode may be seconds or ms.
        const ms = createdAt < 1e12 ? createdAt * 1000 : createdAt
        return new Date(ms).toISOString()
    }
    const parsed = new Date(createdAt)
    return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

/** Pure aggregation — unit-tested without SQLite. */
export function buildCaptchaMetricsSnapshot(
    rows: CaptchaMetricRowView[],
    recentLimit: number = CAPTCHA_METRICS_RECENT_LIMIT,
): CaptchaMetricsSnapshot {
    if (rows.length === 0) return emptyCaptchaMetricsSnapshot()

    const totals: CaptchaMetricsTotals = {
        attempts: rows.length,
        successes: 0,
        failures: 0,
    }
    let durationSum = 0
    const byType: Record<string, CaptchaMetricsBucket & { _sumMs: number }> = {}
    const byProvider: Record<string, CaptchaMetricsBucket & { _sumMs: number }> = {}

    for (const row of rows) {
        accumulateTotals(totals, row.success, row.durationMs)
        durationSum += row.durationMs
        bumpBucket(byType, row.captchaType, row.success, row.durationMs)
        bumpBucket(byProvider, row.provider, row.success, row.durationMs)
    }

    finalizeBuckets(byType)
    finalizeBuckets(byProvider)

    const recentAttempts = selectRecent(rows, recentLimit)

    return {
        totals: {
            attempts: totals.attempts,
            successes: totals.successes,
            failures: totals.failures,
        },
        successRate: rate(totals.successes, totals.attempts),
        averageDurationMs: avgDuration(durationSum, totals.attempts),
        byType: stripInternal(byType),
        byProvider: stripInternal(byProvider),
        recentAttempts,
    }
}

function accumulateTotals(
    totals: CaptchaMetricsTotals,
    success: boolean,
    durationMs: number,
): void {
    void durationMs
    if (success) totals.successes += 1
    else totals.failures += 1
}

function bumpBucket(
    map: Record<string, CaptchaMetricsBucket & { _sumMs: number }>,
    key: string,
    success: boolean,
    durationMs: number,
): void {
    if (!map[key]) {
        map[key] = { ...emptyBucket(), _sumMs: 0 }
    }
    const bucket = map[key]
    bucket.attempts += 1
    if (success) bucket.successes += 1
    else bucket.failures += 1
    bucket._sumMs += durationMs
}

function finalizeBuckets(
    map: Record<string, CaptchaMetricsBucket & { _sumMs: number }>,
): void {
    for (const key of Object.keys(map)) {
        const b = map[key]
        b.successRate = rate(b.successes, b.attempts)
        b.averageDurationMs = avgDuration(b._sumMs, b.attempts)
    }
}

function stripInternal(
    map: Record<string, CaptchaMetricsBucket & { _sumMs: number }>,
): Record<string, CaptchaMetricsBucket> {
    const out: Record<string, CaptchaMetricsBucket> = {}
    for (const key of Object.keys(map)) {
        const { attempts, successes, failures, successRate, averageDurationMs } = map[key]
        out[key] = { attempts, successes, failures, successRate, averageDurationMs }
    }
    return out
}

function selectRecent(
    rows: CaptchaMetricRowView[],
    recentLimit: number,
): CaptchaRecentAttempt[] {
    const limit = Math.max(0, Math.min(recentLimit, CAPTCHA_METRICS_RECENT_LIMIT))
    const sorted = [...rows].sort((a, b) => {
        if (b.id !== a.id) return b.id - a.id
        return 0
    })
    return sorted.slice(0, limit).map((row) => ({
        id: row.id,
        captchaType: normalizeCaptchaType(row.captchaType),
        provider: normalizeCaptchaProvider(row.provider),
        success: row.success,
        durationMs: row.durationMs,
        retryCount: row.retryCount,
        errorCode: row.errorCode,
        createdAt: toIso(row.createdAt),
    }))
}

export class CaptchaMetricsService {
    private readonly repo: CaptchaMetricsRepository

    constructor(repo?: CaptchaMetricsRepository) {
        this.repo = repo ?? createDbRepository()
    }

    /**
     * Persist one solve attempt. Safe to call from solver paths later;
     * failures never throw to callers (logging only).
     */
    recordAttempt(input: CaptchaAttemptRecordInput): CaptchaMetricRowView | null {
        try {
            const row = this.repo.insert({
                captchaType: normalizeCaptchaType(input.captchaType),
                provider: normalizeCaptchaProvider(input.provider),
                success: !!input.success,
                durationMs: clampDurationMs(input.durationMs),
                retryCount: clampRetryCount(input.retryCount),
                errorCode: sanitizeErrorCode(input.errorCode),
            })
            this.safePrune()
            return row
        } catch (err) {
            console.error('[CaptchaMetricsService] recordAttempt failed:', err)
            return null
        }
    }

    getMetrics(): CaptchaMetricsSnapshot {
        try {
            const rows = this.repo.listAll()
            return buildCaptchaMetricsSnapshot(rows, CAPTCHA_METRICS_RECENT_LIMIT)
        } catch (err) {
            console.error('[CaptchaMetricsService] getMetrics failed:', err)
            return emptyCaptchaMetricsSnapshot()
        }
    }

    /**
     * Delete all stored metrics. Idempotent and safe when table is empty.
     */
    resetMetrics(): CaptchaMetricsResetResult {
        try {
            const deleted = this.repo.deleteAll()
            return { success: true, deleted }
        } catch (err) {
            console.error('[CaptchaMetricsService] resetMetrics failed:', err)
            return { success: false, deleted: 0 }
        }
    }

    private safePrune(): void {
        try {
            this.repo.pruneOldest(CAPTCHA_METRICS_MAX_ROWS)
        } catch (err) {
            console.error('[CaptchaMetricsService] prune failed:', err)
        }
    }
}

/** Production singleton (SQLite-backed via getDatabase). */
export const captchaMetricsService = new CaptchaMetricsService()

/** In-memory repository for unit tests (no native SQLite required). */
export function createMemoryCaptchaMetricsRepository(): CaptchaMetricsRepository {
    let seq = 0
    const rows: CaptchaMetricRowView[] = []

    return {
        insert(row) {
            seq += 1
            const created: CaptchaMetricRowView = {
                id: seq,
                captchaType: row.captchaType,
                provider: row.provider,
                success: row.success,
                durationMs: row.durationMs,
                retryCount: row.retryCount,
                errorCode: row.errorCode,
                createdAt: new Date(),
            }
            rows.push(created)
            return created
        },
        listAll() {
            return [...rows].sort((a, b) => b.id - a.id)
        },
        deleteAll() {
            const n = rows.length
            rows.length = 0
            return n
        },
        pruneOldest(keepMax) {
            if (rows.length <= keepMax) return 0
            rows.sort((a, b) => a.id - b.id)
            const excess = rows.length - keepMax
            rows.splice(0, excess)
            return excess
        },
    }
}
