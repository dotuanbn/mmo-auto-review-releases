/**
 * Shared automation IPC contracts — Zod input schemas + recovery DTOs.
 * Used by main IPC validation, preload typing, renderer store normalize, and pure tests.
 * No Electron / DB deps.
 */
import { z } from 'zod'
import {
    boundedString,
    idSchema,
    nonNegativeIntSchema,
    optionalIdSchema,
    positiveIntSchema,
} from './ipc-schemas'

// ---------------------------------------------------------------------------
// Config (saveConfig input)
// ---------------------------------------------------------------------------

const timeHhMmSchema = z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Time must be HH:MM (24h)' })

export const automationProxyModeSchema = z.enum(['rotate', 'sticky', 'none'])

/** Partial whitelist for automation:saveConfig — unknown keys rejected. */
export const automationConfigSaveSchema = z
    .object({
        threads: z.number().int().min(1).max(32).optional(),
        maxReviewsPerAccountPerDay: z.number().int().min(1).max(100).optional(),
        delayMin: z.number().int().min(0).max(86_400).optional(),
        delayMax: z.number().int().min(0).max(86_400).optional(),
        workingHoursStart: timeHhMmSchema.optional(),
        workingHoursEnd: timeHhMmSchema.optional(),
        headless: z.boolean().optional(),
        autoRetry: z.boolean().optional(),
        proxyMode: automationProxyModeSchema.optional(),
    })
    .strict()
    .refine(
        (cfg) =>
            cfg.delayMin === undefined ||
            cfg.delayMax === undefined ||
            cfg.delayMin <= cfg.delayMax,
        { message: 'delayMin must be <= delayMax' },
    )

export type AutomationConfigSavePayload = z.infer<typeof automationConfigSaveSchema>

export interface AutomationConfigDto {
    threads: number
    maxReviewsPerAccountPerDay: number
    delayMin: number
    delayMax: number
    workingHoursStart: string
    workingHoursEnd: string
    headless: boolean
    autoRetry: boolean
    proxyMode: 'rotate' | 'sticky' | 'none'
    profilesPath: string
}

// ---------------------------------------------------------------------------
// Campaign / queue / test inputs
// ---------------------------------------------------------------------------

/** automation:startCampaign | automation:resumeCampaign | automation:getResumePlan */
export const automationCampaignIdSchema = idSchema

/**
 * automation:getQueueStats | automation:clearCompleted
 * Accepts missing/undefined (global stats) or a positive campaign id.
 */
export const automationOptionalCampaignIdSchema = optionalIdSchema

/** automation:testFullFlow optional search query */
export const automationTestQuerySchema = boundedString(500).optional()

// ---------------------------------------------------------------------------
// Action / queue result DTOs
// ---------------------------------------------------------------------------

export interface AutomationActionResult {
    success: boolean
    error?: string
}

export interface AutomationQueueStatsDto {
    total: number
    pending: number
    running: number
    done: number
    failed: number
}

// ---------------------------------------------------------------------------
// Crash recovery DTOs (mirror ReviewRecoveryService, no main imports)
// ---------------------------------------------------------------------------

export type RecoveryReconciledStatus = 'paused' | 'done' | 'error'

export interface RecoverableCampaignDto {
    campaignId: number
    pendingJobs: number
    doneJobs: number
    failedJobs: number
    cancelledJobs: number
    previousStatus: string
    reconciledStatus: RecoveryReconciledStatus
}

export interface RecoveryReportDto {
    loaded: boolean
    requeuedRunningJobs: boolean
    requeuedRunningCount: number
    zombieCampaigns: RecoverableCampaignDto[]
    pendingCampaignIds: number[]
    totalPendingJobs: number
}

export interface ResumePlanDto {
    canResume: boolean
    pendingJobs: number
    doneJobs: number
    cancelledJobs: number
    failedJobs: number
    reason?: string
}

// ---------------------------------------------------------------------------
// Response schemas (normalize IPC payloads)
// ---------------------------------------------------------------------------

export const recoverableCampaignSchema = z
    .object({
        campaignId: positiveIntSchema,
        pendingJobs: nonNegativeIntSchema,
        doneJobs: nonNegativeIntSchema,
        failedJobs: nonNegativeIntSchema,
        cancelledJobs: nonNegativeIntSchema,
        previousStatus: z.string().max(64),
        reconciledStatus: z.enum(['paused', 'done', 'error']),
    })
    .strict()

export const recoveryReportSchema = z
    .object({
        loaded: z.boolean(),
        requeuedRunningJobs: z.boolean(),
        requeuedRunningCount: nonNegativeIntSchema,
        zombieCampaigns: z.array(recoverableCampaignSchema),
        pendingCampaignIds: z.array(positiveIntSchema),
        totalPendingJobs: nonNegativeIntSchema,
    })
    .strict()

