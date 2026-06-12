import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { trafficTasks, TrafficTask, locations, trafficCampaigns, trafficLogs, accounts } from '../database/schema'
import { eq } from 'drizzle-orm'
import { trafficBoostEngine } from '../automation/TrafficBoostEngine'

export function registerTrafficHandlers() {
    // Get all traffic tasks
    ipcMain.handle('traffic:getAll', async () => {
        try {
            const db = getDatabase()
            const tasks = db.select().from(trafficTasks).all()

            // Get location names for display
            const result = []
            for (const task of tasks) {
                const location = db.select().from(locations).where(eq(locations.id, task.locationId)).get()
                result.push({
                    ...task,
                    location: location || null,
                })
            }
            return result
        } catch (error) {
            console.error('Failed to get traffic tasks:', error)
            return []
        }
    })

    // Create a new traffic task
    ipcMain.handle('traffic:create', async (_event, data: {
        locationId: number
        targetViews: number
        viewsPerDay?: number
        useProxies?: boolean
    }) => {
        try {
            const db = getDatabase()
            const result = db.insert(trafficTasks).values({
                locationId: data.locationId,
                targetViews: data.targetViews,
                currentViews: 0,
                viewsPerDay: data.viewsPerDay || 100,
                useProxies: data.useProxies !== false, // Default true
                status: 'pending',
                createdAt: new Date(),
            }).returning().get()
            return result
        } catch (error) {
            console.error('Failed to create traffic task:', error)
            throw error
        }
    })

    // Update traffic task
    ipcMain.handle('traffic:update', async (_event, id: number, data: Partial<TrafficTask>) => {
        try {
            const db = getDatabase()
            const result = db.update(trafficTasks)
                .set(data)
                .where(eq(trafficTasks.id, id))
                .returning()
                .get()
            return result
        } catch (error) {
            console.error('Failed to update traffic task:', error)
            throw error
        }
    })

    // Delete traffic task
    ipcMain.handle('traffic:delete', async (_event, id: number) => {
        try {
            const db = getDatabase()
            db.delete(trafficTasks).where(eq(trafficTasks.id, id)).run()
        } catch (error) {
            console.error('Failed to delete traffic task:', error)
            throw error
        }
    })

    // Start traffic task (placeholder - will integrate with automation engine)
    ipcMain.handle('traffic:start', async (_event, id: number) => {
        try {
            const db = getDatabase()
            db.update(trafficTasks)
                .set({ status: 'running', startedAt: new Date() })
                .where(eq(trafficTasks.id, id))
                .run()
            // TODO: Start traffic automation
        } catch (error) {
            console.error('Failed to start traffic task:', error)
            throw error
        }
    })

    // Stop traffic task
    ipcMain.handle('traffic:stop', async (_event, id: number) => {
        try {
            const db = getDatabase()
            db.update(trafficTasks)
                .set({ status: 'stopped' })
                .where(eq(trafficTasks.id, id))
                .run()
            // TODO: Stop traffic automation
        } catch (error) {
            console.error('Failed to stop traffic task:', error)
            throw error
        }
    })

    // Get traffic stats
    ipcMain.handle('traffic:getStats', async () => {
        try {
            const db = getDatabase()
            const all = db.select().from(trafficTasks).all()
            const running = all.filter((t: TrafficTask) => t.status === 'running').length
            const pending = all.filter((t: TrafficTask) => t.status === 'pending').length
            const completed = all.filter((t: TrafficTask) => t.status === 'completed').length
            const totalViews = all.reduce((sum: number, t: TrafficTask) => sum + (t.currentViews || 0), 0)

            return {
                total: all.length,
                running,
                pending,
                completed,
                totalViews,
            }
        } catch (error) {
            console.error('Failed to get traffic stats:', error)
            return { total: 0, running: 0, pending: 0, completed: 0, totalViews: 0 }
        }
    })

    // ============================================================
    // Traffic Boost Campaign Handlers
    // ============================================================

    // Get all campaigns with enriched data
    ipcMain.handle('trafficBoost:getCampaigns', async () => {
        try {
            const db = getDatabase()
            const campaigns = db.select().from(trafficCampaigns).all()

            // Query accounts and locations once instead of per-campaign
            const allAccounts = db.select().from(accounts).all()
            const allLocations = db.select().from(locations).all()
            const accountMap = new Map(allAccounts.map(a => [a.id, a]))
            const locationMap = new Map(allLocations.map(l => [l.id, l]))

            return campaigns.map(c => {
                let accountIds: number[] = []
                let locationIds: number[] = []
                try { accountIds = JSON.parse(c.accountIds || '[]') } catch { /* skip */ }
                try { locationIds = JSON.parse(c.locationIds || '[]') } catch { /* skip */ }

                return {
                    ...c,
                    accounts: accountIds.map(id => accountMap.get(id)).filter(Boolean).map(a => ({ id: a!.id, email: a!.email })),
                    locations: locationIds.map(id => locationMap.get(id)).filter(Boolean).map(l => ({ id: l!.id, name: l!.name, url: l!.url })),
                }
            })
        } catch (error) {
            console.error('Failed to get traffic campaigns:', error)
            return []
        }
    })

    // Create campaign. Map traffic defaults to deterministic SEO automation.
    ipcMain.handle('trafficBoost:createCampaign', async (_event, data: {
        name: string
        trafficMode?: 'direct' | 'organic' | 'web_seo' | 'map_search'
        searchKeywords?: string[]
        maxMapScroll?: number
        accountIds: number[]
        locationIds: number[]
        threadsCount?: number
        visitsPerLocation?: number
        delayMinSeconds?: number
        delayMaxSeconds?: number
        aiAutoControl?: boolean
    }) => {
        try {
            const db = getDatabase()
            const delayMinSeconds = Math.max(0, data.delayMinSeconds ?? 10)
            const delayMaxSecondsInput = Math.max(0, data.delayMaxSeconds ?? 30)
            const delayMaxSeconds = Math.max(delayMinSeconds, delayMaxSecondsInput)
            const threadsCount = Math.max(1, Math.floor(data.threadsCount ?? 1))

            const providedMax = typeof data.maxMapScroll === 'number' ? data.maxMapScroll : 15
            const clampedMax = Math.max(1, Math.min(100, Math.floor(providedMax)))

            return db.insert(trafficCampaigns).values({
                name: data.name,
                trafficMode: data.trafficMode || 'direct',
                searchKeywords: data.searchKeywords ? JSON.stringify(data.searchKeywords) : null,
                maxMapScroll: clampedMax,
                accountIds: JSON.stringify(data.accountIds),
                locationIds: JSON.stringify(data.locationIds),
                threadsCount,
                visitsPerLocation: data.visitsPerLocation || 10,
                delayMinSeconds,
                delayMaxSeconds,
                // Deterministic SEO defaults kept for DB compatibility.
                actionsPerVisit: 4,
                fixedActionCount: false,
                enabledActions: null,
                targetKpi: null,
                aiAutoControl: data.aiAutoControl === true,
                status: 'pending',
                createdAt: new Date(),
            }).returning().get()
        } catch (error) {
            console.error('Failed to create campaign:', error)
            throw error
        }
    })

    // Update campaign.
    ipcMain.handle('trafficBoost:updateCampaign', async (_event, id: number, data: any) => {
        try {
            const db = getDatabase()
            const updateData: any = {}

            // Core fields that users can still change
            if (data.name !== undefined) updateData.name = data.name
            if (data.trafficMode !== undefined) updateData.trafficMode = data.trafficMode
            if (data.accountIds) updateData.accountIds = JSON.stringify(data.accountIds)
            if (data.locationIds) updateData.locationIds = JSON.stringify(data.locationIds)
            if (data.searchKeywords) updateData.searchKeywords = JSON.stringify(data.searchKeywords)
            if (typeof data.visitsPerLocation === 'number') updateData.visitsPerLocation = data.visitsPerLocation

            if (typeof data.threadsCount === 'number') {
                updateData.threadsCount = Math.max(1, Math.floor(data.threadsCount))
            }

            if (typeof data.delayMinSeconds === 'number' || typeof data.delayMaxSeconds === 'number') {
                const current = db.select().from(trafficCampaigns).where(eq(trafficCampaigns.id, id)).get()
                const resolvedMin = Math.max(0, typeof data.delayMinSeconds === 'number'
                    ? data.delayMinSeconds
                    : current?.delayMinSeconds ?? 10)
                const resolvedMaxInput = Math.max(0, typeof data.delayMaxSeconds === 'number'
                    ? data.delayMaxSeconds
                    : current?.delayMaxSeconds ?? 30)
                updateData.delayMinSeconds = resolvedMin
                updateData.delayMaxSeconds = Math.max(resolvedMin, resolvedMaxInput)
            }

            if (typeof data.aiAutoControl === 'boolean') {
                updateData.aiAutoControl = data.aiAutoControl
            }

            if (typeof data.maxMapScroll === 'number') {
                updateData.maxMapScroll = Math.max(1, Math.min(100, Math.floor(data.maxMapScroll)))
            }

            return db.update(trafficCampaigns)
                .set(updateData)
                .where(eq(trafficCampaigns.id, id))
                .returning().get()
        } catch (error) {
            console.error('Failed to update campaign:', error)
            throw error
        }
    })

    // Delete campaign and its logs
    ipcMain.handle('trafficBoost:deleteCampaign', async (_event, id: number) => {
        try {
            const db = getDatabase()
            db.delete(trafficLogs).where(eq(trafficLogs.campaignId, id)).run()
            db.delete(trafficCampaigns).where(eq(trafficCampaigns.id, id)).run()
            return { success: true }
        } catch (error) {
            console.error('Failed to delete campaign:', error)
            throw error
        }
    })

    // Bulk delete campaigns and their logs
    ipcMain.handle('trafficBoost:deleteCampaigns', async (_event, ids: number[]) => {
        try {
            const db = getDatabase()
            const campaignIds = Array.from(new Set((Array.isArray(ids) ? ids : [])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)))

            for (const campaignId of campaignIds) {
                db.delete(trafficLogs).where(eq(trafficLogs.campaignId, campaignId)).run()
                db.delete(trafficCampaigns).where(eq(trafficCampaigns.id, campaignId)).run()
            }

            return { success: true, deleted: campaignIds.length }
        } catch (error) {
            console.error('Failed to bulk delete campaigns:', error)
            throw error
        }
    })

    // Start campaign
    ipcMain.handle('trafficBoost:start', async (_event, id: number) => {
        try {
            // Start in background (don't await)
            trafficBoostEngine.startCampaign(id).catch(err => {
                console.error('[TrafficBoost] Campaign failed:', err)
            })
            return { success: true }
        } catch (error) {
            console.error('Failed to start campaign:', error)
            throw error
        }
    })

    // Stop campaign
    ipcMain.handle('trafficBoost:stop', async () => {
        try {
            await trafficBoostEngine.stopCampaign()
            return { success: true }
        } catch (error) {
            console.error('Failed to stop campaign:', error)
            throw error
        }
    })

    // Pause campaign
    ipcMain.handle('trafficBoost:pause', async () => {
        try {
            await trafficBoostEngine.pauseCampaign()
            return { success: true }
        } catch (error) {
            console.error('Failed to pause campaign:', error)
            throw error
        }
    })

    // Get realtime status
    ipcMain.handle('trafficBoost:getStatus', async () => {
        return trafficBoostEngine.getStatus()
    })

    // Get campaign report
    ipcMain.handle('trafficBoost:getReport', async (_event, id: number) => {
        try {
            return trafficBoostEngine.getReport(id)
        } catch (error) {
            console.error('Failed to get report:', error)
            throw error
        }
    })

    // Get logs for a campaign
    ipcMain.handle('trafficBoost:getLogs', async (_event, campaignId: number) => {
        try {
            const db = getDatabase()
            const logs = db.select().from(trafficLogs)
                .where(eq(trafficLogs.campaignId, campaignId))
                .all()

            return logs.map(log => {
                const account = log.accountId
                    ? db.select().from(accounts).where(eq(accounts.id, log.accountId)).get()
                    : null
                const location = db.select().from(locations).where(eq(locations.id, log.locationId)).get()

                return {
                    ...log,
                    accountEmail: account?.email || 'Anonymous',
                    locationName: location?.name || 'Unknown',
                    actions: (() => { try { return JSON.parse(log.actions || '[]') } catch { return [] } })(),
                }
            })
        } catch (error) {
            console.error('Failed to get logs:', error)
            return []
        }
    })

    // Get traffic audit report (quality analysis)
    ipcMain.handle('trafficBoost:getAudit', async (_event, campaignId: number) => {
        try {
            return trafficBoostEngine.getAuditReport(campaignId)
        } catch (error) {
            console.error('Failed to get audit report:', error)
            throw error
        }
    })

}

