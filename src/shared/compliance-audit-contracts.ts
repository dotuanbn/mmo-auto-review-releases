/**
 * Compliance audit public contracts — append-only audit trail DTOs + IPC Zod.
 * Never carries secrets, API keys, tokens, passwords, or raw cookies.
 */

import { z } from 'zod'
import { boundedString } from './ipc-schemas'

/** Well-known audit actions (extensible string for forward compatibility). */
export type ComplianceAuditAction =
    | 'review_submit_decision'
    | 'manual_submit_approve'
    | 'manual_submit_reject'
    | 'policy_evaluate'
    | 'operator_override'
    | 'system'
    | string

/** Decision outcome recorded for an audited action. */
export type ComplianceAuditDecision =
    | 'allow'
    | 'deny'
    | 'approve'
    | 'reject'
    | 'info'
    | 'error'
    | string

/** Entity kinds that can appear on audit rows. */
export type ComplianceAuditEntityType =
    | 'review_submission'
    | 'campaign'
    | 'account'
    | 'location'
    | 'settings'
    | 'system'
    | string

/**
 * Public audit event returned to IPC/UI.
 * `metadata` is already sanitized (no secrets).
 */
export interface ComplianceAuditEvent {
    id: number
    action: string
    entityType: string
    entityId: string
    actor: string
    decision: string
    reason: string | null
    /** Sanitized JSON-serializable object; never secrets. */
    metadata: Record<string, unknown> | null
    /** ISO-8601 timestamp */
    createdAt: string
}

/** Input for append-only record (main-process only). */
export interface ComplianceAuditRecordInput {
    action: string
    entityType: string
    entityId: string
    actor: string
    decision: string
    reason?: string | null
    metadata?: Record<string, unknown> | null
}

/**
 * Loose record shapes accepted by the service normalizer
 * (BackupRestoreService / ReviewService optional bridges).
 */
export interface ComplianceAuditBackupEventShape {
    action: string
    backupId?: string
    success: boolean
    message: string
    includeProfiles?: boolean
    preRestoreBackupId?: string
    restartRequired?: boolean
}

export interface ComplianceAuditReconcileEventShape {
    action: string
    historyId: number
    outcome: string
    previousStatus: string
    newStatus: string
    note?: string | null
}

/** Max events returned by a single public query. */
export const COMPLIANCE_AUDIT_QUERY_LIMIT = 100

/** Soft default page size when limit is omitted. */
export const COMPLIANCE_AUDIT_DEFAULT_LIMIT = 50

/** Max length for action / entityType / actor / decision free-text fields. */
export const COMPLIANCE_AUDIT_FIELD_MAX = 128

/** Max length for entityId. */
export const COMPLIANCE_AUDIT_ENTITY_ID_MAX = 256

/** Max length for reason free-text. */
export const COMPLIANCE_AUDIT_REASON_MAX = 1000

/** Max serialized JSON length for metadata after sanitization. */
export const COMPLIANCE_AUDIT_METADATA_JSON_MAX = 4000

/** Max object depth when sanitizing metadata. */
export const COMPLIANCE_AUDIT_METADATA_MAX_DEPTH = 4

/** Max keys per object level in metadata. */
export const COMPLIANCE_AUDIT_METADATA_MAX_KEYS = 40

/** Max offset accepted at the public IPC boundary. */
export const COMPLIANCE_AUDIT_OFFSET_MAX = 1_000_000

// ---------------------------------------------------------------------------
// Zod schemas (data:getComplianceAudit IPC boundary)
// ---------------------------------------------------------------------------

/** Bounded free-text filter field (action / entityType / actor / decision). */
export const complianceAuditFilterFieldSchema = boundedString(COMPLIANCE_AUDIT_FIELD_MAX)

/** Bounded entity / target id filter. */
export const complianceAuditEntityIdSchema = boundedString(COMPLIANCE_AUDIT_ENTITY_ID_MAX)

