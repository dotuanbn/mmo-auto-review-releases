import { useCallback, useEffect, useRef, useState } from 'react'
import {
    approveSubmission,
    fetchPendingSubmissions,
    rejectSubmission,
    subscribeComplianceQueue,
} from './api'
import type { PendingReviewSubmission } from './types'
import { COMPLIANCE_POLL_MS } from './types'

interface UseComplianceQueueOptions {
    /** Enable bounded poll fallback (default true). */
    poll?: boolean
    pollMs?: number
}

interface UseComplianceQueueResult {
    pending: PendingReviewSubmission[]
    count: number
    loading: boolean
    error: string | null
    actingId: string | null
    refresh: () => Promise<void>
    approve: (requestId: string) => Promise<boolean>
    reject: (requestId: string, reason?: string) => Promise<boolean>
}

export function useComplianceQueue(
    options: UseComplianceQueueOptions = {}
): UseComplianceQueueResult {
    const { poll = true, pollMs = COMPLIANCE_POLL_MS } = options
    const [pending, setPending] = useState<PendingReviewSubmission[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [actingId, setActingId] = useState<string | null>(null)
    const mountedRef = useRef(true)

    const refresh = useCallback(async () => {
        try {
            const queue = await fetchPendingSubmissions()
            if (mountedRef.current) {
                setPending(queue)
                setError(null)
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to load compliance queue')
            }
        } finally {
            if (mountedRef.current) {
                setLoading(false)
            }
        }
    }, [])

    useEffect(() => {
        mountedRef.current = true
        void refresh()

        const unsubscribe = subscribeComplianceQueue({
            onQueue: (queue) => {
                if (mountedRef.current) {
                    setPending(queue)
                    setLoading(false)
                }
            },
            onPending: (item) => {
                if (!mountedRef.current) {
                    return
                }
                setPending((prev) => {
                    if (prev.some((row) => row.requestId === item.requestId)) {
                        return prev
                    }
                    return [item, ...prev]
                })
                setLoading(false)
            },
            onResolved: (payload) => {
                if (!mountedRef.current) {
                    return
                }
                setPending((prev) => prev.filter((row) => row.requestId !== payload.requestId))
            },
        })

        let intervalId: ReturnType<typeof setInterval> | null = null
        if (poll && pollMs > 0) {
            intervalId = setInterval(() => {
                void refresh()
            }, pollMs)
        }

        return () => {
            mountedRef.current = false
            unsubscribe()
            if (intervalId) {
                clearInterval(intervalId)
            }
        }
    }, [poll, pollMs, refresh])

    const approve = useCallback(
        async (requestId: string): Promise<boolean> => {
            setActingId(requestId)
            try {
                const result = await approveSubmission(requestId)
                if (result.success) {
                    setPending((prev) => prev.filter((row) => row.requestId !== requestId))
                    return true
                }
                setError(result.message || 'Approve failed')
                return false
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Approve failed')
                return false
            } finally {
                setActingId(null)
            }
        },
        []
    )

    const reject = useCallback(
        async (requestId: string, reason = 'rejected_by_user'): Promise<boolean> => {
            setActingId(requestId)
            try {
                const result = await rejectSubmission(requestId, reason)
                if (result.success) {
                    setPending((prev) => prev.filter((row) => row.requestId !== requestId))
                    return true
                }
                setError(result.message || 'Reject failed')
                return false
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Reject failed')
                return false
            } finally {
                setActingId(null)
            }
        },
        []
    )

    return {
        pending,
        count: pending.length,
        loading,
        error,
        actingId,
        refresh,
        approve,
        reject,
    }
}
