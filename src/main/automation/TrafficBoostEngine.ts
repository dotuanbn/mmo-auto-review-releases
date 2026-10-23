import { BrowserWindow, app } from 'electron'
import { browserService, BrowserConfig } from './BrowserService'
import { HumanBehavior } from './HumanBehavior'
import { proxyService } from '../services/ProxyService'
import { fproxyService } from '../services/FProxyService'
import {
    fproxyPoolService,
    type FProxyLease,
} from '../services/FProxyPoolService'
import { loadSettings } from '../ipc/settings'
import { runtimePolicyService } from '../runtime/v2/runtimePolicy'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import { Page } from 'playwright'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import pRetry from 'p-retry'
import PQueue from 'p-queue'
import { AgenticSearchHandler } from './AgenticSearchHandler'
import { WebSeoFlow } from './WebSeoFlow'
import { MapSearchFlow } from './MapSearchFlow'
import { extractIdentity, identitiesMatch, parseMapIdentity } from './MapIdentity'
import { agenticTrafficHandler } from './AgenticTrafficHandler'
import { autonomousMapAgent } from './AutonomousMapAgent'
import { applyStealth, DEFAULT_STEALTH_LEVEL } from './StealthPatcher'
import { ollamaService } from '../services/OllamaService'
import { networkOrchestrator } from '../runtime/v2/networkOrchestrator'
import { NetworkStateV2, RuntimeActionEvent, RuntimeDiagnosticsV2, RuntimePolicyV2 } from '../runtime/v2/types'
import { getRuntimeLogger } from '../utils/runtimeLogger'
import { miniRagService } from '../services/MiniRagService'
import { windowTilingService } from '../services/WindowTilingService'
import { systemResourceDetector } from '../services/SystemResourceDetector'
import { BrowserResourceWaitError } from '../services/BrowserResourceGovernor'
import { classifyTrafficFailure } from './TrafficFailureClassifier'
import {
    normalizeWebSeoTargetUrl,
    parseWebSeoKeywords,
} from '../../shared/web-seo-contracts'
import {
    DEFAULT_TRAFFIC_VISIT_LEASE_MS,
    isTrafficVisitFreshTransition,
    parseTrafficVisitPayload,
    type TrafficVisitPayload,
} from '../../shared/traffic-visit-contracts'
import {
    buildTrafficVisitSeedItems,
    trafficVisitQueue,
} from './TrafficVisitQueue'
import { accountHealthScorer } from '../services/AccountHealthScorer'

import {
    type SEOAction,
    type TrafficBoostStatus,
    type ThreadDetail,
    type VisitActionRecord,
    type TrafficReport,
    type ActionContext,
    type WebSeoDiscoverySource,
    type WebSeoFlowResult,
    type WebSeoExecuteConfig,
    type WebSeoVisitOutcome,
} from './traffic/types'

export type {
    SEOAction,
    TrafficBoostStatus,
    ThreadDetail,
    VisitActionRecord,
    TrafficReport,
}

import {
    trafficPageGuard,
    type PageGuardHooks,
    type PageGuardLocationRef,
    type PageGuardStatusContext,
} from './traffic/TrafficPageGuard'

import {
    runWithTimeout,
    computeVisitWatchdogTimeoutMs,
    computeMaxActionsForWatchdog,
    isBrowserContextClosedError,
    isProxyConnectionError,
    resolveWebSeoSearchKeywords,
    resolveWebSeoDwellSeconds,
    recordWebSeoStructuredOutcome,
    assertWebSeoOutcomeOrThrow,
    randomBetweenInclusive,
    normalizeDesiredActions,
    pickRandomActions,
} from './traffic/TrafficVisitExecutor'
import { trafficReportService } from './traffic/TrafficReportService'
import { layaService } from '../services/LayaService'
import { layaCampaignOptimizer } from '../services/LayaCampaignOptimizer'
import { LayaRiskContext, type CampaignMetricsSnapshot } from '../../shared/laya-types'

// ============================================================
// Web SEO result helpers
// ============================================================

function unknownErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    if (typeof error === 'string') {
        return error
    }
    if (error == null) {
        return 'unknown'
    }
    try {
        return String(error)
    } catch {
        return 'unknown'
    }
}

function sanitizeErrorDetail(error: unknown, maxLen = 500): string {
    const raw = unknownErrorMessage(error)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (!raw) {
        return 'unknown'
    }
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw
}

function parseStrictKeywordList(raw: unknown): string[] {
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

function extractTargetHost(urlOrHost: string): string | null {
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

function asWebSeoDiscoverySource(value: string | null | undefined): WebSeoDiscoverySource | null {
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

function mapWebSeoFlowResult(
    result: WebSeoFlowResult,
    fallbackTargetHost: string | null,
    discoveryOverride?: WebSeoDiscoverySource
): WebSeoVisitOutcome {
    const record = asResultRecord(result)
    const actionNames = (result.actionsPerformed || []).map((a) => a.action)
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

    // Prefer numeric quality from flow result; never parse string detail heuristics here.
    const successActionCount = (result.actionsPerformed || []).filter((a) => a.success).length
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

// ============================================================
// All SEO Actions
// ============================================================

const ALL_SEO_ACTIONS: SEOAction[] = [
    'map_zoom_in', 'map_zoom_out', 'map_drag_pan', 'map_satellite_view',
    'map_street_view', 'map_terrain_view', 'map_fullscreen', 'map_measure_distance',
    'photos_browse', 'photos_view_single', 'photos_next_prev', 'photos_category',
    'photos_owner', 'photos_latest', 'photos_360',
    'reviews_read', 'reviews_expand', 'reviews_sort', 'reviews_filter_stars',
    'reviews_view_photos', 'reviews_helpful', 'reviews_author_profile',
    'directions_driving', 'directions_walking', 'directions_transit',
    'directions_cycling', 'directions_reverse',
    'info_view_hours', 'info_view_about', 'info_phone', 'info_address_copy',
    'info_website', 'info_menu', 'info_price_range', 'info_amenities',
    'share_link', 'share_embed', 'save_place', 'send_to_phone', 'print_location',
    'explore_nearby', 'explore_similar', 'explore_category', 'explore_popular_times',
    'explore_qa', 'explore_updates',
    'browse_scroll_deep', 'browse_read_panel', 'browse_random_click', 'browse_back_forward',
]

// ============================================================
// Traffic Boost Engine
// ============================================================

export class TrafficBoostEngine {
    private readonly logger = getRuntimeLogger({ module: 'traffic-boost-engine' })
    private running = false
    private shouldStop = false
    private paused = false
    private currentCampaignId: number | null = null
    private currentCampaignName = ''
    private activeContexts: Map<number, string> = new Map() // contextId -> profilePath
    private threadContextIds: Map<number, number> = new Map() // threadId -> contextId
    private threadDetails: ThreadDetail[] = []
    private _totalRounds = 0
    private _currentRound = 0
    private _completedVisits = 0
    private _totalVisits = 0
    private _failedVisits = 0
    private currentQueueDepth = 0
    private _keywordCounters: Record<string, number> = {} // Round-robin keyword index per location
    private captchaThreadStats: Map<number, { hits: number; lastDetectedAt: number; lastResolvedAt?: number }> = new Map()
    private runtimePolicy: RuntimePolicyV2 = runtimePolicyService.getPolicy()
    private networkState: NetworkStateV2 = {
        mode: 'direct',
        reason: 'default_direct_mode',
        useProxySetting: false,
        hasFProxyApiKey: false,
        checkedAt: new Date().toISOString(),
    }
    private statusListeners: Set<(status: TrafficBoostStatus) => void> = new Set()
    private actionListeners: Set<(event: RuntimeActionEvent) => void> = new Set()
    private threadUrlBroadcastAt: Map<number, number> = new Map()
    private readonly proxyAcquireControllers = new Set<AbortController>()
    /** Campaign-local account/profile exclusivity: one concurrent visit per account/profile. */
    private campaignAccountLocks: Map<string, Promise<void>> = new Map()
    /** Stuck locks auto-release so a crashed visit cannot pin an account forever. */
    private readonly accountLockTimeoutMs = 10 * 60 * 1000

    onStatus(listener: (status: TrafficBoostStatus) => void): () => void {
        this.statusListeners.add(listener)
        return () => this.statusListeners.delete(listener)
    }

    onAction(listener: (event: RuntimeActionEvent) => void): () => void {
        this.actionListeners.add(listener)
        return () => this.actionListeners.delete(listener)
    }

    // Safe await point for pause: workers poll here between visits (keeps progress, no reset)
    private async waitWhilePaused(): Promise<void> {
        while (this.paused && !this.shouldStop) {
            await new Promise(resolve => setTimeout(resolve, 250))
        }
    }

    /**
     * Reject when `promise` does not settle within `ms`.
     * `onTimeout` runs first so the caller can release a stuck lock.
     */
    private withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                try {
                    onTimeout?.()
                } catch (error: unknown) {
                    console.error('[TrafficBoost] withTimeout handler failed:', error)
                }
                reject(new Error(`timeout after ${ms}ms`))
            }, ms)
            if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
                (timer as { unref: () => void }).unref()
            }
            const clear = (): void => {
                clearTimeout(timer)
            }
            promise.then(
                (value) => {
                    clear()
                    resolve(value)
                },
                (error: unknown) => {
                    clear()
                    reject(error instanceof Error ? error : new Error(String(error)))
                },
            )
        })
    }

    /** Lock promise that auto-releases after accountLockTimeoutMs. */
    private createTimedAccountLock(key: string): { guarded: Promise<void>; release: () => void } {
        let releaseOuter!: () => void
        const gate = new Promise<void>((resolve) => {
            releaseOuter = resolve
        })
        let guarded!: Promise<void>
        const release = (): void => {
            if (this.campaignAccountLocks.get(key) === guarded) {
                this.campaignAccountLocks.delete(key)
            }
            releaseOuter()
        }
        guarded = this.withTimeout(gate, this.accountLockTimeoutMs, () => {
            console.warn(
                `[TrafficBoost] Auto-released stuck account lock after ${this.accountLockTimeoutMs}ms: ${key}`,
            )
            release()
        })
        return { guarded, release }
    }

    /**
     * Campaign-local exclusivity for persistent Chromium profiles only.
     * Anonymous / ephemeral map-traffic visits skip lock so multi-IP threads can run concurrently.
     */
    private async acquireCampaignAccountLock(
        account: { id?: number | null; profilePath?: string | null } | null | undefined,
        options: { usePersistentProfile?: boolean } = {},
    ): Promise<() => void> {
        const usePersistentProfile = options.usePersistentProfile === true
        if (!usePersistentProfile || !account?.id) {
            return () => { /* ephemeral/anonymous: multi-IP concurrent OK */ }
        }
        const profileKey = typeof account.profilePath === 'string' && account.profilePath.trim()
            ? `profile:${account.profilePath.trim()}`
            : null
        const key = profileKey || `account:${account.id}`

        while (this.campaignAccountLocks.has(key) && !this.shouldStop) {
            const pending = this.campaignAccountLocks.get(key)
            if (!pending) {
                break
            }
            await this.withTimeout(pending, this.accountLockTimeoutMs).catch(() => {
                /* previous holder released, failed, or timed out */
            })
        }
        if (this.shouldStop) {
            throw new Error('visit_cancelled: campaign stopped while waiting for account exclusivity')
        }

        const { guarded, release } = this.createTimedAccountLock(key)
        this.campaignAccountLocks.set(key, guarded)

        let released = false
        return () => {
            if (released) {
                return
            }
            released = true
            release()
        }
    }

    // ============================================================
    // Profile Management - Each account gets a unique Chrome profile
    // ============================================================

    /**
     * Get or create a unique profile path for an account.
     * Each account gets its own Chrome profile folder that persists
     * cookies, localStorage, and login sessions.
     */
    private ensureAccountProfile(account: any): string {
        const db = getDatabase()
        const userDataPath = app.getPath('userData')

        // Prefer reuse of existing profilePath (set by login/ProfileService/manual) when dir exists.
        // This ensures campaign uses the SAME persistent profile dir as the logged-in session (launchPersistent loads cookies/state auto).
        // Only fallback to traffic_profiles/ for legacy accounts without a prior profilePath (then addCookies fallback applies).
        if (account.profilePath && existsSync(account.profilePath)) {
            // Optional self-heal only if obviously stale (non-current userData) but exists check already passed above? keep as-is for this machine.
            console.log(`[TrafficBoost] Reusing account profile for ${account.email}: ${account.profilePath}`)
            return account.profilePath
        }

        const profilesDir = join(userDataPath, 'traffic_profiles')
        if (!existsSync(profilesDir)) {
            mkdirSync(profilesDir, { recursive: true })
        }

        const sanitizedEmail = account.email.replace(/[^a-zA-Z0-9]/g, '_')
        const profilePath = join(profilesDir, `account_${account.id}_${sanitizedEmail}`)

        if (!existsSync(profilePath)) {
            mkdirSync(profilePath, { recursive: true })
        }

        // Self-heal only for this fallback path (legacy case)
        if (account.profilePath !== profilePath) {
            try {
                db.update(schema.accounts)
                    .set({ profilePath })
                    .where(eq(schema.accounts.id, account.id))
                    .run()
            } catch (err) {
                console.error(`[TrafficBoost] Failed to update profilePath in DB:`, err)
            }
            account.profilePath = profilePath
        }

        console.log(`[TrafficBoost] Profile for ${account.email}: ${profilePath}`)
        return profilePath
    }

    // Send status to renderer
    private sendStatus(status: TrafficBoostStatus) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('trafficBoost:status', status)
        }
        this.statusListeners.forEach((listener) => listener(status))
    }

    private emitActionEvent(event: RuntimeActionEvent): void {
        this.actionListeners.forEach((listener) => listener(event))
    }

    private formatProxyCountdown(totalSeconds: number): string {
        const safe = Math.max(0, Math.floor(totalSeconds))
        const m = Math.floor(safe / 60)
        const s = safe % 60
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }

    private setThreadProxyTiming(
        threadIdx: number,
        timing: {
            proxyIpExpiresAt?: number | null
            proxyRotateAt?: number | null
            visitSoftDeadlineAt?: number | null
            timingLabel?: string
            status?: ThreadDetail['status']
            action?: string
        } = {},
    ): void {
        const current = this.ensureThreadDetail(threadIdx)
        this.threadDetails[threadIdx] = {
            ...current,
            proxyIpExpiresAt: timing.proxyIpExpiresAt !== undefined ? timing.proxyIpExpiresAt : current.proxyIpExpiresAt,
            proxyRotateAt: timing.proxyRotateAt !== undefined ? timing.proxyRotateAt : current.proxyRotateAt,
            visitSoftDeadlineAt: timing.visitSoftDeadlineAt !== undefined ? timing.visitSoftDeadlineAt : current.visitSoftDeadlineAt,
            timingLabel: timing.timingLabel !== undefined ? timing.timingLabel : current.timingLabel,
            status: timing.status || current.status,
            currentAction: timing.action || current.currentAction,
        }
        this.sendStatus(this.buildStatus())
    }

