/**
 * Picks eligible reviews and a different account to mark them Helpful.
 * Dedup and per-account rate limits stay in process memory. A restart clears
 * them, which is safe: the next process simply starts a new quiet window.
 * better-sqlite3 is synchronous, so these reads are not async.
 */

import { and, asc, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import type { HelpfulVoteCandidate, HelpfulVoteRecord } from '../../shared/helpful-vote-contracts'
import { getDatabase, schema } from '../database'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000
/** Prefer warmed accounts, but do not refuse colder ones when nobody else is free. */
const TRUSTED_WARMUP_LEVEL = 30

interface VoteCandidateRow {
    historyId: number
    reviewAccountId: number
    reviewAccountEmail: string
    locationId: number
    locationName: string
    locationUrl: string
    reviewText: string
    rating: number
    reviewCreatedAt: Date
    verifiedStatus: 'pending' | 'live' | 'removed' | 'unknown' | null
    googleReviewId: string | null
    status: 'success' | 'failed'
}

interface VoterAccountRow {
    id: number
    email: string
    status: 'active' | 'banned' | 'pending' | 'suspended' | 'checking'
    warmupLevel: number
}

interface LocationAuthorRow {
    accountId: number
}

interface AccountVoteTracker {
    count: number
    lastVoteAt: Date
}

function isValidDate(value: unknown): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime())
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function utcDay(date: Date): string {
    return date.toISOString().slice(0, 10)
}

export class HelpfulVoteService {
    static readonly MIN_AGE_DAYS = 3
    static readonly MAX_AGE_DAYS = 30
    static readonly MAX_VOTES_PER_ACCOUNT_PER_DAY = 3
    static readonly VOTE_COOLDOWN_HOURS = 8

    /** historyIds already attempted. Includes failed and skipped so we do not hammer them. */
    private readonly votedReviews = new Set<number>()
    /** Voter account → votes recorded on the UTC day of lastVoteAt, plus that timestamp. */
    private readonly accountVotesToday = new Map<number, AccountVoteTracker>()

    /**
     * Successful live/pending reviews inside the age window, oldest first.
     * Already-attempted history ids are removed before the limit so a voted row
     * does not consume a slot.
     */
    getVoteCandidates(limit = 20, now = new Date()): HelpfulVoteCandidate[] {
        const maxItems = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
        if (maxItems === 0 || !isValidDate(now)) return []

        const earliestCreatedAt = new Date(now.getTime() - HelpfulVoteService.MAX_AGE_DAYS * MS_PER_DAY)
        const latestCreatedAt = new Date(now.getTime() - HelpfulVoteService.MIN_AGE_DAYS * MS_PER_DAY)

        const db = getDatabase()
        const rh = schema.reviewHistory
        const rows = db
            .select({
                historyId: rh.id,
                reviewAccountId: rh.accountId,
                reviewAccountEmail: schema.accounts.email,
                locationId: rh.locationId,
                locationName: schema.locations.name,
                locationUrl: schema.locations.url,
                reviewText: rh.reviewText,
                rating: rh.rating,
                reviewCreatedAt: rh.createdAt,
                verifiedStatus: rh.verifiedStatus,
                googleReviewId: rh.googleReviewId,
                status: rh.status,
            })
            .from(rh)
            .innerJoin(schema.locations, eq(rh.locationId, schema.locations.id))
            .innerJoin(schema.accounts, eq(rh.accountId, schema.accounts.id))
            .where(and(
                eq(rh.status, 'success'),
                inArray(rh.verifiedStatus, ['live', 'pending']),
                gte(rh.createdAt, earliestCreatedAt),
                lte(rh.createdAt, latestCreatedAt),
            ))
            .orderBy(asc(rh.createdAt))
            .all()

        const eligible: HelpfulVoteCandidate[] = []
        const seen = new Set<number>()
        for (const row of rows) {
            const candidate = this.toCandidate(row, now)
            if (!candidate || seen.has(candidate.historyId)) continue
            seen.add(candidate.historyId)
            eligible.push(candidate)
        }

        eligible.sort((left, right) => {
            const ageOrder = left.reviewCreatedAt.getTime() - right.reviewCreatedAt.getTime()
            if (ageOrder !== 0) return ageOrder
            return left.historyId - right.historyId
        })
        return eligible.slice(0, maxItems)
    }

