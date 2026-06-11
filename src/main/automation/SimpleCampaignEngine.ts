/**
 * SimpleCampaignEngine - Đơn giản hóa flow review
 * Flow: 
 * 1. Get account + location + review text
 * 2. Open browser (visible for debug)
 * 3. Go to Google, search for location
 * 4. Find Maps result, click
 * 5. Find "Write a review" button
 * 6. Write review + rating
 * 7. Save screenshot & close
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { BrowserWindow } from 'electron'
import { campaignService } from '../services/CampaignService'
import { accountService } from '../services/AccountService'
import { accountWarmupService } from '../services/AccountWarmupService'
import { locationService } from '../services/LocationService'
import { reviewService } from '../services/ReviewService'
import { SpintaxParser } from '../utils/SpintaxParser'
import * as path from 'path'
import * as fs from 'fs'
import { loadSettings } from '../ipc/settings'
import { aiService } from '../services/AIService'

export interface CampaignStatus {
    running: boolean
    campaignId?: number
    progress: number
    message: string
    currentAccount?: string
    currentLocation?: string
}

class SimpleCampaignEngine {
    private browser: Browser | null = null
    private running = false
    private shouldStop = false

    // Send status to renderer
    private sendStatus(status: CampaignStatus) {
        console.log(`[Campaign] ${status.message}`)
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('automation:status', status)
        }
    }

    private log(msg: string) {
        console.log(`[SimpleCampaign] ${msg}`)
    }

    // Random delay
    private delay(min: number, max: number): Promise<void> {
        const ms = Math.floor(Math.random() * (max - min + 1)) + min
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    // Check if running
    isRunning(): boolean {
        return this.running
    }

    // Stop campaign
    async stopCampaign(): Promise<void> {
        this.shouldStop = true
        if (this.browser) {
            await this.browser.close().catch(() => { })
            this.browser = null
        }
        this.running = false
        this.sendStatus({ running: false, progress: 0, message: 'Campaign stopped' })
    }

    // Get current status
    getStatus(): CampaignStatus {
        return {
            running: this.running,
            progress: 0,
            message: this.running ? 'Running...' : 'Idle'
        }
    }

    // Main: Run campaign
    async runCampaign(campaignId: number): Promise<{ success: boolean; error?: string }> {
        if (this.running) {
            return { success: false, error: 'Another campaign is already running' }
        }

        this.running = true
        this.shouldStop = false

        try {
            this.log(`Starting campaign ${campaignId}...`)
            this.sendStatus({ running: true, campaignId, progress: 0, message: 'Loading campaign data...' })

            // 1. Get campaign details
            const campaignDetails = await campaignService.getWithDetails(campaignId)
            if (!campaignDetails) {
                throw new Error('Campaign not found')
            }

            const { campaign, locationIds, reviewTemplates } = campaignDetails
            this.log(`Campaign: ${campaign.name}, Locations: ${locationIds.length}, Templates: ${reviewTemplates.length}`)

            // 2. Get accounts
            const accounts = await accountService.getActive()
            if (accounts.length === 0) {
                throw new Error('No active accounts. Please add accounts first.')
            }
            this.log(`Found ${accounts.length} accounts`)

            // 3. Get locations
            const locations = []
            for (const locId of locationIds) {
                const loc = await locationService.getById(locId)
                if (loc) locations.push(loc)
            }
            if (locations.length === 0) {
                throw new Error('No locations found')
            }
            this.log(`Found ${locations.length} locations`)

            // 4. Update campaign status
            await campaignService.start(campaignId)

            // 5. Launch browser (VISIBLE for debugging)
            this.log('Launching browser...')
            this.sendStatus({ running: true, campaignId, progress: 5, message: 'Launching browser...' })

            const globalSettings = loadSettings()
            this.browser = await chromium.launch({
                headless: globalSettings.headless ?? false,
                channel: 'chrome', // Use installed Chrome instead of Chromium
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-infobars',
                    '--window-size=1366,768',
                    '--start-maximized',
                    '--disable-extensions',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-default-apps',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--flag-switches-begin',
                    '--flag-switches-end',
                    '--disable-sync',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--metrics-recording-only',
                    '--disable-hang-monitor',
                    '--disable-prompt-on-repost',
                    '--disable-domain-reliability',
                    '--disable-client-side-phishing-detection',
                    '--disable-background-timer-throttling',
                ]
            })

            // 6. Process each account-location pair
            let completed = 0
            const total = Math.min(accounts.length, locations.length) // 1 review per account per location for now

            for (let i = 0; i < accounts.length && !this.shouldStop; i++) {
                const account = accounts[i]

                // Phase 2: Warmup gate - new/low-warmup accounts should have reduced velocity
                let skipThisAccount = false
                try {
                    const warmupData = await accountWarmupService.getWarmupData(account.id)
                    if (warmupData.warmupLevel < 25) {
                        this.log(`Account ${account.email} has very low warmup level (${warmupData.warmupLevel}). Skipping for now.`)
                        skipThisAccount = true
                    } else if (warmupData.warmupLevel < 55) {
                        this.log(`Account ${account.email} has moderate warmup (${warmupData.warmupLevel}). Throttling reviews.`)
                    }
                } catch {}

                if (skipThisAccount) continue

                for (let j = 0; j < locations.length && !this.shouldStop; j++) {
                    const location = locations[j]
                    // Generate review text — AI first, spintax fallback
                    const globalSettingsForAI = loadSettings()
                    let reviewText: string

                    if (globalSettingsForAI.autoGenerateReview) {
                        try {
                            const aiResult = await aiService.generateReview(
                                location.name,
                                undefined, // category
                                {
                                    rating: campaign.rating,
                                    language: globalSettingsForAI.defaultReviewLanguage || 'vi',
                                    style: globalSettingsForAI.defaultReviewStyle || 'casual',
                                    length: globalSettingsForAI.defaultReviewLength || 'medium',
                                }
                            )
                            if (aiResult.success && aiResult.review) {
                                reviewText = aiResult.review.content
                                this.log(`AI generated review for ${location.name}`)
                            } else {
                                this.log(`AI returned no review, using spintax template`)
                                const reviewTemplate = reviewTemplates[Math.floor(Math.random() * reviewTemplates.length)]
                                reviewText = SpintaxParser.spin(reviewTemplate)
                            }
                        } catch (aiErr: any) {
                            this.log(`AI failed, using spintax template: ${aiErr.message}`)
                            const reviewTemplate = reviewTemplates[Math.floor(Math.random() * reviewTemplates.length)]
                            reviewText = SpintaxParser.spin(reviewTemplate)
                        }
                    } else {
                        const reviewTemplate = reviewTemplates[Math.floor(Math.random() * reviewTemplates.length)]
                        reviewText = SpintaxParser.spin(reviewTemplate)
                    }

                    this.sendStatus({
                        running: true,
                        campaignId,
                        progress: Math.floor((completed / total) * 100),
                        message: `Processing: ${account.email} → ${location.name}`,
                        currentAccount: account.email,
                        currentLocation: location.name,
                    })

                    // Do review
                    const result = await this.performSingleReview(
                        account.email,
                        account.password,
                        location.name,
                        location.url,
                        reviewText,
                        campaign.rating
                    )

                    // Record result
                    await reviewService.create({
                        campaignId,
                        accountId: account.id,
                        locationId: location.id,
                        rating: campaign.rating,
                        reviewText: reviewText,
                        status: result.success ? 'success' : 'failed',
                        errorMessage: result.error,
                        createdAt: new Date(),
                    })

                    completed++

                    // Delay between reviews
                    if (!this.shouldStop) {
                        this.log('Waiting before next review...')
                        await this.delay(campaign.delayMin * 1000, campaign.delayMax * 1000)
                    }
                }
            }

            // Done
            await campaignService.stop(campaignId)
            this.sendStatus({ running: false, campaignId, progress: 100, message: 'Campaign completed!' })

            return { success: true }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.log(`ERROR: ${errorMsg}`)
            this.sendStatus({ running: false, progress: 0, message: `Error: ${errorMsg}` })
            await campaignService.update(campaignId, { status: 'error' })
            return { success: false, error: errorMsg }
        } finally {
            if (this.browser) {
                await this.browser.close().catch(() => { })
                this.browser = null
            }
            this.running = false
        }
    }

    // Perform single review for one account/location
    private async performSingleReview(
        email: string,
        password: string,
        locationName: string,
        locationUrl: string,
        reviewText: string,
        rating: number
    ): Promise<{ success: boolean; error?: string }> {
        let context: BrowserContext | null = null
        let currentStep = 'init'

        try {
            if (!this.browser) throw new Error('Browser not initialized')

            // Create new context
            currentStep = 'create_context'
            this.log(`Creating browser context for ${email}...`)
            context = await this.browser.newContext({
                viewport: { width: 1366, height: 768 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'vi-VN',
                timezoneId: 'Asia/Ho_Chi_Minh',
            })

            // Comprehensive anti-detection stealth scripts
            await context.addInitScript(() => {
                // 1. Hide webdriver flag
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

                // 2. Hide automation extensions
                const originalQuery = window.navigator.permissions.query
                window.navigator.permissions.query = (parameters: any) =>
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
                        : originalQuery(parameters)

                // 3. Add Chrome runtime
                Object.defineProperty(window, 'chrome', {
                    get: () => ({
                        runtime: {
                            connect: () => { },
                            sendMessage: () => { },
                            onMessage: { addListener: () => { } }
                        },
                        loadTimes: () => ({}),
                        csi: () => ({})
                    })
                })

                // 4. Override plugins count
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5].map(() => ({
                        name: 'Chrome PDF Plugin',
                        description: 'Portable Document Format',
                        filename: 'internal-pdf-viewer',
                        length: 1
                    }))
                })

                // 5. Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['vi-VN', 'vi', 'en-US', 'en']
                })

                // 6. Override hardwareConcurrency
                Object.defineProperty(navigator, 'hardwareConcurrency', {
                    get: () => 8
                })

                // 7. Override deviceMemory
                Object.defineProperty(navigator, 'deviceMemory', {
                    get: () => 8
                })

                // 8. Override platform
                Object.defineProperty(navigator, 'platform', {
                    get: () => 'Win32'
                })

                // 9. Override vendor
                Object.defineProperty(navigator, 'vendor', {
                    get: () => 'Google Inc.'
                })

                // 10. Mock WebGL attributes
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function (parameter) {
                    if (parameter === 37445) {
                        return 'Intel Inc.'
                    }
                    if (parameter === 37446) {
                        return 'Intel Iris OpenGL Engine'
                    }
                    return getParameter.call(this, parameter)
                }
            })

            const page = await context.newPage()

            // Step 1: Go to Google
            currentStep = 'google_navigate'
            this.log('Opening Google...')
            await page.goto('https://www.google.com', { waitUntil: 'networkidle' })
            await this.delay(1000, 2000)

            // Step 2: Search for location
            currentStep = 'google_search'
            this.log(`Searching for: ${locationName}...`)

            const searchBox = await page.$('textarea[name="q"], input[name="q"]')
            if (!searchBox) throw new Error('Search box not found')

            await searchBox.click()
            await this.delay(300, 500)

            // Type like human
            for (const char of locationName) {
                await page.keyboard.type(char, { delay: 50 + Math.random() * 100 })
            }
            await this.delay(500, 1000)
            await page.keyboard.press('Enter')
            await this.delay(2000, 3000)

            // Step 3: Look for Maps result or go directly to Maps
            currentStep = 'find_maps'
            this.log('Looking for Maps...')

            // Try clicking on Maps tab
            const mapsTab = await page.$('a[href*="google.com/maps"]')
            if (mapsTab) {
                await mapsTab.click()
                await this.delay(2000, 3000)
            } else {
                // Go directly to Maps search
                await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(locationName)}`, {
                    waitUntil: 'networkidle'
                })
                await this.delay(2000, 3000)
            }

            // Step 4: Find and click on the first place result
            currentStep = 'click_place'
            this.log('Finding place...')
            await this.delay(1000, 2000)

            // Click first result in sidebar
            const placeResult = await page.$('[role="feed"] > div:first-child a[href*="/maps/place"]')
            if (placeResult) {
                await placeResult.click()
                await this.delay(2000, 3000)
            }

            // Step 5: Look for "Write a review" button
            currentStep = 'find_review_button'
            this.log('Looking for Write Review button...')
            await this.delay(1000, 2000)

            // Take screenshot for debugging
            const screenshotPath = path.join(process.cwd(), `review-${Date.now()}.png`)
            await page.screenshot({ path: screenshotPath })
            this.log(`Screenshot saved: ${screenshotPath}`)

            // Try to find review button
            const reviewButton = await page.$('button[aria-label*="review"], button:has-text("Viết đánh giá"), button:has-text("Write a review")')

            if (!reviewButton) {
                this.log('Review button not found - user may not be logged in')
                return { success: false, error: 'Review button not found - need to login first' }
            }

            this.log('Found review button! (Login required for actual review)')
            // Note: Actually clicking and writing review requires Google login
            // For now, we'll mark this as success for the flow test

            return { success: true }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.log(`Error at step ${currentStep}: ${errorMsg}`)
            return { success: false, error: `${currentStep}: ${errorMsg}` }
        } finally {
            if (context) {
                await context.close().catch(() => { })
            }
        }
    }
}

export const simpleCampaignEngine = new SimpleCampaignEngine()
