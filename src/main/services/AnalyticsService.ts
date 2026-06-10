import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq, desc } from 'drizzle-orm'
import { browserService } from '../automation/BrowserService'
import { HumanBehavior } from '../automation/HumanBehavior'
import { loadSettings, saveSetting } from '../ipc/settings'
import { Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// Types
// ============================================================

export interface AnalyticsDateRange {
    from: string  // YYYY-MM-DD
    to: string    // YYYY-MM-DD
}

export interface GA4Metrics {
    sessions: number
    users: number
    pageviews: number
    bounceRate: number
    avgSessionDuration: number
}

export interface GSCMetrics {
    impressions: number
    clicks: number
    ctr: number
    avgPosition: number
    topQueries: { query: string; impressions: number; clicks: number; ctr: number; position: number }[]
}

export interface GBPScrapeMetrics {
    interactions: number
    calls: number
    directions: number
    websiteClicks: number
}

export interface MapsScrapeMetrics {
    reviewCount: number
    avgRating: number
}

export interface AnalyticsSnapshot {
    id?: number
    locationId: number
    source: 'ga4_api' | 'gsc_api' | 'gbp_scrape' | 'maps_scrape'
    // GA4
    sessions?: number
    users?: number
    pageviews?: number
    bounceRate?: number
    avgSessionDuration?: number
    // GSC
    impressions?: number
    clicks?: number
    ctr?: number
    avgPosition?: number
    topQueries?: string
    // GBP Scrape
    gbpInteractions?: number
    gbpCalls?: number
    gbpDirections?: number
    gbpWebsiteClicks?: number
    // Maps
    reviewCount?: number
    avgRating?: number
    // Date
    dateFrom: string
    dateTo: string
    rawData?: string
    createdAt: Date
}

export interface LocationAnalyticsConfig {
    analyticsMode: 'api' | 'scrape' | 'none'
    ga4PropertyId?: string
    gscSiteUrl?: string
}

// ============================================================
// AnalyticsService
// ============================================================

// OAuth2 config — using official Google Analytics Client ID
const OAUTH2_CLIENT_ID = '624816708133-p1lgtsp0ef36812gqtgslfgvi4j8l251.apps.googleusercontent.com'
const OAUTH2_CLIENT_SECRET = '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'
// Use loopback redirect — Electron BrowserWindow intercepts it
const OAUTH2_REDIRECT_URI = 'http://localhost'
const OAUTH2_SCOPES = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/analytics.edit',
    'https://www.googleapis.com/auth/webmasters.readonly',
]

class AnalyticsService {
    private cache: Map<string, { data: any; expireAt: number }> = new Map()
    private readonly CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

    // ---- Cache ----
    private getCached<T>(key: string): T | null {
        const entry = this.cache.get(key)
        if (entry && Date.now() < entry.expireAt) return entry.data as T
        this.cache.delete(key)
        return null
    }

    private setCache(key: string, data: any) {
        this.cache.set(key, { data, expireAt: Date.now() + this.CACHE_TTL_MS })
    }

    // ============================================================
    // OAuth2 Flow — Using Electron BrowserWindow
    // ============================================================

    private createOAuth2Client(): OAuth2Client {
        const settings = loadSettings()
        const clientId = settings.googleOAuth2ClientId || OAUTH2_CLIENT_ID
        const clientSecret = settings.googleOAuth2ClientSecret || OAUTH2_CLIENT_SECRET
        return new google.auth.OAuth2(clientId, clientSecret, OAUTH2_REDIRECT_URI)
    }

