import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs'
import * as schema from './schema'
import { runVersionedMigrations, type SqliteTableInfoRow } from './migrations'
import { ensureFproxyPoolSchema } from './migrations/005_fproxy_pool'

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>

/** Max retained pre-migration snapshots under data/backups (newest kept). */
const MAX_PRE_MIGRATE_BACKUPS = 3

/** SQLite busy_timeout (ms) for brief lock waits in single-process Electron. */
const SQLITE_BUSY_TIMEOUT_MS = 5000
/** Passive WAL checkpoint interval. Keeps the WAL from growing without blocking writers. */
const WAL_CHECKPOINT_INTERVAL_MS = 3_600_000
/** Retention sweep interval for traffic_logs and traffic_visit_queue. */
const DATA_PURGE_INTERVAL_MS = 86_400_000
const DEFAULT_DATA_RETENTION_DAYS = 30
const MS_PER_DAY = 86_400_000

let db: AppDatabase | null = null
let sqlite: Database.Database | null = null
/** Sync re-entrancy guard: prevents a second open while init is mid-flight. */
let initInProgress = false
let walCheckpointTimer: ReturnType<typeof setInterval> | null = null
let dataPurgeTimer: ReturnType<typeof setInterval> | null = null

// Get the path to the database file
function getDatabasePath(): string {
  const userDataPath = app.getPath('userData')
  const dbFolder = join(userDataPath, 'data')

  // Create the data folder if it doesn't exist
  if (!existsSync(dbFolder)) {
    mkdirSync(dbFolder, { recursive: true })
  }

  return join(dbFolder, 'mmo-review.db')
}

function getBackupsDir(dbPath: string): string {
  return join(dbPath, '..', 'backups')
}

/**
 * Close a sqlite handle (best-effort) and clear module singletons so the next
 * initDatabase/getDatabase call can retry from a clean state.
 */
function resetDatabaseHandles(handle: Database.Database | null = sqlite): void {
  const toClose = handle ?? sqlite
  if (toClose) {
    try {
      toClose.close()
    } catch (closeError) {
      console.error('Failed to close database handle during reset:', closeError)
    }
  }
  sqlite = null
  db = null
}

/** WAL + busy_timeout: safe for better-sqlite3 / Electron main single process. */
function applyConnectionPragmas(handle: Database.Database): void {
  handle.pragma('journal_mode = WAL')
  handle.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
}

/**
 * Fail-closed integrity gate before any migrations mutate schema/data.
 */
function assertDatabaseIntegrity(handle: Database.Database): void {
  const rows = handle.prepare('PRAGMA integrity_check').all() as Array<
    Record<string, unknown>
  >
  const messages = rows.map((row) => String(Object.values(row)[0] ?? ''))
  if (messages.length !== 1 || messages[0] !== 'ok') {
    const detail = messages.join('; ') || 'empty result'
    throw new Error(`SQLite integrity_check failed (fail-closed): ${detail}`)
  }
}

