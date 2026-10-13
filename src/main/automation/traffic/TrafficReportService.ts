import { getDatabase } from '../../database'
import * as schema from '../../database/schema'
import { desc, eq } from 'drizzle-orm'
import {
    classifyTrafficFailureMessage,
    readTrafficFailureBucketFromActions,
} from '../TrafficFailureClassifier'
import type { TrafficReport, VisitActionRecord } from './types'

/**
 * Stateless traffic report queries. Reads the database only; no engine runtime state.
 */
export class TrafficReportService {
    getReport(campaignId: number): TrafficReport {
        const db = getDatabase()
        const campaign = db.select().from(schema.trafficCampaigns).where(eq(schema.trafficCampaigns.id, campaignId)).get()
        if (!campaign) throw new Error('Campaign not found')

        const logs = db.select().from(schema.trafficLogs)
            .where(eq(schema.trafficLogs.campaignId, campaignId))
            .all()

        // Aggregate by location
        const locationMap = new Map<number, { name: string; visits: number; totalDuration: number }>()
        const locationIds: number[] = JSON.parse(campaign.locationIds || '[]')
        const allLocations = db.select().from(schema.locations).all().filter(l => locationIds.includes(l.id))
        for (const loc of allLocations) {
            locationMap.set(loc.id, { name: loc.name, visits: 0, totalDuration: 0 })
        }

        // Aggregate by account
        const accountMap = new Map<number, { email: string; visits: number }>()
        const accountIds: number[] = JSON.parse(campaign.accountIds || '[]')
        if (accountIds.length > 0) {
            const allAccounts = db.select().from(schema.accounts).all().filter(a => accountIds.includes(a.id))
            for (const acc of allAccounts) {
                accountMap.set(acc.id, { email: acc.email, visits: 0 })
            }
        }

        const actionCounts = new Map<string, number>()
        let totalDuration = 0

        const normalizeActions = (rawActions: string, fallbackTimestamp: unknown): VisitActionRecord[] => {
            let parsed: unknown
            try {
                parsed = JSON.parse(rawActions || '[]')
            } catch {
                return []
            }

            if (!Array.isArray(parsed)) {
                return []
            }

            const fallbackDate = new Date(fallbackTimestamp as any)
            const fallbackIso = Number.isNaN(fallbackDate.getTime())
                ? new Date().toISOString()
                : fallbackDate.toISOString()

            return parsed.map((item, index) => {
                if (typeof item === 'string') {
                    return {
                        action: item,
                        success: true,
                        source: 'legacy',
                        detail: item.replace(/_/g, ' '),
                        timestamp: fallbackIso,
                    }
                }

                if (!item || typeof item !== 'object') {
                    return {
                        action: `step_${index + 1}`,
                        success: true,
                        source: 'legacy',
                        timestamp: fallbackIso,
                    }
                }

                const record = item as Record<string, unknown>
                const action = typeof record.action === 'string'
                    ? record.action
                    : `step_${index + 1}`

                return {
                    action,
                    success: record.success !== false,
                    source: typeof record.source === 'string' ? record.source : undefined,
                    detail: typeof record.detail === 'string' ? record.detail : undefined,
                    thought: typeof record.thought === 'string' ? record.thought : undefined,
                    error: typeof record.error === 'string' ? record.error : undefined,
                    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
                    threadId: typeof record.threadId === 'number' ? record.threadId : undefined,
                    step: typeof record.step === 'number' ? record.step : undefined,
                    elementId: typeof record.elementId === 'number' ? record.elementId : undefined,
                    attempt: typeof record.attempt === 'number' ? record.attempt : undefined,
                    retryCategory: typeof record.retryCategory === 'string' ? record.retryCategory : undefined,
                    queueDepth: typeof record.queueDepth === 'number' ? record.queueDepth : undefined,
                    latencyMs: typeof record.latencyMs === 'number' ? record.latencyMs : undefined,
                    recoverPath: typeof record.recoverPath === 'string' ? record.recoverPath : undefined,
                    decisionSource: typeof record.decisionSource === 'string' ? record.decisionSource as VisitActionRecord['decisionSource'] : undefined,
                    ragUsed: record.ragUsed === true,
                    ragHitCount: typeof record.ragHitCount === 'number' ? record.ragHitCount : undefined,
                    ragEvidenceIds: Array.isArray(record.ragEvidenceIds)
                        ? record.ragEvidenceIds.filter((id): id is number => typeof id === 'number')
                        : undefined,
                    decisionLatencyMs: typeof record.decisionLatencyMs === 'number' ? record.decisionLatencyMs : undefined,
                    timestamp: typeof record.timestamp === 'string' ? record.timestamp : fallbackIso,
                }
            })
        }

        const normalizedLogs = logs.map(log => {
            // Location stats
            const locData = locationMap.get(log.locationId)
            if (locData && log.status === 'success') {
                locData.visits++
                locData.totalDuration += log.duration || 0
            }

            // Account stats
            if (log.accountId) {
                const accData = accountMap.get(log.accountId)
                if (accData && log.status === 'success') {
                    accData.visits++
                }
            }

            const actions = normalizeActions(log.actions || '[]', log.createdAt)
            for (const action of actions) {
                actionCounts.set(action.action, (actionCounts.get(action.action) || 0) + 1)
            }

            totalDuration += log.duration || 0

            const accountEmail = log.accountId
                ? (accountMap.get(log.accountId)?.email || `Account #${log.accountId}`)
                : 'Anonymous'
            const locationName = locationMap.get(log.locationId)?.name || `Location #${log.locationId}`
            const successfulActionCount = actions.filter(action => action.success).length

            return {
                id: log.id,
                status: log.status,
                round: log.round,
                duration: log.duration || 0,
                createdAt: log.createdAt,
                locationId: log.locationId,
                locationName,
                accountId: log.accountId,
                accountEmail,
                errorMessage: log.errorMessage || null,
                actions,
                successfulActionCount,
                failedActionCount: actions.length - successfulActionCount,
                totalActionCount: actions.length,
            }
        })

        const successLogs = logs.filter(l => l.status === 'success')
        const recentLogs = normalizedLogs
            .slice()
            .sort((left, right) => {
                const leftTime = new Date(left.createdAt as any).getTime() || 0
                const rightTime = new Date(right.createdAt as any).getTime() || 0
                return rightTime - leftTime
            })
            .slice(0, 100)

        return {
            campaignId,
            campaignName: campaign.name,
            totalVisits: campaign.totalVisits,
            completedVisits: campaign.completedVisits,
            failedVisits: campaign.failedVisits,
            totalRounds: campaign.currentRound,
            totalDuration,
            avgVisitDuration: successLogs.length > 0 ? Math.round(totalDuration / successLogs.length) : 0,
            visitsByLocation: Array.from(locationMap.entries()).map(([id, data]) => ({
                locationId: id,
                locationName: data.name,
                visits: data.visits,
                avgDuration: data.visits > 0 ? Math.round(data.totalDuration / data.visits) : 0,
            })),
            visitsByAccount: Array.from(accountMap.entries()).map(([id, data]) => ({
                accountId: id,
                accountEmail: data.email,
                visits: data.visits,
            })),
            actionStats: Array.from(actionCounts.entries()).map(([action, count]) => ({
                action,
                count,
            })).sort((a, b) => b.count - a.count),
            logs: recentLogs,
        }
    }

