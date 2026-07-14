import type Database from 'better-sqlite3'
import { migrations } from './registry'
import type { SchemaMigrationRow } from './types'

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )
`

/**
 * Ensure the ledger table exists, then apply any unapplied versioned migrations
 * in ascending version order. Each migration runs inside a transaction with the
 * ledger insert so partial applies cannot leave an untracked state.
 *
 * Idempotent: re-running is a no-op once all versions are recorded.
 * Does not replace legacy runMigrations — call after that path.
 */
export function runVersionedMigrations(db: Database.Database): void {
  ensureSchemaMigrationsTable(db)

  const applied = loadAppliedVersions(db)
  const pending = migrations
    .slice()
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version))

  if (pending.length === 0) {
    console.log('Versioned migrations: all up to date')
    return
  }

  for (const migration of pending) {
    applyOne(db, migration.version, migration.name, migration.up)
  }

  console.log(`Versioned migrations: applied ${pending.length} migration(s)`)
}

function ensureSchemaMigrationsTable(db: Database.Database): void {
  db.exec(SCHEMA_MIGRATIONS_DDL)
}

function loadAppliedVersions(db: Database.Database): Set<number> {
  const rows = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations')
    .all() as SchemaMigrationRow[]
  return new Set(rows.map((row) => row.version))
}

function applyOne(
  db: Database.Database,
  version: number,
  name: string,
  up: (database: Database.Database) => void
): void {
  const apply = db.transaction(() => {
    console.log(`Versioned migration: applying v${version} (${name})`)
    up(db)
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, strftime(\'%s\', \'now\'))'
    ).run(version, name)
  })
  apply()
  console.log(`Versioned migration: applied v${version} (${name})`)
}
