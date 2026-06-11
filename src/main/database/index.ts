import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import * as schema from './schema'

let db: ReturnType<typeof drizzle> | null = null
let sqlite: Database.Database | null = null

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

// Initialize the database connection
export function initDatabase() {
  if (db) return db

  const dbPath = getDatabasePath()
  console.log('Database path:', dbPath)

  sqlite = new Database(dbPath)
  db = drizzle(sqlite, { schema })

  // Create tables if they don't exist
  createTables()

  // Insert default settings
  insertDefaultSettings()

  return db
}

// Get the database instance
export function getDatabase() {
  if (!db) {
    return initDatabase()
  }
  return db
}

// Close database connection
export function closeDatabase() {
  if (sqlite) {
    sqlite.close()
    sqlite = null
    db = null
  }
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
      warmup_history TEXT
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
      account_ids TEXT NOT NULL,
      location_ids TEXT NOT NULL,
      threads_count INTEGER NOT NULL DEFAULT 1,
      visits_per_location INTEGER NOT NULL DEFAULT 10,
      delay_min_seconds INTEGER NOT NULL DEFAULT 10,
      delay_max_seconds INTEGER NOT NULL DEFAULT 30,
      actions_per_visit INTEGER NOT NULL DEFAULT 4,
      fixed_action_count INTEGER NOT NULL DEFAULT 0,
      enabled_actions TEXT,
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
      last_check INTEGER,
      response_time INTEGER,
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

  console.log('Database tables created successfully')

  // Run migrations for existing database
  runMigrations()
}

