import { create } from 'zustand'

interface Account {
    id: number
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
    twoFactorSecret?: string
    cookies?: string
    profilePath?: string
    loginType: 'auto' | 'manual'
    status: 'active' | 'banned' | 'pending' | 'suspended' | 'checking'
    lastUsed?: Date
    totalReviews: number
    createdAt: Date
}

interface AccountStats {
    total: number
    active: number
    banned: number
    pending: number
    checking?: number
}

type AccountLiveCheckResult = {
    alive: boolean
    error?: string
    needs2FA?: boolean
}

interface AccountStore {
    accounts: Account[]
    stats: AccountStats
    loading: boolean
    error: string | null

    // Actions
    fetchAccounts: () => Promise<void>
    fetchStats: () => Promise<void>
    addAccount: (data: { email: string; password: string; recoveryEmail?: string; recoveryPhone?: string; loginType?: 'auto' | 'manual'; twoFactorSecret?: string }) => Promise<any>
    updateAccount: (id: number, data: Partial<Account>) => Promise<void>
    deleteAccount: (id: number) => Promise<void>
    importAccounts: (accounts: { email: string; password: string; twoFactorSecret?: string; loginType?: 'auto' | 'manual' }[]) => Promise<number>
    testLogin: (id: number) => Promise<any>
    loginVisible: (id: number) => Promise<any>
    checkLiveDie: (id: number) => Promise<AccountLiveCheckResult>
    checkAllPending: () => Promise<{ checked: number; alive: number; dead: number }>
}

export const useAccountStore = create<AccountStore>((set, get) => ({
    accounts: [],
    stats: { total: 0, active: 0, banned: 0, pending: 0 },
    loading: false,
    error: null,

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
}))