    /**
     * First active account that did not post this review, has no successful
     * review of its own on the location, and is under the daily cap and cooldown.
     * Warmup >= 30 is preferred. Null when nobody qualifies.
     */
    pickVoterAccount(
        reviewAccountId: number,
        locationId: number,
        now = new Date(),
    ): { accountId: number; email: string } | null {
        if (!Number.isInteger(reviewAccountId) || reviewAccountId <= 0) return null
        if (!Number.isInteger(locationId) || locationId <= 0) return null
        if (!isValidDate(now)) return null

        try {
            const authors = this.loadLocationAuthorIds(locationId)
            authors.add(reviewAccountId)
            const accounts = this.loadVoterAccounts(reviewAccountId)
                .filter((account) => this.isVoterEligible(account, authors, now))
                .sort(compareVoters)

            const picked = accounts[0]
            if (!picked) return null
            return { accountId: picked.id, email: picked.email.trim() }
        } catch (error: unknown) {
            // Fail closed: voting without a clean author check would cluster accounts.
            console.error(`[HelpfulVote] voter pick failed: ${errorMessage(error)}`)
            return null
        }
    }

    /**
     * Remember one attempt for the life of this process.
     * Failed and skipped attempts still count: the review is not retried, and the
     * voter still spends a daily slot plus the cooldown. Nothing is written to SQLite.
     */
    recordVote(record: HelpfulVoteRecord): void {
        if (!Number.isInteger(record.historyId) || record.historyId <= 0) {
            throw new Error('historyId must be a positive integer')
        }
        if (!Number.isInteger(record.voterAccountId) || record.voterAccountId <= 0) {
            throw new Error('voterAccountId must be a positive integer')
        }
        if (!isValidDate(record.votedAt)) {
            throw new Error('votedAt must be a valid Date')
        }
        if (typeof record.success !== 'boolean') {
            throw new Error('success must be a boolean')
        }

        this.votedReviews.add(record.historyId)
        const prev = this.accountVotesToday.get(record.voterAccountId)
        const sameDay = prev !== undefined && utcDay(prev.lastVoteAt) === utcDay(record.votedAt)
        const count = sameDay && prev ? prev.count + 1 : 1
        this.accountVotesToday.set(record.voterAccountId, {
            count,
            lastVoteAt: record.votedAt,
        })
        console.log(
            `[HelpfulVote] recorded historyId=${record.historyId} voterAccountId=${record.voterAccountId} success=${String(record.success)} dailyCount=${count}`,
        )
    }

    private toCandidate(row: VoteCandidateRow, now: Date): HelpfulVoteCandidate | null {
        if (row.status !== 'success') return null
        if (row.verifiedStatus !== 'live' && row.verifiedStatus !== 'pending') return null
        if (!Number.isInteger(row.historyId) || row.historyId <= 0) return null
        if (!Number.isInteger(row.reviewAccountId) || row.reviewAccountId <= 0) return null
        if (!Number.isInteger(row.locationId) || row.locationId <= 0) return null
        if (!isValidDate(row.reviewCreatedAt) || !this.isWithinAgeWindow(row.reviewCreatedAt, now)) return null
        if (this.votedReviews.has(row.historyId)) return null
        if (!Number.isFinite(row.rating)) return null

        const reviewAccountEmail = typeof row.reviewAccountEmail === 'string' ? row.reviewAccountEmail.trim() : ''
        const locationName = typeof row.locationName === 'string' ? row.locationName.trim() : ''
        const locationUrl = typeof row.locationUrl === 'string' ? row.locationUrl.trim() : ''
        const reviewText = typeof row.reviewText === 'string' ? row.reviewText : ''
        if (reviewAccountEmail === '' || locationName === '' || locationUrl === '' || reviewText.trim() === '') {
            return null
        }

        return {
            historyId: row.historyId,
            reviewAccountId: row.reviewAccountId,
            reviewAccountEmail,
            locationId: row.locationId,
            locationName,
            locationUrl,
            reviewText,
            rating: row.rating,
            reviewCreatedAt: row.reviewCreatedAt,
            verifiedStatus: row.verifiedStatus,
            googleReviewId: row.googleReviewId ?? null,
        }
    }

