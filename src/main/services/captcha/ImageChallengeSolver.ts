import type { Frame, Page } from 'playwright'

/** Remote providers that support image/grid classification. */
export type ImageSolverProvider = '2captcha' | 'capsolver'

/** Snapshot of a visible image/grid CAPTCHA challenge. */
export interface ImageChallengeMeta {
    prompt: string
    rows: number
    columns: number
    /** True when iframe exists but content cannot be accessed safely. */
    crossOriginUnsupported: boolean
    frameUrl: string | null
}

export interface ImageSolveResult {
    success: boolean
    error?: string
    /** 0-based cell indices that were (or would be) clicked. */
    cells?: number[]
    durationMs?: number
}

interface CapSolverClassSolution {
    type?: string
    objects?: number[]
    hasObject?: boolean
    size?: number
}

interface CapSolverCreateResponse {
    errorId?: number
    errorDescription?: string
    errorCode?: string
    status?: string
    solution?: CapSolverClassSolution
    taskId?: string
}

/**
 * CapSolver ReCaptchaV2Classification question IDs (exact API values).
 * @see https://docs.capsolver.com/en/guide/recognition/ReCaptchaClassification/
 */
const CAPSOLVER_QUESTION_MAP: ReadonlyArray<{ keywords: readonly string[]; id: string }> = [
    { keywords: ['taxi', 'taxis'], id: '/m/0pg52' },
    { keywords: ['school bus'], id: '/m/02yvhj' },
    { keywords: ['bus', 'buses'], id: '/m/01bjv' },
    { keywords: ['motorcycle', 'motorcycles'], id: '/m/04_sv' },
    { keywords: ['tractor', 'tractors'], id: '/m/013xlm' },
    { keywords: ['chimney', 'chimneys'], id: '/m/01jk_4' },
    { keywords: ['crosswalk', 'crosswalks', 'zebra'], id: '/m/014xcs' },
    { keywords: ['traffic light', 'traffic lights'], id: '/m/015qff' },
    { keywords: ['bicycle', 'bicycles', 'bike', 'bikes'], id: '/m/0199g' },
    { keywords: ['parking meter', 'parking meters'], id: '/m/015qbp' },
    { keywords: ['car', 'cars', 'vehicle', 'vehicles'], id: '/m/0k4j' },
    { keywords: ['bridge', 'bridges'], id: '/m/015kr' },
    { keywords: ['boat', 'boats'], id: '/m/019jd' },
    { keywords: ['palm tree', 'palm trees', 'palms'], id: '/m/0cdl1' },
    { keywords: ['mountain', 'mountains', 'hill', 'hills'], id: '/m/09d_r' },
    { keywords: ['fire hydrant', 'hydrant', 'hydrants'], id: '/m/01pns0' },
    { keywords: ['stair', 'stairs'], id: '/m/01lynh' },
]

const VALID_GRID_SIZES = new Set([3, 4])

/**
 * Solves reCAPTCHA-style image/grid challenges via CapSolver classification
 * or 2Captcha GridTask. Fail-closed: never clicks unless prompt, grid, and
 * answer indices are all valid.
 */
export class ImageChallengeSolver {
    /**
     * Attempt to solve a visible image/grid challenge on the page.
     * Returns false on any validation failure (fail-closed).
     */
    async trySolve(
        page: Page,
        provider: ImageSolverProvider,
        apiKey: string,
    ): Promise<ImageSolveResult> {
        const start = Date.now()
        if (!apiKey || (provider !== '2captcha' && provider !== 'capsolver')) {
            return { success: false, error: 'No image solver provider/key', durationMs: Date.now() - start }
        }

        const meta = await this.extractChallenge(page)
        if (!meta) {
            return { success: false, error: 'No image challenge detected', durationMs: Date.now() - start }
        }
        if (meta.crossOriginUnsupported) {
            return {
                success: false,
                error: 'Cross-origin challenge unsupported (manual/skip)',
                durationMs: Date.now() - start,
            }
        }
        if (!this.isMetaValid(meta)) {
            return { success: false, error: 'Invalid prompt or grid size', durationMs: Date.now() - start }
        }

        return this.solveAndClick(page, provider, apiKey, meta, start)
    }

    /** Extract prompt + grid size; detect cross-origin inaccessible frames. */
    async extractChallenge(page: Page): Promise<ImageChallengeMeta | null> {
        try {
            const frame = this.findChallengeFrame(page)
            if (!frame) {
                return this.detectOrphanChallengeIframe(page)
            }
            return await this.readMetaFromFrame(frame)
        } catch {
            return null
        }
    }

    /** Map English reCAPTCHA prompt text → CapSolver question id. */
    mapPromptToQuestionId(prompt: string): string | null {
        const lower = prompt.toLowerCase().trim()
        if (!lower) return null
        for (const entry of CAPSOLVER_QUESTION_MAP) {
            if (entry.keywords.some((kw) => lower.includes(kw))) {
                return entry.id
            }
        }
        return null
    }

