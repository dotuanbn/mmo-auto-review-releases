/**
 * ComplianceAuditService — append-only compliance / operator audit trail.
 *
 * - record(): insert only (no update/delete public API)
 * - listEvents(): bounded public query with filters
 * - metadata sanitized: secrets never persisted or returned
 */

import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import {
    COMPLIANCE_AUDIT_DEFAULT_LIMIT,
    COMPLIANCE_AUDIT_ENTITY_ID_MAX,
    COMPLIANCE_AUDIT_FIELD_MAX,
    COMPLIANCE_AUDIT_METADATA_JSON_MAX,
    COMPLIANCE_AUDIT_METADATA_MAX_DEPTH,
    COMPLIANCE_AUDIT_METADATA_MAX_KEYS,
    COMPLIANCE_AUDIT_QUERY_LIMIT,
    COMPLIANCE_AUDIT_REASON_MAX,
    emptyComplianceAuditListResult,
    toComplianceAuditPublicEntry,
    type ComplianceAuditBackupEventShape,
    type ComplianceAuditEvent,
    type ComplianceAuditListResult,
    type ComplianceAuditQuery,
    type ComplianceAuditReconcileEventShape,
    type ComplianceAuditRecordInput,
} from '../../shared/compliance-audit-contracts'

/** Minimal row shape used by repository / tests. */
export interface ComplianceAuditRowView {
    id: number
    action: string
    entityType: string
    entityId: string
    actor: string
    decision: string
    reason: string | null
    metadata: string | null
    createdAt: Date | number | string
}

/** Shared list/count filter (no pagination). */
export interface ComplianceAuditListFilter {
    action?: string
    entityType?: string
    entityId?: string
    decision?: string
    actor?: string
}

/** Injectable repository for unit tests / alternate stores. */
export interface ComplianceAuditRepository {
    insert(row: {
        action: string
        entityType: string
        entityId: string
        actor: string
        decision: string
        reason: string | null
        metadata: string | null
    }): ComplianceAuditRowView
    list(query: ComplianceAuditListFilter & {
        limit: number
        offset: number
    }): ComplianceAuditRowView[]
    /** Accurate filtered total (COUNT). */
    count(filter: ComplianceAuditListFilter): number
}

/** Key fragments that mark secret-bearing metadata fields. */
const SECRET_KEY_PATTERN =
    /password|passwd|secret|token|api[_-]?key|authorization|cookie|session|private[_-]?key|bearer|credential|otp|2fa|totp/i

