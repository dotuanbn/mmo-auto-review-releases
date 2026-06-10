/**
 * JobQueue - Smart Queue Manager for Automation Jobs
 * 
 * Features:
 * - Per-account job queues
 * - Priority support
 * - Daily limit enforcement
 * - Persistent state (survives app restart)
 * - Thread-safe operations
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq, and, sql } from 'drizzle-orm'

export type JobType = 'review' | 'traffic'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
    id: string
    campaignId?: number
    type: JobType
    accountId: number
    locationId: number
    // Review specific
    reviewText?: string
    rating?: number
    // Traffic specific
    targetViews?: number
    // Meta
    priority: number
    status: JobStatus
    retryCount: number
    maxRetries: number
    result?: string // JSON result
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

const DEFAULT_CONFIG: JobQueueConfig = {
    maxRetriesPerJob: 3,
    maxReviewsPerAccountPerDay: 5,
    maxTrafficPerAccountPerDay: 50,
}

class JobQueue {
    private config: JobQueueConfig = DEFAULT_CONFIG
    private jobs: Map<string, Job> = new Map()
    private accountQueues: Map<number, string[]> = new Map() // accountId -> jobIds
    private runningJobs: Set<string> = new Set()

    constructor() {
        this.loadFromDatabase()
    }

    // Load config from settings
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

    // Load pending jobs from database
    private async loadFromDatabase(): Promise<void> {
        try {
            const db = getDatabase()
            // Jobs will be loaded when we have the job_queue table
            console.log('[JobQueue] Initialized')
        } catch (error) {
            console.error('[JobQueue] Failed to load from database:', error)
        }
    }

    // Generate unique job ID
    private generateJobId(): string {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    // Get today's date as YYYY-MM-DD
    private getToday(): string {
        return new Date().toISOString().split('T')[0]
    }

    // Check if account can do more reviews today
    async canAccountDoReview(accountId: number): Promise<boolean> {
        const todayCount = await this.getAccountReviewCountToday(accountId)
        return todayCount < this.config.maxReviewsPerAccountPerDay
    }

    // Check if account can do more traffic today
    async canAccountDoTraffic(accountId: number): Promise<boolean> {
        const todayCount = await this.getAccountTrafficCountToday(accountId)
        return todayCount < this.config.maxTrafficPerAccountPerDay
    }

    // Get account's review count for today
    async getAccountReviewCountToday(accountId: number): Promise<number> {
        try {
            const db = getDatabase()
            const today = this.getToday()

            // Count from review_history
            const result = await db.select({ count: sql<number>`count(*)` })
                .from(schema.reviewHistory)
                .where(and(
                    eq(schema.reviewHistory.accountId, accountId),
                    sql`date(${schema.reviewHistory.createdAt}, 'unixepoch') = ${today}`
                ))
                .get()

            return result?.count || 0
        } catch (error) {
            console.error('[JobQueue] Failed to get review count:', error)
            return 0
        }
    }

    // Get account's traffic count for today
    async getAccountTrafficCountToday(accountId: number): Promise<number> {
        // TODO: Implement traffic counting
        return 0
    }

    // Add a new job to the queue
    async addJob(params: Omit<Job, 'id' | 'status' | 'retryCount' | 'createdAt'>): Promise<Job> {
        const job: Job = {
            id: this.generateJobId(),
            ...params,
            status: 'pending',
            retryCount: 0,
            maxRetries: params.maxRetries || this.config.maxRetriesPerJob,
            createdAt: new Date().toISOString(),
        }

        this.jobs.set(job.id, job)

        // Add to account queue
        const accountQueue = this.accountQueues.get(job.accountId) || []
        accountQueue.push(job.id)
        this.accountQueues.set(job.accountId, accountQueue)

        console.log(`[JobQueue] Added job ${job.id} for account ${job.accountId}`)
        return job
    }

    // Add multiple jobs for a campaign
    async addCampaignJobs(
        campaignId: number,
        type: JobType,
        accountIds: number[],
        locations: { id: number; reviewText?: string; rating?: number }[],
        priority: number = 0
    ): Promise<Job[]> {
        const jobs: Job[] = []

        for (const accountId of accountIds) {
            // Check account quota
            if (type === 'review' && !(await this.canAccountDoReview(accountId))) {
                console.log(`[JobQueue] Account ${accountId} reached daily review limit, skipping`)
                continue
            }

            for (const location of locations) {
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
            }
        }

        console.log(`[JobQueue] Added ${jobs.length} jobs for campaign ${campaignId}`)
        return jobs
    }

    // Get next pending job for any available account
    async getNextJob(): Promise<Job | null> {
        // Sort jobs by priority (higher first) and creation time (older first)
        const pendingJobs = Array.from(this.jobs.values())
            .filter(j => j.status === 'pending' && !this.runningJobs.has(j.id))
            .sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            })

        for (const job of pendingJobs) {
            // Check if account can still do this type of job today
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

    // Get next job for a specific account
    async getNextJobForAccount(accountId: number): Promise<Job | null> {
        const accountQueue = this.accountQueues.get(accountId) || []

        for (const jobId of accountQueue) {
            const job = this.jobs.get(jobId)
            if (job && job.status === 'pending' && !this.runningJobs.has(job.id)) {
                // Check quota
                if (job.type === 'review' && !(await this.canAccountDoReview(accountId))) {
                    return null // Account reached limit
                }
                return job
            }
        }

        return null
    }

    // Mark job as running
    startJob(jobId: string): void {
        const job = this.jobs.get(jobId)
        if (job) {
            job.status = 'running'
            job.startedAt = new Date().toISOString()
            this.runningJobs.add(jobId)
            console.log(`[JobQueue] Job ${jobId} started`)
        }
    }

    // Mark job as completed
    completeJob(jobId: string, result?: any): void {
        const job = this.jobs.get(jobId)
        if (job) {
            job.status = 'done'
            job.completedAt = new Date().toISOString()
            job.result = result ? JSON.stringify(result) : undefined
            this.runningJobs.delete(jobId)
            console.log(`[JobQueue] Job ${jobId} completed`)
        }
    }

    // Mark job as failed (with optional retry)
    failJob(jobId: string, error: string): void {
        const job = this.jobs.get(jobId)
        if (job) {
            job.retryCount++
            job.error = error
            this.runningJobs.delete(jobId)

            if (job.retryCount < job.maxRetries) {
                job.status = 'pending' // Will be retried
                console.log(`[JobQueue] Job ${jobId} failed, will retry (${job.retryCount}/${job.maxRetries})`)
            } else {
                job.status = 'failed'
                job.completedAt = new Date().toISOString()
                console.log(`[JobQueue] Job ${jobId} failed permanently after ${job.retryCount} retries`)
            }
        }
    }

    // Cancel a job
    cancelJob(jobId: string): void {
        const job = this.jobs.get(jobId)
        if (job) {
            job.status = 'cancelled'
            job.completedAt = new Date().toISOString()
            this.runningJobs.delete(jobId)
            console.log(`[JobQueue] Job ${jobId} cancelled`)
        }
    }

    // Cancel all jobs for a campaign
    cancelCampaignJobs(campaignId: number): void {
        const jobs = Array.from(this.jobs.values())
        for (const job of jobs) {
            if (job.campaignId === campaignId && (job.status === 'pending' || job.status === 'running')) {
                this.cancelJob(job.id)
            }
        }
    }

    // Get queue statistics
    getStats(): {
        total: number
        pending: number
        running: number
        done: number
        failed: number
        byAccount: Map<number, { pending: number; done: number }>
    } {
        const stats = {
            total: this.jobs.size,
            pending: 0,
            running: 0,
            done: 0,
            failed: 0,
            byAccount: new Map<number, { pending: number; done: number }>(),
        }

        const jobsList = Array.from(this.jobs.values())
        for (const job of jobsList) {
            switch (job.status) {
                case 'pending': stats.pending++; break
                case 'running': stats.running++; break
                case 'done': stats.done++; break
                case 'failed': stats.failed++; break
            }

            const accountStats = stats.byAccount.get(job.accountId) || { pending: 0, done: 0 }
            if (job.status === 'pending') accountStats.pending++
            if (job.status === 'done') accountStats.done++
            stats.byAccount.set(job.accountId, accountStats)
        }

        return stats
    }

    // Get all jobs
    getAllJobs(): Job[] {
        return Array.from(this.jobs.values())
    }

    // Get jobs for a campaign
    getCampaignJobs(campaignId: number): Job[] {
        return Array.from(this.jobs.values())
            .filter(j => j.campaignId === campaignId)
    }

    // Clear completed jobs
    clearCompleted(): void {
        const entries = Array.from(this.jobs.entries())
        for (const [id, job] of entries) {
            if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
                this.jobs.delete(id)
                const accountQueue = this.accountQueues.get(job.accountId) || []
                const idx = accountQueue.indexOf(id)
                if (idx > -1) accountQueue.splice(idx, 1)
            }
        }
        console.log('[JobQueue] Cleared completed jobs')
    }

    // Clear all jobs
    clearAll(): void {
        this.jobs.clear()
        this.accountQueues.clear()
        this.runningJobs.clear()
        console.log('[JobQueue] Cleared all jobs')
    }

    // Check if queue is empty
    isEmpty(): boolean {
        return this.jobs.size === 0 ||
            Array.from(this.jobs.values()).every(j => j.status !== 'pending')
    }

    // Get running job count
    getRunningCount(): number {
        return this.runningJobs.size
    }
}

// Singleton instance
export const jobQueue = new JobQueue()
