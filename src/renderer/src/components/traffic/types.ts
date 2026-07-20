/**
 * Strict types for trafficBoost.getAudit / getLogs responses.
 * Kept renderer-local so we do not depend on main-process modules.
 */

export type TrafficFailBucketKey =
    | 'captchaBlocked'
    | 'watchdogTimeout'
    | 'loginGate'
    | 'proxyErrors'
    | 'navigationErrors'
    | 'browserCrashes'
    | 'otherErrors'

export interface TrafficAuditQuality {
    highQuality: number
    mediumQuality: number
    lowQuality: number
    avgQualityScore: number
    estimatedGoogleCountable: number
    estimatedGoogleRate: number
}

export interface TrafficAuditIssues {
    veryShortVisits: number
    proxyRotatedVisits: number
    captchaBlocked: number
    watchdogTimeout: number
    loginGate: number
    proxyErrors: number
    navigationErrors: number
    browserCrashes: number
    otherErrors: number
}

export interface TrafficAuditReport {
    campaignId: number
    campaignName: string
    totalAttempted: number
    totalSuccess: number
    totalFailed: number
    successRate: number
    quality: TrafficAuditQuality
    issues: TrafficAuditIssues
    summary: string[]
}

export interface TrafficLogAction {
    action: string
    success?: boolean
    detail?: string
    error?: string
    retryCategory?: string
    timestamp?: string
    source?: string
    durationMs?: number
}

export interface TrafficLogRow {
    id: number
    campaignId: number
    accountId?: number | null
    locationId: number
    status: string
    duration: number
    round: number
    errorMessage?: string | null
    createdAt: string | number | Date
    accountEmail?: string
    locationName?: string
    actions: TrafficLogAction[] | string
}

export type AuditLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'empty'

export interface TrafficAuditSnapshot {
    campaignId: number
    audit: TrafficAuditReport | null
    sampleLogs: TrafficLogRow[]
    totalLogCount: number
    fetchedAt: number
}

export interface FailureBucketItem {
    key: TrafficFailBucketKey
    count: number
    i18nKey: string
    tone: 'rose' | 'amber' | 'violet' | 'slate' | 'blue' | 'cyan' | 'emerald'
}
