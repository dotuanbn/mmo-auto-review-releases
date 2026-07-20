import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame, Page } from 'playwright'
import {
    ImageChallengeSolver,
    type ImageChallengeMeta,
} from '../../../src/main/services/captcha/ImageChallengeSolver'

const { mockGrid } = vi.hoisted(() => ({
    mockGrid: vi.fn(),
}))

vi.mock('@2captcha/captcha-solver', () => ({
    Solver: vi.fn().mockImplementation(() => ({
        grid: mockGrid,
    })),
}))

function createFrame(opts: {
    url?: string
    evaluateResult?: unknown
    tileCount?: number
}): Frame {
    const { url = 'https://www.google.com/recaptcha/api2/bframe?k=x', evaluateResult = null, tileCount = 9 } = opts
    const click = vi.fn().mockResolvedValue(undefined)
    return {
        url: () => url,
        evaluate: vi.fn().mockResolvedValue(evaluateResult),
        locator: vi.fn().mockImplementation(() => ({
            first: () => ({
                count: vi.fn().mockResolvedValue(1),
                screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
                click,
            }),
            count: vi.fn().mockResolvedValue(tileCount),
            nth: vi.fn().mockReturnValue({ click }),
            screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
        })),
    } as unknown as Frame
}

function createPage(opts: {
    frames?: Frame[]
    evaluateResult?: unknown
}): Page {
    const { frames = [], evaluateResult = false } = opts
    return {
        frames: () => frames,
        evaluate: vi.fn().mockResolvedValue(evaluateResult),
        url: () => 'https://example.com',
        isClosed: () => false,
    } as unknown as Page
}

