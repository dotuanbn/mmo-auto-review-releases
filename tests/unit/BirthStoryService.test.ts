import { describe, it, expect, vi, beforeEach } from 'vitest'
import { birthStoryService } from '../../src/main/services/BirthStoryService'
import { getDatabase, schema } from '../../src/main/database'

vi.mock('../../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        accounts: { id: 'id', birthStoryDay: 'birthStoryDay', birthStoryCompleted: 'birthStoryCompleted' }
    }
}))

vi.mock('drizzle-orm', () => ({
    eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
}))

describe('BirthStoryService', () => {
    let dbMock: any
    let accountRow: any

    beforeEach(() => {
        accountRow = {
            id: 1,
            warmupLevel: 10,
            birthStoryDay: 0,
            birthStoryCompleted: false
        }
        dbMock = {
            select: vi.fn().mockReturnThis(),
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            get: vi.fn().mockImplementation(() => accountRow),
            update: vi.fn().mockReturnThis(),
            set: vi.fn().mockReturnThis(),
            run: vi.fn()
        }
        ;(getDatabase as any).mockReturnValue(dbMock)
    })

    it('should return correct plan for day 1', () => {
        const plan = birthStoryService.getPlanForDay(1)
        expect(plan?.activity).toBe('search')
        expect(plan?.durationSeconds).toBe(180)
    })

    it('should return correct plan for day 7', () => {
        const plan = birthStoryService.getPlanForDay(7)
        expect(plan?.activity).toBe('gmail')
    })

    it('should increment day correctly', async () => {
        accountRow.birthStoryDay = 1
        await birthStoryService.progressBirthStory(1)
        expect(dbMock.update).toHaveBeenCalledWith(schema.accounts)
        expect(dbMock.set).toHaveBeenCalledWith({ birthStoryDay: 2, birthStoryCompleted: false })
    })

    it('should mark as completed when day reaches 7', async () => {
        accountRow.birthStoryDay = 7
        await birthStoryService.progressBirthStory(1)
        expect(dbMock.set).toHaveBeenCalledWith({ birthStoryDay: 7, birthStoryCompleted: true })
    })
})
