import type { Page } from 'playwright'

export type CaptchaType =
    | 'recaptchav2'
    | 'recaptchav3'
    | 'hcaptcha'
    | 'turnstile'
    | 'google-sorry'
    | 'unknown'

export interface CaptchaDetectionResult {
    detected: boolean
    type: CaptchaType | null
    sitekey: string | null
    pageUrl: string
    confidence: 'high' | 'medium' | 'low'
}

/** Internal payload returned from page.evaluate (browser context). */
interface DomCaptchaSignals {
    hasRecaptchaV2: boolean
    hasRecaptchaV3: boolean
    hasHcaptcha: boolean
    hasTurnstile: boolean
    hasSorryForm: boolean
    sitekey: string | null
    typedSitekey: CaptchaType | null
    textHit: boolean
}

const EMPTY_DOM_SIGNALS: DomCaptchaSignals = {
    hasRecaptchaV2: false,
    hasRecaptchaV3: false,
    hasHcaptcha: false,
    hasTurnstile: false,
    hasSorryForm: false,
    sitekey: null,
    typedSitekey: null,
    textHit: false,
}

const TEXT_SIGNAL_PATTERNS = [
    "i'm not a robot",
    'i am not a robot',
    'unusual traffic',
    'our systems have detected unusual traffic',
    'toi khong phai la nguoi may',
    'tôi không phải là người máy',
    'verify you are human',
    'xac minh ban la con nguoi',
    'xác minh bạn là con người',
    'captcha',
] as const

/**
 * Shared CAPTCHA / bot-challenge detector.
 * Consolidates URL, DOM, and text heuristics used across automation modules.
 * Does not import from src/main.
 */
export class CaptchaDetector {
    /**
     * Quick URL-based check (no page evaluation needed).
     * Returns true if URL suggests a CAPTCHA/sorry page.
     */
    static isCaptchaUrl(url: string): boolean {
        const u = (url || '').toLowerCase()
        if (!u) return false

        return (
            u.includes('google.com/sorry')
            || u.includes('/sorry/index')
            || u.includes('ipv4.google.com/sorry')
            || u.includes('recaptcha')
            || u.includes('hcaptcha.com')
            || u.includes('newassets.hcaptcha.com')
            || u.includes('challenges.cloudflare.com')
            || u.includes('turnstile')
            || u.includes('/cdn-cgi/challenge')
        )
    }

    /**
     * Full page-level detection. Returns detailed result.
     * Checks URL, DOM elements, and page text.
     */
    static async detect(page: Page): Promise<CaptchaDetectionResult> {
        const empty = (pageUrl: string): CaptchaDetectionResult => ({
            detected: false,
            type: null,
            sitekey: null,
            pageUrl,
            confidence: 'low',
        })

        if (!page || page.isClosed()) {
            return empty('')
        }

        let pageUrl = ''
        try {
            pageUrl = page.url()
        } catch {
            return empty('')
        }

        if (page.isClosed()) {
            return empty(pageUrl)
        }

        const urlType = CaptchaDetector.classifyUrl(pageUrl)
        if (urlType) {
            // Prefer DOM sitekey when available; URL alone is already high confidence.
            const signals = await CaptchaDetector.collectDomSignals(page)
            return {
                detected: true,
                type: urlType === 'unknown' && signals.typedSitekey
                    ? signals.typedSitekey
                    : urlType,
                sitekey: signals.sitekey,
                pageUrl,
                confidence: 'high',
            }
        }

        const signals = await CaptchaDetector.collectDomSignals(page)
        const typeFromDom = CaptchaDetector.classifyFromDom(signals)

        if (typeFromDom) {
            return {
                detected: true,
                type: typeFromDom,
                sitekey: signals.sitekey,
                pageUrl,
                confidence: signals.sitekey ? 'high' : 'medium',
            }
        }

        if (signals.textHit) {
            return {
                detected: true,
                type: 'unknown',
                sitekey: signals.sitekey,
                pageUrl,
                confidence: 'low',
            }
        }

        return empty(pageUrl)
    }

    /**
     * Simple boolean check (backward compatible with existing code).
     */
    static async isCaptchaPage(page: Page): Promise<boolean> {
        if (!page || page.isClosed()) return false
        try {
            const result = await CaptchaDetector.detect(page)
            return result.detected
        } catch {
            return false
        }
    }

    /** Map URL patterns to a concrete captcha type when possible. */
    private static classifyUrl(url: string): CaptchaType | null {
        const u = (url || '').toLowerCase()
        if (!u) return null

        if (
            u.includes('google.com/sorry')
            || u.includes('/sorry/index')
            || u.includes('ipv4.google.com/sorry')
        ) {
            return 'google-sorry'
        }

        if (u.includes('hcaptcha.com') || u.includes('newassets.hcaptcha.com')) {
            return 'hcaptcha'
        }

        if (
            u.includes('challenges.cloudflare.com')
            || u.includes('turnstile')
            || u.includes('/cdn-cgi/challenge')
        ) {
            return 'turnstile'
        }

        if (u.includes('recaptcha')) {
            // v3 enterprise/api often appears only in script URLs; treat generic as unknown subtype.
            if (u.includes('recaptcha/api.js') && u.includes('render=')) {
                return 'recaptchav3'
            }
            return 'recaptchav2'
        }

        return null
    }

    private static classifyFromDom(signals: DomCaptchaSignals): CaptchaType | null {
        if (signals.typedSitekey) return signals.typedSitekey
        if (signals.hasSorryForm) return 'google-sorry'
        if (signals.hasRecaptchaV2) return 'recaptchav2'
        if (signals.hasRecaptchaV3) return 'recaptchav3'
        if (signals.hasHcaptcha) return 'hcaptcha'
        if (signals.hasTurnstile) return 'turnstile'
        return null
    }