describe('ImageChallengeSolver', () => {
    let solver: ImageChallengeSolver

    beforeEach(() => {
        solver = new ImageChallengeSolver()
        vi.clearAllMocks()
        mockGrid.mockReset()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    // -----------------------------------------------------------------------
    // Prompt → CapSolver question ID mapping
    // -----------------------------------------------------------------------

    describe('mapPromptToQuestionId', () => {
        it('maps cars / vehicles to /m/0k4j', () => {
            expect(solver.mapPromptToQuestionId('Select all images with cars')).toBe('/m/0k4j')
            expect(solver.mapPromptToQuestionId('Select all squares with vehicles')).toBe('/m/0k4j')
        })

        it('maps traffic lights and bicycles', () => {
            expect(solver.mapPromptToQuestionId('Select all traffic lights')).toBe('/m/015qff')
            expect(solver.mapPromptToQuestionId('Click on bicycles')).toBe('/m/0199g')
        })

        it('returns null for empty or unmapped prompts (fail-closed)', () => {
            expect(solver.mapPromptToQuestionId('')).toBeNull()
            expect(solver.mapPromptToQuestionId('   ')).toBeNull()
            expect(solver.mapPromptToQuestionId('Select all unicorns')).toBeNull()
        })
    })

    // -----------------------------------------------------------------------
    // Answer validation (fail-closed)
    // -----------------------------------------------------------------------

    describe('isValidAnswer', () => {
        it('accepts unique in-range 0-based indices for 3x3', () => {
            expect(solver.isValidAnswer([0, 4, 8], 3, 3)).toBe(true)
        })

        it('rejects empty, OOB, non-integer, and duplicates', () => {
            expect(solver.isValidAnswer([], 3, 3)).toBe(false)
            expect(solver.isValidAnswer([9], 3, 3)).toBe(false)
            expect(solver.isValidAnswer([-1], 3, 3)).toBe(false)
            expect(solver.isValidAnswer([1.5], 3, 3)).toBe(false)
            expect(solver.isValidAnswer([1, 1], 3, 3)).toBe(false)
        })

        it('rejects invalid grid sizes', () => {
            expect(solver.isValidAnswer([0], 2, 2)).toBe(false)
            expect(solver.isValidAnswer([0], 5, 5)).toBe(false)
        })
    })

    // -----------------------------------------------------------------------
    // Response parsers
    // -----------------------------------------------------------------------

    describe('parseCapSolverObjects', () => {
        it('parses 0-based object indices', () => {
            expect(solver.parseCapSolverObjects([0, 1, 2, 3])).toEqual([0, 1, 2, 3])
        })

        it('returns empty for non-array', () => {
            expect(solver.parseCapSolverObjects(null)).toEqual([])
            expect(solver.parseCapSolverObjects('1,2')).toEqual([])
        })
    })

    describe('parse2CaptchaGridData', () => {
        it('parses click:N/M/O as 1-based → 0-based', () => {
            expect(solver.parse2CaptchaGridData('click:3/6/8')).toEqual([2, 5, 7])
        })

        it('parses slash-separated and array forms', () => {
            expect(solver.parse2CaptchaGridData('1/2/9')).toEqual([0, 1, 8])
            expect(solver.parse2CaptchaGridData([1, 2, 3])).toEqual([0, 1, 2])
        })

        it('returns empty for No_matching_images or blank', () => {
            expect(solver.parse2CaptchaGridData('No_matching_images')).toEqual([])
            expect(solver.parse2CaptchaGridData('')).toEqual([])
            expect(solver.parse2CaptchaGridData(null)).toEqual([])
        })
    })

    // -----------------------------------------------------------------------
    // extractChallenge — cross-origin fail-closed
    // -----------------------------------------------------------------------

    describe('extractChallenge', () => {
        it('returns crossOriginUnsupported when iframe exists but no Frame access', async () => {
            const page = createPage({ frames: [], evaluateResult: true })
            const meta = await solver.extractChallenge(page)
            expect(meta).not.toBeNull()
            expect(meta?.crossOriginUnsupported).toBe(true)
            expect(meta?.prompt).toBe('')
        })

        it('returns null when no challenge iframe at all', async () => {
            const page = createPage({ frames: [], evaluateResult: false })
            await expect(solver.extractChallenge(page)).resolves.toBeNull()
        })

        it('reads prompt and 3x3 grid from accessible bframe', async () => {
            const frame = createFrame({
                evaluateResult: {
                    prompt: 'Select all images with cars',
                    rows: 3,
                    columns: 3,
                },
            })
            const page = createPage({ frames: [frame] })
            const meta = await solver.extractChallenge(page)
            expect(meta).toEqual<ImageChallengeMeta>({
                prompt: 'Select all images with cars',
                rows: 3,
                columns: 3,
                crossOriginUnsupported: false,
                frameUrl: frame.url(),
            })
        })
    })

    // -----------------------------------------------------------------------
    // trySolve — end-to-end fail-closed + CapSolver path
    // -----------------------------------------------------------------------

    describe('trySolve', () => {
        it('returns false without api key', async () => {
            const page = createPage({})
            const result = await solver.trySolve(page, 'capsolver', '')
            expect(result.success).toBe(false)
            expect(result.error).toMatch(/provider|key/i)
        })

        it('returns false for cross-origin unsupported (manual/skip)', async () => {
            const page = createPage({ frames: [], evaluateResult: true })
            const result = await solver.trySolve(page, 'capsolver', 'key')
            expect(result.success).toBe(false)
            expect(result.error).toMatch(/Cross-origin/i)
        })

        it('returns false when prompt cannot map to CapSolver question', async () => {
            const frame = createFrame({
                evaluateResult: {
                    prompt: 'Select all unicorns',
                    rows: 3,
                    columns: 3,
                },
            })
            const page = createPage({ frames: [frame] })
            const result = await solver.trySolve(page, 'capsolver', 'key')
            expect(result.success).toBe(false)
        })

        it('uses ReCaptchaV2Classification and clicks only valid cells', async () => {
            const frame = createFrame({
                evaluateResult: {
                    prompt: 'Select all images with cars',
                    rows: 3,
                    columns: 3,
                },
                tileCount: 9,
            })
            const page = createPage({ frames: [frame] })

            const fetchMock = vi.fn().mockResolvedValue({
                json: async () => ({
                    errorId: 0,
                    status: 'ready',
                    solution: { type: 'multi', objects: [0, 4, 8], size: 3 },
                }),
            })
            vi.stubGlobal('fetch', fetchMock)

            // Speed up click delays
            const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
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

            const result = await solver.trySolve(page, 'capsolver', 'cap-key')

            expect(result.success).toBe(true)
            expect(result.cells).toEqual([0, 4, 8])

            const body = JSON.parse(
                (fetchMock.mock.calls[0][1] as { body: string }).body,
            ) as { clientKey: string; task: { type: string; question: string; image: string } }
            expect(body.clientKey).toBe('cap-key')
            expect(body.task.type).toBe('ReCaptchaV2Classification')
            expect(body.task.question).toBe('/m/0k4j')
            expect(body.task.image).toBeTruthy()
            expect(String(fetchMock.mock.calls[0][0])).toContain('api.capsolver.com/createTask')

            timerSpy.mockRestore()
        })

        it('does not click when CapSolver returns empty objects (fail-closed)', async () => {
            const frame = createFrame({
                evaluateResult: {
                    prompt: 'Select all images with buses',
                    rows: 3,
                    columns: 3,
                },
            })
            const page = createPage({ frames: [frame] })

            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    json: async () => ({
                        errorId: 0,
                        status: 'ready',
                        solution: { type: 'multi', objects: [], size: 0 },
                    }),
                }),
            )

            const result = await solver.trySolve(page, 'capsolver', 'cap-key')
            expect(result.success).toBe(false)
            expect(result.error).toMatch(/fail-closed|Invalid/i)
        })

        it('solves via 2captcha grid() with imgType recaptcha', async () => {
            const frame = createFrame({
                evaluateResult: {
                    prompt: 'Select all images with cars',
                    rows: 3,
                    columns: 3,
                },
                tileCount: 9,
            })
            const page = createPage({ frames: [frame] })
            mockGrid.mockResolvedValue({ data: 'click:1/5/9' })

            const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
                handler: TimerHandler,
            ) => {
                if (typeof handler === 'function') queueMicrotask(() => handler())
                return 0 as unknown as ReturnType<typeof setTimeout>
            }) as typeof setTimeout)

            const result = await solver.trySolve(page, '2captcha', '2c-key')

            expect(result.success).toBe(true)
            expect(result.cells).toEqual([0, 4, 8])
            expect(mockGrid).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.any(String),
                    textinstructions: 'Select all images with cars',
                    rows: 3,
                    cols: 3,
                    imgType: 'recaptcha',
                }),
            )

            timerSpy.mockRestore()
        })
    })
})