export const resumePlanSchema = z
    .object({
        canResume: z.boolean(),
        pendingJobs: nonNegativeIntSchema,
        doneJobs: nonNegativeIntSchema,
        cancelledJobs: nonNegativeIntSchema,
        failedJobs: nonNegativeIntSchema,
        reason: z.string().max(500).optional(),
    })
    .strict()

export const automationQueueStatsSchema = z
    .object({
        total: nonNegativeIntSchema,
        pending: nonNegativeIntSchema,
        running: nonNegativeIntSchema,
        done: nonNegativeIntSchema,
        failed: nonNegativeIntSchema,
    })
    .strict()

export const automationActionResultSchema = z
    .object({
        success: z.boolean(),
        error: z.string().max(2000).optional(),
    })
    .strict()

// ---------------------------------------------------------------------------
// Normalize helpers (defensive; never throw)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function asNonNegInt(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : fallback
}

function asPositiveInt(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Normalize automation:getRecoveryReport payload.
 * Returns null for null/undefined/invalid shapes (no recovery yet or corrupt).
 */
export function normalizeRecoveryReport(raw: unknown): RecoveryReportDto | null {
    if (raw === null || raw === undefined) return null

    const parsed = recoveryReportSchema.safeParse(raw)
    if (parsed.success) return parsed.data

    // Soft fallback for minor shape drift (extra keys / missing optional-like fields)
    if (!isRecord(raw)) return null
    if (typeof raw.loaded !== 'boolean') return null

    const zombieRaw = Array.isArray(raw.zombieCampaigns) ? raw.zombieCampaigns : []
    const zombieCampaigns: RecoverableCampaignDto[] = []
    for (const item of zombieRaw) {
        if (!isRecord(item)) continue
        const campaignId = asPositiveInt(item.campaignId)
        if (campaignId === null) continue
        const status = item.reconciledStatus
        if (status !== 'paused' && status !== 'done' && status !== 'error') continue
        zombieCampaigns.push({
            campaignId,
            pendingJobs: asNonNegInt(item.pendingJobs),
            doneJobs: asNonNegInt(item.doneJobs),
            failedJobs: asNonNegInt(item.failedJobs),
            cancelledJobs: asNonNegInt(item.cancelledJobs),
            previousStatus: typeof item.previousStatus === 'string' ? item.previousStatus : 'unknown',
            reconciledStatus: status,
        })
    }

    const pendingCampaignIds = Array.isArray(raw.pendingCampaignIds)
        ? raw.pendingCampaignIds
              .map((id) => asPositiveInt(id))
              .filter((id): id is number => id !== null)
        : []

    return {
        loaded: raw.loaded,
        requeuedRunningJobs: Boolean(raw.requeuedRunningJobs),
        requeuedRunningCount: asNonNegInt(raw.requeuedRunningCount),
        zombieCampaigns,
        pendingCampaignIds,
        totalPendingJobs: asNonNegInt(raw.totalPendingJobs),
    }
}

/**
 * Normalize automation:getResumePlan payload.
 */
export function normalizeResumePlan(raw: unknown): ResumePlanDto | null {
    if (raw === null || raw === undefined) return null

    const parsed = resumePlanSchema.safeParse(raw)
    if (parsed.success) return parsed.data

    if (!isRecord(raw) || typeof raw.canResume !== 'boolean') return null

    return {
        canResume: raw.canResume,
        pendingJobs: asNonNegInt(raw.pendingJobs),
        doneJobs: asNonNegInt(raw.doneJobs),
        cancelledJobs: asNonNegInt(raw.cancelledJobs),
        failedJobs: asNonNegInt(raw.failedJobs),
        reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    }
}

/**
 * Candidate campaign IDs that still have pending durable work (resume-eligible).
 * Prefer pendingCampaignIds; fall back to zombie rows with pendingJobs > 0.
 */
export function listResumeCandidateIds(report: RecoveryReportDto | null): number[] {
    if (!report) return []
    if (report.pendingCampaignIds.length > 0) {
        return Array.from(new Set(report.pendingCampaignIds))
    }
    const fromZombies = report.zombieCampaigns
        .filter((z) => z.pendingJobs > 0)
        .map((z) => z.campaignId)
    return Array.from(new Set(fromZombies))
}

/** True when UI should show the crash-recovery banner (pending work only; never auto-start). */
export function hasPendingRecoveryWork(report: RecoveryReportDto | null): boolean {
    if (!report || !report.loaded) return false
    return report.totalPendingJobs > 0 || listResumeCandidateIds(report).length > 0
}
