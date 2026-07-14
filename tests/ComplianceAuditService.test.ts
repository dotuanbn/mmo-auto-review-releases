/**
 * ComplianceAuditService unit tests — memory repository (no native SQLite).
 * Covers append-only record, bounded query, metadata sanitization (no secrets).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMPLIANCE_AUDIT_DEFAULT_LIMIT,
  COMPLIANCE_AUDIT_FIELD_MAX,
  COMPLIANCE_AUDIT_QUERY_LIMIT,
  COMPLIANCE_AUDIT_REASON_MAX,
} from '../src/shared/compliance-audit-contracts'
import {
  ComplianceAuditService,
  clampAuditLimit,
  clampAuditOffset,
  createMemoryComplianceAuditRepository,
  normalizeAuditField,
  normalizeAuditReason,
  normalizeRecordInput,
  parseAuditMetadata,
  recordComplianceAudit,
  resolveListBounds,
  sanitizeAuditMetadata,
  serializeAuditMetadata,
  toPublicAuditEvent,
  type ComplianceAuditRepository,
  type ComplianceAuditRowView,
} from '../src/main/services/ComplianceAuditService'

function makeService(repo?: ComplianceAuditRepository): ComplianceAuditService {
  return new ComplianceAuditService(repo ?? createMemoryComplianceAuditRepository())
}

describe('normalize / clamp helpers', () => {
  it('clamps query limit to [1, QUERY_LIMIT] with default', () => {
    expect(clampAuditLimit(undefined)).toBe(COMPLIANCE_AUDIT_DEFAULT_LIMIT)
    expect(clampAuditLimit(0)).toBe(1)
    expect(clampAuditLimit(-5)).toBe(1)
    expect(clampAuditLimit(10)).toBe(10)
    expect(clampAuditLimit(COMPLIANCE_AUDIT_QUERY_LIMIT + 500)).toBe(
      COMPLIANCE_AUDIT_QUERY_LIMIT
    )
  })

  it('clamps offset to non-negative integer', () => {
    expect(clampAuditOffset(undefined)).toBe(0)
    expect(clampAuditOffset(-1)).toBe(0)
    expect(clampAuditOffset(12.9)).toBe(12)
  })

  it('normalizes fields and redacts secret-looking content', () => {
    expect(normalizeAuditField('  manual_submit_approve  ')).toBe('manual_submit_approve')
    expect(normalizeAuditField('')).toBe('unknown')
    expect(normalizeAuditField('api_key=abc')).toBe('redacted')
    expect(normalizeAuditField('x'.repeat(COMPLIANCE_AUDIT_FIELD_MAX + 40)).length).toBe(
      COMPLIANCE_AUDIT_FIELD_MAX
    )
  })

  it('normalizes reason and bounds length', () => {
    expect(normalizeAuditReason(null)).toBeNull()
    expect(normalizeAuditReason('  ok  ')).toBe('ok')
    expect(normalizeAuditReason('password=secret')).toBe('redacted')
    expect(normalizeAuditReason('r'.repeat(COMPLIANCE_AUDIT_REASON_MAX + 20))?.length).toBe(
      COMPLIANCE_AUDIT_REASON_MAX
    )
  })
})

describe('sanitizeAuditMetadata (no secrets)', () => {
  it('returns null for empty/non-object input', () => {
    expect(sanitizeAuditMetadata(null)).toBeNull()
    expect(sanitizeAuditMetadata(undefined)).toBeNull()
  })

  it('redacts secret keys and secret-looking values', () => {
    const cleaned = sanitizeAuditMetadata({
      host: 'maps.example.com',
      apiKey: 'sk-live-xxx',
      password: 'hunter2',
      token: 'abc',
      note: 'token=leaked-value',
      nested: {
        cookie: 'sid=1',
        safe: true,
      },
    })

    expect(cleaned).not.toBeNull()
    expect(cleaned!.host).toBe('maps.example.com')
    expect(cleaned!.apiKey).toBe('[redacted]')
    expect(cleaned!.password).toBe('[redacted]')
    expect(cleaned!.token).toBe('[redacted]')
    expect(cleaned!.note).toBe('[redacted]')
    expect((cleaned!.nested as Record<string, unknown>).cookie).toBe('[redacted]')
    expect((cleaned!.nested as Record<string, unknown>).safe).toBe(true)
  })

  it('serializes and re-parses metadata safely', () => {
    const meta = sanitizeAuditMetadata({ campaignId: 7, decisionSource: 'policy' })
    const json = serializeAuditMetadata(meta)
    expect(json).toContain('campaignId')
    const parsed = parseAuditMetadata(json)
    expect(parsed).toEqual({ campaignId: 7, decisionSource: 'policy' })
  })

  it('re-sanitizes on parse so stored secrets never reach public API', () => {
    const leaked = parseAuditMetadata(
      JSON.stringify({ ok: true, secret: 'should-not-leak', api_key: 'x' })
    )
    expect(leaked).not.toBeNull()
    expect(leaked!.ok).toBe(true)
    expect(leaked!.secret).toBe('[redacted]')
    expect(leaked!.api_key).toBe('[redacted]')
  })
})

describe('toPublicAuditEvent', () => {
  it('maps row view to public event with ISO timestamp', () => {
    const row: ComplianceAuditRowView = {
      id: 3,
      action: 'manual_submit_approve',
      entityType: 'review_submission',
      entityId: 'req-1',
      actor: 'operator',
      decision: 'approve',
      reason: 'looks good',
      metadata: JSON.stringify({ score: 1 }),
      createdAt: new Date('2026-07-14T12:00:00.000Z'),
    }
    const event = toPublicAuditEvent(row)
    expect(event.id).toBe(3)
    expect(event.createdAt).toBe('2026-07-14T12:00:00.000Z')
    expect(event.metadata).toEqual({ score: 1 })
  })
})

describe('normalizeRecordInput bridges', () => {
  it('accepts strict record input', () => {
    const n = normalizeRecordInput({
      action: 'policy_evaluate',
      entityType: 'campaign',
      entityId: '9',
      actor: 'system',
      decision: 'deny',
      reason: 'blocked',
    })
    expect(n).toMatchObject({
      action: 'policy_evaluate',
      entityType: 'campaign',
      entityId: '9',
      decision: 'deny',
    })
  })

  it('maps BackupRestoreService events', () => {
    const n = normalizeRecordInput({
      action: 'backup.create',
      backupId: 'bk-1',
      success: true,
      message: 'ok',
      includeProfiles: false,
    })
    expect(n).toMatchObject({
      action: 'backup.create',
      entityType: 'backup',
      entityId: 'bk-1',
      actor: 'system',
      decision: 'success',
      reason: 'ok',
    })
  })

  it('maps ReviewService reconcile events', () => {
    const n = normalizeRecordInput({
      action: 'reconcile_review_intent',
      historyId: 42,
      outcome: 'success',
      previousStatus: 'unconfirmed',
      newStatus: 'success',
      note: 'operator confirmed',
    })
    expect(n).toMatchObject({
      action: 'reconcile_review_intent',
      entityType: 'review_history',
      entityId: '42',
      actor: 'operator',
      decision: 'success',
      reason: 'operator confirmed',
    })
  })
})

describe('ComplianceAuditService append-only record', () => {
  let service: ComplianceAuditService

  beforeEach(() => {
    service = makeService()
  })

  it('records an event and returns sanitized public DTO', () => {
    const event = service.record({
      action: 'manual_submit_approve',
      entityType: 'review_submission',
      entityId: 'manual-submit-1',
      actor: 'operator',
      decision: 'approve',
      reason: 'verified',
      metadata: { host: 'example.com', password: 'nope' },
    })

    expect(event).not.toBeNull()
    expect(event!.action).toBe('manual_submit_approve')
    expect(event!.entityId).toBe('manual-submit-1')
    expect(event!.decision).toBe('approve')
    expect(event!.metadata).toEqual({ host: 'example.com', password: '[redacted]' })
    expect(event!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is append-only: multiple records accumulate and never overwrite', () => {
    service.record({
      action: 'policy_evaluate',
      entityType: 'review_submission',
      entityId: 'a',
      actor: 'system',
      decision: 'deny',
    })
    service.record({
      action: 'manual_submit_approve',
      entityType: 'review_submission',
      entityId: 'a',
      actor: 'operator',
      decision: 'approve',
    })

    const page = service.listEvents({ limit: 10 })
    expect(page.count).toBe(2)
    expect(page.events.map((e) => e.decision)).toEqual(['approve', 'deny'])
    // Distinct ids — append, not upsert
    expect(page.events[0].id).not.toBe(page.events[1].id)
    // UI projection present
    expect(page.items).toHaveLength(2)
    expect(page.items[0].targetType).toBe('review_submission')
    expect(page.items[0].outcome).toBe('approve')
  })

  it('records backup bridge payload via module helper', () => {
    // Bind helper to in-memory service for isolation
    const mem = createMemoryComplianceAuditRepository()
    const svc = new ComplianceAuditService(mem)
    const event = svc.record({
      action: 'backup.restore',
      backupId: 'b2',
      success: false,
      message: 'integrity failed',
    })
    expect(event?.decision).toBe('failure')
    expect(event?.entityType).toBe('backup')
    // Exported helper uses singleton; just ensure it is a function
    expect(typeof recordComplianceAudit).toBe('function')
  })
})

describe('ComplianceAuditService bounded public query', () => {
  let service: ComplianceAuditService

  beforeEach(() => {
    service = makeService()
    for (let i = 0; i < 30; i += 1) {
      service.record({
        action: i % 2 === 0 ? 'policy_evaluate' : 'manual_submit_reject',
        entityType: 'review_submission',
        entityId: `req-${i}`,
        actor: i % 3 === 0 ? 'system' : 'operator',
        decision: i % 2 === 0 ? 'deny' : 'reject',
        reason: `r-${i}`,
      })
    }
  })

  it('bounds limit to COMPLIANCE_AUDIT_QUERY_LIMIT', () => {
    const page = service.listEvents({ limit: 10_000 })
    expect(page.limit).toBe(COMPLIANCE_AUDIT_QUERY_LIMIT)
    expect(page.events.length).toBeLessThanOrEqual(COMPLIANCE_AUDIT_QUERY_LIMIT)
    expect(page.count).toBe(page.events.length)
  })

  it('uses default limit when omitted', () => {
    const page = service.listEvents()
    expect(page.limit).toBe(COMPLIANCE_AUDIT_DEFAULT_LIMIT)
    expect(page.events.length).toBeLessThanOrEqual(COMPLIANCE_AUDIT_DEFAULT_LIMIT)
  })

  it('supports offset pagination', () => {
    const first = service.listEvents({ limit: 5, offset: 0 })
    const second = service.listEvents({ limit: 5, offset: 5 })
    expect(first.events).toHaveLength(5)
    expect(second.events).toHaveLength(5)
    expect(first.events[0].id).not.toBe(second.events[0].id)
  })

  it('returns accurate COUNT total and hasMore across pages', () => {
    const first = service.listEvents({ limit: 10, offset: 0 })
    expect(first.total).toBe(30)
    expect(first.count).toBe(10)
    expect(first.hasMore).toBe(true)

    const last = service.listEvents({ limit: 10, offset: 20 })
    expect(last.total).toBe(30)
    expect(last.count).toBe(10)
    expect(last.hasMore).toBe(false)

    const pastEnd = service.listEvents({ limit: 10, offset: 30 })
    expect(pastEnd.total).toBe(30)
    expect(pastEnd.count).toBe(0)
    expect(pastEnd.hasMore).toBe(false)

    const filtered = service.listEvents({ action: 'policy_evaluate', limit: 5 })
    // 15 even indices out of 30
    expect(filtered.total).toBe(15)
    expect(filtered.count).toBe(5)
    expect(filtered.hasMore).toBe(true)
  })

  it('filters by action / decision / actor', () => {
    const byAction = service.listEvents({ action: 'policy_evaluate', limit: 50 })
    expect(byAction.events.every((e) => e.action === 'policy_evaluate')).toBe(true)
    expect(byAction.count).toBeGreaterThan(0)
    expect(byAction.total).toBe(byAction.count)

    const byDecision = service.listEvents({ decision: 'reject', limit: 50 })
    expect(byDecision.events.every((e) => e.decision === 'reject')).toBe(true)

    const byActor = service.listEvents({ actor: 'system', limit: 50 })
    expect(byActor.events.every((e) => e.actor === 'system')).toBe(true)
  })

  it('accepts UI aliases page/pageSize/outcome', () => {
    const bounds = resolveListBounds({ page: 2, pageSize: 5 })
    expect(bounds).toEqual({ limit: 5, offset: 5, page: 2 })

    const page = service.listEvents({ page: 1, pageSize: 5, outcome: 'reject' })
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(5)
    expect(page.items.every((i) => i.outcome === 'reject')).toBe(true)
    expect(page.items.length).toBe(page.events.length)
    expect(page.total).toBeGreaterThan(page.count)
    expect(page.hasMore).toBe(true)
  })

  it('returns empty result shape on repository failure', () => {
    const failing: ComplianceAuditRepository = {
      insert: () => {
        throw new Error('insert boom')
      },
      list: () => {
        throw new Error('list boom')
      },
      count: () => {
        throw new Error('count boom')
      },
    }
    const svc = makeService(failing)
    expect(svc.record({
      action: 'x',
      entityType: 'y',
      entityId: 'z',
      actor: 'a',
      decision: 'info',
    })).toBeNull()

    const page = svc.listEvents({ limit: 10 })
    expect(page.events).toEqual([])
    expect(page.items).toEqual([])
    expect(page.count).toBe(0)
    expect(page.total).toBe(0)
    expect(page.hasMore).toBe(false)
    expect(page.limit).toBe(10)
    expect(page.pageSize).toBe(10)
  })
})
