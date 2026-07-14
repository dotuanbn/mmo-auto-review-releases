/**
 * ReviewRecoveryService - Crash recovery for durable review job queue
 *
 * On app boot:
 * 1. Load job_queue into memory (running → pending inside JobQueue only)
 * 2. Reconcile zombie campaign rows still marked "running" after crash
 * 3. Expose deterministic resume plan (campaign IDs + pending counts)
 *
 * Rules:
 * - Only pending work is resume-eligible (running is requeued to pending on load)
 * - done / cancelled are terminal history — never re-run
 * - failed (incl. markJobPermanentlyFailed) is not auto-resumed — use retryJob
 * - Does NOT auto-start browsers. Does NOT touch TrafficBoostEngine.
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import { jobQueue, type Job, type JobStatus } from './JobQueue'

export interface RecoverableCampaign {
    campaignId: number
    pendingJobs: number
    doneJobs: number
    failedJobs: number
    cancelledJobs: number
    previousStatus: string
    reconciledStatus: 'paused' | 'done' | 'error'
}

export interface RecoveryReport {
    loaded: boolean
    requeuedRunningJobs: boolean
    requeuedRunningCount: number
    zombieCampaigns: RecoverableCampaign[]
    pendingCampaignIds: number[]
    totalPendingJobs: number
}

export interface ResumePlan {
    canResume: boolean
    pendingJobs: number
    doneJobs: number
    cancelledJobs: number
    failedJobs: number
    reason?: string
}

export interface JobStatusCounts {
    pending: number
    running: number
    done: number
    failed: number
    cancelled: number
    total: number
}

/** Pure: count statuses for recovery decisions (no side effects). */
export function countJobStatuses(jobs: ReadonlyArray<Pick<Job, 'status'>>): JobStatusCounts {
    const counts: JobStatusCounts = {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        total: jobs.length,
    }
    for (const job of jobs) {
        switch (job.status as JobStatus) {
            case 'pending': counts.pending++; break
            case 'running': counts.running++; break
            case 'done': counts.done++; break
            case 'failed': counts.failed++; break
            case 'cancelled': counts.cancelled++; break
        }
    }
    return counts
}

/**
 * Pure reconcile decision after crash.
 * Pending (includes requeued former-running) → paused for deterministic resume.
 * No work left → done / error based on outcomes. Empty queue → paused (safe).
 */
export function decideCampaignReconcileStatus(counts: JobStatusCounts): RecoverableCampaign['reconciledStatus'] {
    // Residual running should not appear after JobQueue load; treat as unfinished work.
    const unfinished = counts.pending + counts.running
    if (unfinished > 0) {
        return 'paused'
    }
    if (counts.total === 0) {
        return 'paused'
    }
    if (counts.done > 0 && counts.failed === 0) {
        return 'done'
    }
    if (counts.failed > 0) {
        return 'error'
    }
    // All cancelled (or only cancelled/empty outcomes) → paused is safer than done
    if (counts.cancelled > 0 && counts.done === 0) {
        return 'paused'
    }
    return 'done'
}

/**
 * Pure resume eligibility: only pending jobs. done/cancelled never re-run.
 * Residual running is not a resume candidate mid-recovery (load requeues them first).
 */
export function buildResumePlan(counts: JobStatusCounts): ResumePlan {
    const base: ResumePlan = {
        canResume: false,
        pendingJobs: counts.pending,
        doneJobs: counts.done,
        cancelledJobs: counts.cancelled,
        failedJobs: counts.failed,
    }

    if (counts.pending > 0) {
        return { ...base, canResume: true }
    }

    if (counts.running > 0) {
        return {
            ...base,
            reason: 'Jobs still marked running — load/requeue first; do not force re-run',
        }
    }

    if (counts.done > 0 && counts.cancelled === 0 && counts.failed === 0) {
        return {
            ...base,
            reason: 'All jobs already completed — nothing to resume',
        }
    }

    if (counts.cancelled > 0 && counts.done === 0 && counts.failed === 0) {
        return {
            ...base,
            reason: 'All jobs cancelled — terminal; nothing to resume',
        }
    }

    if (counts.failed > 0 && counts.pending === 0) {
        return {
            ...base,
            reason: 'Only failed/terminal jobs remain — use retryJob, do not auto-resume',
        }
    }

    return {
        ...base,
        reason: 'No pending durable jobs for this campaign',
    }
}

class ReviewRecoveryService {
    private lastReport: RecoveryReport | null = null
    private recovered = false

    getLastReport(): RecoveryReport | null {
        return this.lastReport
    }

