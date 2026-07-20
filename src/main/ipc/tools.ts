/**
 * IPC Handlers — Tool Builder / Script Runner
 */

import { ipcMain } from 'electron'
import { toolRunnerService } from '../services/ToolRunnerService'
import { toolsRunSchema } from '../../shared/ipc-schemas'
import { parseIpcArgs, withIpcValidation } from './validate'

export function registerToolHandlers(): void {
    ipcMain.handle('tools:list', withIpcValidation('tools:list', () => {
        return toolRunnerService.listTools()
    }))

    ipcMain.handle('tools:run', withIpcValidation('tools:run', (_event, toolName: unknown, args?: unknown) => {
        const [parsedName, parsedArgs] = parseIpcArgs(
            'tools:run',
            toolsRunSchema,
            [toolName, args],
        )
        return toolRunnerService.runTool(parsedName, parsedArgs ?? [])
    }))

    ipcMain.handle('tools:stop', withIpcValidation('tools:stop', () => {
        return { stopped: toolRunnerService.stop() }
    }))
}
