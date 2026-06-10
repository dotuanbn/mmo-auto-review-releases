import { ipcMain } from 'electron'
import { networkOrchestrator } from '../runtime/v2/networkOrchestrator'

export function registerNetworkHandlers() {
    ipcMain.handle('network:getEffectiveMode', async () => {
        return networkOrchestrator.resolveEffectiveMode()
    })

    ipcMain.handle('network:testConfig', async () => {
        return networkOrchestrator.testConfig()
    })
}

