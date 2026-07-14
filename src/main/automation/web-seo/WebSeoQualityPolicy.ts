/**
 * Quality / countable scoring for Web SEO visits.
 * Engine contract: discoverySource + hostVerified + actionsPerformed + qualityScore.
 * Also accepts a compact test/compat shape (mode/targetHost/dwellSeconds/actionCount).
 */

import type {
    WebSeoActionRecord,
    WebSeoDiscoverySource,
    WebSeoSiteType,
} from '../../../shared/web-seo-contracts'
import { isSameWebSeoSite } from '../../../shared/web-seo-contracts'

/** Canonical engine input. */
export interface WebSeoQualityInput {
    discoverySource: WebSeoDiscoverySource
    organicHit: boolean
    hostVerified: boolean
    durationSeconds: number
    minTimeOnPageSeconds: number
    actionsPerformed: WebSeoActionRecord[]
    requireOrganic?: boolean
    siteType: WebSeoSiteType
    /** When true, visit is not countable and score is penalized. */
    interrupted?: boolean
}

/**
 * Compact / legacy test shape. Mapped into WebSeoQualityInput internally.
 * Prefer the engine fields above when integrating the flow.
 */
export interface WebSeoQualityCompatInput {
    mode?: 'organic' | 'direct' | 'direct_fallback' | 'captcha_cooldown' | 'unreachable' | string
    requireOrganic?: boolean
    targetHost?: string
    landedHost?: string
    dwellSeconds?: number
    minDwellSeconds?: number
    maxDwellSeconds?: number
    actionCount?: number
    interrupted?: boolean
    siteType?: WebSeoSiteType
    // Allow engine fields mixed in
    discoverySource?: WebSeoDiscoverySource
    organicHit?: boolean
    hostVerified?: boolean
    durationSeconds?: number
    minTimeOnPageSeconds?: number
    actionsPerformed?: WebSeoActionRecord[]
}

export interface WebSeoQualityAssessment {
    /** Canonical score used by the engine (0–100). */
    qualityScore: number
    /** Alias of qualityScore for callers that expect `score`. */
    score: number
    countable: boolean
}

function clampNumber(value: unknown, fallback = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return value
}

function clampScore(score: number): number {
    if (!Number.isFinite(score)) return 0
    return Math.max(0, Math.min(100, Math.round(score)))
}

function mapModeToDiscovery(mode: string | undefined): WebSeoDiscoverySource {
    switch ((mode || '').toLowerCase()) {
        case 'organic':
            return 'organic'
        case 'direct':
        case 'direct_fallback':
            return 'direct_fallback'
        case 'captcha_cooldown':
        case 'captcha':
            return 'captcha_cooldown'
        case 'unreachable':
            return 'unreachable'
        default:
            return 'unreachable'
    }
}

function syntheticActions(count: number): WebSeoActionRecord[] {
    const n = Math.max(0, Math.min(100, Math.floor(clampNumber(count, 0))))
    const out: WebSeoActionRecord[] = []
    for (let i = 0; i < n; i++) {
        out.push({ action: `action_${i}`, success: true })
    }
    return out
}

/**
 * Normalize either engine or compact input into a clamped canonical shape.
 */
