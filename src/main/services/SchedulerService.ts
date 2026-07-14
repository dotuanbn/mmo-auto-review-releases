/**
 * SchedulerService - Campaign Scheduling Service
 *
 * Manages scheduled campaign execution. Does not set campaign.status='running'
 * itself — real start/resume goes through injected CampaignAutomationRunner
 * (AutomationController) so durable job queue ownership stays with automation.
 */

import { getDatabase, schema } from '../database'
import { eq, and, lte } from 'drizzle-orm'
import { BrowserWindow } from 'electron'

export type ScheduleRepeatType = 'once' | 'daily' | 'weekly' | 'custom'

export interface ScheduleConfig {
    campaignId: number
    scheduledAt: Date
    repeatType: ScheduleRepeatType
    repeatDays?: number[] // [0-6] for days of week (0 = Sunday)
    endDate?: Date
    isActive: boolean
}

export interface CampaignSchedule {
    id: number
    campaignId: number
    scheduledAt: Date
    repeatType: string
    repeatDays: string | null
    endDate: Date | null
    lastRunAt: Date | null
    nextRunAt: Date | null
    isActive: boolean
    createdAt: Date
}

/** Injected automation port — keeps Scheduler free of AutomationController imports. */
export interface CampaignAutomationRunner {
    startCampaign(campaignId: number): Promise<{ success: boolean; error?: string }>
    resumeCampaign(campaignId: number): Promise<{ success: boolean; error?: string }>
    /** True when durable job_queue still has pending work for this campaign. */
    hasPendingDurableJobs(campaignId: number): Promise<boolean>
}

export interface AutomationStartResult {
    success: boolean
    error?: string
    mode?: 'start' | 'resume'
}

const MAX_CONSECUTIVE_FAILURES = 5
const BASE_BACKOFF_MS = 2 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

function parseRepeatDays(raw: string | null | undefined): number[] | undefined {
    if (!raw) return undefined
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return undefined
        return parsed.filter((d): d is number => typeof d === 'number')
    } catch {
        return undefined
    }
}

function asRepeatType(value: string): ScheduleRepeatType {
    if (value === 'once' || value === 'daily' || value === 'weekly' || value === 'custom') {
        return value
    }
    return 'once'
}

export class SchedulerService {
    private mainWindow: BrowserWindow | null = null
    private checkInterval: ReturnType<typeof setInterval> | null = null
    private isRunning = false
    private automationRunner: CampaignAutomationRunner | null = null

    /** Per-schedule in-flight guard — blocks double-tick on the same schedule. */
    private readonly inFlightScheduleIds = new Set<number>()
    /** Consecutive start failures per schedule id (bounded retry / backoff). */
    private readonly failureCounts = new Map<number, number>()

    /**
     * Inject automation controller (or test double). Call once at app bootstrap.
     */
    setAutomationRunner(runner: CampaignAutomationRunner): void {
        this.automationRunner = runner
    }

    /**
     * Set the main window reference for notifications
     */
    setMainWindow(window: BrowserWindow | null): void {
        this.mainWindow = window
    }

    /**
     * Start the scheduler check loop
     */
    start(): void {
        if (this.isRunning) return

        this.isRunning = true
        console.log('Scheduler service started')

        this.checkInterval = setInterval(() => {
            void this.checkAndStartDue()
        }, 60000)

        void this.checkAndStartDue()
    }

