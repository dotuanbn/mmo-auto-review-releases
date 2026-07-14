/**
 * Pure CAPTCHA prevention policy helpers.
 * No real browser I/O — compute throttle / adaptive delays / session-warming plans.
 * Sleeps are injectable so unit tests never wait wall-clock time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptchaRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type GoogleThrottleBlockReason = 'ok' | 'max_queries' | 'cooldown'

export interface GoogleSearchThrottleConfig {
    /** Max Google queries allowed per automation session (default 4). */
    maxQueriesPerSession: number
    /** Minimum gap between queries in ms (default 30_000). */
    minIntervalMs: number
    /** Maximum gap used when sampling rest delay (default 60_000). */
    maxIntervalMs: number
}

export interface GoogleSearchThrottleState {
    queriesInSession: number
    lastQueryAtMs: number | null
}

export interface GoogleSearchThrottleDecision {
    allowed: boolean
    reason: GoogleThrottleBlockReason
    /** Remaining cooldown before next query may fire (0 if allowed immediately). */
    waitMs: number
    maxQueries: number
    queriesRemaining: number
    queriesInSession: number
}

export interface AdaptiveDelayInput {
    captchaStrikes: number
    baseMinMs: number
    baseMaxMs: number
    /** Injected RNG in [0, 1). Defaults to Math.random. */
    random?: () => number
}

export interface AdaptiveDelayResult {
    minMs: number
    maxMs: number
    factor: number
    riskLevel: CaptchaRiskLevel
    /** Sampled delay within [minMs, maxMs]. */
    delayMs: number
}

export interface ScrollDepthPlan {
    /** Target scroll depth as fraction of page height (0–1). */
    targetDepth: number
    steps: number
    pauseBetweenScrollsMs: { min: number; max: number }
}

export interface TabSwitchPlan {
    shouldSwitch: boolean
    switchCount: number
    dwellPerTabMs: { min: number; max: number }
}

export interface TimeOfDayInput {
    /** Hour of day in proxy/local timezone (0–23). */
    hour: number
    /** Optional weekday 0=Sun … 6=Sat. */
    dayOfWeek?: number
}

export interface TimeOfDayPolicy {
    isActiveHours: boolean
    /** Multiplier for activity intensity (lower at night). */
    activityMultiplier: number
    /** Extra delay factor for off-hours automation. */
    delayFactor: number
}

export type SessionWarmupActionType = 'scroll' | 'tab_switch' | 'dwell' | 'read'

export interface SessionWarmupAction {
    type: SessionWarmupActionType
    /** Type-specific magnitude (depth fraction, switch count, dwell ms, read steps). */
    value: number
}

export interface SessionWarmupPlanInput {
    /** Proxy/local hour for time-of-day shaping. Defaults to system hour. */
    hour?: number
    dayOfWeek?: number
    captchaStrikes?: number
    /** Hard upper bound for planned warmup dwell sum (ms). */
    maxWarmupMs?: number
    random?: () => number
    nowMs?: number
}

export interface SessionWarmupPlan {
    scroll: ScrollDepthPlan
    tabSwitch: TabSwitchPlan
    timeOfDay: TimeOfDayPolicy
    actions: SessionWarmupAction[]
    maxWarmupMs: number
    /** Planned dwell total after bounding (ms). */
    plannedDwellMs: number
}

export interface BoundedWaitOptions {
    minMs: number
    maxMs: number
    /** Absolute ceiling after adaptive scaling (default 120_000). */
    maxBoundMs?: number
    signal?: AbortSignal
    random?: () => number
    /** Injectable sleep — tests pass a no-op / fake timer. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_GOOGLE_SEARCH_THROTTLE: Readonly<GoogleSearchThrottleConfig> = {
    maxQueriesPerSession: 4,
    minIntervalMs: 30_000,
    maxIntervalMs: 60_000,
}

/** Active hours roughly matching human desktop use (proxy local). */
const ACTIVE_HOUR_START = 7
const ACTIVE_HOUR_END = 23

const DEFAULT_MAX_WARMUP_MS = 45_000
const DEFAULT_MAX_BOUND_MS = 120_000

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, Math.floor(value)))
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
}

function resolveRandom(random?: () => number): () => number {
    return typeof random === 'function' ? random : Math.random
}

