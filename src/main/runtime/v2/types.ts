export type EffectiveNetworkMode = 'direct' | 'fproxy' | 'static_proxy'

export interface NetworkStateV2 {
    mode: EffectiveNetworkMode
    reason: string
    proxyInfo?: string
    useProxySetting: boolean
    hasFProxyApiKey: boolean
    checkedAt: string
}

export interface RuntimeThreadStatusV2 {
    id: number
    accountEmail: string
    locationName: string
    status: string
    currentAction: string
    currentKeyword?: string
    progress: number
    proxyInfo?: string
}

export interface RuntimeStatusV2 {
    version: 'v2'
    isRunning: boolean
    campaignId: number | null
    campaignName: string
    currentRound: number
    totalRounds: number
    completedVisits: number
    totalVisits: number
    failedVisits: number
    activeThreads: number
    threadsTotal: number
    message: string
    threads: RuntimeThreadStatusV2[]
    effectiveNetworkMode: EffectiveNetworkMode
    networkState: NetworkStateV2
    timestamp: string
}

export interface RuntimeActionEvent {
    eventId: string
    campaignId: number | null
    campaignName: string
    round: number
    threadId: number
    accountEmail: string
    locationName: string
    action: string
    source: string
    success: boolean
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: RuntimeDecisionSource
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp: string
}

export type CaptchaMode = 'manual' | 'auto_skip' | 'hybrid'
export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type RagWriteMode = 'off' | 'risk_only' | 'all'
export type RuntimeDecisionSource = 'heuristic' | 'llm' | 'llm+rag'

export interface RuntimePolicyV2 {
    captchaMode: CaptchaMode
    captchaAutoSkipMaxStrikes: number
    captchaManualWaitSeconds: number
    queueConcurrency: number
    queueIntervalMs: number
    networkRetryMax: number
    uiRetryMax: number
    logLevel: RuntimeLogLevel
    ragEnabled: boolean
    ragTopK: number
    ragMaxContextChars: number
    ragWriteMode: RagWriteMode
    ragLatencyBudgetMs: number
    ragMinScore: number
    ragEntryTtlHours: number
    ragDedupeWindowMinutes: number
}

export interface RuntimeDiagnosticsV2 {
    timestamp: string
    isRunning: boolean
    campaignId: number | null
    activeContexts: number
    activeThreads: number
    queueDepth: number
    captchaByThread: Array<{
        threadId: number
        hits: number
        lastDetectedAt: number
        lastResolvedAt?: number
    }>
}

export interface RuntimeRagStats {
    enabled: boolean
    totalEntries: number
    retrievalCount: number
    retrievalHitCount: number
    hitRate: number
    p95LatencyMs: number
    avgLatencyMs: number
    lastRetrievalAt?: string
    updatedAt: string
}

export interface McpAdapterHealth {
    name: string
    enabled: boolean
    healthy: boolean
    latencyMs?: number
    detail?: string
    checkedAt: string
}

export interface McpHealthReport {
    healthy: boolean
    adapters: McpAdapterHealth[]
    checkedAt: string
}
