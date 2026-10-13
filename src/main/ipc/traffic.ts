import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDatabase } from '../database'
import { trafficTasks, TrafficTask, locations, trafficCampaigns, trafficLogs, accounts } from '../database/schema'
import { eq, inArray } from 'drizzle-orm'
import { trafficBoostEngine } from '../automation/TrafficBoostEngine'
import { trafficVisitQueue } from '../automation/TrafficVisitQueue'
import {
    idSchema,
    normalizeWebSeoTargetUrl,
    parseWebSeoKeywords,
    positiveIdListSchema,
    trafficBoostCreateSchema,
    trafficBoostUpdateSchema,
    trafficTaskCreateSchema,
    trafficTaskUpdateSchema,
} from '../../shared/ipc-schemas'
import {
    trafficVisitCampaignIdSchema,
    trafficVisitQueueStatsSchema,
    trafficVisitRecoverResultSchema,
} from '../../shared/traffic-visit-contracts'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

const WEB_SEO_DWELL_DEFAULT_MIN = 45
const WEB_SEO_DWELL_DEFAULT_MAX = 90

type TrafficDb = ReturnType<typeof getDatabase>
type TrafficCampaignRow = typeof trafficCampaigns.$inferSelect

function parseIdListJson(raw: string | null | undefined): number[] {
    if (!raw) return []
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
    } catch {
        return []
    }
}

/**
 * Load every requested location; each URL must be a public/safe Web SEO target.
 * Errors never include credential-bearing or raw secret URL material.
 */
function assertWebSeoLocationsSafe(db: TrafficDb, locationIds: number[]): void {
    const uniqueIds = Array.from(new Set(locationIds))
    if (uniqueIds.length === 0) {
        throw new Error('web_seo mode requires at least one location')
    }

    const rows = db.select().from(locations).where(inArray(locations.id, uniqueIds)).all()
    if (rows.length !== uniqueIds.length) {
        const found = new Set(rows.map((r) => r.id))
        const missing = uniqueIds.filter((id) => !found.has(id))
        throw new Error(
            `web_seo campaign references missing location id(s): ${missing.join(', ')}`,
        )
    }

    for (const loc of rows) {
        // Shared fail-closed helper: returns absolute public URL or null (never raw unsafe input).
        const normalized = normalizeWebSeoTargetUrl(loc.url ?? '')
        if (!normalized) {
            throw new Error(
                `web_seo location ${loc.id} has invalid or non-public target URL`,
            )
        }
    }
}

function uniqueNumericIds(values: ReadonlyArray<number | null>): number[] {
    const ids = new Set<number>()
    for (const value of values) {
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) ids.add(value)
    }
    return Array.from(ids)
}

function parseLogActions(raw: string): unknown {
    try {
        const parsed: unknown = JSON.parse(raw || '[]')
        return parsed
    } catch {
        return []
    }
}

/** One query for every distinct account referenced by the log page. */
function loadAccountEmailMap(db: TrafficDb, accountIds: number[]): Map<number, string> {
    const emails = new Map<number, string>()
    if (accountIds.length === 0) return emails
    const rows = db.select({ id: accounts.id, email: accounts.email })
        .from(accounts)
        .where(inArray(accounts.id, accountIds))
        .all()
    for (const row of rows) emails.set(row.id, row.email)
    return emails
}

/** One query for every distinct location referenced by the log page. */
function loadLocationNameMap(db: TrafficDb, locationIds: number[]): Map<number, string> {
    const names = new Map<number, string>()
    if (locationIds.length === 0) return names
    const rows = db.select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(inArray(locations.id, locationIds))
        .all()
    for (const row of rows) names.set(row.id, row.name)
    return names
}

/**
 * Campaign logs plus display names.
 * Three queries total (logs, accounts, locations) instead of two lookups per row.
 */
function loadTrafficBoostLogs(campaignId: number) {
    const db = getDatabase()
    const logs = db.select().from(trafficLogs)
        .where(eq(trafficLogs.campaignId, campaignId))
        .all()
    const accountEmails = loadAccountEmailMap(db, uniqueNumericIds(logs.map((log) => log.accountId)))
    const locationNames = loadLocationNameMap(db, uniqueNumericIds(logs.map((log) => log.locationId)))

    return logs.map((log) => ({
        ...log,
        accountEmail: (log.accountId != null ? accountEmails.get(log.accountId) : undefined) || 'Anonymous',
        locationName: locationNames.get(log.locationId) || 'Unknown',
        actions: parseLogActions(log.actions),
    }))
}

