/**
 * Stateless single-visit helpers extracted from TrafficBoostEngine.
 * Watchdog baseline, action cap, and FProxy rotation are read directly.
 * Per-thread CAPTCHA pressure and the runtime logger are passed in.
 */

import { HumanBehavior } from '../HumanBehavior'
import { fproxyService } from '../../services/FProxyService'
import { getRuntimeLogger, type RuntimeLogger } from '../../utils/runtimeLogger'
import type {
    WebSeoDiscoverySource,
    WebSeoFlowResult as ContractWebSeoFlowResult,
} from '../../../shared/web-seo-contracts'

export type { WebSeoDiscoverySource }

/** Baseline minimum visit watchdog. Proxy cap is applied dynamically. */
export const VISIT_WATCHDOG_TIMEOUT_MS = 150_000

/** Hard cap for actions requested on a single visit. */
export const MAX_ACTIONS_PER_VISIT_CAP = 100

export type SEOAction =
    | 'map_zoom_in' | 'map_zoom_out' | 'map_drag_pan' | 'map_satellite_view'
    | 'map_street_view' | 'map_terrain_view' | 'map_fullscreen' | 'map_measure_distance'
    | 'photos_browse' | 'photos_view_single' | 'photos_next_prev' | 'photos_category'
    | 'photos_owner' | 'photos_latest' | 'photos_360'
    | 'reviews_read' | 'reviews_expand' | 'reviews_sort' | 'reviews_filter_stars'
    | 'reviews_view_photos' | 'reviews_helpful' | 'reviews_author_profile'
    | 'directions_driving' | 'directions_walking' | 'directions_transit'
    | 'directions_cycling' | 'directions_reverse'
    | 'info_view_hours' | 'info_view_about' | 'info_phone' | 'info_address_copy'
    | 'info_website' | 'info_menu' | 'info_price_range' | 'info_amenities'
    | 'share_link' | 'share_embed' | 'save_place' | 'send_to_phone' | 'print_location'
    | 'explore_nearby' | 'explore_similar' | 'explore_category' | 'explore_popular_times'
    | 'explore_qa' | 'explore_updates'
    | 'browse_scroll_deep' | 'browse_read_panel' | 'browse_random_click' | 'browse_back_forward'

export interface VisitActionRecord {
    action: string
    success: boolean
    source?: string
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    threadId?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp?: string
}

/** Same shape as TrafficBoostEngine's per-visit action context. */
export interface VisitActionContext {
    campaignName: string
    round: number
    campaignId: number
    threadId: number
    accountEmail: string
    locationName: string
    domain?: string
    goal?: string
    riskType?: string
}

/** Per-thread CAPTCHA strike snapshot. Only `hits` affects delay scaling. */
export interface CaptchaThreadStat {
    hits: number
    lastDetectedAt?: number
    lastResolvedAt?: number
}

/**
 * Per-visit Web SEO outcome (typed). Prefer numeric fields from the flow result;
 * do not derive quality from string or regex heuristics.
 */
export type WebSeoFlowResult = ContractWebSeoFlowResult & {
    discoverySource?: WebSeoDiscoverySource
    hostVerified?: boolean
    organicHit?: boolean
    qualityScore?: number
    countable?: boolean
    targetHost?: string
    errorCode?: string
    reachedTarget?: boolean
}

export interface WebSeoVisitOutcome {
    success: boolean
    reachedTarget: boolean
    discoverySource: WebSeoDiscoverySource
    hostVerified: boolean
    organicHit: boolean
    qualityScore: number
    countable: boolean
    targetHost: string | null
    errorCode?: string
    message: string
}

export interface WebSeoOutcomeLogOptions {
    logger?: Pick<RuntimeLogger, 'info'>
    /** Fallback queue depth when the action record does not set one. */
    queueDepth?: number
}

const visitLogger = getRuntimeLogger({ module: 'traffic-visit-executor' })

