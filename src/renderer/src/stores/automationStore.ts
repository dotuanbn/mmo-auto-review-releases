import { create } from 'zustand'
import {
    hasPendingRecoveryWork,
    listResumeCandidateIds,
    normalizeRecoveryReport,
    normalizeResumePlan,
    type RecoveryReportDto,
    type ResumePlanDto,
} from '../../../shared/automation-contracts'

/** Thread row from AutomationController (browser fields stripped by IPC). */
export interface AutomationThreadState {
    id: number
    status: 'idle' | 'running' | 'error'
    accountId?: number
    accountEmail?: string
    currentJobId?: string
    lastError?: string
}

export interface AutomationProgressCounts {
    total: number
    completed: number
    failed: number
    remaining: number
}

/** Normalized runtime status for Review Campaigns UI. */
export interface AutomationRuntimeStatus {
    running: boolean
    paused: boolean
    threads: AutomationThreadState[]
    progress: AutomationProgressCounts
    currentCampaignId?: number
    currentAccount?: string
    currentLocation?: string
    message: string
    /** 0–100 overall progress percent derived from queue counts. */
    percent: number
    startTime: string | null
    elapsedTime: number
}

/** IPC queue stats from automation:getQueueStats (no Map / byAccount). */
export interface AutomationQueueStats {
    total: number
    pending: number
    running: number
    done: number
    failed: number
}

interface AutomationStore {
    status: AutomationRuntimeStatus
    queueStats: AutomationQueueStats | null
    /** Last boot recovery snapshot (null = none / not loaded / invalid). */
    recoveryReport: RecoveryReportDto | null
    /** Per-campaign resume plans cached after fetchResumePlan. */
    resumePlans: Record<number, ResumePlanDto>
    recoveryLoading: boolean
    loading: boolean
    error: string | null
    listenersReady: boolean

    fetchStatus: () => Promise<void>
    fetchQueueStats: () => Promise<void>
    fetchRecoveryReport: () => Promise<RecoveryReportDto | null>
    fetchResumePlan: (campaignId: number) => Promise<ResumePlanDto | null>
    refresh: () => Promise<void>
    startCampaign: (campaignId: number) => Promise<{ success: boolean; error?: string }>
    resumeCampaign: (campaignId: number) => Promise<{ success: boolean; error?: string }>
    stopCampaign: () => Promise<void>
    pause: () => Promise<void>
    resume: () => Promise<void>
    clearCompleted: () => Promise<void>
    applyControllerStatus: (raw: unknown) => void
    applyReviewProgress: (raw: unknown) => void
    ensureListeners: () => void
}

export {
    hasPendingRecoveryWork,
    listResumeCandidateIds,
    normalizeRecoveryReport,
    normalizeResumePlan,
}

const EMPTY_PROGRESS: AutomationProgressCounts = {
    total: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
}

const IDLE_STATUS: AutomationRuntimeStatus = {
    running: false,
    paused: false,
    threads: [],
    progress: { ...EMPTY_PROGRESS },
    message: 'Idle',
    percent: 0,
    startTime: null,
    elapsedTime: 0,
}

