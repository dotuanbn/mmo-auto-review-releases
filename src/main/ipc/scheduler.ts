/**
 * Scheduler IPC handlers — runtime Zod validation at the boundary.
 * Date/string coercion and structural checks live in shared scheduler-contracts.
 */

import { ipcMain } from 'electron'
import {
    scheduleCreateSchema,
    scheduleDeleteArgsSchema,
    scheduleGetForCampaignArgsSchema,
    scheduleToggleArgsSchema,
    scheduleUpdateArgsSchema,
} from '../../shared/scheduler-contracts'
import { schedulerService } from '../services/SchedulerService'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

export function registerSchedulerHandlers(): void {
    ipcMain.handle(
        'scheduler:create',
        withIpcValidation('scheduler:create', async (_event, config: unknown) => {
            const payload = parseIpcPayload('scheduler:create', scheduleCreateSchema, config)
            return await schedulerService.createSchedule({
                campaignId: payload.campaignId,
                scheduledAt: payload.scheduledAt,
                repeatType: payload.repeatType,
                repeatDays: payload.repeatDays,
                endDate: payload.endDate,
                isActive: payload.isActive,
            })
        }),
    )

    ipcMain.handle(
        'scheduler:update',
        withIpcValidation('scheduler:update', async (_event, id: unknown, config: unknown) => {
            const [scheduleId, payload] = parseIpcArgs(
                'scheduler:update',
                scheduleUpdateArgsSchema,
                [id, config],
            )
            // Service Partial<ScheduleConfig> types endDate as Date | undefined only;
            // runtime still accepts null to clear (updateData.endDate?: Date | null).
            return await schedulerService.updateSchedule(
                scheduleId,
                payload as Parameters<typeof schedulerService.updateSchedule>[1],
            )
        }),
    )

    ipcMain.handle(
        'scheduler:delete',
        withIpcValidation('scheduler:delete', async (_event, id: unknown) => {
            const [scheduleId] = parseIpcArgs('scheduler:delete', scheduleDeleteArgsSchema, [id])
            return await schedulerService.deleteSchedule(scheduleId)
        }),
    )

    ipcMain.handle(
        'scheduler:getForCampaign',
        withIpcValidation('scheduler:getForCampaign', async (_event, campaignId: unknown) => {
            const [parsedCampaignId] = parseIpcArgs(
                'scheduler:getForCampaign',
                scheduleGetForCampaignArgsSchema,
                [campaignId],
            )
            return await schedulerService.getScheduleForCampaign(parsedCampaignId)
        }),
    )

    ipcMain.handle(
        'scheduler:getAll',
        withIpcValidation('scheduler:getAll', async () => {
            return await schedulerService.getAllSchedules()
        }),
    )

    ipcMain.handle(
        'scheduler:toggle',
        withIpcValidation('scheduler:toggle', async (_event, id: unknown) => {
            const [scheduleId] = parseIpcArgs('scheduler:toggle', scheduleToggleArgsSchema, [id])
            return await schedulerService.toggleSchedule(scheduleId)
        }),
    )

    console.log('Scheduler handlers registered')
}
