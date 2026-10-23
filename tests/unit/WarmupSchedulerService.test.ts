import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WarmupSchedulerService } from '../../src/main/services/WarmupSchedulerService'
import { getDatabase, schema } from '../../src/main/database'
import { browserResourceGovernor } from '../../src/main/services/BrowserResourceGovernor'
import { accountWarmupEngine } from '../../src/main/automation/AccountWarmupEngine'

vi.mock('../../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        accounts: { id: 'id', status: 'status', autoWarmupEnabled: 'autoWarmupEnabled' }
    }
}))

vi.mock('../../src/main/automation/AccountWarmupEngine', () => ({
    accountWarmupEngine: {
        getRunningIds: vi.fn().mockReturnValue(new Set()),
        isRunning: vi.fn().mockReturnValue(false),
        start: vi.fn().mockResolvedValue({ success: true })
    }
}))

vi.mock('../../src/main/services/AccountWarmupService', () => ({
    accountWarmupService: {
        getWarmupData: vi.fn().mockResolvedValue({})
    },
    evaluateStartEligibility: vi.fn().mockReturnValue({ allowed: true })
}))

vi.mock('../../src/main/services/BirthStoryService', () => ({
    birthStoryService: {
        getPlanForDay: vi.fn().mockReturnValue({ activity: 'search', durationSeconds: 300 }),
        progressBirthStory: vi.fn().mockResolvedValue(undefined),
        applyPlan: vi.fn().mockResolvedValue(null),
    }
}))

describe('WarmupSchedulerService', () => {
    let service: WarmupSchedulerService
    
    beforeEach(() => {
        vi.useFakeTimers()
        service = new WarmupSchedulerService()
    })

    afterEach(() => {
        service.stop()
        browserResourceGovernor.configure(false)
        vi.useRealTimers()
        vi.clearAllMocks()
    })

    it('should start and stop timer', () => {
        expect(service.isRunning()).toBe(false)
        service.start()
        expect(service.isRunning()).toBe(true)
        service.stop()
        expect(service.isRunning()).toBe(false)
    })

    it('does not postpone warmups or reduce their normal concurrency when low-resource mode is enabled', async () => {
        const running = new Set<number>()
        vi.mocked(accountWarmupEngine.getRunningIds).mockReturnValue(running)
        vi.mocked(accountWarmupEngine.start).mockImplementation(async (accountId) => {
            running.add(accountId)
            return { success: true }
        })
        vi.mocked(getDatabase).mockReturnValue({
            select: () => ({
                from: () => ({
                    where: () => ({
                        all: () => [
                            { id: 1, birthStoryCompleted: true },
                            { id: 2, birthStoryCompleted: true },
                            { id: 3, birthStoryCompleted: true },
                        ],
                    }),
                }),
            }),
        } as ReturnType<typeof getDatabase>)
        browserResourceGovernor.configure(true)
        const releaseForeground = await browserResourceGovernor.acquire()
        try {
            service.start()
            await service.tick()
            expect(accountWarmupEngine.start).toHaveBeenCalledTimes(2)
            expect(running).toEqual(new Set([1, 2]))
        } finally { releaseForeground() }
    })
})