/** Inclusive integer sample in [min, max]. */
export function sampleInclusive(min: number, max: number, random?: () => number): number {
    const lo = Math.floor(Math.min(min, max))
    const hi = Math.floor(Math.max(min, max))
    if (hi <= lo) return lo
    const r = resolveRandom(random)()
    const unit = Number.isFinite(r) ? clamp01(r) : 0
    // Guard unit===1 so result never exceeds hi
    return Math.min(hi, lo + Math.floor(unit * (hi - lo + 1)))
}

export function createEmptyThrottleState(): GoogleSearchThrottleState {
    return { queriesInSession: 0, lastQueryAtMs: null }
}

// ---------------------------------------------------------------------------
// Risk / adaptive delay
// ---------------------------------------------------------------------------

/**
 * Map captcha strike count → risk band.
 * 0 → low, 1 → medium, 2–3 → high, 4+ → critical.
 */
export function captchaStrikesToRisk(strikes: number): CaptchaRiskLevel {
    const n = clampInt(strikes, 0, 100)
    if (n <= 0) return 'low'
    if (n === 1) return 'medium'
    if (n <= 3) return 'high'
    return 'critical'
}

/**
 * Multiplier for human-like delays after CAPTCHA pressure.
 * Mirrors TrafficBoostEngine spirit (cap ~2.4) with explicit risk bands.
 */
export function adaptiveDelayFactor(strikes: number): number {
    const n = clampInt(strikes, 0, 20)
    if (n <= 0) return 1
    return Math.min(2.4, 1 + n * 0.35)
}

/**
 * Compute scaled delay range + one sampled delayMs (pure / testable).
 */
export function computeAdaptiveDelay(input: AdaptiveDelayInput): AdaptiveDelayResult {
    const baseMin = Math.max(0, Math.floor(input.baseMinMs || 0))
    const baseMax = Math.max(baseMin, Math.floor(input.baseMaxMs || baseMin))
    const strikes = clampInt(input.captchaStrikes, 0, 20)
    const factor = adaptiveDelayFactor(strikes)
    const minMs = Math.floor(baseMin * factor)
    const maxMs = Math.floor(baseMax * factor)
    const riskLevel = captchaStrikesToRisk(strikes)
    const delayMs = sampleInclusive(minMs, maxMs, input.random)
    return { minMs, maxMs, factor, riskLevel, delayMs }
}

// ---------------------------------------------------------------------------
// Google search request throttling
// ---------------------------------------------------------------------------

function normalizeThrottleConfig(
    partial?: Partial<GoogleSearchThrottleConfig>,
): GoogleSearchThrottleConfig {
    const base = DEFAULT_GOOGLE_SEARCH_THROTTLE
    const maxQueries = clampInt(
        partial?.maxQueriesPerSession ?? base.maxQueriesPerSession,
        1,
        10,
    )
    const minInterval = clampInt(partial?.minIntervalMs ?? base.minIntervalMs, 0, 600_000)
    const maxInterval = clampInt(
        partial?.maxIntervalMs ?? base.maxIntervalMs,
        minInterval,
        600_000,
    )
    return {
        maxQueriesPerSession: maxQueries,
        minIntervalMs: minInterval,
        maxIntervalMs: maxInterval,
    }
}

/**
 * Decide whether another Google search query is allowed right now.
 * Pure: uses injected `nowMs` so tests control the clock.
 */
export function evaluateGoogleSearchThrottle(
    state: GoogleSearchThrottleState,
    nowMs: number,
    config?: Partial<GoogleSearchThrottleConfig>,
): GoogleSearchThrottleDecision {
    const cfg = normalizeThrottleConfig(config)
    const queries = clampInt(state.queriesInSession, 0, 10_000)
    const remaining = Math.max(0, cfg.maxQueriesPerSession - queries)

    if (remaining <= 0) {
        return {
            allowed: false,
            reason: 'max_queries',
            waitMs: 0,
            maxQueries: cfg.maxQueriesPerSession,
            queriesRemaining: 0,
            queriesInSession: queries,
        }
    }

    const last = state.lastQueryAtMs
    if (last != null && Number.isFinite(last)) {
        const elapsed = Math.max(0, nowMs - last)
        if (elapsed < cfg.minIntervalMs) {
            return {
                allowed: false,
                reason: 'cooldown',
                waitMs: cfg.minIntervalMs - elapsed,
                maxQueries: cfg.maxQueriesPerSession,
                queriesRemaining: remaining,
                queriesInSession: queries,
            }
        }
    }

    return {
        allowed: true,
        reason: 'ok',
        waitMs: 0,
        maxQueries: cfg.maxQueriesPerSession,
        queriesRemaining: remaining,
        queriesInSession: queries,
    }
}

