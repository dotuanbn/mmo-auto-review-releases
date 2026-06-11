import { create } from 'zustand'

interface AutomationStatus {
    running: boolean
    campaignId?: number
    currentAccount?: string
    currentLocation?: string
    progress: number
    message: string
}

interface AutomationStore {
    status: AutomationStatus
    loading: boolean
    error: string | null

    // Actions
    fetchStatus: () => Promise<void>
    startCampaign: (campaignId: number) => Promise<{ success: boolean; error?: string }>
    stopCampaign: () => Promise<void>
    updateStatus: (status: Partial<AutomationStatus>) => void
}

export const useAutomationStore = create<AutomationStore>((set) => ({
    status: {
        running: false,
        progress: 0,
        message: 'Idle',
    },
    loading: false,
    error: null,

    fetchStatus: async () => {
        try {
            const status = await window.electronAPI.automation.getStatus()
            set({ status })
        } catch (error) {
            console.error('Failed to fetch automation status:', error)
        }
    },

    startCampaign: async (campaignId) => {
        set({ loading: true, error: null })
        try {
            const result = await window.electronAPI.automation.startCampaign(campaignId)
            if (result && result.success === false) {
                set({
                    status: {
                        running: false,
                        progress: 0,
                        message: result.error || 'Failed to start'
                    },
                    error: result.error || 'Failed to start campaign',
                    loading: false
                })
                return { success: false, error: result.error || 'Failed to start campaign' }
            }
            set({
                status: {
                    running: true,
                    campaignId,
                    progress: 0,
                    message: 'Starting...'
                },
                loading: false
            })
            return { success: true }
        } catch (error) {
            set({
                status: {
                    running: false,
                    progress: 0,
                    message: error instanceof Error ? error.message : 'Failed to start'
                },
                error: error instanceof Error ? error.message : 'Failed to start campaign',
                loading: false
            })
            return { success: false, error: error instanceof Error ? error.message : 'Failed to start campaign' }
        }
    },

    stopCampaign: async () => {
        set({ loading: true })
        try {
            await window.electronAPI.automation.stopCampaign()
            set({
                status: { running: false, progress: 0, message: 'Stopped' },
                loading: false
            })
        } catch (error) {
            set({
                error: error instanceof Error ? error.message : 'Failed to stop campaign',
                loading: false
            })
        }
    },

    updateStatus: (partialStatus) => {
        set((state) => ({
            status: { ...state.status, ...partialStatus }
        }))
    },
}))

// Setup event listeners in the main component
export function setupAutomationListeners() {
    window.electronAPI.on('automation:status', (status: AutomationStatus) => {
        useAutomationStore.getState().updateStatus(status)
    })

    window.electronAPI.on('review:progress', (data: any) => {
        useAutomationStore.getState().updateStatus({
            currentAccount: data.accountId != null ? String(data.accountId) : undefined,
            currentLocation: data.locationId != null ? String(data.locationId) : undefined,
            progress: data.progress,
            message: data.message,
        })
    })
}
