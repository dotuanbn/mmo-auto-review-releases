import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'

// ---------------------------------------------------------------------------
// Mocks (hoisted by Vitest before imports under test)
// ---------------------------------------------------------------------------

const {
    mockLoadSettings,
    mockClassifyImage,
    mockRecaptcha,
    mockHcaptcha,
    mockTurnstile,
    mockImageTrySolve,
    mockRecordAttempt,
} = vi.hoisted(() => ({
    mockLoadSettings: vi.fn(),
    mockClassifyImage: vi.fn(),
    mockRecaptcha: vi.fn(),
    mockHcaptcha: vi.fn(),
    mockTurnstile: vi.fn(),
    mockImageTrySolve: vi.fn(),
    mockRecordAttempt: vi.fn(),
}))

vi.mock('../../../src/main/ipc/settings', () => ({
    loadSettings: mockLoadSettings,
}))

vi.mock('../../../src/main/services/HFModelService', () => ({
    hfModelService: {
        classifyImage: mockClassifyImage,
    },
}))

vi.mock('../../../src/main/services/captcha/ImageChallengeSolver', () => ({
    imageChallengeSolver: {
        trySolve: mockImageTrySolve,
    },
}))

vi.mock('../../../src/main/services/CaptchaMetricsService', () => ({
    captchaMetricsService: {
        recordAttempt: mockRecordAttempt,
    },
}))

vi.mock('@2captcha/captcha-solver', () => ({
    Solver: vi.fn().mockImplementation(() => ({
        recaptcha: mockRecaptcha,
        hcaptcha: mockHcaptcha,
        cloudflareTurnstile: mockTurnstile,
    })),
}))

import { captchaSolverService } from '../../../src/main/services/CaptchaSolverService'

/** CaptchaInfo shape from CaptchaSolverService (private interface mirrored for tests). */
interface CaptchaInfo {
    type: 'recaptchav2' | 'recaptchav3' | 'hcaptcha' | 'turnstile'
    sitekey: string
    pageUrl: string
    action?: string
}

/** Access private helpers without changing production exports. */
type SolverInternals = {
    extractCaptchaInfo: (page: Page) => Promise<CaptchaInfo | null>
    verifyCaptchaSolved: (page: Page) => Promise<boolean>
}

function getInternals(): SolverInternals {
    return captchaSolverService as unknown as SolverInternals
}

/**
 * Page mock whose evaluate queue returns values in call order.
 * Covers extractCaptchaInfo → injectToken → verifyCaptchaSolved paths.
 */
function createMockPage(opts: {
    url?: string
    evaluateQueue?: unknown[]
    evaluateImpl?: (fn: unknown, args?: unknown) => Promise<unknown>
}): Page {
    const { url = 'https://example.com/login', evaluateQueue = [], evaluateImpl } = opts
    let callIndex = 0

    return {
        url: () => url,
        isClosed: () => false,
        evaluate: vi.fn().mockImplementation((fn: unknown, args?: unknown) => {
            if (evaluateImpl) {
                return evaluateImpl(fn, args)
            }
            const value = evaluateQueue[callIndex]
            callIndex += 1
            return Promise.resolve(value === undefined ? null : value)
        }),
        $: vi.fn().mockResolvedValue(null),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
        waitForNavigation: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page
}

function defaultSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        captchaSolverProvider: 'none',
        captchaSolverApiKey: '',
        captchaSolverFallbackProvider: 'none',
        captchaSolverFallbackApiKey: '',
        hfModelEnabled: false,
        ...overrides,
    }
}

/**
 * Collapse real delays (CapSolver poll 3s, post-inject verify 2s) to microtasks.
 * Avoids fake-timer deadlocks with async fetch + Promise chains.
 * Uses spyOn so we can mockRestore without resetting vi.mock module mocks.
 */
function stubImmediateTimers(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        handler: TimerHandler,
        _ms?: number,
        ...args: unknown[]
    ) => {
        if (typeof handler === 'function') {
            queueMicrotask(() => {
                ;(handler as (...a: unknown[]) => void)(...args)
            })
        }
        return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
}

