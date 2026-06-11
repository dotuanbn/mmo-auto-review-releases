import { ipcMain } from 'electron'
import { trafficBoostEngine } from '../automation/TrafficBoostEngine'
import { reportActionTraceQuerySchema } from '../runtime/v2/schemas'

export function registerReportHandlers() {
    ipcMain.handle('reports:getActionTrace', async (_event, payload?: { campaignId?: number; limit?: number }) => {
        const parsed = reportActionTraceQuerySchema.safeParse(payload || {})
        if (!parsed.success) {
            throw new Error('Invalid reports:getActionTrace payload')
        }
        return trafficBoostEngine.getActionTrace(parsed.data.campaignId, parsed.data.limit)
    })
}
