/**
 * CaptchaMetricsService unit tests — memory repository (no native SQLite).
 * Covers aggregation, sanitization, bounded recent, safe reset, prune.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
    CAPTCHA_METRICS_ERROR_CODE_MAX,
    CAPTCHA_METRICS_RECENT_LIMIT,
    emptyCaptchaMetricsSnapshot,
} from '../../../src/shared/captcha-metrics-contracts'
import {
    CaptchaMetricsService,
    buildCaptchaMetricsSnapshot,
    clampDurationMs,
    clampRetryCount,
    createMemoryCaptchaMetricsRepository,
    normalizeCaptchaProvider,
    normalizeCaptchaType,
    sanitizeErrorCode,
    type CaptchaMetricRowView,
    type CaptchaMetricsRepository,
} from '../../../src/main/services/CaptchaMetricsService'

function makeService(repo?: CaptchaMetricsRepository): CaptchaMetricsService {
    return new CaptchaMetricsService(repo ?? createMemoryCaptchaMetricsRepository())
}

function seed(
    service: CaptchaMetricsService,
    items: Array<{
        captchaType?: string
        provider?: string
        success: boolean
        durationMs: number
        retryCount?: number
        errorCode?: string | null
    }>,
): void {
    for (const item of items) {
        service.recordAttempt({
            captchaType: item.captchaType ?? 'recaptchav2',
            provider: item.provider ?? 'capsolver',
            success: item.success,
            durationMs: item.durationMs,
            retryCount: item.retryCount,
            errorCode: item.errorCode,
        })
    }
}

describe('normalize helpers', () => {
    it('normalizes known captcha types and falls back to unknown', () => {
        expect(normalizeCaptchaType('hCaptcha')).toBe('hcaptcha')
        expect(normalizeCaptchaType('turnstile')).toBe('turnstile')
        expect(normalizeCaptchaType('weird-grid')).toBe('unknown')
    })

    it('normalizes known providers and falls back to unknown', () => {
        expect(normalizeCaptchaProvider('2captcha')).toBe('2captcha')
        expect(normalizeCaptchaProvider('CapSolver')).toBe('capsolver')
        expect(normalizeCaptchaProvider('evil-svc')).toBe('unknown')
    })

    it('sanitizes error codes and redacts secret-looking strings', () => {
        expect(sanitizeErrorCode(null)).toBeNull()
        expect(sanitizeErrorCode('  timeout  ')).toBe('timeout')
        expect(sanitizeErrorCode('api_key=abc123')).toBe('redacted')
        expect(sanitizeErrorCode('Bearer xyz')).toBe('redacted')
        expect(sanitizeErrorCode('x'.repeat(CAPTCHA_METRICS_ERROR_CODE_MAX + 40))?.length).toBe(
            CAPTCHA_METRICS_ERROR_CODE_MAX,
        )
    })

    it('clamps duration and retry counts', () => {
        expect(clampDurationMs(-5)).toBe(0)
        expect(clampDurationMs(1500.7)).toBe(1501)
        expect(clampDurationMs(9_999_999)).toBe(3_600_000)
        expect(clampRetryCount(undefined)).toBe(0)
        expect(clampRetryCount(-1)).toBe(0)
        expect(clampRetryCount(99)).toBe(20)
    })
})

describe('buildCaptchaMetricsSnapshot (pure)', () => {
    it('returns empty snapshot for no rows', () => {
        expect(buildCaptchaMetricsSnapshot([])).toEqual(emptyCaptchaMetricsSnapshot())
    })

    it('aggregates totals, byType, byProvider, successRate, averageDurationMs', () => {
        const rows: CaptchaMetricRowView[] = [
            {
                id: 1,
                captchaType: 'recaptchav2',
                provider: 'capsolver',
                success: true,
                durationMs: 1000,
                retryCount: 0,
                errorCode: null,
                createdAt: new Date('2026-07-14T10:00:00.000Z'),
            },
            {
                id: 2,
                captchaType: 'recaptchav2',
                provider: '2captcha',
                success: false,
                durationMs: 3000,
                retryCount: 1,
                errorCode: 'timeout',
                createdAt: new Date('2026-07-14T10:01:00.000Z'),
            },
            {
                id: 3,
                captchaType: 'hcaptcha',
                provider: 'capsolver',
                success: true,
                durationMs: 2000,
                retryCount: 0,
                errorCode: null,
                createdAt: new Date('2026-07-14T10:02:00.000Z'),
            },
        ]

        const snap = buildCaptchaMetricsSnapshot(rows)

        expect(snap.totals).toEqual({ attempts: 3, successes: 2, failures: 1 })
        expect(snap.successRate).toBeCloseTo(66.67, 1)
        expect(snap.averageDurationMs).toBe(2000)
        expect(snap.byType.recaptchav2.attempts).toBe(2)
        expect(snap.byType.recaptchav2.successes).toBe(1)
        expect(snap.byType.hcaptcha.successes).toBe(1)
        expect(snap.byProvider.capsolver.attempts).toBe(2)
        expect(snap.byProvider['2captcha'].failures).toBe(1)
        expect(snap.recentAttempts).toHaveLength(3)
        expect(snap.recentAttempts[0].id).toBe(3)
    })

    it('bounds recentAttempts to CAPTCHA_METRICS_RECENT_LIMIT', () => {
        const rows: CaptchaMetricRowView[] = Array.from({ length: 80 }, (_, i) => ({
            id: i + 1,
            captchaType: 'turnstile',
            provider: 'capsolver',
            success: i % 2 === 0,
            durationMs: 500,
            retryCount: 0,
            errorCode: null,
            createdAt: new Date(Date.UTC(2026, 6, 14, 0, 0, i)),
        }))
        const snap = buildCaptchaMetricsSnapshot(rows)
        expect(snap.recentAttempts).toHaveLength(CAPTCHA_METRICS_RECENT_LIMIT)
        expect(snap.totals.attempts).toBe(80)
        expect(snap.recentAttempts[0].id).toBe(80)
    })
})

describe('CaptchaMetricsService (memory repo)', () => {
    let service: CaptchaMetricsService

    beforeEach(() => {
        service = makeService()
    })

    it('records attempts and returns snapshot via getMetrics', () => {
        seed(service, [
            { success: true, durationMs: 1200, captchaType: 'recaptchav3', provider: '2captcha' },
            { success: false, durationMs: 800, captchaType: 'recaptchav3', provider: '2captcha', errorCode: 'fail' },
        ])

        const snap = service.getMetrics()
        expect(snap.totals.attempts).toBe(2)
        expect(snap.totals.successes).toBe(1)
        expect(snap.totals.failures).toBe(1)
        expect(snap.successRate).toBe(50)
        expect(snap.averageDurationMs).toBe(1000)
        expect(snap.byType.recaptchav3.attempts).toBe(2)
        expect(snap.byProvider['2captcha'].attempts).toBe(2)
        expect(snap.recentAttempts).toHaveLength(2)
        expect(snap.recentAttempts.every((a) => a.errorCode !== 'api_key=x')).toBe(true)
    })

    it('never stores secret-looking error codes', () => {
        service.recordAttempt({
            captchaType: 'hcaptcha',
            provider: 'capsolver',
            success: false,
            durationMs: 100,
            errorCode: 'token=supersecret',
        })
        const snap = service.getMetrics()
        expect(snap.recentAttempts[0].errorCode).toBe('redacted')
    })

    it('maps unknown type/provider safely', () => {
        service.recordAttempt({
            captchaType: 'arkose',
            provider: 'anticaptcha',
            success: true,
            durationMs: 50,
        })
        const snap = service.getMetrics()
        expect(snap.recentAttempts[0].captchaType).toBe('unknown')
        expect(snap.recentAttempts[0].provider).toBe('unknown')
        expect(snap.byType.unknown.attempts).toBe(1)
        expect(snap.byProvider.unknown.attempts).toBe(1)
    })

    it('resetMetrics is safe and idempotent', () => {
        seed(service, [
            { success: true, durationMs: 100 },
            { success: false, durationMs: 200 },
        ])
        const first = service.resetMetrics()
        expect(first.success).toBe(true)
        expect(first.deleted).toBe(2)

        const empty = service.getMetrics()
        expect(empty.totals.attempts).toBe(0)
        expect(empty.recentAttempts).toEqual([])

        const second = service.resetMetrics()
        expect(second.success).toBe(true)
        expect(second.deleted).toBe(0)
    })

    it('prunes oldest rows beyond keepMax on record', () => {
        const repo = createMemoryCaptchaMetricsRepository()
        const svc = new CaptchaMetricsService(repo)

        // Bypass service prune cap by calling repo directly, then assert pruneOldest.
        for (let i = 0; i < 5; i++) {
            repo.insert({
                captchaType: 'turnstile',
                provider: 'capsolver',
                success: true,
                durationMs: 10 + i,
                retryCount: 0,
                errorCode: null,
            })
        }
        expect(repo.listAll()).toHaveLength(5)
        const pruned = repo.pruneOldest(3)
        expect(pruned).toBe(2)
        const remaining = repo.listAll().map((r) => r.id).sort((a, b) => a - b)
        expect(remaining).toEqual([3, 4, 5])

        // Service still works after prune
        svc.recordAttempt({
            captchaType: 'turnstile',
            provider: 'capsolver',
            success: false,
            durationMs: 99,
        })
        expect(svc.getMetrics().totals.attempts).toBe(4)
    })

    it('recordAttempt does not throw when repository insert fails', () => {
        const badRepo: CaptchaMetricsRepository = {
            insert: () => {
                throw new Error('disk full')
            },
            listAll: () => [],
            deleteAll: () => 0,
            pruneOldest: () => 0,
        }
        const svc = new CaptchaMetricsService(badRepo)
        expect(() =>
            svc.recordAttempt({
                captchaType: 'recaptchav2',
                provider: 'none',
                success: false,
                durationMs: 1,
            }),
        ).not.toThrow()
        expect(svc.getMetrics().totals.attempts).toBe(0)
    })
})
