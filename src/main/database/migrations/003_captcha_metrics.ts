import type Database from 'better-sqlite3'
import { ensureIndex } from './helpers'
import type { Migration } from './types'

/**
 * v3 — Durable CAPTCHA solve metrics table + indexes.
 * Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 * Never stores secrets, tokens, sitekeys, or API keys.
 */
function up(db: Database.Database): void {
  createCaptchaMetricsTable(db)
  ensureCaptchaMetricsIndexes(db)
}

function createCaptchaMetricsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS captcha_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captcha_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)
}

function ensureCaptchaMetricsIndexes(db: Database.Database): void {
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_captcha_metrics_created ON captcha_metrics(created_at DESC)'
  )
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_captcha_metrics_type_created ON captcha_metrics(captcha_type, created_at DESC)'
  )
  ensureIndex(
    db,
    'CREATE INDEX IF NOT EXISTS idx_captcha_metrics_provider_created ON captcha_metrics(provider, created_at DESC)'
  )
}

export const migration003CaptchaMetrics: Migration = {
  version: 3,
  name: 'captcha_metrics',
  up,
}
