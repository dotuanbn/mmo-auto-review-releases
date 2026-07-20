import type Database from 'better-sqlite3'
import { ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v4 — Operations durability foundation:
 * - traffic_visit_queue: durable per-visit claim/lease/recovery
 * - compliance_audit: append-only audit trail
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 * Must stay in parity with ensureTrafficVisitQueueTable / ensureComplianceAuditTable
 * in src/main/database/index.ts (fresh DB path).
 */

/** Canonical column names for traffic_visit_queue (parity checks). */
export const TRAFFIC_VISIT_QUEUE_COLUMNS = [
  'id',
  'campaign_id',
  'visit_index',
  'status',
  'payload',
  'attempt_count',
  'max_attempts',
  'worker_id',
  'claimed_at',
  'lease_expires_at',
  'available_at',
  'last_error',
  'result',
  'created_at',
  'updated_at',
] as const

/** Canonical column names for compliance_audit (parity checks). */
export const COMPLIANCE_AUDIT_COLUMNS = [
  'id',
  'action',
  'entity_type',
  'entity_id',
  'actor',
  'decision',
  'reason',
  'metadata',
  'created_at',
] as const

export const TRAFFIC_VISIT_QUEUE_DDL = `
    CREATE TABLE IF NOT EXISTS traffic_visit_queue (
      id TEXT PRIMARY KEY NOT NULL,
      campaign_id INTEGER NOT NULL,
      visit_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      worker_id TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      available_at TEXT,
      last_error TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

export const COMPLIANCE_AUDIT_DDL = `
    CREATE TABLE IF NOT EXISTS compliance_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `

export const TRAFFIC_VISIT_QUEUE_INDEX_SQL = [
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_traffic_visit_campaign_index ON traffic_visit_queue(campaign_id, visit_index)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_status ON traffic_visit_queue(status)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_available ON traffic_visit_queue(available_at)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_lease ON traffic_visit_queue(lease_expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_campaign ON traffic_visit_queue(campaign_id)',
] as const

export const COMPLIANCE_AUDIT_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_created ON compliance_audit(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_entity ON compliance_audit(entity_type, entity_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_action ON compliance_audit(action, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_decision ON compliance_audit(decision, created_at DESC)',
] as const

function up(db: Database.Database): void {
  createTrafficVisitQueueTable(db)
  ensureTrafficVisitQueueIndexes(db)
  createComplianceAuditTable(db)
  ensureComplianceAuditIndexes(db)
}

export function createTrafficVisitQueueTable(db: Database.Database): void {
  db.exec(TRAFFIC_VISIT_QUEUE_DDL)
}

export function ensureTrafficVisitQueueIndexes(db: Database.Database): void {
  for (const sql of TRAFFIC_VISIT_QUEUE_INDEX_SQL) {
    ensureIndex(db, sql)
  }
}

export function createComplianceAuditTable(db: Database.Database): void {
  db.exec(COMPLIANCE_AUDIT_DDL)
}

export function ensureComplianceAuditIndexes(db: Database.Database): void {
  for (const sql of COMPLIANCE_AUDIT_INDEX_SQL) {
    ensureIndex(db, sql)
  }
}

/**
 * Full ensure path used by fresh DB init and by this migration.
 * Safe to call repeatedly (idempotent).
 */
export function ensureOperationsDurabilitySchema(db: Database.Database): void {
  createTrafficVisitQueueTable(db)
  ensureTrafficVisitQueueIndexes(db)
  createComplianceAuditTable(db)
  ensureComplianceAuditIndexes(db)
}

export const migration004OperationsDurability: Migration = {
  version: 4,
  name: 'operations_durability',
  up,
}