/** Page size / limit — clamped later by service to COMPLIANCE_AUDIT_QUERY_LIMIT. */
export const complianceAuditLimitSchema = z
    .number()
    .int()
    .min(1)
    .max(COMPLIANCE_AUDIT_QUERY_LIMIT)

/** Non-negative offset. */
export const complianceAuditOffsetSchema = z
    .number()
    .int()
    .min(0)
    .max(COMPLIANCE_AUDIT_OFFSET_MAX)

/** 1-based page number. */
export const complianceAuditPageSchema = z.number().int().min(1).max(COMPLIANCE_AUDIT_OFFSET_MAX)

/**
 * Strict public query filters for data:getComplianceAudit.
 * Unknown keys rejected. UI aliases (pageSize/targetType/outcome/targetId) accepted.
 */
export const complianceAuditQuerySchema = z
    .object({
        limit: complianceAuditLimitSchema.optional(),
        offset: complianceAuditOffsetSchema.optional(),
        page: complianceAuditPageSchema.optional(),
        pageSize: complianceAuditLimitSchema.optional(),
        action: complianceAuditFilterFieldSchema.optional(),
        entityType: complianceAuditFilterFieldSchema.optional(),
        targetType: complianceAuditFilterFieldSchema.optional(),
        entityId: complianceAuditEntityIdSchema.optional(),
        targetId: z
            .union([complianceAuditEntityIdSchema, z.number().int().finite()])
            .optional(),
        decision: complianceAuditFilterFieldSchema.optional(),
        outcome: complianceAuditFilterFieldSchema.optional(),
        actor: complianceAuditFilterFieldSchema.optional(),
    })
    .strict()

/** data:getComplianceAudit(query?) */
export const complianceAuditGetArgsSchema = z.tuple([complianceAuditQuerySchema.optional()])

/** Typed query after IPC parse (aliases still present; service resolves them). */
export type ComplianceAuditQuery = z.infer<typeof complianceAuditQuerySchema>

/** Result of a bounded list query. */
export interface ComplianceAuditListResult {
    events: ComplianceAuditEvent[]
    /** Number of events returned in this page (≤ limit). */
    count: number
    /** Echo of the effective limit after clamping. */
    limit: number
    /** Echo of the effective offset after clamping. */
    offset: number
    /** 1-based page when page/pageSize query style is used. */
    page: number
    /** Alias of limit for UI consumers. */
    pageSize: number
    /**
     * UI-oriented projection (targetType/outcome/summary).
     * Same rows as `events`, different field names for Settings panel.
     */
    items: ComplianceAuditPublicEntry[]
    /** Accurate total matching the current filter (COUNT query). */
    total: number
    /** True when more rows exist after this page (offset + count < total). */
    hasMore: boolean
}

/**
 * Public entry shape aligned with Settings ComplianceAuditPanel DTO
 * (targetType/outcome/summary aliases over entityType/decision/reason).
 */
export interface ComplianceAuditPublicEntry {
    id: number
    createdAt: string
    action: string
    actor: string
    targetType: string
    targetId: string
    outcome: string
    summary: string | null
    /** Sanitized metadata; never secrets. */
    metadata: Record<string, unknown> | null
}

export function emptyComplianceAuditListResult(
    limit: number = COMPLIANCE_AUDIT_DEFAULT_LIMIT,
    offset: number = 0,
): ComplianceAuditListResult {
    const page = limit > 0 ? Math.floor(offset / limit) + 1 : 1
    return {
        events: [],
        count: 0,
        limit,
        offset,
        page,
        pageSize: limit,
        items: [],
        total: 0,
        hasMore: false,
    }
}

/** Map canonical event → UI public entry aliases. */
export function toComplianceAuditPublicEntry(
    event: ComplianceAuditEvent,
): ComplianceAuditPublicEntry {
    return {
        id: event.id,
        createdAt: event.createdAt,
        action: event.action,
        actor: event.actor,
        targetType: event.entityType,
        targetId: event.entityId,
        outcome: event.decision,
        summary: event.reason,
        metadata: event.metadata,
    }
}
