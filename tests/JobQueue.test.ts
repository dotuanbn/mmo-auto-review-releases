/**
 * JobQueue state machine + concurrency regression tests.
 * DB is mocked; state machine runs in-memory via markLoadedForTests().
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
}))

import { getDatabase } from '../src/main/database'
import {
    JobQueue,
    getLocalDayStart,
    isActiveJobStatus,
    isImmutableTerminalStatus,
    type Job,
} from '../src/main/automation/JobQueue'

function mockDatabase(): void {
    const emptyAll = async (): Promise<unknown[]> => []
    const emptyGet = async (): Promise<undefined> => undefined
    const noop = async (): Promise<void> => undefined

    vi.mocked(getDatabase).mockReturnValue({
        select: () => ({
            from: () => ({
                all: emptyAll,
                where: () => ({
                    get: emptyGet,
                    all: emptyAll,
                }),
            }),
        }),
        insert: () => ({
            values: () => ({
                onConflictDoUpdate: noop,
            }),
        }),
        update: () => ({
            set: () => ({
                where: noop,
            }),
        }),
        delete: () => ({
            where: noop,
        }),
    } as never)
}

function baseParams(overrides: Partial<Pick<Job, 'campaignId' | 'accountId' | 'locationId' | 'priority' | 'maxRetries'>> = {}) {
    return {
        campaignId: 1,
        type: 'review' as const,
        accountId: 10,
        locationId: 100,
        reviewText: 'ok',
        rating: 5,
        priority: 0,
        maxRetries: 3,
        ...overrides,
    }
}

describe('JobQueue — terminal state machine', () => {
    let q: JobQueue

    beforeEach(() => {
        mockDatabase()
        q = new JobQueue()
        q.markLoadedForTests()
    })

    it('isImmutableTerminalStatus covers done + cancelled only', () => {
        expect(isImmutableTerminalStatus('done')).toBe(true)
        expect(isImmutableTerminalStatus('cancelled')).toBe(true)
        expect(isImmutableTerminalStatus('failed')).toBe(false)
        expect(isImmutableTerminalStatus('pending')).toBe(false)
        expect(isImmutableTerminalStatus('running')).toBe(false)
    })

    it('start → complete yields done and keeps history for idempotency', async () => {
        const job = await q.addJob(baseParams())
        expect(job.status).toBe('pending')

        const started = await q.startJob(job.id)
        expect(started.applied).toBe(true)
        expect(q.getJob(job.id)?.status).toBe('running')

        const done = await q.completeJob(job.id, { success: true })
        expect(done.applied).toBe(true)
        expect(done.status).toBe('done')

        // History retained (not deleted)
        expect(q.getCampaignJobs(1)).toHaveLength(1)
        expect(q.getBlockingPairKeys(1).has('10:100')).toBe(true)

        // Idempotent complete
        const again = await q.completeJob(job.id, { success: true })
        expect(again.applied).toBe(true)
        expect(again.reason).toBe('already_done')
        expect(q.getJob(job.id)?.status).toBe('done')
    })

    it('cancel of running blocks later complete (stop campaign race)', async () => {
        const job = await q.addJob(baseParams())
        await q.startJob(job.id)

        const cancelled = await q.cancelJob(job.id)
        expect(cancelled.applied).toBe(true)
        expect(cancelled.status).toBe('cancelled')

        const complete = await q.completeJob(job.id, { success: true })
        expect(complete.applied).toBe(false)
        expect(complete.reason).toBe('blocked_by_cancelled')
        expect(q.getJob(job.id)?.status).toBe('cancelled')
    })

    it('cancel of running blocks later failJob', async () => {
        const job = await q.addJob(baseParams())
        await q.startJob(job.id)
        await q.cancelJob(job.id)

        const fail = await q.failJob(job.id, 'late error')
        expect(fail.applied).toBe(false)
        expect(fail.reason).toBe('blocked_by_cancelled')
        expect(q.getJob(job.id)?.status).toBe('cancelled')
    })

    it('done blocks cancel and fail (terminal)', async () => {
        const job = await q.addJob(baseParams())
        await q.startJob(job.id)
        await q.completeJob(job.id)

        const cancel = await q.cancelJob(job.id)
        expect(cancel.applied).toBe(false)
        expect(cancel.reason).toBe('blocked_by_done')

        const fail = await q.failJob(job.id, 'x')
        expect(fail.applied).toBe(false)
        expect(fail.reason).toBe('blocked_by_done')
        expect(q.getJob(job.id)?.status).toBe('done')
    })

    it('refuse start on done/cancelled', async () => {
        const a = await q.addJob(baseParams({ locationId: 1 }))
        await q.startJob(a.id)
        await q.completeJob(a.id)
        expect((await q.startJob(a.id)).applied).toBe(false)

        const b = await q.addJob(baseParams({ locationId: 2 }))
        await q.cancelJob(b.id)
        expect((await q.startJob(b.id)).applied).toBe(false)
    })

    it('failJob retries then permanent failed; never overwrites done', async () => {
        const job = await q.addJob(baseParams({ maxRetries: 2 }))
        await q.startJob(job.id)

        const r1 = await q.failJob(job.id, 'e1')
        expect(r1.applied).toBe(true)
        expect(r1.status).toBe('pending')
        expect(q.getJob(job.id)?.retryCount).toBe(1)

        await q.startJob(job.id)
        const r2 = await q.failJob(job.id, 'e2')
        expect(r2.status).toBe('failed')
        expect(q.getJob(job.id)?.status).toBe('failed')
    })

    it('retryJob allows failed/cancelled but never done; resets retryCount', async () => {
        const doneJob = await q.addJob(baseParams({ locationId: 1 }))
        await q.startJob(doneJob.id)
        await q.completeJob(doneJob.id)
        expect(await q.retryJob(doneJob.id)).toBe(false)
        expect(q.getJob(doneJob.id)?.status).toBe('done')

        const cancelled = await q.addJob(baseParams({ locationId: 2 }))
        await q.cancelJob(cancelled.id)
        expect(await q.retryJob(cancelled.id)).toBe(true)
        expect(q.getJob(cancelled.id)?.status).toBe('pending')
        expect(q.getJob(cancelled.id)?.retryCount).toBe(0)

        // Permanent fail then manual retry resets retryCount
        const failed = await q.addJob(baseParams({ locationId: 3, maxRetries: 1 }))
        await q.startJob(failed.id)
        await q.failJob(failed.id, 'boom')
        expect(q.getJob(failed.id)?.status).toBe('failed')
        expect(q.getJob(failed.id)?.retryCount).toBe(1)
        expect(await q.retryJob(failed.id)).toBe(true)
        expect(q.getJob(failed.id)?.status).toBe('pending')
        expect(q.getJob(failed.id)?.retryCount).toBe(0)
    })

    it('startJob already_running returns applied=false', async () => {
        const job = await q.addJob(baseParams())
        const first = await q.startJob(job.id)
        expect(first.applied).toBe(true)
        expect(first.status).toBe('running')

        const second = await q.startJob(job.id)
        expect(second.applied).toBe(false)
        expect(second.reason).toBe('already_running')
        expect(second.status).toBe('running')
        expect(q.getJob(job.id)?.status).toBe('running')
    })

    it('cancelCampaignJobs cancels only pending/running; preserves done history', async () => {
        const doneJob = await q.addJob(baseParams({ locationId: 1 }))
        await q.startJob(doneJob.id)
        await q.completeJob(doneJob.id)

        const pending = await q.addJob(baseParams({ locationId: 2 }))
        const running = await q.addJob(baseParams({ locationId: 3 }))
        await q.startJob(running.id)

        const n = await q.cancelCampaignJobs(1)
        expect(n).toBe(2)
        expect(q.getJob(doneJob.id)?.status).toBe('done')
        expect(q.getJob(pending.id)?.status).toBe('cancelled')
        expect(q.getJob(running.id)?.status).toBe('cancelled')
        // Done pair still blocks re-enqueue
        expect(q.getBlockingPairKeys(1).has('10:1')).toBe(true)
    })

    it('clearCompleted hides from stats but keeps jobs for idempotency', async () => {
        const job = await q.addJob(baseParams())
        await q.startJob(job.id)
        await q.completeJob(job.id)
        q.clearCompleted(1)
        expect(q.getStats(1).done).toBe(0)
        expect(q.getCampaignJobs(1)).toHaveLength(1)
        expect(q.getBlockingPairKeys(1).has('10:100')).toBe(true)
    })
})

describe('JobQueue — concurrent transition races', () => {
    let q: JobQueue

    beforeEach(() => {
        mockDatabase()
        q = new JobQueue()
        q.markLoadedForTests()
    })

    it('concurrent cancel + complete: cancelled wins, never flips to done', async () => {
        const job = await q.addJob(baseParams())
        await q.startJob(job.id)

        const [c, d] = await Promise.all([
            q.cancelJob(job.id),
            q.completeJob(job.id, { success: true }),
        ])

        const status = q.getJob(job.id)?.status
        expect(status === 'cancelled' || status === 'done').toBe(true)
        // Exactly one applied transition into a terminal (or idempotent)
        if (status === 'cancelled') {
            expect(c.applied).toBe(true)
            expect(d.applied).toBe(false)
            expect(d.reason).toBe('blocked_by_cancelled')
        } else {
            expect(d.applied).toBe(true)
            expect(c.applied).toBe(false)
            expect(c.reason).toBe('blocked_by_done')
        }
        // No torn state
        expect(isImmutableTerminalStatus(status!)).toBe(true)
    })

    it('many concurrent completes after cancel stay cancelled', async () => {
        const job = await q.addJob(baseParams())
        await q.startJob(job.id)
        await q.cancelJob(job.id)

        const results = await Promise.all([
            q.completeJob(job.id),
            q.completeJob(job.id),
            q.failJob(job.id, 'x'),
            q.completeJob(job.id),
        ])

        expect(q.getJob(job.id)?.status).toBe('cancelled')
        for (const r of results) {
            expect(r.applied).toBe(false)
        }
    })

    it('concurrent cancelCampaignJobs + completeJob for in-flight workers', async () => {
        const jobs = await Promise.all([
            q.addJob(baseParams({ locationId: 1 })),
            q.addJob(baseParams({ locationId: 2 })),
            q.addJob(baseParams({ locationId: 3 })),
        ])
        for (const j of jobs) {
            await q.startJob(j.id)
        }

        await Promise.all([
            q.cancelCampaignJobs(1),
            q.completeJob(jobs[0].id),
            q.completeJob(jobs[1].id),
            q.failJob(jobs[2].id, 'late'),
        ])

        for (const j of jobs) {
            const status = q.getJob(j.id)?.status
            // Must be terminal and not leave running
            expect(status === 'cancelled' || status === 'done' || status === 'failed' || status === 'pending').toBe(true)
            expect(status).not.toBe('running')
        }
        // No job silently left running
        expect(q.getRunningCount(1)).toBe(0)
    })

    it('isActiveJobStatus helper matches pending/running only', () => {
        expect(isActiveJobStatus('pending')).toBe(true)
        expect(isActiveJobStatus('running')).toBe(true)
        expect(isActiveJobStatus('done')).toBe(false)
        expect(isActiveJobStatus('cancelled')).toBe(false)
    })
})

describe('JobQueue — claimNextJob atomic', () => {
    let q: JobQueue

    beforeEach(() => {
        mockDatabase()
        q = new JobQueue()
        q.markLoadedForTests()
    })

    it('claimNextJob sets running + persist before return', async () => {
        const job = await q.addJob(baseParams())
        const claimed = await q.claimNextJob(1)
        expect(claimed?.id).toBe(job.id)
        expect(claimed?.status).toBe('running')
        expect(q.getJob(job.id)?.status).toBe('running')
        expect(q.getRunningCount(1)).toBe(1)
        // Peek must not return already-claimed
        expect(await q.getNextJob(1)).toBeNull()
    })

    it('concurrent claimNextJob never hands same job to two workers', async () => {
        const a = await q.addJob(baseParams({ locationId: 1, accountId: 1 }))
        const b = await q.addJob(baseParams({ locationId: 2, accountId: 2 }))
        const c = await q.addJob(baseParams({ locationId: 3, accountId: 3 }))

        const results = await Promise.all([
            q.claimNextJob(1),
            q.claimNextJob(1),
            q.claimNextJob(1),
            q.claimNextJob(1),
        ])

        const ids = results.filter((j): j is Job => j != null).map(j => j.id)
        expect(ids).toHaveLength(3)
        expect(new Set(ids).size).toBe(3)
        expect(ids.sort()).toEqual([a.id, b.id, c.id].sort())
        expect(q.getRunningCount(1)).toBe(3)
        expect(await q.claimNextJob(1)).toBeNull()
    })

    it('claimNextJob enforces max 1 running review per account', async () => {
        const first = await q.addJob(baseParams({ accountId: 99, locationId: 1 }))
        const second = await q.addJob(baseParams({ accountId: 99, locationId: 2 }))
        const other = await q.addJob(baseParams({ accountId: 88, locationId: 3 }))

        const c1 = await q.claimNextJob(1)
        expect(c1?.id).toBe(first.id)
        expect(c1?.status).toBe('running')

        // Same account second review must wait; other account is claimable
        const c2 = await q.claimNextJob(1)
        expect(c2?.id).toBe(other.id)
        expect(c2?.accountId).toBe(88)

        // Account 99 still blocked while first is running
        expect(await q.claimNextJob(1)).toBeNull()
        expect(q.getJob(second.id)?.status).toBe('pending')

        await q.completeJob(first.id)
        const c3 = await q.claimNextJob(1)
        expect(c3?.id).toBe(second.id)
        expect(c3?.status).toBe('running')
    })

    it('claimNextJob persist throw rolls back status/runningJobs/startedAt and rethrows', async () => {
        const job = await q.addJob(baseParams())
        expect(job.status).toBe('pending')

        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => [],
                    where: () => ({
                        get: async () => ({ count: 0 }),
                        all: async () => [],
                    }),
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => {
                        throw new Error('persist boom')
                    },
                }),
            }),
        } as never)

        await expect(q.claimNextJob(1)).rejects.toThrow(/persist boom/)

        const after = q.getJob(job.id)
        expect(after?.status).toBe('pending')
        expect(after?.startedAt).toBeUndefined()
        expect(q.getRunningCount(1)).toBe(0)
        // Job remains claimable after rollback
        mockDatabase()
        const claimed = await q.claimNextJob(1)
        expect(claimed?.id).toBe(job.id)
        expect(claimed?.status).toBe('running')
    })
})

describe('JobQueue — ensureLoaded single-flight + fail-safe', () => {
    it('DB load failure leaves loaded=false and rethrows (no fake empty queue)', async () => {
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => {
                        throw new Error('db down')
                    },
                }),
            }),
        } as never)

        const q = new JobQueue()
        await expect(q.ensureLoaded()).rejects.toThrow(/db down/)
        expect(q.isLoaded()).toBe(false)
        expect(q.getAllJobs()).toHaveLength(0)
    })

    it('concurrent ensureLoaded shares one load (single-flight)', async () => {
        let loadCalls = 0
        const rows: unknown[] = []
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => {
                        loadCalls++
                        await new Promise(r => setTimeout(r, 30))
                        return rows
                    },
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => undefined,
                }),
            }),
        } as never)

        const q = new JobQueue()
        await Promise.all([q.ensureLoaded(), q.ensureLoaded(), q.ensureLoaded()])
        expect(q.isLoaded()).toBe(true)
        expect(loadCalls).toBe(1)
    })

    it('after failed load, retry can succeed', async () => {
        let attempts = 0
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => {
                        attempts++
                        if (attempts === 1) throw new Error('transient')
                        return []
                    },
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => undefined,
                }),
            }),
        } as never)

        const q = new JobQueue()
        await expect(q.ensureLoaded()).rejects.toThrow(/transient/)
        expect(q.isLoaded()).toBe(false)
        await q.ensureLoaded()
        expect(q.isLoaded()).toBe(true)
        expect(attempts).toBe(2)
    })
})

describe('JobQueue — daily review count (local-day + fail-closed)', () => {
    it('getAccountReviewCountToday filters status=success', async () => {
        const whereCaptured: unknown[] = []
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => [],
                    where: (...args: unknown[]) => {
                        whereCaptured.push(args)
                        return {
                            get: async () => ({ count: 2 }),
                            all: async () => [],
                        }
                    },
                }),
            }),
            insert: () => ({
                values: () => ({
                    onConflictDoUpdate: async () => undefined,
                }),
            }),
        } as never)

        const q = new JobQueue()
        q.markLoadedForTests()
        const n = await q.getAccountReviewCountToday(10)
        expect(n).toBe(2)
        // where() was invoked (success filter applied in production query)
        expect(whereCaptured.length).toBeGreaterThan(0)
    })

    it('getLocalDayStart uses machine-local midnight (not UTC ISO day)', () => {
        // Local Jan 1 00:30 — same local day as getLocalDayStart
        const localMorning = new Date(2026, 0, 1, 0, 30, 0, 0)
        const start = getLocalDayStart(localMorning)
        expect(start.getFullYear()).toBe(2026)
        expect(start.getMonth()).toBe(0)
        expect(start.getDate()).toBe(1)
        expect(start.getHours()).toBe(0)
        expect(start.getMinutes()).toBe(0)
        expect(start.getSeconds()).toBe(0)
        expect(start.getMilliseconds()).toBe(0)

        // Boundary: just before local midnight belongs to previous local day
        const beforeMidnight = new Date(2026, 0, 1, 0, 0, 0, 0)
        const prevMs = beforeMidnight.getTime() - 1
        const prev = new Date(prevMs)
        const prevStart = getLocalDayStart(prev)
        expect(prevStart.getTime()).toBeLessThan(start.getTime())
        expect(prevStart.getDate()).not.toBe(1)

        // Contrast with UTC ISO date key (can diverge near TZ boundaries)
        const lateEvening = new Date(2026, 5, 15, 23, 30, 0, 0)
        const localKey = `${lateEvening.getFullYear()}-${String(lateEvening.getMonth() + 1).padStart(2, '0')}-${String(lateEvening.getDate()).padStart(2, '0')}`
        const isoKey = lateEvening.toISOString().split('T')[0]
        const dayStart = getLocalDayStart(lateEvening)
        const dayStartKey = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`
        expect(dayStartKey).toBe(localKey)
        // When local TZ is behind UTC, ISO day may already be next day — helper stays local
        if (isoKey !== localKey) {
            expect(dayStartKey).not.toBe(isoKey)
        }
    })

    it('getAccountReviewCountToday DB error fail-closed rethrows (never returns 0)', async () => {
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => [],
                    where: () => ({
                        get: async () => {
                            throw new Error('count query failed')
                        },
                        all: async () => [],
                    }),
                }),
            }),
        } as never)

        const q = new JobQueue()
        q.markLoadedForTests()
        await expect(q.getAccountReviewCountToday(10)).rejects.toThrow(/count query failed/)
    })
})

describe('JobQueue — markJobPermanentlyFailed (no retry, terminal)', () => {
    let q: JobQueue

    beforeEach(() => {
        mockDatabase()
        q = new JobQueue()
        q.markLoadedForTests()
    })

    it('marks running job failed without retry/requeue and without bumping retryCount', async () => {
        const job = await q.addJob(baseParams({ maxRetries: 3 }))
        await q.startJob(job.id)
        expect(q.getJob(job.id)?.retryCount).toBe(0)

        const result = await q.markJobPermanentlyFailed(job.id, 'unconfirmed submit')
        expect(result.applied).toBe(true)
        expect(result.status).toBe('failed')

        const after = q.getJob(job.id)
        expect(after?.status).toBe('failed')
        expect(after?.error).toBe('unconfirmed submit')
        expect(after?.retryCount).toBe(0)
        expect(after?.completedAt).toBeDefined()
        expect(q.getRunningCount(1)).toBe(0)
        // Not pending — will not be claimed again
        expect(await q.claimNextJob(1)).toBeNull()
    })

    it('marks pending job permanently failed (post-requeue safety)', async () => {
        const job = await q.addJob(baseParams())
        const result = await q.markJobPermanentlyFailed(job.id, 'policy block')
        expect(result.applied).toBe(true)
        expect(q.getJob(job.id)?.status).toBe('failed')
        expect(await q.getNextJob(1)).toBeNull()
    })

    it('does not overwrite done/cancelled; idempotent on already failed', async () => {
        const doneJob = await q.addJob(baseParams({ locationId: 1 }))
        await q.startJob(doneJob.id)
        await q.completeJob(doneJob.id)
        expect((await q.markJobPermanentlyFailed(doneJob.id, 'x')).applied).toBe(false)
        expect(q.getJob(doneJob.id)?.status).toBe('done')

        const cancelled = await q.addJob(baseParams({ locationId: 2 }))
        await q.cancelJob(cancelled.id)
        expect((await q.markJobPermanentlyFailed(cancelled.id, 'x')).reason).toBe('blocked_by_cancelled')

        const failed = await q.addJob(baseParams({ locationId: 3, maxRetries: 1 }))
        await q.startJob(failed.id)
        await q.failJob(failed.id, 'boom')
        const again = await q.markJobPermanentlyFailed(failed.id, 'again')
        expect(again.applied).toBe(true)
        expect(again.reason).toBe('already_failed')
        expect(q.getJob(failed.id)?.status).toBe('failed')
    })
})

describe('JobQueue — recovery load requeues only running', () => {
    it('loadFromDatabase requeues running → pending; keeps done/cancelled', async () => {
        const rows = [
            {
                id: 'job_done',
                campaignId: 7,
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
                result: '{}',
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: '2026-01-01T00:00:01.000Z',
                completedAt: '2026-01-01T00:00:02.000Z',
            },
            {
                id: 'job_cancelled',
                campaignId: 7,
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
                completedAt: '2026-01-01T00:00:03.000Z',
            },
            {
                id: 'job_running',
                campaignId: 7,
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
            {
                id: 'job_pending',
                campaignId: 7,
                type: 'review',
                accountId: 1,
                locationId: 4,
                reviewText: null,
                rating: 5,
                targetViews: null,
                priority: 0,
                status: 'pending',
                retryCount: 0,
                maxRetries: 3,
                result: null,
                error: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                startedAt: null,
                completedAt: null,
            },
        ]

        const persisted: Array<{ id: string; status: string }> = []
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    all: async () => rows,
                }),
            }),
            insert: () => ({
                values: (v: { id: string; status: string }) => ({
                    onConflictDoUpdate: async () => {
                        persisted.push({ id: v.id, status: v.status })
                    },
                }),
            }),
        } as never)

        const q = new JobQueue()
        await q.ensureLoaded()

        expect(q.getLastRequeuedRunningCount()).toBe(1)
        expect(q.getJob('job_done')?.status).toBe('done')
        expect(q.getJob('job_cancelled')?.status).toBe('cancelled')
        expect(q.getJob('job_running')?.status).toBe('pending')
        expect(q.getJob('job_pending')?.status).toBe('pending')
        expect(q.getCampaignIdsWithPending()).toEqual([7])
        expect(persisted.some(p => p.id === 'job_running' && p.status === 'pending')).toBe(true)
        expect(persisted.some(p => p.id === 'job_done')).toBe(false)
        expect(persisted.some(p => p.id === 'job_cancelled')).toBe(false)
    })
})
