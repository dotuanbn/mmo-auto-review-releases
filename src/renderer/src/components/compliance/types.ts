/** Public pending review submission from ComplianceService. */
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

/** Bounded poll interval (ms) when events may be missed. */
export const COMPLIANCE_POLL_MS = 60_000

/** Max items shown in compact AppShell banner. */
export const COMPLIANCE_BANNER_MAX = 3

/** Max items shown on Campaigns panel. */
export const COMPLIANCE_PANEL_MAX = 8
