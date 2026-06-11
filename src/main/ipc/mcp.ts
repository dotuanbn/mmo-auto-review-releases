import { ipcMain } from 'electron'
import { mcpHealthService } from '../services/McpHealthService'
import { createIpcError } from './errors'

export function registerMcpHandlers() {
    ipcMain.handle('mcp:getHealth', async () => {
        try {
            return mcpHealthService.getHealth()
        } catch (error) {
            throw createIpcError('mcp:getHealth', error)
        }
    })
}
