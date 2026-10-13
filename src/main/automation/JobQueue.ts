/**
 * JobQueue - Durable Smart Queue Manager for Automation Jobs
 *
 * Features:
 * - Per-account job queues
 * - Priority support
 * - Daily limit enforcement
 * - Persistent state via job_queue table (survives app restart/crash)
 * - Safe crash recovery: running → pending on load; never re-runs done jobs
 * - Atomic terminal transitions: stale complete/fail cannot overwrite cancelled/done
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq, and, gte, sql, inArray } from 'drizzle-orm'

export type JobType = 'review' | 'traffic'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
    id: string
    campaignId?: number
    type: JobType
    accountId: number
    locationId: number
    reviewText?: string
    rating?: number
    targetViews?: number
    priority: number
    status: JobStatus
    retryCount: number
    maxRetries: number
    result?: string
    error?: string
    createdAt: string
    startedAt?: string
    completedAt?: string
}

export interface JobQueueConfig {
    maxRetriesPerJob: number
    maxReviewsPerAccountPerDay: number
    maxTrafficPerAccountPerDay: number
}

export interface JobTransitionResult {
    applied: boolean
    status: JobStatus | null
    reason?: string
}

/** Optional filters for peek/claim. Omitted fields keep the historical selection rules. */
export interface JobClaimOptions {
    /**
     * Review jobs whose locationId is in this list are not eligible.
     * Used for cross-account cooldown so a hot location is skipped, not failed.
     * Traffic jobs are unaffected.
     */
    disallowRecentlyReviewedLocations?: number[]
}

const DEFAULT_CONFIG: JobQueueConfig = {
    maxRetriesPerJob: 3,
    maxReviewsPerAccountPerDay: 5,
    maxTrafficPerAccountPerDay: 50,
}

/** Statuses that must not be re-enqueued as new work (including completed/failed). */
const BLOCKING_STATUSES: JobStatus[] = ['pending', 'running', 'done', 'failed']

/** Immutable terminals: history kept; no async overwrite allowed. */
const IMMUTABLE_TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'cancelled'])

/** Mutable job fields + membership flags snapshotted before persist-bound transitions. */
interface JobMutationSnapshot {
    status: JobStatus
    retryCount: number
    error: string | undefined
    result: string | undefined
    startedAt: string | undefined
    completedAt: string | undefined
    inRunning: boolean
    inHidden: boolean
    /** Index in accountQueues, or -1 if absent. */
    queueIndex: number
    /** False when this mutation adopted a terminal row that was not in `jobs`. */
    wasResident: boolean
    /** True when adopting subtracted a visible terminal counter that rollback must restore. */
    restoreTerminalCount: boolean
}

export function isImmutableTerminalStatus(status: JobStatus): boolean {
    return IMMUTABLE_TERMINAL.has(status)
}

export function isActiveJobStatus(status: JobStatus): boolean {
    return status === 'pending' || status === 'running'
}

function isTerminalJobStatus(status: string): status is 'done' | 'failed' | 'cancelled' {
    return status === 'done' || status === 'failed' || status === 'cancelled'
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'then' in value &&
        typeof (value as { then?: unknown }).then === 'function'
    )
}

/**
 * Local calendar day start (00:00:00.000 machine timezone).
 * Matches ReviewService.getAccountReviewsToday / getToday semantics.
 * Exported for unit tests (timezone boundary).
 */
export function getLocalDayStart(now: Date = new Date()): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

class JobQueue {
    private config: JobQueueConfig = DEFAULT_CONFIG
    private jobs: Map<string, Job> = new Map()
    private accountQueues: Map<number, string[]> = new Map()
    private runningJobs: Set<string> = new Set()
    private hiddenTerminalJobs: Set<string> = new Set()
    /** Status-only index for jobs removed from `jobs` after a terminal persist. */
    private terminalStatus: Map<string, JobStatus> = new Map()
    /**
     * Terminal job objects the sync driver could not read back.
     * Kept out of `jobs` so scheduling stays on active work only.
     */
    private archivedJobs: Map<string, Job> = new Map()
    /** `${campaignId}|${accountId}:${locationId}` for done/failed rows not kept in RAM. */
    private blockingPairs: Set<string> = new Set()
    private terminalCounts: Map<string, { done: number; failed: number; cancelled: number }> = new Map()
    private loaded = false
    private loadPromise: Promise<void> | null = null
    /** Serializes status mutations so check+set+persist is atomic vs concurrent async. */
    private mutationTail: Promise<void> = Promise.resolve()
    private lastRequeuedRunningCount = 0