    private isWithinAgeWindow(createdAt: Date, now: Date): boolean {
        const ageMs = now.getTime() - createdAt.getTime()
        if (!Number.isFinite(ageMs)) return false
        const minMs = HelpfulVoteService.MIN_AGE_DAYS * MS_PER_DAY
        const maxMs = HelpfulVoteService.MAX_AGE_DAYS * MS_PER_DAY
        return ageMs >= minMs && ageMs <= maxMs
    }

    private loadVoterAccounts(reviewAccountId: number): VoterAccountRow[] {
        const db = getDatabase()
        const rows = db
            .select({
                id: schema.accounts.id,
                email: schema.accounts.email,
                status: schema.accounts.status,
                warmupLevel: schema.accounts.warmupLevel,
            })
            .from(schema.accounts)
            .where(and(
                eq(schema.accounts.status, 'active'),
                ne(schema.accounts.id, reviewAccountId),
            ))
            .all()
        return Array.isArray(rows) ? rows : []
    }

    private loadLocationAuthorIds(locationId: number): Set<number> {
        const db = getDatabase()
        const rows = db
            .select({ accountId: schema.reviewHistory.accountId })
            .from(schema.reviewHistory)
            .where(and(
                eq(schema.reviewHistory.locationId, locationId),
                eq(schema.reviewHistory.status, 'success'),
            ))
            .all()

        const ids = new Set<number>()
        const list: LocationAuthorRow[] = Array.isArray(rows) ? rows : []
        for (const row of list) {
            if (Number.isInteger(row.accountId) && row.accountId > 0) {
                ids.add(row.accountId)
            }
        }
        return ids
    }

    private isVoterEligible(
        account: VoterAccountRow,
        blockedAccountIds: Set<number>,
        now: Date,
    ): boolean {
        if (account.status !== 'active') return false
        if (!Number.isInteger(account.id) || account.id <= 0) return false
        if (typeof account.email !== 'string' || account.email.trim() === '') return false
        if (blockedAccountIds.has(account.id)) return false
        if (this.votesToday(account.id, now) >= HelpfulVoteService.MAX_VOTES_PER_ACCOUNT_PER_DAY) return false
        return this.isCooldownClear(account.id, now)
    }

    private votesToday(accountId: number, now: Date): number {
        const entry = this.accountVotesToday.get(accountId)
        if (!entry || !isValidDate(entry.lastVoteAt)) return 0
        if (utcDay(entry.lastVoteAt) !== utcDay(now)) return 0
        return entry.count
    }

    private isCooldownClear(accountId: number, now: Date): boolean {
        const entry = this.accountVotesToday.get(accountId)
        if (!entry || !isValidDate(entry.lastVoteAt)) return true
        const elapsed = now.getTime() - entry.lastVoteAt.getTime()
        if (!Number.isFinite(elapsed)) return false
        return elapsed >= HelpfulVoteService.VOTE_COOLDOWN_HOURS * MS_PER_HOUR
    }
}

function compareVoters(left: VoterAccountRow, right: VoterAccountRow): number {
    const leftWarmup = Number.isFinite(left.warmupLevel) ? left.warmupLevel : 0
    const rightWarmup = Number.isFinite(right.warmupLevel) ? right.warmupLevel : 0
    const leftTrusted = leftWarmup >= TRUSTED_WARMUP_LEVEL ? 1 : 0
    const rightTrusted = rightWarmup >= TRUSTED_WARMUP_LEVEL ? 1 : 0
    if (leftTrusted !== rightTrusted) return rightTrusted - leftTrusted
    if (leftWarmup !== rightWarmup) return rightWarmup - leftWarmup
    return left.id - right.id
}

export const helpfulVoteService = new HelpfulVoteService()
