import { registerAccountHandlers } from './accounts'
import { registerProxyHandlers } from './proxies'
import { registerLocationHandlers } from './locations'
import { registerCampaignHandlers } from './campaigns'
import { registerReviewHandlers } from './reviews'
import { registerAutomationHandlers } from './automation'
import { registerSettingsHandlers } from './settings'
import { registerTrafficHandlers } from './traffic'
import { registerProjectHandlers } from './projects'
import { registerScriptHandlers } from './scripts'
import { registerTemplateHandlers } from './templates'
import { registerAIHandlers } from './ai'
import { registerImageHandlers } from './images'
import { registerSchedulerHandlers } from './scheduler'
import { registerFProxyHandlers } from './fproxy'
import { registerOllamaHandlers } from './ollama'
import { registerRuntimeHandlers } from './runtime'
import { registerNetworkHandlers } from './network'
import { registerProfileHandlers } from './profiles'
import { registerUpdateHandlers } from './updates'
import { registerDataHandlers } from './data'
import { registerComplianceHandlers } from './compliance'
import { registerReportHandlers } from './reports'
import { registerRagHandlers } from './rag'
import { registerMcpHandlers } from './mcp'
import { registerSoakHandlers } from './soak'
import { registerTilingIPC } from './tiling'
import { registerAnalyticsHandlers } from './analytics'
import { registerHFModelHandlers } from './hfmodel'
import { registerTrackioHandlers } from './trackio'
import { registerDatasetHandlers } from './datasets'
import { registerToolHandlers } from './tools'

// Register all IPC handlers
export function registerAllHandlers() {
    registerAccountHandlers()
    registerProxyHandlers()
    registerLocationHandlers()
    registerCampaignHandlers()
    registerReviewHandlers()
    registerAutomationHandlers()
    registerSettingsHandlers()
    registerTrafficHandlers()
    registerProjectHandlers()
    registerScriptHandlers()
    registerTemplateHandlers()
    registerAIHandlers()
    registerImageHandlers()
    registerSchedulerHandlers()
    registerFProxyHandlers()
    registerOllamaHandlers()
    registerRuntimeHandlers()
    registerNetworkHandlers()
    registerProfileHandlers()
    registerUpdateHandlers()
    registerDataHandlers()
    registerComplianceHandlers()
    registerReportHandlers()
    registerRagHandlers()
    registerMcpHandlers()
    registerSoakHandlers()
    registerTilingIPC()
    registerAnalyticsHandlers()
    registerHFModelHandlers()
    registerTrackioHandlers()
    registerDatasetHandlers()
    registerToolHandlers()

    console.log('All IPC handlers registered')
}
