import { eq, sql } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import type { Location, NewLocation } from '../database/schema'
import { parseMapIdentity, extractIdentity } from '../automation/MapIdentity'

export class LocationService {
    // Get all locations
    async getAll(): Promise<Location[]> {
        const db = getDatabase()
        return db.select().from(schema.locations).all()
    }

    // Get pending locations
    async getPending(): Promise<Location[]> {
        const db = getDatabase()
        return db.select().from(schema.locations).where(eq(schema.locations.status, 'pending')).all()
    }

    // Get location by ID
    async getById(id: number): Promise<Location | undefined> {
        const db = getDatabase()
        const results = db.select().from(schema.locations).where(eq(schema.locations.id, id)).all()
        return results[0]
    }

    // Create new location
    async create(data: NewLocation): Promise<Location> {
        const db = getDatabase()
        const result = db.insert(schema.locations).values({
            ...data,
            targetRating: data.targetRating || 5,
            targetReviews: data.targetReviews || 10,
            currentReviews: 0,
            status: 'pending',
            createdAt: new Date(),
        }).returning().get()
        return result
    }

    // Update location
    async update(id: number, data: Partial<Location>): Promise<Location | undefined> {
        const db = getDatabase()
        const result = db.update(schema.locations)
            .set(data)
            .where(eq(schema.locations.id, id))
            .returning()
            .get()
        return result
    }

    // Delete location (cascade delete related records)
    async delete(id: number): Promise<{ success: boolean; error?: string }> {
        const db = getDatabase()
        try {
            // Delete related review history first
            db.delete(schema.reviewHistory)
                .where(eq(schema.reviewHistory.locationId, id))
                .run()

            // Delete related campaigns that reference this location
            // First get campaigns linked to this location
            const allCampaigns = db.select().from(schema.campaigns).all()
            for (const campaign of allCampaigns) {
                try {
                    const locationIds: number[] = JSON.parse(campaign.locationIds as string || '[]')
                    if (locationIds.includes(id)) {
                        // Remove this location from the campaign's locationIds
                        const updatedIds = locationIds.filter(lid => lid !== id)
                        if (updatedIds.length === 0) {
                            // Delete campaign if no locations left
                            db.delete(schema.campaigns)
                                .where(eq(schema.campaigns.id, campaign.id))
                                .run()
                        } else {
                            db.update(schema.campaigns)
                                .set({ locationIds: JSON.stringify(updatedIds) as any })
                                .where(eq(schema.campaigns.id, campaign.id))
                                .run()
                        }
                    }
                } catch {
                    // Skip if locationIds parse fails
                }
            }

            // Delete related traffic tasks
            db.delete(schema.trafficTasks)
                .where(eq(schema.trafficTasks.locationId, id))
                .run()

            // Delete related traffic logs
            db.delete(schema.trafficLogs)
                .where(eq(schema.trafficLogs.locationId, id))
                .run()

            // Update traffic campaigns that reference this location
            const allTrafficCampaigns = db.select().from(schema.trafficCampaigns).all()
            for (const campaign of allTrafficCampaigns) {
                try {
                    const locationIds: number[] = JSON.parse(campaign.locationIds as string || '[]')
                    if (locationIds.includes(id)) {
                        const updatedIds = locationIds.filter(lid => lid !== id)
                        if (updatedIds.length === 0) {
                            db.delete(schema.trafficCampaigns)
                                .where(eq(schema.trafficCampaigns.id, campaign.id))
                                .run()
                        } else {
                            db.update(schema.trafficCampaigns)
                                .set({ locationIds: JSON.stringify(updatedIds) as any })
                                .where(eq(schema.trafficCampaigns.id, campaign.id))
                                .run()
                        }
                    }
                } catch {
                    // Skip if locationIds parse fails
                }
            }

            // Try to delete analytics_snapshots (via raw sql since it might not be in schema mapped exports)
            try {
                // We don't have schema.analyticsSnapshots exported, so we just ignore its FK or wait, 
                // PRAGMA foreign_keys might block it. Just in case, let's do nothing for analyticsSnapshots 
                // since they are created by index.ts without strict drizzle relations. 
                // We can import sql to do raw execution if needed, but let's see if sqlite allows we execute.
            } catch (e) {}

            // Try to delete analytics_snapshots via raw sql
            try {
                db.run(sql`DELETE FROM analytics_snapshots WHERE location_id = ${id}`)
            } catch (e) {}

            // Now delete the location
            db.delete(schema.locations).where(eq(schema.locations.id, id)).run()
            return { success: true }
        } catch (error: any) {
            console.error('Failed to delete location:', error)
            return { success: false, error: error.message }
        }
    }

    // Increment review count
    async incrementReviewCount(id: number): Promise<void> {
        const db = getDatabase()
        const location = await this.getById(id)
        if (location) {
            const newCount = location.currentReviews + 1
            const newStatus = newCount >= location.targetReviews ? 'done' : 'in_progress'

            db.update(schema.locations)
                .set({
                    currentReviews: newCount,
                    status: newStatus
                })
                .where(eq(schema.locations.id, id))
                .run()
        }
    }

    // Parse Google Maps URL to extract info (enhanced with strong identifiers)
    async parseGoogleMapsUrl(url: string): Promise<{ name: string; placeId?: string; address?: string; cid?: string; featureHex?: string }> {
        const id = parseMapIdentity(url) || {}
        // Crude name fallback from path (kept for UI display only; prefer real name from title later)
        const placeIdMatch = url.match(/place\/([^\/]+)/)
        const name = placeIdMatch ? decodeURIComponent(placeIdMatch[1].replace(/\+/g, ' ')) : 'Unknown Location'

        // coords as weak address fallback
        const coordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)

        // Prefer canonical ChIJ placeId when present in parsed identity
        const pid = id.placeId || (placeIdMatch ? placeIdMatch[1] : undefined)

        return {
            name,
            placeId: pid,
            address: coordsMatch ? `${coordsMatch[1]}, ${coordsMatch[2]}` : undefined,
            cid: id.cid,
            featureHex: id.featureHex,
        }
    }

    // Create from Google Maps URL (auto-extracts strong identifiers from url for later matching)
    async createFromUrl(url: string, targetReviews: number = 10, phone?: string, website?: string): Promise<Location> {
        const parsed = await this.parseGoogleMapsUrl(url)
        const id = extractIdentity({ url, placeId: parsed.placeId })
        return this.create({
            name: parsed.name,
            url,
            placeId: id.placeId || parsed.placeId,
            address: parsed.address,
            phone,
            website,
            // persist strong ids when present in url (no UI change required)
            cid: id.cid,
            featureHex: id.featureHex,
            targetReviews,
            targetRating: 5,
            createdAt: new Date(),
        } as any)
    }

    // Get statistics
    async getStats(): Promise<{
        total: number
        pending: number
        inProgress: number
        done: number
        totalTargetReviews: number
        totalCurrentReviews: number
    }> {
        const all = await this.getAll()
        return {
            total: all.length,
            pending: all.filter(l => l.status === 'pending').length,
            inProgress: all.filter(l => l.status === 'in_progress').length,
            done: all.filter(l => l.status === 'done').length,
            totalTargetReviews: all.reduce((sum, l) => sum + l.targetReviews, 0),
            totalCurrentReviews: all.reduce((sum, l) => sum + l.currentReviews, 0),
        }
    }
}

export const locationService = new LocationService()
