import { ipcMain } from 'electron'
import { z } from 'zod'
import { soakTestService } from '../services/SoakTestService'
import { createIpcError } from './errors'

const soakStartSchema = z.object({
    durationHours: z.number().int().min(1).max(72).optional(),
    intervalSeconds: z.number().int().min(5).max(600).optional(),
    tag: z.string().trim().max(64).optional(),
}).optional()

export function registerSoakHandlers() {
    ipcMain.handle('soak:start', async (_event, payload?: unknown) => {
        try {
            const parsed = soakStartSchema.safeParse(payload)
            if (!parsed.success) {
                throw parsed.error
            }
            return soakTestService.start(parsed.data)
        } catch (error) {
            throw createIpcError('soak:start', error)
        }
    })

    ipcMain.handle('soak:stop', async (_event, reason?: unknown) => {
        try {
            const parsedReason = typeof reason === 'string' ? reason.trim().slice(0, 100) : 'manual_stop'
            return soakTestService.stop(parsedReason || 'manual_stop')
        } catch (error) {
            throw createIpcError('soak:stop', error)
        }
    })

    ipcMain.handle('soak:status', async () => {
        try {
            return soakTestService.getStatus()
        } catch (error) {
            throw createIpcError('soak:status', error)
        }
    })
}
