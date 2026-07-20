import { ipcMain } from 'electron'
import {
    complianceApproveArgsSchema,
    complianceGetPendingReviewIntentsArgsSchema,
    complianceReconcileArgsSchema,
    complianceRejectArgsSchema,
} from '../../shared/compliance-contracts'
import {
    approveManualReviewSubmission,
    getPendingManualReviewSubmissionRequests,
    rejectManualReviewSubmission,
} from '../services/ComplianceService'
import { reviewService } from '../services/ReviewService'
import { parseIpcArgs, withIpcValidation } from './validate'

export function registerComplianceHandlers(): void {
    // --- Pre-submit manual approval (in-memory queue) ---
    ipcMain.handle(
        'compliance:getPendingReviewSubmissions',
        withIpcValidation('compliance:getPendingReviewSubmissions', async () => {
            return getPendingManualReviewSubmissionRequests()
        }),
    )

    ipcMain.handle(
        'compliance:approveReviewSubmission',
        withIpcValidation('compliance:approveReviewSubmission', async (_event, requestId: unknown) => {
            const [parsedId] = parseIpcArgs(
                'compliance:approveReviewSubmission',
                complianceApproveArgsSchema,
                [requestId],
            )
            // Unknown requestId still reaches service → { success: false, ... }
            return approveManualReviewSubmission(parsedId)
        }),
    )

    ipcMain.handle(
        'compliance:rejectReviewSubmission',
        withIpcValidation(
            'compliance:rejectReviewSubmission',
            async (_event, requestId: unknown, reason?: unknown) => {
                const [parsedId, parsedReason] = parseIpcArgs(
                    'compliance:rejectReviewSubmission',
                    complianceRejectArgsSchema,
                    [requestId, reason],
                )
                // Unknown requestId still reaches service → { success: false, ... }
                return rejectManualReviewSubmission(parsedId, parsedReason)
            },
        ),
    )

    // --- Durable review_history intent reconciliation (submitting/unconfirmed) ---
    // Distinct from pre-submit approve/reject above.
    ipcMain.handle(
        'compliance:getPendingReviewIntents',
        withIpcValidation('compliance:getPendingReviewIntents', async () => {
            parseIpcArgs(
                'compliance:getPendingReviewIntents',
                complianceGetPendingReviewIntentsArgsSchema,
                [],
            )
            return reviewService.getPendingReviewIntents()
        }),
    )

    ipcMain.handle(
        'compliance:reconcileReviewIntent',
        withIpcValidation(
            'compliance:reconcileReviewIntent',
            async (
                _event,
                historyId: unknown,
                outcome: unknown,
                note?: unknown,
            ) => {
                const [parsedId, parsedOutcome, parsedNote] = parseIpcArgs(
                    'compliance:reconcileReviewIntent',
                    complianceReconcileArgsSchema,
                    [historyId, outcome, note],
                )
                return reviewService.reconcileReviewIntent(
                    parsedId,
                    parsedOutcome,
                    parsedNote,
                )
            },
        ),
    )
}
