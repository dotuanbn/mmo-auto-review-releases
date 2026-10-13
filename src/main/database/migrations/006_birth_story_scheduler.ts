import type Database from 'better-sqlite3'
import { addColumnIfMissing, ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v6 — Birth-story scheduler + auto-warmup flags on accounts.
 * Idempotent: fresh DBs already have columns from CREATE TABLE; old DBs get ALTER.
 */
export const BIRTH_STORY_ACCOUNT_COLUMNS = [
  'birth_story_day',
  'birth_story_start_date',
  'birth_story_completed',
  'auto_warmup_enabled',
] as const

function up(db: Database.Database): void {
  addBirthStorySchedulerColumns(db)
  ensureBirthStorySchedulerIndexes(db)
}

function addBirthStorySchedulerColumns(db: Database.Database): void {
  addColumnIfMissing(db, 'accounts', 'birth_story_day', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'accounts', 'birth_story_start_date', 'INTEGER')
  addColumnIfMissing(db, 'accounts', 'birth_story_completed', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'accounts', 'auto_warmup_enabled', 'INTEGER NOT NULL DEFAULT 0')
}

function ensureBirthStorySchedulerIndexes(db: Database.Database): void {
  // Scheduler due-scan: WHERE auto_warmup_enabled = 1 AND status = ?
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_accounts_auto_warmup_enabled ON accounts(auto_warmup_enabled, status)'
  )
}

export const migration006BirthStoryScheduler: Migration = {
  version: 6,
  name: 'birth_story_scheduler',
  up,
}