function computePercent(progress: AutomationProgressCounts): number {
    if (progress.total <= 0) return 0
    const finished = progress.completed + progress.failed
    return Math.min(100, Math.round((finished / progress.total) * 100))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function parseThread(value: unknown): AutomationThreadState | null {
    if (!isRecord(value) || typeof value.id !== 'number') return null
    const status = value.status
    if (status !== 'idle' && status !== 'running' && status !== 'error') return null
    return {
        id: value.id,
        status,
        accountId: typeof value.accountId === 'number' ? value.accountId : undefined,
        accountEmail: typeof value.accountEmail === 'string' ? value.accountEmail : undefined,
        currentJobId: typeof value.currentJobId === 'string' ? value.currentJobId : undefined,
        lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
    }
}

function parseProgress(value: unknown): AutomationProgressCounts {
    if (!isRecord(value)) return { ...EMPTY_PROGRESS }
    return {
        total: typeof value.total === 'number' ? value.total : 0,
        completed: typeof value.completed === 'number' ? value.completed : 0,
        failed: typeof value.failed === 'number' ? value.failed : 0,
        remaining: typeof value.remaining === 'number' ? value.remaining : 0,
    }
}

/**
 * Normalize AutomationController.getStatus() payload and legacy flat shapes.
 */
export function normalizeControllerStatus(
    raw: unknown,
    previous: AutomationRuntimeStatus = IDLE_STATUS
): AutomationRuntimeStatus {
    if (!isRecord(raw)) return previous

    const running =
        typeof raw.running === 'boolean'
            ? raw.running
            : typeof raw.isRunning === 'boolean'
                ? raw.isRunning
                : previous.running

    const paused =
        typeof raw.paused === 'boolean'
            ? raw.paused
            : typeof raw.isPaused === 'boolean'
                ? raw.isPaused
                : previous.paused

    const threads = Array.isArray(raw.threads)
        ? raw.threads.map(parseThread).filter((t): t is AutomationThreadState => t !== null)
        : previous.threads

    let progress = previous.progress
    if (isRecord(raw.progress) && typeof raw.progress.total === 'number') {
        progress = parseProgress(raw.progress)
    } else if (typeof raw.progress === 'number') {
        progress = {
            ...previous.progress,
            total: previous.progress.total || 100,
            completed: raw.progress,
        }
    }

    const currentCampaignId =
        typeof raw.currentCampaignId === 'number'
            ? raw.currentCampaignId
            : typeof raw.campaignId === 'number'
                ? raw.campaignId
                : previous.currentCampaignId

    const message =
        typeof raw.message === 'string'
            ? raw.message
            : paused
                ? 'Paused'
                : running
                    ? previous.message === 'Idle' || previous.message === 'Stopped'
                        ? 'Running'
                        : previous.message
                    : previous.message === 'Running' || previous.message === 'Starting...'
                        ? 'Idle'
                        : previous.message

    const startTime =
        typeof raw.startTime === 'string'
            ? raw.startTime
            : running
                ? previous.startTime ?? new Date().toISOString()
                : null

    const elapsedTime =
        typeof raw.elapsedTime === 'number'
            ? raw.elapsedTime
            : startTime
                ? Math.max(0, Math.floor((Date.now() - new Date(startTime).getTime()) / 1000))
                : 0

    return {
        running,
        paused,
        threads,
        progress,
        currentCampaignId,
        currentAccount:
            typeof raw.currentAccount === 'string' ? raw.currentAccount : previous.currentAccount,
        currentLocation:
            typeof raw.currentLocation === 'string' ? raw.currentLocation : previous.currentLocation,
        message,
        percent: computePercent(progress),
        startTime,
        elapsedTime,
    }
}

export function normalizeQueueStats(raw: unknown): AutomationQueueStats | null {
    if (!isRecord(raw)) return null
    // Support both IPC shape { total, pending, running, done, failed }
    // and legacy monitor shape { totalJobs, pendingJobs, ... }
    const total =
        typeof raw.total === 'number'
            ? raw.total
            : typeof raw.totalJobs === 'number'
                ? raw.totalJobs
                : 0
    const pending =
        typeof raw.pending === 'number'
            ? raw.pending
            : typeof raw.pendingJobs === 'number'
                ? raw.pendingJobs
                : 0
    const running =
        typeof raw.running === 'number'
            ? raw.running
            : typeof raw.runningJobs === 'number'
                ? raw.runningJobs
                : 0
    const done =
        typeof raw.done === 'number'
            ? raw.done
            : typeof raw.completedJobs === 'number'
                ? raw.completedJobs
                : 0
    const failed =
        typeof raw.failed === 'number'
            ? raw.failed
            : typeof raw.failedJobs === 'number'
                ? raw.failedJobs
                : 0
    return { total, pending, running, done, failed }
}

function parseReviewProgress(raw: unknown): Partial<AutomationRuntimeStatus> {
    if (!isRecord(raw)) return {}
    const patch: Partial<AutomationRuntimeStatus> = {}
    if (raw.accountId != null) {
        patch.currentAccount = String(raw.accountId)
    }
    if (raw.locationId != null) {
        patch.currentLocation = String(raw.locationId)
    }
    if (typeof raw.message === 'string') {
        patch.message = raw.message
    }
    if (typeof raw.progress === 'number') {
        patch.percent = Math.min(100, Math.max(0, Math.round(raw.progress)))
    }
    if (typeof raw.campaignId === 'number') {
        patch.currentCampaignId = raw.campaignId
    }
    return patch
}

let listenersAttached = false
let elapsedTimer: ReturnType<typeof setInterval> | null = null

function startElapsedTicker(): void {
    if (elapsedTimer) return
    elapsedTimer = setInterval(() => {
        const { status } = useAutomationStore.getState()
        if (!status.running || !status.startTime || status.paused) return
        const elapsed = Math.max(
            0,
            Math.floor((Date.now() - new Date(status.startTime).getTime()) / 1000)
        )
        useAutomationStore.setState({
            status: { ...status, elapsedTime: elapsed },
        })
    }, 1000)
}

function stopElapsedTickerIfIdle(): void {
    const { status } = useAutomationStore.getState()
    if (status.running) return
    if (elapsedTimer) {
        clearInterval(elapsedTimer)
        elapsedTimer = null
    }
}

export const useAutomationStore = create<AutomationStore>((set, get) => ({
    status: { ...IDLE_STATUS },
    queueStats: null,
    recoveryReport: null,
    resumePlans: {},
    recoveryLoading: false,
    loading: false,
    error: null,
    listenersReady: false,

    fetchStatus: async () => {
        try {
            const raw = await window.electronAPI.automation.getStatus()
            const normalized = normalizeControllerStatus(raw, get().status)
            set({ status: normalized, error: null })
            if (normalized.running) startElapsedTicker()
            else stopElapsedTickerIfIdle()
        } catch (error) {
            console.error('Failed to fetch automation status:', error)
            set({
                error: error instanceof Error ? error.message : 'Failed to fetch automation status',
            })
        }
    },

    fetchQueueStats: async () => {
        try {
            const api = window.electronAPI.automation
            if (typeof api.getQueueStats !== 'function') {
                set({ queueStats: null })
                return
            }
            const raw = await api.getQueueStats(get().status.currentCampaignId)
            const queueStats = normalizeQueueStats(raw)
            set({ queueStats })
            if (queueStats) {
                const progress: AutomationProgressCounts = {
                    total: queueStats.total,
                    completed: queueStats.done,
                    failed: queueStats.failed,
                    remaining: queueStats.pending + queueStats.running,
                }
                const prev = get().status
                set({
                    status: {
                        ...prev,
                        progress,
                        percent: computePercent(progress),
                    },
                })
            }
        } catch (error) {
            console.error('Failed to fetch queue stats:', error)
        }
    },

    fetchRecoveryReport: async () => {
        set({ recoveryLoading: true })
        try {
            const api = window.electronAPI.automation
            if (typeof api.getRecoveryReport !== 'function') {
                set({ recoveryReport: null, recoveryLoading: false })
                return null
            }
            const raw = await api.getRecoveryReport()
            const recoveryReport = normalizeRecoveryReport(raw)
            set({ recoveryReport, recoveryLoading: false })
            return recoveryReport
        } catch (error) {
            console.error('Failed to fetch recovery report:', error)
            set({ recoveryReport: null, recoveryLoading: false })
            return null
        }
    },

    fetchResumePlan: async (campaignId) => {
        try {
            const api = window.electronAPI.automation
            if (typeof api.getResumePlan !== 'function') return null
            const raw = await api.getResumePlan(campaignId)
            const plan = normalizeResumePlan(raw)
            if (plan) {
                set((state) => ({
                    resumePlans: { ...state.resumePlans, [campaignId]: plan },
                }))
            }
            return plan
        } catch (error) {
            console.error(`Failed to fetch resume plan for campaign ${campaignId}:`, error)
            return null
        }
    },

    refresh: async () => {
        await Promise.all([
            get().fetchStatus(),
            get().fetchQueueStats(),
            get().fetchRecoveryReport(),
        ])
    },

    startCampaign: async (campaignId) => {
        set({ loading: true, error: null })
        try {
            const result = await window.electronAPI.automation.startCampaign(campaignId)
            if (result && result.success === false) {
                set({
                    status: {
                        ...IDLE_STATUS,
                        message: result.error || 'Failed to start',
                    },
                    error: result.error || 'Failed to start campaign',
                    loading: false,
                })
                return { success: false, error: result.error || 'Failed to start campaign' }
            }
            const startTime = new Date().toISOString()
            set({
                status: {
                    ...IDLE_STATUS,
                    running: true,
                    paused: false,
                    currentCampaignId: campaignId,
                    message: 'Starting...',
                    startTime,
                    elapsedTime: 0,
                },
                loading: false,
                error: null,
            })
            startElapsedTicker()
            await get().refresh()
            return { success: true }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start campaign'
            set({
                status: { ...IDLE_STATUS, message },
                error: message,
                loading: false,
            })
            return { success: false, error: message }
        }
    },

    resumeCampaign: async (campaignId) => {
        const current = get().status
        if (current.running && current.currentCampaignId === campaignId) {
            await get().resume()
            await get().fetchRecoveryReport()
            return { success: true }
        }

        set({ loading: true, error: null })
        try {
            const result = await window.electronAPI.automation.resumeCampaign(campaignId)
            if (result?.success === false) {
                const message = result.error || 'Failed to resume campaign'
                set({ loading: false, error: message })
                return { success: false, error: message }
            }
            set({
                status: {
                    ...IDLE_STATUS,
                    running: true,
                    currentCampaignId: campaignId,
                    message: 'Resuming...',
                    startTime: new Date().toISOString(),
                },
                loading: false,
                error: null,
            })
            startElapsedTicker()
            // Refresh status/queue + recovery banner after manual resume (no auto-start)
            await get().refresh()
            return { success: true }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to resume campaign'
            set({ loading: false, error: message })
            return { success: false, error: message }
        }
    },

    stopCampaign: async () => {
        set({ loading: true })
        try {
            await window.electronAPI.automation.stopCampaign()
            set({
                status: { ...IDLE_STATUS, message: 'Stopped' },
                queueStats: null,
                loading: false,
                error: null,
            })
            stopElapsedTickerIfIdle()
        } catch (error) {
            set({
                error: error instanceof Error ? error.message : 'Failed to stop campaign',
                loading: false,
            })
        }
    },

    pause: async () => {
        try {
            await window.electronAPI.automation.pause()
            set((state) => ({
                status: {
                    ...state.status,
                    paused: true,
                    message: 'Paused',
                },
                error: null,
            }))
        } catch (error) {
            set({
                error: error instanceof Error ? error.message : 'Failed to pause campaign',
            })
        }
    },

    resume: async () => {
        try {
            await window.electronAPI.automation.resume()
            set((state) => ({
                status: {
                    ...state.status,
                    paused: false,
                    running: true,
                    message: 'Running',
                    startTime: state.status.startTime ?? new Date().toISOString(),
                },
                error: null,
            }))
            startElapsedTicker()
        } catch (error) {
            set({
                error: error instanceof Error ? error.message : 'Failed to resume campaign',
            })
        }
    },

    clearCompleted: async () => {
        try {
            const api = window.electronAPI.automation
            if (typeof api.clearCompleted === 'function') {
                await api.clearCompleted(get().status.currentCampaignId)
            }
            await get().fetchQueueStats()
        } catch (error) {
            console.error('Failed to clear completed jobs:', error)
        }
    },

    applyControllerStatus: (raw) => {
        const normalized = normalizeControllerStatus(raw, get().status)
        set({ status: normalized, error: null })
        if (normalized.running) startElapsedTicker()
        else stopElapsedTickerIfIdle()
    },

    applyReviewProgress: (raw) => {
        const patch = parseReviewProgress(raw)
        if (Object.keys(patch).length === 0) return
        set((state) => ({
            status: {
                ...state.status,
                ...patch,
            },
        }))
    },

    ensureListeners: () => {
        if (listenersAttached || get().listenersReady) return
        setupAutomationListeners()
    },
}))

/**
 * Subscribe to live automation IPC events. Safe to call multiple times.
 */
export function setupAutomationListeners(): void {
    if (listenersAttached) return
    if (typeof window === 'undefined' || !window.electronAPI) return

    listenersAttached = true

    const store = useAutomationStore.getState()

    // Generic event bus (preload validChannels includes automation:status + review:progress)
    if (typeof window.electronAPI.on === 'function') {
        window.electronAPI.on('automation:status', (status: unknown) => {
            useAutomationStore.getState().applyControllerStatus(status)
        })
        window.electronAPI.on('review:progress', (data: unknown) => {
            useAutomationStore.getState().applyReviewProgress(data)
        })
    }

    // Optional dedicated stream (runtime may expose it; not always in Window typing)
    const automationApi = window.electronAPI.automation as {
        onStatusUpdate?: (callback: (status: unknown) => void) => (() => void) | void
    }
    if (typeof automationApi.onStatusUpdate === 'function') {
        automationApi.onStatusUpdate((status: unknown) => {
            useAutomationStore.getState().applyControllerStatus(status)
        })
    }

    useAutomationStore.setState({ listenersReady: true })

    // Initial snapshot
    void store.refresh()
}
