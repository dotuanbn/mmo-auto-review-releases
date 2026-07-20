import type Database from 'better-sqlite3'
import type { SqliteTableInfoRow } from './types'

/** Return column names for a table via PRAGMA table_info. */
export function getTableColumns(db: Database.Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as SqliteTableInfoRow[]
  return rows.map((row) => row.name)
}

/** True when the named column exists on the table. */
export function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  return getTableColumns(db, tableName).includes(columnName)
}

/**
 * ADD COLUMN only when missing. Safe for fresh DBs that already include the column
 * in CREATE TABLE and for older DBs that need ALTER.
 */
export function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDef: string
): boolean {
  if (hasColumn(db, tableName, columnName)) {
    return false
  }
  db.exec(`ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(columnName)} ${columnDef}`)
  return true
}

/** CREATE INDEX IF NOT EXISTS wrapper with logging-friendly return. */
export function ensureIndex(db: Database.Database, indexSql: string): void {
  db.exec(indexSql)
}

/**
 * Quote a simple SQL identifier. Rejects anything outside [A-Za-z0-9_].
 * Prevents injection when identifiers are composed from constants only.
 */
function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`)
  }
  return ident
}