/** Value patterns that look like secrets even under safe keys. */
const SECRET_VALUE_PATTERN =
    /(?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*\S+/i

function createDbRepository(): ComplianceAuditRepository {
    return {
        insert: insertComplianceAuditRow,
        list: listComplianceAuditRows,
        count: countComplianceAuditRows,
    }
}

function buildListConditions(filter: ComplianceAuditListFilter): SQL[] {
    const conditions: SQL[] = []
    if (filter.action) {
        conditions.push(eq(schema.complianceAudit.action, filter.action))
    }
    if (filter.entityType) {
        conditions.push(eq(schema.complianceAudit.entityType, filter.entityType))
    }
    if (filter.entityId) {
        conditions.push(eq(schema.complianceAudit.entityId, filter.entityId))
    }
    if (filter.decision) {
        conditions.push(eq(schema.complianceAudit.decision, filter.decision))
    }
    if (filter.actor) {
        conditions.push(eq(schema.complianceAudit.actor, filter.actor))
    }
    return conditions
}

function insertComplianceAuditRow(row: {
    action: string
    entityType: string
    entityId: string
    actor: string
    decision: string
    reason: string | null
    metadata: string | null
}): ComplianceAuditRowView {
    const db = getDatabase()
    const inserted = db
        .insert(schema.complianceAudit)
        .values({
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            actor: row.actor,
            decision: row.decision,
            reason: row.reason,
            metadata: row.metadata,
        })
        .returning()
        .get()
    return toRowView(inserted)
}

function listComplianceAuditRows(query: ComplianceAuditListFilter & {
    limit: number
    offset: number
}): ComplianceAuditRowView[] {
    const db = getDatabase()
    const conditions = buildListConditions(query)

    const rows =
        conditions.length > 0
            ? db
                  .select()
                  .from(schema.complianceAudit)
                  .where(and(...conditions))
                  .orderBy(
                      desc(schema.complianceAudit.createdAt),
                      desc(schema.complianceAudit.id)
                  )
                  .limit(query.limit)
                  .offset(query.offset)
                  .all()
            : db
                  .select()
                  .from(schema.complianceAudit)
                  .orderBy(
                      desc(schema.complianceAudit.createdAt),
                      desc(schema.complianceAudit.id)
                  )
                  .limit(query.limit)
                  .offset(query.offset)
                  .all()

    return rows.map(toRowView)
}

function countComplianceAuditRows(filter: ComplianceAuditListFilter): number {
    const db = getDatabase()
    const conditions = buildListConditions(filter)
    const row =
        conditions.length > 0
            ? db
                  .select({ count: sql<number>`count(*)` })
                  .from(schema.complianceAudit)
                  .where(and(...conditions))
                  .get()
            : db
                  .select({ count: sql<number>`count(*)` })
                  .from(schema.complianceAudit)
                  .get()
    return Number(row?.count) || 0
}

function toRowView(row: {
    id: number
    action: string
    entityType: string
    entityId: string
    actor: string
    decision: string
    reason: string | null
    metadata: string | null
    createdAt: Date | number | string | null
}): ComplianceAuditRowView {
    return {
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actor: row.actor,
        decision: row.decision,
        reason: row.reason,
        metadata: row.metadata,
        createdAt: row.createdAt ?? new Date(),
    }
}

export function clampAuditLimit(raw: number | undefined): number {
    if (raw == null || !Number.isFinite(raw)) {
        return COMPLIANCE_AUDIT_DEFAULT_LIMIT
    }
    const n = Math.floor(raw)
    if (n < 1) return 1
    return Math.min(n, COMPLIANCE_AUDIT_QUERY_LIMIT)
}

export function clampAuditOffset(raw: number | undefined): number {
    if (raw == null || !Number.isFinite(raw) || raw < 0) return 0
    return Math.min(Math.floor(raw), 1_000_000)
}

export function normalizeAuditField(
    raw: string,
    maxLen: number = COMPLIANCE_AUDIT_FIELD_MAX,
): string {
    const trimmed = raw.replace(/\s+/g, ' ').trim()
    if (!trimmed) return 'unknown'
    // Only redact value-shaped secrets (key=value), not substrings like "session".
    if (SECRET_VALUE_PATTERN.test(trimmed)) {
        return 'redacted'
    }
    return trimmed.slice(0, maxLen)
}

export function normalizeAuditReason(raw: string | null | undefined): string | null {
    if (raw == null) return null
    const trimmed = raw.replace(/\s+/g, ' ').trim()
    if (!trimmed) return null
    if (SECRET_VALUE_PATTERN.test(trimmed)) return 'redacted'
    return trimmed.slice(0, COMPLIANCE_AUDIT_REASON_MAX)
}

/**
 * Deep-sanitize metadata: drop secret-looking keys/values, bound depth/keys/size.
 * Returns a plain object or null.
 */
export function sanitizeAuditMetadata(
    raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return null
    }
    const cleaned = sanitizeValue(raw, 0)
    if (cleaned == null || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
        return null
    }
    const obj = cleaned as Record<string, unknown>
    if (Object.keys(obj).length === 0) return null

    let json: string
    try {
        json = JSON.stringify(obj)
    } catch {
        return { _error: 'metadata_not_serializable' }
    }
    if (json.length > COMPLIANCE_AUDIT_METADATA_JSON_MAX) {
        return { _truncated: true, _originalLength: json.length }
    }
    return obj
}

