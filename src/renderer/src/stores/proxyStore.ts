import { create } from 'zustand'

interface Proxy {
    id: number
    host: string
    port: number
    username?: string
    password?: string
    type: 'http' | 'https' | 'socks5'
    country?: string
    provider?: string          // 'dataimpulse' | 'fproxy' | 'smartproxy' | 'manual' | 'custom' ...
    status: 'active' | 'dead' | 'checking'
    lastCheck?: Date
    responseTime?: number
    createdAt: Date
}

interface ProxyStats {
    total: number
    active: number
    dead: number
}

interface ProxyStore {
    proxies: Proxy[]
    stats: ProxyStats
    loading: boolean
    error: string | null

    // Actions
    fetchProxies: () => Promise<void>
    fetchStats: () => Promise<void>
    addProxy: (data: { host: string; port: number; username?: string; password?: string; type?: 'http' | 'https' | 'socks5'; country?: string; provider?: string }) => Promise<void>
    updateProxy: (id: number, data: Partial<Proxy>) => Promise<void>
    deleteProxy: (id: number) => Promise<void>
    checkProxy: (id: number) => Promise<{ alive: boolean; responseTime: number; reason?: string }>
    checkAllProxies: () => Promise<void>
    importFromText: (text: string, defaultProvider?: string) => Promise<number>
    deleteDeadProxies: () => Promise<number>
}

export const useProxyStore = create<ProxyStore>((set, get) => ({
    proxies: [],
    stats: { total: 0, active: 0, dead: 0 },
    loading: false,
    error: null,

    fetchProxies: async () => {
        set({ loading: true, error: null })
        try {
            const proxies = await window.electronAPI.proxies.getAll()
            set({ proxies, loading: false })
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to fetch proxies', loading: false })
        }
    },

    fetchStats: async () => {
        try {
            const stats = await window.electronAPI.proxies.getStats()
            set({ stats })
        } catch (error) {
            console.error('Failed to fetch proxy stats:', error)
        }
    },

    addProxy: async (data) => {
        set({ loading: true, error: null })
        try {
            await window.electronAPI.proxies.add(data)
            await get().fetchProxies()
            await get().fetchStats()
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to add proxy', loading: false })
        }
    },

    updateProxy: async (id, data) => {
        try {
            await window.electronAPI.proxies.update(id, data)
            await get().fetchProxies()
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to update proxy', loading: false })
        }
    },

    deleteProxy: async (id) => {
        try {
            await window.electronAPI.proxies.delete(id)
            await get().fetchProxies()
            await get().fetchStats()
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to delete proxy', loading: false })
        }
    },

    checkProxy: async (id) => {
        try {
            const result = await window.electronAPI.proxies.check(id)
            await get().fetchProxies()
            return result
        } catch (error) {
            console.error('Failed to check proxy:', error)
            return { alive: false, responseTime: 0 }
        }
    },

    checkAllProxies: async () => {
        set({ loading: true })
        try {
            await window.electronAPI.proxies.checkAll()
            await get().fetchProxies()
            await get().fetchStats()
            set({ loading: false })
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to check proxies', loading: false })
        }
    },

    importFromText: async (text, defaultProvider) => {
        set({ loading: true, error: null })
        try {
            const count = await window.electronAPI.proxies.importText(text, defaultProvider)
            await get().fetchProxies()
            await get().fetchStats()
            set({ loading: false })
            return count
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to import proxies', loading: false })
            return 0
        }
    },

    deleteDeadProxies: async () => {
        try {
            const count = await window.electronAPI.proxies.deleteDead()
            await get().fetchProxies()
            await get().fetchStats()
            return count
        } catch (error) {
            set({ error: error instanceof Error ? error.message : 'Failed to delete dead proxies' })
            return 0
        }
    },
}))
