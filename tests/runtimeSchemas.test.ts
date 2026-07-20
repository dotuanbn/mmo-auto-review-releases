import { describe, expect, it } from 'vitest'
import {
    ragClearScopeSchema,
    reportActionTraceQuerySchema,
    runtimeActionEventSchema,
    runtimePolicyPatchSchema,
} from '../src/main/runtime/v2/schemas'

describe('runtimePolicyPatchSchema', () => {
    it('accepts empty patch', () => {
        const result = runtimePolicyPatchSchema.safeParse({})
        expect(result.success).toBe(true)
    })

    it('accepts a valid partial policy patch', () => {
        const result = runtimePolicyPatchSchema.safeParse({
            captchaMode: 'hybrid',
            queueConcurrency: 4,
            ragEnabled: true,
            ragMinScore: 0.25,
            logLevel: 'warn',
        })
        expect(result.success).toBe(true)
    })

    it('rejects out-of-range numbers', () => {
        const cases = [
            { queueConcurrency: 0 },
            { queueConcurrency: 99 },
            { captchaManualWaitSeconds: 10 },
            { ragMinScore: 1.5 },
            { ragTopK: 0 },
        ]
        for (const input of cases) {
            expect(runtimePolicyPatchSchema.safeParse(input).success, JSON.stringify(input)).toBe(false)
        }
    })

    it('rejects invalid enums', () => {
        expect(runtimePolicyPatchSchema.safeParse({ captchaMode: 'always' }).success).toBe(false)
        expect(runtimePolicyPatchSchema.safeParse({ logLevel: 'trace' }).success).toBe(false)
        expect(runtimePolicyPatchSchema.safeParse({ ragWriteMode: 'maybe' }).success).toBe(false)
    })
})

describe('runtimeActionEventSchema', () => {
    const validEvent = {
        eventId: 'evt-1',
        campaignId: 1,
        campaignName: 'Maps KPI',
        round: 0,
        threadId: 0,
        accountEmail: 'user@example.com',
        locationName: 'Cafe A',
        action: 'click',
        source: 'heuristic',
        success: true,
        timestamp: '2026-06-01T00:00:00.000Z',
    }

    it('accepts a minimal valid action event', () => {
        const result = runtimeActionEventSchema.safeParse(validEvent)
        expect(result.success).toBe(true)
    })

    it('accepts null campaignId', () => {
        const result = runtimeActionEventSchema.safeParse({
            ...validEvent,
            campaignId: null,
        })
        expect(result.success).toBe(true)
    })

    it('accepts optional observability fields', () => {
        const result = runtimeActionEventSchema.safeParse({
            ...validEvent,
            detail: 'clicked directions',
            durationMs: 1200,
            decisionSource: 'llm+rag',
            ragUsed: true,
            ragHitCount: 2,
            ragEvidenceIds: [1, 2],
        })
        expect(result.success).toBe(true)
    })

    it('rejects missing required fields', () => {
        const { eventId: _eventId, ...withoutId } = validEvent
        expect(runtimeActionEventSchema.safeParse(withoutId).success).toBe(false)
        expect(runtimeActionEventSchema.safeParse({ ...validEvent, action: '' }).success).toBe(false)
        expect(runtimeActionEventSchema.safeParse({ ...validEvent, decisionSource: 'random' }).success).toBe(false)
    })
})

describe('reportActionTraceQuerySchema', () => {
    it('accepts empty query', () => {
        expect(reportActionTraceQuerySchema.safeParse({}).success).toBe(true)
    })

    it('accepts valid limit and campaignId', () => {
        expect(
            reportActionTraceQuerySchema.safeParse({ campaignId: 3, limit: 100 }).success
        ).toBe(true)
    })

    it('rejects invalid limit bounds', () => {
        expect(reportActionTraceQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
        expect(reportActionTraceQuerySchema.safeParse({ limit: 5001 }).success).toBe(false)
        expect(reportActionTraceQuerySchema.safeParse({ campaignId: 0 }).success).toBe(false)
    })
})

describe('ragClearScopeSchema', () => {
    it('allows undefined (optional schema)', () => {
        expect(ragClearScopeSchema.safeParse(undefined).success).toBe(true)
    })

    it('accepts scoped clear payloads', () => {
        expect(
            ragClearScopeSchema.safeParse({ campaignId: 1, domain: 'maps', riskType: 'captcha' }).success
        ).toBe(true)
    })

    it('rejects empty domain/riskType strings', () => {
        expect(ragClearScopeSchema.safeParse({ domain: '' }).success).toBe(false)
        expect(ragClearScopeSchema.safeParse({ riskType: '' }).success).toBe(false)
    })
})
