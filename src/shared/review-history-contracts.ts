/**
 * Review history IPC contracts — campaignId / limit / filters boundary.
 * Schemas are pure (no Electron); handlers validate before touching ReviewService.
 */

import { z } from 'zod'
import { idSchema } from './ipc-schemas'

/** Upper bound for reviews:getRecent / filters.limit. */
export const REVIEW_HISTORY_LIMIT_MAX = 5000

/** Positive campaign id (reviews:getByCampaign). */
export const reviewHistoryCampaignIdSchema = idSchema

/** Bounded positive page/limit size. */
export const reviewHistoryLimitSchema = z
    .number()
    .int()
    .min(1)
    .max(REVIEW_HISTORY_LIMIT_MAX)

/** Optional limit for reviews:getRecent (undefined → service default). */
export const reviewHistoryOptionalLimitSchema = reviewHistoryLimitSchema.optional()

/**
 * Optional ISO-ish date/time string for history range filters.
 * Syntax-only bound; semantic date parsing stays in the handler filter logic.
 */
export const reviewHistoryDateStringSchema = z.string().trim().min(1).max(64)

/** Review status filter values used by reviews:getHistory. */
export const reviewHistoryStatusSchema = z.enum(['success', 'failed'])

/**
 * Whitelisted filters for reviews:getHistory.
 * Strict: unknown keys are rejected at the IPC boundary.
 */
export const reviewHistoryFiltersSchema = z
    .object({
        campaignId: idSchema.optional(),
        accountId: idSchema.optional(),
        locationId: idSchema.optional(),
        status: reviewHistoryStatusSchema.optional(),
        dateFrom: reviewHistoryDateStringSchema.optional(),
        dateTo: reviewHistoryDateStringSchema.optional(),
        limit: reviewHistoryLimitSchema.optional(),
    })
    .strict()

/** Optional filters object (undefined means unfiltered history). */
export const reviewHistoryFiltersInputSchema = reviewHistoryFiltersSchema.optional()

/** Public filter shape for reviews:getHistory. */
export type ReviewHistoryFilters = z.infer<typeof reviewHistoryFiltersSchema>

/** @deprecated Prefer ReviewHistoryFilters — alias for existing call sites. */
export type ReviewFilters = ReviewHistoryFilters

/** Outcome written by reviews:recordVerification. */
export const reviewVerificationRecordSchema = z.object({
    historyId: idSchema,
    status: z.enum(['live', 'removed', 'unknown']),
    googleReviewId: z.string().trim().max(256).optional(),
}).strict()

export type ReviewVerificationRecordInput = z.infer<typeof reviewVerificationRecordSchema>

/** Optional cap for reviews:getVerificationQueue (undefined → service default). */
export const reviewVerificationQueueLimitSchema = z.number().int().min(1).max(200).optional()

export type ReviewVerificationQueueLimit = z.infer<typeof reviewVerificationQueueLimitSchema>

/** Status stored on review_history.verified_status. */
export type ReviewVerifiedStatus = 'pending' | 'live' | 'removed' | 'unknown'

/**
 * One due review for the verifier. Account secrets (password, cookies) are omitted.
 * Dates stay Date objects across Electron structured clone.
 */
export interface ReviewVerificationQueueItem {
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
    checkCount: number
    verifiedStatus: ReviewVerifiedStatus | null
    googleReviewId: string | null
    styleApplied: boolean
}

/** Tracking fields returned after reviews:recordVerification. The row may include more columns. */
export interface ReviewVerificationResult {
    id: number
    verifiedStatus: ReviewVerifiedStatus | null
    verifiedAt: Date | null
    lastCheckAt: Date | null
    checkCount: number | null
    survivalDays: number | null
    googleReviewId: string | null
}
