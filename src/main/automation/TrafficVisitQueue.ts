/**
 * TrafficVisitQueue — durable per-visit claim/recovery for Traffic campaigns.
 *
 * Contract (schema.trafficVisitQueue fields):
 * id, campaignId, visitIndex, status, payload, attemptCount, maxAttempts,
 * workerId, claimedAt, leaseExpiresAt, availableAt, lastError, result,
 * createdAt, updatedAt — unique(campaignId, visitIndex).
 *
 * Uses the canonical Drizzle schema from src/main/database/schema.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import {
    trafficVisitQueue as trafficVisitQueueTable,
    type NewTrafficVisitQueueRow,
    type TrafficVisitQueueRow,
} from '../database/schema'
import {
    buildTrafficVisitId,
    computeTrafficVisitBackoffMs,
    DEFAULT_TRAFFIC_VISIT_LEASE_MS,
    DEFAULT_TRAFFIC_VISIT_MAX_ATTEMPTS,
    isTrafficVisitActive,
    isTrafficVisitClaimable,
    isTrafficVisitTerminal,
    parseTrafficVisitPayload,
    serializeTrafficVisitPayload,
    type TrafficVisitCampaignCounters,
    type TrafficVisitPayload,
    type TrafficVisitRecoverResult,
    type TrafficVisitRow,
    type TrafficVisitSeedItem,
    type TrafficVisitSeedResult,
    type TrafficVisitStatus,
    type TrafficVisitTransitionResult,
} from '../../shared/traffic-visit-contracts'

const EMPTY_COUNTERS = (): TrafficVisitCampaignCounters => ({
    total: 0,
    pending: 0,
    retry: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    remaining: 0,
})

/** Resident rows only. `retry` is claimable work, not history. */
const ACTIVE_VISIT_STATUSES: Array<'pending' | 'retry' | 'running'> = [
    'pending',
    'retry',
    'running',
]

const TERMINAL_VISIT_STATUSES: Array<'done' | 'failed' | 'cancelled'> = [
    'done',
    'failed',
    'cancelled',
]

interface TerminalCountBucket {
    done: number
    failed: number
    cancelled: number
}

function emptyTerminalBucket(): TerminalCountBucket {
    return { done: 0, failed: 0, cancelled: 0 }
}

function coerceSqlCount(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value ?? 0)
    return Number.isFinite(n) ? n : 0
}

function nowIso(now: Date = new Date()): string {
    return now.toISOString()
}

function cloneVisit(v: TrafficVisitRow): TrafficVisitRow {
    return { ...v }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'then' in value &&
        typeof (value as { then?: unknown }).then === 'function'
    )
}

function isVisitQueueRow(row: unknown): row is TrafficVisitQueueRow {
    if (row == null || typeof row !== 'object' || isThenable(row)) return false
    const candidate = row as {
        id?: unknown
        campaignId?: unknown
        visitIndex?: unknown
        status?: unknown
    }
    return (
        typeof candidate.id === 'string' &&
        typeof candidate.campaignId === 'number' &&
        typeof candidate.visitIndex === 'number' &&
        typeof candidate.status === 'string'
    )
}

