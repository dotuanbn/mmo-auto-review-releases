import type { AccountWarmupStatus, WarmupActivityType, WarmupGateTier, WarmupRunState } from './types'
import { WARMUP_READY_MIN_LEVEL, deriveWarmupTier } from './types'
import type { PublicAccount } from '../../../../shared/account-contracts'

type Translate = (key: string, fallback?: string) => string
type BadgeTone = 'slate' | 'blue' | 'violet' | 'emerald' | 'amber' | 'rose'

/** Format a date-like value for compact UI (vi-VN style). Never throws. */
export function formatWarmupDate(value: string | Date | null | undefined, neverLabel: string): string {
    if (value == null || value === '') return neverLabel
    try {
        const d = value instanceof Date ? value : new Date(value)
        if (Number.isNaN(d.getTime())) return neverLabel
        return (
            d.toLocaleDateString('vi-VN')
            + ' '
            + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
        )
    } catch {
        return neverLabel
    }
}

/** True when nextWarmupAt is a valid future timestamp (cooldown still active). */
export function isWarmupCooldownActive(
    nextActivityAt: string | Date | null | undefined,
    now: Date = new Date(),
): boolean {
    if (nextActivityAt == null || nextActivityAt === '') return false
    try {
        const d = nextActivityAt instanceof Date ? nextActivityAt : new Date(nextActivityAt)
        if (Number.isNaN(d.getTime())) return false
        return d.getTime() > now.getTime()
    } catch {
        return false
    }
}

/**
 * Derive a safe display status from PublicAccount when warmup IPC is unavailable.
 * Does not surface passwords, TOTP, or raw history details.
 * Readiness aligns with backend gate: ready only at level >= 55.
 */
export function deriveWarmupFromAccount(account: PublicAccount): AccountWarmupStatus {
    const level = Math.min(100, Math.max(0, account.warmupLevel ?? 0))
    const reputation = account.reputationScore ?? 0
    const sessions = account.warmupSessions ?? 0

    return {
        accountId: account.id,
        level,
        reputation,
        sessions,
        readiness: level >= WARMUP_READY_MIN_LEVEL,
        progress: level,
        lastActivityAt: account.lastWarmupAt != null ? String(account.lastWarmupAt) : null,
        nextActivityAt: account.nextWarmupAt != null ? String(account.nextWarmupAt) : null,
        state: 'idle',
        activityType: null,
        error: null,
    }
}

/** @deprecated Prefer tierTone(deriveWarmupTier(level)). Kept for callers using readiness boolean. */
export function readinessTone(ready: boolean): 'emerald' | 'amber' {
    return ready ? 'emerald' : 'amber'
}

export function tierTone(tier: WarmupGateTier): 'rose' | 'amber' | 'emerald' {
    switch (tier) {
        case 'blocked':
            return 'rose'
        case 'throttled':
            return 'amber'
        case 'ready':
            return 'emerald'
    }
}

/** Level badge color aligned to gate bands (<25 / 25–54 / >=55). */
export function levelTone(level: number): BadgeTone {
    if (level >= WARMUP_READY_MIN_LEVEL) return 'emerald'
    if (level >= 25) return 'violet'
    if (level >= 10) return 'blue'
    return 'slate'
}

export function tierLabel(tier: WarmupGateTier, t: Translate): string {
    switch (tier) {
        case 'blocked':
            return t('accounts.warmup.tierBlocked', 'Blocked')
        case 'throttled':
            return t('accounts.warmup.tierThrottled', 'Warming')
        case 'ready':
            return t('accounts.warmup.tierReady', 'Ready')
    }
}

export function tierDescription(tier: WarmupGateTier, t: Translate): string {
    switch (tier) {
        case 'blocked':
            return t(
                'accounts.warmup.tierBlockedDesc',
                'Level < 25 — reviews blocked until more warmup',
            )
        case 'throttled':
            return t(
                'accounts.warmup.tierThrottledDesc',
                'Level 25–54 — throttled (max 1 pending job/account)',
            )
        case 'ready':
            return t(
                'accounts.warmup.tierReadyDesc',
                'Level ≥ 55 — ready for full review velocity',
            )
    }
}

