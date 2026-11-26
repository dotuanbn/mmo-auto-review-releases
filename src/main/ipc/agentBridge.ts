import { ipcMain } from 'electron'
import { getAgentBridgeService, rotateAgentBridgeToken } from '../services/AgentBridgeService'
import { withIpcValidation } from './validate'

export function registerAgentBridgeHandlers(): void {
    ipcMain.handle('agentBridge:getState', withIpcValidation('agentBridge:getState', async () => {
        return getAgentBridgeService().getPublicState()
    }))
    ipcMain.handle('agentBridge:rotateToken', withIpcValidation('agentBridge:rotateToken', async () => {
        return rotateAgentBridgeToken()
    }))
}
