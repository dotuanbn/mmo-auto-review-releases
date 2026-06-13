import { useEffect, useState, useCallback, useRef } from 'react'
import { useI18n } from '../i18n'
import {
    Eye,
    Plus,
    Play,
    Pause,
    Square,
    Trash2,
    RefreshCw,
    TrendingUp,
    MapPin,
    Search,
    BarChart3,
    Zap,
    Globe,
    Activity,
    Users,
    Clock,
    CheckCircle,
    XCircle,
    FileText,
    Loader2,
    MousePointer2,
    ChevronUp,
    ChevronDown,
} from 'lucide-react'
import {
    PageHeader,
    PageShell,
    PrimaryButton,
    IconButton,
    SegmentedTabs,
    Panel,
    SectionPanel,
    StatCard as DSStatCard,
    StatRow,
    StatusPill,
    Badge,
    EmptyState,
    ProgressBar,
    Modal,
    Divider,
    AlertBanner,
} from '../components/ui/surface'

// ============================================================
// Types
// ============================================================

interface Account {
    id: number
    email: string
}

interface Location {
    id: number
    name: string
    url: string
    searchKeywords?: string | null
}

interface Campaign {
    id: number
    name: string
    accountIds: string
    locationIds: string
    threadsCount: number
    visitsPerLocation: number
    delayMinSeconds: number
    delayMaxSeconds: number
    status: string
    totalVisits: number
    completedVisits: number
    failedVisits: number
    currentRound: number
    createdAt: string
    startedAt: string | null
    trafficMode?: string
    searchKeywords?: string | null
    maxMapScroll?: number
    accounts?: { id: number; email: string }[]
    locations?: { id: number; name: string; url: string }[]
}

interface ThreadDetail {
    id: number
    accountEmail: string
    locationName: string
    status: string
    currentAction: string
    currentUrl?: string
    currentKeyword?: string
    progress: number
    proxyInfo?: string
}

interface LiveStatus {
    isRunning: boolean
    campaignId: number | null
    campaignName: string
    currentRound: number
    totalRounds: number
    completedVisits: number
    totalVisits: number
    failedVisits: number
    activeThreads: number
    threads: ThreadDetail[]
    effectiveNetworkMode?: 'direct' | 'fproxy' | 'static_proxy'
    networkState?: {
        mode: 'direct' | 'fproxy' | 'static_proxy'
        reason: string
        proxyInfo?: string
        useProxySetting: boolean
        hasFProxyApiKey: boolean
        checkedAt: string
    }
}

interface ReportData {
    campaignId: number
    campaignName: string
    totalVisits: number
    completedVisits: number
    failedVisits: number
    totalRounds: number
    totalDuration: number
    avgVisitDuration: number
    visitsByLocation: { locationId: number; locationName: string; visits: number; avgDuration: number }[]
    visitsByAccount: { accountId: number; accountEmail: string; visits: number }[]
    actionStats: { action: string; count: number }[]
    logs: ReportVisitLog[]
}

interface ReportVisitAction {
    action: string
    success: boolean
    source?: string
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    threadId?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp?: string
}

function getJsonArrayLength(value: unknown): number {
    if (Array.isArray(value)) return value.length
    if (typeof value !== 'string') return 0

    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.length : 0
    } catch {
        return 0
    }
}

interface ReportVisitLog {
    id: number
    status: string
    round: number
    duration: number
    createdAt: string
    locationId: number
    locationName?: string
    accountId?: number | null
    accountEmail?: string
    errorMessage?: string | null
    actions: ReportVisitAction[]
    successfulActionCount?: number
    failedActionCount?: number
    totalActionCount?: number
}

interface MonitorActionLog {
    id: string
    timestamp: number
    threadId: number
    accountEmail: string
    locationName: string
    action: string
    status: string
    source?: string
    detail?: string
    success?: boolean
    error?: string
    thought?: string
    durationMs?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
}

interface RuntimeStatusPayload {
    isRunning?: boolean
    campaignId?: number | null
    campaignName?: string
    currentRound?: number
    totalRounds?: number
    completedVisits?: number
    totalVisits?: number
    failedVisits?: number
    activeThreads?: number
    threads?: ThreadDetail[]
    effectiveNetworkMode?: 'direct' | 'fproxy' | 'static_proxy'
    networkState?: LiveStatus['networkState']
}

interface RuntimeActionEventPayload {
    eventId?: string
    threadId?: number
    accountEmail?: string
    locationName?: string
    action?: string
    source?: string
    success?: boolean
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
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp?: string
}

interface RuntimePolicy {
    captchaMode: 'manual' | 'auto_skip' | 'hybrid'
    captchaAutoSkipMaxStrikes: number
    captchaManualWaitSeconds: number
    queueConcurrency: number
    queueIntervalMs: number
    networkRetryMax: number
    uiRetryMax: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
    ragEnabled: boolean
    ragTopK: number
    ragMaxContextChars: number
    ragWriteMode: 'off' | 'risk_only' | 'all'
    ragLatencyBudgetMs: number
    ragMinScore: number
    ragEntryTtlHours: number
    ragDedupeWindowMinutes: number
}

interface RuntimeDiagnostics {
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

interface RagStats {
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

interface McpHealth {
    healthy: boolean
    checkedAt: string
    adapters: Array<{
        name: string
        enabled: boolean
        healthy: boolean
        latencyMs?: number
        detail?: string
        checkedAt: string
    }>
}


function formatDateTime(value: unknown): string {
    const date = value instanceof Date ? value : new Date(value as string)
    if (Number.isNaN(date.getTime())) {
        return 'N/A'
    }

    return date.toLocaleString('vi-VN')
}

function formatActionLabel(value: string): string {
    return value
        .replace(/[:_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function formatCursorAction(value: string): string {
    const normalized = formatActionLabel(value || '')
    if (!normalized) {
        return 'Dang cho hanh dong'
    }
    if (normalized.length > 36) {
        return `${normalized.slice(0, 33)}...`
    }
    return normalized
}

function normalizeLiveStatus(payload: RuntimeStatusPayload | null | undefined): LiveStatus {
    const fallbackNetworkMode = payload?.networkState?.mode
    const useProxySetting = payload?.networkState?.useProxySetting
    const effectiveNetworkMode = useProxySetting === false
        ? 'direct'
        : (payload?.effectiveNetworkMode || fallbackNetworkMode || 'direct')

    return {
        isRunning: payload?.isRunning === true,
        campaignId: payload?.campaignId ?? null,
        campaignName: payload?.campaignName || '',
        currentRound: Number(payload?.currentRound || 0),
        totalRounds: Number(payload?.totalRounds || 0),
        completedVisits: Number(payload?.completedVisits || 0),
        totalVisits: Number(payload?.totalVisits || 0),
        failedVisits: Number(payload?.failedVisits || 0),
        activeThreads: Number(payload?.activeThreads || 0),
        threads: Array.isArray(payload?.threads) ? payload!.threads : [],
        effectiveNetworkMode,
        networkState: payload?.networkState
            ? {
                mode: payload.networkState.useProxySetting === false ? 'direct' : payload.networkState.mode,
                reason: payload.networkState.reason || '',
                proxyInfo: payload.networkState.proxyInfo,
                useProxySetting: payload.networkState.useProxySetting === true,
                hasFProxyApiKey: payload.networkState.hasFProxyApiKey === true,
                checkedAt: payload.networkState.checkedAt || new Date().toISOString(),
            }
            : undefined,
    }
}

function toMonitorActionLog(payload: RuntimeActionEventPayload): MonitorActionLog | null {
    if (!payload || typeof payload !== 'object' || !payload.action) {
        return null
    }

    const parsedTime = payload.timestamp ? new Date(payload.timestamp).getTime() : Number.NaN
    const timestamp = Number.isNaN(parsedTime) ? Date.now() : parsedTime

    return {
        id: payload.eventId || `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        threadId: Number(payload.threadId || 0),
        accountEmail: payload.accountEmail || 'Anonymous',
        locationName: payload.locationName || 'Unknown location',
        action: formatActionLabel(payload.action),
        status: payload.success === false ? 'failed' : 'success',
        source: payload.source,
        detail: payload.detail,
        success: payload.success !== false,
        error: payload.error,
        thought: payload.thought,
        durationMs: payload.durationMs,
        step: payload.step,
        elementId: payload.elementId,
        attempt: payload.attempt,
        retryCategory: payload.retryCategory,
        queueDepth: payload.queueDepth,
        latencyMs: payload.latencyMs,
        recoverPath: payload.recoverPath,
        decisionSource: payload.decisionSource,
        ragUsed: payload.ragUsed === true,
        ragHitCount: payload.ragHitCount,
        ragEvidenceIds: Array.isArray(payload.ragEvidenceIds)
            ? payload.ragEvidenceIds.filter((id): id is number => typeof id === 'number')
            : undefined,
        decisionLatencyMs: payload.decisionLatencyMs,
    }
}

// ============================================================
// Main Component
// ============================================================

export function Traffic() {
    const { t } = useI18n()
    const [activeTab, setActiveTab] = useState<'campaigns' | 'monitor' | 'reports'>('campaigns')
    const [campaigns, setCampaigns] = useState<Campaign[]>([])
    const [accounts, setAccounts] = useState<Account[]>([])
    const [locations, setLocations] = useState<Location[]>([])
    const [loading, setLoading] = useState(true)
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null)
    const [monitorActionLogs, setMonitorActionLogs] = useState<MonitorActionLog[]>([])
    const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicy | null>(null)
    const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics | null>(null)
    const [ragStats, setRagStats] = useState<RagStats | null>(null)
    const [mcpHealth, setMcpHealth] = useState<McpHealth | null>(null)
    const [selectedReport, setSelectedReport] = useState<ReportData | null>(null)
    const [reportCampaignId, setReportCampaignId] = useState<number | null>(null)
    const statusInterval = useRef<ReturnType<typeof setInterval> | null>(null)
    const lastThreadStateRef = useRef<Record<number, string>>({})
    const wasRunningRef = useRef(false)
    const lastHeavyRuntimeFetchAtRef = useRef(0)
    const activeTabRef = useRef<'campaigns' | 'monitor' | 'reports'>('campaigns')

    const api = (window as any).electronAPI

    // ============================================================
    // Data Fetching
    // ============================================================

    const fetchCampaigns = useCallback(async () => {
        try {
            const data = await api.trafficBoost.getCampaigns()
            setCampaigns(data || [])
        } catch (err) {
            console.error('Failed to fetch campaigns:', err)
        }
    }, [])

    const fetchAccounts = useCallback(async () => {
        try {
            const data = await api.accounts.getAll()
            setAccounts(data || [])
        } catch (err) {
            console.error('Failed to fetch accounts:', err)
        }
    }, [])

    const fetchLocations = useCallback(async () => {
        try {
            const data = await api.locations.getAll()
            setLocations(data || [])
        } catch (err) {
            console.error('Failed to fetch locations:', err)
        }
    }, [])

    const applyStatus = useCallback((incoming: RuntimeStatusPayload | LiveStatus | null | undefined) => {
        const status = normalizeLiveStatus(incoming)
        setLiveStatus(status)

        if (!status?.isRunning) {
            lastThreadStateRef.current = {}
            return
        }

        const nextLogs: MonitorActionLog[] = []
        const now = Date.now()
        const activeThreadIds = new Set<number>()

        for (const thread of status.threads || []) {
            activeThreadIds.add(thread.id)
            const actionText = (thread.currentAction || '').trim()
            if (!actionText) {
                continue
            }

            const fingerprint = `${thread.status}|${thread.accountEmail}|${thread.locationName}|${thread.currentKeyword || ''}|${actionText}`
            if (lastThreadStateRef.current[thread.id] === fingerprint) {
                continue
            }

            lastThreadStateRef.current[thread.id] = fingerprint
            nextLogs.push({
                id: `${now}-${thread.id}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: now,
                threadId: thread.id,
                accountEmail: thread.accountEmail || 'Anonymous',
                locationName: thread.locationName || 'Unknown location',
                action: actionText,
                status: thread.status,
            })
        }

        for (const key of Object.keys(lastThreadStateRef.current)) {
            const threadId = Number(key)
            if (!activeThreadIds.has(threadId)) {
                delete lastThreadStateRef.current[threadId]
            }
        }

        if (nextLogs.length > 0) {
            setMonitorActionLogs(previous => [...nextLogs.reverse(), ...previous].slice(0, 250))
        }
    }, [])

