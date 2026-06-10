import { Page } from 'playwright'
import { loadSettings } from '../ipc/settings'
import { hfModelService } from './HFModelService'

export type CaptchaSolverProvider = 'none' | '2captcha' | 'capsolver' | 'local-ai'

export interface CaptchaSolveResult {
    success: boolean
    token?: string
    error?: string
    durationMs?: number
}

class CaptchaSolverService {
    /**
     * Solve a CAPTCHA on the given page using configured provider.
     * Returns true if the CAPTCHA was solved and the page should be usable.
     */
    async solveCaptchaOnPage(page: Page, threadIdx?: number): Promise<boolean> {
        const settings = loadSettings()
        const provider: CaptchaSolverProvider = settings.captchaSolverProvider || 'none'
        const apiKey: string = settings.captchaSolverApiKey || ''

        if (provider === 'none' || (!apiKey && provider !== 'local-ai')) {
            // Try local AI fallback if enabled
            if (settings.hfModelEnabled) {
                return this.solveWithLocalAI(page, threadIdx)
            }
            console.log(`[CaptchaSolver] No provider configured (provider=${provider}, hasKey=${!!apiKey})`)
            return false
        }

        try {
            // Extract sitekey from the page
            const captchaInfo = await this.extractCaptchaInfo(page)
            if (!captchaInfo) {
                console.log(`[CaptchaSolver] Thread ${(threadIdx ?? 0) + 1}: Could not extract CAPTCHA info from page`)
                return false
            }

            console.log(`[CaptchaSolver] Thread ${(threadIdx ?? 0) + 1}: Solving ${captchaInfo.type} via ${provider}...`)
            const startTime = Date.now()

            let result: CaptchaSolveResult

            switch (provider) {
                case '2captcha':
                    result = await this.solveWith2Captcha(apiKey, captchaInfo)
                    break
                case 'capsolver':
                    result = await this.solveWithCapSolver(apiKey, captchaInfo)
                    break
                case 'local-ai':
                    return this.solveWithLocalAI(page, threadIdx)
                default:
                    return false
            }

            const elapsed = Date.now() - startTime
            console.log(`[CaptchaSolver] Thread ${(threadIdx ?? 0) + 1}: ${result.success ? 'SUCCESS' : 'FAILED'} in ${elapsed}ms${result.error ? ` (${result.error})` : ''}`)

            if (result.success && result.token) {
                // Inject the token into the page
                await this.injectToken(page, result.token, captchaInfo)
                return true
            }

            // 3rd-party failed — try local AI fallback
            if (settings.hfModelEnabled) {
                console.log(`[CaptchaSolver] Thread ${(threadIdx ?? 0) + 1}: 3rd-party failed, trying local AI...`)
                return this.solveWithLocalAI(page, threadIdx)
            }

            return false
        } catch (error: any) {
            console.error(`[CaptchaSolver] Thread ${(threadIdx ?? 0) + 1}: Error:`, error?.message || error)

            // Last resort — local AI fallback
            const settings2 = loadSettings()
            if (settings2.hfModelEnabled) {
                return this.solveWithLocalAI(page, threadIdx)
            }
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
        } catch (err: any) {
            console.error(`[CaptchaSolver] ${threadLabel}: Local AI error:`, err.message)
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
        } catch (err: any) {
            console.error('[CaptchaSolver] classifyImage error:', err.message)
            return []
        }
    }