    /**
     * Start OAuth2 login flow — opens Electron BrowserWindow for Google login
     * Intercepts the redirect to extract the authorization code
     * @param loginHint - email to pre-select in Google account chooser
     */
    async startOAuth2Flow(loginHint?: string): Promise<{ success: boolean; email?: string; error?: string }> {
        const { BrowserWindow: BW } = require('electron')
        const oauth2Client = this.createOAuth2Client()

        const authOptions: any = {
            access_type: 'offline',
            scope: OAUTH2_SCOPES,
            prompt: 'consent',
            redirect_uri: OAUTH2_REDIRECT_URI,
        }
        if (loginHint) {
            authOptions.login_hint = loginHint
        }
        const authUrl = oauth2Client.generateAuthUrl(authOptions)

        return new Promise((resolve) => {
            // Create a BrowserWindow for Google login
            const authWindow = new BW({
                width: 600,
                height: 700,
                show: true,
                title: 'Đăng nhập Google — Analytics',
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                },
                autoHideMenuBar: true,
            })

            let resolved = false
            const finish = (result: { success: boolean; email?: string; error?: string }) => {
                if (resolved) return
                resolved = true
                if (!authWindow.isDestroyed()) authWindow.close()
                resolve(result)
            }

            // Intercept navigation — look for redirect to localhost with code
            authWindow.webContents.on('will-redirect', async (_event: any, url: string) => {
                try {
                    const parsed = new URL(url)
                    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
                        const code = parsed.searchParams.get('code')
                        const error = parsed.searchParams.get('error')

                        if (error) {
                            finish({ success: false, error: `Google login denied: ${error}` })
                            return
                        }

                        if (code) {
                            // Exchange code for tokens
                            const { tokens } = await oauth2Client.getToken({
                                code,
                                redirect_uri: OAUTH2_REDIRECT_URI,
                            })
                            oauth2Client.setCredentials(tokens)

                            // Get user email
                            let email = 'Unknown'
                            try {
                                const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
                                const userInfo = await oauth2.userinfo.get()
                                email = userInfo.data.email || 'Unknown'
                            } catch { }

                            // Save tokens to settings per email
                            const settings = loadSettings()
                            const accountsStr = settings.googleOAuth2Accounts || '{}'
                            let accounts: Record<string, any> = {}
                            try { accounts = JSON.parse(accountsStr) } catch { }
                            accounts[email] = tokens
                            saveSetting('googleOAuth2Accounts', JSON.stringify(accounts))
                            // Also save as last used
                            saveSetting('googleOAuth2Email', email)

                            finish({ success: true, email })
                        }
                    }
                } catch (err: any) {
                    console.error('[Analytics] OAuth2 redirect error:', err)
                    finish({ success: false, error: err.message })
                }
            })

            // Also intercept will-navigate for same check
            authWindow.webContents.on('will-navigate', async (_event: any, url: string) => {
                try {
                    const parsed = new URL(url)
                    if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.searchParams.get('code')) {
                        const code = parsed.searchParams.get('code')!

                        const { tokens } = await oauth2Client.getToken({
                            code,
                            redirect_uri: OAUTH2_REDIRECT_URI,
                        })
                        oauth2Client.setCredentials(tokens)

                        let email = 'Unknown'
                        try {
                            const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
                            const userInfo = await oauth2.userinfo.get()
                            email = userInfo.data.email || 'Unknown'
                        } catch { }

                        const settings = loadSettings()
                        const accountsStr = settings.googleOAuth2Accounts || '{}'
                        let accounts: Record<string, any> = {}
                        try { accounts = JSON.parse(accountsStr) } catch { }
                        accounts[email] = tokens
                        saveSetting('googleOAuth2Accounts', JSON.stringify(accounts))
                        saveSetting('googleOAuth2Email', email)

                        finish({ success: true, email })
                    }
                } catch (err: any) {
                    // Ignore non-localhost navigations
                }
            })

            // Handle window close
            authWindow.on('close', () => {
                finish({ success: false, error: 'Login window was closed' })
            })

