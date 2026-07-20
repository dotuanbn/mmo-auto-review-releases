import { describe, expect, it } from 'vitest'
import {
    countsTowardDailyLimit,
    evaluateSubmissionGate,
    isBlockingSubmissionStatus,
    resolveCrashRiskStatus,
    resolveIntentCatchStatus,
    resolveSubmissionFinalStatus,
    retryCountForPermanentFail,
    terminalJobStatusForManualReconcile,
    type SubmissionIntentRow,
} from '../src/main/services/ReviewService'

describe('ReviewSubmissionIntent — status helpers', () => {
    it('blocks submitting and unconfirmed only', () => {
        expect(isBlockingSubmissionStatus('submitting')).toBe(true)
        expect(isBlockingSubmissionStatus('unconfirmed')).toBe(true)
        expect(isBlockingSubmissionStatus('success')).toBe(false)
        expect(isBlockingSubmissionStatus('failed')).toBe(false)
        expect(isBlockingSubmissionStatus(undefined)).toBe(false)
    })

    it('daily limit still success-only (intent statuses do not count)', () => {
        expect(countsTowardDailyLimit('success')).toBe(true)
        expect(countsTowardDailyLimit('submitting')).toBe(false)
        expect(countsTowardDailyLimit('unconfirmed')).toBe(false)
        expect(countsTowardDailyLimit('failed')).toBe(false)
    })
})

describe('ReviewSubmissionIntent — resolveSubmissionFinalStatus', () => {
    it('success → success regardless of submitAttempted', () => {
        expect(resolveSubmissionFinalStatus(true, true)).toBe('success')
        expect(resolveSubmissionFinalStatus(true, false)).toBe('success')
        expect(resolveSubmissionFinalStatus(true, undefined)).toBe('success')
    })

    it('explicit failure before submit → failed', () => {
        expect(resolveSubmissionFinalStatus(false, false)).toBe('failed')
        expect(resolveSubmissionFinalStatus(false, undefined)).toBe('failed')
    })

    it('failure after submitAttempted → unconfirmed (fail-closed)', () => {
        expect(resolveSubmissionFinalStatus(false, true)).toBe('unconfirmed')
    })
})

describe('ReviewSubmissionIntent — resolveCrashRiskStatus', () => {
    it('unknown/true after intent → unconfirmed (blocks re-post)', () => {
        expect(resolveCrashRiskStatus(undefined)).toBe('unconfirmed')
        expect(resolveCrashRiskStatus(true)).toBe('unconfirmed')
    })

    it('known pre-submit abort → failed', () => {
        expect(resolveCrashRiskStatus(false)).toBe('failed')
    })
})

describe('ReviewSubmissionIntent — pre-handler / knownPreSubmit', () => {
    it('pre-handler error after intent → failed (not unconfirmed)', () => {
        // Ollama probe / setup moved before intent; if anything still fails
        // while knownPreSubmit=true, finalize as failed (retryable), never unconfirmed.
        expect(resolveIntentCatchStatus(true, undefined)).toBe('failed')
        expect(resolveIntentCatchStatus(true, false)).toBe('failed')
        expect(resolveIntentCatchStatus(true, true)).toBe('failed')
    })

    it('handler-zone crash without submitAttempted → unconfirmed (fail-closed)', () => {
        expect(resolveIntentCatchStatus(false, undefined)).toBe('unconfirmed')
        expect(resolveIntentCatchStatus(false, true)).toBe('unconfirmed')
    })

    it('handler-zone crash with submitAttempted=false → failed', () => {
        expect(resolveIntentCatchStatus(false, false)).toBe('failed')
    })
})