describe('CaptchaSolverService', () => {
    let timerSpy: ReturnType<typeof vi.spyOn> | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        mockLoadSettings.mockReturnValue(defaultSettings())
        mockClassifyImage.mockResolvedValue([])
        // clear history only — keep default mock fn shape (do not mockReset implementations of Solver wiring)
        mockRecaptcha.mockClear()
        mockHcaptcha.mockClear()
        mockTurnstile.mockClear()
        mockRecaptcha.mockReset()
        mockHcaptcha.mockReset()
        mockTurnstile.mockReset()
        mockImageTrySolve.mockReset()
        mockImageTrySolve.mockResolvedValue({ success: false, error: 'no image challenge' })
    })

    afterEach(() => {
        // Restore only the timer spy — never restoreAllMocks (it wipes @2captcha Solver mockImplementation)
        timerSpy?.mockRestore()
        timerSpy = undefined
        vi.unstubAllGlobals()
    })

    // -----------------------------------------------------------------------
    // provider: none
    // -----------------------------------------------------------------------

    describe('solveCaptchaOnPage — none provider', () => {
        it('returns false when provider is none and local AI is disabled', async () => {
            mockLoadSettings.mockReturnValue(
                defaultSettings({ captchaSolverProvider: 'none', hfModelEnabled: false }),
            )
            const page = createMockPage({})

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(false)
            expect(page.evaluate).not.toHaveBeenCalled()
        })

        it('returns false when provider is set but apiKey is empty (and not local-ai)', async () => {
            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: '',
                    hfModelEnabled: false,
                }),
            )
            const page = createMockPage({})

            await expect(captchaSolverService.solveCaptchaOnPage(page)).resolves.toBe(false)
        })
    })

    // -----------------------------------------------------------------------
    // extractCaptchaInfo (private, tested via cast)
    // -----------------------------------------------------------------------

    describe('extractCaptchaInfo', () => {
        const { extractCaptchaInfo } = getInternals()

        it('extracts recaptchav2 info from page evaluate result', async () => {
            const info: CaptchaInfo = {
                type: 'recaptchav2',
                sitekey: '6LeTest-recaptcha-v2',
                pageUrl: 'https://example.com/form',
            }
            const page = createMockPage({
                evaluateQueue: [info],
            })

            await expect(extractCaptchaInfo(page)).resolves.toEqual(info)
        })

        it('extracts recaptchav3 info with action', async () => {
            const info: CaptchaInfo = {
                type: 'recaptchav3',
                sitekey: '6LeTest-recaptcha-v3',
                pageUrl: 'https://example.com/checkout',
                action: 'verify',
            }
            const page = createMockPage({ evaluateQueue: [info] })

            await expect(extractCaptchaInfo(page)).resolves.toEqual(info)
        })

        it('extracts hcaptcha info', async () => {
            const info: CaptchaInfo = {
                type: 'hcaptcha',
                sitekey: 'HCAPTCHA-SITE-KEY',
                pageUrl: 'https://example.com/signup',
            }
            const page = createMockPage({ evaluateQueue: [info] })

            await expect(extractCaptchaInfo(page)).resolves.toEqual(info)
        })

        it('extracts turnstile info', async () => {
            const info: CaptchaInfo = {
                type: 'turnstile',
                sitekey: '0x4AAAA-TURNSTILE',
                pageUrl: 'https://example.com/wall',
            }
            const page = createMockPage({ evaluateQueue: [info] })

            await expect(extractCaptchaInfo(page)).resolves.toEqual(info)
        })

        it('returns null when no captcha is present', async () => {
            const page = createMockPage({ evaluateQueue: [null, false] })
            await expect(extractCaptchaInfo(page)).resolves.toBeNull()
        })

        it('returns null when evaluate throws', async () => {
            const page = createMockPage({
                evaluateImpl: async () => {
                    throw new Error('Execution context destroyed')
                },
            })
            await expect(extractCaptchaInfo(page)).resolves.toBeNull()
        })
    })

    // -----------------------------------------------------------------------
    // verifyCaptchaSolved (private)
    // -----------------------------------------------------------------------

    describe('verifyCaptchaSolved', () => {
        const { verifyCaptchaSolved } = getInternals()

        it('returns true when widgets are gone (evaluate reports stillPresent=false)', async () => {
            const page = createMockPage({ evaluateQueue: [false] })
            await expect(verifyCaptchaSolved(page)).resolves.toBe(true)
        })

        it('returns false when widgets are still present', async () => {
            const page = createMockPage({ evaluateQueue: [true] })
            await expect(verifyCaptchaSolved(page)).resolves.toBe(false)
        })

        it('fails closed when verification evaluate rejects', async () => {
            const page = createMockPage({
                evaluateImpl: async () => {
                    throw new Error('frame detached')
                },
            })
            await expect(verifyCaptchaSolved(page)).resolves.toBe(false)
        })

        it('returns false when page.evaluate is not a function / outer throw', async () => {
            const page = {
                evaluate: null,
            } as unknown as Page
            // page.evaluate is null → calling it throws → outer catch → false
            await expect(verifyCaptchaSolved(page)).resolves.toBe(false)
        })
    })

    // -----------------------------------------------------------------------
    // Fallback provider chain (primary fails → fallback succeeds)
    // -----------------------------------------------------------------------

    describe('solveCaptchaOnPage — fallback provider chain', () => {
        it('tries CapSolver fallback when 2captcha primary fails', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'primary-key',
                    captchaSolverFallbackProvider: 'capsolver',
                    captchaSolverFallbackApiKey: 'fallback-key',
                    hfModelEnabled: false,
                }),
            )

            // Primary 2captcha fails
            mockRecaptcha.mockRejectedValue(new Error('2captcha primary failed'))

            // CapSolver: createTask OK → getTaskResult ready
            const fetchMock = vi
                .fn()
                .mockResolvedValueOnce({
                    json: async () => ({ errorId: 0, taskId: 'task-fallback-1' }),
                })
                .mockResolvedValueOnce({
                    json: async () => ({
                        status: 'ready',
                        errorId: 0,
                        solution: { gRecaptchaResponse: 'FALLBACK-TOKEN-XYZ' },
                    }),
                })
            vi.stubGlobal('fetch', fetchMock)

            const captchaInfo: CaptchaInfo = {
                type: 'recaptchav2',
                sitekey: '6LeTestKey',
                pageUrl: 'https://example.com/login',
            }

            // evaluate order: extract → inject → verify(stillPresent=false)
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [captchaInfo, undefined, false],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockRecaptcha).toHaveBeenCalled()
            expect(fetchMock).toHaveBeenCalled()

            // createTask should use fallback API key
            const createBody = JSON.parse(
                (fetchMock.mock.calls[0][1] as { body: string }).body,
            ) as { clientKey: string; task: { type: string } }
            expect(createBody.clientKey).toBe('fallback-key')
            expect(createBody.task.type).toBe('ReCaptchaV2TaskProxyLess')
            expect(String(fetchMock.mock.calls[0][0])).toContain('api.capsolver.com/createTask')
        })

        it('returns false when both primary and fallback fail (no local AI)', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'primary-key',
                    captchaSolverFallbackProvider: 'capsolver',
                    captchaSolverFallbackApiKey: 'fallback-key',
                    hfModelEnabled: false,
                }),
            )

            mockRecaptcha.mockRejectedValue(new Error('primary down'))

            // CapSolver createTask error
            const fetchMock = vi.fn().mockResolvedValue({
                json: async () => ({
                    errorId: 1,
                    errorDescription: 'ERROR_KEY_DENIED',
                    errorCode: 'ERROR_KEY_DENIED',
                }),
            })
            vi.stubGlobal('fetch', fetchMock)

            const captchaInfo: CaptchaInfo = {
                type: 'recaptchav2',
                sitekey: '6LeTestKey',
                pageUrl: 'https://example.com/login',
            }
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [captchaInfo],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(false)
            expect(mockRecaptcha).toHaveBeenCalled()
            expect(fetchMock).toHaveBeenCalled()
        })

        it('skips fallback when fallback provider is none', async () => {
            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'primary-key',
                    captchaSolverFallbackProvider: 'none',
                    captchaSolverFallbackApiKey: '',
                    hfModelEnabled: false,
                }),
            )

            mockRecaptcha.mockRejectedValue(new Error('primary failed'))

            const captchaInfo: CaptchaInfo = {
                type: 'hcaptcha',
                sitekey: 'h-key',
                pageUrl: 'https://example.com',
            }
            const page = createMockPage({
                evaluateQueue: [captchaInfo],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(false)
            expect(mockRecaptcha).not.toHaveBeenCalled() // hcaptcha uses solver.hcaptcha
            expect(mockHcaptcha).toHaveBeenCalled()
        })
    })

    // -----------------------------------------------------------------------
    // verify path after successful token
    // -----------------------------------------------------------------------

    describe('solveCaptchaOnPage — verify after injection', () => {
        it('returns true when primary succeeds and verifyCaptchaSolved reports clean page', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'key-ok',
                    captchaSolverFallbackProvider: 'none',
                    hfModelEnabled: false,
                }),
            )

            mockRecaptcha.mockResolvedValue({ data: 'TOKEN-FROM-2CAPTCHA' })

            const captchaInfo: CaptchaInfo = {
                type: 'recaptchav2',
                sitekey: '6LeOk',
                pageUrl: 'https://example.com/ok',
            }

            // extract → inject → verify(stillPresent=false) → solved
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [captchaInfo, undefined, false],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockRecaptcha).toHaveBeenCalledWith(
                expect.objectContaining({
                    pageurl: captchaInfo.pageUrl,
                    googlekey: captchaInfo.sitekey,
                }),
            )
            // extract + inject + verify
            expect(page.evaluate).toHaveBeenCalledTimes(3)
        })

        it('retries when verify still sees captcha, then succeeds on second attempt', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'key-ok',
                    captchaSolverFallbackProvider: 'none',
                    hfModelEnabled: false,
                }),
            )

            mockRecaptcha
                .mockResolvedValueOnce({ data: 'TOKEN-1' })
                .mockResolvedValueOnce({ data: 'TOKEN-2' })

            const captchaInfo: CaptchaInfo = {
                type: 'recaptchav2',
                sitekey: '6LeRetry',
                pageUrl: 'https://example.com/retry',
            }

            // Attempt 1: extract, inject, verify stillPresent=true → image fail → retry
            // Attempt 2: extract, inject, verify stillPresent=false
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [
                    captchaInfo,
                    undefined,
                    true, // still present after first inject
                    captchaInfo,
                    undefined,
                    false, // solved on second try
                ],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockRecaptcha).toHaveBeenCalledTimes(2)
        })
    })

    // -----------------------------------------------------------------------
    // Image/grid CAPTCHA path (fail-closed)
    // -----------------------------------------------------------------------

    describe('solveCaptchaOnPage — image/grid challenge', () => {
        it('solves image-grid when sitekey extract fails but ImageChallengeSolver succeeds', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: 'capsolver',
                    captchaSolverApiKey: 'cap-key',
                    captchaSolverFallbackProvider: 'none',
                    hfModelEnabled: false,
                }),
            )

            mockImageTrySolve.mockResolvedValue({
                success: true,
                cells: [0, 4, 8],
            })

            // extractCaptchaInfo → null; image path succeeds
            const page = createMockPage({ evaluateQueue: [null] })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockImageTrySolve).toHaveBeenCalledWith(
                page,
                'capsolver',
                'cap-key',
            )
            expect(mockRecordAttempt).toHaveBeenCalledWith(expect.objectContaining({
                captchaType: 'image-grid',
                provider: 'capsolver',
                success: true,
            }))
        })

        it('does not report success when image cells were clicked but CAPTCHA remains', async () => {
            timerSpy = stubImmediateTimers()
            mockLoadSettings.mockReturnValue(defaultSettings({
                captchaSolverProvider: 'capsolver',
                captchaSolverApiKey: 'cap-key',
                captchaSolverFallbackProvider: 'none',
                hfModelEnabled: false,
            }))
            mockImageTrySolve.mockResolvedValue({ success: true, cells: [1] })

            const page = createMockPage({
                evaluateQueue: [null, true, null, true, true, null, true, true],
            })
            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(false)
            expect(mockImageTrySolve).toHaveBeenCalledTimes(3)
            expect(mockRecordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
                success: false,
            }))
        })

        it('returns false (fail-closed) when image challenge is cross-origin unsupported', async () => {
            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'key',
                    captchaSolverFallbackProvider: 'none',
                    hfModelEnabled: false,
                }),
            )

            mockImageTrySolve.mockResolvedValue({
                success: false,
                error: 'Cross-origin challenge unsupported (manual/skip)',
            })

            const page = createMockPage({
                evaluateQueue: [null, null, true, null, true],
            })
            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(false)
            expect(mockImageTrySolve).toHaveBeenCalled()
        })

        it('tries image path after token inject when captcha still present', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'key-ok',
                    captchaSolverFallbackProvider: 'none',
                    hfModelEnabled: false,
                }),
            )

            mockRecaptcha.mockResolvedValue({ data: 'TOKEN-PARTIAL' })
            mockImageTrySolve.mockResolvedValue({ success: true, cells: [1, 2] })

            const captchaInfo: CaptchaInfo = {
                type: 'recaptchav2',
                sitekey: '6LeImg',
                pageUrl: 'https://example.com/img',
            }

            // extract → inject → verify still present → image ok → verify clean
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [captchaInfo, undefined, true, false],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockImageTrySolve).toHaveBeenCalled()
            expect(mockRecaptcha).toHaveBeenCalled()
        })

        it('preserves hCaptcha primary → CapSolver fallback chain', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'primary-key',
                    captchaSolverFallbackProvider: 'capsolver',
                    captchaSolverFallbackApiKey: 'fallback-key',
                    hfModelEnabled: false,
                }),
            )

            mockHcaptcha.mockRejectedValue(new Error('hcaptcha primary failed'))

            const fetchMock = vi
                .fn()
                .mockResolvedValueOnce({
                    json: async () => ({ errorId: 0, taskId: 'hc-task-1' }),
                })
                .mockResolvedValueOnce({
                    json: async () => ({
                        status: 'ready',
                        errorId: 0,
                        solution: { gRecaptchaResponse: 'HCAPTCHA-FALLBACK-TOKEN' },
                    }),
                })
            vi.stubGlobal('fetch', fetchMock)

            const captchaInfo: CaptchaInfo = {
                type: 'hcaptcha',
                sitekey: 'HCAPTCHA-KEY',
                pageUrl: 'https://example.com/hcaptcha',
            }
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [captchaInfo, undefined, false],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockHcaptcha).toHaveBeenCalled()
            const createBody = JSON.parse(
                (fetchMock.mock.calls[0][1] as { body: string }).body,
            ) as { clientKey: string; task: { type: string } }
            expect(createBody.clientKey).toBe('fallback-key')
            expect(createBody.task.type).toBe('HCaptchaTaskProxyLess')
        })

        it('preserves Turnstile primary success path', async () => {
            timerSpy = stubImmediateTimers()

            mockLoadSettings.mockReturnValue(
                defaultSettings({
                    captchaSolverProvider: '2captcha',
                    captchaSolverApiKey: 'key-ok',
                    captchaSolverFallbackProvider: 'none',
                    hfModelEnabled: false,
                }),
            )

            mockTurnstile.mockResolvedValue({ data: 'TURNSTILE-TOKEN' })

            const captchaInfo: CaptchaInfo = {
                type: 'turnstile',
                sitekey: '0x4AAAA-TEST',
                pageUrl: 'https://example.com/cf',
            }
            const page = createMockPage({
                url: captchaInfo.pageUrl,
                evaluateQueue: [captchaInfo, undefined, false],
            })

            const result = await captchaSolverService.solveCaptchaOnPage(page, 0)

            expect(result).toBe(true)
            expect(mockTurnstile).toHaveBeenCalledWith(
                expect.objectContaining({
                    sitekey: captchaInfo.sitekey,
                    pageurl: captchaInfo.pageUrl,
                }),
            )
        })
    })
})
