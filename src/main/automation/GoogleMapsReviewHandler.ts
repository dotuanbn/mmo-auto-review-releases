import { Page } from 'playwright'
import { browserService } from './BrowserService'
import { join } from 'path'
import { app } from 'electron'
import { loadSettings } from '../ipc/settings'
import {
    buildManualSubmitMessage,
    getReviewSubmissionDecision,
    requestManualReviewSubmissionApproval,
} from '../services/ComplianceService'

export interface ReviewResult {
    success: boolean
    locationName?: string
    reviewText?: string
    rating?: number
    screenshot?: string
    error?: string
}

export class GoogleMapsReviewHandler {
    private screenshotsPath: string

    constructor() {
        this.screenshotsPath = join(app.getPath('userData'), 'screenshots')
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
            // Star rating buttons (1-5)
            const starSelector = `div[jsaction*="rate"] button:nth-child(${stars}), div[data-rating="${stars}"]`

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

    // Submit the review
    async submitReview(contextId: number): Promise<{ success: boolean; error?: string }> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }

        try {
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
                    }
                }
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
                        await button.click()
                        clicked = true
                        break
                    }
                } catch {
                    continue
                }
            }

            if (!clicked) {
                return { success: false, error: 'Could not find submit button' }
            }

            // Wait for submission to complete
            await browserService.randomDelay(3000, 5000)

            // Check for success indicators
            // (The review form should close or show confirmation)

            return { success: true }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to submit review'
            }
        }
    }

    // Complete review process
    async postReview(
        contextId: number,
        locationUrl: string,
        rating: number,
        reviewText: string
    ): Promise<ReviewResult> {
        try {
            // Step 1: Navigate to location
            const navResult = await this.navigateToLocation(contextId, locationUrl)
            if (!navResult.success) {
                return { success: false, error: navResult.error }
            }

            // Get location info
            const locationInfo = await this.getLocationInfo(contextId)

            // Step 2: Open review form
            const openResult = await this.openReviewForm(contextId)
            if (!openResult.success) {
                return { success: false, error: openResult.error, locationName: locationInfo.name }
            }

            // Step 3: Set rating
            const ratingResult = await this.setRating(contextId, rating)
            if (!ratingResult.success) {
                return { success: false, error: ratingResult.error, locationName: locationInfo.name }
            }

            // Step 4: Write review
            const writeResult = await this.writeReview(contextId, reviewText)
            if (!writeResult.success) {
                return { success: false, error: writeResult.error, locationName: locationInfo.name }
            }

            // Step 5: Take screenshot before submit
            const timestamp = Date.now()
            const screenshotPath = join(this.screenshotsPath, `review_${timestamp}.png`)
            await browserService.takeScreenshot(contextId, screenshotPath)

            // Step 6: Submit review
            const submitResult = await this.submitReview(contextId)
            if (!submitResult.success) {
                return {
                    success: false,
                    error: submitResult.error,
                    locationName: locationInfo.name,
                    screenshot: screenshotPath
                }
            }

            return {
                success: true,
                locationName: locationInfo.name,
                reviewText,
                rating,
                screenshot: screenshotPath,
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during review',
            }
        }
    }
}

export const googleMapsReviewHandler = new GoogleMapsReviewHandler()