function resolveDwellWindow(
    minInput: number | undefined,
    maxInput: number | undefined,
    currentMin: number | null | undefined,
    currentMax: number | null | undefined,
): { min: number; max: number } {
    const min = typeof minInput === 'number'
        ? minInput
        : (currentMin ?? WEB_SEO_DWELL_DEFAULT_MIN)
    const maxRaw = typeof maxInput === 'number'
        ? maxInput
        : (currentMax ?? WEB_SEO_DWELL_DEFAULT_MAX)
    return { min, max: Math.max(min, maxRaw) }
}

/**
 * When the resulting traffic mode is web_seo, enforce public locations + non-empty keywords.
 * Mutates updateData only for keyword re-normalization already staged by caller.
 */
function applyWebSeoUpdateGuards(
    db: TrafficDb,
    current: TrafficCampaignRow,
    parsed: {
        locationIds?: number[]
        searchKeywords?: string[]
    },
    updateData: Record<string, string | number | boolean | null>,
): void {
    const locationIds = parsed.locationIds ?? parseIdListJson(current.locationIds)
    assertWebSeoLocationsSafe(db, locationIds)

    const keywords = parsed.searchKeywords !== undefined
        ? parseWebSeoKeywords(parsed.searchKeywords)
        : parseWebSeoKeywords(
            typeof updateData.searchKeywords === 'string'
                ? updateData.searchKeywords
                : current.searchKeywords,
        )

    if (keywords.length === 0) {
        throw new Error('web_seo mode requires at least one non-empty search keyword')
    }

    // Ensure persisted keywords are normalized/deduped when mode is web_seo
    if (parsed.searchKeywords !== undefined || updateData.searchKeywords !== undefined) {
        updateData.searchKeywords = JSON.stringify(keywords)
    }
}

