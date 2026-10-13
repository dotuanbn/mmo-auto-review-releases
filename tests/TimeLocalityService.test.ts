import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_HUMAN_JITTER_MS,
    DEFAULT_TIMEZONE,
    addHumanJitter,
    getLocalHour,
    getNextGoldenHourMs,
    inferTimezone,
    isGoldenHour,
    isNightTime,
    timeLocalityService,
    TimeLocalityService,
} from '../src/main/services/TimeLocalityService'

const HOUR_MS = 60 * 60 * 1000

describe('inferTimezone', () => {
    it.each([
        ['123 Nguyen Hue, District 1, Ho Chi Minh City, Vietnam', 'Asia/Ho_Chi_Minh'],
        ['Hà Nội, Việt Nam', 'Asia/Ho_Chi_Minh'],
        ['Viet Nam', 'Asia/Ho_Chi_Minh'],
        ['Hanoi', 'Asia/Ho_Chi_Minh'],
        ['Bangkok, Thailand', 'Asia/Bangkok'],
        ['Shibuya, Tokyo, Japan', 'Asia/Tokyo'],
        ['Osaka, Japan', 'Asia/Tokyo'],
        ['Seoul, Korea', 'Asia/Seoul'],
        ['Singapore', 'Asia/Singapore'],
        ['Kuala Lumpur, Malaysia', 'Asia/Kuala_Lumpur'],
        ['Jakarta, Indonesia', 'Asia/Jakarta'],
        ['Manila, Philippines', 'Asia/Manila'],
        ['Taipei, Taiwan', 'Asia/Taipei'],
        ['Sydney, Australia', 'Australia/Sydney'],
        ['Melbourne, Australia', 'Australia/Sydney'],
        ['New York, United States', 'America/New_York'],
        ['Los Angeles, United States', 'America/New_York'],
        ['Chicago, United States', 'America/New_York'],
        ['London, United Kingdom', 'Europe/London'],
        ['Berlin, Germany', 'Europe/Berlin'],
        ['Paris, France', 'Europe/Paris'],
    ])('maps %s to %s', (address, timezone) => {
        expect(inferTimezone(address)).toBe(timezone)
    })

    it('returns the Vietnam fallback for null, empty, and unknown addresses', () => {
        expect(inferTimezone(null)).toBe(DEFAULT_TIMEZONE)
        expect(inferTimezone(undefined)).toBe(DEFAULT_TIMEZONE)
        expect(inferTimezone('')).toBe(DEFAULT_TIMEZONE)
        expect(inferTimezone('   ')).toBe(DEFAULT_TIMEZONE)
        expect(inferTimezone('Somewhere Unknown')).toBe('Asia/Ho_Chi_Minh')
    })
})

describe('getLocalHour', () => {
    it('returns the clock hour in the target timezone for a fixed instant', () => {
        const morningUtc = new Date('2026-01-15T03:00:00.000Z')
        expect(getLocalHour('Asia/Ho_Chi_Minh', morningUtc)).toBe(10)
        expect(getLocalHour('Asia/Tokyo', morningUtc)).toBe(12)
        // January is EST (UTC-5), so 17:00Z is noon in New York.
        expect(getLocalHour('America/New_York', new Date('2026-01-15T17:00:00.000Z'))).toBe(12)
        expect(getLocalHour('UTC', new Date('2026-01-15T18:00:00.000Z'))).toBe(18)
    })

    it('rejects an invalid timezone', () => {
        expect(() => getLocalHour('Not/AZone', new Date('2026-01-15T00:00:00.000Z'))).toThrow(/invalid timezone/i)
    })
})

describe('isGoldenHour', () => {
    it('is true for 10, 12, 14, 18, and 20', () => {
        for (const hour of [10, 12, 14, 18, 20]) {
            expect(isGoldenHour(hour)).toBe(true)
        }
    })

    it('is false for 3, 7, and 22', () => {
        for (const hour of [3, 7, 22]) {
            expect(isGoldenHour(hour)).toBe(false)
        }
    })
})

describe('isNightTime', () => {
    it('is true for 0, 2, 5, and 23', () => {
        for (const hour of [0, 2, 5, 23]) {
            expect(isNightTime(hour)).toBe(true)
        }
    })

    it('is false for 10, 15, and 19', () => {
        for (const hour of [10, 15, 19]) {
            expect(isNightTime(hour)).toBe(false)
        }
    })
})

