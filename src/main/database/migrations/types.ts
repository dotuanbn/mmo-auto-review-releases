import type Database from 'better-sqlite3'

/**
 * A single versioned database migration.
 * `version` must be unique and monotonically increasing.
 * `up` must be safe to re-evaluate against already-shaped schemas (idempotent helpers).
 */
export interface Migration {
  readonly version: number
  readonly name: string
  up: (db: Database.Database) => void
}

/** PRAGMA table_info row shape (SQLite). */
export interface SqliteTableInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | number | null
  pk: number
}

/** Row from schema_migrations ledger. */
export interface SchemaMigrationRow {
  version: number
  name: string
  applied_at: number
}