export function registerTrafficHandlers() {
    // Get all traffic tasks
    ipcMain.handle('traffic:getAll', withIpcValidation('traffic:getAll', async () => {
        try {
            const db = getDatabase()
            const tasks = db.select().from(trafficTasks).all()

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
    }))

    // Create a new traffic task
    ipcMain.handle('traffic:create', withIpcValidation('traffic:create', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('traffic:create', trafficTaskCreateSchema, data)
        try {
            const db = getDatabase()
            const result = db.insert(trafficTasks).values({
                locationId: parsed.locationId,
                targetViews: parsed.targetViews,
                currentViews: 0,
                viewsPerDay: parsed.viewsPerDay || 100,
                useProxies: parsed.useProxies !== false,
                status: 'pending',
                createdAt: new Date(),
            }).returning().get()
            return result
        } catch (error) {
            console.error('Failed to create traffic task:', error)
            throw error
        }
    }))

    // Update traffic task
    ipcMain.handle('traffic:update', withIpcValidation('traffic:update', async (_event, id: unknown, data: unknown) => {
        const [parsedId, parsedData] = parseIpcArgs(
            'traffic:update',
            z.tuple([idSchema, trafficTaskUpdateSchema]),
            [id, data],
        )
        try {
            const db = getDatabase()
            const result = db.update(trafficTasks)
                .set(parsedData)
                .where(eq(trafficTasks.id, parsedId))
                .returning()
                .get()
            return result
        } catch (error) {
            console.error('Failed to update traffic task:', error)
            throw error
        }
    }))

    // Delete traffic task
    ipcMain.handle('traffic:delete', withIpcValidation('traffic:delete', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('traffic:delete', idSchema, id)
        try {
            const db = getDatabase()
            db.delete(trafficTasks).where(eq(trafficTasks.id, parsedId)).run()
        } catch (error) {
            console.error('Failed to delete traffic task:', error)
            throw error
        }
    }))

    // Start traffic task
    ipcMain.handle('traffic:start', withIpcValidation('traffic:start', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('traffic:start', idSchema, id)
        try {
            const db = getDatabase()
            db.update(trafficTasks)
                .set({ status: 'running', startedAt: new Date() })
                .where(eq(trafficTasks.id, parsedId))
                .run()
        } catch (error) {
            console.error('Failed to start traffic task:', error)
            throw error
        }
    }))

    // Stop traffic task
    ipcMain.handle('traffic:stop', withIpcValidation('traffic:stop', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('traffic:stop', idSchema, id)
        try {
            const db = getDatabase()
            db.update(trafficTasks)
                .set({ status: 'stopped' })
                .where(eq(trafficTasks.id, parsedId))
                .run()
        } catch (error) {
            console.error('Failed to stop traffic task:', error)
            throw error
        }
    }))

    // Get traffic stats
    ipcMain.handle('traffic:getStats', withIpcValidation('traffic:getStats', async () => {
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
    }))

    // ============================================================
    // Traffic Boost Campaign Handlers
    // ============================================================

    ipcMain.handle('trafficBoost:getCampaigns', withIpcValidation('trafficBoost:getCampaigns', async () => {
        try {
            const db = getDatabase()
            const campaigns = db.select().from(trafficCampaigns).all()

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
    }))

    ipcMain.handle('trafficBoost:createCampaign', withIpcValidation('trafficBoost:createCampaign', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('trafficBoost:createCampaign', trafficBoostCreateSchema, data)
        try {
            const db = getDatabase()
            const trafficMode = parsed.trafficMode || 'direct'
            const delayMinSeconds = Math.max(0, parsed.delayMinSeconds ?? 10)
            const delayMaxSecondsInput = Math.max(0, parsed.delayMaxSeconds ?? 30)
            const delayMaxSeconds = Math.max(delayMinSeconds, delayMaxSecondsInput)
            const threadsCount = Math.max(1, Math.floor(parsed.threadsCount ?? 1))

            const providedMax = typeof parsed.maxMapScroll === 'number' ? parsed.maxMapScroll : 15
            const clampedMax = Math.max(1, Math.min(100, Math.floor(providedMax)))

            const dwell = resolveDwellWindow(
                parsed.webSeoMinDwellSeconds,
                parsed.webSeoMaxDwellSeconds,
                WEB_SEO_DWELL_DEFAULT_MIN,
                WEB_SEO_DWELL_DEFAULT_MAX,
            )
            const webSeoRequireOrganic = parsed.webSeoRequireOrganic === true

            const normalizedKeywords = parseWebSeoKeywords(parsed.searchKeywords)
            if (trafficMode === 'web_seo') {
                if (normalizedKeywords.length === 0) {
                    throw new Error('web_seo mode requires at least one non-empty search keyword')
                }
                assertWebSeoLocationsSafe(db, parsed.locationIds)
            }

            return db.insert(trafficCampaigns).values({
                name: parsed.name,
                trafficMode,
                searchKeywords: normalizedKeywords.length > 0
                    ? JSON.stringify(normalizedKeywords)
                    : null,
                maxMapScroll: clampedMax,
                accountIds: JSON.stringify(parsed.accountIds),
                locationIds: JSON.stringify(parsed.locationIds),
                threadsCount,
                visitsPerLocation: parsed.visitsPerLocation || 10,
                delayMinSeconds,
                delayMaxSeconds,
                actionsPerVisit: 4,
                fixedActionCount: false,
                enabledActions: null,
                targetKpi: null,
                aiAutoControl: parsed.aiAutoControl === true,
                webSeoMinDwellSeconds: dwell.min,
                webSeoMaxDwellSeconds: dwell.max,
                webSeoRequireOrganic,
                status: 'pending',
                createdAt: new Date(),
            }).returning().get()
        } catch (error) {
            console.error('Failed to create campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:updateCampaign', withIpcValidation('trafficBoost:updateCampaign', async (
        _event,
        id: unknown,
        data: unknown,
    ) => {
        const [parsedId, parsed] = parseIpcArgs(
            'trafficBoost:updateCampaign',
            z.tuple([idSchema, trafficBoostUpdateSchema]),
            [id, data],
        )
        try {
            const db = getDatabase()
            const current = db.select().from(trafficCampaigns).where(eq(trafficCampaigns.id, parsedId)).get()
            if (!current) {
                throw new Error(`Campaign ${parsedId} not found`)
            }

            const updateData: Record<string, string | number | boolean | null> = {}
            const resultingMode = parsed.trafficMode ?? current.trafficMode

            if (parsed.name !== undefined) updateData.name = parsed.name
            if (parsed.trafficMode !== undefined) updateData.trafficMode = parsed.trafficMode
            if (parsed.accountIds) updateData.accountIds = JSON.stringify(parsed.accountIds)
            if (parsed.locationIds) updateData.locationIds = JSON.stringify(parsed.locationIds)

            if (parsed.searchKeywords !== undefined) {
                const normalizedKeywords = parseWebSeoKeywords(parsed.searchKeywords)
                updateData.searchKeywords = normalizedKeywords.length > 0
                    ? JSON.stringify(normalizedKeywords)
                    : null
            }

            if (typeof parsed.visitsPerLocation === 'number') {
                updateData.visitsPerLocation = parsed.visitsPerLocation
            }

            if (typeof parsed.threadsCount === 'number') {
                updateData.threadsCount = Math.max(1, Math.floor(parsed.threadsCount))
            }

            if (typeof parsed.delayMinSeconds === 'number' || typeof parsed.delayMaxSeconds === 'number') {
                const resolvedMin = Math.max(0, typeof parsed.delayMinSeconds === 'number'
                    ? parsed.delayMinSeconds
                    : current.delayMinSeconds ?? 10)
                const resolvedMaxInput = Math.max(0, typeof parsed.delayMaxSeconds === 'number'
                    ? parsed.delayMaxSeconds
                    : current.delayMaxSeconds ?? 30)
                updateData.delayMinSeconds = resolvedMin
                updateData.delayMaxSeconds = Math.max(resolvedMin, resolvedMaxInput)
            }

            if (
                typeof parsed.webSeoMinDwellSeconds === 'number'
                || typeof parsed.webSeoMaxDwellSeconds === 'number'
            ) {
                const dwell = resolveDwellWindow(
                    parsed.webSeoMinDwellSeconds,
                    parsed.webSeoMaxDwellSeconds,
                    current.webSeoMinDwellSeconds,
                    current.webSeoMaxDwellSeconds,
                )
                updateData.webSeoMinDwellSeconds = dwell.min
                updateData.webSeoMaxDwellSeconds = dwell.max
            }

            if (typeof parsed.webSeoRequireOrganic === 'boolean') {
                updateData.webSeoRequireOrganic = parsed.webSeoRequireOrganic
            }

            if (typeof parsed.aiAutoControl === 'boolean') {
                updateData.aiAutoControl = parsed.aiAutoControl
            }

            if (typeof parsed.maxMapScroll === 'number') {
                updateData.maxMapScroll = Math.max(1, Math.min(100, Math.floor(parsed.maxMapScroll)))
            }

            if (resultingMode === 'web_seo') {
                applyWebSeoUpdateGuards(db, current, parsed, updateData)
            }

            return db.update(trafficCampaigns)
                .set(updateData)
                .where(eq(trafficCampaigns.id, parsedId))
                .returning().get()
        } catch (error) {
            console.error('Failed to update campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:deleteCampaign', withIpcValidation('trafficBoost:deleteCampaign', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('trafficBoost:deleteCampaign', idSchema, id)
        try {
            await trafficVisitQueue.cancelCampaignVisits(parsedId)
            const db = getDatabase()
            db.delete(trafficLogs).where(eq(trafficLogs.campaignId, parsedId)).run()
            db.delete(trafficCampaigns).where(eq(trafficCampaigns.id, parsedId)).run()
            return { success: true }
        } catch (error) {
            console.error('Failed to delete campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:deleteCampaigns', withIpcValidation('trafficBoost:deleteCampaigns', async (_event, ids: unknown) => {
        const campaignIds = parseIpcPayload('trafficBoost:deleteCampaigns', positiveIdListSchema, ids)
        try {
            const db = getDatabase()
            const uniqueIds = Array.from(new Set(campaignIds))

            for (const campaignId of uniqueIds) {
                await trafficVisitQueue.cancelCampaignVisits(campaignId)
                db.delete(trafficLogs).where(eq(trafficLogs.campaignId, campaignId)).run()
                db.delete(trafficCampaigns).where(eq(trafficCampaigns.id, campaignId)).run()
            }

            return { success: true, deleted: uniqueIds.length }
        } catch (error) {
            console.error('Failed to bulk delete campaigns:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:start', withIpcValidation('trafficBoost:start', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('trafficBoost:start', idSchema, id)
        try {
            // Recover any expired leases from a prior crash before workers claim
            await trafficVisitQueue.ensureLoaded()
            await trafficVisitQueue.recoverExpiredLeases(parsedId)
            trafficBoostEngine.startCampaign(parsedId).catch(err => {
                console.error('[TrafficBoost] Campaign failed:', err)
            })
            return { success: true }
        } catch (error) {
            console.error('Failed to start campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:stop', withIpcValidation('trafficBoost:stop', async () => {
        try {
            await trafficBoostEngine.stopCampaign()
            return { success: true }
        } catch (error) {
            console.error('Failed to stop campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:pause', withIpcValidation('trafficBoost:pause', async () => {
        try {
            await trafficBoostEngine.pauseCampaign()
            return { success: true }
        } catch (error) {
            console.error('Failed to pause campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:resume', withIpcValidation('trafficBoost:resume', async () => {
        try {
            await trafficBoostEngine.resumeCampaign()
            return { success: true }
        } catch (error) {
            console.error('Failed to resume campaign:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:getStatus', withIpcValidation('trafficBoost:getStatus', async () => {
        return trafficBoostEngine.getStatus()
    }))

    ipcMain.handle('trafficBoost:getReport', withIpcValidation('trafficBoost:getReport', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('trafficBoost:getReport', idSchema, id)
        try {
            return trafficBoostEngine.getReport(parsedId)
        } catch (error) {
            console.error('Failed to get report:', error)
            throw error
        }
    }))

    ipcMain.handle('trafficBoost:getLogs', withIpcValidation('trafficBoost:getLogs', async (_event, campaignId: unknown) => {
        const parsedId = parseIpcPayload('trafficBoost:getLogs', idSchema, campaignId)
        try {
            return loadTrafficBoostLogs(parsedId)
        } catch (error) {
            console.error('Failed to get logs:', error)
            return []
        }
    }))

    ipcMain.handle('trafficBoost:getAudit', withIpcValidation('trafficBoost:getAudit', async (_event, campaignId: unknown) => {
        const parsedId = parseIpcPayload('trafficBoost:getAudit', idSchema, campaignId)
        try {
            return trafficBoostEngine.getAuditReport(parsedId)
        } catch (error) {
            console.error('Failed to get audit report:', error)
            throw error
        }
    }))

    // Durable per-visit queue stats (campaign counters without duplicate visits)
    ipcMain.handle('trafficBoost:getVisitQueueStats', withIpcValidation(
        'trafficBoost:getVisitQueueStats',
        async (_event, campaignId: unknown) => {
            const parsedId = parseIpcPayload(
                'trafficBoost:getVisitQueueStats',
                trafficVisitCampaignIdSchema,
                campaignId,
            )
            try {
                await trafficVisitQueue.ensureLoaded()
                const counters = trafficVisitQueue.getCampaignCounters(parsedId)
                // Strict Zod outbound: reject malformed counter shapes before IPC return
                return parseIpcPayload(
                    'trafficBoost:getVisitQueueStats:response',
                    trafficVisitQueueStatsSchema,
                    {
                        campaignId: parsedId,
                        counters,
                        recoveredOnBoot: trafficVisitQueue.getLastRecoveredCount(),
                    },
                )
            } catch (error) {
                console.error('Failed to get visit queue stats:', error)
                throw error
            }
        },
    ))

    // Recover expired running leases for a campaign (requires positive campaign id)
    ipcMain.handle('trafficBoost:recoverVisitLeases', withIpcValidation(
        'trafficBoost:recoverVisitLeases',
        async (_event, campaignId: unknown) => {
            const parsedId = parseIpcPayload(
                'trafficBoost:recoverVisitLeases',
                trafficVisitCampaignIdSchema,
                campaignId,
            )
            try {
                const result = await trafficBoostEngine.recoverVisitLeases(parsedId)
                return parseIpcPayload(
                    'trafficBoost:recoverVisitLeases:response',
                    trafficVisitRecoverResultSchema,
                    result,
                )
            } catch (error) {
                console.error('Failed to recover visit leases:', error)
                throw error
            }
        },
    ))
}
