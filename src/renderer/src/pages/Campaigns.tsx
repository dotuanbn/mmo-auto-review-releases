import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAutomationStore, setupAutomationListeners } from '../stores'
import {
    Plus,
    Play,
    Pause,
    Square,
    Trash2,
    RefreshCw,
    Rocket,
    CheckCircle,
    Clock,
    X,
    AlertCircle,
    Target,
    TrendingUp,
    Activity,
    Star,
    MapPin,
    Users,
    Globe,
    BarChart3,
    Timer,
    ChevronDown,
    ChevronUp,
    Eye,
    Copy
} from 'lucide-react'
import { useI18n } from '../i18n'
import {
    IconButton,
    PageHeader,
    PageShell,
    PrimaryButton,
    StatCard,
    StatRow,
    Panel,
    StatusPill,
    Badge,
    ProgressBar,
    Modal,
    EmptyState,
    AlertBanner,
    SegmentedTabs,
    TextInput,
    SectionPanel,
    Toolbar
} from '../components/ui/surface'
import { AutomationMonitor } from '../components/AutomationMonitor'
import { ResourceMultiSelect } from '../components/campaigns/ResourceMultiSelect'
import { RecoveryBanner } from '../components/campaigns/RecoveryBanner'
import {
    buildCampaignCreatePayload,
    buildPoolConfirmMessage,
    getPoolSelectionSummary,
    type CampaignCreateFormState,
} from '../components/campaigns/buildCampaignCreatePayload'
import { CampaignSchedulerPanel } from '../components/scheduler'
import {
    CompliancePendingPanel,
    ReviewIntentReconcilePanel,
    useComplianceQueue,
    useReviewIntentQueue,
} from '../components/compliance'

interface Campaign {
    id: number
    name: string
    status: 'pending' | 'running' | 'paused' | 'done' | 'error'
    totalReviews: number
    successReviews: number
    failedReviews: number
    progress: number
    rating: number
    createdAt: Date
}

interface CampaignLocation {
    id: number
    name: string
}

interface CampaignAccountOption {
    id: number
    email: string
    status: string
}

interface CampaignProxyOption {
    id: number
    host: string
    port: number
    type: string
    status: string
    country?: string | null
}

interface CampaignStats {
    total: number
    running: number
    paused: number
    done: number
}

type StatusFilter = 'all' | 'pending' | 'running' | 'paused' | 'done' | 'error'

const EMPTY_CAMPAIGN_FORM: CampaignCreateFormState = {
    name: '',
    locationIds: [],
    accountIds: [],
    proxyIds: [],
    reviewTemplates: [''],
    rating: 5,
    delayMin: 30,
    delayMax: 60,
}

function isCampaignAccount(value: unknown): value is CampaignAccountOption {
    if (!value || typeof value !== 'object') return false
    const candidate = value as { id?: unknown; email?: unknown; status?: unknown }
    return (
        typeof candidate.id === 'number' &&
        typeof candidate.email === 'string' &&
        typeof candidate.status === 'string'
    )
}

function isCampaignProxy(value: unknown): value is CampaignProxyOption {
    if (!value || typeof value !== 'object') return false
    const candidate = value as {
        id?: unknown
        host?: unknown
        port?: unknown
        type?: unknown
        status?: unknown
    }
    return (
        typeof candidate.id === 'number' &&
        typeof candidate.host === 'string' &&
        typeof candidate.port === 'number' &&
        typeof candidate.type === 'string' &&
        typeof candidate.status === 'string'
    )
}

function deriveCampaignStats(campaigns: Campaign[]): CampaignStats {
    return campaigns.reduce<CampaignStats>((acc, campaign) => {
        acc.total += 1
        if (campaign.status === 'running') acc.running += 1
        if (campaign.status === 'paused') acc.paused += 1
        if (campaign.status === 'done') acc.done += 1
        return acc
    }, { total: 0, running: 0, paused: 0, done: 0 })
}

function isCampaignLocation(value: unknown): value is CampaignLocation {
    if (!value || typeof value !== 'object') return false
    const candidate = value as { id?: unknown; name?: unknown }
    return typeof candidate.id === 'number' && typeof candidate.name === 'string'
}

const statusToneMap: Record<string, 'emerald' | 'amber' | 'blue' | 'rose' | 'slate'> = {
    running: 'emerald',
    paused: 'amber',
    done: 'blue',
    error: 'rose',
    pending: 'slate',
}

const progressToneMap: Record<string, 'emerald' | 'amber' | 'blue' | 'rose' | 'slate'> = {
    running: 'emerald',
    paused: 'amber',
    done: 'blue',
    error: 'rose',
    pending: 'slate',
}

