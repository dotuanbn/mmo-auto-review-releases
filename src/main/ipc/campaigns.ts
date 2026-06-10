import { ipcMain, BrowserWindow } from 'electron'
import { campaignService } from '../services/CampaignService'
import { automationController } from '../automation/AutomationController'

export function registerCampaignHandlers() {
    // Get all campaigns
    ipcMain.handle('campaigns:getAll', async () => {
        return campaignService.getAll()
    })

    // Get running campaigns
    ipcMain.handle('campaigns:getRunning', async () => {
        return campaignService.getRunning()
    })

    // Get campaign by ID
    ipcMain.handle('campaigns:getById', async (_event, id: number) => {
        return campaignService.getById(id)
    })

    // Create new campaign
    ipcMain.handle('campaigns:create', async (_event, data: {
        name: string
        locationIds: number[]
        accountIds?: number[]
        proxyIds?: number[]
        reviewTemplates: string[]
        rating?: number
        delayMin?: number
        delayMax?: number
        maxReviewsPerAccountPerDay?: number
    }) => {
        return campaignService.create(data)
    })

    // Update campaign
    ipcMain.handle('campaigns:update', async (_event, id: number, data: any) => {
        return campaignService.update(id, data)
    })

    // Delete campaign
    ipcMain.handle('campaigns:delete', async (_event, id: number) => {
        return campaignService.delete(id)
    })

    // Start campaign - now properly starts the automation engine
    ipcMain.handle('campaigns:start', async (_event, id: number) => {
        try {
            const result = await automationController.startCampaign(id)
            if (result.success) {
                notifyCampaignUpdate(id, 'running', 'Campaign started')
            } else {
                notifyCampaignUpdate(id, 'error', result.error || 'Failed to start')
            }
            return result
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            notifyCampaignUpdate(id, 'error', errorMsg)
            return { success: false, error: errorMsg }
        }
    })

    // Pause campaign
    ipcMain.handle('campaigns:pause', async (_event, id: number) => {
        automationController.pause()
        await campaignService.pause(id)
        notifyCampaignUpdate(id, 'paused', 'Campaign paused')
    })

    // Stop campaign - now properly stops the automation engine
    ipcMain.handle('campaigns:stop', async (_event, id: number) => {
        await automationController.stop()
        await campaignService.stop(id)
        notifyCampaignUpdate(id, 'done', 'Campaign stopped')
    })

    // Get statistics
    ipcMain.handle('campaigns:getStats', async () => {
        return campaignService.getStats()
    })
}

// Send campaign update to renderer
function notifyCampaignUpdate(campaignId: number, status: string, message: string) {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
        win.webContents.send('campaign:update', {
            campaignId,
            status,
            message,
        })
    }
}

// Export for use by automation engine
export function sendReviewProgress(data: {
    campaignId: number
    accountId: number
    locationId: number
    status: string
    message: string
    progress: number
}) {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
        win.webContents.send('review:progress', data)
    }
}
