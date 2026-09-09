import { create } from 'zustand'
import {
    fproxyPoolSnapshotSchema,
    type FProxyAddSlotInput,
    type FProxyPoolPolicy,
    type FProxyPoolSnapshotDto,
} from '../../../shared/fproxy-pool-contracts'

type SlotAction = 'testing' | 'removing' | 'toggling'

export type FProxyPoolErrorCode =
    | 'api_unavailable'
    | 'duplicate_slot'
    | 'slot_in_use'
    | 'invalid_key'
    | 'request_failed'

interface FProxyPoolApi {
    getSnapshot?: () => Promise<unknown>
    addSlot?: (input: FProxyAddSlotInput) => Promise<unknown>
    removeSlot?: (id: number) => Promise<unknown>
    setEnabled?: (id: number, enabled: boolean) => Promise<unknown>
    updatePolicy?: (input: FProxyPoolPolicy) => Promise<unknown>
    testSlot?: (id: number) => Promise<unknown>
    testAll?: () => Promise<unknown>
    refreshAll?: () => Promise<unknown>
    onSnapshot?: (callback: (snapshot: FProxyPoolSnapshotDto) => void) => () => void
}

interface FProxyPoolStore {
    snapshot: FProxyPoolSnapshotDto | null
    loading: boolean
    adding: boolean
    testingAll: boolean
    policySaving: boolean
    error: FProxyPoolErrorCode | null
    actionBySlot: Record<number, SlotAction | undefined>
    lastLoadedAt: number | null

    load: () => Promise<boolean>
    addSlots: (drafts: FProxyAddSlotInput[]) => Promise<{ added: number; failed: number }>
    removeSlot: (id: number) => Promise<boolean>
    setEnabled: (id: number, enabled: boolean) => Promise<boolean>
    updatePolicy: (policy: FProxyPoolPolicy) => Promise<boolean>
    testSlot: (id: number) => Promise<boolean>
    testAll: () => Promise<boolean>
    refreshAll: () => Promise<boolean>
    subscribe: () => () => void
    clearError: () => void
}

function getPoolApi(): FProxyPoolApi | null {
    if (typeof window === 'undefined' || !window.electronAPI) {
        return null
    }
    return (window.electronAPI as unknown as { fproxyPool?: FProxyPoolApi }).fproxyPool || null
}

function classifyError(error: unknown): FProxyPoolErrorCode {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('duplicate')) return 'duplicate_slot'
    if (message.includes('in_use') || message.includes('in use') || message.includes('leased')) {
        return 'slot_in_use'
    }
    if (message.includes('invalid') && message.includes('key')) return 'invalid_key'
    return 'request_failed'
}

