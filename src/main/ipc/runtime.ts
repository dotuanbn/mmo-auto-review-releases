import { ipcMain } from 'electron'
import { runtimeCore } from '../runtime/v2/runtimeCore'
import { runtimePolicyPatchSchema } from '../runtime/v2/schemas'
import { createIpcError } from './errors'

export function registerRuntimeHandlers() {
    runtimeCore.init()

    ipcMain.handle('runtime:getStatusV2', async () => {
        try {
            return runtimeCore.getStatusV2()
        } catch (error) {
            throw createIpcError('runtime:getStatusV2', error)
        }
    })

    ipcMain.handle('runtime:getDiagnostics', async () => {
        try {
            return runtimeCore.getDiagnostics()
        } catch (error) {
            throw createIpcError('runtime:getDiagnostics', error)
        }
    })

    ipcMain.handle('runtime:getPolicy', async () => {
        try {
            return runtimeCore.getPolicy()
        } catch (error) {
            throw createIpcError('runtime:getPolicy', error)
        }
    })

    ipcMain.handle('runtime:updatePolicy', async (_event, patch: Record<string, unknown>) => {
        try {
            const parsed = runtimePolicyPatchSchema.safeParse(patch || {})
            if (!parsed.success) {
                throw parsed.error
            }
            return runtimeCore.updatePolicy(parsed.data)
        } catch (error) {
            throw createIpcError('runtime:updatePolicy', error)
        }
    })
}
