/**
 * HelpfulVoteWorker — slow background pass that marks another account's live review as Helpful.
 *
 * One headless context at a time. Overlapping ticks are skipped. Every context is closed
 * before the next vote, including when navigation or the click fails. Not started automatically;
 * call start() from the same place as the other schedulers when the feature is wired in.
 */

import type { Locator, Page } from 'playwright'
import type { HelpfulVoteCandidate, HelpfulVoteRecord, HelpfulVoteStatus } from '../../shared/helpful-vote-contracts'
import { browserService } from '../automation/BrowserService'
import { helpfulVoteService } from './HelpfulVoteService'

const PAGE_LOAD_TIMEOUT_MS = 30_000
const REVIEW_TEXT_SNIPPET_LENGTH = 40
/** Midpoint of the 2–3s settle window after the Helpful click. */
const POST_CLICK_WAIT_MS = 2_500
const PRIMARY_REVIEW_SELECTOR = '[class*="review"] span, .review-full-text'
const FALLBACK_REVIEW_SELECTOR = '.MyEned, [data-review-id]'
const HELPFUL_LABEL_SELECTOR = 'button[aria-label*="elpful"], button[aria-label*="seful"], [data-tooltip*="elpful"]'
const HELPFUL_TEXT_PATTERN = /helpful|useful|hữu ích/i

interface VoteAttemptOutcome {
    success: boolean
    errorMessage?: string
}

interface VoterAccount {
    accountId: number
    email: string
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function attemptStatus(success: boolean, errorMessage?: string): HelpfulVoteStatus {
    if (success) return 'voted'
    if (errorMessage?.startsWith('skipped')) return 'skipped'
    return 'failed'
}

export class HelpfulVoteWorker {
    static readonly TICK_INTERVAL_MS = 60 * 60 * 1000
    static readonly STARTUP_DELAY_MS = 5 * 60 * 1000
    static readonly MAX_VOTES_PER_TICK = 5
    static readonly DELAY_BETWEEN_VOTES_MS = 30_000

    private timer: ReturnType<typeof setInterval> | null = null
    private startupTimer: ReturnType<typeof setTimeout> | null = null
    private enabled = false
    /** Prevents overlapping ticks if a pass outlives the interval. */
    private ticking = false
    /** Prevents a second queue pass from opening another browser. */
    private processing = false

