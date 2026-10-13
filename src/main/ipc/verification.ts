/**
 * Review verification worker IPC.
 * Self-registers on import, same pattern as dashboard.ts (`import './verification'`).
 *
 * Channels:
 *   verification:start  — start only when enableReviewVerification is exactly true
 *   verification:stop
 *   verification:status → { running }
 */
import { ipcMain } from 'electron'
import { reviewVerificationWorker } from '../services/ReviewVerificationWorker'
import { loadSettings } from './settings'

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function verificationEnabled(): boolean {
    const settings = loadSettings()
    return settings.enableReviewVerification === true
}

ipcMain.handle('verification:start', () => {
    try {
        if (verificationEnabled()) {
            reviewVerificationWorker.start()
        }
    } catch (error: unknown) {
        console.error(`[ReviewVerifier] start failed: ${errorMessage(error)}`)
    }
    return { running: reviewVerificationWorker.isRunning() }
})

ipcMain.handle('verification:stop', () => {
    try {
        reviewVerificationWorker.stop()
    } catch (error: unknown) {
        console.error(`[ReviewVerifier] stop failed: ${errorMessage(error)}`)
    }
    return { running: reviewVerificationWorker.isRunning() }
})

ipcMain.handle('verification:status', () => {
    return { running: reviewVerificationWorker.isRunning() }
})
