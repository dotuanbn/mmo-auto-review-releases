/**
 * AutomationController - Central Workflow Controller
 * 
 * Manages the entire automation workflow:
 * - Thread pool management
 * - Job distribution
 * - Account/Profile coordination
 * - Progress tracking
 * - Error handling & recovery
 */

import { BrowserContext, chromium, Browser } from 'playwright'
import { jobQueue, Job, JobType } from './JobQueue'
import { browserService } from './BrowserService'
import { googleAuthHandler } from './GoogleAuthHandler'
import { googleMapsReviewHandler } from './GoogleMapsReviewHandler'
import { proxyService } from '../services/ProxyService'
import { accountService } from '../services/AccountService'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs'
import { ollamaService } from '../services/OllamaService'
import { agenticReviewHandler } from './AgenticReviewHandler'
import { sendReviewProgress } from '../ipc/campaigns'
import { loadSettings } from '../ipc/settings'
import {
    buildManualSubmitMessage,
    getReviewSubmissionDecision,
    requestManualReviewSubmissionApproval,
} from '../services/ComplianceService'

// Debug file logger
const LOG_FILE = join(app.getPath('userData'), 'automation-debug.log')
function logToFile(msg: string): void {
    const timestamp = new Date().toISOString()
    try {
        appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`)
    } catch { /* ignore */ }
    console.log(msg)
}

export interface AutomationConfig {
    threads: number
    maxReviewsPerAccountPerDay: number
    delayMin: number // seconds
    delayMax: number // seconds
    workingHoursStart: string // HH:MM
    workingHoursEnd: string // HH:MM
    headless: boolean
    autoRetry: boolean
    proxyMode: 'rotate' | 'sticky' | 'none'
    profilesPath: string
}

export interface ThreadState {
    id: number
    status: 'idle' | 'running' | 'error'
    accountId?: number
    accountEmail?: string
    currentJobId?: string
    browser?: Browser
    context?: BrowserContext
    lastError?: string
}

export interface AutomationStatus {
    running: boolean
    paused: boolean
    threads: ThreadState[]
    progress: {
        total: number
        completed: number
        failed: number
        remaining: number
    }
    currentCampaignId?: number
}

const DEFAULT_CONFIG: AutomationConfig = {
    threads: 3,
    maxReviewsPerAccountPerDay: 5,
    delayMin: 30,
    delayMax: 120,
    workingHoursStart: '08:00',
    workingHoursEnd: '22:00',
    headless: false,
    autoRetry: true,
    proxyMode: 'rotate',
    profilesPath: '',
}

class AutomationController {
    private config: AutomationConfig = DEFAULT_CONFIG
    private running = false
    private paused = false
    private shouldStop = false
    private threads: ThreadState[] = []
    private currentCampaignId?: number
    private mainWindow: BrowserWindow | null = null

    constructor() {
        this.initProfilesPath()
    }

    // Initialize profiles path
    private initProfilesPath(): void {
        const userDataPath = app.getPath('userData')
        this.config.profilesPath = join(userDataPath, 'profiles')

        if (!existsSync(this.config.profilesPath)) {
            mkdirSync(this.config.profilesPath, { recursive: true })
        }
    }

    // Set main window for IPC communication
    setMainWindow(window: BrowserWindow): void {
        this.mainWindow = window
    }

    // Send status update to renderer
    private sendStatus(): void {
        if (this.mainWindow) {
            this.mainWindow.webContents.send('automation:status', this.getStatus())
        }
    }

    // Load config from database
    async loadConfig(): Promise<void> {
        try {
            const db = getDatabase()
            const settings = await db.select().from(schema.settings).all()

            const getValue = (key: string, defaultVal: any): any => {
                const setting = settings.find(s => s.key === key)
                return setting ? setting.value : defaultVal
            }

            // Get profiles path from DB, but validate it
            let profilesPath = getValue('profiles_path', this.config.profilesPath)

            // Validate the profiles path - check if the parent directory exists
            // If it points to a non-existent drive (e.g. D:\DULIEU\PROFILE), fallback to userData
            try {
                const parentDir = join(profilesPath, '..')
                if (!existsSync(parentDir)) {
                    logToFile(`[loadConfig] profiles_path "${profilesPath}" parent dir doesn't exist, using default`)
                    profilesPath = join(app.getPath('userData'), 'profiles')
                    // Auto-correct the DB value
                    await db.insert(schema.settings)
                        .values({ key: 'profiles_path', value: profilesPath })
                        .onConflictDoUpdate({
                            target: schema.settings.key,
                            set: { value: profilesPath }
                        })
                }
            } catch {
                profilesPath = join(app.getPath('userData'), 'profiles')
            }

            // Ensure profiles directory exists
            if (!existsSync(profilesPath)) {
                mkdirSync(profilesPath, { recursive: true })
            }

            const globalSettings = loadSettings()

            this.config = {
                threads: globalSettings.maxConcurrentBrowsers || 3,
                maxReviewsPerAccountPerDay: parseInt(getValue('max_reviews_per_day', '5')),
                delayMin: parseInt(getValue('delay_min', '30')),
                delayMax: parseInt(getValue('delay_max', '120')),
                workingHoursStart: getValue('working_hours_start', '08:00'),
                workingHoursEnd: getValue('working_hours_end', '22:00'),
                headless: globalSettings.headless ?? false,
                autoRetry: getValue('auto_retry', 'true') === 'true',
                proxyMode: getValue('proxy_mode', 'rotate') as 'rotate' | 'sticky' | 'none',
                profilesPath: profilesPath,
            }

            // Also update job queue config
            await jobQueue.loadConfig()

            logToFile(`[loadConfig] Config loaded. profilesPath: ${this.config.profilesPath}, headless: ${this.config.headless}`)
        } catch (error) {
            console.error('[AutomationController] Failed to load config:', error)
        }
    }

    // Save config to database
    async saveConfig(newConfig: Partial<AutomationConfig>): Promise<void> {
        try {
            const db = getDatabase()

            const configMap: Record<string, string> = {
                threads: String(newConfig.threads ?? this.config.threads),
                max_reviews_per_day: String(newConfig.maxReviewsPerAccountPerDay ?? this.config.maxReviewsPerAccountPerDay),
                delay_min: String(newConfig.delayMin ?? this.config.delayMin),
                delay_max: String(newConfig.delayMax ?? this.config.delayMax),
                working_hours_start: newConfig.workingHoursStart ?? this.config.workingHoursStart,
                working_hours_end: newConfig.workingHoursEnd ?? this.config.workingHoursEnd,
                headless: String(newConfig.headless ?? this.config.headless),
                auto_retry: String(newConfig.autoRetry ?? this.config.autoRetry),
                proxy_mode: newConfig.proxyMode ?? this.config.proxyMode,
            }

            for (const [key, value] of Object.entries(configMap)) {
                await db.insert(schema.settings)
                    .values({ key, value })
                    .onConflictDoUpdate({
                        target: schema.settings.key,
                        set: { value }
                    })
            }

            this.config = { ...this.config, ...newConfig }
            console.log('[AutomationController] Config saved')
        } catch (error) {
            console.error('[AutomationController] Failed to save config:', error)
        }
    }

    // Get current config
    getConfig(): AutomationConfig {
        return { ...this.config }
    }

    // Get profile path for an account
    getAccountProfilePath(accountId: number): string {
        const profilePath = join(this.config.profilesPath, `account_${accountId}`)
        if (!existsSync(profilePath)) {
            mkdirSync(profilePath, { recursive: true })
        }
        return profilePath
    }

    // Check if current time is within working hours
    isWithinWorkingHours(): boolean {
        const now = new Date()
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        return currentTime >= this.config.workingHoursStart && currentTime <= this.config.workingHoursEnd
    }

    // Random delay
    private async delay(): Promise<void> {
        const ms = (this.config.delayMin + Math.random() * (this.config.delayMax - this.config.delayMin)) * 1000
        await new Promise(resolve => setTimeout(resolve, ms))
    }

    // Get automation status
    getStatus(): AutomationStatus {
        const stats = jobQueue.getStats()

        return {
            running: this.running,
            paused: this.paused,
            threads: this.threads,
            progress: {
                total: stats.total,
                completed: stats.done,
                failed: stats.failed,
                remaining: stats.pending + stats.running,
            },
            currentCampaignId: this.currentCampaignId,
        }
    }

    // Start automation for a campaign
    async startCampaign(campaignId: number): Promise<{ success: boolean; error?: string }> {
        if (this.running) {
            return { success: false, error: 'Automation is already running' }
        }

        try {
            await this.loadConfig()
            logToFile(`[startCampaign] Config loaded. Working hours: ${this.config.workingHoursStart}-${this.config.workingHoursEnd}`)
            logToFile(`[startCampaign] Current time: ${new Date().toTimeString().slice(0, 5)}, within hours: ${this.isWithinWorkingHours()}`)

            // Check working hours
            if (!this.isWithinWorkingHours()) {
                logToFile(`[startCampaign] BLOCKED: Outside working hours!`)
                return { success: false, error: `Outside working hours (${this.config.workingHoursStart} - ${this.config.workingHoursEnd})` }
            }

            // Get campaign details
            const db = getDatabase()
            const campaign = await db.select().from(schema.campaigns)
                .where(eq(schema.campaigns.id, campaignId))
                .get()

            if (!campaign) {
                return { success: false, error: 'Campaign not found' }
            }

            // Parse IDs
            const locationIds: number[] = JSON.parse(campaign.locationIds || '[]')
            const accountIds: number[] = JSON.parse(campaign.accountIds || '[]')

            logToFile(`[AutomationController] Campaign ${campaignId}: locationIds=${JSON.stringify(locationIds)}, accountIds=${JSON.stringify(accountIds)}`)

            if (locationIds.length === 0) {
                return { success: false, error: 'No locations in campaign' }
            }

            // Get accounts - accept active, pending, and verified accounts
            let accounts: any[]
            if (accountIds.length > 0) {
                accounts = await db.select().from(schema.accounts).all()
                accounts = accounts.filter(a => accountIds.includes(a.id))
            } else {
                // If no specific accounts, get all non-banned accounts
                accounts = await db.select().from(schema.accounts).all()
                accounts = accounts.filter(a => a.status !== 'banned' && a.status !== 'disabled')
            }

            logToFile(`[AutomationController] Found ${accounts.length} accounts: ${accounts.map(a => `${a.email}(${a.status})`).join(', ')}`)

            if (accounts.length === 0) {
                return { success: false, error: 'No accounts available. Please add accounts first.' }
            }

            // Parse review templates - campaign.reviewTemplates is stored as JSON string array
            let reviewTemplates: string[] = []
            try {
                const parsed = JSON.parse(campaign.reviewTemplates || '[]')
                reviewTemplates = Array.isArray(parsed) ? parsed.filter((t: string) => t && t.trim()) : [String(parsed)]
            } catch {
                // If not valid JSON, treat as single template text
                if (campaign.reviewTemplates && campaign.reviewTemplates.trim()) {
                    reviewTemplates = [campaign.reviewTemplates]
                }
            }

            logToFile(`[AutomationController] Review templates (${reviewTemplates.length}): ${reviewTemplates.map(t => t.substring(0, 30)).join(' | ')}`)

            // Get locations
            const locations = await db.select().from(schema.locations).all()
            const campaignLocations = locations
                .filter(l => locationIds.includes(l.id))
                .map(l => ({
                    id: l.id,
                    // Randomly pick one template for each location-account pair
                    reviewText: reviewTemplates.length > 0
                        ? reviewTemplates[Math.floor(Math.random() * reviewTemplates.length)]
                        : '',
                    rating: campaign.rating,
                }))

            logToFile(`[AutomationController] Campaign locations: ${campaignLocations.map(l => `loc=${l.id}, text="${l.reviewText?.substring(0, 20)}..."`).join(', ')}`)

            if (campaignLocations.length === 0) {
                return { success: false, error: 'No matching locations found in database' }
            }

            // Create jobs
            const jobs = await jobQueue.addCampaignJobs(
                campaignId,
                'review',
                accounts.map(a => a.id),
                campaignLocations,
                0
            )

            logToFile(`[AutomationController] Created ${jobs.length} jobs`)

            if (jobs.length === 0) {
                return { success: false, error: 'No jobs created - accounts may have reached daily review limit' }
            }

            this.currentCampaignId = campaignId
            this.running = true
            this.shouldStop = false
            this.paused = false

            // Update campaign total reviews
            await db.update(schema.campaigns)
                .set({
                    status: 'running',
                    totalReviews: jobs.length,
                })
                .where(eq(schema.campaigns.id, campaignId))

            // Initialize threads
            this.initializeThreads()

            // Start worker loop
            this.runWorkerLoop()

            this.sendStatus()
            console.log(`[AutomationController] ✅ Campaign ${campaignId} started with ${jobs.length} jobs across ${accounts.length} accounts`)
            return { success: true }
        } catch (error) {
            console.error('[AutomationController] Failed to start campaign:', error)
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }
        }
    }

    // Initialize thread states
    private initializeThreads(): void {
        this.threads = []
        for (let i = 0; i < this.config.threads; i++) {
            this.threads.push({
                id: i,
                status: 'idle',
            })
        }
    }

    // Main worker loop
    private async runWorkerLoop(): Promise<void> {
        console.log(`[AutomationController] Starting worker loop with ${this.config.threads} threads`)

        while (this.running && !this.shouldStop) {
            // Check if paused
            if (this.paused) {
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }

            // Check working hours
            if (!this.isWithinWorkingHours()) {
                logToFile('[AutomationController] Outside working hours, pausing...')
                this.paused = true
                this.sendStatus()
                continue
            }

            // Find idle threads
            const idleThreads = this.threads.filter(t => t.status === 'idle')

            if (idleThreads.length === 0) {
                // Wait a bit if all threads are busy
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }

            // Get next job
            const job = await jobQueue.getNextJob()

            if (!job) {
                // Check if all done
                if (jobQueue.isEmpty()) {
                    logToFile('[AutomationController] All jobs completed!')
                    await this.stop()
                    break
                }
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }

            // Assign job to first idle thread
            const thread = idleThreads[0]
            this.runJobOnThread(thread, job)
        }
    }

    // Run a job on a specific thread
    private async runJobOnThread(thread: ThreadState, job: Job): Promise<void> {
        thread.status = 'running'
        thread.currentJobId = job.id
        jobQueue.startJob(job.id)
        this.sendStatus()

        try {
            // Get account
            const db = getDatabase()
            const account = await db.select().from(schema.accounts)
                .where(eq(schema.accounts.id, job.accountId))
                .get()

            if (!account) {
                throw new Error('Account not found')
            }

            thread.accountId = account.id
            thread.accountEmail = account.email
            this.sendStatus()

            // Get proxy if needed
            let proxy = null
            if (this.config.proxyMode !== 'none') {
                const proxies = await proxyService.getActive()
                if (proxies.length > 0) {
                    proxy = proxies[thread.id % proxies.length]
                }
            }

            // Determine profile path - use account's stored profilePath or generate one
            let profilePath = account.profilePath
            if (!profilePath || !existsSync(profilePath)) {
                // Try legacy profile naming convention
                const emailClean = account.email.replace(/[@.]/g, '_')
                const legacyPath = join(this.config.profilesPath, `profile_${account.id}_${emailClean}`)
                if (existsSync(legacyPath)) {
                    profilePath = legacyPath
                    logToFile(`[Thread ${thread.id}] Using legacy profile: ${legacyPath}`)
                } else {
                    // Create new profile path
                    profilePath = this.getAccountProfilePath(account.id)
                logToFile(`[Thread ${thread.id}] Using new profile: ${profilePath}`)
                }
            } else {
                logToFile(`[Thread ${thread.id}] Using stored profile: ${profilePath}`)
            }

            logToFile(`[Thread ${thread.id}] Starting job ${job.id} for ${account.email}`)
            logToFile(`[Thread ${thread.id}] Profile: ${profilePath}`)

            const globalSettings = loadSettings()
            
            // Launch browser with persistent context (preserves login sessions if saveProfiles is enabled)
            const contextOptions: any = {
                viewport: globalSettings.randomizeViewport ? browserService.getRandomViewport() : { width: 1366, height: 768 },
                userAgent: globalSettings.randomizeUserAgent ? browserService.getRandomUserAgent() : undefined,
                args: [
                    '--disable-infobars',
                    '--no-first-run',
                ],
                headless: globalSettings.headless ?? false, 
            }

            if (globalSettings.hideAutomation !== false) {
                contextOptions.args.push('--disable-blink-features=AutomationControlled')
            }

            if (proxy) {
                contextOptions.proxy = {
                    server: `${proxy.type || 'http'}://${proxy.host}:${proxy.port}`,
                    username: proxy.username,
                    password: proxy.password,
                }
            }

            // Use launchPersistentContext to reuse existing login sessions, or a temp dir if saveProfiles is false
            const actualProfilePath = globalSettings.saveProfiles !== false ? profilePath : ''
            thread.context = await chromium.launchPersistentContext(actualProfilePath, contextOptions)
            thread.browser = null as any // persistent context doesn't have a separate browser object
            const page = thread.context.pages()[0] || await thread.context.newPage()

            // Check if logged in
            await page.goto('https://www.google.com')
            await page.waitForTimeout(3000)

            const isLoggedIn = await this.checkGoogleLogin(page)

            if (!isLoggedIn) {
                logToFile(`[Thread ${thread.id}] Not logged in, attempting login...`)

                // Login flow
                const loginResult = await this.performGoogleLogin(page, account.email, account.password)

                if (!loginResult.success) {
                    logToFile(`[Thread ${thread.id}] Login failed: ${loginResult.error}. Will try to proceed anyway...`)
                    // Don't throw - try to continue even without login
                    // The review might still work if there's a partial session
                }
            } else {
                logToFile(`[Thread ${thread.id}] Already logged in!`)
            }

            // Execute job based on type
            if (job.type === 'review') {
                await this.executeReviewJob(thread, page, job)
            } else if (job.type === 'traffic') {
                await this.executeTrafficJob(thread, page, job)
            }

            // Persistent context auto-saves state, no manual cookie saving needed

            // Job completed
            jobQueue.completeJob(job.id, { success: true })
            logToFile(`[Thread ${thread.id}] Job ${job.id} completed successfully`)

        } catch (error) {
            logToFile(`[Thread ${thread.id}] ERROR: Job ${job.id} failed: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`)
            thread.lastError = error instanceof Error ? error.message : 'Unknown error'
            jobQueue.failJob(job.id, thread.lastError)

        } finally {
            // Cleanup
            if (thread.context) {
                await thread.context.close().catch(() => { })
            }
            if (thread.browser) {
                await thread.browser.close().catch(() => { })
            }

            thread.status = 'idle'
            thread.currentJobId = undefined
            thread.browser = undefined
            thread.context = undefined

            // Delay before next job
            await this.delay()
            this.sendStatus()
        }
    }

    // Check if logged into Google
    private async checkGoogleLogin(page: any): Promise<boolean> {
        try {
            // Look for account avatar or menu
            const avatar = await page.$('img[aria-label*="Google"], a[aria-label*="Google Account"]')
            return avatar !== null
        } catch {
            return false
        }
    }

    // Perform Google login
    private async performGoogleLogin(page: any, email: string, password: string): Promise<{ success: boolean; error?: string }> {
        try {
            await page.goto('https://accounts.google.com/signin')
            await page.waitForTimeout(2000)

            // Enter email
            await page.fill('input[type="email"]', email)
            await page.click('button:has-text("Next"), #identifierNext')
            await page.waitForTimeout(3000)

            // Check for error
            const emailError = await page.$('text="Couldn\'t find your Google Account"')
            if (emailError) {
                return { success: false, error: 'Email not found' }
            }

            // Enter password
            await page.waitForSelector('input[type="password"]', { timeout: 10000 })
            await page.fill('input[type="password"]', password)
            await page.click('button:has-text("Next"), #passwordNext')
            await page.waitForTimeout(5000)

            // Check for password error
            const passError = await page.$('text="Wrong password"')
            if (passError) {
                return { success: false, error: 'Wrong password' }
            }

            // Check for 2FA
            const twoFA = await page.$('text="2-Step Verification"')
            if (twoFA) {
                return { success: false, error: '2FA required - please login manually first' }
            }

            // Verify login success
            await page.waitForTimeout(3000)
            const isLoggedIn = await this.checkGoogleLogin(page)

            return {
                success: isLoggedIn,
                error: isLoggedIn ? undefined : 'Login verification failed'
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Login error'
            }
        }
    }

    // Human-like typing with random delays per character
    private async humanType(page: any, element: any, text: string): Promise<void> {
        await element.click()
        await page.waitForTimeout(200 + Math.random() * 300)

        for (const char of text) {
            await page.keyboard.type(char)
            // Random delay between keystrokes: 30-100ms for normal chars, longer for spaces/punctuation
            const isSpecial = [' ', '.', ',', '!', '?', '\n'].includes(char)
            const delay = isSpecial
                ? 80 + Math.random() * 200
                : 30 + Math.random() * 70
            await page.waitForTimeout(delay)
        }
    }

    // Set star rating with specific Google Maps selectors
    private async setStarRating(page: any, rating: number): Promise<boolean> {
        // Strategy 1: Google Maps star buttons with aria-label
        const starAriaSelectors = [
            `span[aria-label*="${rating} star"]`,
            `span[aria-label*="${rating} sao"]`,
            `button[aria-label*="${rating} star"]`,
            `button[aria-label*="${rating} sao"]`,
            `div[aria-label*="${rating} star"]`,
            `div[aria-label*="${rating} sao"]`,
        ]

        for (const selector of starAriaSelectors) {
            try {
                const el = await page.$(selector)
                if (el) {
                    await el.click()
                    await page.waitForTimeout(500 + Math.random() * 500)
                    return true
                }
            } catch { /* try next */ }
        }

        // Strategy 2: Star buttons inside the review rating container
        try {
            const starButtons = await page.$$('div[jsaction*="rate"] button, div[jsaction*="rate"] span[role="radio"]')
            if (starButtons.length >= rating) {
                await starButtons[rating - 1].click()
                await page.waitForTimeout(500 + Math.random() * 500)
                return true
            }
        } catch { /* try next */ }

        // Strategy 3: Rate by data-rating attribute
        try {
            const ratingEl = await page.$(`[data-rating="${rating}"]`)
            if (ratingEl) {
                await ratingEl.click()
                await page.waitForTimeout(500 + Math.random() * 500)
                return true
            }
        } catch { /* try next */ }

        return false
    }

    // Verify review was submitted successfully
    private async verifyReviewSubmitted(page: any): Promise<{ success: boolean; error?: string }> {
        try {
            // Wait for one of these outcomes:
            // 1. Review form disappears (success)
            // 2. Success/thank you message appears
            // 3. Error message appears

            // Check for error messages first
            const errorSelectors = [
                'text="Something went wrong"',
                'text="Đã xảy ra lỗi"',
                'text="Try again"',
                'text="Thử lại"',
                'text="can\'t post"',
                'text="không thể đăng"',
            ]

            for (const selector of errorSelectors) {
                try {
                    const errorEl = await page.$(selector)
                    if (errorEl) {
                        const errorText = await errorEl.textContent()
                        return { success: false, error: `Submit error: ${errorText}` }
                    }
                } catch { /* continue */ }
            }

            // Check for success indicators
            const successSelectors = [
                'text="Your review has been posted"',
                'text="Bài đánh giá của bạn đã được đăng"',
                'text="Thanks for your review"',
                'text="Cảm ơn bạn đã đánh giá"',
                'text="Your contribution"',
            ]

            for (const selector of successSelectors) {
                try {
                    const successEl = await page.$(selector)
                    if (successEl) {
                        return { success: true }
                    }
                } catch { /* continue */ }
            }

            // Check if review form/dialog has closed (also indicates success)
            const formStillOpen = await page.$('textarea[aria-label*="review"], textarea[aria-label*="đánh giá"], div[jsaction*="rate"]')
            if (!formStillOpen) {
                return { success: true } // Form closed = submitted
            }

            // If form is still open after submit, likely failed
            return { success: false, error: 'Review form still open after submit attempt' }
        } catch (error) {
            return { success: false, error: `Verification error: ${error instanceof Error ? error.message : 'Unknown'}` }
        }
    }

    // Execute review job with full validation
    private async executeReviewJob(thread: ThreadState, page: any, job: Job): Promise<void> {
        const db = getDatabase()
        const location = await db.select().from(schema.locations)
            .where(eq(schema.locations.id, job.locationId))
            .get()

        if (!location) {
            throw new Error('Location not found')
        }

        console.log(`[Thread ${thread.id}] Reviewing: ${location.name}`)

        let reviewStatus: 'success' | 'failed' = 'failed'
        let errorMessage: string | undefined
        const rating = job.rating || 5
        let processedReviewText = ''

        if (job.reviewText) {
            processedReviewText = this.processSpintax(job.reviewText)
        } else {
            processedReviewText = ''
        }

        try {
            // Check if we should use Agentic Mode
            const ollamaStatus = await ollamaService.testConnection()
            
            if (ollamaStatus.success) {
                console.log(`[Thread ${thread.id}] 🧠 Ollama available. Using Agentic Review Handler!`)
                sendReviewProgress({
                    campaignId: job.campaignId || 0,
                    accountId: job.accountId,
                    locationId: job.locationId,
                    status: 'running',
                    message: `🧠 System using Agentic AI with ${ollamaStatus.models?.[0] || 'Ollama'} locally...`,
                    progress: 10
                })
                
                const agenticResult = await agenticReviewHandler.performReview(
                    page,
                    location.name,
                    location.url,
                    processedReviewText,
                    rating,
                    job.campaignId || 0,
                    thread.id,
                    () => this.shouldStop || this.paused
                )

                if (agenticResult.success) {
                    reviewStatus = 'success'
                    console.log(`[Thread ${thread.id}] ✅ [Agentic] Review posted successfully for ${location.name}`)
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'success',
                        message: `✅ Agentic AI successfully posted review.`,
                        progress: 100
                    })
                } else {
                    reviewStatus = 'failed'
                    errorMessage = agenticResult.error
                    console.warn(`[Thread ${thread.id}] ❌ [Agentic] Review failed: ${agenticResult.error}`)
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'error',
                        message: `❌ Agentic AI failed: ${agenticResult.error}`,
                        progress: 100
                    })
                }
            } else {
                console.log(`[Thread ${thread.id}] ⚠ Ollama offline. Falling back to linear script review.`)
                sendReviewProgress({
                    campaignId: job.campaignId || 0,
                    accountId: job.accountId,
                    locationId: job.locationId,
                    status: 'running',
                    message: `⚠ Local AI is offline. Using linear script fallback...`,
                    progress: 10
                })
                
                // Step 1: Navigate to location
                await page.goto(location.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
                await page.waitForTimeout(2000 + Math.random() * 2000)

                // Wait for page to fully load
                try {
                    await page.waitForSelector('h1.DUwDvf, h1.fontHeadlineLarge', { timeout: 15000 })
                } catch {
                    throw new Error('Location page did not load properly')
                }

                // Step 2: Find and click "Write a review" button
                const reviewButtonSelectors = [
                    'button[jsaction*="review.start"]',
                    'button[data-value="Write a review"]',
                    'button:has-text("Write a review")',
                    'button:has-text("Viết bài đánh giá")',
                    'button:has-text("Viết đánh giá")',
                    'span:has-text("Write a review")',
                    'span:has-text("Viết đánh giá")',
                ]

                let reviewButtonClicked = false
                for (const selector of reviewButtonSelectors) {
                    try {
                        const btn = await page.$(selector)
                        if (btn) {
                            await btn.click()
                            reviewButtonClicked = true
                            break
                        }
                    } catch { continue }
                }

                if (!reviewButtonClicked) {
                    throw new Error('Review button not found - account may need to be logged in or this location does not accept reviews')
                }
                await page.waitForTimeout(1500 + Math.random() * 1500)

                // Step 3: Set star rating with specific selectors
                const starSet = await this.setStarRating(page, rating)
                if (!starSet) {
                    throw new Error(`Failed to set ${rating}-star rating - star buttons not found`)
                }
                console.log(`[Thread ${thread.id}] ★ Rating set to ${rating} stars`)

                // Step 4: Enter review text with human-like typing
                if (processedReviewText) {
                    const textareaSelectors = [
                        'textarea[aria-label*="review"]',
                        'textarea[aria-label*="đánh giá"]',
                        'textarea[aria-label*="Share"]',
                        'textarea[aria-label*="Chia sẻ"]',
                        'div[contenteditable="true"]',
                        'textarea',
                    ]

                    let textEntered = false
                    for (const selector of textareaSelectors) {
                        try {
                            const textarea = await page.$(selector)
                            if (textarea) {
                                await this.humanType(page, textarea, processedReviewText)
                                textEntered = true
                                break
                            }
                        } catch { continue }
                    }

                    if (!textEntered) {
                        console.warn(`[Thread ${thread.id}] ⚠ Could not find textarea, submitting rating-only review`)
                    }
                }

	                await page.waitForTimeout(1000 + Math.random() * 1000)

	                // Step 5: Submit the review
	                const complianceSettings = loadSettings()
	                const reviewSubmitDecision = getReviewSubmissionDecision(location.url, complianceSettings)
	                if (!reviewSubmitDecision.allowed) {
	                    const manualMsg = buildManualSubmitMessage(location.url, complianceSettings)
	                    sendReviewProgress({
	                        campaignId: job.campaignId || 0,
	                        accountId: job.accountId,
	                        locationId: job.locationId,
	                        status: 'running',
	                        message: `🛑 ${manualMsg} Waiting for manual approval...`,
	                        progress: 95
	                    })
	                    const manualResult = await requestManualReviewSubmissionApproval({
	                        locationUrl: location.url,
	                        locationName: location.name,
	                        accountEmail: thread.accountEmail,
	                        campaignId: job.campaignId || 0,
	                        threadId: thread.id,
	                        reason: reviewSubmitDecision.reason,
	                    })
	                    if (!manualResult.approved) {
	                        throw new Error(`${manualMsg} (reason: ${manualResult.reason})`)
	                    }
	                    sendReviewProgress({
	                        campaignId: job.campaignId || 0,
	                        accountId: job.accountId,
	                        locationId: job.locationId,
	                        status: 'running',
	                        message: '✅ Manual approval received. Submitting review...',
	                        progress: 97
	                    })
	                }
	
	                const submitSelectors = [
	                    'button[jsaction*="submit"]',
                    'button[aria-label*="Post"]',
                    'button[aria-label*="Đăng"]',
                    'button:has-text("Post")',
                    'button:has-text("Đăng")',
                    'button:has-text("Submit")',
                    'button:has-text("Gửi")',
                ]

                let submitClicked = false
                for (const selector of submitSelectors) {
                    try {
                        const btn = await page.$(selector)
                        if (btn) {
                            await btn.click()
                            submitClicked = true
                            break
                        }
                    } catch { continue }
                }

                if (!submitClicked) {
                    throw new Error('Submit button not found')
                }

                // Step 6: Wait and verify submission
                await page.waitForTimeout(3000 + Math.random() * 2000)
                const verification = await this.verifyReviewSubmitted(page)

                if (verification.success) {
                    reviewStatus = 'success'
                    console.log(`[Thread ${thread.id}] ✅ Review posted successfully for ${location.name}`)
                } else {
                    reviewStatus = 'failed'
                    errorMessage = verification.error
                    console.warn(`[Thread ${thread.id}] ❌ Review verification failed: ${verification.error}`)
                }
            } // end else linear script fallback

        } catch (error) {
            reviewStatus = 'failed'
            errorMessage = error instanceof Error ? error.message : 'Unknown error during review'
            console.error(`[Thread ${thread.id}] ❌ Review failed for ${location.name}: ${errorMessage}`)
        }

        // Log actual result to review history
        await db.insert(schema.reviewHistory).values({
            campaignId: job.campaignId,
            accountId: job.accountId,
            locationId: job.locationId,
            rating: rating,
            reviewText: processedReviewText || job.reviewText || '',
            status: reviewStatus,
            errorMessage: errorMessage,
        })

        // If failed, throw to trigger job failure in the caller
        if (reviewStatus === 'failed') {
            throw new Error(errorMessage || 'Review failed')
        }
    }

    // Execute traffic job
    private async executeTrafficJob(thread: ThreadState, page: any, job: Job): Promise<void> {
        const db = getDatabase()
        const location = await db.select().from(schema.locations)
            .where(eq(schema.locations.id, job.locationId))
            .get()

        if (!location) {
            throw new Error('Location not found')
        }

        console.log(`[Thread ${thread.id}] Generating traffic for: ${location.name}`)

        // Navigate and scroll
        await page.goto(location.url)
        await page.waitForTimeout(3000)

        // Scroll around to generate engagement
        for (let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, 500)
            await page.waitForTimeout(1000 + Math.random() * 1000)
        }

        await page.waitForTimeout(5000)
        console.log(`[Thread ${thread.id}] Traffic generated for ${location.name}`)
    }

    // Process spintax text
    private processSpintax(text: string): string {
        return text.replace(/{([^{}]+)}/g, (match, options) => {
            const optArray = options.split('|')
            return optArray[Math.floor(Math.random() * optArray.length)]
        })
    }

    // Pause automation
    pause(): void {
        this.paused = true
        console.log('[AutomationController] Paused')
        this.sendStatus()
    }

    // Resume automation
    resume(): void {
        this.paused = false
        console.log('[AutomationController] Resumed')
        this.sendStatus()
    }

    // Stop automation
    async stop(): Promise<void> {
        console.log('[AutomationController] Stopping...')
        this.shouldStop = true
        this.running = false

        // Close all browser instances
        for (const thread of this.threads) {
            if (thread.context) {
                await thread.context.close().catch(() => { })
            }
            if (thread.browser) {
                await thread.browser.close().catch(() => { })
            }
        }

        // Cancel remaining jobs
        if (this.currentCampaignId) {
            jobQueue.cancelCampaignJobs(this.currentCampaignId)

            // Update campaign status
            const db = getDatabase()
            await db.update(schema.campaigns)
                .set({ status: 'paused' })
                .where(eq(schema.campaigns.id, this.currentCampaignId))
        }

        this.threads = []
        this.currentCampaignId = undefined
        this.sendStatus()

        console.log('[AutomationController] Stopped')
    }

    // Check if running
    isRunning(): boolean {
        return this.running
    }

    // Check if paused
    isPaused(): boolean {
        return this.paused
    }
}

// Singleton instance
export const automationController = new AutomationController()