    const fetchStatus = useCallback(async () => {
        try {
            if (api.runtime?.getStatusV2) {
                const status = await api.runtime.getStatusV2()
                applyStatus(status)
                const now = Date.now()
                const heavyIntervalMs = status?.isRunning ? 5000 : 15000
                if (now - lastHeavyRuntimeFetchAtRef.current >= heavyIntervalMs) {
                    lastHeavyRuntimeFetchAtRef.current = now
                    const [diagnostics, policy, rag, mcp] = await Promise.all([
                        api.runtime.getDiagnostics ? api.runtime.getDiagnostics() : Promise.resolve(null),
                        api.runtime.getPolicy ? api.runtime.getPolicy() : Promise.resolve(null),
                        api.rag?.getStats ? api.rag.getStats() : Promise.resolve(null),
                        api.mcp?.getHealth ? api.mcp.getHealth() : Promise.resolve(null),
                    ])
                    if (diagnostics) {
                        setRuntimeDiagnostics(diagnostics as RuntimeDiagnostics)
                    }
                    if (policy) {
                        setRuntimePolicy(policy as RuntimePolicy)
                    }
                    if (rag) {
                        setRagStats(rag as RagStats)
                    }
                    if (mcp) {
                        setMcpHealth(mcp as McpHealth)
                    }
                }
                return
            }

            const legacyStatus = await api.trafficBoost.getStatus()
            applyStatus(legacyStatus)
        } catch (err) {
            console.error('Failed to fetch status:', err)
        }
    }, [api.runtime, api.trafficBoost, applyStatus])

    useEffect(() => {
        Promise.all([fetchCampaigns(), fetchAccounts(), fetchLocations()]).finally(() => setLoading(false))
    }, [])

    useEffect(() => {
        activeTabRef.current = activeTab
    }, [activeTab])

    // Real-time status polling when on monitor tab
    useEffect(() => {
        if (activeTab === 'monitor') {
            fetchStatus()
            statusInterval.current = setInterval(fetchStatus, 1500)
        }
        return () => {
            if (statusInterval.current) clearInterval(statusInterval.current)
        }
    }, [activeTab, fetchStatus])

    // Listen for real-time updates
    useEffect(() => {
        const unsubscribers: Array<() => void> = []

        if (api.runtime?.onStatusV2) {
            unsubscribers.push(
                api.runtime.onStatusV2((status: RuntimeStatusPayload) => {
                    if (activeTabRef.current !== 'monitor') {
                        setLiveStatus(normalizeLiveStatus(status))
                        return
                    }
                    applyStatus(status)
                })
            )
        } else if (api.trafficBoost?.onStatusUpdate) {
            unsubscribers.push(
                api.trafficBoost.onStatusUpdate((status: LiveStatus) => {
                    if (activeTabRef.current !== 'monitor') {
                        setLiveStatus(normalizeLiveStatus(status))
                        return
                    }
                    applyStatus(status)
                })
            )
        }

        if (api.runtime?.onActionEvent) {
            unsubscribers.push(
                api.runtime.onActionEvent((event: RuntimeActionEventPayload) => {
                    if (activeTabRef.current !== 'monitor') {
                        return
                    }
                    const log = toMonitorActionLog(event)
                    if (!log) {
                        return
                    }
                    setMonitorActionLogs(previous => [log, ...previous].slice(0, 400))
                })
            )
        }

        return () => {
            for (const unsubscribe of unsubscribers) {
                try {
                    unsubscribe()
                } catch {
                    // Ignore listener cleanup errors.
                }
            }
        }
    }, [api.runtime, api.trafficBoost, applyStatus])

    useEffect(() => {
        if (liveStatus?.isRunning) {
            wasRunningRef.current = true
            return
        }
        if (wasRunningRef.current) {
            wasRunningRef.current = false
            setActiveTab('campaigns')
            void fetchCampaigns()
        }
    }, [liveStatus?.isRunning, fetchCampaigns])

    // ============================================================
    // Actions
    // ============================================================

    const handleStartCampaign = async (id: number) => {
        try {
            lastThreadStateRef.current = {}
            setMonitorActionLogs([])
            await api.trafficBoost.start(id)
            setActiveTab('monitor')
            fetchCampaigns()
        } catch (err) {
            console.error('Failed to start campaign:', err)
        }
    }

    const handleStopCampaign = async () => {
        try {
            await api.trafficBoost.stop()
            fetchCampaigns()
        } catch (err) {
            console.error('Failed to stop campaign:', err)
        }
    }

    const handlePauseCampaign = async () => {
        try {
            await api.trafficBoost.pause()
        } catch (err) {
            console.error('Failed to pause campaign:', err)
        }
    }

    const handleDeleteCampaigns = async (ids: number[]) => {
        const uniqueIds = Array.from(new Set(ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)))
        if (uniqueIds.length === 0) {
            return
        }

        const isSingle = uniqueIds.length === 1
        const confirmed = confirm(
            isSingle
                ? 'Delete this campaign and all its logs?'
                : `Delete ${uniqueIds.length} campaigns and all their logs?`
        )
        if (!confirmed) {
            return
        }

        try {
            if (typeof api.trafficBoost.deleteCampaigns === 'function') {
                await api.trafficBoost.deleteCampaigns(uniqueIds)
            } else {
                for (const campaignId of uniqueIds) {
                    await api.trafficBoost.deleteCampaign(campaignId)
                }
            }
            fetchCampaigns()
        } catch (err) {
            console.error('Failed to delete campaign(s):', err)
        }
    }

    const handleDeleteCampaign = async (id: number) => {
        await handleDeleteCampaigns([id])
    }

    const handleViewReport = async (id: number) => {
        try {
            setReportCampaignId(id)
            const report = await api.trafficBoost.getReport(id)
            setSelectedReport(report)
            setActiveTab('reports')
        } catch (err) {
            console.error('Failed to get report:', err)
        }
    }

