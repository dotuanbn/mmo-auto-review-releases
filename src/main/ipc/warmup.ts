/**
 * Account Warmup IPC handlers.
 * Channels (exact):
 *   warmup:getStatus(id)
 *   warmup:getAllStatuses
 *   warmup:start(id, { activityType?, durationSeconds? })
 *   warmup:cancel(id)
 *
 * Results pass through engine DTOs (success, message?, code?, status?) —
 * optional `code` is additive for BC with older renderers.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import { idSchema } from '../../shared/ipc-schemas'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'
import { accountWarmupEngine } from '../automation/AccountWarmupEngine'
import type { WarmupActionResultDto } from '../../shared/warmup-contracts'

const warmupActivityTypeSchema = z.enum([
    'google_search',
    'maps_browse',
    'youtube_browse',
    'search',
    'maps',
    'youtube',
])

const warmupStartOptionsSchema = z
    .object({
        activityType: warmupActivityTypeSchema.optional(),
        durationSeconds: z.number().int().min(30).max(600).optional(),
    })
    .strict()
    .optional()
    .default({})

export function registerWarmupHandlers(): void {
    ipcMain.handle(
        'warmup:getStatus',
        withIpcValidation('warmup:getStatus', async (_event, id: unknown) => {
            const accountId = parseIpcPayload('warmup:getStatus', idSchema, id)
            return accountWarmupEngine.getStatus(accountId)
        }),
    )

    ipcMain.handle(
        'warmup:getAllStatuses',
        withIpcValidation('warmup:getAllStatuses', async () => {
            return accountWarmupEngine.getAllStatuses()
        }),
    )

    ipcMain.handle(
        'warmup:start',
        withIpcValidation('warmup:start', async (_event, id: unknown, options: unknown): Promise<WarmupActionResultDto> => {
            const [accountId, opts] = parseIpcArgs(
                'warmup:start',
                z.tuple([idSchema, warmupStartOptionsSchema]),
                [id, options ?? {}],
            )
            return accountWarmupEngine.start(accountId, {
                activityType: opts.activityType,
                durationSeconds: opts.durationSeconds,
            })
        }),
    )

    ipcMain.handle(
        'warmup:cancel',
        withIpcValidation('warmup:cancel', async (_event, id: unknown): Promise<WarmupActionResultDto> => {
            const accountId = parseIpcPayload('warmup:cancel', idSchema, id)
            return accountWarmupEngine.cancel(accountId)
        }),
    )

    console.log('Warmup handlers registered')
}
