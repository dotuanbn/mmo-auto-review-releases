import type {
    ComplianceMutationResult,
    ComplianceResolvedPayload,
    PendingReviewSubmission,
} from './types'

interface ComplianceApi {
    getPendingReviewSubmissions: () => Promise<unknown>
    approveReviewSubmission: (requestId: string) => Promise<ComplianceMutationResult>
    rejectReviewSubmission: (
        requestId: string,
        reason?: string
    ) => Promise<ComplianceMutationResult>
    onReviewSubmissionPending: (
        callback: (payload: unknown) => void
    ) => () => void
    onReviewSubmissionResolved: (
        callback: (payload: unknown) => void
    ) => () => void
    onReviewSubmissionQueue: (
        callback: (payload: unknown) => void
    ) => () => void
}

interface ElectronApiWithCompliance {
    compliance?: ComplianceApi
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const n = Number(value)
        return Number.isFinite(n) ? n : undefined
    }
    return undefined
}

export function normalizePendingSubmission(raw: unknown): PendingReviewSubmission | null {
    const record = asRecord(raw)
    if (!record) {
        return null
    }
    const requestId = asString(record.requestId)
    const locationUrl = asString(record.locationUrl)
    const createdAt = asString(record.createdAt)
    const expiresAt = asString(record.expiresAt)
    const reason = asString(record.reason)
    if (!requestId || !locationUrl) {
        return null
    }
    return {
        requestId,
        createdAt,
        expiresAt,
        locationUrl,
        locationName: asOptionalString(record.locationName),
        accountEmail: asOptionalString(record.accountEmail),
        campaignId: asOptionalNumber(record.campaignId),
        threadId: asOptionalNumber(record.threadId),
        reason: reason || 'manual_confirm_required',
    }
}

export function normalizePendingQueue(raw: unknown): PendingReviewSubmission[] {
    if (!Array.isArray(raw)) {
        return []
    }
    const items: PendingReviewSubmission[] = []
    for (const entry of raw) {
        const item = normalizePendingSubmission(entry)
        if (item) {
            items.push(item)
        }
    }
    return items
}

export function normalizeResolvedPayload(raw: unknown): ComplianceResolvedPayload | null {
    const record = asRecord(raw)
    if (!record) {
        return null
    }
    const requestId = asString(record.requestId)
    if (!requestId) {
        return null
    }
    return {
        requestId,
        approved: typeof record.approved === 'boolean' ? record.approved : undefined,
        reason: asOptionalString(record.reason),
    }
}

export function getComplianceApi(): ComplianceApi | null {
    if (typeof window === 'undefined') {
        return null
    }
    const api = (window as Window & { electronAPI?: ElectronApiWithCompliance }).electronAPI
    if (
        !api?.compliance?.getPendingReviewSubmissions ||
        !api.compliance.approveReviewSubmission ||
        !api.compliance.rejectReviewSubmission
    ) {
        return null
    }
    return api.compliance
}

export async function fetchPendingSubmissions(): Promise<PendingReviewSubmission[]> {
    const api = getComplianceApi()
    if (!api) {
        throw new Error('compliance API unavailable')
    }
    const raw = await api.getPendingReviewSubmissions()
    return normalizePendingQueue(raw)
}

export async function approveSubmission(requestId: string): Promise<ComplianceMutationResult> {
    const api = getComplianceApi()
    if (!api) {
        return { success: false, message: 'compliance API unavailable' }
    }
    return api.approveReviewSubmission(requestId)
}

export async function rejectSubmission(
    requestId: string,
    reason = 'rejected_by_user'
): Promise<ComplianceMutationResult> {
    const api = getComplianceApi()
    if (!api) {
        return { success: false, message: 'compliance API unavailable' }
    }
    return api.rejectReviewSubmission(requestId, reason)
}

export function subscribeComplianceQueue(handlers: {
    onQueue?: (queue: PendingReviewSubmission[]) => void
    onPending?: (item: PendingReviewSubmission) => void
    onResolved?: (payload: ComplianceResolvedPayload) => void
}): () => void {
    const api = getComplianceApi()
    if (!api) {
        return () => undefined
    }

    const unsubs: Array<() => void> = []

    if (handlers.onQueue && typeof api.onReviewSubmissionQueue === 'function') {
        unsubs.push(
            api.onReviewSubmissionQueue((payload) => {
                handlers.onQueue?.(normalizePendingQueue(payload))
            })
        )
    }

    if (handlers.onPending && typeof api.onReviewSubmissionPending === 'function') {
        unsubs.push(
            api.onReviewSubmissionPending((payload) => {
                const item = normalizePendingSubmission(payload)
                if (item) {
                    handlers.onPending?.(item)
                }
            })
        )
    }

    if (handlers.onResolved && typeof api.onReviewSubmissionResolved === 'function') {
        unsubs.push(
            api.onReviewSubmissionResolved((payload) => {
                const resolved = normalizeResolvedPayload(payload)
                if (resolved) {
                    handlers.onResolved?.(resolved)
                }
            })
        )
    }

    return () => {
        for (const unsub of unsubs) {
            try {
                unsub()
            } catch {
                // ignore teardown errors
            }
        }
    }
}

export function formatComplianceTimestamp(value: string, locale = 'vi-VN'): string {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) {
        return value
    }
    return d.toLocaleString(locale)
}