export function parseStrictKeywordList(raw: unknown): string[] {
    if (raw == null) {
        return []
    }
    if (Array.isArray(raw)) {
        return raw
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
    }
    if (typeof raw !== 'string') {
        return []
    }
    const trimmed = raw.trim()
    if (!trimmed) {
        return []
    }
    try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
            return parsed
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean)
        }
    } catch {
        // Fall through to delimiter split for non-JSON campaign/location keyword blobs.
    }
    return trimmed.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
}

export function extractTargetHost(urlOrHost: string): string | null {
    const raw = (urlOrHost || '').trim()
    if (!raw) {
        return null
    }
    try {
        const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
        const host = new URL(withProtocol).hostname.replace(/^www\./i, '').toLowerCase()
        return host || null
    } catch {
        const cleaned = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0]?.toLowerCase()
        return cleaned || null
    }
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | null {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | null {
    const value = record[key]
    return typeof value === 'boolean' ? value : null
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asResultRecord(result: WebSeoFlowResult): Record<string, unknown> {
    return result as unknown as Record<string, unknown>
}

export function asWebSeoDiscoverySource(value: string | null | undefined): WebSeoDiscoverySource | null {
    if (
        value === 'organic'
        || value === 'direct_fallback'
        || value === 'captcha_cooldown'
        || value === 'unreachable'
    ) {
        return value
    }
    return null
}

export function mapWebSeoFlowResult(
    result: WebSeoFlowResult,
    fallbackTargetHost: string | null,
    discoveryOverride?: WebSeoDiscoverySource,
): WebSeoVisitOutcome {
    const record = asResultRecord(result)
    const actionNames = (result.actionsPerformed || []).map((item) => item.action)
    const usedFallback = actionNames.some((name) => /fallback/i.test(name))
    const reachedTarget =
        readOptionalBoolean(record, 'reachedTarget')
        ?? result.foundWebsite
        ?? false

    let discoverySource: WebSeoDiscoverySource =
        discoveryOverride
        ?? asWebSeoDiscoverySource(readOptionalString(record, 'discoverySource'))
        ?? 'unreachable'

    if (!discoveryOverride && discoverySource === 'unreachable') {
        if (usedFallback && reachedTarget) {
            discoverySource = 'direct_fallback'
        } else if (reachedTarget) {
            discoverySource = 'organic'
        } else {
            discoverySource = 'unreachable'
        }
    }

    const hostVerified =
        readOptionalBoolean(record, 'hostVerified')
        ?? (reachedTarget && result.success)
    const organicHit =
        readOptionalBoolean(record, 'organicHit')
        ?? discoverySource === 'organic'
    const targetHost =
        readOptionalString(record, 'targetHost')
        ?? fallbackTargetHost

    // Prefer numeric quality from the flow result; never parse string detail heuristics here.
    const successActionCount = (result.actionsPerformed || []).filter((item) => item.success).length
    const qualityFromResult = readOptionalNumber(record, 'qualityScore')
    const qualityScore = qualityFromResult != null
        ? Math.max(0, Math.min(100, Math.round(qualityFromResult)))
        : result.success
            ? Math.min(100, 40 + successActionCount * 8 + (organicHit ? 20 : 0) + (hostVerified ? 10 : 0))
            : Math.min(40, successActionCount * 5)

    const countableFromResult = readOptionalBoolean(record, 'countable')
    const countable = countableFromResult != null
        ? countableFromResult
        : Boolean(result.success && hostVerified && qualityScore >= 40)

    const errorCode = readOptionalString(record, 'errorCode') || undefined

    return {
        success: Boolean(result.success),
        reachedTarget,
        discoverySource,
        hostVerified: Boolean(hostVerified),
        organicHit: Boolean(organicHit),
        qualityScore,
        countable,
        targetHost,
        errorCode,
        message: result.message || '',
    }
}

export function resolveWebSeoSearchKeywords(
    campaign: { searchKeywords?: string | null },
    location: { searchKeywords?: string | null; name: string },
): string[] {
    const fromCampaign = parseStrictKeywordList(campaign.searchKeywords)
    if (fromCampaign.length > 0) {
        return fromCampaign
    }
    const fromLocation = parseStrictKeywordList(location.searchKeywords)
    if (fromLocation.length > 0) {
        return fromLocation
    }
    return [location.name]
}

export function resolveWebSeoDwellSeconds(campaign: {
    webSeoMinDwellSeconds?: number | null
    webSeoMaxDwellSeconds?: number | null
}): { minSeconds: number; maxSeconds: number } {
    const minSeconds = Math.max(1, Number(campaign.webSeoMinDwellSeconds ?? 45) || 45)
    const maxRaw = Number(campaign.webSeoMaxDwellSeconds ?? 90) || 90
    const maxSeconds = Math.max(minSeconds, maxRaw)
    return { minSeconds, maxSeconds }
}

function logStructuredVisitAction(
    actionsPerformed: VisitActionRecord[],
    input: VisitActionRecord,
    context: VisitActionContext,
    logger: Pick<RuntimeLogger, 'info'>,
    queueDepth?: number,
): void {
    const timestamp = input.timestamp || new Date().toISOString()
    const normalized: VisitActionRecord = {
        ...input,
        timestamp,
        threadId: input.threadId ?? context.threadId,
    }
    actionsPerformed.push(normalized)
    const source = normalized.source || 'runtime'
    logger.info({
        event: 'runtime_action',
        campaignId: context.campaignId,
        threadId: normalized.threadId ?? context.threadId,
        action: normalized.action,
        source,
        success: normalized.success !== false,
        attempt: normalized.attempt,
        retryCategory: normalized.retryCategory,
        queueDepth: normalized.queueDepth ?? queueDepth,
        latencyMs: normalized.latencyMs,
        recoverPath: normalized.recoverPath,
        decisionSource: normalized.decisionSource,
        ragUsed: normalized.ragUsed === true || normalized.decisionSource === 'llm+rag',
        ragHitCount: normalized.ragHitCount,
        timestamp,
    })
}

export function recordWebSeoStructuredOutcome(
    actionsPerformed: VisitActionRecord[],
    outcome: WebSeoVisitOutcome,
    threadId: number,
    actionContext: VisitActionContext,
    options?: WebSeoOutcomeLogOptions,
): void {
    const logger = options?.logger ?? visitLogger
    logStructuredVisitAction(actionsPerformed, {
        action: 'web_seo_discovery',
        success: outcome.reachedTarget,
        source: 'web_seo',
        detail: `discoverySource=${outcome.discoverySource}; organicHit=${outcome.organicHit}; hostVerified=${outcome.hostVerified}; targetHost=${outcome.targetHost || ''}`,
        threadId,
        timestamp: new Date().toISOString(),
    }, actionContext, logger, options?.queueDepth)
    logStructuredVisitAction(actionsPerformed, {
        action: 'web_seo_quality',
        success: outcome.countable,
        source: 'web_seo',
        detail: `qualityScore=${outcome.qualityScore}; countable=${outcome.countable}`,
        threadId,
        timestamp: new Date().toISOString(),
    }, actionContext, logger, options?.queueDepth)
}

export function assertWebSeoOutcomeOrThrow(outcome: WebSeoVisitOutcome): void {
    if (outcome.success && outcome.reachedTarget) {
        return
    }
    const rawCode = outcome.errorCode
    const code = rawCode
        ? (rawCode.startsWith('web_seo_') ? rawCode : `web_seo_${rawCode}`)
        : (outcome.reachedTarget ? 'web_seo_low_quality' : 'web_seo_target_not_found')
    const detail = outcome.message || 'Web SEO did not reach target successfully'
    throw new Error(`${code}: ${detail}`)
}

export function randomBetweenInclusive(minValue: number, maxValue: number): number {
    const min = Math.floor(Math.min(minValue, maxValue))
    const max = Math.floor(Math.max(minValue, maxValue))
    return HumanBehavior.getRandomDelay(min, max)
}

export function normalizeDesiredActions(value: unknown): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        return 4
    }
    return Math.max(1, Math.min(MAX_ACTIONS_PER_VISIT_CAP, Math.floor(parsed)))
}

