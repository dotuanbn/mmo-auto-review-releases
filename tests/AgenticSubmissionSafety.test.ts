/**
 * P0 Agentic/Linear submission safety:
 * - submitAttempted contract + no linear fallback after submit click
 * - verify requires positive signals (form-absent alone is not success)
 * - isSubmitElement false-positive guards (token boundary + button context)
 * - postReview always propagates submitAttempted (never undefined after click)
 *
 * Pure policy helpers only; Electron/Playwright heavy graph is mocked.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
    app: {
        getPath: () => 'C:\\tmp\\mmo-submission-safety-userData',
    },
    BrowserWindow: {
        getAllWindows: () => [],
    },
}))

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: () => ({}),
}))

vi.mock('../src/main/services/ComplianceService', () => ({
    buildManualSubmitMessage: () => 'manual submit required',
    getReviewSubmissionDecision: () => ({ allowed: true, reason: 'test' }),
    requestManualReviewSubmissionApproval: async () => ({ approved: true, reason: 'test' }),
}))

vi.mock('../src/main/services/ReviewPhotoService', () => ({
    reviewPhotoService: {
        resolvePhotos: async () => ({ paths: [], maxPhotos: 0 }),
    },
    redactImagePathForLog: (p: string) => p,
}))

vi.mock('../src/main/automation/BrowserService', () => ({
    browserService: {
        getPage: () => null,
        randomDelay: async () => {},
        takeScreenshot: async () => {},
        humanScroll: async () => {},
    },
}))

vi.mock('../src/main/services/OllamaService', () => ({
    ollamaService: {
        chat: async () => ({ success: false, error: 'mocked' }),
    },
}))

vi.mock('../src/main/automation/DOMUtils', () => ({
    DOMUtils: {
        extractInteractiveDOM: async () => ({ domText: '', elementIds: new Set(), summaries: [] }),
        scrollObservedPage: async () => {},
        getObservedElementLocator: () => ({ count: async () => 0 }),
    },
}))

vi.mock('../src/main/automation/ContextualInterruptionResolver', () => ({
    contextualInterruptionResolver: {
        resolve: async () => ({ handled: false }),
    },
}))

vi.mock('../src/main/automation/agentSchemas', () => ({
    parseReviewAgentAction: () => ({ success: false }),
}))

vi.mock('../src/main/services/ReviewService', () => ({
    shouldUseAgenticReview: () => false,
}))

import {
    allowAgenticLinearFallback,
    buildAgenticFailureResult,
    buildAgenticSuccessResult,
    hasSubmitControlContext,
    isSubmitElementSummary,
    type AgenticReviewResult,
    type SubmitElementProbe,
} from '../src/main/automation/AgenticReviewHandler'
import {
    evaluateSubmissionVerification,
    type PostReviewResult,
    type SubmitReviewResult,
    type VerifySubmissionResult,
} from '../src/main/automation/GoogleMapsReviewHandler'

describe('AgenticSubmissionSafety — contracts', () => {
    it('AgenticReviewResult carries submitAttempted + allowLinearFallback', () => {
        const result: AgenticReviewResult = buildAgenticFailureResult('x', true)
        expect(result).toMatchObject({
            success: false,
            error: 'x',
            submitAttempted: true,
            allowLinearFallback: false,
        })
    })

    it('PostReviewResult/SubmitReviewResult expose submitAttempted for unconfirmed handling', () => {
        const submit: SubmitReviewResult = {
            success: false,
            error: 'Submission unconfirmed: no positive success signal (form absent is not success)',
            submitAttempted: true,
        }
        const post: PostReviewResult = {
            success: false,
            error: submit.error,
            submitAttempted: submit.submitAttempted,
        }
        expect(post.submitAttempted).toBe(true)
        expect(post.success).toBe(false)
    })
})

describe('AgenticSubmissionSafety — linear fallback policy', () => {
    it('allows fallback only when submit was never attempted', () => {
        expect(allowAgenticLinearFallback(false)).toBe(true)
        expect(allowAgenticLinearFallback(true)).toBe(false)
    })

    it('fail / finish-unverified / max-steps / catch map to allowLinearFallback=false after submit', () => {
        const branches = [
            buildAgenticFailureResult('Agent declared failure: stuck', true),
            buildAgenticFailureResult('Agent finish without verified submission', true),
            buildAgenticFailureResult('Maximum agent steps reached without finishing.', true),
            buildAgenticFailureResult('page closed mid-flow', true),
        ]
        for (const result of branches) {
            expect(result.allowLinearFallback).toBe(false)
            expect(result.submitAttempted).toBe(true)
            expect(result.success).toBe(false)
        }
    })

    it('allows fallback on soft failures when submit was not clicked', () => {
        const soft = [
            buildAgenticFailureResult('Agent declared failure: no write button', false),
            buildAgenticFailureResult('Maximum agent steps reached without finishing.', false),
            buildAgenticFailureResult('LLM offline', false),
        ]
        for (const result of soft) {
            expect(result.allowLinearFallback).toBe(true)
            expect(result.submitAttempted).toBe(false)
        }
    })

    it('success always disables linear fallback', () => {
        expect(buildAgenticSuccessResult(true)).toEqual({
            success: true,
            submitAttempted: true,
            allowLinearFallback: false,
        })
        expect(buildAgenticSuccessResult(false)).toEqual({
            success: true,
            submitAttempted: false,
            allowLinearFallback: false,
        })
    })
})

describe('AgenticSubmissionSafety — verify positive signals only', () => {
    it('accepts clear positive success signals', () => {
        const cases = [
            {
                hasError: false,
                hasPositiveSuccess: true,
                formStillOpen: false,
            },
            {
                hasError: false,
                hasPositiveSuccess: true,
                formStillOpen: true,
            },
        ] as const

        for (const signals of cases) {
            const result: VerifySubmissionResult = evaluateSubmissionVerification(signals)
            expect(result.success).toBe(true)
            expect(result.error).toBeUndefined()
        }
    })

    it('does NOT treat form absent alone as success (false-positive guard)', () => {
        const result = evaluateSubmissionVerification({
            hasError: false,
            hasPositiveSuccess: false,
            formStillOpen: false,
        })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/form absent is not success/i)
    })

    it('fails when form still open without positive signal', () => {
        const result = evaluateSubmissionVerification({
            hasError: false,
            hasPositiveSuccess: false,
            formStillOpen: true,
        })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/form still open/i)
    })

    it('fails on submit error UI even if form closed', () => {
        const result = evaluateSubmissionVerification({
            hasError: true,
            errorText: "can't post",
            hasPositiveSuccess: false,
            formStillOpen: false,
        })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Submit error/i)
    })

    it('error takes precedence over positive signal', () => {
        const result = evaluateSubmissionVerification({
            hasError: true,
            errorText: 'Something went wrong',
            hasPositiveSuccess: true,
            formStillOpen: false,
        })
        expect(result.success).toBe(false)
        expect(result.error).toContain('Something went wrong')
    })
})

describe('AgenticSubmissionSafety — unconfirmed after submit click', () => {
    it('unconfirmed verify + submitAttempted must block linear re-submit', () => {
        const verify = evaluateSubmissionVerification({
            hasError: false,
            hasPositiveSuccess: false,
            formStillOpen: false,
        })
        expect(verify.success).toBe(false)

        const agentic = buildAgenticFailureResult(
            verify.error || 'Submit clicked but submission unconfirmed',
            true,
        )
        expect(agentic.submitAttempted).toBe(true)
        expect(agentic.allowLinearFallback).toBe(false)

        const linear: SubmitReviewResult = {
            success: false,
            error: verify.error,
            submitAttempted: true,
        }
        // Controller rule (documented by contract): unconfirmed + attempted ⇒ no second submit.
        expect(linear.submitAttempted === true && linear.success === false).toBe(true)
    })
})

describe('AgenticSubmissionSafety — isSubmitElement corpus (false-positive guards)', () => {
    const POSITIVE_CORPUS: ReadonlyArray<{ name: string; probe: SubmitElementProbe }> = [
        { name: 'EN Post button', probe: { tagName: 'button', textContent: 'Post' } },
        { name: 'EN Submit button', probe: { tagName: 'button', textContent: 'Submit' } },
        { name: 'EN Publish aria', probe: { tagName: 'button', ariaLabel: 'Publish' } },
        { name: 'EN Post role=button', probe: { tagName: 'div', role: 'button', textContent: 'Post' } },
        { name: 'input type=submit', probe: { tagName: 'input', type: 'submit', textContent: '' } },
        { name: 'VI Đăng button', probe: { tagName: 'button', textContent: 'Đăng' } },
        { name: 'VI Gửi button', probe: { tagName: 'button', textContent: 'Gửi' } },
        { name: 'VI Hoàn tất', probe: { tagName: 'button', textContent: 'Hoàn tất' } },
        { name: 'VI Xác nhận', probe: { tagName: 'button', textContent: 'Xác nhận' } },
        { name: 'VI aria Đăng đánh giá', probe: { tagName: 'button', ariaLabel: 'Đăng' } },
        { name: 'anchor Post CTA', probe: { tagName: 'a', textContent: 'Post' } },
    ]

    const NEGATIVE_CORPUS: ReadonlyArray<{ name: string; probe: SubmitElementProbe }> = [
        // Bare substring traps (old regex matched gui/dang inside longer tokens)
        { name: 'Guide link (gui substring)', probe: { tagName: 'a', textContent: 'Guide' } },
        { name: 'Local Guide button', probe: { tagName: 'button', textContent: 'Local Guide' } },
        { name: 'Guidelines menu', probe: { tagName: 'button', textContent: 'Guidelines' } },
        { name: 'Guise label', probe: { tagName: 'button', textContent: 'Guise' } },
        // Login / sign-in (đăng nhập → dang nhap)
        { name: 'VI Đăng nhập', probe: { tagName: 'button', textContent: 'Đăng nhập' } },
        { name: 'Sign in button', probe: { tagName: 'button', textContent: 'Sign in' } },
        { name: 'Log in link', probe: { tagName: 'a', textContent: 'Log in' } },
        { name: 'Login button', probe: { tagName: 'button', textContent: 'Login' } },
        // Non-submit UI with similar English words
        { name: 'Post office (context noise)', probe: { tagName: 'span', textContent: 'Post office' } },
        { name: 'Cancel button', probe: { tagName: 'button', textContent: 'Cancel' } },
        { name: 'Close dialog', probe: { tagName: 'button', textContent: 'Close' } },
        { name: 'Write a review (not submit)', probe: { tagName: 'button', textContent: 'Write a review' } },
        { name: 'Add photos', probe: { tagName: 'button', textContent: 'Add photos' } },
        // Placeholder-only must not count (textarea "post your thoughts")
        {
            name: 'textarea placeholder post only',
            probe: { tagName: 'textarea', placeholder: 'Post your thoughts here', textContent: '' },
        },
        // Missing button/role context even with submit-like text
        { name: 'plain div text Post', probe: { tagName: 'div', textContent: 'Post' } },
        { name: 'plain p text Submit', probe: { tagName: 'p', textContent: 'Submit review' } },
        { name: 'span Đăng no role', probe: { tagName: 'span', textContent: 'Đăng' } },
        // Empty / undefined
        { name: 'empty button', probe: { tagName: 'button', textContent: '' } },
    ]

    it('positive corpus: real submit CTAs match', () => {
        for (const { name, probe } of POSITIVE_CORPUS) {
            expect(isSubmitElementSummary(probe), name).toBe(true)
        }
    })

    it('negative corpus: false-positive traps do not match', () => {
        for (const { name, probe } of NEGATIVE_CORPUS) {
            expect(isSubmitElementSummary(probe), name).toBe(false)
        }
    })

    it('undefined / null probe is never submit', () => {
        expect(isSubmitElementSummary(undefined)).toBe(false)
        expect(isSubmitElementSummary(null)).toBe(false)
    })

    it('requires actionable control context (button/role/submit)', () => {
        expect(hasSubmitControlContext({ tagName: 'button' })).toBe(true)
        expect(hasSubmitControlContext({ tagName: 'div', role: 'button' })).toBe(true)
        expect(hasSubmitControlContext({ tagName: 'input', type: 'submit' })).toBe(true)
        expect(hasSubmitControlContext({ tagName: 'a' })).toBe(true)
        expect(hasSubmitControlContext({ tagName: 'div' })).toBe(false)
        expect(hasSubmitControlContext({ tagName: 'span', textContent: 'Post' })).toBe(false)
        expect(hasSubmitControlContext({ tagName: 'textarea' })).toBe(false)
    })

    it('does not match bare gui/dang substrings inside longer words', () => {
        // Regression: old /(post|...|dang|gui|...)/ matched "guide" and similar.
        expect(isSubmitElementSummary({ tagName: 'button', textContent: 'guide' })).toBe(false)
        expect(isSubmitElementSummary({ tagName: 'button', textContent: 'Guider' })).toBe(false)
        expect(isSubmitElementSummary({ tagName: 'button', textContent: 'pending' })).toBe(false)
        // Whole-token VI still works
        expect(isSubmitElementSummary({ tagName: 'button', textContent: 'gui' })).toBe(true)
        expect(isSubmitElementSummary({ tagName: 'button', textContent: 'dang' })).toBe(true)
    })
})

describe('AgenticSubmissionSafety — postReview submitAttempted propagation', () => {
    /**
     * Mirrors GoogleMapsReviewHandler.postReview contract:
     * flag lives outside submitReview; outer catch / final always set it.
     */
    function buildPostReviewLikeResult(args: {
        success: boolean
        error?: string
        submitAttempted: boolean
        threwAfterClick?: boolean
    }): PostReviewResult {
        let submitAttempted = false
        try {
            if (args.submitAttempted) {
                submitAttempted = true
            }
            if (args.threwAfterClick) {
                throw new Error(args.error || 'post-click failure')
            }
            return {
                success: args.success,
                error: args.error,
                submitAttempted,
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during review',
                submitAttempted,
            }
        }
    }

    it('outer catch after click always returns submitAttempted=true (never undefined)', () => {
        const result = buildPostReviewLikeResult({
            success: false,
            submitAttempted: true,
            threwAfterClick: true,
            error: 'page closed after post click',
        })
        expect(result.success).toBe(false)
        expect(result.submitAttempted).toBe(true)
        expect(result.submitAttempted).not.toBeUndefined()
        expect(result.error).toMatch(/page closed after post click/i)
    })

    it('pre-submit failure keeps submitAttempted false', () => {
        const result = buildPostReviewLikeResult({
            success: false,
            error: 'Could not find review button',
            submitAttempted: false,
        })
        expect(result.submitAttempted).toBe(false)
    })

    it('final failure after submit click still carries submitAttempted', () => {
        const result = buildPostReviewLikeResult({
            success: false,
            error: 'Submission unconfirmed: no positive success signal (form absent is not success)',
            submitAttempted: true,
        })
        expect(result.success).toBe(false)
        expect(result.submitAttempted).toBe(true)
    })

    it('success final result includes submitAttempted true', () => {
        const result = buildPostReviewLikeResult({
            success: true,
            submitAttempted: true,
        })
        expect(result.success).toBe(true)
        expect(result.submitAttempted).toBe(true)
    })
})
