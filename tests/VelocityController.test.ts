/**
 * Cross-account velocity. Database and settings are mocked; the SQL is not executed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loadSettingsMock, getMock, allMock } = vi.hoisted(() => ({
    loadSettingsMock: vi.fn(),
    getMock: vi.fn(),
    allMock: vi.fn(),
}))

vi.mock('../src/main/database', () => {
    function chain(): {
        from: () => ReturnType<typeof chain>
        where: () => ReturnType<typeof chain>
        orderBy: () => ReturnType<typeof chain>
        limit: () => ReturnType<typeof chain>
        get: () => unknown
        all: () => unknown
    } {
        return {
            from: () => chain(),
            where: () => chain(),
            orderBy: () => chain(),
            limit: () => chain(),
            get: () => getMock(),
            all: () => allMock(),
        }
    }

    return {
        getDatabase: () => ({
            select: () => chain(),
        }),
    }
})

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: () => loadSettingsMock(),
}))

import {
    addJitter,
    isLocationInCooldown,
    VelocityController,
    velocityController,
} from '../src/main/services/VelocityController'

const NOW = new Date('2026-10-12T12:00:00.000Z')
const COOLDOWN_MINUTES = 120

describe('addJitter', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns a value between base and base * 1.3 (default 30% jitter)', () => {
        const base = 10_000
        for (let i = 0; i < 40; i++) {
            const value = addJitter(base)
            expect(value).toBeGreaterThanOrEqual(base)
            expect(value).toBeLessThanOrEqual(base * 1.3)
        }
    })

    it('pins the ends of the default jitter range', () => {
        const random = vi.spyOn(Math, 'random')
        random.mockReturnValue(0)
        expect(addJitter(1000)).toBe(1000)
        random.mockReturnValue(1)
        expect(addJitter(1000)).toBe(1300)
    })
})

describe('isLocationInCooldown', () => {
    beforeEach(() => {
        getMock.mockReset()
        allMock.mockReset()
    })

    it('returns false when no other account has a recent success', () => {
        getMock.mockReturnValue({ count: 0 })
        expect(isLocationInCooldown(5, 2, COOLDOWN_MINUTES, NOW)).toBe(false)
    })

    it('returns true when another account succeeded inside the window', () => {
        getMock.mockReturnValue({ count: 3 })
        expect(isLocationInCooldown(5, 2, COOLDOWN_MINUTES, NOW)).toBe(true)
    })
})

describe('VelocityController.checkCooldown', () => {
    const controller = new VelocityController()

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
        getMock.mockReset()
        allMock.mockReset()
        loadSettingsMock.mockReset()
        loadSettingsMock.mockReturnValue({ crossAccountCooldownMinutes: COOLDOWN_MINUTES })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('returns allowed=true when the cooldown is disabled', () => {
        loadSettingsMock.mockReturnValue({ crossAccountCooldownMinutes: 0 })
        expect(controller.checkCooldown(1, 2)).toEqual({ allowed: true })

        loadSettingsMock.mockReturnValue({ crossAccountCooldownMinutes: -15 })
        expect(controller.checkCooldown(1, 2)).toEqual({ allowed: true })
        expect(getMock).not.toHaveBeenCalled()
    })

    it('returns allowed=false with retryAfterMs when another account succeeded inside the window', () => {
        const successAt = new Date('2026-10-12T11:00:00.000Z')
        getMock
            .mockReturnValueOnce({ count: 1 })
            .mockReturnValueOnce({ createdAt: successAt })

        const result = controller.checkCooldown(9, 4)

        expect(result.allowed).toBe(false)
        expect(result.retryAfterMs).toBe(60 * 60_000)
        expect(result.recentSuccessCount).toBe(1)
    })
})

describe('VelocityController.getCooldownLocationIds', () => {
    const controller = new VelocityController()

    beforeEach(() => {
        getMock.mockReset()
        allMock.mockReset()
        loadSettingsMock.mockReset()
        loadSettingsMock.mockReturnValue({ crossAccountCooldownMinutes: COOLDOWN_MINUTES })
    })

    it('returns the blocked location ids', () => {
        allMock.mockReturnValue([
            { locationId: 3 },
            { locationId: 7 },
            { locationId: 3 },
        ])

        expect(controller.getCooldownLocationIds()).toEqual([3, 7])
    })
})

describe('cross-account integration', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
        getMock.mockReset()
        allMock.mockReset()
        loadSettingsMock.mockReset()
        loadSettingsMock.mockReturnValue({ crossAccountCooldownMinutes: COOLDOWN_MINUTES })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('blocks a second account at the same location inside the window', () => {
        getMock.mockReturnValueOnce({ count: 0 })
        const first = velocityController.checkCooldown(42, 1)
        expect(first.allowed).toBe(true)

        const successAt = new Date(NOW.getTime() - 30 * 60_000)
        getMock
            .mockReturnValueOnce({ count: 1 })
            .mockReturnValueOnce({ createdAt: successAt })
        const second = velocityController.checkCooldown(42, 2)

        expect(second.allowed).toBe(false)
        expect(second.retryAfterMs).toBe(90 * 60_000)
        expect(second.recentSuccessCount).toBe(1)
    })

    it('spreads the recommended retry with jitter instead of the exact boundary', () => {
        const successAt = new Date(NOW.getTime() - 30 * 60_000)
        getMock.mockReturnValue({ createdAt: successAt })
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)

        const delay = velocityController.getRecommendedDelay(42)
        const remaining = 90 * 60_000

        expect(delay).toBe(remaining + remaining * 0.3 * 0.5)
        expect(delay).toBeGreaterThan(remaining)
        expect(delay).toBeLessThanOrEqual(remaining * 1.3)
        random.mockRestore()
    })
})