export function pickRandomActions(actions: SEOAction[], count: number): SEOAction[] {
    if (!Array.isArray(actions) || actions.length === 0 || count <= 0) {
        return []
    }
    const normalizedCount = Math.max(1, Math.floor(count))
    const shuffled = [...actions].sort(() => Math.random() - 0.5)
    if (normalizedCount <= shuffled.length) {
        return shuffled.slice(0, normalizedCount)
    }
    const picked: SEOAction[] = [...shuffled]
    while (picked.length < normalizedCount) {
        const randomAction = actions[Math.floor(Math.random() * actions.length)]
        picked.push(randomAction)
    }
    return picked
}

/**
 * CAPTCHA-pressure delay scale.
 * `captchaThreadStats` replaces the engine map previously read via `this`.
 * Missing stats (or a missing thread) keep the factor at 1.
 */
export function getAdaptiveDelayFactor(
    threadIdx: number,
    captchaThreadStats?: ReadonlyMap<number, CaptchaThreadStat>,
): number {
    const stats = captchaThreadStats?.get(threadIdx)
    if (!stats || stats.hits <= 0) {
        return 1
    }
    return Math.min(2.4, 1 + (stats.hits * 0.35))
}

export function computeVisitWatchdogTimeoutMs(
    desiredActions: number,
    delayMinSeconds: number,
    delayMaxSeconds: number,
    mode: 'agentic' | 'seo',
    threadIdx: number,
    fixedActionCount: boolean,
    options: { fproxyPoolEnabled?: boolean; proxyEnabled?: boolean } = {},
    captchaThreadStats?: ReadonlyMap<number, CaptchaThreadStat>,
): number {
    const safeActions = normalizeDesiredActions(desiredActions)
    const adaptiveFactor = getAdaptiveDelayFactor(threadIdx, captchaThreadStats)
    const safeDelayMin = Math.max(0, Number(delayMinSeconds || 0))
    const safeDelayMax = Math.max(safeDelayMin, Number(delayMaxSeconds || safeDelayMin))
    const averageDelayMs = Math.max(500, Math.floor(((safeDelayMin + safeDelayMax) / 2) * 750 * adaptiveFactor))
    // Keep KPI visits intentionally compact under rotating proxies (direction/website/phone).
    const averageActionExecutionMs = mode === 'agentic' ? 7000 : 5200
    const baseOverheadMs = fixedActionCount ? 35_000 : 28_000
    const fixedFactor = fixedActionCount ? 1.15 : 1
    const estimatedMs = Math.floor(baseOverheadMs + (safeActions * (averageDelayMs + averageActionExecutionMs) * fixedFactor))
    const hardMaxMs = 12 * 60 * 1000
    const computedMs = Math.max(VISIT_WATCHDOG_TIMEOUT_MS, Math.min(hardMaxMs, estimatedMs))

    // Align with FProxy rotate window (~2 min): visit must finish before the provider rotates IP.
    const fproxyRotationActive = !!options.proxyEnabled && (
        !!options.fproxyPoolEnabled
        || (!!fproxyService.getApiKey() && fproxyService.isAutoRotateActive())
    )
    if (fproxyRotationActive) {
        const proxyIntervalMs = Math.max(
            60_000,
            Number(fproxyService.getRotateIntervalMs?.() || 120_000) || 120_000,
        )
        // Leave a cleanup buffer so context close and lease release finish before the next IP.
        const proxyCappedMs = Math.max(45_000, proxyIntervalMs - 12_000)
        return Math.min(computedMs, proxyCappedMs)
    }
    return computedMs
}

