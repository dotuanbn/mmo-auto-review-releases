import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../src/main/database/schema'
import { TrafficReportService } from '../src/main/automation/traffic/TrafficReportService'
import { loadTrafficBoostLogs } from '../src/main/ipc/traffic'

// Detect ONLY known native module version mismatch between system Node and Electron ABI.
// Do not catch arbitrary runtime errors; any other native failure must still throw.
function isNodeAbiMismatch(): boolean {
    try {
        const probe = new Database(':memory:')
        probe.close()
        return false
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
            msg.includes('NODE_MODULE_VERSION') ||
            msg.includes('was compiled against a different Node.js version')
        ) {
            return true
        }
        throw err
    }
}

const isAbiIncompatible = isNodeAbiMismatch()

let testDb: ReturnType<typeof drizzle>
let sqliteInstance: InstanceType<typeof Database> | null = null

vi.mock('../src/main/database', () => ({
    getDatabase: () => testDb,
}))

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn(),
    },
}))

vi.mock('../src/main/automation/TrafficBoostEngine', () => ({
    trafficBoostEngine: {},
}))

vi.mock('../src/main/automation/TrafficVisitQueue', () => ({
    trafficVisitQueue: {},
}))

describe.skipIf(isAbiIncompatible)('TrafficReportService & IPC Scaling Regression Suite', () => {
    let service: TrafficReportService

    beforeEach(() => {
        sqliteInstance = new Database(':memory:')
        sqliteInstance.exec(`
            CREATE TABLE traffic_campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                traffic_mode TEXT DEFAULT 'direct' NOT NULL,
                search_keywords TEXT,
                max_map_scroll INTEGER DEFAULT 15 NOT NULL,
                account_ids TEXT NOT NULL,
                location_ids TEXT NOT NULL,
                threads_count INTEGER DEFAULT 1 NOT NULL,
                visits_per_location INTEGER DEFAULT 10 NOT NULL,
                delay_min_seconds INTEGER DEFAULT 10 NOT NULL,
                delay_max_seconds INTEGER DEFAULT 30 NOT NULL,
                actions_per_visit INTEGER DEFAULT 4 NOT NULL,
                fixed_action_count INTEGER DEFAULT 0 NOT NULL,
                enabled_actions TEXT,
                target_kpi TEXT,
                ai_auto_control INTEGER DEFAULT 0 NOT NULL,
                web_seo_min_dwell_seconds INTEGER DEFAULT 45 NOT NULL,
                web_seo_max_dwell_seconds INTEGER DEFAULT 90 NOT NULL,
                web_seo_require_organic INTEGER DEFAULT 0 NOT NULL,
                status TEXT DEFAULT 'pending' NOT NULL,
                total_visits INTEGER DEFAULT 0 NOT NULL,
                completed_visits INTEGER DEFAULT 0 NOT NULL,
                failed_visits INTEGER DEFAULT 0 NOT NULL,
                current_round INTEGER DEFAULT 0 NOT NULL,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                completed_at INTEGER
            );

            CREATE TABLE locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,
                name TEXT NOT NULL,
                place_id TEXT,
                address TEXT,
                url TEXT NOT NULL,
                cid TEXT,
                feature_hex TEXT,
                category TEXT,
                search_keywords TEXT,
                phone TEXT,
                website TEXT,
                target_rating INTEGER DEFAULT 5 NOT NULL,
                target_reviews INTEGER DEFAULT 10 NOT NULL,
                current_reviews INTEGER DEFAULT 0 NOT NULL,
                status TEXT DEFAULT 'pending' NOT NULL,
                analytics_mode TEXT DEFAULT 'none',
                ga4_property_id TEXT,
                gsc_site_url TEXT,
                analytics_google_email TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                recovery_email TEXT,
                recovery_phone TEXT,
                login_type TEXT DEFAULT 'auto' NOT NULL,
                two_factor_secret TEXT,
                cookies TEXT,
                profile_path TEXT,
                fingerprint_id TEXT,
                status TEXT DEFAULT 'pending' NOT NULL,
                last_used INTEGER,
                last_check_at INTEGER,
                total_reviews INTEGER DEFAULT 0 NOT NULL,
                created_at INTEGER NOT NULL,
                first_review_date INTEGER,
                last_review_date INTEGER,
                warmup_level INTEGER DEFAULT 0 NOT NULL,
                reputation_score INTEGER DEFAULT 0 NOT NULL,
                warmup_history TEXT,
                review_style_profile TEXT,
                review_style_seed TEXT,
                behavior_profile TEXT,
                last_warmup_at INTEGER,
                next_warmup_at INTEGER,
                warmup_sessions INTEGER DEFAULT 0 NOT NULL,
                birth_story_day INTEGER DEFAULT 0 NOT NULL,
                birth_story_start_date INTEGER,
                birth_story_completed INTEGER DEFAULT 0 NOT NULL,
                auto_warmup_enabled INTEGER DEFAULT 0 NOT NULL
            );

            CREATE TABLE traffic_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL REFERENCES traffic_campaigns(id),
                account_id INTEGER REFERENCES accounts(id),
                location_id INTEGER NOT NULL REFERENCES locations(id),
                actions TEXT NOT NULL,
                duration INTEGER DEFAULT 0 NOT NULL,
                round INTEGER DEFAULT 1 NOT NULL,
                status TEXT NOT NULL,
                error_message TEXT,
                discovery_source TEXT,
                quality_score INTEGER DEFAULT 0 NOT NULL,
                countable INTEGER DEFAULT 0 NOT NULL,
                target_host TEXT,
                created_at INTEGER NOT NULL
            );
        `)

        testDb = drizzle(sqliteInstance, { schema })
        service = new TrafficReportService()

        // Seed common entities
        testDb.insert(schema.locations).values([
            { id: 1, name: 'Hanoi Branch', url: 'https://example.com/hanoi', createdAt: new Date(1000) },
            { id: 2, name: 'Danang Branch', url: 'https://example.com/danang', createdAt: new Date(1000) },
            { id: 3, name: 'Other Campaign Location', url: 'https://example.com/other', createdAt: new Date(1000) },
        ]).run()

        testDb.insert(schema.accounts).values([
            { id: 1, email: 'acc1@gmail.com', password: 'secret_pw_1', twoFactorSecret: 'totp_secret_1', createdAt: new Date(1000) },
            { id: 2, email: 'acc2@gmail.com', password: 'secret_pw_2', twoFactorSecret: 'totp_secret_2', createdAt: new Date(1000) },
            { id: 3, email: 'other@gmail.com', password: 'secret_pw_3', twoFactorSecret: 'totp_secret_3', createdAt: new Date(1000) },
        ]).run()

        testDb.insert(schema.trafficCampaigns).values([
            {
                id: 1,
                name: 'Main Traffic Boost Campaign',
                accountIds: JSON.stringify([1, 2]),
                locationIds: JSON.stringify([1, 2]),
                totalVisits: 1300,
                completedVisits: 1000,
                failedVisits: 300,
                currentRound: 5,
                createdAt: new Date(1000),
            },
            {
                id: 2,
                name: 'Secondary Campaign',
                accountIds: JSON.stringify([3]),
                locationIds: JSON.stringify([3]),
                totalVisits: 200,
                completedVisits: 150,
                failedVisits: 50,
                currentRound: 1,
                createdAt: new Date(1000),
            },
        ]).run()
    })

    afterEach(() => {
        if (sqliteInstance) {
            sqliteInstance.close()
            sqliteInstance = null
        }
    })

    it('aggregates full history correctly across keyset pages (>1200 rows with ID gaps)', () => {
        // Generate 1250 rows for campaign 1 with gaps in ID sequence
        // Keysets of size 500 will require at least 3 pages (500 + 500 + 250)
        let expectedTotalDuration = 0
        let expectedSuccessCount = 0
        let loc1SuccessVisits = 0
        let loc1Duration = 0
        let loc2SuccessVisits = 0
        let loc2Duration = 0
        let acc1SuccessVisits = 0
        let acc2SuccessVisits = 0
        let mapZoomCount = 0
        let reviewsReadCount = 0

        const rows: Array<typeof schema.trafficLogs.$inferInsert> = []
        let currentId = 10

        for (let i = 0; i < 1250; i++) {
            currentId += (i % 3 === 0 ? 5 : 1) // introduce gaps in id
            const isSuccess = i % 4 !== 0 // 3 out of 4 succeed
            const duration = isSuccess ? 20 + (i % 30) : 5
            const locationId = i % 2 === 0 ? 1 : 2
            const accountId = i % 2 === 0 ? 1 : 2
            const createdAt = new Date(1000000 + i * 1000)

            const actions = isSuccess
                ? JSON.stringify([
                    { action: 'map_zoom_in', success: true },
                    { action: 'reviews_read', success: true },
                ])
                : JSON.stringify([
                    { action: 'map_zoom_in', success: false, error: 'Element missing' },
                ])

            expectedTotalDuration += duration
            if (isSuccess) {
                expectedSuccessCount++
                if (locationId === 1) {
                    loc1SuccessVisits++
                    loc1Duration += duration
                } else {
                    loc2SuccessVisits++
                    loc2Duration += duration
                }

                if (accountId === 1) {
                    acc1SuccessVisits++
                } else {
                    acc2SuccessVisits++
                }
                mapZoomCount++
                reviewsReadCount++
            } else {
                mapZoomCount++
            }

            rows.push({
                id: currentId,
                campaignId: 1,
                accountId,
                locationId,
                status: isSuccess ? 'success' : 'failed',
                round: 1 + Math.floor(i / 300),
                duration,
                actions,
                errorMessage: isSuccess ? null : 'Simulated failure',
                createdAt,
            })
        }

        // Also insert 150 rows for campaign 2 interleaved to verify campaign filtering
        for (let j = 0; j < 150; j++) {
            currentId += 2
            rows.push({
                id: currentId,
                campaignId: 2,
                accountId: 3,
                locationId: 3,
                status: 'success',
                round: 1,
                duration: 99,
                actions: JSON.stringify([{ action: 'campaign2_action', success: true }]),
                createdAt: new Date(2000000 + j * 1000),
            })
        }

        // Insert in chunks to avoid SQLite parameter bounds
        const CHUNK_SIZE = 100
        for (let k = 0; k < rows.length; k += CHUNK_SIZE) {
            testDb.insert(schema.trafficLogs).values(rows.slice(k, k + CHUNK_SIZE)).run()
        }

        const report = service.getReport(1)

        // Verify full history aggregate correctness without silent truncation
        expect(report.campaignId).toBe(1)
        expect(report.campaignName).toBe('Main Traffic Boost Campaign')
        expect(report.totalDuration).toBe(expectedTotalDuration)
        const expectedAvg = Math.round(expectedTotalDuration / expectedSuccessCount)
        expect(report.avgVisitDuration).toBe(expectedAvg)

        // Location aggregates
        const loc1 = report.visitsByLocation.find(l => l.locationId === 1)
        const loc2 = report.visitsByLocation.find(l => l.locationId === 2)
        expect(loc1?.visits).toBe(loc1SuccessVisits)
        expect(loc1?.avgDuration).toBe(Math.round(loc1Duration / loc1SuccessVisits))
        expect(loc2?.visits).toBe(loc2SuccessVisits)
        expect(loc2?.avgDuration).toBe(Math.round(loc2Duration / loc2SuccessVisits))
        expect(report.visitsByLocation.some(l => l.locationId === 3)).toBe(false)

        // Account aggregates
        const acc1 = report.visitsByAccount.find(a => a.accountId === 1)
        const acc2 = report.visitsByAccount.find(a => a.accountId === 2)
        expect(acc1?.visits).toBe(acc1SuccessVisits)
        expect(acc2?.visits).toBe(acc2SuccessVisits)
        expect(report.visitsByAccount.some(a => a.accountId === 3)).toBe(false)

        // Action stats
        const zoomStat = report.actionStats.find(s => s.action === 'map_zoom_in')
        const readStat = report.actionStats.find(s => s.action === 'reviews_read')
        expect(zoomStat?.count).toBe(mapZoomCount)
        expect(readStat?.count).toBe(reviewsReadCount)
        expect(report.actionStats.some(s => s.action === 'campaign2_action')).toBe(false)

        // Recent logs bounded to 100
        expect(report.logs.length).toBe(100)

        // Verify logs are the most recent 100 rows ordered descending by createdAt
        for (let i = 0; i < report.logs.length - 1; i++) {
            const current = new Date(report.logs[i].createdAt).getTime()
            const next = new Date(report.logs[i + 1].createdAt).getTime()
            expect(current).toBeGreaterThanOrEqual(next)
        }

        // Verify normalized properties on recent logs
        const firstLog = report.logs[0]
        expect(firstLog.locationName).toBeDefined()
        expect(firstLog.accountEmail).toBeDefined()
        expect(firstLog.actions).toBeInstanceOf(Array)
        expect(typeof firstLog.successfulActionCount).toBe('number')
        expect(typeof firstLog.failedActionCount).toBe('number')
        expect(typeof firstLog.totalActionCount).toBe('number')
        expect(firstLog.successfulActionCount + firstLog.failedActionCount).toBe(firstLog.totalActionCount)

        // Verify no secret account columns exist on the report or log objects
        expect((firstLog as Record<string, unknown>).password).toBeUndefined()
        expect((firstLog as Record<string, unknown>).twoFactorSecret).toBeUndefined()
    })

    it('preserves stable tie-breaking when createdAt timestamps are identical', () => {
        // Insert 10 rows with identical createdAt timestamp
        const sameTime = new Date('2026-11-23T10:00:00.000Z')
        const rows: Array<typeof schema.trafficLogs.$inferInsert> = []

        for (let i = 0; i < 10; i++) {
            rows.push({
                id: i + 1,
                campaignId: 1,
                accountId: 1,
                locationId: 1,
                status: 'success',
                round: 1,
                duration: 10 + i,
                actions: JSON.stringify([{ action: `step_${i + 1}`, success: true }]),
                createdAt: sameTime,
            })
        }
        testDb.insert(schema.trafficLogs).values(rows).run()

        const report = service.getReport(1)
        expect(report.logs.length).toBe(10)

        // When createdAt is tied, stable sort preserves insertion order (id 1, 2, ..., 10)
        const returnedIds = report.logs.map(l => l.id)
        expect(returnedIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    it('correctly handles legacy, string, and malformed actions without failing', () => {
        const rows: Array<typeof schema.trafficLogs.$inferInsert> = [
            {
                id: 1,
                campaignId: 1,
                accountId: 1,
                locationId: 1,
                status: 'success',
                round: 1,
                duration: 25,
                actions: JSON.stringify(['legacy_string_action', 'another_legacy_action']),
                createdAt: new Date(1000),
            },
            {
                id: 2,
                campaignId: 1,
                accountId: 1,
                locationId: 1,
                status: 'failed',
                round: 1,
                duration: 5,
                actions: 'this is not json {invalid}',
                errorMessage: 'captcha error occurred',
                createdAt: new Date(2000),
            },
            {
                id: 3,
                campaignId: 1,
                accountId: 2,
                locationId: 2,
                status: 'success',
                round: 1,
                duration: 30,
                actions: JSON.stringify([
                    null,
                    42,
                    { action: 'custom_action', success: true },
                    { no_action_field: true },
                ]),
                createdAt: new Date(3000),
            },
        ]
        testDb.insert(schema.trafficLogs).values(rows).run()

        const report = service.getReport(1)
        expect(report.logs.length).toBe(3)

        // String legacy actions should be normalized with source='legacy' and detail
        const legacyLog = report.logs.find(l => l.id === 1)
        expect(legacyLog?.actions[0].action).toBe('legacy_string_action')
        expect(legacyLog?.actions[0].source).toBe('legacy')
        expect(legacyLog?.actions[0].detail).toBe('legacy string action')

        // Malformed JSON should normalize to empty array safely
        const malformedLog = report.logs.find(l => l.id === 2)
        expect(malformedLog?.actions).toEqual([])

        // Non-object array items should become step_1, step_2
        const nonObjLog = report.logs.find(l => l.id === 3)
        expect(nonObjLog?.actions[0].action).toBe('step_1')
        expect(nonObjLog?.actions[1].action).toBe('step_2')
        expect(nonObjLog?.actions[2].action).toBe('custom_action')
        expect(nonObjLog?.actions[3].action).toBe('step_4')
    })

    it('calculates audit report across multiple keyset pages with failure and quality math', () => {
        // Insert 1200 rows into campaign 1
        const rows: Array<typeof schema.trafficLogs.$inferInsert> = []
        for (let i = 0; i < 1200; i++) {
            const isSuccess = i % 3 !== 0 // 800 success, 400 failed (failed when i % 3 === 0)
            let actions = '[]'
            let errorMessage: string | null = null
            let qualityScore = 0
            let countable = false
            let discoverySource: 'organic' | 'direct_fallback' | null = null

            if (!isSuccess) {
                // When i % 3 === 0, i % 6 can only be 0 or 3
                if (i % 6 === 0) {
                    errorMessage = 'CAPTCHA detected'
                } else if (i % 6 === 3) {
                    errorMessage = 'watchdog timeout'
                    actions = JSON.stringify([{ action: 'watchdog_timeout', error: 'timed out' }])
                } else {
                    errorMessage = 'Unknown connection failure'
                }
            } else {
                if (i % 2 === 0) {
                    // Structured quality
                    discoverySource = 'organic'
                    qualityScore = 80 // high quality
                    countable = true
                } else if (i % 5 === 0) {
                    // Legacy quality detail regex fallback
                    actions = JSON.stringify([
                        { action: 'visit_quality_assessment', detail: 'Quality=50/100' }, // medium quality
                    ])
                } else if (i % 7 === 0) {
                    // Proxy rotated visit
                    actions = JSON.stringify([
                        { action: 'proxy_rotated_visit_ended' },
                    ])
                }
            }

            rows.push({
                id: i + 1,
                campaignId: 1,
                accountId: 1,
                locationId: 1,
                status: isSuccess ? 'success' : 'failed',
                round: 1,
                duration: isSuccess ? (i % 10 === 0 ? 10 : 35) : 3, // some very short visits (<15s)
                actions,
                errorMessage,
                discoverySource,
                qualityScore,
                countable,
                createdAt: new Date(1000 + i * 100),
            })
        }

        const CHUNK_SIZE = 100
        for (let k = 0; k < rows.length; k += CHUNK_SIZE) {
            testDb.insert(schema.trafficLogs).values(rows.slice(k, k + CHUNK_SIZE)).run()
        }

        const audit = service.getAuditReport(1)
        expect(audit.campaignId).toBe(1)
        expect(audit.totalAttempted).toBe(1200)
        expect(audit.totalSuccess).toBe(800)
        expect(audit.totalFailed).toBe(400)
        expect(audit.successRate).toBe(Math.round((800 / 1200) * 100))

        // Check quality metrics
        expect(audit.quality.highQuality).toBeGreaterThan(0)
        expect(audit.quality.estimatedGoogleCountable).toBeGreaterThan(0)
        expect(audit.issues.captchaBlocked).toBeGreaterThan(0)
        expect(audit.issues.watchdogTimeout).toBeGreaterThan(0)
        expect(audit.issues.veryShortVisits).toBeGreaterThan(0)
        expect(audit.issues.proxyRotatedVisits).toBeGreaterThan(0)

        // Summary string format checks
        expect(audit.summary.length).toBeGreaterThan(0)
        expect(audit.summary[0]).toContain('Total: 1200 visits (800 success, 400 failed)')
    })

    it('bounds IPC log sample feed (loadTrafficBoostLogs) to at most 1000 latest rows deterministically', () => {
        // Insert 1500 logs for campaign 1
        const rows: Array<typeof schema.trafficLogs.$inferInsert> = []
        for (let i = 1; i <= 1500; i++) {
            rows.push({
                id: i,
                campaignId: 1,
                accountId: 1,
                locationId: 1,
                status: 'success',
                round: 1,
                duration: 20,
                actions: JSON.stringify([{ action: `action_${i}`, success: true }]),
                createdAt: new Date(100000 + i * 100),
            })
        }

        const CHUNK_SIZE = 100
        for (let k = 0; k < rows.length; k += CHUNK_SIZE) {
            testDb.insert(schema.trafficLogs).values(rows.slice(k, k + CHUNK_SIZE)).run()
        }

        // Fetch logs via IPC helper
        const logs = loadTrafficBoostLogs(1)

        // Must be capped at exactly 1000 rows
        expect(logs.length).toBe(1000)

        // Must be sorted deterministically descending by id (latest rows first)
        expect(logs[0].id).toBe(1500)
        expect(logs[999].id).toBe(501)

        // Name resolution and parsed actions check
        expect(logs[0].accountEmail).toBe('acc1@gmail.com')
        expect(logs[0].locationName).toBe('Hanoi Branch')
        expect(Array.isArray(logs[0].actions)).toBe(true)
        const firstLogActions = logs[0].actions as Array<{ action: string }>
        expect(firstLogActions[0].action).toBe('action_1500')
    })
})
