/**
 * Compliance + Review History IPC boundary validation.
 * Pure schema tests (no Electron / DB). Handlers use these schemas via withIpcValidation.
 */
import { describe, expect, it } from 'vitest'
import {
    COMPLIANCE_REJECT_REASON_MAX,
    COMPLIANCE_REQUEST_ID_MAX,
    complianceApproveArgsSchema,
    complianceRejectArgsSchema,
    complianceRejectReasonSchema,
    complianceRequestIdSchema,
} from '../src/shared/compliance-contracts'
import {
    REVIEW_HISTORY_LIMIT_MAX,
    reviewHistoryCampaignIdSchema,
    reviewHistoryFiltersInputSchema,
    reviewHistoryFiltersSchema,
    reviewHistoryLimitSchema,
    reviewHistoryOptionalLimitSchema,
} from '../src/shared/review-history-contracts'

function expectOk(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
    return result
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
    return result
}

// ---------------------------------------------------------------------------
// Compliance — requestId / reject reason
// ---------------------------------------------------------------------------

describe('complianceRequestIdSchema', () => {
    it('accepts nonempty bounded request ids', () => {
        expectOk(complianceRequestIdSchema, 'manual-submit-1710000000000-abc123')
        expectOk(complianceRequestIdSchema, 'req-1')
        expectOk(complianceRequestIdSchema, '  trimmed-id  ')
    })

    it('rejects empty / whitespace / oversized request ids', () => {
        expectFail(complianceRequestIdSchema, '')
        expectFail(complianceRequestIdSchema, '   ')
        expectFail(complianceRequestIdSchema, 'a'.repeat(COMPLIANCE_REQUEST_ID_MAX + 1))
        expectFail(complianceRequestIdSchema, 123)
        expectFail(complianceRequestIdSchema, null)
        expectFail(complianceRequestIdSchema, undefined)
    })

    it('accepts well-formed unknown ids (service returns failure later)', () => {
        // Boundary only checks format; existence is service-owned.
        const unknown = 'manual-submit-9999999999999-notreal'
        const parsed = complianceRequestIdSchema.safeParse(unknown)
        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data).toBe(unknown)
    })
})

describe('complianceRejectReasonSchema', () => {
    it('accepts bounded reasons', () => {
        expectOk(complianceRejectReasonSchema, 'user cancelled')
        expectOk(complianceRejectReasonSchema, 'a')
        expectOk(complianceRejectReasonSchema, 'x'.repeat(COMPLIANCE_REJECT_REASON_MAX))
        expectOk(complianceRejectReasonSchema, '')
    })

    it('rejects oversized or non-string reasons', () => {
        expectFail(complianceRejectReasonSchema, 'x'.repeat(COMPLIANCE_REJECT_REASON_MAX + 1))
        expectFail(complianceRejectReasonSchema, 42)
        expectFail(complianceRejectReasonSchema, { text: 'nope' })
    })
})

describe('compliance approve/reject arg tuples', () => {
    it('approve requires a single valid requestId', () => {
        expectOk(complianceApproveArgsSchema, ['manual-submit-1-ok'])
        expectFail(complianceApproveArgsSchema, [''])
        expectFail(complianceApproveArgsSchema, [])
        expectFail(complianceApproveArgsSchema, ['id', 'extra'])
    })

    it('reject accepts optional bounded reason', () => {
        expectOk(complianceRejectArgsSchema, ['manual-submit-1-ok'])
        expectOk(complianceRejectArgsSchema, ['manual-submit-1-ok', undefined])
        expectOk(complianceRejectArgsSchema, ['manual-submit-1-ok', 'not trusted host'])
        expectFail(complianceRejectArgsSchema, [''])
        expectFail(complianceRejectArgsSchema, [
            'manual-submit-1-ok',
            'x'.repeat(COMPLIANCE_REJECT_REASON_MAX + 1),
        ])
    })
})

