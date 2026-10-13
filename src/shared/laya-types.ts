/**
 * Shared TypeScript types for Laya AI proxy integration.
 * Used by main-process LayaService and any future renderer/IPC surfaces.
 */

/** Discrete risk bands returned by Laya `risk_score`. */
export const LAYA_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export type LayaRiskLevel = (typeof LAYA_RISK_LEVELS)[number]

/** Account / session snapshot sent to Laya for a risk evaluation. */
export interface LayaRiskContext {
    accountEmail: string
    locationName: string
    warmupLevel?: number
    reputationScore?: number
    timeSinceLastVisitMs?: number
    proxyIp?: string
    trafficMode: string
    threadCount: number
    consecutiveFailures: number
}

/** Parsed result of a Laya `risk_score` call. Score is 0–100. */
export interface LayaRiskResult {
    score: number
    level: LayaRiskLevel
    reason: string
    shouldProceed: boolean
    suggestedDelayMs?: number
}

/** Generic decision request envelope (request_type + context bag). */
export interface LayaDecisionPayload {
    type: string
    context: Record<string, unknown>
}

/** Parsed result of a Laya decision call. Confidence is 0–1. */
export interface LayaDecisionResult {
    decision: string
    confidence: number
    reasoning: string
    tier: string
}

/** Liveness / capability snapshot of the local Laya proxy. */
export interface LayaHealthStatus {
    online: boolean
    latencyMs: number
    tier1Ready: boolean
    tier2Ready: boolean
    version: string
}

// ═══════════════════════════════════════════════════════════
// Phase 2 — Campaign Optimization + Account Health Scoring
// ═══════════════════════════════════════════════════════════

/** Pacing strategy recommended by the optimizer. */
export type LayaPacingStrategy = 'aggressive' | 'normal' | 'cautious' | 'pause'

/** Snapshot of campaign metrics sent to Laya for optimization. */
export interface CampaignMetricsSnapshot {
    campaignId: number
    campaignName: string
    trafficMode: string
    totalVisits: number
    completedVisits: number
    failedVisits: number
    successRate: number
    consecutiveFailures: number
    currentThreadCount: number
    avgVisitDurationMs: number
    elapsedMs: number
    locationCount: number
}

/** Optimization suggestions returned by Laya. */
export interface CampaignOptimizationResult {
    suggestedPacing: LayaPacingStrategy
    suggestedDelayRange: { minMs: number; maxMs: number }
    suggestedThreadCount: number
    shouldContinue: boolean
    reasoning: string
    confidence: number
}

/** Account health context sent to Laya for scoring. */
export interface AccountHealthContext {
    accountId: number
    email: string
    createdAt: string
    warmupLevel: number
    totalReviews: number
    lastReviewAt?: string
    lastBanAt?: string
    banCount: number
    daysSinceCreation: number
    recentFailures: number
}

/** Account health grade (A = best, F = banned/risky). */
export type AccountHealthGrade = 'A' | 'B' | 'C' | 'D' | 'F'

/** Account health evaluation result. */
export interface AccountHealthResult {
    score: number
    grade: AccountHealthGrade
    risks: string[]
    recommendations: string[]
    readyForTraffic: boolean
    cooldownMs: number
}
