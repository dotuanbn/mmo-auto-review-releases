/**
 * Review survival verification queue and result persistence.
 * Checkpoint math stays in process: 24h, then 7d (5d gap), then 30d (15d gap).
 * better-sqlite3 is synchronous, so these reads and writes are not async.
 */

import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import type { ReviewVerificationQueueItem } from '../../shared/review-history-contracts'
import { getDatabase, schema } from '../database'
import type { ReviewHistory } from '../database/schema'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const CHECK_24H_MS = 24 * 60 * 60 * 1000
const CHECK_7D_MS = 7 * 86400 * 1000
const GAP_5D_MS = 5 * 86400 * 1000
const CHECK_30D_MS = 30 * 86400 * 1000
const GAP_15D_MS = 15 * 86400 * 1000

export interface ReviewDueCheckInput {
    createdAt: Date
    lastCheckAt: Date | null
    checkCount: number
    verifiedStatus?: string | null
}

export interface RecordVerificationInput {
    historyId: number
    status: 'live' | 'removed' | 'unknown'
    googleReviewId?: string
    checkedAt?: Date
}

function isValidDate(value: unknown): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime())
}

/**
 * Whether a successful review is due for its next survival check.
 * Removed reviews and reviews that already completed 3 checks are never due.
 * Check 0: 24h after create. Check 1: 7d old and 5d since last check.
 * Check 2: 30d old and 15d since last check. A null lastCheckAt satisfies the gap.
 */
export function isReviewDueForCheck(review: ReviewDueCheckInput, now: Date = new Date()): boolean {
    if (review.verifiedStatus === 'removed' || review.checkCount >= 3) {
        return false
    }

    const ageMs = now.getTime() - review.createdAt.getTime()

    if (review.checkCount === 0) {
        return ageMs >= CHECK_24H_MS
    }

    // No prior check does not block the next checkpoint; a real timestamp must clear the gap.
    const gapMs = review.lastCheckAt === null || review.lastCheckAt === undefined
        ? null
        : now.getTime() - review.lastCheckAt.getTime()

    if (review.checkCount === 1) {
        return ageMs >= CHECK_7D_MS && (gapMs === null || gapMs >= GAP_5D_MS)
    }

    if (review.checkCount === 2) {
        return ageMs >= CHECK_30D_MS && (gapMs === null || gapMs >= GAP_15D_MS)
    }

    return false
}

/** Whole days from submit to this check. Never negative. */
export function calculateSurvivalDays(createdAt: Date, checkedAt: Date): number {
    return Math.max(0, Math.floor((checkedAt.getTime() - createdAt.getTime()) / MS_PER_DAY))
}

interface VerificationCandidateRow {
    historyId: number
    accountId: number
    accountEmail: string
    locationId: number
    locationName: string
    locationUrl: string
    rating: number
    reviewText: string
    createdAt: Date
    lastCheckAt: Date | null
    checkCount: number | null
    verifiedStatus: ReviewVerificationQueueItem['verifiedStatus']
    googleReviewId: string | null
    styleApplied: boolean | null
}

function toQueueItem(row: VerificationCandidateRow): ReviewVerificationQueueItem {
    return {
        historyId: row.historyId,
        accountId: row.accountId,
        accountEmail: row.accountEmail,
        locationId: row.locationId,
        locationName: row.locationName,
        locationUrl: row.locationUrl,
        rating: row.rating,
        reviewText: row.reviewText,
        createdAt: row.createdAt,
        lastCheckAt: isValidDate(row.lastCheckAt) ? row.lastCheckAt : null,
        checkCount: row.checkCount ?? 0,
        verifiedStatus: row.verifiedStatus,
        googleReviewId: row.googleReviewId ?? null,
        styleApplied: row.styleApplied === true,
    }
}

export class ReviewVerificationService {
    /**
     * Successful pending/live reviews with fewer than 3 checks, filtered to those
     * whose checkpoint is due. Location and account joins supply the open target
     * without selecting account secrets.
     */
    getVerificationQueue(limit = 50, now = new Date()): ReviewVerificationQueueItem[] {
        const maxItems = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
        if (maxItems === 0) return []

        const db = getDatabase()
        const rh = schema.reviewHistory
        const rows = db
            .select({
                historyId: rh.id,
                accountId: rh.accountId,
                accountEmail: schema.accounts.email,
                locationId: rh.locationId,
                locationName: schema.locations.name,
                locationUrl: schema.locations.url,
                rating: rh.rating,
                reviewText: rh.reviewText,
                createdAt: rh.createdAt,
                lastCheckAt: rh.lastCheckAt,
                checkCount: rh.checkCount,
                verifiedStatus: rh.verifiedStatus,
                googleReviewId: rh.googleReviewId,
                styleApplied: rh.styleApplied,
            })
            .from(rh)
            .innerJoin(schema.locations, eq(rh.locationId, schema.locations.id))
            .innerJoin(schema.accounts, eq(rh.accountId, schema.accounts.id))
            .where(and(
                eq(rh.status, 'success'),
                inArray(rh.verifiedStatus, ['pending', 'live']),
                lt(rh.checkCount, 3),
            ))
            .orderBy(asc(rh.createdAt))
            .all()

        const due: ReviewVerificationQueueItem[] = []
        for (const row of rows) {
            if (due.length >= maxItems) break
            if (!isValidDate(row.createdAt)) continue
            const candidate = toQueueItem(row)
            if (!isReviewDueForCheck(candidate, now)) continue
            due.push(candidate)
        }
        return due
    }

    /**
     * Persist one verification observation.
     * verifiedAt moves only when the review is confirmed live; other outcomes keep the previous stamp.
     * Throws if the history row does not exist or the check timestamp is invalid.
     */
    recordVerificationResult(input: RecordVerificationInput): ReviewHistory {
        if (!Number.isInteger(input.historyId) || input.historyId <= 0) {
            throw new Error('historyId must be a positive integer')
        }
        if (input.status !== 'live' && input.status !== 'removed' && input.status !== 'unknown') {
            throw new Error('Invalid verification status')
        }

        const checkedAt = input.checkedAt ?? new Date()
        if (!isValidDate(checkedAt)) {
            throw new Error('checkedAt must be a valid Date')
        }

        const db = getDatabase()
        const row = db
            .select()
            .from(schema.reviewHistory)
            .where(eq(schema.reviewHistory.id, input.historyId))
            .get()

        if (!row) {
            throw new Error(`Review history ${input.historyId} not found`)
        }
        if (!isValidDate(row.createdAt)) {
            throw new Error(`Review history ${input.historyId} has an invalid createdAt`)
        }

        const survivalDays = calculateSurvivalDays(row.createdAt, checkedAt)
        const updated = db
            .update(schema.reviewHistory)
            .set({
                verifiedStatus: input.status,
                verifiedAt: input.status === 'live' ? checkedAt : row.verifiedAt,
                lastCheckAt: checkedAt,
                checkCount: (row.checkCount || 0) + 1,
                survivalDays,
                googleReviewId: input.googleReviewId ?? row.googleReviewId,
            })
            .where(eq(schema.reviewHistory.id, input.historyId))
            .returning()
            .get()

        if (!updated) {
            throw new Error(`Review history ${input.historyId} could not be updated`)
        }
        return updated
    }
}

export const reviewVerificationService = new ReviewVerificationService()
