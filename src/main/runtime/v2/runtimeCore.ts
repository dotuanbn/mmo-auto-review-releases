import { BrowserWindow } from 'electron'
import { trafficBoostEngine } from '../../automation/TrafficBoostEngine'
import { networkOrchestrator } from './networkOrchestrator'
import { runtimePolicyService } from './runtimePolicy'
import { RuntimeActionEvent, RuntimeDiagnosticsV2, RuntimePolicyV2, RuntimeStatusV2 } from './types'
import { getRuntimeLogger } from '../../utils/runtimeLogger'
import { runtimeActionEventSchema } from './schemas'

class RuntimeCore {
    private readonly logger = getRuntimeLogger({ module: 'runtime-core' })
    private latestStatus: RuntimeStatusV2 = {
        version: 'v2',
        isRunning: false,
        campaignId: null,
        campaignName: '',
        currentRound: 0,
        totalRounds: 0,
        completedVisits: 0,
        totalVisits: 0,
        failedVisits: 0,
        activeThreads: 0,
        threadsTotal: 0,
        message: 'Idle',
        threads: [],
        effectiveNetworkMode: 'direct',
        networkState: networkOrchestrator.getCurrentState(),
        timestamp: new Date().toISOString(),
    }

    private initialized = false

    init(): void {
        if (this.initialized) {
            return
        }
        this.initialized = true

        trafficBoostEngine.onStatus((status) => {
            this.latestStatus = {
                version: 'v2',
                isRunning: status.isRunning,
                campaignId: status.campaignId,
                campaignName: status.campaignName,
                currentRound: status.currentRound,
                totalRounds: status.totalRounds,
                completedVisits: status.completedVisits,
                totalVisits: status.totalVisits,
                failedVisits: status.failedVisits,
                activeThreads: status.activeThreads,
                threadsTotal: status.threadsTotal,
                message: status.message,
                threads: status.threads || [],
                effectiveNetworkMode: status.effectiveNetworkMode || 'direct',
                networkState: status.networkState || networkOrchestrator.getCurrentState(),
                timestamp: new Date().toISOString(),
            }
            this.broadcastStatus()
        })

        trafficBoostEngine.onAction((event) => {
            this.broadcastAction(event)
        })

        runtimePolicyService.applyDefaultsIfMissing()
    }

    async refreshNetworkState(): Promise<void> {
        const state = await networkOrchestrator.resolveEffectiveMode()
        this.latestStatus = {
            ...this.latestStatus,
            effectiveNetworkMode: state.mode,
            networkState: state,
            timestamp: new Date().toISOString(),
        }
    }

    async getStatusV2(): Promise<RuntimeStatusV2> {
        await this.refreshNetworkState()
        return this.latestStatus
    }

    getPolicy(): RuntimePolicyV2 {
        return runtimePolicyService.getPolicy()
    }

    updatePolicy(input: Partial<RuntimePolicyV2>): RuntimePolicyV2 {
        const next = runtimePolicyService.updatePolicy(input)
        this.logger.info({ policy: next }, 'runtime policy updated')
        return next
    }

    async getDiagnostics(): Promise<RuntimeDiagnosticsV2> {
        const diagnostics = trafficBoostEngine.getDiagnostics()
        return {
            ...diagnostics,
            timestamp: new Date().toISOString(),
        }
    }

    private broadcastStatus(): void {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('runtime:statusV2', this.latestStatus)
        }
    }

    private broadcastAction(event: RuntimeActionEvent): void {
        const parsed = runtimeActionEventSchema.safeParse(event)
        if (!parsed.success) {
            this.logger.warn({
                event: 'invalid_runtime_action_event',
                issues: parsed.error.issues.map(issue => issue.message),
            })
            return
        }
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('runtime:actionEvent', parsed.data)
        }
    }
}

export const runtimeCore = new RuntimeCore()
