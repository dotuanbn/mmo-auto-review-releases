import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Projects table - Organize campaigns and traffic tasks
export const projects = sqliteTable('projects', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').default('#3b82f6').notNull(), // For UI display
    icon: text('icon').default('folder').notNull(), // Icon name
    status: text('status', { enum: ['active', 'archived', 'completed'] }).default('active').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
})

// Accounts table - Google accounts for reviewing
export const accounts = sqliteTable('accounts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull().unique(),
    password: text('password').notNull(),
    recoveryEmail: text('recovery_email'),
    recoveryPhone: text('recovery_phone'),
    loginType: text('login_type', { enum: ['auto', 'manual'] }).default('auto').notNull(),
    twoFactorSecret: text('two_factor_secret'), // TOTP secret for 2FA
    cookies: text('cookies'), // JSON string of cookies
    profilePath: text('profile_path'),
    fingerprintId: text('fingerprint_id'), // Link to saved fingerprint config
    status: text('status', { enum: ['active', 'banned', 'pending', 'suspended', 'checking'] }).default('pending').notNull(),
    lastUsed: integer('last_used', { mode: 'timestamp' }),
    lastCheckAt: integer('last_check_at', { mode: 'timestamp' }), // Last live/die check
    totalReviews: integer('total_reviews').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),

    // Phase 2 - Account Warmup & Reputation (Anti-Detection Strategy)
    firstReviewDate: integer('first_review_date', { mode: 'timestamp' }),
    lastReviewDate: integer('last_review_date', { mode: 'timestamp' }),
    warmupLevel: integer('warmup_level').default(0).notNull(), // 0-100
    reputationScore: integer('reputation_score').default(0).notNull(), // internal score (can be scaled)
    warmupHistory: text('warmup_history'), // JSON blob of simulated safe activities

    // Phase 2 extended - per-account review style + warmup schedule
    reviewStyleProfile: text('review_style_profile'), // JSON style profile for content variation
    reviewStyleSeed: text('review_style_seed'), // stable seed for style generation
    behaviorProfile: text('behavior_profile'), // JSON behavior profile (nullable)
    lastWarmupAt: integer('last_warmup_at', { mode: 'timestamp' }),
    nextWarmupAt: integer('next_warmup_at', { mode: 'timestamp' }),
    warmupSessions: integer('warmup_sessions').default(0).notNull(),

    // Birth-story scheduler + auto-warmup
    birthStoryDay: integer('birth_story_day').default(0).notNull(),
    birthStoryStartDate: integer('birth_story_start_date', { mode: 'timestamp' }),
    birthStoryCompleted: integer('birth_story_completed', { mode: 'boolean' }).default(false).notNull(),
    autoWarmupEnabled: integer('auto_warmup_enabled', { mode: 'boolean' }).default(false).notNull(),
})

// Proxies table - Proxy servers for rotation
export const proxies = sqliteTable('proxies', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username'),
    password: text('password'),
    type: text('type', { enum: ['http', 'https', 'socks5'] }).default('http').notNull(),
    country: text('country'),
    provider: text('provider'), // 'manual' | 'dataimpulse' | 'fproxy' | 'smartproxy' | 'custom' etc. (optional)
    status: text('status', { enum: ['active', 'dead', 'checking'] }).default('active').notNull(),
    lastCheck: integer('last_check', { mode: 'timestamp' }),
    responseTime: integer('response_time'), // in milliseconds
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Encrypted FProxy API-key slots. Runtime proxy/lease state is intentionally not persisted.
export const fproxyKeys = sqliteTable(
    'fproxy_keys',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        label: text('label').notNull(),
        apiKeyCiphertext: text('api_key_ciphertext').notNull(),
        enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
        createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
        updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    },
    (table) => ({
        enabledIdx: index('idx_fproxy_keys_enabled').on(table.enabled),
    })
)

export type FproxyKeyRow = typeof fproxyKeys.$inferSelect
export type NewFproxyKeyRow = typeof fproxyKeys.$inferInsert