function listPreMigrateBackups(backupsDir: string): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(backupsDir)) return []

  return readdirSync(backupsDir)
    .filter((name) => name.startsWith('mmo-review.pre-migrate.') && name.endsWith('.db'))
    .map((name) => {
      const path = join(backupsDir, name)
      return { path, mtimeMs: statSync(path).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Keep newest MAX_PRE_MIGRATE_BACKUPS; delete older snapshot files. */
function retainMaxPreMigrateBackups(backupsDir: string): void {
  const ranked = listPreMigrateBackups(backupsDir)
  for (const stale of ranked.slice(MAX_PRE_MIGRATE_BACKUPS)) {
    unlinkSync(stale.path)
  }
}

/**
 * Pre-migration snapshot of an existing DB file into data/backups.
 * - Not used for brand-new empty DBs
 * - Unique destination (no overwrite)
 * - Retain max 3
 * - Disk errors fail-closed
 */
function createPreMigrationSnapshot(dbPath: string): void {
  try {
    const backupsDir = getBackupsDir(dbPath)
    if (!existsSync(backupsDir)) {
      mkdirSync(backupsDir, { recursive: true })
    }

    const stamp = `${Date.now()}-${process.pid}`
    const dest = join(backupsDir, `mmo-review.pre-migrate.${stamp}.db`)
    if (existsSync(dest)) {
      throw new Error(`backup destination already exists: ${dest}`)
    }

    // Checkpoint first so the main file is a consistent on-disk image under WAL.
    if (sqlite) {
      sqlite.pragma('wal_checkpoint(TRUNCATE)')
    }
    copyFileSync(dbPath, dest)
    retainMaxPreMigrateBackups(backupsDir)
    console.log('Pre-migration DB snapshot:', dest)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Pre-migration snapshot failed (fail-closed): ${message}`)
  }
}

// Initialize the database connection
// Boot order: re-entrancy guard → open → WAL/busy_timeout → integrity_check →
// (optional pre-migration snapshot if DB existed) → tables/legacy/versioned
// migrations → default settings → publish singleton.
// Fail-closed: only publish after the full pipeline succeeds; on error close
// the handle, clear cache, and rethrow so the next call can retry cleanly.
export function initDatabase(): AppDatabase {
  if (db) return db

  if (initInProgress) {
    throw new Error(
      'Database initialization already in progress (re-entrancy guard)'
    )
  }

  initInProgress = true
  let opened: Database.Database | null = null

  try {
    const dbPath = getDatabasePath()
    const dbExistedBeforeOpen = existsSync(dbPath)
    console.log('Database path:', dbPath)

    opened = new Database(dbPath)
    // Expose raw handle for createTables / migrations only — drizzle singleton
    // is published after the full pipeline succeeds.
    sqlite = opened

    applyConnectionPragmas(opened)
    assertDatabaseIntegrity(opened)

    // Snapshot only when a prior file existed (never snapshot a brand-new empty DB).
    if (dbExistedBeforeOpen) {
      createPreMigrationSnapshot(dbPath)
    }

    const pendingDb = drizzle(opened, { schema })

    // Create tables if they don't exist (+ legacy + versioned migrations)
    createTables()

    // Insert default settings
    insertDefaultSettings()

    db = pendingDb
    startDatabaseMaintenance()
    return db
  } catch (error) {
    console.error('Database initialization failed (fail-closed):', error)
    stopDatabaseMaintenance()
    resetDatabaseHandles(opened)
    throw error
  } finally {
    initInProgress = false
  }
}

// Get the database instance
export function getDatabase(): AppDatabase {
  if (!db) {
    return initDatabase()
  }
  return db
}

// Close database connection
export function closeDatabase(): void {
  stopDatabaseMaintenance()
  resetDatabaseHandles(sqlite)
}

function startDatabaseMaintenance(): void {
  stopDatabaseMaintenance()
  walCheckpointTimer = setInterval(() => {
    try {
      sqlite?.pragma('wal_checkpoint(PASSIVE)')
    } catch {
      // DB may already be closed
    }
  }, WAL_CHECKPOINT_INTERVAL_MS)

  dataPurgeTimer = setInterval(() => {
    try {
      purgeOldData()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Periodic purgeOldData failed: ${message}`)
    }
  }, DATA_PURGE_INTERVAL_MS)
}

function stopDatabaseMaintenance(): void {
  if (walCheckpointTimer) {
    clearInterval(walCheckpointTimer)
    walCheckpointTimer = null
  }
  if (dataPurgeTimer) {
    clearInterval(dataPurgeTimer)
    dataPurgeTimer = null
  }
}

function normalizeRetentionDays(retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`retentionDays must be a finite number >= 1, got ${String(retentionDays)}`)
  }
  return Math.floor(retentionDays)
}

/**
 * Delete traffic rows older than retentionDays.
 * traffic_logs.created_at is unix seconds (drizzle timestamp mode).
 * traffic_visit_queue.created_at is an ISO-8601 text timestamp.
 * Returns the number of rows removed across both tables.
 */
