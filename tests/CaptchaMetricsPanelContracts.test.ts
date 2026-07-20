/**
 * CAPTCHA metrics panel contracts — public DTO shape + pure helpers.
 * Ensures the Settings dashboard never depends on secret-bearing fields.
 */
import { describe, expect, it } from 'vitest'
import {
    CAPTCHA_METRICS_RECENT_LIMIT,
    emptyCaptchaMetricsSnapshot,
    type CaptchaMetricsSnapshot,
    type CaptchaRecentAttempt,
} from '../src/shared/captcha-metrics-contracts'
import {
    CAPTCHA_METRICS_FORBIDDEN_KEYS,
    CAPTCHA_METRICS_PUBLIC_ATTEMPT_KEYS,
    formatDurationMs,
    formatPercent,
    isEmptyMetrics,
    resolveMetricsState,
    snapshotHasNoSecrets,
    successTone,
} from '../src/renderer/src/components/captcha/CaptchaMetricsPanel'

function sampleAttempt(over: Partial<CaptchaRecentAttempt> = {}): CaptchaRecentAttempt {
    return {
        id: 1,
        captchaType: 'recaptchav2',
        provider: 'capsolver',
        success: true,
        durationMs: 1200,
        retryCount: 0,
        errorCode: null,
        createdAt: '2026-07-14T10:00:00.000Z',
        ...over,
    }
}

function sampleSnapshot(over: Partial<CaptchaMetricsSnapshot> = {}): CaptchaMetricsSnapshot {
    return {
        ...emptyCaptchaMetricsSnapshot(),
        totals: { attempts: 2, successes: 1, failures: 1 },
        successRate: 50,
        averageDurationMs: 1500,
        byType: {
            recaptchav2: {
                attempts: 2,
                successes: 1,
                failures: 1,
                successRate: 50,
                averageDurationMs: 1500,
            },
        },
        byProvider: {
            capsolver: {
                attempts: 2,
                successes: 1,
                failures: 1,
                successRate: 50,
                averageDurationMs: 1500,
            },
        },
        recentAttempts: [sampleAttempt()],
        ...over,
    }
}

describe('CaptchaMetricsSnapshot public contract', () => {
    it('empty snapshot has zero counters and no recent rows', () => {
        const empty = emptyCaptchaMetricsSnapshot()
        expect(isEmptyMetrics(empty)).toBe(true)
        expect(empty.totals).toEqual({ attempts: 0, successes: 0, failures: 0 })
        expect(empty.successRate).toBe(0)
        expect(empty.averageDurationMs).toBe(0)
        expect(empty.byType).toEqual({})
        expect(empty.byProvider).toEqual({})
        expect(empty.recentAttempts).toEqual([])
        expect(snapshotHasNoSecrets(empty)).toBe(true)
    })

    it('recent attempt only exposes public keys', () => {
        const attempt = sampleAttempt({ errorCode: 'timeout' })
        const keys = Object.keys(attempt).sort()
        expect(keys).toEqual([...CAPTCHA_METRICS_PUBLIC_ATTEMPT_KEYS].sort())
        for (const forbidden of CAPTCHA_METRICS_FORBIDDEN_KEYS) {
            expect(keys).not.toContain(forbidden)
        }
    })

    it('snapshot has no secret field names', () => {
        const snap = sampleSnapshot()
        expect(snapshotHasNoSecrets(snap)).toBe(true)
        expect(isEmptyMetrics(snap)).toBe(false)
    })

    it('bounds recent attempts constant is finite and positive', () => {
        expect(CAPTCHA_METRICS_RECENT_LIMIT).toBeGreaterThan(0)
        expect(CAPTCHA_METRICS_RECENT_LIMIT).toBeLessThanOrEqual(200)
    })

    it('does not carry sitekey, token, apiKey, or URL fields on attempts', () => {
        const attempt = sampleAttempt()
        const record = attempt as Record<string, unknown>
        expect(record.sitekey).toBeUndefined()
        expect(record.token).toBeUndefined()
        expect(record.apiKey).toBeUndefined()
        expect(record.url).toBeUndefined()
        expect(record.pageUrl).toBeUndefined()
    })
})

describe('CaptchaMetricsPanel pure helpers', () => {
    it('formats duration and percent safely', () => {
        expect(formatDurationMs(0)).toBe('0ms')
        expect(formatDurationMs(450)).toBe('450ms')
        expect(formatDurationMs(1500)).toBe('1.5s')
        expect(formatDurationMs(Number.NaN)).toBe('0ms')
        expect(formatPercent(66.666)).toBe('66.7%')
        expect(formatPercent(Number.NaN)).toBe('0%')
    })

    it('maps success rate to UI tones', () => {
        expect(successTone(80)).toBe('emerald')
        expect(successTone(50)).toBe('amber')
        expect(successTone(10)).toBe('rose')
        expect(successTone(0)).toBe('slate')
    })

    it('resolveMetricsState covers loading / error / empty / ready', () => {
        expect(resolveMetricsState(null, null)).toBe('loading')
        expect(resolveMetricsState(null, 'boom')).toBe('error')
        expect(resolveMetricsState(emptyCaptchaMetricsSnapshot(), null)).toBe('empty')
        expect(resolveMetricsState(sampleSnapshot(), null)).toBe('ready')
        // Prefer showing data if snap exists even when a soft error string is set
        expect(resolveMetricsState(sampleSnapshot(), 'soft')).toBe('ready')
    })
})
