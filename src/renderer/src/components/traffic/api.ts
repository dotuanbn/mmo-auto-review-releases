import type { TrafficAuditReport, TrafficLogRow } from './types'

interface TrafficBoostAuditApi {
    getAudit: (campaignId: number) => Promise<unknown>
    getLogs: (campaignId: number) => Promise<unknown>
}

interface ElectronApiShape {
    trafficBoost?: TrafficBoostAuditApi
}

function getTrafficBoostApi(): TrafficBoostAuditApi | null {
    if (typeof window === 'undefined') {
        return null
    }
    const api = (window as Window & { electronAPI?: ElectronApiShape }).electronAPI
    if (!api?.trafficBoost?.getAudit || !api.trafficBoost.getLogs) {
        return null
    }
    return api.trafficBoost
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asNumber(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : fallback
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback
}

function parseActions(raw: unknown): TrafficLogRow['actions'] {
    if (Array.isArray(raw)) {
        return raw as TrafficLogRow['actions']
    }
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw)
            return Array.isArray(parsed) ? (parsed as TrafficLogRow['actions']) : []
        } catch {
            return []
        }
    }
    return []
}

function normalizeQuality(raw: unknown): TrafficAuditReport['quality'] {
    const q = asRecord(raw) || {}
    return {
        highQuality: asNumber(q.highQuality),
        mediumQuality: asNumber(q.mediumQuality),
        lowQuality: asNumber(q.lowQuality),
        avgQualityScore: asNumber(q.avgQualityScore),
        estimatedGoogleCountable: asNumber(q.estimatedGoogleCountable),
        estimatedGoogleRate: asNumber(q.estimatedGoogleRate),
    }
}

function normalizeIssues(raw: unknown): TrafficAuditReport['issues'] {
    const i = asRecord(raw) || {}
    return {
        veryShortVisits: asNumber(i.veryShortVisits),
        proxyRotatedVisits: asNumber(i.proxyRotatedVisits),
        captchaBlocked: asNumber(i.captchaBlocked),
        watchdogTimeout: asNumber(i.watchdogTimeout),
        loginGate: asNumber(i.loginGate),
        proxyErrors: asNumber(i.proxyErrors),
        navigationErrors: asNumber(i.navigationErrors),
        browserCrashes: asNumber(i.browserCrashes),
        otherErrors: asNumber(i.otherErrors),
    }
}

export function normalizeAuditReport(raw: unknown, campaignId: number): TrafficAuditReport | null {
    const record = asRecord(raw)
    if (!record) {
        return null
    }

    const summaryRaw = record.summary
    const summary = Array.isArray(summaryRaw)
        ? summaryRaw.filter((line): line is string => typeof line === 'string')
        : []

    return {
        campaignId: asNumber(record.campaignId, campaignId),
        campaignName: asString(record.campaignName, ''),
        totalAttempted: asNumber(record.totalAttempted),
        totalSuccess: asNumber(record.totalSuccess),
        totalFailed: asNumber(record.totalFailed),
        successRate: asNumber(record.successRate),
        quality: normalizeQuality(record.quality),
        issues: normalizeIssues(record.issues),
        summary,
    }
}

export function normalizeLogRows(raw: unknown): TrafficLogRow[] {
    if (!Array.isArray(raw)) {
        return []
    }

    const rows: TrafficLogRow[] = []
    for (const item of raw) {
        const record = asRecord(item)
        if (!record) {
            continue
        }
        const id = asNumber(record.id, -1)
        if (id < 0) {
            continue
        }
        rows.push({
            id,
            campaignId: asNumber(record.campaignId),
            accountId: record.accountId == null ? null : asNumber(record.accountId),
            locationId: asNumber(record.locationId),
            status: asString(record.status, 'unknown'),
            duration: asNumber(record.duration),
            round: asNumber(record.round, 1),
            errorMessage: record.errorMessage == null ? null : asString(record.errorMessage),
            createdAt: (record.createdAt as string | number | Date) ?? '',
            accountEmail: asString(record.accountEmail, 'Anonymous'),
            locationName: asString(record.locationName, 'Unknown'),
            actions: parseActions(record.actions),
        })
    }
    return rows
}

/**
 * Fetch audit + logs in a single parallel batch (no N+1 client calls).
 */
export async function fetchTrafficAuditBundle(campaignId: number): Promise<{
    audit: TrafficAuditReport | null
    logs: TrafficLogRow[]
}> {
    const api = getTrafficBoostApi()
    if (!api) {
        throw new Error('trafficBoost API unavailable')
    }

    const [auditResult, logsResult] = await Promise.allSettled([
        api.getAudit(campaignId),
        api.getLogs(campaignId),
    ])

    if (auditResult.status === 'rejected' && logsResult.status === 'rejected') {
        const reason = auditResult.reason instanceof Error
            ? auditResult.reason.message
            : 'Failed to load audit and logs'
        throw new Error(reason)
    }

    const audit = auditResult.status === 'fulfilled'
        ? normalizeAuditReport(auditResult.value, campaignId)
        : null

    if (auditResult.status === 'rejected' && !audit) {
        const reason = auditResult.reason instanceof Error
            ? auditResult.reason.message
            : 'Failed to load audit'
        throw new Error(reason)
    }

    const logs = logsResult.status === 'fulfilled'
        ? normalizeLogRows(logsResult.value)
        : []

    return { audit, logs }
}
