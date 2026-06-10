/**
 * IPC Handlers — HuggingFace Dataset Browser
 */

import { ipcMain } from 'electron'
import { datasetService } from '../services/DatasetService'

export function registerDatasetHandlers(): void {
    ipcMain.handle('datasets:isValid', (_event, datasetId: string) => {
        return datasetService.isValid(datasetId)
    })

    ipcMain.handle('datasets:listSplits', (_event, datasetId: string) => {
        return datasetService.listSplits(datasetId)
    })

    ipcMain.handle('datasets:previewRows', (_event, datasetId: string, config: string, split: string, limit?: number) => {
        return datasetService.previewRows(datasetId, config, split, limit)
    })

    ipcMain.handle('datasets:getRows', (_event, datasetId: string, config: string, split: string, offset?: number, length?: number) => {
        return datasetService.getRows(datasetId, config, split, offset, length)
    })

    ipcMain.handle('datasets:search', (_event, datasetId: string, config: string, split: string, query: string, offset?: number, length?: number) => {
        return datasetService.search(datasetId, config, split, query, offset, length)
    })

    ipcMain.handle('datasets:getSize', (_event, datasetId: string) => {
        return datasetService.getSize(datasetId)
    })

    ipcMain.handle('datasets:getStatistics', (_event, datasetId: string, config: string, split: string) => {
        return datasetService.getStatistics(datasetId, config, split)
    })
}