    start(): void {
        if (this.enabled) return
        this.enabled = true
        this.timer = setInterval(() => {
            void this.tick()
        }, HelpfulVoteWorker.TICK_INTERVAL_MS)
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null
            void this.tick()
        }, HelpfulVoteWorker.STARTUP_DELAY_MS)
        console.log('[HelpfulVote] Started')
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
        console.log('[HelpfulVote] Stopped')
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
            await this.processVoteQueue()
        } catch (error: unknown) {
            console.error(`[HelpfulVote] tick failed: ${toErrorMessage(error)}`)
        } finally {
            this.ticking = false
        }
    }

    /**
     * Cast up to MAX_VOTES_PER_TICK helpful votes. Stops between items when disabled.
     * The 30s gap is between votes, not after a skip that never opened a browser.
     */
    async processVoteQueue(): Promise<void> {
        if (this.processing) return
        this.processing = true
        try {
            let candidates: HelpfulVoteCandidate[] = []
            try {
                const queued = helpfulVoteService.getVoteCandidates(HelpfulVoteWorker.MAX_VOTES_PER_TICK)
                candidates = Array.isArray(queued) ? queued : []
            } catch (error: unknown) {
                console.error(`[HelpfulVote] queue read failed: ${toErrorMessage(error)}`)
                return
            }

            if (candidates.length === 0) {
                console.log('[HelpfulVote] Vote queue empty')
                return
            }

            for (let index = 0; index < candidates.length; index += 1) {
                if (!this.enabled) break
                const candidate = candidates[index]
                if (!candidate) continue

                let voted = false
                try {
                    const voter = helpfulVoteService.pickVoterAccount(
                        candidate.reviewAccountId,
                        candidate.locationId,
                    )
                    if (!voter) {
                        console.log(
                            `[HelpfulVote] no eligible voter historyId=${candidate.historyId} reviewAccountId=${candidate.reviewAccountId}`,
                        )
                        continue
                    }
                    await this.castVote(candidate, voter)
                    voted = true
                } catch (error: unknown) {
                    console.error(
                        `[HelpfulVote] item failed historyId=${candidate.historyId}: ${toErrorMessage(error)}`,
                    )
                }

                const hasNext = index < candidates.length - 1
                if (!this.enabled || !hasNext) break
                // A missed voter or a thrown attempt must not insert a 30s gap or stop the pass.
                if (!voted) continue
                await this.pause(HelpfulVoteWorker.DELAY_BETWEEN_VOTES_MS)
            }
        } finally {
            this.processing = false
        }
    }

    /**
     * Open a headless context, click Helpful on this review, record the outcome, and close.
     * The context is closed in finally even when navigation, the locator, or the click throws.
     */
    async castVote(candidate: HelpfulVoteCandidate, voter: VoterAccount): Promise<void> {
        let contextId: number | undefined
        try {
            contextId = await browserService.createContext({
                shouldAbort: () => this.processing && !this.enabled,
                headless: true,
                cleanProfileOnStart: true,
            })
            const page = browserService.getPage(contextId)
            if (!page) {
                this.recordOutcome(candidate, voter, false, 'Browser page unavailable')
                return
            }
            const outcome = await this.voteOnPage(page, candidate)
            this.recordOutcome(candidate, voter, outcome.success, outcome.errorMessage)
        } catch (error: unknown) {
            console.error(
                `[HelpfulVote] historyId=${candidate.historyId} error: ${toErrorMessage(error)}`,
            )
            this.recordOutcome(candidate, voter, false, toErrorMessage(error))
        } finally {
            if (contextId !== undefined) {
                try {
                    await browserService.closeContext(contextId)
                } catch (error: unknown) {
                    console.error(
                        `[HelpfulVote] closeContext failed contextId=${contextId}: ${toErrorMessage(error)}`,
                    )
                }
            }
        }
    }

    private async voteOnPage(page: Page, candidate: HelpfulVoteCandidate): Promise<VoteAttemptOutcome> {
        await page.goto(candidate.locationUrl, {
            waitUntil: 'domcontentloaded',
            timeout: PAGE_LOAD_TIMEOUT_MS,
        })

        const reviewElement = await this.findReview(page, candidate.reviewText)
        if (!reviewElement) {
            return { success: false, errorMessage: 'skipped: review not found' }
        }

        const button = await this.findHelpfulButton(reviewElement)
        if (!button) {
            return { success: false, errorMessage: 'skipped: helpful button not found' }
        }

        await button.click()
        await this.pause(POST_CLICK_WAIT_MS)
        return { success: true }
    }

    private async findReview(page: Page, reviewText: string): Promise<Locator | null> {
        const snippet = reviewText.slice(0, REVIEW_TEXT_SNIPPET_LENGTH)
        if (snippet.trim().length === 0) return null

        const primary = page.locator(PRIMARY_REVIEW_SELECTOR).filter({ hasText: snippet })
        if (await primary.count() > 0) return primary.first()

        const fallback = page.locator(FALLBACK_REVIEW_SELECTOR).filter({ hasText: snippet })
        if (await fallback.count() > 0) return fallback.first()

        return null
    }

    private async findHelpfulButton(reviewElement: Locator): Promise<Locator | null> {
        const byLabel = reviewElement.locator('..').locator(HELPFUL_LABEL_SELECTOR).first()
        if (await byLabel.count() > 0) return byLabel

        const byText = reviewElement
            .locator('..')
            .locator('button')
            .filter({ hasText: HELPFUL_TEXT_PATTERN })
            .first()
        if (await byText.count() > 0) return byText

        return null
    }

    private recordOutcome(
        candidate: HelpfulVoteCandidate,
        voter: VoterAccount,
        success: boolean,
        errorMessage?: string,
    ): void {
        const status = attemptStatus(success, errorMessage)
        try {
            const record: HelpfulVoteRecord = {
                historyId: candidate.historyId,
                voterAccountId: voter.accountId,
                votedAt: new Date(),
                success,
            }
            if (errorMessage !== undefined && errorMessage.length > 0) {
                record.errorMessage = errorMessage
            }
            helpfulVoteService.recordVote(record)
            console.log(
                `[HelpfulVote] historyId=${candidate.historyId} voter=${voter.email} status=${status}`,
            )
        } catch (error: unknown) {
            console.error(
                `[HelpfulVote] record failed historyId=${candidate.historyId}: ${toErrorMessage(error)}`,
            )
        }
    }

    private pause(ms: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, ms)
        })
    }
}

export const helpfulVoteWorker = new HelpfulVoteWorker()
