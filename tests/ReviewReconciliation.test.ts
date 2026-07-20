/**
 * Manual reconciliation of durable review_history intents
 * (submitting / unconfirmed → success | failed).
 * Pure helpers + service with mocked DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/database', () => ({
    getDatabase: vi.fn(),
    schema: {
        reviewHistory: {
            id: 'id',
            status: 'status',
            accountId: 'accountId',
            locationId: 'locationId',
            campaignId: 'campaignId',
            rating: 'rating',
            reviewText: 'reviewText',
            errorMessage: 'errorMessage',
            createdAt: 'createdAt',
        },
        accounts: {
            id: 'id',
            email: 'email',
        },
        locations: {
            id: 'id',
            name: 'name',
            url: 'url',
        },
        campaigns: {
            id: 'id',
            successReviews: 'successReviews',
            failedReviews: 'failedReviews',
        },
    },
}))

vi.mock('../src/main/services/ComplianceAuditService', () => ({
    recordComplianceAudit: vi.fn(() => null),
    complianceAuditService: { record: vi.fn(() => null) },
    ComplianceAuditService: class {
        record() {
            return null
        }
    },
}))

import { getDatabase } from '../src/main/database'
import {
    buildManualReconcileErrorMessage,
    clampReconcileNote,
    evaluateReconcileTransition,
    evaluateSubmissionGate,
    isBlockingSubmissionStatus,
    isReconcileEligibleStatus,
    mapReconcileOutcomeToHistoryStatus,
    previewReviewText,
    ReviewService,
} from '../src/main/services/ReviewService'
import {
    COMPLIANCE_RECONCILE_NOTE_MAX,
    PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX,
} from '../src/shared/compliance-contracts'

const getDatabaseMock = vi.mocked(getDatabase)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('ReviewReconciliation — eligibility & mapping', () => {
    it('only submitting/unconfirmed are reconcile-eligible', () => {
        expect(isReconcileEligibleStatus('submitting')).toBe(true)
        expect(isReconcileEligibleStatus('unconfirmed')).toBe(true)
        expect(isReconcileEligibleStatus('success')).toBe(false)
        expect(isReconcileEligibleStatus('failed')).toBe(false)
        expect(isReconcileEligibleStatus(undefined)).toBe(false)
        expect(isReconcileEligibleStatus(null)).toBe(false)
    })

    it('maps outcomes to terminal history statuses', () => {
        expect(mapReconcileOutcomeToHistoryStatus('confirmed_success')).toBe('success')
        expect(mapReconcileOutcomeToHistoryStatus('confirmed_not_posted')).toBe('failed')
    })

    it('confirmed_not_posted clears block semantics (failed is non-blocking)', () => {
        expect(isBlockingSubmissionStatus('failed')).toBe(false)
        expect(isBlockingSubmissionStatus('success')).toBe(false)
        // After not-posted → failed, gate allows proceed for a new attempt
        expect(evaluateSubmissionGate([{ id: 1, status: 'failed' }]).action).toBe('proceed')
        // After success, gate is idempotent complete (no re-post)
        expect(evaluateSubmissionGate([{ id: 2, status: 'success' }]).action).toBe(
            'idempotent_complete',
        )
    })
})

describe('ReviewReconciliation — evaluateReconcileTransition', () => {
    it('allows submitting → success on confirmed_success', () => {
        const d = evaluateReconcileTransition('submitting', 'confirmed_success')
        expect(d).toEqual({
            ok: true,
            previousStatus: 'submitting',
            newStatus: 'success',
        })
    })

    it('allows unconfirmed → failed on confirmed_not_posted', () => {
        const d = evaluateReconcileTransition('unconfirmed', 'confirmed_not_posted')
        expect(d).toEqual({
            ok: true,
            previousStatus: 'unconfirmed',
            newStatus: 'failed',
        })
    })

    it('allows unconfirmed → success and submitting → failed', () => {
        expect(evaluateReconcileTransition('unconfirmed', 'confirmed_success')).toMatchObject({
            ok: true,
            newStatus: 'success',
        })
        expect(evaluateReconcileTransition('submitting', 'confirmed_not_posted')).toMatchObject({
            ok: true,
            newStatus: 'failed',
        })
    })

    it('rejects missing intent', () => {
        const d = evaluateReconcileTransition(null, 'confirmed_success')
        expect(d.ok).toBe(false)
        if (!d.ok) {
            expect(d.reason).toMatch(/not found/i)
        }
    })

    it('idempotently rejects stale terminal statuses', () => {
        for (const status of ['success', 'failed', 'cancelled', 'pending'] as const) {
            const d = evaluateReconcileTransition(status, 'confirmed_success')
            expect(d.ok).toBe(false)
            if (!d.ok) {
                expect(d.previousStatus).toBe(status)
                expect(d.reason).toMatch(/no longer reconcilable|stale/i)
            }
        }
    })
})

describe('ReviewReconciliation — notes & preview', () => {
    it('clamps operator notes (empty/oversize/null)', () => {
        expect(clampReconcileNote(null)).toBeNull()
        expect(clampReconcileNote(undefined)).toBeNull()
        expect(clampReconcileNote('   ')).toBeNull()
        expect(clampReconcileNote('  ok  ')).toBe('ok')
        const oversized = 'x'.repeat(COMPLIANCE_RECONCILE_NOTE_MAX + 50)
        const clamped = clampReconcileNote(oversized)
        expect(clamped).not.toBeNull()
        expect(clamped!.length).toBe(COMPLIANCE_RECONCILE_NOTE_MAX)
    })

    it('builds error markers for both outcomes', () => {
        expect(buildManualReconcileErrorMessage('confirmed_success')).toBeNull()
        expect(buildManualReconcileErrorMessage('confirmed_success', '  ok  ')).toBe(
            'manual_reconcile:confirmed_success: ok',
        )
        expect(buildManualReconcileErrorMessage('confirmed_not_posted')).toBe(
            'manual_reconcile:confirmed_not_posted',
        )
        expect(buildManualReconcileErrorMessage('confirmed_not_posted', 'checked')).toBe(
            'manual_reconcile:confirmed_not_posted: checked',
        )
        // Oversized note is clamped, not thrown
        const long = 'n'.repeat(COMPLIANCE_RECONCILE_NOTE_MAX + 20)
        const msg = buildManualReconcileErrorMessage('confirmed_not_posted', long)
        expect(msg).toMatch(/^manual_reconcile:confirmed_not_posted: /)
        expect(msg!.length).toBeLessThanOrEqual(
            'manual_reconcile:confirmed_not_posted: '.length + COMPLIANCE_RECONCILE_NOTE_MAX,
        )
    })

    it('bounds review text preview', () => {
        expect(previewReviewText('short')).toBe('short')
        const long = 'a'.repeat(PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX + 40)
        const preview = previewReviewText(long)
        expect(preview.length).toBeLessThanOrEqual(PENDING_REVIEW_INTENT_TEXT_PREVIEW_MAX)
        expect(preview.endsWith('…')).toBe(true)
        expect(previewReviewText(null)).toBe('')
        expect(previewReviewText(undefined)).toBe('')
    })
})

// ---------------------------------------------------------------------------
// Service (mocked better-sqlite3 / drizzle chain)
// ---------------------------------------------------------------------------

function createMockDb(options: {
    getResult?: unknown
    allResult?: unknown[]
    changes?: number
    postUpdateGet?: unknown
}) {
    const getFn = vi.fn()
    const allFn = vi.fn().mockReturnValue(options.allResult ?? [])
    // First history update returns options.changes; subsequent (campaign counter) always 1
    const runFn = vi
        .fn()
        .mockReturnValueOnce({ changes: options.changes ?? 0 })
        .mockReturnValue({ changes: 1 })

    // First get = pre-read; subsequent gets can return post-race status
    if (options.getResult !== undefined) {
        getFn.mockReturnValueOnce(options.getResult)
    }
    if (options.postUpdateGet !== undefined) {
        getFn.mockReturnValue(options.postUpdateGet)
    } else if (options.getResult !== undefined) {
        getFn.mockReturnValue(options.getResult)
    } else {
        getFn.mockReturnValue(undefined)
    }

    const orderBy = vi.fn(() => ({
        all: allFn,
    }))

    const fromSelect = vi.fn(() => ({
        where: vi.fn(),
    }))

    const select = vi.fn(() => ({
        from: fromSelect,
    }))

    // For simpler paths that use .where().get() without orderBy
    // Override where to support both shapes:
    const flexibleWhere = vi.fn(() => ({
        orderBy,
        get: getFn,
        all: allFn,
        limit: vi.fn(() => ({ get: getFn })),
    }))
    fromSelect.mockImplementation(() => ({
        where: flexibleWhere,
    }))

    const updateWhere = vi.fn(() => ({
        run: runFn,
    }))
    const updateSet = vi.fn(() => ({
        where: updateWhere,
    }))
    const update = vi.fn(() => ({
        set: updateSet,
    }))

    return {
        db: { select, update },
        getFn,
        allFn,
        runFn,
        updateSet,
        updateWhere,
        update,
        select,
        flexibleWhere,
    }
}

describe('ReviewService.reconcileReviewIntent', () => {
    let service: ReviewService

    beforeEach(() => {
        vi.clearAllMocks()
        service = new ReviewService()
    })

    it('atomically transitions submitting → success on confirmed_success', async () => {
        const mock = createMockDb({
            getResult: { id: 10, status: 'submitting', campaignId: 42 },
            changes: 1,
        })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = await service.reconcileReviewIntent(10, 'confirmed_success', 'verified')
        expect(result.success).toBe(true)
        expect(result.historyId).toBe(10)
        expect(result.previousStatus).toBe('submitting')
        expect(result.newStatus).toBe('success')
        expect(mock.updateSet).toHaveBeenCalled()
        const patch = mock.updateSet.mock.calls[0]?.[0] as {
            status: string
            errorMessage: string | null
        }
        expect(patch.status).toBe('success')
        expect(patch.errorMessage).toContain('confirmed_success')
        // Success path bumps campaign success counter after atomic apply
        expect(mock.update).toHaveBeenCalled()
    })

    it('atomically transitions unconfirmed → failed on confirmed_not_posted', async () => {
        const mock = createMockDb({
            getResult: { id: 11, status: 'unconfirmed', campaignId: 7 },
            changes: 1,
        })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = await service.reconcileReviewIntent(11, 'confirmed_not_posted')
        expect(result.success).toBe(true)
        expect(result.newStatus).toBe('failed')
        expect(result.previousStatus).toBe('unconfirmed')
        const patch = mock.updateSet.mock.calls[0]?.[0] as {
            status: string
            errorMessage: string | null
        }
        expect(patch.status).toBe('failed')
        expect(patch.errorMessage).toBe('manual_reconcile:confirmed_not_posted')
    })

    it('skips campaign counter when campaignId is null', async () => {
        const mock = createMockDb({
            getResult: { id: 12, status: 'submitting', campaignId: null },
            changes: 1,
        })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = await service.reconcileReviewIntent(12, 'confirmed_success')
        expect(result.success).toBe(true)
        // history update only (no campaign counter update)
        expect(mock.update).toHaveBeenCalledTimes(1)
    })

    it('rejects missing history id without update', async () => {
        const mock = createMockDb({ getResult: undefined, changes: 0 })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = await service.reconcileReviewIntent(999, 'confirmed_success')
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/not found/i)
        expect(mock.updateSet).not.toHaveBeenCalled()
    })

    it('rejects stale success status (idempotent)', async () => {
        const mock = createMockDb({
            getResult: { id: 5, status: 'success' },
            changes: 0,
        })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = await service.reconcileReviewIntent(5, 'confirmed_not_posted')
        expect(result.success).toBe(false)
        expect(result.previousStatus).toBe('success')
        expect(result.message).toMatch(/no longer reconcilable|stale/i)
        expect(mock.updateSet).not.toHaveBeenCalled()
    })

    it('rejects when atomic update races to 0 changes', async () => {
        const mock = createMockDb({
            getResult: { id: 7, status: 'submitting' },
            changes: 0,
            postUpdateGet: { status: 'success' },
        })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const result = await service.reconcileReviewIntent(7, 'confirmed_success')
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/stale|concurrent|no longer reconcilable/i)
        expect(result.previousStatus).toBe('success')
    })
})

describe('ReviewService.getPendingReviewIntents', () => {
    let service: ReviewService

    beforeEach(() => {
        vi.clearAllMocks()
        service = new ReviewService()
    })

    it('returns empty list when no reconcilable rows', async () => {
        const mock = createMockDb({ allResult: [] })
        getDatabaseMock.mockReturnValue(mock.db as never)

        const rows = await service.getPendingReviewIntents()
        expect(rows).toEqual([])
    })

    it('maps submitting/unconfirmed rows to public DTOs with enrichment', async () => {
        const historyRows = [
            {
                id: 1,
                status: 'unconfirmed',
                accountId: 10,
                locationId: 20,
                campaignId: 3,
                rating: 5,
                reviewText: 'Great place',
                errorMessage: 'Submission unconfirmed',
                createdAt: new Date('2026-07-01T12:00:00.000Z'),
            },
            {
                id: 2,
                status: 'submitting',
                accountId: 10,
                locationId: 21,
                campaignId: null,
                rating: 4,
                reviewText: 'Nice',
                errorMessage: null,
                createdAt: new Date('2026-07-02T12:00:00.000Z'),
            },
        ]

        // select() is called 3 times: history, accounts, locations
        const allHistory = vi.fn().mockReturnValue(historyRows)
        const allAccounts = vi.fn().mockReturnValue([{ id: 10, email: 'a@example.com' }])
        const allLocations = vi.fn().mockReturnValue([
            { id: 20, name: 'Cafe A', url: 'https://maps.example/a' },
            { id: 21, name: 'Cafe B', url: 'https://maps.example/b' },
        ])

        let selectCall = 0
        const select = vi.fn(() => {
            selectCall += 1
            const call = selectCall
            return {
                from: vi.fn(() => ({
                    where: vi.fn(() => ({
                        orderBy: vi.fn(() => ({
                            all: call === 1 ? allHistory : call === 2 ? allAccounts : allLocations,
                        })),
                        all: call === 1 ? allHistory : call === 2 ? allAccounts : allLocations,
                        get: vi.fn(),
                    })),
                })),
            }
        })

        getDatabaseMock.mockReturnValue({ select, update: vi.fn() } as never)

        const rows = await service.getPendingReviewIntents()
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({
            historyId: 1,
            status: 'unconfirmed',
            accountEmail: 'a@example.com',
            locationName: 'Cafe A',
            locationUrl: 'https://maps.example/a',
            campaignId: 3,
            reviewTextPreview: 'Great place',
        })
        expect(rows[1]).toMatchObject({
            historyId: 2,
            status: 'submitting',
            locationName: 'Cafe B',
            campaignId: null,
        })
        expect(rows[0]?.createdAt).toBe('2026-07-01T12:00:00.000Z')
    })
})
