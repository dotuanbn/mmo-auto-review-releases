import { BrowserWindow } from 'electron'
import { browserService, BrowserConfig } from './BrowserService'
import { googleAuthHandler } from './GoogleAuthHandler'
import { googleMapsReviewHandler } from './GoogleMapsReviewHandler'
import { accountService } from '../services/AccountService'
import { proxyService } from '../services/ProxyService'
import { locationService } from '../services/LocationService'
import { campaignService } from '../services/CampaignService'
import { reviewService } from '../services/ReviewService'
import { aiService } from '../services/AIService'
import { loadSettings } from '../ipc/settings'
import type { Campaign } from '../database/schema'

export interface AutomationStatus {
    running: boolean
    campaignId?: number
    currentAccount?: string
    currentLocation?: string
    progress: number
    message: string
}

export class ReviewAutomationEngine {
    private running = false
    private shouldStop = false
    private currentCampaignId: number | null = null

    // Send status update to renderer
    private sendStatus(status: AutomationStatus) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('automation:status', status)
        }
    }

    // Get random item from array
    private getRandomItem<T>(array: T[]): T {
        return array[Math.floor(Math.random() * array.length)]
    }

    // Get random number between min and max
    private getRandomDelay(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    // Start campaign automation
    async startCampaign(campaignId: number): Promise<void> {
        if (this.running) {
            this.sendStatus({ running: true, message: 'Already running another campaign', progress: 0 })
            return
        }

        this.running = true
        this.shouldStop = false
        this.currentCampaignId = campaignId

        try {
            // Get campaign details
            const campaignDetails = await campaignService.getWithDetails(campaignId)
            if (!campaignDetails) {
                throw new Error('Campaign not found')
            }

            const { campaign, locationIds, accountIds, reviewTemplates } = campaignDetails

            // Get accounts to use
            let accounts = await accountService.getActive()
            if (accountIds && accountIds.length > 0) {
                accounts = accounts.filter(a => accountIds.includes(a.id))
            }

            if (accounts.length === 0) {
                throw new Error('No active accounts available')
            }

            // Get proxies
            const proxies = await proxyService.getActive()

            // Get locations
            const locations = []
            for (const id of locationIds) {
                const location = await locationService.getById(id)
                if (location && location.status !== 'done') {
                    locations.push(location)
                }
            }

            if (locations.length === 0) {
                throw new Error('No pending locations')
            }

            // Start automation loop
            this.sendStatus({
                running: true,
                campaignId,
                message: 'Starting campaign...',
                progress: 0,
            })

            await campaignService.start(campaignId)

            // Process each location
            let completedReviews = 0
            const totalReviews = locations.length * campaign.maxReviewsPerAccountPerDay

            for (const location of locations) {
                if (this.shouldStop) break

                // Get accounts that haven't exceeded daily limit for this location
                for (const account of accounts) {
                    if (this.shouldStop) break

                    // Check daily limit
                    const todayReviews = await reviewService.getAccountReviewsToday(account.id)
                    if (todayReviews >= campaign.maxReviewsPerAccountPerDay) {
                        continue
                    }

                    // Get random proxy if available
                    const proxy = proxies.length > 0 ? this.getRandomItem(proxies) : undefined

                    // Generate review text — AI first, template fallback
                    const settings = loadSettings()
                    let reviewText: string

                    if (settings.autoGenerateReview && reviewTemplates.length > 0) {
                        try {
                            const aiResult = await aiService.generateReview(
                                location.name,
                                undefined, // category
                                {
                                    rating: campaign.rating,
                                    language: settings.defaultReviewLanguage || 'vi',
                                    style: settings.defaultReviewStyle || 'casual',
                                    length: settings.defaultReviewLength || 'medium',
                                }
                            )
                            if (aiResult.success && aiResult.review) {
                                reviewText = aiResult.review.content
                                console.log(`[ReviewEngine] AI generated review for ${location.name}`)
                            } else {
                                console.warn(`[ReviewEngine] AI returned no review, using template`)
                                reviewText = this.getRandomItem(reviewTemplates)
                            }
                        } catch (aiErr: any) {
                            console.warn(`[ReviewEngine] AI generation failed, using template: ${aiErr.message}`)
                            reviewText = this.getRandomItem(reviewTemplates)
                        }
                    } else {
                        reviewText = this.getRandomItem(reviewTemplates)
                    }

                    // Perform review
                    this.sendStatus({
                        running: true,
                        campaignId,
                        currentAccount: account.email,
                        currentLocation: location.name,
                        message: `Reviewing ${location.name}...`,
                        progress: Math.round((completedReviews / totalReviews) * 100),
                    })

                    const result = await this.performReview(
                        account,
                        location,
                        proxy,
                        campaign.rating,
                        reviewText
                    )

                    // Record result
                    await reviewService.create({
                        campaignId,
                        accountId: account.id,
                        locationId: location.id,
                        proxyId: proxy?.id,
                        rating: campaign.rating,
                        reviewText: reviewText as string,
                        status: result.success ? 'success' : 'failed',
                        errorMessage: result.error,
                        screenshot: result.screenshot,
                        createdAt: new Date(),
                    })

                    // Update progress
                    await campaignService.updateProgress(campaignId, result.success)

                    if (result.success) {
                        await accountService.incrementReviewCount(account.id)
                        await locationService.incrementReviewCount(location.id)
                    }

                    completedReviews++

                    // Random delay between reviews
                    if (!this.shouldStop) {
                        const delay = this.getRandomDelay(campaign.delayMin * 1000, campaign.delayMax * 1000)
                        this.sendStatus({
                            running: true,
                            campaignId,
                            message: `Waiting ${Math.round(delay / 1000)}s before next review...`,
                            progress: Math.round((completedReviews / totalReviews) * 100),
                        })
                        await new Promise(resolve => setTimeout(resolve, delay))
                    }
                }
            }

            // Campaign complete
            await campaignService.stop(campaignId)
            this.sendStatus({
                running: false,
                campaignId,
                message: 'Campaign completed',
                progress: 100,
            })

        } catch (error) {
            console.error('Campaign error:', error)
            this.sendStatus({
                running: false,
                campaignId,
                message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                progress: 0,
            })
            await campaignService.update(campaignId, { status: 'error' })
        } finally {
            this.running = false
            this.currentCampaignId = null
            await browserService.closeBrowser()
        }
    }

    // Perform single review
    private async performReview(
        account: any,
        location: any,
        proxy: any | undefined,
        rating: number,
        reviewText: string
    ): Promise<{ success: boolean; error?: string; screenshot?: string }> {
        let contextId = -1

        try {
            const settings = loadSettings()
            // Browser config
            const config: BrowserConfig = {
                headless: settings.headless ?? false,
                profilePath: account.profilePath,
                userAgent: settings.randomizeUserAgent ? browserService.getRandomUserAgent() : undefined,
                viewport: settings.randomizeViewport ? browserService.getRandomViewport() : undefined,
            }

            if (proxy) {
                config.proxy = {
                    host: proxy.host,
                    port: proxy.port,
                    username: proxy.username,
                    password: proxy.password,
                }
            }

            // Login if needed
            if (!account.cookies) {
                // Forward recovery + 2FA secret so challenge resolver loop can auto-handle selection/kpe/TOTP/phone/prompts
                const loginResult = await googleAuthHandler.login(
                    account.email,
                    account.password,
                    config,
                    account.twoFactorSecret || undefined,
                    account.recoveryEmail || undefined,
                    account.recoveryPhone || undefined
                )
                contextId = loginResult.contextId

                if (!loginResult.success) {
                    return { success: false, error: loginResult.error }
                }

                // Save session
                if (account.profilePath) {
                    await googleAuthHandler.saveSession(contextId, account.profilePath)
                }
            } else {
                // Use existing session
                contextId = await browserService.createContext(config)
            }

            // Post review
            const result = await googleMapsReviewHandler.postReview(
                contextId,
                location.url,
                rating,
                reviewText
            )

            return {
                success: result.success,
                error: result.error,
                screenshot: result.screenshot,
            }

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        } finally {
            if (contextId !== -1) {
                await browserService.closeContext(contextId)
            }
        }
    }

    // Stop current campaign
    async stopCampaign(): Promise<void> {
        this.shouldStop = true
        if (this.currentCampaignId) {
            await campaignService.pause(this.currentCampaignId)
        }
        this.sendStatus({
            running: false,
            message: 'Campaign stopped',
            progress: 0,
        })
    }

    // Check if running
    isRunning(): boolean {
        return this.running
    }

    // Get current status
    getStatus(): AutomationStatus {
        return {
            running: this.running,
            campaignId: this.currentCampaignId || undefined,
            message: this.running ? 'Running...' : 'Idle',
            progress: 0,
        }
    }
}

export const reviewAutomationEngine = new ReviewAutomationEngine()
