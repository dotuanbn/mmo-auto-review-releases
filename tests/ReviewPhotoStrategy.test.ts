/**
 * Photo attach strategy. ReviewPhotoService, database, and settings are mocked;
 * probability math is exercised directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { resolvePhotosMock } = vi.hoisted(() => ({
    resolvePhotosMock: vi.fn(),
}))

vi.mock('../src/main/services/ReviewPhotoService', () => ({
    reviewPhotoService: {
        resolvePhotos: resolvePhotosMock,
    },
}))

vi.mock('../src/main/database', () => ({
    getDatabase: () => {
        throw new Error('database should not be used by ReviewPhotoStrategy')
    },
}))

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: () => {
        throw new Error('settings should not be used by ReviewPhotoStrategy')
    },
}))

import type { ReviewPhotoResolveResult } from '../src/main/services/ReviewPhotoService'
import {
    calculatePhotoAttachProbability,
    decidePhotoCount,
    makePhotoDecision,
    ReviewPhotoStrategy,
    type PhotoDecisionInput,
} from '../src/main/services/ReviewPhotoStrategy'

const NEUTRAL_TEXT = 'Stable neutral review text for photo probability.'

function decisionInput(overrides: Partial<PhotoDecisionInput> = {}): PhotoDecisionInput {
    return {
        accountId: 7,
        locationId: 42,
        rating: 3,
        reviewText: NEUTRAL_TEXT,
        category: null,
        accountTotalReviews: 4,
        accountWarmupLevel: 30,
        isFirstReviewForLocation: false,
        ...overrides,
    }
}

function libraryResult(): ReviewPhotoResolveResult {
    return {
        paths: ['C:\\photos\\a.jpg', 'C:\\photos\\b.jpg', 'C:\\photos\\c.jpg'],
        source: 'library',
        labels: ['a.jpg', 'b.jpg', 'c.jpg'],
        reason: 'library:3',
    }
}

describe('calculatePhotoAttachProbability', () => {
    it('is high for a 5-star restaurant review with long text', () => {
        const probability = calculatePhotoAttachProbability(
            decisionInput({
                rating: 5,
                reviewText: 'x'.repeat(220),
                category: 'restaurant',
            }),
        )
        expect(probability).toBeGreaterThan(0.5)
        expect(probability).toBeLessThanOrEqual(0.7)
    })

    it('is low for a 1-star office review with short text', () => {
        const probability = calculatePhotoAttachProbability(
            decisionInput({
                rating: 1,
                reviewText: 'No',
                category: 'office',
            }),
        )
        expect(probability).toBeLessThan(0.15)
        expect(probability).toBeGreaterThanOrEqual(0.05)
    })

    it('reduces probability for a new account (warmupLevel < 20)', () => {
        const shared = {
            rating: 5 as const,
            category: 'restaurant',
            reviewText: NEUTRAL_TEXT,
            isFirstReviewForLocation: false,
        }
        const mature = calculatePhotoAttachProbability(
            decisionInput({ ...shared, accountWarmupLevel: 30 }),
        )
        const newbie = calculatePhotoAttachProbability(
            decisionInput({ ...shared, accountWarmupLevel: 10 }),
        )
        expect(newbie).toBeLessThan(mature)
        expect(newbie).toBeCloseTo(mature - 0.2, 10)
    })

    it('clamps probability to [0.05, 0.70]', () => {
        const high = calculatePhotoAttachProbability(
            decisionInput({
                rating: 5,
                reviewText: 'x'.repeat(240),
                category: 'Nhà hàng',
                accountWarmupLevel: 80,
                isFirstReviewForLocation: true,
            }),
        )
        const low = calculatePhotoAttachProbability(
            decisionInput({
                rating: 1,
                reviewText: 'x',
                category: 'Phòng khám',
                accountWarmupLevel: 0,
                isFirstReviewForLocation: false,
            }),
        )
        const neutral = calculatePhotoAttachProbability(decisionInput())

        expect(high).toBe(0.7)
        expect(low).toBe(0.05)
        expect(neutral).toBeCloseTo(0.3, 10)
        expect(neutral).toBeGreaterThan(0.05)
        expect(neutral).toBeLessThan(0.7)
    })

    it('applies the restaurant bonus for "Nhà hàng Phở 24"', () => {
        const neutral = calculatePhotoAttachProbability(decisionInput({ category: null }))
        const restaurant = calculatePhotoAttachProbability(
            decisionInput({ category: 'Nhà hàng Phở 24' }),
        )
        const upper = calculatePhotoAttachProbability(
            decisionInput({ category: 'NHÀ HÀNG PHỞ 24' }),
        )
        expect(restaurant).toBeCloseTo(neutral + 0.15, 10)
        expect(upper).toBeCloseTo(restaurant, 10)
    })

    it('applies the office penalty for "Phòng khám Đa khoa"', () => {
        const neutral = calculatePhotoAttachProbability(decisionInput({ category: null }))
        const clinic = calculatePhotoAttachProbability(
            decisionInput({ category: 'Phòng khám Đa khoa' }),
        )
        expect(clinic).toBeCloseTo(neutral - 0.1, 10)
    })

    it('applies no category modifier when category is null', () => {
        const withNull = calculatePhotoAttachProbability(decisionInput({ category: null }))
        const withOther = calculatePhotoAttachProbability(
            decisionInput({ category: 'bookstore' }),
        )
        expect(withNull).toBeCloseTo(0.3, 10)
        expect(withOther).toBeCloseTo(withNull, 10)
    })
})

describe('decidePhotoCount', () => {
    it('returns 3 photos for a high probability and 5 stars', () => {
        expect(decidePhotoCount(0.65, 5)).toBe(3)
        expect(decidePhotoCount(0.7, 5)).toBe(3)
    })

    it('returns 1 photo for a moderate probability', () => {
        expect(decidePhotoCount(0.4, 5)).toBe(1)
        expect(decidePhotoCount(0.4, 3)).toBe(1)
        expect(decidePhotoCount(0.55, 3)).toBe(1)
    })
})

describe('makePhotoDecision', () => {
    const input = decisionInput({
        rating: 5,
        category: 'Nhà hàng Phở 24',
        reviewText: 'x'.repeat(180),
    })

    it('attaches when randomRoll is 0.1 (below the calculated probability)', () => {
        const random = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Math.random should not run when randomRoll is provided')
        })
        const decision = makePhotoDecision(input, 0.1)
        expect(decision.shouldAttach).toBe(true)
        expect(decision.maxPhotos).toBeGreaterThanOrEqual(1)
        expect(decision.maxPhotos).toBeLessThanOrEqual(3)
        expect(decision.probability).toBe(calculatePhotoAttachProbability(input))
        expect(decision.probability).toBeGreaterThan(0.1)
        random.mockRestore()
    })

    it('skips photos when randomRoll is 0.99', () => {
        const decision = makePhotoDecision(input, 0.99)
        expect(decision.shouldAttach).toBe(false)
        expect(decision.maxPhotos).toBe(0)
        expect(decision.probability).toBeLessThanOrEqual(0.7)
    })

    it('is deterministic for the same randomRoll', () => {
        expect(makePhotoDecision(input, 0.1)).toEqual(makePhotoDecision(input, 0.1))
        expect(makePhotoDecision(input, 0.99)).toEqual(makePhotoDecision(input, 0.99))
    })

    it('includes category and rating in the reason', () => {
        const decision = makePhotoDecision(input, 0.99)
        expect(decision.reason).toContain('Nhà hàng Phở 24')
        expect(decision.reason).toContain('rating 5')
        expect(decision.reason.length).toBeGreaterThan(0)
    })

    it('rejects a randomRoll outside 0..1', () => {
        expect(() => makePhotoDecision(input, 1.5)).toThrow(/randomRoll/)
        expect(() => makePhotoDecision(input, Number.NaN)).toThrow(/randomRoll/)
    })
})

describe('ReviewPhotoStrategy', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        resolvePhotosMock.mockReset()
    })

    it('decide returns a PhotoDecision with every field', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.1)
        const strategy = new ReviewPhotoStrategy()
        const input = decisionInput({
            rating: 4,
            category: 'cafe',
            reviewText: NEUTRAL_TEXT,
        })
        const decision = strategy.decide(input)

        expect(decision.shouldAttach).toBe(true)
        expect(decision.maxPhotos).toBeGreaterThanOrEqual(1)
        expect(decision.maxPhotos).toBeLessThanOrEqual(3)
        expect(typeof decision.reason).toBe('string')
        expect(decision.reason).toContain('cafe')
        expect(decision.reason).toContain('rating 4')
        expect(decision.probability).toBe(calculatePhotoAttachProbability(input))
        expect(decision.probability).toBeGreaterThanOrEqual(0.05)
        expect(decision.probability).toBeLessThanOrEqual(0.7)
    })

    it('resolvePhotosForReview calls resolvePhotos when the roll attaches', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.01)
        resolvePhotosMock.mockReturnValue(libraryResult())
        const strategy = new ReviewPhotoStrategy()
        const input = decisionInput({
            accountId: 7,
            rating: 5,
            reviewText: 'x'.repeat(240),
            category: 'Nhà hàng',
            accountWarmupLevel: 80,
            isFirstReviewForLocation: true,
            campaignId: 'camp-42',
        })

        const result = strategy.resolvePhotosForReview(input)

        expect(result.decision.shouldAttach).toBe(true)
        expect(result.decision.maxPhotos).toBe(3)
        expect(resolvePhotosMock).toHaveBeenCalledTimes(1)
        expect(resolvePhotosMock).toHaveBeenCalledWith({
            maxPhotos: 3,
            includePhotos: true,
            accountKey: '7',
            campaignId: 'camp-42',
        })
        expect(result.photos).toEqual(libraryResult())
    })

    it('resolvePhotosForReview returns source none and does not resolve when skipping', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.99)
        const strategy = new ReviewPhotoStrategy()
        const input = decisionInput({
            rating: 5,
            category: 'Nhà hàng Phở 24',
            campaignId: 'camp-42',
        })

        const result = strategy.resolvePhotosForReview(input)

        expect(result.decision.shouldAttach).toBe(false)
        expect(result.photos).toEqual({
            paths: [],
            source: 'none',
            labels: [],
            reason: result.decision.reason,
        })
        expect(resolvePhotosMock).not.toHaveBeenCalled()
    })

    it('returns source none when the photo resolver throws', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.01)
        resolvePhotosMock.mockImplementation(() => {
            throw new Error('disk offline')
        })
        const strategy = new ReviewPhotoStrategy()
        const result = strategy.resolvePhotosForReview(
            decisionInput({ rating: 5, category: 'restaurant', reviewText: 'x'.repeat(220) }),
        )

        expect(result.decision.shouldAttach).toBe(true)
        expect(result.photos.source).toBe('none')
        expect(result.photos.paths).toEqual([])
        expect(result.photos.labels).toEqual([])
        expect(result.photos.reason).toContain('disk offline')
    })
})
