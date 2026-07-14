import { create } from 'zustand'
import type {
    AccountCreatePayload,
    AccountImportPayload,
    AccountLiveCheckResult,
    AccountStats,
    AccountUpdatePayload,
    PublicAccount,
} from '../../../shared/account-contracts'
import {
    getWarmupApi,
    normalizeWarmupStatus,
    normalizeWarmupStatusMap,
    type AccountWarmupStatus,
    type WarmupActivityType,
    type WarmupStartOptions,
} from '../components/accounts'

interface AccountStore {
    accounts: PublicAccount[]
    stats: AccountStats
    loading: boolean
    error: string | null

    /** Batch warmup statuses keyed by accountId (from getAllStatuses — never N+1). */
    warmupStatuses: Record<number, AccountWarmupStatus>
    warmupLoading: boolean
    warmupError: string | null
    /** Per-account start/cancel in-flight flags. */
    warmupActionLoading: Record<number, boolean>
    /** Whether optional electronAPI.warmup is present. */
    warmupApiAvailable: boolean

    // Actions
    fetchAccounts: () => Promise<void>
    fetchStats: () => Promise<void>
    addAccount: (data: AccountCreatePayload) => Promise<PublicAccount | undefined>
    updateAccount: (id: number, data: AccountUpdatePayload) => Promise<void>
    deleteAccount: (id: number) => Promise<void>
    importAccounts: (accounts: AccountImportPayload[]) => Promise<number>
    testLogin: (id: number) => Promise<{ success: boolean; message: string; needs2FA?: boolean }>
    loginVisible: (id: number) => Promise<{ success: boolean; message: string; needs2FA?: boolean }>
    checkLiveDie: (id: number) => Promise<AccountLiveCheckResult>
    checkAllPending: () => Promise<{ checked: number; alive: number; dead: number }>

    /** Single batch IPC: warmup.getAllStatuses(). No per-row getStatus. */
    fetchWarmupStatuses: () => Promise<void>
    startWarmup: (id: number, options?: WarmupStartOptions) => Promise<{ success: boolean; message?: string }>
    cancelWarmup: (id: number) => Promise<{ success: boolean; message?: string }>
}

function safeErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
        // Strip anything that looks like a secret / token fragment
        return error.message.replace(/(password|secret|token|cookie)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 200)
    }
    return fallback
}

function setActionLoading(
    prev: Record<number, boolean>,
    id: number,
    loading: boolean,
): Record<number, boolean> {
    if (loading) return { ...prev, [id]: true }
    const next = { ...prev }
    delete next[id]
    return next
}