export function runStateLabel(state: WarmupRunState, t: Translate): string {
    switch (state) {
        case 'running':
            return t('accounts.warmup.stateRunning', 'Running')
        case 'completed':
            return t('accounts.warmup.stateCompleted', 'Completed')
        case 'failed':
            return t('accounts.warmup.stateFailed', 'Failed')
        case 'cancelled':
            return t('accounts.warmup.stateCancelled', 'Cancelled')
        default:
            return t('accounts.warmup.stateIdle', 'Idle')
    }
}

export function activityLabel(type: WarmupActivityType | null, t: Translate): string {
    if (!type) return t('accounts.warmup.activityNone', '—')
    switch (type) {
        case 'search':
            return t('accounts.warmup.activitySearch', 'Search')
        case 'maps':
            return t('accounts.warmup.activityMaps', 'Maps')
        case 'youtube':
            return t('accounts.warmup.activityYoutube', 'YouTube')
        case 'gmail':
            return t('accounts.warmup.activityGmail', 'Gmail')
        case 'photos_browse':
            return t('accounts.warmup.activityPhotos', 'Photos')
        default:
            return t('accounts.warmup.activityNone', '—')
    }
}

/** Canonical UI error codes (not_logged_in aliases to not_authenticated). */
export type WarmupUiErrorCode =
    | 'cooldown_active'
    | 'daily_cap_reached'
    | 'already_running'
    | 'not_authenticated'

const RAW_WARMUP_ERROR_CODES = [
    'cooldown_active',
    'daily_cap_reached',
    'already_running',
    'not_authenticated',
    'not_logged_in',
] as const

function normalizeErrorCode(code: string): WarmupUiErrorCode | null {
    if (code === 'not_logged_in' || code === 'not_authenticated') return 'not_authenticated'
    if (
        code === 'cooldown_active'
        || code === 'daily_cap_reached'
        || code === 'already_running'
    ) {
        return code
    }
    return null
}

/** Extract a known warmup error code from a raw code or backend message. */
export function extractWarmupErrorCode(raw: string | null | undefined): WarmupUiErrorCode | null {
    if (raw == null) return null
    const trimmed = raw.trim()
    if (!trimmed) return null

    const direct = normalizeErrorCode(trimmed)
    if (direct) return direct

    const lower = trimmed.toLowerCase()
    for (const code of RAW_WARMUP_ERROR_CODES) {
        if (lower.includes(code)) {
            return normalizeErrorCode(code)
        }
    }

    if (lower.includes('cooldown') && (lower.includes('nextwarmupat') || lower.includes('until'))) {
        return 'cooldown_active'
    }
    if (lower.includes('daily') && lower.includes('cap')) {
        return 'daily_cap_reached'
    }
    if (lower.includes('already') && lower.includes('running')) {
        return 'already_running'
    }
    if (
        lower.includes('not authenticated')
        || lower.includes('not logged in')
    ) {
        return 'not_authenticated'
    }

    return null
}

/**
 * Map backend error code/message → localized, user-friendly text.
 * Falls back to the original message when no known code matches.
 */
export function mapWarmupErrorMessage(raw: string | null | undefined, t: Translate): string | null {
    if (raw == null) return null
    const trimmed = raw.trim()
    if (!trimmed) return null

    const code = extractWarmupErrorCode(trimmed)
    if (!code) return trimmed.slice(0, 200)

    switch (code) {
        case 'cooldown_active':
            return t(
                'accounts.warmup.errors.cooldownActive',
                'Warmup cooldown is active. Wait until Next before starting again.',
            )
        case 'daily_cap_reached':
            return t(
                'accounts.warmup.errors.dailyCapReached',
                'Daily warmup cap reached (max 3 sessions/day). Try again tomorrow.',
            )
        case 'already_running':
            return t(
                'accounts.warmup.errors.alreadyRunning',
                'A warmup session is already running for this account.',
            )
        case 'not_authenticated':
            return t(
                'accounts.warmup.errors.notAuthenticated',
                'Account is not logged in. Complete login before warmup.',
            )
    }
}

/** Re-export tier helper for UI consumers. */
export { deriveWarmupTier }