describe('ReviewSubmissionIntent — manual-reconcile job terminal (no re-enqueue)', () => {
    it('uses permanent failed (not cancel) so pair stays blocked on restart', () => {
        // JobQueue BLOCKING_STATUSES = pending|running|done|failed — cancelled is NOT included.
        // cancelJob → re-enqueue churn; permanent failed + review_history gate = correct.
        expect(terminalJobStatusForManualReconcile()).toBe('failed')
        expect(String(terminalJobStatusForManualReconcile())).not.toBe('cancelled')
    })

    it('retryCountForPermanentFail forces next failJob into terminal failed', () => {
        // failJob does retryCount++ then checks retryCount < maxRetries
        expect(retryCountForPermanentFail(0, 3)).toBe(3)
        expect(retryCountForPermanentFail(2, 3)).toBe(3)
        expect(retryCountForPermanentFail(5, 3)).toBe(5)
        // After force: retryCount becomes 4, 4 < 3 → permanent failed
        const forced = retryCountForPermanentFail(0, 3)
        expect(forced + 1 < 3).toBe(false)
    })

    it('unconfirmed/submitting gate still blocks re-post (review_history)', () => {
        expect(evaluateSubmissionGate([rowLike(1, 'unconfirmed')]).action).toBe('block_manual_reconcile')
        expect(evaluateSubmissionGate([rowLike(2, 'submitting')]).action).toBe('block_manual_reconcile')
        // Early gate + permanent failed job = no browser reopen / no re-enqueue on restart
    })
})

describe('ReviewSubmissionIntent — evaluateSubmissionGate state flow', () => {
    const row = (id: number, status: string): SubmissionIntentRow => ({
        id,
        status: status as SubmissionIntentRow['status'],
    })

    it('empty → proceed (create submitting intent next)', () => {
        expect(evaluateSubmissionGate([])).toEqual({ action: 'proceed' })
    })

    it('failed history does not block (proceed)', () => {
        // Gate rows should only include success|submitting|unconfirmed in service query;
        // pure evaluator still ignores non-blocking statuses if present.
        expect(evaluateSubmissionGate([row(1, 'failed')])).toEqual({ action: 'proceed' })
    })

    it('existing success → idempotent_complete', () => {
        const d = evaluateSubmissionGate([row(9, 'success')])
        expect(d.action).toBe('idempotent_complete')
        expect(d.intentId).toBe(9)
        expect(d.status).toBe('success')
    })

    it('success wins over older submitting/unconfirmed', () => {
        const d = evaluateSubmissionGate([
            row(1, 'submitting'),
            row(2, 'success'),
            row(3, 'unconfirmed'),
        ])
        expect(d.action).toBe('idempotent_complete')
        expect(d.intentId).toBe(2)
    })

    it('submitting leftover (crash after Google accept) → block_manual_reconcile no retry', () => {
        const d = evaluateSubmissionGate([row(4, 'submitting')])
        expect(d.action).toBe('block_manual_reconcile')
        expect(d.status).toBe('submitting')
        expect(d.intentId).toBe(4)
        expect(d.reason).toMatch(/Manual reconciliation/i)
        expect(d.reason).toMatch(/re-post blocked/i)
    })

    it('unconfirmed after submitAttempted → block_manual_reconcile', () => {
        const d = evaluateSubmissionGate([row(5, 'unconfirmed')])
        expect(d.action).toBe('block_manual_reconcile')
        expect(d.status).toBe('unconfirmed')
        expect(d.intentId).toBe(5)
        expect(d.reason).toMatch(/unconfirmed/i)
    })
})

describe('ReviewSubmissionIntent — lifecycle contract (documentation as tests)', () => {
    it('state flow: none → submitting → success|failed|unconfirmed', () => {
        // 1) Gate proceed
        expect(evaluateSubmissionGate([]).action).toBe('proceed')
        // 2) beginSubmissionIntent writes submitting — now blocks
        expect(evaluateSubmissionGate([rowLike(1, 'submitting')]).action).toBe('block_manual_reconcile')
        // 3a) success finalize
        expect(resolveSubmissionFinalStatus(true, true)).toBe('success')
        expect(evaluateSubmissionGate([rowLike(1, 'success')]).action).toBe('idempotent_complete')
        // 3b) pre-submit fail
        expect(resolveSubmissionFinalStatus(false, false)).toBe('failed')
        // 3c) post-submit fail / crash
        expect(resolveSubmissionFinalStatus(false, true)).toBe('unconfirmed')
        expect(resolveCrashRiskStatus(undefined)).toBe('unconfirmed')
    })
})

function rowLike(id: number, status: string): SubmissionIntentRow {
    return { id, status: status as SubmissionIntentRow['status'] }
}
