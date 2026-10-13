import type Database from 'better-sqlite3'
import { addColumnIfMissing } from './helpers'
import type { Migration } from './types'

/**
 * v7 — Add behavior_profile column to accounts table.
 * This JSON column stores per-account behavior profiles for anti-detection.
 * Idempotent: fresh DBs already have the column from CREATE TABLE; old DBs get ALTER.
 */
function up(db: Database.Database): void {
  addColumnIfMissing(db, 'accounts', 'behavior_profile', 'TEXT')
}

export const migration007BehaviorProfile: Migration = {
  version: 7,
  name: 'behavior_profile',
  up,
}
