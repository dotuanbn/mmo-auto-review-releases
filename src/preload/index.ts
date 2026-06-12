import { contextBridge, ipcRenderer } from 'electron'
import type { Account } from '../shared/types'

type AccountLoginType = 'auto' | 'manual'

type AccountAddPayload = {
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
    loginType?: AccountLoginType
}

type AccountUpdatePayload = Partial<Pick<
    Account,
    'email' | 'password' | 'recoveryEmail' | 'recoveryPhone' | 'loginType' | 'status'
>>

type AccountImportPayload = {
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
}

type AccountLiveCheckResult = {
    alive: boolean
    error?: string
    needs2FA?: boolean
}

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

    // Accounts
    accounts: {
        getAll: () => ipcRenderer.invoke('accounts:getAll'),
        getActiveCount: () => ipcRenderer.invoke('accounts:getActiveCount'),
        getById: (id: number) => ipcRenderer.invoke('accounts:getById', id),
        add: (data: AccountAddPayload) =>
            ipcRenderer.invoke('accounts:add', data),
        update: (id: number, data: AccountUpdatePayload) => ipcRenderer.invoke('accounts:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('accounts:delete', id),
        importCSV: (accounts: AccountImportPayload[]) => ipcRenderer.invoke('accounts:importCSV', accounts),
        getStats: () => ipcRenderer.invoke('accounts:getStats'),
        testLogin: (id: number) => ipcRenderer.invoke('accounts:testLogin', id),
        loginVisible: (id: number) => ipcRenderer.invoke('accounts:loginVisible', id),
        checkLiveDie: (id: number) => ipcRenderer.invoke('accounts:checkLiveDie', id),
        checkAllPending: () => ipcRenderer.invoke('accounts:checkAllPending'),
        openManualLogin: (id: number) => ipcRenderer.invoke('accounts:openManualLogin', id),
    },

    // Proxies
    proxies: {
        getAll: () => ipcRenderer.invoke('proxies:getAll'),
        getActive: () => ipcRenderer.invoke('proxies:getActive'),
        getActiveCount: () => ipcRenderer.invoke('proxies:getActiveCount'),
        add: (data: { host: string; port: number; username?: string; password?: string; type?: string; country?: string }) =>
            ipcRenderer.invoke('proxies:add', data),
        update: (id: number, data: any) => ipcRenderer.invoke('proxies:update', id, data),
        delete: (id: number) => ipcRenderer.invoke('proxies:delete', id),
        check: (id: number) => ipcRenderer.invoke('proxies:check', id),
        checkAll: () => ipcRenderer.invoke('proxies:checkAll'),
        importText: (text: string, defaultProvider?: string) => ipcRenderer.invoke('proxies:importText', text, defaultProvider),
        deleteDead: () => ipcRenderer.invoke('proxies:deleteDead'),
        getStats: () => ipcRenderer.invoke('proxies:getStats'),
    },

    // FProxy API (fproxy.me rotating proxy)
    fproxy: {
        setApiKey: (apiKey: string) => ipcRenderer.invoke('fproxy:setApiKey', apiKey),
        getNew: () => ipcRenderer.invoke('fproxy:getNew'),
        getInfo: () => ipcRenderer.invoke('fproxy:getInfo'),
        test: () => ipcRenderer.invoke('fproxy:test'),
    },

    // Locations
    locations: {
        getAll: () => ipcRenderer.invoke('locations:getAll'),
        getPending: () => ipcRenderer.invoke('locations:getPending'),
        add: (data: { name: string; url: string; placeId?: string; address?: string; phone?: string; website?: string; category?: string; targetRating?: number; targetReviews?: number }) =>
            ipcRenderer.invoke('locations:add', data),
        addFromUrl: (url: string, targetReviews?: number, phone?: string, website?: string) => ipcRenderer.invoke('locations:addFromUrl', url, targetReviews, phone, website),
        parseUrl: (url: string) => ipcRenderer.invoke('locations:parseUrl', url),
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

    // Settings
    settings: {
        get: (key: string) => ipcRenderer.invoke('settings:get', key),
        set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
        getAll: () => ipcRenderer.invoke('settings:getAll'),
        saveAll: (settings: Record<string, any>) => ipcRenderer.invoke('settings:saveAll', settings),
        resetDefaults: () => ipcRenderer.invoke('settings:resetDefaults'),
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

    // Automation
    automation: {
        getConfig: () => ipcRenderer.invoke('automation:getConfig'),
        saveConfig: (config: any) => ipcRenderer.invoke('automation:saveConfig', config),
        startCampaign: (campaignId: number) => ipcRenderer.invoke('automation:startCampaign', campaignId),
        stopCampaign: () => ipcRenderer.invoke('automation:stopCampaign'),
        pause: () => ipcRenderer.invoke('automation:pause'),
        resume: () => ipcRenderer.invoke('automation:resume'),
        getStatus: () => ipcRenderer.invoke('automation:getStatus'),
        isRunning: () => ipcRenderer.invoke('automation:isRunning'),
        getQueueStats: () => ipcRenderer.invoke('automation:getQueueStats'),
        clearCompleted: () => ipcRenderer.invoke('automation:clearCompleted'),
        // Status updates from main process
        onStatusUpdate: (callback: (status: any) => void) => {
            const handler = (_event: any, status: any) => callback(status)
            ipcRenderer.on('automation:status', handler)
            return () => ipcRenderer.removeListener('automation:status', handler)
        },
        // Test functions for debugging
        testBrowser: () => ipcRenderer.invoke('automation:testBrowser'),
        testFullFlow: (searchQuery?: string) => ipcRenderer.invoke('automation:testFullFlow', searchQuery),
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
        getStatus: () => ipcRenderer.invoke('trafficBoost:getStatus'),
        getReport: (id: number) => ipcRenderer.invoke('trafficBoost:getReport', id),
        getLogs: (campaignId: number) => ipcRenderer.invoke('trafficBoost:getLogs', campaignId),
        getAudit: (campaignId: number) => ipcRenderer.invoke('trafficBoost:getAudit', campaignId),
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

    // Portable data root + migration
    data: {
        getRoot: () => ipcRenderer.invoke('data:getRoot'),
        detectLegacy: () => ipcRenderer.invoke('data:detectLegacy'),
        migrateLegacy: (sourcePath?: string) => ipcRenderer.invoke('data:migrateLegacy', sourcePath),
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

    // Compliance manual-confirm queue
    compliance: {
        getPendingReviewSubmissions: () => ipcRenderer.invoke('compliance:getPendingReviewSubmissions'),
        approveReviewSubmission: (requestId: string) => ipcRenderer.invoke('compliance:approveReviewSubmission', requestId),
        rejectReviewSubmission: (requestId: string, reason?: string) => ipcRenderer.invoke('compliance:rejectReviewSubmission', requestId, reason),
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
                getAll: () => Promise<Account[]>
                getActiveCount: () => Promise<number>
                getById: (id: number) => Promise<Account | undefined>
                add: (data: AccountAddPayload) => Promise<Account>
                update: (id: number, data: AccountUpdatePayload) => Promise<Account | undefined>
                delete: (id: number) => Promise<void>
                importCSV: (accounts: AccountImportPayload[]) => Promise<number>
                getStats: () => Promise<any>
                testLogin: (id: number) => Promise<any>
                loginVisible: (id: number) => Promise<any>
                checkLiveDie: (id: number) => Promise<AccountLiveCheckResult>
                checkAllPending: () => Promise<{ checked: number; alive: number; dead: number }>
                openManualLogin: (id: number) => Promise<any>
            }
            proxies: {
                getAll: () => Promise<any[]>
                getActive: () => Promise<any[]>
                getActiveCount: () => Promise<number>
                add: (data: any) => Promise<any>
                update: (id: number, data: any) => Promise<any>
                delete: (id: number) => Promise<void>
                check: (id: number) => Promise<any>
                checkAll: () => Promise<any>
                importText: (text: string, defaultProvider?: string) => Promise<number>
                deleteDead: () => Promise<number>
                getStats: () => Promise<any>
            }
            locations: {
                getAll: () => Promise<any[]>
                getPending: () => Promise<any[]>
                add: (data: any) => Promise<any>
                addFromUrl: (url: string, targetReviews?: number, phone?: string, website?: string) => Promise<any>
                parseUrl: (url: string) => Promise<any>
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
                get: (key: string) => Promise<any>
                set: (key: string, value: any) => Promise<void>
                getAll: () => Promise<any>
                saveAll: (settings: Record<string, any>) => Promise<any>
                resetDefaults: () => Promise<any>
            }
            automation: {
                getConfig: () => Promise<any>
                saveConfig: (config: any) => Promise<any>
                startCampaign: (campaignId: number) => Promise<any>
                stopCampaign: () => Promise<any>
                pause: () => Promise<any>
                resume: () => Promise<any>
                getStatus: () => Promise<any>
                isRunning: () => Promise<boolean>
                getQueueStats: () => Promise<any>
                clearCompleted: () => Promise<any>
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
            }
            updates: {
                getState: () => Promise<any>
                check: () => Promise<any>
                checkAndDownload: () => Promise<any>
                download: () => Promise<any>
                install: () => Promise<any>
                onState: (callback: (state: any) => void) => () => void
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
