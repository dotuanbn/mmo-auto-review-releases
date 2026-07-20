import type { ElementHandle, Page } from 'playwright'
import { browserService } from './BrowserService'
import { basename, join } from 'path'
import { app } from 'electron'
import { loadSettings } from '../ipc/settings'
import {
    buildManualSubmitMessage,
    getReviewSubmissionDecision,
    requestManualReviewSubmissionApproval,
} from '../services/ComplianceService'
import {
    reviewPhotoService,
    type ReviewPhotoResolveInput,
} from '../services/ReviewPhotoService'
import { redactImagePathForLog } from '../services/ImageManager'

export interface ReviewResult {
    success: boolean
    locationName?: string
    reviewText?: string
    rating?: number
    screenshot?: string
    error?: string
    /** True when at least one photo was attached and verified. */
    photoAttached?: boolean
    /** Non-fatal photo attach note (optional photo failed; review continued). */
    photoWarning?: string
    /**
     * True after Post/Submit was clicked. When true + success=false, treat as
     * unconfirmed (do not re-submit / linear retry the same review).
     */
    submitAttempted?: boolean
}

/** Alias for postReview return contract (controllers may import either name). */
export type PostReviewResult = ReviewResult

export interface SubmitReviewResult {
    success: boolean
    error?: string
    /** True after the Post/Submit control was clicked. */
    submitAttempted?: boolean
}

/**
 * Optional photo attachment for postReview.
 * Backward compatible: omit entirely for legacy 4-arg calls.
 */
export interface PostReviewOptions {
    photoPath?: string
    photoPaths?: readonly string[]
    /** Default 1. Hard-capped by ReviewPhotoService. */
    maxPhotos?: number
    /** Override settings.includePhotos when selecting from library. */
    includePhotos?: boolean
    accountKey?: string
    campaignId?: string
    folderPaths?: readonly string[]
    allowedRoots?: readonly string[]
    /** When true, abort before submit (and after navigation) without posting. */
    shouldAbort?: () => boolean
}

export interface VerifySubmissionResult {
    success: boolean
    error?: string
}

export interface AttachReviewPhotoResult {
    success: boolean
    verified: boolean
    error?: string
    label?: string
}

/** Observable signals gathered before pure verification decision. */
export interface SubmissionVerifySignals {
    hasError: boolean
    errorText?: string
    hasPositiveSuccess: boolean
    formStillOpen: boolean
}

/**
 * Positive UI markers only — form absent alone is never treated as success.
 * Shared by linear + agentic verification paths.
 */
export const SUBMISSION_POSITIVE_SELECTORS = [
    'text="Your review has been posted"',
    'text="Bài đánh giá của bạn đã được đăng"',
    'text="Thanks for your review"',
    'text="Cảm ơn bạn đã đánh giá"',
    'text="Your contribution"',
    'text="Edit your review"',
    'text="Chỉnh sửa đánh giá"',
    'text="Chỉnh sửa đánh giá của bạn"',
    'button[aria-label*="Edit your review" i]',
    'button[aria-label*="Chỉnh sửa đánh giá" i]',
    'a[aria-label*="Edit your review" i]',
    'a[aria-label*="Chỉnh sửa đánh giá" i]',
    '[aria-label*="Your contribution" i]',
    '[aria-label*="Đóng góp của bạn" i]',
] as const

export const SUBMISSION_ERROR_SELECTORS = [
    'text="Something went wrong"',
    'text="Đã xảy ra lỗi"',
    'text="Try again"',
    'text="Thử lại"',
    'text="can\'t post"',
    'text="không thể đăng"',
] as const

/**
 * Pure verification policy:
 * - error → fail
 * - positive toast / edit-your-review / contribution → success
 * - form still open → fail
 * - form absent without positive signal → fail (ambiguous, not success)
 */
export function evaluateSubmissionVerification(
    signals: SubmissionVerifySignals,
): VerifySubmissionResult {
    if (signals.hasError) {
        return {
            success: false,
            error: `Submit error: ${signals.errorText || 'unknown'}`,
        }
    }

    if (signals.hasPositiveSuccess) {
        return { success: true }
    }

    if (signals.formStillOpen) {
        return {
            success: false,
            error: 'Review form still open after submit attempt',
        }
    }

    return {
        success: false,
        error: 'Submission unconfirmed: no positive success signal (form absent is not success)',
    }
}

const FILE_INPUT_SELECTORS = [
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="photo"]',
    'input[type="file"][accept*="image/*"]',
    'form input[type="file"]',
    'div[role="dialog"] input[type="file"]',
    'input[type="file"]',
] as const

