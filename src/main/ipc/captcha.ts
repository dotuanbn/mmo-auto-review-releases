/**
 * CAPTCHA metrics IPC handlers.
 * Channels (exact):
 *   captcha:getMetrics() → CaptchaMetricsSnapshot
 *   captcha:resetMetrics() → CaptchaMetricsResetResult
 *
 * Public DTOs never include secrets/tokens/API keys.
 */

import { ipcMain } from 'electron'
import { withIpcValidation } from './validate'
import { captchaMetricsService } from '../services/CaptchaMetricsService'
import type {
    CaptchaMetricsResetResult,
    CaptchaMetricsSnapshot,
} from '../../shared/captcha-metrics-contracts'

export function registerCaptchaHandlers(): void {
    ipcMain.handle(
        'captcha:getMetrics',
        withIpcValidation('captcha:getMetrics', async (): Promise<CaptchaMetricsSnapshot> => {
            return captchaMetricsService.getMetrics()
        }),
    )

    ipcMain.handle(
        'captcha:resetMetrics',
        withIpcValidation(
            'captcha:resetMetrics',
            async (): Promise<CaptchaMetricsResetResult> => {
                return captchaMetricsService.resetMetrics()
            },
        ),
    )

    console.log('Captcha metrics handlers registered')
}