function normalizeQualityInput(
    raw: WebSeoQualityInput | WebSeoQualityCompatInput,
): WebSeoQualityInput {
    const r = raw as WebSeoQualityCompatInput & Partial<WebSeoQualityInput>

    const hasEngineDiscovery = typeof r.discoverySource === 'string'
    const discoverySource: WebSeoDiscoverySource = hasEngineDiscovery
        ? (r.discoverySource as WebSeoDiscoverySource)
        : mapModeToDiscovery(r.mode)

    const organicHit = typeof r.organicHit === 'boolean'
        ? r.organicHit
        : discoverySource === 'organic'

    let hostVerified: boolean
    if (typeof r.hostVerified === 'boolean') {
        hostVerified = r.hostVerified
    } else if (typeof r.targetHost === 'string' && typeof r.landedHost === 'string') {
        hostVerified = isSameWebSeoSite(r.landedHost, r.targetHost)
    } else if (typeof r.targetHost === 'string' && !r.landedHost) {
        hostVerified = false
    } else {
        // Engine path without hostVerified → fail closed
        hostVerified = false
    }

    const durationSeconds = Math.max(
        0,
        clampNumber(
            r.durationSeconds !== undefined ? r.durationSeconds : r.dwellSeconds,
            0,
        ),
    )

    const minTimeOnPageSeconds = Math.max(
        1,
        clampNumber(
            r.minTimeOnPageSeconds !== undefined ? r.minTimeOnPageSeconds : r.minDwellSeconds,
            1,
        ),
    )

    let actionsPerformed: WebSeoActionRecord[]
    if (Array.isArray(r.actionsPerformed)) {
        actionsPerformed = r.actionsPerformed
    } else if (typeof r.actionCount === 'number') {
        actionsPerformed = syntheticActions(r.actionCount)
    } else {
        actionsPerformed = []
    }

    return {
        discoverySource,
        organicHit,
        hostVerified,
        durationSeconds,
        minTimeOnPageSeconds,
        actionsPerformed,
        requireOrganic: Boolean(r.requireOrganic),
        siteType: r.siteType || 'generic',
        interrupted: Boolean(r.interrupted),
    }
}

/**
 * Score 0–100. Countable only when host verified, dwell met, actions present,
 * organic requirement (if any) is satisfied, and visit was not interrupted.
 * Direct fallback never pretends organic.
 */
export function assessWebSeoQuality(
    input: WebSeoQualityInput | WebSeoQualityCompatInput,
): WebSeoQualityAssessment {
    const normalized = normalizeQualityInput(input)
    const {
        discoverySource,
        hostVerified,
        organicHit,
        interrupted,
        requireOrganic,
        siteType,
        durationSeconds,
        minTimeOnPageSeconds,
        actionsPerformed,
    } = normalized

    if (discoverySource === 'unreachable' || !hostVerified) {
        return { qualityScore: 0, score: 0, countable: false }
    }

    const successActions = actionsPerformed.filter((a) => a && a.success).length
    const minDwell = Math.max(1, minTimeOnPageSeconds)
    const dwellRatio = Math.min(1, durationSeconds / minDwell)

    let score = 0

    // Discovery quality
    if (discoverySource === 'organic' && organicHit) {
        score += 40
    } else if (discoverySource === 'direct_fallback') {
        score += 15
    } else if (discoverySource === 'captcha_cooldown') {
        score += 10
    }

    // Host verification
    if (hostVerified) score += 20

    // Dwell
    score += Math.round(dwellRatio * 25)

    // Interaction depth
    if (successActions >= 6) score += 15
    else if (successActions >= 3) score += 10
    else if (successActions >= 1) score += 5

    // Site-type micro-bonus (engaged browse patterns)
    if (siteType === 'ecommerce' && successActions >= 4) score += 3
    if (siteType === 'article' && dwellRatio >= 0.8) score += 3

    // Interrupted visits lose significant quality credit
    if (interrupted) score -= 35

    score = clampScore(score)

    const dwellOk = durationSeconds >= minDwell
    const actionsOk = successActions >= 2
    const organicOk = !requireOrganic || (organicHit && discoverySource === 'organic')

    const countable =
        !interrupted
        && hostVerified
        && dwellOk
        && actionsOk
        && organicOk
        && score >= 45

    return { qualityScore: score, score, countable }
}

/**
 * Optional helper: derive hostVerified from landed vs target hosts
 * using the shared fail-closed same-site check (rejects suffix tricks).
 */
export function webSeoHostsMatch(landedHost: string, targetHost: string): boolean {
    if (!landedHost || !targetHost) return false
    return isSameWebSeoSite(landedHost, targetHost)
}
