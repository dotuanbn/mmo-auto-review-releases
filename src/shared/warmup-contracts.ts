export type WarmupActivityInput =
    | 'search'
    | 'maps'
    | 'youtube'
    | 'google_search'
    | 'maps_browse'
    | 'youtube_browse'

export interface WarmupStartOptions {
    activityType?: WarmupActivityInput
    durationSeconds?: number
}

/**
 * Structured failure codes for warmup:start / cancel.
 * Optional on results for backward compatibility with older renderers.
 */
export type WarmupActionErrorCode =
    | 'already_running'
    | 'account_not_found'
    | 'cooldown_active'
    | 'daily_cap_reached'
    | 'not_logged_in'
    | 'cancelled'
    | 'stale_generation'

export interface AccountWarmupStatusDto {
    accountId: number
    running: boolean
    warmupLevel: number
    reputationScore: number
    warmupSessions: number
    lastWarmupAt: string | null
    nextWarmupAt: string | null
    isReady: boolean
}

export interface WarmupActionResultDto {
    success: boolean
    message?: string
    /** Present on known failures; omit on success for BC. */
    code?: WarmupActionErrorCode
    status?: AccountWarmupStatusDto
}