export function purgeOldData(retentionDays: number = DEFAULT_DATA_RETENTION_DAYS): number {
  const handle = sqlite
  if (!handle) return 0

  const days = normalizeRetentionDays(retentionDays)
  const cutoffMs = Date.now() - days * MS_PER_DAY
  const logCutoffSeconds = Math.floor(cutoffMs / 1000)
  const queueCutoffIso = new Date(cutoffMs).toISOString()

  const deleteLogs = handle.prepare('DELETE FROM traffic_logs WHERE created_at < ?')
  const deleteQueue = handle.prepare('DELETE FROM traffic_visit_queue WHERE created_at < ?')
  const deleted = handle.transaction(() => {
    return deleteLogs.run(logCutoffSeconds).changes + deleteQueue.run(queueCutoffIso).changes
  })()

  if (deleted > 0) {
    console.log(`Purged ${deleted} traffic rows older than ${days} days`)
  }
  return deleted
}

// Create tables manually (since we're not using migrations in dev)
function createTables() {
  if (!sqlite) return

  // Projects table (must be created first for foreign keys)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      icon TEXT NOT NULL DEFAULT 'folder',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Accounts table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      recovery_email TEXT,
      recovery_phone TEXT,
      login_type TEXT NOT NULL DEFAULT 'auto',
      cookies TEXT,
      profile_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_used INTEGER,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      -- Phase 2: Account Warmup & Reputation (Anti-Detection Strategy)
      first_review_date INTEGER,
      last_review_date INTEGER,
      warmup_level INTEGER NOT NULL DEFAULT 0,
      reputation_score INTEGER NOT NULL DEFAULT 0,
      warmup_history TEXT,
      -- Phase 2 extended: review style + warmup schedule
      review_style_profile TEXT,
      review_style_seed TEXT,
      last_warmup_at INTEGER,
      next_warmup_at INTEGER,
      warmup_sessions INTEGER NOT NULL DEFAULT 0,
      -- Birth-story scheduler + auto-warmup
      birth_story_day INTEGER NOT NULL DEFAULT 0,
      birth_story_start_date INTEGER,
      birth_story_completed INTEGER NOT NULL DEFAULT 0,
      auto_warmup_enabled INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Version ledger for new migrations (CREATE also happens in runner for old DBs)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Proxies table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password TEXT,
      type TEXT NOT NULL DEFAULT 'http',
      country TEXT,
      provider TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_check INTEGER,
      response_time INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Encrypted multi-key FProxy pool (fresh DB parity with migration v5)
  ensureFproxyPoolSchema(sqlite)

  // Campaigns table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      location_ids TEXT NOT NULL,
      account_ids TEXT,
      proxy_ids TEXT,
      review_templates TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 5,
      delay_min INTEGER NOT NULL DEFAULT 30,
      delay_max INTEGER NOT NULL DEFAULT 120,
      max_reviews_per_day INTEGER NOT NULL DEFAULT 5,
      working_hours_start TEXT DEFAULT '08:00',
      working_hours_end TEXT DEFAULT '22:00',
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      success_reviews INTEGER NOT NULL DEFAULT 0,
      failed_reviews INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Review history table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS review_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER REFERENCES campaigns(id),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      proxy_id INTEGER REFERENCES proxies(id),
      rating INTEGER NOT NULL,
      review_text TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      screenshot TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Settings table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Traffic tasks table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS traffic_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      target_views INTEGER NOT NULL DEFAULT 1000,
      current_views INTEGER NOT NULL DEFAULT 0,
      views_per_day INTEGER NOT NULL DEFAULT 100,
      use_proxies INTEGER NOT NULL DEFAULT 1,
      proxy_ids TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Review Templates table (Spintax)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS review_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      is_active INTEGER NOT NULL DEFAULT 1,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Image Folders table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS image_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      image_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Campaign Schedules table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      scheduled_at INTEGER NOT NULL,
      repeat_type TEXT NOT NULL DEFAULT 'once',
      repeat_days TEXT,
      end_date INTEGER,
      last_run_at INTEGER,
      next_run_at INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Traffic Campaigns table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS traffic_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      traffic_mode TEXT NOT NULL DEFAULT 'direct',
      search_keywords TEXT,
      max_map_scroll INTEGER NOT NULL DEFAULT 15,
      account_ids TEXT NOT NULL,
      location_ids TEXT NOT NULL,
      threads_count INTEGER NOT NULL DEFAULT 1,
      visits_per_location INTEGER NOT NULL DEFAULT 10,
      delay_min_seconds INTEGER NOT NULL DEFAULT 10,
      delay_max_seconds INTEGER NOT NULL DEFAULT 30,
      actions_per_visit INTEGER NOT NULL DEFAULT 4,
      fixed_action_count INTEGER NOT NULL DEFAULT 0,
      enabled_actions TEXT,
      target_kpi TEXT,
      ai_auto_control INTEGER NOT NULL DEFAULT 0,
      web_seo_min_dwell_seconds INTEGER NOT NULL DEFAULT 45,
      web_seo_max_dwell_seconds INTEGER NOT NULL DEFAULT 90,
      web_seo_require_organic INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      total_visits INTEGER NOT NULL DEFAULT 0,
      completed_visits INTEGER NOT NULL DEFAULT 0,
      failed_visits INTEGER NOT NULL DEFAULT 0,
      current_round INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      started_at INTEGER,
      completed_at INTEGER
    )
  `)

  // Traffic Logs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS traffic_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES traffic_campaigns(id),
      account_id INTEGER REFERENCES accounts(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      actions TEXT NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      error_message TEXT,
      discovery_source TEXT,
      quality_score INTEGER NOT NULL DEFAULT 0,
      countable INTEGER NOT NULL DEFAULT 0,
      target_host TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Locations table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      place_id TEXT,
      address TEXT,
      url TEXT NOT NULL,
      cid TEXT,
      feature_hex TEXT,
      phone TEXT,
      website TEXT,
      category TEXT,
      target_rating INTEGER NOT NULL DEFAULT 5,
      target_reviews INTEGER NOT NULL DEFAULT 10,
      current_reviews INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)

  // Agent Knowledge table (Mini-RAG memory)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      campaign_type TEXT NOT NULL,
      campaign_id INTEGER,
      thread_id INTEGER,
      domain TEXT NOT NULL,
      goal TEXT NOT NULL,
      risk_type TEXT NOT NULL,
      signal_text TEXT NOT NULL,
      action TEXT NOT NULL,
      decision_source TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      detail TEXT,
      error TEXT,
      recover_path TEXT,
      latency_ms INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_domain_goal_risk_created ON agent_knowledge(domain, goal, risk_type, created_at DESC)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_campaign_thread_created ON agent_knowledge(campaign_id, thread_id, created_at DESC)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_expires ON agent_knowledge(expires_at)`)

  // Automation Scripts table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS automation_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '1.0.0',
      actions TEXT NOT NULL,
      variables TEXT,
      settings TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `)

  // AI Metrics table (Trackio performance monitoring)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      model_id TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'inference',
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL,
      memory_mb INTEGER,
      input_length INTEGER,
      output_length INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_ai_metrics_created ON ai_metrics(created_at DESC)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_ai_metrics_task ON ai_metrics(task, created_at DESC)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_locations_status ON locations(status)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status)`)

  // CAPTCHA solve metrics (no secrets/tokens)
  ensureCaptchaMetricsTable()

  // Durable review/automation job queue (fresh DB)
  ensureJobQueueTable()

  // Operations durability: traffic visit queue + compliance audit (fresh DB)
  ensureTrafficVisitQueueTable()
  ensureComplianceAuditTable()

  console.log('Database tables created successfully')

  // Legacy column/table backfills for existing databases (kept intact)
  runMigrations()

  // Versioned idempotent migrations (schema_migrations ledger)
  runVersionedMigrations(sqlite)
}

