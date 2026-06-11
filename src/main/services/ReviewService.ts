import { eq, desc, and, gte } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import type { ReviewHistory, NewReviewHistory } from '../database/schema'

export class ReviewService {
    // Get all review history
    async getAll(): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select().from(schema.reviewHistory).orderBy(desc(schema.reviewHistory.createdAt)).all()
    }

    // Get reviews for a campaign
    async getByCampaign(campaignId: number): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewHistory)
            .where(eq(schema.reviewHistory.campaignId, campaignId))
            .orderBy(desc(schema.reviewHistory.createdAt))
            .all()
    }

    // Get reviews for an account
    async getByAccount(accountId: number): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewHistory)
            .where(eq(schema.reviewHistory.accountId, accountId))
            .orderBy(desc(schema.reviewHistory.createdAt))
            .all()
    }

    // Get recent reviews (last N)
    async getRecent(limit: number = 10): Promise<ReviewHistory[]> {
        const db = getDatabase()
        return db.select()
            .from(schema.reviewHistory)
            .orderBy(desc(schema.reviewHistory.createdAt))
            .limit(limit)
            .all()
    }

    // Create review record
    async create(data: NewReviewHistory): Promise<ReviewHistory> {
        const db = getDatabase()
        const result = db.insert(schema.reviewHistory).values({
            ...data,
            createdAt: new Date(),
        }).returning().get()
        return result
    }

    // Get reviews today
    async getToday(): Promise<ReviewHistory[]> {
        const db = getDatabase()
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        return db.select()
            .from(schema.reviewHistory)
            .where(gte(schema.reviewHistory.createdAt, today))
            .all()
    }

    // Get comprehensive statistics
    async getStats(): Promise<{
        totalReviews: number
        successfulReviews: number
        failedReviews: number
        successRate: number
        reviewsToday: number
        reviewsThisWeek: number
        reviewsThisMonth: number
    }> {
        const db = getDatabase()
        const all = db.select().from(schema.reviewHistory).all()

        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
        const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

        const successful = all.filter(r => r.status === 'success')
        const reviewsToday = all.filter(r => r.createdAt && r.createdAt >= today)
        const reviewsThisWeek = all.filter(r => r.createdAt && r.createdAt >= weekAgo)
        const reviewsThisMonth = all.filter(r => r.createdAt && r.createdAt >= monthAgo)

        return {
            totalReviews: all.length,
            successfulReviews: successful.length,
            failedReviews: all.length - successful.length,
            successRate: all.length > 0 ? Math.round((successful.length / all.length) * 100 * 10) / 10 : 0,
            reviewsToday: reviewsToday.length,
            reviewsThisWeek: reviewsThisWeek.length,
            reviewsThisMonth: reviewsThisMonth.length,
        }
    }

    // Get reviews count for account today (for rate limiting)
    async getAccountReviewsToday(accountId: number): Promise<number> {
        const db = getDatabase()
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const reviews = db.select()
            .from(schema.reviewHistory)
            .where(and(
                eq(schema.reviewHistory.accountId, accountId),
                gte(schema.reviewHistory.createdAt, today)
            ))
            .all()

        return reviews.length
    }
}

export const reviewService = new ReviewService()
