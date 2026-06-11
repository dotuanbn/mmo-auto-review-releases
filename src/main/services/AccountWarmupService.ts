/**
 * AccountWarmupService — Phase 2 of Anti-Detection Strategy
 *
 * Responsible for:
 * - Simulating "safe" Google activity for new accounts (Gmail, YouTube, Search, Maps browsing)
 * - Tracking warmup_level and reputation_score
 * - Enforcing gradual review velocity ramp
 * - Recording warmup history
 *
 * This is a foundational piece for making new accounts look like they have real history.
 */

import { getDatabase, schema } from '../database'
import { eq } from 'drizzle-orm'
import { Account } from '../database/schema'

export interface WarmupActivity {
    type: 'gmail' | 'youtube' | 'search' | 'maps_browse' | 'photos' | 'other'
    timestamp: string
    durationSec?: number
    detail?: string
}

export class AccountWarmupService {
    /**
     * Get or initialize warmup data for an account
     */
    async getWarmupData(accountId: number): Promise<{
        warmupLevel: number
        reputationScore: number
        firstReviewDate?: Date
        lastReviewDate?: Date
        history: WarmupActivity[]
    }> {
        const db = getDatabase()
        const acc = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get() as any

        if (!acc) throw new Error('Account not found')

        let history: WarmupActivity[] = []
        try {
            history = acc.warmupHistory ? JSON.parse(acc.warmupHistory) : []
        } catch {
            history = []
        }

        return {
            warmupLevel: acc.warmupLevel ?? 0,
            reputationScore: acc.reputationScore ?? 0,
            firstReviewDate: acc.firstReviewDate ? new Date(acc.firstReviewDate) : undefined,
            lastReviewDate: acc.lastReviewDate ? new Date(acc.lastReviewDate) : undefined,
            history,
        }
    }

    /**
     * Record a "safe" activity for warmup purposes.
     * This should be called by automation flows before allowing real reviews.
     */
    async recordSafeActivity(accountId: number, activity: WarmupActivity): Promise<void> {
        const db = getDatabase()
        const current = await this.getWarmupData(accountId)

        const newHistory = [...current.history, activity].slice(-50) // keep last 50

        // Very simple heuristic for Phase 2
        let newLevel = current.warmupLevel
        let newScore = current.reputationScore

        const boost = this.getActivityBoost(activity.type)
        newLevel = Math.min(100, newLevel + boost)
        newScore = Math.min(1000, newScore + Math.floor(boost * 3))

        db.update(schema.accounts)
            .set({
                warmupLevel: newLevel,
                reputationScore: newScore,
                warmupHistory: JSON.stringify(newHistory),
            })
            .where(eq(schema.accounts.id, accountId))
            .run()
    }

    private getActivityBoost(type: WarmupActivity['type']): number {
        switch (type) {
            case 'gmail': return 8
            case 'youtube': return 6
            case 'search': return 5
            case 'maps_browse': return 7
            case 'photos': return 4
            default: return 3
        }
    }

    /**
     * Decide if an account is "ready" for real review/traffic work.
     * This is a simple gate for Phase 2.
     */
    async isReadyForRealWork(accountId: number, minLevel = 35): Promise<boolean> {
        const data = await this.getWarmupData(accountId)
        return data.warmupLevel >= minLevel
    }

    /**
     * Record that a real review happened (updates dates and slightly increases reputation)
     */
    async recordRealReview(accountId: number): Promise<void> {
        const db = getDatabase()
        const now = new Date()

        const acc = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get() as any
        if (!acc) return

        const updates: any = {
            lastReviewDate: now,
            totalReviews: (acc.totalReviews || 0) + 1,
            reputationScore: Math.min(1000, (acc.reputationScore || 0) + 5),
        }

        if (!acc.firstReviewDate) {
            updates.firstReviewDate = now
        }

        db.update(schema.accounts)
            .set(updates)
            .where(eq(schema.accounts.id, accountId))
            .run()
    }
}

export const accountWarmupService = new AccountWarmupService()