/** Idempotent CREATE + indexes for captcha_metrics (fresh and old DBs). */
function ensureCaptchaMetricsTable() {
  if (!sqlite) return

  sqlite.exec(`
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
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_captcha_metrics_created ON captcha_metrics(created_at DESC)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_captcha_metrics_type_created ON captcha_metrics(captcha_type, created_at DESC)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_captcha_metrics_provider_created ON captcha_metrics(provider, created_at DESC)`
  )
}

/** Idempotent CREATE + indexes for job_queue (fresh and old DBs). */
function ensureJobQueueTable() {
  if (!sqlite) return

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY NOT NULL,
      campaign_id INTEGER REFERENCES campaigns(id),
      type TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      review_text TEXT,
      rating INTEGER,
      target_views INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_campaign ON job_queue(campaign_id)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_account_status ON job_queue(account_id, status)`)
}

/**
 * Idempotent CREATE + unique/indexes for traffic_visit_queue (fresh and old DBs).
 * Parity with migrations/004_operations_durability.ts.
 */
function ensureTrafficVisitQueueTable() {
  if (!sqlite) return

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS traffic_visit_queue (
      id TEXT PRIMARY KEY NOT NULL,
      campaign_id INTEGER NOT NULL,
      visit_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      worker_id TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      available_at TEXT,
      last_error TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  sqlite.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_traffic_visit_campaign_index ON traffic_visit_queue(campaign_id, visit_index)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_status ON traffic_visit_queue(status)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_available ON traffic_visit_queue(available_at)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_lease ON traffic_visit_queue(lease_expires_at)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_traffic_visit_queue_campaign ON traffic_visit_queue(campaign_id)`
  )
}