export const useAccountStore = create<AccountStore>((set, get) => ({
    accounts: [],
    stats: { total: 0, active: 0, banned: 0, pending: 0, checking: 0 },
    loading: false,
    error: null,

    warmupStatuses: {},
    warmupLoading: false,
    warmupError: null,
    warmupActionLoading: {},
    warmupApiAvailable: false,

    fetchAccounts: async () => {
        set({ loading: true, error: null })
        try {
            const accounts = await window.electronAPI.accounts.getAll()
            set({ accounts, loading: false })
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to fetch accounts', loading: false })
        }
    },

    fetchStats: async () => {
        try {
            const stats = await window.electronAPI.accounts.getStats()
            set({ stats })
        } catch (error) {
            console.error('Failed to fetch account stats:', error)
        }
    },

    addAccount: async (data) => {
        set({ loading: true, error: null })
        try {
            const created = await window.electronAPI.accounts.add(data)
            await get().fetchAccounts()
            await get().fetchStats()
            set({ loading: false })
            return created
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to add account', loading: false })
            return undefined
        }
    },

    updateAccount: async (id, data) => {
        set({ loading: true, error: null })
        try {
            await window.electronAPI.accounts.update(id, data)
            await get().fetchAccounts()
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to update account', loading: false })
        }
    },

    deleteAccount: async (id) => {
        set({ loading: true, error: null })
        try {
            await window.electronAPI.accounts.delete(id)
            await get().fetchAccounts()
            await get().fetchStats()
            // Drop stale warmup entry for deleted account
            const { [id]: _removed, ...rest } = get().warmupStatuses
            set({ warmupStatuses: rest })
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to delete account', loading: false })
        }
    },

    importAccounts: async (accounts) => {
        set({ loading: true, error: null })
        try {
            const count = await window.electronAPI.accounts.importCSV(accounts)
            await get().fetchAccounts()
            await get().fetchStats()
            set({ loading: false })
            return count
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to import accounts', loading: false })
            return 0
        }
    },

    testLogin: async (id) => {
        try {
            const result = await window.electronAPI.accounts.testLogin(id)
            // Refresh accounts after login attempt to get updated status
            await get().fetchAccounts()
            await get().fetchStats()
            return result
        } catch (error) {
            console.error('Failed to test login:', error)
            return { success: false, message: error instanceof Error ? error.message : 'Unknown error' }
        }
    },

    loginVisible: async (id) => {
        try {
            const result = await window.electronAPI.accounts.loginVisible(id)
            // Refresh accounts after login attempt to get updated status
            await get().fetchAccounts()
            await get().fetchStats()
            return result
        } catch (error) {
            console.error('Failed to login visible:', error)
            return { success: false, message: error instanceof Error ? error.message : 'Unknown error' }
        }
    },

    checkLiveDie: async (id) => {
        try {
            const result = await window.electronAPI.accounts.checkLiveDie(id)
            await get().fetchAccounts()
            await get().fetchStats()
            return result
        } catch (error) {
            console.error('Failed to check account:', error)
            return { alive: false, error: error instanceof Error ? error.message : 'Unknown error' }
        }
    },

    checkAllPending: async () => {
        try {
            const result = await window.electronAPI.accounts.checkAllPending()
            await get().fetchAccounts()
            await get().fetchStats()
            return result
        } catch (error) {
            console.error('Failed to check all pending:', error)
            return { checked: 0, alive: 0, dead: 0 }
        }
    },

    fetchWarmupStatuses: async () => {
        const api = getWarmupApi()
        if (!api) {
            set({
                warmupApiAvailable: false,
                warmupLoading: false,
                // Keep last known statuses; UI falls back to PublicAccount fields per row
            })
            return
        }

        set({ warmupLoading: true, warmupError: null, warmupApiAvailable: true })
        try {
            // Batch only — never loop getStatus(id) for each account
            const raw = await api.getAllStatuses()
            const map = normalizeWarmupStatusMap(raw)
            set({ warmupStatuses: map, warmupLoading: false, warmupApiAvailable: true })
        } catch (error) {
            set({
                warmupLoading: false,
                warmupError: safeErrorMessage(error, 'Failed to fetch warmup statuses'),
                warmupApiAvailable: true,
            })
        }
    },

    startWarmup: async (id, options) => {
        const api = getWarmupApi()
        if (!api) {
            const message = 'Warmup API not available'
            set({ warmupError: message, warmupApiAvailable: false })
            return { success: false, message }
        }

        set((state) => ({
            warmupApiAvailable: true,
            warmupError: null,
            warmupActionLoading: setActionLoading(state.warmupActionLoading, id, true),
        }))

        try {
            const activityType: WarmupActivityType | undefined = options?.activityType
            const payload: WarmupStartOptions = {}
            if (activityType) payload.activityType = activityType
            if (options?.durationSeconds != null) payload.durationSeconds = options.durationSeconds

            const result = await api.start(id, payload)

            // Prefer single-account refresh when available, then full batch for consistency
            try {
                const one = await api.getStatus(id)
                const normalized = normalizeWarmupStatus(one, id)
                if (normalized) {
                    set((state) => ({
                        warmupStatuses: { ...state.warmupStatuses, [id]: normalized },
                    }))
                }
            } catch {
                await get().fetchWarmupStatuses()
            }

            if (!result?.success) {
                const message = result?.message?.slice(0, 200) || 'Failed to start warmup'
                set((state) => ({
                    warmupError: message,
                    warmupActionLoading: setActionLoading(state.warmupActionLoading, id, false),
                }))
                return { success: false, message }
            }

            set((state) => ({
                warmupActionLoading: setActionLoading(state.warmupActionLoading, id, false),
            }))
            // Background batch sync (level/reputation may update on main)
            void get().fetchWarmupStatuses()
            return { success: true, message: result.message }
        } catch (error) {
            const message = safeErrorMessage(error, 'Failed to start warmup')
            set((state) => ({
                warmupError: message,
                warmupActionLoading: setActionLoading(state.warmupActionLoading, id, false),
            }))
            return { success: false, message }
        }
    },

    cancelWarmup: async (id) => {
        const api = getWarmupApi()
        if (!api) {
            const message = 'Warmup API not available'
            set({ warmupError: message, warmupApiAvailable: false })
            return { success: false, message }
        }

        set((state) => ({
            warmupApiAvailable: true,
            warmupError: null,
            warmupActionLoading: setActionLoading(state.warmupActionLoading, id, true),
        }))

        try {
            const result = await api.cancel(id)

            try {
                const one = await api.getStatus(id)
                const normalized = normalizeWarmupStatus(one, id)
                if (normalized) {
                    set((state) => ({
                        warmupStatuses: { ...state.warmupStatuses, [id]: normalized },
                    }))
                }
            } catch {
                await get().fetchWarmupStatuses()
            }

            if (!result?.success) {
                const message = result?.message?.slice(0, 200) || 'Failed to cancel warmup'
                set((state) => ({
                    warmupError: message,
                    warmupActionLoading: setActionLoading(state.warmupActionLoading, id, false),
                }))
                return { success: false, message }
            }

            set((state) => ({
                warmupActionLoading: setActionLoading(state.warmupActionLoading, id, false),
            }))
            void get().fetchWarmupStatuses()
            return { success: true, message: result.message }
        } catch (error) {
            const message = safeErrorMessage(error, 'Failed to cancel warmup')
            set((state) => ({
                warmupError: message,
                warmupActionLoading: setActionLoading(state.warmupActionLoading, id, false),
            }))
            return { success: false, message }
        }
    },
}))
