import { useState, useEffect } from 'react'
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
    TrendingUp,
    Zap
} from 'lucide-react'

interface AutomationStatus {
    isRunning: boolean
    isPaused: boolean
    currentCampaignId: number | null
    threads: {
        id: number
        status: 'idle' | 'running' | 'error'
        accountId: number | null
        currentJob: string | null
    }[]
    stats: {
        totalJobs: number
        completedJobs: number
        failedJobs: number
        pendingJobs: number
    }
    startTime: string | null
    elapsedTime: number
}

interface QueueStats {
    totalJobs: number
    pendingJobs: number
    runningJobs: number
    completedJobs: number
    failedJobs: number
    accountStats: {
        accountId: number
        pending: number
        completed: number
        dailyCount: number
    }[]
}

export function AutomationMonitor() {
    const [status, setStatus] = useState<AutomationStatus | null>(null)
    const [queueStats, setQueueStats] = useState<QueueStats | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Fetch status periodically
    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const [statusResult, queueResult] = await Promise.all([
                    window.electronAPI.automation.getStatus(),
                    window.electronAPI.automation.getQueueStats?.() || null
                ])
                setStatus(statusResult)
                setQueueStats(queueResult)
                setError(null)
            } catch (err) {
                setError('Failed to fetch automation status')
                console.error(err)
            } finally {
                setLoading(false)
            }
        }

        fetchStatus()
        const interval = setInterval(fetchStatus, 2000) // Update every 2 seconds

        return () => clearInterval(interval)
    }, [])

    // Handle pause/resume
    const handlePauseResume = async () => {
        try {
            if (status?.isPaused) {
                await window.electronAPI.automation.resume?.()
            } else {
                await window.electronAPI.automation.pause?.()
            }
        } catch (err) {
            console.error('Failed to pause/resume:', err)
        }
    }

    // Handle stop
    const handleStop = async () => {
        try {
            await window.electronAPI.automation.stopCampaign()
        } catch (err) {
            console.error('Failed to stop:', err)
        }
    }

    // Handle clear completed
    const handleClearCompleted = async () => {
        try {
            await window.electronAPI.automation.clearCompleted?.()
        } catch (err) {
            console.error('Failed to clear completed:', err)
        }
    }

    // Format elapsed time
    const formatTime = (seconds: number): string => {
        const h = Math.floor(seconds / 3600)
        const m = Math.floor((seconds % 3600) / 60)
        const s = seconds % 60
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }

    if (loading) {
        return (
            <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50">
                <div className="flex items-center justify-center gap-2 text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    Loading automation status...
                </div>
            </div>
        )
    }

    if (!status?.isRunning && !queueStats) {
        return (
            <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50">
                <div className="flex items-center justify-center gap-2 text-slate-400">
                    <Activity className="w-5 h-5" />
                    No automation running. Start a campaign to see progress.
                </div>
            </div>
        )
    }

    const progress = queueStats
        ? Math.round((queueStats.completedJobs / Math.max(queueStats.totalJobs, 1)) * 100)
        : 0

    return (
        <div className="bg-gradient-to-br from-blue-900/30 to-cyan-900/20 rounded-xl p-6 border border-blue-500/30">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                    <Activity className="w-5 h-5 text-blue-400" />
                    Automation Progress Monitor
                    {status?.isRunning && (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${status.isPaused
                                ? 'bg-yellow-500/20 text-yellow-400'
                                : 'bg-green-500/20 text-green-400'
                            }`}>
                            <span className={`w-2 h-2 rounded-full ${status.isPaused ? 'bg-yellow-400' : 'bg-green-400 animate-pulse'
                                }`}></span>
                            {status.isPaused ? 'Paused' : 'Running'}
                        </span>
                    )}
                </h2>

                {/* Controls */}
                {status?.isRunning && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handlePauseResume}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${status.isPaused
                                    ? 'bg-green-600 hover:bg-green-500 text-white'
                                    : 'bg-yellow-600 hover:bg-yellow-500 text-white'
                                }`}
                        >
                            {status.isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                            {status.isPaused ? 'Resume' : 'Pause'}
                        </button>
                        <button
                            onClick={handleStop}
                            className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors"
                        >
                            <Square className="w-3 h-3" />
                            Stop
                        </button>
                    </div>
                )}
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="bg-slate-800/60 rounded-lg p-4 text-center">
                    <div className="text-3xl font-bold text-white">{queueStats?.totalJobs || 0}</div>
                    <div className="text-xs text-slate-400 mt-1">Total Jobs</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-4 text-center">
                    <div className="text-3xl font-bold text-green-400">{queueStats?.completedJobs || 0}</div>
                    <div className="text-xs text-slate-400 mt-1 flex items-center justify-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Completed
                    </div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-4 text-center">
                    <div className="text-3xl font-bold text-red-400">{queueStats?.failedJobs || 0}</div>
                    <div className="text-xs text-slate-400 mt-1 flex items-center justify-center gap-1">
                        <XCircle className="w-3 h-3" /> Failed
                    </div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-4 text-center">
                    <div className="text-3xl font-bold text-blue-400">{queueStats?.pendingJobs || 0}</div>
                    <div className="text-xs text-slate-400 mt-1 flex items-center justify-center gap-1">
                        <Clock className="w-3 h-3" /> Pending
                    </div>
                </div>
            </div>

            {/* Progress Bar */}
            <div className="mb-6">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-slate-400">Overall Progress</span>
                    <span className="text-sm font-medium text-white">{progress}%</span>
                </div>
                <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-500"
                        style={{ width: `${progress}%` }}
                    />
                </div>
                {status?.startTime && (
                    <div className="flex items-center justify-between mt-2 text-xs text-slate-500">
                        <span>Started: {new Date(status.startTime).toLocaleTimeString()}</span>
                        <span>Elapsed: {formatTime(status.elapsedTime)}</span>
                    </div>
                )}
            </div>

            {/* Thread Status */}
            {status?.threads && status.threads.length > 0 && (
                <div className="mb-6">
                    <h3 className="text-sm font-medium text-slate-300 mb-3 flex items-center gap-2">
                        <Users className="w-4 h-4" />
                        Active Threads ({status.threads.filter(t => t.status === 'running').length}/{status.threads.length})
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                        {status.threads.map((thread) => (
                            <div
                                key={thread.id}
                                className={`p-3 rounded-lg text-xs ${thread.status === 'running'
                                        ? 'bg-green-500/20 border border-green-500/30'
                                        : thread.status === 'error'
                                            ? 'bg-red-500/20 border border-red-500/30'
                                            : 'bg-slate-700/50 border border-slate-600/50'
                                    }`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className="font-medium text-white">Thread {thread.id}</span>
                                    <span className={`w-2 h-2 rounded-full ${thread.status === 'running' ? 'bg-green-400 animate-pulse' :
                                            thread.status === 'error' ? 'bg-red-400' : 'bg-slate-500'
                                        }`}></span>
                                </div>
                                {thread.currentJob && (
                                    <div className="text-slate-400 truncate">
                                        {thread.currentJob}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Account Daily Stats */}
            {queueStats?.accountStats && queueStats.accountStats.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
                            <TrendingUp className="w-4 h-4" />
                            Account Activity Today
                        </h3>
                        <button
                            onClick={handleClearCompleted}
                            className="text-xs text-slate-400 hover:text-white transition-colors"
                        >
                            Clear Completed
                        </button>
                    </div>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                        {queueStats.accountStats.map((account) => (
                            <div
                                key={account.accountId}
                                className="flex items-center justify-between p-2 bg-slate-800/60 rounded-lg"
                            >
                                <div className="flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-yellow-400" />
                                    <span className="text-sm text-white">Account #{account.accountId}</span>
                                </div>
                                <div className="flex items-center gap-4 text-xs">
                                    <span className="text-green-400">{account.completed} done</span>
                                    <span className="text-blue-400">{account.pending} pending</span>
                                    <span className="text-slate-400">Today: {account.dailyCount}/day</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {error && (
                <div className="mt-4 p-3 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400 text-sm">
                    {error}
                </div>
            )}
        </div>
    )
}