    /**
     * Traffic Audit Report — analyzes visit quality to explain the gap
     * between "successful visits" in the app and actual visits counted by Google.
     */
    getAuditReport(campaignId: number) {
        const db = getDatabase()
        const campaign = db.select().from(schema.trafficCampaigns).where(eq(schema.trafficCampaigns.id, campaignId)).get()
        if (!campaign) throw new Error('Campaign not found')

        const logs = db.select().from(schema.trafficLogs)
            .where(eq(schema.trafficLogs.campaignId, campaignId))
            .all()

        const successLogs = logs.filter(l => l.status === 'success')
        const failedLogs = logs.filter(l => l.status === 'failed')

        // Analyze failed visits by error category
        const failureReasons: Record<string, number> = {}
        for (const log of failedLogs) {
            const msg = log.errorMessage || 'unknown'
            let category = classifyTrafficFailureMessage(msg).bucket
            try {
                const parsedActions = JSON.parse(log.actions || '[]') as unknown
                category = readTrafficFailureBucketFromActions(parsedActions) || category
            } catch {
                // Legacy or malformed rows still fall back to error_message classification.
            }
            failureReasons[category] = (failureReasons[category] || 0) + 1
        }

        // Analyze success visits by quality
        let highQualityVisits = 0
        let mediumQualityVisits = 0
        let lowQualityVisits = 0
        let proxyRotatedVisits = 0
        let veryShortVisits = 0
        let totalQualityScore = 0
        let qualityAssessmentCount = 0
        let structuredCountableVisits = 0
        let legacyHighQualityVisits = 0
        let legacyMediumQualityVisits = 0

        for (const log of successLogs) {
            if ((log.duration || 0) < 15) veryShortVisits++

            let actions: unknown[] = []
            try {
                const parsed: unknown = JSON.parse(log.actions || '[]')
                actions = Array.isArray(parsed) ? parsed : []
            } catch { /* ignore */ }

            // Prefer structured quality_score column (web_seo numeric + new logs); fallback legacy detail regex for generic modes
            const hasStructuredQuality = log.discoverySource !== null || log.countable === true || log.qualityScore > 0
            let score: number | null =
                hasStructuredQuality && typeof log.qualityScore === 'number' && Number.isFinite(log.qualityScore)
                    ? log.qualityScore
                    : null

            if (score == null) {
                const qualityAction = actions.find((entry) => {
                    if (!entry || typeof entry !== 'object') return false
                    return (entry as { action?: unknown }).action === 'visit_quality_assessment'
                }) as { detail?: unknown } | undefined
                if (qualityAction && typeof qualityAction.detail === 'string') {
                    const match = qualityAction.detail.match(/Quality=(\d+)\/100/)
                    if (match) {
                        score = parseInt(match[1], 10)
                    }
                }
            }

            if (score != null) {
                totalQualityScore += score
                qualityAssessmentCount++
                if (score >= 60) {
                    highQualityVisits++
                    if (log.discoverySource === null) legacyHighQualityVisits++
                } else if (score >= 40) {
                    mediumQualityVisits++
                    if (log.discoverySource === null) legacyMediumQualityVisits++
                } else {
                    lowQualityVisits++
                }
            }

            if (log.discoverySource !== null && log.countable === true) {
                structuredCountableVisits++
            }

            const proxyAction = actions.find((entry) => {
                if (!entry || typeof entry !== 'object') return false
                return (entry as { action?: unknown }).action === 'proxy_rotated_visit_ended'
            })
            if (proxyAction) proxyRotatedVisits++
        }

        const avgQuality = qualityAssessmentCount > 0 ? Math.round(totalQualityScore / qualityAssessmentCount) : 0
        const estimatedGoogleCountable = structuredCountableVisits
            + legacyHighQualityVisits
            + Math.floor(legacyMediumQualityVisits * 0.5)

        return {
            campaignId,
            campaignName: campaign.name,
            totalAttempted: logs.length,
            totalSuccess: successLogs.length,
            totalFailed: failedLogs.length,
            successRate: logs.length > 0 ? Math.round((successLogs.length / logs.length) * 100) : 0,
            quality: {
                highQuality: highQualityVisits,
                mediumQuality: mediumQualityVisits,
                lowQuality: lowQualityVisits,
                avgQualityScore: avgQuality,
                estimatedGoogleCountable,
                estimatedGoogleRate: successLogs.length > 0
                    ? Math.round((estimatedGoogleCountable / successLogs.length) * 100)
                    : 0,
            },
            issues: {
                veryShortVisits,
                proxyRotatedVisits,
                captchaBlocked: failureReasons['captcha_blocked'] || 0,
                watchdogTimeout: failureReasons['watchdog_timeout'] || 0,
                loginGate: failureReasons['login_gate'] || 0,
                proxyErrors: failureReasons['proxy_error'] || 0,
                navigationErrors: failureReasons['navigation_error'] || 0,
                browserCrashes: failureReasons['browser_crash'] || 0,
                otherErrors: failureReasons['other'] || 0,
            },
            summary: this.buildAuditSummary(
                logs.length, successLogs.length, failedLogs.length,
                highQualityVisits, mediumQualityVisits, lowQualityVisits,
                estimatedGoogleCountable, failureReasons, proxyRotatedVisits, veryShortVisits
            ),
        }
    }

