import { ipcMain } from 'electron'
import { z } from 'zod'
import { windowTilingService } from '../services/WindowTilingService'
import { createIpcError } from './errors'

const tilingCountSchema = z.number().int().min(1).max(16)
const tilingEnabledSchema = z.boolean()

export function registerTilingIPC(): void {
    ipcMain.handle('tiling:getLayout', (_event, count: number) => {
        try {
            const parsed = tilingCountSchema.safeParse(count || 1)
            if (!parsed.success) {
                throw parsed.error
            }
            return windowTilingService.getLayout(parsed.data)
        } catch (error) {
            throw createIpcError('tiling:getLayout', error)
        }
    })

    ipcMain.handle('tiling:setEnabled', (_event, enabled: boolean) => {
        try {
            const parsed = tilingEnabledSchema.safeParse(enabled)
            if (!parsed.success) {
                throw parsed.error
            }
            windowTilingService.setEnabled(parsed.data)
            return { success: true, enabled: windowTilingService.isEnabled() }
        } catch (error) {
            throw createIpcError('tiling:setEnabled', error)
        }
    })

    ipcMain.handle('tiling:isEnabled', () => {
        try {
            return windowTilingService.isEnabled()
        } catch (error) {
            throw createIpcError('tiling:isEnabled', error)
        }
    })
}
