/**
 * IPC Handlers — Tool Builder / Script Runner
 */

import { ipcMain } from 'electron'
import { toolRunnerService } from '../services/ToolRunnerService'

export function registerToolHandlers(): void {
    ipcMain.handle('tools:list', () => {
        return toolRunnerService.listTools()
    })

    ipcMain.handle('tools:run', (_event, toolName: string, args?: string[]) => {
        return toolRunnerService.runTool(toolName, args ?? [])
    })

    ipcMain.handle('tools:stop', () => {
        return { stopped: toolRunnerService.stop() }
    })
}