export function computeMaxActionsForWatchdog(
    delayMinSeconds: number,
    delayMaxSeconds: number,
    threadIdx: number,
    mode: 'agentic' | 'seo',
    visitTimeoutMs: number,
    desiredActions: number,
    captchaThreadStats?: ReadonlyMap<number, CaptchaThreadStat>,
): number {
    const adaptiveFactor = getAdaptiveDelayFactor(threadIdx, captchaThreadStats)
    const safeDelayMin = Math.max(0, Number(delayMinSeconds || 0))
    const safeDelayMax = Math.max(safeDelayMin, Number(delayMaxSeconds || 0))

    const delayMinMs = Math.max(650, Math.floor(safeDelayMin * 420 * adaptiveFactor))
    const delayMaxMs = Math.max(1200, Math.floor(safeDelayMax * 620 * adaptiveFactor))
    const averageDelayMs = Math.floor((delayMinMs + delayMaxMs) / 2)

    const averageActionExecutionMs = mode === 'agentic' ? 9000 : 6200
    const reservedOverheadMs = 24_000
    const availableMs = Math.max(15_000, visitTimeoutMs - reservedOverheadMs)
    const estimatedMax = Math.floor(availableMs / Math.max(1400, averageDelayMs + averageActionExecutionMs))
    const desiredCap = Math.max(1, Math.floor(normalizeDesiredActions(desiredActions) * 1.35))
    const hardCap = Math.min(MAX_ACTIONS_PER_VISIT_CAP, Math.max(6, desiredCap))

    return Math.max(1, Math.min(hardCap, estimatedMax))
}

