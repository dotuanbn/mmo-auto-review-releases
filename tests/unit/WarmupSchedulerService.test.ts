import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WarmupSchedulerService } from '../../src/main/services/WarmupSchedulerService'
import { getDatabase, schema } from '../../src/main/database'

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
        progressBirthStory: vi.fn().mockResolvedValue(undefined)
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
        vi.useRealTimers()
    })

    it('should start and stop timer', () => {
        expect(service.isRunning()).toBe(false)
        service.start()
        expect(service.isRunning()).toBe(true)
        service.stop()
        expect(service.isRunning()).toBe(false)
    })
})
