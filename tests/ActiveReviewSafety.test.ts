import { describe, expect, it } from 'vitest'
import {
    countsTowardDailyLimit,
    evaluateSubmissionGate,
    isBlockingSubmissionStatus,
    isSuccessfulReviewPair,
    resolveIntentCatchStatus,
    resolveSubmissionFinalStatus,
    retryCountForPermanentFail,
    shouldUseAgenticReview,
    terminalJobStatusForManualReconcile,
} from '../src/main/services/ReviewService'

describe('ActiveReviewSafety — agentic gate', () => {
    it('requires enableAgenticReview=true, ollama up, and photos off', () => {
        expect(
            shouldUseAgenticReview(
                { enableAgenticReview: true, includePhotos: false },
                true,
            ),
        ).toBe(true)
    })

    it('disables agentic when setting is not explicitly true', () => {
        expect(
            shouldUseAgenticReview(
                { enableAgenticReview: false, includePhotos: false },
                true,
            ),
        ).toBe(false)
        expect(
            shouldUseAgenticReview(
                { includePhotos: false },
                true,
            ),
        ).toBe(false)
        expect(
            shouldUseAgenticReview(
                { enableAgenticReview: 'true', includePhotos: false },
                true,
            ),
        ).toBe(false)
    })

    it('forces linear when includePhotos is true', () => {
        expect(
            shouldUseAgenticReview(
                { enableAgenticReview: true, includePhotos: true },
                true,
            ),
        ).toBe(false)
    })

    it('forces linear when Ollama is unavailable', () => {
        expect(
            shouldUseAgenticReview(
                { enableAgenticReview: true, includePhotos: false },
                false,
            ),
        ).toBe(false)
    })
})

describe('ActiveReviewSafety — daily limit / content history success-only', () => {
    it('counts only status=success toward daily limit', () => {
        expect(countsTowardDailyLimit('success')).toBe(true)
        expect(countsTowardDailyLimit('failed')).toBe(false)
        expect(countsTowardDailyLimit(undefined)).toBe(false)
        expect(countsTowardDailyLimit(null)).toBe(false)
        expect(countsTowardDailyLimit('pending')).toBe(false)
        // Intent statuses must not consume daily budget
        expect(countsTowardDailyLimit('submitting')).toBe(false)
        expect(countsTowardDailyLimit('unconfirmed')).toBe(false)
    })
})

describe('ActiveReviewSafety — submit intent fail-closed', () => {
    it('submitting/unconfirmed block re-post; success is idempotent', () => {
        expect(isBlockingSubmissionStatus('submitting')).toBe(true)
        expect(isBlockingSubmissionStatus('unconfirmed')).toBe(true)

        expect(evaluateSubmissionGate([{ id: 1, status: 'success' }]).action).toBe('idempotent_complete')
        expect(evaluateSubmissionGate([{ id: 2, status: 'submitting' }]).action).toBe('block_manual_reconcile')
        expect(evaluateSubmissionGate([{ id: 3, status: 'unconfirmed' }]).action).toBe('block_manual_reconcile')
    })

    it('maps submitAttempted into final history status', () => {
        expect(resolveSubmissionFinalStatus(true, true)).toBe('success')
        expect(resolveSubmissionFinalStatus(false, false)).toBe('failed')
        expect(resolveSubmissionFinalStatus(false, true)).toBe('unconfirmed')
    })

    it('pre-handler (knownPreSubmit) error finalizes failed — not unconfirmed', () => {
        // Controller: Ollama probe before beginSubmissionIntent; knownPreSubmit until handler zone
        expect(resolveIntentCatchStatus(true, undefined)).toBe('failed')
        expect(resolveIntentCatchStatus(false, undefined)).toBe('unconfirmed')
    })

    it('unconfirmed restart: permanent failed job terminal (no cancel re-enqueue)', () => {
        // Early gate blocks before browser; job → permanent failed (BLOCKING_STATUSES)
        expect(terminalJobStatusForManualReconcile()).toBe('failed')
        expect(retryCountForPermanentFail(0, 3)).toBe(3)
        expect(evaluateSubmissionGate([{ id: 9, status: 'unconfirmed' }]).action)
            .toBe('block_manual_reconcile')
    })
})

describe('ActiveReviewSafety — idempotency pair matching', () => {
    const base = {
        accountId: 10,
        locationId: 20,
        campaignId: 5,
        status: 'success' as const,
    }

    it('matches success for same campaign/account/location', () => {
        expect(isSuccessfulReviewPair(base, 5, 10, 20)).toBe(true)
    })

    it('rejects failed status', () => {
        expect(
            isSuccessfulReviewPair({ ...base, status: 'failed' }, 5, 10, 20),
        ).toBe(false)
    })

    it('rejects different account or location', () => {
        expect(isSuccessfulReviewPair(base, 5, 99, 20)).toBe(false)
        expect(isSuccessfulReviewPair(base, 5, 10, 99)).toBe(false)
    })

    it('rejects different campaign when campaignId is provided', () => {
        expect(isSuccessfulReviewPair(base, 7, 10, 20)).toBe(false)
    })

    it('matches account+location when campaignId filter is null', () => {
        expect(isSuccessfulReviewPair(base, null, 10, 20)).toBe(true)
        expect(isSuccessfulReviewPair(base, undefined, 10, 20)).toBe(true)
    })
})
