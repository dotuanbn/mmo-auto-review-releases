import { describe, expect, it } from 'vitest'
import {
    classifyTrafficFailure,
    classifyTrafficFailureMessage,
    readTrafficFailureBucketFromActions,
    type TrafficFailBucket,
} from '../src/main/automation/TrafficFailureClassifier'

describe('classifyTrafficFailureMessage', () => {
    it('classifies captcha blocks as non-retryable captcha_blocked', () => {
        const result = classifyTrafficFailureMessage('Blocked by reCAPTCHA challenge')
        expect(result).toMatchObject({
            bucket: 'captcha_blocked',
            code: 'captcha_gate',
            retryable: false,
            message: 'Visit blocked by CAPTCHA gate',
        })
        expect(result.evidence).toContain('captcha')
    })

    it('classifies watchdog timeouts as retryable', () => {
        const cases = [
            'visit_watchdog_timeout after 90s',
            'visit_aborted_by_watchdog',
            'Watchdog budget exceeded',
        ]
        for (const message of cases) {
            const result = classifyTrafficFailureMessage(message)
            expect(result.bucket).toBe('watchdog_timeout')
            expect(result.code).toBe('visit_watchdog')
            expect(result.retryable).toBe(true)
        }
    })

    it('classifies proxy tunnel/auth failures as retryable proxy_error', () => {
        const cases = [
            'ERR_PROXY_CONNECTION_FAILED',
            'proxy connection failed for host',
            'ERR_TUNNEL_CONNECTION_FAILED',
            'Proxy Authentication Required',
            'HTTP 407 Proxy Authentication Required',
            'socks5 connection refused',
        ]
        for (const message of cases) {
            const result = classifyTrafficFailureMessage(message)
            expect(result.bucket, message).toBe('proxy_error')
            expect(result.retryable).toBe(true)
            expect(result.evidence).toContain('proxy')
        }
    })

    it('classifies direct_mode_map_not_ready', () => {
        const result = classifyTrafficFailureMessage('direct_mode_map_not_ready after restore')
        expect(result.bucket).toBe('direct_map_not_ready')
        expect(result.code).toBe('direct_map_not_ready')
        expect(result.retryable).toBe(true)
    })

    it('classifies web SEO target-not-found errors', () => {
        const a = classifyTrafficFailureMessage('web_seo_target_not_found for listing')
        expect(a.bucket).toBe('web_seo_target_not_found')
        expect(a.retryable).toBe(true)

        const b = classifyTrafficFailureMessage('target not found in SERP')
        expect(b.bucket).toBe('web_seo_target_not_found')
    })

    it('classifies agentic/planner/llm failures', () => {
        for (const message of ['agentic planner timed out', 'LLM returned invalid action', 'ollama offline']) {
            const result = classifyTrafficFailureMessage(message)
            expect(result.bucket, message).toBe('agentic_planner')
            expect(result.retryable).toBe(true)
        }
    })

    it('classifies navigation and net::err failures', () => {
        for (const message of [
            'Navigation timeout of 30000 ms exceeded',
            'net::ERR_CONNECTION_RESET',
            'timeout while page.goto',
            'page.goto: net::ERR_NAME_NOT_RESOLVED',
        ]) {
            const result = classifyTrafficFailureMessage(message)
            expect(result.bucket, message).toBe('navigation_error')
            expect(result.retryable).toBe(true)
        }
    })

    it('classifies login gates as non-retryable', () => {
        for (const message of [
            'google_login_blocked on consent',
            'Please sign in to continue',
            'SignIn required',
            'Login wall detected',
        ]) {
            const result = classifyTrafficFailureMessage(message)
            expect(result.bucket, message).toBe('login_gate')
            expect(result.retryable).toBe(false)
        }
    })

    it('classifies browser/context/page closed as browser_crash', () => {
        for (const message of [
            'Target closed',
            'Browser has been closed',
            'context is closed',
            'page closed unexpectedly',
        ]) {
            const result = classifyTrafficFailureMessage(message)
            expect(result.bucket, message).toBe('browser_crash')
            expect(result.retryable).toBe(true)
        }
    })

    it('falls back to other for unclassified messages', () => {
        const result = classifyTrafficFailureMessage('something completely unknown')
        expect(result).toMatchObject({
            bucket: 'other',
            code: 'unclassified_runtime_error',
            retryable: false,
        })
        expect(result.evidence).toEqual([])
    })

    it('prefers captcha over overlapping keywords when captcha is present', () => {
        // captcha check runs first in the classifier
        const result = classifyTrafficFailureMessage('captcha appeared after proxy timeout')
        expect(result.bucket).toBe('captcha_blocked')
        expect(result.retryable).toBe(false)
    })

    it('classifies Web SEO organic-required and low-quality outcomes explicitly', () => {
        expect(classifyTrafficFailureMessage('web_seo_organic_required: no organic hit')).toMatchObject({
            bucket: 'web_seo_target_not_found',
            code: 'web_seo_organic_required',
            retryable: false,
        })
        expect(classifyTrafficFailureMessage('web_seo_low_quality: dwell too short')).toMatchObject({
            bucket: 'web_seo_target_not_found',
            code: 'web_seo_low_quality',
            retryable: false,
        })
    })
})

