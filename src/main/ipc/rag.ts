import { ipcMain } from 'electron'
import { miniRagService } from '../services/MiniRagService'
import { ragClearScopeSchema } from '../runtime/v2/schemas'
import { createIpcError } from './errors'

export function registerRagHandlers() {
    ipcMain.handle('rag:getStats', async () => {
        try {
            return miniRagService.getStats()
        } catch (error) {
            throw createIpcError('rag:getStats', error)
        }
    })

    ipcMain.handle('rag:clear', async (_event, payload?: { campaignId?: number; domain?: string; riskType?: string }) => {
        try {
            const parsed = ragClearScopeSchema.safeParse(payload)
            if (!parsed.success) {
                throw parsed.error
            }
            const scope = parsed.data
            return miniRagService.clear(scope)
        } catch (error) {
            throw createIpcError('rag:clear', error)
        }
    })
}
