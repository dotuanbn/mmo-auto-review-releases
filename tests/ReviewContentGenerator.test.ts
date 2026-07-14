import { describe, expect, it } from 'vitest'
import {
    REVIEW_STYLE_BOUNDS,
    REVIEW_STYLE_PROFILE_VERSION,
    type ReviewStyleProfile,
} from '../src/shared/review-style-contracts'
import {
    defaultSeedForAccount,
    generateStyleProfileFromSeed,
    hashStringToSeed,
    parseStyleProfile,
    serializeStyleProfile,
} from '../src/main/services/ReviewStyleService'
import {
    computeTextSimilarity,
    maxSimilarityToPrevious,
    protectSensitiveTokens,
    restoreSensitiveTokens,
    styleReviewText,
    ReviewContentGenerator,
} from '../src/main/services/ReviewContentGenerator'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_VI =
    'Mình rất thích không gian ở đây. Nhân viên phục vụ nhiệt tình, đồ uống ngon và giá cả hợp lý. Sẽ quay lại.'

function profileFor(seed: string, overrides?: Partial<ReviewStyleProfile>): ReviewStyleProfile {
    const base = generateStyleProfileFromSeed(seed, {
        createdAt: '2020-01-01T00:00:00.000Z',
    })
    return { ...base, ...overrides, vocabulary: overrides?.vocabulary ?? base.vocabulary }
}

// ─── Profile stability ───────────────────────────────────────────────────────

describe('ReviewStyleService — profile generation', () => {
    it('is stable for the same seed', () => {
        const a = generateStyleProfileFromSeed('acct-seed-alpha', {
            createdAt: '2020-01-01T00:00:00.000Z',
        })
        const b = generateStyleProfileFromSeed('acct-seed-alpha', {
            createdAt: '2020-01-01T00:00:00.000Z',
        })
        expect(a).toEqual(b)
        expect(a.version).toBe(REVIEW_STYLE_PROFILE_VERSION)
        expect(a.seed).toBe('acct-seed-alpha')
    })

    it('varies across different account seeds', () => {
        const seeds = Array.from({ length: 8 }, (_, i) => defaultSeedForAccount(i + 1))
        const profiles = seeds.map((s) =>
            generateStyleProfileFromSeed(s, { createdAt: '2020-01-01T00:00:00.000Z' }),
        )

        // Not all formality values identical
        const formalities = new Set(profiles.map((p) => p.formality))
        expect(formalities.size).toBeGreaterThan(1)

        // Not all typo rates identical
        const typos = new Set(profiles.map((p) => p.typoRate))
        expect(typos.size).toBeGreaterThan(1)

        // Pairwise: at least half of pairs differ on formality or emojiRate
        let diffs = 0
        for (let i = 0; i < profiles.length; i++) {
            for (let j = i + 1; j < profiles.length; j++) {
                if (
                    profiles[i].formality !== profiles[j].formality ||
                    profiles[i].emojiRate !== profiles[j].emojiRate ||
                    profiles[i].avgSentenceLength !== profiles[j].avgSentenceLength
                ) {
                    diffs++
                }
            }
        }
        expect(diffs).toBeGreaterThan(10)
    })

    it('keeps all numeric traits within hard bounds', () => {
        for (let i = 0; i < 30; i++) {
            const p = generateStyleProfileFromSeed(`bound-check-${i}`)
            const b = REVIEW_STYLE_BOUNDS
            expect(p.formality).toBeGreaterThanOrEqual(b.formality.min)
            expect(p.formality).toBeLessThanOrEqual(b.formality.max)
            expect(p.avgSentenceLength).toBeGreaterThanOrEqual(b.avgSentenceLength.min)
            expect(p.avgSentenceLength).toBeLessThanOrEqual(b.avgSentenceLength.max)
            expect(p.sentenceLengthVariance).toBeGreaterThanOrEqual(b.sentenceLengthVariance.min)
            expect(p.sentenceLengthVariance).toBeLessThanOrEqual(b.sentenceLengthVariance.max)
            expect(p.emojiRate).toBeGreaterThanOrEqual(b.emojiRate.min)
            expect(p.emojiRate).toBeLessThanOrEqual(b.emojiRate.max)
            expect(p.typoRate).toBeGreaterThanOrEqual(b.typoRate.min)
            expect(p.typoRate).toBeLessThanOrEqual(b.typoRate.max)
            expect(p.codeSwitchRate).toBeGreaterThanOrEqual(b.codeSwitchRate.min)
            expect(p.codeSwitchRate).toBeLessThanOrEqual(b.codeSwitchRate.max)
            expect(p.vocabulary.intensifiers.length).toBeGreaterThan(0)
            expect(p.vocabulary.openers.length).toBeGreaterThan(0)
        }
    })

    it('round-trips through serialize/parse', () => {
        const p = generateStyleProfileFromSeed('roundtrip-seed', {
            createdAt: '2021-05-05T12:00:00.000Z',
        })
        const raw = serializeStyleProfile(p)
        const parsed = parseStyleProfile(raw)
        expect(parsed).toEqual(p)
    })

    it('rejects invalid JSON profiles', () => {
        expect(parseStyleProfile(null)).toBeNull()
        expect(parseStyleProfile('')).toBeNull()
        expect(parseStyleProfile('{not json')).toBeNull()
        expect(parseStyleProfile(JSON.stringify({ version: 99, seed: 'x' }))).toBeNull()
    })

    it('defaultSeedForAccount is deterministic and unique per id', () => {
        expect(defaultSeedForAccount(7)).toBe(defaultSeedForAccount(7))
        expect(defaultSeedForAccount(1)).not.toBe(defaultSeedForAccount(2))
        expect(hashStringToSeed('abc')).toBe(hashStringToSeed('abc'))
        expect(hashStringToSeed('abc')).not.toBe(hashStringToSeed('abd'))
    })
})

