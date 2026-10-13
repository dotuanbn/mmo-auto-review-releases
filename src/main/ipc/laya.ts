import { ipcMain } from 'electron'
import { layaService } from '../services/LayaService'
import { layaCampaignOptimizer } from '../services/LayaCampaignOptimizer'
import { layaAccountHealthService } from '../services/LayaAccountHealthService'
import type { 
    LayaHealthStatus, 
    LayaRiskContext, 
    LayaRiskResult, 
    LayaDecisionResult,
    CampaignMetricsSnapshot,
    CampaignOptimizationResult,
    AccountHealthContext,
    AccountHealthResult
} from '../../shared/laya-types'

/**
 * Registers all Laya AI related IPC handlers
 */
export function registerLayaIpcHandlers(): void {
    // Health check handler
    ipcMain.handle('laya:healthCheck', async (): Promise<LayaHealthStatus> => {
        try {
            return await layaService.healthCheck()
        } catch (error) {
            console.error('[IPC Laya] healthCheck error:', error)
            throw error
        }
    })

    // Risk score handler
    ipcMain.handle('laya:riskScore', async (_, payload: LayaRiskContext): Promise<LayaRiskResult> => {
        try {
            return await layaService.riskScore(payload)
        } catch (error) {
            console.error('[IPC Laya] riskScore error:', error)
            throw error
        }
    })

    // Decision handler
    ipcMain.handle('laya:decide', async (_, args: { type: string; payload: Record<string, unknown> }): Promise<LayaDecisionResult> => {
        try {
            return await layaService.decide(args.type, args.payload)
        } catch (error) {
            console.error('[IPC Laya] decide error:', error)
            throw error
        }
    })

    // Campaign optimization handler
    ipcMain.handle('laya:optimizeCampaign', async (_, payload: CampaignMetricsSnapshot): Promise<CampaignOptimizationResult> => {
        try {
            return await layaCampaignOptimizer.optimize(payload)
        } catch (error) {
            console.error('[IPC Laya] optimizeCampaign error:', error)
            throw error
        }
    })

    // Should pause campaign handler
    ipcMain.handle('laya:shouldPauseCampaign', async (_, payload: CampaignMetricsSnapshot): Promise<boolean> => {
        try {
            return await layaCampaignOptimizer.shouldPauseCampaign(payload)
        } catch (error) {
            console.error('[IPC Laya] shouldPauseCampaign error:', error)
            throw error
        }
    })

    // Evaluate account health handler
    ipcMain.handle('laya:evaluateAccountHealth', async (_, payload: AccountHealthContext): Promise<AccountHealthResult> => {
        try {
            return await layaAccountHealthService.evaluateHealth(payload)
        } catch (error) {
            console.error('[IPC Laya] evaluateAccountHealth error:', error)
            throw error
        }
    })

    // Rank accounts handler
    ipcMain.handle(
        'laya:rankAccounts',
        async (_, payload: AccountHealthContext[]): Promise<Array<AccountHealthContext & { health: AccountHealthResult }>> => {
            try {
                return await layaAccountHealthService.rankAccounts(payload)
            } catch (error) {
                console.error('[IPC Laya] rankAccounts error:', error)
                throw error
            }
        },
    )
}
