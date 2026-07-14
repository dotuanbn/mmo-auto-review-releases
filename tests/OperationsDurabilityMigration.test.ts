/**
 * Operations durability migration v4 — schema parity + idempotency.
 * Uses a pure mock SQLite (no better-sqlite3 native binding) so tests run
 * under system Node even when the package was rebuilt for Electron's ABI.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_AUDIT_COLUMNS,
  COMPLIANCE_AUDIT_DDL,
  COMPLIANCE_AUDIT_INDEX_SQL,
  TRAFFIC_VISIT_QUEUE_COLUMNS,
  TRAFFIC_VISIT_QUEUE_DDL,
  TRAFFIC_VISIT_QUEUE_INDEX_SQL,
  ensureOperationsDurabilitySchema,
  migration004OperationsDurability,
} from '../src/main/database/migrations/004_operations_durability'
import { migrations } from '../src/main/database/migrations/registry'
import type { SqliteTableInfoRow } from '../src/main/database/migrations/types'

interface MockStatement {
  all: () => ReadonlyArray<Record<string, unknown>>
  run: (..._params: unknown[]) => { changes: number }
}

/** Minimal better-sqlite3 stand-in that records DDL for assertions. */
class MockSqliteDatabase {
  readonly statements: string[] = []
  private readonly tables = new Map<string, string[]>()
  private readonly indexes = new Set<string>()

  exec(sql: string): void {
    this.statements.push(sql)
    this.trackCreateTable(sql)
    this.trackCreateIndex(sql)
  }

  prepare(sql: string): MockStatement {
    const tableMatch = /PRAGMA\s+table_info\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/i.exec(sql)
    if (tableMatch) {
      const tableName = tableMatch[1]
      const cols = this.tables.get(tableName) ?? []
      return {
        all: () =>
          cols.map(
            (name, cid): SqliteTableInfoRow => ({
              cid,
              name,
              type: 'TEXT',
              notnull: 0,
              dflt_value: null,
              pk: name === 'id' ? 1 : 0,
            })
          ),
        run: () => ({ changes: 0 }),
      }
    }
    return {
      all: () => [],
      run: () => ({ changes: 0 }),
    }
  }

  private trackCreateTable(sql: string): void {
    const match = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)/i.exec(
      sql
    )
    if (!match) return
    const tableName = match[1]
    if (this.tables.has(tableName)) return
    this.tables.set(tableName, extractColumnNames(`CREATE TABLE x (${match[2]})`))
  }

  private trackCreateIndex(sql: string): void {
    const match =
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)
    if (match) {
      this.indexes.add(match[1])
    }
  }

  hasTable(name: string): boolean {
    return this.tables.has(name)
  }

  columnsOf(name: string): string[] {
    return this.tables.get(name) ?? []
  }

  hasIndex(name: string): boolean {
    return this.indexes.has(name)
  }
}

/** Fresh-DB ensure SQL mirrored from src/main/database/index.ts (parity source). */
const FRESH_DB_TRAFFIC_VISIT_QUEUE_DDL = `
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

const FRESH_DB_COMPLIANCE_AUDIT_DDL = `
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

const FRESH_DB_TRAFFIC_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_traffic_visit_campaign_index ON traffic_visit_queue(campaign_id, visit_index)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_status ON traffic_visit_queue(status)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_available ON traffic_visit_queue(available_at)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_lease ON traffic_visit_queue(lease_expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_campaign ON traffic_visit_queue(campaign_id)',
] as const

const FRESH_DB_AUDIT_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_created ON compliance_audit(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_entity ON compliance_audit(entity_type, entity_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_action ON compliance_audit(action, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_compliance_audit_decision ON compliance_audit(decision, created_at DESC)',
] as const

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Extract top-level column names from a CREATE TABLE DDL body.
 * Strips parenthetical expressions first so commas inside DEFAULT (strftime(...))
 * do not split column definitions incorrectly.
 */
function extractColumnNames(ddl: string): string[] {
  const match = /\(([\s\S]*)\)/.exec(ddl)
  if (!match) return []
  // Remove nested (...) groups repeatedly (defaults, constraints).
  let body = match[1]
  let prev = ''
  while (body !== prev) {
    prev = body
    body = body.replace(/\([^()]*\)/g, '')
  }
  return body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+/)[0]?.toLowerCase() ?? '')
    .filter((name) => name && !/^(primary|unique|check|foreign|constraint)$/i.test(name))
}