function sanitizeValue(value: unknown, depth: number): unknown {
    if (value == null) return null
    if (typeof value === 'string') {
        if (SECRET_VALUE_PATTERN.test(value)) return '[redacted]'
        return value.length > 500 ? value.slice(0, 500) : value
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object') return null

    if (depth >= COMPLIANCE_AUDIT_METADATA_MAX_DEPTH) {
        return '[max_depth]'
    }

    if (Array.isArray(value)) {
        return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1))
    }

    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let keyCount = 0
    for (const key of Object.keys(input)) {
        if (keyCount >= COMPLIANCE_AUDIT_METADATA_MAX_KEYS) {
            out._truncatedKeys = true
            break
        }
        if (SECRET_KEY_PATTERN.test(key)) {
            out[key] = '[redacted]'
            keyCount += 1
            continue
        }
        const safeKey = key.slice(0, 64)
        out[safeKey] = sanitizeValue(input[key], depth + 1)
        keyCount += 1
    }
    return out
}

export function serializeAuditMetadata(
    metadata: Record<string, unknown> | null,
): string | null {
    if (metadata == null) return null
    try {
        const json = JSON.stringify(metadata)
        if (json.length > COMPLIANCE_AUDIT_METADATA_JSON_MAX) {
            return JSON.stringify({ _truncated: true, _originalLength: json.length })
        }
        return json
    } catch {
        return JSON.stringify({ _error: 'metadata_not_serializable' })
    }
}

export function parseAuditMetadata(raw: string | null): Record<string, unknown> | null {
    if (raw == null || raw === '') return null
    try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null
        }
        // Re-sanitize on read so legacy rows cannot leak secrets to public API.
        return sanitizeAuditMetadata(parsed as Record<string, unknown>)
    } catch {
        return null
    }
}