            // Load Google auth page
            authWindow.loadURL(authUrl)
            console.log('[Analytics] OAuth2 BrowserWindow opened for login')
        })
    }

    /**
     * Check if user is logged in via OAuth2
     */
    getGoogleLoginStatus(emailToCheck?: string): { loggedIn: boolean; email?: string; allEmails?: string[] } {
        const settings = loadSettings()
        const accountsStr = settings.googleOAuth2Accounts || '{}'
        let accounts: Record<string, any> = {}
        try { accounts = JSON.parse(accountsStr) } catch { }

        const allEmails = Object.keys(accounts)
        const targetEmail = emailToCheck || settings.googleOAuth2Email

        if (targetEmail && accounts[targetEmail]) {
            const tokens = accounts[targetEmail]
            if (tokens.refresh_token || tokens.access_token) {
                return { loggedIn: true, email: targetEmail, allEmails }
            }
        }
        
        return { loggedIn: false, allEmails }
    }

    /**
     * Logout — clear stored tokens for specific email or all
     */
    logoutGoogle(emailToLogout?: string): void {
        const settings = loadSettings()
        if (emailToLogout) {
            const accountsStr = settings.googleOAuth2Accounts || '{}'
            let accounts: Record<string, any> = {}
            try { accounts = JSON.parse(accountsStr) } catch { }
            delete accounts[emailToLogout]
            saveSetting('googleOAuth2Accounts', JSON.stringify(accounts))
            
            if (settings.googleOAuth2Email === emailToLogout) {
                const remaining = Object.keys(accounts)
                saveSetting('googleOAuth2Email', remaining.length > 0 ? remaining[0] : '')
            }
        } else {
            saveSetting('googleOAuth2Accounts', '{}')
            saveSetting('googleOAuth2Email', '')
        }
    }

    /**
     * Get authenticated OAuth2 client from stored tokens
     */
    private getOAuth2Auth(email?: string): OAuth2Client {
        const settings = loadSettings()
        const targetEmail = email || settings.googleOAuth2Email
        if (!targetEmail) {
            throw new Error('Chưa chọn tài khoản Email để kết nối.')
        }

        const accountsStr = settings.googleOAuth2Accounts || '{}'
        let accounts: Record<string, any> = {}
        try { accounts = JSON.parse(accountsStr) } catch { }

        const tokens = accounts[targetEmail]
        if (!tokens) {
            throw new Error(`Tài khoản ${targetEmail} chưa được đăng nhập. Vui lòng đăng nhập lại.`)
        }

        const oauth2Client = this.createOAuth2Client()
        oauth2Client.setCredentials(tokens)

        // Auto-refresh: save new tokens when they change
        oauth2Client.on('tokens', (newTokens) => {
            const merged = { ...tokens, ...newTokens }
            accounts[targetEmail] = merged
            saveSetting('googleOAuth2Accounts', JSON.stringify(accounts))
        })

        return oauth2Client
    }

    /**
     * List all GA4 properties the user has access to
     * Uses direct HTTP to avoid googleapis library's quota project requirement
     */
    async listGA4Properties(email?: string): Promise<{ id: string; displayName: string }[]> {
        try {
            const auth = this.getOAuth2Auth(email)
            const accessToken = (await auth.getAccessToken()).token
            if (!accessToken) throw new Error('No access token available')

            const response = await fetch(
                'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                }
            )

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}))
                throw new Error(errData.error?.message || `HTTP ${response.status}`)
            }

            const data = await response.json()
            const properties: { id: string; displayName: string }[] = []

            for (const account of data.accountSummaries || []) {
                for (const prop of account.propertySummaries || []) {
                    if (prop.property && prop.displayName) {
                        const id = prop.property.replace('properties/', '')
                        properties.push({ id, displayName: `${prop.displayName} (${account.displayName})` })
                    }
                }
            }

            return properties
        } catch (err: any) {
            console.error('[Analytics] listGA4Properties failed:', err.message)
            throw new Error(`Không thể liệt kê GA4 properties: ${err.message}`)
        }
    }

    /**
     * List all Search Console sites the user has access to
     * Uses direct HTTP to avoid googleapis library's quota project requirement
     */
    async listSearchConsoleSites(email?: string): Promise<{ siteUrl: string; permissionLevel: string }[]> {
        try {
            const auth = this.getOAuth2Auth(email)
            const accessToken = (await auth.getAccessToken()).token
            if (!accessToken) throw new Error('No access token available')

            const response = await fetch(
                'https://searchconsole.googleapis.com/webmasters/v3/sites',
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                }
            )

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}))
                throw new Error(errData.error?.message || `HTTP ${response.status}`)
            }

            const data = await response.json()
            return (data.siteEntry || []).map((site: any) => ({
                siteUrl: site.siteUrl || '',
                permissionLevel: site.permissionLevel || 'unknown',
            }))
        } catch (err: any) {
            console.error('[Analytics] listSearchConsoleSites failed:', err.message)
            throw new Error(`Không thể liệt kê Search Console sites: ${err.message}`)
        }
    }

    // ============================================================
    // API Mode — Google Analytics + Search Console
    // ============================================================

    private getGoogleAuth() {
        const settings = loadSettings()

        // Try OAuth2 first (tokens are stored under googleOAuth2Accounts by email)
        const accountsJson = settings.googleOAuth2Accounts
        if (accountsJson) {
            try {
                return this.getOAuth2Auth()
            } catch { }
        }

        // Fallback to Service Account
        const keyFilePath = settings.analyticsKeyFilePath
        if (!keyFilePath || !fs.existsSync(keyFilePath)) {
            throw new Error('Chưa đăng nhập Google. Vào Analytics → Cài đặt → Đăng nhập Google.')
        }

        const keyFile = JSON.parse(fs.readFileSync(keyFilePath, 'utf-8'))
        const auth = new google.auth.GoogleAuth({
            credentials: keyFile,
            scopes: [
                'https://www.googleapis.com/auth/analytics.readonly',
                'https://www.googleapis.com/auth/webmasters.readonly',
            ],
        })
        return auth
    }

    /**
     * Fetch GA4 metrics via Google Analytics Data API
     */
    async fetchGA4Data(propertyId: string, dateRange: AnalyticsDateRange): Promise<GA4Metrics> {
        const cacheKey = `ga4:${propertyId}:${dateRange.from}:${dateRange.to}`
        const cached = this.getCached<GA4Metrics>(cacheKey)
        if (cached) return cached

        const auth = this.getGoogleAuth()
        const analyticsData = google.analyticsdata({ version: 'v1beta', auth })

        const response = await analyticsData.properties.runReport({
            property: `properties/${propertyId}`,
            requestBody: {
                dateRanges: [{ startDate: dateRange.from, endDate: dateRange.to }],
                metrics: [
                    { name: 'sessions' },
                    { name: 'totalUsers' },
                    { name: 'screenPageViews' },
                    { name: 'bounceRate' },
                    { name: 'averageSessionDuration' },
                ],
            },
        })

        const row = response.data.rows?.[0]
        const values = row?.metricValues || []

        const result: GA4Metrics = {
            sessions: parseInt(values[0]?.value || '0'),
            users: parseInt(values[1]?.value || '0'),
            pageviews: parseInt(values[2]?.value || '0'),
            bounceRate: parseFloat(values[3]?.value || '0'),
            avgSessionDuration: parseFloat(values[4]?.value || '0'),
        }

        this.setCache(cacheKey, result)
        return result
    }

    /**
     * Fetch Google Search Console data
     */
    async fetchGSCData(siteUrl: string, dateRange: AnalyticsDateRange): Promise<GSCMetrics> {
        const cacheKey = `gsc:${siteUrl}:${dateRange.from}:${dateRange.to}`
        const cached = this.getCached<GSCMetrics>(cacheKey)
        if (cached) return cached

        const auth = this.getGoogleAuth()
        const searchConsole = google.searchconsole({ version: 'v1', auth })

        const response = await searchConsole.searchanalytics.query({
            siteUrl,
            requestBody: {
                startDate: dateRange.from,
                endDate: dateRange.to,
                dimensions: ['query'],
                rowLimit: 20,
            },
        })

        const rows = response.data.rows || []
        let totalImpressions = 0
        let totalClicks = 0

        const topQueries = rows.map(row => {
            const impressions = row.impressions || 0
            const clicks = row.clicks || 0
            totalImpressions += impressions
            totalClicks += clicks
            return {
                query: row.keys?.[0] || '',
                impressions,
                clicks,
                ctr: row.ctr || 0,
                position: row.position || 0,
            }
        })

        const result: GSCMetrics = {
            impressions: totalImpressions,
            clicks: totalClicks,
            ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
            avgPosition: rows.length > 0
                ? rows.reduce((sum, r) => sum + (r.position || 0), 0) / rows.length
                : 0,
            topQueries,
        }

        this.setCache(cacheKey, result)
        return result
    }

    // ============================================================
    // Scrape Mode — Google Business Profile & Maps
    // ============================================================

    /**
     * Scrape Google Maps listing for review count + avg rating
     */
    async scrapeMapMetrics(locationUrl: string): Promise<MapsScrapeMetrics> {
        const cacheKey = `maps:${locationUrl}`
        const cached = this.getCached<MapsScrapeMetrics>(cacheKey)
        if (cached) return cached

        let contextId: number | null = null
        let page: Page | undefined = undefined
        try {
            await browserService.initBrowser(true)
            contextId = await browserService.createContext({ headless: true })
            page = browserService.getPage(contextId)
            if (!page) throw new Error('Failed to create page')
            await page.goto(locationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await HumanBehavior.randomDelay(3000, 5000)

            // Extract rating and review count from the page
            const metrics = await page.evaluate(() => {
                let avgRating = 0
                let reviewCount = 0

                // Try to find rating - Format: "4.5" in aria-label or text
                const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]')
                    || document.querySelector('span.ceNzKf[aria-label]')
                    || document.querySelector('div[jsaction*="pane"] span.fontDisplayLarge')
                if (ratingEl) {
                    const text = ratingEl.getAttribute('aria-label') || ratingEl.textContent || ''
                    const match = text.match(/([\d,.]+)/)
                    if (match) avgRating = parseFloat(match[1].replace(',', '.'))
                }

                // Try to find review count
                const reviewEl = document.querySelector('div.F7nice span[aria-label*="review"]')
                    || document.querySelector('span[aria-label*="reviews"]')
                    || document.querySelector('button[jsaction*="reviewChart"] span')
                if (reviewEl) {
                    const text = reviewEl.getAttribute('aria-label') || reviewEl.textContent || ''
                    const match = text.match(/([\d,.]+)/)
                    if (match) reviewCount = parseInt(match[1].replace(/[.,]/g, ''))
                }

                // Fallback: search all text for patterns
                if (avgRating === 0 || reviewCount === 0) {
                    const allText = document.body.innerText
                    if (avgRating === 0) {
                        const ratingMatch = allText.match(/([\d,.]+)\s*(?:stars?|sao)/i)
                        if (ratingMatch) avgRating = parseFloat(ratingMatch[1].replace(',', '.'))
                    }
                    if (reviewCount === 0) {
                        const countMatch = allText.match(/([\d,.]+)\s*(?:reviews?|đánh giá)/i)
                        if (countMatch) reviewCount = parseInt(countMatch[1].replace(/[.,]/g, ''))
                    }
                }

                return { avgRating, reviewCount }
            })

            this.setCache(cacheKey, metrics)
            return metrics
        } catch (err: any) {
            console.error('[Analytics] Maps scrape failed:', err.message)
            return { avgRating: 0, reviewCount: 0 }
        } finally {
            if (contextId) await browserService.closeContext(contextId).catch(() => { })
        }
    }

    /**
     * Scrape Google Business Profile performance page
     * URL: https://business.google.com/n/XXXXXX/searchperformance
     * Requires a logged-in Google account
     */
    async scrapeGBPInsights(locationUrl: string, accountId?: number): Promise<GBPScrapeMetrics> {
        const cacheKey = `gbp:${locationUrl}`
        const cached = this.getCached<GBPScrapeMetrics>(cacheKey)
        if (cached) return cached

        let contextId: number | null = null
        let page: Page | undefined = undefined
        try {
            const settings = loadSettings()

            // Try to find an account to login with
            const db = getDatabase()
            let account: any = null
            if (accountId) {
                account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()
            }
            if (!account) {
                // Pick first active account
                const activeAccounts = db.select().from(schema.accounts)
                    .where(eq(schema.accounts.status, 'active')).all()
                if (activeAccounts.length > 0) {
                    account = activeAccounts[0]
                }
            }

            await browserService.initBrowser(true)
            contextId = await browserService.createContext({
                headless: true,
                profilePath: account?.profilePath,
            })
            page = browserService.getPage(contextId)
            if (!page) throw new Error('Failed to create page')

            // Search for the business on Google to find GBP panel
            // Extract place name from URL for search
            const placeNameMatch = locationUrl.match(/place\/([^/@]+)/)
            const searchQuery = placeNameMatch
                ? decodeURIComponent(placeNameMatch[1].replace(/\+/g, ' '))
                : locationUrl

            await page.goto(`https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            })
            await HumanBehavior.randomDelay(3000, 5000)

            // Try to find GBP performance data in the knowledge panel
            const metrics = await page.evaluate(() => {
                let interactions = 0
                let calls = 0
                let directions = 0
                let websiteClicks = 0

                // Look for interaction stats in the business panel
                const allElements = document.querySelectorAll('[data-attrid], [data-item-id]')
                for (const el of Array.from(allElements)) {
                    const text = el.textContent || ''
                    const numMatch = text.match(/([\d,.]+)/)
                    if (!numMatch) continue
                    const num = parseInt(numMatch[1].replace(/[.,]/g, ''))

                    const attr = el.getAttribute('data-attrid') || el.getAttribute('data-item-id') || ''
                    if (attr.includes('phone') || text.includes('call')) calls = num
                    if (attr.includes('direction') || text.includes('direction')) directions = num
                    if (attr.includes('website') || text.includes('website')) websiteClicks = num
                }

                return { interactions, calls, directions, websiteClicks }
            })

            this.setCache(cacheKey, metrics)
            return metrics
        } catch (err: any) {
            console.error('[Analytics] GBP scrape failed:', err.message)
            return { interactions: 0, calls: 0, directions: 0, websiteClicks: 0 }
        } finally {
            if (contextId) await browserService.closeContext(contextId).catch(() => { })
        }
    }

    // ============================================================
    // Collect & Store
    // ============================================================

    /**
     * Collect analytics for a specific location based on its mode
     */
    async collectForLocation(locationId: number, dateRange?: AnalyticsDateRange): Promise<{
        success: boolean
        source: string
        error?: string
        ga4?: GA4Metrics
        gsc?: GSCMetrics
        maps?: MapsScrapeMetrics
        gbp?: GBPScrapeMetrics
    }> {
        const db = getDatabase()
        const location = db.select().from(schema.locations).where(eq(schema.locations.id, locationId)).get()
        if (!location) throw new Error('Location not found')

        const mode = (location as any).analyticsMode || 'none'
        if (mode === 'none') {
            return { success: false, source: 'none', error: 'Analytics mode is "none" for this location' }
        }

        const range = dateRange || this.getDefaultDateRange()
        const now = new Date()

        if (mode === 'api') {
            const ga4PropertyId = (location as any).ga4PropertyId
            const gscSiteUrl = (location as any).gscSiteUrl
            const results: any = { success: true, source: 'api' }

            // Fetch GA4
            if (ga4PropertyId) {
                try {
                    const ga4 = await this.fetchGA4Data(ga4PropertyId, range)
                    results.ga4 = ga4
                    // Save snapshot
                    this.saveSnapshot({
                        locationId,
                        source: 'ga4_api',
                        sessions: ga4.sessions,
                        users: ga4.users,
                        pageviews: ga4.pageviews,
                        bounceRate: ga4.bounceRate,
                        avgSessionDuration: ga4.avgSessionDuration,
                        dateFrom: range.from,
                        dateTo: range.to,
                        rawData: JSON.stringify(ga4),
                        createdAt: now,
                    })
                } catch (err: any) {
                    results.error = `GA4: ${err.message}`
                }
            }

            // Fetch GSC
            if (gscSiteUrl) {
                try {
                    const gsc = await this.fetchGSCData(gscSiteUrl, range)
                    results.gsc = gsc
                    this.saveSnapshot({
                        locationId,
                        source: 'gsc_api',
                        impressions: gsc.impressions,
                        clicks: gsc.clicks,
                        ctr: gsc.ctr,
                        avgPosition: gsc.avgPosition,
                        topQueries: JSON.stringify(gsc.topQueries),
                        dateFrom: range.from,
                        dateTo: range.to,
                        rawData: JSON.stringify(gsc),
                        createdAt: now,
                    })
                } catch (err: any) {
                    results.error = (results.error || '') + ` GSC: ${err.message}`
                }
            }

            return results
        }

        if (mode === 'scrape') {
            const results: any = { success: true, source: 'scrape' }

            // Scrape Maps metrics (always works)
            try {
                const maps = await this.scrapeMapMetrics(location.url)
                results.maps = maps
                this.saveSnapshot({
                    locationId,
                    source: 'maps_scrape',
                    reviewCount: maps.reviewCount,
                    avgRating: maps.avgRating,
                    dateFrom: range.from,
                    dateTo: range.to,
                    rawData: JSON.stringify(maps),
                    createdAt: now,
                })
            } catch (err: any) {
                results.error = `Maps scrape: ${err.message}`
            }

            // Scrape GBP insights
            try {
                const gbp = await this.scrapeGBPInsights(location.url)
                results.gbp = gbp
                this.saveSnapshot({
                    locationId,
                    source: 'gbp_scrape',
                    gbpInteractions: gbp.interactions,
                    gbpCalls: gbp.calls,
                    gbpDirections: gbp.directions,
                    gbpWebsiteClicks: gbp.websiteClicks,
                    dateFrom: range.from,
                    dateTo: range.to,
                    rawData: JSON.stringify(gbp),
                    createdAt: now,
                })
            } catch (err: any) {
                results.error = (results.error || '') + ` GBP scrape: ${err.message}`
            }

            return results
        }

        return { success: false, source: mode, error: 'Unknown analytics mode' }
    }

    /**
     * Test API connection with current credentials
     */
    async testApiConnection(): Promise<{ ga4: boolean; gsc: boolean; error?: string }> {
        try {
            const auth = this.getGoogleAuth()
            const token = await auth.getAccessToken()
            return { ga4: !!token, gsc: !!token }
        } catch (err: any) {
            return { ga4: false, gsc: false, error: err.message }
        }
    }

    /**
     * Get stored snapshots for a location
     */
    getSnapshots(locationId: number, dateRange?: AnalyticsDateRange, limit = 50): any[] {
        const db = getDatabase()
        try {
            if (!db) return []
            const sqlite = (db as any).session?.client
            if (!sqlite) return []

            let query = `SELECT * FROM analytics_snapshots WHERE location_id = ?`
            const params: any[] = [locationId]

            if (dateRange) {
                query += ` AND date_from >= ? AND date_to <= ?`
                params.push(dateRange.from, dateRange.to)
            }

            query += ` ORDER BY created_at DESC LIMIT ?`
            params.push(limit)

            return sqlite.prepare(query).all(...params)
        } catch (err: any) {
            console.error('[Analytics] Failed to get snapshots:', err.message)
            return []
        }
    }

    /**
     * Get the latest snapshot for each source for a location
     */
    getLatestSnapshots(locationId: number): Record<string, any> {
        const db = getDatabase()
        const result: Record<string, any> = {}
        try {
            const sqlite = (db as any).session?.client
            if (!sqlite) return result

            const sources = ['ga4_api', 'gsc_api', 'gbp_scrape', 'maps_scrape']
            for (const source of sources) {
                const row = sqlite.prepare(
                    `SELECT * FROM analytics_snapshots WHERE location_id = ? AND source = ? ORDER BY created_at DESC LIMIT 1`
                ).get(locationId, source)
                if (row) {
                    result[source] = row
                }
            }
        } catch (err: any) {
            console.error('[Analytics] Failed to get latest snapshots:', err.message)
        }
        return result
    }

    /**
     * Get trend data for charts (last N snapshots per source)
     */
    getTrend(locationId: number, source: string, limit = 30): any[] {
        const db = getDatabase()
        try {
            const sqlite = (db as any).session?.client
            if (!sqlite) return []

            return sqlite.prepare(
                `SELECT * FROM analytics_snapshots WHERE location_id = ? AND source = ? ORDER BY created_at ASC LIMIT ?`
            ).all(locationId, source, limit)
        } catch (err: any) {
            console.error('[Analytics] Failed to get trend:', err.message)
            return []
        }
    }

    // ---- Private helpers ----

    private saveSnapshot(snapshot: AnalyticsSnapshot) {
        const db = getDatabase()
        try {
            const sqlite = (db as any).session?.client
            if (!sqlite) return

            sqlite.prepare(`
                INSERT INTO analytics_snapshots (
                    location_id, source,
                    sessions, users, pageviews, bounce_rate, avg_session_duration,
                    impressions, clicks, ctr, avg_position, top_queries,
                    gbp_interactions, gbp_calls, gbp_directions, gbp_website_clicks,
                    review_count, avg_rating,
                    date_from, date_to, raw_data, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                snapshot.locationId, snapshot.source,
                snapshot.sessions ?? null, snapshot.users ?? null, snapshot.pageviews ?? null,
                snapshot.bounceRate ?? null, snapshot.avgSessionDuration ?? null,
                snapshot.impressions ?? null, snapshot.clicks ?? null,
                snapshot.ctr ?? null, snapshot.avgPosition ?? null, snapshot.topQueries ?? null,
                snapshot.gbpInteractions ?? null, snapshot.gbpCalls ?? null,
                snapshot.gbpDirections ?? null, snapshot.gbpWebsiteClicks ?? null,
                snapshot.reviewCount ?? null, snapshot.avgRating ?? null,
                snapshot.dateFrom, snapshot.dateTo,
                snapshot.rawData ?? null,
                Math.floor(snapshot.createdAt.getTime() / 1000),
            )
        } catch (err: any) {
            console.error('[Analytics] Failed to save snapshot:', err.message)
        }
    }

    private getDefaultDateRange(): AnalyticsDateRange {
        const to = new Date()
        const from = new Date()
        from.setDate(from.getDate() - 30)
        return {
            from: from.toISOString().split('T')[0],
            to: to.toISOString().split('T')[0],
        }
    }
}

export const analyticsService = new AnalyticsService()
