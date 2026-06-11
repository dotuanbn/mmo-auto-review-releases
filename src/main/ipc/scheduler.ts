import { ipcMain } from 'electron'
import { schedulerService } from '../services/SchedulerService'

export function registerSchedulerHandlers() {
    // Create a schedule
    ipcMain.handle('scheduler:create', async (_event, config: any) => {
        // Convert string date to Date object
        const scheduleConfig = {
            ...config,
            scheduledAt: new Date(config.scheduledAt),
            endDate: config.endDate ? new Date(config.endDate) : undefined,
        }
        return await schedulerService.createSchedule(scheduleConfig)
    })

    // Update a schedule
    ipcMain.handle('scheduler:update', async (_event, id: number, config: any) => {
        const updateConfig = {
            ...config,
            scheduledAt: config.scheduledAt ? new Date(config.scheduledAt) : undefined,
            endDate: config.endDate ? new Date(config.endDate) : undefined,
        }
        return await schedulerService.updateSchedule(id, updateConfig)
    })

    // Delete a schedule
    ipcMain.handle('scheduler:delete', async (_event, id: number) => {
        return await schedulerService.deleteSchedule(id)
    })

    // Get schedule for a campaign
    ipcMain.handle('scheduler:getForCampaign', async (_event, campaignId: number) => {
        return await schedulerService.getScheduleForCampaign(campaignId)
    })

    // Get all schedules
    ipcMain.handle('scheduler:getAll', async () => {
        return await schedulerService.getAllSchedules()
    })

    // Toggle schedule active status
    ipcMain.handle('scheduler:toggle', async (_event, id: number) => {
        return await schedulerService.toggleSchedule(id)
    })

    console.log('Scheduler handlers registered')
}
