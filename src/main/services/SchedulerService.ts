/**
 * SchedulerService - Campaign Scheduling Service
 * 
 * Manages scheduled campaign execution
 */

import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq, and, lte, isNull, not } from 'drizzle-orm'
import { BrowserWindow } from 'electron'

export interface ScheduleConfig {
    campaignId: number
    scheduledAt: Date
    repeatType: 'once' | 'daily' | 'weekly' | 'custom'
    repeatDays?: number[] // [0-6] for days of week (0 = Sunday)
    endDate?: Date
    isActive: boolean
}

interface CampaignSchedule {
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

class SchedulerService {
    private mainWindow: BrowserWindow | null = null
    private checkInterval: NodeJS.Timeout | null = null
    private isRunning = false

    /**
     * Set the main window reference for notifications
     */
    setMainWindow(window: BrowserWindow): void {
        this.mainWindow = window
    }

    /**
     * Start the scheduler check loop
     */
    start(): void {
        if (this.isRunning) return

        this.isRunning = true
        console.log('Scheduler service started')

        // Check every minute
        this.checkInterval = setInterval(() => {
            this.checkAndStartDue()
        }, 60000)

        // Initial check
        this.checkAndStartDue()
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
        console.log('Scheduler service stopped')
    }

    /**
     * Create a new schedule for a campaign
     */
    async createSchedule(config: ScheduleConfig): Promise<{ success: boolean; id?: number; error?: string }> {
        try {
            const db = getDatabase()

            // Calculate next run time
            const nextRunAt = this.calculateNextRunTime(config.scheduledAt, config.repeatType, config.repeatDays)

            const result = (db as any).insert((schema as any).campaignSchedules).values({
                campaignId: config.campaignId,
                scheduledAt: config.scheduledAt,
                repeatType: config.repeatType,
                repeatDays: config.repeatDays ? JSON.stringify(config.repeatDays) : null,
                endDate: config.endDate || null,
                nextRunAt: nextRunAt,
                isActive: config.isActive,
            }).run()

            return { success: true, id: Number(result.lastInsertRowid) }
        } catch (error: any) {
            console.error('Failed to create schedule:', error)
            return { success: false, error: error.message }
        }
    }

