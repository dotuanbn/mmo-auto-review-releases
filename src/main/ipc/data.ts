import { ipcMain } from 'electron'
import { dataRootService } from '../services/DataRootService'

export function registerDataHandlers() {
    ipcMain.handle('data:getRoot', async () => {
        return {
            dataRoot: dataRootService.getDataRoot(),
        }
    })

    ipcMain.handle('data:detectLegacy', async () => {
        return dataRootService.detectLegacyRoots()
    })

    ipcMain.handle('data:migrateLegacy', async (_event, sourcePath?: string) => {
        return dataRootService.migrateLegacyData(sourcePath)
    })
}

