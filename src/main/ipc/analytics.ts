import { ipcMain, dialog, BrowserWindow } from 'electron'
import { analyticsService } from '../services/AnalyticsService'
import { getDatabase } from '../database'
import { locations } from '../database/schema'
import { eq } from 'drizzle-orm'

export function registerAnalyticsHandlers() {
    // Get analytics data (snapshots) for a location
    ipcMain.handle('analytics:getData', async (_event, locationId: number, dateRange?: { from: string; to: string }) => {
        try {
            const latest = analyticsService.getLatestSnapshots(locationId)
            const trend = analyticsService.getTrend(locationId, 'maps_scrape', 30)
            const trendGa4 = analyticsService.getTrend(locationId, 'ga4_api', 30)
            const trendGsc = analyticsService.getTrend(locationId, 'gsc_api', 30)
            const trendGbp = analyticsService.getTrend(locationId, 'gbp_scrape', 30)

            return {
                latest,
                trends: {
                    maps: trend,
                    ga4: trendGa4,
                    gsc: trendGsc,
                    gbp: trendGbp,
                },
            }
        } catch (error: any) {
            console.error('[Analytics] getData failed:', error)
            return { latest: {}, trends: {} }
        }
    })

    // Collect fresh data for a location
    ipcMain.handle('analytics:collect', async (_event, locationId: number) => {
        try {
            const result = await analyticsService.collectForLocation(locationId)
            return result
        } catch (error: any) {
            console.error('[Analytics] collect failed:', error)
            return { success: false, source: 'error', error: error.message }
        }
    })

    // Test API connection
    ipcMain.handle('analytics:testApiConnection', async () => {
        try {
            return await analyticsService.testApiConnection()
        } catch (error: any) {
            return { ga4: false, gsc: false, error: error.message }
        }
    })

    // OAuth2: Start Google Login flow
    ipcMain.handle('analytics:startGoogleLogin', async (_event, loginHint?: string) => {
        try {
            return await analyticsService.startOAuth2Flow(loginHint)
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // OAuth2: Get login status
    ipcMain.handle('analytics:getGoogleLoginStatus', async (_event, email?: string) => {
        try {
            return analyticsService.getGoogleLoginStatus(email)
        } catch (error: any) {
            return { loggedIn: false }
        }
    })

    // OAuth2: Logout
    ipcMain.handle('analytics:logoutGoogle', async (_event, email?: string) => {
        try {
            analyticsService.logoutGoogle(email)
            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // OAuth2: List GA4 Properties
    ipcMain.handle('analytics:listGA4Properties', async (_event, email?: string) => {
        try {
            return await analyticsService.listGA4Properties(email)
        } catch (error: any) {
            return { error: error.message }
        }
    })

    // OAuth2: List Search Console Sites
    ipcMain.handle('analytics:listSearchConsoleSites', async (_event, email?: string) => {
        try {
            return await analyticsService.listSearchConsoleSites(email)
        } catch (error: any) {
            return { error: error.message }
        }
    })

    // Select Service Account JSON key file
    ipcMain.handle('analytics:selectKeyFile', async () => {
        try {
            const window = BrowserWindow.getFocusedWindow()
            if (!window) return null

            const result = await dialog.showOpenDialog(window, {
                properties: ['openFile'],
                filters: [
                    { name: 'JSON Key File', extensions: ['json'] },
                ],
                title: 'Select Google Service Account Key File',
            })

            if (result.canceled || result.filePaths.length === 0) {
                return null
            }

            return result.filePaths[0]
        } catch (error: any) {
            console.error('[Analytics] selectKeyFile failed:', error)
            return null
        }
    })

    // Update location analytics config
    ipcMain.handle('analytics:updateLocationConfig', async (_event, locationId: number, config: {
        analyticsMode?: string
        ga4PropertyId?: string
        gscSiteUrl?: string
        analyticsGoogleEmail?: string
    }) => {
        try {
            const db = getDatabase()
            const sqlite = (db as any).session?.client
            if (!sqlite) throw new Error('Database not available')

            if (config.analyticsMode !== undefined) {
                sqlite.prepare('UPDATE locations SET analytics_mode = ? WHERE id = ?').run(config.analyticsMode, locationId)
            }
            if (config.ga4PropertyId !== undefined) {
                sqlite.prepare('UPDATE locations SET ga4_property_id = ? WHERE id = ?').run(config.ga4PropertyId, locationId)
            }
            if (config.gscSiteUrl !== undefined) {
                sqlite.prepare('UPDATE locations SET gsc_site_url = ? WHERE id = ?').run(config.gscSiteUrl, locationId)
            }
            if (config.analyticsGoogleEmail !== undefined) {
                sqlite.prepare('UPDATE locations SET analytics_google_email = ? WHERE id = ?').run(config.analyticsGoogleEmail, locationId)
            }

            return { success: true }
        } catch (error: any) {
            console.error('[Analytics] updateLocationConfig failed:', error)
            return { success: false, error: error.message }
        }
    })

    // Get location analytics config
    ipcMain.handle('analytics:getLocationConfig', async (_event, locationId: number) => {
        try {
            const db = getDatabase()
            const sqlite = (db as any).session?.client
            if (!sqlite) return { analyticsMode: 'none' }

            const row = sqlite.prepare('SELECT analytics_mode, ga4_property_id, gsc_site_url, analytics_google_email FROM locations WHERE id = ?').get(locationId)
            return {
                analyticsMode: row?.analytics_mode || 'none',
                ga4PropertyId: row?.ga4_property_id || '',
                gscSiteUrl: row?.gsc_site_url || '',
                analyticsGoogleEmail: row?.analytics_google_email || '',
            }
        } catch (error: any) {
            console.error('[Analytics] getLocationConfig failed:', error)
            return { analyticsMode: 'none' }
        }
    })

    // Get all locations with their analytics configs
    ipcMain.handle('analytics:getLocationsWithConfig', async () => {
        try {
            const db = getDatabase()
            const sqlite = (db as any).session?.client
            if (!sqlite) return []

            const rows = sqlite.prepare(`
                SELECT id, name, url, category, analytics_mode, ga4_property_id, gsc_site_url, analytics_google_email 
                FROM locations 
                ORDER BY created_at DESC
            `).all()

            return rows.map((r: any) => ({
                id: r.id,
                name: r.name,
                url: r.url,
                category: r.category,
                analyticsMode: r.analytics_mode || 'none',
                ga4PropertyId: r.ga4_property_id || '',
                gscSiteUrl: r.gsc_site_url || '',
                analyticsGoogleEmail: r.analytics_google_email || '',
            }))
        } catch (error: any) {
            console.error('[Analytics] list properties failed:', error)
            return []
        }
    })
}
