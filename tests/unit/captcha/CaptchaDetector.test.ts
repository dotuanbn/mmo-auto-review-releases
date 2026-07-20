import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import {
    CaptchaDetector,
    type CaptchaDetectionResult,
} from '../../../src/shared/captcha/CaptchaDetector'

/** Minimal DOM signals shape returned by page.evaluate in CaptchaDetector. */
interface DomCaptchaSignals {
    hasRecaptchaV2: boolean
    hasRecaptchaV3: boolean
    hasHcaptcha: boolean
    hasTurnstile: boolean
    hasSorryForm: boolean
    sitekey: string | null
    typedSitekey: CaptchaDetectionResult['type']
    textHit: boolean
}

const EMPTY_SIGNALS: DomCaptchaSignals = {
    hasRecaptchaV2: false,
    hasRecaptchaV3: false,
    hasHcaptcha: false,
    hasTurnstile: false,
    hasSorryForm: false,
    sitekey: null,
    typedSitekey: null,
    textHit: false,
}

/**
 * Playwright Page mock for unit tests (no real browser).
 * evaluate() returns prebuilt DOM signals instead of running in-browser code.
 */
function createMockPage(opts: {
    url?: string
    isClosed?: boolean
    signals?: Partial<DomCaptchaSignals> | null
}): Page {
    const { url = 'https://example.com', isClosed = false, signals = null } = opts
    const resolvedSignals: DomCaptchaSignals = signals
        ? { ...EMPTY_SIGNALS, ...signals }
        : { ...EMPTY_SIGNALS }

    return {
        url: () => url,
        isClosed: () => isClosed,
        evaluate: vi.fn().mockResolvedValue(resolvedSignals),
        locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
        $: vi.fn().mockResolvedValue(null),
    } as unknown as Page
}

describe('CaptchaDetector.isCaptchaUrl', () => {
    it('returns true for google.com/sorry URLs', () => {
        expect(CaptchaDetector.isCaptchaUrl('https://www.google.com/sorry/index?continue=...')).toBe(true)
        expect(CaptchaDetector.isCaptchaUrl('https://google.com/sorry')).toBe(true)
    })

    it('returns true for ipv4.google.com/sorry', () => {
        expect(CaptchaDetector.isCaptchaUrl('https://ipv4.google.com/sorry/index')).toBe(true)
    })

    it('returns true for URLs containing recaptcha', () => {
        expect(CaptchaDetector.isCaptchaUrl('https://www.google.com/recaptcha/api2/anchor?k=abc')).toBe(true)
        expect(CaptchaDetector.isCaptchaUrl('https://www.gstatic.com/recaptcha/releases/x/styles.css')).toBe(true)
    })

    it('returns false for normal Google URLs', () => {
        expect(CaptchaDetector.isCaptchaUrl('https://www.google.com/search?q=test')).toBe(false)
        expect(CaptchaDetector.isCaptchaUrl('https://www.google.com/')).toBe(false)
        expect(CaptchaDetector.isCaptchaUrl('https://maps.google.com/')).toBe(false)
    })

    it('returns true for hcaptcha.com URLs', () => {
        expect(CaptchaDetector.isCaptchaUrl('https://hcaptcha.com/1/api.js')).toBe(true)
        expect(CaptchaDetector.isCaptchaUrl('https://newassets.hcaptcha.com/captcha/v1/x/static')).toBe(true)
    })

    it('returns true for challenges.cloudflare.com URLs', () => {
        expect(
            CaptchaDetector.isCaptchaUrl(
                'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/...',
            ),
        ).toBe(true)
    })

    it('returns true for turnstile and cdn-cgi challenge paths', () => {
        expect(CaptchaDetector.isCaptchaUrl('https://example.com/turnstile/widget')).toBe(true)
        expect(CaptchaDetector.isCaptchaUrl('https://example.com/cdn-cgi/challenge-platform')).toBe(true)
    })

    it('returns false for empty string', () => {
        expect(CaptchaDetector.isCaptchaUrl('')).toBe(false)
    })

    it('handles undefined/null safely (runtime falsy coercion)', () => {
        // API is typed as string; defensive (url || '') must not throw
        expect(CaptchaDetector.isCaptchaUrl(undefined as unknown as string)).toBe(false)
        expect(CaptchaDetector.isCaptchaUrl(null as unknown as string)).toBe(false)
    })
})

