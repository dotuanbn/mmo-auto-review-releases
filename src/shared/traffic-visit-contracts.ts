/**
 * Shared contracts for durable per-visit Traffic queue.
 * Mirrors schema.trafficVisitQueue field contract (main owns table definition).
 * No Electron / DB deps — pure types + helpers for IPC/tests.
 */

import { z } from 'zod'
import { idSchema, nonNegativeIntSchema, positiveIntSchema } from './ipc-schemas'

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

/** Claimable work statuses (availableAt must be due). */
export const TRAFFIC_VISIT_CLAIMABLE_STATUSES = ['pending', 'retry'] as const

/** Immutable terminals — no async complete/fail/cancel overwrite. */
export const TRAFFIC_VISIT_TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const

export const trafficVisitStatusSchema = z.enum([
    'pending',
    'retry',
    'running',
    'done',
    'failed',
    'cancelled',
])

export type TrafficVisitStatus = z.infer<typeof trafficVisitStatusSchema>

export function isTrafficVisitTerminal(status: TrafficVisitStatus): boolean {
    return (TRAFFIC_VISIT_TERMINAL_STATUSES as readonly string[]).includes(status)
}

export function isTrafficVisitClaimable(status: TrafficVisitStatus): boolean {
    return (TRAFFIC_VISIT_CLAIMABLE_STATUSES as readonly string[]).includes(status)
}

export function isTrafficVisitActive(status: TrafficVisitStatus): boolean {
    return status === 'pending' || status === 'retry' || status === 'running'
}

// ---------------------------------------------------------------------------
// Payload (JSON in traffic_visit_queue.payload)
// ---------------------------------------------------------------------------

export const trafficVisitPayloadSchema = z
    .object({
        locationId: positiveIntSchema,
        accountId: positiveIntSchema.nullable().optional(),
        round: positiveIntSchema,
        requestedActions: positiveIntSchema.optional(),
        forceDirectConnection: z.boolean().optional(),
        proxyRetryCount: nonNegativeIntSchema.optional(),
        watchdogRetryCount: nonNegativeIntSchema.optional(),
    })
    .strict()

export type TrafficVisitPayload = z.infer<typeof trafficVisitPayloadSchema>

export function parseTrafficVisitPayload(raw: string | null | undefined): TrafficVisitPayload | null {
    if (!raw) return null
    try {
        const parsed: unknown = JSON.parse(raw)
        const result = trafficVisitPayloadSchema.safeParse(parsed)
        return result.success ? result.data : null
    } catch {
        return null
    }
}

export function serializeTrafficVisitPayload(payload: TrafficVisitPayload): string {
    return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Domain row DTO
// ---------------------------------------------------------------------------

export interface TrafficVisitRow {
    id: string
    campaignId: number
    visitIndex: number
    status: TrafficVisitStatus
    payload: string | null
    attemptCount: number
    maxAttempts: number
    workerId: string | null
    claimedAt: string | null
    leaseExpiresAt: string | null
    availableAt: string | null
    lastError: string | null
    result: string | null
    createdAt: string
    updatedAt: string
}

export interface TrafficVisitTransitionResult {
    applied: boolean
    status: TrafficVisitStatus | null
    reason?: string
}

export interface TrafficVisitCampaignCounters {
    total: number
    pending: number
    retry: number
    running: number
    done: number
    failed: number
    cancelled: number
    /** Visits still eligible for claim or in-flight (not terminal). */
    remaining: number
}

export interface TrafficVisitSeedItem {
    visitIndex: number
    payload: TrafficVisitPayload
    maxAttempts?: number
}

export interface TrafficVisitSeedResult {
    seeded: number
    skippedExisting: number
    total: number
}

export interface TrafficVisitRecoverResult {
    requeued: number
    campaignIds: number[]
}

// ---------------------------------------------------------------------------
// IPC schemas
// ---------------------------------------------------------------------------

export const trafficVisitCampaignIdSchema = idSchema

export const trafficVisitCountersSchema = z
    .object({
        total: nonNegativeIntSchema,
        pending: nonNegativeIntSchema,
        retry: nonNegativeIntSchema,
        running: nonNegativeIntSchema,
        done: nonNegativeIntSchema,
        failed: nonNegativeIntSchema,
        cancelled: nonNegativeIntSchema,
        remaining: nonNegativeIntSchema,
    })
    .strict()

export const trafficVisitQueueStatsSchema = z
    .object({
        campaignId: idSchema,
        counters: trafficVisitCountersSchema,
        recoveredOnBoot: nonNegativeIntSchema.optional(),
    })
    .strict()

export type TrafficVisitQueueStatsDto = z.infer<typeof trafficVisitQueueStatsSchema>

export const trafficVisitRecoverResultSchema = z
    .object({
        requeued: nonNegativeIntSchema,
        campaignIds: z.array(idSchema),
    })
    .strict()

export type TrafficVisitRecoverResultDto = z.infer<typeof trafficVisitRecoverResultSchema>

/** True when a transition first moved into a new status (not idempotent replay). */
export function isTrafficVisitFreshTransition(
    result: TrafficVisitTransitionResult,
): boolean {
    return result.applied === true && result.reason == null
}

/** Default lease for a running visit (ms). Covers visit watchdog (~150s) + buffer. */
export const DEFAULT_TRAFFIC_VISIT_LEASE_MS = 5 * 60 * 1000

/** Default max attempts before permanent failed. */
export const DEFAULT_TRAFFIC_VISIT_MAX_ATTEMPTS = 3

/** Base backoff for retry (ms); grows exponentially with attemptCount. */
export const DEFAULT_TRAFFIC_VISIT_BACKOFF_BASE_MS = 5_000

/** Cap backoff so retries stay bounded. */
export const DEFAULT_TRAFFIC_VISIT_BACKOFF_MAX_MS = 5 * 60 * 1000

/**
 * Compute availableAt delay after a failed attempt.
 * attemptCount is the count AFTER increment (1-based for first retry).
 */
export function computeTrafficVisitBackoffMs(
    attemptCount: number,
    baseMs: number = DEFAULT_TRAFFIC_VISIT_BACKOFF_BASE_MS,
    maxMs: number = DEFAULT_TRAFFIC_VISIT_BACKOFF_MAX_MS,
): number {
    const safeAttempt = Math.max(1, Math.floor(attemptCount))
    const raw = baseMs * Math.pow(2, safeAttempt - 1)
    return Math.min(maxMs, Math.max(0, Math.floor(raw)))
}

/** Deterministic primary key for (campaignId, visitIndex). */
export function buildTrafficVisitId(campaignId: number, visitIndex: number): string {
    return `tv:${campaignId}:${visitIndex}`
}