// Locations table - Google Maps locations to review
export const locations = sqliteTable('locations', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').references(() => projects.id), // Optional project association
    name: text('name').notNull(),
    placeId: text('place_id'),
    address: text('address'),
    url: text('url').notNull(),
    cid: text('cid'),
    featureHex: text('feature_hex'),
    category: text('category'),
    searchKeywords: text('search_keywords'), // JSON array of keywords for organic search, e.g. ["kaff viet nam", "kaff hanoi"]
    phone: text('phone'),
    website: text('website'),
    targetRating: integer('target_rating').default(5).notNull(),
    targetReviews: integer('target_reviews').default(10).notNull(),
    currentReviews: integer('current_reviews').default(0).notNull(),
    status: text('status', { enum: ['pending', 'in_progress', 'done'] }).default('pending').notNull(),
    analyticsMode: text('analytics_mode').default('none'),
    ga4PropertyId: text('ga4_property_id'),
    gscSiteUrl: text('gsc_site_url'),
    analyticsGoogleEmail: text('analytics_google_email'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Campaigns table - Review campaigns
export const campaigns = sqliteTable('campaigns', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').references(() => projects.id), // Optional project association
    name: text('name').notNull(),
    locationIds: text('location_ids').notNull(), // JSON array
    accountIds: text('account_ids'), // JSON array, null means all
    proxyIds: text('proxy_ids'), // JSON array, null means all
    reviewTemplates: text('review_templates').notNull(), // JSON array
    rating: integer('rating').default(5).notNull(),
    delayMin: integer('delay_min').default(30).notNull(), // seconds
    delayMax: integer('delay_max').default(120).notNull(),
    maxReviewsPerAccountPerDay: integer('max_reviews_per_day').default(5).notNull(),
    workingHoursStart: text('working_hours_start').default('08:00'),
    workingHoursEnd: text('working_hours_end').default('22:00'),
    status: text('status', { enum: ['pending', 'running', 'paused', 'done', 'error'] }).default('pending').notNull(),
    progress: integer('progress').default(0).notNull(),
    totalReviews: integer('total_reviews').default(0).notNull(),
    successReviews: integer('success_reviews').default(0).notNull(),
    failedReviews: integer('failed_reviews').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Review history table - Log of all reviews
export const reviewHistory = sqliteTable('review_history', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').references(() => campaigns.id),
    accountId: integer('account_id').references(() => accounts.id).notNull(),
    locationId: integer('location_id').references(() => locations.id).notNull(),
    proxyId: integer('proxy_id').references(() => proxies.id),
    rating: integer('rating').notNull(),
    reviewText: text('review_text').notNull(),
    status: text('status', { enum: ['success', 'failed'] }).notNull(),
    errorMessage: text('error_message'),
    screenshot: text('screenshot'), // file path
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    // Review survival tracking (migration 008)
    verifiedStatus: text('verified_status', { enum: ['pending', 'live', 'removed', 'unknown'] }).default('pending'),
    verifiedAt: integer('verified_at', { mode: 'timestamp' }),
    lastCheckAt: integer('last_check_at', { mode: 'timestamp' }),
    checkCount: integer('check_count').default(0),
    survivalDays: integer('survival_days'),
    googleReviewId: text('google_review_id'),
    styleApplied: integer('style_applied', { mode: 'boolean' }).default(false),
})

// Settings table - App configuration
export const settings = sqliteTable('settings', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull().unique(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Traffic Tasks table - Map views booster
export const trafficTasks = sqliteTable('traffic_tasks', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').references(() => projects.id), // Optional project association
    locationId: integer('location_id').references(() => locations.id).notNull(),
    targetViews: integer('target_views').default(1000).notNull(),
    currentViews: integer('current_views').default(0).notNull(),
    viewsPerDay: integer('views_per_day').default(100).notNull(),
    useProxies: integer('use_proxies', { mode: 'boolean' }).default(true),
    proxyIds: text('proxy_ids'), // JSON array
    status: text('status', { enum: ['pending', 'running', 'paused', 'completed', 'stopped'] }).default('pending').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Review Templates table - Spintax templates for reviews
export const reviewTemplates = sqliteTable('review_templates', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    content: text('content').notNull(), // Spintax format: {option1|option2|option3}
    category: text('category').default('general').notNull(), // 5_star, 4_star, short, detailed, etc.
    isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
    useCount: integer('use_count').default(0).notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

// Image Folders table - Mapping image folders to categories
export const imageFolders = sqliteTable('image_folders', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    path: text('path').notNull(), // Folder path on disk
    category: text('category').default('general').notNull(),
    imageCount: integer('image_count').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Campaign Schedules table - Schedule campaigns to run at specific times
export const campaignSchedules = sqliteTable('campaign_schedules', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').references(() => campaigns.id).notNull(),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp' }).notNull(),
    repeatType: text('repeat_type', { enum: ['once', 'daily', 'weekly', 'custom'] }).default('once').notNull(),
    repeatDays: text('repeat_days'), // JSON array [0,1,2,3,4,5,6] for days of week
    endDate: integer('end_date', { mode: 'timestamp' }),
    lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
    nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
    isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Traffic Campaigns table - Configurable traffic boost campaigns
export const trafficCampaigns = sqliteTable('traffic_campaigns', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    trafficMode: text('traffic_mode', { enum: ['direct', 'organic', 'web_seo', 'map_search'] }).default('direct').notNull(), // direct = open URL, organic = map search, web_seo = website search, map_search = SEO search directly in Google Maps UI
    searchKeywords: text('search_keywords'), // JSON array of keywords for organic mode
    maxMapScroll: integer('max_map_scroll').default(15).notNull(), // max cards to scroll in map_search mode before fallback to direct URL
    accountIds: text('account_ids').notNull(), // JSON array of account IDs
    locationIds: text('location_ids').notNull(), // JSON array of location IDs
    threadsCount: integer('threads_count').default(1).notNull(), // 1-10 concurrent browsers
    visitsPerLocation: integer('visits_per_location').default(10).notNull(), // Target visits per location
    delayMinSeconds: integer('delay_min_seconds').default(10).notNull(), // Min delay between visits
    delayMaxSeconds: integer('delay_max_seconds').default(30).notNull(), // Max delay between visits
    actionsPerVisit: integer('actions_per_visit').default(4).notNull(), // 3-6 random SEO actions per visit
    fixedActionCount: integer('fixed_action_count', { mode: 'boolean' }).default(false).notNull(), // true = exact actions per visit
    enabledActions: text('enabled_actions'), // JSON array of enabled action types, null = all
    targetKpi: text('target_kpi'),
    aiAutoControl: integer('ai_auto_control', { mode: 'boolean' }).default(false).notNull(), // true = AI autonomously controls all SEO actions
    // Web SEO quality gates (dwell window + organic requirement)
    webSeoMinDwellSeconds: integer('web_seo_min_dwell_seconds').default(45).notNull(),
    webSeoMaxDwellSeconds: integer('web_seo_max_dwell_seconds').default(90).notNull(),
    webSeoRequireOrganic: integer('web_seo_require_organic', { mode: 'boolean' }).default(false).notNull(),
    status: text('status', { enum: ['pending', 'running', 'paused', 'completed', 'stopped'] }).default('pending').notNull(),
    totalVisits: integer('total_visits').default(0).notNull(),
    completedVisits: integer('completed_visits').default(0).notNull(),
    failedVisits: integer('failed_visits').default(0).notNull(),
    currentRound: integer('current_round').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
})

// Traffic Logs table - Detailed per-visit logs
export const trafficLogs = sqliteTable('traffic_logs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').references(() => trafficCampaigns.id).notNull(),
    accountId: integer('account_id').references(() => accounts.id),
    locationId: integer('location_id').references(() => locations.id).notNull(),
    actions: text('actions').notNull(), // JSON array of actions performed
    duration: integer('duration').default(0).notNull(), // Visit duration in seconds
    round: integer('round').default(1).notNull(), // Which loop round
    status: text('status', { enum: ['success', 'failed'] }).notNull(),
    errorMessage: text('error_message'),
    // Web SEO quality / discovery metadata
    discoverySource: text('discovery_source', {
        enum: ['organic', 'direct_fallback', 'captcha_cooldown', 'unreachable'],
    }),
    qualityScore: integer('quality_score').default(0).notNull(),
    countable: integer('countable', { mode: 'boolean' }).default(false).notNull(),
    targetHost: text('target_host'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Agent Knowledge table - Mini RAG memory for runtime recovery/context
export const agentKnowledge = sqliteTable('agent_knowledge', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signature: text('signature').notNull().unique(),
    campaignType: text('campaign_type').notNull(), // traffic | review | web_seo | generic
    campaignId: integer('campaign_id'),
    threadId: integer('thread_id'),
    domain: text('domain').notNull(),
    goal: text('goal').notNull(), // map_interaction | review_flow | website_browse | generic
    riskType: text('risk_type').notNull(), // popup | modal | captcha | recover | generic
    signalText: text('signal_text').notNull(),
    action: text('action').notNull(),
    decisionSource: text('decision_source').notNull(), // heuristic | llm | llm+rag | runtime
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    detail: text('detail'),
    error: text('error'),
    recoverPath: text('recover_path'),
    latencyMs: integer('latency_ms'),
    metadata: text('metadata'), // JSON blob for future enrichment
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
})

// Type exports for use in services
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type Account = typeof accounts.$inferSelect
export type NewAccount = typeof accounts.$inferInsert
export type Proxy = typeof proxies.$inferSelect
export type NewProxy = typeof proxies.$inferInsert
export type Location = typeof locations.$inferSelect
export type NewLocation = typeof locations.$inferInsert
export type Campaign = typeof campaigns.$inferSelect
export type NewCampaign = typeof campaigns.$inferInsert
export type ReviewHistory = typeof reviewHistory.$inferSelect
export type NewReviewHistory = typeof reviewHistory.$inferInsert
export type Setting = typeof settings.$inferSelect
export type TrafficTask = typeof trafficTasks.$inferSelect
export type NewTrafficTask = typeof trafficTasks.$inferInsert
export type ReviewTemplate = typeof reviewTemplates.$inferSelect
export type NewReviewTemplate = typeof reviewTemplates.$inferInsert
export type ImageFolder = typeof imageFolders.$inferSelect
export type NewImageFolder = typeof imageFolders.$inferInsert
export type TrafficCampaign = typeof trafficCampaigns.$inferSelect
export type NewTrafficCampaign = typeof trafficCampaigns.$inferInsert
export type TrafficLog = typeof trafficLogs.$inferSelect
export type NewTrafficLog = typeof trafficLogs.$inferInsert
export type AgentKnowledge = typeof agentKnowledge.$inferSelect
export type NewAgentKnowledge = typeof agentKnowledge.$inferInsert

// Durable automation job queue (survives app crash/restart)
// Status 'running' = in-progress; on boot, running rows are safely requeued as pending.
export const jobQueueEntries = sqliteTable('job_queue', {
    id: text('id').primaryKey(),
    campaignId: integer('campaign_id').references(() => campaigns.id),
    type: text('type', { enum: ['review', 'traffic'] }).notNull(),
    accountId: integer('account_id').notNull(),
    locationId: integer('location_id').notNull(),
    reviewText: text('review_text'),
    rating: integer('rating'),
    targetViews: integer('target_views'),
    priority: integer('priority').default(0).notNull(),
    status: text('status', {
        enum: ['pending', 'running', 'done', 'failed', 'cancelled'],
    }).default('pending').notNull(),
    retryCount: integer('retry_count').default(0).notNull(),
    maxRetries: integer('max_retries').default(3).notNull(),
    result: text('result'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
})

export type JobQueueEntry = typeof jobQueueEntries.$inferSelect
export type NewJobQueueEntry = typeof jobQueueEntries.$inferInsert

// Automation Scripts table - Persistent script storage
export const automationScripts = sqliteTable('automation_scripts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scriptId: text('script_id').notNull().unique(), // UUID from frontend
    name: text('name').notNull(),
    description: text('description'),
    version: text('version').default('1.0.0').notNull(),
    actions: text('actions').notNull(), // JSON string of ScriptAction[]
    variables: text('variables'), // JSON string of ScriptVariable[]
    settings: text('settings'), // JSON string of settings object
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
})

export type AutomationScriptRow = typeof automationScripts.$inferSelect
export type NewAutomationScriptRow = typeof automationScripts.$inferInsert

// AI Metrics — Inference performance tracking (Trackio)
export const aiMetrics = sqliteTable('ai_metrics', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task: text('task').notNull(),              // HFTaskType: 'text-generation' | 'zero-shot-image-classification' | ...
    modelId: text('model_id').notNull(),        // e.g. 'Xenova/Qwen1.5-0.5B-Chat'
    operation: text('operation', { enum: ['inference', 'load', 'unload'] }).default('inference').notNull(),
    durationMs: integer('duration_ms').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    memoryMB: integer('memory_mb'),
    inputLength: integer('input_length'),       // Character count of input
    outputLength: integer('output_length'),     // Character count of output
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export type AIMetricRow = typeof aiMetrics.$inferSelect
export type NewAIMetricRow = typeof aiMetrics.$inferInsert

// CAPTCHA solve metrics — durable attempt log (no secrets/tokens/API keys)
export const captchaMetrics = sqliteTable('captcha_metrics', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    captchaType: text('captcha_type').notNull(), // recaptchav2 | recaptchav3 | hcaptcha | turnstile | unknown
    provider: text('provider').notNull(), // none | 2captcha | capsolver | local-ai | unknown
    success: integer('success', { mode: 'boolean' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    retryCount: integer('retry_count').default(0).notNull(),
    errorCode: text('error_code'), // short sanitized code only — never secrets
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export type CaptchaMetricRow = typeof captchaMetrics.$inferSelect
export type NewCaptchaMetricRow = typeof captchaMetrics.$inferInsert

// Versioned schema migrations ledger (idempotent runner tracks applied versions)
export const schemaMigrations = sqliteTable('schema_migrations', {
    version: integer('version').primaryKey(),
    name: text('name').notNull(),
    appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export type SchemaMigration = typeof schemaMigrations.$inferSelect
export type NewSchemaMigration = typeof schemaMigrations.$inferInsert

/**
 * Durable Traffic per-visit queue — crash-safe claim/lease/recovery.
 * Unique (campaignId, visitIndex) is the idempotency key for enqueue.
 * Lease fields support atomic claim + expired-lease reclaim.
 */
export const trafficVisitQueue = sqliteTable(
    'traffic_visit_queue',
    {
        id: text('id').primaryKey(),
        campaignId: integer('campaign_id').notNull(),
        visitIndex: integer('visit_index').notNull(),
        status: text('status', {
            enum: ['pending', 'retry', 'running', 'done', 'failed', 'cancelled'],
        })
            .default('pending')
            .notNull(),
        /** JSON blob for visit task params (no secrets). */
        payload: text('payload'),
        attemptCount: integer('attempt_count').default(0).notNull(),
        maxAttempts: integer('max_attempts').default(3).notNull(),
        workerId: text('worker_id'),
        claimedAt: text('claimed_at'),
        leaseExpiresAt: text('lease_expires_at'),
        /** Not available for claim until this timestamp (backoff / delay). */
        availableAt: text('available_at'),
        lastError: text('last_error'),
        result: text('result'),
        createdAt: text('created_at')
            .notNull()
            .$defaultFn(() => new Date().toISOString()),
        updatedAt: text('updated_at')
            .notNull()
            .$defaultFn(() => new Date().toISOString()),
    },
    (table) => ({
        campaignVisitUnique: uniqueIndex('uq_traffic_visit_campaign_index').on(
            table.campaignId,
            table.visitIndex
        ),
        statusIdx: index('idx_traffic_visit_queue_status').on(table.status),
        availableIdx: index('idx_traffic_visit_queue_available').on(table.availableAt),
        leaseIdx: index('idx_traffic_visit_queue_lease').on(table.leaseExpiresAt),
        campaignIdx: index('idx_traffic_visit_queue_campaign').on(table.campaignId),
    })
)

export type TrafficVisitQueueRow = typeof trafficVisitQueue.$inferSelect
export type NewTrafficVisitQueueRow = typeof trafficVisitQueue.$inferInsert
export type TrafficVisitQueueStatus = TrafficVisitQueueRow['status']

/**
 * Append-only compliance / operator audit trail.
 * Public queries must sanitize metadata (never store/return secrets).
 */
export const complianceAudit = sqliteTable(
    'compliance_audit',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        action: text('action').notNull(),
        entityType: text('entity_type').notNull(),
        entityId: text('entity_id').notNull(),
        actor: text('actor').notNull(),
        decision: text('decision').notNull(),
        reason: text('reason'),
        /** JSON object string; secrets must be stripped before insert. */
        metadata: text('metadata'),
        createdAt: integer('created_at', { mode: 'timestamp' })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => ({
        createdIdx: index('idx_compliance_audit_created').on(table.createdAt),
        entityIdx: index('idx_compliance_audit_entity').on(
            table.entityType,
            table.entityId,
            table.createdAt
        ),
        actionIdx: index('idx_compliance_audit_action').on(table.action, table.createdAt),
        decisionIdx: index('idx_compliance_audit_decision').on(table.decision, table.createdAt),
    })
)

export type ComplianceAuditRow = typeof complianceAudit.$inferSelect
export type NewComplianceAuditRow = typeof complianceAudit.$inferInsert
