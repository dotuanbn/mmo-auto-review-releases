/**
 * Compliance audit IPC boundary — Zod schema unit tests.
 * Pure contracts only (no Electron / DB). Handlers use these via parseIpcPayload.
 */
import { describe, expect, it } from 'vitest'
import {
    COMPLIANCE_AUDIT_ENTITY_ID_MAX,
    COMPLIANCE_AUDIT_FIELD_MAX,
    COMPLIANCE_AUDIT_QUERY_LIMIT,
    complianceAuditGetArgsSchema,
    complianceAuditQuerySchema,
    emptyComplianceAuditListResult,
} from '../src/shared/compliance-audit-contracts'

function expectOk<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    input: unknown,
): T {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
    return result.data as T
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
}

describe('complianceAuditQuerySchema', () => {
    it('accepts empty object and full canonical filters', () => {
        expectOk(complianceAuditQuerySchema, {})
        const full = expectOk(complianceAuditQuerySchema, {
            limit: 25,
            offset: 10,
            action: 'policy_evaluate',
            entityType: 'review_submission',
            entityId: 'req-1',
            decision: 'deny',
            actor: 'system',
        })
        expect(full.limit).toBe(25)
        expect(full.offset).toBe(10)
        expect(full.action).toBe('policy_evaluate')
    })

    it('accepts UI aliases page/pageSize/targetType/targetId/outcome', () => {
        const data = expectOk(complianceAuditQuerySchema, {
            page: 2,
            pageSize: 10,
            targetType: 'campaign',
            targetId: 42,
            outcome: 'reject',
        })
        expect(data.page).toBe(2)
        expect(data.pageSize).toBe(10)
        expect(data.targetType).toBe('campaign')
        expect(data.targetId).toBe(42)
        expect(data.outcome).toBe('reject')
    })

    it('trims filter strings', () => {
        const data = expectOk(complianceAuditQuerySchema, {
            action: '  manual_submit_approve  ',
            actor: '  operator  ',
        })
        expect(data.action).toBe('manual_submit_approve')
        expect(data.actor).toBe('operator')
    })

    it('rejects unknown keys (strict)', () => {
        expectFail(complianceAuditQuerySchema, { evil: true })
        expectFail(complianceAuditQuerySchema, { limit: 10, password: 'x' })
        expectFail(complianceAuditQuerySchema, { apiKey: 'sk' })
    })

    it('rejects invalid limit / offset / page bounds', () => {
        expectFail(complianceAuditQuerySchema, { limit: 0 })
        expectFail(complianceAuditQuerySchema, { limit: COMPLIANCE_AUDIT_QUERY_LIMIT + 1 })
        expectFail(complianceAuditQuerySchema, { limit: 1.5 })
        expectFail(complianceAuditQuerySchema, { offset: -1 })
        expectFail(complianceAuditQuerySchema, { page: 0 })
        expectFail(complianceAuditQuerySchema, { pageSize: 0 })
    })

    it('rejects oversize filter fields', () => {
        expectFail(complianceAuditQuerySchema, {
            action: 'x'.repeat(COMPLIANCE_AUDIT_FIELD_MAX + 1),
        })
        expectFail(complianceAuditQuerySchema, {
            entityId: 'x'.repeat(COMPLIANCE_AUDIT_ENTITY_ID_MAX + 1),
        })
    })

    it('rejects non-object payloads', () => {
        expectFail(complianceAuditQuerySchema, null)
        expectFail(complianceAuditQuerySchema, 'policy_evaluate')
        expectFail(complianceAuditQuerySchema, 1)
        expectFail(complianceAuditQuerySchema, [])
    })
})

describe('complianceAuditGetArgsSchema', () => {
    it('allows missing query (default list)', () => {
        expectOk(complianceAuditGetArgsSchema, [undefined])
        expectOk(complianceAuditGetArgsSchema, [{}])
        expectOk(complianceAuditGetArgsSchema, [{ limit: 10, page: 1 }])
    })

    it('rejects invalid query objects and extra args', () => {
        expectFail(complianceAuditGetArgsSchema, [{ evil: true }])
        expectFail(complianceAuditGetArgsSchema, [{ limit: 10 }, 'extra'])
        expectFail(complianceAuditGetArgsSchema, [null])
        expectFail(complianceAuditGetArgsSchema, ['policy_evaluate'])
    })
})

describe('emptyComplianceAuditListResult', () => {
    it('includes hasMore false and zero total', () => {
        const empty = emptyComplianceAuditListResult(10, 0)
        expect(empty.events).toEqual([])
        expect(empty.items).toEqual([])
        expect(empty.total).toBe(0)
        expect(empty.hasMore).toBe(false)
        expect(empty.count).toBe(0)
        expect(empty.limit).toBe(10)
        expect(empty.pageSize).toBe(10)
    })
})