describe('CaptchaDetector.detect', () => {
    it('detects reCAPTCHA v2 from DOM signals (iframe/widget)', async () => {
        const page = createMockPage({
            url: 'https://shop.example.com/login',
            signals: {
                hasRecaptchaV2: true,
                sitekey: '6Le-recaptcha-v2-key',
                typedSitekey: 'recaptchav2',
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(true)
        expect(result.type).toBe('recaptchav2')
        expect(result.sitekey).toBe('6Le-recaptcha-v2-key')
        expect(result.pageUrl).toBe('https://shop.example.com/login')
        expect(result.confidence).toBe('high')
    })

    it('detects hCaptcha from DOM signals', async () => {
        const page = createMockPage({
            url: 'https://app.example.com/signup',
            signals: {
                hasHcaptcha: true,
                sitekey: 'hcaptcha-site-key',
                typedSitekey: 'hcaptcha',
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(true)
        expect(result.type).toBe('hcaptcha')
        expect(result.sitekey).toBe('hcaptcha-site-key')
        expect(result.confidence).toBe('high')
    })

    it('detects Turnstile widget from DOM signals', async () => {
        const page = createMockPage({
            url: 'https://protected.example.com/',
            signals: {
                hasTurnstile: true,
                sitekey: '0x4AAAA-turnstile',
                typedSitekey: 'turnstile',
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(true)
        expect(result.type).toBe('turnstile')
        expect(result.sitekey).toBe('0x4AAAA-turnstile')
        expect(result.confidence).toBe('high')
    })

    it('detects Google sorry URL with high confidence', async () => {
        const page = createMockPage({
            url: 'https://www.google.com/sorry/index?continue=https://www.google.com/',
            signals: {
                hasRecaptchaV2: true,
                sitekey: 'sorry-page-key',
                typedSitekey: 'recaptchav2',
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(true)
        expect(result.type).toBe('google-sorry')
        expect(result.sitekey).toBe('sorry-page-key')
        expect(result.confidence).toBe('high')
    })

    it('returns not detected for a normal page', async () => {
        const page = createMockPage({
            url: 'https://example.com/about',
            signals: null,
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(false)
        expect(result.type).toBeNull()
        expect(result.sitekey).toBeNull()
        expect(result.pageUrl).toBe('https://example.com/about')
        expect(result.confidence).toBe('low')
    })

    it('returns detected false for a closed page', async () => {
        const page = createMockPage({
            url: 'https://example.com',
            isClosed: true,
            signals: {
                hasRecaptchaV2: true,
                sitekey: 'should-not-be-read',
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(false)
        expect(result.type).toBeNull()
        expect(result.pageUrl).toBe('')
        expect(page.evaluate).not.toHaveBeenCalled()
    })

    it('detects medium confidence when DOM has widget but no sitekey', async () => {
        const page = createMockPage({
            url: 'https://example.com/form',
            signals: {
                hasRecaptchaV2: true,
                sitekey: null,
                typedSitekey: null,
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(true)
        expect(result.type).toBe('recaptchav2')
        expect(result.confidence).toBe('medium')
    })

    it('detects unknown type from text signals only (low confidence)', async () => {
        const page = createMockPage({
            url: 'https://example.com/blocked',
            signals: {
                textHit: true,
            },
        })

        const result = await CaptchaDetector.detect(page)

        expect(result.detected).toBe(true)
        expect(result.type).toBe('unknown')
        expect(result.confidence).toBe('low')
    })
})

describe('CaptchaDetector.isCaptchaPage', () => {
    it('returns true when detect() finds a captcha', async () => {
        const page = createMockPage({
            url: 'https://example.com',
            signals: { hasHcaptcha: true, sitekey: 'hk', typedSitekey: 'hcaptcha' },
        })
        await expect(CaptchaDetector.isCaptchaPage(page)).resolves.toBe(true)
    })

    it('returns false for normal pages', async () => {
        const page = createMockPage({ url: 'https://example.com/home' })
        await expect(CaptchaDetector.isCaptchaPage(page)).resolves.toBe(false)
    })

    it('returns false for closed pages', async () => {
        const page = createMockPage({ isClosed: true })
        await expect(CaptchaDetector.isCaptchaPage(page)).resolves.toBe(false)
    })
})