    /**
     * Single evaluate pass: DOM widgets, sitekey extraction, and text signals.
     * Safe against closed pages and evaluation failures.
     */
    private static async collectDomSignals(page: Page): Promise<DomCaptchaSignals> {
        if (page.isClosed()) {
            return { ...EMPTY_DOM_SIGNALS }
        }

        const textPatterns = [...TEXT_SIGNAL_PATTERNS]

        const result = await page
            .evaluate((patterns) => {
                const out: DomCaptchaSignals = {
                    hasRecaptchaV2: false,
                    hasRecaptchaV3: false,
                    hasHcaptcha: false,
                    hasTurnstile: false,
                    hasSorryForm: false,
                    sitekey: null,
                    typedSitekey: null,
                    textHit: false,
                }

                const pickAttr = (el: Element | null, attr: string): string | null => {
                    if (!el) return null
                    const value = el.getAttribute(attr)
                    return value && value.trim() ? value.trim() : null
                }

                const setKey = (key: string | null, type: CaptchaType): void => {
                    if (!key || out.sitekey) return
                    out.sitekey = key
                    out.typedSitekey = type
                }

                // --- reCAPTCHA v2 ---
                const recaptchaIframe = document.querySelector(
                    'iframe[src*="recaptcha"]',
                ) as HTMLIFrameElement | null
                const recaptchaWidget = document.querySelector(
                    'div.g-recaptcha, .g-recaptcha',
                )
                // Generic data-sitekey only when not clearly another provider
                const genericSitekeyEl = document.querySelector(
                    '[data-sitekey]:not(.h-captcha):not(.cf-turnstile):not([data-hcaptcha-sitekey]):not([data-turnstile-sitekey])',
                )
                out.hasRecaptchaV2 = !!(recaptchaIframe || recaptchaWidget || genericSitekeyEl)

                if (recaptchaWidget) {
                    setKey(pickAttr(recaptchaWidget, 'data-sitekey'), 'recaptchav2')
                }
                if (genericSitekeyEl) {
                    setKey(pickAttr(genericSitekeyEl, 'data-sitekey'), 'recaptchav2')
                }
                if (recaptchaIframe?.src) {
                    const match = recaptchaIframe.src.match(/[?&]k=([^&]+)/)
                    if (match) setKey(decodeURIComponent(match[1]), 'recaptchav2')
                }

                // --- reCAPTCHA v3 (script render=SITEKEY, no visible checkbox) ---
                const recaptchaScripts = Array.from(
                    document.querySelectorAll('script[src*="recaptcha"]'),
                ) as HTMLScriptElement[]
                for (const script of recaptchaScripts) {
                    const src = script.src || ''
                    const match = src.match(/[?&]render=([^&]+)/)
                    if (match && match[1] !== 'explicit') {
                        out.hasRecaptchaV3 = true
                        setKey(decodeURIComponent(match[1]), 'recaptchav3')
                        break
                    }
                }
                // Badge-only v3
                if (
                    !out.hasRecaptchaV3
                    && document.querySelector('.grecaptcha-badge, [data-callback]')
                    && !recaptchaIframe
                    && !document.querySelector('div.g-recaptcha')
                ) {
                    // Weak signal — only mark v3 if a sitekey was already found via script
                    if (out.typedSitekey === 'recaptchav3') {
                        out.hasRecaptchaV3 = true
                    }
                }

                // --- hCaptcha ---
                const hcaptchaIframe = document.querySelector(
                    'iframe[src*="hcaptcha"]',
                ) as HTMLIFrameElement | null
                const hcaptchaWidget = document.querySelector(
                    'div.h-captcha, .h-captcha, [data-hcaptcha-sitekey]',
                )
                out.hasHcaptcha = !!(hcaptchaIframe || hcaptchaWidget)
                if (hcaptchaWidget) {
                    setKey(pickAttr(hcaptchaWidget, 'data-hcaptcha-sitekey')
                        || pickAttr(hcaptchaWidget, 'data-sitekey'), 'hcaptcha')
                }
                if (hcaptchaIframe?.src) {
                    const match = hcaptchaIframe.src.match(/[?&]sitekey=([^&]+)/)
                    if (match) setKey(decodeURIComponent(match[1]), 'hcaptcha')
                }

                // --- Cloudflare Turnstile ---
                const turnstileIframe = document.querySelector(
                    'iframe[src*="challenges.cloudflare.com"]',
                ) as HTMLIFrameElement | null
                const turnstileWidget = document.querySelector(
                    'div.cf-turnstile, .cf-turnstile, [data-turnstile-sitekey]',
                )
                out.hasTurnstile = !!(turnstileIframe || turnstileWidget)
                if (turnstileWidget) {
                    setKey(pickAttr(turnstileWidget, 'data-turnstile-sitekey')
                        || pickAttr(turnstileWidget, 'data-sitekey'), 'turnstile')
                }

                // --- Google sorry form ---
                out.hasSorryForm = !!document.querySelector('form[action*="sorry"]')

                // --- Text signals (title + body, capped) ---
                const bodyText = (document.body?.innerText || '').toLowerCase().slice(0, 5000)
                const titleText = (document.title || '').toLowerCase()
                const snapshot = `${titleText}\n${bodyText}`
                out.textHit = patterns.some((p) => snapshot.includes(p))

                return out
            }, textPatterns)
            .catch(() => ({ ...EMPTY_DOM_SIGNALS }))

        return result ?? { ...EMPTY_DOM_SIGNALS }
    }
}
