/**
 * Compliance IPC contracts — manual review submission approve/reject boundary.
 * Schemas are pure (no Electron); handlers validate before calling ComplianceService.
 *
 * Unknown-but-well-formed requestIds still reach the service so it can return
 * its own failure payload ({ success: false, message: 'Request not found...' }).
 */

import { z } from 'zod'
import { boundedString } from './ipc-schemas'

/** Max length for compliance requestId (e.g. manual-submit-<ts>-<rand>). */
export const COMPLIANCE_REQUEST_ID_MAX = 128

/** Max length for optional reject reason free-text. */
export const COMPLIANCE_REJECT_REASON_MAX = 1000

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

/** Result of approve / reject IPC mutations. */
export interface ComplianceMutationResult {
    success: boolean
    message: string
}

export type ComplianceRequestId = z.infer<typeof complianceRequestIdSchema>
export type ComplianceRejectReason = z.infer<typeof complianceRejectReasonSchema>