private ensureThreadDetail(threadIdx: number): ThreadDetail {
        let current = this.threadDetails[threadIdx]
        if (!current) {
            current = {
                id: threadIdx,
                accountEmail: '',
                locationName: '',
                currentAction: '',
                currentUrl: '',
                status: 'waiting',
                progress: 0,
            }
            this.threadDetails[threadIdx] = current
        }
        return current
    }

    private setThreadAction(threadIdx: number, action: string): void {
        const current = this.ensureThreadDetail(threadIdx)
        if (current.currentAction === action) return
        this.threadDetails[threadIdx] = {
            ...current,
            currentAction: action,
        }
    }

    private setThreadKeyword(threadIdx: number, keyword: string): void {
        const current = this.ensureThreadDetail(threadIdx)
        this.threadDetails[threadIdx] = {
            ...current,
            currentKeyword: keyword,
        }
    }

    private updateThreadCurrentUrl(threadIdx: number, page: Page): void {
        if (page.isClosed()) {
            return
        }
        const current = this.threadDetails[threadIdx]
        if (!current) {
            return
        }
        const url = page.url() || ''
        if (!url || current.currentUrl === url) {
            return
        }
        this.threadDetails[threadIdx] = {
            ...current,
            currentUrl: url,
        }

        if (this.running) {
            const now = Date.now()
            const lastBroadcast = this.threadUrlBroadcastAt.get(threadIdx) ?? 0
            if (now - lastBroadcast >= 500) {
                this.threadUrlBroadcastAt.set(threadIdx, now)
                this.sendStatus(this.buildStatus())
            }
        }
    }

    private startThreadPageMonitor(threadIdx: number, page: Page): () => void {
        const timer = setInterval(() => {
            this.updateThreadCurrentUrl(threadIdx, page)
        }, 900)
        this.updateThreadCurrentUrl(threadIdx, page)
        return () => clearInterval(timer)
    }

    private applyRuntimeProxySettings(): { proxyEnabled: boolean; fproxyApiKey: string } {
        const savedSettings = loadSettings()
        const proxyEnabled = savedSettings.useProxy === true
        const fproxyApiKey = typeof savedSettings.fproxyApiKey === 'string' ? savedSettings.fproxyApiKey.trim() : ''

        if (!proxyEnabled) {
            if (fproxyService.hasConfiguration()) {
                fproxyService.clearConfiguration('runtime_proxy_disabled_in_settings')
            }
        } else if (fproxyApiKey) {
            if (fproxyService.getApiKey() !== fproxyApiKey) {
                fproxyService.setApiKey(fproxyApiKey)
            }
        } else if (fproxyService.getApiKey()) {
            // Proxy is enabled globally but FProxy key was removed at runtime.
            // Keep static proxy mode clean by removing stale FProxy config.
            fproxyService.clearConfiguration('runtime_proxy_key_missing')
        }

        return { proxyEnabled, fproxyApiKey }
    }

    private normalizeDomain(raw?: string): string {
        if (!raw) {
            return 'unknown'
        }
        try {
            const url = raw.startsWith('http://') || raw.startsWith('https://')
                ? new URL(raw)
                : new URL(`https://${raw}`)
            return (url.hostname || 'unknown').toLowerCase()
        } catch {
            return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || 'unknown'
        }
    }

    private deriveDecisionSource(
        source: string,
        explicit?: VisitActionRecord['decisionSource'],
        ragUsed?: boolean
    ): VisitActionRecord['decisionSource'] | undefined {
        if (explicit) {
            return explicit
        }
        const normalized = source.toLowerCase()
        if (normalized.includes('heuristic')) {
            return 'heuristic'
        }
        if (normalized.includes('llm')) {
            return ragUsed ? 'llm+rag' : 'llm'
        }
        return undefined
    }

    private recordAction(
        actionsPerformed: VisitActionRecord[],
        input: VisitActionRecord,
        context: ActionContext
    ): void {
        const timestamp = input.timestamp || new Date().toISOString()
        const normalized: VisitActionRecord = {
            ...input,
            timestamp,
            threadId: input.threadId ?? context.threadId,
        }
        const source = normalized.source || 'runtime'
        const decisionSource = this.deriveDecisionSource(source, normalized.decisionSource, normalized.ragUsed)
        const ragUsed = normalized.ragUsed === true || decisionSource === 'llm+rag'

        actionsPerformed.push(normalized)

        const actionEvent: RuntimeActionEvent = {
            eventId: `${timestamp}-${context.threadId}-${Math.random().toString(36).slice(2, 8)}`,
            campaignId: context.campaignId,
            campaignName: context.campaignName,
            round: context.round,
            threadId: normalized.threadId ?? context.threadId,
            accountEmail: context.accountEmail,
            locationName: context.locationName,
            action: normalized.action,
            source,
            success: normalized.success !== false,
            detail: normalized.detail,
            thought: normalized.thought,
            error: normalized.error,
            durationMs: normalized.durationMs,
            step: normalized.step,
            elementId: normalized.elementId,
            attempt: normalized.attempt,
            retryCategory: normalized.retryCategory,
            queueDepth: normalized.queueDepth ?? this.currentQueueDepth,
            latencyMs: normalized.latencyMs,
            recoverPath: normalized.recoverPath,
            decisionSource,
            ragUsed,
            ragHitCount: normalized.ragHitCount,
            ragEvidenceIds: normalized.ragEvidenceIds,
            decisionLatencyMs: normalized.decisionLatencyMs,
            timestamp,
        }
        this.logger.info({
            event: 'runtime_action',
            campaignId: actionEvent.campaignId,
            threadId: actionEvent.threadId,
            action: actionEvent.action,
            source: actionEvent.source,
            success: actionEvent.success,
            attempt: actionEvent.attempt,
            retryCategory: actionEvent.retryCategory,
            queueDepth: actionEvent.queueDepth,
            latencyMs: actionEvent.latencyMs,
            recoverPath: actionEvent.recoverPath,
            decisionSource: actionEvent.decisionSource,
            ragUsed: actionEvent.ragUsed,
            ragHitCount: actionEvent.ragHitCount,
            timestamp: actionEvent.timestamp,
        })
        void miniRagService.ingest({
            campaignType: 'traffic',
            campaignId: context.campaignId,
            threadId: normalized.threadId ?? context.threadId,
            domain: context.domain,
            goal: context.goal || 'map_interaction',
            riskType: normalized.retryCategory || normalized.action || context.riskType,
            signalText: normalized.thought || normalized.detail || normalized.action,
            action: normalized.action,
            decisionSource: decisionSource || source,
            success: normalized.success !== false,
            detail: normalized.detail,
            error: normalized.error,
            recoverPath: normalized.recoverPath,
            latencyMs: normalized.latencyMs ?? normalized.decisionLatencyMs ?? normalized.durationMs,
            metadata: actionEvent.ragEvidenceIds ? { ragEvidenceIds: actionEvent.ragEvidenceIds } : undefined,
            timestamp,
        }).catch(() => { })
        this.emitActionEvent(actionEvent)
    }

    // Build current status object
    private buildStatus(overrides: Partial<TrafficBoostStatus> = {}): TrafficBoostStatus {
        return {
            isRunning: this.running,
            isPaused: this.paused,
            campaignId: this.currentCampaignId ?? null,
            campaignName: this.currentCampaignName,
            activeThreads: this.threadDetails.filter(t => t.status === 'visiting').length,
            threadsTotal: this.threadDetails.length,
            currentRound: this._currentRound,
            totalRounds: this._totalRounds,
            completedVisits: this._completedVisits,
            totalVisits: this._totalVisits,
            failedVisits: this._failedVisits,
            message: 'Idle',
            threads: this.threadDetails.map(t => ({
                id: t.id,
                accountEmail: t.accountEmail,
                locationName: t.locationName,
                currentAction: t.currentAction,
                currentUrl: t.currentUrl || '',
                currentKeyword: t.currentKeyword || '',
                status: t.status,
                progress: t.progress ?? 0,
                proxyInfo: t.proxyInfo || '',
                proxyIpExpiresAt: t.proxyIpExpiresAt ?? null,
                proxyRotateAt: t.proxyRotateAt ?? null,
                visitSoftDeadlineAt: t.visitSoftDeadlineAt ?? null,
                timingLabel: t.timingLabel || '',
            })),
            effectiveNetworkMode: this.networkState.mode,
            networkState: this.networkState,
            ...overrides,
        }
    }

    private refreshRuntimePolicy(): RuntimePolicyV2 {
        this.runtimePolicy = runtimePolicyService.getPolicy()
        trafficPageGuard.refreshRuntimePolicy()
        return this.runtimePolicy
    }

    getDiagnostics(): RuntimeDiagnosticsV2 {
        return {
            timestamp: new Date().toISOString(),
            isRunning: this.running,
            campaignId: this.currentCampaignId ?? null,
            activeContexts: this.activeContexts.size,
            activeThreads: this.threadDetails.filter(t => t.status === 'visiting').length,
            queueDepth: this.currentQueueDepth,
            captchaByThread: Array.from(this.captchaThreadStats.entries()).map(([threadId, stats]) => ({
                threadId,
                hits: stats.hits,
                lastDetectedAt: stats.lastDetectedAt,
                lastResolvedAt: stats.lastResolvedAt,
            })),
        }
    }

    getActionTrace(campaignId?: number, limit: number = 500): Array<Record<string, unknown>> {
        return trafficReportService.getActionTrace(campaignId, limit)
    }

    private pageGuardHooks(): PageGuardHooks {
        return {
            setThreadAction: (threadIndex, action) => {
                this.setThreadAction(threadIndex, action)
            },
            recordAction: (actionsPerformed, input, context) => {
                this.recordAction(actionsPerformed, input, context)
                this.mirrorCaptchaStatsFromAction(input)
            },
            sendStatus: (overrides) => {
                this.sendStatus(this.buildStatus(overrides))
            },
            updateThreadCurrentUrl: (threadIndex, page) => {
                this.updateThreadCurrentUrl(threadIndex, page)
            },
            getQueueDepth: () => this.currentQueueDepth,
        }
    }

    /** Diagnostics and watchdog delay read this mirror. Page guard owns the live strikes. */
    private mirrorCaptchaStatsFromAction(input: VisitActionRecord): void {
        const threadIdx = input.threadId
        if (threadIdx == null) {
            return
        }
        if (input.action === 'captcha_detected' && typeof input.attempt === 'number') {
            const previous = this.captchaThreadStats.get(threadIdx)
            this.captchaThreadStats.set(threadIdx, {
                hits: input.attempt,
                lastDetectedAt: Date.now(),
                lastResolvedAt: previous?.lastResolvedAt,
            })
            return
        }
        const captchaRecovered = input.action === 'captcha_auto_solved'
            || (input.action === 'context_recover_map_success' && input.retryCategory === 'captcha')
        if (!captchaRecovered) {
            return
        }
        const current = this.captchaThreadStats.get(threadIdx)
        if (!current) {
            return
        }
        this.captchaThreadStats.set(threadIdx, {
            hits: Math.max(0, current.hits - 1),
            lastDetectedAt: current.lastDetectedAt,
            lastResolvedAt: Date.now(),
        })
    }

    private isGoogleLoginUrl(rawUrl: string): boolean {
        return trafficPageGuard.isGoogleLoginUrl(rawUrl)
    }

    private async isCaptchaOrSorryPage(page: Page): Promise<boolean> {
        return trafficPageGuard.isCaptchaOrSorryPage(page)
    }

    private async isMapUiReady(page: Page): Promise<boolean> {
        return trafficPageGuard.isMapUiReady(page)
    }

    private async hasVisibleBlockingDialog(page: Page): Promise<boolean> {
        return trafficPageGuard.hasVisibleBlockingDialog(page)
    }

    private markCaptchaDetected(threadIdx: number): { hits: number; lastDetectedAt: number; lastResolvedAt?: number } {
        return trafficPageGuard.markCaptchaDetected(threadIdx)
    }

    private markCaptchaResolved(threadIdx: number): void {
        trafficPageGuard.markCaptchaResolved(threadIdx)
    }

    private shouldAvoidGoogleSearch(threadIdx: number): boolean {
        return trafficPageGuard.shouldAvoidGoogleSearch(threadIdx)
    }

    private getAdaptiveDelayFactor(threadIdx: number): number {
        return trafficPageGuard.getAdaptiveDelayFactor(threadIdx)
    }

    private async cleanupExtraTabsForThread(page: Page, threadIdx: number, reason: string): Promise<void> {
        await trafficPageGuard.cleanupExtraTabsForThread(page.context(), page, threadIdx, reason)
    }

    private async ensureDirectModeMapReady(
        page: Page,
        threadIdx: number,
        location: PageGuardLocationRef,
        statusContext: PageGuardStatusContext,
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        hasAccount: boolean,
    ): Promise<void> {
        await trafficPageGuard.ensureDirectModeMapReady(page, location, threadIdx, {
            statusContext,
            actionsPerformed,
            actionContext,
            hasAccount,
            hooks: this.pageGuardHooks(),
        })
    }

    private async handleGoogleLoginIfNeeded(
        page: Page,
        threadIdx: number,
        statusContext: PageGuardStatusContext,
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        fallbackUrl: string,
    ): Promise<void> {
        await trafficPageGuard.handleGoogleLoginIfNeeded(page, threadIdx, {
            statusContext,
            actionsPerformed,
            actionContext,
            fallbackUrl,
            hooks: this.pageGuardHooks(),
        })
    }

    private async handleCaptchaIfNeeded(
        page: Page,
        threadIdx: number,
        statusContext: PageGuardStatusContext,
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        fallbackUrl: string,
    ): Promise<void> {
        await trafficPageGuard.handleCaptchaIfNeeded(page, threadIdx, {
            statusContext,
            actionsPerformed,
            actionContext,
            fallbackUrl,
            hooks: this.pageGuardHooks(),
        })
    }

    private async stabilizeContextIfNeeded(
        page: Page,
        threadIdx: number,
        reason: string,
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        statusContext?: PageGuardStatusContext,
    ): Promise<void> {
        await trafficPageGuard.stabilizeContextIfNeeded(page, threadIdx, {
            reason,
            actionsPerformed,
            actionContext,
            statusContext,
            hooks: this.pageGuardHooks(),
        })
    }

    // ============================================================
    // Start Campaign
    // ============================================================

    async startCampaign(campaignId: number): Promise<void> {
        if (this.running) {
            console.log('[TrafficBoost] Already running')
            return
        }

        const db = getDatabase()
        const campaign = db.select().from(schema.trafficCampaigns).where(eq(schema.trafficCampaigns.id, campaignId)).get()
        if (!campaign) throw new Error('Campaign not found')

        // In-process resume: unpause without full re-init (counters already loaded from DB on prior start)
        if (this.running && this.currentCampaignId === campaignId) {
            if (this.paused) {
                this.paused = false
                if (fproxyService.getApiKey() && fproxyService.isAutoRotateActive() === false) {
                    fproxyService.resumeAutoRotate()
                }
                const db = getDatabase()
                db.update(schema.trafficCampaigns).set({ status: 'running' }).where(eq(schema.trafficCampaigns.id, campaignId)).run()
                this.sendStatus(this.buildStatus({ message: 'Resumed from pause' }))
                return
            }
            console.log('[TrafficBoost] Already running')
            return
        }

        this.running = true
        let terminalMessage = 'Traffic boost stopped'

        try {
        this.shouldStop = false
        this.currentCampaignId = campaignId
        this.currentQueueDepth = 0
        this.threadUrlBroadcastAt.clear()

        // Reset browser singleton state before each campaign start.
        // This prevents reusing an old hidden(headless) browser from previous account checks.
        try {
            await browserService.closeBrowser()
        } catch (error) {
            console.log('[TrafficBoost] Browser reset warning (non-fatal):', error)
        }
        this.activeContexts.clear()
        this.threadContextIds.clear()
        windowTilingService.reset()

        this.refreshRuntimePolicy()
        this.logger.info({
            event: 'campaign_start',
            campaignId,
            policy: this.runtimePolicy,
        })
        
        // Log system resources & calculate limits
        systemResourceDetector.logCurrentStats()
        const systemRecs = systemResourceDetector.getRecommendations()
        const globalSettings = loadSettings()
        const configuredMaxBrowsers = globalSettings.maxConcurrentBrowsers ?? 3

        // Load proxy runtime settings from a single source of truth
        const runtimeProxySettings = this.applyRuntimeProxySettings()
        const proxyEnabled = runtimeProxySettings.proxyEnabled
        let fproxyPoolSnapshot = await fproxyPoolService.getSnapshot()
        let enabledPoolSlots = fproxyPoolSnapshot.slots.filter(
            slot => slot.enabled && slot.hasSecret,
        )
        if (proxyEnabled && enabledPoolSlots.length === 0 && runtimeProxySettings.fproxyApiKey) {
            try {
                await fproxyPoolService.upsertLegacyApiKey(runtimeProxySettings.fproxyApiKey)
                fproxyPoolSnapshot = await fproxyPoolService.getSnapshot()
                enabledPoolSlots = fproxyPoolSnapshot.slots.filter(
                    slot => slot.enabled && slot.hasSecret,
                )
            } catch {
                // Keep legacy single-key fallback if pool DB write fails
            }
        }
        const enabledPoolSlotCount = enabledPoolSlots.length
        const fproxyPoolEnabled = proxyEnabled && enabledPoolSlotCount > 0
        const strictFproxyPool = fproxyPoolEnabled && fproxyPoolSnapshot.policy.strictUnique
        const maxGlobalBrowsers = fproxyPoolEnabled
            ? Math.max(configuredMaxBrowsers, Math.min(10, enabledPoolSlotCount))
            : configuredMaxBrowsers
        let safeThreadCount = Math.min(maxGlobalBrowsers, Math.max(1, Math.floor(Number(campaign.threadsCount || 1))))
        this.networkState = await networkOrchestrator.resolveEffectiveMode()
        if (proxyEnabled && runtimeProxySettings.fproxyApiKey && !fproxyService.getApiKey()) {
            fproxyService.setApiKey(runtimeProxySettings.fproxyApiKey)
            console.log('[TrafficBoost] ðŸ”‘ FProxy API key loaded from settings')
        }
        if (!proxyEnabled) {
            if (fproxyService.hasConfiguration()) {
                fproxyService.clearConfiguration('campaign_start_proxy_disabled')
            }
            console.log('[TrafficBoost] Proxy disabled in settings -> direct connection mode')
            this.networkState = {
                ...this.networkState,
                mode: 'direct',
                reason: 'campaign_start_proxy_disabled',
                checkedAt: new Date().toISOString(),
            }
        }

        // Start FProxy auto-rotate if API key is configured
        if (proxyEnabled && !fproxyPoolEnabled && fproxyService.getApiKey()) {
            this.networkState = {
                ...this.networkState,
                mode: 'fproxy',
                reason: 'fproxy_enabled',
                checkedAt: new Date().toISOString(),
            }
            console.log('[TrafficBoost] ðŸ›¡ï¸ FProxy proxy enabled â€” auto-rotate every 2 min')
            // Auto-rotate every 2 minutes (120s)
            fproxyService.startAutoRotate(120_000)
            fproxyService.setOnProxyChanged((newProxy) => {
                console.log(`[TrafficBoost] ðŸ”„ Proxy IP rotated: ${newProxy.httpuserpass?.split(':')[0]} (${newProxy.location})`)
            })
        } else {
            fproxyService.stopAutoRotate()
        }
        this.networkState = await networkOrchestrator.resolveEffectiveMode()

        // Parse account and location IDs
        const accountIds: number[] = JSON.parse(campaign.accountIds || '[]')
        const locationIds: number[] = JSON.parse(campaign.locationIds || '[]')
        const enabledActions: SEOAction[] = campaign.enabledActions
            ? (() => {
                // Map old action names to new ones for backward compatibility
                const OLD_TO_NEW: Record<string, SEOAction> = {
                    'browse_map': 'map_drag_pan',
                    'view_photos': 'photos_browse',
                    'view_reviews': 'reviews_read',
                    'get_directions': 'directions_driving',
                    'view_about': 'info_view_about',
                    'share_location': 'share_link',
                    'view_nearby': 'explore_nearby',
                    'click_website': 'info_website',
                    'view_hours': 'info_view_hours',
                    'scroll_read': 'browse_scroll_deep',
                }
                const parsed: string[] = JSON.parse(campaign.enabledActions!)
                return parsed.map(a => OLD_TO_NEW[a] || a as SEOAction)
            })()
            : ALL_SEO_ACTIONS
        const campaignUseFixedActionCount = campaign.fixedActionCount === true
        const runtimeSettings = loadSettings()
        // groqApiKey can be stored in settings.json OR in the SQLite database.
        // Check both sources to avoid the "always empty" bug.
        let groqKeyFromSettings = runtimeSettings.groqApiKey || ''
        if (!groqKeyFromSettings) {
            try {
                const dbKeyRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'groqApiKey')).get()
                if (dbKeyRow && dbKeyRow.value) {
                    groqKeyFromSettings = dbKeyRow.value
                }
            } catch (_e) { /* ignore db read errors */ }
        }
        const agenticEnabledBySettings = !!groqKeyFromSettings
        const aiAutoControlEnabled = campaign.aiAutoControl === true
        const allowAgenticMapPlanner = (runtimeSettings as Record<string, unknown>).enableAgenticMaps === true
        const agenticMapPlannerReady = aiAutoControlEnabled && allowAgenticMapPlanner && agenticEnabledBySettings
        if (agenticMapPlannerReady) {
            console.log('[TrafficBoost] Agentic Maps planner enabled by campaign AI auto-control and internal setting. LLM path is active.')
        } else {
            console.log('[TrafficBoost] Deterministic Maps SEO flow active. LLM planner is disabled for Maps traffic.')
        }

        if (locationIds.length === 0) {
            throw new Error('No locations configured')
        }

        // Get accounts (use only the campaign-selected IDs; defensively drop banned/suspended so we don't waste visits on dead accounts)
        let accounts: any[] = []
        if (accountIds.length > 0) {
            const all = db.select().from(schema.accounts).all()
            accounts = all.filter(a => accountIds.includes(a.id) && a.status !== 'banned' && a.status !== 'suspended')
        }
        // Sprint 3: filter out accounts that need rest (fail-open for traffic)
        if (accounts.length > 1) {
            try {
                const healthMap = accountHealthScorer.evaluateAll()
                const healthy = accounts.filter((a: any) => {
                    const h = healthMap.get(a.id)
                    return !h || !h.shouldRest
                })
                if (healthy.length > 0) accounts = healthy
            } catch { /* health check failure = use all accounts */ }
        }
        if (accounts.length === 0) accounts = [null] // anonymous / no usable account

        const usableAccountCount = accounts.filter((account) => account !== null).length
        // web_seo needs logged-in/profile exclusivity, so threads cannot exceed usable accounts.
        // maps traffic (direct/organic/map_search) is multi-IP: concurrent visits are OK even with 1 account.
        const mapsMultiIpTraffic = campaign.trafficMode !== 'web_seo'
        if (fproxyPoolEnabled) {
            const beforeThreads = safeThreadCount
            // Strict 1 key = 1 browser rule: each enabled FProxy key manages its own
            // single browser lifecycle and cannot open more than 1 concurrent browser.
            safeThreadCount = Math.min(safeThreadCount, enabledPoolSlotCount)
            if (safeThreadCount !== beforeThreads) {
                console.log(
                    '[TrafficBoost] FProxy 1-key-per-browser clamp threads ' +
                    beforeThreads + ' -> ' + safeThreadCount +
                    ' (enabledSlots=' + enabledPoolSlotCount +
                    ', maps=' + locationIds.length + ')',
                )
            }
        } else if (proxyEnabled && fproxyService.getApiKey()) {
            safeThreadCount = 1
        }
        if (campaign.trafficMode === 'web_seo' && usableAccountCount > 0) {
            safeThreadCount = Math.min(safeThreadCount, usableAccountCount)
        }
        console.log(
            `[TrafficBoost] Concurrency plan: threads=${safeThreadCount}, ` +
            `enabledFProxySlots=${enabledPoolSlotCount}, accounts=${usableAccountCount || 0}, ` +
            `maps=${locationIds.length}, ` +
            `mode=${campaign.trafficMode || 'direct'}, mapsMultiIp=${mapsMultiIpTraffic}`,
        )

        // Get locations
        const allLocations = db.select().from(schema.locations).all().filter(l => locationIds.includes(l.id))
        if (allLocations.length === 0) throw new Error('No valid locations found')

        if (campaign.trafficMode === 'web_seo') {
            const campaignKeywords = parseWebSeoKeywords(campaign.searchKeywords)
            if (campaignKeywords.length === 0) {
                throw new Error('web_seo_invalid_target: campaign has no valid search keywords')
            }
            for (const location of allLocations) {
                if (!normalizeWebSeoTargetUrl(location.url)) {
                    throw new Error(`web_seo_invalid_target: location ${location.id} is not a public safe URL`)
                }
            }
        }

        // Calculate total visits needed
        const totalVisits = allLocations.length * campaign.visitsPerLocation
        db.update(schema.trafficCampaigns)
            .set({ status: 'running', startedAt: new Date(), totalVisits })
            .where(eq(schema.trafficCampaigns.id, campaignId))
            .run()

        // Durable per-visit queue: idempotent seed + lease recovery before workers claim
        const campaignRequestedActions = normalizeDesiredActions(campaign.actionsPerVisit)
        const seedAccountIds: Array<number | null> = accounts.map((a) =>
            a && typeof a.id === 'number' ? a.id : null,
        )
        await trafficVisitQueue.ensureLoaded()
        await trafficVisitQueue.seedCampaign(
            campaignId,
            buildTrafficVisitSeedItems({
                locations: allLocations.map((l) => ({ id: l.id })),
                accountIds: seedAccountIds,
                visitsPerLocation: campaign.visitsPerLocation,
                requestedActions: campaignRequestedActions,
            }),
        )
        await trafficVisitQueue.recoverExpiredLeases(campaignId)
        const durableCounters = trafficVisitQueue.getCampaignCounters(campaignId)

        // Initialize class-level tracking fields (counters derived from durable queue)
        this.currentCampaignName = campaign.name
        this._totalVisits = totalVisits
        this._totalRounds = campaign.visitsPerLocation
        this._completedVisits = durableCounters.done
        this._failedVisits = durableCounters.failed
        this._currentRound = campaign.currentRound || 0
        this.paused = false
        db.update(schema.trafficCampaigns)
            .set({
                completedVisits: durableCounters.done,
                failedVisits: durableCounters.failed,
            })
            .where(eq(schema.trafficCampaigns.id, campaignId))
            .run()

        // Initialize thread details
        this.threadDetails = Array.from({ length: safeThreadCount }, (_, i) => ({
            id: i,
            accountEmail: '',
            locationName: '',
            currentAction: '',
            currentUrl: '',
            status: 'idle' as const,
            progress: 0,
        }))

        this.sendStatus(this.buildStatus({
            message: `Starting traffic boost with ${safeThreadCount} threads (Recommended max: ${systemRecs.maxSafeThreads}, Campaign config: ${campaign.threadsCount})...`,
        }))

        let completedVisits = this._completedVisits
        let failedVisits = this._failedVisits
        let currentRound = this._currentRound

        // MAIN LOOP: durable claim until no remaining work (done/failed/cancelled cover target)
        interface VisitTask {
            durableVisitId: string
            account: (typeof accounts)[number] | null
            location: (typeof allLocations)[number]
            round: number
            requestedActions: number
            watchdogRetryCount: number
            proxyRetryCount: number
            forceDirectConnection: boolean
        }
        const locationById = new Map(allLocations.map((l) => [l.id, l]))
        const accountById = new Map(
            accounts
                .filter((a): a is NonNullable<typeof a> => a != null && typeof a.id === 'number')
                .map((a) => [a.id as number, a]),
        )

        const resolveVisitTask = (
            durableId: string,
            payload: TrafficVisitPayload,
        ): VisitTask | null => {
            const location = locationById.get(payload.locationId)
            if (!location) return null
            const account =
                payload.accountId != null ? (accountById.get(payload.accountId) ?? null) : null
            return {
                durableVisitId: durableId,
                account,
                location,
                round: payload.round,
                requestedActions: payload.requestedActions ?? campaignRequestedActions,
                watchdogRetryCount: payload.watchdogRetryCount ?? 0,
                proxyRetryCount: payload.proxyRetryCount ?? 0,
                forceDirectConnection: payload.forceDirectConnection === true,
            }
        }

        const startTime = Date.now()

        while (!this.shouldStop) {
                await this.waitWhilePaused()
                await trafficVisitQueue.recoverExpiredLeases(campaignId)
                const waveCounters = trafficVisitQueue.getCampaignCounters(campaignId)
                completedVisits = waveCounters.done
                failedVisits = waveCounters.failed
                this._completedVisits = completedVisits
                this._failedVisits = failedVisits
                if (waveCounters.remaining === 0) break

                currentRound = Math.max(currentRound, 1)
                this._currentRound = currentRound
                console.log(`[TrafficBoost] Durable visit wave (remaining=${waveCounters.remaining})...`)
                this.sendStatus(this.buildStatus({
                    message: `Queue wave: ${waveCounters.remaining} visit(s) remaining...`,
                }))
                this.currentQueueDepth = waveCounters.remaining

                // === Laya Campaign Optimizer (Phase 2) — advisory only, never stops campaign ===
                try {
                    const optimizerMetrics: CampaignMetricsSnapshot = {
                        campaignId,
                        campaignName: campaign.name,
                        trafficMode: campaign.trafficMode || 'direct',
                        totalVisits,
                        completedVisits,
                        failedVisits,
                        successRate: totalVisits > 0 ? completedVisits / totalVisits : 1,
                        consecutiveFailures: 0, // Not tracked at wave level; per-visit tracking is separate
                        currentThreadCount: safeThreadCount,
                        avgVisitDurationMs: 0,
                        elapsedMs: Date.now() - startTime,
                        locationCount: locationIds.length,
                    }
                    const optimization = await layaCampaignOptimizer.optimize(optimizerMetrics)
                    console.log(`[TrafficBoost] Laya optimizer: pacing=${optimization.suggestedPacing} threads=${optimization.suggestedThreadCount} continue=${optimization.shouldContinue}`)
                } catch (optErr) {
                    console.log('[TrafficBoost] Laya optimizer offline, using default pacing')
                }

                // Keep campaign workers fully utilized via atomic durable claims.
                const queueConcurrency = safeThreadCount
                const visitQueue = new PQueue({
                    concurrency: queueConcurrency,
                    carryoverConcurrencyCount: true,
                })
                const threadPromises: Promise<void>[] = []

                for (let t = 0; t < safeThreadCount; t++) {
                    const threadIdx = t
                    const assignedSlotId = fproxyPoolEnabled
                        ? enabledPoolSlots[threadIdx % enabledPoolSlots.length]?.id
                        : undefined
                    threadPromises.push((async () => {
                        try {
                            // Stagger thread starts to prevent huge RAM spikes on low spec PCs
                            if (threadIdx > 0 && systemRecs.staggerDelayMs > 0) {
                                const delayConfig = threadIdx * systemRecs.staggerDelayMs
                                console.log(`[TrafficBoost] Staggering Thread ${threadIdx + 1} start by ${delayConfig}ms to prevent RAM spike.`)
                                await HumanBehavior.randomDelay(delayConfig, delayConfig + 500)
                            }
                            const idlePollDelayMs = 120
                            const maxIdlePollsBeforeDone = 20
                            let idlePollCount = 0
                            while (!this.shouldStop) {
                                await this.waitWhilePaused()
                                const claimed = await trafficVisitQueue.claimNextVisit(
                                    campaignId,
                                    `thread-${threadIdx}`,
                                    DEFAULT_TRAFFIC_VISIT_LEASE_MS,
                                    new Date(),
                                    { disallowRunningLocations: false },
                                )
                                if (!claimed) {
                                    const depth = trafficVisitQueue.getCampaignCounters(campaignId)
                                    this.currentQueueDepth = Math.max(0, depth.remaining)
                                    const hasInFlight =
                                        depth.running > 0 || visitQueue.size > 0 || visitQueue.pending > 0
                                    if (hasInFlight || idlePollCount < maxIdlePollsBeforeDone) {
                                        idlePollCount += 1
                                        await new Promise(resolve => setTimeout(resolve, idlePollDelayMs))
                                        continue
                                    }
                                    break
                                }
                                idlePollCount = 0

                                const payload = parseTrafficVisitPayload(claimed.payload)
                                if (!payload) {
                                    await trafficVisitQueue.failVisit(
                                        claimed.id,
                                        'invalid_visit_payload',
                                        { permanent: true },
                                    )
                                    continue
                                }
                                const task = resolveVisitTask(claimed.id, payload)
                                if (!task) {
                                    await trafficVisitQueue.failVisit(
                                        claimed.id,
                                        'visit_location_missing',
                                        { permanent: true },
                                    )
                                    continue
                                }
                                await this.waitWhilePaused()
                                if (task.round > currentRound) {
                                    currentRound = task.round
                                    this._currentRound = currentRound
                                }
                                await visitQueue.add(async () => {
                                // === Laya AI Risk Gate ===
                                try {
                                    const layaCtx: LayaRiskContext = {
                                        accountEmail: task.account?.email || 'anonymous',
                                        locationName: task.location.name,
                                        trafficMode: campaign.trafficMode || 'direct',
                                        threadCount: safeThreadCount,
                                        consecutiveFailures: failedVisits,
                                    }
                                    const risk = await layaService.riskScore(layaCtx)
                                    console.log(`[TrafficBoost] Laya risk: score=${risk.score} level=${risk.level}`)
                                    if (!risk.shouldProceed) {
                                        console.warn(`[TrafficBoost] Laya risk gate BLOCKED visit (score=${risk.score}, reason=${risk.reason})`)
                                        await trafficVisitQueue.failVisit(claimed.id, `laya_risk_gate:${risk.reason}`, { permanent: false })
                                        return
                                    }
                                    const suggestedDelayMs = risk.suggestedDelayMs
                                    if (suggestedDelayMs !== undefined && suggestedDelayMs > 0) {
                                        console.log(`[TrafficBoost] Laya suggested delay: ${suggestedDelayMs}ms`)
                                        await new Promise(resolve => setTimeout(resolve, Math.min(suggestedDelayMs, 30000)))
                                    }
                                } catch (layaErr) {
                                    // Laya offline = silent skip, don't block the visit
                                    console.log('[TrafficBoost] Laya AI offline, skipping risk check')
                                }

                                // Maps multi-IP traffic uses ephemeral browsers so one selected account
                                // never serializes N concurrent proxy visits on the same map.
                                const usePersistentProfile = !mapsMultiIpTraffic && !!task.account
                                const releaseAccountLock = await this.acquireCampaignAccountLock(task.account, {
                                    usePersistentProfile,
                                })
                                let stopPageMonitor: (() => void) | null = null
                                try {
                                const depthNow = trafficVisitQueue.getCampaignCounters(campaignId)
                                this.currentQueueDepth = Math.max(0, depthNow.remaining)
                                const accountEmail = task.account?.email || 'Anonymous'
                                const locationName = task.location.name
                                const actionContext = {
                                    campaignId,
                                    campaignName: campaign.name,
                                    round: task.round,
                                    threadId: threadIdx,
                                    accountEmail,
                                    locationName,
                                    domain: this.normalizeDomain(task.location.url),
                                    goal: campaign.trafficMode === 'web_seo' ? 'website_browse' : 'map_interaction',
                                    riskType: 'campaign_step',
                                }

                            const waitingForProxySync = proxyEnabled && (
                                fproxyPoolEnabled
                                || (Boolean(fproxyService.getApiKey()) && fproxyService.isAutoRotateActive())
                            )

                            // Update thread detail (keep status='waiting' until key rotation is ready and browser opens)
                            this.threadDetails[threadIdx] = {
                                id: threadIdx,
                                accountEmail,
                                locationName,
                                status: waitingForProxySync ? 'waiting' : 'visiting',
                                currentAction: waitingForProxySync ? 'Syncing FProxy rotation...' : 'Opening browser...',
                                currentUrl: '',
                                progress: 0,
                            }

                            this.sendStatus(this.buildStatus({
                                campaignName: campaign.name,
                                currentRound,
                                completedVisits,
                                totalVisits,
                                failedVisits,
                                message: waitingForProxySync
                                    ? `Thread ${threadIdx + 1}: Syncing FProxy key for ${locationName}`
                                    : `Thread ${threadIdx + 1}: Visiting ${locationName}`,
                            }))

                            // === Proxy Countdown Sync (1 key = 1 browser = 1 visit per IP): wait by server waiting_time before visit ===
                            let preSyncedAvailableMs: number | null = null
                            if (proxyEnabled && fproxyPoolEnabled) {
                                const proxyIntervalSec = 120
                                const minTimeRequired = Math.max(30, Math.floor(proxyIntervalSec * 0.8))
                                const waitResult = await fproxyPoolService.waitForFreshRotation(
                                    minTimeRequired,
                                    () => this.shouldStop,
                                    (msg) => {
                                        // Parse "... Ns remaining" for live thread timing UI.
                                        const match = /(\d+)s remaining/i.exec(msg)
                                        const leftSec = match ? Number(match[1]) : 0
                                        this.setThreadProxyTiming(threadIdx, {
                                            status: 'waiting',
                                            proxyRotateAt: leftSec > 0 ? Date.now() + leftSec * 1000 : Date.now(),
                                            proxyIpExpiresAt: null,
                                            visitSoftDeadlineAt: null,
                                            timingLabel: leftSec > 0
                                                ? `Cho xoay IP ${this.formatProxyCountdown(leftSec)}`
                                                : 'Dang lay IP moi',
                                            action: msg,
                                        })
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                            message: `Thread ${threadIdx + 1}: ${msg}`,
                                        }))
                                    },
                                    undefined,
                                    task.location.id,
                                    assignedSlotId,
                                )
                                preSyncedAvailableMs = waitResult.availableMs
                                if (this.shouldStop || preSyncedAvailableMs <= 0) {
                                    if (this.shouldStop) return
                                    await trafficVisitQueue.failVisit(
                                        task.durableVisitId,
                                        'proxy_wait_unavailable',
                                        { immediateRetry: true },
                                    )
                                    return
                                }
                                console.log(
                                    `[TrafficBoost] Thread ${threadIdx + 1}: FProxy pool ready after countdown sync, ` +
                                    `available=${Math.round(preSyncedAvailableMs / 1000)}s, readySlots=${waitResult.readySlotIds.join(',') || 'n/a'}`,
                                )
                            } else if (
                                !fproxyPoolEnabled
                                && proxyEnabled
                                && fproxyService.getApiKey()
                                && fproxyService.isAutoRotateActive()
                                && fproxyService.hasUsableProxy()
                            ) {
                                const proxyIntervalSec = Math.round(fproxyService.getRotateIntervalMs() / 1000)
                                // Require at least 80% of the rotation interval to start a visit
                                const minTimeRequired = Math.max(30, Math.floor(proxyIntervalSec * 0.8))

                                const availableMs = await fproxyService.waitForFreshRotation(
                                    minTimeRequired,
                                    () => this.shouldStop,
                                    (msg) => {
                                        const match = /(\d+)s remaining/i.exec(msg)
                                        const leftSec = match ? Number(match[1]) : 0
                                        this.setThreadProxyTiming(threadIdx, {
                                            status: 'waiting',
                                            proxyRotateAt: leftSec > 0 ? Date.now() + leftSec * 1000 : Date.now(),
                                            timingLabel: leftSec > 0
                                                ? `Cho xoay IP ${this.formatProxyCountdown(leftSec)}`
                                                : 'Dang lay IP moi',
                                            action: msg,
                                        })
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                            message: `Thread ${threadIdx + 1}: ${msg}`,
                                        }))
                                    },
                                )
                                preSyncedAvailableMs = availableMs

                                if (this.shouldStop || availableMs <= 0) {
                                    // Do not leave a claimed running visit orphaned:
                                    // stop path cancels non-terminal; proxy wait abort requeues immediately.
                                    if (this.shouldStop) {
                                        return
                                    }
                                    await trafficVisitQueue.failVisit(
                                        task.durableVisitId,
                                        'proxy_wait_unavailable',
                                        { immediateRetry: true },
                                    )
                                    return
                                }
                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Proxy ready! Starting visit with ${Math.round(availableMs / 1000)}s available`)
                            } else if (!fproxyPoolEnabled && proxyEnabled && fproxyService.getApiKey() && fproxyService.isAutoRotateActive()) {
                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy has no usable lease yet, skipping countdown wait and attempting direct acquisition`)
                            }
                            
                            const visitStart = Date.now()
                            /**
                             * Typed per-visit Web SEO outcome (null for non-web_seo modes).
                             * Held in a box so nested async + catch can read without CF narrowing to never.
                             */
                            const webSeoVisitState: { outcome: WebSeoVisitOutcome | null } = { outcome: null }
                            const requestedActionsForVisit = normalizeDesiredActions(task.requestedActions)
                            const watchdogMode: 'agentic' | 'seo' = (campaign.trafficMode !== 'web_seo' && agenticMapPlannerReady)
                                ? 'agentic'
                                : 'seo'
                            // Align visit lifecycle with FProxy rotate window (pool multi-key or legacy single-key).
                            const isProxyRotationActive = proxyEnabled && (
                                fproxyPoolEnabled
                                || (
                                    Boolean(fproxyService.getApiKey())
                                    && fproxyService.isAutoRotateActive()
                                )
                            )
                            const computedWatchdogMs = computeVisitWatchdogTimeoutMs(
                                requestedActionsForVisit,
                                Number(campaign.delayMinSeconds ?? 5),
                                Number(campaign.delayMaxSeconds ?? 12),
                                watchdogMode,
                                threadIdx,
                                campaignUseFixedActionCount,
                                { fproxyPoolEnabled, proxyEnabled },
                                this.captchaThreadStats,
                            )
                            // STRICT rotate lifecycle: never schedule a visit longer than the provider IP window.
                            const providerRotateMs = Math.max(
                                60_000,
                                Number(fproxyService.getRotateIntervalMs?.() || 120_000) || 120_000,
                            )
                            let visitWatchdogTimeoutMs = isProxyRotationActive
                                ? Math.min(computedWatchdogMs, Math.max(45_000, providerRotateMs - 12_000))
                                : computedWatchdogMs
                            // Soft stop before hard abort so KPI phase exits cleanly inside the IP window.
                            let visitSoftDeadlineAt = visitStart + Math.max(15_000, visitWatchdogTimeoutMs - 12_000)
                            let visitHardDeadlineAt = visitStart + visitWatchdogTimeoutMs
                            const actionsPerformed: VisitActionRecord[] = []
                            let profilePath: string | undefined
                            let contextId: number | null = null
                            let watchdogTriggered = false
                            let contextCleanupStarted = false
                            let visitBudgetStopLogged = false
                            let usedProxyThisVisit = false
                            let fproxyLease: FProxyLease | null = null
                            let proxyLeaseAbortHandler: (() => void) | null = null
                            const visitProxySnapshotTime = Date.now() // Timestamp for per-thread proxy rotation check

                            const shouldStopForVisitBudget = () => {
                                if (Date.now() >= visitSoftDeadlineAt) return true
                                if (fproxyLease) {
                                    // Leave a small buffer before provider endpoint expiry / next rotate.
                                    const leaseSoftAt = Math.min(
                                        fproxyLease.endpointExpiresAt - 8_000,
                                        // If rotateAllowedAt is within the visit, stop early only after IP is near end-of-life.
                                        fproxyLease.endpointExpiresAt - 8_000,
                                    )
                                    if (Date.now() >= leaseSoftAt) return true
                                }
                                return false
                            }
                            const markVisitBudgetStop = (detail: string) => {
                                if (visitBudgetStopLogged) {
                                    return
                                }
                                visitBudgetStopLogged = true
                                this.recordAction(actionsPerformed, {
                                    action: 'visit_budget_stop',
                                    success: true,
                                    source: 'runtime',
                                    detail,
                                    threadId: threadIdx,
                                    retryCategory: 'visit_watchdog',
                                    queueDepth: this.currentQueueDepth,
                                    timestamp: new Date().toISOString(),
                                }, actionContext)
                            }

                            const recycleVisitContext = async (reason: 'watchdog_timeout' | 'visit_end') => {
                                try {
                                    stopPageMonitor?.()
                                    stopPageMonitor = null
                                } catch {
                                    // Ignore page monitor teardown errors.
                                }
                                if (contextCleanupStarted) {
                                    return
                                }

                                contextCleanupStarted = true

                                if (contextId !== null) {
                                // For ephemeral (no profilePath): skip save (in-memory only, clean-slate per visit).
                                // For profilePath: persistent launchPersistentContext already writes live state to disk; we still close here (final stop may snapshot).
                                if (profilePath) {
                                    console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Persistent profile — close context (state lives in ${profilePath})`)
                                } else {
                                    console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Clean-slate mode — session not saved (ephemeral context)`)
                                }

                                try {
                                    await browserService.closeContext(contextId)
                                } catch {
                                    // Ignore close errors during recycle.
                                }
                                this.activeContexts.delete(contextId)
                                if (this.threadContextIds.get(threadIdx) === contextId) {
                                    this.threadContextIds.delete(threadIdx)
                                }
                                }

                                if (fproxyLease && proxyLeaseAbortHandler) {
                                    fproxyLease.signal.removeEventListener('abort', proxyLeaseAbortHandler)
                                }
                                await fproxyLease?.release(reason)
                                fproxyLease = null
                                if (usedProxyThisVisit && !fproxyPoolEnabled && fproxyService.getApiKey()) {
                                    fproxyService.markVisitCompleted()
                                }
                            }

                            // Acquire FProxy BEFORE visit watchdog so cooldown wait is not counted as visit time.
                            let proxyConfig: BrowserConfig['proxy'] = undefined
                            let proxyInfoStr = ''
                            try {
                                if (task.account && usePersistentProfile) {
                                    profilePath = this.ensureAccountProfile(task.account)
                                } else {
                                    // Ephemeral multi-IP path: cookies may still be injected below without locking a profile dir.
                                    profilePath = undefined
                                    if (task.account && mapsMultiIpTraffic) {
                                        console.log(
                                            `[TrafficBoost] Thread ${threadIdx + 1}: maps multi-IP mode -> ephemeral context` +
                                            ` for account ${task.account.email || task.account.id} (concurrent IPs allowed)`,
                                        )
                                    }
                                }

                                // Create browser context with account's profile + proxy
                                // Try FProxy API first, then static proxies
                                 const runtimeProxy = this.applyRuntimeProxySettings()
                                 const useProxyThisVisit = runtimeProxy.proxyEnabled
                                     && (!task.forceDirectConnection || strictFproxyPool)
                                 usedProxyThisVisit = useProxyThisVisit
 
                             if (useProxyThisVisit) {
                                 if (fproxyPoolEnabled) {
                                     const acquireController = new AbortController()
                                     this.proxyAcquireControllers.add(acquireController)
                                     // Wait until this worker's assigned FProxy key is past cooldown and has rotated to a fresh IP.
                                     const snap = await fproxyPoolService.getSnapshot().catch(() => null)
                                     const nowMs = Date.now()
                                     const pinnedSlotSnap = typeof assignedSlotId === 'number'
                                         ? (snap?.slots || []).find(s => s.id === assignedSlotId)
                                         : undefined
                                     const candidateSlots = pinnedSlotSnap
                                         ? [pinnedSlotSnap]
                                         : (snap?.slots || []).filter(s =>
                                             s.enabled && s.hasSecret && s.status !== 'leased' && s.status !== 'disabled'
                                         )
                                     const nextReadyAt = candidateSlots
                                         .map(s => s.cooldownUntil || s.nextRotateAt || 0)
                                         .filter((v): v is number => typeof v === 'number' && v > nowMs)
                                         .sort((a, b) => a - b)[0] || nowMs
                                     const waitSec = Math.max(0, Math.ceil((nextReadyAt - nowMs) / 1000))
                                     this.setThreadProxyTiming(threadIdx, {
                                         status: 'waiting',
                                         proxyRotateAt: nextReadyAt,
                                         proxyIpExpiresAt: null,
                                         visitSoftDeadlineAt: null,
                                         timingLabel: waitSec > 0
                                             ? `Cho xoay IP ${this.formatProxyCountdown(waitSec)}`
                                             : 'Dang lay IP moi',
                                         action: waitSec > 0
                                             ? `Cho key san sang (xoay IP con ${this.formatProxyCountdown(waitSec)})`
                                             : 'Dang lay IP FProxy moi',
                                     })

                                     // Keep UI ticking while waiting for acquire (including server-reported cooldown updates).
                                     const waitTicker = setInterval(() => {
                                         if (this.shouldStop) return
                                         void fproxyPoolService.getSnapshot().then((liveSnap) => {
                                             if (this.shouldStop) return
                                             const cur = this.threadDetails[threadIdx]
                                             if (!cur || cur.status !== 'waiting') return
                                             const liveSlot = typeof assignedSlotId === 'number'
                                                 ? liveSnap.slots.find(s => s.id === assignedSlotId)
                                                 : undefined
                                             const liveRotateAt = liveSlot
                                                 ? (liveSlot.cooldownUntil || liveSlot.nextRotateAt || null)
                                                 : null
                                             const until = (liveRotateAt && liveRotateAt > Date.now())
                                                 ? liveRotateAt
                                                 : cur.proxyRotateAt
                                             const left = until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0
                                             const timingLabel = left > 0
                                                 ? `Cho xoay IP ${this.formatProxyCountdown(left)}`
                                                 : 'Dang lay IP moi'
                                             const action = left > 0
                                                 ? `Cho key san sang (xoay IP con ${this.formatProxyCountdown(left)})`
                                                 : 'Dang lay IP FProxy moi'
                                             if (cur.currentAction !== action || cur.timingLabel !== timingLabel || cur.proxyRotateAt !== until) {
                                                 this.setThreadProxyTiming(threadIdx, {
                                                     status: 'waiting',
                                                     proxyRotateAt: until ?? null,
                                                     timingLabel,
                                                     action,
                                                 })
                                             }
                                         }).catch(() => {})
                                     }, 1000)

                                     try {
                                         // minRemaining must fit one full visit inside time_die, not exceed it.
                                         // Request slightly more than visit budget so acquire rejects near-expired IPs.
                                         const minRemainingForVisit = Math.min(
                                             Math.max(45_000, visitWatchdogTimeoutMs + 10_000),
                                             Math.max(50_000, providerRotateMs - 5_000),
                                         )
                                         fproxyLease = await fproxyPoolService.acquire({
                                             owner: {
                                                 kind: 'traffic_visit',
                                                 id: `campaign-${campaignId}:thread-${threadIdx}`,
                                                 threadId: threadIdx,
                                                 locationId: task.location.id,
                                             },
                                             slotId: assignedSlotId,
                                             // Wait through full provider cooldown if needed (rotate ~2 min + buffer).
                                             timeoutMs: Math.max(180_000, providerRotateMs + 90_000),
                                             minRemainingMs: minRemainingForVisit,
                                             signal: acquireController.signal,
                                         })
                                     } finally {
                                         clearInterval(waitTicker)
                                         this.proxyAcquireControllers.delete(acquireController)
                                     }

                                     // Re-anchor visit deadlines to ROTATE window (~2 min), not IP life (~30 min).
                                     const nowAfterLease = Date.now()
                                     const leaseRemainingMs = Math.max(
                                         20_000,
                                         fproxyLease.endpointExpiresAt - nowAfterLease,
                                     )
                                     // waiting_time cycle only. Ignore mirrored time_die values on rotateAllowedAt.
                                     const rotateWindowMs = (() => {
                                         const fromLease = fproxyLease.rotateAllowedAt > nowAfterLease
                                             ? (fproxyLease.rotateAllowedAt - nowAfterLease)
                                             : 0
                                         if (fromLease > 0 && fromLease <= 5 * 60_000) return fromLease
                                         if (preSyncedAvailableMs && preSyncedAvailableMs > 0 && preSyncedAvailableMs <= 5 * 60_000) {
                                             return preSyncedAvailableMs
                                         }
                                         return 120_000
                                     })()
                                     const leaseHardBudgetMs = Math.max(
                                         30_000,
                                         Math.min(
                                             visitWatchdogTimeoutMs,
                                             rotateWindowMs - 8_000,
                                             Math.max(30_000, leaseRemainingMs - 8_000),
                                         ),
                                     )
                                     visitWatchdogTimeoutMs = leaseHardBudgetMs
                                     visitHardDeadlineAt = nowAfterLease + leaseHardBudgetMs
                                     visitSoftDeadlineAt = nowAfterLease + Math.max(12_000, leaseHardBudgetMs - 10_000)

                                     proxyConfig = { ...fproxyLease.proxySnapshot }
                                     proxyInfoStr = `${fproxyLease.observedIp} (FProxy slot ${fproxyLease.slotId})`
                                     this.networkState = {
                                         ...this.networkState,
                                         mode: 'fproxy',
                                         reason: 'fproxy_pool_lease_assigned',
                                         proxyInfo: proxyInfoStr,
                                         useProxySetting: true,
                                         checkedAt: new Date().toISOString(),
                                     }
                                     console.log(
                                         `[TrafficBoost] Thread ${threadIdx + 1}: ` +
                                         `FProxy slot ${fproxyLease.slotId}, egress ${fproxyLease.observedIp}, ` +
                                         `ipWindowMs=${leaseRemainingMs}, visitBudgetMs=${visitWatchdogTimeoutMs}`,
                                     )
                                     this.setThreadProxyTiming(threadIdx, {
                                         status: 'visiting',
                                         proxyIpExpiresAt: fproxyLease.endpointExpiresAt,
                                         proxyRotateAt: fproxyLease.rotateAllowedAt,
                                         visitSoftDeadlineAt,
                                         timingLabel: `Con ${this.formatProxyCountdown(Math.ceil(visitWatchdogTimeoutMs / 1000))}s budget`,
                                         action: `FProxy IP ready (${Math.round(visitWatchdogTimeoutMs / 1000)}s budget)`,
                                     })
                                     this.threadDetails[threadIdx] = {
                                         ...this.ensureThreadDetail(threadIdx),
                                         proxyInfo: proxyInfoStr,
                                     }
                                 } else {
                                 const fproxyKey = fproxyService.getApiKey()
                                 if (fproxyKey) {
                                    // Use FProxy.me API for dynamic proxy
                                    console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Using FProxy API...`)
                                    try {
                                        const fproxy = await fproxyService.getProxyForBrowser()
                                        if (fproxy) {
                                            proxyConfig = fproxy
                                            const info = fproxyService.getProxyInfo()
                                            proxyInfoStr = `${fproxy.host}:${fproxy.port}${info?.location ? ` (${info.location})` : ''}`
                                            this.networkState = {
                                                ...this.networkState,
                                                mode: 'fproxy',
                                                reason: 'active_fproxy_proxy_assigned',
                                                proxyInfo: proxyInfoStr,
                                                useProxySetting: true,
                                                checkedAt: new Date().toISOString(),
                                            }
                                            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy: ${proxyInfoStr}, user: ${fproxy.username}`)
                                        } else {
                                            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy returned null, direct connection`)
                                        }
                                    } catch (fErr: any) {
                                        console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy error: ${fErr.message}`)
                                    }
                                } else {
                                    // Fallback: use static proxies from DB
                                    const activeProxy = await proxyService.getRandomActive()
                                    if (activeProxy) {
                                        proxyConfig = {
                                            host: activeProxy.host,
                                            port: activeProxy.port,
                                            username: activeProxy.username || undefined,
                                            password: activeProxy.password || undefined,
                                            type: (activeProxy.type as 'http' | 'https' | 'socks5') || 'http',
                                        }
                                        proxyInfoStr = `${activeProxy.host}:${activeProxy.port}${activeProxy.country ? ` (${activeProxy.country})` : ''}`
                                        this.networkState = {
                                            ...this.networkState,
                                            mode: 'static_proxy',
                                            reason: 'active_static_proxy_assigned',
                                            proxyInfo: proxyInfoStr,
                                            useProxySetting: true,
                                            checkedAt: new Date().toISOString(),
                                        }
                                        console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Static proxy: ${proxyInfoStr}`)
                                    } else {
                                        console.log(`[TrafficBoost] Thread ${threadIdx + 1}: No proxy, direct connection`)
                                        this.networkState = {
                                            ...this.networkState,
                                            mode: 'direct',
                                            reason: 'static_proxy_pool_empty',
                                            proxyInfo: undefined,
                                            useProxySetting: true,
                                            checkedAt: new Date().toISOString(),
                                         }
                                     }
                                 }
                                 }
                             } else {
                                if (task.forceDirectConnection) {
                                    console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Proxy temporarily bypassed for retry, using direct connection`)
                                } else {
                                    console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Proxy disabled in settings, using direct connection`)
                                }
                                this.networkState = {
                                    ...this.networkState,
                                    mode: 'direct',
                                    reason: task.forceDirectConnection ? 'proxy_failed_fallback_direct' : 'proxy_disabled_in_settings',
                                    proxyInfo: undefined,
                                    useProxySetting: task.forceDirectConnection ? true : false,
                                    checkedAt: new Date().toISOString(),
                                }
                            }

                            } catch (proxyAcquireError) {
                                try { await fproxyLease?.release('acquire_failed') } catch {}
                                fproxyLease = null
                                throw proxyAcquireError
                            }

                            try {
                                await runWithTimeout(async () => {
                                    // Retrieve and self-heal task.account.profilePath (via ensureAccountProfile which computes, mkdirs, DB-updates if stale).
                                    // Pass healed path into config; branch to createContext (persistent profile) vs createEphemeralContext (anonymous).
                                    // Proxy already acquired outside watchdog; create browser with bound IP window.
                                    if (watchdogTriggered || shouldStopForVisitBudget()) {
                                        throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                    }

                                // Config: pass profilePath (when present) so create* decides persistent vs ephemeral.
                                const config: BrowserConfig = {
                                    shouldAbort: () => this.shouldStop || this.paused || watchdogTriggered || shouldStopForVisitBudget() || Boolean(fproxyLease?.signal.aborted),
                                    headless: globalSettings.headless ?? false,
                                    proxy: proxyConfig,
                                    ...(profilePath ? { profilePath } : {}),
                                }

                                // Update thread detail with proxy info and mark browser opening now that fresh IP is ready
                                this.threadDetails[threadIdx] = {
                                    ...this.threadDetails[threadIdx],
                                    status: 'visiting',
                                    currentAction: 'Opening browser...',
                                    proxyInfo: proxyInfoStr,
                                }
                                this.sendStatus(this.buildStatus({
                                    campaignName: campaign.name,
                                    currentRound,
                                    completedVisits,
                                    totalVisits,
                                    failedVisits,
                                    message: `Thread ${threadIdx + 1}: Visiting ${locationName}`,
                                }))

                                // Call createContext (if profilePath healed for account) else createEphemeralContext. Matches BrowserConfig.profilePath contract.
                                contextId = await pRetry(
                                    async () => {
                                        const attemptConfig = { ...config }
                                        try {
                                            if (profilePath) {
                                                return await browserService.createContext(attemptConfig)
                                            } else {
                                                return await browserService.createEphemeralContext(attemptConfig)
                                            }
                                        } catch (error) {
                                            if (isBrowserContextClosedError(error)) {
                                                this.setThreadAction(threadIdx, 'Browser disconnected - recreating context')
                                            }
                                            throw error
                                        }
                                    },
                                    {
                                        retries: Math.max(0, this.runtimePolicy.networkRetryMax),
                                        factor: 1.8,
                                        minTimeout: 700,
                                        maxTimeout: 5000,
                                        randomize: true,
                                        onFailedAttempt: async (attemptError: any) => {
                                            if (!isBrowserContextClosedError(attemptError)) {
                                                return
                                            }

                                            const attempt = Number(attemptError?.attemptNumber || 1)
                                            const retriesLeft = Number(attemptError?.retriesLeft || 0)
                                            const maxAttempts = attempt + retriesLeft
                                            const errorMessage = attemptError?.message || 'browser context closed'

                                            this.setThreadAction(threadIdx, `Browser disconnected - relaunching (${attempt}/${maxAttempts})`)
                                            this.sendStatus(this.buildStatus({
                                                campaignName: campaign.name,
                                                currentRound,
                                                completedVisits,
                                                totalVisits,
                                                failedVisits,
                                                message: `Thread ${threadIdx + 1}: Browser disconnected, recovering (${attempt}/${maxAttempts})`,
                                            }))
                                            this.recordAction(actionsPerformed, {
                                                action: 'browser_context_recreate',
                                                success: false,
                                                source: 'runtime',
                                                detail: `createContext retry ${attempt}/${maxAttempts}: ${errorMessage}`,
                                                threadId: threadIdx,
                                                attempt,
                                                retryCategory: 'browser_recover',
                                                queueDepth: this.currentQueueDepth,
                                                timestamp: new Date().toISOString(),
                                            }, actionContext)

                                            await browserService.closeBrowser().catch(() => { })
                                            await HumanBehavior.randomDelay(180, 420)
                                        },
                                    }
                                )
                                if (fproxyLease) {
                                    const activeLease = fproxyLease
                                    proxyLeaseAbortHandler = () => {
                                        watchdogTriggered = true
                                        void recycleVisitContext('watchdog_timeout')
                                    }
                                    activeLease.signal.addEventListener(
                                        'abort',
                                        proxyLeaseAbortHandler,
                                        { once: true },
                                    )
                                }
                                this.activeContexts.set(contextId, profilePath || '')
                                this.threadContextIds.set(threadIdx, contextId)

                                // Apply centralized stealth (already done via BrowserService for ephemeral, here for any direct persistent paths)
                                // Traffic visits primarily use createEphemeralContext which now goes through StealthPatcher
                                try {
                                    const ctx = browserService.getContext(contextId)
                                    if (ctx) {
                                        await applyStealth(ctx, { level: DEFAULT_STEALTH_LEVEL }).catch(() => {})
                                    }
                                } catch {}
                                if (watchdogTriggered) {
                                    throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                }

                                try {
                                    const page = browserService.getPage(contextId!)
                                    if (!page) throw new Error('Could not get page')
                                    if (watchdogTriggered) {
                                        throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                    }

                                    // Restore session for selected account: prefer persistent profilePath (reused in ensure -> launchPersistent auto-loads prior login state).
                                    // Fallback: use saved cookies blob (from login ctx.cookies) via addCookies for legacy/compat cases.
                                    // Parse robust + BC (old string may be array or {cookies:[]}), filter valid shape, light normalize for google addCookies compat. Never log values.
                                    if (task.account?.cookies) {
                                        try {
                                            const ctx = browserService.getContext(contextId!)
                                            if (ctx) {
                                                let ckRaw: any = []
                                                try { ckRaw = JSON.parse(task.account.cookies || '[]') } catch {}
                                                let ck: any[] = Array.isArray(ckRaw) ? ckRaw : (ckRaw && Array.isArray(ckRaw.cookies) ? ckRaw.cookies : [])
                                                // Required by Playwright addCookies + filter garbage/expired; normalize sameSite/secure for cross-domain google
                                                ck = ck.filter((c: any) => c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && typeof c.path === 'string')
                                                    .map((c: any) => {
                                                        let domain = c.domain
                                                        if (domain && /google\.com$/i.test(domain) && !domain.startsWith('.')) domain = '.' + domain.replace(/^www\./i, '')
                                                        const sameSite = (c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict') ? c.sameSite : 'Lax'
                                                        const secure = sameSite === 'None' ? true : (c.secure !== false)
                                                        return { ...c, domain, sameSite, secure }
                                                    })
                                                if (ck.length > 0) {
                                                    await ctx.addCookies(ck).catch((e: any) => { console.log(`[TrafficBoost] addCookies warn (non-fatal, ${ck.length} cookies) for account:`, e?.message?.slice(0, 120)) })
                                                    this.recordAction(actionsPerformed, {
                                                        action: 'account_session_restored',
                                                        success: true,
                                                        detail: task.account.email || String(task.account.id),
                                                        threadId: threadIdx,
                                                        timestamp: new Date().toISOString(),
                                                    }, actionContext)
                                                }
                                            }
                                        } catch { /* non-fatal: fall back to anonymous for this visit */ }
                                    }

                                    // VERIFY after profile/cookies load: if account was chosen (active) but still not detected logged-in, WARN clearly + record (audit visible to user).
                                    // Do not block; run visit anon but reason is explicit so user knows to re-login or check profile. Reuses BrowserService.isGoogleLoggedIn (cookie-primary).
                                    if (task.account) {
                                        try {
                                            const logged = await browserService.isGoogleLoggedIn(contextId!).catch(() => false)
                                            if (!logged) {
                                                console.warn(`[TrafficBoost] WARNING: Selected account ${task.account.email} (status active/cookies present) but isGoogleLoggedIn=false after context. Running visit ANONYMOUS. Re-login the account or verify profilePath.`)
                                                this.recordAction(actionsPerformed, {
                                                    action: 'account_session_verify_failed',
                                                    success: false,
                                                    detail: `${task.account.email || task.account.id} (ran anonymous)`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }
                                        } catch { /* never break visit */ }
                                    }

                                    stopPageMonitor = this.startThreadPageMonitor(threadIdx, page)
                                    await this.cleanupExtraTabsForThread(page, threadIdx, 'visit_start')

                                    // Apply window tiling based on active thread count
                                    try {
                                        const slotTargets: Array<{
                                            slot: number
                                            contextId: number
                                            context: { pages: () => any[] }
                                        }> = []
                                        for (const [slot, ctxId] of Array.from(this.threadContextIds.entries()).sort((a, b) => a[0] - b[0])) {
                                            const ctx = browserService.getContext(ctxId)
                                            if (ctx) {
                                                slotTargets.push({
                                                    slot,
                                                    contextId: ctxId,
                                                    context: ctx,
                                                })
                                            }
                                        }
                                        if (slotTargets.length > 0) {
                                            await windowTilingService.applyBySlots(slotTargets, safeThreadCount)
                                        }
                                    } catch (tilingErr) {
                                        console.log(`[TrafficBoost] Tiling error (non-fatal):`, tilingErr)
                                    }

                                    // Navigate to location - branch by traffic mode
                                    if (campaign.trafficMode === 'organic' || campaign.trafficMode === 'web_seo' || campaign.trafficMode === 'map_search') {
                                        // ORGANIC / MAP_SEARCH / WEB_SEO MODE (keyword per-location round-robin)
                                        // web_seo: campaign.searchKeywords first, then location.searchKeywords/name
                                        let searchKeywords: string[]
                                        if (campaign.trafficMode === 'web_seo') {
                                            searchKeywords = resolveWebSeoSearchKeywords(campaign, task.location)
                                        } else {
                                            searchKeywords = [task.location.name]
                                            const locationKeywordRaw =
                                                typeof task.location.searchKeywords === 'string'
                                                    ? task.location.searchKeywords
                                                    : null
                                            const parsedLocationKeywords = parseStrictKeywordList(locationKeywordRaw)
                                            if (parsedLocationKeywords.length > 0) {
                                                searchKeywords = parsedLocationKeywords
                                            }
                                        }
                                        // Round-robin keyword selection: cycle through all keywords evenly
                                        const locationKey = `loc_${task.location.id}`
                                        if (!(locationKey in this._keywordCounters)) this._keywordCounters[locationKey] = 0
                                        const keywordIdx = this._keywordCounters[locationKey] % searchKeywords.length
                                        this._keywordCounters[locationKey]++
                                        const keyword = searchKeywords[keywordIdx]
                                        const avoidGoogleSearchForThread = this.shouldAvoidGoogleSearch(threadIdx)
                                        const webSeoDwell = campaign.trafficMode === 'web_seo'
                                            ? resolveWebSeoDwellSeconds(campaign)
                                            : null

                                        this.setThreadKeyword(threadIdx, keyword)
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                            message: avoidGoogleSearchForThread
                                                ? `Thread ${threadIdx + 1}: CAPTCHA cooldown active, skipping Google search for this visit`
                                                : `Thread ${threadIdx + 1}: ${campaign.trafficMode === 'organic' ? 'Organic' : campaign.trafficMode === 'map_search' ? 'SEO Map' : 'Web SEO'} search "${keyword}"`,
                                        }))
                                        if (avoidGoogleSearchForThread) {
                                            this.recordAction(actionsPerformed, {
                                                action: 'captcha_cooldown_skip_search',
                                                success: true,
                                                source: 'safety',
                                                detail: `Skipped Google search due to repeated CAPTCHA on thread ${threadIdx + 1}`,
                                                threadId: threadIdx,
                                                timestamp: new Date().toISOString(),
                                            }, actionContext)
                                        }

                                        if (avoidGoogleSearchForThread && campaign.trafficMode === 'organic') {
                                            this.setThreadAction(threadIdx, 'Captcha cooldown: direct map navigation')
                                            await page.goto(task.location.url, {
                                                waitUntil: 'commit',
                                                timeout: 20000,
                                            })
                                            await HumanBehavior.randomDelay(1200, 2600)
                                        } else if (avoidGoogleSearchForThread && campaign.trafficMode === 'map_search') {
                                            // map_search cooldown: direct map URL (per spec, avoid Google search UI)
                                            this.setThreadAction(threadIdx, 'Captcha cooldown: direct map navigation (map_search)')
                                            await page.goto(task.location.url, {
                                                waitUntil: 'commit',
                                                timeout: 20000,
                                            })
                                            await HumanBehavior.randomDelay(1200, 2600)
                                        } else if (avoidGoogleSearchForThread && campaign.trafficMode === 'web_seo') {
                                            this.setThreadAction(threadIdx, 'Captcha cooldown: direct website browsing')
                                            const targetUrl = normalizeWebSeoTargetUrl(task.location.url)
                                            const targetHost = targetUrl ? extractTargetHost(targetUrl) : null
                                            if (!targetUrl || !targetHost) {
                                                throw new Error(`web_seo_invalid_target: invalid URL for location ${task.location.id}`)
                                            }
                                            if (campaign.webSeoRequireOrganic) {
                                                throw new Error('web_seo_organic_required: Google search unavailable during CAPTCHA cooldown')
                                            }
                                            const dwell = webSeoDwell || resolveWebSeoDwellSeconds(campaign)

                                            await page.goto(targetUrl, {
                                                waitUntil: 'domcontentloaded',
                                                timeout: 20000
                                            })
                                            await HumanBehavior.randomDelay(2000, 4200)
                                            const cooldownFlow = new WebSeoFlow((status) => {
                                                this.setThreadAction(threadIdx, status.message || status.action)
                                            })
                                            const cooldownConfig: WebSeoExecuteConfig = {
                                                keyword,
                                                targetDomain: targetUrl,
                                                minTimeOnPageSeconds: dwell.minSeconds,
                                                maxTimeOnPageSeconds: dwell.maxSeconds,
                                                captchaStrategy: 'auto_skip',
                                                deadlineAt: visitSoftDeadlineAt,
                                                shouldStop: () => this.shouldStop || shouldStopForVisitBudget(),
                                                requireOrganic: false,
                                            }
                                            let browseOk = false
                                            try {
                                                // Public typed browse path (no private method cast)
                                                browseOk = await cooldownFlow.browseWebsiteLikeRealUser(page, cooldownConfig)
                                            } catch (cooldownErr: unknown) {
                                                console.warn(
                                                    `[TrafficBoost] web_seo captcha cooldown browse failed:`,
                                                    sanitizeErrorDetail(cooldownErr)
                                                )
                                                browseOk = false
                                            }
                                            await this.cleanupExtraTabsForThread(page, threadIdx, 'after_web_seo_captcha_cooldown_browse')
                                            webSeoVisitState.outcome = {
                                                success: browseOk,
                                                reachedTarget: browseOk,
                                                discoverySource: 'captcha_cooldown',
                                                hostVerified: browseOk,
                                                organicHit: false,
                                                qualityScore: browseOk ? 55 : 0,
                                                countable: browseOk,
                                                targetHost,
                                                message: browseOk
                                                    ? 'Captcha cooldown direct browse completed'
                                                    : 'Captcha cooldown direct browse failed',
                                            }
                                            recordWebSeoStructuredOutcome(
                                                actionsPerformed,
                                                webSeoVisitState.outcome,
                                                threadIdx,
                                                actionContext,
                                                { queueDepth: this.currentQueueDepth, logger: this.logger },
                                            )
                                            assertWebSeoOutcomeOrThrow(webSeoVisitState.outcome)
                                        } else if (campaign.trafficMode === 'organic') {
                                            const searchHandler = new AgenticSearchHandler((status) => {
                                                this.setThreadAction(threadIdx, status)
                                                this.sendStatus(this.buildStatus({
                                                    campaignName: campaign.name,
                                                    currentRound,
                                                    completedVisits,
                                                    totalVisits,
                                                    failedVisits,
                                                }))
                                            })

                                            const searchResult = await searchHandler.executeSearch(page, keyword, {
                                                name: task.location.name,
                                                address: task.location.address,
                                                placeId: task.location.placeId,
                                                url: task.location.url,
                                                                                                                                            }, threadIdx)

                                            // Log agentic search actions
                                            for (const a of searchResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `organic_discovery:${a.action}`,
                                                    success: a.success,
                                                    source: a.source || 'llm',
                                                    detail: a.detail || `Agentic Discovery: ${a.action}`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }

                                            if (!searchResult.foundMap) {
                                                // Fallback to direct mode if map not found in search results
                                                this.setThreadAction(threadIdx, 'Fallback: Chuyển sang URL trực tiếp...')
                                                console.log(`[TrafficBoost] Organic search did not find "${task.location.name}" for "${keyword}", falling back to direct URL`)
                                                await page.goto(task.location.url, {
                                                    waitUntil: 'domcontentloaded',
                                                    timeout: 25000
                                                }).catch(() => {})
                                                await HumanBehavior.randomDelay(1500, 3000)
                                                await this.ensureDirectModeMapReady(
                                                    page,
                                                    threadIdx,
                                                    task.location,
                                                    {
                                                        campaignName: campaign.name,
                                                        currentRound,
                                                        completedVisits,
                                                        totalVisits,
                                                        failedVisits,
                                                    },
                                                    actionsPerformed,
                                                    actionContext,
                                                    !!task.account
                                                )
                                            }
                                            // After organic discovery flow, we're on the map page -> continue to SEO actions below
                                        } else if (campaign.trafficMode === 'map_search') {
                                            // MAP_SEARCH MODE: open maps.google.com/maps, type keyword (round-robin), scroll feed max 15 cards, match by name/placeId, click to detail.
                                            // On not found within limit -> fallback to direct URL. Then common path runs autonomous KPI agent (since !== 'web_seo').
                                            const mapSearchFlow = new MapSearchFlow((status: string) => {
                                                this.setThreadAction(threadIdx, status)
                                                this.sendStatus(this.buildStatus({
                                                    campaignName: campaign.name,
                                                    currentRound,
                                                    completedVisits,
                                                    totalVisits,
                                                    failedVisits,
                                                }))
                                            })

                                            const mapSearchResult = await mapSearchFlow.execute(page, keyword, {
                                                name: task.location.name,
                                                address: task.location.address,
                                                placeId: task.location.placeId,
                                                url: task.location.url,
                                            }, !!task.account, (campaign.maxMapScroll ?? undefined))

                                            // Log discovery actions with prefix
                                            for (const a of mapSearchResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `map_search_discovery:${a.action}`,
                                                    success: a.success,
                                                    source: 'map_search',
                                                    detail: `Map search discovery: ${a.action}`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }

                                            if (!mapSearchResult.foundMap) {
                                                this.setThreadAction(threadIdx, 'Fallback: Chuyển sang URL trực tiếp...')
                                                console.log(`[TrafficBoost] MapSearchFlow did not find "${task.location.name}" within limit for "${keyword}", falling back to direct URL`)
                                                await page.goto(task.location.url, {
                                                    waitUntil: 'domcontentloaded',
                                                    timeout: 25000
                                                }).catch(() => {})
                                                await HumanBehavior.randomDelay(1500, 3000)
                                                await this.ensureDirectModeMapReady(
                                                    page,
                                                    threadIdx,
                                                    task.location,
                                                    {
                                                        campaignName: campaign.name,
                                                        currentRound,
                                                        completedVisits,
                                                        totalVisits,
                                                        failedVisits,
                                                    },
                                                    actionsPerformed,
                                                    actionContext,
                                                    !!task.account
                                                )
                                            }
                                            // On success or fallback we are on map page -> fall through to common consent/login/stabilize + autonomous KPI
                                        } else {
                                            // WEB SEO MODE — single flow path; no engine-level double direct fallback/browse
                                            const targetUrl = normalizeWebSeoTargetUrl(task.location.url)
                                            const targetHost = targetUrl ? extractTargetHost(targetUrl) : null
                                            if (!targetUrl || !targetHost) {
                                                throw new Error(`web_seo_invalid_target: invalid URL for location ${task.location.id}`)
                                            }
                                            const dwell = webSeoDwell || resolveWebSeoDwellSeconds(campaign)
                                            const requireOrganic = Boolean(campaign.webSeoRequireOrganic)

                                            const webSeoFlow = new WebSeoFlow((status) => {
                                                this.setThreadAction(threadIdx, status.message || status.action)
                                                this.sendStatus(this.buildStatus({
                                                    campaignName: campaign.name,
                                                    currentRound,
                                                    completedVisits,
                                                    totalVisits,
                                                    failedVisits,
                                                }))
                                            })

                                            const webSeoConfig: WebSeoExecuteConfig = {
                                                keyword,
                                                targetDomain: targetUrl,
                                                minTimeOnPageSeconds: dwell.minSeconds,
                                                maxTimeOnPageSeconds: dwell.maxSeconds,
                                                captchaStrategy: 'auto_skip',
                                                deadlineAt: visitSoftDeadlineAt,
                                                shouldStop: () => this.shouldStop || shouldStopForVisitBudget(),
                                                requireOrganic,
                                            }

                                            let webSeoResult: WebSeoFlowResult
                                            try {
                                                webSeoResult = await webSeoFlow.execute(page, webSeoConfig)
                                            } catch (flowErr: unknown) {
                                                const msg = sanitizeErrorDetail(flowErr)
                                                if (/deadline/i.test(msg)) {
                                                    throw new Error(`web_seo_deadline: ${msg}`)
                                                }
                                                if (/cancel/i.test(msg) || this.shouldStop) {
                                                    throw new Error(`web_seo_cancelled: ${msg}`)
                                                }
                                                if (/host.?mismatch/i.test(msg)) {
                                                    throw new Error(`web_seo_host_mismatch: ${msg}`)
                                                }
                                                if (/invalid.?target/i.test(msg)) {
                                                    throw new Error(`web_seo_invalid_target: ${msg}`)
                                                }
                                                throw new Error(`web_seo_target_not_found: ${msg}`)
                                            }
                                            await this.cleanupExtraTabsForThread(page, threadIdx, 'after_web_seo_flow')

                                            // Log web_seo flow actions
                                            for (const a of webSeoResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `web_seo:${a.action}`,
                                                    success: a.success,
                                                    source: 'web_seo',
                                                    detail: `Web SEO flow: ${a.action}`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }

                                            webSeoVisitState.outcome = mapWebSeoFlowResult(webSeoResult, targetHost)
                                            // requireOrganic: flow-level direct_fallback is not acceptable
                                            if (
                                                requireOrganic
                                                && webSeoVisitState.outcome.discoverySource === 'direct_fallback'
                                            ) {
                                                throw new Error(
                                                    `web_seo_target_not_found: requireOrganic but discovery was direct_fallback for host ${targetHost}`
                                                )
                                            }

                                            recordWebSeoStructuredOutcome(
                                                actionsPerformed,
                                                webSeoVisitState.outcome,
                                                threadIdx,
                                                actionContext,
                                                { queueDepth: this.currentQueueDepth, logger: this.logger },
                                            )

                                            // Direct-fallback success still completes the visit (logged via discoverySource).
                                            // Hard fail only when flow did not succeed / reach target.
                                            assertWebSeoOutcomeOrThrow(webSeoVisitState.outcome)

                                            if (webSeoVisitState.outcome.discoverySource === 'direct_fallback') {
                                                console.log(
                                                    `[TrafficBoost] Web SEO completed via direct_fallback for "${targetHost}" keyword="${keyword}"`
                                                )
                                            }
                                        }

                                    } else {
                                        // DIRECT MODE: Navigate straight to URL (original behavior)
                                        this.setThreadAction(threadIdx, 'Loading map...')
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }))

                                        await page.goto(task.location.url, {
                                            waitUntil: 'commit',
                                            timeout: 20000
                                        })
                                        await HumanBehavior.randomDelay(1000, 3000)
                                        await this.ensureDirectModeMapReady(
                                            page,
                                            threadIdx,
                                            task.location,
                                            {
                                                campaignName: campaign.name,
                                                currentRound,
                                                completedVisits,
                                                totalVisits,
                                                failedVisits,
                                            },
                                            actionsPerformed,
                                            actionContext,
                                            !!task.account
                                        )

                                        // Direct mode: verify target identity (strong ID priority) before any KPI/boost actions.
                                        // Per requirement: only run tăng chỉ số after confirmed; one safe re-goto fallback then proceed (bounded, no loop).
                                        try {
                                            const vLoc = {
                                                name: task.location?.name || '',
                                                placeId: task.location?.placeId,
                                                address: task.location?.address,
                                                url: task.location?.url || '',
                                                cid: (task.location as any)?.cid,
                                                featureHex: (task.location as any)?.featureHex,
                                            }
                                            let verified = await HumanBehavior.verifyOnTargetMap(page, vLoc as any).catch(() => false)
                                            if (!verified) {
                                                this.recordAction(actionsPerformed, {
                                                    action: 'direct_target_verify_fallback',
                                                    success: true,
                                                    source: 'runtime',
                                                    detail: `Re-nav to location.url after verify fail (${page.url()})`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                                await page.goto(task.location.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
                                                await HumanBehavior.randomDelay(1200, 2800)
                                                verified = await HumanBehavior.verifyOnTargetMap(page, vLoc as any).catch(() => false)
                                            }
                                            if (verified) {
                                                this.recordAction(actionsPerformed, {
                                                    action: 'direct_target_verified',
                                                    success: true,
                                                    source: 'map_identity',
                                                    detail: `Target confirmed before boost`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }
                                        } catch { /* defensive: never block direct path */ }
                                    }
                                    await this.cleanupExtraTabsForThread(page, threadIdx, 'after_navigation')
                                    if (campaign.trafficMode !== 'web_seo') {
                                    await this.handleGoogleLoginIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    await this.stabilizeContextIfNeeded(
                                        page,
                                        threadIdx,
                                        'after_navigation',
                                        actionsPerformed,
                                        actionContext,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }
                                    )

                                    // Accept cookies/consent if present (both modes)
                                    try {
                                        const consentBtn = await page.$('button:has-text("Accept all"), button:has-text("Äá»“ng Ã½"), button:has-text("Accept"), form[action*="consent"] button')
                                        if (consentBtn) {
                                            await consentBtn.click()
                                            await HumanBehavior.randomDelay(1000, 2000)
                                        }
                                    } catch { /* ignore */ }
                                    await this.handleGoogleLoginIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    await this.stabilizeContextIfNeeded(
                                        page,
                                        threadIdx,
                                        'after_consent',
                                        actionsPerformed,
                                        actionContext,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }
                                    )

                                    await this.handleCaptchaIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    await this.stabilizeContextIfNeeded(
                                        page,
                                        threadIdx,
                                        'post_captcha',
                                        actionsPerformed,
                                        actionContext,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }
                                    )
                                    await this.handleGoogleLoginIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    }

                                    if (campaign.trafficMode !== 'web_seo') {
                                        await this.handleGoogleLoginIfNeeded(
                                            page,
                                            threadIdx,
                                            {
                                                campaignName: campaign.name,
                                                currentRound,
                                                completedVisits,
                                                totalVisits,
                                                failedVisits,
                                            },
                                            actionsPerformed,
                                            actionContext,
                                            task.location.url
                                        )
                                        // === AUTONOMOUS AI AGENT ===
                                        // Unified autonomous session: AI detects business type,
                                        // selects optimal KPI strategy, and executes full engagement.
                                        let autonomousResult;
                                        if (watchdogMode === 'agentic') {
                                            const agenticResult = await agenticTrafficHandler.performBrowsing(
                                                page,
                                                task.location.name,
                                                campaignUseFixedActionCount ? Number(campaign.actionsPerVisit ?? 5) : 10,
                                                threadIdx,
                                                (msg: string) => {
                                                    this.setThreadAction(threadIdx, msg)
                                                    this.sendStatus(this.buildStatus({
                                                        campaignName: campaign.name,
                                                        currentRound,
                                                        completedVisits,
                                                        totalVisits,
                                                        failedVisits,
                                                        message: `Thread ${threadIdx + 1}: [AI] ${msg}`,
                                                    }))
                                                },
                                                () => this.shouldStop
                                                    || shouldStopForVisitBudget()
                                                    || (!fproxyPoolEnabled && proxyEnabled && !!fproxyService.getApiKey()
                                                        && fproxyService.hasProxyRotatedSince(visitProxySnapshotTime)
                                                        && (Date.now() - visitStart) < (visitWatchdogTimeoutMs * 0.5)),
                                                'all',
                                                [Number(campaign.delayMinSeconds ?? 3), Number(campaign.delayMaxSeconds ?? 15)]
                                            );
                                            
                                            // Map agentic actions to expected SessionAction format
                                            autonomousResult = {
                                                actionsPerformed: agenticResult.actionsPerformed.map(a => ({
                                                    action: a.action,
                                                    success: a.success,
                                                    source: 'agentic' as const,
                                                    detail: a.detail,
                                                    durationMs: a.durationMs,
                                                    timestamp: new Date().toISOString()
                                                })),
                                                kpisExecuted: [],
                                                totalDurationMs: Date.now() - visitStart,
                                                businessType: 'generic' as const,
                                                strategyUsed: 'Agentic LLM'
                                            }
                                        } else {
                                            autonomousResult = await autonomousMapAgent.execute({
                                                page,
                                                locationName: task.location.name,
                                                locationUrl: task.location.url,
                                                threadId: threadIdx,
                                                onStatusUpdate: (msg: string) => {
                                                    this.setThreadAction(threadIdx, msg)
                                                    this.sendStatus(this.buildStatus({
                                                        campaignName: campaign.name,
                                                        currentRound,
                                                        completedVisits,
                                                        totalVisits,
                                                        failedVisits,
                                                        message: `Thread ${threadIdx + 1}: ${msg}`,
                                                    }))
                                                },
                                                shouldStop: () => this.shouldStop
                                                    || shouldStopForVisitBudget()
                                                    || (!fproxyPoolEnabled && proxyEnabled && !!fproxyService.getApiKey()
                                                        && fproxyService.hasProxyRotatedSince(visitProxySnapshotTime)
                                                        && (Date.now() - visitStart) < (visitWatchdogTimeoutMs * 0.5)),
                                            })
                                        }

                                        // Record autonomous session results
                                        if (autonomousResult && autonomousResult.actionsPerformed.length > 0) {
                                            for (const sessionAction of autonomousResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `autonomous:${sessionAction.action}`,
                                                    success: sessionAction.success,
                                                    source: sessionAction.source === 'kpi_skill' ? 'kpi_skill' : 'runtime',
                                                    detail: sessionAction.detail || sessionAction.action,
                                                    durationMs: sessionAction.durationMs,
                                                    threadId: threadIdx,
                                                    timestamp: sessionAction.timestamp,
                                                }, actionContext)
                                            }
                                        }

                                        // Log strategy used for diagnostics
                                        this.recordAction(actionsPerformed, {
                                            action: 'autonomous_session_completed',
                                            success: true,
                                            source: 'runtime',
                                            detail: `Strategy: ${autonomousResult.strategyUsed}, Duration: ${Math.round(autonomousResult.totalDurationMs / 1000)}s, KPIs: ${autonomousResult.kpisExecuted.filter(k => k.executed).length}/${autonomousResult.kpisExecuted.length}`,
                                            threadId: threadIdx,
                                            timestamp: new Date().toISOString(),
                                        }, actionContext)
                                        }
                                    await this.cleanupExtraTabsForThread(page, threadIdx, 'visit_before_log')
                                    if (watchdogTriggered) {
                                        throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                    }

                                    // Log success with visit quality scoring
                                    const duration = Math.round((Date.now() - visitStart) / 1000)
                                    const successfulSeoActions = actionsPerformed.filter(a => a.success && !a.action.startsWith('context_') && !a.action.startsWith('visit_') && !a.action.startsWith('captcha_') && !a.action.startsWith('browser_') && !a.action.startsWith('google_login') && !a.action.startsWith('proxy_') && !a.action.startsWith('action_count')).length

                                    // web_seo: numeric outcome fields only (no string/regex quality heuristic)
                                    // other modes: existing duration/action heuristic + column defaults
                                    let visitQualityScore: number
                                    let visitCountable: boolean
                                    let visitDiscoverySource: WebSeoDiscoverySource | null = null
                                    let visitTargetHost: string | null = null

                                    const webSeoOutcome = webSeoVisitState.outcome
                                    if (campaign.trafficMode === 'web_seo' && webSeoOutcome) {
                                        visitQualityScore = webSeoOutcome.qualityScore
                                        visitCountable = webSeoOutcome.countable
                                        visitDiscoverySource = webSeoOutcome.discoverySource
                                        visitTargetHost = webSeoOutcome.targetHost
                                    } else {
                                        const durationScore = Math.min(50, Math.floor((duration / 120) * 50))
                                        const actionScore = Math.min(50, successfulSeoActions * 12)
                                        visitQualityScore = durationScore + actionScore
                                        visitCountable = visitQualityScore >= 40
                                    }

                                    const qualityDetail = campaign.trafficMode === 'web_seo' && webSeoOutcome
                                        ? `Quality=${visitQualityScore}/100 (web_seo numeric; discovery=${webSeoOutcome.discoverySource}; countable=${visitCountable})`
                                        : `Quality=${visitQualityScore}/100 (duration=${duration}s, actions=${successfulSeoActions})${visitQualityScore < 40 ? ' ⚠️ LOW QUALITY - Google may not count this visit' : ' ✅ Good quality'}`

                                    // Durable complete first — only emit traffic_logs on fresh applied transition
                                    // (blocks double log on already_done / cancelled race).
                                    const completeResult = await trafficVisitQueue.completeVisit(
                                        task.durableVisitId,
                                        {
                                            success: true,
                                            duration,
                                            qualityScore: visitQualityScore,
                                            countable: visitCountable,
                                        },
                                    )
                                    if (isTrafficVisitFreshTransition(completeResult)) {
                                        db.insert(schema.trafficLogs).values({
                                            campaignId,
                                            accountId: task.account?.id || null,
                                            locationId: task.location.id,
                                            actions: JSON.stringify([
                                                ...actionsPerformed,
                                                {
                                                    action: 'visit_quality_assessment',
                                                    success: visitCountable,
                                                    source: campaign.trafficMode === 'web_seo' ? 'web_seo' : 'runtime',
                                                    detail: qualityDetail,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }
                                            ]),
                                            duration,
                                            round: task.round,
                                            status: 'success',
                                            discoverySource: visitDiscoverySource,
                                            qualityScore: visitQualityScore,
                                            countable: visitCountable,
                                            targetHost: visitTargetHost,
                                            createdAt: new Date(),
                                        }).run()
                                    }
                                    const afterDone = trafficVisitQueue.getCampaignCounters(campaignId)
                                    completedVisits = afterDone.done
                                    failedVisits = afterDone.failed
                                    this._completedVisits = completedVisits
                                    this._failedVisits = failedVisits

                                } finally {
                                    await recycleVisitContext(watchdogTriggered ? 'watchdog_timeout' : 'visit_end')
                                }

                                }, Math.max(20_000, Math.min(visitWatchdogTimeoutMs * 1.15, Math.max(0, visitHardDeadlineAt - Date.now()) + 5_000)), async () => {
                                    watchdogTriggered = true
                                    await recycleVisitContext('watchdog_timeout')
                                })

                            } catch (error: unknown) {
                                await recycleVisitContext(
                                    watchdogTriggered ? 'watchdog_timeout' : 'visit_end',
                                )
                                if (error instanceof BrowserResourceWaitError) {
                                    await trafficVisitQueue.deferRunningVisit(task.durableVisitId)
                                    return
                                }
                                const errMsg = sanitizeErrorDetail(error)
                                const errStack = error instanceof Error ? (error.stack || '') : ''
                                console.error(`[TrafficBoost] Visit failed:`, errMsg)
                                if (errStack) {
                                    console.error(`[TrafficBoost] Stack:`, errStack)
                                }

                                // Write error to debug log file
                                try {
                                    const { appendFileSync } = require('fs')
                                    const { join } = require('path')
                                    const { app } = require('electron')
                                    const logPath = join(app.getPath('userData'), 'proxy-debug.log')
                                    appendFileSync(logPath, `[${new Date().toISOString()}] VISIT ERROR: ${errMsg}\n${errStack}\n\n`)
                                } catch { /* ignore */ }

                                const failureClassification = classifyTrafficFailure(error)
                                this.recordAction(actionsPerformed, {
                                    action: 'visit_failure_classified',
                                    success: false,
                                    source: 'runtime',
                                    detail: `${failureClassification.message} (${failureClassification.code})`,
                                    thought: failureClassification.evidence.join(', '),
                                    error: errMsg,
                                    threadId: threadIdx,
                                    retryCategory: failureClassification.bucket,
                                    recoverPath: failureClassification.code,
                                    queueDepth: this.currentQueueDepth,
                                    timestamp: new Date().toISOString(),
                                }, actionContext)

                                const isWatchdogFailure = failureClassification.bucket === 'watchdog_timeout'
                                const isProxyFailure = failureClassification.bucket === 'proxy_error'
                                const canRetryWithoutProxy = isProxyFailure
                                    && usedProxyThisVisit
                                    && !strictFproxyPool
                                    && !task.forceDirectConnection
                                    && (task.proxyRetryCount ?? 0) < 1
                                    && !this.shouldStop
                                // Strict FProxy pool: requeue on another unique slot instead of failing the map permanently.
                                const canRetryWithFproxyPool = isProxyFailure
                                    && usedProxyThisVisit
                                    && strictFproxyPool
                                    && (task.proxyRetryCount ?? 0) < 2
                                    && !this.shouldStop
                                const canRetryBrowserCrash = failureClassification.bucket === 'browser_crash'
                                    && (task.watchdogRetryCount ?? 0) < 1
                                    && !this.shouldStop
                                const canRetryWatchdog = isWatchdogFailure
                                    && (task.watchdogRetryCount ?? 0) < 1
                                    && !this.shouldStop

                                if (canRetryWithoutProxy) {
                                    await trafficVisitQueue.failVisit(task.durableVisitId, errMsg, {
                                        immediateRetry: true,
                                        mergePayload: {
                                            forceDirectConnection: true,
                                            proxyRetryCount: (task.proxyRetryCount ?? 0) + 1,
                                        },
                                    })
                                    this.recordAction(actionsPerformed, {
                                        action: 'proxy_error_retry_direct_requeued',
                                        success: true,
                                        source: 'runtime',
                                        detail: `Proxy connection failed (${errMsg}). Requeued visit with direct connection fallback`,
                                        threadId: threadIdx,
                                        retryCategory: 'network',
                                        queueDepth: this.currentQueueDepth,
                                        timestamp: new Date().toISOString(),
                                    }, actionContext)
                                } else if (canRetryWithFproxyPool) {
                                    await trafficVisitQueue.failVisit(task.durableVisitId, errMsg, {
                                        immediateRetry: true,
                                        mergePayload: {
                                            proxyRetryCount: (task.proxyRetryCount ?? 0) + 1,
                                        },
                                    })
                                    this.recordAction(actionsPerformed, {
                                        action: 'proxy_error_retry_pool_requeued',
                                        success: true,
                                        source: 'runtime',
                                        detail: `Proxy/tunnel failed (${errMsg}). Requeued visit for another FProxy slot`,
                                        threadId: threadIdx,
                                        retryCategory: 'network',
                                        queueDepth: this.currentQueueDepth,
                                        timestamp: new Date().toISOString(),
                                    }, actionContext)
                                } else if (canRetryBrowserCrash) {
                                    await trafficVisitQueue.failVisit(task.durableVisitId, errMsg, {
                                        immediateRetry: true,
                                        mergePayload: {
                                            watchdogRetryCount: (task.watchdogRetryCount ?? 0) + 1,
                                        },
                                    })
                                    this.recordAction(actionsPerformed, {
                                        action: 'browser_crash_retry_requeued',
                                        success: true,
                                        source: 'runtime',
                                        detail: `Browser/context closed unexpectedly (${errMsg}). Requeued visit`,
                                        threadId: threadIdx,
                                        retryCategory: 'browser_context',
                                        queueDepth: this.currentQueueDepth,
                                        timestamp: new Date().toISOString(),
                                    }, actionContext)
                                } else if (canRetryWatchdog) {
                                    const requeueActions = campaignUseFixedActionCount
                                        ? normalizeDesiredActions(task.requestedActions)
                                        : Math.max(1, Math.floor(normalizeDesiredActions(task.requestedActions) * 0.65))
                                    await trafficVisitQueue.failVisit(task.durableVisitId, errMsg, {
                                        immediateRetry: true,
                                        mergePayload: {
                                            requestedActions: requeueActions,
                                            watchdogRetryCount: (task.watchdogRetryCount ?? 0) + 1,
                                        },
                                    })
                                    this.recordAction(actionsPerformed, {
                                        action: 'visit_watchdog_retry_requeued',
                                        success: true,
                                        source: 'runtime',
                                        detail: campaignUseFixedActionCount
                                            ? `Requeued fixed-count visit after watchdog timeout (actions=${requeueActions})`
                                            : `Requeued visit after watchdog timeout with reduced actions=${requeueActions}`,
                                        threadId: threadIdx,
                                        retryCategory: 'visit_watchdog',
                                        queueDepth: this.currentQueueDepth,
                                        timestamp: new Date().toISOString(),
                                    }, actionContext)
                                } else {
                                    const duration = Math.round((Date.now() - visitStart) / 1000)
                                    const failedSeoOutcome = webSeoVisitState.outcome
                                    const failResult = await trafficVisitQueue.failVisit(
                                        task.durableVisitId,
                                        errMsg,
                                    )
                                    // Only emit traffic_logs failed on first permanent fail
                                    // (retry / already_failed / blocked must not double-count).
                                    if (
                                        failResult.status === 'failed'
                                        && isTrafficVisitFreshTransition(failResult)
                                    ) {
                                        db.insert(schema.trafficLogs).values({
                                            campaignId,
                                            accountId: task.account?.id || null,
                                            locationId: task.location.id,
                                            actions: JSON.stringify(actionsPerformed),
                                            duration,
                                            round: task.round,
                                            status: 'failed',
                                            errorMessage: errMsg,
                                            discoverySource: failedSeoOutcome?.discoverySource ?? null,
                                            qualityScore: failedSeoOutcome?.qualityScore ?? 0,
                                            countable: false,
                                            targetHost: failedSeoOutcome?.targetHost ?? null,
                                            createdAt: new Date(),
                                        }).run()
                                    }
                                    const afterFail = trafficVisitQueue.getCampaignCounters(campaignId)
                                    completedVisits = afterFail.done
                                    failedVisits = afterFail.failed
                                    this._completedVisits = completedVisits
                                    this._failedVisits = failedVisits
                                }
                            }
                                } finally {
                                    releaseAccountLock()
                                }

                            // Update campaign progress
                            db.update(schema.trafficCampaigns)
                                .set({ completedVisits, failedVisits, currentRound })
                                .where(eq(schema.trafficCampaigns.id, campaignId))
                                .run()

                            // Thread idle -> waiting
                            this.threadDetails[threadIdx] = {
                                id: threadIdx,
                                accountEmail: '',
                                locationName: '',
                                currentAction: '',
                                currentUrl: '',
                                status: 'waiting',
                                progress: 0,
                            }

                            if (!this.shouldStop) {
                                this.sendStatus(this.buildStatus({
                                    campaignName: campaign.name,
                                    currentRound,
                                    completedVisits,
                                    totalVisits,
                                    failedVisits,
                                    message: `Thread ${threadIdx + 1}: Visit finished, starting next task immediately`,
                                }))
                            }
                            await this.waitWhilePaused()
                                }).catch(async (queueError: unknown) => {
                                    if (queueError instanceof BrowserResourceWaitError) {
                                        await trafficVisitQueue.deferRunningVisit(task.durableVisitId)
                                        return
                                    }
                                    console.error(`[TrafficBoost] Thread ${threadIdx + 1}: queue task crashed`, sanitizeErrorDetail(queueError))
                                    try {
                                        await trafficVisitQueue.failVisit(
                                            task.durableVisitId,
                                            sanitizeErrorDetail(queueError),
                                        )
                                    } catch {
                                        // Lease recovery will reclaim if fail is blocked/unavailable
                                    }
                                })
                            }
                        } catch (threadError) {
                            console.error(`[TrafficBoost] Thread ${threadIdx + 1}: thread loop crashed`, threadError)
                        } finally {
                            // Thread done
                            this.threadDetails[threadIdx] = { id: threadIdx, accountEmail: '', locationName: '', currentAction: '', currentUrl: '', status: 'done', progress: 100 }
                        }
                    })())
                }

                // Wait for all threads to finish this round
                const threadResults = await Promise.allSettled(threadPromises)
                threadResults.forEach((result, idx) => {
                    if (result.status === 'rejected') {
                        console.error(`[TrafficBoost] Thread ${idx + 1} rejected`, result.reason)
                    }
                })
                this.currentQueueDepth = 0

                if (this.shouldStop) break
            }

        // Campaign complete only when durable queue has no pending/retry/running left.
        // cancelled/done/failed all count as terminal; never use done+failed alone (misses cancelled).
        const finalCounters = trafficVisitQueue.getCampaignCounters(campaignId)
        completedVisits = finalCounters.done
        failedVisits = finalCounters.failed
        this._completedVisits = completedVisits
        this._failedVisits = failedVisits
        const queueDrained = finalCounters.remaining === 0
        // Stop always wins; otherwise complete only when no pending/retry/running remain.
        const finalStatus = this.shouldStop
            ? 'stopped'
            : queueDrained
                ? 'completed'
                : 'stopped'
        db.update(schema.trafficCampaigns)
            .set({
                status: finalStatus,
                completedVisits,
                failedVisits,
                currentRound,
                completedAt: finalStatus === 'completed' ? new Date() : null,
            })
            .where(eq(schema.trafficCampaigns.id, campaignId))
            .run()

        this.sendStatus(this.buildStatus({
            campaignName: campaign.name,
            completedVisits,
            totalVisits,
            failedVisits,
            message: finalStatus === 'completed' ? '✅ Traffic boost completed!' : '⏸ Traffic boost stopped',
        }))
        terminalMessage = finalStatus === 'completed'
            ? 'Traffic boost completed'
            : 'Traffic boost stopped'
        } catch (error: unknown) {
            const campaignErrMsg = sanitizeErrorDetail(error)
            console.error('[TrafficBoost] Campaign error:', campaignErrMsg)
            db.update(schema.trafficCampaigns)
                .set({ status: 'stopped' })
                .where(eq(schema.trafficCampaigns.id, campaignId))
                .run()

            this.sendStatus(this.buildStatus({
                message: `❌ Error: ${campaignErrMsg}`,
            }))
            terminalMessage = `Error: ${campaignErrMsg}`
        } finally {
            this.running = false
            this.resetKeywordAndCaptchaStats()
            this.abortPendingProxyAcquires()
            this.campaignAccountLocks.clear()
            try {
                this.sendStatus(this.buildStatus({
                    isRunning: false,
                    message: terminalMessage,
                }))
            } catch (statusError: unknown) {
                console.error('[TrafficBoost] Failed to broadcast terminal status:', sanitizeErrorDetail(statusError))
            }
            this.currentCampaignId = null

            // Stop FProxy auto-rotate
            fproxyService.stopAutoRotate()

            // Clean up contexts (save state before closing)
            for (const entry of Array.from(this.activeContexts.entries())) {
                const [contextId, profilePath] = entry
                try {
                    if (profilePath) {
                        await browserService.saveContextState(contextId, profilePath)
                    }
                    await browserService.closeContext(contextId)
                    // Give V8 time to GC
                    await HumanBehavior.randomDelay(500, 1000)
                } catch { }
            }
            this.activeContexts.clear()
            this.threadContextIds.clear()
            this.threadDetails = []
            this.currentQueueDepth = 0
            this.threadUrlBroadcastAt.clear()

            // Close shared proxy browser
            await browserService.closeBrowser()
        }
    }

    // ============================================================
    // Stop / Pause
    // ============================================================

    async stopCampaign(): Promise<void> {
        this.shouldStop = true
        this.paused = false
        this.running = false
        this.resetKeywordAndCaptchaStats()
        this.abortPendingProxyAcquires()
        if (this.currentCampaignId) {
            const campaignId = this.currentCampaignId
            try {
                await trafficVisitQueue.cancelCampaignVisits(campaignId)
                const counters = trafficVisitQueue.getCampaignCounters(campaignId)
                this._completedVisits = counters.done
                this._failedVisits = counters.failed
            } catch (queueError) {
                console.error('[TrafficBoost] cancelCampaignVisits failed:', queueError)
            }
            const db = getDatabase()
            db.update(schema.trafficCampaigns)
                .set({
                    status: 'stopped',
                    completedVisits: this._completedVisits,
                    failedVisits: this._failedVisits,
                })
                .where(eq(schema.trafficCampaigns.id, campaignId))
                .run()
        }
        await this.closeActiveContexts('stop')
        // Keep thread slots so late async callbacks do not crash on undefined entries.
        this.threadDetails = this.threadDetails.map((thread, idx) => ({
            id: thread?.id ?? idx,
            accountEmail: '',
            locationName: '',
            currentAction: 'stopped',
            currentUrl: '',
            status: 'done' as const,
            progress: 100,
        }))
        this.currentQueueDepth = 0
        fproxyService.stopAutoRotate()
        // Broadcast stopped status to UI
        this.sendStatus(this.buildStatus({
            isRunning: false,
            message: '⏹ Campaign stopped',
        }))
    }

    async pauseCampaign(): Promise<void> {
        // Do NOT set shouldStop (would terminate); use paused flag for freeze at safe points between visits.
        // Close browser contexts to save resources (per spec: keep full progress/counts/indices in memory+DB).
        // Persist counters so resume (or app reopen + resume) continues exactly: visits, round, keyword/account order via logs+DB.
        this.paused = true
        this.abortPendingProxyAcquires()
        // keep running=true so monitor treats as active (paused) control session
        if (this.currentCampaignId) {
            const campaignId = this.currentCampaignId
            try {
                // Release in-flight leases to retry without consuming attempt budget
                await trafficVisitQueue.releaseRunningForPause(campaignId)
                const counters = trafficVisitQueue.getCampaignCounters(campaignId)
                this._completedVisits = counters.done
                this._failedVisits = counters.failed
            } catch (queueError) {
                console.error('[TrafficBoost] releaseRunningForPause failed:', queueError)
            }
            const db = getDatabase()
            db.update(schema.trafficCampaigns)
                .set({
                    status: 'paused',
                    completedVisits: this._completedVisits,
                    failedVisits: this._failedVisits,
                    currentRound: this._currentRound,
                })
                .where(eq(schema.trafficCampaigns.id, campaignId))
                .run()
        }
        await this.closeActiveContexts('pause')
        this.threadDetails = []
        this.currentQueueDepth = 0
        // Proxy rotation: freeze remaining (app-controlled) so pause time not counted toward next rotate
        fproxyService.pauseAutoRotate()
        // Broadcast: isRunning remains true, consumers use isPaused for UI state (Resume button etc)
        this.sendStatus(this.buildStatus({
            message: '⏸ Campaign paused',
        }))
    }

    async resumeCampaign(): Promise<void> {
        // If engine not currently controlling (e.g. app was closed while paused), recover the paused campaign from DB and start (it will load persisted counters/round/logs-skip for exact resume point)
        if (!this.running || !this.currentCampaignId) {
            const db = getDatabase()
            const pausedCamp = db.select().from(schema.trafficCampaigns)
                .where(eq(schema.trafficCampaigns.status, 'paused')).get()
            if (pausedCamp) {
                // startCampaign will load _completed/_currentRound from row, rebuild remaining tasks, run
                await this.startCampaign(pausedCamp.id).catch(e => console.error('[TrafficBoost] resume start error', e))
            }
            return
        }
        this.paused = false
        if (this.currentCampaignId) {
            const campaignId = this.currentCampaignId
            try {
                await trafficVisitQueue.recoverExpiredLeases(campaignId)
                const counters = trafficVisitQueue.getCampaignCounters(campaignId)
                this._completedVisits = counters.done
                this._failedVisits = counters.failed
            } catch (queueError) {
                console.error('[TrafficBoost] resume recoverExpiredLeases failed:', queueError)
            }
            const db = getDatabase()
            db.update(schema.trafficCampaigns)
                .set({
                    status: 'running',
                    completedVisits: this._completedVisits,
                    failedVisits: this._failedVisits,
                })
                .where(eq(schema.trafficCampaigns.id, campaignId))
                .run()
        }
        // Proxy: resume with freeze-remaining restore + refresh-if-expired (provider safeguard)
        fproxyService.resumeAutoRotate()
        this.sendStatus(this.buildStatus({
            message: '▶ Campaign resumed',
        }))
    }

    /** Durable visit queue counters for IPC / recovery UI. */
    getVisitQueueCounters(campaignId: number) {
        return trafficVisitQueue.getCampaignCounters(campaignId)
    }

    async recoverVisitLeases(campaignId?: number) {
        await trafficVisitQueue.ensureLoaded()
        return trafficVisitQueue.recoverExpiredLeases(campaignId)
    }

    // ============================================================
    // Status & Report
    // ============================================================

    isRunning(): boolean { return this.running }

    private resetKeywordAndCaptchaStats(): void {
        this._keywordCounters = {}
        this.captchaThreadStats.forEach((stats, threadIdx) => {
            for (let hit = 0; hit < stats.hits; hit++) {
                trafficPageGuard.markCaptchaResolved(threadIdx)
            }
        })
        this.captchaThreadStats.clear()
    }

    /** Await context shutdown before dropping the maps so Chromium is not orphaned. */
    private async closeActiveContexts(reason: 'stop' | 'pause'): Promise<void> {
        const ids = Array.from(this.activeContexts.keys())
        const results = await Promise.allSettled(
            ids.map((id) => browserService.closeContext(id)),
        )
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error(`[TrafficBoost] Error closing context on ${reason}:`, result.reason)
            }
        }
        this.activeContexts.clear()
        this.threadContextIds.clear()
    }

    private abortPendingProxyAcquires(): void {
        for (const controller of Array.from(this.proxyAcquireControllers)) {
            controller.abort()
        }
        this.proxyAcquireControllers.clear()
    }

    getStatus(): TrafficBoostStatus {
        return this.buildStatus()
    }

    getReport(campaignId: number): TrafficReport {
        return trafficReportService.getReport(campaignId)
    }

    /**
     * Traffic Audit Report — analyzes visit quality to explain the gap
     * between "successful visits" in the app and actual visits counted by Google.
     */
    getAuditReport(campaignId: number) {
        return trafficReportService.getAuditReport(campaignId)
    }


}

export const trafficBoostEngine = new TrafficBoostEngine()

