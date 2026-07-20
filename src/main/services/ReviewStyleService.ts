/**
 * ReviewStyleService — Phase 3 per-account writing persona.
 *
 * Responsibilities:
 * - Deterministic style profile from a stable seed
 * - Persist/load JSON on accounts.reviewStyleProfile + reviewStyleSeed
 * - Optional regenerate (new seed + profile)
 *
 * Pure helpers are exported for unit tests (no Electron required).
 */

import { createHash, randomBytes } from 'crypto'
import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import {
    REVIEW_STYLE_BOUNDS,
    REVIEW_STYLE_PROFILE_VERSION,
    type EmojiStyle,
    type PreferredReviewLength,
    type PunctuationStyle,
    type ReviewStyleProfile,
    type ReviewStyleProfileResult,
    type VocabularyPreferences,
} from '../../shared/review-style-contracts'

// ─── Vocabulary banks (Vietnamese-first) ─────────────────────────────────────

const INTENSIFIER_BANK = [
    'rất', 'khá', 'siêu', 'cực kỳ', 'hơi', 'thật sự', 'khá là', 'cũng khá',
] as const

const OPENER_BANK = [
    'Mình vừa ghé', 'Hôm nay ghé thử', 'Lâu rồi mới quay lại', 'Lần đầu đến',
    'Đã thử', 'Ghé quán', 'Tình cờ phát hiện', 'Được bạn giới thiệu',
] as const

const CLOSER_BANK = [
    'Sẽ quay lại', 'Recommend nha', 'Đáng thử', 'Ok lắm',
    'Sẽ ủng hộ tiếp', 'Nên ghé một lần', 'Hài lòng', 'Ổn áp',
] as const

const POSITIVE_PHRASE_BANK = [
    'phục vụ nhiệt tình', 'không gian dễ chịu', 'giá cả hợp lý',
    'chất lượng ổn', 'sạch sẽ', 'nhanh gọn', 'thân thiện',
    'đáng tiền', 'menu đa dạng', 'view đẹp',
] as const

const FILLER_BANK = [
    'thì', 'à', 'nói chung', 'thực ra', 'cơ bản là', 'kiểu', 'ý là',
] as const

const ENGLISH_LOAN_BANK = [
    'ok', 'nice', 'good', 'service', 'vibe', 'menu', 'check-in',
    'recommend', 'best', 'chill', 'deal', 'quality',
] as const

const LENGTH_STYLES: PreferredReviewLength[] = ['short', 'medium', 'long']
const PUNCT_STYLES: PunctuationStyle[] = ['minimal', 'normal', 'expressive']

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

/** FNV-1a style string → 32-bit seed. Deterministic across platforms. */
export function hashStringToSeed(input: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
}

export type SeededRng = () => number

/** Mulberry32 — returns [0, 1). Same seed ⇒ same sequence. */
export function createSeededRng(seed: string): SeededRng {
    let state = hashStringToSeed(seed) || 1
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function rngFloat(rng: SeededRng, min: number, max: number): number {
    return min + rng() * (max - min)
}

function rngInt(rng: SeededRng, min: number, max: number): number {
    return Math.floor(rngFloat(rng, min, max + 1 - 1e-12))
}

function rngPick<T>(rng: SeededRng, items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]
}

function rngSampleUnique(
    rng: SeededRng,
    bank: readonly string[],
    count: number,
): string[] {
    const pool = [...bank]
    const out: string[] = []
    const n = Math.min(count, pool.length)
    for (let i = 0; i < n; i++) {
        const idx = Math.floor(rng() * pool.length)
        out.push(pool[idx])
        pool.splice(idx, 1)
    }
    return out
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000
}

// ─── Pure profile generation ─────────────────────────────────────────────────

/**
 * Build a deterministic ReviewStyleProfile from a seed.
 * Same seed always yields the same profile (modulo createdAt override).
 */
