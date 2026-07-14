import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTrafficAuditBundle } from './api'
import { selectSampleLogs } from './sampleLogs'
import type { AuditLoadState, TrafficAuditReport, TrafficAuditSnapshot, TrafficLogRow } from './types'

const CACHE_TTL_MS = 12_000
const MIN_FORCE_REFRESH_GAP_MS = 4_000

interface CacheEntry {
    snapshot: TrafficAuditSnapshot
    storedAt: number
}

interface UseTrafficAuditDataOptions {
    campaignId: number | null
    /** When false, skip auto-fetch (e.g. inactive tab). Default true. */
    enabled?: boolean
}

interface UseTrafficAuditDataResult {
    state: AuditLoadState
    audit: TrafficAuditReport | null
    sampleLogs: TrafficLogRow[]
    totalLogCount: number
    errorMessage: string | null
    isRefreshing: boolean
    lastFetchedAt: number | null
    refresh: (force?: boolean) => Promise<void>
}

function buildSnapshot(
    campaignId: number,
    audit: TrafficAuditReport | null,
    logs: TrafficLogRow[]
): TrafficAuditSnapshot {
    return {
        campaignId,
        audit,
        sampleLogs: selectSampleLogs(logs),
        totalLogCount: logs.length,
        fetchedAt: Date.now(),
    }
}

function resolveState(snapshot: TrafficAuditSnapshot | null): AuditLoadState {
    if (!snapshot) {
        return 'idle'
    }
    const hasAudit = snapshot.audit !== null
    const hasLogs = snapshot.totalLogCount > 0
    if (!hasAudit && !hasLogs) {
        return 'empty'
    }
    return 'ready'
}

/**
 * Loads getAudit + getLogs once per campaign (Promise.all), caches briefly,
 * and ignores stale responses so refresh never N+1s or races the UI.
 */
export function useTrafficAuditData({
    campaignId,
    enabled = true,
}: UseTrafficAuditDataOptions): UseTrafficAuditDataResult {
    const [state, setState] = useState<AuditLoadState>('idle')
    const [audit, setAudit] = useState<TrafficAuditReport | null>(null)
    const [sampleLogs, setSampleLogs] = useState<TrafficLogRow[]>([])
    const [totalLogCount, setTotalLogCount] = useState(0)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

    const cacheRef = useRef<Map<number, CacheEntry>>(new Map())
    const requestSeqRef = useRef(0)
    const lastForceAtRef = useRef(0)
    const inFlightRef = useRef(false)

    const applySnapshot = useCallback((snapshot: TrafficAuditSnapshot) => {
        setAudit(snapshot.audit)
        setSampleLogs(snapshot.sampleLogs)
        setTotalLogCount(snapshot.totalLogCount)
        setLastFetchedAt(snapshot.fetchedAt)
        setErrorMessage(null)
        setState(resolveState(snapshot))
    }, [])

    const clearView = useCallback(() => {
        setAudit(null)
        setSampleLogs([])
        setTotalLogCount(0)
        setLastFetchedAt(null)
        setErrorMessage(null)
        setState('idle')
        setIsRefreshing(false)
    }, [])

    const load = useCallback(async (targetId: number, force: boolean) => {
        const cached = cacheRef.current.get(targetId)
        const now = Date.now()

        if (!force && cached && now - cached.storedAt < CACHE_TTL_MS) {
            applySnapshot(cached.snapshot)
            return
        }

        if (force && now - lastForceAtRef.current < MIN_FORCE_REFRESH_GAP_MS) {
            if (cached) {
                applySnapshot(cached.snapshot)
            }
            return
        }

        if (inFlightRef.current && !force) {
            return
        }

        const seq = ++requestSeqRef.current
        inFlightRef.current = true
        setIsRefreshing(true)
        if (!cached) {
            setState('loading')
        }
        setErrorMessage(null)

        if (force) {
            lastForceAtRef.current = now
        }

        try {
            const { audit: nextAudit, logs } = await fetchTrafficAuditBundle(targetId)
            if (seq !== requestSeqRef.current) {
                return
            }

            const snapshot = buildSnapshot(targetId, nextAudit, logs)
            cacheRef.current.set(targetId, { snapshot, storedAt: Date.now() })
            // Keep cache small: drop oldest if map grows
            if (cacheRef.current.size > 8) {
                const oldestKey = cacheRef.current.keys().next().value
                if (typeof oldestKey === 'number') {
                    cacheRef.current.delete(oldestKey)
                }
            }
            applySnapshot(snapshot)
        } catch (err) {
            if (seq !== requestSeqRef.current) {
                return
            }
            const message = err instanceof Error ? err.message : 'Failed to load audit'
            if (cached) {
                applySnapshot(cached.snapshot)
                setErrorMessage(message)
            } else {
                setAudit(null)
                setSampleLogs([])
                setTotalLogCount(0)
                setLastFetchedAt(null)
                setErrorMessage(message)
                setState('error')
            }
        } finally {
            if (seq === requestSeqRef.current) {
                inFlightRef.current = false
                setIsRefreshing(false)
            }
        }
    }, [applySnapshot])

    const refresh = useCallback(async (force = true) => {
        if (!campaignId || !enabled) {
            return
        }
        await load(campaignId, force)
    }, [campaignId, enabled, load])

    useEffect(() => {
        if (!enabled || !campaignId || campaignId <= 0) {
            requestSeqRef.current += 1
            inFlightRef.current = false
            clearView()
            return
        }

        void load(campaignId, false)

        return () => {
            requestSeqRef.current += 1
            inFlightRef.current = false
        }
    }, [campaignId, enabled, load, clearView])

    return {
        state,
        audit,
        sampleLogs,
        totalLogCount,
        errorMessage,
        isRefreshing,
        lastFetchedAt,
        refresh,
    }
}
