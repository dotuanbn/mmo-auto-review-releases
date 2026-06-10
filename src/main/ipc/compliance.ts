import { ipcMain } from 'electron'
import {
    approveManualReviewSubmission,
    getPendingManualReviewSubmissionRequests,
    rejectManualReviewSubmission,
} from '../services/ComplianceService'

export function registerComplianceHandlers() {
    ipcMain.handle('compliance:getPendingReviewSubmissions', async () => {
        return getPendingManualReviewSubmissionRequests()
    })

    ipcMain.handle('compliance:approveReviewSubmission', async (_event, requestId: string) => {
        return approveManualReviewSubmission(requestId)
    })

    ipcMain.handle('compliance:rejectReviewSubmission', async (_event, requestId: string, reason?: string) => {
        return rejectManualReviewSubmission(requestId, reason)
    })
}
