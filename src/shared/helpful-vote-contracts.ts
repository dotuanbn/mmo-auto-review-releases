/**
 * Cross-account Helpful votes on reviews this app already posted.
 * Attempts live in process memory only — no IPC payload and no new table.
 */

export interface HelpfulVoteCandidate {
    historyId: number
    /** Account that posted the review. A voter must be someone else. */
    reviewAccountId: number
    reviewAccountEmail: string
    locationId: number
    locationName: string
    locationUrl: string
    reviewText: string
    rating: number
    reviewCreatedAt: Date
    verifiedStatus: 'live' | 'pending' | null
    googleReviewId: string | null
}

export interface HelpfulVoteRecord {
    historyId: number
    voterAccountId: number
    votedAt: Date
    success: boolean
    errorMessage?: string
}

export type HelpfulVoteStatus = 'pending' | 'voted' | 'failed' | 'skipped'
