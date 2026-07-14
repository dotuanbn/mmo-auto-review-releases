import type Database from 'better-sqlite3'
import { addColumnIfMissing, ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v1 — Account review-style profile + warmup scheduling columns and indexes.
 * Idempotent: fresh DBs already have columns from CREATE TABLE; old DBs get ALTER.
 */
function up(db: Database.Database): void {
  addAccountWarmupColumns(db)
  ensureWarmupSchedulingIndexes(db)
}

function addAccountWarmupColumns(db: Database.Database): void {
  addColumnIfMissing(db, 'accounts', 'review_style_profile', 'TEXT')
  addColumnIfMissing(db, 'accounts', 'review_style_seed', 'TEXT')
  addColumnIfMissing(db, 'accounts', 'last_warmup_at', 'INTEGER')
  addColumnIfMissing(db, 'accounts', 'next_warmup_at', 'INTEGER')
  addColumnIfMissing(db, 'accounts', 'warmup_sessions', 'INTEGER NOT NULL DEFAULT 0')
}

function ensureWarmupSchedulingIndexes(db: Database.Database): void {
  // Due-for-warmup queries: WHERE next_warmup_at IS NOT NULL AND next_warmup_at <= ?
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_accounts_next_warmup_at ON accounts(next_warmup_at)'
  )
  // Active accounts due for warmup: WHERE status = ? AND next_warmup_at <= ?
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_accounts_status_next_warmup ON accounts(status, next_warmup_at)'
  )
  // Recent warmup history lookups
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_accounts_last_warmup_at ON accounts(last_warmup_at)'
  )
}

export const migration001AccountsWarmupStyle: Migration = {
  version: 1,
  name: 'accounts_warmup_style',
  up,
}
