/**
 * CAPTCHA metrics IPC contracts — public DTOs only.
 * Never carries secrets, API keys, tokens, sitekeys, or full page URLs.
 */

/** Supported CAPTCHA widget types (aligned with CaptchaSolverService). */
export type CaptchaMetricType =
    | 'recaptchav2'
    | 'recaptchav3'
    | 'hcaptcha'
    | 'turnstile'
    | 'image-grid'
    | 'unknown'

/** Solver provider labels (no API keys). */
export type CaptchaMetricProvider =
    | 'none'
    | '2captcha'
    | 'capsolver'
    | 'local-ai'
    | 'unknown'

/** Aggregated counters for a single slice (total / byType / byProvider). */
export interface CaptchaMetricsTotals {
    attempts: number
    successes: number
    failures: number
}

/** Per-type or per-provider breakdown bucket. */
export interface CaptchaMetricsBucket extends CaptchaMetricsTotals {
    successRate: number
    averageDurationMs: number
}

/**
 * One recent solve attempt for the dashboard list.
 * Intentionally omits tokens, sitekeys, URLs, and API keys.
 */
export interface CaptchaRecentAttempt {
    id: number
    captchaType: CaptchaMetricType
    provider: CaptchaMetricProvider
    success: boolean
    durationMs: number
    retryCount: number
    /** Short machine-safe error code/message; never a secret. */
    errorCode: string | null
    /** ISO-8601 timestamp */
    createdAt: string
}

/**
 * Snapshot returned by captcha:getMetrics.
 * Bound `recentAttempts` server-side (see CaptchaMetricsService).
 */
export interface CaptchaMetricsSnapshot {
    totals: CaptchaMetricsTotals
    successRate: number
    averageDurationMs: number
    byType: Record<string, CaptchaMetricsBucket>
    byProvider: Record<string, CaptchaMetricsBucket>
    recentAttempts: CaptchaRecentAttempt[]
}

/** Input for recording one attempt (main-process only; never from renderer raw). */
export interface CaptchaAttemptRecordInput {
    captchaType: string
    provider: string
    success: boolean
    durationMs: number
    retryCount?: number
    errorCode?: string | null
}

/** Result of captcha:resetMetrics. */
export interface CaptchaMetricsResetResult {
    success: boolean
    deleted: number
}

/** Max recent attempts exposed via getMetrics (bounded). */
export const CAPTCHA_METRICS_RECENT_LIMIT = 50

/** Soft cap on durable rows retained after each insert (bounded storage). */
export const CAPTCHA_METRICS_MAX_ROWS = 2000

/** Max length for sanitised error codes stored in DB. */
export const CAPTCHA_METRICS_ERROR_CODE_MAX = 120

export function emptyCaptchaMetricsSnapshot(): CaptchaMetricsSnapshot {
    return {
        totals: { attempts: 0, successes: 0, failures: 0 },
        successRate: 0,
        averageDurationMs: 0,
        byType: {},
        byProvider: {},
        recentAttempts: [],
    }
}
