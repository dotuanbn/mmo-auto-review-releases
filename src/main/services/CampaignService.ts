import { eq, sql } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import type { Campaign, NewCampaign } from '../database/schema'

export class CampaignService {
    // Get all campaigns
    async getAll(): Promise<Campaign[]> {
        const db = getDatabase()
        return db.select().from(schema.campaigns).all()
    }

    // Get running campaigns
    async getRunning(): Promise<Campaign[]> {
        const db = getDatabase()
        return db.select().from(schema.campaigns).where(eq(schema.campaigns.status, 'running')).all()
    }

    // Get campaign by ID
    async getById(id: number): Promise<Campaign | undefined> {
        const db = getDatabase()
        const results = db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).all()
        return results[0]
    }

    // Create new campaign
    async create(data: {
        name: string
        locationIds: number[]
        accountIds?: number[]
        proxyIds?: number[]
        reviewTemplates: string[]
        rating?: number
        delayMin?: number
        delayMax?: number
        maxReviewsPerAccountPerDay?: number
    }): Promise<Campaign> {
        const db = getDatabase()
        const result = db.insert(schema.campaigns).values({
            name: data.name,
            locationIds: JSON.stringify(data.locationIds),
            accountIds: data.accountIds ? JSON.stringify(data.accountIds) : null,
            proxyIds: data.proxyIds ? JSON.stringify(data.proxyIds) : null,
            reviewTemplates: JSON.stringify(data.reviewTemplates),
            rating: data.rating || 5,
            delayMin: data.delayMin || 30,
            delayMax: data.delayMax || 120,
            maxReviewsPerAccountPerDay: data.maxReviewsPerAccountPerDay || 5,
            status: 'pending',
            progress: 0,
            totalReviews: 0,
            successReviews: 0,
            failedReviews: 0,
            createdAt: new Date(),
        }).returning().get()
        return result
    }

    // Update campaign
    async update(id: number, data: Partial<Campaign>): Promise<Campaign | undefined> {
        const db = getDatabase()
        const result = db.update(schema.campaigns)
            .set(data)
            .where(eq(schema.campaigns.id, id))
            .returning()
            .get()
        return result
    }

    // Delete campaign
    async delete(id: number): Promise<void> {
        const db = getDatabase()
        db.delete(schema.campaigns).where(eq(schema.campaigns.id, id)).run()
    }

    // Start campaign
    async start(id: number): Promise<void> {
        await this.update(id, { status: 'running' })
    }

    // Pause campaign
    async pause(id: number): Promise<void> {
        await this.update(id, { status: 'paused' })
    }

    // Stop campaign
    async stop(id: number): Promise<void> {
        await this.update(id, { status: 'done' })
    }

    // Update progress
    async updateProgress(id: number, success: boolean): Promise<void> {
        const campaign = await this.getById(id)
        if (!campaign) return

        const totalReviews = campaign.totalReviews + 1
        const successReviews = success ? campaign.successReviews + 1 : campaign.successReviews
        const failedReviews = success ? campaign.failedReviews : campaign.failedReviews + 1

        // Calculate progress based on location targets
        let locationIds: number[] = []
        try { locationIds = JSON.parse(campaign.locationIds) } catch { /* corrupted JSON */ }
        const progress = locationIds.length > 0
            ? Math.min(100, Math.round((totalReviews / (locationIds.length * 10)) * 100))
            : 0

        await this.update(id, {
            totalReviews,
            successReviews,
            failedReviews,
            progress,
            status: progress >= 100 ? 'done' : campaign.status,
        })
    }

    // Get campaign with parsed JSON fields
    async getWithDetails(id: number): Promise<{
        campaign: Campaign
        locationIds: number[]
        accountIds: number[] | null
        proxyIds: number[] | null
        reviewTemplates: string[]
    } | undefined> {
        const campaign = await this.getById(id)
        if (!campaign) return undefined

        const safeParse = <T>(json: string | null | undefined, fallback: T): T => {
            if (!json) return fallback
            try { return JSON.parse(json) } catch { return fallback }
        }

        return {
            campaign,
            locationIds: safeParse<number[]>(campaign.locationIds, []),
            accountIds: campaign.accountIds ? safeParse<number[]>(campaign.accountIds, []) : null,
            proxyIds: campaign.proxyIds ? safeParse<number[]>(campaign.proxyIds, []) : null,
            reviewTemplates: safeParse<string[]>(campaign.reviewTemplates, []),
        }
    }

    // Get statistics
    async getStats(): Promise<{
        total: number
        running: number
        paused: number
        done: number
    }> {
        const db = getDatabase()
        const rows = db.select({
            status: schema.campaigns.status,
            count: sql<number>`count(*)`,
        }).from(schema.campaigns).groupBy(schema.campaigns.status).all()

        return rows.reduce((acc, row) => {
            acc.total += Number(row.count) || 0
            if (row.status === 'running') acc.running = Number(row.count) || 0
            if (row.status === 'paused') acc.paused = Number(row.count) || 0
            if (row.status === 'done') acc.done = Number(row.count) || 0
            return acc
        }, { total: 0, running: 0, paused: 0, done: 0 })
    }
}

export const campaignService = new CampaignService()