    // ============================================================
    // Render
    // ============================================================

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 text-[#8d74e8] animate-spin" />
            </div>
        )
    }

    return (
        <PageShell>
            <PageHeader
                icon={TrendingUp}
                tone="violet"
                title={t('traffic.title')}
                subtitle={t('traffic.subtitle')}
            >
                {activeTab === 'campaigns' && (
                    <PrimaryButton icon={Plus} onClick={() => setShowCreateModal(true)}>
                        {t('traffic.createCampaign')}
                    </PrimaryButton>
                )}
            </PageHeader>

            <SegmentedTabs
                value={activeTab}
                onChange={setActiveTab}
                className="w-full justify-stretch"
                items={[
                    { id: 'campaigns' as const, label: t('traffic.campaigns'), icon: FileText },
                    { id: 'monitor' as const, label: t('traffic.liveMonitor'), icon: Activity },
                    { id: 'reports' as const, label: t('traffic.reports'), icon: BarChart3 },
                ]}
            />

            {/* Tab Content */}
            {activeTab === 'campaigns' && !showCreateModal && (
                <CampaignsTab
                    campaigns={campaigns}
                    onStart={handleStartCampaign}
                    onDelete={handleDeleteCampaign}
                    onDeleteMany={handleDeleteCampaigns}
                    onViewReport={handleViewReport}
                    onRefresh={fetchCampaigns}
                />
            )}

            {activeTab === 'monitor' && (
                <MonitorTab
                    status={liveStatus}
                    actionLogs={monitorActionLogs}
                    runtimePolicy={runtimePolicy}
                    runtimeDiagnostics={runtimeDiagnostics}
                    ragStats={ragStats}
                    mcpHealth={mcpHealth}
                    onStop={handleStopCampaign}
                    onPause={handlePauseCampaign}
                    onRefresh={fetchStatus}
                />
            )}

            {activeTab === 'reports' && (
                <ReportsTab
                    campaigns={campaigns}
                    report={selectedReport}
                    reportCampaignId={reportCampaignId}
                    onSelectCampaign={handleViewReport}
                />
            )}

            {/* Create Campaign Modal */}
            {showCreateModal && (
                <CreateCampaignModal
                    accounts={accounts}
                    locations={locations}
                    onClose={() => setShowCreateModal(false)}
                    onCreate={async (data) => {
                        await api.trafficBoost.createCampaign(data)
                        setShowCreateModal(false)
                        fetchCampaigns()
                    }}
                />
            )}
        </PageShell>
    )
}

// ============================================================
// Campaigns Tab
// ============================================================

