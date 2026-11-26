import { existsSync, readFileSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { desc } from 'drizzle-orm'
import { browserService } from '../automation/BrowserService'
import { automationController } from '../automation/AutomationController'
import { trafficBoostEngine } from '../automation/TrafficBoostEngine'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import type { AgentBridgeController } from './AgentBridgeService'
import { browserResourceGovernor } from './BrowserResourceGovernor'
import { dataRootService } from './DataRootService'
import { resolveBootstrapLogPath, runtimeHealthService } from './RuntimeHealthService'

const LOG_FILES = ['bootstrap', 'runtime-health', 'proxy-debug'] as const

function tailFile(filePath: string, lines: number): { name: string; exists: boolean; text: string } {
    if (!existsSync(filePath)) {
        return { name: filePath, exists: false, text: '' }
    }
    const raw = readFileSync(filePath)
    const slice = raw.subarray(Math.max(0, raw.length - 256 * 1024)).toString('utf8')
    return {
        name: filePath,
        exists: true,
        text: slice.split(/\r?\n/).slice(-lines).join('\n'),
    }
}

function logPath(name: string): string | null {
    const root = dataRootService.getDataRoot()
    if (name === 'bootstrap') return resolveBootstrapLogPath()
    if (name === 'runtime-health') return join(root, 'logs', 'runtime-health.json')
    if (name === 'proxy-debug') return join(app.getPath('userData'), 'proxy-debug.log')
    return null
}

export function createAgentBridgeController(): AgentBridgeController {
    return {
        snapshot() {
            return {
                version: app.getVersion(),
                memory: process.memoryUsage(),
                system: {
                    freeMB: Math.round(freemem() / 1048576),
                    totalMB: Math.round(totalmem() / 1048576),
                },
                performance: browserResourceGovernor.getSnapshot(),
                health: runtimeHealthService.getSnapshot(),
                traffic: trafficBoostEngine.getStatus(),
                trafficDiagnostics: trafficBoostEngine.getDiagnostics(),
                automation: automationController.getStatus(),
                browser: browserService.getRuntimeStats(),
            }
        },
        listAccounts() {
            const db = getDatabase()
            return db.select({
                id: schema.accounts.id,
                email: schema.accounts.email,
                status: schema.accounts.status,
                warmupLevel: schema.accounts.warmupLevel,
                reputationScore: schema.accounts.reputationScore,
                totalReviews: schema.accounts.totalReviews,
                lastUsed: schema.accounts.lastUsed,
                autoWarmupEnabled: schema.accounts.autoWarmupEnabled,
                birthStoryDay: schema.accounts.birthStoryDay,
            }).from(schema.accounts).all()
        },
        listCampaigns() {
            const db = getDatabase()
            return {
                reviews: db.select({
                    id: schema.campaigns.id,
                    name: schema.campaigns.name,
                    status: schema.campaigns.status,
                    progress: schema.campaigns.progress,
                    totalReviews: schema.campaigns.totalReviews,
                    successReviews: schema.campaigns.successReviews,
                    failedReviews: schema.campaigns.failedReviews,
                }).from(schema.campaigns).orderBy(desc(schema.campaigns.id)).all(),
                traffic: db.select({
                    id: schema.trafficCampaigns.id,
                    name: schema.trafficCampaigns.name,
                    status: schema.trafficCampaigns.status,
                    trafficMode: schema.trafficCampaigns.trafficMode,
                    threadsCount: schema.trafficCampaigns.threadsCount,
                    totalVisits: schema.trafficCampaigns.totalVisits,
                    completedVisits: schema.trafficCampaigns.completedVisits,
                    failedVisits: schema.trafficCampaigns.failedVisits,
                    currentRound: schema.trafficCampaigns.currentRound,
                }).from(schema.trafficCampaigns).orderBy(desc(schema.trafficCampaigns.id)).all(),
            }
        },
        listLocations() {
            const db = getDatabase()
            return db.select({
                id: schema.locations.id,
                name: schema.locations.name,
                status: schema.locations.status,
                address: schema.locations.address,
                category: schema.locations.category,
            }).from(schema.locations).all()
        },
        readLog(name: string, lines: number) {
            const filePath = logPath(name)
            if (!filePath) return { error: 'unknown_log', allowed: LOG_FILES }
            return tailFile(filePath, lines)
        },
        async startTraffic(campaignId: number) {
            await trafficBoostEngine.startCampaign(campaignId)
            return { started: true, kind: 'traffic', campaignId }
        },
        async pauseTraffic() {
            await trafficBoostEngine.pauseCampaign()
            return { paused: true, kind: 'traffic' }
        },
        async resumeTraffic() {
            await trafficBoostEngine.resumeCampaign()
            return { resumed: true, kind: 'traffic' }
        },
        async stopTraffic() {
            await trafficBoostEngine.stopCampaign()
            return { stopped: true, kind: 'traffic' }
        },
        startAutomation(campaignId: number) {
            return automationController.startCampaign(campaignId)
        },
        async pauseAutomation() {
            await automationController.pause()
            return { paused: true, kind: 'automation' }
        },
        async resumeAutomation() {
            await automationController.resume()
            return { resumed: true, kind: 'automation' }
        },
        async stopAutomation() {
            await automationController.stop()
            return { stopped: true, kind: 'automation' }
        },
        recycleBrowser(force: boolean) {
            return browserService.recycleSharedBrowser(force)
        },
    }
}