    /**
     * Stop the scheduler
     */
    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval)
            this.checkInterval = null
        }
        this.isRunning = false
        this.inFlightScheduleIds.clear()
        console.log('Scheduler service stopped')
    }

    /** Test helper: clear in-memory retry / in-flight state. */
    resetRuntimeStateForTests(): void {
        this.inFlightScheduleIds.clear()
        this.failureCounts.clear()
    }

    /**
     * Create a new schedule for a campaign
     */
    async createSchedule(config: ScheduleConfig): Promise<{ success: boolean; id?: number; error?: string }> {
        try {
            const db = getDatabase()
            const nextRunAt = this.calculateNextRunTime(config.scheduledAt, config.repeatType, config.repeatDays)

            const result = db.insert(schema.campaignSchedules).values({
                campaignId: config.campaignId,
                scheduledAt: config.scheduledAt,
                repeatType: config.repeatType,
                repeatDays: config.repeatDays ? JSON.stringify(config.repeatDays) : null,
                endDate: config.endDate || null,
                nextRunAt,
                isActive: config.isActive,
            }).run()

            return { success: true, id: Number(result.lastInsertRowid) }
        } catch (error: unknown) {
            console.error('Failed to create schedule:', error)
            return { success: false, error: errorMessage(error) }
        }
    }

    /**
     * Update an existing schedule
     */
    async updateSchedule(id: number, config: Partial<ScheduleConfig>): Promise<{ success: boolean; error?: string }> {
        try {
            const db = getDatabase()

            const updateData: {
                scheduledAt?: Date
                repeatType?: ScheduleRepeatType
                repeatDays?: string
                endDate?: Date | null
                isActive?: boolean
                nextRunAt?: Date
            } = {}

            if (config.scheduledAt !== undefined) updateData.scheduledAt = config.scheduledAt
            if (config.repeatType !== undefined) updateData.repeatType = config.repeatType
            if (config.repeatDays !== undefined) updateData.repeatDays = JSON.stringify(config.repeatDays)
            if (config.endDate !== undefined) updateData.endDate = config.endDate
            if (config.isActive !== undefined) updateData.isActive = config.isActive

            if (config.scheduledAt || config.repeatType || config.repeatDays) {
                const schedule = await this.getSchedule(id)
                if (schedule) {
                    updateData.nextRunAt = this.calculateNextRunTime(
                        config.scheduledAt || schedule.scheduledAt,
                        config.repeatType || asRepeatType(schedule.repeatType),
                        config.repeatDays || parseRepeatDays(schedule.repeatDays)
                    )
                }
            }

            db.update(schema.campaignSchedules)
                .set(updateData)
                .where(eq(schema.campaignSchedules.id, id))
                .run()

            return { success: true }
        } catch (error: unknown) {
            return { success: false, error: errorMessage(error) }
        }
    }

    /**
     * Delete a schedule
     */
    async deleteSchedule(id: number): Promise<{ success: boolean; error?: string }> {
        try {
            const db = getDatabase()
            db.delete(schema.campaignSchedules)
                .where(eq(schema.campaignSchedules.id, id))
                .run()
            this.failureCounts.delete(id)
            this.inFlightScheduleIds.delete(id)
            return { success: true }
        } catch (error: unknown) {
            return { success: false, error: errorMessage(error) }
        }
    }

    /**
     * Get a schedule by ID
     */
    async getSchedule(id: number): Promise<CampaignSchedule | null> {
        try {
            const db = getDatabase()
            const result = db.select().from(schema.campaignSchedules)
                .where(eq(schema.campaignSchedules.id, id))
                .get()
            return result ?? null
        } catch {
            return null
        }
    }

    /**
     * Get schedule for a campaign
     */
    async getScheduleForCampaign(campaignId: number): Promise<CampaignSchedule | null> {
        try {
            const db = getDatabase()
            const result = db.select().from(schema.campaignSchedules)
                .where(eq(schema.campaignSchedules.campaignId, campaignId))
                .get()
            return result ?? null
        } catch {
            return null
        }
    }

    /**
     * Get all active schedules
     */
    async getAllSchedules(): Promise<CampaignSchedule[]> {
        try {
            const db = getDatabase()
            return db.select().from(schema.campaignSchedules).all() || []
        } catch (error: unknown) {
            console.error('Failed to get schedules:', error)
            return []
        }
    }

    /**
     * Check for due campaigns and start them
     */
    async checkAndStartDue(): Promise<void> {
        try {
            const db = getDatabase()
            const now = new Date()

            const dueSchedules = db.select()
                .from(schema.campaignSchedules)
                .where(
                    and(
                        eq(schema.campaignSchedules.isActive, true),
                        lte(schema.campaignSchedules.nextRunAt, now)
                    )
                )
                .all() as CampaignSchedule[]

            for (const schedule of dueSchedules) {
                await this.executeCampaign(schedule)
            }
        } catch (error: unknown) {
            console.error('Scheduler check failed:', error)
        }
    }

    /**
     * Execute a scheduled campaign via real automation (start or resume).
     * Advances lastRunAt/nextRunAt only after runner reports success.
     */
    private async executeCampaign(schedule: CampaignSchedule): Promise<void> {
        if (this.inFlightScheduleIds.has(schedule.id)) {
            console.log(`[Scheduler] Skip schedule ${schedule.id} — already in-flight`)
            return
        }

        this.inFlightScheduleIds.add(schedule.id)
        console.log(`[Scheduler] Executing scheduled campaign: ${schedule.campaignId} (schedule=${schedule.id})`)

        try {
            if (!this.automationRunner) {
                console.error('[Scheduler] No automation runner injected — cannot execute campaigns')
                this.applyFailureBackoff(schedule, 'Automation runner not configured')
                return
            }

            const db = getDatabase()
            const campaign = db.select().from(schema.campaigns)
                .where(eq(schema.campaigns.id, schedule.campaignId))
                .get()

            if (!campaign) {
                console.error(`[Scheduler] Campaign ${schedule.campaignId} not found`)
                this.persistSchedulePatch(schedule.id, { isActive: false, nextRunAt: null })
                return
            }

            // Do NOT set campaign.status='running' here — only AutomationController may.
            const startResult = await this.invokeAutomation(schedule.campaignId)

            if (!startResult.success) {
                console.error(
                    `[Scheduler] Automation ${startResult.mode ?? 'start'} failed for campaign ` +
                    `${schedule.campaignId}: ${startResult.error ?? 'unknown'}`
                )
                this.applyFailureBackoff(schedule, startResult.error ?? 'Start failed')
                this.notifyFrontend({
                    campaignId: schedule.campaignId,
                    status: campaign.status,
                    message: `Scheduler start failed: ${startResult.error ?? 'unknown'}`,
                })
                return
            }

            this.failureCounts.delete(schedule.id)
            this.advanceScheduleAfterSuccess(schedule)
            this.notifyFrontend({
                campaignId: schedule.campaignId,
                status: 'running',
                message: `Campaign ${startResult.mode === 'resume' ? 'resumed' : 'started'} by scheduler`,
            })
        } catch (error: unknown) {
            console.error(`[Scheduler] Failed to execute campaign ${schedule.campaignId}:`, error)
            this.applyFailureBackoff(schedule, errorMessage(error))
        } finally {
            this.inFlightScheduleIds.delete(schedule.id)
        }
    }

    /**
     * Prefer resume when durable pending jobs exist; otherwise fresh start.
     */
    private async invokeAutomation(campaignId: number): Promise<AutomationStartResult> {
        const runner = this.automationRunner
        if (!runner) {
            return { success: false, error: 'Automation runner not configured' }
        }

        const hasPending = await runner.hasPendingDurableJobs(campaignId)
        if (hasPending) {
            const result = await runner.resumeCampaign(campaignId)
            return { ...result, mode: 'resume' }
        }

        const result = await runner.startCampaign(campaignId)
        return { ...result, mode: 'start' }
    }

    /**
     * Only after successful start/resume: set lastRunAt and compute next fire.
     */
    private advanceScheduleAfterSuccess(schedule: CampaignSchedule): void {
        const lastRunAt = new Date()
        let nextRunAt: Date | null = null
        let shouldDeactivate = false

        if (schedule.repeatType !== 'once') {
            const repeatDays = parseRepeatDays(schedule.repeatDays)
            nextRunAt = this.calculateNextRunTime(
                lastRunAt,
                asRepeatType(schedule.repeatType),
                repeatDays
            )

            if (schedule.endDate && nextRunAt > schedule.endDate) {
                shouldDeactivate = true
                nextRunAt = null
            }
        } else {
            shouldDeactivate = true
        }

        this.persistSchedulePatch(schedule.id, {
            lastRunAt,
            nextRunAt,
            isActive: !shouldDeactivate,
        })
    }

    /**
     * Failure path: never fake running. Push nextRunAt with exponential backoff.
     * After MAX failures: once → deactivate; recurring → skip to natural next slot.
     */
    private applyFailureBackoff(schedule: CampaignSchedule, reason: string): void {
        const fails = (this.failureCounts.get(schedule.id) ?? 0) + 1
        this.failureCounts.set(schedule.id, fails)

        if (fails >= MAX_CONSECUTIVE_FAILURES) {
            if (asRepeatType(schedule.repeatType) === 'once') {
                console.warn(
                    `[Scheduler] Schedule ${schedule.id} hit max failures (${fails}); deactivating. reason=${reason}`
                )
                this.persistSchedulePatch(schedule.id, { isActive: false, nextRunAt: null })
                return
            }

            const nextRunAt = this.calculateNextRunTime(
                new Date(),
                asRepeatType(schedule.repeatType),
                parseRepeatDays(schedule.repeatDays)
            )
            console.warn(
                `[Scheduler] Schedule ${schedule.id} hit max failures (${fails}); advancing to ${nextRunAt.toISOString()}. reason=${reason}`
            )
            this.failureCounts.delete(schedule.id)
            this.persistSchedulePatch(schedule.id, { nextRunAt })
            return
        }

        const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, fails - 1))
        const nextRunAt = new Date(Date.now() + backoffMs)
        console.warn(
            `[Scheduler] Schedule ${schedule.id} failure #${fails}; retry at ${nextRunAt.toISOString()} (+${backoffMs}ms). reason=${reason}`
        )
        this.persistSchedulePatch(schedule.id, { nextRunAt })
    }

    private persistSchedulePatch(
        id: number,
        patch: {
            lastRunAt?: Date | null
            nextRunAt?: Date | null
            isActive?: boolean
        }
    ): void {
        try {
            const db = getDatabase()
            db.update(schema.campaignSchedules)
                .set(patch)
                .where(eq(schema.campaignSchedules.id, id))
                .run()
        } catch (error: unknown) {
            console.error(`[Scheduler] Failed to patch schedule ${id}:`, error)
        }
    }

    private notifyFrontend(payload: {
        campaignId: number
        status: string
        message: string
    }): void {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return
        try {
            this.mainWindow.webContents.send('campaign:update', payload)
        } catch (error: unknown) {
            console.error('[Scheduler] Failed to notify frontend:', error)
        }
    }

    /**
     * Calculate the next run time based on repeat configuration
     */
    calculateNextRunTime(
        baseTime: Date,
        repeatType: ScheduleRepeatType,
        repeatDays?: number[]
    ): Date {
        const next = new Date(baseTime)

        switch (repeatType) {
            case 'once':
                return next

            case 'daily':
                next.setDate(next.getDate() + 1)
                return next

            case 'weekly':
                next.setDate(next.getDate() + 7)
                return next

            case 'custom': {
                if (!repeatDays || repeatDays.length === 0) {
                    next.setDate(next.getDate() + 1)
                    return next
                }

                const currentDay = next.getDay()
                let daysToAdd = 1

                for (let i = 1; i <= 7; i++) {
                    const checkDay = (currentDay + i) % 7
                    if (repeatDays.includes(checkDay)) {
                        daysToAdd = i
                        break
                    }
                }

                next.setDate(next.getDate() + daysToAdd)
                return next
            }

            default:
                return next
        }
    }

    /**
     * Toggle schedule active status
     */
    async toggleSchedule(id: number): Promise<{ success: boolean; isActive?: boolean; error?: string }> {
        try {
            const schedule = await this.getSchedule(id)
            if (!schedule) {
                return { success: false, error: 'Schedule not found' }
            }

            const isActive = !schedule.isActive
            await this.updateSchedule(id, { isActive })

            return { success: true, isActive }
        } catch (error: unknown) {
            return { success: false, error: errorMessage(error) }
        }
    }

    /** Exposed for tests — number of schedules currently executing. */
    getInFlightCountForTests(): number {
        return this.inFlightScheduleIds.size
    }

    /** Exposed for tests — consecutive failure count for a schedule. */
    getFailureCountForTests(scheduleId: number): number {
        return this.failureCounts.get(scheduleId) ?? 0
    }
}

export const schedulerService = new SchedulerService()
