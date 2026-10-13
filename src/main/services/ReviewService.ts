import { eq, desc, and, gte, inArray, sql } from 'drizzle-orm'
import {
    COMPLIANCE_RECONCILE_NOTE_MAX,
    PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX,
    type PendingReviewIntent,
    type PendingReviewIntentStatus,
    type ReviewIntentReconcileResult,
    type ReviewReconcileOutcome,
} from '../../shared/compliance-contracts'
import { getDatabase, schema } from '../database'
import type { ReviewHistory, NewReviewHistory } from '../database/schema'
import { recordComplianceAudit } from './ComplianceAuditService'

/**
 * review_history.status values for submit idempotency (no schema migration).
 * SQLite column is free text; Drizzle enum remains success|failed for legacy rows.
 */
export type ReviewSubmissionStatus =
    | 'submitting'
    | 'success'
    | 'failed'
    | 'unconfirmed'

/** Gate decision before any Google submit. */
export type SubmissionGateAction =
    | 'proceed'
    | 'idempotent_complete'
    | 'block_manual_reconcile'

export interface SubmissionGateDecision {
    action: SubmissionGateAction
    status?: ReviewSubmissionStatus
    reason?: string
    intentId?: number
}

/**
 * Handler contract coordination (AgenticReviewResult / PostReviewResult).
 * Handler worker adds submitAttempted; treat as optional until present.
 */
export interface SubmitAwareResult {
    success: boolean
    submitAttempted?: boolean
    error?: string
    screenshot?: string
    allowLinearFallback?: boolean
}

/** Intent row shape used by pure gate evaluator. */
export type SubmissionIntentRow = Pick<ReviewHistory, 'id' | 'status'>

/** Cast wider status into Drizzle column type without introducing `any`. */
function asHistoryStatus(status: ReviewSubmissionStatus): ReviewHistory['status'] {
    return status as ReviewHistory['status']
}

/** Only successful posts count toward daily limit / content history. */
export function countsTowardDailyLimit(status: string | null | undefined): boolean {
    return status === 'success'
}

/** In-flight or crash-risk intents must not auto re-post. */
export function isBlockingSubmissionStatus(status: string | null | undefined): boolean {
    return status === 'submitting' || status === 'unconfirmed'
}

/**
 * Final status from a clean handler result.
 * success → success; submitAttempted without success → unconfirmed; else failed.
 */
export function resolveSubmissionFinalStatus(
    success: boolean,
    submitAttempted: boolean | undefined,
): ReviewSubmissionStatus {
    if (success) return 'success'
    if (submitAttempted === true) return 'unconfirmed'
    return 'failed'
}

/**
 * Crash / abort after intent exists without a clean result.
 * Fail-closed: unconfirmed unless we know submit was not attempted.
 */
export function resolveCrashRiskStatus(
    submitAttempted: boolean | undefined,
): 'failed' | 'unconfirmed' {
    if (submitAttempted === false) return 'failed'
    return 'unconfirmed'
}

/**
 * Intent catch → history status.
 * knownPreSubmit (pre-handler setup after intent, before Google handler) → failed (retryable).
 * Once handler zone entered → resolveCrashRiskStatus (fail-closed unconfirmed).
 */
export function resolveIntentCatchStatus(
    knownPreSubmit: boolean,
    submitAttempted: boolean | undefined,
): 'failed' | 'unconfirmed' {
    if (knownPreSubmit) return 'failed'
    return resolveCrashRiskStatus(submitAttempted)
}

/**
 * Job terminal for manual-reconcile / unconfirmed / leftover submitting.
 * Prefer permanent `failed` over `cancelled`: JobQueue BLOCKING_STATUSES includes
 * failed (and done) but not cancelled — cancel allows re-enqueue churn on restart.
 */
export function terminalJobStatusForManualReconcile(): 'failed' {
    return 'failed'
}

/**
 * Force next JobQueue.failJob into permanent failed (no pending retry).
 * failJob does retryCount++ then checks retryCount < maxRetries.
 */
export function retryCountForPermanentFail(
    currentRetryCount: number,
    maxRetries: number,
): number {
    return Math.max(currentRetryCount, maxRetries)
}

