/**
 * Account Warmup IPC contract (optional until preload wires `electronAPI.warmup`).
 * Public DTOs never include passwords, TOTP secrets, or raw credential material.
 */

/** Activity types exposed in the Start Warmup UI. */
export type WarmupActivityType = 'search' | 'maps' | 'youtube'

/** Runtime state of a warmup job for one account. */
export type WarmupRunState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Review gate tier (backend AutomationController / AccountWarmupService):
 * - blocked: level < 25
 * - throttled: level 25–54 (max 1 pending job/account)
 * - ready: level >= 55
 */
export type WarmupGateTier = 'blocked' | 'throttled' | 'ready'

/** Minimum level for full review velocity (backend gate). */
export const WARMUP_READY_MIN_LEVEL = 55
/** Levels below this are fully blocked from review jobs. */
export const WARMUP_BLOCKED_BELOW = 25
/** Max credited warmup sessions per local calendar day. */
export const WARMUP_DAILY_CAP = 3

export interface WarmupStartOptions {
    activityType?: WarmupActivityType
    durationSeconds?: number
}

/** Safe public status — no secrets, no raw history blobs. */
export interface AccountWarmupStatus {
    accountId: number
    /** Warmup level 0–100. */
    level: number
    /** Internal reputation score (display only). */
    reputation: number
    /** Completed warmup session count. */
    sessions: number
    /** Ready for real review/traffic work (level >= 55 when inferred). */
    readiness: boolean
    /** Current run progress 0–100 (or overall level when idle). */
    progress: number
    lastActivityAt: string | null
    nextActivityAt: string | null
    state: WarmupRunState
    activityType: WarmupActivityType | null
    /** Safe, user-facing error message (never secrets). */
    error: string | null
}

export interface WarmupActionResult {
    success: boolean
    message?: string
    /** Structured failure code from main (optional, BC with older preload). */
    code?: string
}

/** Derive gate tier from warmup level (single source of truth for UI). */
export function deriveWarmupTier(level: number): WarmupGateTier {
    if (level < WARMUP_BLOCKED_BELOW) return 'blocked'
    if (level < WARMUP_READY_MIN_LEVEL) return 'throttled'
    return 'ready'
}

/** Optional preload surface — all methods required when present. */
export interface WarmupApi {
    getStatus: (id: number) => Promise<unknown>
    getAllStatuses: () => Promise<unknown>
    start: (id: number, options?: WarmupStartOptions) => Promise<WarmupActionResult>
    cancel: (id: number) => Promise<WarmupActionResult>
}

const WARMUP_ACTIVITY_TYPES: readonly WarmupActivityType[] = ['search', 'maps', 'youtube'] as const
const WARMUP_RUN_STATES: readonly WarmupRunState[] = [
    'idle',
    'running',
    'completed',
    'failed',
    'cancelled',
] as const

export function isWarmupActivityType(value: unknown): value is WarmupActivityType {
    return typeof value === 'string' && (WARMUP_ACTIVITY_TYPES as readonly string[]).includes(value)
}

export function isWarmupRunState(value: unknown): value is WarmupRunState {
    return typeof value === 'string' && (WARMUP_RUN_STATES as readonly string[]).includes(value)
}

function asFiniteNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNullableString(value: unknown): string | null {
    if (value == null) return null
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    return null
}

function clampPct(value: number): number {
    return Math.min(100, Math.max(0, value))
}

/** Normalize a single status payload from main (tolerant of field aliases). */
export function normalizeWarmupStatus(raw: unknown, fallbackId?: number): AccountWarmupStatus | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const accountId = asFiniteNumber(r.accountId ?? r.id, fallbackId ?? NaN)
    if (!Number.isFinite(accountId)) return null

    const level = clampPct(asFiniteNumber(r.level ?? r.warmupLevel, 0))
    const reputation = asFiniteNumber(r.reputation ?? r.reputationScore, 0)
    const sessions = Math.max(0, Math.floor(asFiniteNumber(r.sessions ?? r.sessionCount ?? r.warmupSessions, 0)))
    // Prefer explicit flags; fallback aligns with backend ready gate (>= 55), not legacy 35.
    const readiness = Boolean(r.readiness ?? r.ready ?? r.isReady ?? level >= WARMUP_READY_MIN_LEVEL)
    const progress = clampPct(asFiniteNumber(r.progress, level))

    const stateRaw = r.state ?? r.status ?? r.runState
    const state: WarmupRunState = r.running === true
        ? 'running'
        : isWarmupRunState(stateRaw)
        ? stateRaw
        : (stateRaw === 'in_progress' || stateRaw === 'active' ? 'running' : 'idle')

    const activityRaw = r.activityType ?? r.activity
    const activityType = isWarmupActivityType(activityRaw) ? activityRaw : null

    const errorRaw = r.error ?? r.message
    const error =
        typeof errorRaw === 'string' && errorRaw.trim()
            ? errorRaw.trim().slice(0, 200)
            : null

    return {
        accountId,
        level,
        reputation,
        sessions,
        readiness,
        progress: state === 'running' ? progress : level,
        lastActivityAt: asNullableString(r.lastActivityAt ?? r.lastActivity ?? r.lastAt ?? r.lastWarmupAt),
        nextActivityAt: asNullableString(r.nextActivityAt ?? r.nextActivity ?? r.nextAt ?? r.nextWarmupAt),
        state,
        activityType,
        error: state === 'failed' || error ? error : null,
    }
}

/** Map array or record response → Record<accountId, status>. */
export function normalizeWarmupStatusMap(raw: unknown): Record<number, AccountWarmupStatus> {
    const out: Record<number, AccountWarmupStatus> = {}

    if (Array.isArray(raw)) {
        for (const item of raw) {
            const status = normalizeWarmupStatus(item)
            if (status) out[status.accountId] = status
        }
        return out
    }

    if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            const idHint = Number(key)
            const status = normalizeWarmupStatus(value, Number.isFinite(idHint) ? idHint : undefined)
            if (status) out[status.accountId] = status
        }
    }

    return out
}

/** Optional typed accessor — returns null when preload has not wired warmup. */
export function getWarmupApi(): WarmupApi | null {
    if (typeof window === 'undefined' || !window.electronAPI) return null

    const candidate: WarmupApi = window.electronAPI.warmup
    if (!candidate) return null

    if (
        typeof candidate.getStatus !== 'function'
        || typeof candidate.getAllStatuses !== 'function'
        || typeof candidate.start !== 'function'
        || typeof candidate.cancel !== 'function'
    ) {
        return null
    }

    return candidate
}

export const WARMUP_ACTIVITY_OPTIONS: ReadonlyArray<{
    type: WarmupActivityType
    labelKey: string
    fallback: string
}> = [
    { type: 'search', labelKey: 'accounts.warmup.activitySearch', fallback: 'Search' },
    { type: 'maps', labelKey: 'accounts.warmup.activityMaps', fallback: 'Maps' },
    { type: 'youtube', labelKey: 'accounts.warmup.activityYoutube', fallback: 'YouTube' },
]
