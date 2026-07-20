import { ipcMain, BrowserWindow } from 'electron'
import { simpleTestAutomation } from '../automation/SimpleTestAutomation'
import { automationController } from '../automation/AutomationController'
import { jobQueue } from '../automation/JobQueue'
import { reviewRecoveryService } from '../automation/ReviewRecoveryService'
import {
    automationCampaignIdSchema,
    automationConfigSaveSchema,
    automationOptionalCampaignIdSchema,
    automationTestQuerySchema,
    type AutomationActionResult,
    type AutomationQueueStatsDto,
    type RecoveryReportDto,
    type ResumePlanDto,
} from '../../shared/automation-contracts'
import { parseIpcPayload, withIpcValidation } from './validate'

export function registerAutomationHandlers(mainWindow?: BrowserWindow) {
    // Set main window for status updates (if provided)
    if (mainWindow) {
        automationController.setMainWindow(mainWindow)
    }

    // Get automation config
    ipcMain.handle(
        'automation:getConfig',
        withIpcValidation('automation:getConfig', async () => {
            await automationController.loadConfig()
            return automationController.getConfig()
        }),
    )

    // Save automation config (Zod-validated partial whitelist)
    ipcMain.handle(
        'automation:saveConfig',
        withIpcValidation(
            'automation:saveConfig',
            async (_event, config: unknown): Promise<AutomationActionResult> => {
                const parsed = parseIpcPayload(
                    'automation:saveConfig',
                    automationConfigSaveSchema,
                    config,
                )
                await automationController.saveConfig(parsed)
                return { success: true }
            },
        ),
    )

    // Start campaign
    ipcMain.handle(
        'automation:startCampaign',
        withIpcValidation(
            'automation:startCampaign',
            async (_event, campaignId: unknown): Promise<AutomationActionResult> => {
                const id = parseIpcPayload(
                    'automation:startCampaign',
                    automationCampaignIdSchema,
                    campaignId,
                )
                console.log(`Starting campaign ${id} with AutomationController...`)
                return automationController.startCampaign(id)
            },
        ),
    )

    // Stop campaign
    ipcMain.handle(
        'automation:stopCampaign',
        withIpcValidation('automation:stopCampaign', async () => {
            await automationController.stop()
            return { success: true } satisfies AutomationActionResult
        }),
    )

    // Pause automation
    ipcMain.handle(
        'automation:pause',
        withIpcValidation('automation:pause', async () => {
            await automationController.pause()
            return { success: true } satisfies AutomationActionResult
        }),
    )

    // Resume automation (global pause resume — not crash recovery)
    ipcMain.handle(
        'automation:resume',
        withIpcValidation('automation:resume', async () => {
            await automationController.resume()
            return { success: true } satisfies AutomationActionResult
        }),
    )

    // Deterministic resume of pending durable jobs for one campaign
    ipcMain.handle(
        'automation:resumeCampaign',
        withIpcValidation(
            'automation:resumeCampaign',
            async (_event, campaignId: unknown): Promise<AutomationActionResult> => {
                const id = parseIpcPayload(
                    'automation:resumeCampaign',
                    automationCampaignIdSchema,
                    campaignId,
                )
                return automationController.resumeCampaign(id)
            },
        ),
    )

    // Get status
    ipcMain.handle(
        'automation:getStatus',
        withIpcValidation('automation:getStatus', () => {
            return automationController.getStatus()
        }),
    )

    // Check if running
    ipcMain.handle(
        'automation:isRunning',
        withIpcValidation('automation:isRunning', () => {
            return automationController.isRunning()
        }),
    )

    // Get job queue stats
    ipcMain.handle(
        'automation:getQueueStats',
        withIpcValidation(
            'automation:getQueueStats',
            (_event, campaignId?: unknown): AutomationQueueStatsDto => {
                const id =
                    campaignId === undefined || campaignId === null
                        ? undefined
                        : parseIpcPayload(
                              'automation:getQueueStats',
                              automationOptionalCampaignIdSchema,
                              campaignId,
                          )
                const stats = jobQueue.getStats(id)
                return {
                    total: stats.total,
                    pending: stats.pending,
                    running: stats.running,
                    done: stats.done,
                    failed: stats.failed,
                }
            },
        ),
    )

    // Clear completed jobs
    ipcMain.handle(
        'automation:clearCompleted',
        withIpcValidation(
            'automation:clearCompleted',
            (_event, campaignId?: unknown): AutomationActionResult => {
                const id =
                    campaignId === undefined || campaignId === null
                        ? undefined
                        : parseIpcPayload(
                              'automation:clearCompleted',
                              automationOptionalCampaignIdSchema,
                              campaignId,
                          )
                jobQueue.clearCompleted(id)
                return { success: true }
            },
        ),
    )

    // Readonly: last boot recovery report (null if recovery not run yet)
    ipcMain.handle(
        'automation:getRecoveryReport',
        withIpcValidation(
            'automation:getRecoveryReport',
            (): RecoveryReportDto | null => {
                return reviewRecoveryService.getLastReport()
            },
        ),
    )

    // Readonly: deterministic resume plan for one campaign
    ipcMain.handle(
        'automation:getResumePlan',
        withIpcValidation(
            'automation:getResumePlan',
            async (_event, campaignId: unknown): Promise<ResumePlanDto> => {
                const id = parseIpcPayload(
                    'automation:getResumePlan',
                    automationCampaignIdSchema,
                    campaignId,
                )
                return reviewRecoveryService.getResumePlan(id)
            },
        ),
    )

    // TEST: Basic browser test
    ipcMain.handle(
        'automation:testBrowser',
        withIpcValidation('automation:testBrowser', async () => {
            console.log('Starting browser test...')
            const result = await simpleTestAutomation.testBrowserLaunch()
            console.log('Browser test result:', result)
            return result
        }),
    )

    // TEST: Full flow test (Google -> Search -> Maps)
    ipcMain.handle(
        'automation:testFullFlow',
        withIpcValidation(
            'automation:testFullFlow',
            async (_event, searchQuery?: unknown) => {
                const query =
                    searchQuery === undefined || searchQuery === null || searchQuery === ''
                        ? undefined
                        : parseIpcPayload(
                              'automation:testFullFlow',
                              automationTestQuerySchema,
                              searchQuery,
                          )
                console.log('Starting full flow test...')
                const result = await simpleTestAutomation.testFullFlow(
                    query || 'quán cà phê Hà Nội',
                )
                console.log('Full flow test result:', result)
                return result
            },
        ),
    )

    console.log('[IPC] Automation handlers registered')
}