function parseSnapshot(value: unknown): FProxyPoolSnapshotDto | null {
    const parsed = fproxyPoolSnapshotSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

function keepNewestSnapshot(
    current: FProxyPoolSnapshotDto | null,
    incoming: FProxyPoolSnapshotDto,
): FProxyPoolSnapshotDto {
    return !current || incoming.revision >= current.revision ? incoming : current
}

async function fetchSnapshot(api: FProxyPoolApi): Promise<FProxyPoolSnapshotDto | null> {
    if (!api.getSnapshot) return null
    return parseSnapshot(await api.getSnapshot())
}

export function getFProxyPoolServerOffset(snapshot: FProxyPoolSnapshotDto | null): number {
    if (!snapshot) return 0
    return snapshot.serverNow - Date.now()
}

export function getFProxyCooldownSeconds(
    cooldownUntil: number | null,
    serverOffsetMs: number,
    clientNow = Date.now(),
): number {
    if (cooldownUntil === null) return 0
    return Math.max(0, Math.ceil((cooldownUntil - (clientNow + serverOffsetMs)) / 1000))
}

/** Seconds remaining until an absolute provider deadline (time_die / waiting_time). */
export function getFProxyRemainingSeconds(
    deadlineAt: number | null | undefined,
    serverOffsetMs: number,
    clientNow = Date.now(),
): number {
    if (deadlineAt == null || !Number.isFinite(deadlineAt)) return 0
    return Math.max(0, Math.ceil((deadlineAt - (clientNow + serverOffsetMs)) / 1000))
}

export function formatFProxyCountdown(seconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(safeSeconds / 3600)
    const minutes = Math.floor((safeSeconds % 3600) / 60)
    const remainder = safeSeconds % 60
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    }
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export const useFProxyPoolStore = create<FProxyPoolStore>((set, get) => {
    const applySnapshot = (snapshot: FProxyPoolSnapshotDto) => {
        set(state => ({
            snapshot: keepNewestSnapshot(state.snapshot, snapshot),
            lastLoadedAt: Date.now(),
        }))
    }

    const refresh = async (api: FProxyPoolApi, response?: unknown): Promise<boolean> => {
        const direct = parseSnapshot(response)
        const snapshot = direct || await fetchSnapshot(api)
        if (!snapshot) return false
        applySnapshot(snapshot)
        return true
    }

    const setSlotAction = (id: number, action?: SlotAction) => {
        set(state => ({
            actionBySlot: {
                ...state.actionBySlot,
                [id]: action,
            },
        }))
    }

    return {
        snapshot: null,
        loading: false,
        adding: false,
        testingAll: false,
        policySaving: false,
        error: null,
        actionBySlot: {},
        lastLoadedAt: null,

        load: async () => {
            const api = getPoolApi()
            if (!api?.getSnapshot) {
                set({ loading: false, error: 'api_unavailable' })
                return false
            }
            set({ loading: true, error: null })
            try {
                const snapshot = await fetchSnapshot(api)
                if (!snapshot) throw new Error('Invalid FProxy pool snapshot')
                applySnapshot(snapshot)
                set({ loading: false })
                return true
            } catch (error) {
                set({ loading: false, error: classifyError(error) })
                return false
            }
        },

        async refreshAll() {
            const api = getPoolApi()
            if (!api?.refreshAll) return get().load()
            set({ loading: true })
            try {
                const raw = await api.refreshAll()
                const incoming = parseSnapshot(raw)
                if (!incoming) {
                    set({ loading: false, error: 'request_failed' })
                    return false
                }
                set(state => ({
                    snapshot: keepNewestSnapshot(state.snapshot, incoming),
                    loading: false,
                    error: null,
                    lastLoadedAt: Date.now(),
                }))
                return true
            } catch (error) {
                set({ loading: false, error: classifyError(error) })
                return false
            }
        },

        addSlots: async (drafts) => {
            const api = getPoolApi()
            if (!api?.addSlot) {
                set({ adding: false, error: 'api_unavailable' })
                return { added: 0, failed: drafts.length }
            }

            set({ adding: true, error: null })
            let added = 0
            let failed = 0
            let lastError: FProxyPoolErrorCode | null = null

            for (const draft of drafts) {
                try {
                    const response = await api.addSlot(draft)
                    await refresh(api, response)
                    added += 1
                } catch (error) {
                    failed += 1
                    lastError = classifyError(error)
                }
            }

            if (added > 0) await get().load()
            set({ adding: false, error: lastError })
            return { added, failed }
        },

        removeSlot: async (id) => {
            const api = getPoolApi()
            if (!api?.removeSlot) {
                set({ error: 'api_unavailable' })
                return false
            }
            setSlotAction(id, 'removing')
            set({ error: null })
            try {
                const response = await api.removeSlot(id)
                await refresh(api, response)
                return true
            } catch (error) {
                set({ error: classifyError(error) })
                return false
            } finally {
                setSlotAction(id)
            }
        },

        setEnabled: async (id, enabled) => {
            const api = getPoolApi()
            if (!api?.setEnabled) {
                set({ error: 'api_unavailable' })
                return false
            }
            setSlotAction(id, 'toggling')
            set({ error: null })
            try {
                const response = await api.setEnabled(id, enabled)
                await refresh(api, response)
                return true
            } catch (error) {
                set({ error: classifyError(error) })
                return false
            } finally {
                setSlotAction(id)
            }
        },

        updatePolicy: async (policy) => {
            const api = getPoolApi()
            if (!api?.updatePolicy) {
                set({ error: 'api_unavailable' })
                return false
            }
            set({ policySaving: true, error: null })
            try {
                const response = await api.updatePolicy(policy)
                await refresh(api, response)
                return true
            } catch (error) {
                set({ error: classifyError(error) })
                return false
            } finally {
                set({ policySaving: false })
            }
        },

        testSlot: async (id) => {
            const api = getPoolApi()
            if (!api?.testSlot) {
                set({ error: 'api_unavailable' })
                return false
            }
            setSlotAction(id, 'testing')
            set({ error: null })
            try {
                const response = await api.testSlot(id)
                await refresh(api, response)
                return true
            } catch (error) {
                set({ error: classifyError(error) })
                return false
            } finally {
                setSlotAction(id)
            }
        },

        testAll: async () => {
            const api = getPoolApi()
            if (!api?.testAll) {
                set({ error: 'api_unavailable' })
                return false
            }
            set({ testingAll: true, error: null })
            try {
                const response = await api.testAll()
                await refresh(api, response)
                return true
            } catch (error) {
                set({ error: classifyError(error) })
                return false
            } finally {
                set({ testingAll: false })
            }
        },

        subscribe: () => {
            const api = getPoolApi()
            if (!api?.onSnapshot) return () => undefined
            return api.onSnapshot(snapshot => {
                const parsed = parseSnapshot(snapshot)
                if (parsed) applySnapshot(parsed)
            })
        },

        clearError: () => set({ error: null }),
    }
})
