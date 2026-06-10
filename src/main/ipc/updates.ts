import { ipcMain } from 'electron'
import { updateService } from '../services/UpdateService'

export function registerUpdateHandlers() {
    updateService.init()

    ipcMain.handle('updates:getState', async () => {
        return updateService.getState()
    })

    ipcMain.handle('updates:check', async () => {
        return updateService.checkForUpdates()
    })

    ipcMain.handle('updates:checkAndDownload', async () => {
        return updateService.checkAndDownload()
    })

    ipcMain.handle('updates:download', async () => {
        return updateService.downloadUpdate()
    })

    ipcMain.handle('updates:install', async () => {
        return updateService.installUpdate()
    })
}
