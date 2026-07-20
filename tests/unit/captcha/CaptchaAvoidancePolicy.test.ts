import { describe, expect, it } from 'vitest'
import {
    adaptiveDelayFactor,
    boundedWait,
    boundedWaitExact,
    buildSessionWarmupPlan,
    captchaStrikesToRisk,
    computeAdaptiveDelay,
    createEmptyThrottleState,
    evaluateGoogleSearchThrottle,
    evaluateTimeOfDay,
    planScrollDepth,
    planTabSwitch,
    recordGoogleSearchQuery,
    sampleInclusive,
    sampleInterQueryDelayMs,
    DEFAULT_GOOGLE_SEARCH_THROTTLE,
} from '../../../src/main/automation/CaptchaAvoidancePolicy'

/** Deterministic RNG factory: always returns fixed unit in [0, 1). */
function fixedRandom(unit: number): () => number {
    return () => unit
}

describe('captchaStrikesToRisk / adaptiveDelayFactor', () => {
    it('maps strike counts to risk bands', () => {
        expect(captchaStrikesToRisk(0)).toBe('low')
        expect(captchaStrikesToRisk(1)).toBe('medium')
        expect(captchaStrikesToRisk(2)).toBe('high')
        expect(captchaStrikesToRisk(3)).toBe('high')
        expect(captchaStrikesToRisk(4)).toBe('critical')
        expect(captchaStrikesToRisk(10)).toBe('critical')
    })

    it('scales delay factor and caps near 2.4', () => {
        expect(adaptiveDelayFactor(0)).toBe(1)
        expect(adaptiveDelayFactor(1)).toBeCloseTo(1.35, 5)
        expect(adaptiveDelayFactor(2)).toBeCloseTo(1.7, 5)
        expect(adaptiveDelayFactor(20)).toBeLessThanOrEqual(2.4)
        expect(adaptiveDelayFactor(100)).toBe(2.4)
    })
})

describe('computeAdaptiveDelay', () => {
    it('returns unscaled range at zero strikes', () => {
        const result = computeAdaptiveDelay({
            captchaStrikes: 0,
            baseMinMs: 1000,
            baseMaxMs: 2000,
            random: fixedRandom(0),
        })
        expect(result.factor).toBe(1)
        expect(result.riskLevel).toBe('low')
        expect(result.minMs).toBe(1000)
        expect(result.maxMs).toBe(2000)
        expect(result.delayMs).toBe(1000)
    })

    it('widens range under captcha pressure', () => {
        const result = computeAdaptiveDelay({
            captchaStrikes: 2,
            baseMinMs: 1000,
            baseMaxMs: 2000,
            random: fixedRandom(0.5),
        })
        expect(result.factor).toBeGreaterThan(1)
        expect(result.minMs).toBeGreaterThan(1000)
        expect(result.maxMs).toBeGreaterThan(2000)
        expect(result.riskLevel).toBe('high')
        expect(result.delayMs).toBeGreaterThanOrEqual(result.minMs)
        expect(result.delayMs).toBeLessThanOrEqual(result.maxMs)
    })
})

describe('Google search throttle policy', () => {
    it('allows first query with empty state', () => {
        const state = createEmptyThrottleState()
        const decision = evaluateGoogleSearchThrottle(state, 1_000_000)
        expect(decision.allowed).toBe(true)
        expect(decision.reason).toBe('ok')
        expect(decision.waitMs).toBe(0)
        expect(decision.queriesRemaining).toBe(DEFAULT_GOOGLE_SEARCH_THROTTLE.maxQueriesPerSession)
    })

    it('blocks when session query budget is exhausted', () => {
        let state = createEmptyThrottleState()
        const t0 = 10_000
        for (let i = 0; i < DEFAULT_GOOGLE_SEARCH_THROTTLE.maxQueriesPerSession; i++) {
            state = recordGoogleSearchQuery(state, t0 + i * 100_000)
        }
        const decision = evaluateGoogleSearchThrottle(state, t0 + 1_000_000)
        expect(decision.allowed).toBe(false)
        expect(decision.reason).toBe('max_queries')
        expect(decision.queriesRemaining).toBe(0)
    })

    it('enforces min interval cooldown between queries', () => {
        const state = recordGoogleSearchQuery(createEmptyThrottleState(), 50_000)
        const tooSoon = evaluateGoogleSearchThrottle(state, 50_000 + 5_000)
        expect(tooSoon.allowed).toBe(false)
        expect(tooSoon.reason).toBe('cooldown')
        expect(tooSoon.waitMs).toBe(
            DEFAULT_GOOGLE_SEARCH_THROTTLE.minIntervalMs - 5_000,
        )

        const afterGap = evaluateGoogleSearchThrottle(
            state,
            50_000 + DEFAULT_GOOGLE_SEARCH_THROTTLE.minIntervalMs,
        )
        expect(afterGap.allowed).toBe(true)
        expect(afterGap.reason).toBe('ok')
    })

    it('samples inter-query delay within scaled bounds', () => {
        const delay = sampleInterQueryDelayMs(
            { minIntervalMs: 30_000, maxIntervalMs: 60_000 },
            0,
            fixedRandom(0),
        )
        expect(delay).toBe(30_000)

        const delayed = sampleInterQueryDelayMs(
            { minIntervalMs: 30_000, maxIntervalMs: 60_000 },
            2,
            fixedRandom(1),
        )
        expect(delayed).toBeGreaterThanOrEqual(Math.floor(30_000 * adaptiveDelayFactor(2)))
        expect(delayed).toBeLessThanOrEqual(Math.floor(60_000 * adaptiveDelayFactor(2)))
    })
})