    /** True when every cell index is an integer inside [0, rows*cols). */
    isValidAnswer(cells: number[], rows: number, columns: number): boolean {
        if (!Array.isArray(cells) || cells.length === 0) return false
        if (!VALID_GRID_SIZES.has(rows) || !VALID_GRID_SIZES.has(columns)) return false
        const max = rows * columns
        const seen = new Set<number>()
        for (const cell of cells) {
            if (!Number.isInteger(cell) || cell < 0 || cell >= max || seen.has(cell)) {
                return false
            }
            seen.add(cell)
        }
        return true
    }

    /** Parse CapSolver solution.objects (0-based) into cell indices. */
    parseCapSolverObjects(objects: unknown): number[] {
        if (!Array.isArray(objects)) return []
        return objects
            .map((v) => (typeof v === 'number' ? v : Number(v)))
            .filter((n) => Number.isInteger(n))
    }

    /**
     * Parse 2Captcha grid answer. Classic grid uses 1-based indices
     * (data: "click:3/6/8" or "3/6/8"); convert to 0-based.
     */
    parse2CaptchaGridData(data: unknown): number[] {
        if (Array.isArray(data)) {
            return data
                .map((v) => (typeof v === 'number' ? v : Number(v)))
                .filter((n) => Number.isInteger(n))
                .map((n) => (n > 0 ? n - 1 : n))
        }
        if (typeof data !== 'string' || !data.trim()) return []
        const cleaned = data.replace(/^click:/i, '').trim()
        if (!cleaned || /^no_matching/i.test(cleaned)) return []
        return cleaned
            .split(/[/,\s]+/)
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
            .map((n) => n - 1)
    }

    // -------------------------------------------------------------------------
    // Private helpers (each ≤ 50 lines)
    // -------------------------------------------------------------------------

    private isMetaValid(meta: ImageChallengeMeta): boolean {
        return (
            !!meta.prompt.trim()
            && VALID_GRID_SIZES.has(meta.rows)
            && VALID_GRID_SIZES.has(meta.columns)
            && !meta.crossOriginUnsupported
        )
    }

    private findChallengeFrame(page: Page): Frame | null {
        const frames = page.frames()
        const match = frames.find((f) => {
            const u = f.url().toLowerCase()
            return (
                (u.includes('recaptcha') && (u.includes('bframe') || u.includes('challenge')))
                || (u.includes('hcaptcha.com') && u.includes('challenge'))
            )
        })
        return match ?? null
    }

    private async detectOrphanChallengeIframe(page: Page): Promise<ImageChallengeMeta | null> {
        const hasIframe = await page
            .evaluate(() => {
                return !!(
                    document.querySelector(
                        'iframe[src*="recaptcha"][src*="bframe"], iframe[title*="recaptcha challenge"]',
                    )
                    || document.querySelector('iframe[src*="hcaptcha.com"][src*="challenge"]')
                )
            })
            .catch(() => false)

        if (!hasIframe) return null
        // Iframe present but Frame API cannot reach content → fail-closed
        return {
            prompt: '',
            rows: 0,
            columns: 0,
            crossOriginUnsupported: true,
            frameUrl: null,
        }
    }

    private async readMetaFromFrame(frame: Frame): Promise<ImageChallengeMeta | null> {
        const data = await frame.evaluate(extractDomChallengeMeta).catch(() => null)
        if (!data) {
            return {
                prompt: '',
                rows: 0,
                columns: 0,
                crossOriginUnsupported: true,
                frameUrl: frame.url(),
            }
        }
        return {
            prompt: data.prompt,
            rows: data.rows,
            columns: data.columns,
            crossOriginUnsupported: false,
            frameUrl: frame.url(),
        }
    }

    private async solveAndClick(
        page: Page,
        provider: ImageSolverProvider,
        apiKey: string,
        meta: ImageChallengeMeta,
        start: number,
    ): Promise<ImageSolveResult> {
        const imageBase64 = await this.captureChallengeImage(page)
        if (!imageBase64) {
            return { success: false, error: 'Failed to capture challenge image', durationMs: Date.now() - start }
        }

        const cells =
            provider === 'capsolver'
                ? await this.solveWithCapSolver(apiKey, imageBase64, meta)
                : await this.solveWith2Captcha(apiKey, imageBase64, meta)

        if (!cells || !this.isValidAnswer(cells, meta.rows, meta.columns)) {
            return {
                success: false,
                error: 'Invalid or empty grid answer (fail-closed)',
                cells: cells ?? undefined,
                durationMs: Date.now() - start,
            }
        }

        const clicked = await this.clickCells(page, cells, meta.rows, meta.columns)
        if (!clicked) {
            return { success: false, error: 'Failed to click grid cells', cells, durationMs: Date.now() - start }
        }

        await this.clickVerify(page)
        return { success: true, cells, durationMs: Date.now() - start }
    }

