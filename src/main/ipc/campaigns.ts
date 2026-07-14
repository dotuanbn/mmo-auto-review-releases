import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { campaignService } from '../services/CampaignService'
import { automationController } from '../automation/AutomationController'
import {
    campaignCreateSchema,
    campaignUpdateSchema,
    idSchema,
} from '../../shared/ipc-schemas'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

export function registerCampaignHandlers() {
    // Get all campaigns
    ipcMain.handle('campaigns:getAll', withIpcValidation('campaigns:getAll', async () => {
        return campaignService.getAll()
    }))

    // Get running campaigns
    ipcMain.handle('campaigns:getRunning', withIpcValidation('campaigns:getRunning', async () => {
        return campaignService.getRunning()
    }))

    // Get campaign by ID
    ipcMain.handle('campaigns:getById', withIpcValidation('campaigns:getById', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('campaigns:getById', idSchema, id)
        return campaignService.getById(parsedId)
    }))

    // Create new campaign
    ipcMain.handle('campaigns:create', withIpcValidation('campaigns:create', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('campaigns:create', campaignCreateSchema, data)
        return campaignService.create(parsed)
    }))

    // Update campaign
    ipcMain.handle('campaigns:update', withIpcValidation('campaigns:update', async (_event, id: unknown, data: unknown) => {
        const [parsedId, parsedData] = parseIpcArgs(
            'campaigns:update',
            z.tuple([idSchema, campaignUpdateSchema]),
            [id, data],
        )
        // Normalize JSON array fields to string form expected by DB / CampaignService
        const normalized: Parameters<typeof campaignService.update>[1] = {
            ...('name' in parsedData ? { name: parsedData.name } : {}),
            ...('rating' in parsedData ? { rating: parsedData.rating } : {}),
            ...('delayMin' in parsedData ? { delayMin: parsedData.delayMin } : {}),
            ...('delayMax' in parsedData ? { delayMax: parsedData.delayMax } : {}),
            ...('maxReviewsPerAccountPerDay' in parsedData
                ? { maxReviewsPerAccountPerDay: parsedData.maxReviewsPerAccountPerDay }
                : {}),
            ...('projectId' in parsedData ? { projectId: parsedData.projectId ?? undefined } : {}),
            ...('workingHoursStart' in parsedData
                ? { workingHoursStart: parsedData.workingHoursStart ?? undefined }
                : {}),
            ...('workingHoursEnd' in parsedData
                ? { workingHoursEnd: parsedData.workingHoursEnd ?? undefined }
                : {}),
            ...('status' in parsedData ? { status: parsedData.status } : {}),
            ...('progress' in parsedData ? { progress: parsedData.progress } : {}),
            ...('maxMapScroll' in parsedData ? { maxMapScroll: parsedData.maxMapScroll } : {}),
        }
        if (parsedData.locationIds !== undefined) {
            normalized.locationIds = Array.isArray(parsedData.locationIds)
                ? JSON.stringify(parsedData.locationIds)
                : parsedData.locationIds
        }
        if (parsedData.accountIds !== undefined) {
            normalized.accountIds = Array.isArray(parsedData.accountIds)
                ? JSON.stringify(parsedData.accountIds)
                : parsedData.accountIds
        }
        if (parsedData.proxyIds !== undefined) {
            normalized.proxyIds = Array.isArray(parsedData.proxyIds)
                ? JSON.stringify(parsedData.proxyIds)
                : parsedData.proxyIds
        }
        if (parsedData.reviewTemplates !== undefined) {
            normalized.reviewTemplates = Array.isArray(parsedData.reviewTemplates)
                ? JSON.stringify(parsedData.reviewTemplates)
                : parsedData.reviewTemplates
        }
        return campaignService.update(parsedId, normalized)
    }))

    // Delete campaign
    ipcMain.handle('campaigns:delete', withIpcValidation('campaigns:delete', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('campaigns:delete', idSchema, id)
        return campaignService.delete(parsedId)
    }))

    // Start campaign - now properly starts the automation engine
    ipcMain.handle('campaigns:start', withIpcValidation('campaigns:start', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('campaigns:start', idSchema, id)
        try {
            const result = await automationController.startCampaign(parsedId)
            if (result.success) {
                notifyCampaignUpdate(parsedId, 'running', 'Campaign started')
            } else {
                notifyCampaignUpdate(parsedId, 'error', result.error || 'Failed to start')
            }
            return result
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            notifyCampaignUpdate(parsedId, 'error', errorMsg)
            return { success: false, error: errorMsg }
        }
    }))

    // Pause campaign
    ipcMain.handle('campaigns:pause', withIpcValidation('campaigns:pause', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('campaigns:pause', idSchema, id)
        await automationController.pause()
        await campaignService.pause(parsedId)
        notifyCampaignUpdate(parsedId, 'paused', 'Campaign paused')
    }))

    // Stop campaign - now properly stops the automation engine
    ipcMain.handle('campaigns:stop', withIpcValidation('campaigns:stop', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('campaigns:stop', idSchema, id)
        await automationController.stop()
        await campaignService.stop(parsedId)
        notifyCampaignUpdate(parsedId, 'done', 'Campaign stopped')
    }))

    // Get statistics
    ipcMain.handle('campaigns:getStats', withIpcValidation('campaigns:getStats', async () => {
        return campaignService.getStats()
    }))
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
