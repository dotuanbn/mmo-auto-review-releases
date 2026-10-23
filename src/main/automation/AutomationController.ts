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

import { BrowserContext, Page } from 'playwright'
import { jobQueue, Job, type JobTransitionResult } from './JobQueue'
import { accountService } from '../services/AccountService'
import { reviewRecoveryService } from './ReviewRecoveryService'
import { browserService } from './BrowserService'
import { BrowserResourceWaitError } from '../services/BrowserResourceGovernor'
import { googleAuthHandler } from './GoogleAuthHandler'
import { googleMapsReviewHandler } from './GoogleMapsReviewHandler'
import { proxyService } from '../services/ProxyService'
import {
    fproxyPoolService,
    type FProxyLease,
} from '../services/FProxyPoolService'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import { velocityController } from '../services/VelocityController'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { getRotatingLogger } from '../utils/RotatingLogger'
import { ollamaService } from '../services/OllamaService'
import { agenticReviewHandler } from './AgenticReviewHandler'
import { sendReviewProgress } from '../ipc/campaigns'
import { loadSettings } from '../ipc/settings'
import { accountWarmupService, type WarmupGateTier } from '../services/AccountWarmupService'
import { reviewContentGenerator } from '../services/ReviewContentGenerator'
import {
    reviewService,
    shouldUseAgenticReview,
    resolveSubmissionFinalStatus,
    resolveIntentCatchStatus,
    type SubmitAwareResult,
    type ReviewSubmissionStatus,
} from '../services/ReviewService'
import { locationService } from '../services/LocationService'
import { timeLocalityService } from '../services/TimeLocalityService'
import { accountHealthScorer } from '../services/AccountHealthScorer'
import { reviewPhotoStrategy, type PhotoDecision } from '../services/ReviewPhotoStrategy'

// Debug file logger
const LOG_FILE = join(app.getPath('userData'), 'automation-debug.log')
function logToFile(msg: string): void {
    const timestamp = new Date().toISOString()
    try {
        getRotatingLogger('automation', LOG_FILE).write(`[${timestamp}] ${msg}\n`)
    } catch { /* ignore */ }
    console.log(msg)
}

/**
 * Minimal job shape for Runtime Warmup Gate (crash-resume / concurrent workers).
 * Pure helpers below are unit-tested without spinning Electron.
 */
export interface WarmupGateJobRef {
    id: string
    accountId: number
    status: Job['status']
    createdAt: string
}

/** Non-terminal = may still execute (pending or running). Done/cancelled/failed kept as history. */
export function isWarmupNonTerminalStatus(status: Job['status']): boolean {
    return status === 'pending' || status === 'running'
}

/**
 * Deterministic keeper for throttled tier (max 1 non-terminal / account).
 * Prefer in-flight running work, then oldest createdAt, then id.
 */
export function pickThrottledWarmupKeeper(jobs: readonly WarmupGateJobRef[]): WarmupGateJobRef | null {
    const active = jobs.filter(j => isWarmupNonTerminalStatus(j.status))
    if (active.length === 0) return null
    return [...active].sort((a, b) => {
        const aRun = a.status === 'running' ? 0 : 1
        const bRun = b.status === 'running' ? 0 : 1
        if (aRun !== bRun) return aRun - bRun
        const ta = Date.parse(a.createdAt) || 0
        const tb = Date.parse(b.createdAt) || 0
        if (ta !== tb) return ta - tb
        return a.id.localeCompare(b.id)
    })[0]
}

/**
 * Select job IDs to cancel for one account under a gate tier.
 * - blocked: cancel all non-terminal
 * - throttled: keep exactly 1 keeper, cancel excess non-terminal
 * - full: cancel nothing (ready runs normally)
 * Never targets done/failed/cancelled history.
 */
export function selectWarmupJobsToCancel(
    jobs: readonly WarmupGateJobRef[],
    tier: WarmupGateTier,
    maxNonTerminal: number | null,
): string[] {
    const active = jobs.filter(j => isWarmupNonTerminalStatus(j.status))
    if (active.length === 0) return []

    if (tier === 'full' || maxNonTerminal === null) {
        return []
    }

    if (tier === 'blocked' || maxNonTerminal <= 0) {
        return active.map(j => j.id)
    }

    // throttled (or any positive cap): keep first N keepers deterministically
    const ordered = [...active].sort((a, b) => {
        const aRun = a.status === 'running' ? 0 : 1
        const bRun = b.status === 'running' ? 0 : 1
        if (aRun !== bRun) return aRun - bRun
        const ta = Date.parse(a.createdAt) || 0
        const tb = Date.parse(b.createdAt) || 0
        if (ta !== tb) return ta - tb
        return a.id.localeCompare(b.id)
    })
    const keepIds = new Set(ordered.slice(0, maxNonTerminal).map(j => j.id))
    return ordered.filter(j => !keepIds.has(j.id)).map(j => j.id)
}