// ---------------------------------------------------------------------------
// Review history — campaignId / limit / filters
// ---------------------------------------------------------------------------

describe('reviewHistoryCampaignIdSchema', () => {
    it('accepts positive integer campaign ids', () => {
        expectOk(reviewHistoryCampaignIdSchema, 1)
        expectOk(reviewHistoryCampaignIdSchema, 99)
    })

    it('rejects non-positive or non-int campaign ids', () => {
        expectFail(reviewHistoryCampaignIdSchema, 0)
        expectFail(reviewHistoryCampaignIdSchema, -1)
        expectFail(reviewHistoryCampaignIdSchema, 1.5)
        expectFail(reviewHistoryCampaignIdSchema, '1')
        expectFail(reviewHistoryCampaignIdSchema, null)
        expectFail(reviewHistoryCampaignIdSchema, undefined)
    })
})

describe('reviewHistoryLimitSchema', () => {
    it('accepts bounded positive limits', () => {
        expectOk(reviewHistoryLimitSchema, 1)
        expectOk(reviewHistoryLimitSchema, 10)
        expectOk(reviewHistoryLimitSchema, REVIEW_HISTORY_LIMIT_MAX)
    })

    it('rejects out-of-range limits', () => {
        expectFail(reviewHistoryLimitSchema, 0)
        expectFail(reviewHistoryLimitSchema, -5)
        expectFail(reviewHistoryLimitSchema, REVIEW_HISTORY_LIMIT_MAX + 1)
        expectFail(reviewHistoryLimitSchema, 1.2)
        expectFail(reviewHistoryLimitSchema, '10')
    })

    it('optional limit allows undefined only', () => {
        expectOk(reviewHistoryOptionalLimitSchema, undefined)
        expectOk(reviewHistoryOptionalLimitSchema, 5)
        expectFail(reviewHistoryOptionalLimitSchema, 0)
        expectFail(reviewHistoryOptionalLimitSchema, null)
    })
})

describe('reviewHistoryFiltersSchema (strict)', () => {
    it('accepts empty and partial valid filters', () => {
        expectOk(reviewHistoryFiltersSchema, {})
        expectOk(reviewHistoryFiltersSchema, {
            campaignId: 1,
            accountId: 2,
            locationId: 3,
            status: 'success',
            dateFrom: '2026-01-01',
            dateTo: '2026-12-31T23:59:59.000Z',
            limit: 50,
        })
        expectOk(reviewHistoryFiltersSchema, { status: 'failed', limit: 1 })
    })

    it('rejects unknown keys (strict)', () => {
        expectFail(reviewHistoryFiltersSchema, { inject: true })
        expectFail(reviewHistoryFiltersSchema, { campaignId: 1, extra: 'x' })
        expectFail(reviewHistoryFiltersSchema, { orderBy: 'createdAt' })
    })

    it('rejects invalid field types / bounds', () => {
        expectFail(reviewHistoryFiltersSchema, { campaignId: 0 })
        expectFail(reviewHistoryFiltersSchema, { accountId: -1 })
        expectFail(reviewHistoryFiltersSchema, { status: 'pending' })
        expectFail(reviewHistoryFiltersSchema, { limit: 0 })
        expectFail(reviewHistoryFiltersSchema, { limit: REVIEW_HISTORY_LIMIT_MAX + 1 })
        expectFail(reviewHistoryFiltersSchema, { dateFrom: '' })
        expectFail(reviewHistoryFiltersSchema, { dateFrom: 'a'.repeat(65) })
    })

    it('optional input allows undefined (unfiltered history)', () => {
        expectOk(reviewHistoryFiltersInputSchema, undefined)
        expectOk(reviewHistoryFiltersInputSchema, { campaignId: 1 })
        expectFail(reviewHistoryFiltersInputSchema, null)
        expectFail(reviewHistoryFiltersInputSchema, { evil: 1 })
    })
})
