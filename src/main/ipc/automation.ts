import { ipcMain, BrowserWindow } from 'electron'
import { reviewAutomationEngine } from '../automation'
import { simpleTestAutomation } from '../automation/SimpleTestAutomation'
import { simpleCampaignEngine } from '../automation/SimpleCampaignEngine'
import { automationController } from '../automation/AutomationController'
import { jobQueue } from '../automation/JobQueue'

export function registerAutomationHandlers(mainWindow?: BrowserWindow) {
    // Set main window for status updates (if provided)
    if (mainWindow) {
        automationController.setMainWindow(mainWindow)
    }

    // Get automation config
    ipcMain.handle('automation:getConfig', async () => {
        try {
            await automationController.loadConfig()
            return automationController.getConfig()
        } catch (error) {
            console.error('Failed to get automation config:', error)
            return null
        }
    })

    // Save automation config
    ipcMain.handle('automation:saveConfig', async (_, config) => {
        try {
            await automationController.saveConfig(config)
            return { success: true }
        } catch (error) {
            console.error('Failed to save automation config:', error)
            return { success: false, error: String(error) }
        }
    })

    // Start campaign - USE NEW CONTROLLER
    ipcMain.handle('automation:startCampaign', async (_event, campaignId: number) => {
        try {
            console.log(`Starting campaign ${campaignId} with AutomationController...`)
            const result = await automationController.startCampaign(campaignId)
            return result
        } catch (error) {
            console.error('Campaign start error:', error)
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
        }
    })

    // Stop campaign
    ipcMain.handle('automation:stopCampaign', async () => {
        await automationController.stop()
        return { success: true }
    })

    // Pause automation
    ipcMain.handle('automation:pause', async () => {
        automationController.pause()
        return { success: true }
    })

    // Resume automation
    ipcMain.handle('automation:resume', async () => {
        automationController.resume()
        return { success: true }
    })

    // Get status
    ipcMain.handle('automation:getStatus', () => {
        return automationController.getStatus()
    })

    // Check if running
    ipcMain.handle('automation:isRunning', () => {
        return automationController.isRunning()
    })

    // Get job queue stats
    ipcMain.handle('automation:getQueueStats', () => {
        const stats = jobQueue.getStats()
        return {
            total: stats.total,
            pending: stats.pending,
            running: stats.running,
            done: stats.done,
            failed: stats.failed,
        }
    })

    // Clear completed jobs
    ipcMain.handle('automation:clearCompleted', () => {
        jobQueue.clearCompleted()
        return { success: true }
    })

    // TEST: Basic browser test
    ipcMain.handle('automation:testBrowser', async () => {
        console.log('Starting browser test...')
        const result = await simpleTestAutomation.testBrowserLaunch()
        console.log('Browser test result:', result)
        return result
    })

    // TEST: Full flow test (Google -> Search -> Maps)
    ipcMain.handle('automation:testFullFlow', async (_event, searchQuery?: string) => {
        console.log('Starting full flow test...')
        const result = await simpleTestAutomation.testFullFlow(searchQuery || 'quán cà phê Hà Nội')
        console.log('Full flow test result:', result)
        return result
    })

    console.log('[IPC] Automation handlers registered')
}

