/**
 * IPC Handlers — Trackio AI Metrics
 */

import { ipcMain } from 'electron'
import { trackioService } from '../services/TrackioService'

export function registerTrackioHandlers(): void {
    ipcMain.handle('trackio:getMetrics', (_event, timeRange?: string) => {
        return trackioService.getMetricsSummary(
            (timeRange as 'hour' | 'day' | 'week') ?? 'day'
        )
    })

    ipcMain.handle('trackio:getHistory', (_event, limit?: number) => {
        return trackioService.getInferenceHistory(limit ?? 50)
    })

    ipcMain.handle('trackio:getAlerts', () => {
        return trackioService.checkAlerts()
    })

    ipcMain.handle('trackio:cleanup', (_event, keepDays?: number) => {
        const deleted = trackioService.cleanup(keepDays ?? 30)
        return { deleted }
    })
}