function toIso(createdAt: Date | number | string): string {
    if (createdAt instanceof Date) return createdAt.toISOString()
    if (typeof createdAt === 'number') {
        const ms = createdAt < 1e12 ? createdAt * 1000 : createdAt
        return new Date(ms).toISOString()
    }
    const parsed = new Date(createdAt)
    return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

export function toPublicAuditEvent(row: ComplianceAuditRowView): ComplianceAuditEvent {
    return {
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actor: row.actor,
        decision: row.decision,
        reason: row.reason,
        metadata: parseAuditMetadata(row.metadata),
        createdAt: toIso(row.createdAt),
    }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return undefined
}

/**
 * Normalize strict or loose record payloads (backup / reconcile bridges).
 * Returns null when the payload cannot form a valid audit row.
 */
export function normalizeRecordInput(
    raw: ComplianceAuditRecordInput | ComplianceAuditBackupEventShape | ComplianceAuditReconcileEventShape | Record<string, unknown> | unknown,
): ComplianceAuditRecordInput | null {
    if (!isRecordObject(raw)) return null

    // Strict shape
    if (
        typeof raw.action === 'string' &&
        typeof raw.entityType === 'string' &&
        typeof raw.entityId === 'string' &&
        typeof raw.actor === 'string' &&
        typeof raw.decision === 'string'
    ) {
        const metadata =
            raw.metadata != null && isRecordObject(raw.metadata)
                ? (raw.metadata as Record<string, unknown>)
                : null
        return {
            action: raw.action,
            entityType: raw.entityType,
            entityId: raw.entityId,
            actor: raw.actor,
            decision: raw.decision,
            reason: asString(raw.reason) ?? null,
            metadata,
        }
    }

    // BackupRestoreService bridge: { action, success, message, backupId?, ... }
    if (
        typeof raw.action === 'string' &&
        typeof raw.success === 'boolean' &&
        typeof raw.message === 'string'
    ) {
        const backupId = asString(raw.backupId) ?? 'unknown'
        return {
            action: raw.action,
            entityType: 'backup',
            entityId: backupId,
            actor: 'system',
            decision: raw.success ? 'success' : 'failure',
            reason: raw.message,
            metadata: {
                includeProfiles: raw.includeProfiles === true,
                preRestoreBackupId: asString(raw.preRestoreBackupId) ?? null,
                restartRequired: raw.restartRequired === true,
            },
        }
    }

    // ReviewService reconcile bridge: { action, historyId, outcome, previousStatus, newStatus, note? }
    if (
        typeof raw.action === 'string' &&
        typeof raw.historyId === 'number' &&
        typeof raw.outcome === 'string' &&
        typeof raw.previousStatus === 'string' &&
        typeof raw.newStatus === 'string'
    ) {
        return {
            action: raw.action,
            entityType: 'review_history',
            entityId: String(raw.historyId),
            actor: 'operator',
            decision: raw.outcome,
            reason: asString(raw.note) ?? null,
            metadata: {
                previousStatus: raw.previousStatus,
                newStatus: raw.newStatus,
            },
        }
    }

    // Best-effort partial mapping
    const action = asString(raw.action)
    if (!action) return null
    const entityType =
        asString(raw.entityType) ?? asString(raw.targetType) ?? 'system'
    const entityId =
        asString(raw.entityId) ?? asString(raw.targetId) ?? asString(raw.backupId) ?? 'unknown'
    const actor = asString(raw.actor) ?? 'system'
    const decision =
        asString(raw.decision) ?? asString(raw.outcome) ?? (raw.success === true ? 'success' : raw.success === false ? 'failure' : 'info')
    const reason = asString(raw.reason) ?? asString(raw.summary) ?? asString(raw.message) ?? asString(raw.note) ?? null
    const metadata = isRecordObject(raw.metadata) ? raw.metadata : null
    return { action, entityType, entityId, actor, decision, reason, metadata }
}

export function resolveListBounds(query: ComplianceAuditQuery): {
    limit: number
    offset: number
    page: number
} {
    const pageSizeRaw = query.pageSize ?? query.limit
    const limit = clampAuditLimit(pageSizeRaw)

    if (query.page != null && Number.isFinite(query.page) && query.page >= 1) {
        const page = Math.floor(query.page)
        return { limit, offset: (page - 1) * limit, page }
    }

    const offset = clampAuditOffset(query.offset)
    const page = limit > 0 ? Math.floor(offset / limit) + 1 : 1
    return { limit, offset, page }
}

export class ComplianceAuditService {
    private readonly repo: ComplianceAuditRepository

    constructor(repo?: ComplianceAuditRepository) {
        this.repo = repo ?? createDbRepository()
    }

    /**
     * Append-only insert. Never updates or deletes existing rows.
     * Accepts strict ComplianceAuditRecordInput or loose bridge payloads.
     * Returns the public event, or null on failure (logged, non-throwing).
     */
    record(
        input:
            | ComplianceAuditRecordInput
            | ComplianceAuditBackupEventShape
            | ComplianceAuditReconcileEventShape
            | Record<string, unknown>
            | unknown,
    ): ComplianceAuditEvent | null {
        try {
            const normalized = normalizeRecordInput(input)
            if (!normalized) {
                console.error('[ComplianceAuditService] record rejected: invalid input')
                return null
            }
            const sanitizedMeta = sanitizeAuditMetadata(normalized.metadata)
            const row = this.repo.insert({
                action: normalizeAuditField(normalized.action),
                entityType: normalizeAuditField(normalized.entityType),
                entityId: normalizeAuditField(
                    normalized.entityId,
                    COMPLIANCE_AUDIT_ENTITY_ID_MAX,
                ),
                actor: normalizeAuditField(normalized.actor),
                decision: normalizeAuditField(normalized.decision),
                reason: normalizeAuditReason(normalized.reason),
                metadata: serializeAuditMetadata(sanitizedMeta),
            })
            return toPublicAuditEvent(row)
        } catch (err) {
            console.error('[ComplianceAuditService] record failed:', err)
            return null
        }
    }

    /**
     * Bounded public query. Results are newest-first and metadata-sanitized.
     * Supports limit/offset and page/pageSize + UI aliases (outcome/targetType).
     */
    listEvents(query: ComplianceAuditQuery = {}): ComplianceAuditListResult {
        const { limit, offset, page } = resolveListBounds(query)
        try {
            const entityTypeRaw = query.entityType ?? query.targetType
            const entityIdRaw =
                query.entityId ??
                (query.targetId != null ? String(query.targetId) : undefined)
            const decisionRaw = query.decision ?? query.outcome

            const filter: ComplianceAuditListFilter = {
                action: query.action ? normalizeAuditField(query.action) : undefined,
                entityType: entityTypeRaw
                    ? normalizeAuditField(entityTypeRaw)
                    : undefined,
                entityId: entityIdRaw
                    ? normalizeAuditField(entityIdRaw, COMPLIANCE_AUDIT_ENTITY_ID_MAX)
                    : undefined,
                decision: decisionRaw ? normalizeAuditField(decisionRaw) : undefined,
                actor: query.actor ? normalizeAuditField(query.actor) : undefined,
            }

            const total = this.repo.count(filter)
            const rows = this.repo.list({
                ...filter,
                limit,
                offset,
            })
            const events = rows.map(toPublicAuditEvent)
            const items = events.map(toComplianceAuditPublicEntry)
            const count = events.length
            return {
                events,
                count,
                limit,
                offset,
                page,
                pageSize: limit,
                items,
                total,
                hasMore: offset + count < total,
            }
        } catch (err) {
            console.error('[ComplianceAuditService] listEvents failed:', err)
            return emptyComplianceAuditListResult(limit, offset)
        }
    }
}

/** Production singleton (SQLite-backed via getDatabase). */
export const complianceAuditService = new ComplianceAuditService()

/**
 * Module-level append helper for optional bridges (ReviewService dynamic import).
 * Never throws; returns null on invalid input or storage failure.
 */
export function recordComplianceAudit(
    input:
        | ComplianceAuditRecordInput
        | ComplianceAuditBackupEventShape
        | ComplianceAuditReconcileEventShape
        | Record<string, unknown>
        | unknown,
): ComplianceAuditEvent | null {
    return complianceAuditService.record(input)
}

function filterMemoryRows(
    rows: ComplianceAuditRowView[],
    filter: ComplianceAuditListFilter,
): ComplianceAuditRowView[] {
    let filtered = [...rows]
    if (filter.action) {
        filtered = filtered.filter((r) => r.action === filter.action)
    }
    if (filter.entityType) {
        filtered = filtered.filter((r) => r.entityType === filter.entityType)
    }
    if (filter.entityId) {
        filtered = filtered.filter((r) => r.entityId === filter.entityId)
    }
    if (filter.decision) {
        filtered = filtered.filter((r) => r.decision === filter.decision)
    }
    if (filter.actor) {
        filtered = filtered.filter((r) => r.actor === filter.actor)
    }
    return filtered
}

/** In-memory repository for unit tests (no native SQLite required). */
export function createMemoryComplianceAuditRepository(): ComplianceAuditRepository {
    let seq = 0
    const rows: ComplianceAuditRowView[] = []

    return {
        insert(row) {
            seq += 1
            const created: ComplianceAuditRowView = {
                id: seq,
                action: row.action,
                entityType: row.entityType,
                entityId: row.entityId,
                actor: row.actor,
                decision: row.decision,
                reason: row.reason,
                metadata: row.metadata,
                createdAt: new Date(),
            }
            rows.push(created)
            return created
        },
        list(query) {
            const filtered = filterMemoryRows(rows, query)
            filtered.sort((a, b) => b.id - a.id)
            return filtered.slice(query.offset, query.offset + query.limit)
        },
        count(filter) {
            return filterMemoryRows(rows, filter).length
        },
    }
}
