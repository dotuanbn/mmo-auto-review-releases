/**
 * ReviewPhotoStrategy — decide when a review should include photos, and how many.
 *
 * Real reviewers attach photos sometimes, not always. The probability is a pure
 * function of rating, length, business category, account warmup, and whether
 * this is the account's first review at the location. The roll is injectable
 * so tests stay deterministic.
 *
 * Photo files still come from ReviewPhotoService.resolvePhotos. This module
 * does not read the library itself.
 */

import {
    reviewPhotoService,
    type ReviewPhotoResolveInput,
    type ReviewPhotoResolveResult,
} from './ReviewPhotoService'

export interface PhotoDecisionInput {
    accountId: number
    locationId: number
    /** Star rating, normally 1–5. */
    rating: number
    reviewText: string
    /** Location business category. Null when unknown. */
    category: string | null
    accountTotalReviews: number
    accountWarmupLevel: number
    /** True when this account has not reviewed this location before. */
    isFirstReviewForLocation: boolean
}

export interface PhotoDecision {
    shouldAttach: boolean
    /** 1–3 when attaching; 0 when the roll skips photos. */
    maxPhotos: number
    /** Human-readable explanation safe for logs (no filesystem paths). */
    reason: string
    /** Calculated probability in [0.05, 0.70], before the random roll. */
    probability: number
}

export interface PhotoResolveForReviewResult {
    decision: PhotoDecision
    photos: ReviewPhotoResolveResult
}

const BASE_PROBABILITY = 0.3
/** Never impossible, never the default — occasional photos still happen. */
const MIN_PROBABILITY = 0.05
/** Cap so a fully engaged review still skips photos sometimes. */
const MAX_PROBABILITY = 0.7

interface CategoryRule {
    /** Stable label used in decision reasons. */
    rule: string
    delta: number
    /** Lowercased NFC keywords. Matched by inclusion, case-insensitive. */
    keywords: readonly string[]
}

/**
 * First matching group wins so overlapping labels (cafe + quán) are not stacked.
 * Keywords cover English and Vietnamese category names.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
    {
        rule: 'restaurant',
        delta: 0.15,
        keywords: ['restaurant', 'cafe', 'quán', 'nhà hàng'],
    },
    {
        rule: 'hotel',
        delta: 0.15,
        keywords: ['hotel', 'khách sạn', 'resort'],
    },
    {
        rule: 'spa',
        delta: 0.1,
        keywords: ['spa', 'salon', 'beauty'],
    },
    {
        rule: 'gym',
        delta: 0.05,
        keywords: ['gym', 'fitness'],
    },
    {
        rule: 'office',
        delta: -0.1,
        keywords: ['office', 'văn phòng', 'clinic', 'phòng khám'],
    },
]

interface CategoryMatch {
    delta: number
    rule: string
}

interface PhotoScore {
    probability: number
    ratingDelta: number
    lengthDelta: number
    category: CategoryMatch
    warmupDelta: number
    firstReviewDelta: number
    reviewLength: number
}

function clampProbability(value: number): number {
    if (!Number.isFinite(value) || value < MIN_PROBABILITY) return MIN_PROBABILITY
    if (value > MAX_PROBABILITY) return MAX_PROBABILITY
    return value
}

function normalizeCategory(category: string | null): string {
    if (typeof category !== 'string') return ''
    return category.normalize('NFC').trim().toLocaleLowerCase('vi')
}

function matchCategory(category: string | null): CategoryMatch {
    const normalized = normalizeCategory(category)
    if (normalized.length === 0) return { delta: 0, rule: 'none' }
    for (const group of CATEGORY_RULES) {
        for (const keyword of group.keywords) {
            if (normalized.includes(keyword)) {
                return { delta: group.delta, rule: group.rule }
            }
        }
    }
    return { delta: 0, rule: 'other' }
}

function ratingDelta(rating: number): number {
    switch (rating) {
        case 5:
            return 0.1
        case 4:
            return 0.05
        case 3:
            return 0
        case 2:
            return -0.05
        case 1:
            return -0.1
        default:
            return 0
    }
}

/** Exclusive tiers: a long review does not also collect the medium bonus. */
function lengthDelta(reviewText: string): number {
    const length = typeof reviewText === 'string' ? reviewText.length : 0
    if (length > 200) return 0.1
    if (length > 100) return 0.05
    if (length < 30) return -0.15
    return 0
}

function warmupDelta(warmupLevel: number): number {
    if (!Number.isFinite(warmupLevel)) return 0
    if (warmupLevel < 20) return -0.2
    if (warmupLevel >= 50) return 0.05
    return 0
}