    private buildAuditSummary(
        total: number, success: number, failed: number,
        high: number, medium: number, low: number,
        estimated: number, failures: Record<string, number>,
        proxyRotated: number, veryShort: number,
    ): string[] {
        const lines: string[] = []
        lines.push(`Total: ${total} visits (${success} success, ${failed} failed)`)
        lines.push(`High quality (Google will count): ${high}`)
        lines.push(`Medium quality: ${medium}`)
        lines.push(`Low quality (Google may not count): ${low}`)
        lines.push(`Estimated Google-countable: ~${estimated} (${total > 0 ? Math.round((estimated / total) * 100) : 0}%)`)
        if (proxyRotated > 0) lines.push(`${proxyRotated} visits cut short by proxy rotation`)
        if (veryShort > 0) lines.push(`${veryShort} visits too short (<15s)`)
        if (failures['captcha_blocked']) lines.push(`${failures['captcha_blocked']} visits blocked by CAPTCHA`)
        if (failures['watchdog_timeout']) lines.push(`${failures['watchdog_timeout']} visits timed out`)
        return lines
    }

    getActionTrace(campaignId?: number, limit: number = 500): Array<Record<string, unknown>> {
        const db = getDatabase()
        const rowLimit = Math.max(1, Math.min(limit, 500))
        const rows = campaignId
            ? db.select().from(schema.trafficLogs)
                .where(eq(schema.trafficLogs.campaignId, campaignId))
                .orderBy(desc(schema.trafficLogs.id))
                .limit(rowLimit)
                .all()
            : db.select().from(schema.trafficLogs)
                .orderBy(desc(schema.trafficLogs.id))
                .limit(rowLimit)
                .all()

        const trace: Array<Record<string, unknown>> = []
        const max = Math.max(1, Math.min(limit, 5000))
        for (const row of rows) {
            let actions: unknown = []
            try {
                actions = JSON.parse(row.actions || '[]')
            } catch {
                actions = []
            }

            if (!Array.isArray(actions)) {
                continue
            }

            for (const item of actions) {
                if (!item || typeof item !== 'object') {
                    continue
                }
                const event = item as Record<string, unknown>
                trace.push({
                    campaignId: row.campaignId,
                    logId: row.id,
                    accountId: row.accountId,
                    locationId: row.locationId,
                    round: row.round,
                    status: row.status,
                    createdAt: row.createdAt,
                    action: typeof event.action === 'string' ? event.action : 'unknown',
                    success: event.success !== false,
                    source: typeof event.source === 'string' ? event.source : undefined,
                    detail: typeof event.detail === 'string' ? event.detail : undefined,
                    thought: typeof event.thought === 'string' ? event.thought : undefined,
                    error: typeof event.error === 'string' ? event.error : undefined,
                    durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
                    step: typeof event.step === 'number' ? event.step : undefined,
                    elementId: typeof event.elementId === 'number' ? event.elementId : undefined,
                    attempt: typeof event.attempt === 'number' ? event.attempt : undefined,
                    retryCategory: typeof event.retryCategory === 'string' ? event.retryCategory : undefined,
                    queueDepth: typeof event.queueDepth === 'number' ? event.queueDepth : undefined,
                    latencyMs: typeof event.latencyMs === 'number' ? event.latencyMs : undefined,
                    recoverPath: typeof event.recoverPath === 'string' ? event.recoverPath : undefined,
                    decisionSource: typeof event.decisionSource === 'string' ? event.decisionSource : undefined,
                    ragUsed: event.ragUsed === true,
                    ragHitCount: typeof event.ragHitCount === 'number' ? event.ragHitCount : undefined,
                    ragEvidenceIds: Array.isArray(event.ragEvidenceIds)
                        ? event.ragEvidenceIds.filter((id): id is number => typeof id === 'number')
                        : undefined,
                    decisionLatencyMs: typeof event.decisionLatencyMs === 'number' ? event.decisionLatencyMs : undefined,
                    timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
                })
                if (trace.length >= max) {
                    return trace
                }
            }
        }

        return trace
    }
}

export const trafficReportService = new TrafficReportService()
