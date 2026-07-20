import { Page } from 'playwright'
import { loadSettings } from '../ipc/settings'
import { hfModelService } from './HFModelService'
import {
    imageChallengeSolver,
    type ImageSolverProvider,
} from './captcha/ImageChallengeSolver'
import { captchaMetricsService } from './CaptchaMetricsService'

export type CaptchaSolverProvider = 'none' | '2captcha' | 'capsolver' | 'local-ai'

export interface CaptchaSolveResult {
    success: boolean
    token?: string
    error?: string
    durationMs?: number
}

interface CaptchaInfo {
    type: 'recaptchav2' | 'recaptchav3' | 'hcaptcha' | 'turnstile'
    sitekey: string
    pageUrl: string
    /** Optional reCAPTCHA v3 action name */
    action?: string
}

interface SolveAttemptMetrics {
    providerUsed: string
    captchaType: string
    success: boolean
    durationMs: number
    retryCount: number
}

interface ImageChallengeChainResult {
    success: boolean
    providerUsed: ImageSolverProvider | null
}

class CaptchaSolverService {
    /**
     * Solve a CAPTCHA on the given page using configured provider.
     * Supports primary → fallback provider chain, local AI last resort,
     * and post-injection verify/retry (max 3 attempts).
     * Returns true if the CAPTCHA was solved and the page should be usable.
     */
    async solveCaptchaOnPage(page: Page, threadIdx?: number): Promise<boolean> {
        const threadLabel = `Thread ${(threadIdx ?? 0) + 1}`
        const overallStart = Date.now()
        const settings = loadSettings() as Record<string, unknown>
        const provider: CaptchaSolverProvider = (settings.captchaSolverProvider as CaptchaSolverProvider) || 'none'
        const apiKey: string = (settings.captchaSolverApiKey as string) || ''
        const fallbackProvider: CaptchaSolverProvider =
            (settings.captchaSolverFallbackProvider as CaptchaSolverProvider) || 'none'
        const fallbackApiKey: string = (settings.captchaSolverFallbackApiKey as string) || ''
        const hfEnabled = !!settings.hfModelEnabled

        // No remote provider configured — try local AI only
        if (provider === 'none' || (!apiKey && provider !== 'local-ai')) {
            if (hfEnabled) {
                const localOk = await this.solveWithLocalAI(page, threadIdx)
                this.logSolveMetrics({
                    providerUsed: 'local-ai',
                    captchaType: 'unknown',
                    success: localOk,
                    durationMs: Date.now() - overallStart,
                    retryCount: 0,
                }, threadLabel)
                return localOk
            }
            console.log(`[CaptchaSolver] No provider configured (provider=${provider}, hasKey=${!!apiKey})`)
            this.logSolveMetrics({
                providerUsed: 'none',
                captchaType: 'unknown',
                success: false,
                durationMs: Date.now() - overallStart,
                retryCount: 0,
            }, threadLabel)
            return false
        }

        // Local-ai as primary — no remote chain
        if (provider === 'local-ai') {
            const localOk = await this.solveWithLocalAI(page, threadIdx)
            this.logSolveMetrics({
                providerUsed: 'local-ai',
                captchaType: 'unknown',
                success: localOk,
                durationMs: Date.now() - overallStart,
                retryCount: 0,
            }, threadLabel)
            return localOk
        }
        let retryCount = 0
        let lastProviderUsed: string = provider
        let lastCaptchaType = 'unknown'
        let lastSuccess = false

        const maxRetries = 3

        try {
            while (retryCount < maxRetries) {
                const captchaInfo = await this.extractCaptchaInfo(page)
                if (!captchaInfo) {
                    console.log(`[CaptchaSolver] ${threadLabel}: Could not extract CAPTCHA info from page`)
                    if (retryCount > 0 && await this.verifyCaptchaSolved(page)) {
                        lastSuccess = true
                        break
                    }

                    const imageResult = await this.solveAndVerifyImageChallenge(
                        page,
                        provider,
                        apiKey,
                        fallbackProvider,
                        fallbackApiKey,
                        threadLabel,
                    )
                    if (imageResult.success) {
                        lastCaptchaType = 'image-grid'
                        lastProviderUsed = imageResult.providerUsed ?? provider
                        lastSuccess = true
                        this.logSolveMetrics({
                            providerUsed: lastProviderUsed,
                            captchaType: lastCaptchaType,
                            success: true,
                            durationMs: Date.now() - overallStart,
                            retryCount,
                        }, threadLabel)
                        return true
                    }

                    retryCount++
                    if (retryCount < maxRetries) {
                        continue
                    }
                    break
                }

                lastCaptchaType = captchaInfo.type
                console.log(
                    `[CaptchaSolver] ${threadLabel}: Solving ${captchaInfo.type} via ${provider}` +
                    (retryCount > 0 ? ` (retry ${retryCount})` : '') + '...'
                )

                // a/b) Primary provider
                let result = await this.solveWithProvider(provider, apiKey, captchaInfo)
                lastProviderUsed = provider

                // c) Fallback provider if primary failed
                if (!result.success && fallbackProvider && fallbackProvider !== 'none') {
                    const canUseFallback =
                        fallbackProvider === 'local-ai' ||
                        (fallbackApiKey && fallbackProvider !== provider)

                    if (canUseFallback) {
                        console.log(
                            `[CaptchaSolver] ${threadLabel}: Primary (${provider}) failed` +
                            `${result.error ? `: ${result.error}` : ''}, trying fallback (${fallbackProvider})...`
                        )
                        if (fallbackProvider === 'local-ai') {
                            const localOk = await this.solveWithLocalAI(page, threadIdx)
                            lastProviderUsed = 'local-ai'
                            lastSuccess = localOk
                            this.logSolveMetrics({
                                providerUsed: lastProviderUsed,
                                captchaType: lastCaptchaType,
                                success: lastSuccess,
                                durationMs: Date.now() - overallStart,
                                retryCount,
                            }, threadLabel)
                            return localOk
                        }
                        result = await this.solveWithProvider(fallbackProvider, fallbackApiKey, captchaInfo)
                        lastProviderUsed = fallbackProvider
                    }
                }

                if (result.success && result.token) {
                    await this.injectToken(page, result.token, captchaInfo)

                    // Wait 2s then verify CAPTCHA is gone
                    await new Promise(resolve => setTimeout(resolve, 2000))
                    const solved = await this.verifyCaptchaSolved(page)

                    if (solved) {
                        lastSuccess = true
                        this.logSolveMetrics({
                            providerUsed: lastProviderUsed,
                            captchaType: lastCaptchaType,
                            success: true,
                            durationMs: Date.now() - overallStart,
                            retryCount,
                        }, threadLabel)
                        return true
                    }

                    // Still present — try image/grid challenge before retry
                    const imageAfterInject = await this.solveAndVerifyImageChallenge(
                        page,
                        provider,
                        apiKey,
                        fallbackProvider,
                        fallbackApiKey,
                        threadLabel,
                    )
                    if (imageAfterInject.success) {
                        lastProviderUsed = imageAfterInject.providerUsed ?? lastProviderUsed
                        lastCaptchaType = 'image-grid'
                        lastSuccess = true
                        this.logSolveMetrics({
                            providerUsed: lastProviderUsed,
                            captchaType: lastCaptchaType,
                            success: true,
                            durationMs: Date.now() - overallStart,
                            retryCount,
                        }, threadLabel)
                        return true
                    }

                    // Still detected — retry solve
                    retryCount++
                    console.log(
                        `[CaptchaSolver] ${threadLabel}: CAPTCHA still present after inject` +
                        ` (attempt ${retryCount}/${maxRetries})`
                    )
                    if (retryCount < maxRetries) {
                        continue
                    }
                    lastSuccess = false
                    break
                }

                // Token solvers failed — try image/grid challenge (fail-closed)
                const imageResult = await this.solveAndVerifyImageChallenge(
                    page,
                    provider,
                    apiKey,
                    fallbackProvider,
                    fallbackApiKey,
                    threadLabel,
                )
                if (imageResult.success) {
                    lastProviderUsed = imageResult.providerUsed ?? lastProviderUsed
                    lastCaptchaType = 'image-grid'
                    lastSuccess = true
                    this.logSolveMetrics({
                        providerUsed: lastProviderUsed,
                        captchaType: lastCaptchaType,
                        success: true,
                        durationMs: Date.now() - overallStart,
                        retryCount,
                    }, threadLabel)
                    return true
                }

                // Both remote providers failed — try local AI once
                if (hfEnabled) {
                    console.log(`[CaptchaSolver] ${threadLabel}: Remote solvers failed, trying local AI...`)
                    const localOk = await this.solveWithLocalAI(page, threadIdx)
                    lastProviderUsed = 'local-ai'
                    lastSuccess = localOk
                    this.logSolveMetrics({
                        providerUsed: lastProviderUsed,
                        captchaType: lastCaptchaType,
                        success: lastSuccess,
                        durationMs: Date.now() - overallStart,
                        retryCount,
                    }, threadLabel)
                    return localOk
                }

                lastSuccess = false
                break
            }

            this.logSolveMetrics({
                providerUsed: lastProviderUsed,
                captchaType: lastCaptchaType,
                success: lastSuccess,
                durationMs: Date.now() - overallStart,
                retryCount,
            }, threadLabel)
            return lastSuccess
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[CaptchaSolver] ${threadLabel}: Error:`, message)

            // Last resort — local AI fallback
            if (hfEnabled) {
                const localOk = await this.solveWithLocalAI(page, threadIdx)
                this.logSolveMetrics({
                    providerUsed: 'local-ai',
                    captchaType: lastCaptchaType,
                    success: localOk,
                    durationMs: Date.now() - overallStart,
                    retryCount,
                }, threadLabel)
                return localOk
            }

            this.logSolveMetrics({
                providerUsed: lastProviderUsed,
                captchaType: lastCaptchaType,
                success: false,
                durationMs: Date.now() - overallStart,
                retryCount,
            }, threadLabel)
            return false
        }
    }

    /**
     * Log solve metrics: provider, type, success, duration, retries.
     */
    private logSolveMetrics(metrics: SolveAttemptMetrics, threadLabel: string): void {
        captchaMetricsService.recordAttempt({
            captchaType: metrics.captchaType,
            provider: metrics.providerUsed,
            success: metrics.success,
            durationMs: metrics.durationMs,
            retryCount: metrics.retryCount,
        })
        console.log(
            `[CaptchaSolver] ${threadLabel}: METRICS` +
            ` provider=${metrics.providerUsed}` +
            ` type=${metrics.captchaType}` +
            ` success=${metrics.success}` +
            ` durationMs=${metrics.durationMs}` +
            ` retries=${metrics.retryCount}`
        )
    }

    private async solveAndVerifyImageChallenge(
        page: Page,
        provider: CaptchaSolverProvider,
        apiKey: string,
        fallbackProvider: CaptchaSolverProvider,
        fallbackApiKey: string,
        threadLabel: string,
    ): Promise<ImageChallengeChainResult> {
        const result = await this.tryImageChallengeChain(
            page,
            provider,
            apiKey,
            fallbackProvider,
            fallbackApiKey,
            threadLabel,
        )
        if (!result.success) return result

        await new Promise(resolve => setTimeout(resolve, 2000))
        return {
            success: await this.verifyCaptchaSolved(page),
            providerUsed: result.providerUsed,
        }
    }

    /**
     * Attempt image/grid solve via primary then fallback provider.
     * Fail-closed: reports an unsuccessful result when the challenge is
     * cross-origin, invalid, or cannot be applied safely.
     */
    private async tryImageChallengeChain(
        page: Page,
        provider: CaptchaSolverProvider,
        apiKey: string,
        fallbackProvider: CaptchaSolverProvider,
        fallbackApiKey: string,
        threadLabel: string,
    ): Promise<ImageChallengeChainResult> {
        const primary = this.toImageProvider(provider)
        if (primary && apiKey) {
            console.log(`[CaptchaSolver] ${threadLabel}: Trying image/grid via ${primary}...`)
            const result = await imageChallengeSolver.trySolve(page, primary, apiKey)
            if (result.success) {
                console.log(
                    `[CaptchaSolver] ${threadLabel}: Image/grid solved via ${primary}` +
                    ` cells=${result.cells?.join(',') ?? ''}`,
                )
                return { success: true, providerUsed: primary }
            }
            if (result.error?.includes('Cross-origin')) {
                console.log(`[CaptchaSolver] ${threadLabel}: ${result.error}`)
                return { success: false, providerUsed: primary }
            }
            console.log(
                `[CaptchaSolver] ${threadLabel}: Image/grid primary failed` +
                `${result.error ? `: ${result.error}` : ''}`,
            )
        }

        const fallback = this.toImageProvider(fallbackProvider)
        if (fallback && fallbackApiKey && fallback !== primary) {
            console.log(`[CaptchaSolver] ${threadLabel}: Image/grid fallback via ${fallback}...`)
            const result = await imageChallengeSolver.trySolve(page, fallback, fallbackApiKey)
            if (result.success) {
                console.log(
                    `[CaptchaSolver] ${threadLabel}: Image/grid solved via fallback ${fallback}`,
                )
                return { success: true, providerUsed: fallback }
            }
            console.log(
                `[CaptchaSolver] ${threadLabel}: Image/grid fallback failed` +
                `${result.error ? `: ${result.error}` : ''}`,
            )
        }

        return { success: false, providerUsed: null }
    }

    private toImageProvider(provider: CaptchaSolverProvider): ImageSolverProvider | null {
        if (provider === '2captcha' || provider === 'capsolver') return provider
        return null
    }

    /**
     * Dispatch solve request to the given remote provider.
     */
    private async solveWithProvider(
        provider: CaptchaSolverProvider,
        apiKey: string,
        info: CaptchaInfo
    ): Promise<CaptchaSolveResult> {
        try {
            switch (provider) {
                case '2captcha':
                    return await this.solveWith2Captcha(apiKey, info)
                case 'capsolver':
                    return await this.solveWithCapSolver(apiKey, info)
                default:
                    return { success: false, error: `Unsupported provider: ${provider}` }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: message }
        }
    }

    /**
     * Verify whether CAPTCHA widgets are still present on the page.
     * Returns true when captcha appears solved (no detectable widgets).
     */
    private async verifyCaptchaSolved(page: Page): Promise<boolean> {
        try {
            const stillPresent = await page.evaluate(() => {
                const hasRecaptcha = !!(
                    document.querySelector('.g-recaptcha[data-sitekey]') ||
                    document.querySelector('iframe[src*="recaptcha"][src*="anchor"]') ||
                    document.querySelector('iframe[src*="recaptcha"][src*="bframe"]')
                )
                const hasHcaptcha = !!(
                    document.querySelector('div.h-captcha') ||
                    document.querySelector('[data-hcaptcha-sitekey]') ||
                    document.querySelector('iframe[src*="hcaptcha.com"]')
                )
                const hasTurnstile = !!(
                    document.querySelector('div.cf-turnstile') ||
                    document.querySelector('[data-turnstile-sitekey]') ||
                    document.querySelector('iframe[src*="challenges.cloudflare.com/turnstile"]')
                )
                // Google sorry interstitial still showing
                const isSorry = window.location.href.includes('google.com/sorry') ||
                    window.location.href.includes('ipv4.google.com/sorry')

                return hasRecaptcha || hasHcaptcha || hasTurnstile || isSorry
            })

            // true = solved (widgets gone)
            return !stillPresent
        } catch {
            // On evaluation error, assume not verified
            return false
        }
    }

    /**
     * Solve image-based CAPTCHA using local AI (CLIP image classification).
     * Captures the CAPTCHA screenshot and classifies grid cells against the target label.
     */
    private async solveWithLocalAI(page: Page, threadIdx?: number): Promise<boolean> {
        const threadLabel = `Thread ${(threadIdx ?? 0) + 1}`
        try {
            console.log(`[CaptchaSolver] ${threadLabel}: Attempting local AI image captcha solve...`)

            // Check if there's a visible captcha challenge on the page
            const hasCaptchaChallenge = await page.evaluate(() => {
                // Check for reCAPTCHA image challenge iframe
                const challengeFrame = document.querySelector(
                    'iframe[src*="recaptcha"][src*="bframe"], iframe[title*="recaptcha challenge"]'
                )
                // Check for Google sorry page
                const isSorry = window.location.href.includes('google.com/sorry')
                return !!(challengeFrame || isSorry)
            }).catch(() => false)

            if (!hasCaptchaChallenge) {
                console.log(`[CaptchaSolver] ${threadLabel}: No image captcha challenge detected`)
                return false
            }

            // Take screenshot of the captcha area
            const screenshot = await page.screenshot({ type: 'png' })
            const base64Image = screenshot.toString('base64')

            // Classify the screenshot — is this a captcha page?
            const captchaLabels = [
                'captcha challenge',
                'image verification',
                'normal web page',
                'login form',
            ]

            const classification = await hfModelService.classifyImage(base64Image, captchaLabels)

            if (classification.length > 0) {
                const topResult = classification[0]
                console.log(`[CaptchaSolver] ${threadLabel}: Image classified as "${topResult.label}" (confidence: ${(topResult.score * 100).toFixed(1)}%)`)

                // If it's classified as a captcha with high confidence, log it
                if (topResult.label.includes('captcha') || topResult.label.includes('verification')) {
                    console.log(`[CaptchaSolver] ${threadLabel}: Captcha detected. Local AI classification complete.`)
                    // For now, we can only identify the captcha — full grid-solving requires Phase 4
                    // Return false to let the automation handle it (skip/retry)
                    return false
                }
            }

            return false
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`[CaptchaSolver] ${threadLabel}: Local AI error:`, message)
            return false
        }
    }

    /**
     * Classify an image against labels using local AI.
     * Utility method exposed for other services that need image classification.
     */
    async classifyImage(imageBase64: string, labels: string[]): Promise<Array<{ label: string; score: number }>> {
        try {
            return await hfModelService.classifyImage(imageBase64, labels)
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            console.error('[CaptchaSolver] classifyImage error:', message)
            return []
        }
    }

    private async extractCaptchaInfo(page: Page): Promise<CaptchaInfo | null> {
        try {
            return await page.evaluate(() => {
                // --- hCaptcha ---
                const hcaptchaEl = document.querySelector(
                    'div.h-captcha, [data-hcaptcha-sitekey]'
                ) as HTMLElement | null
                if (hcaptchaEl) {
                    const sitekey =
                        hcaptchaEl.getAttribute('data-sitekey') ||
                        hcaptchaEl.getAttribute('data-hcaptcha-sitekey')
                    if (sitekey) {
                        return {
                            type: 'hcaptcha' as const,
                            sitekey,
                            pageUrl: window.location.href,
                        }
                    }
                }

                const hcaptchaFrame = document.querySelector(
                    'iframe[src*="hcaptcha.com"]'
                ) as HTMLIFrameElement | null
                if (hcaptchaFrame) {
                    const src = hcaptchaFrame.src
                    const match = src.match(/[?&]sitekey=([^&]+)/)
                    if (match) {
                        return {
                            type: 'hcaptcha' as const,
                            sitekey: decodeURIComponent(match[1]),
                            pageUrl: window.location.href,
                        }
                    }
                }

                // --- Cloudflare Turnstile ---
                const turnstileEl = document.querySelector(
                    'div.cf-turnstile, [data-turnstile-sitekey]'
                ) as HTMLElement | null
                if (turnstileEl) {
                    const sitekey =
                        turnstileEl.getAttribute('data-sitekey') ||
                        turnstileEl.getAttribute('data-turnstile-sitekey')
                    if (sitekey) {
                        return {
                            type: 'turnstile' as const,
                            sitekey,
                            pageUrl: window.location.href,
                        }
                    }
                }

                const turnstileFrame = document.querySelector(
                    'iframe[src*="challenges.cloudflare.com/turnstile"]'
                ) as HTMLIFrameElement | null
                if (turnstileFrame) {
                    const src = turnstileFrame.src
                    const match = src.match(/[?&]sitekey=([^&]+)/)
                    if (match) {
                        return {
                            type: 'turnstile' as const,
                            sitekey: decodeURIComponent(match[1]),
                            pageUrl: window.location.href,
                        }
                    }
                }

                // --- reCAPTCHA v2 (prefer specific class; avoid matching hcaptcha/turnstile) ---
                const recaptchaDiv = document.querySelector('.g-recaptcha') as HTMLElement | null
                if (recaptchaDiv) {
                    const sitekey = recaptchaDiv.getAttribute('data-sitekey')
                    if (sitekey) {
                        return {
                            type: 'recaptchav2' as const,
                            sitekey,
                            pageUrl: window.location.href,
                        }
                    }
                }

                // Generic data-sitekey only if not clearly hcaptcha/turnstile host
                const genericSitekey = document.querySelector('[data-sitekey]') as HTMLElement | null
                if (genericSitekey) {
                    const isHcaptchaHost = !!genericSitekey.closest('.h-captcha, [data-hcaptcha-widget-id]')
                    const isTurnstileHost = !!genericSitekey.closest('.cf-turnstile')
                    if (!isHcaptchaHost && !isTurnstileHost) {
                        const sitekey = genericSitekey.getAttribute('data-sitekey')
                        if (sitekey) {
                            return {
                                type: 'recaptchav2' as const,
                                sitekey,
                                pageUrl: window.location.href,
                            }
                        }
                    }
                }

                // reCAPTCHA v2 in iframe
                const recaptchaFrame = document.querySelector(
                    'iframe[src*="recaptcha"]'
                ) as HTMLIFrameElement | null
                if (recaptchaFrame) {
                    const src = recaptchaFrame.src
                    const match = src.match(/[?&]k=([^&]+)/)
                    if (match) {
                        return {
                            type: 'recaptchav2' as const,
                            sitekey: match[1],
                            pageUrl: window.location.href,
                        }
                    }
                }

                // reCAPTCHA v3 (render=SITEKEY in script src)
                const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'))
                for (const script of scripts) {
                    const src = (script as HTMLScriptElement).src
                    const match = src.match(/render=([^&]+)/)
                    if (match && match[1] !== 'explicit') {
                        return {
                            type: 'recaptchav3' as const,
                            sitekey: match[1],
                            pageUrl: window.location.href,
                            action: 'verify',
                        }
                    }
                }

                // Google sorry page — special case
                if (
                    window.location.href.includes('google.com/sorry') ||
                    window.location.href.includes('ipv4.google.com/sorry')
                ) {
                    const iframe = document.querySelector(
                        'iframe[src*="recaptcha"]'
                    ) as HTMLIFrameElement | null
                    if (iframe) {
                        const src = iframe.src
                        const m = src.match(/[?&]k=([^&]+)/)
                        if (m) {
                            return {
                                type: 'recaptchav2' as const,
                                sitekey: m[1],
                                pageUrl: window.location.href,
                            }
                        }
                    }
                }

                return null
            })
        } catch {
            return null
        }
    }

    private async solveWith2Captcha(apiKey: string, info: CaptchaInfo): Promise<CaptchaSolveResult> {
        const startTime = Date.now()
        try {
            const { Solver } = await import('@2captcha/captcha-solver')
            const solver = new Solver(apiKey)

            if (info.type === 'recaptchav2') {
                const result = await solver.recaptcha({
                    pageurl: info.pageUrl,
                    googlekey: info.sitekey,
                })
                return {
                    success: true,
                    token: result.data,
                    durationMs: Date.now() - startTime,
                }
            }

            if (info.type === 'recaptchav3') {
                const result = await solver.recaptcha({
                    pageurl: info.pageUrl,
                    googlekey: info.sitekey,
                    version: 'v3',
                    action: info.action || 'verify',
                    min_score: 0.3,
                })
                return {
                    success: true,
                    token: result.data,
                    durationMs: Date.now() - startTime,
                }
            }

            if (info.type === 'hcaptcha') {
                const result = await solver.hcaptcha({
                    sitekey: info.sitekey,
                    pageurl: info.pageUrl,
                })
                return {
                    success: true,
                    token: result.data,
                    durationMs: Date.now() - startTime,
                }
            }

            if (info.type === 'turnstile') {
                const result = await solver.cloudflareTurnstile({
                    sitekey: info.sitekey,
                    pageurl: info.pageUrl,
                })
                return {
                    success: true,
                    token: result.data,
                    durationMs: Date.now() - startTime,
                }
            }

            return { success: false, error: 'Unsupported CAPTCHA type', durationMs: Date.now() - startTime }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown 2captcha error'
            return {
                success: false,
                error: message,
                durationMs: Date.now() - startTime,
            }
        }
    }

    private async solveWithCapSolver(apiKey: string, info: CaptchaInfo): Promise<CaptchaSolveResult> {
        const startTime = Date.now()
        try {
            let taskType: string
            const task: Record<string, unknown> = {
                websiteURL: info.pageUrl,
                websiteKey: info.sitekey,
            }

            switch (info.type) {
                case 'recaptchav2':
                    taskType = 'ReCaptchaV2TaskProxyLess'
                    break
                case 'recaptchav3':
                    taskType = 'ReCaptchaV3TaskProxyLess'
                    task.pageAction = info.action || 'verify'
                    task.minScore = 0.3
                    break
                case 'hcaptcha':
                    taskType = 'HCaptchaTaskProxyLess'
                    break
                case 'turnstile':
                    taskType = 'AntiTurnstileTaskProxyLess'
                    break
                default:
                    return {
                        success: false,
                        error: 'Unsupported CAPTCHA type',
                        durationMs: Date.now() - startTime,
                    }
            }

            task.type = taskType

            const createResponse = await fetch('https://api.capsolver.com/createTask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientKey: apiKey,
                    task,
                }),
            })

            const createData = await createResponse.json() as {
                errorId?: number
                errorDescription?: string
                errorCode?: string
                taskId?: string
            }
            if (createData.errorId !== 0) {
                return {
                    success: false,
                    error: `CapSolver create task failed: ${createData.errorDescription || createData.errorCode}`,
                    durationMs: Date.now() - startTime,
                }
            }

            const taskId = createData.taskId

            // Poll for result (max 120 seconds)
            for (let i = 0; i < 40; i++) {
                await new Promise(resolve => setTimeout(resolve, 3000))

                const resultResponse = await fetch('https://api.capsolver.com/getTaskResult', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        clientKey: apiKey,
                        taskId,
                    }),
                })

                const resultData = await resultResponse.json() as {
                    status?: string
                    errorId?: number
                    errorDescription?: string
                    errorCode?: string
                    solution?: {
                        gRecaptchaResponse?: string
                        token?: string
                    }
                }

                if (resultData.status === 'ready') {
                    // Turnstile returns solution.token; reCAPTCHA/hCaptcha use gRecaptchaResponse
                    const token =
                        info.type === 'turnstile'
                            ? resultData.solution?.token
                            : (resultData.solution?.gRecaptchaResponse || resultData.solution?.token)

                    return {
                        success: !!token,
                        token,
                        error: token ? undefined : 'CapSolver returned empty token',
                        durationMs: Date.now() - startTime,
                    }
                }

                if (resultData.errorId !== 0) {
                    return {
                        success: false,
                        error: `CapSolver error: ${resultData.errorDescription || resultData.errorCode}`,
                        durationMs: Date.now() - startTime,
                    }
                }
            }

            return { success: false, error: 'CapSolver timeout (120s)', durationMs: Date.now() - startTime }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown CapSolver error'
            return {
                success: false,
                error: message,
                durationMs: Date.now() - startTime,
            }
        }
    }

    private async injectToken(page: Page, token: string, info: CaptchaInfo): Promise<void> {
        try {
            await page.evaluate((args) => {
                const { token: t, captchaType } = args

                // --- hCaptcha ---
                if (captchaType === 'hcaptcha') {
                    const responseFields = document.querySelectorAll(
                        'textarea[name="h-captcha-response"], input[name="h-captcha-response"]'
                    )
                    responseFields.forEach((el) => {
                        const field = el as HTMLTextAreaElement | HTMLInputElement
                        field.value = t
                        field.dispatchEvent(new Event('input', { bubbles: true }))
                        field.dispatchEvent(new Event('change', { bubbles: true }))
                    })

                    // data-callback on h-captcha widget
                    const callbackName = document
                        .querySelector('.h-captcha, [data-hcaptcha-widget-id], [data-callback]')
                        ?.getAttribute('data-callback')
                    if (callbackName && typeof (window as unknown as Record<string, unknown>)[callbackName] === 'function') {
                        ; (window as unknown as Record<string, (token: string) => void>)[callbackName](t)
                    }

                    // Global hcaptcha API callback search
                    try {
                        const hcaptchaApi = (window as unknown as { hcaptcha?: { execute?: unknown } }).hcaptcha
                        if (hcaptchaApi) {
                            // Some sites store callbacks on the widget; try data-callback only above
                        }
                    } catch { /* ignore */ }

                    return
                }

                // --- Cloudflare Turnstile ---
                if (captchaType === 'turnstile') {
                    const responseFields = document.querySelectorAll(
                        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
                    )
                    responseFields.forEach((el) => {
                        const field = el as HTMLInputElement | HTMLTextAreaElement
                        field.value = t
                        field.dispatchEvent(new Event('input', { bubbles: true }))
                        field.dispatchEvent(new Event('change', { bubbles: true }))
                    })

                    const callbackName = document
                        .querySelector('.cf-turnstile, [data-turnstile-sitekey], [data-callback]')
                        ?.getAttribute('data-callback')
                    if (callbackName && typeof (window as unknown as Record<string, unknown>)[callbackName] === 'function') {
                        ; (window as unknown as Record<string, (token: string) => void>)[callbackName](t)
                    }

                    // turnstile global callbacks if present
                    try {
                        const turnstileApi = (window as unknown as {
                            turnstile?: { getResponse?: () => string }
                        }).turnstile
                        void turnstileApi
                    } catch { /* ignore */ }

                    return
                }

                // --- reCAPTCHA v2 / v3 ---
                const textarea = document.querySelector(
                    '#g-recaptcha-response, [name="g-recaptcha-response"]'
                ) as HTMLTextAreaElement | null
                if (textarea) {
                    textarea.style.display = 'block'
                    textarea.value = t
                    textarea.style.display = 'none'
                }

                const hiddenInput = document.querySelector(
                    'input[name="g-recaptcha-response"]'
                ) as HTMLInputElement | null
                if (hiddenInput) {
                    hiddenInput.value = t
                }

                const callbackName = document
                    .querySelector('.g-recaptcha, [data-callback]')
                    ?.getAttribute('data-callback')
                if (callbackName && typeof (window as unknown as Record<string, unknown>)[callbackName] === 'function') {
                    ; (window as unknown as Record<string, (token: string) => void>)[callbackName](t)
                }

                try {
                    const cfg = (window as unknown as {
                        ___grecaptcha_cfg?: { clients?: Record<string, unknown> }
                    }).___grecaptcha_cfg
                    if (cfg?.clients) {
                        for (const clientKey of Object.keys(cfg.clients)) {
                            const client = cfg.clients[clientKey]
                            const findCallback = (obj: unknown, depth: number): ((token: string) => void) | null => {
                                if (depth > 5 || !obj) return null
                                if (typeof obj === 'function') return obj as (token: string) => void
                                if (typeof obj === 'object' && obj !== null) {
                                    for (const key of Object.keys(obj as Record<string, unknown>)) {
                                        const record = obj as Record<string, unknown>
                                        if (key === 'callback' && typeof record[key] === 'function') {
                                            return record[key] as (token: string) => void
                                        }
                                        const found = findCallback(record[key], depth + 1)
                                        if (found) return found
                                    }
                                }
                                return null
                            }
                            const cb = findCallback(client, 0)
                            if (cb) {
                                cb(t)
                                break
                            }
                        }
                    }
                } catch { /* ignore */ }
            }, { token, captchaType: info.type })

            const isGoogleSorry =
                page.url().includes('google.com/sorry') ||
                page.url().includes('ipv4.google.com/sorry')
            if (isGoogleSorry) {
                const submitBtn = await page
                    .$('input[type="submit"], button[type="submit"], #submit, .rc-button-default')
                    .catch(() => null)
                if (submitBtn) {
                    await submitBtn.click().catch(() => { })
                    await page
                        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
                        .catch(() => { })
                }
            }

            // Note: post-inject wait is handled by the caller (verify path)
        } catch (error) {
            console.error('[CaptchaSolver] Error injecting token:', error)
        }
    }
}

export const captchaSolverService = new CaptchaSolverService()
