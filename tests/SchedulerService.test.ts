/**
 * SchedulerService — real automation wiring, success-only advance, backoff, in-flight guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        campaigns: { id: 'campaigns.id', status: 'campaigns.status' },
        campaignSchedules: {
            id: 'campaign_schedules.id',
            campaignId: 'campaign_schedules.campaign_id',
            isActive: 'campaign_schedules.is_active',
            nextRunAt: 'campaign_schedules.next_run_at',
        },
    },
}))

vi.mock('drizzle-orm', () => ({
    eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
    and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
    lte: vi.fn((...args: unknown[]) => ({ op: 'lte', args })),
}))

vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
}))

import { getDatabase } from '../src/main/database'
import {
    SchedulerService,
    type CampaignAutomationRunner,
    type CampaignSchedule,
} from '../src/main/services/SchedulerService'

interface ScheduleRow extends CampaignSchedule {
    [key: string]: unknown
}

interface CampaignRow {
    id: number
    status: string
    name?: string
}

function baseSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
    const past = new Date(Date.now() - 60_000)
    return {
        id: 1,
        campaignId: 10,
        scheduledAt: past,
        repeatType: 'once',
        repeatDays: null,
        endDate: null,
        lastRunAt: null,
        nextRunAt: past,
        isActive: true,
        createdAt: past,
        ...overrides,
    }
}

function createMockDb(opts: {
    schedules?: ScheduleRow[]
    campaign?: CampaignRow | null
    onScheduleUpdate?: (patch: Record<string, unknown>) => void
    onCampaignUpdate?: (patch: Record<string, unknown>) => void
}) {
    const schedules = opts.schedules ?? [baseSchedule()]
    const campaign = opts.campaign === undefined ? { id: 10, status: 'pending' } : opts.campaign
    let lastSchedulePatch: Record<string, unknown> | null = null
    let lastCampaignPatch: Record<string, unknown> | null = null
    let campaignUpdateCount = 0

    const db = {
        select: () => ({
            from: (table: { id?: string }) => {
                const isCampaign = table?.id === 'campaigns.id'
                return {
                    where: () => ({
                        get: () => (isCampaign ? campaign : schedules[0] ?? null),
                        all: () => (isCampaign ? (campaign ? [campaign] : []) : schedules),
                    }),
                    all: () => (isCampaign ? (campaign ? [campaign] : []) : schedules),
                    get: () => (isCampaign ? campaign : schedules[0] ?? null),
                }
            },
        }),
        update: (table: { id?: string }) => ({
            set: (patch: Record<string, unknown>) => ({
                where: () => ({
                    run: () => {
                        if (table?.id === 'campaigns.id') {
                            campaignUpdateCount += 1
                            lastCampaignPatch = patch
                            opts.onCampaignUpdate?.(patch)
                        } else {
                            lastSchedulePatch = patch
                            opts.onScheduleUpdate?.(patch)
                            if (schedules[0]) {
                                Object.assign(schedules[0], patch)
                            }
                        }
                        return { changes: 1 }
                    },
                }),
            }),
        }),
        insert: () => ({
            values: () => ({
                run: () => ({ lastInsertRowid: 99 }),
            }),
        }),
        delete: () => ({
            where: () => ({
                run: () => ({ changes: 1 }),
            }),
        }),
    }

    return {
        db,
        get lastSchedulePatch() {
            return lastSchedulePatch
        },
        get lastCampaignPatch() {
            return lastCampaignPatch
        },
        get campaignUpdateCount() {
            return campaignUpdateCount
        },
        schedules,
    }
}

function mockRunner(overrides: Partial<CampaignAutomationRunner> = {}): CampaignAutomationRunner & {
    startCampaign: ReturnType<typeof vi.fn>
    resumeCampaign: ReturnType<typeof vi.fn>
    hasPendingDurableJobs: ReturnType<typeof vi.fn>
} {
    return {
        startCampaign: vi.fn(async () => ({ success: true })),
        resumeCampaign: vi.fn(async () => ({ success: true })),
        hasPendingDurableJobs: vi.fn(async () => false),
        ...overrides,
    } as CampaignAutomationRunner & {
        startCampaign: ReturnType<typeof vi.fn>
        resumeCampaign: ReturnType<typeof vi.fn>
        hasPendingDurableJobs: ReturnType<typeof vi.fn>
    }
}

describe('SchedulerService — automation execution', () => {
    let service: SchedulerService

    beforeEach(() => {
        vi.clearAllMocks()
        service = new SchedulerService()
        service.resetRuntimeStateForTests()
    })

    it('calls startCampaign when no durable pending jobs', async () => {
        const mock = createMockDb({})
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        const runner = mockRunner({ hasPendingDurableJobs: vi.fn(async () => false) })
        service.setAutomationRunner(runner)

        await service.checkAndStartDue()

        expect(runner.hasPendingDurableJobs).toHaveBeenCalledWith(10)
        expect(runner.startCampaign).toHaveBeenCalledWith(10)
        expect(runner.resumeCampaign).not.toHaveBeenCalled()
    })

    it('calls resumeCampaign when durable pending jobs exist', async () => {
        const mock = createMockDb({ campaign: { id: 10, status: 'paused' } })
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        const runner = mockRunner({ hasPendingDurableJobs: vi.fn(async () => true) })
        service.setAutomationRunner(runner)

        await service.checkAndStartDue()

        expect(runner.resumeCampaign).toHaveBeenCalledWith(10)
        expect(runner.startCampaign).not.toHaveBeenCalled()
    })

    it('advances lastRunAt/nextRunAt only after runner success (once → deactivate)', async () => {
        const mock = createMockDb({ schedules: [baseSchedule({ repeatType: 'once' })] })
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        service.setAutomationRunner(mockRunner())

        await service.checkAndStartDue()

        expect(mock.lastSchedulePatch).toMatchObject({
            isActive: false,
            nextRunAt: null,
        })
        expect(mock.lastSchedulePatch?.lastRunAt).toBeInstanceOf(Date)
        // Must NOT fake campaign.status = running
        expect(mock.campaignUpdateCount).toBe(0)
    })

    it('on start failure does not mark success schedule advance; applies backoff nextRunAt', async () => {
        const schedule = baseSchedule({ nextRunAt: new Date(Date.now() - 1000) })
        const mock = createMockDb({ schedules: [schedule] })
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        service.setAutomationRunner(
            mockRunner({
                startCampaign: vi.fn(async () => ({ success: false, error: 'Outside working hours' })),
            })
        )

        const before = Date.now()
        await service.checkAndStartDue()

        expect(mock.lastSchedulePatch?.lastRunAt).toBeUndefined()
        expect(mock.lastSchedulePatch?.isActive).toBeUndefined()
        const next = mock.lastSchedulePatch?.nextRunAt as Date
        expect(next).toBeInstanceOf(Date)
        // Base backoff 2 minutes
        expect(next.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000 - 50)
        expect(service.getFailureCountForTests(1)).toBe(1)
        expect(mock.campaignUpdateCount).toBe(0)
    })

    it('bounded retry: after max failures, once schedule is deactivated', async () => {
        const schedule = baseSchedule({ repeatType: 'once' })
        const mock = createMockDb({ schedules: [schedule] })
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        service.setAutomationRunner(
            mockRunner({
                startCampaign: vi.fn(async () => ({ success: false, error: 'boom' })),
            })
        )

        for (let i = 0; i < 5; i++) {
            // Keep due so each check re-attempts
            schedule.nextRunAt = new Date(Date.now() - 1000)
            schedule.isActive = true
            await service.checkAndStartDue()
        }

        expect(service.getFailureCountForTests(1)).toBe(5)
        expect(mock.lastSchedulePatch).toMatchObject({ isActive: false, nextRunAt: null })
    })

    it('in-flight guard blocks concurrent double-tick for the same schedule', async () => {
        const mock = createMockDb({})
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)

        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const startCampaign = vi.fn(async () => {
            await gate
            return { success: true }
        })
        service.setAutomationRunner(mockRunner({ startCampaign }))

        const first = service.checkAndStartDue()
        // Second tick while first still in-flight
        await Promise.resolve()
        const second = service.checkAndStartDue()
        await Promise.resolve()

        expect(service.getInFlightCountForTests()).toBe(1)

        release()
        await Promise.all([first, second])

        expect(startCampaign).toHaveBeenCalledTimes(1)
        expect(service.getInFlightCountForTests()).toBe(0)
    })

    it('daily success sets nextRunAt ~+1 day and keeps active', async () => {
        const schedule = baseSchedule({ repeatType: 'daily', isActive: true })
        const mock = createMockDb({ schedules: [schedule] })
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        service.setAutomationRunner(mockRunner())

        await service.checkAndStartDue()

        const next = mock.lastSchedulePatch?.nextRunAt as Date
        const last = mock.lastSchedulePatch?.lastRunAt as Date
        expect(mock.lastSchedulePatch?.isActive).toBe(true)
        expect(next.getTime() - last.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60_000 - 1000)
    })

    it('fails safely when automation runner is not injected (backoff, no campaign running)', async () => {
        const mock = createMockDb({})
        vi.mocked(getDatabase).mockReturnValue(mock.db as never)
        // no setAutomationRunner

        await service.checkAndStartDue()

        expect(mock.campaignUpdateCount).toBe(0)
        expect(mock.lastSchedulePatch?.nextRunAt).toBeInstanceOf(Date)
        expect(mock.lastSchedulePatch?.lastRunAt).toBeUndefined()
    })

    it('calculateNextRunTime custom weekdays picks next matching day', () => {
        // Wednesday 2026-07-15
        const wed = new Date('2026-07-15T10:00:00')
        const next = service.calculateNextRunTime(wed, 'custom', [1, 5]) // Mon, Fri
        expect(next.getDay()).toBe(5) // Friday
    })
})