describe('getNextGoldenHourMs', () => {
    it('is a positive wait while the location is in night hours', () => {
        // 18:00Z is 01:00 in Asia/Ho_Chi_Minh, nine hours before 10:00 local.
        const night = new Date('2026-01-15T18:00:00.000Z')
        expect(getLocalHour('Asia/Ho_Chi_Minh', night)).toBe(1)
        expect(isNightTime(1)).toBe(true)
        const waitMs = getNextGoldenHourMs('Asia/Ho_Chi_Minh', night)
        expect(waitMs).toBeGreaterThan(0)
        expect(waitMs).toBe(9 * HOUR_MS)
    })

    it('waits until 10:00 local from midnight in a negative-offset zone', () => {
        // 05:00Z is midnight EST. Next golden start is 10:00 EST = 15:00Z.
        const midnightNewYork = new Date('2026-01-15T05:00:00.000Z')
        expect(getLocalHour('America/New_York', midnightNewYork)).toBe(0)
        expect(getNextGoldenHourMs('America/New_York', midnightNewYork)).toBe(10 * HOUR_MS)
    })

    it('waits until 18:00 during the afternoon gap', () => {
        // 08:00Z is 15:00 in Ho Chi Minh, three hours before the evening window.
        const afternoon = new Date('2026-01-15T08:00:00.000Z')
        expect(getLocalHour('Asia/Ho_Chi_Minh', afternoon)).toBe(15)
        expect(getNextGoldenHourMs('Asia/Ho_Chi_Minh', afternoon)).toBe(3 * HOUR_MS)
    })
})

describe('addHumanJitter', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('stays inside base ± maxJitterMs', () => {
        const base = 10_000_000
        const maxJitter = 1_800_000
        for (let i = 0; i < 40; i++) {
            const value = addHumanJitter(base, maxJitter)
            expect(value).toBeGreaterThanOrEqual(base - maxJitter)
            expect(value).toBeLessThanOrEqual(base + maxJitter)
        }
    })

    it('pins both ends of the default ±30 minute span', () => {
        const random = vi.spyOn(Math, 'random')
        const base = 5_000_000
        random.mockReturnValue(0)
        expect(addHumanJitter(base)).toBe(base - DEFAULT_HUMAN_JITTER_MS)
        random.mockReturnValue(1)
        expect(addHumanJitter(base)).toBe(base + DEFAULT_HUMAN_JITTER_MS)
        random.mockReturnValue(0.5)
        expect(addHumanJitter(base)).toBe(base)
    })
})

describe('TimeLocalityService.shouldReviewNow', () => {
    const service = new TimeLocalityService()

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not allow a review during local night and waits for the next golden hour', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const night = new Date('2026-01-15T18:00:00.000Z')
        const decision = service.shouldReviewNow(
            '123 Nguyen Hue, District 1, Ho Chi Minh City, Vietnam',
            night,
        )
        expect(decision.allowed).toBe(false)
        expect(decision.localHour).toBe(1)
        expect(decision.timezone).toBe('Asia/Ho_Chi_Minh')
        expect(decision.reason.toLowerCase()).toContain('night')
        expect(decision.waitMs).toBe(9 * HOUR_MS)
    })

    it('allows a review during golden hours', () => {
        // 04:00Z is 11:00 in Ho Chi Minh.
        const golden = new Date('2026-01-15T04:00:00.000Z')
        const decision = service.shouldReviewNow('Ho Chi Minh City, Vietnam', golden)
        expect(decision.allowed).toBe(true)
        expect(decision.localHour).toBe(11)
        expect(decision.timezone).toBe('Asia/Ho_Chi_Minh')
        expect(decision.reason.toLowerCase()).toContain('golden')
        expect(decision.waitMs).toBeUndefined()
    })

    it('allows acceptable daytime hours that are outside the golden windows', () => {
        // 15:00Z is 22:00 in Ho Chi Minh: not night, not golden.
        const lateEvening = new Date('2026-01-15T15:00:00.000Z')
        const decision = service.shouldReviewNow('Vietnam', lateEvening)
        expect(decision.allowed).toBe(true)
        expect(decision.localHour).toBe(22)
        expect(decision.waitMs).toBeUndefined()
        expect(isGoldenHour(decision.localHour)).toBe(false)
        expect(isNightTime(decision.localHour)).toBe(false)
    })
})

describe('TimeLocalityService.getOptimalDelay', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns 0 during a golden hour and a jittered wait otherwise', () => {
        const golden = new Date('2026-01-15T04:00:00.000Z')
        expect(timeLocalityService.getOptimalDelay('Ho Chi Minh City, Vietnam', golden)).toBe(0)

        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const night = new Date('2026-01-15T18:00:00.000Z')
        expect(timeLocalityService.getOptimalDelay('Vietnam', night)).toBe(9 * HOUR_MS)
    })
})
