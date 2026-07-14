/**
 * Compliance IPC contracts — manual review submission approve/reject boundary
 * plus durable review_history intent reconciliation (submitting/unconfirmed).
 * Schemas are pure (no Electron); handlers validate before calling services.
 *
 * Unknown-but-well-formed requestIds still reach the service so it can return
 * its own failure payload ({ success: false, message: 'Request not found...' }).
 */

import { z } from 'zod'
import { boundedString, idSchema } from './ipc-schemas'

/** Max length for compliance requestId (e.g. manual-submit-<ts>-<rand>). */
export const COMPLIANCE_REQUEST_ID_MAX = 128

/** Max length for optional reject reason free-text. */
export const COMPLIANCE_REJECT_REASON_MAX = 1000

/** Max length for optional manual reconcile operator note. */
export const COMPLIANCE_RECONCILE_NOTE_MAX = 1000

/** Max chars of review text preview on pending intent DTOs. */
export const PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX = 160

/** Non-empty trimmed requestId used by approve/reject. */
export const complianceRequestIdSchema = boundedString(COMPLIANCE_REQUEST_ID_MAX)

/**
 * Optional reject reason — when present must be a bounded string.
 * Empty / whitespace-only is accepted after trim (service may still default).
 */
export const complianceRejectReasonSchema = z
    .string()
    .trim()
    .max(COMPLIANCE_REJECT_REASON_MAX)

/** approveReviewSubmission(requestId) */
export const complianceApproveArgsSchema = z.tuple([complianceRequestIdSchema])

/** rejectReviewSubmission(requestId, reason?) */
export const complianceRejectArgsSchema = z.tuple([
    complianceRequestIdSchema,
    complianceRejectReasonSchema.optional(),
])

// ---------------------------------------------------------------------------
// Manual reconciliation of durable review_history intents
// (distinct from pre-submit compliance approve/reject)
// ---------------------------------------------------------------------------

/** review_history.id — positive integer. */
export const complianceHistoryIdSchema = idSchema

/**
 * Operator outcomes for submitting/unconfirmed rows:
 * - confirmed_success → history status success (counts as posted; blocks re-post)
 * - confirmed_not_posted → history status failed (clears block; permits retry)
 */
export const reviewReconcileOutcomeSchema = z.enum([
    'confirmed_success',
    'confirmed_not_posted',
])

/** Optional operator note — bounded; empty/whitespace allowed after trim. */
export const complianceReconcileNoteSchema = z
    .string()
    .trim()
    .max(COMPLIANCE_RECONCILE_NOTE_MAX)

/**
 * reconcileReviewIntent(historyId, outcome, note?)
 * historyId must be a positive int; outcome is a closed enum.
 */
export const complianceReconcileArgsSchema = z.tuple([
    complianceHistoryIdSchema,
    reviewReconcileOutcomeSchema,
    complianceReconcileNoteSchema.optional(),
])

/** getPendingReviewIntents() — no payload. */
export const complianceGetPendingReviewIntentsArgsSchema = z.tuple([])

/** Result of approve / reject IPC mutations. */
export interface ComplianceMutationResult {
    success: boolean
    message: string
}

/** Blocking durable intent statuses eligible for manual reconcile. */
export type PendingReviewIntentStatus = 'submitting' | 'unconfirmed'

export type ReviewReconcileOutcome = z.infer<typeof reviewReconcileOutcomeSchema>

/**
 * Public DTO for a durable review_history row awaiting operator reconciliation.
 * Secrets are never included (no password/cookies/2FA/screenshot).
 * Review body is preview-only (bounded by PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX).
 */
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

/** Result of reconcileReviewIntent IPC mutation. */
export interface ReviewIntentReconcileResult {
    success: boolean
    message: string
    historyId: number
    previousStatus?: string
    newStatus?: 'success' | 'failed'
}

export type ComplianceRequestId = z.infer<typeof complianceRequestIdSchema>
export type ComplianceRejectReason = z.infer<typeof complianceRejectReasonSchema>
export type ComplianceReconcileNote = z.infer<typeof complianceReconcileNoteSchema>
export type ComplianceHistoryId = z.infer<typeof complianceHistoryIdSchema>