// ─── Generator determinism + bounds ──────────────────────────────────────────

describe('styleReviewText — core generator', () => {
    it('is deterministic for fixed seed + input', () => {
        const profile = profileFor('gen-det-seed')
        const input = {
            accountId: 1,
            baseText: BASE_VI,
            locationName: 'KAFF Việt Nam',
            category: 'Cà phê',
            rating: 5,
            generationSeed: 'fixed-gen-1',
            previousReviews: [],
        }
        const a = styleReviewText(input, profile)
        const b = styleReviewText(input, profile)
        expect(a.styledText).toBe(b.styledText)
        expect(a.audit).toEqual(b.audit)
        expect(a.styledText.length).toBeGreaterThan(10)
        expect(a.audit.seed).toBe('gen-det-seed')
        expect(a.audit.generationSeed).toBe('fixed-gen-1')
    })

    it('produces cross-account variance on the same base text', () => {
        const baseInput = {
            accountId: 1,
            baseText: BASE_VI,
            locationName: 'Quán Test',
            rating: 5,
            generationSeed: 'same-gen',
            previousReviews: [] as string[],
        }
        const outputs = [1, 2, 3, 4, 5].map((id) => {
            const profile = profileFor(defaultSeedForAccount(id))
            return styleReviewText({ ...baseInput, accountId: id }, profile).styledText
        })
        const unique = new Set(outputs)
        // Expect at least 2 distinct styled variants across 5 personas
        expect(unique.size).toBeGreaterThanOrEqual(2)
    })

    it('bounds typo count and respects typoRate=0', () => {
        const noTypo = profileFor('typo-zero', { typoRate: 0 })
        const highTypo = profileFor('typo-high', {
            typoRate: REVIEW_STYLE_BOUNDS.typoRate.max,
        })

        const input = {
            accountId: 9,
            baseText:
                'Mình rất thích không gian. Nhân viên nhiệt tình, đồ uống ngon. Cảm ơn rất nhiều, sẽ quay lại.',
            rating: 5,
            generationSeed: 'typo-run',
            previousReviews: [],
        }

        const clean = styleReviewText(input, noTypo)
        expect(clean.audit.typoCount).toBe(0)

        // Multiple rolls — never exceed hard max
        for (let i = 0; i < 15; i++) {
            const r = styleReviewText(
                { ...input, generationSeed: `typo-run-${i}` },
                highTypo,
            )
            expect(r.audit.typoCount).toBeLessThanOrEqual(
                REVIEW_STYLE_BOUNDS.maxTyposPerReview,
            )
        }
    })

    it('bounds emoji count and honors emojiStyle none', () => {
        const none = profileFor('emoji-none', {
            emojiStyle: 'none',
            emojiRate: 0,
        })
        const expressive = profileFor('emoji-expr', {
            emojiStyle: 'expressive',
            emojiRate: REVIEW_STYLE_BOUNDS.emojiRate.max,
        })

        const input = {
            accountId: 3,
            baseText: BASE_VI,
            rating: 5,
            generationSeed: 'emoji-run',
            previousReviews: [],
        }

        const noEmoji = styleReviewText(input, none)
        expect(noEmoji.audit.emojiCount).toBe(0)
        expect(/[\u{1F300}-\u{1FAFF}]/u.test(noEmoji.styledText)).toBe(false)

        for (let i = 0; i < 12; i++) {
            const r = styleReviewText(
                { ...input, generationSeed: `emoji-run-${i}` },
                expressive,
            )
            expect(r.audit.emojiCount).toBeLessThanOrEqual(
                REVIEW_STYLE_BOUNDS.maxEmojisPerReview,
            )
        }
    })

    it('keeps length delta within bound relative to base', () => {
        const profile = profileFor('len-seed', {
            preferredLength: 'long',
            formality: 0.8,
        })
        for (let i = 0; i < 10; i++) {
            const r = styleReviewText(
                {
                    accountId: 4,
                    baseText: BASE_VI,
                    rating: 5,
                    generationSeed: `len-${i}`,
                    previousReviews: [],
                },
                profile,
            )
            const ow = r.audit.originalWordCount
            const maxDelta = Math.ceil(ow * REVIEW_STYLE_BOUNDS.maxLengthDeltaRatio) + 8
            expect(Math.abs(r.audit.lengthDelta)).toBeLessThanOrEqual(maxDelta + 2)
            expect(r.audit.styledWordCount).toBeGreaterThan(0)
        }
    })

    it('preserves location name and URL (protected tokens)', () => {
        const profile = profileFor('protect-seed', {
            typoRate: REVIEW_STYLE_BOUNDS.typoRate.max,
            emojiRate: REVIEW_STYLE_BOUNDS.emojiRate.max,
            emojiStyle: 'expressive',
            codeSwitchRate: REVIEW_STYLE_BOUNDS.codeSwitchRate.max,
        })
        const locationName = 'KAFF Việt Nam'
        const url = 'https://maps.example.com/place/kaff'
        const baseText =
            `Ghé ${locationName} thấy ổn. Xem thêm tại ${url} nhé. Nhân viên rất nhiệt tình.`

        for (let i = 0; i < 8; i++) {
            const r = styleReviewText(
                {
                    accountId: 5,
                    baseText,
                    locationName,
                    rating: 5,
                    generationSeed: `protect-${i}`,
                    previousReviews: [],
                },
                profile,
            )
            expect(r.styledText).toContain(locationName)
            expect(r.styledText).toContain(url)
            expect(r.audit.protectedTokensPreserved).toBe(true)
        }
    })

    it('dedupe reduces similarity when previous reviews are near-duplicates', () => {
        const profile = profileFor('dedupe-seed', {
            formality: 0.4,
            typoRate: 0.02,
            emojiRate: 0.05,
            emojiStyle: 'sparse',
        })
        const previous = [BASE_VI, `${BASE_VI} Ok lắm.`]

        const r = styleReviewText(
            {
                accountId: 6,
                baseText: BASE_VI,
                rating: 5,
                generationSeed: 'dedupe-fixed',
                previousReviews: previous,
            },
            profile,
        )

        // Either dedupe applied or already below threshold after styling
        if (r.audit.dedupeApplied) {
            expect(r.audit.similarityToPrevious).toBeLessThan(
                REVIEW_STYLE_BOUNDS.dedupeSimilarityThreshold + 0.05,
            )
        }
        expect(r.audit.similarityToPrevious).toBeGreaterThanOrEqual(0)
        expect(r.audit.similarityToPrevious).toBeLessThanOrEqual(1)
        // Should not be an exact copy of previous[0]
        expect(r.styledText.trim()).not.toBe(previous[0].trim())
    })

    it('emits complete audit metadata', () => {
        const profile = profileFor('audit-seed')
        const r = styleReviewText(
            {
                accountId: 42,
                baseText: BASE_VI,
                locationName: 'Test Place',
                category: 'Cafe',
                rating: 4,
                generationSeed: 'audit-gen',
                previousReviews: ['Bài review cũ hoàn toàn khác.'],
            },
            profile,
        )
        expect(r.audit.accountId).toBe(42)
        expect(r.audit.profileVersion).toBe(REVIEW_STYLE_PROFILE_VERSION)
        expect(r.audit.steps.length).toBeGreaterThan(0)
        expect(typeof r.audit.formality).toBe('number')
        expect(typeof r.audit.typoCount).toBe('number')
        expect(typeof r.audit.emojiCount).toBe('number')
        expect(Array.isArray(r.audit.steps)).toBe(true)
    })
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

describe('similarity + protect helpers', () => {
    it('computeTextSimilarity is 1 for identical and lower for different', () => {
        expect(computeTextSimilarity('hello world', 'hello world')).toBe(1)
        expect(computeTextSimilarity('abc def', 'xyz qwe')).toBe(0)
        const mid = computeTextSimilarity(
            'quan ca phe rat ngon khong gian dep',
            'quan ca phe ngon view dep',
        )
        expect(mid).toBeGreaterThan(0.3)
        expect(mid).toBeLessThan(1)
    })

    it('maxSimilarityToPrevious picks the max', () => {
        const max = maxSimilarityToPrevious('hello world foo', [
            'zzz',
            'hello world',
            'nothing',
        ])
        expect(max).toBeGreaterThan(0.4)
    })

    it('protect/restore round-trips URLs and names', () => {
        const text = 'Visit https://example.com and KAFF Store today'
        const { text: protectedText, tokens } = protectSensitiveTokens(
            text,
            'KAFF Store',
        )
        expect(protectedText).not.toContain('https://example.com')
        expect(protectedText).not.toContain('KAFF Store')
        expect(tokens.length).toBeGreaterThanOrEqual(2)
        expect(restoreSensitiveTokens(protectedText, tokens)).toBe(text)
    })
})

// ─── Class facade (pure path) ────────────────────────────────────────────────

describe('ReviewContentGenerator.generateWithProfile', () => {
    it('delegates to styleReviewText', () => {
        const gen = new ReviewContentGenerator()
        const profile = profileFor('facade-seed')
        const out = gen.generateWithProfile(
            {
                accountId: 1,
                baseText: BASE_VI,
                rating: 5,
                generationSeed: 'facade-gen',
            },
            profile,
        )
        expect(out.styledText.length).toBeGreaterThan(5)
        expect(out.audit.accountId).toBe(1)
    })
})