    /**
     * Run fn exclusively against in-memory job status (and its persist).
     * Previous failures do not block the next mutation.
     */
    private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.mutationTail.then(fn, fn)
        this.mutationTail = run.then(
            () => undefined,
            () => undefined
        )
        return run
    }

    /**
     * Ensure durable rows are loaded (safe to call multiple times).
     * True single-flight: concurrent callers share one loadPromise.
     * On DB failure: loaded stays false and error is rethrown (never fake empty queue).
     */
    async ensureLoaded(): Promise<void> {
        if (this.loaded) return
        if (!this.loadPromise) {
            this.loadPromise = this.loadFromDatabase().finally(() => {
                this.loadPromise = null
            })
        }
        await this.loadPromise
    }

    async loadConfig(): Promise<void> {
        try {
            const db = getDatabase()
            const settings = await db.select().from(schema.settings).all()

            const getValue = (key: string, defaultVal: number): number => {
                const setting = settings.find(s => s.key === key)
                return setting ? parseInt(setting.value) || defaultVal : defaultVal
            }

            this.config = {
                maxRetriesPerJob: getValue('max_retries_per_job', 3),
                maxReviewsPerAccountPerDay: getValue('max_reviews_per_day', 5),
                maxTrafficPerAccountPerDay: getValue('traffic_per_account_day', 50),
            }

            console.log('[JobQueue] Config loaded:', this.config)
        } catch (error) {
            console.error('[JobQueue] Failed to load config:', error)
        }
    }

    /**
     * Load pending/running jobs only. Terminal history stays in SQLite.
     * Convert in-progress (running) → pending safely. Never requeues done/cancelled.
     * On failure: reset in-memory state, leave loaded=false, rethrow.
     */
    private async loadFromDatabase(): Promise<void> {
        try {
            const partition = await this.selectRowsForLoad()
            this.resetMemoryIndexes()

            let requeued = 0
            for (const row of partition.active) {
                const job = this.rowToJob(row)
                if (!isActiveJobStatus(job.status)) continue
                if (job.status === 'running') {
                    job.status = 'pending'
                    job.startedAt = undefined
                    requeued++
                    await this.persistJob(job)
                }
                this.indexJob(job)
            }
            for (const row of partition.terminal) {
                this.rememberLoadedTerminal(this.rowToJob(row))
            }

            await this.loadTerminalJobIndexes()
            this.lastRequeuedRunningCount = requeued
            this.loaded = true
            console.log(
                `[JobQueue] Loaded ${this.jobs.size} active jobs from DB` +
                (requeued > 0 ? ` (requeued ${requeued} in-progress → pending)` : '')
            )
        } catch (error) {
            console.error('[JobQueue] Failed to load from database:', error)
            this.resetMemoryIndexes()
            this.lastRequeuedRunningCount = 0
            this.loaded = false
            throw error
        }
    }

    private resetMemoryIndexes(): void {
        this.jobs.clear()
        this.accountQueues.clear()
        this.runningJobs.clear()
        this.hiddenTerminalJobs.clear()
        this.terminalStatus.clear()
        this.archivedJobs.clear()
        this.blockingPairs.clear()
        this.terminalCounts.clear()
    }

    /**
     * Active rows for the resident map. Terminal rows are returned only when the
     * query builder cannot filter (test doubles); a real driver keeps them in SQLite.
     */
    private async selectRowsForLoad(): Promise<{
        active: schema.JobQueueEntry[]
        terminal: schema.JobQueueEntry[]
    }> {
        const db = getDatabase()
        const query = db.select().from(schema.jobQueueEntries)
        const whereFn = (query as {
            where?: (clause: unknown) => {
                all: () => Promise<schema.JobQueueEntry[]> | schema.JobQueueEntry[]
                groupBy?: unknown
            }
        }).where

        const partition = (rows: schema.JobQueueEntry[]) => ({
            active: rows.filter((row) => row.status === 'pending' || row.status === 'running'),
            terminal: rows.filter((row) => isTerminalJobStatus(row.status)),
        })

        if (typeof whereFn === 'function') {
            const filtered = whereFn.call(
                query,
                inArray(schema.jobQueueEntries.status, ['pending', 'running']),
            )
            // Drizzle's builder has groupBy. A stub `where()` that ignores the clause does not.
            if (typeof filtered.groupBy === 'function') {
                const rows = await filtered.all()
                return { active: rows, terminal: [] }
            }
        }

        const rows = await (query as {
            all: () => Promise<schema.JobQueueEntry[]> | schema.JobQueueEntry[]
        }).all()
        return partition(rows)
    }

    /** Compact done/failed keys + counts. Full terminal job objects are not loaded. */
    private async loadTerminalJobIndexes(): Promise<void> {
        await this.loadBlockingPairs()
        await this.loadTerminalJobCounts()
    }

    private async loadBlockingPairs(): Promise<void> {
        const db = getDatabase()
        const query = db.select({
            campaignId: schema.jobQueueEntries.campaignId,
            accountId: schema.jobQueueEntries.accountId,
            locationId: schema.jobQueueEntries.locationId,
        }).from(schema.jobQueueEntries)
        const whereFn = (query as {
            where?: (clause: unknown) => {
                all: () => Promise<Array<{
                    campaignId: number | null
                    accountId: number
                    locationId: number
                }>> | Array<{
                    campaignId: number | null
                    accountId: number
                    locationId: number
                }>
            }
        }).where
        if (typeof whereFn !== 'function') return
        let rows: Array<{ campaignId: number | null; accountId: number; locationId: number }>
        try {
            rows = await whereFn.call(
                query,
                inArray(schema.jobQueueEntries.status, ['done', 'failed']),
            ).all()
        } catch (error) {
            if (this.isMissingQueryMethod(error)) return
            throw error
        }
        for (const row of rows) {
            if (row.campaignId == null) continue
            this.blockingPairs.add(this.blockingToken(row.campaignId, row.accountId, row.locationId))
        }
    }

    private async loadTerminalJobCounts(): Promise<void> {
        const db = getDatabase()
        const query = db.select({
            campaignId: schema.jobQueueEntries.campaignId,
            status: schema.jobQueueEntries.status,
            count: sql<number>`count(*)`,
        }).from(schema.jobQueueEntries)
        const whereFn = (query as {
            where?: (clause: unknown) => {
                groupBy: (...cols: unknown[]) => {
                    all: () => Promise<Array<{ campaignId: number | null; status: string; count: unknown }>>
                        | Array<{ campaignId: number | null; status: string; count: unknown }>
                }
            }
        }).where
        if (typeof whereFn !== 'function') return
        let rows: Array<{ campaignId: number | null; status: string; count: unknown }>
        try {
            rows = await whereFn.call(
                query,
                inArray(schema.jobQueueEntries.status, ['done', 'failed', 'cancelled']),
            ).groupBy(schema.jobQueueEntries.campaignId, schema.jobQueueEntries.status).all()
        } catch (error) {
            if (this.isMissingQueryMethod(error)) return
            throw error
        }
        for (const row of rows) {
            this.addTerminalCount(this.campaignKey(row.campaignId), row.status, this.coerceCount(row.count))
        }
    }

    private isMissingQueryMethod(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error)
        return /is not a function/i.test(message)
    }

    private campaignKey(campaignId: number | null | undefined): string {
        return campaignId == null ? 'none' : String(campaignId)
    }

    private blockingToken(campaignId: number, accountId: number, locationId: number): string {
        return `${campaignId}|${accountId}:${locationId}`
    }

    private coerceCount(value: unknown): number {
        const n = typeof value === 'number' ? value : Number(value ?? 0)
        return Number.isFinite(n) ? n : 0
    }

    private addTerminalCount(key: string, status: string, amount: number): void {
        if (!Number.isFinite(amount) || amount === 0) return
        const bucket = this.terminalCounts.get(key) ?? { done: 0, failed: 0, cancelled: 0 }
        if (status === 'done') bucket.done += amount
        else if (status === 'failed') bucket.failed += amount
        else if (status === 'cancelled') bucket.cancelled += amount
        else return
        this.terminalCounts.set(key, bucket)
    }

    private rememberBlockingPair(job: Job): void {
        if (job.campaignId == null) return
        if (job.status !== 'done' && job.status !== 'failed') return
        this.blockingPairs.add(this.blockingToken(job.campaignId, job.accountId, job.locationId))
    }

    /** Free the job object after SQLite has the terminal row. */
    private forgetTerminalJob(job: Job): void {
        if (!isTerminalJobStatus(job.status)) return
        this.terminalStatus.set(job.id, job.status)
        this.rememberBlockingPair(job)
        this.addTerminalCount(this.campaignKey(job.campaignId), job.status, 1)
        this.runningJobs.delete(job.id)
        this.hiddenTerminalJobs.delete(job.id)
        this.removeFromAccountQueue(job)
        this.jobs.delete(job.id)
        if (this.readJobFromDatabase(job.id)) {
            this.archivedJobs.delete(job.id)
            return
        }
        // Sync read missed. Keep the object out of `jobs` for getJob/getCampaignJobs.
        this.archivedJobs.set(job.id, job)
    }

    /** Terminal history seen only because the loader could not filter in SQL. */
    private rememberLoadedTerminal(job: Job): void {
        if (!isTerminalJobStatus(job.status)) return
        this.terminalStatus.set(job.id, job.status)
        this.rememberBlockingPair(job)
        this.addTerminalCount(this.campaignKey(job.campaignId), job.status, 1)
        this.archivedJobs.set(job.id, job)
    }

    private subtractTerminalCount(key: string, status: string, amount: number): boolean {
        if (!Number.isFinite(amount) || amount === 0) return false
        const bucket = this.terminalCounts.get(key)
        if (!bucket) return false
        if (status === 'done') bucket.done = Math.max(0, bucket.done - amount)
        else if (status === 'failed') bucket.failed = Math.max(0, bucket.failed - amount)
        else if (status === 'cancelled') bucket.cancelled = Math.max(0, bucket.cancelled - amount)
        else return false
        return true
    }

    private rememberedTerminalResult(
        jobId: string,
        op: 'complete' | 'fail' | 'cancel' | 'permanent',
    ): JobTransitionResult | null {
        const status = this.terminalStatus.get(jobId)
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
        if (op === 'permanent' && status === 'failed') {
            return { applied: true, status: 'failed', reason: 'already_failed' }
        }
        return { applied: false, status, reason: `blocked_by_${status}` }
    }

    /** How many running→pending conversions happened on the last load. */
    getLastRequeuedRunningCount(): number {
        return this.lastRequeuedRunningCount
    }

    private rowToJob(row: schema.JobQueueEntry): Job {
        return {
            id: row.id,
            campaignId: row.campaignId ?? undefined,
            type: row.type as JobType,
            accountId: row.accountId,
            locationId: row.locationId,
            reviewText: row.reviewText ?? undefined,
            rating: row.rating ?? undefined,
            targetViews: row.targetViews ?? undefined,
            priority: row.priority,
            status: row.status as JobStatus,
            retryCount: row.retryCount,
            maxRetries: row.maxRetries,
            result: row.result ?? undefined,
            error: row.error ?? undefined,
            createdAt: row.createdAt,
            startedAt: row.startedAt ?? undefined,
            completedAt: row.completedAt ?? undefined,
        }
    }

    private indexJob(job: Job): void {
        this.jobs.set(job.id, job)
        if (job.status === 'pending' || job.status === 'running') {
            const queue = this.accountQueues.get(job.accountId) || []
            if (!queue.includes(job.id)) {
                queue.push(job.id)
                this.accountQueues.set(job.accountId, queue)
            }
        }
        if (job.status === 'running') {
            this.runningJobs.add(job.id)
        }
    }

    /**
     * Snapshot job fields + running/hidden/queue membership for exact rollback
     * if persist throws after an in-memory mutation.
     */
    private captureMutationState(job: Job): JobMutationSnapshot {
        const queue = this.accountQueues.get(job.accountId)
        return {
            status: job.status,
            retryCount: job.retryCount,
            error: job.error,
            result: job.result,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            inRunning: this.runningJobs.has(job.id),
            inHidden: this.hiddenTerminalJobs.has(job.id),
            queueIndex: queue ? queue.indexOf(job.id) : -1,
            wasResident: true,
            restoreTerminalCount: false,
        }
    }

    /** Restore fields/sets/maps to a prior captureMutationState snapshot. */
    private restoreMutationState(job: Job, snap: JobMutationSnapshot): void {
        job.status = snap.status
        job.retryCount = snap.retryCount
        job.error = snap.error
        job.result = snap.result
        job.startedAt = snap.startedAt
        job.completedAt = snap.completedAt

        if (snap.inRunning) this.runningJobs.add(job.id)
        else this.runningJobs.delete(job.id)

        if (snap.inHidden) this.hiddenTerminalJobs.add(job.id)
        else this.hiddenTerminalJobs.delete(job.id)

        this.restoreQueueMembership(job, snap.queueIndex)
    }

    private restoreQueueMembership(job: Job, queueIndex: number): void {
        let queue = this.accountQueues.get(job.accountId)
        if (!queue) {
            if (queueIndex < 0) return
            queue = []
            this.accountQueues.set(job.accountId, queue)
        }
        const currentIdx = queue.indexOf(job.id)
        if (currentIdx > -1) queue.splice(currentIdx, 1)
        if (queueIndex >= 0) {
            queue.splice(Math.min(queueIndex, queue.length), 0, job.id)
        }
    }

    /** Undo a brand-new job that was indexed but never successfully persisted. */
    private unindexNewJob(job: Job): void {
        this.jobs.delete(job.id)
        this.runningJobs.delete(job.id)
        this.hiddenTerminalJobs.delete(job.id)
        this.removeFromAccountQueue(job)
    }

    /**
     * Persist after in-memory mutation; on throw restore snapshot and rethrow
     * so callers never observe a half-applied transition.
     */
    private async persistOrRollback(job: Job, snap: JobMutationSnapshot): Promise<void> {
        try {
            await this.persistJob(job)
        } catch (error) {
            this.restoreMutationState(job, snap)
            if (!snap.wasResident) {
                this.jobs.delete(job.id)
                this.runningJobs.delete(job.id)
                this.hiddenTerminalJobs.delete(job.id)
                this.removeFromAccountQueue(job)
                this.archivedJobs.set(job.id, job)
                this.terminalStatus.set(job.id, job.status)
                if (snap.restoreTerminalCount) {
                    this.addTerminalCount(this.campaignKey(job.campaignId), job.status, 1)
                }
            }
            throw error
        }
    }

    private async persistJob(job: Job): Promise<void> {
        const db = getDatabase()
        const values: schema.NewJobQueueEntry = {
            id: job.id,
            campaignId: job.campaignId ?? null,
            type: job.type,
            accountId: job.accountId,
            locationId: job.locationId,
            reviewText: job.reviewText ?? null,
            rating: job.rating ?? null,
            targetViews: job.targetViews ?? null,
            priority: job.priority,
            status: job.status,
            retryCount: job.retryCount,
            maxRetries: job.maxRetries,
            result: job.result ?? null,
            error: job.error ?? null,
            createdAt: job.createdAt,
            startedAt: job.startedAt ?? null,
            completedAt: job.completedAt ?? null,
        }

        await db.insert(schema.jobQueueEntries)
            .values(values)
            .onConflictDoUpdate({
                target: schema.jobQueueEntries.id,
                set: {
                    campaignId: values.campaignId,
                    type: values.type,
                    accountId: values.accountId,
                    locationId: values.locationId,
                    reviewText: values.reviewText,
                    rating: values.rating,
                    targetViews: values.targetViews,
                    priority: values.priority,
                    status: values.status,
                    retryCount: values.retryCount,
                    maxRetries: values.maxRetries,
                    result: values.result,
                    error: values.error,
                    startedAt: values.startedAt,
                    completedAt: values.completedAt,
                },
            })
    }

    private generateJobId(): string {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    private jobPairKey(accountId: number, locationId: number): string {
        return `${accountId}:${locationId}`
    }

    async canAccountDoReview(accountId: number): Promise<boolean> {
        const todayCount = await this.getAccountReviewCountToday(accountId)
        return todayCount < this.config.maxReviewsPerAccountPerDay
    }

    async canAccountDoTraffic(accountId: number): Promise<boolean> {
        const todayCount = await this.getAccountTrafficCountToday(accountId)
        return todayCount < this.config.maxTrafficPerAccountPerDay
    }

    /**
     * Successful reviews only (status=success). Failed attempts do not consume daily budget.
     * Uses local-day start (machine TZ) — same bound as ReviewService.getAccountReviewsToday.
     * DB errors fail-closed: rethrow (never return 0 as a false "under limit").
     */
    async getAccountReviewCountToday(accountId: number): Promise<number> {
        const db = getDatabase()
        const dayStart = getLocalDayStart()
        const result = await db.select({ count: sql<number>`count(*)` })
            .from(schema.reviewHistory)
            .where(and(
                eq(schema.reviewHistory.accountId, accountId),
                eq(schema.reviewHistory.status, 'success'),
                gte(schema.reviewHistory.createdAt, dayStart)
            ))
            .get()
        return result?.count ?? 0
    }

    /**
     * All traffic_logs attempts for the account on the local calendar day
     * (success and failed both consume daily traffic exposure).
     * Uses local-day start (machine TZ) — same bound as getAccountReviewCountToday.
     * DB errors fail-closed: rethrow (never return 0 as a false "under limit").
     */
    async getAccountTrafficCountToday(accountId: number): Promise<number> {
        const db = getDatabase()
        const dayStart = getLocalDayStart()
        const result = await db.select({ count: sql<number>`count(*)` })
            .from(schema.trafficLogs)
            .where(and(
                eq(schema.trafficLogs.accountId, accountId),
                gte(schema.trafficLogs.createdAt, dayStart)
            ))
            .get()
        return result?.count ?? 0
    }

    /**
     * Keys accountId:locationId that already block re-enqueue for a campaign
     * (pending, running, or done — never re-run completed). History retained.
     */
    getBlockingPairKeys(campaignId: number): Set<string> {
        const keys = new Set<string>()
        const jobsList = Array.from(this.jobs.values())
        for (const job of jobsList) {
            if (job.campaignId !== campaignId) continue
            if (BLOCKING_STATUSES.includes(job.status)) {
                keys.add(this.jobPairKey(job.accountId, job.locationId))
            }
        }
        const prefix = `${campaignId}|`
        for (const token of Array.from(this.blockingPairs)) {
            if (token.startsWith(prefix)) keys.add(token.slice(prefix.length))
        }
        return keys
    }

    getPendingCountForCampaign(campaignId: number): number {
        let n = 0
        const jobsList = Array.from(this.jobs.values())
        for (const job of jobsList) {
            if (job.campaignId === campaignId && job.status === 'pending') n++
        }
        return n
    }

    async addJob(params: Omit<Job, 'id' | 'status' | 'retryCount' | 'createdAt'>): Promise<Job> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job: Job = {
                id: this.generateJobId(),
                ...params,
                status: 'pending',
                retryCount: 0,
                maxRetries: params.maxRetries || this.config.maxRetriesPerJob,
                createdAt: new Date().toISOString(),
            }

            this.indexJob(job)
            try {
                await this.persistJob(job)
            } catch (error) {
                this.unindexNewJob(job)
                console.error(
                    `[JobQueue] addJob persist failed for ${job.id}; rolled back memory:`,
                    error
                )
                throw error
            }

            console.log(`[JobQueue] Added job ${job.id} for account ${job.accountId}`)
            return job
        })
    }

    async addCampaignJobs(
        campaignId: number,
        type: JobType,
        accountIds: number[],
        locations: { id: number; reviewText?: string; rating?: number }[],
        priority: number = 0
    ): Promise<Job[]> {
        await this.ensureLoaded()
        const jobs: Job[] = []
        const blocked = this.getBlockingPairKeys(campaignId)
        let skipped = 0

        for (const accountId of accountIds) {
            if (type === 'review' && !(await this.canAccountDoReview(accountId))) {
                console.log(`[JobQueue] Account ${accountId} reached daily review limit, skipping`)
                continue
            }

            for (const location of locations) {
                const key = this.jobPairKey(accountId, location.id)
                if (blocked.has(key)) {
                    skipped++
                    continue
                }

                const job = await this.addJob({
                    campaignId,
                    type,
                    accountId,
                    locationId: location.id,
                    reviewText: location.reviewText,
                    rating: location.rating || 5,
                    priority,
                    maxRetries: this.config.maxRetriesPerJob,
                })
                jobs.push(job)
                blocked.add(key)
            }
        }

        console.log(
            `[JobQueue] Added ${jobs.length} jobs for campaign ${campaignId}` +
            (skipped > 0 ? ` (skipped ${skipped} existing/done pairs)` : '')
        )
        return jobs
    }

    /**
     * True when this account already has an in-flight review job.
     * Limits concurrent profile use / daily-limit races (max 1 running review per account).
     */
    private accountHasRunningReview(accountId: number): boolean {
        for (const jobId of Array.from(this.runningJobs)) {
            const j = this.jobs.get(jobId)
            if (
                j &&
                j.accountId === accountId &&
                j.type === 'review' &&
                j.status === 'running'
            ) {
                return true
            }
        }
        return false
    }

    /**
     * Select next eligible pending job (peek — does not mutate).
     * Skips accounts already at daily limit or with a running review (type=review).
     * Review locations in `disallowRecentlyReviewedLocations` are skipped so the
     * caller can pick a different job instead of starting a cooled-down location.
     */
    private async findEligiblePendingJob(
        campaignId?: number,
        options?: JobClaimOptions,
    ): Promise<Job | null> {
        const disallowed = options?.disallowRecentlyReviewedLocations
        const blockedLocations = disallowed && disallowed.length > 0
            ? new Set<number>(disallowed)
            : null

        const pendingJobs = Array.from(this.jobs.values())
            .filter(j =>
                j.status === 'pending' &&
                !this.runningJobs.has(j.id) &&
                (campaignId == null || j.campaignId === campaignId)
            )
            .sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            })

        for (const job of pendingJobs) {
            if (
                job.type === 'review' &&
                blockedLocations !== null &&
                blockedLocations.has(job.locationId)
            ) {
                continue
            }
            if (job.type === 'review' && this.accountHasRunningReview(job.accountId)) {
                continue
            }
            if (job.type === 'review' && !(await this.canAccountDoReview(job.accountId))) {
                continue
            }
            if (job.type === 'traffic' && !(await this.canAccountDoTraffic(job.accountId))) {
                continue
            }
            return job
        }
        return null
    }

    /** Peek next eligible job without claiming (non-mutating). */
    async getNextJob(campaignId?: number, options?: JobClaimOptions): Promise<Job | null> {
        await this.ensureLoaded()
        return this.findEligiblePendingJob(campaignId, options)
    }

    /**
     * Atomic claim for workers: select eligible pending → running + persist under runExclusive.
     * Guarantees two concurrent callers never receive the same job.
     * Enforces max 1 running review per account before claim.
     * On persist failure: roll back memory (status/runningJobs/startedAt) and rethrow
     * so AutomationController can handle separately (no half-claimed in-memory job).
     */
    async claimNextJob(campaignId?: number, options?: JobClaimOptions): Promise<Job | null> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = await this.findEligiblePendingJob(campaignId, options)
            if (!job) return null
            // Defensive: status may have changed only if exclusivity broken; re-check.
            if (job.status !== 'pending') return null

            const snap = this.captureMutationState(job)
            job.status = 'running'
            job.startedAt = new Date().toISOString()
            this.runningJobs.add(job.id)
            try {
                await this.persistOrRollback(job, snap)
            } catch (error) {
                console.error(
                    `[JobQueue] claimNextJob persist failed for ${job.id}; rolled back memory:`,
                    error
                )
                throw error
            }
            console.log(`[JobQueue] Claimed job ${job.id}`)
            return job
        })
    }

    /**
     * Return a claimed running job to pending without counting a retry or failure.
     * Cross-account cooldown uses this so the job can be picked again later.
     */
    async deferRunningJob(jobId: string): Promise<JobTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = this.jobs.get(jobId)
            if (!job) {
                return { applied: false, status: null, reason: 'not_found' }
            }
            if (job.status !== 'running') {
                return { applied: false, status: job.status, reason: `invalid_from_${job.status}` }
            }

            const snap = this.captureMutationState(job)
            job.status = 'pending'
            job.startedAt = undefined
            this.runningJobs.delete(jobId)
            try {
                await this.persistOrRollback(job, snap)
            } catch (error) {
                console.error(
                    `[JobQueue] deferRunningJob persist failed for ${jobId}; rolled back memory:`,
                    error
                )
                throw error
            }
            console.log(`[JobQueue] Deferred job ${jobId} back to pending`)
            return { applied: true, status: 'pending' }
        })
    }

    async getNextJobForAccount(accountId: number): Promise<Job | null> {
        await this.ensureLoaded()
        const accountQueue = this.accountQueues.get(accountId) || []

        for (const jobId of accountQueue) {
            const job = this.jobs.get(jobId)
            if (job && job.status === 'pending' && !this.runningJobs.has(job.id)) {
                if (job.type === 'review' && this.accountHasRunningReview(accountId)) {
                    return null
                }
                if (job.type === 'review' && !(await this.canAccountDoReview(accountId))) {
                    return null
                }
                return job
            }
        }
        return null
    }

    async startJob(jobId: string): Promise<JobTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = this.jobs.get(jobId)
            if (!job) {
                const remembered = this.terminalStatus.get(jobId)
                if (!remembered) return { applied: false, status: null, reason: 'not_found' }
                return { applied: false, status: remembered, reason: `invalid_from_${remembered}` }
            }
            if (job.status === 'running') {
                // Not a new transition — caller must not treat as fresh claim.
                return { applied: false, status: 'running', reason: 'already_running' }
            }
            if (job.status !== 'pending') {
                console.warn(`[JobQueue] Refusing to start terminal/non-pending job ${jobId} (${job.status})`)
                return { applied: false, status: job.status, reason: `invalid_from_${job.status}` }
            }

            const snap = this.captureMutationState(job)
            job.status = 'running'
            job.startedAt = new Date().toISOString()
            this.runningJobs.add(jobId)
            await this.persistOrRollback(job, snap)
            console.log(`[JobQueue] Job ${jobId} started`)
            return { applied: true, status: 'running' }
        })
    }

    /**
     * Mark job done. Atomic: refuses to overwrite cancelled/failed/done-from-other-path.
     * Idempotent when already done. Stale async after cancel → no-op (cancelled wins).
     */
    async completeJob(jobId: string, result?: unknown): Promise<JobTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = this.jobs.get(jobId)
            if (!job) {
                return this.rememberedTerminalResult(jobId, 'complete')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (job.status === 'done') {
                return { applied: true, status: 'done', reason: 'already_done' }
            }
            if (isImmutableTerminalStatus(job.status) || job.status === 'failed') {
                console.warn(
                    `[JobQueue] Refusing completeJob on ${jobId}: status=${job.status} (terminal)`
                )
                return { applied: false, status: job.status, reason: `blocked_by_${job.status}` }
            }
            if (job.status !== 'running') {
                console.warn(
                    `[JobQueue] Refusing completeJob on ${jobId}: expected running, got ${job.status}`
                )
                return { applied: false, status: job.status, reason: `invalid_from_${job.status}` }
            }

            const snap = this.captureMutationState(job)
            job.status = 'done'
            job.completedAt = new Date().toISOString()
            job.result = result !== undefined ? JSON.stringify(result) : undefined
            this.runningJobs.delete(jobId)
            this.removeFromAccountQueue(job)
            await this.persistOrRollback(job, snap)
            this.forgetTerminalJob(job)
            console.log(`[JobQueue] Job ${jobId} completed`)
            return { applied: true, status: 'done' }
        })
    }

    /**
     * Fail with retry or permanent failed. Never overwrites done/cancelled.
     */
    async failJob(jobId: string, error: string): Promise<JobTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = this.jobs.get(jobId)
            if (!job) {
                return this.rememberedTerminalResult(jobId, 'fail')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (job.status === 'failed') {
                return { applied: true, status: 'failed', reason: 'already_failed' }
            }
            if (isImmutableTerminalStatus(job.status)) {
                console.warn(
                    `[JobQueue] Refusing failJob on ${jobId}: status=${job.status} (immutable terminal)`
                )
                return { applied: false, status: job.status, reason: `blocked_by_${job.status}` }
            }
            if (job.status !== 'running') {
                console.warn(
                    `[JobQueue] Refusing failJob on ${jobId}: expected running, got ${job.status}`
                )
                return { applied: false, status: job.status, reason: `invalid_from_${job.status}` }
            }

            const snap = this.captureMutationState(job)
            job.retryCount++
            job.error = error
            this.runningJobs.delete(jobId)

            if (job.retryCount < job.maxRetries) {
                job.status = 'pending'
                job.startedAt = undefined
                console.log(`[JobQueue] Job ${jobId} failed, will retry (${job.retryCount}/${job.maxRetries})`)
            } else {
                job.status = 'failed'
                job.completedAt = new Date().toISOString()
                this.removeFromAccountQueue(job)
                console.log(`[JobQueue] Job ${jobId} failed permanently after ${job.retryCount} retries`)
            }

            await this.persistOrRollback(job, snap)
            this.forgetTerminalJob(job)
            return { applied: true, status: job.status }
        })
    }

    /**
     * Terminal fail without retry budget (no pending requeue, no retryCount bump).
     * For unconfirmed / policy-driven permanent failure from AutomationController.
     * Atomic under runExclusive; never overwrites done/cancelled.
     * Accepts running (primary) or pending (post-requeue safety).
     */
    async markJobPermanentlyFailed(jobId: string, error: string): Promise<JobTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = this.jobs.get(jobId)
            if (!job) {
                return this.rememberedTerminalResult(jobId, 'permanent')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (job.status === 'failed') {
                return { applied: true, status: 'failed', reason: 'already_failed' }
            }
            if (isImmutableTerminalStatus(job.status)) {
                console.warn(
                    `[JobQueue] Refusing markJobPermanentlyFailed on ${jobId}: status=${job.status}`
                )
                return { applied: false, status: job.status, reason: `blocked_by_${job.status}` }
            }
            if (job.status !== 'running' && job.status !== 'pending') {
                console.warn(
                    `[JobQueue] Refusing markJobPermanentlyFailed on ${jobId}: expected running|pending, got ${job.status}`
                )
                return { applied: false, status: job.status, reason: `invalid_from_${job.status}` }
            }

            const snap = this.captureMutationState(job)
            job.status = 'failed'
            job.error = error
            job.completedAt = new Date().toISOString()
            this.runningJobs.delete(jobId)
            this.removeFromAccountQueue(job)
            await this.persistOrRollback(job, snap)
            this.forgetTerminalJob(job)
            console.log(`[JobQueue] Job ${jobId} marked permanently failed (no retry)`)
            return { applied: true, status: 'failed' }
        })
    }

    /**
     * Cancel pending/running only. done stays done; cancelled is idempotent.
     * Wins over later completeJob/failJob from stale async workers.
     */
    async cancelJob(jobId: string): Promise<JobTransitionResult> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            const job = this.jobs.get(jobId)
            if (!job) {
                return this.rememberedTerminalResult(jobId, 'cancel')
                    ?? { applied: false, status: null, reason: 'not_found' }
            }
            if (job.status === 'cancelled') {
                return { applied: true, status: 'cancelled', reason: 'already_cancelled' }
            }
            if (job.status === 'done' || job.status === 'failed') {
                console.warn(
                    `[JobQueue] Refusing cancelJob on ${jobId}: status=${job.status} (terminal)`
                )
                return { applied: false, status: job.status, reason: `blocked_by_${job.status}` }
            }
            if (!isActiveJobStatus(job.status)) {
                return { applied: false, status: job.status, reason: `invalid_from_${job.status}` }
            }

            const snap = this.captureMutationState(job)
            job.status = 'cancelled'
            job.completedAt = new Date().toISOString()
            this.runningJobs.delete(jobId)
            this.removeFromAccountQueue(job)
            await this.persistOrRollback(job, snap)
            this.forgetTerminalJob(job)
            console.log(`[JobQueue] Job ${jobId} cancelled`)
            return { applied: true, status: 'cancelled' }
        })
    }

    async cancelCampaignJobs(campaignId: number): Promise<number> {
        await this.ensureLoaded()
        let cancelled = 0
        // Snapshot IDs first — statuses mutate under exclusive lock per cancelJob
        const ids = Array.from(this.jobs.values())
            .filter(j => j.campaignId === campaignId && isActiveJobStatus(j.status))
            .map(j => j.id)

        for (const id of ids) {
            const result = await this.cancelJob(id)
            if (result.applied && result.status === 'cancelled') cancelled++
        }
        return cancelled
    }

    /**
     * Manual retry of a failed/cancelled job → pending.
     * Resets retryCount so the full maxRetries budget is available again.
     * Never retries done.
     */
    async retryJob(jobId: string): Promise<boolean> {
        await this.ensureLoaded()
        return this.runExclusive(async () => {
            let job = this.jobs.get(jobId)
            const wasResident = job != null
            if (!job) job = this.archivedJobs.get(jobId)
            if (!job) {
                const hydrated = await this.rehydrateJob(jobId)
                if (!hydrated) return false
                job = hydrated
            }
            if (job.status === 'done') {
                console.warn(`[JobQueue] Refusing to retry completed job ${jobId}`)
                return false
            }
            if (job.status === 'pending' || job.status === 'running') {
                console.warn(`[JobQueue] Refusing to retry active job ${jobId} (${job.status})`)
                return false
            }

            let restoreTerminalCount = false
            if (!wasResident) {
                this.archivedJobs.delete(job.id)
                restoreTerminalCount = this.subtractTerminalCount(
                    this.campaignKey(job.campaignId),
                    job.status,
                    1,
                )
                this.terminalStatus.delete(job.id)
                this.jobs.set(job.id, job)
            }

            const snap = this.captureMutationState(job)
            snap.wasResident = wasResident
            snap.restoreTerminalCount = restoreTerminalCount
            job.status = 'pending'
            job.retryCount = 0
            job.error = undefined
            job.startedAt = undefined
            job.completedAt = undefined
            this.runningJobs.delete(jobId)
            this.hiddenTerminalJobs.delete(jobId)
            this.indexJob(job)
            await this.persistOrRollback(job, snap)
            console.log(`[JobQueue] Job ${jobId} requeued for retry (retryCount reset)`)
            return true
        })
    }

    /** Load one terminal row back when a manual retry needs the full job. Does not index it. */
    private async rehydrateJob(jobId: string): Promise<Job | null> {
        try {
            return this.readJobFromDatabase(jobId) ?? null
        } catch (error) {
            console.error(`[JobQueue] rehydrateJob failed for ${jobId}:`, error)
            return null
        }
    }

    private isJobRow(row: unknown): row is schema.JobQueueEntry {
        if (row == null || typeof row !== 'object' || isThenable(row)) return false
        const candidate = row as {
            id?: unknown
            status?: unknown
            accountId?: unknown
            locationId?: unknown
            type?: unknown
        }
        return (
            typeof candidate.id === 'string' &&
            typeof candidate.status === 'string' &&
            typeof candidate.accountId === 'number' &&
            typeof candidate.locationId === 'number' &&
            typeof candidate.type === 'string'
        )
    }

    /** Point read. Never inserts into `jobs`. */
    private readJobFromDatabase(jobId: string): Job | undefined {
        try {
            const db = getDatabase()
            const row = db
                .select()
                .from(schema.jobQueueEntries)
                .where(eq(schema.jobQueueEntries.id, jobId))
                .get()
            if (!this.isJobRow(row)) {
                if (isThenable(row)) {
                    void Promise.resolve(row).then(
                        () => undefined,
                        () => undefined,
                    )
                }
                return undefined
            }
            return this.rowToJob(row)
        } catch (error) {
            if (this.isMissingQueryMethod(error)) return undefined
            console.error(`[JobQueue] SQLite job lookup failed for ${jobId}:`, error)
            return undefined
        }
    }

    /** Campaign rows for callers that still expect terminal history. Skips ids already in memory. */
    private readCampaignJobsFromDatabase(campaignId: number): Job[] {
        try {
            const db = getDatabase()
            const rows = db
                .select()
                .from(schema.jobQueueEntries)
                .where(eq(schema.jobQueueEntries.campaignId, campaignId))
                .all()
            if (isThenable(rows)) {
                void Promise.resolve(rows).then(
                    () => undefined,
                    () => undefined,
                )
                return []
            }
            if (!Array.isArray(rows)) return []
            const jobs: Job[] = []
            for (const row of rows) {
                if (!this.isJobRow(row)) continue
                jobs.push(this.rowToJob(row))
            }
            return jobs
        } catch (error) {
            if (this.isMissingQueryMethod(error)) return []
            console.error(
                `[JobQueue] SQLite campaign job lookup failed for ${campaignId}:`,
                error,
            )
            return []
        }
    }

    private removeFromAccountQueue(job: Job): void {
        const queue = this.accountQueues.get(job.accountId)
        if (!queue) return
        const idx = queue.indexOf(job.id)
        if (idx > -1) queue.splice(idx, 1)
    }

    getStats(campaignId?: number): {
        total: number
        pending: number
        running: number
        done: number
        failed: number
        cancelled: number
        byAccount: Map<number, { pending: number; done: number }>
    } {
        const stats = {
            total: this.jobs.size,
            pending: 0,
            running: 0,
            done: 0,
            failed: 0,
            cancelled: 0,
            byAccount: new Map<number, { pending: number; done: number }>(),
        }

        const jobsList = Array.from(this.jobs.values()).filter(job =>
            !this.hiddenTerminalJobs.has(job.id) &&
            (campaignId == null || job.campaignId === campaignId)
        )
        for (const job of jobsList) {
            switch (job.status) {
                case 'pending': stats.pending++; break
                case 'running': stats.running++; break
                case 'done': stats.done++; break
                case 'failed': stats.failed++; break
                case 'cancelled': stats.cancelled++; break
            }

            const accountStats = stats.byAccount.get(job.accountId) || { pending: 0, done: 0 }
            if (job.status === 'pending') accountStats.pending++
            if (job.status === 'done') accountStats.done++
            stats.byAccount.set(job.accountId, accountStats)
        }

        this.addVisibleTerminalCounts(stats, campaignId)
        stats.total = stats.pending + stats.running + stats.done + stats.failed + stats.cancelled
        return stats
    }

    private addVisibleTerminalCounts(
        stats: { done: number; failed: number; cancelled: number },
        campaignId?: number,
    ): void {
        const keys = campaignId == null
            ? Array.from(this.terminalCounts.keys())
            : [this.campaignKey(campaignId)]
        for (const key of keys) {
            const bucket = this.terminalCounts.get(key)
            if (!bucket) continue
            stats.done += bucket.done
            stats.failed += bucket.failed
            stats.cancelled += bucket.cancelled
        }
    }

    getAllJobs(): Job[] {
        return Array.from(this.jobs.values())
    }

    getJob(jobId: string): Job | undefined {
        const resident = this.jobs.get(jobId)
        if (resident) return resident
        const archived = this.archivedJobs.get(jobId)
        if (archived) return archived
        return this.readJobFromDatabase(jobId)
    }

    getCampaignJobs(campaignId: number): Job[] {
        const byId = new Map<string, Job>()
        for (const job of Array.from(this.jobs.values())) {
            if (job.campaignId === campaignId) byId.set(job.id, job)
        }
        for (const job of Array.from(this.archivedJobs.values())) {
            if (job.campaignId === campaignId && !byId.has(job.id)) byId.set(job.id, job)
        }
        for (const job of this.readCampaignJobsFromDatabase(campaignId)) {
            if (!byId.has(job.id)) byId.set(job.id, job)
        }
        return Array.from(byId.values())
    }

    /** Campaign IDs that still have pending work (for recovery). Never includes done-only. */
    getCampaignIdsWithPending(): number[] {
        const ids = new Set<number>()
        const jobsList = Array.from(this.jobs.values())
        for (const job of jobsList) {
            if (job.status === 'pending' && job.campaignId != null) {
                ids.add(job.campaignId)
            }
        }
        return Array.from(ids)
    }

    /**
     * Drop terminal job objects from RAM. Durable rows stay in SQLite.
     * Blocking pairs are kept so completed work is not enqueued again.
     */
    clearCompleted(campaignId?: number): void {
        for (const [, job] of Array.from(this.jobs.entries())) {
            if (campaignId != null && job.campaignId !== campaignId) continue
            if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
                this.forgetTerminalJob(job)
            }
        }
        if (campaignId == null) this.terminalCounts.clear()
        else this.terminalCounts.delete(this.campaignKey(campaignId))
        console.log('[JobQueue] Removed completed jobs from memory; durable rows remain in SQLite')
    }

    /** Optionally purge terminal rows from DB (explicit ops only). */
    async purgeTerminalFromDatabase(campaignId?: number): Promise<void> {
        const db = getDatabase()
        const terminal: JobStatus[] = ['done', 'failed', 'cancelled']
        if (campaignId != null) {
            await db.delete(schema.jobQueueEntries)
                .where(and(
                    eq(schema.jobQueueEntries.campaignId, campaignId),
                    inArray(schema.jobQueueEntries.status, terminal)
                ))
            return
        }
        await db.delete(schema.jobQueueEntries)
            .where(inArray(schema.jobQueueEntries.status, terminal))
    }

    clearAll(): void {
        this.resetMemoryIndexes()
        this.lastRequeuedRunningCount = 0
        console.log('[JobQueue] Cleared all jobs from memory')
    }

    /**
     * Test / isolated-instance helper: mark queue loaded without hitting DB,
     * so unit tests can exercise the state machine with mocked persist.
     */
    markLoadedForTests(): void {
        this.loaded = true
        this.loadPromise = null
        this.lastRequeuedRunningCount = 0
    }

    isEmpty(campaignId?: number): boolean {
        const jobsList = Array.from(this.jobs.values())
            .filter(job => campaignId == null || job.campaignId === campaignId)
        return jobsList.every(j => j.status !== 'pending')
    }

    getRunningCount(campaignId?: number): number {
        if (campaignId == null) return this.runningJobs.size
        let count = 0
        for (const jobId of Array.from(this.runningJobs)) {
            if (this.jobs.get(jobId)?.campaignId === campaignId) count++
        }
        return count
    }

    isLoaded(): boolean {
        return this.loaded
    }
}

export { JobQueue }
export const jobQueue = new JobQueue()