    private async captureChallengeImage(page: Page): Promise<string | null> {
        const frame = this.findChallengeFrame(page)
        if (!frame) return null
        try {
            const table = frame.locator(
                '#rc-imageselect-target, .rc-imageselect-table, .rc-imageselect-challenge',
            ).first()
            const count = await table.count().catch(() => 0)
            const buf =
                count > 0
                    ? await table.screenshot({ type: 'png' }).catch(() => null)
                    : await frame.locator('body').screenshot({ type: 'png' }).catch(() => null)
            if (!buf) return null
            return buf.toString('base64')
        } catch {
            return null
        }
    }

    /**
     * CapSolver ReCaptchaV2Classification — synchronous createTask response.
     * Task type must be exactly "ReCaptchaV2Classification".
     */
    private async solveWithCapSolver(
        apiKey: string,
        imageBase64: string,
        meta: ImageChallengeMeta,
    ): Promise<number[] | null> {
        const question = this.mapPromptToQuestionId(meta.prompt)
        if (!question) {
            console.log('[ImageChallengeSolver] CapSolver: unmapped prompt, fail-closed')
            return null
        }

        try {
            const response = await fetch('https://api.capsolver.com/createTask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientKey: apiKey,
                    task: {
                        type: 'ReCaptchaV2Classification',
                        image: imageBase64,
                        question,
                    },
                }),
            })

            const data = (await response.json()) as CapSolverCreateResponse
            if (data.errorId && data.errorId !== 0) {
                console.log(
                    `[ImageChallengeSolver] CapSolver error: ${data.errorDescription || data.errorCode}`,
                )
                return null
            }

            // Classification API returns solution synchronously (status ready)
            if (data.status === 'ready' || data.solution) {
                return this.parseCapSolverObjects(data.solution?.objects)
            }
            return null
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            console.error('[ImageChallengeSolver] CapSolver request failed:', message)
            return null
        }
    }

    /** 2Captcha grid() — body + textinstructions + rows/cols + imgType recaptcha. */
    private async solveWith2Captcha(
        apiKey: string,
        imageBase64: string,
        meta: ImageChallengeMeta,
    ): Promise<number[] | null> {
        try {
            const { Solver } = await import('@2captcha/captcha-solver')
            const solver = new Solver(apiKey)
            // Library types mark recaptcha required; runtime grid accepts body + instructions.
            const result = await solver.grid({
                body: imageBase64,
                textinstructions: meta.prompt,
                rows: meta.rows,
                cols: meta.columns,
                imgType: 'recaptcha',
                recaptcha: 1,
            })

            return this.parse2CaptchaGridData(result?.data)
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            console.error('[ImageChallengeSolver] 2Captcha grid failed:', message)
            return null
        }
    }

    private async clickCells(
        page: Page,
        cells: number[],
        rows: number,
        columns: number,
    ): Promise<boolean> {
        if (!this.isValidAnswer(cells, rows, columns)) return false
        const frame = this.findChallengeFrame(page)
        if (!frame) return false

        try {
            const tiles = frame.locator(
                '.rc-imageselect-tile, td.rc-imageselect-tile, .task-image .image',
            )
            const tileCount = await tiles.count()
            if (tileCount < rows * columns) return false

            for (const index of cells) {
                if (index >= tileCount) return false
                await tiles.nth(index).click({ delay: 40 }).catch(() => undefined)
                await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 120)))
            }
            return true
        } catch {
            return false
        }
    }

    private async clickVerify(page: Page): Promise<void> {
        const frame = this.findChallengeFrame(page)
        if (!frame) return
        try {
            const btn = frame.locator('#recaptcha-verify-button, .rc-button-default').first()
            if ((await btn.count()) > 0) {
                await btn.click({ delay: 30 }).catch(() => undefined)
            }
        } catch {
            // ignore verify click failures — caller will re-check widgets
        }
    }
}

/**
 * Runs inside challenge frame via Playwright evaluate — must be self-contained
 * (no outer-scope helpers; body is serialized into the browser).
 */
function extractDomChallengeMeta(): { prompt: string; rows: number; columns: number } {
    const promptEl =
        document.querySelector('.rc-imageselect-desc-text')
        || document.querySelector('.rc-imageselect-desc')
        || document.querySelector('.rc-imageselect-instructions')
        || document.querySelector('[class*="prompt-text"]')
    const prompt = (promptEl?.textContent || '').replace(/\s+/g, ' ').trim()
    const count = document.querySelectorAll(
        '.rc-imageselect-tile, td.rc-imageselect-tile, .task-image .image',
    ).length
    let rows = 0
    let columns = 0
    if (count === 9) {
        rows = 3
        columns = 3
    } else if (count === 16) {
        rows = 4
        columns = 4
    } else if (count > 0) {
        const root = Math.round(Math.sqrt(count))
        if (root * root === count) {
            rows = root
            columns = root
        }
    }
    return { prompt, rows, columns }
}

export const imageChallengeSolver = new ImageChallengeSolver()