export function generateStyleProfileFromSeed(
    seed: string,
    options?: { createdAt?: string },
): ReviewStyleProfile {
    const rng = createSeededRng(`profile:${seed}`)
    const b = REVIEW_STYLE_BOUNDS

    const formality = round3(rngFloat(rng, b.formality.min, b.formality.max))
    const avgSentenceLength = round3(
        rngFloat(rng, b.avgSentenceLength.min, b.avgSentenceLength.max),
    )
    const sentenceLengthVariance = round3(
        rngFloat(rng, b.sentenceLengthVariance.min, b.sentenceLengthVariance.max),
    )
    const emojiRate = round3(rngFloat(rng, b.emojiRate.min, b.emojiRate.max))
    const typoRate = round3(rngFloat(rng, b.typoRate.min, b.typoRate.max))
    const codeSwitchRate = round3(
        rngFloat(rng, b.codeSwitchRate.min, b.codeSwitchRate.max),
    )

    // Correlate emoji style with rate for realism
    let emojiStyle: EmojiStyle
    if (emojiRate < 0.02) {
        emojiStyle = 'none'
    } else if (emojiRate < 0.1) {
        emojiStyle = rng() < 0.7 ? 'sparse' : 'friendly'
    } else if (emojiRate < 0.22) {
        emojiStyle = rngPick(rng, ['friendly', 'sparse', 'expressive'] as const)
    } else {
        emojiStyle = rng() < 0.6 ? 'expressive' : 'friendly'
    }

    const preferShortWords = formality < 0.45
    const vocabCount = rngInt(rng, 3, 5)

    const vocabulary: VocabularyPreferences = {
        preferShortWords,
        intensifiers: rngSampleUnique(rng, INTENSIFIER_BANK, vocabCount),
        openers: rngSampleUnique(rng, OPENER_BANK, rngInt(rng, 2, 4)),
        closers: rngSampleUnique(rng, CLOSER_BANK, rngInt(rng, 2, 4)),
        positivePhrases: rngSampleUnique(rng, POSITIVE_PHRASE_BANK, vocabCount),
        fillerWords: rngSampleUnique(rng, FILLER_BANK, rngInt(rng, 2, 4)),
        englishLoanwords: rngSampleUnique(rng, ENGLISH_LOAN_BANK, rngInt(rng, 2, 5)),
    }

    // Formality biases length + punctuation
    let preferredLength: PreferredReviewLength
    if (formality > 0.7) {
        preferredLength = rng() < 0.65 ? 'long' : 'medium'
    } else if (formality < 0.3) {
        preferredLength = rng() < 0.6 ? 'short' : 'medium'
    } else {
        preferredLength = rngPick(rng, LENGTH_STYLES)
    }

    let punctuationStyle: PunctuationStyle
    if (formality > 0.65) {
        punctuationStyle = rng() < 0.7 ? 'normal' : 'minimal'
    } else if (formality < 0.35) {
        punctuationStyle = rng() < 0.55 ? 'expressive' : 'normal'
    } else {
        punctuationStyle = rngPick(rng, PUNCT_STYLES)
    }

    return {
        version: REVIEW_STYLE_PROFILE_VERSION,
        seed,
        formality,
        avgSentenceLength,
        sentenceLengthVariance,
        emojiRate,
        emojiStyle,
        typoRate,
        vocabulary,
        codeSwitchRate,
        preferredLength,
        punctuationStyle,
        createdAt: options?.createdAt ?? new Date(0).toISOString(),
    }
}

