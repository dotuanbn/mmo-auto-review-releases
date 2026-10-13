/**
 * Review verification schedule, survival-day math, and persisted check results.
 * Service tests use a mocked better-sqlite3 / drizzle chain (no Electron, no network).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        reviewHistory: {
            id: 'reviewHistory.id',
            status: 'reviewHistory.status',
            accountId: 'reviewHistory.accountId',
            locationId: 'reviewHistory.locationId',
            rating: 'reviewHistory.rating',
            reviewText: 'reviewHistory.reviewText',
            createdAt: 'reviewHistory.createdAt',
            lastCheckAt: 'reviewHistory.lastCheckAt',
            checkCount: 'reviewHistory.checkCount',
            verifiedStatus: 'reviewHistory.verifiedStatus',
            verifiedAt: 'reviewHistory.verifiedAt',
            survivalDays: 'reviewHistory.survivalDays',
            googleReviewId: 'reviewHistory.googleReviewId',
            styleApplied: 'reviewHistory.styleApplied',
        },
        accounts: {
            id: 'accounts.id',
            email: 'accounts.email',
        },
        locations: {
            id: 'locations.id',
            name: 'locations.name',
            url: 'locations.url',
        },
    },
}))

import { getDatabase } from '../src/main/database'
import {
    calculateSurvivalDays,
    isReviewDueForCheck,
    ReviewVerificationService,
    type RecordVerificationInput,
} from '../src/main/services/ReviewVerificationService'
import {
    reviewVerificationQueueLimitSchema,
    reviewVerificationRecordSchema,
    type ReviewVerificationQueueItem,
} from '../src/shared/review-history-contracts'

const getDatabaseMock = vi.mocked(getDatabase)

const NOW = new Date('2026-10-12T00:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function hoursBefore(hours: number, from: Date = NOW): Date {
    return new Date(from.getTime() - hours * HOUR_MS)
}

function daysBefore(days: number, from: Date = NOW): Date {
    return new Date(from.getTime() - days * DAY_MS)
}

describe('isReviewDueForCheck', () => {
    it('returns false if verifiedStatus is removed', () => {
        expect(isReviewDueForCheck({
            createdAt: daysBefore(40),
            lastCheckAt: null,
            checkCount: 0,
            verifiedStatus: 'removed',
        }, NOW)).toBe(false)
    })

    it('returns false if checkCount >= 3', () => {
        expect(isReviewDueForCheck({
            createdAt: daysBefore(40),
            lastCheckAt: daysBefore(20),
            checkCount: 3,
            verifiedStatus: 'live',
        }, NOW)).toBe(false)
    })

    it('returns false for a new review younger than 24h', () => {
        expect(isReviewDueForCheck({
            createdAt: new Date(NOW.getTime() - 24 * HOUR_MS + 1),
            lastCheckAt: null,
            checkCount: 0,
            verifiedStatus: 'pending',
        }, NOW)).toBe(false)
    })

    it('returns true for a review at least 24h old with checkCount 0', () => {
        expect(isReviewDueForCheck({
            createdAt: new Date(NOW.getTime() - 24 * HOUR_MS),
            lastCheckAt: null,
            checkCount: 0,
            verifiedStatus: 'pending',
        }, NOW)).toBe(true)
    })

    it('returns true at the 7d checkpoint when checkCount is 1 and the last check is at least 5d ago', () => {
        expect(isReviewDueForCheck({
            createdAt: daysBefore(7),
            lastCheckAt: daysBefore(5),
            checkCount: 1,
            verifiedStatus: 'live',
        }, NOW)).toBe(true)
    })

    it('returns false at the 7d checkpoint when the last check was only 1d ago', () => {
        expect(isReviewDueForCheck({
            createdAt: daysBefore(7),
            lastCheckAt: daysBefore(1),
            checkCount: 1,
            verifiedStatus: 'live',
        }, NOW)).toBe(false)
    })

    it('returns true at the 30d checkpoint when checkCount is 2 and the last check is at least 15d ago', () => {
        expect(isReviewDueForCheck({
            createdAt: daysBefore(30),
            lastCheckAt: daysBefore(15),
            checkCount: 2,
            verifiedStatus: 'live',
        }, NOW)).toBe(true)
    })
})

describe('calculateSurvivalDays', () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z')

    it('returns 0 days for the same day', () => {
        expect(calculateSurvivalDays(createdAt, createdAt)).toBe(0)
        expect(calculateSurvivalDays(createdAt, new Date(createdAt.getTime() + 6 * HOUR_MS))).toBe(0)
    })

    it('returns 7 days for a 7 day difference', () => {
        expect(calculateSurvivalDays(createdAt, new Date(createdAt.getTime() + 7 * DAY_MS))).toBe(7)
    })

    it('clamps a negative span to 0', () => {
        expect(calculateSurvivalDays(createdAt, new Date(createdAt.getTime() - 3 * DAY_MS))).toBe(0)
    })
})

describe('review verification IPC schemas', () => {
    it('accepts a strict record and a bounded queue limit', () => {
        expect(reviewVerificationRecordSchema.parse({
            historyId: 4,
            status: 'live',
            googleReviewId: '  abc  ',
        })).toEqual({
            historyId: 4,
            status: 'live',
            googleReviewId: 'abc',
        })
        expect(reviewVerificationRecordSchema.safeParse({
            historyId: 4,
            status: 'live',
            extra: true,
        }).success).toBe(false)
        expect(reviewVerificationRecordSchema.safeParse({
            historyId: 0,
            status: 'removed',
        }).success).toBe(false)
        expect(reviewVerificationQueueLimitSchema.parse(undefined)).toBeUndefined()
        expect(reviewVerificationQueueLimitSchema.parse(200)).toBe(200)
        expect(reviewVerificationQueueLimitSchema.safeParse(0).success).toBe(false)
        expect(reviewVerificationQueueLimitSchema.safeParse(201).success).toBe(false)
    })
})

interface StoredReview {
    id: number
    createdAt: Date
    verifiedAt: Date | null
    verifiedStatus: string | null
    lastCheckAt: Date | null
    checkCount: number | null
    survivalDays: number | null
    googleReviewId: string | null
    status: 'success' | 'failed'
}

interface VerificationPatch {
    verifiedStatus: 'live' | 'removed' | 'unknown'
    verifiedAt: Date | null
    lastCheckAt: Date
    checkCount: number
    survivalDays: number
    googleReviewId: string | null
}

function createRecordDb(existing: StoredReview | undefined) {
    const getExisting = vi.fn(() => existing)
    const select = vi.fn(() => ({
        from: () => ({
            where: () => ({
                get: getExisting,
            }),
        }),
    }))

    const getUpdated = vi.fn((patch: VerificationPatch) => ({
        ...existing,
        ...patch,
        id: existing?.id,
    }))
    const updateSet = vi.fn((patch: VerificationPatch) => ({
        where: () => ({
            returning: () => ({
                get: () => getUpdated(patch),
            }),
        }),
    }))
    const update = vi.fn(() => ({
        set: updateSet,
    }))

    return {
        db: { select, update },
        updateSet,
        update,
        getUpdated,
    }
}

describe('ReviewVerificationService.recordVerificationResult', () => {
    let service: ReviewVerificationService

    beforeEach(() => {
        vi.clearAllMocks()
        service = new ReviewVerificationService()
    })

    it('marks a live review, stamps verifiedAt, and increments the check', () => {
        const createdAt = new Date('2026-09-01T00:00:00.000Z')
        const checkedAt = new Date('2026-09-08T00:00:00.000Z')
        const existing: StoredReview = {
            id: 15,
            createdAt,
            verifiedAt: null,
            verifiedStatus: 'pending',
            lastCheckAt: null,
            checkCount: 0,
            survivalDays: null,
            googleReviewId: null,
            status: 'success',
        }
        const mock = createRecordDb(existing)
        getDatabaseMock.mockReturnValue(mock.db as never)

        const input: RecordVerificationInput = {
            historyId: 15,
            status: 'live',
            googleReviewId: 'maps-review-15',
            checkedAt,
        }
        const result = service.recordVerificationResult(input)

        const patch = mock.updateSet.mock.calls[0]?.[0]
        expect(patch).toEqual({
            verifiedStatus: 'live',
            verifiedAt: checkedAt,
            lastCheckAt: checkedAt,
            checkCount: 1,
            survivalDays: 7,
            googleReviewId: 'maps-review-15',
        })
        expect(result).toMatchObject({
            id: 15,
            verifiedStatus: 'live',
            verifiedAt: checkedAt,
            lastCheckAt: checkedAt,
            checkCount: 1,
            survivalDays: 7,
            googleReviewId: 'maps-review-15',
        })
    })

    it('keeps the previous verifiedAt and googleReviewId when the review is removed', () => {
        const createdAt = new Date('2026-08-01T00:00:00.000Z')
        const previousVerifiedAt = new Date('2026-08-02T00:00:00.000Z')
        const checkedAt = new Date('2026-08-31T00:00:00.000Z')
        const existing: StoredReview = {
            id: 8,
            createdAt,
            verifiedAt: previousVerifiedAt,
            verifiedStatus: 'live',
            lastCheckAt: previousVerifiedAt,
            checkCount: 1,
            survivalDays: 1,
            googleReviewId: 'keep-me',
            status: 'success',
        }
        const mock = createRecordDb(existing)
        getDatabaseMock.mockReturnValue(mock.db as never)

        service.recordVerificationResult({
            historyId: 8,
            status: 'removed',
            checkedAt,
        })

        expect(mock.updateSet.mock.calls[0]?.[0]).toEqual({
            verifiedStatus: 'removed',
            verifiedAt: previousVerifiedAt,
            lastCheckAt: checkedAt,
            checkCount: 2,
            survivalDays: 30,
            googleReviewId: 'keep-me',
        })
    })

    it('treats a null checkCount as zero and leaves verifiedAt untouched for unknown', () => {
        const createdAt = new Date('2026-10-01T00:00:00.000Z')
        const checkedAt = new Date('2026-10-03T12:00:00.000Z')
        const existing: StoredReview = {
            id: 3,
            createdAt,
            verifiedAt: null,
            verifiedStatus: 'pending',
            lastCheckAt: null,
            checkCount: null,
            survivalDays: null,
            googleReviewId: null,
            status: 'success',
        }
        const mock = createRecordDb(existing)
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = service.recordVerificationResult({
            historyId: 3,
            status: 'unknown',
            checkedAt,
        })

        expect(mock.updateSet.mock.calls[0]?.[0]).toMatchObject({
            verifiedStatus: 'unknown',
            verifiedAt: null,
            checkCount: 1,
            survivalDays: 2,
            googleReviewId: null,
        })
        expect(result.checkCount).toBe(1)
    })

    it('throws when the history row is missing and does not update', () => {
        const mock = createRecordDb(undefined)
        getDatabaseMock.mockReturnValue(mock.db as never)

        expect(() => service.recordVerificationResult({
            historyId: 404,
            status: 'live',
        })).toThrow(/not found/i)
        expect(mock.update).not.toHaveBeenCalled()
    })
})

function queueRow(
    overrides: Partial<ReviewVerificationQueueItem> & Pick<ReviewVerificationQueueItem, 'historyId' | 'createdAt' | 'checkCount'>,
): ReviewVerificationQueueItem {
    return {
        accountId: 10,
        accountEmail: 'reviewer@example.com',
        locationId: 20,
        locationName: 'Cafe',
        locationUrl: 'https://maps.example/cafe',
        rating: 5,
        reviewText: 'Solid coffee',
        lastCheckAt: null,
        verifiedStatus: 'pending',
        googleReviewId: null,
        styleApplied: false,
        ...overrides,
    }
}

function createQueueDb(rows: readonly ReviewVerificationQueueItem[]) {
    const all = vi.fn(() => rows)
    const select = vi.fn(() => ({
        from: () => ({
            innerJoin: () => ({
                innerJoin: () => ({
                    where: () => ({
                        orderBy: () => ({
                            all,
                        }),
                    }),
                }),
            }),
        }),
    }))
    return { db: { select }, all }
}

describe('ReviewVerificationService.getVerificationQueue', () => {
    let service: ReviewVerificationService

    beforeEach(() => {
        vi.clearAllMocks()
        service = new ReviewVerificationService()
    })

    it('returns only due rows, in query order, up to the limit', () => {
        const fresh = queueRow({
            historyId: 1,
            createdAt: hoursBefore(1),
            checkCount: 0,
        })
        const due24 = queueRow({
            historyId: 2,
            createdAt: hoursBefore(24),
            checkCount: 0,
            styleApplied: null as unknown as boolean,
        })
        const gapTooSmall = queueRow({
            historyId: 3,
            createdAt: daysBefore(7),
            lastCheckAt: daysBefore(1),
            checkCount: 1,
            verifiedStatus: 'live',
        })
        const due30 = queueRow({
            historyId: 4,
            createdAt: daysBefore(30),
            lastCheckAt: daysBefore(15),
            checkCount: 2,
            verifiedStatus: 'live',
        })
        const mock = createQueueDb([fresh, due24, gapTooSmall, due30])
        getDatabaseMock.mockReturnValue(mock.db as never)

        const queued = service.getVerificationQueue(1, NOW)
        expect(queued.map((row) => row.historyId)).toEqual([2])
        expect(queued[0]?.styleApplied).toBe(false)
        expect(queued[0]?.accountEmail).toBe('reviewer@example.com')
        expect(queued[0]?.locationUrl).toBe('https://maps.example/cafe')

        const allDue = service.getVerificationQueue(50, NOW)
        expect(allDue.map((row) => row.historyId)).toEqual([2, 4])
    })
})