const UPLOAD_BUTTON_SELECTORS = [
    'button[aria-label*="Add photo" i]',
    'button[aria-label*="Add photos" i]',
    'button[aria-label*="Thêm ảnh" i]',
    'button[aria-label*="photo" i]',
    'button[aria-label*="ảnh" i]',
    'button:has-text("Add photos")',
    'button:has-text("Add photo")',
    'button:has-text("Thêm ảnh")',
    'button:has-text("Thêm hình")',
    'div[role="button"][aria-label*="photo" i]',
    'div[role="button"][aria-label*="ảnh" i]',
    'span:has-text("Add photos")',
    'span:has-text("Add photo")',
    'span:has-text("Thêm ảnh")',
] as const

export class GoogleMapsReviewHandler {
    private screenshotsPath: string | null = null

    private getScreenshotsPath(): string {
        if (!this.screenshotsPath) {
            this.screenshotsPath = join(app.getPath('userData'), 'screenshots')
        }
        return this.screenshotsPath
    }

    // Navigate to Google Maps location
    async navigateToLocation(
        contextId: number,
        locationUrl: string
    ): Promise<{ success: boolean; error?: string }> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }

        try {
            await page.goto(locationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
            await browserService.randomDelay(2000, 4000)

            // Wait for the place title to appear
            await page.waitForSelector('h1.DUwDvf, h1.fontHeadlineLarge', { timeout: 15000 })

            return { success: true }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to navigate'
            }
        }
    }

    // Get location information
    async getLocationInfo(contextId: number): Promise<{ name: string; address: string; rating?: number }> {
        const page = browserService.getPage(contextId)
        if (!page) throw new Error('No page found')

        const name = await page.$eval('h1.DUwDvf, h1.fontHeadlineLarge', el => el.textContent || '') || 'Unknown'

        let address = ''
        try {
            address = await page.$eval('button[data-item-id="address"] div.fontBodyMedium', el => el.textContent || '')
        } catch {
            address = 'Unknown address'
        }

        let rating: number | undefined
        try {
            const ratingText = await page.$eval('div.F7nice span[aria-hidden="true"]', el => el.textContent || '')
            rating = parseFloat(ratingText.replace(',', '.'))
        } catch {
            rating = undefined
        }

        return { name, address, rating }
    }

    // Click on Write Review button
    async openReviewForm(contextId: number): Promise<{ success: boolean; error?: string }> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }

        try {
            // Scroll down to find review section
            await browserService.humanScroll(page, 'down', 300)
            await browserService.randomDelay(1000, 2000)

            // Look for review button (multiple possible selectors)
            const reviewButtonSelectors = [
                'button[jsaction*="review.start"]',
                'button[data-value="Write a review"]',
                'button:has-text("Write a review")',
                'button:has-text("Viết đánh giá")',
                'span:has-text("Write a review")',
                'span:has-text("Viết đánh giá")',
            ]

            let clicked = false
            for (const selector of reviewButtonSelectors) {
                try {
                    const button = await page.$(selector)
                    if (button) {
                        await button.click()
                        clicked = true
                        break
                    }
                } catch {
                    continue
                }
            }

            if (!clicked) {
                return { success: false, error: 'Could not find review button' }
            }

            await browserService.randomDelay(2000, 3000)

            // Wait for review form to appear
            await page.waitForSelector('div[jsaction*="rate"]', { timeout: 10000 })

            return { success: true }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to open review form'
            }
        }
    }

    // Set star rating
    async setRating(contextId: number, stars: number): Promise<{ success: boolean; error?: string }> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }

        try {
            // Try different methods to select stars
            let success = false

            // Method 1: Click nth star button
            try {
                const starButtons = await page.$$('div[jsaction*="rate"] button, span[aria-label*="star"]')
                if (starButtons.length >= stars) {
                    await starButtons[stars - 1].click()
                    success = true
                }
            } catch {
                // Try method 2
            }

            if (!success) {
                // Method 2: Use aria-label
                const ariaSelector = `span[aria-label*="${stars} star"], button[aria-label*="${stars} star"], button[aria-label*="${stars} sao"]`
                const starEl = await page.$(ariaSelector)
                if (starEl) {
                    await starEl.click()
                    success = true
                }
            }

            if (!success) {
                // Method 3: data-rating / nth-child composite selector
                const starSelector = `div[jsaction*="rate"] button:nth-child(${stars}), div[data-rating="${stars}"]`
                const starEl = await page.$(starSelector)
                if (starEl) {
                    await starEl.click()
                    success = true
                }
            }

            if (!success) {
                return { success: false, error: 'Could not set rating' }
            }

            await browserService.randomDelay(500, 1000)
            return { success: true }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to set rating'
            }
        }
    }

    // Write review text
    async writeReview(contextId: number, reviewText: string): Promise<{ success: boolean; error?: string }> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }

        try {
            // Find review textarea
            const textareaSelectors = [
                'textarea[aria-label*="review"]',
                'textarea[aria-label*="đánh giá"]',
                'textarea.review-input',
                'div[contenteditable="true"]',
                'textarea',
            ]

            let found = false
            for (const selector of textareaSelectors) {
                try {
                    const textarea = await page.$(selector)
                    if (textarea) {
                        await textarea.click()
                        await browserService.randomDelay(300, 500)

                        // Type review with human-like delays
                        for (const char of reviewText) {
                            await page.keyboard.type(char)
                            await browserService.randomDelay(20, 80)
                        }

                        found = true
                        break
                    }
                } catch {
                    continue
                }
            }

            if (!found) {
                return { success: false, error: 'Could not find review text area' }
            }

            await browserService.randomDelay(1000, 2000)
            return { success: true }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to write review'
            }
        }
    }

    /**
     * Defensively locate a file input suitable for review photo upload.
     */
    private async findFileInput(page: Page): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
        for (const selector of FILE_INPUT_SELECTORS) {
            try {
                const handles = await page.$$(selector)
                for (const handle of handles) {
                    const isVisible = await handle.isVisible().catch(() => false)
                    // Hidden file inputs are normal; prefer first matching accept/image when possible
                    const accept = await handle.getAttribute('accept').catch(() => null)
                    if (accept && /image|photo|\*/i.test(accept)) {
                        return handle
                    }
                    if (!accept || isVisible) {
                        return handle
                    }
                }
                if (handles.length > 0) {
                    return handles[0]
                }
            } catch {
                continue
            }
        }
        return null
    }

    /**
     * Try to reveal a file input by clicking common "Add photo" controls.
     */
    private async tryRevealUploadControl(page: Page): Promise<void> {
        for (const selector of UPLOAD_BUTTON_SELECTORS) {
            try {
                const btn = await page.$(selector)
                if (!btn) continue
                const visible = await btn.isVisible().catch(() => false)
                if (!visible) continue
                await btn.click({ timeout: 2000 }).catch(async () => {
                    await btn.click({ force: true }).catch(() => undefined)
                })
                await browserService.randomDelay(400, 900)
                return
            } catch {
                continue
            }
        }
    }

    /**
     * Verify upload succeeded via thumbnail / filename / input.files heuristics.
     */
    private async verifyPhotoAttached(page: Page, filePath: string): Promise<boolean> {
        const fileName = basename(filePath)
        const nameStem = fileName.replace(/\.[^.]+$/, '')

        // 1) input.files length
        try {
            const count = await page.$$eval('input[type="file"]', (inputs) =>
                inputs.reduce((sum, el) => {
                    const input = el as HTMLInputElement
                    return sum + (input.files?.length ?? 0)
                }, 0),
            )
            if (count > 0) return true
        } catch {
            // continue other checks
        }

        // 2) filename / stem visible in dialog
        if (fileName.length >= 3) {
            try {
                const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                const byName = page.locator(`text=/${escaped}/i`).first()
                if (await byName.isVisible({ timeout: 1500 }).catch(() => false)) {
                    return true
                }
            } catch {
                // ignore
            }
        }
        if (nameStem.length >= 3) {
            try {
                const escaped = nameStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                const byStem = page.locator(`text=/${escaped}/i`).first()
                if (await byStem.isVisible({ timeout: 800 }).catch(() => false)) {
                    return true
                }
            } catch {
                // ignore
            }
        }

        // 3) thumbnail / preview image near review form
        const thumbSelectors = [
            'div[role="dialog"] img[src*="blob:"]',
            'div[role="dialog"] img[src*="googleusercontent"]',
            'div[role="dialog"] img[src^="data:image"]',
            'form img[src*="blob:"]',
            'img[alt*="photo" i]',
            'img[alt*="ảnh" i]',
            'button img[src]',
            '[data-photo-id] img',
            'div[jsaction*="photo"] img',
        ]
        for (const selector of thumbSelectors) {
            try {
                const el = page.locator(selector).first()
                if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
                    return true
                }
            } catch {
                continue
            }
        }

        return false
    }

    /**
     * Optional review photo upload. Failures are non-fatal for the review flow
     * (caller logs warning and continues). Does not throw.
     */
    async attachReviewPhoto(
        contextId: number,
        photoPath: string,
    ): Promise<AttachReviewPhotoResult> {
        const label = redactImagePathForLog(photoPath)
        const page = browserService.getPage(contextId)
        if (!page) {
            return { success: false, verified: false, error: 'No page found', label }
        }

        try {
            let fileInput = await this.findFileInput(page)

            if (!fileInput) {
                // Click Add photo button, prefer filechooser event
                let chooserHandled = false
                try {
                    const [fileChooser] = await Promise.all([
                        page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null),
                        this.tryRevealUploadControl(page),
                    ])
                    if (fileChooser) {
                        await fileChooser.setFiles(photoPath)
                        chooserHandled = true
                    }
                } catch (err) {
                    console.warn(
                        `[ReviewPhoto] filechooser path failed for ${label}:`,
                        err instanceof Error ? err.message : 'unknown',
                    )
                }

                if (chooserHandled) {
                    await browserService.randomDelay(1200, 2200)
                    const verified = await this.verifyPhotoAttached(page, photoPath)
                    if (!verified) {
                        return {
                            success: false,
                            verified: false,
                            error: 'Upload completed but thumbnail/filename not verified',
                            label,
                        }
                    }
                    return { success: true, verified: true, label }
                }

                fileInput = await this.findFileInput(page)
            }

            if (!fileInput) {
                // Last attempt: click upload control then re-scan input
                await this.tryRevealUploadControl(page)
                fileInput = await this.findFileInput(page)
            }

            if (!fileInput) {
                return {
                    success: false,
                    verified: false,
                    error: 'Could not find photo upload input or button',
                    label,
                }
            }

            await fileInput.setInputFiles(photoPath)
            await browserService.randomDelay(1200, 2200)

            const verified = await this.verifyPhotoAttached(page, photoPath)
            if (!verified) {
                return {
                    success: false,
                    verified: false,
                    error: 'Files set but thumbnail/filename not verified',
                    label,
                }
            }

            return { success: true, verified: true, label }
        } catch (error) {
            return {
                success: false,
                verified: false,
                error: error instanceof Error ? error.message : 'Failed to attach photo',
                label,
            }
        }
    }

    /**
     * Resolve + attach optional photos. Never fails the review — returns warning string.
     */
    private async tryAttachOptionalPhotos(
        contextId: number,
        options?: PostReviewOptions,
    ): Promise<{ attached: boolean; warning?: string }> {
        const resolveInput: ReviewPhotoResolveInput = {
            photoPath: options?.photoPath,
            photoPaths: options?.photoPaths,
            maxPhotos: options?.maxPhotos ?? 1,
            includePhotos: options?.includePhotos,
            accountKey: options?.accountKey,
            campaignId: options?.campaignId,
            folderPaths: options?.folderPaths,
            allowedRoots: options?.allowedRoots,
        }

        // When options omitted entirely, still honor settings.includePhotos via service
        const resolved = reviewPhotoService.resolvePhotos(resolveInput)
        if (resolved.paths.length === 0) {
            // Silent skip when disabled / no photos — not a warning
            if (resolved.reason && resolved.reason !== 'includePhotos disabled') {
                // Only warn when caller expected photos (explicit invalid) or library empty while enabled
                if (resolved.reason.startsWith('explicit') || resolved.reason.includes('no valid') || resolved.reason.includes('no image')) {
                    console.warn(`[ReviewPhoto] skipped: ${resolved.reason}`)
                    return { attached: false, warning: resolved.reason }
                }
            }
            return { attached: false }
        }

        let attachedCount = 0
        const failures: string[] = []

        for (const photoPath of resolved.paths) {
            const label = redactImagePathForLog(photoPath)
            const result = await this.attachReviewPhoto(contextId, photoPath)
            if (result.success && result.verified) {
                attachedCount++
                console.info(`[ReviewPhoto] attached ${label} (${resolved.source})`)
            } else {
                const msg = result.error || 'attach failed'
                failures.push(`${label}: ${msg}`)
                console.warn(`[ReviewPhoto] optional attach failed for ${label}: ${msg}`)
            }
        }

        if (attachedCount > 0 && failures.length === 0) {
            return { attached: true }
        }
        if (attachedCount > 0 && failures.length > 0) {
            return {
                attached: true,
                warning: `partial attach (${attachedCount} ok): ${failures.join('; ')}`,
            }
        }
        return {
            attached: false,
            warning: `optional photo failed (review continues): ${failures.join('; ') || 'unknown'}`,
        }
    }

    private isAborted(options?: PostReviewOptions): boolean {
        try {
            return options?.shouldAbort?.() === true
        } catch {
            return false
        }
    }

    /**
     * Verify review submission via positive UI signals only.
     * Form absent alone is NOT success (ambiguous → false).
     * Shared by linear postReview and AgenticReview finish/submit paths.
     */
    async verifyReviewSubmitted(page: Page): Promise<VerifySubmissionResult> {
        try {
            let hasError = false
            let errorText: string | undefined

            for (const selector of SUBMISSION_ERROR_SELECTORS) {
                try {
                    const errorEl = await page.$(selector)
                    if (errorEl) {
                        hasError = true
                        errorText = (await errorEl.textContent()) || undefined
                        break
                    }
                } catch {
                    // continue
                }
            }

            let hasPositiveSuccess = false
            for (const selector of SUBMISSION_POSITIVE_SELECTORS) {
                try {
                    const successEl = await page.$(selector)
                    if (successEl) {
                        hasPositiveSuccess = true
                        break
                    }
                } catch {
                    // continue
                }
            }

            // Deterministic submitted state: contributions URL after post.
            if (!hasPositiveSuccess) {
                try {
                    const url = page.url()
                    if (/\/contrib\//i.test(url) || /contribution/i.test(url)) {
                        hasPositiveSuccess = true
                    }
                } catch {
                    // ignore url probe errors
                }
            }

            const formStillOpen = !!(await page.$(
                'textarea[aria-label*="review"], textarea[aria-label*="đánh giá"], div[jsaction*="rate"]',
            ).catch(() => null))

            return evaluateSubmissionVerification({
                hasError,
                errorText,
                hasPositiveSuccess,
                formStillOpen,
            })
        } catch (error) {
            return {
                success: false,
                error: `Verification error: ${error instanceof Error ? error.message : 'Unknown'}`,
            }
        }
    }

    async verifyReviewSubmittedByContext(contextId: number): Promise<VerifySubmissionResult> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }
        return this.verifyReviewSubmitted(page)
    }

    // Submit the review
    async submitReview(
        contextId: number,
        options?: Pick<PostReviewOptions, 'shouldAbort'>,
    ): Promise<SubmitReviewResult> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found', submitAttempted: false }

        let submitAttempted = false

        try {
            if (this.isAborted(options)) {
                return { success: false, error: 'Aborted before submit', submitAttempted: false }
            }

            const settings = loadSettings()
            const currentUrl = page.url()
            const decision = getReviewSubmissionDecision(currentUrl, settings)
            if (!decision.allowed) {
                const manualMessage = buildManualSubmitMessage(currentUrl, settings)
                const manualResult = await requestManualReviewSubmissionApproval({
                    locationUrl: currentUrl,
                    reason: decision.reason,
                })
                if (!manualResult.approved) {
                    return {
                        success: false,
                        error: `${manualMessage} (reason: ${manualResult.reason})`,
                        submitAttempted: false,
                    }
                }
            }

            // Re-check abort after possible manual-approval wait
            if (this.isAborted(options)) {
                return { success: false, error: 'Aborted before submit', submitAttempted: false }
            }

            // Find and click submit/post button
            const submitSelectors = [
                'button[jsaction*="submit"]',
                'button[aria-label*="Post"]',
                'button[aria-label*="Đăng"]',
                'button:has-text("Post")',
                'button:has-text("Đăng")',
                'button:has-text("Submit")',
                'button:has-text("Gửi")',
            ]

            let clicked = false
            for (const selector of submitSelectors) {
                try {
                    const button = await page.$(selector)
                    if (button) {
                        const rawLabel = [
                            await button.getAttribute('aria-label'),
                            await button.textContent(),
                        ].filter((value): value is string => typeof value === 'string').join(' ')
                        const normalizedLabel = rawLabel
                            .normalize('NFD')
                            .replace(/[\u0300-\u036f]/g, '')
                            .replace(/đ/gi, 'd')
                            .trim()
                            .toLowerCase()
                        const exactSubmitLabel = /^(post|submit|publish|dang|gui|hoan tat|xac nhan)$/
                            .test(normalizedLabel)
                        const semanticSubmitSelector = selector.includes('jsaction*="submit"')
                        if (!semanticSubmitSelector && !exactSubmitLabel) {
                            continue
                        }
                        // Mark immediately before click to surface unconfirmed state if verify fails.
                        submitAttempted = true
                        await button.click()
                        clicked = true
                        break
                    }
                } catch {
                    continue
                }
            }

            if (!clicked) {
                return { success: false, error: 'Could not find submit button', submitAttempted: false }
            }

            // Wait for submission to complete, then require positive verification.
            await browserService.randomDelay(3000, 5000)

            const verification = await this.verifyReviewSubmitted(page)
            if (!verification.success) {
                return {
                    success: false,
                    error: verification.error || 'Submit verification failed',
                    submitAttempted: true,
                }
            }

            return { success: true, submitAttempted: true }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to submit review',
                submitAttempted,
            }
        }
    }

    /**
     * Complete review process.
     * Signature remains backward compatible: 4 required args; optional 5th options bag.
     *
     * submitAttempted is tracked outside submitReview so outer catch / final result
     * always propagate the flag (never undefined after a Post/Submit click).
     */
    async postReview(
        contextId: number,
        locationUrl: string,
        rating: number,
        reviewText: string,
        options?: PostReviewOptions,
    ): Promise<ReviewResult> {
        /** Outside submitReview so throws after click still surface the flag. */
        let submitAttempted = false

        try {
            if (this.isAborted(options)) {
                return { success: false, error: 'Aborted before review', submitAttempted: false }
            }

            // Step 1: Navigate to location
            const navResult = await this.navigateToLocation(contextId, locationUrl)
            if (!navResult.success) {
                return { success: false, error: navResult.error, submitAttempted: false }
            }

            if (this.isAborted(options)) {
                return { success: false, error: 'Aborted after navigation', submitAttempted: false }
            }

            // Get location info
            const locationInfo = await this.getLocationInfo(contextId)

            // Step 2: Open review form
            const openResult = await this.openReviewForm(contextId)
            if (!openResult.success) {
                return {
                    success: false,
                    error: openResult.error,
                    locationName: locationInfo.name,
                    submitAttempted: false,
                }
            }

            if (this.isAborted(options)) {
                return {
                    success: false,
                    error: 'Aborted before submit',
                    locationName: locationInfo.name,
                    submitAttempted: false,
                }
            }

            // Step 3: Set rating
            const ratingResult = await this.setRating(contextId, rating)
            if (!ratingResult.success) {
                return {
                    success: false,
                    error: ratingResult.error,
                    locationName: locationInfo.name,
                    submitAttempted: false,
                }
            }

            // Step 4: Write review
            const writeResult = await this.writeReview(contextId, reviewText)
            if (!writeResult.success) {
                return {
                    success: false,
                    error: writeResult.error,
                    locationName: locationInfo.name,
                    submitAttempted: false,
                }
            }

            // Step 4b: Optional photo (max 1 by default). Failure → warning only, continue.
            const photoOutcome = await this.tryAttachOptionalPhotos(contextId, options)

            // Step 5: Take screenshot before submit
            const timestamp = Date.now()
            const screenshotPath = join(this.getScreenshotsPath(), `review_${timestamp}.png`)
            await browserService.takeScreenshot(contextId, screenshotPath)

            if (this.isAborted(options)) {
                return {
                    success: false,
                    error: 'Aborted before submit',
                    locationName: locationInfo.name,
                    screenshot: screenshotPath,
                    photoAttached: photoOutcome.attached,
                    photoWarning: photoOutcome.warning,
                    submitAttempted: false,
                }
            }

            // Step 6: Submit review — failures are NOT swallowed; verifies submission
            const submitResult = await this.submitReview(contextId, options)
            // Lift flag immediately so any subsequent throw still reports attempt.
            if (submitResult.submitAttempted === true) {
                submitAttempted = true
            }

            if (!submitResult.success) {
                return {
                    success: false,
                    error: submitResult.error,
                    locationName: locationInfo.name,
                    screenshot: screenshotPath,
                    photoAttached: photoOutcome.attached,
                    photoWarning: photoOutcome.warning,
                    submitAttempted,
                }
            }

            return {
                success: true,
                locationName: locationInfo.name,
                reviewText,
                rating,
                screenshot: screenshotPath,
                photoAttached: photoOutcome.attached,
                photoWarning: photoOutcome.warning,
                submitAttempted,
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during review',
                // Always propagate — never leave undefined after a post click path.
                submitAttempted,
            }
        }
    }
}

export const googleMapsReviewHandler = new GoogleMapsReviewHandler()