describe('time-of-day / scroll / tab-switch plans', () => {
    it('marks deep night as inactive with higher delay factor', () => {
        const night = evaluateTimeOfDay({ hour: 3 })
        expect(night.isActiveHours).toBe(false)
        expect(night.activityMultiplier).toBeLessThan(1)
        expect(night.delayFactor).toBeGreaterThan(1)
    })

    it('marks peak daytime as full activity', () => {
        const day = evaluateTimeOfDay({ hour: 14 })
        expect(day.isActiveHours).toBe(true)
        expect(day.activityMultiplier).toBe(1)
        expect(day.delayFactor).toBe(1)
    })

    it('plans partial scroll depth (not always 100%)', () => {
        const plan = planScrollDepth(0, fixedRandom(0.5))
        expect(plan.targetDepth).toBeGreaterThanOrEqual(0.25)
        expect(plan.targetDepth).toBeLessThanOrEqual(0.9)
        expect(plan.steps).toBeGreaterThanOrEqual(1)
        expect(plan.steps).toBeLessThanOrEqual(6)
    })

    it('caps scroll depth under high captcha pressure', () => {
        const cautious = planScrollDepth(5, fixedRandom(0.99))
        expect(cautious.targetDepth).toBeLessThanOrEqual(0.55)
    })

    it('suppresses tab switches at critical risk', () => {
        const plan = planTabSwitch(5, fixedRandom(0.99))
        expect(plan.shouldSwitch).toBe(false)
        expect(plan.switchCount).toBe(0)
    })

    it('may plan tab switches at low risk', () => {
        const plan = planTabSwitch(0, fixedRandom(0.9))
        expect(plan.shouldSwitch).toBe(true)
        expect(plan.switchCount).toBeGreaterThanOrEqual(1)
    })
})

describe('buildSessionWarmupPlan', () => {
    it('composes scroll, optional tabs, time-of-day, and bounded dwell', () => {
        const plan = buildSessionWarmupPlan({
            hour: 14,
            captchaStrikes: 0,
            maxWarmupMs: 12_000,
            random: fixedRandom(0.5),
        })
        expect(plan.timeOfDay.isActiveHours).toBe(true)
        expect(plan.scroll.targetDepth).toBeGreaterThan(0)
        expect(plan.actions.length).toBeGreaterThanOrEqual(2)
        expect(plan.actions.some((a) => a.type === 'scroll')).toBe(true)
        expect(plan.actions.some((a) => a.type === 'dwell')).toBe(true)
        expect(plan.plannedDwellMs).toBeLessThanOrEqual(12_000)
        expect(plan.plannedDwellMs).toBeGreaterThan(0)
    })

    it('reduces planned activity at night', () => {
        const night = buildSessionWarmupPlan({
            hour: 2,
            maxWarmupMs: 40_000,
            random: fixedRandom(0.5),
        })
        const day = buildSessionWarmupPlan({
            hour: 12,
            maxWarmupMs: 40_000,
            random: fixedRandom(0.5),
        })
        expect(night.timeOfDay.isActiveHours).toBe(false)
        expect(night.plannedDwellMs).toBeLessThanOrEqual(day.plannedDwellMs * 1.05)
    })
})

describe('bounded / cancellable waits (no real wall-clock)', () => {
    it('boundedWait uses injectable sleep and respects maxBoundMs', async () => {
        const slept: number[] = []
        const waited = await boundedWait({
            minMs: 50_000,
            maxMs: 80_000,
            maxBoundMs: 5_000,
            random: fixedRandom(1),
            sleep: async (ms) => {
                slept.push(ms)
            },
        })
        expect(waited).toBe(5_000)
        expect(slept).toEqual([5_000])
    })

    it('boundedWaitExact clamps and uses injectable sleep', async () => {
        const slept: number[] = []
        const waited = await boundedWaitExact(999_999, {
            maxBoundMs: 1_500,
            sleep: async (ms) => {
                slept.push(ms)
            },
        })
        expect(waited).toBe(1_500)
        expect(slept).toEqual([1_500])
    })

    it('boundedWaitExact rejects when already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(
            boundedWaitExact(100, {
                signal: controller.signal,
                sleep: async () => {
                    throw new Error('should not sleep')
                },
            }),
        ).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('boundedWaitExact aborts mid-wait via signal', async () => {
        const controller = new AbortController()
        const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
            new Promise((resolve, reject) => {
                const t = setTimeout(resolve, ms)
                signal?.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(t)
                        const err = new Error('Aborted')
                        err.name = 'AbortError'
                        reject(err)
                    },
                    { once: true },
                )
            })

        // Abort immediately; sleep is injectable so no multi-second wait
        const promise = boundedWaitExact(10_000, {
            maxBoundMs: 10_000,
            signal: controller.signal,
            sleep,
        })
        controller.abort()
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    })
})

describe('sampleInclusive', () => {
    it('stays within inclusive bounds for edge random values', () => {
        expect(sampleInclusive(10, 20, fixedRandom(0))).toBe(10)
        expect(sampleInclusive(10, 20, fixedRandom(1))).toBe(20)
        expect(sampleInclusive(5, 5, fixedRandom(0.5))).toBe(5)
    })
})

describe('default constants', () => {
    it('uses research-aligned Google throttle defaults', () => {
        expect(DEFAULT_GOOGLE_SEARCH_THROTTLE.maxQueriesPerSession).toBeGreaterThanOrEqual(3)
        expect(DEFAULT_GOOGLE_SEARCH_THROTTLE.maxQueriesPerSession).toBeLessThanOrEqual(5)
        expect(DEFAULT_GOOGLE_SEARCH_THROTTLE.minIntervalMs).toBe(30_000)
        expect(DEFAULT_GOOGLE_SEARCH_THROTTLE.maxIntervalMs).toBe(60_000)
    })
})

