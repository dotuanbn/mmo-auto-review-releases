import { contextBridge, ipcRenderer } from 'electron'
import type {
    AccountCreatePayload,
    AccountImportPayload,
    AccountLiveCheckResult,
    AccountLoginResult,
    AccountStats,
    AccountUpdatePayload,
    PublicAccount,
} from '../shared/account-contracts'
import type {
    PublicProxy,
    ProxyCreatePayload,
    ProxyRuntimeCheckResult,
    ProxyStats,
    ProxyUpdatePayload,
} from '../shared/proxy-contracts'
import type {
    AccountWarmupStatusDto,
    WarmupActionResultDto,
    WarmupStartOptions,
} from '../shared/warmup-contracts'
import type {
    AutomationActionResult,
    AutomationConfigDto,
    AutomationConfigSavePayload,
    AutomationQueueStatsDto,
    RecoveryReportDto,
    ResumePlanDto,
} from '../shared/automation-contracts'
import type { SettingsKey } from '../shared/ipc-schemas'
import type { SettingsRecord, SettingsValue } from '../shared/types'
import type {
    CaptchaMetricsResetResult,
    CaptchaMetricsSnapshot,
} from '../shared/captcha-metrics-contracts'
import type {
    PendingReviewIntent,
    ReviewIntentReconcileResult,
    ReviewReconcileOutcome,
} from '../shared/compliance-contracts'
import type {
    CreateBackupOptionsInput,
    CreateBackupResult,
    PublicBackupInspect,
    PublicBackupSummary,
    RestoreBackupOptionsInput,
    RestoreBackupResult,
} from '../shared/backup-contracts'
import type {
    ComplianceAuditListResult,
    ComplianceAuditQuery,
} from '../shared/compliance-audit-contracts'
import type {
    TrafficVisitQueueStatsDto,
    TrafficVisitRecoverResult,
} from '../shared/traffic-visit-contracts'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // App
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPaths: () => ipcRenderer.invoke('app:getPaths'),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    reloadWindow: (reason?: string) => ipcRenderer.invoke('app:reloadWindow', reason),
    reportRendererEvent: (payload: { level?: 'info' | 'warn' | 'error'; message: string }) =>
        ipcRenderer.invoke('app:reportRendererEvent', payload),

    // Accounts — IPC returns PublicAccount (no password / twoFactorSecret)
    accounts: {
        getAll: (): Promise<PublicAccount[]> => ipcRenderer.invoke('accounts:getAll'),
        getActiveCount: (): Promise<number> => ipcRenderer.invoke('accounts:getActiveCount'),
        getById: (id: number): Promise<PublicAccount | undefined> =>
            ipcRenderer.invoke('accounts:getById', id),
        add: (data: AccountCreatePayload): Promise<PublicAccount> =>
            ipcRenderer.invoke('accounts:add', data),
        update: (id: number, data: AccountUpdatePayload): Promise<PublicAccount | undefined> =>
            ipcRenderer.invoke('accounts:update', id, data),
        delete: (id: number): Promise<void> => ipcRenderer.invoke('accounts:delete', id),
        importCSV: (accounts: AccountImportPayload[]): Promise<number> =>
            ipcRenderer.invoke('accounts:importCSV', accounts),
        getStats: (): Promise<AccountStats> => ipcRenderer.invoke('accounts:getStats'),
        testLogin: (id: number): Promise<AccountLoginResult> =>
            ipcRenderer.invoke('accounts:testLogin', id),
        loginVisible: (id: number): Promise<AccountLoginResult> =>
            ipcRenderer.invoke('accounts:loginVisible', id),
        checkLiveDie: (id: number): Promise<AccountLiveCheckResult> =>
            ipcRenderer.invoke('accounts:checkLiveDie', id),
        checkAllPending: (): Promise<{ checked: number; alive: number; dead: number }> =>
            ipcRenderer.invoke('accounts:checkAllPending'),
        openManualLogin: (id: number): Promise<AccountLoginResult> =>
            ipcRenderer.invoke('accounts:openManualLogin', id),
    },

    warmup: {
        getStatus: (id: number): Promise<AccountWarmupStatusDto> =>
            ipcRenderer.invoke('warmup:getStatus', id),
        getAllStatuses: (): Promise<AccountWarmupStatusDto[]> =>
            ipcRenderer.invoke('warmup:getAllStatuses'),
        start: (id: number, options?: WarmupStartOptions): Promise<WarmupActionResultDto> =>
            ipcRenderer.invoke('warmup:start', id, options),
        cancel: (id: number): Promise<WarmupActionResultDto> =>
            ipcRenderer.invoke('warmup:cancel', id),
    },

    // Proxies
    proxies: {
        getAll: (): Promise<PublicProxy[]> => ipcRenderer.invoke('proxies:getAll'),
        getActive: (): Promise<PublicProxy[]> => ipcRenderer.invoke('proxies:getActive'),
        getActiveCount: () => ipcRenderer.invoke('proxies:getActiveCount'),
        add: (data: ProxyCreatePayload): Promise<PublicProxy> =>
            ipcRenderer.invoke('proxies:add', data),
        update: (id: number, data: ProxyUpdatePayload): Promise<PublicProxy | undefined> =>
            ipcRenderer.invoke('proxies:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('proxies:delete', id),
        check: (id: number) => ipcRenderer.invoke('proxies:check', id),
        checkRuntime: (id: number): Promise<ProxyRuntimeCheckResult> =>
            ipcRenderer.invoke('proxies:checkRuntime', id),
        checkAll: () => ipcRenderer.invoke('proxies:checkAll'),
        importText: (text: string, defaultProvider?: string) => ipcRenderer.invoke('proxies:importText', text, defaultProvider),
        deleteDead: () => ipcRenderer.invoke('proxies:deleteDead'),
        getStats: (): Promise<ProxyStats> => ipcRenderer.invoke('proxies:getStats'),
    },

    // FProxy API (fproxy.me rotating proxy)
    fproxy: {
        setApiKey: (apiKey: string) => ipcRenderer.invoke('fproxy:setApiKey', apiKey),
        getNew: () => ipcRenderer.invoke('fproxy:getNew'),
        getInfo: () => ipcRenderer.invoke('fproxy:getInfo'),
        test: () => ipcRenderer.invoke('fproxy:test'),
        testApi: () => ipcRenderer.invoke('fproxy:testApi'), // Settings: test proxy API endpoint + live proxy connect
    },

    // Locations
    locations: {
        getAll: () => ipcRenderer.invoke('locations:getAll'),
        getPending: () => ipcRenderer.invoke('locations:getPending'),
        add: (data: { name: string; url: string; placeId?: string; address?: string; phone?: string; website?: string; category?: string; targetRating?: number; targetReviews?: number }) =>
            ipcRenderer.invoke('locations:add', data),
        addFromUrl: (url: string, targetReviews?: number, phone?: string, website?: string) => ipcRenderer.invoke('locations:addFromUrl', url, targetReviews, phone, website),
        parseUrl: (url: string) => ipcRenderer.invoke('locations:parseUrl', url), // returns {name, placeId?, address?, cid?, featureHex?}
        update: (id: number, data: any) => ipcRenderer.invoke('locations:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('locations:delete', id),
        getStats: () => ipcRenderer.invoke('locations:getStats'),
    },

    // Campaigns
    campaigns: {
        getAll: () => ipcRenderer.invoke('campaigns:getAll'),
        getRunning: () => ipcRenderer.invoke('campaigns:getRunning'),
        getById: (id: number) => ipcRenderer.invoke('campaigns:getById', id),
        create: (data: {
            name: string
            locationIds: number[]
            accountIds?: number[]
            proxyIds?: number[]
            reviewTemplates: string[]
            rating?: number
            delayMin?: number
            delayMax?: number
            maxReviewsPerAccountPerDay?: number
        }) => ipcRenderer.invoke('campaigns:create', data),
        update: (id: number, data: any) => ipcRenderer.invoke('campaigns:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('campaigns:delete', id),
        start: (id: number) => ipcRenderer.invoke('campaigns:start', id),
        pause: (id: number) => ipcRenderer.invoke('campaigns:pause', id),
        stop: (id: number) => ipcRenderer.invoke('campaigns:stop', id),
        getStats: () => ipcRenderer.invoke('campaigns:getStats'),
    },

    // Reviews
    reviews: {
        getAll: () => ipcRenderer.invoke('reviews:getAll'),
        getByCampaign: (campaignId: number) => ipcRenderer.invoke('reviews:getByCampaign', campaignId),
        getRecent: (limit?: number) => ipcRenderer.invoke('reviews:getRecent', limit),
        getToday: () => ipcRenderer.invoke('reviews:getToday'),
        getStats: () => ipcRenderer.invoke('reviews:getStats'),
        getHistory: (filters?: any) => ipcRenderer.invoke('reviews:getHistory', filters),
    },

    // Settings (key-value; whitelist + schema enforced in main).
    // Secret keys (groqApiKey, fproxyApiKey, captchaSolverApiKey) are never returned raw:
    // nonempty secrets appear as ASCII mask '********'. saveAll: mask = keep, '' = clear, other = replace.
    settings: {
        get: (key: SettingsKey) => ipcRenderer.invoke('settings:get', key) as Promise<SettingsValue | undefined>,
        set: (key: SettingsKey, value: SettingsValue) =>
            ipcRenderer.invoke('settings:set', key, value) as Promise<void>,
        getAll: () => ipcRenderer.invoke('settings:getAll') as Promise<SettingsRecord>,
        saveAll: (settings: Partial<Record<SettingsKey, SettingsValue>>) =>
            ipcRenderer.invoke('settings:saveAll', settings) as Promise<SettingsRecord>,
        resetDefaults: () => ipcRenderer.invoke('settings:resetDefaults') as Promise<SettingsRecord>,
    },

    // Analytics (Google Analytics + Search Console + GBP Scraping)
    analytics: {
        getData: (locationId: number, dateRange?: { from: string; to: string }) =>
            ipcRenderer.invoke('analytics:getData', locationId, dateRange),
        collect: (locationId: number) => ipcRenderer.invoke('analytics:collect', locationId),
        testApiConnection: () => ipcRenderer.invoke('analytics:testApiConnection'),
        selectKeyFile: () => ipcRenderer.invoke('analytics:selectKeyFile'),
        updateLocationConfig: (locationId: number, config: any) =>
            ipcRenderer.invoke('analytics:updateLocationConfig', locationId, config),
        getLocationConfig: (locationId: number) =>
            ipcRenderer.invoke('analytics:getLocationConfig', locationId),
        getLocationsWithConfig: () => ipcRenderer.invoke('analytics:getLocationsWithConfig'),
        // OAuth2 flow
        startGoogleLogin: (loginHint?: string) => ipcRenderer.invoke('analytics:startGoogleLogin', loginHint),
        getGoogleLoginStatus: (email?: string) => ipcRenderer.invoke('analytics:getGoogleLoginStatus', email),
        logoutGoogle: (email?: string) => ipcRenderer.invoke('analytics:logoutGoogle', email),
        listGA4Properties: (email?: string) => ipcRenderer.invoke('analytics:listGA4Properties', email),
        listSearchConsoleSites: (email?: string) => ipcRenderer.invoke('analytics:listSearchConsoleSites', email),
    },

    // Automation — typed via shared/automation-contracts
    automation: {
        getConfig: (): Promise<AutomationConfigDto | null> =>
            ipcRenderer.invoke('automation:getConfig'),
        saveConfig: (config: AutomationConfigSavePayload): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:saveConfig', config),
        startCampaign: (campaignId: number): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:startCampaign', campaignId),
        resumeCampaign: (campaignId: number): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:resumeCampaign', campaignId),
        stopCampaign: (): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:stopCampaign'),
        pause: (): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:pause'),
        resume: (): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:resume'),
        getStatus: (): Promise<unknown> =>
            ipcRenderer.invoke('automation:getStatus'),
        isRunning: (): Promise<boolean> =>
            ipcRenderer.invoke('automation:isRunning'),
        getQueueStats: (campaignId?: number): Promise<AutomationQueueStatsDto> =>
            ipcRenderer.invoke('automation:getQueueStats', campaignId),
        clearCompleted: (campaignId?: number): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:clearCompleted', campaignId),
        /** Readonly boot recovery snapshot — never auto-starts browsers. */
        getRecoveryReport: (): Promise<RecoveryReportDto | null> =>
            ipcRenderer.invoke('automation:getRecoveryReport'),
        /** Readonly resume eligibility for one campaign (pending jobs only). */
        getResumePlan: (campaignId: number): Promise<ResumePlanDto> =>
            ipcRenderer.invoke('automation:getResumePlan', campaignId),
        // Status updates from main process
        onStatusUpdate: (callback: (status: unknown) => void): (() => void) => {
            const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
            ipcRenderer.on('automation:status', handler)
            return () => ipcRenderer.removeListener('automation:status', handler)
        },
        // Test functions for debugging
        testBrowser: (): Promise<AutomationActionResult> =>
            ipcRenderer.invoke('automation:testBrowser'),
        testFullFlow: (
            searchQuery?: string,
        ): Promise<{ success: boolean; step?: string; error?: string }> =>
            ipcRenderer.invoke('automation:testFullFlow', searchQuery),
    },

    // Traffic Booster
    traffic: {
        getAll: () => ipcRenderer.invoke('traffic:getAll'),
        create: (data: { locationId: number; targetViews: number; viewsPerDay?: number; useProxies?: boolean }) =>
            ipcRenderer.invoke('traffic:create', data),
        update: (id: number, data: any) => ipcRenderer.invoke('traffic:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('traffic:delete', id),
        start: (id: number) => ipcRenderer.invoke('traffic:start', id),
        stop: (id: number) => ipcRenderer.invoke('traffic:stop', id),
        getStats: () => ipcRenderer.invoke('traffic:getStats'),
    },

    // Traffic Boost Engine (Smart SEO)
    trafficBoost: {
        getCampaigns: () => ipcRenderer.invoke('trafficBoost:getCampaigns'),
        createCampaign: (data: {
            name: string
            accountIds: number[]
            locationIds: number[]
            threadsCount?: number
            visitsPerLocation?: number
            delayMinSeconds?: number
            delayMaxSeconds?: number
            actionsPerVisit?: number
            fixedActionCount?: boolean
            enabledActions?: string[]
            trafficMode?: 'direct' | 'organic' | 'web_seo' | 'map_search'
            searchKeywords?: string[]
            maxMapScroll?: number
        }) => ipcRenderer.invoke('trafficBoost:createCampaign', data),
        updateCampaign: (id: number, data: any) => ipcRenderer.invoke('trafficBoost:updateCampaign', id, data),
        deleteCampaign: (id: number) => ipcRenderer.invoke('trafficBoost:deleteCampaign', id),
        deleteCampaigns: (ids: number[]) => ipcRenderer.invoke('trafficBoost:deleteCampaigns', ids),
        start: (id: number) => ipcRenderer.invoke('trafficBoost:start', id),
        stop: () => ipcRenderer.invoke('trafficBoost:stop'),
        pause: () => ipcRenderer.invoke('trafficBoost:pause'),
        resume: () => ipcRenderer.invoke('trafficBoost:resume'),
        getStatus: () => ipcRenderer.invoke('trafficBoost:getStatus'),
        getReport: (id: number) => ipcRenderer.invoke('trafficBoost:getReport', id),
        getLogs: (campaignId: number) => ipcRenderer.invoke('trafficBoost:getLogs', campaignId),
        getAudit: (campaignId: number) => ipcRenderer.invoke('trafficBoost:getAudit', campaignId),
        /** Durable per-visit queue counters — channel trafficBoost:getVisitQueueStats. */
        getVisitQueueStats: (campaignId: number): Promise<TrafficVisitQueueStatsDto> =>
            ipcRenderer.invoke('trafficBoost:getVisitQueueStats', campaignId),
        /** Recover expired running visit leases — channel trafficBoost:recoverVisitLeases. */
        recoverVisitLeases: (campaignId: number): Promise<TrafficVisitRecoverResult> =>
            ipcRenderer.invoke('trafficBoost:recoverVisitLeases', campaignId),
        // Real-time status updates from main process
        onStatusUpdate: (callback: (status: any) => void) => {
            const handler = (_event: any, status: any) => callback(status)
            ipcRenderer.on('trafficBoost:status', handler)
            return () => ipcRenderer.removeListener('trafficBoost:status', handler)
        },
    },

    // Runtime V2
    runtime: {
        getStatusV2: () => ipcRenderer.invoke('runtime:getStatusV2'),
        getDiagnostics: () => ipcRenderer.invoke('runtime:getDiagnostics'),
        getPolicy: () => ipcRenderer.invoke('runtime:getPolicy'),
        updatePolicy: (patch: Record<string, unknown>) => ipcRenderer.invoke('runtime:updatePolicy', patch),
        onStatusV2: (callback: (status: any) => void) => {
            const handler = (_event: any, status: any) => callback(status)
            ipcRenderer.on('runtime:statusV2', handler)
            return () => ipcRenderer.removeListener('runtime:statusV2', handler)
        },
        onActionEvent: (callback: (event: any) => void) => {
            const handler = (_event: any, payload: any) => callback(payload)
            ipcRenderer.on('runtime:actionEvent', handler)
            return () => ipcRenderer.removeListener('runtime:actionEvent', handler)
        },
    },

    // Network Orchestrator
    network: {
        getEffectiveMode: () => ipcRenderer.invoke('network:getEffectiveMode'),
        testConfig: () => ipcRenderer.invoke('network:testConfig'),
    },

    // Session Profile V2
    profiles: {
        list: () => ipcRenderer.invoke('profiles:list'),
        get: (accountId: number) => ipcRenderer.invoke('profiles:get', accountId),
        create: (accountId: number) => ipcRenderer.invoke('profiles:create', accountId),
        update: (payload: { accountId: number; profilePath?: string; basePath?: string }) =>
            ipcRenderer.invoke('profiles:update', payload),
        delete: (accountId: number) => ipcRenderer.invoke('profiles:delete', accountId),
        migrate: (payload: { accountId: number; targetBasePath: string }) =>
            ipcRenderer.invoke('profiles:migrate', payload),
    },

    // Portable data root + migration + storage usage + managed backup / audit
    data: {
        getRoot: () => ipcRenderer.invoke('data:getRoot'),
        detectLegacy: () => ipcRenderer.invoke('data:detectLegacy'),
        migrateLegacy: (sourcePath?: string) => ipcRenderer.invoke('data:migrateLegacy', sourcePath),
        getStorageInfo: () => ipcRenderer.invoke('data:getStorageInfo'),
        openPath: (targetPath: string) => ipcRenderer.invoke('data:openPath', targetPath),
        clearCaches: () => ipcRenderer.invoke('data:clearCaches'),
        /** Managed backup — channel data:backupCreate (options?). */
        createBackup: (options?: CreateBackupOptionsInput): Promise<CreateBackupResult> =>
            ipcRenderer.invoke('data:backupCreate', options),
        /** Managed backup list — channel data:backupList. */
        listBackups: (): Promise<PublicBackupSummary[]> =>
            ipcRenderer.invoke('data:backupList'),
        /** Inspect one backup package — channel data:backupInspect(backupId). */
        inspectBackup: (backupId: string): Promise<PublicBackupInspect> =>
            ipcRenderer.invoke('data:backupInspect', backupId),
        /** Restore from managed backup — channel data:backupRestore(options). */
        restoreBackup: (options: RestoreBackupOptionsInput): Promise<RestoreBackupResult> =>
            ipcRenderer.invoke('data:backupRestore', options),
        /** Bounded compliance audit history — channel data:getComplianceAudit(query?). */
        getComplianceAudit: (query?: ComplianceAuditQuery): Promise<ComplianceAuditListResult> =>
            ipcRenderer.invoke('data:getComplianceAudit', query),
    },

    // App updates
    updates: {
        getState: () => ipcRenderer.invoke('updates:getState'),
        check: () => ipcRenderer.invoke('updates:check'),
        checkAndDownload: () => ipcRenderer.invoke('updates:checkAndDownload'),
        download: () => ipcRenderer.invoke('updates:download'),
        install: () => ipcRenderer.invoke('updates:install'),
        onState: (callback: (state: any) => void) => {
            const handler = (_event: any, state: any) => callback(state)
            ipcRenderer.on('updates:state', handler)
            return () => ipcRenderer.removeListener('updates:state', handler)
        },
    },

    reports: {
        getActionTrace: (payload?: { campaignId?: number; limit?: number }) =>
            ipcRenderer.invoke('reports:getActionTrace', payload),
    },

    rag: {
        getStats: () => ipcRenderer.invoke('rag:getStats'),
        clear: (scope?: { campaignId?: number; domain?: string; riskType?: string }) =>
            ipcRenderer.invoke('rag:clear', scope),
    },

    mcp: {
        getHealth: () => ipcRenderer.invoke('mcp:getHealth'),
    },

    soak: {
        start: (payload?: { durationHours?: number; intervalSeconds?: number; tag?: string }) =>
            ipcRenderer.invoke('soak:start', payload),
        stop: (reason?: string) =>
            ipcRenderer.invoke('soak:stop', reason),
        status: () =>
            ipcRenderer.invoke('soak:status'),
    },

    tiling: {
        getLayout: (count: number) =>
            ipcRenderer.invoke('tiling:getLayout', count),
        setEnabled: (enabled: boolean) =>
            ipcRenderer.invoke('tiling:setEnabled', enabled),
        isEnabled: () =>
            ipcRenderer.invoke('tiling:isEnabled'),
    },

    // Compliance manual-confirm queue + durable review_history intent reconcile
    compliance: {
        getPendingReviewSubmissions: () => ipcRenderer.invoke('compliance:getPendingReviewSubmissions'),
        approveReviewSubmission: (requestId: string) => ipcRenderer.invoke('compliance:approveReviewSubmission', requestId),
        rejectReviewSubmission: (requestId: string, reason?: string) => ipcRenderer.invoke('compliance:rejectReviewSubmission', requestId, reason),
        /** Durable submitting/unconfirmed intents — channel compliance:getPendingReviewIntents. */
        getPendingReviewIntents: (): Promise<PendingReviewIntent[]> =>
            ipcRenderer.invoke('compliance:getPendingReviewIntents'),
        /**
         * Operator reconcile of one history row —
         * channel compliance:reconcileReviewIntent(historyId, outcome, note?).
         */
        reconcileReviewIntent: (
            historyId: number,
            outcome: ReviewReconcileOutcome,
            note?: string,
        ): Promise<ReviewIntentReconcileResult> =>
            ipcRenderer.invoke('compliance:reconcileReviewIntent', historyId, outcome, note),
        onReviewSubmissionPending: (callback: (payload: any) => void) => {
            const handler = (_event: any, payload: any) => callback(payload)
            ipcRenderer.on('compliance:reviewSubmissionPending', handler)
            return () => ipcRenderer.removeListener('compliance:reviewSubmissionPending', handler)
        },
        onReviewSubmissionResolved: (callback: (payload: any) => void) => {
            const handler = (_event: any, payload: any) => callback(payload)
            ipcRenderer.on('compliance:reviewSubmissionResolved', handler)
            return () => ipcRenderer.removeListener('compliance:reviewSubmissionResolved', handler)
        },
        onReviewSubmissionQueue: (callback: (payload: any[]) => void) => {
            const handler = (_event: any, payload: any[]) => callback(payload)
            ipcRenderer.on('compliance:reviewSubmissionQueue', handler)
            return () => ipcRenderer.removeListener('compliance:reviewSubmissionQueue', handler)
        },
    },

    // Automation Scripts
    scripts: {
        getAll: () => ipcRenderer.invoke('scripts:getAll'),
        save: (script: any) => ipcRenderer.invoke('scripts:save', script),
        delete: (scriptId: string) => ipcRenderer.invoke('scripts:delete', scriptId),
        run: (script: any, variables?: Record<string, any>) => ipcRenderer.invoke('scripts:run', script, variables),
        runWithAccounts: (script: any, accountIds: number[], variables?: Record<string, any>) => ipcRenderer.invoke('scripts:runWithAccounts', script, accountIds, variables),
        stop: () => ipcRenderer.invoke('scripts:stop'),
    },

    // Review Templates (Spintax)
    templates: {
        getAll: () => ipcRenderer.invoke('templates:getAll'),
        getById: (id: number) => ipcRenderer.invoke('templates:getById', id),
        create: (data: { name: string; content: string; category: string }) =>
            ipcRenderer.invoke('templates:create', data),
        update: (id: number, data: any) => ipcRenderer.invoke('templates:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('templates:delete', id),
        preview: (content: string) => ipcRenderer.invoke('templates:preview', content),
        generateVariations: (content: string, count?: number) =>
            ipcRenderer.invoke('templates:generateVariations', content, count),
        generateReview: (templateId?: number) => ipcRenderer.invoke('templates:generateReview', templateId),
        seedDefaults: () => ipcRenderer.invoke('templates:seedDefaults'),
    },

    // Projects
    projects: {
        getAll: () => ipcRenderer.invoke('projects:getAll'),
        getAllWithSummary: () => ipcRenderer.invoke('projects:getAllWithSummary'),
        getById: (id: number) => ipcRenderer.invoke('projects:getById', id),
        getWithDetails: (id: number) => ipcRenderer.invoke('projects:getWithDetails', id),
        getActive: () => ipcRenderer.invoke('projects:getActive'),
        create: (data: { name: string; description?: string; color?: string; icon?: string }) =>
            ipcRenderer.invoke('projects:create', data),
        update: (id: number, data: any) => ipcRenderer.invoke('projects:update', id, data),
        delete: (id: number, deleteContents?: boolean) => ipcRenderer.invoke('projects:delete', id, deleteContents),
        archive: (id: number) => ipcRenderer.invoke('projects:archive', id),
        getStats: (id: number) => ipcRenderer.invoke('projects:getStats', id),
    },

    // AI Review Generation
    ai: {
        generateReview: (locationName: string, options?: { category?: string; style?: string; language?: string; rating?: number; length?: string }) =>
            ipcRenderer.invoke('ai:generateReview', locationName, options),
        generateBulk: (count: number, locationName: string, category?: string, options?: any) =>
            ipcRenderer.invoke('ai:generateBulk', count, locationName, category, options),
        improveReview: (text: string, language?: 'vi' | 'en') =>
            ipcRenderer.invoke('ai:improveReview', text, language),
        setApiKey: (key: string) =>
            ipcRenderer.invoke('ai:setApiKey', key),
        getApiKeyStatus: () =>
            ipcRenderer.invoke('ai:getApiKeyStatus'),
        saveReview: (review: any, locationId?: number) =>
            ipcRenderer.invoke('ai:saveReview', review, locationId),
    },

    // Ollama Local LLM
    ollama: {
        testConnection: (url?: string) => ipcRenderer.invoke('ollama:testConnection', url),
        getConfig: () => ipcRenderer.invoke('ollama:getConfig'),
    },

    // Image Folders
    images: {
        getFolders: () =>
            ipcRenderer.invoke('images:getFolders'),
        addFolder: (folderPath: string, category?: string) =>
            ipcRenderer.invoke('images:addFolder', folderPath, category),
        selectFolder: () =>
            ipcRenderer.invoke('images:selectFolder'),
        deleteFolder: (id: number) =>
            ipcRenderer.invoke('images:deleteFolder', id),
        getImagesInFolder: (folderId: number) =>
            ipcRenderer.invoke('images:getImagesInFolder', folderId),
        getRandomImage: (folderId: number, campaignId?: string) =>
            ipcRenderer.invoke('images:getRandomImage', folderId, campaignId),
        rescanFolder: (id: number) =>
            ipcRenderer.invoke('images:rescanFolder', id),
        getBase64: (imagePath: string) =>
            ipcRenderer.invoke('images:getBase64', imagePath),
    },

    // Campaign Scheduler
    scheduler: {
        create: (config: any) =>
            ipcRenderer.invoke('scheduler:create', config),
        update: (id: number, config: any) =>
            ipcRenderer.invoke('scheduler:update', id, config),
        delete: (id: number) =>
            ipcRenderer.invoke('scheduler:delete', id),
        getForCampaign: (campaignId: number) =>
            ipcRenderer.invoke('scheduler:getForCampaign', campaignId),
        getAll: () =>
            ipcRenderer.invoke('scheduler:getAll'),
        toggle: (id: number) =>
            ipcRenderer.invoke('scheduler:toggle', id),
    },

    // HuggingFace Local AI
    hfmodel: {
        getStatus: () => ipcRenderer.invoke('hfmodel:getStatus'),
        preload: (task: string, model?: string) => ipcRenderer.invoke('hfmodel:preload', task, model),
        unload: (task: string) => ipcRenderer.invoke('hfmodel:unload', task),
        testGenerate: (prompt?: string) => ipcRenderer.invoke('hfmodel:testGenerate', prompt),
        dispose: () => ipcRenderer.invoke('hfmodel:dispose'),
    },

    // Trackio — AI Performance Monitoring
    trackio: {
        getMetrics: (timeRange?: string) => ipcRenderer.invoke('trackio:getMetrics', timeRange),
        getHistory: (limit?: number) => ipcRenderer.invoke('trackio:getHistory', limit),
        getAlerts: () => ipcRenderer.invoke('trackio:getAlerts'),
        cleanup: (keepDays?: number) => ipcRenderer.invoke('trackio:cleanup', keepDays),
    },

    // CAPTCHA metrics (public snapshot only — no secrets/tokens)
    captcha: {
        getMetrics: (): Promise<CaptchaMetricsSnapshot> =>
            ipcRenderer.invoke('captcha:getMetrics'),
        resetMetrics: (): Promise<CaptchaMetricsResetResult> =>
            ipcRenderer.invoke('captcha:resetMetrics'),
    },

    // HuggingFace Datasets — Browse & Search
    datasets: {
        isValid: (datasetId: string) => ipcRenderer.invoke('datasets:isValid', datasetId),
        listSplits: (datasetId: string) => ipcRenderer.invoke('datasets:listSplits', datasetId),
        previewRows: (datasetId: string, config: string, split: string, limit?: number) =>
            ipcRenderer.invoke('datasets:previewRows', datasetId, config, split, limit),
        getRows: (datasetId: string, config: string, split: string, offset?: number, length?: number) =>
            ipcRenderer.invoke('datasets:getRows', datasetId, config, split, offset, length),
        search: (datasetId: string, config: string, split: string, query: string, offset?: number, length?: number) =>
            ipcRenderer.invoke('datasets:search', datasetId, config, split, query, offset, length),
        getSize: (datasetId: string) => ipcRenderer.invoke('datasets:getSize', datasetId),
        getStatistics: (datasetId: string, config: string, split: string) =>
            ipcRenderer.invoke('datasets:getStatistics', datasetId, config, split),
    },

    // Tool Builder — Run automation scripts
    toolBuilder: {
        list: () => ipcRenderer.invoke('tools:list'),
        run: (toolName: string, args?: string[]) => ipcRenderer.invoke('tools:run', toolName, args),
        stop: () => ipcRenderer.invoke('tools:stop'),
    },

    // Event listeners — returns unsubscribe function to prevent leaks
    on: (channel: string, callback: (...args: any[]) => void) => {
        const validChannels = [
            'campaign:update',
            'review:progress',
            'automation:status',
            'traffic:progress',
            'compliance:reviewSubmissionPending',
            'compliance:reviewSubmissionResolved',
            'compliance:reviewSubmissionQueue',
        ]
        if (validChannels.includes(channel)) {
            const handler = (_event: any, ...args: any[]) => callback(...args)
            ipcRenderer.on(channel, handler)
            // Return unsubscribe function
            return () => { ipcRenderer.removeListener(channel, handler) }
        }
        return () => {}
    },

    off: (channel: string, handler?: (...args: any[]) => void) => {
        if (handler) {
            ipcRenderer.removeListener(channel, handler)
        } else {
            ipcRenderer.removeAllListeners(channel)
        }
    },
})

// TypeScript type declarations for the exposed API
declare global {
    interface Window {
        electronAPI: {
            getVersion: () => Promise<string>
            getPaths: () => Promise<{
                userData: string
                appData: string
                temp: string
                home: string
            }>
            selectDirectory: () => Promise<string | null>
            openExternal: (url: string) => Promise<void>
            reloadWindow: (reason?: string) => Promise<{ success: boolean }>
            reportRendererEvent: (payload: { level?: 'info' | 'warn' | 'error'; message: string }) => Promise<{ success: boolean }>
            accounts: {
                getAll: () => Promise<PublicAccount[]>
                getActiveCount: () => Promise<number>
                getById: (id: number) => Promise<PublicAccount | undefined>
                add: (data: AccountCreatePayload) => Promise<PublicAccount>
                update: (id: number, data: AccountUpdatePayload) => Promise<PublicAccount | undefined>
                delete: (id: number) => Promise<void>
                importCSV: (accounts: AccountImportPayload[]) => Promise<number>
                getStats: () => Promise<AccountStats>
                testLogin: (id: number) => Promise<AccountLoginResult>
                loginVisible: (id: number) => Promise<AccountLoginResult>
                checkLiveDie: (id: number) => Promise<AccountLiveCheckResult>
                checkAllPending: () => Promise<{ checked: number; alive: number; dead: number }>
                openManualLogin: (id: number) => Promise<AccountLoginResult>
            }
            warmup: {
                getStatus: (id: number) => Promise<AccountWarmupStatusDto>
                getAllStatuses: () => Promise<AccountWarmupStatusDto[]>
                start: (id: number, options?: WarmupStartOptions) => Promise<WarmupActionResultDto>
                cancel: (id: number) => Promise<WarmupActionResultDto>
            }
            proxies: {
                getAll: () => Promise<PublicProxy[]>
                getActive: () => Promise<PublicProxy[]>
                getActiveCount: () => Promise<number>
                add: (data: ProxyCreatePayload) => Promise<PublicProxy>
                update: (id: number, data: ProxyUpdatePayload) => Promise<PublicProxy | undefined>
                delete: (id: number) => Promise<void>
                check: (id: number) => Promise<any>
                checkRuntime: (id: number) => Promise<ProxyRuntimeCheckResult>
                checkAll: () => Promise<any>
                importText: (text: string, defaultProvider?: string) => Promise<number>
                deleteDead: () => Promise<number>
                getStats: () => Promise<ProxyStats>
            }
            locations: {
                getAll: () => Promise<any[]>
                getPending: () => Promise<any[]>
                add: (data: any) => Promise<any>
                addFromUrl: (url: string, targetReviews?: number, phone?: string, website?: string) => Promise<any>
                parseUrl: (url: string) => Promise<{ name: string; placeId?: string; address?: string; cid?: string; featureHex?: string }>
                update: (id: number, data: any) => Promise<any>
                delete: (id: number) => Promise<{ success: boolean; error?: string }>
                getStats: () => Promise<any>
            }
            campaigns: {
                getAll: () => Promise<any[]>
                getRunning: () => Promise<any[]>
                getById: (id: number) => Promise<any>
                create: (data: any) => Promise<any>
                update: (id: number, data: any) => Promise<any>
                delete: (id: number) => Promise<void>
                start: (id: number) => Promise<void>
                pause: (id: number) => Promise<void>
                stop: (id: number) => Promise<void>
                getStats: () => Promise<any>
            }
            reviews: {
                getAll: () => Promise<any[]>
                getByCampaign: (campaignId: number) => Promise<any[]>
                getRecent: (limit?: number) => Promise<any[]>
                getToday: () => Promise<any[]>
                getStats: () => Promise<any>
                getHistory: (filters?: any) => Promise<any[]>
            }
            settings: {
                /** Secret keys return '********' when set, never plaintext. */
                get: (key: SettingsKey) => Promise<SettingsValue | undefined>
                set: (key: SettingsKey, value: SettingsValue) => Promise<void>
                /** Public settings view — secrets masked as '********' when nonempty. */
                getAll: () => Promise<SettingsRecord>
                /**
                 * Secret field semantics: '********' keeps prior secret, '' clears,
                 * any other string replaces and encrypts at rest (fail-closed if unavailable).
                 */
                saveAll: (settings: Partial<Record<SettingsKey, SettingsValue>>) =>
                    Promise<SettingsRecord>
                resetDefaults: () => Promise<SettingsRecord>
            }
            automation: {
                getConfig: () => Promise<AutomationConfigDto | null>
                saveConfig: (config: AutomationConfigSavePayload) => Promise<AutomationActionResult>
                startCampaign: (campaignId: number) => Promise<AutomationActionResult>
                resumeCampaign: (campaignId: number) => Promise<AutomationActionResult>
                stopCampaign: () => Promise<AutomationActionResult>
                pause: () => Promise<AutomationActionResult>
                resume: () => Promise<AutomationActionResult>
                getStatus: () => Promise<unknown>
                isRunning: () => Promise<boolean>
                getQueueStats: (campaignId?: number) => Promise<AutomationQueueStatsDto>
                clearCompleted: (campaignId?: number) => Promise<AutomationActionResult>
                getRecoveryReport: () => Promise<RecoveryReportDto | null>
                getResumePlan: (campaignId: number) => Promise<ResumePlanDto>
                onStatusUpdate: (callback: (status: unknown) => void) => () => void
                testBrowser: () => Promise<AutomationActionResult>
                testFullFlow: (
                    searchQuery?: string,
                ) => Promise<{ success: boolean; step?: string; error?: string }>
            }
            traffic: {
                getAll: () => Promise<any[]>
                create: (data: any) => Promise<any>
                update: (id: number, data: any) => Promise<any>
                delete: (id: number) => Promise<void>
                start: (id: number) => Promise<void>
                stop: (id: number) => Promise<void>
                getStats: () => Promise<any>
            }
            trafficBoost: {
                getCampaigns: () => Promise<any[]>
                createCampaign: (data: any) => Promise<any>
                updateCampaign: (id: number, data: any) => Promise<any>
                deleteCampaign: (id: number) => Promise<any>
                deleteCampaigns: (ids: number[]) => Promise<any>
                start: (id: number) => Promise<any>
                stop: () => Promise<any>
                pause: () => Promise<any>
                getStatus: () => Promise<any>
                getReport: (id: number) => Promise<any>
                getLogs: (campaignId: number) => Promise<any>
                getAudit: (campaignId: number) => Promise<any>
                getVisitQueueStats: (campaignId: number) => Promise<TrafficVisitQueueStatsDto>
                recoverVisitLeases: (campaignId: number) => Promise<TrafficVisitRecoverResult>
                onStatusUpdate: (callback: (status: any) => void) => () => void
            }
            runtime: {
                getStatusV2: () => Promise<any>
                getDiagnostics: () => Promise<any>
                getPolicy: () => Promise<any>
                updatePolicy: (patch: Record<string, unknown>) => Promise<any>
                onStatusV2: (callback: (status: any) => void) => () => void
                onActionEvent: (callback: (event: any) => void) => () => void
            }
            network: {
                getEffectiveMode: () => Promise<any>
                testConfig: () => Promise<any>
            }
            profiles: {
                list: () => Promise<any[]>
                get: (accountId: number) => Promise<any>
                create: (accountId: number) => Promise<any>
                update: (payload: { accountId: number; profilePath?: string; basePath?: string }) => Promise<any>
                delete: (accountId: number) => Promise<any>
                migrate: (payload: { accountId: number; targetBasePath: string }) => Promise<any>
            }
            data: {
                getRoot: () => Promise<any>
                detectLegacy: () => Promise<any[]>
                migrateLegacy: (sourcePath?: string) => Promise<any>
                getStorageInfo: () => Promise<any>
                openPath: (targetPath: string) => Promise<any>
                clearCaches: () => Promise<any>
                createBackup: (options?: CreateBackupOptionsInput) => Promise<CreateBackupResult>
                listBackups: () => Promise<PublicBackupSummary[]>
                inspectBackup: (backupId: string) => Promise<PublicBackupInspect>
                restoreBackup: (options: RestoreBackupOptionsInput) => Promise<RestoreBackupResult>
                getComplianceAudit: (query?: ComplianceAuditQuery) => Promise<ComplianceAuditListResult>
            }
            updates: {
                getState: () => Promise<any>
                check: () => Promise<any>
                checkAndDownload: () => Promise<any>
                download: () => Promise<any>
                install: () => Promise<any>
                onState: (callback: (state: any) => void) => () => void
            }
            fproxy: {
                testApi: () => Promise<{ success: boolean; message: string; ip?: string; latencyMs?: number; location?: string }>
            }
            reports: {
                getActionTrace: (payload?: { campaignId?: number; limit?: number }) => Promise<any[]>
            }
            rag: {
                getStats: () => Promise<any>
                clear: (scope?: { campaignId?: number; domain?: string; riskType?: string }) => Promise<{ deleted: number }>
            }
            mcp: {
                getHealth: () => Promise<any>
            }
            soak: {
                start: (payload?: { durationHours?: number; intervalSeconds?: number; tag?: string }) => Promise<any>
                stop: (reason?: string) => Promise<any>
                status: () => Promise<any>
            }
            tiling: {
                getLayout: (count: number) => Promise<any>
                setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
                isEnabled: () => Promise<boolean>
            }
            compliance: {
                getPendingReviewSubmissions: () => Promise<any[]>
                approveReviewSubmission: (requestId: string) => Promise<{ success: boolean; message: string }>
                rejectReviewSubmission: (requestId: string, reason?: string) => Promise<{ success: boolean; message: string }>
                getPendingReviewIntents: () => Promise<PendingReviewIntent[]>
                reconcileReviewIntent: (
                    historyId: number,
                    outcome: ReviewReconcileOutcome,
                    note?: string,
                ) => Promise<ReviewIntentReconcileResult>
                onReviewSubmissionPending: (callback: (payload: any) => void) => () => void
                onReviewSubmissionResolved: (callback: (payload: any) => void) => () => void
                onReviewSubmissionQueue: (callback: (payload: any[]) => void) => () => void
            }
            projects: {
                getAll: () => Promise<any[]>
                getAllWithSummary: () => Promise<any[]>
                getById: (id: number) => Promise<any>
                getWithDetails: (id: number) => Promise<any>
                getActive: () => Promise<any[]>
                create: (data: any) => Promise<any>
                update: (id: number, data: any) => Promise<any>
                delete: (id: number, deleteContents?: boolean) => Promise<void>
                archive: (id: number) => Promise<any>
                getStats: (id: number) => Promise<any>
            }
            templates: {
                getAll: () => Promise<any[]>
                getById: (id: number) => Promise<any>
                create: (data: { name: string; content: string; category: string }) => Promise<any>
                update: (id: number, data: any) => Promise<any>
                delete: (id: number) => Promise<void>
                preview: (content: string) => Promise<{ preview: string; variationCount: number; variations: string[] }>
                generateVariations: (content: string, count?: number) => Promise<string[]>
                generateReview: (templateId?: number) => Promise<any>
                seedDefaults: () => Promise<number>
            }
            ai: {
                generateReview: (locationName: string, options?: any) => Promise<{ success: boolean; review?: any; error?: string }>
                generateBulk: (count: number, locationName: string, category?: string, options?: any) => Promise<{ success: boolean; reviews?: any[]; error?: string }>
                improveReview: (text: string, language?: 'vi' | 'en') => Promise<{ success: boolean; improved?: string; error?: string }>
                setApiKey: (key: string) => Promise<{ success: boolean; error?: string }>
                getApiKeyStatus: () => Promise<{ hasKey: boolean; isValid?: boolean }>
                saveReview: (review: any, locationId?: number) => Promise<{ success: boolean; id?: number; error?: string }>
            }
            ollama: {
                testConnection: (url?: string) => Promise<{ success: boolean; error?: string; models?: string[] }>
                getConfig: () => Promise<{ url: string; model: string }>
            }
            images: {
                getFolders: () => Promise<any[]>
                addFolder: (folderPath: string, category?: string) => Promise<{ success: boolean; id?: number; folder?: any; error?: string }>
                selectFolder: () => Promise<{ path: string; name: string; imageCount: number } | null>
                deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>
                getImagesInFolder: (folderId: number) => Promise<{ success: boolean; images?: any[]; error?: string }>
                getRandomImage: (folderId: number, campaignId?: string) => Promise<{ success: boolean; image?: any; error?: string }>
                rescanFolder: (id: number) => Promise<{ success: boolean; imageCount?: number; error?: string }>
                getBase64: (imagePath: string) => Promise<string | null>
            }
            analytics: any
            scheduler: {
                create: (config: any) => Promise<{ success: boolean; id?: number; error?: string }>
                update: (id: number, config: any) => Promise<{ success: boolean; error?: string }>
                delete: (id: number) => Promise<{ success: boolean; error?: string }>
                getForCampaign: (campaignId: number) => Promise<any | null>
                getAll: () => Promise<any[]>
                toggle: (id: number) => Promise<{ success: boolean; isActive?: boolean; error?: string }>
            }
            hfmodel: {
                getStatus: () => Promise<any>
                preload: (task: string, model?: string) => Promise<any>
                unload: (task: string) => Promise<any>
                testGenerate: (prompt?: string) => Promise<any>
                dispose: () => Promise<any>
            }
            trackio: {
                getMetrics: (timeRange?: string) => Promise<any>
                getHistory: (limit?: number) => Promise<any[]>
                getAlerts: () => Promise<any[]>
                cleanup: (keepDays?: number) => Promise<{ deleted: number }>
            }
            captcha: {
                getMetrics: () => Promise<CaptchaMetricsSnapshot>
                resetMetrics: () => Promise<CaptchaMetricsResetResult>
            }
            datasets: {
                isValid: (datasetId: string) => Promise<any>
                listSplits: (datasetId: string) => Promise<any[]>
                previewRows: (datasetId: string, config: string, split: string, limit?: number) => Promise<any>
                getRows: (datasetId: string, config: string, split: string, offset?: number, length?: number) => Promise<any>
                search: (datasetId: string, config: string, split: string, query: string, offset?: number, length?: number) => Promise<any>
                getSize: (datasetId: string) => Promise<any>
                getStatistics: (datasetId: string, config: string, split: string) => Promise<any>
            }
            toolBuilder: {
                list: () => Promise<any[]>
                run: (toolName: string, args?: string[]) => Promise<any>
                stop: () => Promise<{ stopped: boolean }>
            }
            on: (channel: string, callback: (...args: any[]) => void) => void
            off: (channel: string) => void
        }
    }
}