    private async extractCaptchaInfo(page: Page): Promise<CaptchaInfo | null> {
        try {
            return await page.evaluate(() => {
                // Check for reCAPTCHA v2
                const recaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]') as HTMLElement | null
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

                // Check for reCAPTCHA v2 in iframe
                const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null
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

                // Check for reCAPTCHA v3
                const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'))
                for (const script of scripts) {
                    const src = (script as HTMLScriptElement).src
                    const match = src.match(/render=([^&]+)/)
                    if (match && match[1] !== 'explicit') {
                        return {
                            type: 'recaptchav3' as const,
                            sitekey: match[1],
                            pageUrl: window.location.href,
                        }
                    }
                }

                // Google sorry page — special case
                if (window.location.href.includes('google.com/sorry') || window.location.href.includes('ipv4.google.com/sorry')) {
                    const iframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null
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
            } else if (info.type === 'recaptchav3') {
                const result = await solver.recaptcha({
                    pageurl: info.pageUrl,
                    googlekey: info.sitekey,
                    version: 'v3',
                    action: 'verify',
                    min_score: 0.3,
                })
                return {
                    success: true,
                    token: result.data,
                    durationMs: Date.now() - startTime,
                }
            }

            return { success: false, error: 'Unsupported CAPTCHA type', durationMs: Date.now() - startTime }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || 'Unknown 2captcha error',
                durationMs: Date.now() - startTime,
            }
        }
    }

    private async solveWithCapSolver(apiKey: string, info: CaptchaInfo): Promise<CaptchaSolveResult> {
        const startTime = Date.now()
        try {
            const taskType = info.type === 'recaptchav2'
                ? 'ReCaptchaV2TaskProxyLess'
                : 'ReCaptchaV3TaskProxyLess'

            const createResponse = await fetch('https://api.capsolver.com/createTask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientKey: apiKey,
                    task: {
                        type: taskType,
                        websiteURL: info.pageUrl,
                        websiteKey: info.sitekey,
                        ...(info.type === 'recaptchav3' ? { pageAction: 'verify', minScore: 0.3 } : {}),
                    },
                }),
            })

            const createData = await createResponse.json() as any
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

                const resultData = await resultResponse.json() as any
                if (resultData.status === 'ready') {
                    return {
                        success: true,
                        token: resultData.solution?.gRecaptchaResponse,
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
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || 'Unknown CapSolver error',
                durationMs: Date.now() - startTime,
            }
        }
    }

    private async injectToken(page: Page, token: string, info: CaptchaInfo): Promise<void> {
        try {
            await page.evaluate((args) => {
                const { token: t } = args
                const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]') as HTMLTextAreaElement | null
                if (textarea) {
                    textarea.style.display = 'block'
                    textarea.value = t
                    textarea.style.display = 'none'
                }

                const hiddenInput = document.querySelector('input[name="g-recaptcha-response"]') as HTMLInputElement | null
                if (hiddenInput) {
                    hiddenInput.value = t
                }

                const callbackName = document.querySelector('.g-recaptcha, [data-callback]')?.getAttribute('data-callback')
                if (callbackName && typeof (window as any)[callbackName] === 'function') {
                    (window as any)[callbackName](t)
                }

                try {
                    const cfg = (window as any).___grecaptcha_cfg
                    if (cfg?.clients) {
                        for (const clientKey of Object.keys(cfg.clients)) {
                            const client = cfg.clients[clientKey]
                            const findCallback = (obj: any, depth: number): any => {
                                if (depth > 5 || !obj) return null
                                if (typeof obj === 'function') return obj
                                if (typeof obj === 'object') {
                                    for (const key of Object.keys(obj)) {
                                        if (key === 'callback' && typeof obj[key] === 'function') {
                                            return obj[key]
                                        }
                                        const found = findCallback(obj[key], depth + 1)
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
            }, { token })

            const isGoogleSorry = page.url().includes('google.com/sorry') || page.url().includes('ipv4.google.com/sorry')
            if (isGoogleSorry) {
                const submitBtn = await page.$('input[type="submit"], button[type="submit"], #submit, .rc-button-default').catch(() => null)
                if (submitBtn) {
                    await submitBtn.click().catch(() => { })
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { })
                }
            }

            await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (error) {
            console.error('[CaptchaSolver] Error injecting token:', error)
        }
    }
}

interface CaptchaInfo {
    type: 'recaptchav2' | 'recaptchav3'
    sitekey: string
    pageUrl: string
}

export const captchaSolverService = new CaptchaSolverService()