// Run migrations for existing databases
function runMigrations() {
  if (!sqlite) return

  try {
    // Check if project_id column exists in locations
    const locationsInfo = sqlite.prepare("PRAGMA table_info(locations)").all() as any[]
    const hasLocationProjectId = locationsInfo.some((col: any) => col.name === 'project_id')

    if (!hasLocationProjectId) {
      console.log('Migration: Adding project_id to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN project_id INTEGER REFERENCES projects(id)')
    }

    // Check if project_id column exists in campaigns
    const campaignsInfo = sqlite.prepare("PRAGMA table_info(campaigns)").all() as any[]
    const hasCampaignProjectId = campaignsInfo.some((col: any) => col.name === 'project_id')

    if (!hasCampaignProjectId) {
      console.log('Migration: Adding project_id to campaigns table')
      sqlite.exec('ALTER TABLE campaigns ADD COLUMN project_id INTEGER REFERENCES projects(id)')
    }

    // Check if project_id column exists in traffic_tasks
    const trafficInfo = sqlite.prepare("PRAGMA table_info(traffic_tasks)").all() as any[]
    const hasTrafficProjectId = trafficInfo.some((col: any) => col.name === 'project_id')

    if (!hasTrafficProjectId) {
      console.log('Migration: Adding project_id to traffic_tasks table')
      sqlite.exec('ALTER TABLE traffic_tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)')
    }

    // Account table migrations for Phase A features
    const accountsInfo = sqlite.prepare("PRAGMA table_info(accounts)").all() as any[]

    // Add login_type column
    if (!accountsInfo.some((col: any) => col.name === 'login_type')) {
      console.log('Migration: Adding login_type to accounts table')
      sqlite.exec("ALTER TABLE accounts ADD COLUMN login_type TEXT NOT NULL DEFAULT 'auto'")
    }

    // Add two_factor_secret column
    if (!accountsInfo.some((col: any) => col.name === 'two_factor_secret')) {
      console.log('Migration: Adding two_factor_secret to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN two_factor_secret TEXT')
    }

    // Add fingerprint_id column
    if (!accountsInfo.some((col: any) => col.name === 'fingerprint_id')) {
      console.log('Migration: Adding fingerprint_id to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN fingerprint_id TEXT')
    }

    // Add last_check_at column
    if (!accountsInfo.some((col: any) => col.name === 'last_check_at')) {
      console.log('Migration: Adding last_check_at to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN last_check_at INTEGER')
    }

    // Phase 2 - Anti-Detection Warmup & Reputation fields
    if (!accountsInfo.some((col: any) => col.name === 'first_review_date')) {
      console.log('Migration: Adding first_review_date to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN first_review_date INTEGER')
    }
    if (!accountsInfo.some((col: any) => col.name === 'last_review_date')) {
      console.log('Migration: Adding last_review_date to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN last_review_date INTEGER')
    }
    if (!accountsInfo.some((col: any) => col.name === 'warmup_level')) {
      console.log('Migration: Adding warmup_level to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN warmup_level INTEGER NOT NULL DEFAULT 0')
    }
    if (!accountsInfo.some((col: any) => col.name === 'reputation_score')) {
      console.log('Migration: Adding reputation_score to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN reputation_score INTEGER NOT NULL DEFAULT 0')
    }
    if (!accountsInfo.some((col: any) => col.name === 'warmup_history')) {
      console.log('Migration: Adding warmup_history to accounts table')
      sqlite.exec('ALTER TABLE accounts ADD COLUMN warmup_history TEXT')
    }

    // Proxy table migrations for health-check metadata
    const proxiesInfo = sqlite.prepare("PRAGMA table_info(proxies)").all() as any[]
    if (!proxiesInfo.some((col: any) => col.name === 'last_check')) {
      console.log('Migration: Adding last_check to proxies table')
      sqlite.exec('ALTER TABLE proxies ADD COLUMN last_check INTEGER')
    }
    if (!proxiesInfo.some((col: any) => col.name === 'response_time')) {
      console.log('Migration: Adding response_time to proxies table')
      sqlite.exec('ALTER TABLE proxies ADD COLUMN response_time INTEGER')
    }
    if (!proxiesInfo.some((col: any) => col.name === 'provider')) {
      console.log('Migration: Adding provider to proxies table (DataImpulse / Smartproxy / etc. support)')
      sqlite.exec('ALTER TABLE proxies ADD COLUMN provider TEXT')
    }

    // Add search_keywords column to locations for organic search
    if (!locationsInfo.some((col: any) => col.name === 'search_keywords')) {
      console.log('Migration: Adding search_keywords to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN search_keywords TEXT')
    }

    // Add traffic_mode and search_keywords columns to traffic_campaigns
    const tcInfo = sqlite.prepare('PRAGMA table_info(traffic_campaigns)').all() as any[]
    if (!tcInfo.some((col: any) => col.name === 'traffic_mode')) {
      console.log('Migration: Adding traffic_mode to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN traffic_mode TEXT NOT NULL DEFAULT 'direct'")
    }
    if (!tcInfo.some((col: any) => col.name === 'search_keywords')) {
      console.log('Migration: Adding search_keywords to traffic_campaigns table')
      sqlite.exec('ALTER TABLE traffic_campaigns ADD COLUMN search_keywords TEXT')
    }
    if (!tcInfo.some((col: any) => col.name === 'fixed_action_count')) {
      console.log('Migration: Adding fixed_action_count to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN fixed_action_count INTEGER NOT NULL DEFAULT 0")
    }
    if (!tcInfo.some((col: any) => col.name === 'target_kpi')) {
      console.log('Migration: Adding target_kpi to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN target_kpi TEXT")
    }
    if (!tcInfo.some((col: any) => col.name === 'ai_auto_control')) {
      console.log('Migration: Adding ai_auto_control to traffic_campaigns table')
      sqlite.exec("ALTER TABLE traffic_campaigns ADD COLUMN ai_auto_control INTEGER NOT NULL DEFAULT 0")
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
    const locInfoMigrate = sqlite.prepare("PRAGMA table_info(locations)").all() as any[]
    if (!locInfoMigrate.some((col: any) => col.name === 'analytics_mode')) {
      console.log('Migration: Adding analytics_mode to locations table')
      sqlite.exec("ALTER TABLE locations ADD COLUMN analytics_mode TEXT DEFAULT 'none'")
    }
    if (!locInfoMigrate.some((col: any) => col.name === 'ga4_property_id')) {
      console.log('Migration: Adding ga4_property_id to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN ga4_property_id TEXT')
    }
    if (!locInfoMigrate.some((col: any) => col.name === 'gsc_site_url')) {
      console.log('Migration: Adding gsc_site_url to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN gsc_site_url TEXT')
    }
    if (!locInfoMigrate.some((col: any) => col.name === 'analytics_google_email')) {
      console.log('Migration: Adding analytics_google_email to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN analytics_google_email TEXT')
    }
    if (!locInfoMigrate.some((col: any) => col.name === 'phone')) {
      console.log('Migration: Adding phone to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN phone TEXT')
    }
    if (!locInfoMigrate.some((col: any) => col.name === 'website')) {
      console.log('Migration: Adding website to locations table')
      sqlite.exec('ALTER TABLE locations ADD COLUMN website TEXT')
    }

    console.log('Database migrations completed')
  } catch (error) {
    console.error('Migration error:', error)
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
