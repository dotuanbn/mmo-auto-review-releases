import type Database from 'better-sqlite3'
import { addColumnIfMissing, ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v8 — Review survival tracking columns on review_history.
 *
 * Adds columns to track whether a submitted review is still live on Google Maps
 * after 24h / 7d / 30d.  Also adds an optional google_review_id for future
 * matching and a style_applied flag to compare styled vs unstyled survival.
 *
 * Idempotent: fresh DBs already have columns from CREATE TABLE; old DBs get ALTER.
 */
function up(db: Database.Database): void {
  // Verification lifecycle columns
  addColumnIfMissing(db, 'review_history', 'verified_status', "TEXT DEFAULT 'pending'")
  addColumnIfMissing(db, 'review_history', 'verified_at', 'INTEGER')
  addColumnIfMissing(db, 'review_history', 'last_check_at', 'INTEGER')
  addColumnIfMissing(db, 'review_history', 'check_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'review_history', 'survival_days', 'INTEGER')

  // Optional external identifier for future matching
  addColumnIfMissing(db, 'review_history', 'google_review_id', 'TEXT')

  // Track whether per-account style pipeline was applied for A/B analytics
  addColumnIfMissing(db, 'review_history', 'style_applied', 'INTEGER NOT NULL DEFAULT 0')

  ensureReviewVerificationIndexes(db)
}

function ensureReviewVerificationIndexes(db: Database.Database): void {
  // Verification queue scan: successful reviews pending or due for re-check
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_review_history_verified_status ON review_history(verified_status, status)'
  )
  // Survival analytics: group by style_applied for A/B comparison
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_review_history_style_applied ON review_history(style_applied, verified_status)'
  )
}

export const migration008ReviewVerification: Migration = {
  version: 8,
  name: 'review_verification',
  up,
}