function CampaignsTab({ campaigns, onStart, onDelete, onDeleteMany, onViewReport, onRefresh }: {
    campaigns: Campaign[]
    onStart: (id: number) => void
    onDelete: (id: number) => void
    onDeleteMany: (ids: number[]) => Promise<void> | void
    onViewReport: (id: number) => void
    onRefresh: () => void
}) {
    const { t } = useI18n()
    const [selectedCampaignIds, setSelectedCampaignIds] = useState<number[]>([])
    const [bulkDeleting, setBulkDeleting] = useState(false)

    useEffect(() => {
        setSelectedCampaignIds(prev =>
            prev.filter(id => campaigns.some(campaign => campaign.id === id))
        )
    }, [campaigns])

    const selectedCount = selectedCampaignIds.length
    const allSelected = campaigns.length > 0 && selectedCount === campaigns.length

    const toggleSelectedCampaign = (campaignId: number) => {
        setSelectedCampaignIds(prev =>
            prev.includes(campaignId)
                ? prev.filter(id => id !== campaignId)
                : [...prev, campaignId]
        )
    }

    const toggleSelectAllCampaigns = () => {
        setSelectedCampaignIds(prev =>
            (prev.length === campaigns.length)
                ? []
                : campaigns.map(campaign => campaign.id)
        )
    }

    const handleDeleteSelected = async () => {
        if (selectedCampaignIds.length === 0 || bulkDeleting) {
            return
        }

        setBulkDeleting(true)
        try {
            await onDeleteMany(selectedCampaignIds)
            setSelectedCampaignIds([])
        } finally {
            setBulkDeleting(false)
        }
    }
    const getStatusTone = (status: string): 'amber' | 'emerald' | 'rose' | 'violet' | 'slate' => {
        const map: Record<string, 'amber' | 'emerald' | 'rose' | 'violet' | 'slate'> = {
            pending: 'amber',
            running: 'emerald',
            paused: 'amber',
            completed: 'violet',
            stopped: 'rose',
        }
        return map[status] || 'slate'
    }

    if (campaigns.length === 0) {
        return (
            <EmptyState
                icon={Globe}
                title={t('traffic.noCampaigns')}
                subtitle={t('traffic.createFirst')}
            />
        )
    }

    return (
        <div className="space-y-4">
            {/* Campaign Info Banner */}
            <AlertBanner type="info">
                <div className="flex items-center gap-2 mb-1">
                    <Zap className="w-4 h-4" />
                    <span className="font-semibold">{t('traffic.smartTrafficBoost')}</span>
                </div>
                <ul className="text-sm space-y-0.5 mt-1 opacity-90">
                    <li>- <strong>{t('traffic.persistentSessions')}</strong> - {t('traffic.persistentSessionsDesc')}</li>
                    <li>- <strong>{t('traffic.seoActions')}</strong> - {t('traffic.seoActionsDesc')}</li>
                    <li>- <strong>{t('traffic.multiThreaded')}</strong> - {t('traffic.multiThreadedDesc')}</li>
                    <li>- <strong>{t('traffic.humanLike')}</strong> - {t('traffic.humanLikeDesc')}</li>
                </ul>
            </AlertBanner>

            {/* Campaign Cards */}
            <SectionPanel icon={FileText} title={<>{t('traffic.allCampaigns')} <Badge tone="slate" className="ml-2">{campaigns.length}</Badge></>}>
                {/* Toolbar */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-[#5f5a6d] font-medium cursor-pointer">
                            <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={toggleSelectAllCampaigns}
                                className="h-4 w-4 rounded accent-[#8d74e8]"
                            />
                            Chọn tất cả
                        </label>
                        <PrimaryButton
                            tone="rose"
                            variant="quiet"
                            icon={bulkDeleting ? Loader2 : Trash2}
                            onClick={handleDeleteSelected}
                            disabled={selectedCount === 0 || bulkDeleting}
                        >
                            Xóa đã chọn ({selectedCount})
                        </PrimaryButton>
                    </div>
                    <IconButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
                </div>

                <Divider />

                {/* Campaign List */}
                <div className="space-y-3">
                    {campaigns.map(c => (
                        <Panel key={c.id} tone="slate" className="p-4">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        checked={selectedCampaignIds.includes(c.id)}
                                        onChange={() => toggleSelectedCampaign(c.id)}
                                        className="h-4 w-4 rounded accent-[#8d74e8]"
                                    />
                                    <h4 className="text-[#17171f] font-semibold">{c.name}</h4>
                                    {c.trafficMode === 'organic' && (
                                        <StatusPill tone="emerald">Organic</StatusPill>
                                    )}
                                    {c.trafficMode === 'map_search' && (
                                        <StatusPill tone="emerald">SEO Map</StatusPill>
                                    )}
                                    <StatusPill tone={getStatusTone(c.status)}>{c.status}</StatusPill>
                                </div>
                                <div className="flex items-center gap-2">
                                    {c.status === 'pending' && (
                                        <PrimaryButton tone="emerald" icon={Play} onClick={() => onStart(c.id)}>
                                            {t('traffic.start')}
                                        </PrimaryButton>
                                    )}
                                    <PrimaryButton variant="quiet" icon={BarChart3} onClick={() => onViewReport(c.id)}>
                                        {t('traffic.report')}
                                    </PrimaryButton>
                                    <IconButton icon={Trash2} label="Delete Campaign" onClick={() => onDelete(c.id)} />
                                </div>
                            </div>

                            {/* Campaign Details */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div>
                                    <span className="text-[#908a9e] text-xs font-semibold uppercase">Accounts</span>
                                    <div className="text-[#17171f] mt-0.5 font-medium">
                                        {c.accounts?.map(a => a.email).join(', ') || (
                                            <span className="text-[#908a9e]">{getJsonArrayLength(c.accountIds)} accounts</span>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-[#908a9e] text-xs font-semibold uppercase">Locations</span>
                                    <div className="text-[#17171f] mt-0.5 font-medium">
                                        {c.locations?.map(l => l.name).join(', ') || (
                                            <span className="text-[#908a9e]">{getJsonArrayLength(c.locationIds)} locations</span>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-[#908a9e] text-xs font-semibold uppercase">{t('traffic.concurrentThreads')} / {t('traffic.targetVisits')}</span>
                                    <div className="text-[#17171f] mt-0.5 font-medium">{c.threadsCount} threads - {c.visitsPerLocation} visits/loc</div>
                                </div>
                                <div>
                                    <span className="text-[#908a9e] text-xs font-semibold uppercase">{t('traffic.progress')}</span>
                                    <div className="text-[#17171f] mt-0.5 font-medium">
                                        {((c.completedVisits || 0) + (c.failedVisits || 0))} / {c.totalVisits || '---'} {t('traffic.visits')}
                                        {c.failedVisits ? <span className="text-rose-600 ml-2">({c.failedVisits} {t('traffic.failedVisits')})</span> : null}
                                    </div>
                                </div>
                            </div>

                            {/* Progress bar */}
                            {c.totalVisits > 0 && (
                                <ProgressBar
                                    value={(c.completedVisits || 0) + (c.failedVisits || 0)}
                                    max={c.totalVisits}
                                    tone="violet"
                                    className="mt-3"
                                />
                            )}
                        </Panel>
                    ))}
                </div>
            </SectionPanel>
        </div>
    )
}

// ============================================================
// Thread Cursor Preview
// ============================================================

function ThreadCursorPreview({ thread, clickVersion }: {
    thread: ThreadDetail
    clickVersion: number
}) {
    const [isClicking, setIsClicking] = useState(false)

    useEffect(() => {
        if (clickVersion <= 0) {
            return
        }
        setIsClicking(true)
        const timer = setTimeout(() => {
            setIsClicking(false)
        }, 380)
        return () => clearTimeout(timer)
    }, [clickVersion])

    const actorName = (thread.accountEmail || `Thread ${thread.id}`).split('@')[0].slice(0, 14)
    const actionName = formatCursorAction(thread.currentAction)
    const delaySeconds = ((thread.id % 9) * 0.43).toFixed(2)

    return (
        <div className="relative mt-3 h-28 rounded-[16px] border border-[#e6e0fb] bg-gradient-to-br from-[#f4f0ff] via-[#f7f7f9] to-white overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(141,116,232,0.12),transparent_45%),radial-gradient(circle_at_80%_70%,rgba(141,116,232,0.08),transparent_45%)]" />
            <div
                className={`live-cursor-bot ${thread.status === 'visiting' ? 'is-active' : ''} ${isClicking ? 'is-clicking' : ''}`}
                style={{ animationDelay: `-${delaySeconds}s` }}
            >
                <div className="live-cursor-icon-shell">
                    <MousePointer2 className="w-6 h-6 text-[#8d74e8] fill-[#e6e0fb] drop-shadow-[0_6px_12px_rgba(141,116,232,0.35)]" />
                </div>
                <div className="live-cursor-name">{actorName || `Thread ${thread.id}`}</div>
                <div className="live-cursor-action">{actionName}</div>
            </div>
        </div>
    )
}

// ============================================================
// Live Monitor Tab
// ============================================================

function MonitorTab({ status, actionLogs, runtimePolicy, runtimeDiagnostics, ragStats, mcpHealth, onStop, onPause, onRefresh }: {
    status: LiveStatus | null
    actionLogs: MonitorActionLog[]
    runtimePolicy: RuntimePolicy | null
    runtimeDiagnostics: RuntimeDiagnostics | null
    ragStats: RagStats | null
    mcpHealth: McpHealth | null
    onStop: () => void
    onPause: () => void
    onRefresh: () => void
}) {
    const { t } = useI18n()
    const [fproxyInfo, setFproxyInfo] = useState<{ ip: string; port: string; location: string; expiresIn: number; user: string; nextRotateIn: number; autoRotate: boolean } | null>(null)
    const lastThreadActionRef = useRef<Record<number, string>>({})
    const [cursorClickVersion, setCursorClickVersion] = useState<Record<number, number>>({})
    const effectiveMode = status?.effectiveNetworkMode || status?.networkState?.mode || 'direct'

    // Bump cursor click version when a thread's action changes
    useEffect(() => {
        if (!status?.threads) return
        const nextVersions: Record<number, number> = { ...cursorClickVersion }
        let changed = false
        for (const thread of status.threads) {
            const action = (thread.currentAction || '').trim()
            const prev = lastThreadActionRef.current[thread.id]
            if (action && action !== prev) {
                lastThreadActionRef.current[thread.id] = action
                nextVersions[thread.id] = (nextVersions[thread.id] || 0) + 1
                changed = true
            }
        }
        if (changed) {
            setCursorClickVersion(nextVersions)
        }
    }, [status?.threads])

    // Poll FProxy info every 5 seconds when campaign is running
    useEffect(() => {
        if (!status?.isRunning || effectiveMode !== 'fproxy') {
            setFproxyInfo(null)
            return
        }
        const fetchInfo = async () => {
            try {
                const info = await (window as any).electronAPI.fproxy.getInfo()
                setFproxyInfo(info)
            } catch {
                setFproxyInfo(null)
            }
        }
        fetchInfo()
        const interval = setInterval(fetchInfo, 5000)
        return () => clearInterval(interval)
    }, [status?.isRunning, effectiveMode])

    if (!status || !status.isRunning) {
        return (
            <EmptyState
                icon={Activity}
                title={t('traffic.noActiveCampaign')}
                subtitle={t('traffic.startCampaignHint')}
            />
        )
    }

    const progress = status.totalVisits > 0
        ? Math.round((((status.completedVisits || 0) + (status.failedVisits || 0)) / status.totalVisits) * 100)
        : 0
    const recentTimeline = actionLogs.slice(0, 120)
    const successCount = recentTimeline.filter(log => log.success !== false).length
    const failedCount = recentTimeline.length - successCount
    const llmCount = recentTimeline.filter(log => log.decisionSource === 'llm' || log.decisionSource === 'llm+rag').length
    const heuristicCount = recentTimeline.filter(log => log.decisionSource === 'heuristic').length
    const ragCount = recentTimeline.filter(log => log.decisionSource === 'llm+rag' || log.ragUsed === true).length

    return (
        <div className="space-y-4">
            {/* Campaign Overview */}
            <Panel tone="slate" className="p-5">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-[#17171f] font-semibold text-lg flex items-center gap-2">
                            <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse" />
                            {status.campaignName}
                        </h3>
                        <p className="text-[#908a9e] text-sm mt-1">
                            {t('traffic.round')} {status.currentRound} - {status.activeThreads} {t('traffic.activeThreads')}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <PrimaryButton tone="amber" variant="quiet" icon={Pause} onClick={onPause}>
                            {t('traffic.pause')}
                        </PrimaryButton>
                        <PrimaryButton tone="rose" variant="quiet" icon={Square} onClick={onStop}>
                            {t('traffic.stop')}
                        </PrimaryButton>
                        <IconButton icon={RefreshCw} label="Refresh status" onClick={onRefresh} />
                    </div>
                </div>

                {/* Stats Row */}
                <StatRow className="mb-4">
                    <DSStatCard icon={CheckCircle} label={t('traffic.completed')} value={status.completedVisits} tone="emerald" />
                    <DSStatCard icon={Eye} label={t('traffic.totalTarget')} value={status.totalVisits} tone="blue" />
                    <DSStatCard icon={XCircle} label={t('traffic.failedVisits')} value={status.failedVisits} tone="rose" />
                    <DSStatCard icon={Activity} label={t('traffic.progress')} value={`${progress}%`} tone="violet" />
                </StatRow>

                {/* Progress Bar */}
                <ProgressBar value={progress} tone="emerald" />
            </Panel>

            {/* Proxy Status Banner */}
            <Panel tone={effectiveMode === 'fproxy' ? 'emerald' : effectiveMode === 'static_proxy' ? 'cyan' : 'slate'} className="p-3 flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${effectiveMode === 'fproxy' ? 'bg-emerald-100' : effectiveMode === 'static_proxy' ? 'bg-cyan-100' : 'bg-[#f4f1fa]'}`}>
                    <Globe className={`w-4 h-4 ${effectiveMode === 'fproxy' ? 'text-emerald-600' : effectiveMode === 'static_proxy' ? 'text-cyan-600' : 'text-[#908a9e]'}`} />
                </div>
                {effectiveMode === 'fproxy' ? (
	                    <div className="max-h-72 overflow-y-auto">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-emerald-700 text-sm font-semibold">Proxy đang hoạt động</span>
                            <Badge tone="emerald">FProxy</Badge>
                            {fproxyInfo?.autoRotate && (
                                <Badge tone="cyan">Auto-Rotate</Badge>
                            )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs flex-wrap">
                            <span className="text-[#17171f] font-mono">{fproxyInfo?.ip || '...'}:{fproxyInfo?.port || '...'}</span>
                            <span className="text-[#908a9e]">-</span>
                            <span className="text-cyan-600">{fproxyInfo?.location || '...'}</span>
                            <span className="text-[#908a9e]">-</span>
                            <span className={`${(fproxyInfo?.expiresIn || 0) > 60 ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {Math.floor((fproxyInfo?.expiresIn || 0) / 60)}:{String((fproxyInfo?.expiresIn || 0) % 60).padStart(2, '0')}
                            </span>
                            {fproxyInfo?.autoRotate && (fproxyInfo?.nextRotateIn || 0) > 0 && (
                                <>
                                    <span className="text-[#908a9e]">-</span>
                                    <span className={`${(fproxyInfo?.nextRotateIn || 0) > 30 ? 'text-[#735bd6]' : 'text-amber-600 animate-pulse'}`}>
                                        Rotate {Math.floor((fproxyInfo?.nextRotateIn || 0) / 60)}:{String((fproxyInfo?.nextRotateIn || 0) % 60).padStart(2, '0')}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
	                ) : (
                    <div className="flex-1">
	                        <span className="text-[#5f5a6d] text-sm">
	                            {effectiveMode === 'static_proxy'
	                                ? `Proxy tinh dang hoat dong${status.networkState?.proxyInfo ? `: ${status.networkState.proxyInfo}` : ''}`
	                                : 'Khong co proxy -- Ket noi truc tiep'}
	                        </span>
                    </div>
                )}
            </Panel>

            {/* Thread Status */}
            <SectionPanel icon={Users} title={t('traffic.activeThreads')} tone="violet">
                {status.threads.length === 0 ? (
                    <div className="p-8 text-center text-[#908a9e]">
                        <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin text-[#8d74e8]" />
                        {t('traffic.waitingThreads')}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {status.threads.map(thread => (
                            <Panel key={thread.id} tone="slate" className="p-4">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-3">
                                        <div className={`w-2 h-2 rounded-full ${thread.status === 'visiting' ? 'bg-emerald-500 animate-pulse' :
                                            thread.status === 'waiting' ? 'bg-amber-500' :
                                                'bg-[#908a9e]'
                                            }`} />
                                        <span className="text-[#17171f] text-sm font-semibold">Thread #{thread.id}</span>
                                        <span className="text-[#908a9e] text-xs">-</span>
                                        <span className="text-[#735bd6] text-sm font-medium">{thread.accountEmail}</span>
                                    </div>
                                    <StatusPill tone={thread.status === 'visiting' ? 'emerald' : thread.status === 'waiting' ? 'amber' : 'slate'}>{thread.status}</StatusPill>
                                </div>
                                <div className="flex items-center gap-3 text-sm">
                                    <MapPin className="w-3.5 h-3.5 text-[#908a9e]" />
                                    <span className="text-[#5f5a6d]">{thread.locationName}</span>
                                    {thread.currentAction && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className="text-amber-600 font-medium">{thread.currentAction}</span>
                                        </>
                                    )}
                                </div>
                                {thread.proxyInfo && (
                                    <div className="flex items-center gap-2 text-xs mt-1">
                                        <span className="text-emerald-600">Proxy:</span>
                                        <span className="text-emerald-700">{thread.proxyInfo}</span>
                                    </div>
                                )}
                                {thread.currentKeyword && (
                                    <div className="flex items-center gap-2 text-xs mt-1">
                                        <Search className="w-3 h-3 text-blue-600" />
                                        <span className="text-blue-700">Keyword: <span className="font-semibold">"{thread.currentKeyword}"</span></span>
                                    </div>
                                )}
                                {thread.currentUrl && (
                                    <div className="flex items-center gap-2 text-xs mt-1">
                                        <Globe className="w-3 h-3 text-[#735bd6] shrink-0" />
                                        <span className="text-[#735bd6] truncate" title={thread.currentUrl}>{thread.currentUrl}</span>
                                    </div>
                                )}
                                {thread.progress > 0 && (
                                    <ProgressBar value={thread.progress} tone="violet" size="sm" className="mt-2" />
                                )}
                                <ThreadCursorPreview thread={thread} clickVersion={cursorClickVersion[thread.id] || 0} />
                            </Panel>
                        ))}
                    </div>
                )}
            </SectionPanel>

            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">Su kien gan nhat: </span><span className="text-xs text-[#735bd6] font-semibold">{recentTimeline.length}</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">Thanh cong: </span><span className="text-xs text-emerald-600 font-semibold">{successCount}</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">Loi: </span><span className="text-xs text-rose-600 font-semibold">{failedCount}</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">H/LLM/RAG: </span><span className="text-xs text-[#735bd6] font-semibold">{heuristicCount}/{llmCount}/{ragCount}</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">Queue depth: </span><span className="text-xs text-amber-600 font-semibold">{runtimeDiagnostics?.queueDepth ?? 0}</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">CAPTCHA mode: </span><span className="text-xs text-[#735bd6] font-semibold">{runtimePolicy?.captchaMode || 'n/a'}</span>
                </Panel>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">RAG hits/queries: </span><span className="text-xs text-[#735bd6] font-semibold">{ragStats?.retrievalHitCount ?? 0}/{ragStats?.retrievalCount ?? 0}</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">RAG p95 latency: </span><span className="text-xs text-[#735bd6] font-semibold">{ragStats?.p95LatencyMs ?? 0}ms</span>
                </Panel>
                <Panel tone="slate" className="!p-2.5">
                    <span className="text-xs text-[#6f697c]">MCP health: </span><span className={`text-xs font-semibold ${mcpHealth?.healthy ? 'text-emerald-600' : 'text-amber-600'}`}>{mcpHealth?.healthy ? 'healthy' : 'degraded'}</span>
                </Panel>
            </div>

            {/* Realtime Action Timeline */}
            <SectionPanel icon={Activity} title="Nhat ky hanh dong AI (realtime)" tone="violet">
                {actionLogs.length === 0 ? (
                    <div className="p-6 text-center text-[#908a9e] text-sm">
                        Chua co hanh dong nao duoc ghi nhan.
	                    </div>
	                ) : false ? (
	                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[#17171f] text-sm font-medium">Proxy tinh dang hoat dong</span>
                            <span className="text-xs bg-[#f4f1fa] text-[#8d74e8] px-1.5 py-0.5 rounded">Static</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs flex-wrap">
                            {status?.networkState?.proxyInfo ? (
                                <span className="text-[#17171f] font-mono">{status?.networkState?.proxyInfo}</span>
                            ) : (
                                <span className="text-[#5f5a6d]">Proxy pool active</span>
                            )}
                            {status?.networkState?.reason && (
                                <>
                                    <span className="text-[#908a9e]">·</span>
                                    <span className="text-[#5f5a6d]">{status?.networkState?.reason}</span>
                                </>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="max-h-72 overflow-y-auto divide-y divide-[#e9e4f2]">
                        {actionLogs.map(log => (
                            <div key={log.id} className="p-3 text-sm">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs text-[#908a9e] w-32">{formatDateTime(log.timestamp)}</span>
                                    <Badge tone="violet">Thread #{log.threadId}</Badge>
                                    <StatusPill tone={
                                        log.status === 'visiting' ? 'emerald'
                                        : log.status === 'waiting' ? 'amber'
                                        : log.status === 'success' ? 'emerald'
                                        : log.status === 'failed' ? 'rose'
                                        : 'slate'
                                    }>
                                        {log.status}
                                    </StatusPill>
                                    {log.source && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className="text-[#735bd6] text-xs">{log.source}</span>
                                        </>
                                    )}
                                    {log.decisionSource && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className={`text-xs font-medium ${log.decisionSource === 'heuristic'
                                                ? 'text-emerald-600'
                                                : log.decisionSource === 'llm'
                                                    ? 'text-[#735bd6]'
                                                    : 'text-[#8d74e8]'
                                                }`}>
                                                {log.decisionSource}
                                            </span>
                                        </>
                                    )}
                                    {log.step !== undefined && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className="text-[#735bd6] text-xs">step {log.step}</span>
                                        </>
                                    )}
                                    {log.elementId !== undefined && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className="text-[#5f5a6d] text-xs">el #{log.elementId}</span>
                                        </>
                                    )}
                                    {log.attempt !== undefined && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className="text-amber-600 text-xs">attempt {log.attempt}</span>
                                        </>
                                    )}
                                    {log.retryCategory && (
                                        <>
                                            <span className="text-[#908a9e]">-</span>
                                            <span className="text-amber-700 text-xs">{log.retryCategory}</span>
                                        </>
                                    )}
                                    <span className="text-[#5f5a6d]">{log.accountEmail}</span>
                                    <span className="text-[#908a9e]">-</span>
                                    <span className="text-[#5f5a6d]">{log.locationName}</span>
                                </div>
                                <div className="mt-1 text-amber-700 font-medium break-words">{log.action}</div>
                                {log.thought && (
                                    <div className="mt-1 text-xs text-amber-600 break-words">AI: {log.thought}</div>
                                )}
                                {log.detail && (
                                    <div className="mt-1 text-xs text-[#5f5a6d] break-words">{log.detail}</div>
                                )}
                                {log.durationMs !== undefined && (
                                    <div className="mt-1 text-xs text-[#908a9e]">duration: {log.durationMs}ms</div>
                                )}
                                {(log.queueDepth !== undefined || log.latencyMs !== undefined || log.recoverPath) && (
                                    <div className="mt-1 text-xs text-[#908a9e] break-words">
                                        {log.queueDepth !== undefined ? `queue: ${log.queueDepth}` : ''}
                                        {log.latencyMs !== undefined ? `${log.queueDepth !== undefined ? ' - ' : ''}latency: ${log.latencyMs}ms` : ''}
                                        {log.recoverPath ? `${(log.queueDepth !== undefined || log.latencyMs !== undefined) ? ' - ' : ''}recover: ${log.recoverPath}` : ''}
                                    </div>
                                )}
                                {(log.ragUsed || log.ragHitCount !== undefined || log.decisionLatencyMs !== undefined) && (
                                    <div className="mt-1 text-xs text-[#735bd6] break-words">
                                        {log.ragUsed ? 'rag: on' : 'rag: off'}
                                        {log.ragHitCount !== undefined ? ` - hits: ${log.ragHitCount}` : ''}
                                        {log.decisionLatencyMs !== undefined ? ` - decision: ${log.decisionLatencyMs}ms` : ''}
                                        {log.ragEvidenceIds && log.ragEvidenceIds.length > 0 ? ` - evidence: ${log.ragEvidenceIds.slice(0, 5).join(',')}` : ''}
                                    </div>
                                )}
                                {log.error && (
                                    <div className="mt-1 text-xs text-rose-600 break-words">{log.error}</div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </SectionPanel>
        </div>
    )
}

// ============================================================
// Reports Tab
// ============================================================

function ReportsTab({ campaigns, report, reportCampaignId, onSelectCampaign }: {
    campaigns: Campaign[]
    report: ReportData | null
    reportCampaignId: number | null
    onSelectCampaign: (id: number) => void
}) {
    const { t } = useI18n()
    const [expandedLogIds, setExpandedLogIds] = useState<Record<number, boolean>>({})

    useEffect(() => {
        setExpandedLogIds({})
    }, [reportCampaignId])

    const toggleLogDetails = (logId: number) => {
        setExpandedLogIds(previous => ({
            ...previous,
            [logId]: !previous[logId],
        }))
    }

    return (
        <div className="space-y-4">
            {/* Campaign Selector */}
            <Panel tone="slate" className="p-4">
                <h3 className="text-[#24222c] font-semibold mb-3">{t('traffic.selectCampaign')}</h3>
                <div className="flex flex-wrap gap-2">
                    {campaigns.map(c => (
                        <button
                            key={c.id}
                            onClick={() => onSelectCampaign(c.id)}
                            className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-all ${reportCampaignId === c.id
                                ? 'bg-[#8d74e8] text-white shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                : 'bg-white border border-[#e9e4f2] text-[#5f5a6d] hover:bg-[#f4f1fa] hover:text-[#24222c]'
                                }`}
                        >
                            {c.name}
                        </button>
                    ))}
                    {campaigns.length === 0 && (
                        <p className="text-[#908a9e] text-sm">{t('traffic.noCampaignsReport')}</p>
                    )}
                </div>
            </Panel>

            {/* Report Content */}
            {report ? (
                <div className="space-y-4">
                    {/* Summary Stats */}
                    <StatRow>
                        <DSStatCard icon={Eye} label={t('traffic.totalVisits')} value={report.completedVisits} tone="violet" />
                        <DSStatCard icon={XCircle} label={t('traffic.failedVisits')} value={report.failedVisits} tone="rose" />
                        <DSStatCard icon={Clock} label={t('traffic.avgDuration')} value={`${report.avgVisitDuration}s`} tone="amber" />
                        <DSStatCard icon={RefreshCw} label={t('traffic.rounds')} value={report.totalRounds} tone="blue" />
                    </StatRow>

                    {/* Visits by Location */}
                    {report.visitsByLocation.length > 0 && (
                        <SectionPanel icon={MapPin} title={t('traffic.visitsByLocation')} tone="violet">
                            <div className="space-y-2">
                                {report.visitsByLocation.map(loc => (
                                    <div key={loc.locationId} className="flex items-center justify-between p-3 bg-white rounded-[14px] border border-[#e9e4f2]">
                                        <div>
                                            <span className="text-[#17171f] text-sm font-semibold">{loc.locationName}</span>
                                            <div className="text-xs text-[#908a9e]">{t('traffic.avgDuration')} {loc.avgDuration}s</div>
                                        </div>
                                        <Badge tone="violet">{loc.visits} {t('traffic.visits')}</Badge>
                                    </div>
                                ))}
                            </div>
                        </SectionPanel>
                    )}

                    {/* Visits by Account */}
                    {report.visitsByAccount.length > 0 && (
                        <SectionPanel icon={Users} title={t('traffic.visitsByAccount')} tone="emerald">
                            <div className="space-y-2">
                                {report.visitsByAccount.map(acc => (
                                    <div key={acc.accountId} className="flex items-center justify-between p-3 bg-white rounded-[14px] border border-[#e9e4f2]">
                                        <span className="text-[#17171f] text-sm font-semibold">{acc.accountEmail}</span>
                                        <Badge tone="emerald">{acc.visits} {t('traffic.visits')}</Badge>
                                    </div>
                                ))}
                            </div>
                        </SectionPanel>
                    )}

                    {/* Action Stats */}
                    {report.actionStats.length > 0 && (
                        <SectionPanel icon={Zap} title={t('traffic.seoActionsPerformed')} tone="amber">
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                {report.actionStats.map(item => {
                                    const maxCount = Math.max(...report.actionStats.map(a => a.count))
                                    const percentage = maxCount > 0 ? (item.count / maxCount) * 100 : 0
                                    return (
                                        <div key={item.action} className="relative bg-white rounded-[14px] border border-[#e9e4f2] p-3 overflow-hidden">
                                            <div className="relative z-10">
                                                <div className="text-[#17171f] text-sm font-semibold">{formatActionLabel(item.action)}</div>
                                                <div className="text-[#735bd6] text-lg font-bold">{item.count}</div>
                                            </div>
                                            <div
                                                className="absolute inset-0 bg-[#f4f0ff] rounded-[14px] transition-all"
                                                style={{ width: `${percentage}%` }}
                                            />
                                        </div>
                                    )
                                })}
                            </div>
                        </SectionPanel>
                    )}

                    {/* Recent Logs */}
                    {report.logs.length > 0 && (
                        <SectionPanel icon={FileText} title={t('traffic.recentLogs')} tone="violet">
                            <div className="max-h-80 overflow-y-auto space-y-2">
                                {report.logs.map(log => {
                                    const logId = log.id
                                    const isExpanded = !!expandedLogIds[logId]
                                    const actionList = Array.isArray(log.actions) ? log.actions : []

                                    return (
                                        <div key={logId} className="p-3 text-sm bg-white rounded-[14px] border border-[#e9e4f2]">
                                            <div className="flex items-start gap-3">
                                                {log.status === 'success' ? (
                                                    <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                                                ) : (
                                                    <XCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
                                                )}

                                                <div className="flex-1 min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="text-[#908a9e] text-xs">{formatDateTime(log.createdAt)}</span>
                                                        <span className="text-[#e9e4f2]">-</span>
                                                        <span className="text-[#17171f] font-medium truncate">{log.locationName || `Location #${log.locationId}`}</span>
                                                        <span className="text-[#e9e4f2]">-</span>
                                                        <span className="text-[#5f5a6d] truncate">{log.accountEmail || 'Anonymous'}</span>
                                                        <span className="text-[#e9e4f2]">-</span>
                                                        <span className="text-[#5f5a6d]">{log.duration}s</span>
                                                        <span className="text-[#e9e4f2]">-</span>
                                                        <Badge tone="violet">{log.totalActionCount ?? actionList.length} actions</Badge>
                                                    </div>

                                                    {log.errorMessage && (
                                                        <div className="mt-1 text-xs text-rose-600 break-words">
                                                            {log.errorMessage}
                                                        </div>
                                                    )}
                                                </div>

                                                {actionList.length > 0 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleLogDetails(logId)}
                                                        className="p-1 rounded-full hover:bg-[#f4f1fa] transition-colors"
                                                        title={isExpanded ? 'An chi tiet hanh dong' : 'Xem chi tiet hanh dong'}
                                                    >
                                                        {isExpanded ? (
                                                            <ChevronUp className="w-4 h-4 text-[#908a9e]" />
                                                        ) : (
                                                            <ChevronDown className="w-4 h-4 text-[#908a9e]" />
                                                        )}
                                                    </button>
                                                )}
                                            </div>

                                            {isExpanded && actionList.length > 0 && (
                                                <div className="mt-3 ml-7 rounded-[14px] border border-[#e9e4f2] bg-[#f7f7f9] overflow-hidden">
                                                    <div className="max-h-56 overflow-y-auto divide-y divide-[#e9e4f2]">
                                                        {actionList.map((action, index) => (
                                                            <div key={`${logId}-${index}`} className="p-2.5 text-xs space-y-1.5">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    {action.success ? (
                                                                        <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                                                                    ) : (
                                                                        <XCircle className="w-3.5 h-3.5 text-rose-500" />
                                                                    )}
                                                                    <span className="text-[#17171f] font-semibold">
                                                                        {formatActionLabel(action.action)}
                                                                    </span>
                                                                    {action.source && (
                                                                        <Badge tone="violet">{action.source}</Badge>
                                                                    )}
                                                                    {action.decisionSource && (
                                                                        <Badge tone={action.decisionSource === 'heuristic' ? 'emerald' : 'violet'}>
                                                                            {action.decisionSource}
                                                                        </Badge>
                                                                    )}
                                                                    {action.step !== undefined && (
                                                                        <Badge tone="slate">step {action.step}</Badge>
                                                                    )}
                                                                    {action.attempt !== undefined && (
                                                                        <Badge tone="amber">attempt {action.attempt}</Badge>
                                                                    )}
                                                                    {action.retryCategory && (
                                                                        <Badge tone="amber">{action.retryCategory}</Badge>
                                                                    )}
                                                                    {action.timestamp && (
                                                                        <span className="text-[#908a9e]">
                                                                            {formatDateTime(action.timestamp)}
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {action.detail && (
                                                                    <div className="text-[#5f5a6d] break-words">{action.detail}</div>
                                                                )}
                                                                {action.thought && (
                                                                    <div className="text-amber-700 break-words">AI: {action.thought}</div>
                                                                )}
                                                                {action.error && (
                                                                    <div className="text-rose-600 break-words">Error: {action.error}</div>
                                                                )}
                                                                {(action.ragUsed || action.ragHitCount !== undefined || action.decisionLatencyMs !== undefined) && (
                                                                    <div className="text-[#735bd6] break-words">
                                                                        {action.ragUsed ? 'rag: on' : 'rag: off'}
                                                                        {action.ragHitCount !== undefined ? ` | hits: ${action.ragHitCount}` : ''}
                                                                        {action.decisionLatencyMs !== undefined ? ` | decision: ${action.decisionLatencyMs}ms` : ''}
                                                                        {action.ragEvidenceIds && action.ragEvidenceIds.length > 0 ? ` | evidence: ${action.ragEvidenceIds.slice(0, 5).join(',')}` : ''}
                                                                    </div>
                                                                )}
                                                                {(action.queueDepth !== undefined || action.latencyMs !== undefined || action.recoverPath) && (
                                                                    <div className="text-[#908a9e] break-words">
                                                                        {action.queueDepth !== undefined ? `queue: ${action.queueDepth}` : ''}
                                                                        {action.latencyMs !== undefined ? `${action.queueDepth !== undefined ? ' - ' : ''}latency: ${action.latencyMs}ms` : ''}
                                                                        {action.recoverPath ? `${(action.queueDepth !== undefined || action.latencyMs !== undefined) ? ' - ' : ''}recover: ${action.recoverPath}` : ''}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </SectionPanel>
                    )}
                </div>
            ) : (
                <EmptyState
                    icon={BarChart3}
                    title={t('traffic.selectCampaignReport')}
                    subtitle={t('traffic.clickToAnalytics')}
                />
            )}
        </div>
    )
}

// ============================================================
// Create Campaign Modal
// ============================================================

function CreateCampaignModal({ accounts, locations, onClose, onCreate }: {
    accounts: Account[]
    locations: Location[]
    onClose: () => void
    onCreate: (data: any) => Promise<void>
}) {
    const { t } = useI18n()
    const [name, setName] = useState('')
    const [selectedAccounts, setSelectedAccounts] = useState<number[]>([])
    const [selectedLocations, setSelectedLocations] = useState<number[]>([])
    const [threadsCount, setThreadsCount] = useState(1)
    const [visitsPerLocation, setVisitsPerLocation] = useState(10)
    const [delayMin, setDelayMin] = useState(10)
    const [delayMax, setDelayMax] = useState(30)
    const [trafficMode, setTrafficMode] = useState<'direct' | 'organic' | 'web_seo' | 'map_search'>('direct')
    const [locationKeywords, setLocationKeywords] = useState<Record<number, string>>({})
    const [creating, setCreating] = useState(false)
    // map_search specific: max cards to scroll (UI default 15, min 1; passed only relevant for mode)
    const [maxMapScroll, setMaxMapScroll] = useState(15)
    // Web SEO specific state
    const [websiteUrl, setWebsiteUrl] = useState('')
    const [webSeoKeyword, setWebSeoKeyword] = useState('')

    const toggleAccount = (id: number) => {
        setSelectedAccounts(prev =>
            prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]
        )
    }

    const toggleLocation = (id: number) => {
        setSelectedLocations(prev =>
            prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id]
        )
    }

    const handleCreate = async () => {
        if (trafficMode === 'web_seo') {
            // Web SEO mode: need websiteUrl and keyword
            if (!websiteUrl.trim() || !webSeoKeyword.trim()) return
        } else {
            if (selectedLocations.length === 0) return
        }
        const campaignName = name.trim() || `Campaign ${new Date().toLocaleDateString('vi-VN')} ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
        const normalizedDelayMin = Math.max(0, Number.isFinite(delayMin) ? delayMin : 0)
        const normalizedDelayMax = Math.max(normalizedDelayMin, Number.isFinite(delayMax) ? delayMax : normalizedDelayMin)
        setCreating(true)
        try {
            const api = (window as any).electronAPI

            if (trafficMode === 'web_seo') {
                // Web SEO: create a virtual location from websiteUrl, save keywords
                let targetUrl = websiteUrl.trim()
                if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl
                // Extract domain name for location name
                let domainName = targetUrl
                try { domainName = new URL(targetUrl).hostname.replace('www.', '') } catch { /* use as-is */ }

                // Create/find location for this URL
                const loc = await api.locations.add({
                    name: domainName,
                    url: targetUrl,
                    address: targetUrl,
                    placeId: 'web_seo_' + Date.now(),
                })
                const locId = loc?.id || loc

                // Save keywords on the location
                const keywords = webSeoKeyword.split(/[\n,]+/).map((k: string) => k.trim()).filter(Boolean)
                if (keywords.length > 0) {
                    await api.locations.update(locId, {
                        searchKeywords: JSON.stringify(keywords)
                    })
                }

                await onCreate({
                    name: campaignName,
                    accountIds: selectedAccounts,
                    locationIds: [locId],
                    threadsCount,
                    visitsPerLocation,
                    delayMinSeconds: normalizedDelayMin,
                    delayMaxSeconds: normalizedDelayMax,
                    trafficMode,
                    maxMapScroll,
                })
            } else {
                // Direct / Organic mode
                if (trafficMode === 'organic' || trafficMode === 'map_search') {
                    for (const locId of selectedLocations) {
                        const kw = locationKeywords[locId]
                        if (kw && kw.trim()) {
                            const keywords = kw.split(/[\n,]+/).map((k: string) => k.trim()).filter(Boolean)
                            await api.locations.update(locId, {
                                searchKeywords: JSON.stringify(keywords)
                            })
                        }
                    }
                }
                await onCreate({
                    name: campaignName,
                    accountIds: selectedAccounts,
                    locationIds: selectedLocations,
                    threadsCount,
                    visitsPerLocation,
                    delayMinSeconds: normalizedDelayMin,
                    delayMaxSeconds: normalizedDelayMax,
                    trafficMode,
                    maxMapScroll,
                })
            }
        } catch (error: any) {
            console.error('Failed to create campaign:', error)
            alert('Failed to create campaign: ' + (error?.message || error))
        } finally {
            setCreating(false)
        }
    }

    const isValid = trafficMode === 'web_seo'
        ? (websiteUrl.trim().length > 0 && webSeoKeyword.trim().length > 0)
        : selectedLocations.length > 0

    return (
        <Modal open={true} onClose={onClose} title={t('traffic.createCampaign')} size="lg" footer={
            <div className="flex items-center justify-between w-full">
                <div className="text-sm text-[#908a9e]">
                    {trafficMode === 'web_seo' ? (
                        <>
                            {visitsPerLocation} {t('traffic.visits')} x {threadsCount} {t('traffic.threads')} ={' '}
                            <span className="text-[#735bd6] font-semibold">
                                {visitsPerLocation} {t('traffic.totalWebSeoVisits')}
                            </span>
                        </>
                    ) : (
                        <>
                            {(selectedAccounts.length || 1)} {selectedAccounts.length === 0 ? 'anonymous' : t('traffic.accounts')} x{' '}
                            {selectedLocations.length} {t('traffic.locationCount')} x{' '}
                            {visitsPerLocation} {t('traffic.visits')} ={' '}
                            <span className="text-[#735bd6] font-semibold">
                                {(selectedAccounts.length || 1) * selectedLocations.length * visitsPerLocation} {t('traffic.totalVisitsCalc')}
                            </span>
                        </>
                    )}
                </div>
                <div className="flex gap-2">
                    <PrimaryButton variant="quiet" onClick={onClose}>{t('common.cancel')}</PrimaryButton>
                    <PrimaryButton
                        icon={creating ? Loader2 : Plus}
                        onClick={handleCreate}
                        disabled={!isValid || creating}
                    >
                        {creating ? t('traffic.creating') : t('traffic.createCampaign')}
                    </PrimaryButton>
                </div>
            </div>
        }>
                <div className="space-y-5">
                    {/* Name */}
                    <div>
                        <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('traffic.campaignName')}</label>
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="e.g., Daily SEO Boost - Restaurant"
                            autoFocus
                            className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                        />
                    </div>

                    {/* Traffic Mode */}
                    <div>
                        <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('traffic.trafficMode')}</label>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setTrafficMode('direct')}
                                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border transition-all text-sm font-semibold ${trafficMode === 'direct'
                                    ? 'bg-[#8d74e8] text-white border-[#8d74e8] shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                    : 'bg-white border-[#e9e4f2] text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                    }`}
                            >
                                <Globe className="w-4 h-4" />
                                {t('traffic.directUrl')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setTrafficMode('organic')}
                                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border transition-all text-sm font-semibold ${trafficMode === 'organic'
                                    ? 'bg-[#8d74e8] text-white border-[#8d74e8] shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                    : 'bg-white border-[#e9e4f2] text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                    }`}
                            >
                                <Search className="w-4 h-4" />
                                {t('traffic.organicSearch')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setTrafficMode('web_seo')}
                                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border transition-all text-sm font-semibold ${trafficMode === 'web_seo'
                                    ? 'bg-[#8d74e8] text-white border-[#8d74e8] shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                    : 'bg-white border-[#e9e4f2] text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                    }`}
                            >
                                <Search className="w-4 h-4" />
                                {t('traffic.webSEO') || 'Web SEO'}
                            </button>
                            <button
                                type="button"
                                onClick={() => setTrafficMode('map_search')}
                                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full border transition-all text-sm font-semibold ${trafficMode === 'map_search'
                                    ? 'bg-[#8d74e8] text-white border-[#8d74e8] shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                    : 'bg-white border-[#e9e4f2] text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                    }`}
                            >
                                <Search className="w-4 h-4" />
                                {t('traffic.mapSearch') || 'SEO Map'}
                            </button>
                        </div>
                        <p className="text-xs text-[#908a9e] mt-1">
                            {trafficMode === 'direct'
                                ? t('traffic.directUrlDesc')
                                : trafficMode === 'organic'
                                    ? t('traffic.organicSearchDesc')
                                    : trafficMode === 'map_search'
                                        ? (t('traffic.mapSearchDesc') || 'Tìm trực tiếp trên Google Maps → cuộn feed kết quả → vào map (SEO Maps)')
                                        : t('traffic.webSEODesc') || 'Tim Google -> Website muc tieu -> Tuong tac'}
                        </p>
                    </div>

                    {/* Accounts Selection */}
                    <div>
                        <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                            {t('traffic.selectAccounts')} ({selectedAccounts.length} {t('traffic.selected')})
                        </label>
                        <div className="max-h-32 overflow-y-auto bg-[#f7f7f9] rounded-[16px] border border-[#e9e4f2] p-2 space-y-1">
                            {accounts.length === 0 && (
                                <p className="text-[#908a9e] text-sm p-2">{t('traffic.noAccountsAvailable')}</p>
                            )}
                            {selectedAccounts.length === 0 && (
                                <p className="text-xs text-amber-600 mt-1 px-2">Khong chon tai khoan = duyet an danh (anonymous)</p>
                            )}
                            {accounts.map(acc => (
                                <label
                                    key={acc.id}
                                    className="flex items-center gap-2 p-2 rounded-[12px] hover:bg-[#f4f1fa] cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedAccounts.includes(acc.id)}
                                        onChange={() => toggleAccount(acc.id)}
                                        className="h-4 w-4 rounded accent-[#8d74e8]"
                                    />
                                    <span className="text-[#17171f] text-sm">{acc.email}</span>
                                </label>
                            ))}
                        </div>
                        {accounts.length > 0 && (
                            <div className="flex gap-2 mt-1.5">
                                <button
                                    onClick={() => setSelectedAccounts(accounts.map(a => a.id))}
                                    className="text-xs text-[#8d74e8] hover:text-[#735bd6] font-semibold"
                                >
                                    {t('traffic.selectAll')}
                                </button>
                                <button
                                    onClick={() => setSelectedAccounts([])}
                                    className="text-xs text-[#908a9e] hover:text-[#5f5a6d] font-semibold"
                                >
                                    {t('traffic.clear')}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Web SEO mode inputs */}
                    {trafficMode === 'web_seo' && (
                        <Panel tone="violet" className="space-y-4 p-4">
                            <div>
                                <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                    {t('traffic.websiteUrl')}
                                </label>
                                <input
                                    type="url"
                                    value={websiteUrl}
                                    onChange={e => setWebsiteUrl(e.target.value)}
                                    placeholder={t('traffic.websiteUrlPlaceholder')}
                                    className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                    {t('traffic.webSeoKeyword')}
                                </label>
                                <textarea
                                    value={webSeoKeyword}
                                    onChange={e => setWebSeoKeyword(e.target.value)}
                                    placeholder={t('traffic.webSeoKeywordPlaceholder')}
                                    rows={3}
                                    className="w-full px-4 py-3 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3] resize-none"
                                />
                                <p className="text-xs text-[#908a9e] mt-1">{t('traffic.webSeoKeywordHint')}</p>
                            </div>
                            <AlertBanner type="info">
                                {t('traffic.webSeoNote')}
                            </AlertBanner>
                        </Panel>
                    )}

                    {/* Locations selection */}
                    {trafficMode !== 'web_seo' && (
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                {t('traffic.selectLocations')} ({selectedLocations.length} {t('traffic.selected')})
                            </label>
                            <div className={`${(trafficMode === 'organic' || trafficMode === 'map_search') ? 'max-h-60' : 'max-h-32'} overflow-y-auto rounded-[16px] border border-[#e9e4f2] bg-[#f7f7f9] p-2 space-y-1`}>
                                {locations.length === 0 && (
                                    <p className="text-[#908a9e] text-sm p-2">{t('traffic.noLocationsAvailable')}</p>
                                )}
                                {locations.map(loc => (
                                    <div key={loc.id} className="rounded-[12px] hover:bg-[#f4f1fa]">
                                        <label className="flex items-center gap-2 p-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={selectedLocations.includes(loc.id)}
                                                onChange={() => {
                                                    toggleLocation(loc.id)
                                                    if (!selectedLocations.includes(loc.id) && loc.searchKeywords) {
                                                        try {
                                                            const saved = JSON.parse(loc.searchKeywords)
                                                            if (Array.isArray(saved) && saved.length > 0) {
                                                                setLocationKeywords(prev => ({ ...prev, [loc.id]: saved.join('\n') }))
                                                            }
                                                        } catch { /* ignore */ }
                                                    }
                                                }}
                                                className="rounded border-[#e9e4f2] text-[#8d74e8] focus:ring-[#8d74e8]"
                                            />
                                            <div>
                                                <span className="text-[#17171f] text-sm">{loc.name}</span>
                                                <div className="text-xs text-[#908a9e] truncate max-w-xs">{loc.url}</div>
                                            </div>
                                        </label>
                                        {(trafficMode === 'organic' || trafficMode === 'map_search') && selectedLocations.includes(loc.id) && (
                                            <div className="px-2 pb-2 pl-8">
                                                <input
                                                    type="text"
                                                    value={locationKeywords[loc.id] || ''}
                                                    onChange={e => setLocationKeywords(prev => ({ ...prev, [loc.id]: e.target.value }))}
                                                    placeholder={t('traffic.keywordPlaceholder').replace('{name}', loc.name)}
                                                    className="w-full px-3 py-1.5 rounded-[12px] border border-[#e9e4f2] bg-white text-xs text-[#17171f] placeholder:text-[#908a9e] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                                                />
                                                <p className="text-xs text-[#908a9e] mt-0.5">{t('traffic.keywordHint')}</p>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {locations.length > 0 && (
                                <div className="flex gap-2 mt-1.5">
                                    <button
                                        onClick={() => setSelectedLocations(locations.map(l => l.id))}
                                        className="text-xs text-[#8d74e8] hover:text-[#735bd6] font-medium"
                                    >
                                        {t('traffic.selectAll')}
                                    </button>
                                    <button
                                        onClick={() => setSelectedLocations([])}
                                        className="text-xs text-[#908a9e] hover:text-[#5f5a6d]"
                                    >
                                        {t('traffic.clear')}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* map_search specific: max scroll threshold (only for SEO Map mode, near keyword config area) */}
                    {trafficMode === 'map_search' && (
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                {t('traffic.maxMapScroll') || 'Số map tối đa khi cuộn tìm'}
                            </label>
                            <input
                                type="number"
                                value={maxMapScroll}
                                onChange={e => setMaxMapScroll(Math.max(1, Math.min(100, parseInt(e.target.value) || 15)))}
                                min={1}
                                max={100}
                                className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                            />
                            <p className="text-xs text-[#908a9e] mt-0.5">Tối đa số map cuộn trong feed trước khi fallback URL trực tiếp (mặc định 15).</p>
                        </div>
                    )}

                    {/* Basic Settings */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('traffic.threads')}</label>
                            <input
                                type="number"
                                value={threadsCount}
                                onChange={e => setThreadsCount(Math.max(1, parseInt(e.target.value) || 1))}
                                min={1}
                                max={100}
                                className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('traffic.visitsPerLocation')}</label>
                            <input
                                type="number"
                                value={visitsPerLocation}
                                onChange={e => setVisitsPerLocation(Math.max(1, parseInt(e.target.value) || 1))}
                                min={1}
                                className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                            />
                        </div>
                    </div>

                    {/* Delay Settings */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('traffic.minDelay')}</label>
                            <input
                                type="number"
                                value={delayMin}
                                onChange={e => setDelayMin(Math.max(0, parseInt(e.target.value) || 0))}
                                min={0}
                                className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('traffic.maxDelay')}</label>
                            <input
                                type="number"
                                value={delayMax}
                                onChange={e => setDelayMax(Math.max(0, parseInt(e.target.value) || 0))}
                                min={0}
                                className="w-full h-10 px-4 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15 focus:border-[#cbbff3]"
                            />
                        </div>
                    </div>

                    {/* Deterministic Maps SEO Banner */}
                    <Panel tone="cyan" className="p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <Zap className="w-4 h-4 text-[#8d74e8]" />
                            <span className="text-sm font-semibold text-[#17171f]">Maps SEO deterministic mode</span>
                        </div>
                        <p className="text-xs text-[#5f5a6d] leading-relaxed">
                            The browser first checks which Maps actions are actually available, then executes every available KPI action:
                            phone, website, and directions. Missing actions are skipped instead of guessed.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-2">
                            <Badge tone="cyan">Phone</Badge>
                            <Badge tone="cyan">Website</Badge>
                            <Badge tone="cyan">Directions</Badge>
                            <Badge tone="emerald">Available-only</Badge>
                            <Badge tone="emerald">Self-healing</Badge>
                        </div>
                    </Panel>
                </div>
        </Modal>
    )
}