export function isBrowserContextClosedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /target page, context or browser has been closed|target closed|browser\.newcontext|browser has been closed/i.test(message)
}

export function isProxyConnectionError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
    return /err_proxy_connection_failed|proxy connection failed|err_tunnel_connection_failed|proxy authentication required|407|socks|proxy/i.test(message)
}

export async function runWithTimeout<T>(
    work: () => Promise<T>,
    timeoutMs: number,
    onTimeout: () => Promise<void>,
): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let timedOut = false

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true
            void onTimeout().catch(() => { })
            reject(new Error('VISIT_WATCHDOG_TIMEOUT'))
        }, timeoutMs)
    })

    try {
        return await Promise.race([work(), timeoutPromise])
    } catch (error) {
        if (timedOut) {
            throw new Error('VISIT_WATCHDOG_TIMEOUT')
        }
        throw error
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle)
        }
    }
}

/**
 * Static facade for one visit's timeout, watchdog budget, and proxy/browser errors.
 * Calculation lives in the exported functions above.
 */
export class TrafficVisitExecutor {
    static readonly visitWatchdogTimeoutMs = VISIT_WATCHDOG_TIMEOUT_MS
    static readonly maxActionsPerVisitCap = MAX_ACTIONS_PER_VISIT_CAP

    private constructor() {
        // Stateless. Call the static methods.
    }

    static runWithTimeout<T>(
        work: () => Promise<T>,
        timeoutMs: number,
        onTimeout: () => Promise<void>,
    ): Promise<T> {
        return runWithTimeout(work, timeoutMs, onTimeout)
    }

    static computeVisitWatchdogTimeoutMs(
        desiredActions: number,
        delayMinSeconds: number,
        delayMaxSeconds: number,
        mode: 'agentic' | 'seo',
        threadIdx: number,
        fixedActionCount: boolean,
        options: { fproxyPoolEnabled?: boolean; proxyEnabled?: boolean } = {},
        captchaThreadStats?: ReadonlyMap<number, CaptchaThreadStat>,
    ): number {
        return computeVisitWatchdogTimeoutMs(
            desiredActions,
            delayMinSeconds,
            delayMaxSeconds,
            mode,
            threadIdx,
            fixedActionCount,
            options,
            captchaThreadStats,
        )
    }

    static computeMaxActionsForWatchdog(
        delayMinSeconds: number,
        delayMaxSeconds: number,
        threadIdx: number,
        mode: 'agentic' | 'seo',
        visitTimeoutMs: number,
        desiredActions: number,
        captchaThreadStats?: ReadonlyMap<number, CaptchaThreadStat>,
    ): number {
        return computeMaxActionsForWatchdog(
            delayMinSeconds,
            delayMaxSeconds,
            threadIdx,
            mode,
            visitTimeoutMs,
            desiredActions,
            captchaThreadStats,
        )
    }

    static isBrowserContextClosedError(error: unknown): boolean {
        return isBrowserContextClosedError(error)
    }

    static isProxyConnectionError(error: unknown): boolean {
        return isProxyConnectionError(error)
    }
}