/** Parse + validate a stored JSON profile. Returns null if invalid. */
export function parseStyleProfile(raw: string | null | undefined): ReviewStyleProfile | null {
    if (!raw || typeof raw !== 'string') return null
    try {
        const data = JSON.parse(raw) as Partial<ReviewStyleProfile>
        if (data.version !== REVIEW_STYLE_PROFILE_VERSION) return null
        if (typeof data.seed !== 'string' || !data.seed) return null
        if (typeof data.formality !== 'number') return null
        if (typeof data.avgSentenceLength !== 'number') return null
        if (typeof data.typoRate !== 'number') return null
        if (typeof data.emojiRate !== 'number') return null
        if (typeof data.codeSwitchRate !== 'number') return null
        if (!data.vocabulary || typeof data.vocabulary !== 'object') return null

        const b = REVIEW_STYLE_BOUNDS
        return {
            version: REVIEW_STYLE_PROFILE_VERSION,
            seed: data.seed,
            formality: clamp(data.formality, b.formality.min, b.formality.max),
            avgSentenceLength: clamp(
                data.avgSentenceLength,
                b.avgSentenceLength.min,
                b.avgSentenceLength.max,
            ),
            sentenceLengthVariance: clamp(
                data.sentenceLengthVariance ?? 3,
                b.sentenceLengthVariance.min,
                b.sentenceLengthVariance.max,
            ),
            emojiRate: clamp(data.emojiRate, b.emojiRate.min, b.emojiRate.max),
            emojiStyle: (data.emojiStyle as EmojiStyle) || 'sparse',
            typoRate: clamp(data.typoRate, b.typoRate.min, b.typoRate.max),
            vocabulary: data.vocabulary as VocabularyPreferences,
            codeSwitchRate: clamp(
                data.codeSwitchRate,
                b.codeSwitchRate.min,
                b.codeSwitchRate.max,
            ),
            preferredLength: (data.preferredLength as PreferredReviewLength) || 'medium',
            punctuationStyle: (data.punctuationStyle as PunctuationStyle) || 'normal',
            createdAt: typeof data.createdAt === 'string'
                ? data.createdAt
                : new Date(0).toISOString(),
        }
    } catch {
        return null
    }
}

export function serializeStyleProfile(profile: ReviewStyleProfile): string {
    return JSON.stringify(profile)
}

/** Stable default seed derived from account id (deterministic bootstrap). */
export function defaultSeedForAccount(accountId: number): string {
    return createHash('sha256')
        .update(`review-style:v1:account:${accountId}`)
        .digest('hex')
        .slice(0, 24)
}

export function createRandomSeed(): string {
    return randomBytes(12).toString('hex')
}

// ─── Service (DB-backed) ─────────────────────────────────────────────────────

export class ReviewStyleService {
    /**
     * Get existing profile or create + persist a deterministic one.
     * @param regenerate force new seed + profile
     */
    async getOrCreateProfile(
        accountId: number,
        regenerate = false,
    ): Promise<ReviewStyleProfileResult> {
        const db = getDatabase()
        const row = db
            .select({
                id: schema.accounts.id,
                reviewStyleProfile: schema.accounts.reviewStyleProfile,
                reviewStyleSeed: schema.accounts.reviewStyleSeed,
            })
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId))
            .get()

        if (!row) {
            throw new Error(`Account not found: ${accountId}`)
        }

        if (!regenerate) {
            const existing = parseStyleProfile(row.reviewStyleProfile)
            const seed = row.reviewStyleSeed || existing?.seed
            if (existing && seed) {
                return {
                    profile: existing,
                    seed,
                    created: false,
                    regenerated: false,
                }
            }
        }

        const seed = regenerate
            ? createRandomSeed()
            : (row.reviewStyleSeed || defaultSeedForAccount(accountId))

        const profile = generateStyleProfileFromSeed(seed, {
            createdAt: new Date().toISOString(),
        })

        db.update(schema.accounts)
            .set({
                reviewStyleSeed: seed,
                reviewStyleProfile: serializeStyleProfile(profile),
            })
            .where(eq(schema.accounts.id, accountId))
            .run()

        return {
            profile,
            seed,
            created: !row.reviewStyleProfile,
            regenerated: regenerate,
        }
    }

    /** Read profile without creating. */
    async getProfile(accountId: number): Promise<ReviewStyleProfile | null> {
        const db = getDatabase()
        const row = db
            .select({
                reviewStyleProfile: schema.accounts.reviewStyleProfile,
            })
            .from(schema.accounts)
            .where(eq(schema.accounts.id, accountId))
            .get()

        if (!row) return null
        return parseStyleProfile(row.reviewStyleProfile)
    }

    /** Force regenerate profile with a fresh seed. */
    async regenerateProfile(accountId: number): Promise<ReviewStyleProfileResult> {
        return this.getOrCreateProfile(accountId, true)
    }

    /** Ensure seed exists; returns seed string. */
    async ensureSeed(accountId: number): Promise<string> {
        const result = await this.getOrCreateProfile(accountId, false)
        return result.seed
    }
}

export const reviewStyleService = new ReviewStyleService()