/**
 * Idempotent CREATE + indexes for compliance_audit (fresh and old DBs).
 * Append-only audit trail; parity with migrations/004_operations_durability.ts.
 */
function ensureComplianceAuditTable() {
  if (!sqlite) return

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS compliance_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_compliance_audit_created ON compliance_audit(created_at DESC)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_compliance_audit_entity ON compliance_audit(entity_type, entity_id, created_at DESC)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_compliance_audit_action ON compliance_audit(action, created_at DESC)`
  )
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_compliance_audit_decision ON compliance_audit(decision, created_at DESC)`
  )
}

// Run migrations for existing databases.
// Fail-closed: errors are logged and rethrown so versioned migrations and
// singleton publish never proceed on a partially migrated schema.
function runMigrations(): void {
  if (!sqlite) return

  try {
    // Check if project_id column exists in locations
    const locationsInfo = sqlite.prepare("PRAGMA table_info(locations)").all() as SqliteTableInfoRow[]
    const hasLocationProjectId = locationsInfo.some((col) => col.name === 'project_id')

    if (!hasLocationProjectId) {
      console.log('Migration: Adding project_id to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN project_id INTEGER REFERENCES projects(id)')
    }

    // Check if project_id column exists in campaigns
    const campaignsInfo = sqlite.prepare("PRAGMA table_info(campaigns)").all() as SqliteTableInfoRow[]
    const hasCampaignProjectId = campaignsInfo.some((col) => col.name === 'project_id')

    if (!hasCampaignProjectId) {
      console.log('Migration: Adding project_id to campaigns table')
      sqlite.exec('ALTER TABLE campaigns ADD COLUMN project_id INTEGER REFERENCES projects(id)')
    }

    // Check if project_id column exists in traffic_tasks
    const trafficInfo = sqlite.prepare("PRAGMA table_info(traffic_tasks)").all() as SqliteTableInfoRow[]
    const hasTrafficProjectId = trafficInfo.some((col) => col.name === 'project_id')

    if (!hasTrafficProjectId) {
      console.log('Migration: Adding project_id to traffic_tasks table')
      sqlite.exec('ALTER TABLE traffic_tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)')
    }

    // Account table migrations for Phase A features
    const accountsInfo = sqlite.prepare("PRAGMA table_info(accounts)").all() as SqliteTableInfoRow[]

    // Add login_type column
    if (!accountsInfo.some((col) => col.name === 'login_type')) {
      console.log('Migration: Adding login_type to accounts table')
      sqlite.exec("ALTER TABLE accounts ADD COLUMN login_type TEXT NOT NULL DEFAULT 'auto'")
    }

    // Add two_factor_secret column
    if (!accountsInfo.some((col) => col.name === 'two_factor_secret')) {
      console.log('Migration: Adding two_factor_secret to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN two_factor_secret TEXT')
    }

    // Add fingerprint_id column
    if (!accountsInfo.some((col) => col.name === 'fingerprint_id')) {
      console.log('Migration: Adding fingerprint_id to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN fingerprint_id TEXT')
    }

    // Add last_check_at column
    if (!accountsInfo.some((col) => col.name === 'last_check_at')) {
      console.log('Migration: Adding last_check_at to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN last_check_at INTEGER')
    }

    // Phase 2 - Anti-Detection Warmup & Reputation fields
    if (!accountsInfo.some((col) => col.name === 'first_review_date')) {
      console.log('Migration: Adding first_review_date to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN first_review_date INTEGER')
    }
    if (!accountsInfo.some((col) => col.name === 'last_review_date')) {
      console.log('Migration: Adding last_review_date to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN last_review_date INTEGER')
    }
    if (!accountsInfo.some((col) => col.name === 'warmup_level')) {
      console.log('Migration: Adding warmup_level to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN warmup_level INTEGER NOT NULL DEFAULT 0')
    }
    if (!accountsInfo.some((col) => col.name === 'reputation_score')) {
      console.log('Migration: Adding reputation_score to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN reputation_score INTEGER NOT NULL DEFAULT 0')
    }
    if (!accountsInfo.some((col) => col.name === 'warmup_history')) {
      console.log('Migration: Adding warmup_history to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN warmup_history TEXT')
    }

    // Proxy table migrations for health-check metadata
    const proxiesInfo = sqlite.prepare("PRAGMA table_info(proxies)").all() as SqliteTableInfoRow[]
    if (!proxiesInfo.some((col) => col.name === 'last_check')) {
      console.log('Migration: Adding last_check to proxies table')
      sqlite.exec('ALTER TABLE proxies ADD COLUMN last_check INTEGER')
    }
    if (!proxiesInfo.some((col) => col.name === 'response_time')) {
      console.log('Migration: Adding response_time to proxies table')
      sqlite.exec('ALTER TABLE proxies ADD COLUMN response_time INTEGER')
    }
    if (!proxiesInfo.some((col) => col.name === 'provider')) {
      console.log('Migration: Adding provider to proxies table (DataImpulse / Smartproxy / etc. support)')
      sqlite.exec('ALTER TABLE proxies ADD COLUMN provider TEXT')
    }

    // Add search_keywords column to locations for organic search
    if (!locationsInfo.some((col) => col.name === 'search_keywords')) {
      console.log('Migration: Adding search_keywords to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN search_keywords TEXT')
    }

    // Add traffic_mode and search_keywords columns to traffic_campaigns
    const tcInfo = sqlite.prepare('PRAGMA table_info(traffic_campaigns)').all() as SqliteTableInfoRow[]
    if (!tcInfo.some((col) => col.name === 'traffic_mode')) {
      console.log('Migration: Adding traffic_mode to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN traffic_mode TEXT NOT NULL DEFAULT 'direct'")
    }
    if (!tcInfo.some((col) => col.name === 'search_keywords')) {
      console.log('Migration: Adding search_keywords to traffic_campaigns table')
      sqlite.exec('ALTER TABLE traffic_campaigns ADD COLUMN search_keywords TEXT')
    }
    if (!tcInfo.some((col) => col.name === 'fixed_action_count')) {
      console.log('Migration: Adding fixed_action_count to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN fixed_action_count INTEGER NOT NULL DEFAULT 0")
    }
    if (!tcInfo.some((col) => col.name === 'target_kpi')) {
      console.log('Migration: Adding target_kpi to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN target_kpi TEXT")
    }
    if (!tcInfo.some((col) => col.name === 'ai_auto_control')) {
      console.log('Migration: Adding ai_auto_control to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN ai_auto_control INTEGER NOT NULL DEFAULT 0")
    }
    if (!tcInfo.some((col) => col.name === 'max_map_scroll')) {
      console.log('Migration: Adding max_map_scroll to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN max_map_scroll INTEGER NOT NULL DEFAULT 15")
    }

    // Agent knowledge table migration + indexes
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signature TEXT NOT NULL UNIQUE,
        campaign_type TEXT NOT NULL,
        campaign_id INTEGER,
        thread_id INTEGER,
        domain TEXT NOT NULL,
        goal TEXT NOT NULL,
        risk_type TEXT NOT NULL,
        signal_text TEXT NOT NULL,
        action TEXT NOT NULL,
        decision_source TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        detail TEXT,
        error TEXT,
        recover_path TEXT,
        latency_ms INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        expires_at INTEGER
      )
    `)
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_domain_goal_risk_created ON agent_knowledge(domain, goal, risk_type, created_at DESC)`)
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_campaign_thread_created ON agent_knowledge(campaign_id, thread_id, created_at DESC)`)
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_knowledge_expires ON agent_knowledge(expires_at)`)

    // Analytics Snapshots table
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS analytics_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id INTEGER NOT NULL REFERENCES locations(id),
        source TEXT NOT NULL,
        sessions INTEGER,
        users INTEGER,
        pageviews INTEGER,
        bounce_rate REAL,
        avg_session_duration REAL,
        impressions INTEGER,
        clicks INTEGER,
        ctr REAL,
        avg_position REAL,
        top_queries TEXT,
        gbp_interactions INTEGER,
        gbp_calls INTEGER,
        gbp_directions INTEGER,
        gbp_website_clicks INTEGER,
        review_count INTEGER,
        avg_rating REAL,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        raw_data TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `)
    sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_location_source ON analytics_snapshots(location_id, source, created_at DESC)`)

    // Add analytics columns to locations table
    const locInfoMigrate = sqlite.prepare("PRAGMA table_info(locations)").all() as SqliteTableInfoRow[]
    if (!locInfoMigrate.some((col) => col.name === 'analytics_mode')) {
      console.log('Migration: Adding analytics_mode to locations table')
      sqlite.exec("ALTER TABLE locations ADD COLUMN analytics_mode TEXT DEFAULT 'none'")
    }
    if (!locInfoMigrate.some((col) => col.name === 'ga4_property_id')) {
      console.log('Migration: Adding ga4_property_id to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN ga4_property_id TEXT')
    }
    if (!locInfoMigrate.some((col) => col.name === 'gsc_site_url')) {
      console.log('Migration: Adding gsc_site_url to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN gsc_site_url TEXT')
    }
    if (!locInfoMigrate.some((col) => col.name === 'analytics_google_email')) {
      console.log('Migration: Adding analytics_google_email to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN analytics_google_email TEXT')
    }
    if (!locInfoMigrate.some((col) => col.name === 'phone')) {
      console.log('Migration: Adding phone to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN phone TEXT')
    }
    if (!locInfoMigrate.some((col) => col.name === 'website')) {
      console.log('Migration: Adding website to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN website TEXT')
    }

    // Strong map identity columns for target verification (placeId already existed; add cid + feature_hex)
    const locInfo2 = sqlite.prepare("PRAGMA table_info(locations)").all() as SqliteTableInfoRow[]
    if (!locInfo2.some((col) => col.name === 'cid')) {
      console.log('Migration: Adding cid to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN cid TEXT')
    }
    if (!locInfo2.some((col) => col.name === 'feature_hex')) {
      console.log('Migration: Adding feature_hex to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN feature_hex TEXT')
    }

    // Durable job_queue (idempotent for existing DBs)
    ensureJobQueueTable()
    console.log('Migration: ensured job_queue table')

    // Operations durability tables (idempotent; versioned migration v4 also applies)
    ensureTrafficVisitQueueTable()
    ensureComplianceAuditTable()
    console.log('Migration: ensured traffic_visit_queue + compliance_audit tables')

    console.log('Database migrations completed')
  } catch (error) {
    console.error('Migration error:', error)
    // Fail-closed: do not continue to versioned migrations or publish singleton
    throw error
  }
}

// Insert default settings
function insertDefaultSettings() {
  if (!sqlite) return

  const userDataPath = app.getPath('userData')
  const defaults = [
    { key: 'headless', value: 'true' },
    { key: 'delay_min', value: '30' },
    { key: 'delay_max', value: '120' },
    { key: 'max_reviews_per_day', value: '5' },
    { key: 'profiles_path', value: join(userDataPath, 'profiles') },
    { key: 'screenshots_path', value: join(userDataPath, 'screenshots') },
    { key: 'theme', value: 'dark' },
    { key: 'notifications', value: 'true' },
  ]

  const stmt = sqlite.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `)

  for (const setting of defaults) {
    stmt.run(setting.key, setting.value)
  }
}

export { schema }