    isRecovered(): boolean {
        return this.recovered
    }

    /**
     * Run once after initDatabase(). Safe to call again (idempotent).
     * Relies on JobQueue.ensureLoaded() which requeues only running → pending
     * and keeps done/cancelled history for idempotency.
     */
    async recoverOnBoot(): Promise<RecoveryReport> {
        if (this.recovered && this.lastReport) {
            return this.lastReport
        }

        console.log('[ReviewRecovery] Starting durable queue recovery...')
        await jobQueue.ensureLoaded()
        await jobQueue.loadConfig()

        const requeuedRunningCount = jobQueue.getLastRequeuedRunningCount()
        const zombieCampaigns = await this.reconcileZombieCampaigns()
        const pendingCampaignIds = jobQueue.getCampaignIdsWithPending()
        const stats = jobQueue.getStats()

        // Defensive: resume candidates must only include campaigns with pending work.
        // done/cancelled-only campaigns never appear here.
        const safePendingIds = pendingCampaignIds.filter(id => {
            const jobs = jobQueue.getCampaignJobs(id)
            const counts = countJobStatuses(jobs)
            return counts.pending > 0
        })

        const report: RecoveryReport = {
            loaded: true,
            requeuedRunningJobs: requeuedRunningCount > 0,
            requeuedRunningCount,
            zombieCampaigns,
            pendingCampaignIds: safePendingIds,
            totalPendingJobs: stats.pending,
        }

        this.lastReport = report
        this.recovered = true

        console.log(
            `[ReviewRecovery] Done. pendingJobs=${stats.pending}, ` +
            `requeuedRunning=${requeuedRunningCount}, ` +
            `zombieCampaigns=${zombieCampaigns.length}, ` +
            `resumeCandidates=${safePendingIds.join(',') || 'none'}`
        )
        return report
    }

    /**
     * Campaigns left as status=running after crash → paused (or done if no work left).
     * Pending jobs stay in job_queue for deterministic resume.
     * Terminal done/cancelled jobs are never requeued as work.
     */
    private async reconcileZombieCampaigns(): Promise<RecoverableCampaign[]> {
        const db = getDatabase()
        const runningCampaigns = await db.select()
            .from(schema.campaigns)
            .where(eq(schema.campaigns.status, 'running'))
            .all()

        const results: RecoverableCampaign[] = []

        for (const campaign of runningCampaigns) {
            const reconciled = await this.reconcileOneCampaign(campaign.id, campaign.status)
            if (reconciled) results.push(reconciled)
        }

        return results
    }

    private async reconcileOneCampaign(
        campaignId: number,
        previousStatus: string
    ): Promise<RecoverableCampaign | null> {
        const jobs = jobQueue.getCampaignJobs(campaignId)
        const counts = countJobStatuses(jobs)
        const reconciledStatus = decideCampaignReconcileStatus(counts)

        await this.updateCampaignStatus(campaignId, reconciledStatus)

        console.log(
            `[ReviewRecovery] Campaign ${campaignId}: ${previousStatus} → ${reconciledStatus} ` +
            `(pending=${counts.pending}, running=${counts.running}, done=${counts.done}, ` +
            `failed=${counts.failed}, cancelled=${counts.cancelled})`
        )

        return {
            campaignId,
            pendingJobs: counts.pending,
            doneJobs: counts.done,
            failedJobs: counts.failed,
            cancelledJobs: counts.cancelled,
            previousStatus,
            reconciledStatus,
        }
    }

    private async updateCampaignStatus(
        campaignId: number,
        status: 'paused' | 'done' | 'error'
    ): Promise<void> {
        const db = getDatabase()
        await db.update(schema.campaigns)
            .set({ status })
            .where(eq(schema.campaigns.id, campaignId))
    }

    /**
     * Deterministic resume plan: only pending jobs, never re-run done/cancelled.
     */
    async getResumePlan(campaignId: number): Promise<ResumePlan> {
        await jobQueue.ensureLoaded()
        const jobs = jobQueue.getCampaignJobs(campaignId)
        const counts = countJobStatuses(jobs)
        return buildResumePlan(counts)
    }

    /** Campaign IDs safe to resume after boot recovery (pending work only). */
    listResumeCandidates(): number[] {
        return jobQueue.getCampaignIdsWithPending()
    }

    /** Reset recovered flag — tests only. */
    resetForTests(): void {
        this.lastReport = null
        this.recovered = false
    }
}

export const reviewRecoveryService = new ReviewRecoveryService()
export { ReviewRecoveryService }