function rowToVisit(row: TrafficVisitQueueRow): TrafficVisitRow {
    return {
        id: row.id,
        campaignId: row.campaignId,
        visitIndex: row.visitIndex,
        status: row.status as TrafficVisitStatus,
        payload: row.payload ?? null,
        attemptCount: row.attemptCount,
        maxAttempts: row.maxAttempts,
        workerId: row.workerId ?? null,
        claimedAt: row.claimedAt ?? null,
        leaseExpiresAt: row.leaseExpiresAt ?? null,
        availableAt: row.availableAt ?? null,
        lastError: row.lastError ?? null,
        result: row.result ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
}

export class TrafficVisitQueue {
    private visits: Map<string, TrafficVisitRow> = new Map()
    /** Status only — full terminal rows stay in SQLite, not in `visits`. */
    private terminalStatus: Map<string, TrafficVisitStatus> = new Map()
    /**
     * Terminal rows the sync driver could not read back.
     * Not part of `visits`, so claim/load stay limited to active work.
     */
    private evictedVisits: Map<string, TrafficVisitRow> = new Map()
    private evictedCounts: Map<number, TerminalCountBucket> = new Map()
    private loaded = false
    private loadPromise: Promise<void> | null = null
    private mutationTail: Promise<void> = Promise.resolve()
    private lastRecoveredCount = 0

    private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.mutationTail.then(fn, fn)
        this.mutationTail = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }

    async ensureLoaded(): Promise<void> {
        if (this.loaded) return
        if (!this.loadPromise) {
            this.loadPromise = this.loadFromDatabase().finally(() => {
                this.loadPromise = null
            })
        }
        await this.loadPromise
    }

    /**
     * Load claimable/in-flight rows only. Terminal history stays in SQLite.
     * Does NOT auto-requeue; call recoverExpiredLeases on boot/resume.
     */
    private async loadFromDatabase(): Promise<void> {
        try {
            const rows = await this.selectActiveVisitRows()
            this.visits.clear()
            this.terminalStatus.clear()
            this.evictedCounts.clear()
            this.evictedVisits.clear()
            for (const row of rows) {
                const visit = rowToVisit(row)
                if (!this.isResidentStatus(visit.status)) continue
                this.visits.set(visit.id, visit)
            }
            await this.loadEvictedCounts()
            this.loaded = true
            console.log(`[TrafficVisitQueue] Loaded ${this.visits.size} active visits from DB`)
        } catch (error) {
            console.error('[TrafficVisitQueue] Failed to load from database:', error)
            this.visits.clear()
            this.terminalStatus.clear()
            this.evictedCounts.clear()
            this.evictedVisits.clear()
            this.loaded = false
            throw error
        }
    }

    private isResidentStatus(status: TrafficVisitStatus): boolean {
        return status === 'pending' || status === 'retry' || status === 'running'
    }

    /** SQL filter when the driver supports it; otherwise drop terminal rows in memory. */
    private async selectActiveVisitRows(): Promise<TrafficVisitQueueRow[]> {
        const db = getDatabase()
        const query = db.select().from(trafficVisitQueueTable)
        const whereFn = (query as {
            where?: (clause: unknown) => {
                all: () => Promise<TrafficVisitQueueRow[]> | TrafficVisitQueueRow[]
            }
        }).where
        if (typeof whereFn === 'function') {
            const filtered = whereFn.call(
                query,
                inArray(trafficVisitQueueTable.status, ACTIVE_VISIT_STATUSES),
            )
            return await filtered.all()
        }
        const rows = await (query as {
            all: () => Promise<TrafficVisitQueueRow[]> | TrafficVisitQueueRow[]
        }).all()
        return rows.filter((row) =>
            row.status === 'pending' || row.status === 'retry' || row.status === 'running',
        )
    }

    /** Count done/failed/cancelled without materializing those rows. */
    private async loadEvictedCounts(): Promise<void> {
        const db = getDatabase()
        const query = db
            .select({
                campaignId: trafficVisitQueueTable.campaignId,
                status: trafficVisitQueueTable.status,
                count: sql<number>`count(*)`,
            })
            .from(trafficVisitQueueTable)
        const whereFn = (query as {
            where?: (clause: unknown) => {
                groupBy: (...cols: unknown[]) => {
                    all: () => Array<{ campaignId: number; status: string; count: unknown }>
                        | Promise<Array<{ campaignId: number; status: string; count: unknown }>>
                }
            }
        }).where
        if (typeof whereFn !== 'function') return
        let rows: Array<{ campaignId: number; status: string; count: unknown }>
        try {
            const grouped = whereFn
                .call(query, inArray(trafficVisitQueueTable.status, TERMINAL_VISIT_STATUSES))
                .groupBy(trafficVisitQueueTable.campaignId, trafficVisitQueueTable.status)
            rows = await grouped.all()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/is not a function/i.test(message)) return
            throw error
        }
        for (const row of rows) {
            this.addEvictedCount(row.campaignId, row.status, coerceSqlCount(row.count))
        }
    }

    private addEvictedCount(campaignId: number, status: string, amount: number): void {
        if (!Number.isFinite(amount) || amount === 0) return
        const bucket = this.evictedCounts.get(campaignId) ?? emptyTerminalBucket()
        if (status === 'done') bucket.done += amount
        else if (status === 'failed') bucket.failed += amount
        else if (status === 'cancelled') bucket.cancelled += amount
        else return
        this.evictedCounts.set(campaignId, bucket)
    }

    /** Drop a persisted terminal row from the active map and remember status for idempotent replays. */
    private releaseTerminalVisit(visit: TrafficVisitRow): void {
        if (!isTrafficVisitTerminal(visit.status)) return
        this.terminalStatus.set(visit.id, visit.status)
        this.addEvictedCount(visit.campaignId, visit.status, 1)
        this.visits.delete(visit.id)
        if (this.readVisitFromDatabase(visit.id)) {
            this.evictedVisits.delete(visit.id)
            return
        }
        // Sync read missed (test double or driver error). Do not put the row back in `visits`.
        this.evictedVisits.set(visit.id, cloneVisit(visit))
    }

    /** Point read. Never inserts into `visits`. */
    private readVisitFromDatabase(visitId: string): TrafficVisitRow | undefined {
        try {
            const db = getDatabase()
            const row = db
                .select()
                .from(trafficVisitQueueTable)
                .where(eq(trafficVisitQueueTable.id, visitId))
                .get()
            if (!isVisitQueueRow(row)) {
                if (isThenable(row)) {
                    void Promise.resolve(row).then(
                        () => undefined,
                        () => undefined,
                    )
                }
                return undefined
            }
            return rowToVisit(row)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/is not a function/i.test(message)) return undefined
            console.error(`[TrafficVisitQueue] SQLite visit lookup failed for ${visitId}:`, error)
            return undefined
        }
    }

    private rememberedVisitResult(
        visitId: string,
        op: 'complete' | 'fail' | 'cancel',
    ): TrafficVisitTransitionResult | null {
        const status = this.terminalStatus.get(visitId)
        if (!status) return null
        if (op === 'complete' && status === 'done') {
            return { applied: true, status: 'done', reason: 'already_done' }
        }
        if (op === 'fail' && status === 'failed') {
            return { applied: true, status: 'failed', reason: 'already_failed' }
        }
        if (op === 'cancel' && status === 'cancelled') {
            return { applied: true, status: 'cancelled', reason: 'already_cancelled' }
        }
        return { applied: false, status, reason: `blocked_by_${status}` }
    }

    private async persistVisit(visit: TrafficVisitRow): Promise<void> {
        const db = getDatabase()
        const values: NewTrafficVisitQueueRow = {
            id: visit.id,
            campaignId: visit.campaignId,
            visitIndex: visit.visitIndex,
            status: visit.status,
            payload: visit.payload,
            attemptCount: visit.attemptCount,
            maxAttempts: visit.maxAttempts,
            workerId: visit.workerId,
            claimedAt: visit.claimedAt,
            leaseExpiresAt: visit.leaseExpiresAt,
            availableAt: visit.availableAt,
            lastError: visit.lastError,
            result: visit.result,
            createdAt: visit.createdAt,
            updatedAt: visit.updatedAt,
        }
        await db
            .insert(trafficVisitQueueTable)
            .values(values)
            .onConflictDoUpdate({
                target: trafficVisitQueueTable.id,
                set: {
                    status: values.status,
                    payload: values.payload,
                    attemptCount: values.attemptCount,
                    maxAttempts: values.maxAttempts,
                    workerId: values.workerId,
                    claimedAt: values.claimedAt,
                    leaseExpiresAt: values.leaseExpiresAt,
                    availableAt: values.availableAt,
                    lastError: values.lastError,
                    result: values.result,
                    updatedAt: values.updatedAt,
                },
            })
    }

    private async insertVisitIgnoreConflict(visit: TrafficVisitRow): Promise<boolean> {
        const db = getDatabase()
        const values: NewTrafficVisitQueueRow = {
            id: visit.id,
            campaignId: visit.campaignId,
            visitIndex: visit.visitIndex,
            status: visit.status,
            payload: visit.payload,
            attemptCount: visit.attemptCount,
            maxAttempts: visit.maxAttempts,
            workerId: visit.workerId,
            claimedAt: visit.claimedAt,
            leaseExpiresAt: visit.leaseExpiresAt,
            availableAt: visit.availableAt,
            lastError: visit.lastError,
            result: visit.result,
            createdAt: visit.createdAt,
            updatedAt: visit.updatedAt,
        }
        try {
            await db.insert(trafficVisitQueueTable).values(values)
            return true
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (/unique|constraint|UNIQUE/i.test(msg)) {
                return false
            }
            throw error
        }
    }

    /**
     * Idempotent seed: one row per (campaignId, visitIndex). Existing rows untouched.
     */
    async seedCampaign(
        campaignId: number,
        items: TrafficVisitSeedItem[],
        defaults?: { maxAttempts?: number },
    ): Promise<TrafficVisitSeedResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            let seeded = 0
            let skippedExisting = 0
            const maxDefault = defaults?.maxAttempts ?? DEFAULT_TRAFFIC_VISIT_MAX_ATTEMPTS
            const ts = nowIso()

            for (const item of items) {
                const id = buildTrafficVisitId(campaignId, item.visitIndex)
                if (this.visits.has(id) || this.terminalStatus.has(id)) {
                    skippedExisting++
                    continue
                }
                const visit: TrafficVisitRow = {
                    id,
                    campaignId,
                    visitIndex: item.visitIndex,
                    status: 'pending',
                    payload: serializeTrafficVisitPayload(item.payload),
                    attemptCount: 0,
                    maxAttempts: item.maxAttempts ?? maxDefault,
                    workerId: null,
                    claimedAt: null,
                    leaseExpiresAt: null,
                    availableAt: null,
                    lastError: null,
                    result: null,
                    createdAt: ts,
                    updatedAt: ts,
                }
                const inserted = await this.insertVisitIgnoreConflict(visit)
                if (!inserted) {
                    skippedExisting++
                    continue
                }
                this.visits.set(id, visit)
                seeded++
            }

            console.log(
                `[TrafficVisitQueue] Seed campaign ${campaignId}: +${seeded} ` +
                    `(skipped ${skippedExisting}, target ${items.length})`,
            )
            return { seeded, skippedExisting, total: items.length }
        })
    }

    private isAvailableNow(visit: TrafficVisitRow, now: Date): boolean {
        if (!isTrafficVisitClaimable(visit.status)) return false
        if (!visit.availableAt) return true
        return new Date(visit.availableAt).getTime() <= now.getTime()
    }

    /**
     * Location IDs currently held by running visits in this campaign.
     * Unparseable payloads are ignored (no location to exclude).
     */
    private collectRunningLocationIds(campaignId: number): Set<number> {
        const ids = new Set<number>()
        for (const visit of Array.from(this.visits.values())) {
            if (visit.campaignId !== campaignId) continue
            if (visit.status !== 'running') continue
            const payload = parseTrafficVisitPayload(visit.payload)
            if (payload) ids.add(payload.locationId)
        }
        return ids
    }

    /**
     * Next claimable visit by visitIndex. Candidates whose payload.locationId
     * is in disallowedLocationIds are skipped (same-location mutual exclusion).
     * Returns null when every due candidate is disallowed so the worker can wait.
     */
    private findClaimable(
        campaignId: number,
        now: Date,
        disallowedLocationIds?: Set<number>,
    ): TrafficVisitRow | null {
        const candidates: TrafficVisitRow[] = []
        for (const visit of Array.from(this.visits.values())) {
            if (visit.campaignId !== campaignId) continue
            if (!this.isAvailableNow(visit, now)) continue
            if (disallowedLocationIds && disallowedLocationIds.size > 0) {
                const payload = parseTrafficVisitPayload(visit.payload)
                if (payload && disallowedLocationIds.has(payload.locationId)) continue
            }
            candidates.push(visit)
        }
        candidates.sort((a, b) => {
            if (a.visitIndex !== b.visitIndex) return a.visitIndex - b.visitIndex
            return a.createdAt.localeCompare(b.createdAt)
        })
        return candidates[0] ?? null
    }

    /**
     * Atomic claim: pending|retry → running under mutex.
     * Persist before return; on persist failure roll back memory and rethrow.
     * When disallowRunningLocations is true, also exclude locations that already
     * have a running visit in this campaign (merged with disallowedLocationIds).
     */
    async claimNextVisit(
        campaignId: number,
        workerId: string,
        leaseMs: number = DEFAULT_TRAFFIC_VISIT_LEASE_MS,
        now: Date = new Date(),
        options?: {
            disallowRunningLocations?: boolean
            disallowedLocationIds?: Set<number>
        },
    ): Promise<TrafficVisitRow | null> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const disallowedLocationIds = new Set<number>(options?.disallowedLocationIds)
            if (options?.disallowRunningLocations) {
                for (const locationId of Array.from(this.collectRunningLocationIds(campaignId))) {
                    disallowedLocationIds.add(locationId)
                }
            }
            const visit = this.findClaimable(
                campaignId,
                now,
                disallowedLocationIds.size > 0 ? disallowedLocationIds : undefined,
            )
            if (!visit) return null
            if (!isTrafficVisitClaimable(visit.status)) return null

            const snapshot = cloneVisit(visit)
            const ts = nowIso(now)
            const lease = Math.max(1_000, Math.floor(leaseMs))
            visit.status = 'running'
            visit.workerId = workerId
            visit.claimedAt = ts
            visit.leaseExpiresAt = new Date(now.getTime() + lease).toISOString()
            visit.availableAt = null
            visit.attemptCount = visit.attemptCount + 1
            visit.updatedAt = ts

            try {
                await this.persistVisit(visit)
            } catch (error) {
                this.visits.set(visit.id, snapshot)
                console.error(
                    `[TrafficVisitQueue] claimNextVisit persist failed for ${visit.id}; rolled back:`,
                    error,
                )
                throw error
            }

            console.log(
                `[TrafficVisitQueue] Claimed ${visit.id} by ${workerId} ` +
                    `(attempt ${visit.attemptCount}/${visit.maxAttempts})`,
            )
            return cloneVisit(visit)
        })
    }

    /** Resource backpressure is not a failed attempt; retain durable work for later. */
    async deferRunningVisit(visitId: string, now: Date = new Date()): Promise<boolean> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const visit = this.visits.get(visitId)
            if (!visit || visit.status !== 'running') return false
            const snapshot = cloneVisit(visit)
            visit.status = 'retry'
            visit.workerId = null
            visit.claimedAt = null
            visit.leaseExpiresAt = null
            visit.availableAt = new Date(now.getTime() + 5000).toISOString()
            visit.attemptCount = Math.max(0, visit.attemptCount - 1)
            visit.updatedAt = nowIso(now)
            try {
                await this.persistVisit(visit)
            } catch (error) {
                this.visits.set(visit.id, snapshot)
                throw error
            }
            return true
        })
    }

    async completeVisit(
        visitId: string,
        result?: unknown,
    ): Promise<TrafficVisitTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const visit = this.visits.get(visitId)
            if (!visit) {
                return this.rememberedVisitResult(visitId, 'complete')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (visit.status === 'done') {
                return { applied: true, status: 'done', reason: 'already_done' }
            }
            if (isTrafficVisitTerminal(visit.status)) {
                return { applied: false, status: visit.status, reason: `blocked_by_${visit.status}` }
            }
            if (visit.status !== 'running') {
                return { applied: false, status: visit.status, reason: `invalid_from_${visit.status}` }
            }

            const snapshot = cloneVisit(visit)
            const ts = nowIso()
            visit.status = 'done'
            visit.result = result !== undefined ? JSON.stringify(result) : visit.result
            visit.workerId = null
            visit.claimedAt = null
            visit.leaseExpiresAt = null
            visit.updatedAt = ts

            try {
                await this.persistVisit(visit)
            } catch (error) {
                this.visits.set(visitId, snapshot)
                throw error
            }
            this.releaseTerminalVisit(visit)
            return { applied: true, status: 'done' }
        })
    }

    /**
     * Fail running visit: bounded retry with backoff → status=retry, or permanent failed.
     * Never overwrites terminal. Persist rollback on failure.
     */
    async failVisit(
        visitId: string,
        error: string,
        opts?: {
            permanent?: boolean
            immediateRetry?: boolean
            mergePayload?: Partial<TrafficVisitPayload>
            now?: Date
        },
    ): Promise<TrafficVisitTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const visit = this.visits.get(visitId)
            if (!visit) {
                return this.rememberedVisitResult(visitId, 'fail')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (visit.status === 'failed') {
                return { applied: true, status: 'failed', reason: 'already_failed' }
            }
            if (isTrafficVisitTerminal(visit.status)) {
                return { applied: false, status: visit.status, reason: `blocked_by_${visit.status}` }
            }
            if (visit.status !== 'running') {
                return { applied: false, status: visit.status, reason: `invalid_from_${visit.status}` }
            }
            return this.applyFailTransition(visit, error, opts)
        })
    }

    private async applyFailTransition(
        visit: TrafficVisitRow,
        error: string,
        opts?: {
            permanent?: boolean
            immediateRetry?: boolean
            mergePayload?: Partial<TrafficVisitPayload>
            now?: Date
        },
    ): Promise<TrafficVisitTransitionResult> {
        const snapshot = cloneVisit(visit)
        const now = opts?.now ?? new Date()
        const ts = nowIso(now)
        visit.lastError = error
        visit.workerId = null
        visit.claimedAt = null
        visit.leaseExpiresAt = null
        visit.updatedAt = ts
        if (opts?.mergePayload) {
            visit.payload = this.mergePayloadJson(visit.payload, opts.mergePayload)
        }
        const canRetry = !opts?.permanent && visit.attemptCount < visit.maxAttempts
        if (canRetry) {
            const backoff = opts?.immediateRetry
                ? 0
                : computeTrafficVisitBackoffMs(visit.attemptCount)
            visit.status = 'retry'
            visit.availableAt = new Date(now.getTime() + backoff).toISOString()
            visit.result = null
        } else {
            visit.status = 'failed'
            visit.availableAt = null
        }
        try {
            await this.persistVisit(visit)
        } catch (persistError) {
            this.visits.set(visit.id, snapshot)
            throw persistError
        }
        this.releaseTerminalVisit(visit)
        return { applied: true, status: visit.status }
    }

    private mergePayloadJson(
        raw: string | null,
        partial: Partial<TrafficVisitPayload>,
    ): string {
        let base: Record<string, unknown> = {}
        if (raw) {
            try {
                const parsed: unknown = JSON.parse(raw)
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    base = { ...(parsed as Record<string, unknown>) }
                }
            } catch {
                base = {}
            }
        }
        return JSON.stringify({ ...base, ...partial })
    }

    async cancelVisit(visitId: string): Promise<TrafficVisitTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const visit = this.visits.get(visitId)
            if (!visit) {
                return this.rememberedVisitResult(visitId, 'cancel')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (visit.status === 'cancelled') {
                return { applied: true, status: 'cancelled', reason: 'already_cancelled' }
            }
            if (visit.status === 'done' || visit.status === 'failed') {
                return { applied: false, status: visit.status, reason: `blocked_by_${visit.status}` }
            }
            if (!isTrafficVisitActive(visit.status)) {
                return { applied: false, status: visit.status, reason: `invalid_from_${visit.status}` }
            }

            const snapshot = cloneVisit(visit)
            const ts = nowIso()
            visit.status = 'cancelled'
            visit.workerId = null
            visit.claimedAt = null
            visit.leaseExpiresAt = null
            visit.availableAt = null
            visit.updatedAt = ts

            try {
                await this.persistVisit(visit)
            } catch (error) {
                this.visits.set(visitId, snapshot)
                throw error
            }
            this.releaseTerminalVisit(visit)
            return { applied: true, status: 'cancelled' }
        })
    }

    async cancelCampaignVisits(campaignId: number): Promise<number> {
        await this.ensureLoaded()
        const ids = Array.from(this.visits.values())
            .filter((v) => v.campaignId === campaignId && isTrafficVisitActive(v.status))
            .map((v) => v.id)
        let cancelled = 0
        for (const id of ids) {
            const result = await this.cancelVisit(id)
            // Count only first cancel transition (not already_cancelled / blocked).
            if (result.applied && result.status === 'cancelled' && result.reason == null) {
                cancelled++
            }
        }
        return cancelled
    }

    /** Campaign has no pending/retry/running work left. */
    isCampaignFullyTerminal(campaignId: number): boolean {
        return this.getCampaignCounters(campaignId).remaining === 0
    }

    /**
     * Pause semantics: release in-flight running visits back to retry without
     * consuming extra attempt budget (attemptCount decremented by 1, floor 0).
     */
    async releaseRunningForPause(campaignId: number, now: Date = new Date()): Promise<number> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            let released = 0
            const ts = nowIso(now)
            for (const visit of Array.from(this.visits.values())) {
                if (visit.campaignId !== campaignId || visit.status !== 'running') continue
                const snapshot = cloneVisit(visit)
                visit.status = 'retry'
                visit.workerId = null
                visit.claimedAt = null
                visit.leaseExpiresAt = null
                visit.availableAt = ts
                visit.attemptCount = Math.max(0, visit.attemptCount - 1)
                visit.updatedAt = ts
                try {
                    await this.persistVisit(visit)
                    released++
                } catch (error) {
                    this.visits.set(visit.id, snapshot)
                    throw error
                }
            }
            return released
        })
    }

    /**
     * Recover expired running leases → retry (available immediately).
     * Call on boot / resume. Does not touch terminals.
     */
    async recoverExpiredLeases(
        campaignId?: number,
        now: Date = new Date(),
    ): Promise<TrafficVisitRecoverResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            let requeued = 0
            const campaignIds = new Set<number>()
            const ts = nowIso(now)
            const nowMs = now.getTime()

            for (const visit of Array.from(this.visits.values())) {
                if (campaignId != null && visit.campaignId !== campaignId) continue
                if (visit.status !== 'running') continue
                const leaseEnd = visit.leaseExpiresAt
                    ? new Date(visit.leaseExpiresAt).getTime()
                    : 0
                if (leaseEnd > nowMs) continue

                const snapshot = cloneVisit(visit)
                visit.status = 'retry'
                visit.workerId = null
                visit.claimedAt = null
                visit.leaseExpiresAt = null
                visit.availableAt = ts
                visit.lastError = visit.lastError ?? 'lease_expired'
                visit.updatedAt = ts
                try {
                    await this.persistVisit(visit)
                } catch (error) {
                    this.visits.set(visit.id, snapshot)
                    throw error
                }
                requeued++
                campaignIds.add(visit.campaignId)
            }

            this.lastRecoveredCount = requeued
            if (requeued > 0) {
                console.log(
                    `[TrafficVisitQueue] Recovered ${requeued} expired lease(s)` +
                        (campaignId != null ? ` for campaign ${campaignId}` : ''),
                )
            }
            return { requeued, campaignIds: Array.from(campaignIds) }
        })
    }

    getCampaignCounters(campaignId: number): TrafficVisitCampaignCounters {
        const counters = EMPTY_COUNTERS()
        for (const visit of Array.from(this.visits.values())) {
            if (visit.campaignId !== campaignId) continue
            counters.total++
            switch (visit.status) {
                case 'pending':
                    counters.pending++
                    break
                case 'retry':
                    counters.retry++
                    break
                case 'running':
                    counters.running++
                    break
                case 'done':
                    counters.done++
                    break
                case 'failed':
                    counters.failed++
                    break
                case 'cancelled':
                    counters.cancelled++
                    break
            }
        }
        const evicted = this.evictedCounts.get(campaignId)
        if (evicted) {
            counters.done += evicted.done
            counters.failed += evicted.failed
            counters.cancelled += evicted.cancelled
            counters.total += evicted.done + evicted.failed + evicted.cancelled
        }
        counters.remaining = counters.pending + counters.retry + counters.running
        return counters
    }

    /** Completed (`done`) visits from SQLite, not the in-memory map. */
    getCompletedCount(): number {
        try {
            const db = getDatabase()
            const row = db
                .select({ count: sql<number>`count(*)` })
                .from(trafficVisitQueueTable)
                .where(eq(trafficVisitQueueTable.status, 'done'))
                .get()
            return coerceSqlCount(row?.count)
        } catch (error) {
            console.error('[TrafficVisitQueue] getCompletedCount failed:', error)
            return 0
        }
    }

    getVisit(visitId: string): TrafficVisitRow | undefined {
        const resident = this.visits.get(visitId)
        if (resident) return cloneVisit(resident)
        const persisted = this.readVisitFromDatabase(visitId)
        if (persisted) return persisted
        const evicted = this.evictedVisits.get(visitId)
        return evicted ? cloneVisit(evicted) : undefined
    }

    getCampaignVisits(campaignId: number): TrafficVisitRow[] {
        return Array.from(this.visits.values())
            .filter((v) => v.campaignId === campaignId)
            .map(cloneVisit)
            .sort((a, b) => a.visitIndex - b.visitIndex)
    }

    getLastRecoveredCount(): number {
        return this.lastRecoveredCount
    }

    isLoaded(): boolean {
        return this.loaded
    }

    markLoadedForTests(): void {
        this.loaded = true
        this.loadPromise = null
        this.lastRecoveredCount = 0
    }

    /** Test helper: inject a visit without DB (requires markLoadedForTests). */
    putVisitForTests(visit: TrafficVisitRow): void {
        this.visits.set(visit.id, cloneVisit(visit))
    }

    clearAllForTests(): void {
        this.visits.clear()
        this.terminalStatus.clear()
        this.evictedCounts.clear()
        this.evictedVisits.clear()
        this.loaded = false
        this.loadPromise = null
        this.lastRecoveredCount = 0
        this.mutationTail = Promise.resolve()
    }
}

