/**
 * ReviewVerificationWorker — background check that posted reviews are still on Google Maps.
 *
 * Opt-in via settings (enableReviewVerification). The IPC layer gates start(); this
 * loop itself is crash-safe: overlapping ticks are skipped, one browser session runs
 * at a time, and every context is closed before the next review.
 */

import type { Locator, Page } from 'playwright'
import { browserService } from '../automation/BrowserService'
import type { ReviewVerificationQueueItem } from '../../shared/review-history-contracts'
import { reviewVerificationService } from './ReviewVerificationService'

const TICK_INTERVAL_MS = 30 * 60 * 1000
const STARTUP_DELAY_MS = 60_000
const MAX_CHECKS_PER_TICK = 10
const DELAY_BETWEEN_CHECKS_MS = 15_000
const PAGE_LOAD_TIMEOUT_MS = 30_000
const REVIEW_TEXT_SNIPPET_LENGTH = 40
const PRIMARY_REVIEW_SELECTOR = '.review-full-text, [data-review-id], .MyEned'
const FALLBACK_REVIEW_SELECTOR = '[class*=review] span, [class*=comment] span'

type VerificationStatus = 'live' | 'removed' | 'unknown'

interface ReviewObservation {
    status: VerificationStatus
    googleReviewId?: string
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export class ReviewVerificationWorker {
    private timer: ReturnType<typeof setInterval> | null = null
    private startupTimer: ReturnType<typeof setTimeout> | null = null
    private enabled = false
    /** Prevents overlapping ticks if a scan outlives the interval. */
    private ticking = false
    /** Prevents concurrent browser sessions if processQueue is entered twice. */
    private processing = false

    start(): void {
        if (this.enabled) return
        this.enabled = true
        this.timer = setInterval(() => {
            void this.tick()
        }, TICK_INTERVAL_MS)
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null
            void this.tick()
        }, STARTUP_DELAY_MS)
        console.log('[ReviewVerifier] Started')
    }

    stop(): void {
        if (!this.enabled && !this.timer && !this.startupTimer) return
        this.enabled = false
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        if (this.startupTimer) {
            clearTimeout(this.startupTimer)
            this.startupTimer = null
        }
        console.log('[ReviewVerifier] Stopped')
    }

    isRunning(): boolean {
        return this.enabled
    }

    /**
     * One queue pass. Public so tests can drive the loop without waiting on timers.
     */
    async tick(): Promise<void> {
        if (!this.enabled || this.ticking) return
        this.ticking = true
        try {
            await this.processQueue()
        } catch (error: unknown) {
            console.error(`[ReviewVerifier] tick failed: ${errorMessage(error)}`)
        } finally {
            this.ticking = false
        }
    }

    /**
     * Drain up to MAX_CHECKS_PER_TICK due reviews. Stops between items when disabled.
     */
    async processQueue(): Promise<void> {
        if (this.processing) return
        this.processing = true
        try {
            let items: ReviewVerificationQueueItem[] = []
            try {
                const queued = reviewVerificationService.getVerificationQueue(MAX_CHECKS_PER_TICK)
                items = Array.isArray(queued) ? queued : []
            } catch (error: unknown) {
                console.error(`[ReviewVerifier] queue read failed: ${errorMessage(error)}`)
                return
            }

            if (items.length === 0) {
                console.log('[ReviewVerifier] Verification queue empty')
                return
            }

            for (let index = 0; index < items.length; index += 1) {
                if (!this.enabled) break
                const item = items[index]
                if (!item) continue
                try {
                    await this.checkSingleReview(item)
                } catch (error: unknown) {
                    console.error(
                        `[ReviewVerifier] item failed historyId=${item.historyId}: ${errorMessage(error)}`,
                    )
                }
                const hasNext = index < items.length - 1
                if (!this.enabled || !hasNext) break
                await this.waitBetweenChecks()
            }
        } finally {
            this.processing = false
        }
    }

    /**
     * Open a headless context, look for the review text, persist the outcome, and close.
     */
    async checkSingleReview(item: ReviewVerificationQueueItem): Promise<void> {
        let contextId: number | undefined
        let recorded = false

        const record = (observation: ReviewObservation): void => {
            if (recorded) return
            recorded = true
            try {
                reviewVerificationService.recordVerificationResult({
                    historyId: item.historyId,
                    status: observation.status,
                    googleReviewId: observation.googleReviewId,
                    checkedAt: new Date(),
                })
                console.log(
                    `[ReviewVerifier] historyId=${item.historyId} location=${item.locationName} status=${observation.status}`,
                )
            } catch (error: unknown) {
                console.error(
                    `[ReviewVerifier] record failed historyId=${item.historyId}: ${errorMessage(error)}`,
                )
            }
        }

        try {
            contextId = await browserService.createContext({
                headless: true,
                cleanProfileOnStart: true,
            })
            const page = browserService.getPage(contextId)
            const observation = page
                ? await this.observeReview(page, item)
                : { status: 'unknown' as const }
            record(observation)
        } catch (error: unknown) {
            console.error(
                `[ReviewVerifier] historyId=${item.historyId} error: ${errorMessage(error)}`,
            )
            if (contextId !== undefined) {
                record({ status: 'unknown' })
            }
        } finally {
            if (contextId !== undefined) {
                try {
                    await browserService.closeContext(contextId)
                } catch (error: unknown) {
                    console.error(
                        `[ReviewVerifier] closeContext failed contextId=${contextId}: ${errorMessage(error)}`,
                    )
                }
            }
        }
    }

    private async observeReview(page: Page, item: ReviewVerificationQueueItem): Promise<ReviewObservation> {
        try {
            // Maps keeps long-lived requests open, so networkidle often hits the timeout.
            await page.goto(item.locationUrl, {
                waitUntil: 'domcontentloaded',
                timeout: PAGE_LOAD_TIMEOUT_MS,
            })
            return await this.matchReview(page, item.reviewText)
        } catch (error: unknown) {
            console.error(
                `[ReviewVerifier] navigation failed historyId=${item.historyId}: ${errorMessage(error)}`,
            )
            return { status: 'unknown' }
        }
    }

    private async matchReview(page: Page, reviewText: string): Promise<ReviewObservation> {
        const snippet = reviewText.slice(0, REVIEW_TEXT_SNIPPET_LENGTH).trim()
        if (!snippet) {
            return { status: 'unknown' }
        }

        const primary = page.locator(PRIMARY_REVIEW_SELECTOR).filter({ hasText: snippet })
        if (await primary.count() > 0) {
            return { status: 'live', googleReviewId: await this.readReviewId(primary) }
        }

        const fallback = page.locator(FALLBACK_REVIEW_SELECTOR).filter({ hasText: snippet })
        if (await fallback.count() > 0) {
            return { status: 'live', googleReviewId: await this.readReviewId(fallback) }
        }

        return { status: 'removed' }
    }

    private async readReviewId(locator: Locator): Promise<string | undefined> {
        try {
            const value = await locator.first().getAttribute('data-review-id')
            if (!value) return undefined
            const trimmed = value.trim()
            return trimmed.length > 0 ? trimmed : undefined
        } catch (error: unknown) {
            console.error(`[ReviewVerifier] review id read failed: ${errorMessage(error)}`)
            return undefined
        }
    }

    private waitBetweenChecks(): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, DELAY_BETWEEN_CHECKS_MS)
        })
    }
}

export const reviewVerificationWorker = new ReviewVerificationWorker()