export function Campaigns() {
    const { t } = useI18n()
    const automationStatus = useAutomationStore((s) => s.status)
    const recoveryReport = useAutomationStore((s) => s.recoveryReport)
    const recoveryLoading = useAutomationStore((s) => s.recoveryLoading)
    const automationLoading = useAutomationStore((s) => s.loading)
    const startCampaign = useAutomationStore((s) => s.startCampaign)
    const stopCampaign = useAutomationStore((s) => s.stopCampaign)
    const pauseAutomation = useAutomationStore((s) => s.pause)
    const resumeCampaign = useAutomationStore((s) => s.resumeCampaign)
    const refreshAutomation = useAutomationStore((s) => s.refresh)
    const fetchRecoveryReport = useAutomationStore((s) => s.fetchRecoveryReport)
    const [campaigns, setCampaigns] = useState<Campaign[]>([])
    const [selectedIds, setSelectedIds] = useState<number[]>([])
    const [selectionMode, setSelectionMode] = useState(false)
    const [stats, setStats] = useState<CampaignStats>({ total: 0, running: 0, paused: 0, done: 0 })
    const [loading, setLoading] = useState(true)
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
    const [expandedId, setExpandedId] = useState<number | null>(null)
    const [newCampaign, setNewCampaign] = useState<CampaignCreateFormState>({ ...EMPTY_CAMPAIGN_FORM })
    const [locations, setLocations] = useState<CampaignLocation[]>([])
    const [accountOptions, setAccountOptions] = useState<CampaignAccountOption[]>([])
    const [proxyOptions, setProxyOptions] = useState<CampaignProxyOption[]>([])
    const [activeAccountCount, setActiveAccountCount] = useState(0)
    const [activeProxyCount, setActiveProxyCount] = useState(0)
    const [createStep, setCreateStep] = useState(1)
    const [creating, setCreating] = useState(false)
    const [resumingRecoveryId, setResumingRecoveryId] = useState<number | null>(null)
    const {
        pending: pendingSubmissions,
        actingId: complianceActingId,
        approve: approveCompliance,
        reject: rejectCompliance,
    } = useComplianceQueue()
    const {
        intents: pendingReviewIntents,
        loading: reviewIntentsLoading,
        refreshing: reviewIntentsRefreshing,
        error: reviewIntentsError,
        actingId: reviewIntentActingId,
        available: reviewIntentsAvailable,
        refresh: refreshReviewIntents,
        reconcile: reconcileReviewIntentAction,
    } = useReviewIntentQueue()

    const fetchCampaigns = useCallback(async () => {
        try {
            setLoading(true)
            const data = await window.electronAPI.campaigns.getAll()
            const campaignRows = Array.isArray(data) ? data as Campaign[] : []
            setCampaigns(campaignRows)
            setStats(deriveCampaignStats(campaignRows))
            setSelectedIds(prev => prev.filter(id => campaignRows.some(campaign => campaign.id === id)))
        } catch (error) {
            console.error('Failed to fetch campaigns:', error)
        } finally {
            setLoading(false)
        }
    }, [])

    const fetchResources = useCallback(async () => {
        try {
            const [locationData, accountCount, proxyCount, accountsData, proxiesData] = await Promise.all([
                window.electronAPI.locations.getPending(),
                window.electronAPI.accounts.getActiveCount(),
                window.electronAPI.proxies.getActiveCount(),
                window.electronAPI.accounts.getAll(),
                window.electronAPI.proxies.getAll(),
            ])
            setLocations(Array.isArray(locationData) ? locationData.filter(isCampaignLocation) : [])
            setActiveAccountCount(Number(accountCount) || 0)
            setActiveProxyCount(Number(proxyCount) || 0)

            const accounts = Array.isArray(accountsData)
                ? accountsData.filter(isCampaignAccount).filter((a) => a.status === 'active')
                : []
            const proxies = Array.isArray(proxiesData)
                ? proxiesData.filter(isCampaignProxy).filter((p) => p.status === 'active')
                : []
            setAccountOptions(accounts)
            setProxyOptions(proxies)
        } catch (error) {
            console.error('Failed to fetch campaign resources:', error)
        }
    }, [])

    useEffect(() => {
        setupAutomationListeners()
        void refreshAutomation()
        void fetchRecoveryReport()
        fetchCampaigns()
        fetchResources()
    }, [fetchCampaigns, fetchResources, refreshAutomation, fetchRecoveryReport])

    // Auto-refresh running campaigns + keep automation snapshot warm
    useEffect(() => {
        if (stats.running > 0 || automationStatus.running) {
            const interval = setInterval(() => {
                void fetchCampaigns()
                void refreshAutomation()
            }, 10000)
            return () => clearInterval(interval)
        }
    }, [stats.running, automationStatus.running, fetchCampaigns, refreshAutomation])

    const recoveryCampaignLabels = useMemo(
        () => campaigns.map((c) => ({ id: c.id, name: c.name })),
        [campaigns],
    )

    const filteredCampaigns = useMemo(() => campaigns.filter(c => {
        const matchSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase())
        const matchStatus = statusFilter === 'all' || c.status === statusFilter
        return matchSearch && matchStatus
    }), [campaigns, searchQuery, statusFilter])

    const campaignTotals = useMemo(() => {
        return campaigns.reduce((acc, campaign) => {
            acc.completed += (Number(campaign.successReviews) || 0) + (Number(campaign.failedReviews) || 0)
            acc.success += Number(campaign.successReviews) || 0
            return acc
        }, { completed: 0, success: 0 })
    }, [campaigns])
    const overallSuccessRate = campaignTotals.completed > 0
        ? Math.round((campaignTotals.success / campaignTotals.completed) * 100)
        : 0
    const selectedLocationIds = useMemo(() => new Set(newCampaign.locationIds), [newCampaign.locationIds])
    const poolSummary = useMemo(() => getPoolSelectionSummary(newCampaign), [newCampaign])
    const showLiveMonitor = automationStatus.running || automationStatus.paused || stats.running > 0

    const accountSelectOptions = useMemo(
        () =>
            accountOptions.map((acc) => ({
                id: acc.id,
                label: acc.email,
                badge: acc.status,
                badgeTone: 'emerald' as const,
            })),
        [accountOptions]
    )

    const proxySelectOptions = useMemo(
        () =>
            proxyOptions.map((proxy) => ({
                id: proxy.id,
                label: `${proxy.host}:${proxy.port}`,
                sublabel: [proxy.type, proxy.country].filter(Boolean).join(' · '),
                badge: proxy.status,
                badgeTone: 'emerald' as const,
            })),
        [proxyOptions]
    )

    const resetCreateForm = () => {
        setNewCampaign({ ...EMPTY_CAMPAIGN_FORM })
        setCreateStep(1)
    }

    const handleCreateCampaign = async () => {
        if (!newCampaign.name || newCampaign.locationIds.length === 0 || creating) return

        if (poolSummary.needsPoolConfirm) {
            const confirmText = buildPoolConfirmMessage({
                useAllAccounts: poolSummary.useAllAccounts,
                useAllProxies: poolSummary.useAllProxies,
                title: t(
                    'campaigns.confirmUseFullPool',
                    'Empty selection will use the entire available pool. Continue?'
                ),
                accountPoolLabel: t(
                    'campaigns.confirmUseAllAccounts',
                    'Accounts: use entire active account pool'
                ),
                proxyPoolLabel: t(
                    'campaigns.confirmUseAllProxies',
                    'Proxies: use entire active proxy pool (or none if pool empty)'
                ),
            })
            if (!confirm(confirmText)) return
        }

        const payload = buildCampaignCreatePayload(newCampaign)
        try {
            setCreating(true)
            await window.electronAPI.campaigns.create(payload)
            await fetchCampaigns()
            await fetchResources()
            resetCreateForm()
            setShowCreateModal(false)
        } catch (error) {
            alert(t('campaigns.createFailed'))
        } finally {
            setCreating(false)
        }
    }

    const handleStart = async (id: number) => {
        const result = await startCampaign(id)
        if (!result.success) {
            alert(`${t('campaigns.startFailed', 'Failed to start')}: ${result.error}`)
        }
        await fetchCampaigns()
        await refreshAutomation()
    }

    const handlePause = async (id: number) => {
        // campaigns.pause also pauses AutomationController
        await pauseAutomation()
        await window.electronAPI.campaigns.pause(id)
        await fetchCampaigns()
        await refreshAutomation()
    }

    const handleResume = async (id: number) => {
        const result = await resumeCampaign(id)
        if (!result.success) {
            alert(`${t('campaigns.startFailed', 'Failed to resume')}: ${result.error}`)
        }
        await fetchCampaigns()
        await refreshAutomation()
    }

    /** Recovery banner resume — always resumeCampaign (pending jobs only), never auto-start. */
    const handleRecoveryResume = async (id: number) => {
        setResumingRecoveryId(id)
        try {
            const result = await resumeCampaign(id)
            if (!result.success) {
                alert(
                    `${t('campaigns.recoveryResumeFailed', 'Failed to resume recovery')}: ${result.error ?? ''}`,
                )
            }
            await fetchCampaigns()
            await refreshAutomation()
            await fetchRecoveryReport()
        } finally {
            setResumingRecoveryId(null)
        }
    }

    const handleStop = async (id: number) => {
        await stopCampaign()
        await window.electronAPI.campaigns.stop(id)
        await fetchCampaigns()
        await refreshAutomation()
    }

    const handleDelete = async (id: number) => {
        if (!confirm(t('campaigns.deleteConfirm'))) return
        await window.electronAPI.campaigns.delete(id)
        await fetchCampaigns()
    }

    const handleDeleteSelected = async () => {
        if (selectedIds.length === 0) return
        const translated = t('campaigns.deleteSelectedConfirm')
        const confirmText = translated.includes('deleteSelectedConfirm')
            ? `Delete ${selectedIds.length} campaigns?`
            : translated.replace('{count}', String(selectedIds.length))
        if (!confirm(confirmText)) return
        for (const id of selectedIds) {
            try {
                await window.electronAPI.campaigns.delete(id)
            } catch (error) {
                console.error(`Failed to delete campaign ${id}:`, error)
            }
        }
        setSelectedIds([])
        setSelectionMode(false)
        await fetchCampaigns()
    }

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
    }

    const handleSelectAllFiltered = () => {
        setSelectedIds(filteredCampaigns.map(campaign => campaign.id))
    }

    const handleClearSelection = () => {
        setSelectedIds([])
    }

    const handleDuplicate = async (campaign: Campaign) => {
        setNewCampaign({
            ...EMPTY_CAMPAIGN_FORM,
            name: `${campaign.name} (Copy)`,
            rating: campaign.rating,
        })
        setCreateStep(1)
        void fetchResources()
        setShowCreateModal(true)
    }

    const openCreateModal = () => {
        setCreateStep(1)
        void fetchResources()
        setShowCreateModal(true)
    }

    const handleApproveSubmission = (requestId: string) => {
        void approveCompliance(requestId)
    }

    const handleRejectSubmission = (requestId: string) => {
        void rejectCompliance(requestId, 'rejected_in_campaign_ui')
    }

    const handleReconcileReviewIntent = (
        historyId: number,
        outcome: 'confirmed_success' | 'confirmed_not_posted',
        note?: string,
    ) => {
        void reconcileReviewIntentAction(historyId, outcome, note)
    }

    const getProgress = (completed: number, total: number) => {
        return total > 0 ? Math.round((completed / total) * 100) : 0
    }

    const getSuccessRate = (campaign: Campaign) => {
        const completed = (Number(campaign.successReviews) || 0) + (Number(campaign.failedReviews) || 0)
        return completed > 0
            ? Math.round(((Number(campaign.successReviews) || 0) / completed) * 100)
            : 0
    }

    // Resource readiness
    const resourceReady = activeAccountCount > 0 && locations.length > 0
    const hasProxies = activeProxyCount > 0

    return (
        <PageShell>
            <PageHeader
                icon={Rocket}
                tone="violet"
                title={t('campaigns.title')}
                subtitle={t('campaigns.subtitle')}
            >
                <IconButton
                    icon={RefreshCw}
                    label="Refresh"
                    onClick={() => {
                        fetchCampaigns()
                        fetchResources()
                        void refreshAutomation()
                        void fetchRecoveryReport()
                        void refreshReviewIntents()
                    }}
                    className={loading || reviewIntentsRefreshing ? 'animate-spin' : undefined}
                />
                <PrimaryButton
                    icon={Plus}
                    onClick={openCreateModal}
                    disabled={!resourceReady}
                    title={!resourceReady ? t('campaigns.needResourcesFirst') : ''}
                >
                    {t('campaigns.newCampaign')}
                </PrimaryButton>
            </PageHeader>

            {/* Resource Readiness Banner */}
            {!resourceReady && (
                <AlertBanner type="warning" title={t('campaigns.prepareResources')}>
                    <div className="flex gap-4 mt-1">
                        {activeAccountCount === 0 && (
                            <span className="text-sm flex items-center gap-1">
                                <X className="w-3.5 h-3.5 text-rose-500" /> {t('campaigns.noActiveAccounts')}
                            </span>
                        )}
                        {locations.length === 0 && (
                            <span className="text-sm flex items-center gap-1">
                                <X className="w-3.5 h-3.5 text-rose-500" /> {t('campaigns.noPendingLocationsShort')}
                            </span>
                        )}
                        {!hasProxies && (
                            <span className="text-sm flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5 text-amber-500" /> {t('campaigns.noProxyOptional')}
                            </span>
                        )}
                    </div>
                </AlertBanner>
            )}

            {/* Crash recovery — pending durable jobs; manual resume only (never auto-start) */}
            <RecoveryBanner
                report={recoveryReport}
                campaigns={recoveryCampaignLabels}
                loading={recoveryLoading || automationLoading}
                resumingId={resumingRecoveryId}
                disabled={automationStatus.running}
                onResume={handleRecoveryResume}
                onRefresh={async () => {
                    await fetchRecoveryReport()
                    await fetchCampaigns()
                }}
            />

            {/* Live Automation Status — stream from AutomationController via store */}
            {showLiveMonitor && (
                <AutomationMonitor embedded showControls />
            )}

            {/* Pending Review Submissions (pre-submit compliance operator panel) */}
            <CompliancePendingPanel
                pending={pendingSubmissions}
                actingId={complianceActingId}
                onApprove={handleApproveSubmission}
                onReject={handleRejectSubmission}
            />

            {/* Durable submitting/unconfirmed intents — manual reconcile (distinct from pre-submit) */}
            <ReviewIntentReconcilePanel
                intents={pendingReviewIntents}
                loading={reviewIntentsLoading}
                refreshing={reviewIntentsRefreshing}
                error={reviewIntentsError}
                actingId={reviewIntentActingId}
                available={reviewIntentsAvailable}
                onReconcile={handleReconcileReviewIntent}
                onRefresh={refreshReviewIntents}
            />

            {/* Stats Grid */}
            <StatRow>
                <StatCard icon={Target} tone="slate" value={stats.total} label={t('campaigns.totalCampaigns')} subtext={t('common.total')} />
                <StatCard icon={Activity} tone="emerald" value={stats.running} label={t('common.running')} />
                <StatCard icon={Pause} tone="amber" value={stats.paused} label={t('campaigns.paused')} />
                <StatCard icon={CheckCircle} tone="violet" value={stats.done} label={t('common.completed')} />
                <StatCard icon={TrendingUp} tone="emerald" value={`${overallSuccessRate}%`} label={t('campaigns.successRate')} />
            </StatRow>

            {/* Resource Summary */}
            <Panel tone="slate" className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-6">
                    <span className="text-xs text-[#908a9e] uppercase tracking-wider font-bold">{t('campaigns.resourcesReady')}:</span>
                    <div className="flex items-center gap-1.5 text-sm">
                        <Users className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-[#17171f] font-medium">{activeAccountCount}</span>
                        <span className="text-[#908a9e]">{t('campaigns.accountsLabel')}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm">
                        <MapPin className="w-3.5 h-3.5 text-amber-500" />
                        <span className="text-[#17171f] font-medium">{locations.length}</span>
                        <span className="text-[#908a9e]">{t('campaigns.locationsLabel')}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm">
                        <Globe className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-[#17171f] font-medium">{activeProxyCount}</span>
                        <span className="text-[#908a9e]">proxy</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm">
                        <BarChart3 className="w-3.5 h-3.5 text-[#8d74e8]" />
                        <span className="text-[#17171f] font-medium">{campaignTotals.completed}</span>
                        <span className="text-[#908a9e]">{t('campaigns.reviewsSent')}</span>
                    </div>
                </div>
            </Panel>

            {/* Search & Filter */}
            <Toolbar
                search={searchQuery}
                onSearchChange={setSearchQuery}
                searchPlaceholder={t('campaigns.searchPlaceholder')}
            >
                <SegmentedTabs<StatusFilter>
                    value={statusFilter}
                    onChange={setStatusFilter}
                    items={[
                        { id: 'all', label: `${t('common.all')} (${campaigns.length})` },
                        { id: 'running', label: t('campaigns.running') },
                        { id: 'pending', label: t('campaigns.pending') },
                        { id: 'paused', label: t('campaigns.paused') },
                        { id: 'done', label: t('campaigns.done') },
                        { id: 'error', label: t('campaigns.error') },
                    ]}
                />
            </Toolbar>

            {/* Selection Toolbar */}
            <div className="flex items-center justify-end gap-2">
                <PrimaryButton
                    variant="quiet"
                    icon={CheckCircle}
                    onClick={() => {
                        if (selectionMode) {
                            setSelectionMode(false)
                            setSelectedIds([])
                            return
                        }
                        setSelectionMode(true)
                    }}
                    className={selectionMode ? '!border-[#8d74e8] !bg-[#f4f0ff] !text-[#735bd6]' : ''}
                >
                    {selectionMode ? t('common.cancel') : t('common.selected')}
                </PrimaryButton>
                {selectionMode && (
                    <>
                        <PrimaryButton variant="quiet" onClick={handleSelectAllFiltered}>
                            {t('common.selectAll')}
                        </PrimaryButton>
                        <PrimaryButton variant="quiet" onClick={handleClearSelection}>
                            {t('common.deselectAll')}
                        </PrimaryButton>
                    </>
                )}
                {selectedIds.length > 0 && (
                    <PrimaryButton icon={Trash2} tone="rose" onClick={handleDeleteSelected}>
                        {t('common.delete')} ({selectedIds.length})
                    </PrimaryButton>
                )}
            </div>

            {/* Campaigns List */}
            {!showCreateModal && (
                <div className="space-y-3">
                    {loading && campaigns.length === 0 ? (
                        <EmptyState
                            icon={RefreshCw}
                            title={t('campaigns.loadingCampaigns')}
                        />
                    ) : filteredCampaigns.length === 0 ? (
                        campaigns.length === 0 ? (
                            <EmptyState
                                icon={Rocket}
                                title={t('campaigns.noCampaignsFound')}
                                subtitle={t('campaigns.createFirstDescription')}
                                action={
                                    <PrimaryButton
                                        icon={Plus}
                                        onClick={openCreateModal}
                                        disabled={!resourceReady}
                                    >
                                        {t('campaigns.newCampaign')}
                                    </PrimaryButton>
                                }
                            />
                        ) : (
                            <EmptyState
                                icon={Target}
                                title={t('campaigns.noMatchingCampaigns')}
                            />
                        )
                    ) : (
                        filteredCampaigns.map((campaign) => {
                            const completed = (Number(campaign.successReviews) || 0) + (Number(campaign.failedReviews) || 0)
                            const progress = getProgress(completed, Number(campaign.totalReviews) || 0)
                            const successRate = getSuccessRate(campaign)
                            const isExpanded = expandedId === campaign.id
                            const statusTone = statusToneMap[campaign.status] || 'slate'

                            return (
                                <Panel
                                    key={campaign.id}
                                    tone="slate"
                                    className={`p-0 overflow-hidden transition-all ${selectedIds.includes(campaign.id) ? '!border-[#8d74e8] !bg-[#f8f6ff]' : campaign.status === 'running' ? '!border-emerald-200' : campaign.status === 'error' ? '!border-rose-200' : ''}`}
                                >
                                    {/* Main Row */}
                                    <div className="p-5">
                                        <div className="flex items-center justify-between mb-4">
                                            <div className="flex items-center gap-3">
                                                {selectionMode && (
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.includes(campaign.id)}
                                                        onChange={() => toggleSelection(campaign.id)}
                                                        className="h-4 w-4 rounded accent-[#8d74e8]"
                                                    />
                                                )}
                                                <div>
                                                    <h3 className="font-semibold text-[#17171f] text-lg">{campaign.name}</h3>
                                                    <div className="flex items-center gap-3 text-sm text-[#908a9e] mt-0.5">
                                                        <span className="flex items-center gap-1">
                                                            <Star className="w-3.5 h-3.5 text-amber-400" />
                                                            {campaign.rating} {t('campaigns.stars')}
                                                        </span>
                                                        <span className="flex items-center gap-1">
                                                            <Clock className="w-3.5 h-3.5" />
                                                            {new Date(campaign.createdAt).toLocaleDateString('vi-VN')}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                            <StatusPill tone={statusTone}>
                                                {t(`campaigns.${campaign.status}`)}
                                            </StatusPill>
                                        </div>

                                        {/* Progress Bar */}
                                        <div className="mb-4">
                                            <div className="flex justify-between text-sm mb-1.5">
                                                <span className="text-[#908a9e] flex items-center gap-1.5">
                                                    <BarChart3 className="w-3.5 h-3.5" />
                                                    {t('campaigns.progress')}
                                                </span>
                                                <span className="text-[#17171f] font-medium">
                                                    {completed} / {Number(campaign.totalReviews) || 0}
                                                    <span className="text-[#908a9e] ml-1">({progress}%)</span>
                                                </span>
                                            </div>
                                            <ProgressBar value={progress} tone={progressToneMap[campaign.status] || 'violet'} />
                                        </div>

                                        {/* Stats Row */}
                                        <div className="grid grid-cols-3 gap-3 mb-4">
                                            <div className="bg-[#f7f7f9] rounded-[14px] border border-[#e9e4f2] p-2.5 text-center">
                                                <div className="text-lg font-bold text-[#17171f]">{completed}</div>
                                                <div className="text-xs text-[#908a9e]">{t('campaigns.sent')}</div>
                                            </div>
                                            <div className="bg-[#f7f7f9] rounded-[14px] border border-[#e9e4f2] p-2.5 text-center">
                                                <div className={`text-lg font-bold ${successRate >= 80 ? 'text-emerald-600' : successRate >= 50 ? 'text-amber-600' : 'text-rose-600'}`}>
                                                    {successRate}%
                                                </div>
                                                <div className="text-xs text-[#908a9e]">{t('campaigns.successful')}</div>
                                            </div>
                                            <div className="bg-[#f7f7f9] rounded-[14px] border border-[#e9e4f2] p-2.5 text-center">
                                                <div className="text-lg font-bold text-[#5f5a6d]">{Math.max(0, (Number(campaign.totalReviews) || 0) - completed)}</div>
                                                <div className="text-xs text-[#908a9e]">{t('campaigns.remaining')}</div>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex items-center justify-between pt-3 border-t border-[#e9e4f2]">
                                            <PrimaryButton
                                                variant="quiet"
                                                icon={isExpanded ? ChevronUp : ChevronDown}
                                                onClick={() => setExpandedId(isExpanded ? null : campaign.id)}
                                                className="!px-3 !py-1.5 !text-xs"
                                            >
                                                {isExpanded ? t('campaigns.collapse') : t('campaigns.details')}
                                            </PrimaryButton>
                                            <div className="flex items-center gap-2">
                                                <IconButton icon={Copy} label="Duplicate" onClick={() => handleDuplicate(campaign)} />
                                                {campaign.status === 'pending' && (
                                                    <PrimaryButton icon={Play} tone="emerald" onClick={() => handleStart(campaign.id)} className="!px-3 !py-1.5 !text-xs">
                                                        {t('common.start')}
                                                    </PrimaryButton>
                                                )}
                                                {campaign.status === 'running' && (
                                                    <>
                                                        <PrimaryButton icon={Pause} tone="amber" onClick={() => handlePause(campaign.id)} className="!px-3 !py-1.5 !text-xs">
                                                            {t('common.pause')}
                                                        </PrimaryButton>
                                                        <PrimaryButton icon={Square} tone="rose" onClick={() => handleStop(campaign.id)} className="!px-3 !py-1.5 !text-xs">
                                                            {t('common.stop')}
                                                        </PrimaryButton>
                                                    </>
                                                )}
                                                {campaign.status === 'paused' && (
                                                    <PrimaryButton
                                                        icon={Play}
                                                        tone="emerald"
                                                        onClick={() => {
                                                            // Prefer engine resume when this campaign is the live one
                                                            if (
                                                                automationStatus.running &&
                                                                automationStatus.currentCampaignId === campaign.id
                                                            ) {
                                                                void handleResume(campaign.id)
                                                            } else {
                                                                void handleStart(campaign.id)
                                                            }
                                                        }}
                                                        className="!px-3 !py-1.5 !text-xs"
                                                    >
                                                        {t('common.resume')}
                                                    </PrimaryButton>
                                                )}
                                                <IconButton
                                                    icon={Trash2}
                                                    label={t('common.delete')}
                                                    onClick={() => handleDelete(campaign.id)}
                                                    disabled={selectionMode}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Expanded Details */}
                                    {isExpanded && (
                                        <div className="px-5 pb-5 pt-0 border-t border-[#e9e4f2]">
                                            <div className="pt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                                                <div>
                                                    <h4 className="text-xs text-[#908a9e] uppercase tracking-wider font-bold mb-2">{t('campaigns.detailInfo')}</h4>
                                                    <div className="space-y-2 text-sm">
                                                        <div className="flex justify-between">
                                                            <span className="text-[#908a9e]">{t('campaigns.successfulReviews')}</span>
                                                            <span className="text-emerald-600 font-medium">{Number(campaign.successReviews) || 0}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-[#908a9e]">{t('campaigns.failedReviews')}</span>
                                                            <span className="text-rose-600 font-medium">{Number(campaign.failedReviews) || 0}</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-[#908a9e]">{t('campaigns.ratingLabel')}</span>
                                                            <Badge tone="amber">{campaign.rating} sao</Badge>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div>
                                                    <h4 className="text-xs text-[#908a9e] uppercase tracking-wider font-bold mb-2">{t('campaigns.progressSection')}</h4>
                                                    <div className="space-y-2 text-sm">
                                                        <div className="flex justify-between">
                                                            <span className="text-[#908a9e]">{t('campaigns.statusLabel')}</span>
                                                            <StatusPill tone={statusTone}>{t(`campaigns.${campaign.status}`)}</StatusPill>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-[#908a9e]">{t('campaigns.progressLabel')}</span>
                                                            <span className="text-[#17171f] font-medium">{progress}%</span>
                                                        </div>
                                                        <div className="flex justify-between">
                                                            <span className="text-[#908a9e]">{t('campaigns.createdDateLabel')}</span>
                                                            <span className="text-[#5f5a6d]">{new Date(campaign.createdAt).toLocaleString('vi-VN')}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            <CampaignSchedulerPanel
                                                campaignId={campaign.id}
                                                campaignName={campaign.name}
                                            />
                                        </div>
                                    )}
                                </Panel>
                            )
                        })
                    )}
                </div>
            )}

            {/* Create Campaign Modal - Step Wizard */}
            <Modal
                open={showCreateModal}
                onClose={() => {
                    setShowCreateModal(false)
                    resetCreateForm()
                }}
                title={t('campaigns.createCampaign')}
                description={`${t('campaigns.stepLabel')} ${createStep} / 3`}
                size="lg"
            >
                {/* Step Indicator */}
                <div className="flex items-center gap-2 mb-6">
                    {[1, 2, 3].map(step => (
                        <div key={step} className="flex-1 flex items-center gap-2">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${createStep >= step
                                ? 'bg-[#8d74e8] text-white shadow-[0_12px_22px_rgba(141,116,232,0.24)]'
                                : 'bg-[#f4f1fa] text-[#908a9e]'
                                }`}>
                                {createStep > step ? <CheckCircle className="w-4 h-4" /> : step}
                            </div>
                            <span className={`text-xs hidden sm:block font-medium ${createStep >= step ? 'text-[#17171f]' : 'text-[#908a9e]'}`}>
                                {step === 1 ? t('campaigns.stepBasic') : step === 2 ? t('campaigns.stepLocations') : t('campaigns.stepSettings')}
                            </span>
                            {step < 3 && <div className={`flex-1 h-0.5 rounded ${createStep > step ? 'bg-[#8d74e8]' : 'bg-[#e9e4f2]'}`} />}
                        </div>
                    ))}
                </div>

                {/* Step 1: Basic Info */}
                {createStep === 1 && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('campaigns.campaignName')}</label>
                            <TextInput
                                value={newCampaign.name}
                                onChange={(val) => setNewCampaign({ ...newCampaign, name: val })}
                                placeholder={t('campaigns.campaignNamePlaceholder')}
                                icon={Rocket}
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('campaigns.rating')}</label>
                            <div className="flex gap-2">
                                {[5, 4, 3, 2, 1].map(r => (
                                    <button
                                        key={r}
                                        onClick={() => setNewCampaign({ ...newCampaign, rating: r })}
                                        className={`flex-1 py-2.5 rounded-full text-sm font-semibold transition-all ${newCampaign.rating === r
                                            ? 'bg-amber-50 text-amber-700 border-2 border-amber-300'
                                            : 'bg-[#f7f7f9] text-[#5f5a6d] border border-[#e9e4f2] hover:border-[#cbbff3]'
                                            }`}
                                    >
                                        {r} sao
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('campaigns.reviewTemplates')}</label>
                            <textarea
                                value={newCampaign.reviewTemplates.join('\n')}
                                onChange={(e) => setNewCampaign({ ...newCampaign, reviewTemplates: e.target.value.split('\n') })}
                                className="w-full h-28 px-4 py-3 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                placeholder={t('campaigns.reviewTemplatesPlaceholder')}
                            />
                            <p className="text-xs text-[#908a9e] mt-1">{t('campaigns.templateHint')}</p>
                        </div>
                        <PrimaryButton
                            className="w-full"
                            onClick={() => setCreateStep(2)}
                            disabled={!newCampaign.name}
                        >
                            {t('common.next')}
                        </PrimaryButton>
                    </div>
                )}

                {/* Step 2: Select Locations */}
                {createStep === 2 && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                {t('campaigns.selectLocations')}
                                <span className="ml-2 text-[#8d74e8] font-normal">({newCampaign.locationIds.length} {t('common.selected')} / {locations.length} {t('campaigns.available')})</span>
                            </label>
                            {locations.length > 5 && (
                                <PrimaryButton
                                    variant="quiet"
                                    className="!px-3 !py-1 !text-xs mb-2"
                                    onClick={() => {
                                        setNewCampaign(prev => ({
                                            ...prev,
                                            locationIds: prev.locationIds.length === locations.length
                                                ? []
                                                : locations.map(location => location.id),
                                        }))
                                    }}
                                >
                                    {newCampaign.locationIds.length === locations.length ? t('common.deselectAll') : t('common.selectAll')}
                                </PrimaryButton>
                            )}
                            <div className="max-h-56 overflow-y-auto bg-[#f7f7f9] rounded-[16px] p-2 space-y-1 border border-[#e9e4f2]">
                                {locations.length === 0 ? (
                                    <div className="p-4 text-center">
                                        <MapPin className="w-8 h-8 mx-auto mb-2 text-[#cbbff3]" />
                                        <p className="text-[#908a9e] text-sm">{t('campaigns.noPendingLocations')}</p>
                                    </div>
                                ) : (
                                    locations.map((loc) => (
                                        <label key={loc.id} className={`flex items-center gap-3 p-2.5 rounded-[12px] cursor-pointer transition-colors ${selectedLocationIds.has(loc.id) ? 'bg-[#f4f0ff] border border-[#e6e0fb]' : 'hover:bg-white border border-transparent'
                                            }`}>
                                            <input
                                                type="checkbox"
                                                checked={selectedLocationIds.has(loc.id)}
                                                onChange={(e) => {
                                                    setNewCampaign(prev => ({
                                                        ...prev,
                                                        locationIds: e.target.checked
                                                            ? [...prev.locationIds, loc.id]
                                                            : prev.locationIds.filter(id => id !== loc.id),
                                                    }))
                                                }}
                                                className="h-4 w-4 rounded accent-[#8d74e8]"
                                            />
                                            <MapPin className="w-4 h-4 text-amber-500 shrink-0" />
                                            <span className="text-[#17171f] text-sm">{loc.name}</span>
                                        </label>
                                    ))
                                )}
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <PrimaryButton variant="quiet" className="flex-1" onClick={() => setCreateStep(1)}>
                                {t('common.back')}
                            </PrimaryButton>
                            <PrimaryButton className="flex-1" onClick={() => setCreateStep(3)} disabled={newCampaign.locationIds.length === 0}>
                                {t('common.next')}
                            </PrimaryButton>
                        </div>
                    </div>
                )}

                {/* Step 3: Resources, Settings & Confirm */}
                {createStep === 3 && (
                    <div className="space-y-4">
                        <ResourceMultiSelect
                            title={t('campaigns.selectAccounts', 'Select Accounts')}
                            countLabel={`(${newCampaign.accountIds.length} ${t('common.selected')} / ${accountOptions.length} ${t('campaigns.available')})`}
                            options={accountSelectOptions}
                            selectedIds={newCampaign.accountIds}
                            onChange={(ids) => setNewCampaign((prev) => ({ ...prev, accountIds: ids }))}
                            emptyPoolHint={t(
                                'campaigns.emptyAccountsUsePool',
                                'No accounts selected — campaign will use the entire active account pool.'
                            )}
                            noOptionsLabel={t('campaigns.noActiveAccounts', 'No active accounts')}
                            selectAllLabel={t('common.selectAll')}
                            clearLabel={t('common.deselectAll')}
                            icon={Users}
                        />

                        <ResourceMultiSelect
                            title={t('campaigns.selectProxies', 'Select Proxies')}
                            countLabel={`(${newCampaign.proxyIds.length} ${t('common.selected')} / ${proxyOptions.length} ${t('campaigns.available')})`}
                            options={proxySelectOptions}
                            selectedIds={newCampaign.proxyIds}
                            onChange={(ids) => setNewCampaign((prev) => ({ ...prev, proxyIds: ids }))}
                            emptyPoolHint={t(
                                'campaigns.emptyProxiesUsePool',
                                'No proxies selected — campaign will use the entire active proxy pool (or no proxy if pool empty).'
                            )}
                            noOptionsLabel={t('campaigns.noProxyOptional', 'No proxy (optional)')}
                            selectAllLabel={t('common.selectAll')}
                            clearLabel={t('common.deselectAll')}
                            icon={Globe}
                        />

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                    <Timer className="w-3.5 h-3.5 inline mr-1" />
                                    {t('campaigns.minDelay')}
                                </label>
                                <TextInput
                                    value={String(newCampaign.delayMin)}
                                    onChange={(val) => setNewCampaign({ ...newCampaign, delayMin: parseInt(val) || 30 })}
                                    type="number"
                                    icon={Timer}
                                    min={10}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                                    <Timer className="w-3.5 h-3.5 inline mr-1" />
                                    {t('campaigns.maxDelay')}
                                </label>
                                <TextInput
                                    value={String(newCampaign.delayMax)}
                                    onChange={(val) => setNewCampaign({ ...newCampaign, delayMax: parseInt(val) || 60 })}
                                    type="number"
                                    icon={Timer}
                                    min={10}
                                />
                            </div>
                        </div>

                        {/* Summary */}
                        <SectionPanel icon={Eye} title={t('campaigns.campaignSummary')} tone="violet">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                                <div>
                                    <span className="text-[#908a9e]">{t('common.name')}:</span>
                                    <span className="text-[#17171f] ml-2 font-medium">{newCampaign.name}</span>
                                </div>
                                <div>
                                    <span className="text-[#908a9e]">{t('campaigns.ratingLabel')}:</span>
                                    <span className="text-amber-600 ml-2 font-medium">{newCampaign.rating} sao</span>
                                </div>
                                <div>
                                    <span className="text-[#908a9e]">{t('campaigns.locationsLabel')}:</span>
                                    <span className="text-[#8d74e8] ml-2 font-medium">{newCampaign.locationIds.length}</span>
                                </div>
                                <div>
                                    <span className="text-[#908a9e]">{t('campaigns.templatesLabel', 'Templates')}:</span>
                                    <span className="text-[#8d74e8] ml-2 font-medium">{newCampaign.reviewTemplates.filter(tmpl => tmpl.trim()).length}</span>
                                </div>
                                <div>
                                    <span className="text-[#908a9e]">{t('campaigns.delayLabel', 'Delay')}:</span>
                                    <span className="text-[#5f5a6d] ml-2">{newCampaign.delayMin}s - {newCampaign.delayMax}s</span>
                                </div>
                                <div>
                                    <span className="text-[#908a9e]">{t('campaigns.accountsLabel')}:</span>
                                    <span className="text-emerald-600 ml-2 font-medium">
                                        {poolSummary.useAllAccounts
                                            ? t('campaigns.poolAllAccounts', `All active (${accountOptions.length || activeAccountCount})`)
                                            : `${newCampaign.accountIds.length} ${t('common.selected')}`}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-[#908a9e]">{t('campaigns.proxiesLabel', 'proxies')}:</span>
                                    <span className="text-emerald-600 ml-2 font-medium">
                                        {poolSummary.useAllProxies
                                            ? t('campaigns.poolAllProxies', `All active (${proxyOptions.length || activeProxyCount})`)
                                            : `${newCampaign.proxyIds.length} ${t('common.selected')}`}
                                    </span>
                                </div>
                            </div>
                            {poolSummary.needsPoolConfirm && (
                                <p className="text-xs text-amber-700 mt-3">
                                    {t(
                                        'campaigns.poolConfirmHint',
                                        'Creating with empty account/proxy selection will ask you to confirm using the full pool.'
                                    )}
                                </p>
                            )}
                        </SectionPanel>

                        <div className="flex gap-3">
                            <PrimaryButton variant="quiet" className="flex-1" onClick={() => setCreateStep(2)}>
                                {t('common.back')}
                            </PrimaryButton>
                            <PrimaryButton
                                className="flex-1"
                                icon={Rocket}
                                onClick={() => void handleCreateCampaign()}
                                disabled={!newCampaign.name || newCampaign.locationIds.length === 0 || creating}
                            >
                                {creating
                                    ? t('campaigns.creating', 'Creating...')
                                    : t('campaigns.createCampaign')}
                            </PrimaryButton>
                        </div>
                    </div>
                )}
            </Modal>
        </PageShell>
    )
}