/** Group campaign jobs by accountId (active + history; caller filters). */
export function groupJobsByAccount(jobs: readonly WarmupGateJobRef[]): Map<number, WarmupGateJobRef[]> {
    const map = new Map<number, WarmupGateJobRef[]>()
    for (const job of jobs) {
        const list = map.get(job.accountId)
        if (list) list.push(job)
        else map.set(job.accountId, [job])
    }
    return map
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
    contextId?: number
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
    private readonly proxyAcquireControllers = new Set<AbortController>()
    /** Throttle "all remaining jobs are in cross-account cooldown" logs. */
    private cooldownWaitLogAt = 0

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
            let threadCount = globalSettings.maxConcurrentBrowsers || 3
            if (globalSettings.useProxy === true) {
                try {
                    const poolSnapshot = await fproxyPoolService.getSnapshot()
                    const enabledSlots = poolSnapshot.slots.filter(slot => slot.enabled && slot.hasSecret).length
                    if (enabledSlots > 0 && poolSnapshot.policy.strictUnique) {
                        const before = threadCount
                        threadCount = Math.max(1, Math.min(threadCount, enabledSlots))
                        if (threadCount !== before) {
                            logToFile(
                                `[loadConfig] FProxy strict pool capacity clamp threads ${before} -> ${threadCount} ` +
                                `(enabledSlots=${enabledSlots})`,
                            )
                        }
                    }
                } catch (error) {
                    logToFile(
                        `[loadConfig] FProxy pool capacity check skipped: ` +
                        `${error instanceof Error ? error.message : String(error)}`,
                    )
                }
            }

            this.config = {
                threads: threadCount,
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

            logToFile(`[loadConfig] Config loaded. profilesPath: ${this.config.profilesPath}, headless: ${this.config.headless}, threads: ${this.config.threads}`)
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
        const stats = jobQueue.getStats(this.currentCampaignId)

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

    /**
     * Deterministic resume after crash recovery: only pending durable jobs.
     * Never re-creates completed work. Does not touch TrafficBoostEngine.
     */
    async resumeCampaign(campaignId: number): Promise<{ success: boolean; error?: string }> {
        if (this.running) {
            return { success: false, error: 'Automation is already running' }
        }

        try {
            await this.loadConfig()
            await jobQueue.ensureLoaded()

            if (!this.isWithinWorkingHours()) {
                return {
                    success: false,
                    error: `Outside working hours (${this.config.workingHoursStart} - ${this.config.workingHoursEnd})`,
                }
            }

            const plan = await reviewRecoveryService.getResumePlan(campaignId)
            if (!plan.canResume) {
                return { success: false, error: plan.reason || 'Nothing to resume' }
            }

            return await this.beginWorkerLoop(campaignId, plan.pendingJobs + plan.doneJobs, plan.pendingJobs)
        } catch (error) {
            console.error('[AutomationController] Failed to resume campaign:', error)
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    // Start automation for a campaign (durable enqueue; skips done pairs)
    async startCampaign(campaignId: number): Promise<{ success: boolean; error?: string }> {
        if (this.running) {
            return { success: false, error: 'Automation is already running' }
        }

        try {
            await this.loadConfig()
            await jobQueue.ensureLoaded()
            logToFile(`[startCampaign] Config loaded. Working hours: ${this.config.workingHoursStart}-${this.config.workingHoursEnd}`)
            logToFile(`[startCampaign] Current time: ${new Date().toTimeString().slice(0, 5)}, within hours: ${this.isWithinWorkingHours()}`)

            if (!this.isWithinWorkingHours()) {
                logToFile(`[startCampaign] BLOCKED: Outside working hours!`)
                return { success: false, error: `Outside working hours (${this.config.workingHoursStart} - ${this.config.workingHoursEnd})` }
            }

            const prepared = await this.prepareCampaignJobs(campaignId)
            if (!prepared.success) {
                return { success: false, error: prepared.error }
            }

            return await this.beginWorkerLoop(
                campaignId,
                prepared.totalJobs,
                prepared.pendingJobs,
            )
        } catch (error) {
            console.error('[AutomationController] Failed to start campaign:', error)
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }
        }
    }

    /** Parse campaign, enqueue missing review jobs, skip already done/pending pairs. */
    private async prepareCampaignJobs(campaignId: number): Promise<{
        success: boolean
        error?: string
        totalJobs: number
        pendingJobs: number
        accountCount: number
    }> {
        const db = getDatabase()
        const campaign = await db.select().from(schema.campaigns)
            .where(eq(schema.campaigns.id, campaignId))
            .get()

        if (!campaign) {
            return { success: false, error: 'Campaign not found', totalJobs: 0, pendingJobs: 0, accountCount: 0 }
        }

        const locationIds: number[] = JSON.parse(campaign.locationIds || '[]')
        const accountIds: number[] = JSON.parse(campaign.accountIds || '[]')

        logToFile(`[AutomationController] Campaign ${campaignId}: locationIds=${JSON.stringify(locationIds)}, accountIds=${JSON.stringify(accountIds)}`)

        if (locationIds.length === 0) {
            return { success: false, error: 'No locations in campaign', totalJobs: 0, pendingJobs: 0, accountCount: 0 }
        }

        const accounts = await this.resolveCampaignAccounts(accountIds)
        logToFile(`[AutomationController] Found ${accounts.length} accounts: ${accounts.map(a => `${a.email}(${a.status})`).join(', ')}`)

        if (accounts.length === 0) {
            return {
                success: false,
                error: 'No accounts available. Please add accounts first.',
                totalJobs: 0,
                pendingJobs: 0,
                accountCount: 0,
            }
        }

        const reviewTemplates = this.parseReviewTemplates(campaign.reviewTemplates)
        logToFile(`[AutomationController] Review templates (${reviewTemplates.length}): ${reviewTemplates.map(t => t.substring(0, 30)).join(' | ')}`)

        const locations = await db.select().from(schema.locations).all()
        const campaignLocations = locations
            .filter(l => locationIds.includes(l.id))
            .map(l => ({
                id: l.id,
                reviewText: reviewTemplates.length > 0
                    ? reviewTemplates[Math.floor(Math.random() * reviewTemplates.length)]
                    : '',
                rating: campaign.rating,
            }))

        logToFile(`[AutomationController] Campaign locations: ${campaignLocations.map(l => `loc=${l.id}, text="${l.reviewText?.substring(0, 20)}..."`).join(', ')}`)

        if (campaignLocations.length === 0) {
            return {
                success: false,
                error: 'No matching locations found in database',
                totalJobs: 0,
                pendingJobs: 0,
                accountCount: accounts.length,
            }
        }

        const existingPending = jobQueue.getPendingCountForCampaign(campaignId)
        const gated = await this.applyWarmupGateToAccounts(
            campaignId,
            accounts.map(a => ({ id: a.id, email: a.email })),
            campaignLocations,
        )

        const newJobs = await jobQueue.addCampaignJobs(
            campaignId,
            'review',
            gated.fullAccountIds,
            campaignLocations,
            0
        )

        // Mid-warmup accounts: max 1 pending job total (across prior + new)
        const throttledJobs = await this.enqueueThrottledWarmupJobs(
            campaignId,
            gated.throttledAccounts,
            campaignLocations,
        )

        const pendingJobs = jobQueue.getPendingCountForCampaign(campaignId)
        const allCampaignJobs = jobQueue.getCampaignJobs(campaignId)
        const totalJobs = allCampaignJobs.filter(j => j.status !== 'cancelled').length

        logToFile(
            `[AutomationController] Created ${newJobs.length + throttledJobs} new jobs ` +
            `(full=${newJobs.length}, throttled=${throttledJobs}, blocked=${gated.blockedCount}); ` +
            `pending=${pendingJobs}; priorPending=${existingPending}`
        )

        if (pendingJobs === 0) {
            const createdAny = newJobs.length + throttledJobs > 0
            let emptyReason = 'No pending jobs available'
            if (existingPending === 0 && !createdAny) {
                emptyReason =
                    gated.enforce && gated.blockedCount > 0 && gated.fullAccountIds.length === 0 && gated.throttledAccounts.length === 0
                        ? `No jobs to run — all ${gated.blockedCount} account(s) blocked by warmup gate (level < 25)`
                        : 'No jobs to run — all pairs already completed or accounts hit daily limit'
            }
            return {
                success: false,
                error: emptyReason,
                totalJobs,
                pendingJobs: 0,
                accountCount: accounts.length,
            }
        }

        return {
            success: true,
            totalJobs,
            pendingJobs,
            accountCount: accounts.length,
        }
    }

    private async resolveCampaignAccounts(accountIds: number[]): Promise<Array<{ id: number; email: string; status: string }>> {
        const db = getDatabase()
        const all = await db.select().from(schema.accounts).all()
        let candidates: typeof all
        if (accountIds.length > 0) {
            candidates = all.filter(a => accountIds.includes(a.id))
        } else {
            candidates = all.filter(a => a.status !== 'banned' && a.status !== 'suspended')
        }

        // Sprint 3: filter out accounts that should rest (health-based rotation)
        const settings = loadSettings()
        if (settings.enableAccountHealth !== false && candidates.length > 1) {
            try {
                const healthMap = await accountHealthScorer.evaluateAll()
                const filtered = candidates.filter(a => {
                    const h = healthMap.get(a.id)
                    if (!h) return true // unknown health = allow
                    if (h.shouldRest) {
                        logToFile(`[AccountHealth] Resting account ${a.email} (score=${h.score}, grade=${h.grade}, restDays=${h.restDays})`)
                        return false
                    }
                    return true
                })
                // Sort by health score descending (healthiest first)
                filtered.sort((a, b) => {
                    const ha = healthMap.get(a.id)?.score ?? 50
                    const hb = healthMap.get(b.id)?.score ?? 50
                    return hb - ha
                })
                if (filtered.length > 0) {
                    candidates = filtered
                } else {
                    logToFile(`[AccountHealth] All accounts need rest — proceeding with original list to avoid deadlock`)
                }
            } catch (err) {
                logToFile(`[AccountHealth] Evaluation failed (proceeding without filter): ${err instanceof Error ? err.message : String(err)}`)
            }
        }

        return candidates
    }

    /**
     * Active review warmup gate (Phase 2).
     * Only enforces when loadSettings().enforceAccountWarmup === true (default false = legacy).
     * - level < 25: blocked (no new jobs)
     * - level 25-54: throttled (max 1 pending job/account)
     * - level >= 55: full
     */
    private async applyWarmupGateToAccounts(
        campaignId: number,
        accounts: Array<{ id: number; email: string }>,
        _locations: Array<{ id: number }>,
    ): Promise<{
        fullAccountIds: number[]
        throttledAccounts: Array<{ id: number; email: string }>
        blockedCount: number
        enforce: boolean
    }> {
        const settings = loadSettings()
        const enforce = settings.enforceAccountWarmup === true

        if (!enforce) {
            logToFile(
                `[WarmupGate] campaign=${campaignId} enforceAccountWarmup=false — legacy path, no gate`
            )
            return {
                fullAccountIds: accounts.map(a => a.id),
                throttledAccounts: [],
                blockedCount: 0,
                enforce: false,
            }
        }

        const fullAccountIds: number[] = []
        const throttledAccounts: Array<{ id: number; email: string }> = []
        let blockedCount = 0

        for (const account of accounts) {
            const decision = await accountWarmupService.evaluateReviewGateForAccount(account.id, true)
            if (decision.tier === 'blocked' || !decision.allowed) {
                blockedCount++
                logToFile(
                    `[WarmupGate] SKIP account=${account.id} (${account.email}) — ${decision.reason}`
                )
                continue
            }
            if (decision.tier === 'throttled') {
                throttledAccounts.push(account)
                logToFile(
                    `[WarmupGate] THROTTLE account=${account.id} (${account.email}) — ${decision.reason}`
                )
                continue
            }
            fullAccountIds.push(account.id)
            logToFile(
                `[WarmupGate] FULL account=${account.id} (${account.email}) — ${decision.reason}`
            )
        }

        logToFile(
            `[WarmupGate] campaign=${campaignId} enforce=true ` +
            `full=${fullAccountIds.length} throttled=${throttledAccounts.length} blocked=${blockedCount}`
        )

        return { fullAccountIds, throttledAccounts, blockedCount, enforce: true }
    }

    /** Enqueue at most one pending job per mid-warmup account. */
    private async enqueueThrottledWarmupJobs(
        campaignId: number,
        throttledAccounts: Array<{ id: number; email: string }>,
        locations: Array<{ id: number; reviewText?: string; rating?: number }>,
    ): Promise<number> {
        if (throttledAccounts.length === 0 || locations.length === 0) return 0

        const stats = jobQueue.getStats(campaignId)
        let created = 0

        for (const account of throttledAccounts) {
            const pendingForAccount = stats.byAccount.get(account.id)?.pending ?? 0
            if (pendingForAccount >= 1) {
                logToFile(
                    `[WarmupGate] THROTTLE skip enqueue account=${account.id} ` +
                    `(${account.email}) — already has ${pendingForAccount} pending`
                )
                continue
            }

            const singleLocation = [locations[0]]
            const jobs = await jobQueue.addCampaignJobs(
                campaignId,
                'review',
                [account.id],
                singleLocation,
                0,
            )
            created += jobs.length
            // Refresh local view of pending so subsequent accounts in this loop are accurate
            const refreshed = jobQueue.getStats(campaignId).byAccount.get(account.id)
            if (refreshed) {
                stats.byAccount.set(account.id, refreshed)
            }
            logToFile(
                `[WarmupGate] THROTTLE enqueued ${jobs.length} job(s) for account=${account.id} (${account.email})`
            )
        }

        return created
    }

    private parseReviewTemplates(raw: string | null | undefined): string[] {
        try {
            const parsed = JSON.parse(raw || '[]')
            return Array.isArray(parsed)
                ? parsed.filter((t: string) => t && t.trim())
                : [String(parsed)]
        } catch {
            if (raw && raw.trim()) return [raw]
            return []
        }
    }

    /**
     * Runtime Warmup Gate prune (P0 crash-resume safety).
     * When enforceAccountWarmup=true:
     * - blocked (<25): cancel all non-terminal jobs for account
     * - throttled (25-54): keep max 1 non-terminal / account, cancel excess pending
     * - full (>=55): no cancel
     * Done/cancelled history is never rewritten. Safe vs concurrent cancelJob state machine.
     */
    private async pruneWarmupGateJobsForCampaign(campaignId: number): Promise<number> {
        const settings = loadSettings()
        if (settings.enforceAccountWarmup !== true) {
            return 0
        }

        const campaignJobs = jobQueue.getCampaignJobs(campaignId)
        const refs: WarmupGateJobRef[] = campaignJobs.map(j => ({
            id: j.id,
            accountId: j.accountId,
            status: j.status,
            createdAt: j.createdAt,
        }))
        const byAccount = groupJobsByAccount(refs)
        let cancelled = 0

        const accountEntries = Array.from(byAccount.entries())
        for (let i = 0; i < accountEntries.length; i++) {
            const accountId = accountEntries[i][0]
            const accountJobs = accountEntries[i][1]
            const activeCount = accountJobs.filter(
                (j: WarmupGateJobRef) => isWarmupNonTerminalStatus(j.status),
            ).length
            if (activeCount === 0) continue

            const gate = await accountWarmupService.evaluateReviewGateForAccount(accountId, true)
            const toCancel = selectWarmupJobsToCancel(
                accountJobs,
                gate.tier,
                gate.maxPendingJobs,
            )
            if (toCancel.length === 0) continue

            for (const jobId of toCancel) {
                const result = await jobQueue.cancelJob(jobId)
                if (result.applied && result.status === 'cancelled') {
                    cancelled++
                }
            }
            logToFile(
                `[WarmupGate] prune campaign=${campaignId} account=${accountId} ` +
                `tier=${gate.tier} cancelled=${toCancel.length} keeper_cap=${gate.maxPendingJobs ?? 'none'} ` +
                `reason=${gate.reason}`
            )
        }

        if (cancelled > 0) {
            logToFile(
                `[WarmupGate] prune campaign=${campaignId} totalCancelled=${cancelled} (done history kept)`
            )
        }
        return cancelled
    }

    /** Shared start path for fresh start and crash resume. */
    private async beginWorkerLoop(
        campaignId: number,
        totalJobs: number,
        pendingJobs: number,
    ): Promise<{ success: boolean; error?: string }> {
        const db = getDatabase()

        // Before workers claim jobs: enforce throttled cap / blocked cancel on durable pending
        // (covers crash-resume of pre-gate multi-job queues for level 25-54)
        const pruned = await this.pruneWarmupGateJobsForCampaign(campaignId)
        const effectivePending = Math.max(0, pendingJobs - pruned)

        this.currentCampaignId = campaignId
        this.running = true
        this.shouldStop = false
        this.paused = false

        await db.update(schema.campaigns)
            .set({
                status: 'running',
                totalReviews: totalJobs > 0 ? totalJobs : effectivePending,
            })
            .where(eq(schema.campaigns.id, campaignId))

        this.initializeThreads()
        this.runWorkerLoop()
        this.sendStatus()

        console.log(
            `[AutomationController] ✅ Campaign ${campaignId} worker started ` +
            `(pending=${effectivePending}, totalTracked=${totalJobs}, warmupPruned=${pruned})`
        )
        return { success: true }
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

            // Atomic claim: pending → running under JobQueue exclusivity (owner-only run/fail).
            // Locations with a recent success from any account are not claimed; another job is preferred.
            let job: Job | null
            const disallowedLocations = this.listCrossAccountCooldownLocationIds()
            try {
                job = await jobQueue.claimNextJob(this.currentCampaignId, {
                    disallowRecentlyReviewedLocations: disallowedLocations,
                })
            } catch (error) {
                logToFile(
                    `[AutomationController] Failed to claim next job: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                )
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }

            if (!job) {
                if (
                    disallowedLocations.length > 0 &&
                    !jobQueue.isEmpty(this.currentCampaignId)
                ) {
                    const nowMs = Date.now()
                    if (nowMs - this.cooldownWaitLogAt >= 60_000) {
                        this.cooldownWaitLogAt = nowMs
                        console.warn(
                            `[AutomationController] Waiting — cross-account cooldown on ` +
                            `${disallowedLocations.length} location(s); eligible jobs will run when the window clears`
                        )
                    }
                }
                // Check if all done (no pending left — do not cancel completed work)
                if (
                    jobQueue.isEmpty(this.currentCampaignId) &&
                    jobQueue.getRunningCount(this.currentCampaignId) === 0
                ) {
                    logToFile('[AutomationController] All jobs completed!')
                    await this.finishCampaignNaturally()
                    break
                }
                await new Promise(resolve => setTimeout(resolve, 1000))
                continue
            }

            // Assign claimed job to first idle thread (already running in queue)
            const thread = idleThreads[0]
            this.runJobOnThread(thread, job)
        }
    }

    // Run a job on a specific thread (job must already be claimed/running)
    private async runJobOnThread(thread: ThreadState, job: Job): Promise<void> {
        // Guard: never re-run completed durable jobs; only owner of a claimed running job proceeds
        if (job.status === 'done' || job.status === 'cancelled' || job.status === 'failed') {
            logToFile(`[Thread ${thread.id}] Skip terminal job ${job.id} (${job.status})`)
            return
        }
        if (job.status !== 'running') {
            logToFile(
                `[Thread ${thread.id}] Skip non-owned job ${job.id} (status=${job.status}; expected claimNextJob → running)`,
            )
            return
        }

        thread.status = 'running'
        thread.currentJobId = job.id
        this.sendStatus()

        let proxyLease: FProxyLease | null = null
        let proxyLeaseAbortHandler: (() => void) | null = null
        try {
            const account = await accountService.getById(job.accountId)

            if (!account) {
                throw new Error('Account not found')
            }

            // Early review gate BEFORE browser/login: idempotent complete or permanent
            // terminal fail (no re-enqueue). Avoids browser churn on unconfirmed restart.
            if (job.type === 'review') {
                const earlyGate = await reviewService.evaluateSubmissionGateForPair(
                    job.campaignId,
                    job.accountId,
                    job.locationId,
                )
                if (earlyGate.action === 'idempotent_complete') {
                    logToFile(
                        `[Thread ${thread.id}] Early idempotent skip job=${job.id} — ` +
                        `reviewHistory success (no browser)`,
                    )
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'success',
                        message: 'Already reviewed successfully — skipping re-post',
                        progress: 100,
                    })
                    const completed = await jobQueue.completeJob(job.id, { success: true })
                    logToFile(
                        `[Thread ${thread.id}] Job ${job.id} completed (idempotent skip, no browser)` +
                        `${completed.applied ? '' : ` (complete not applied: ${completed.reason || completed.status})`}`,
                    )
                    return
                }
                if (earlyGate.action === 'block_manual_reconcile') {
                    const reason = earlyGate.reason
                        || 'Manual reconciliation required — auto re-post blocked'
                    logToFile(
                        `[Thread ${thread.id}] Early BLOCK job=${job.id} intent=${earlyGate.intentId} ` +
                        `status=${earlyGate.status} → permanent failed (no browser/re-enqueue): ${reason}`,
                    )
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'error',
                        message: reason,
                        progress: 100,
                    })
                    // Permanent failed (not cancel): cancelled is NOT in BLOCKING_STATUSES
                    await this.failJobTerminalNoRetry(job.id, reason)
                    thread.lastError = reason
                    return
                }

                // Another account reviewed this location recently — wait, do not fail the job.
                if (await this.deferClaimedJobForCrossAccountCooldown(thread, job)) {
                    return
                }
            }

            // Runtime warmup gate: blocked cancel; throttled max 1 non-terminal/account;
            // full/ready proceeds. Concurrent-safe via cancelJob state machine + deterministic keeper.
            const gateSettings = loadSettings()
            if (gateSettings.enforceAccountWarmup === true) {
                const gate = await accountWarmupService.evaluateReviewGateForAccount(account.id, true)
                const accountJobRefs: WarmupGateJobRef[] = jobQueue
                    .getCampaignJobs(job.campaignId ?? this.currentCampaignId ?? 0)
                    .filter(j => j.accountId === account.id)
                    .map(j => ({
                        id: j.id,
                        accountId: j.accountId,
                        status: j.status,
                        createdAt: j.createdAt,
                    }))

                const toCancel = selectWarmupJobsToCancel(
                    accountJobRefs,
                    gate.tier,
                    gate.maxPendingJobs,
                )

                // Cancel excess (or all if blocked) — never touches done history
                for (const cancelId of toCancel) {
                    await jobQueue.cancelJob(cancelId)
                }

                if (toCancel.includes(job.id) || !gate.allowed || gate.tier === 'blocked') {
                    logToFile(
                        `[WarmupGate] runtime SKIP job=${job.id} account=${account.id} (${account.email}) ` +
                        `tier=${gate.tier} cancelledPeers=${toCancel.length} — ${gate.reason}`
                    )
                    // Ensure current job is terminal if not already cancelled above
                    if (!toCancel.includes(job.id)) {
                        await jobQueue.cancelJob(job.id)
                    }
                    thread.status = 'idle'
                    thread.currentJobId = undefined
                    thread.accountId = undefined
                    thread.accountEmail = undefined
                    this.sendStatus()
                    return
                }

                logToFile(
                    `[WarmupGate] runtime ALLOW job=${job.id} account=${account.id} ` +
                    `tier=${gate.tier} level=${gate.warmupLevel} prunedPeers=${toCancel.length}`
                )
            }

            thread.accountId = account.id
            thread.accountEmail = account.email
            this.sendStatus()

            const globalSettings = loadSettings()
            let proxy = null
            if (this.config.proxyMode !== 'none') {
                const poolSnapshot = await fproxyPoolService.getSnapshot()
                const hasEnabledPool = globalSettings.useProxy === true
                    && poolSnapshot.slots.some(slot => slot.enabled && slot.hasSecret)

                if (hasEnabledPool) {
                    const acquireController = new AbortController()
                    this.proxyAcquireControllers.add(acquireController)
                    try {
                        proxyLease = await fproxyPoolService.acquire({
                            owner: {
                                kind: 'automation_job',
                                id: `campaign-${job.campaignId ?? 0}:account-${account.id}`,
                                threadId: thread.id,
                            },
                            timeoutMs: 180_000,
                            minRemainingMs: 60_000,
                            signal: acquireController.signal,
                        })
                    } finally {
                        this.proxyAcquireControllers.delete(acquireController)
                    }
                    proxy = proxyLease.proxySnapshot
                    logToFile(
                        `[Thread ${thread.id}] FProxy slot ${proxyLease.slotId} leased ` +
                        `(egress ${proxyLease.observedIp})`,
                    )
                } else {
                    const proxies = await proxyService.getActive()
                    if (proxies.length > 0) {
                        proxy = proxies[thread.id % proxies.length]
                    }
                }
            }

            let profilePath = account.profilePath
            if (!profilePath || !existsSync(profilePath)) {
                const emailClean = account.email.replace(/[@.]/g, '_')
                const legacyPath = join(this.config.profilesPath, `profile_${account.id}_${emailClean}`)
                if (existsSync(legacyPath)) {
                    profilePath = legacyPath
                    logToFile(`[Thread ${thread.id}] Using legacy profile: ${legacyPath}`)
                } else {
                    profilePath = this.getAccountProfilePath(account.id)
                    logToFile(`[Thread ${thread.id}] Using new profile: ${profilePath}`)
                }
            } else {
                logToFile(`[Thread ${thread.id}] Using stored profile: ${profilePath}`)
            }

            logToFile(`[Thread ${thread.id}] Starting job ${job.id} for ${account.email}`)
            logToFile(`[Thread ${thread.id}] Profile: ${profilePath}`)

            const browserConfig = {
                shouldAbort: () => this.isAbortRequested() || Boolean(proxyLease?.signal.aborted),
                viewport: globalSettings.randomizeViewport ? browserService.getRandomViewport() : { width: 1366, height: 768 },
                userAgent: globalSettings.randomizeUserAgent ? browserService.getRandomUserAgent() : undefined,
                headless: globalSettings.headless ?? false,
                ...(globalSettings.saveProfiles !== false ? { profilePath } : {}),
                ...(proxy ? {
                    proxy: {
                        host: proxy.host,
                        port: proxy.port,
                        username: proxy.username || undefined,
                        password: proxy.password || undefined,
                        type: proxy.type || 'http',
                    },
                } : {}),
            }

            thread.contextId = globalSettings.saveProfiles !== false
                ? await browserService.createContext(browserConfig)
                : await browserService.createEphemeralContext(browserConfig)
            if (proxyLease) {
                proxyLeaseAbortHandler = () => {
                    const contextId = thread.contextId
                    if (contextId != null) {
                        void browserService.closeContext(contextId).catch(() => { })
                    }
                }
                proxyLease.signal.addEventListener('abort', proxyLeaseAbortHandler, { once: true })
            }
            thread.context = browserService.getContext(thread.contextId)
            let page = browserService.getPage(thread.contextId)
            if (!thread.context || !page) {
                throw new Error('Browser context initialization failed')
            }

            // Abort after context creation — stop must not continue to post
            this.assertNotAborted(`Thread ${thread.id}`)

            await page.goto('https://www.google.com')
            await page.waitForTimeout(3000)

            // Strict cookie auth (SAPISID+SID) — no avatar heuristics
            let isLoggedIn = await browserService.isGoogleLoggedIn(thread.contextId).catch(() => false)

            if (!isLoggedIn) {
                logToFile(`[Thread ${thread.id}] Not logged in (isGoogleLoggedIn=false), hardened GoogleAuthHandler login...`)
                // Free profile lock before login creates a new context on the same path
                if (thread.contextId != null) {
                    await browserService.closeContext(thread.contextId).catch(() => { })
                }
                thread.contextId = undefined
                thread.context = undefined

                const loginResult = await googleAuthHandler.login(
                    account.email,
                    account.password,
                    browserConfig,
                    account.twoFactorSecret || undefined,
                    account.recoveryEmail || undefined,
                    account.recoveryPhone || undefined,
                )

                if (!loginResult.success || loginResult.contextId < 0) {
                    const err = loginResult.error || 'Google login failed'
                    logToFile(`[Thread ${thread.id}] Login failed — failing job (no submit): ${err}`)
                    throw new Error(`Google login failed: ${err}`)
                }

                thread.contextId = loginResult.contextId
                thread.context = browserService.getContext(thread.contextId)
                page = browserService.getPage(thread.contextId)
                if (!thread.context || !page) {
                    throw new Error('Browser context missing after login')
                }

                isLoggedIn = await browserService.isGoogleLoggedIn(thread.contextId).catch(() => false)
                if (!isLoggedIn) {
                    throw new Error('Google login verification failed (strict cookies missing)')
                }

                if (profilePath && globalSettings.saveProfiles !== false) {
                    await googleAuthHandler.saveSession(thread.contextId, profilePath).catch(() => { })
                }
                logToFile(`[Thread ${thread.id}] Hardened login succeeded for ${account.email}`)
            } else {
                logToFile(`[Thread ${thread.id}] Already logged in (strict cookies OK)`)
            }

            this.assertNotAborted(`Thread ${thread.id}`)

            let alreadySucceeded = false
            if (job.type === 'review') {
                const reviewOutcome = await this.executeReviewJob(thread, page, job)
                alreadySucceeded = reviewOutcome.alreadySucceeded === true

                // Cooldown lost the race during login — release the claim, do not post or fail.
                // executeReviewJob already logged the warning; do not re-check (a second
                // read could disagree and leave the job stuck in running).
                if (reviewOutcome.deferredCrossAccount === true) {
                    await this.releaseDeferredReviewJob(thread, job)
                    return
                }

                // Sprint 3: night-time locality block — defer to golden hours
                if (reviewOutcome.deferredTimeLocality === true) {
                    await this.releaseDeferredReviewJob(thread, job)
                    return
                }

                // Existing submitting/unconfirmed OR new unconfirmed after submitAttempted:
                // permanent failed (not cancel) — cancelled is re-enqueued on restart churn.
                // review_history gate still blocks auto re-post.
                if (reviewOutcome.blockedManualReconcile === true) {
                    const reason = reviewOutcome.blockReason
                        || 'Manual reconciliation required — auto re-post blocked'
                    logToFile(
                        `[Thread ${thread.id}] Terminal-fail job ${job.id} (no retry/re-enqueue): ${reason}`,
                    )
                    await this.failJobTerminalNoRetry(job.id, reason)
                    thread.lastError = reason
                    // Do not bump campaign failed counters (unknown Google outcome / manual reconcile)
                    return
                }
            } else if (job.type === 'traffic') {
                await this.executeTrafficJob(thread, page, job)
            }

            const completed = await jobQueue.completeJob(job.id, { success: true })
            // Bump campaign success only when this owner applied a fresh done transition
            if (
                completed.applied
                && completed.status === 'done'
                && completed.reason !== 'already_done'
                && !alreadySucceeded
            ) {
                await this.bumpCampaignCounters(job.campaignId, 'success')
            }
            logToFile(
                `[Thread ${thread.id}] Job ${job.id} completed` +
                `${alreadySucceeded ? ' (idempotent skip)' : ''}` +
                `${completed.applied ? '' : ` (complete not applied: ${completed.reason || completed.status})`}`,
            )

        } catch (error) {
            if (error instanceof BrowserResourceWaitError) {
                await jobQueue.deferRunningJob(job.id)
                logToFile(`[Thread ${thread.id}] Job ${job.id} deferred while waiting for PC resources`)
                return
            }
            logToFile(`[Thread ${thread.id}] ERROR: Job ${job.id} failed: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`)
            thread.lastError = error instanceof Error ? error.message : 'Unknown error'
            // Only the claim owner can fail a running job; terminal/cancel wins over stale fail
            const failed = await jobQueue.failJob(job.id, thread.lastError)
            if (failed.applied && failed.status === 'failed') {
                await this.bumpCampaignCounters(job.campaignId, 'failed')
            }

        } finally {
            if (thread.contextId != null) {
                await browserService.closeContext(thread.contextId).catch(() => { })
            } else if (thread.context) {
                await thread.context.close().catch(() => { })
            }
            if (proxyLease && proxyLeaseAbortHandler) {
                proxyLease.signal.removeEventListener('abort', proxyLeaseAbortHandler)
            }
            await proxyLease?.release('automation_job_finished')

            thread.status = 'idle'
            thread.currentJobId = undefined
            thread.contextId = undefined
            thread.context = undefined

            await this.delay()
            this.sendStatus()
        }
    }

    private async bumpCampaignCounters(
        campaignId: number | undefined,
        kind: 'success' | 'failed'
    ): Promise<void> {
        if (!campaignId) return
        try {
            // Atomic SQL increment (avoids read-modify-write races across threads)
            if (kind === 'success') {
                await reviewService.incrementCampaignSuccessReviews(campaignId)
            } else {
                await reviewService.incrementCampaignFailedReviews(campaignId)
            }
        } catch (error) {
            console.error('[AutomationController] Failed to bump campaign counters:', error)
        }
    }

    private assertNotAborted(context: string): void {
        if (this.shouldStop || this.paused) {
            throw new Error(`${context}: aborted (stop/pause) before continue`)
        }
    }

    private isAbortRequested(): boolean {
        return this.shouldStop || this.paused
    }

    /**
     * Permanent fail without pending retry requeue.
     * JobQueue.failJob retries while retryCount < maxRetries; raise retryCount so
     * the next fail is terminal `failed` (blocks re-enqueue). Prefer over cancelJob:
     * cancelled is NOT in JobQueue BLOCKING_STATUSES → re-enqueue churn on restart.
     * Does not bump campaign failed counters (caller decides).
     */
    private async failJobTerminalNoRetry(
        jobId: string,
        error: string,
    ): Promise<JobTransitionResult> {
        return jobQueue.markJobPermanentlyFailed(jobId, error)
    }

    /**
     * Linear review via shared GoogleMapsReviewHandler.postReview (no duplicated DOM logic).
     * Coordinates with handler contract: optional submitAttempted on PostReviewResult.
     */
    private async runLinearPostReview(
        thread: ThreadState,
        job: Job,
        locationUrl: string,
        rating: number,
        reviewText: string,
        photoDecision?: PhotoDecision | null,
    ): Promise<SubmitAwareResult> {
        if (thread.contextId == null) {
            return { success: false, submitAttempted: false, error: 'No browser context for linear review' }
        }
        this.assertNotAborted(`Thread ${thread.id}`)

        // Sprint 3: use smart photo decision when available
        const effectiveMaxPhotos = photoDecision?.shouldAttach
            ? photoDecision.maxPhotos
            : (photoDecision === null ? 1 : 0) // null = no decision (legacy) → 1; explicit skip → 0

        const result = await googleMapsReviewHandler.postReview(
            thread.contextId,
            locationUrl,
            rating,
            reviewText,
            {
                accountKey: String(job.accountId),
                campaignId: job.campaignId != null ? String(job.campaignId) : undefined,
                maxPhotos: effectiveMaxPhotos,
                shouldAbort: () => this.isAbortRequested(),
            },
        )

        const submitAware = result as SubmitAwareResult
        return {
            success: result.success,
            error: result.error,
            screenshot: result.screenshot,
            // Handler worker adds submitAttempted; success implies submit was attempted
            submitAttempted: submitAware.submitAttempted ?? (result.success ? true : undefined),
        }
    }

    /**
     * Read submitAttempted from handler result (AgenticReviewResult / PostReviewResult contract).
     * success always implies submit was attempted.
     */
    private readSubmitAttempted(result: SubmitAwareResult): boolean | undefined {
        if (result.success) return true
        if (typeof result.submitAttempted === 'boolean') return result.submitAttempted
        return undefined
    }

    /**
     * Cooldown length in minutes. Missing or non-numeric settings fall back to 120.
     * Zero or negative disables the window.
     */
    private readCrossAccountCooldownMinutes(): number {
        return velocityController.readCooldownMinutes()
    }

    /**
     * True when no other account has a successful review for this location inside
     * the cooldown window. Sync because better-sqlite3 queries are synchronous.
     * Check failures allow the review (do not block the queue on a bad read).
     */
    checkCrossAccountCooldown(locationId: number, currentAccountId: number): boolean {
        try {
            const minutes = this.readCrossAccountCooldownMinutes()
            const decision = velocityController.checkCooldown(locationId, currentAccountId)
            if (decision.allowed) return true

            const count = decision.recentSuccessCount ?? 0
            console.warn(
                `[AutomationController] Cross-account cooldown: location ${locationId} has ` +
                `${count} recent success review(s) from other accounts (window ${minutes}m); ` +
                `account ${currentAccountId} must wait`
            )
            return false
        } catch (error: unknown) {
            console.warn(
                '[AutomationController] Cross-account cooldown check failed; allowing review:',
                error
            )
            return true
        }
    }

    /**
     * Location ids with any recent successful review. Passed into JobQueue so those
     * review jobs are skipped (not failed) until the cooldown window clears.
     * Empty when the check cannot run.
     */
    private listCrossAccountCooldownLocationIds(): number[] {
        try {
            return velocityController.getCooldownLocationIds()
        } catch (error: unknown) {
            console.warn(
                '[AutomationController] Failed to list cross-account cooldown locations; allowing claims:',
                error
            )
            return []
        }
    }

    /**
     * If the claimed review must wait, put it back to pending (no retry bump) and
     * return true. Safe to call twice: the second call sees a non-running job.
     */
    private async deferClaimedJobForCrossAccountCooldown(thread: ThreadState, job: Job): Promise<boolean> {
        if (job.type !== 'review') return false
        if (this.checkCrossAccountCooldown(job.locationId, job.accountId)) return false

        logToFile(
            `[Thread ${thread.id}] Cross-account cooldown — defer job ${job.id} ` +
            `location=${job.locationId} account=${job.accountId}`
        )
        try {
            await jobQueue.deferRunningJob(job.id)
        } catch (error: unknown) {
            logToFile(
                `[Thread ${thread.id}] Failed to defer job ${job.id}: ` +
                `${error instanceof Error ? error.message : String(error)}`
            )
        }
        return true
    }

    /** Put a claimed job back to pending after executeReviewJob already decided to wait. */
    private async releaseDeferredReviewJob(thread: ThreadState, job: Job): Promise<void> {
        logToFile(
            `[Thread ${thread.id}] Releasing job ${job.id} to pending after cross-account cooldown`
        )
        try {
            await jobQueue.deferRunningJob(job.id)
        } catch (error: unknown) {
            logToFile(
                `[Thread ${thread.id}] Failed to defer job ${job.id}: ` +
                `${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    // Execute review job with submission intent (fail-closed idempotency)
    private async executeReviewJob(
        thread: ThreadState,
        page: Page,
        job: Job,
    ): Promise<{
        alreadySucceeded?: boolean
        deferredCrossAccount?: boolean
        deferredTimeLocality?: boolean
        blockedManualReconcile?: boolean
        blockReason?: string
    }> {
        // Race: another account may have succeeded while this browser was logging in.
        if (!this.checkCrossAccountCooldown(job.locationId, job.accountId)) {
            logToFile(
                `[Thread ${thread.id}] Defer review before post — cross-account cooldown ` +
                `job=${job.id} location=${job.locationId} account=${job.accountId}`
            )
            return { deferredCrossAccount: true }
        }

        const db = getDatabase()
        const location = await db.select().from(schema.locations)
            .where(eq(schema.locations.id, job.locationId))
            .get()

        if (!location) {
            throw new Error('Location not found')
        }

        // Sprint 3: Time-of-day locality check — block night-time reviews at location timezone
        const localitySettings = loadSettings()
        if (localitySettings.enableTimeLocality !== false) {
            const timeDecision = timeLocalityService.shouldReviewNow(location.address)
            if (!timeDecision.allowed) {
                logToFile(
                    `[Thread ${thread.id}] TimeLocality DEFER job=${job.id} — ` +
                    `${timeDecision.reason} (tz=${timeDecision.timezone}, hour=${timeDecision.localHour}, ` +
                    `waitMs=${timeDecision.waitMs ?? 'N/A'})`
                )
                return { deferredTimeLocality: true }
            }
            logToFile(
                `[Thread ${thread.id}] TimeLocality OK — tz=${timeDecision.timezone} hour=${timeDecision.localHour} ` +
                `${timeDecision.reason}`
            )
        }

        console.log(`[Thread ${thread.id}] Reviewing: ${location.name}`)

        // Pre-submit gate: success → idempotent; submitting/unconfirmed → block (no auto-post)
        const gate = await reviewService.evaluateSubmissionGateForPair(
            job.campaignId,
            job.accountId,
            job.locationId,
        )
        if (gate.action === 'idempotent_complete') {
            logToFile(
                `[Thread ${thread.id}] Idempotent skip job=${job.id} — reviewHistory success ` +
                `campaign=${job.campaignId} account=${job.accountId} location=${job.locationId}`,
            )
            sendReviewProgress({
                campaignId: job.campaignId || 0,
                accountId: job.accountId,
                locationId: job.locationId,
                status: 'success',
                message: 'Already reviewed successfully — skipping re-post',
                progress: 100,
            })
            return { alreadySucceeded: true }
        }
        if (gate.action === 'block_manual_reconcile') {
            const reason = gate.reason
                || 'Manual reconciliation required — auto re-post blocked'
            logToFile(
                `[Thread ${thread.id}] BLOCK re-post job=${job.id} intent=${gate.intentId} ` +
                `status=${gate.status}: ${reason}`,
            )
            sendReviewProgress({
                campaignId: job.campaignId || 0,
                accountId: job.accountId,
                locationId: job.locationId,
                status: 'error',
                message: reason,
                progress: 100,
            })
            return { blockedManualReconcile: true, blockReason: reason }
        }

        // Daily limit — only status=success counts
        const todaySuccess = await reviewService.getAccountReviewsToday(job.accountId)
        if (todaySuccess >= this.config.maxReviewsPerAccountPerDay) {
            throw new Error(
                `Daily review limit reached (${todaySuccess}/${this.config.maxReviewsPerAccountPerDay} success)`,
            )
        }

        this.assertNotAborted(`Thread ${thread.id}`)

        let finalStatus: ReviewSubmissionStatus = 'failed'
        let errorMessage: string | undefined
        let screenshotPath: string | undefined
        /** Known false until Google handler zone; undefined once handler entered (fail-closed). */
        let submitAttempted: boolean | undefined = false
        /** True until Google submit handler starts — pre-handler errors finalize as failed. */
        let knownPreSubmit = true
        let intentId: number | undefined
        const rating = job.rating || 5
        let processedReviewText = ''

        if (job.reviewText) {
            processedReviewText = this.processSpintax(job.reviewText)
        } else {
            processedReviewText = ''
        }

        const reviewSettings = loadSettings()
        let wasStyled = false
        if (reviewSettings.enablePerAccountReviewStyle === true && processedReviewText) {
            try {
                const styled = await reviewContentGenerator.generate({
                    accountId: job.accountId,
                    baseText: processedReviewText,
                    locationContext: location.address || undefined,
                    locationName: location.name,
                    category: location.category || undefined,
                    rating,
                    generationSeed: job.id,
                })
                processedReviewText = styled.styledText
                wasStyled = true
                logToFile(
                    `[ReviewStyle] job=${job.id} account=${job.accountId} ` +
                    `typos=${styled.audit.typoCount} emoji=${styled.audit.emojiCount} ` +
                    `similarity=${styled.audit.similarityToPrevious.toFixed(2)}`
                )
            } catch (error) {
                logToFile(
                    `[ReviewStyle] fallback job=${job.id}: ` +
                    `${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        // Sprint 3: Smart photo attachment — probabilistic decision based on context
        let photoDecision: PhotoDecision | null = null
        if (reviewSettings.enableSmartPhotos !== false && reviewSettings.includePhotos) {
            try {
                const warmupData = await accountWarmupService.getWarmupData(job.accountId)
                photoDecision = reviewPhotoStrategy.decide({
                    accountId: job.accountId,
                    locationId: job.locationId,
                    rating,
                    reviewText: processedReviewText,
                    category: location.category || null,
                    accountTotalReviews: todaySuccess,
                    accountWarmupLevel: warmupData?.warmupLevel ?? 0,
                    isFirstReviewForLocation: gate.action === 'proceed',
                })
                logToFile(
                    `[PhotoStrategy] job=${job.id} shouldAttach=${photoDecision.shouldAttach} ` +
                    `maxPhotos=${photoDecision.maxPhotos} probability=${photoDecision.probability.toFixed(2)} ` +
                    `reason="${photoDecision.reason}"`
                )
            } catch (err) {
                logToFile(
                    `[PhotoStrategy] fallback job=${job.id}: ${err instanceof Error ? err.message : String(err)}`
                )
            }
        }

        // Pre-handler setup BEFORE intent (Ollama probe, agentic decision).
        // Errors here throw without intent row → job fail/retry, not unconfirmed.
        const ollamaStatus = await ollamaService.testConnection()
        const agenticSettings = {
            enableAgenticReview: reviewSettings.enableAgenticReview,
            includePhotos: reviewSettings.includePhotos,
        }
        const useAgentic = shouldUseAgenticReview(agenticSettings, ollamaStatus.success === true)
        const ollamaModelLabel = ollamaStatus.models?.[0] || 'Ollama'

        // Intent AFTER pre-handler setup, BEFORE any Google submit
        const intent = await reviewService.beginSubmissionIntent({
            campaignId: job.campaignId,
            accountId: job.accountId,
            locationId: job.locationId,
            rating,
            reviewText: processedReviewText || job.reviewText || '',
            styleApplied: wasStyled,
        })
        intentId = intent.id
        logToFile(
            `[Thread ${thread.id}] Submission intent id=${intentId} status=submitting ` +
            `campaign=${job.campaignId} account=${job.accountId} location=${job.locationId}`,
        )

        try {
            if (useAgentic) {
                // Entering Google handler zone — unknown submit until handler reports
                knownPreSubmit = false
                submitAttempted = undefined
                console.log(`[Thread ${thread.id}] 🧠 enableAgenticReview=true. Using Agentic Review Handler.`)
                sendReviewProgress({
                    campaignId: job.campaignId || 0,
                    accountId: job.accountId,
                    locationId: job.locationId,
                    status: 'running',
                    message: `🧠 Agentic review with ${ollamaModelLabel}...`,
                    progress: 10,
                })

                const agenticRaw = await agenticReviewHandler.performReview(
                    page,
                    location.name,
                    location.url,
                    processedReviewText,
                    rating,
                    job.campaignId || 0,
                    thread.id,
                    () => this.isAbortRequested(),
                )
                const agenticResult: SubmitAwareResult = {
                    success: agenticRaw.success,
                    error: agenticRaw.error,
                    allowLinearFallback: agenticRaw.allowLinearFallback,
                    submitAttempted: (agenticRaw as SubmitAwareResult).submitAttempted,
                }
                submitAttempted = this.readSubmitAttempted(agenticResult)

                if (agenticResult.success) {
                    finalStatus = 'success'
                    submitAttempted = true
                    console.log(`[Thread ${thread.id}] ✅ [Agentic] Review verified for ${location.name}`)
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'success',
                        message: '✅ Agentic review posted and verified.',
                        progress: 100,
                    })
                } else if (submitAttempted === true) {
                    // Fail-closed: never linear-fallback after submit was attempted
                    finalStatus = 'unconfirmed'
                    errorMessage = agenticResult.error
                        || 'Agentic submit attempted but success not verified'
                    logToFile(
                        `[Thread ${thread.id}] Agentic submitAttempted=true → unconfirmed (no linear fallback): ${errorMessage}`,
                    )
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'error',
                        message: `⚠ Unconfirmed submit — manual reconcile: ${errorMessage}`,
                        progress: 100,
                    })
                } else if (
                    agenticResult.allowLinearFallback !== false
                    && !this.isAbortRequested()
                ) {
                    // Safe linear fallback only when submit was NOT attempted
                    logToFile(
                        `[Thread ${thread.id}] Agentic soft-fail → linear postReview fallback: ${agenticResult.error || 'n/a'}`,
                    )
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'running',
                        message: '⚠ Agentic incomplete — safe linear fallback...',
                        progress: 40,
                    })
                    const linear = await this.runLinearPostReview(
                        thread,
                        job,
                        location.url,
                        rating,
                        processedReviewText,
                        photoDecision,
                    )
                    const linearAttempted = this.readSubmitAttempted(linear)
                    if (linearAttempted === true) submitAttempted = true
                    if (linear.success) {
                        finalStatus = 'success'
                        submitAttempted = true
                        screenshotPath = linear.screenshot
                        console.log(`[Thread ${thread.id}] ✅ Linear fallback posted for ${location.name}`)
                    } else {
                        finalStatus = resolveSubmissionFinalStatus(false, linearAttempted)
                        errorMessage = linear.error || agenticResult.error || 'Linear fallback failed'
                    }
                } else {
                    finalStatus = resolveSubmissionFinalStatus(false, submitAttempted)
                    errorMessage = agenticResult.error || 'Agentic review failed'
                    console.warn(`[Thread ${thread.id}] ❌ [Agentic] ${errorMessage}`)
                    sendReviewProgress({
                        campaignId: job.campaignId || 0,
                        accountId: job.accountId,
                        locationId: job.locationId,
                        status: 'error',
                        message: `❌ Agentic failed: ${errorMessage}`,
                        progress: 100,
                    })
                }
            } else {
                const reason = reviewSettings.includePhotos === true
                    ? 'photos enabled → linear'
                    : reviewSettings.enableAgenticReview === true
                        ? 'Ollama offline → linear'
                        : 'enableAgenticReview!=true → linear'
                // Entering Google handler zone
                knownPreSubmit = false
                submitAttempted = undefined
                console.log(`[Thread ${thread.id}] Linear review (${reason})`)
                sendReviewProgress({
                    campaignId: job.campaignId || 0,
                    accountId: job.accountId,
                    locationId: job.locationId,
                    status: 'running',
                    message: `Linear review (${reason})...`,
                    progress: 10,
                })

                const linear = await this.runLinearPostReview(
                    thread,
                    job,
                    location.url,
                    rating,
                    processedReviewText,
                    photoDecision,
                )
                submitAttempted = this.readSubmitAttempted(linear)
                if (linear.success) {
                    finalStatus = 'success'
                    submitAttempted = true
                    screenshotPath = linear.screenshot
                    console.log(`[Thread ${thread.id}] ✅ Review posted for ${location.name}`)
                } else {
                    finalStatus = resolveSubmissionFinalStatus(false, submitAttempted)
                    errorMessage = linear.error || 'Linear review failed'
                    console.warn(`[Thread ${thread.id}] ❌ Review failed: ${errorMessage}`)
                }
            }
        } catch (error) {
            // knownPreSubmit → failed; handler zone → fail-closed unconfirmed unless submit=false
            errorMessage = error instanceof Error ? error.message : 'Unknown error during review'
            finalStatus = resolveIntentCatchStatus(knownPreSubmit, submitAttempted)
            console.error(
                `[Thread ${thread.id}] ❌ Review ${finalStatus} for ${location.name}: ${errorMessage}`,
            )
        }

        // Finalize the same intent row (submitting → success|failed|unconfirmed)
        if (intentId != null) {
            const applied = await reviewService.finalizeSubmissionIntent(
                intentId,
                finalStatus === 'submitting' ? 'unconfirmed' : finalStatus,
                {
                    errorMessage: errorMessage ?? null,
                    screenshot: screenshotPath ?? null,
                    reviewText: processedReviewText || job.reviewText || '',
                    rating,
                },
            )
            logToFile(
                `[Thread ${thread.id}] Intent id=${intentId} → ${finalStatus}` +
                `${applied ? '' : ' (finalize no-op; row not submitting)'}`,
            )
        }

        if (finalStatus === 'success') {
            await accountWarmupService.recordRealReview(job.accountId)
            await locationService.incrementReviewCount(job.locationId).catch((err: unknown) => {
                logToFile(
                    `[Thread ${thread.id}] location counter update failed: ` +
                    `${err instanceof Error ? err.message : String(err)}`,
                )
            })
            return {}
        }

        if (finalStatus === 'unconfirmed') {
            const reason = errorMessage
                ? `Unconfirmed submit (manual reconciliation required): ${errorMessage}`
                : 'Unconfirmed submit (manual reconciliation required) — auto re-post blocked'
            return { blockedManualReconcile: true, blockReason: reason }
        }

        // Explicit pre-submit failure → fail job (may retry); intent is failed not blocking
        throw new Error(errorMessage || 'Review failed')
    }

    // Execute traffic job
    private async executeTrafficJob(thread: ThreadState, page: Page, job: Job): Promise<void> {
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
    async pause(): Promise<void> {
        this.paused = true
        this.abortPendingProxyAcquires()
        if (this.currentCampaignId) {
            const db = getDatabase()
            await db.update(schema.campaigns)
                .set({ status: 'paused' })
                .where(eq(schema.campaigns.id, this.currentCampaignId))
        }
        console.log('[AutomationController] Paused')
        this.sendStatus()
    }

    // Resume automation
    async resume(): Promise<void> {
        if (!this.running || !this.currentCampaignId) {
            throw new Error('No in-process campaign is available to resume')
        }
        this.paused = false
        const db = getDatabase()
        await db.update(schema.campaigns)
            .set({ status: 'running' })
            .where(eq(schema.campaigns.id, this.currentCampaignId))
        console.log('[AutomationController] Resumed')
        this.sendStatus()
    }

    /** Natural drain: mark campaign done, keep durable done rows, no cancel. */
    private async finishCampaignNaturally(): Promise<void> {
        this.shouldStop = true
        this.running = false
        this.abortPendingProxyAcquires()

        for (const thread of this.threads) {
            if (thread.contextId != null) {
                await browserService.closeContext(thread.contextId).catch(() => { })
            } else if (thread.context) {
                await thread.context.close().catch(() => { })
            }
        }

        if (this.currentCampaignId) {
            const db = getDatabase()
            await db.update(schema.campaigns)
                .set({ status: 'done' })
                .where(eq(schema.campaigns.id, this.currentCampaignId))
        }

        this.threads = []
        this.currentCampaignId = undefined
        this.sendStatus()
        console.log('[AutomationController] Campaign finished naturally (status=done)')
    }

    // Stop automation (user stop → cancel remaining durable jobs + pause campaign)
    async stop(): Promise<void> {
        console.log('[AutomationController] Stopping...')
        this.shouldStop = true
        this.running = false
        this.abortPendingProxyAcquires()

        for (const thread of this.threads) {
            if (thread.contextId != null) {
                await browserService.closeContext(thread.contextId).catch(() => { })
            } else if (thread.context) {
                await thread.context.close().catch(() => { })
            }
        }

        if (this.currentCampaignId) {
            await jobQueue.cancelCampaignJobs(this.currentCampaignId)

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

    isRunning(): boolean {
        return this.running
    }

    isPaused(): boolean {
        return this.paused
    }

    private abortPendingProxyAcquires(): void {
        for (const controller of Array.from(this.proxyAcquireControllers)) {
            controller.abort()
        }
        this.proxyAcquireControllers.clear()
    }
}

// Singleton instance
export const automationController = new AutomationController()