/**
 * Build deterministic seed items: visitIndex covers all location×round slots.
 * Order matches legacy TrafficBoostEngine: rounds outer, locations inner.
 */
export function buildTrafficVisitSeedItems(params: {
    locations: Array<{ id: number }>
    accountIds: Array<number | null>
    visitsPerLocation: number
    requestedActions: number
    maxAttempts?: number
}): TrafficVisitSeedItem[] {
    const { locations, accountIds, visitsPerLocation, requestedActions, maxAttempts } = params
    if (locations.length === 0 || visitsPerLocation <= 0) return []
    const pool = accountIds.length > 0 ? accountIds : [null]
    const items: TrafficVisitSeedItem[] = []
    let visitIndex = 0
    for (let round = 1; round <= visitsPerLocation; round++) {
        for (let li = 0; li < locations.length; li++) {
            const accountId = pool[visitIndex % pool.length] ?? null
            items.push({
                visitIndex,
                maxAttempts,
                payload: {
                    locationId: locations[li].id,
                    accountId,
                    round,
                    requestedActions,
                    forceDirectConnection: false,
                    proxyRetryCount: 0,
                    watchdogRetryCount: 0,
                },
            })
            visitIndex++
        }
    }
    return items
}

export { TrafficVisitQueue as default }
export const trafficVisitQueue = new TrafficVisitQueue()
