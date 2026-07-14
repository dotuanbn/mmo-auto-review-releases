/** Public pending review submission from ComplianceService (pre-submit). */
export interface PendingReviewSubmission {
    requestId: string
    createdAt: string
    expiresAt: string
    locationUrl: string
    locationName?: string
    accountEmail?: string
    campaignId?: number
    threadId?: number
    reason: string
}

export interface ComplianceMutationResult {
    success: boolean
    message: string
}

export interface ComplianceResolvedPayload {
    requestId: string
    approved?: boolean
    reason?: string
}

/** Durable review_history intent awaiting operator reconciliation. */
export type PendingReviewIntentStatus = 'submitting' | 'unconfirmed'

export type ReviewReconcileOutcome = 'confirmed_success' | 'confirmed_not_posted'

export interface PendingReviewIntent {
    historyId: number
    status: PendingReviewIntentStatus
    accountId: number
    locationId: number
    campaignId: number | null
    rating: number
    reviewTextPreview: string
    errorMessage: string | null
    createdAt: string
    accountEmail?: string
    locationName?: string
    locationUrl?: string
}

export interface ReviewIntentReconcileResult {
    success: boolean
    message: string
    historyId: number
    previousStatus?: string
    newStatus?: 'success' | 'failed'
}

/** Bounded poll interval (ms) when events may be missed. */
export const COMPLIANCE_POLL_MS = 60_000

/** Poll for durable reconcile queue (no push events yet). */
export const REVIEW_INTENT_POLL_MS = 30_000

/** Max items shown in compact AppShell banner. */
export const COMPLIANCE_BANNER_MAX = 3

/** Max items shown on Campaigns panel. */
export const COMPLIANCE_PANEL_MAX = 8

/** Max durable intents shown on Campaigns reconcile panel. */
export const REVIEW_INTENT_PANEL_MAX = 12