/**
 * Pure pre-submit gate over existing pair rows.
 * success → idempotent complete; submitting/unconfirmed → block (manual reconcile).
 */
export function evaluateSubmissionGate(
    rows: readonly SubmissionIntentRow[],
): SubmissionGateDecision {
    const success = rows.find(r => r.status === 'success')
    if (success) {
        return {
            action: 'idempotent_complete',
            status: 'success',
            intentId: success.id,
        }
    }

    const blocking = rows.find(r => isBlockingSubmissionStatus(r.status))
    if (blocking) {
        // status column is free text at runtime; Drizzle enum is still success|failed
        const rawStatus = String(blocking.status)
        const status: ReviewSubmissionStatus =
            rawStatus === 'unconfirmed' ? 'unconfirmed' : 'submitting'
        return {
            action: 'block_manual_reconcile',
            status,
            intentId: blocking.id,
            reason:
                status === 'submitting'
                    ? 'Prior submit intent is still submitting (possible crash after Google accept). Manual reconciliation required — auto re-post blocked.'
                    : 'Prior submit is unconfirmed (submit attempted without verified success). Manual reconciliation required — auto re-post blocked.',
        }
    }

    return { action: 'proceed' }
}

/** True when a durable intent may be manually reconciled. */
export function isReconcileEligibleStatus(
    status: string | null | undefined,
): status is PendingReviewIntentStatus {
    return status === 'submitting' || status === 'unconfirmed'
}

/** Map operator outcome → terminal review_history status. */
export function mapReconcileOutcomeToHistoryStatus(
    outcome: ReviewReconcileOutcome,
): 'success' | 'failed' {
    return outcome === 'confirmed_success' ? 'success' : 'failed'
}

/**
 * Bound/normalize optional operator note (defense-in-depth beyond IPC Zod).
 * Empty/whitespace → null; oversize → truncated to COMPLIANCE_RECONCILE_NOTE_MAX.
 */
export function clampReconcileNote(note?: string | null): string | null {
    if (typeof note !== 'string') return null
    const trimmed = note.trim()
    if (trimmed.length === 0) return null
    if (trimmed.length <= COMPLIANCE_RECONCILE_NOTE_MAX) return trimmed
    return trimmed.slice(0, COMPLIANCE_RECONCILE_NOTE_MAX)
}

/**
 * errorMessage written on reconcile.
 * confirmed_not_posted always stamps a marker (clears block for operators/logs);
 * confirmed_success only stores an optional note.
 */
export function buildManualReconcileErrorMessage(
    outcome: ReviewReconcileOutcome,
    note?: string | null,
): string | null {
    const trimmed = clampReconcileNote(note) ?? ''
    if (outcome === 'confirmed_success') {
        return trimmed.length > 0
            ? `manual_reconcile:confirmed_success: ${trimmed}`
            : null
    }
    return trimmed.length > 0
        ? `manual_reconcile:confirmed_not_posted: ${trimmed}`
        : 'manual_reconcile:confirmed_not_posted'
}

export type ReconcileTransitionDecision =
    | { ok: true; previousStatus: PendingReviewIntentStatus; newStatus: 'success' | 'failed' }
    | { ok: false; reason: string; previousStatus?: string }

/**
 * Pure reconcile gate — only submitting/unconfirmed may transition.
 * Stale terminal rows (success/failed/missing) are rejected idempotently.
 */
export function evaluateReconcileTransition(
    currentStatus: string | null | undefined,
    outcome: ReviewReconcileOutcome,
): ReconcileTransitionDecision {
    if (currentStatus == null) {
        return { ok: false, reason: 'Review intent not found.' }
    }
    if (!isReconcileEligibleStatus(currentStatus)) {
        return {
            ok: false,
            previousStatus: String(currentStatus),
            reason:
                `Intent is no longer reconcilable (status=${currentStatus}). ` +
                'Stale or already resolved — no change applied.',
        }
    }
    return {
        ok: true,
        previousStatus: currentStatus,
        newStatus: mapReconcileOutcomeToHistoryStatus(outcome),
    }
}