    /**
     * Update an existing schedule
     */
    async updateSchedule(id: number, config: Partial<ScheduleConfig>): Promise<{ success: boolean; error?: string }> {
        try {
            const db = getDatabase()

            const updateData: any = {}
            if (config.scheduledAt !== undefined) updateData.scheduledAt = config.scheduledAt
            if (config.repeatType !== undefined) updateData.repeatType = config.repeatType
            if (config.repeatDays !== undefined) updateData.repeatDays = JSON.stringify(config.repeatDays)
            if (config.endDate !== undefined) updateData.endDate = config.endDate
            if (config.isActive !== undefined) updateData.isActive = config.isActive

            // Recalculate next run time if schedule changed
            if (config.scheduledAt || config.repeatType || config.repeatDays) {
                const schedule = await this.getSchedule(id)
                if (schedule) {
                    const nextRunAt = this.calculateNextRunTime(
                        config.scheduledAt || schedule.scheduledAt,
                        config.repeatType || schedule.repeatType as any,
                        config.repeatDays || (schedule.repeatDays ? JSON.parse(schedule.repeatDays) : undefined)
                    )
                    updateData.nextRunAt = nextRunAt
                }
            }

            (db as any).update((schema as any).campaignSchedules)
                .set(updateData)
                .where(eq((schema as any).campaignSchedules.id, id))
                .run()

            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }

    /**
     * Delete a schedule
     */
    async deleteSchedule(id: number): Promise<{ success: boolean; error?: string }> {
        try {
            const db = getDatabase()
                ; (db as any).delete((schema as any).campaignSchedules)
                    .where(eq((schema as any).campaignSchedules.id, id))
                    .run()
            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }

    /**
     * Get a schedule by ID
     */
    async getSchedule(id: number): Promise<CampaignSchedule | null> {
        try {
            const db = getDatabase()
            const result = (db as any).select().from((schema as any).campaignSchedules)
                .where(eq((schema as any).campaignSchedules.id, id))
                .get()
            return result || null
        } catch (error) {
            return null
        }
    }

    /**
     * Get schedule for a campaign
     */
    async getScheduleForCampaign(campaignId: number): Promise<CampaignSchedule | null> {
        try {
            const db = getDatabase()
            const result = (db as any).select().from((schema as any).campaignSchedules)
                .where(eq((schema as any).campaignSchedules.campaignId, campaignId))
                .get()
            return result || null
        } catch (error) {
            return null
        }
    }

    /**
     * Get all active schedules
     */
    async getAllSchedules(): Promise<CampaignSchedule[]> {
        try {
            const db = getDatabase()
            return (db as any).select().from((schema as any).campaignSchedules).all() || []
        } catch (error) {
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

            // Get all active schedules that are due
            const dueSchedules = (db as any).select()
                .from((schema as any).campaignSchedules)
                .where(
                    and(
                        eq((schema as any).campaignSchedules.isActive, true),
                        lte((schema as any).campaignSchedules.nextRunAt, now)
                    )
                )
                .all() as CampaignSchedule[]

            for (const schedule of dueSchedules) {
                await this.executeCampaign(schedule)
            }
        } catch (error) {
            console.error('Scheduler check failed:', error)
        }
    }

    /**
     * Execute a scheduled campaign
     */
    private async executeCampaign(schedule: CampaignSchedule): Promise<void> {
        console.log(`Executing scheduled campaign: ${schedule.campaignId}`)

        try {
            const db = getDatabase()

            // Get campaign info
            const campaign = db.select().from(schema.campaigns)
                .where(eq(schema.campaigns.id, schedule.campaignId))
                .get()

            if (!campaign) {
                console.error(`Campaign ${schedule.campaignId} not found`)
                return
            }

            // Update campaign status to running
            db.update(schema.campaigns)
                .set({ status: 'running' })
                .where(eq(schema.campaigns.id, schedule.campaignId))
                .run()

            // Notify frontend
            if (this.mainWindow) {
                this.mainWindow.webContents.send('campaign:update', {
                    campaignId: schedule.campaignId,
                    status: 'running',
                    message: 'Campaign started by scheduler'
                })
            }

            // Update schedule
            const lastRunAt = new Date()
            let nextRunAt: Date | null = null
            let shouldDeactivate = false

            // Calculate next run based on repeat type
            if (schedule.repeatType !== 'once') {
                const repeatDays = schedule.repeatDays ? JSON.parse(schedule.repeatDays) : undefined
                nextRunAt = this.calculateNextRunTime(lastRunAt, schedule.repeatType as any, repeatDays)

                // Check if we're past end date
                if (schedule.endDate && nextRunAt > schedule.endDate) {
                    shouldDeactivate = true
                    nextRunAt = null
                }
            } else {
                shouldDeactivate = true
            }

            // Update schedule record
            ; (db as any).update((schema as any).campaignSchedules)
                .set({
                    lastRunAt,
                    nextRunAt,
                    isActive: !shouldDeactivate
                })
                .where(eq((schema as any).campaignSchedules.id, schedule.id))
                .run()

        } catch (error) {
            console.error(`Failed to execute campaign ${schedule.campaignId}:`, error)
        }
    }

    /**
     * Calculate the next run time based on repeat configuration
     */
    private calculateNextRunTime(
        baseTime: Date,
        repeatType: 'once' | 'daily' | 'weekly' | 'custom',
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

            case 'custom':
                if (!repeatDays || repeatDays.length === 0) {
                    next.setDate(next.getDate() + 1)
                    return next
                }

                // Find next valid day
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
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    }
}

export const schedulerService = new SchedulerService()
