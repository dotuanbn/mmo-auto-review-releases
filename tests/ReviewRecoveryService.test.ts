/**
 * ReviewRecoveryService pure recovery/resume decisions + boot integration with JobQueue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
}))

import { getDatabase } from '../src/main/database'
import { JobQueue } from '../src/main/automation/JobQueue'
import {
    buildResumePlan,
    countJobStatuses,
    decideCampaignReconcileStatus,
    type JobStatusCounts,
} from '../src/main/automation/ReviewRecoveryService'

function counts(partial: Partial<JobStatusCounts>): JobStatusCounts {
    return {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
        ...partial,
    }
}

describe('countJobStatuses', () => {
    it('tallies all known statuses', () => {
        const c = countJobStatuses([
            { status: 'pending' },
            { status: 'pending' },
            { status: 'running' },
            { status: 'done' },
            { status: 'failed' },
            { status: 'cancelled' },
        ])
        expect(c).toEqual({
            pending: 2,
            running: 1,
            done: 1,
            failed: 1,
            cancelled: 1,
            total: 6,
        })
    })
})

describe('decideCampaignReconcileStatus', () => {
    it('pauses when pending work remains (resume-eligible)', () => {
        expect(decideCampaignReconcileStatus(counts({ pending: 2, total: 2 }))).toBe('paused')
    })

    it('pauses residual running as unfinished (defensive)', () => {
        expect(decideCampaignReconcileStatus(counts({ running: 1, total: 1 }))).toBe('paused')
    })

    it('marks done when only successful completions remain', () => {
        expect(decideCampaignReconcileStatus(counts({ done: 3, total: 3 }))).toBe('done')
    })

    it('marks error when failures remain and no unfinished work', () => {
        expect(decideCampaignReconcileStatus(counts({ done: 1, failed: 2, total: 3 }))).toBe('error')
        expect(decideCampaignReconcileStatus(counts({ failed: 1, total: 1 }))).toBe('error')
    })

    it('pauses empty queue and all-cancelled (safe, no false done)', () => {
        expect(decideCampaignReconcileStatus(counts({ total: 0 }))).toBe('paused')
        expect(decideCampaignReconcileStatus(counts({ cancelled: 4, total: 4 }))).toBe('paused')
    })

    it('done + cancelled without failed → done (work fully finished or intentionally stopped after success)', () => {
        // unfinished=0, done>0, failed=0 → done
        expect(decideCampaignReconcileStatus(counts({ done: 2, cancelled: 1, total: 3 }))).toBe('done')
    })
})

describe('buildResumePlan — never re-run done/cancelled', () => {
    it('can resume only when pending > 0', () => {
        const plan = buildResumePlan(counts({ pending: 5, done: 2, total: 7 }))
        expect(plan.canResume).toBe(true)
        expect(plan.pendingJobs).toBe(5)
        expect(plan.doneJobs).toBe(2)
    })

    it('refuses resume for all-done campaign', () => {
        const plan = buildResumePlan(counts({ done: 4, total: 4 }))
        expect(plan.canResume).toBe(false)
        expect(plan.reason).toMatch(/completed/i)
    })

    it('refuses resume for all-cancelled campaign', () => {
        const plan = buildResumePlan(counts({ cancelled: 3, total: 3 }))
        expect(plan.canResume).toBe(false)
        expect(plan.reason).toMatch(/cancelled/i)
    })

    it('refuses auto-resume for failed-only (use retryJob)', () => {
        const plan = buildResumePlan(counts({ failed: 2, total: 2 }))
        expect(plan.canResume).toBe(false)
        expect(plan.reason).toMatch(/retryJob|failed/i)
    })

    it('does not treat residual running as auto-resume without requeue', () => {
        const plan = buildResumePlan(counts({ running: 2, total: 2 }))
        expect(plan.canResume).toBe(false)
        expect(plan.reason).toMatch(/running|requeue/i)
    })
})

describe('JobQueue recovery integration (running requeue + terminal history)', () => {
    beforeEach(() => {
        vi.mocked(getDatabase).mockReset()
    })

    it('after load: only pending is resume-eligible; done/cancelled stay terminal', async () => {
        const rows = [
            {
                id: 'd1',
                campaignId: 42,
                type: 'review',
                accountId: 1,
                locationId: 1,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'done',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: null,
                completedAt: '2026-01-01T00:00:01.000Z',
            },
            {
                id: 'c1',
                campaignId: 42,
                type: 'review',
                accountId: 1,
                locationId: 2,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'cancelled',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: null,
                completedAt: '2026-01-01T00:00:01.000Z',
            },
            {
                id: 'r1',
                campaignId: 42,
                type: 'review',
                accountId: 1,
                locationId: 3,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'running',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: '2026-01-01T00:00:01.000Z',
                completedAt: null,
            },
        ]

        const emptyGet = async (): Promise<{ count: number }> => ({ count: 0 })
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => rows,
                    where: () => ({
                        get: emptyGet,
                        all: async () => [],
                    }),
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => undefined,
                }),
            }),
        } as never)

        const q = new JobQueue()
        await q.ensureLoaded()

        const jobCounts = countJobStatuses(q.getCampaignJobs(42))
        // running requeued → pending
        expect(jobCounts.pending).toBe(1)
        expect(jobCounts.running).toBe(0)
        expect(jobCounts.done).toBe(1)
        expect(jobCounts.cancelled).toBe(1)

        const plan = buildResumePlan(jobCounts)
        expect(plan.canResume).toBe(true)
        expect(plan.pendingJobs).toBe(1)
        expect(plan.doneJobs).toBe(1)
        expect(plan.cancelledJobs).toBe(1)

        // Reconcile would pause (has pending)
        expect(decideCampaignReconcileStatus(jobCounts)).toBe('paused')

        // Terminal jobs never appear as next work; claim is atomic pending→running
        const next = await q.getNextJob(42)
        expect(next?.id).toBe('r1')
        expect(next?.status).toBe('pending')

        const claimed = await q.claimNextJob(42)
        expect(claimed?.id).toBe('r1')
        expect(claimed?.status).toBe('running')
        expect(await q.claimNextJob(42)).toBeNull()
    })

    it('campaign with only done+cancelled is not a resume candidate', async () => {
        const rows = [
            {
                id: 'd1',
                campaignId: 99,
                type: 'review',
                accountId: 1,
                locationId: 1,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'done',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: null,
                completedAt: '2026-01-01T00:00:01.000Z',
            },
            {
                id: 'c1',
                campaignId: 99,
                type: 'review',
                accountId: 1,
                locationId: 2,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'cancelled',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: null,
                completedAt: '2026-01-01T00:00:01.000Z',
            },
        ]

        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => rows,
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => undefined,
                }),
            }),
        } as never)

        const q = new JobQueue()
        await q.ensureLoaded()

        expect(q.getCampaignIdsWithPending()).toEqual([])
        const plan = buildResumePlan(countJobStatuses(q.getCampaignJobs(99)))
        expect(plan.canResume).toBe(false)
    })

    it('permanently failed jobs stay terminal: not resume-eligible, not requeued', async () => {
        const rows = [
            {
                id: 'f1',
                campaignId: 55,
                type: 'review',
                accountId: 1,
                locationId: 1,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'failed',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: 'unconfirmed submit',
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: '2026-01-01T00:00:01.000Z',
                completedAt: '2026-01-01T00:00:02.000Z',
            },
        ]

        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => rows,
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => undefined,
                }),
            }),
        } as never)

        const q = new JobQueue()
        await q.ensureLoaded()

        expect(q.getJob('f1')?.status).toBe('failed')
        expect(q.getCampaignIdsWithPending()).toEqual([])
        const jobCounts = countJobStatuses(q.getCampaignJobs(55))
        expect(jobCounts.failed).toBe(1)
        expect(jobCounts.pending).toBe(0)
        const plan = buildResumePlan(jobCounts)
        expect(plan.canResume).toBe(false)
        expect(plan.reason).toMatch(/retryJob|failed/i)
        expect(decideCampaignReconcileStatus(jobCounts)).toBe('error')
        expect(await q.claimNextJob(55)).toBeNull()
    })
})