function scorePhotoAttach(input: PhotoDecisionInput): PhotoScore {
    // accountId, locationId, and accountTotalReviews identify the review.
    // They do not change attach probability; accountId is only a library key.
    const text = typeof input.reviewText === 'string' ? input.reviewText : ''
    const ratingMod = ratingDelta(input.rating)
    const lengthMod = lengthDelta(text)
    const category = matchCategory(input.category)
    const warmupMod = warmupDelta(input.accountWarmupLevel)
    const firstReviewMod = input.isFirstReviewForLocation === true ? 0.05 : 0
    const raw =
        BASE_PROBABILITY + ratingMod + lengthMod + category.delta + warmupMod + firstReviewMod
    return {
        probability: clampProbability(raw),
        ratingDelta: ratingMod,
        lengthDelta: lengthMod,
        category,
        warmupDelta: warmupMod,
        firstReviewDelta: firstReviewMod,
        reviewLength: text.length,
    }
}

/**
 * Probability in [0.05, 0.70] that this review should include at least one photo.
 * Does not roll; callers compare the result with their own random value.
 */
export function calculatePhotoAttachProbability(input: PhotoDecisionInput): number {
    return scorePhotoAttach(input).probability
}

/**
 * How many photos to request once the decision is to attach.
 * The 3-photo case is checked first so a 5-star high probability is not
 * swallowed by the broader "2 photos" rule.
 */
export function decidePhotoCount(probability: number, rating: number): number {
    if (!Number.isFinite(probability) || !Number.isFinite(rating)) return 1
    if (probability > 0.6 && rating === 5) return 3
    if (probability > 0.5 && rating >= 4) return 2
    return 1
}

function takeRoll(randomRoll: number | undefined): number {
    if (randomRoll === undefined) return Math.random()
    if (!Number.isFinite(randomRoll) || randomRoll < 0 || randomRoll > 1) {
        throw new Error('randomRoll must be a finite number between 0 and 1')
    }
    return randomRoll
}

function formatSigned(delta: number): string {
    const rounded = delta.toFixed(2)
    return delta >= 0 ? `+${rounded}` : rounded
}

function categoryLabel(category: string | null): string {
    if (typeof category !== 'string') return 'none'
    const trimmed = category.trim()
    return trimmed.length > 0 ? trimmed : 'none'
}

/**
 * Decide whether to attach photos. Pass randomRoll (0–1) to make the result deterministic.
 * shouldAttach is true only when the roll is strictly below the probability.
 */
export function makePhotoDecision(
    input: PhotoDecisionInput,
    randomRoll?: number,
): PhotoDecision {
    const score = scorePhotoAttach(input)
    const probability = score.probability
    const roll = takeRoll(randomRoll)
    const shouldAttach = roll < probability
    const maxPhotos = shouldAttach ? decidePhotoCount(probability, input.rating) : 0
    const action = shouldAttach ? `Attach up to ${maxPhotos} photo(s)` : 'Skip photos'
    const reason = [
        `${action}:`,
        `rating ${input.rating} (${formatSigned(score.ratingDelta)})`,
        `category "${categoryLabel(input.category)}" [${score.category.rule} ${formatSigned(score.category.delta)}]`,
        `reviewLength ${score.reviewLength} (${formatSigned(score.lengthDelta)})`,
        `warmup ${input.accountWarmupLevel} (${formatSigned(score.warmupDelta)})`,
        `firstReview ${input.isFirstReviewForLocation === true} (${formatSigned(score.firstReviewDelta)})`,
        `probability ${probability.toFixed(2)}`,
        `roll ${roll.toFixed(2)}`,
    ].join(' ')
    return { shouldAttach, maxPhotos, reason, probability }
}

function emptyPhotos(reason: string): ReviewPhotoResolveResult {
    return {
        paths: [],
        source: 'none',
        labels: [],
        reason,
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message
    return 'unknown photo resolve error'
}

export class ReviewPhotoStrategy {
    decide(input: PhotoDecisionInput): PhotoDecision {
        return makePhotoDecision(input)
    }

    /**
     * Decide, then resolve library photos only when the roll says to attach.
     * A resolver failure becomes source 'none' and does not throw — the review
     * can still be posted without photos.
     */
    resolvePhotosForReview(
        input: PhotoDecisionInput & { campaignId?: string },
    ): PhotoResolveForReviewResult {
        const decision = this.decide(input)
        if (!decision.shouldAttach) {
            return { decision, photos: emptyPhotos(decision.reason) }
        }

        const request: ReviewPhotoResolveInput = {
            maxPhotos: decision.maxPhotos,
            includePhotos: true,
            accountKey: String(input.accountId),
            campaignId: input.campaignId,
        }

        try {
            const photos = reviewPhotoService.resolvePhotos(request)
            return { decision, photos }
        } catch (error) {
            return {
                decision,
                photos: emptyPhotos(`photo resolve failed: ${errorMessage(error)}`),
            }
        }
    }
}

export const reviewPhotoStrategy = new ReviewPhotoStrategy()