/**
 * Record a completed Google query into throttle state (immutable update).
 */
export function recordGoogleSearchQuery(
    state: GoogleSearchThrottleState,
    atMs: number,
): GoogleSearchThrottleState {
    return {
        queriesInSession: clampInt(state.queriesInSession, 0, 10_000) + 1,
        lastQueryAtMs: Number.isFinite(atMs) ? atMs : Date.now(),
    }
}

/**
 * Sample inter-query rest delay within [minInterval, maxInterval], scaled by strikes.
 */
export function sampleInterQueryDelayMs(
    config?: Partial<GoogleSearchThrottleConfig>,
    captchaStrikes = 0,
    random?: () => number,
): number {
    const cfg = normalizeThrottleConfig(config)
    const factor = adaptiveDelayFactor(captchaStrikes)
    const minMs = Math.floor(cfg.minIntervalMs * factor)
    const maxMs = Math.floor(cfg.maxIntervalMs * factor)
    return sampleInclusive(minMs, maxMs, random)
}

// ---------------------------------------------------------------------------
// Time-of-day / scroll / tab-switch (session warming building blocks)
// ---------------------------------------------------------------------------

/**
 * Shape activity to human working hours for the proxy timezone.
 * Night (0–6): low activity, higher delay. Day (7–22): full activity.
 */
export function evaluateTimeOfDay(input: TimeOfDayInput): TimeOfDayPolicy {
    const hour = clampInt(input.hour, 0, 23)
    const isActiveHours = hour >= ACTIVE_HOUR_START && hour < ACTIVE_HOUR_END

    if (!isActiveHours) {
        // Deep night: slow down hard, still allow sparse activity
        return {
            isActiveHours: false,
            activityMultiplier: 0.45,
            delayFactor: 1.6,
        }
    }

    // Late evening taper (21–22)
    if (hour >= 21) {
        return {
            isActiveHours: true,
            activityMultiplier: 0.75,
            delayFactor: 1.2,
        }
    }

    // Peak daytime
    if (hour >= 9 && hour <= 18) {
        return {
            isActiveHours: true,
            activityMultiplier: 1,
            delayFactor: 1,
        }
    }

    // Early morning / evening shoulder
    return {
        isActiveHours: true,
        activityMultiplier: 0.85,
        delayFactor: 1.1,
    }
}

/**
 * Vary scroll depth — real users rarely scroll 100% of every page.
 * Higher captcha pressure → shallower, more cautious scrolling.
 */
export function planScrollDepth(
    captchaStrikes = 0,
    random?: () => number,
): ScrollDepthPlan {
    const r = resolveRandom(random)
    const strikes = clampInt(captchaStrikes, 0, 20)
    // Base depth 35–90%; high risk caps near 55%
    const riskCap = strikes >= 4 ? 0.55 : strikes >= 2 ? 0.7 : 0.9
    const base = 0.35 + r() * 0.55
    const targetDepth = Math.min(riskCap, Math.max(0.25, base))
    const steps = clampInt(2 + Math.floor(targetDepth * 4) + (r() > 0.5 ? 1 : 0), 1, 6)
    const pauseMin = Math.floor(400 * adaptiveDelayFactor(strikes))
    const pauseMax = Math.floor(1400 * adaptiveDelayFactor(strikes))
    return {
        targetDepth: Math.round(targetDepth * 100) / 100,
        steps,
        pauseBetweenScrollsMs: { min: pauseMin, max: Math.max(pauseMin, pauseMax) },
    }
}

/**
 * Tab-switch pattern: occasionally open a side context, then return.
 * Suppressed under critical CAPTCHA pressure (looks less scripted to skip).
 */
export function planTabSwitch(
    captchaStrikes = 0,
    random?: () => number,
): TabSwitchPlan {
    const r = resolveRandom(random)
    const strikes = clampInt(captchaStrikes, 0, 20)
    if (strikes >= 4) {
        return {
            shouldSwitch: false,
            switchCount: 0,
            dwellPerTabMs: { min: 800, max: 2000 },
        }
    }
    // ~40% chance of 1 switch, ~12% of 2
    const roll = r()
    const switchCount = roll > 0.88 ? 2 : roll > 0.48 ? 1 : 0
    return {
        shouldSwitch: switchCount > 0,
        switchCount,
        dwellPerTabMs: { min: 1200, max: 4500 },
    }
}