describe('classifyTrafficFailure', () => {
    it('extracts message from Error instances', () => {
        const result = classifyTrafficFailure(new Error('ERR_PROXY_CONNECTION_FAILED'))
        expect(result.bucket).toBe('proxy_error')
    })

    it('stringifies non-Error values', () => {
        const result = classifyTrafficFailure('visit_watchdog_timeout')
        expect(result.bucket).toBe('watchdog_timeout')
    })

    it('handles null/undefined without throwing', () => {
        expect(classifyTrafficFailure(null).bucket).toBe('other')
        expect(classifyTrafficFailure(undefined).bucket).toBe('other')
    })
})

describe('readTrafficFailureBucketFromActions', () => {
    it('returns null for non-array input', () => {
        expect(readTrafficFailureBucketFromActions(null)).toBeNull()
        expect(readTrafficFailureBucketFromActions({})).toBeNull()
        expect(readTrafficFailureBucketFromActions('x')).toBeNull()
    })

    it('returns null when no visit_failure_classified action exists', () => {
        const actions = [
            { action: 'click', retryCategory: 'proxy_error' },
            { action: 'wait' },
        ]
        expect(readTrafficFailureBucketFromActions(actions)).toBeNull()
    })

    it('reads known retryCategory from visit_failure_classified', () => {
        const buckets: TrafficFailBucket[] = [
            'captcha_blocked',
            'watchdog_timeout',
            'proxy_error',
            'navigation_error',
            'login_gate',
            'browser_crash',
            'direct_map_not_ready',
            'web_seo_target_not_found',
            'agentic_planner',
            'other',
        ]
        for (const bucket of buckets) {
            const actions = [
                { action: 'scroll_down' },
                { action: 'visit_failure_classified', retryCategory: bucket },
            ]
            expect(readTrafficFailureBucketFromActions(actions)).toBe(bucket)
        }
    })

    it('ignores unknown retryCategory values', () => {
        const actions = [
            { action: 'visit_failure_classified', retryCategory: 'not_a_real_bucket' },
        ]
        expect(readTrafficFailureBucketFromActions(actions)).toBeNull()
    })

    it('skips non-object entries and returns first valid bucket', () => {
        const actions = [
            null,
            'noise',
            { action: 'visit_failure_classified', retryCategory: 42 },
            { action: 'visit_failure_classified', retryCategory: 'navigation_error' },
            { action: 'visit_failure_classified', retryCategory: 'proxy_error' },
        ]
        expect(readTrafficFailureBucketFromActions(actions)).toBe('navigation_error')
    })
})
