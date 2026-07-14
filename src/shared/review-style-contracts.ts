/**
 * Per-account review style contracts (Phase 3 — Content Engine).
 * Shared between main services and pure unit tests. No Electron/DB deps.
 */

/** Schema version for persisted JSON profiles. */
export const REVIEW_STYLE_PROFILE_VERSION = 1 as const

/** Emoji presentation style for a writing persona. */
export type EmojiStyle = 'none' | 'sparse' | 'friendly' | 'expressive'

/** Preferred overall review length band. */
export type PreferredReviewLength = 'short' | 'medium' | 'long'

/** Punctuation expressiveness. */
export type PunctuationStyle = 'minimal' | 'normal' | 'expressive'

/** Hard bounds for controlled imperfection (generator must never exceed). */
export const REVIEW_STYLE_BOUNDS = {
    formality: { min: 0.05, max: 0.95 },
    avgSentenceLength: { min: 6, max: 22 },
    sentenceLengthVariance: { min: 1, max: 8 },
    emojiRate: { min: 0, max: 0.35 },
    typoRate: { min: 0, max: 0.06 },
    codeSwitchRate: { min: 0, max: 0.25 },
    /** Max typos injected per review (absolute cap). */
    maxTyposPerReview: 3,
    /** Max emoji tokens injected per review. */
    maxEmojisPerReview: 3,
    /** Length delta vs base text (ratio of original word count). */
    maxLengthDeltaRatio: 0.45,
    /** Similarity threshold that triggers dedupe rephrase. */
    dedupeSimilarityThreshold: 0.72,
    /** Max rephrase attempts for dedupe. */
    maxDedupeAttempts: 4,
} as const

/** Vocabulary fingerprint for one account persona. */
export interface VocabularyPreferences {
    /** Prefer shorter everyday words over formal synonyms. */
    preferShortWords: boolean
    /** Intensifiers used often (Vietnamese-first). */
    intensifiers: string[]
    /** Common review openers. */
    openers: string[]
    /** Common review closers. */
    closers: string[]
    /** Positive stock phrases. */
    positivePhrases: string[]
    /** Mild filler / discourse markers. */
    fillerWords: string[]
    /** Optional English loanwords for code-switch. */
    englishLoanwords: string[]
}

/**
 * Deterministic per-account writing profile.
 * Persisted as JSON in `accounts.review_style_profile`.
 */
export interface ReviewStyleProfile {
    version: typeof REVIEW_STYLE_PROFILE_VERSION
    /** Stable seed string that produced this profile. */
    seed: string
    /** Formality 0 (very casual) → 1 (very formal). */
    formality: number
    /** Target average words per sentence. */
    avgSentenceLength: number
    /** Allowed variance around avg sentence length. */
    sentenceLengthVariance: number
    /** Probability-ish rate of emoji use (bounded). */
    emojiRate: number
    emojiStyle: EmojiStyle
    /** Per-word typo injection probability (bounded). */
    typoRate: number
    vocabulary: VocabularyPreferences
    /** Probability of inserting an English loanword. */
    codeSwitchRate: number
    preferredLength: PreferredReviewLength
    punctuationStyle: PunctuationStyle
    /** ISO timestamp when profile was created/regenerated. */
    createdAt: string
}

/** Input for styled review generation. */
export interface ReviewStyleGenerateInput {
    accountId: number
    /** Base review text (from AI/template/spintax). */
    baseText: string
    /** Optional free-form location context (address, notes). */
    locationContext?: string
    locationName?: string
    category?: string
    /** Target star rating 1–5. */
    rating: number
    /** Previous review texts by this account (dedupe). */
    previousReviews?: string[]
    /**
     * Optional extra entropy for this generation.
     * When omitted, derived from profile seed + content fingerprint.
     */
    generationSeed?: string
}

/** Audit trail returned with every styled review. */
export interface ReviewStyleAuditMetadata {
    accountId: number
    seed: string
    generationSeed: string
    profileVersion: number
    formality: number
    typoRate: number
    emojiRate: number
    codeSwitchRate: number
    typoCount: number
    emojiCount: number
    codeSwitchCount: number
    /** Max Jaccard similarity vs previous reviews (0–1). */
    similarityToPrevious: number
    dedupeApplied: boolean
    /** Word-count delta (styled − original). */
    lengthDelta: number
    originalWordCount: number
    styledWordCount: number
    protectedTokensPreserved: boolean
    steps: string[]
}

/** Generator output. */
export interface ReviewStyleGenerateOutput {
    styledText: string
    audit: ReviewStyleAuditMetadata
}

/** Result of get-or-create profile. */
export interface ReviewStyleProfileResult {
    profile: ReviewStyleProfile
    seed: string
    created: boolean
    regenerated: boolean
}