describe('migration004OperationsDurability metadata', () => {
  it('is registered as version 4 with stable name', () => {
    expect(migration004OperationsDurability.version).toBe(4)
    expect(migration004OperationsDurability.name).toBe('operations_durability')
  })

  it('appears exactly once in the migrations registry after v3', () => {
    const v4 = migrations.filter((m) => m.version === 4)
    expect(v4).toHaveLength(1)
    expect(v4[0].name).toBe('operations_durability')

    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(versions).toContain(3)
    expect(versions).toContain(4)
    expect(versions.indexOf(4)).toBeGreaterThan(versions.indexOf(3))
  })
})

describe('DDL column contracts', () => {
  it('traffic_visit_queue DDL includes all required columns', () => {
    const cols = extractColumnNames(TRAFFIC_VISIT_QUEUE_DDL)
    expect(cols).toEqual([...TRAFFIC_VISIT_QUEUE_COLUMNS])
    for (const required of [
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
    ]) {
      expect(cols).toContain(required)
    }
  })

  it('compliance_audit DDL includes all required columns', () => {
    const cols = extractColumnNames(COMPLIANCE_AUDIT_DDL)
    expect(cols).toEqual([...COMPLIANCE_AUDIT_COLUMNS])
    for (const required of [
      'id',
      'action',
      'entity_type',
      'entity_id',
      'actor',
      'decision',
      'reason',
      'metadata',
      'created_at',
    ]) {
      expect(cols).toContain(required)
    }
  })

  it('defines unique campaign+visit index and status/available/lease/campaign indexes', () => {
    const joined = TRAFFIC_VISIT_QUEUE_INDEX_SQL.join('\n').toLowerCase()
    expect(joined).toContain('uq_traffic_visit_campaign_index')
    expect(joined).toContain('campaign_id, visit_index')
    expect(joined).toContain('idx_traffic_visit_queue_status')
    expect(joined).toContain('idx_traffic_visit_queue_available')
    expect(joined).toContain('idx_traffic_visit_queue_lease')
    expect(joined).toContain('idx_traffic_visit_queue_campaign')
  })

  it('traffic_visit_queue uses deterministic text id and ISO text timestamps', () => {
    const ddl = normalizeSql(TRAFFIC_VISIT_QUEUE_DDL)
    expect(ddl).toContain('id text primary key not null')
    expect(ddl).not.toContain('autoincrement')
    expect(ddl).toContain('claimed_at text')
    expect(ddl).toContain('lease_expires_at text')
    expect(ddl).toContain('available_at text')
    expect(ddl).toContain('created_at text not null')
    expect(ddl).toContain('updated_at text not null')
    // No unix-epoch integer timestamp defaults on lease/timestamp columns
    expect(ddl).not.toMatch(/claimed_at\s+integer/)
    expect(ddl).not.toMatch(/created_at\s+integer/)
    expect(ddl).not.toMatch(/strftime\s*\(/)
  })
})

describe('fresh DB ensure parity with migration v4', () => {
  it('traffic_visit_queue DDL matches between migration and fresh ensure', () => {
    expect(normalizeSql(TRAFFIC_VISIT_QUEUE_DDL)).toBe(
      normalizeSql(FRESH_DB_TRAFFIC_VISIT_QUEUE_DDL)
    )
    expect(extractColumnNames(TRAFFIC_VISIT_QUEUE_DDL)).toEqual(
      extractColumnNames(FRESH_DB_TRAFFIC_VISIT_QUEUE_DDL)
    )
  })

  it('compliance_audit DDL matches between migration and fresh ensure', () => {
    expect(normalizeSql(COMPLIANCE_AUDIT_DDL)).toBe(normalizeSql(FRESH_DB_COMPLIANCE_AUDIT_DDL))
    expect(extractColumnNames(COMPLIANCE_AUDIT_DDL)).toEqual(
      extractColumnNames(FRESH_DB_COMPLIANCE_AUDIT_DDL)
    )
  })

  it('index SQL sets match between migration and fresh ensure', () => {
    expect(TRAFFIC_VISIT_QUEUE_INDEX_SQL.map(normalizeSql)).toEqual(
      FRESH_DB_TRAFFIC_INDEXES.map(normalizeSql)
    )
    expect(COMPLIANCE_AUDIT_INDEX_SQL.map(normalizeSql)).toEqual(
      FRESH_DB_AUDIT_INDEXES.map(normalizeSql)
    )
  })
})

describe('migration up() idempotency', () => {
  it('creates both tables and indexes on a fresh mock DB', () => {
    const db = new MockSqliteDatabase()
    migration004OperationsDurability.up(db as never)

    expect(db.hasTable('traffic_visit_queue')).toBe(true)
    expect(db.hasTable('compliance_audit')).toBe(true)

    expect(db.columnsOf('traffic_visit_queue')).toEqual([...TRAFFIC_VISIT_QUEUE_COLUMNS])
    expect(db.columnsOf('compliance_audit')).toEqual([...COMPLIANCE_AUDIT_COLUMNS])

    expect(db.hasIndex('uq_traffic_visit_campaign_index')).toBe(true)
    expect(db.hasIndex('idx_traffic_visit_queue_status')).toBe(true)
    expect(db.hasIndex('idx_traffic_visit_queue_available')).toBe(true)
    expect(db.hasIndex('idx_traffic_visit_queue_lease')).toBe(true)
    expect(db.hasIndex('idx_traffic_visit_queue_campaign')).toBe(true)
    expect(db.hasIndex('idx_compliance_audit_created')).toBe(true)
    expect(db.hasIndex('idx_compliance_audit_entity')).toBe(true)
    expect(db.hasIndex('idx_compliance_audit_action')).toBe(true)
    expect(db.hasIndex('idx_compliance_audit_decision')).toBe(true)
  })

  it('is safe to re-run (idempotent IF NOT EXISTS)', () => {
    const db = new MockSqliteDatabase()
    migration004OperationsDurability.up(db as never)
    const firstCount = db.statements.length

    expect(() => migration004OperationsDurability.up(db as never)).not.toThrow()
    // Second run still issues IF NOT EXISTS statements (no-op on real SQLite)
    expect(db.statements.length).toBeGreaterThanOrEqual(firstCount)
    // Tables stay single-definition (CREATE IF NOT EXISTS does not duplicate columns)
    expect(db.columnsOf('traffic_visit_queue')).toEqual([...TRAFFIC_VISIT_QUEUE_COLUMNS])
    expect(db.columnsOf('compliance_audit')).toEqual([...COMPLIANCE_AUDIT_COLUMNS])
  })

  it('ensureOperationsDurabilitySchema matches migration up()', () => {
    const viaMigration = new MockSqliteDatabase()
    const viaEnsure = new MockSqliteDatabase()

    migration004OperationsDurability.up(viaMigration as never)
    ensureOperationsDurabilitySchema(viaEnsure as never)

    expect(viaEnsure.columnsOf('traffic_visit_queue')).toEqual(
      viaMigration.columnsOf('traffic_visit_queue')
    )
    expect(viaEnsure.columnsOf('compliance_audit')).toEqual(
      viaMigration.columnsOf('compliance_audit')
    )
    expect(viaEnsure.hasIndex('uq_traffic_visit_campaign_index')).toBe(true)
    expect(viaEnsure.hasIndex('idx_compliance_audit_created')).toBe(true)
  })
})
