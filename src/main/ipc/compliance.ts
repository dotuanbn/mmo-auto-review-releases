import { ipcMain } from 'electron'
import {
    complianceApproveArgsSchema,
    complianceRejectArgsSchema,
} from '../../shared/compliance-contracts'
import {
    approveManualReviewSubmission,
    getPendingManualReviewSubmissionRequests,
    rejectManualReviewSubmission,
} from '../services/ComplianceService'
import { parseIpcArgs, withIpcValidation } from './validate'

export function registerComplianceHandlers(): void {
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
}
