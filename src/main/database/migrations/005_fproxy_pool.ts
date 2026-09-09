import type Database from 'better-sqlite3'
import { ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v5 — Encrypted multi-key FProxy pool.
 *
 * Runtime health, endpoint credentials, and active leases remain in memory.
 * Only encrypted API-key material and operator-managed slot metadata are durable.
 */
export const FPROXY_KEYS_COLUMNS = [
  'id',
  'label',
  'api_key_ciphertext',
  'enabled',
  'created_at',
  'updated_at',
] as const

export const FPROXY_KEYS_DDL = `
  CREATE TABLE IF NOT EXISTS fproxy_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    api_key_ciphertext TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )
`

export const FPROXY_KEYS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_fproxy_keys_enabled ON fproxy_keys(enabled)',
] as const

export function ensureFproxyPoolSchema(db: Database.Database): void {
  db.exec(FPROXY_KEYS_DDL)
  for (const sql of FPROXY_KEYS_INDEX_SQL) {
    ensureIndex(db, sql)
  }
}

export const migration005FproxyPool: Migration = {
  version: 5,
  name: 'fproxy_pool',
  up: ensureFproxyPoolSchema,
}
