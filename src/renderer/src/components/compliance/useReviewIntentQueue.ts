import { useCallback, useEffect, useRef, useState } from 'react'
import {
    fetchPendingReviewIntents,
    hasReviewIntentApi,
    reconcileReviewIntent,
} from './api'
import type { PendingReviewIntent, ReviewReconcileOutcome } from './types'
import { REVIEW_INTENT_POLL_MS } from './types'

interface UseReviewIntentQueueOptions {
    poll?: boolean
    pollMs?: number
}

interface UseReviewIntentQueueResult {
    intents: PendingReviewIntent[]
    count: number
    loading: boolean
    refreshing: boolean
    error: string | null
    actingId: number | null
    available: boolean
    refresh: () => Promise<void>
    reconcile: (
        historyId: number,
        outcome: ReviewReconcileOutcome,
        note?: string
    ) => Promise<boolean>
}

type RefreshMode = 'initial' | 'poll' | 'manual'

export function useReviewIntentQueue(
    options: UseReviewIntentQueueOptions = {}
): UseReviewIntentQueueResult {
    const { poll = true, pollMs = REVIEW_INTENT_POLL_MS } = options
    const [intents, setIntents] = useState<PendingReviewIntent[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [actingId, setActingId] = useState<number | null>(null)
    const [available, setAvailable] = useState(true)
    const mountedRef = useRef(true)

    const refresh = useCallback(async (mode: RefreshMode = 'manual') => {
        if (!hasReviewIntentApi()) {
            if (mountedRef.current) {
                setAvailable(false)
                setIntents([])
                setError(null)
                setLoading(false)
                setRefreshing(false)
            }
            return
        }
        if (mountedRef.current) {
            if (mode === 'initial') setLoading(true)
            if (mode === 'manual') setRefreshing(true)
        }
        try {
            const queue = await fetchPendingReviewIntents()
            if (mountedRef.current) {
                setAvailable(true)
                setIntents(queue)
                setError(null)
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load review intents'
                )
            }
        } finally {
            if (mountedRef.current) {
                setLoading(false)
                setRefreshing(false)
            }
        }
    }, [])

    useEffect(() => {
        mountedRef.current = true
        void refresh('initial')

        let intervalId: ReturnType<typeof setInterval> | null = null
        if (poll && pollMs > 0) {
            intervalId = setInterval(() => {
                void refresh('poll')
            }, pollMs)
        }

        return () => {
            mountedRef.current = false
            if (intervalId) {
                clearInterval(intervalId)
            }
        }
    }, [poll, pollMs, refresh])

    const reconcile = useCallback(
        async (
            historyId: number,
            outcome: ReviewReconcileOutcome,
            note?: string
        ): Promise<boolean> => {
            setActingId(historyId)
            try {
                const result = await reconcileReviewIntent(historyId, outcome, note)
                if (result.success) {
                    setIntents((prev) =>
                        prev.filter((row) => row.historyId !== historyId)
                    )
                    setError(null)
                    return true
                }
                setError(result.message || 'Reconcile failed')
                // Stale/race: refresh so UI drops non-reconcilable rows.
                void refresh('poll')
                return false
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Reconcile failed')
                return false
            } finally {
                setActingId(null)
            }
        },
        [refresh]
    )

    const manualRefresh = useCallback(async () => {
        await refresh('manual')
    }, [refresh])

    return {
        intents,
        count: intents.length,
        loading,
        refreshing,
        error,
        actingId,
        available,
        refresh: manualRefresh,
        reconcile,
    }
}
