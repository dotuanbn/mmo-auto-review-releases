import type Database from 'better-sqlite3'
import { addColumnIfMissing, ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v2 — Web SEO quality columns on traffic_campaigns / traffic_logs + indexes.
 * Idempotent: fresh DBs already have columns from CREATE TABLE; old DBs get ALTER.
 */
function up(db: Database.Database): void {
  addTrafficCampaignWebSeoColumns(db)
  addTrafficLogQualityColumns(db)
  ensureTrafficLogIndexes(db)
}

function addTrafficCampaignWebSeoColumns(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'traffic_campaigns',
    'web_seo_min_dwell_seconds',
    'INTEGER NOT NULL DEFAULT 45'
  )
  addColumnIfMissing(
    db,
    'traffic_campaigns',
    'web_seo_max_dwell_seconds',
    'INTEGER NOT NULL DEFAULT 90'
  )
  addColumnIfMissing(
    db,
    'traffic_campaigns',
    'web_seo_require_organic',
    'INTEGER NOT NULL DEFAULT 0'
  )
}

function addTrafficLogQualityColumns(db: Database.Database): void {
  addColumnIfMissing(db, 'traffic_logs', 'discovery_source', 'TEXT')
  addColumnIfMissing(db, 'traffic_logs', 'quality_score', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'traffic_logs', 'countable', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'traffic_logs', 'target_host', 'TEXT')
}

function ensureTrafficLogIndexes(db: Database.Database): void {
  // Daily traffic exposure by account: WHERE account_id = ? AND created_at >= ?
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_traffic_logs_account_created ON traffic_logs(account_id, created_at)'
  )
  // Campaign countable visits over time
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_traffic_logs_campaign_countable ON traffic_logs(campaign_id, countable, created_at)'
  )
}

export const migration002WebSeoQuality: Migration = {
  version: 2,
  name: 'web_seo_quality',
  up,
}