/** Bound free-text review body for public DTOs. */
export function previewReviewText(
    text: string | null | undefined,
    max = PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX,
): string {
    const raw = typeof text === 'string' ? text.trim() : ''
    if (raw.length <= max) return raw
    return raw.slice(0, Math.max(0, max - 1)) + '…'
}

function toIsoCreatedAt(value: Date | number | string | null | undefined): string {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        // SQLite may store seconds or ms; treat small values as seconds.
        const ms = value < 1e12 ? value * 1000 : value
        return new Date(ms).toISOString()
    }
    if (typeof value === 'string' && value.length > 0) {
        const d = new Date(value)
        if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
    return new Date(0).toISOString()
}

function asPendingIntentStatus(status: string): PendingReviewIntentStatus | null {
    if (status === 'submitting' || status === 'unconfirmed') return status
    return null
}

/**
 * Append reconcile event via ComplianceAuditService (non-throwing bridge).
 * Shape matches ComplianceAuditReconcileEventShape in compliance-audit-contracts.
 */
function tryRecordComplianceReconcileAudit(entry: {
    action: 'reconcile_review_intent'
    historyId: number
    outcome: ReviewReconcileOutcome
    previousStatus: string
    newStatus: string
    note?: string | null
}): void {
    try {
        recordComplianceAudit(entry)
    } catch {
        // Audit must never roll back a durable history transition.
    }
}

/**
 * Agentic path is opt-in only. Photos force linear (file attach is linear-only).
 * Pure helper — safe for unit tests without Electron.
 */
export function shouldUseAgenticReview(
    settings: { enableAgenticReview?: unknown; includePhotos?: unknown },
    ollamaAvailable: boolean,
): boolean {
    return settings.enableAgenticReview === true
        && settings.includePhotos !== true
        && ollamaAvailable
}

/**
 * Idempotency: same campaign + account + location already posted successfully.
 * When campaignId is missing, match account+location success only.
 */
export function isSuccessfulReviewPair(
    row: Pick<ReviewHistory, 'status' | 'campaignId' | 'accountId' | 'locationId'>,
    campaignId: number | null | undefined,
    accountId: number,
    locationId: number,
): boolean {
    if (row.status !== 'success') return false
    if (row.accountId !== accountId || row.locationId !== locationId) return false
    if (campaignId == null) return true
    return row.campaignId === campaignId
}

