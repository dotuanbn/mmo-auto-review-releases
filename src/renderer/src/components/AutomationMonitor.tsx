import { useEffect } from 'react'
import {
    Play,
    Pause,
    Square,
    Activity,
    Users,
    Clock,
    CheckCircle,
    XCircle,
    RefreshCw,
    Zap,
} from 'lucide-react'
import { useI18n } from '../i18n'
import {
    useAutomationStore,
    setupAutomationListeners,
    type AutomationThreadState,
} from '../stores/automationStore'

export interface AutomationMonitorProps {
    /** Compact panel style for embedding inside Campaigns page. */
    embedded?: boolean
    /** When false, hide pause/resume/stop controls. Default true. */
    showControls?: boolean
    /** Optional campaign id filter — still shows if controller campaign matches or unknown. */
    campaignId?: number
    className?: string
}

function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function threadJobLabel(thread: AutomationThreadState): string {
    if (thread.lastError) return thread.lastError
    if (thread.currentJobId) return thread.currentJobId
    if (thread.accountEmail) return thread.accountEmail
    if (thread.accountId != null) return `#${thread.accountId}`
    return '—'
}

export function AutomationMonitor({
    embedded = false,
    showControls = true,
    campaignId,
    className = '',
}: AutomationMonitorProps) {
    const { t } = useI18n()
    const status = useAutomationStore((s) => s.status)
    const queueStats = useAutomationStore((s) => s.queueStats)
    const loading = useAutomationStore((s) => s.loading)
    const error = useAutomationStore((s) => s.error)
    const refresh = useAutomationStore((s) => s.refresh)
    const pause = useAutomationStore((s) => s.pause)
    const resume = useAutomationStore((s) => s.resume)
    const stopCampaign = useAutomationStore((s) => s.stopCampaign)
    const clearCompleted = useAutomationStore((s) => s.clearCompleted)
    const ensureListeners = useAutomationStore((s) => s.ensureListeners)

    useEffect(() => {
        setupAutomationListeners()
        ensureListeners()
        void refresh()
        const interval = setInterval(() => {
            void refresh()
        }, 2000)
        return () => clearInterval(interval)
    }, [ensureListeners, refresh])

    const handlePauseResume = async () => {
        if (status.paused) {
            await resume()
        } else {
            await pause()
        }
    }

    const handleStop = async () => {
        await stopCampaign()
    }

    const handleClearCompleted = async () => {
        await clearCompleted()
    }

    const isRelevant =
        !campaignId ||
        !status.currentCampaignId ||
        status.currentCampaignId === campaignId

    const shellClass = embedded
        ? `rounded-[18px] border border-emerald-200 bg-gradient-to-br from-emerald-50 to-cyan-50 p-5 ${className}`
        : `rounded-xl border border-blue-500/30 bg-gradient-to-br from-blue-900/30 to-cyan-900/20 p-6 ${className}`

    const muted = embedded ? 'text-[#908a9e]' : 'text-slate-400'
    const strong = embedded ? 'text-[#17171f]' : 'text-white'
    const cardBg = embedded
        ? 'bg-white/80 border border-[#e9e4f2]'
        : 'bg-slate-800/60'

    if (loading && !status.running && !queueStats) {
        return (
            <div className={shellClass}>
                <div className={`flex items-center justify-center gap-2 ${muted}`}>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    {t('campaigns.monitorLoading', 'Loading automation status...')}
                </div>
            </div>
        )
    }

    if (!status.running && !queueStats) {
        return (
            <div className={shellClass}>
                <div className={`flex items-center justify-center gap-2 ${muted}`}>
                    <Activity className="w-5 h-5" />
                    {t('campaigns.monitorIdle', 'No automation running. Start a campaign to see progress.')}
                </div>
            </div>
        )
    }

    if (!isRelevant && status.running) {
        return null
    }

    const progressPercent =
        status.percent > 0
            ? status.percent
            : queueStats
                ? Math.round((queueStats.done / Math.max(queueStats.total, 1)) * 100)
                : 0

    const totalJobs = queueStats?.total ?? status.progress.total
    const completedJobs = queueStats?.done ?? status.progress.completed
    const failedJobs = queueStats?.failed ?? status.progress.failed
    const pendingJobs = queueStats?.pending ?? status.progress.remaining
    const activeThreads = status.threads.filter((th) => th.status === 'running').length
    const errorThreads = status.threads.filter((th) => th.status === 'error')

    return (
        <div className={shellClass}>
            {/* Header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
                <h2 className={`text-lg font-semibold flex items-center gap-2 flex-wrap ${strong}`}>
                    <Activity className={`w-5 h-5 ${embedded ? 'text-emerald-600' : 'text-blue-400'}`} />
                    {t('campaigns.monitorTitle', 'Automation Progress Monitor')}
                    {status.running && (
                        <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                status.paused
                                    ? embedded
                                        ? 'bg-amber-100 text-amber-700'
                                        : 'bg-yellow-500/20 text-yellow-400'
                                    : embedded
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : 'bg-green-500/20 text-green-400'
                            }`}
                        >
                            <span
                                className={`w-2 h-2 rounded-full ${
                                    status.paused
                                        ? 'bg-amber-500'
                                        : 'bg-emerald-500 animate-pulse'
                                }`}
                            />
                            {status.paused
                                ? t('campaigns.paused', 'Paused')
                                : t('campaigns.running', 'Running')}
                        </span>
                    )}
                    {status.currentCampaignId != null && (
                        <span className={`text-xs font-normal ${muted}`}>
                            #{status.currentCampaignId}
                        </span>
                    )}
                </h2>

                {showControls && status.running && (
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            type="button"
                            onClick={() => void handlePauseResume()}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                status.paused
                                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                    : 'bg-amber-500 hover:bg-amber-400 text-white'
                            }`}
                        >
                            {status.paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                            {status.paused
                                ? t('common.resume', 'Resume')
                                : t('common.pause', 'Pause')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleStop()}
                            className="flex items-center gap-1 px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                            <Square className="w-3 h-3" />
                            {t('common.stop', 'Stop')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm transition-colors ${
                                embedded
                                    ? 'bg-white border border-[#e9e4f2] text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                    : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                            }`}
                            title={t('common.refresh', 'Refresh')}
                        >
                            <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}
            </div>

            {/* Live message / context */}
            {(status.message || status.currentAccount || status.currentLocation) && (
                <div className={`mb-4 text-sm ${muted}`}>
                    <span className={strong}>{status.message}</span>
                    {status.currentAccount && (
                        <span className="ml-2">
                            · {t('campaigns.monitorAccount', 'Account')}: {status.currentAccount}
                        </span>
                    )}
                    {status.currentLocation && (
                        <span className="ml-2">
                            · {t('campaigns.monitorLocation', 'Location')}: {status.currentLocation}
                        </span>
                    )}
                </div>
            )}

            {/* Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                <div className={`${cardBg} rounded-lg p-3 text-center`}>
                    <div className={`text-2xl font-bold ${strong}`}>{totalJobs}</div>
                    <div className={`text-xs mt-1 ${muted}`}>
                        {t('campaigns.monitorTotalJobs', 'Total Jobs')}
                    </div>
                </div>
                <div className={`${cardBg} rounded-lg p-3 text-center`}>
                    <div className="text-2xl font-bold text-emerald-600">{completedJobs}</div>
                    <div className={`text-xs mt-1 flex items-center justify-center gap-1 ${muted}`}>
                        <CheckCircle className="w-3 h-3" />
                        {t('campaigns.monitorCompleted', 'Completed')}
                    </div>
                </div>
                <div className={`${cardBg} rounded-lg p-3 text-center`}>
                    <div className="text-2xl font-bold text-rose-600">{failedJobs}</div>
                    <div className={`text-xs mt-1 flex items-center justify-center gap-1 ${muted}`}>
                        <XCircle className="w-3 h-3" />
                        {t('campaigns.monitorFailed', 'Failed')}
                    </div>
                </div>
                <div className={`${cardBg} rounded-lg p-3 text-center`}>
                    <div className="text-2xl font-bold text-blue-600">{pendingJobs}</div>
                    <div className={`text-xs mt-1 flex items-center justify-center gap-1 ${muted}`}>
                        <Clock className="w-3 h-3" />
                        {t('campaigns.monitorPending', 'Pending')}
                    </div>
                </div>
            </div>

            {/* Progress Bar */}
            <div className="mb-5">
                <div className="flex justify-between items-center mb-2">
                    <span className={`text-sm ${muted}`}>
                        {t('campaigns.monitorOverallProgress', 'Overall Progress')}
                    </span>
                    <span className={`text-sm font-medium ${strong}`}>{progressPercent}%</span>
                </div>
                <div
                    className={`h-3 rounded-full overflow-hidden ${
                        embedded ? 'bg-[#e9e4f2]' : 'bg-slate-700'
                    }`}
                >
                    <div
                        className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-500"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
                {status.startTime && (
                    <div className={`flex items-center justify-between mt-2 text-xs ${muted}`}>
                        <span>
                            {t('campaigns.monitorStarted', 'Started')}:{' '}
                            {new Date(status.startTime).toLocaleTimeString()}
                        </span>
                        <span>
                            {t('campaigns.monitorElapsed', 'Elapsed')}: {formatTime(status.elapsedTime)}
                        </span>
                    </div>
                )}
            </div>

            {/* Thread Status */}
            {status.threads.length > 0 && (
                <div className="mb-5">
                    <h3 className={`text-sm font-medium mb-3 flex items-center gap-2 ${strong}`}>
                        <Users className="w-4 h-4" />
                        {t('campaigns.monitorThreads', 'Active Threads')} ({activeThreads}/
                        {status.threads.length})
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {status.threads.map((thread) => (
                            <div
                                key={thread.id}
                                className={`p-3 rounded-lg text-xs border ${
                                    thread.status === 'running'
                                        ? embedded
                                            ? 'bg-emerald-50 border-emerald-200'
                                            : 'bg-green-500/20 border-green-500/30'
                                        : thread.status === 'error'
                                            ? embedded
                                                ? 'bg-rose-50 border-rose-200'
                                                : 'bg-red-500/20 border-red-500/30'
                                            : embedded
                                                ? 'bg-white border-[#e9e4f2]'
                                                : 'bg-slate-700/50 border-slate-600/50'
                                }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className={`font-medium ${strong}`}>
                                        {t('campaigns.monitorThread', 'Thread')} {thread.id}
                                    </span>
                                    <span
                                        className={`w-2 h-2 rounded-full ${
                                            thread.status === 'running'
                                                ? 'bg-emerald-500 animate-pulse'
                                                : thread.status === 'error'
                                                    ? 'bg-rose-500'
                                                    : 'bg-slate-400'
                                        }`}
                                    />
                                </div>
                                <div className={`${muted} truncate`}>{threadJobLabel(thread)}</div>
                                {thread.status === 'error' && thread.lastError && (
                                    <div className="mt-1 text-rose-600 truncate" title={thread.lastError}>
                                        {thread.lastError}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Error threads summary */}
            {errorThreads.length > 0 && (
                <div
                    className={`mb-4 p-3 rounded-lg text-sm ${
                        embedded
                            ? 'bg-rose-50 border border-rose-200 text-rose-700'
                            : 'bg-red-500/20 border border-red-500/30 text-red-400'
                    }`}
                >
                    {t('campaigns.monitorThreadErrors', 'Threads with errors')}: {errorThreads.length}
                </div>
            )}

            {/* Queue quick actions */}
            {queueStats && queueStats.done > 0 && (
                <div className="flex items-center justify-between">
                    <div className={`flex items-center gap-2 text-sm ${muted}`}>
                        <Zap className={`w-4 h-4 ${embedded ? 'text-amber-500' : 'text-yellow-400'}`} />
                        {t('campaigns.monitorQueueHint', 'Queue stats live from automation engine')}
                    </div>
                    <button
                        type="button"
                        onClick={() => void handleClearCompleted()}
                        className={`text-xs transition-colors ${
                            embedded
                                ? 'text-[#908a9e] hover:text-[#5f5a6d]'
                                : 'text-slate-400 hover:text-white'
                        }`}
                    >
                        {t('campaigns.monitorClearCompleted', 'Clear Completed')}
                    </button>
                </div>
            )}

            {error && (
                <div
                    className={`mt-4 p-3 rounded-lg text-sm ${
                        embedded
                            ? 'bg-rose-50 border border-rose-200 text-rose-700'
                            : 'bg-red-500/20 border border-red-500/30 text-red-400'
                    }`}
                >
                    {error}
                </div>
            )}
        </div>
    )
}