/**
 * Compose a full session-warming plan (scroll + tabs + time-of-day).
 * Pure — callers apply actions; tests assert structure without sleeping.
 */
export function buildSessionWarmupPlan(input: SessionWarmupPlanInput = {}): SessionWarmupPlan {
    const random = resolveRandom(input.random)
    const hour =
        typeof input.hour === 'number' && Number.isFinite(input.hour)
            ? clampInt(input.hour, 0, 23)
            : new Date(input.nowMs ?? Date.now()).getHours()
    const strikes = clampInt(input.captchaStrikes ?? 0, 0, 20)
    const maxWarmupMs = clampInt(input.maxWarmupMs ?? DEFAULT_MAX_WARMUP_MS, 5_000, 180_000)

    const timeOfDay = evaluateTimeOfDay({ hour, dayOfWeek: input.dayOfWeek })
    const scroll = planScrollDepth(strikes, random)
    const tabSwitch = planTabSwitch(strikes, random)

    const actions: SessionWarmupAction[] = []
    actions.push({ type: 'scroll', value: scroll.targetDepth })
    actions.push({ type: 'read', value: Math.max(1, Math.min(3, scroll.steps - 1)) })

    if (tabSwitch.shouldSwitch) {
        actions.push({ type: 'tab_switch', value: tabSwitch.switchCount })
    }

    // Dwell scaled by time-of-day activity; then hard-bound by maxWarmupMs
    const rawDwell = sampleInclusive(4_000, 14_000, random)
    const scaledDwell = Math.floor(rawDwell * timeOfDay.activityMultiplier * timeOfDay.delayFactor)
    const plannedDwellMs = Math.min(maxWarmupMs, Math.max(1_500, scaledDwell))
    actions.push({ type: 'dwell', value: plannedDwellMs })

    return {
        scroll,
        tabSwitch,
        timeOfDay,
        actions,
        maxWarmupMs,
        plannedDwellMs,
    }
}

// ---------------------------------------------------------------------------
// Bounded / cancellable waits (runtime helpers with injectable sleep)
// ---------------------------------------------------------------------------

/** Default sleep that respects AbortSignal when provided. */
export function defaultCancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    const duration = Math.max(0, Math.floor(ms))
    if (duration <= 0) return Promise.resolve()
    if (signal?.aborted) {
        return Promise.reject(createAbortError())
    }
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup()
            resolve()
        }, duration)
        const onAbort = (): void => {
            cleanup()
            reject(createAbortError())
        }
        const cleanup = (): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function createAbortError(): Error {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    return err
}

/**
 * Sample a delay in [min,max], clamp to maxBoundMs, then sleep (injectable).
 * Returns the actual waited ms (0 if aborted before start after clamp).
 */
export async function boundedWait(options: BoundedWaitOptions): Promise<number> {
    const maxBound = clampInt(options.maxBoundMs ?? DEFAULT_MAX_BOUND_MS, 0, 600_000)
    const minMs = Math.max(0, Math.floor(options.minMs || 0))
    const maxMs = Math.max(minMs, Math.floor(options.maxMs || minMs))
    const sampled = sampleInclusive(minMs, maxMs, options.random)
    const waitMs = Math.min(maxBound, sampled)
    if (waitMs <= 0) return 0
    if (options.signal?.aborted) {
        throw createAbortError()
    }
    const sleep = options.sleep ?? defaultCancellableSleep
    await sleep(waitMs, options.signal)
    return waitMs
}

/**
 * Wait exactly `waitMs` (clamped), cancellable — used for throttle cooldowns.
 */
export async function boundedWaitExact(
    waitMs: number,
    options: Pick<BoundedWaitOptions, 'maxBoundMs' | 'signal' | 'sleep'> = {},
): Promise<number> {
    const maxBound = clampInt(options.maxBoundMs ?? DEFAULT_MAX_BOUND_MS, 0, 600_000)
    const clamped = Math.min(maxBound, Math.max(0, Math.floor(waitMs)))
    if (clamped <= 0) return 0
    if (options.signal?.aborted) {
        throw createAbortError()
    }
    const sleep = options.sleep ?? defaultCancellableSleep
    await sleep(clamped, options.signal)
    return clamped
}