export class ReviewService {
    // Get all review history
    async getAll(): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select().from(schema.reviewHistory).orderBy(desc(schema.reviewHistory.createdAt)).all()
    }

    // Get reviews for a campaign
    async getByCampaign(campaignId: number): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewHistory)
            .where(eq(schema.reviewHistory.campaignId, campaignId))
            .orderBy(desc(schema.reviewHistory.createdAt))
            .all()
    }

    // Get reviews for an account
    async getByAccount(accountId: number): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewHistory)
            .where(eq(schema.reviewHistory.accountId, accountId))
            .orderBy(desc(schema.reviewHistory.createdAt))
            .all()
    }

    // Get recent reviews (last N)
    async getRecent(limit: number = 10): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewHistory)
            .orderBy(desc(schema.reviewHistory.createdAt))
            .limit(limit)
            .all()
    }

    // Create review record
    async create(data: NewReviewHistory): Promise<ReviewHistory> {
        const db = getDatabase()
        const result = db.insert(schema.reviewHistory).values({
            ...data,
            createdAt: new Date(),
        }).returning().get()
        return result
    }

    // Get reviews today
    async getToday(): Promise<ReviewHistory[]> {
        const db = getDatabase()
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        return db.select()
            .from(schema.reviewHistory)
            .where(gte(schema.reviewHistory.createdAt, today))
            .all()
    }

    // Get comprehensive statistics
    async getStats(): Promise<{
        totalReviews: number
        successfulReviews: number
        failedReviews: number
        successRate: number
        reviewsToday: number
        reviewsThisWeek: number
        reviewsThisMonth: number
    }> {
        const db = getDatabase()
        const all = db.select().from(schema.reviewHistory).all()

        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
        const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

        const successful = all.filter(r => r.status === 'success')
        const reviewsToday = all.filter(r => r.createdAt && r.createdAt >= today && r.status === 'success')
        const reviewsThisWeek = all.filter(r => r.createdAt && r.createdAt >= weekAgo && r.status === 'success')
        const reviewsThisMonth = all.filter(r => r.createdAt && r.createdAt >= monthAgo && r.status === 'success')

        return {
            totalReviews: all.length,
            successfulReviews: successful.length,
            failedReviews: all.length - successful.length,
            successRate: all.length > 0 ? Math.round((successful.length / all.length) * 100 * 10) / 10 : 0,
            reviewsToday: reviewsToday.length,
            reviewsThisWeek: reviewsThisWeek.length,
            reviewsThisMonth: reviewsThisMonth.length,
        }
    }

    /**
     * Successful reviews today for an account (daily limit).
     * Failed attempts do not consume the daily budget.
     */
    async getAccountReviewsToday(accountId: number): Promise<number> {
        const db = getDatabase()
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const reviews = db.select()
            .from(schema.reviewHistory)
            .where(and(
                eq(schema.reviewHistory.accountId, accountId),
                eq(schema.reviewHistory.status, 'success'),
                gte(schema.reviewHistory.createdAt, today)
            ))
            .all()

        return reviews.length
    }

    /**
     * True when this campaign/account/location already has a successful reviewHistory row.
     * Used for pre-submit idempotency (complete job without re-posting).
     */
    async hasSuccessfulReview(
        campaignId: number | null | undefined,
        accountId: number,
        locationId: number,
    ): Promise<boolean> {
        const db = getDatabase()
        const conditions = [
            eq(schema.reviewHistory.accountId, accountId),
            eq(schema.reviewHistory.locationId, locationId),
            eq(schema.reviewHistory.status, 'success'),
        ]
        // Google allows one review per account/location. Campaign is analytics
        // metadata only and must not permit a cross-campaign duplicate post.
        void campaignId

        const row = db.select({ id: schema.reviewHistory.id })
            .from(schema.reviewHistory)
            .where(and(...conditions))
            .limit(1)
            .get()

        return row != null
    }

    /**
     * Rows that matter for submit gate: success | submitting | unconfirmed.
     * Failed history does not block a new attempt.
     */
    async getSubmissionGateRows(
        campaignId: number | null | undefined,
        accountId: number,
        locationId: number,
    ): Promise<SubmissionIntentRow[]> {
        const db = getDatabase()
        const conditions = [
            eq(schema.reviewHistory.accountId, accountId),
            eq(schema.reviewHistory.locationId, locationId),
            inArray(schema.reviewHistory.status, [
                asHistoryStatus('success'),
                asHistoryStatus('submitting'),
                asHistoryStatus('unconfirmed'),
            ]),
        ]
        // Submission safety is global for the Google account/location pair.
        // Campaign remains stored on the history row for reporting only.
        void campaignId

        return db.select({
            id: schema.reviewHistory.id,
            status: schema.reviewHistory.status,
        })
            .from(schema.reviewHistory)
            .where(and(...conditions))
            .orderBy(desc(schema.reviewHistory.createdAt))
            .all()
    }

    /** Evaluate gate for campaign/account/location pair. */
    async evaluateSubmissionGateForPair(
        campaignId: number | null | undefined,
        accountId: number,
        locationId: number,
    ): Promise<SubmissionGateDecision> {
        const rows = await this.getSubmissionGateRows(campaignId, accountId, locationId)
        return evaluateSubmissionGate(rows)
    }

    /**
     * Create intent row BEFORE any Google submit.
     * Survives crash: leftover submitting blocks re-post (fail-closed).
     */
    async beginSubmissionIntent(input: {
        campaignId?: number | null
        accountId: number
        locationId: number
        rating: number
        reviewText: string
        styleApplied?: boolean
    }): Promise<ReviewHistory> {
        const db = getDatabase()
        return db.insert(schema.reviewHistory).values({
            campaignId: input.campaignId ?? undefined,
            accountId: input.accountId,
            locationId: input.locationId,
            rating: input.rating,
            reviewText: input.reviewText,
            status: asHistoryStatus('submitting'),
            errorMessage: null,
            styleApplied: input.styleApplied ?? false,
            createdAt: new Date(),
        }).returning().get()
    }

    /**
     * Update the same intent row after post attempt.
     * Prefer updating only while still submitting (idempotent finalize).
     */
    async finalizeSubmissionIntent(
        intentId: number,
        status: Exclude<ReviewSubmissionStatus, 'submitting'>,
        fields?: {
            errorMessage?: string | null
            screenshot?: string | null
            reviewText?: string
            rating?: number
        },
    ): Promise<boolean> {
        const db = getDatabase()
        const patch: {
            status: ReviewHistory['status']
            errorMessage?: string | null
            screenshot?: string | null
            reviewText?: string
            rating?: number
        } = {
            status: asHistoryStatus(status),
        }
        if (fields?.errorMessage !== undefined) patch.errorMessage = fields.errorMessage
        if (fields?.screenshot !== undefined) patch.screenshot = fields.screenshot
        if (fields?.reviewText !== undefined) patch.reviewText = fields.reviewText
        if (fields?.rating !== undefined) patch.rating = fields.rating

        const result = db.update(schema.reviewHistory)
            .set(patch)
            .where(and(
                eq(schema.reviewHistory.id, intentId),
                eq(schema.reviewHistory.status, asHistoryStatus('submitting')),
            ))
            .run()

        // better-sqlite3 RunResult has changes
        const changes = typeof result?.changes === 'number' ? result.changes : 0
        return changes > 0
    }

    /**
     * Atomic campaign success counter bump (SQL increment).
     * Call only when completeJob transition applied a fresh done.
     */
    async incrementCampaignSuccessReviews(campaignId: number): Promise<void> {
        const db = getDatabase()
        db.update(schema.campaigns)
            .set({
                successReviews: sql`${schema.campaigns.successReviews} + 1`,
            })
            .where(eq(schema.campaigns.id, campaignId))
            .run()
    }

    /** Atomic campaign failed counter bump. */
    async incrementCampaignFailedReviews(campaignId: number): Promise<void> {
        const db = getDatabase()
        db.update(schema.campaigns)
            .set({
                failedReviews: sql`${schema.campaigns.failedReviews} + 1`,
            })
            .where(eq(schema.campaigns.id, campaignId))
            .run()
    }

    /**
     * List durable review_history rows still in submitting/unconfirmed.
     * Public projection only — no screenshot/password/cookie fields.
     */
    async getPendingReviewIntents(): Promise<PendingReviewIntent[]> {
        const db = getDatabase()
        // Explicit column projection: never pull screenshot or unrelated secrets.
        const rows = db
            .select({
                id: schema.reviewHistory.id,
                status: schema.reviewHistory.status,
                accountId: schema.reviewHistory.accountId,
                locationId: schema.reviewHistory.locationId,
                campaignId: schema.reviewHistory.campaignId,
                rating: schema.reviewHistory.rating,
                reviewText: schema.reviewHistory.reviewText,
                errorMessage: schema.reviewHistory.errorMessage,
                createdAt: schema.reviewHistory.createdAt,
            })
            .from(schema.reviewHistory)
            .where(
                inArray(schema.reviewHistory.status, [
                    asHistoryStatus('submitting'),
                    asHistoryStatus('unconfirmed'),
                ]),
            )
            .orderBy(desc(schema.reviewHistory.createdAt))
            .all()

        if (rows.length === 0) return []

        const accountIds = Array.from(new Set(rows.map((r) => r.accountId)))
        const locationIds = Array.from(new Set(rows.map((r) => r.locationId)))

        const accountRows =
            accountIds.length > 0
                ? db
                      .select({
                          id: schema.accounts.id,
                          email: schema.accounts.email,
                      })
                      .from(schema.accounts)
                      .where(inArray(schema.accounts.id, accountIds))
                      .all()
                : []
        const locationRows =
            locationIds.length > 0
                ? db
                      .select({
                          id: schema.locations.id,
                          name: schema.locations.name,
                          url: schema.locations.url,
                      })
                      .from(schema.locations)
                      .where(inArray(schema.locations.id, locationIds))
                      .all()
                : []

        const emailById = new Map(accountRows.map((a) => [a.id, a.email]))
        const locationById = new Map(
            locationRows.map((l) => [l.id, { name: l.name, url: l.url }]),
        )

        const result: PendingReviewIntent[] = []
        for (const row of rows) {
            const status = asPendingIntentStatus(String(row.status))
            if (!status) continue
            const loc = locationById.get(row.locationId)
            const email = emailById.get(row.accountId)
            result.push({
                historyId: row.id,
                status,
                accountId: row.accountId,
                locationId: row.locationId,
                campaignId: row.campaignId ?? null,
                rating: row.rating,
                reviewTextPreview: previewReviewText(row.reviewText),
                errorMessage: row.errorMessage ?? null,
                createdAt: toIsoCreatedAt(row.createdAt),
                accountEmail: email || undefined,
                locationName: loc?.name || undefined,
                locationUrl: loc?.url || undefined,
            })
        }
        return result
    }

    /**
     * Operator manual reconcile for submitting/unconfirmed intent rows.
     * Atomic: only rows still in reconcilable status transition.
     * confirmed_success → success; confirmed_not_posted → failed (retry allowed).
     * Campaign counters bump only after a successful conditional update
     * (automation skips counters while outcome is unknown).
     */
    async reconcileReviewIntent(
        historyId: number,
        outcome: ReviewReconcileOutcome,
        note?: string | null,
    ): Promise<ReviewIntentReconcileResult> {
        const db = getDatabase()
        const existing = db
            .select({
                id: schema.reviewHistory.id,
                status: schema.reviewHistory.status,
                campaignId: schema.reviewHistory.campaignId,
            })
            .from(schema.reviewHistory)
            .where(eq(schema.reviewHistory.id, historyId))
            .get()

        const decision = evaluateReconcileTransition(
            existing ? String(existing.status) : null,
            outcome,
        )
        if (!decision.ok) {
            return {
                success: false,
                message: decision.reason,
                historyId,
                previousStatus: decision.previousStatus,
            }
        }

        const safeNote = clampReconcileNote(note)
        const errorMessage = buildManualReconcileErrorMessage(outcome, safeNote)
        const result = db
            .update(schema.reviewHistory)
            .set({
                status: asHistoryStatus(decision.newStatus),
                errorMessage,
            })
            .where(
                and(
                    eq(schema.reviewHistory.id, historyId),
                    inArray(schema.reviewHistory.status, [
                        asHistoryStatus('submitting'),
                        asHistoryStatus('unconfirmed'),
                    ]),
                ),
            )
            .run()

        const changes = typeof result?.changes === 'number' ? result.changes : 0
        if (changes <= 0) {
            // Race: another transition won between read and update.
            const again = db
                .select({ status: schema.reviewHistory.status })
                .from(schema.reviewHistory)
                .where(eq(schema.reviewHistory.id, historyId))
                .get()
            const staleStatus = again ? String(again.status) : undefined
            return {
                success: false,
                message:
                    'Intent is no longer reconcilable (concurrent or stale update). No change applied.',
                historyId,
                previousStatus: staleStatus ?? decision.previousStatus,
            }
        }

        const campaignId = existing?.campaignId ?? null
        if (campaignId != null) {
            try {
                if (decision.newStatus === 'success') {
                    await this.incrementCampaignSuccessReviews(campaignId)
                } else {
                    await this.incrementCampaignFailedReviews(campaignId)
                }
            } catch {
                // Counter bump must not undo the durable history transition.
            }
        }

        tryRecordComplianceReconcileAudit({
            action: 'reconcile_review_intent',
            historyId,
            outcome,
            previousStatus: decision.previousStatus,
            newStatus: decision.newStatus,
            note: safeNote,
        })

        const successMessage =
            outcome === 'confirmed_success'
                ? 'Marked as successfully posted (success). Re-post remains blocked.'
                : 'Marked as not posted (failed). Block cleared — retry is permitted.'

        return {
            success: true,
            message: successMessage,
            historyId,
            previousStatus: decision.previousStatus,
            newStatus: decision.newStatus,
        }
    }
}

export const reviewService = new ReviewService()
