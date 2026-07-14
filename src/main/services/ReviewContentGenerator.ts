/**
 * ReviewContentGenerator — apply per-account style to base review text.
 *
 * Pipeline (deterministic given profile seed + generation seed):
 * 1. Protect proper names / URLs / emails
 * 2. Formality + vocabulary + sentence length shaping
 * 3. Bounded code-switch, typo, emoji injection
 * 4. Dedupe vs previous reviews (similarity heuristic)
 * 5. Emit styled text + audit metadata
 *
 * Pure `styleReviewText` is unit-testable without DB/Electron.
 */

import { and, desc, eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import {
    REVIEW_STYLE_BOUNDS,
    type ReviewStyleAuditMetadata,
    type ReviewStyleGenerateInput,
    type ReviewStyleGenerateOutput,
    type ReviewStyleProfile,
} from '../../shared/review-style-contracts'
import {
    createSeededRng,
    hashStringToSeed,
    reviewStyleService,
    type SeededRng,
    type ReviewStyleService,
} from './ReviewStyleService'

// ─── Constants ───────────────────────────────────────────────────────────────

const EMOJI_BY_STYLE: Record<string, string[]> = {
    none: [],
    sparse: ['🙂', '👍'],
    friendly: ['😊', '👍', '✨', '💖', '👏'],
    expressive: ['😍', '🔥', '💯', '🥰', '⭐', '🙌', '💕', '🎉'],
}

/** Common Vietnamese keyboard-adjacent / dropped-tone typos (safe, mild). */
const TYPO_MAP: ReadonlyArray<readonly [string, string]> = [
    ['thích', 'thich'],
    ['quá', 'qua'],
    ['được', 'duoc'],
    ['rất', 'rat'],
    ['nhân viên', 'nhan vien'],
    ['không', 'khong'],
    ['tuyệt', 'tuyet'],
    ['nhiều', 'nhieu'],
    ['cảm ơn', 'cam on'],
    ['không gian', 'khong gian'],
    ['nhiệt tình', 'nhiet tinh'],
    ['hài lòng', 'hai long'],
    ['tuyệt vời', 'tuyet voi'],
    ['ngon', 'ngoon'],
    ['ổn', 'on'],
]

const FORMAL_TO_CASUAL: ReadonlyArray<readonly [string, string]> = [
    ['rất hài lòng', 'ưng lắm'],
    ['xin cảm ơn', 'cảm ơn'],
    ['chúng tôi', 'mình'],
    ['chúng mình', 'mình'],
    ['tuyệt vời', 'xịn'],
    ['xuất sắc', 'đỉnh'],
    ['rất tốt', 'ổn áp'],
    ['nhân viên phục vụ', 'nv'],
]

const CASUAL_TO_FORMAL: ReadonlyArray<readonly [string, string]> = [
    ['ưng lắm', 'rất hài lòng'],
    ['xịn', 'rất tốt'],
    ['đỉnh', 'xuất sắc'],
    ['ok', 'ổn'],
    ['ổn áp', 'ổn định'],
    ['nv', 'nhân viên'],
    ['mình', 'tôi'],
    ['quá trời', 'rất nhiều'],
]

const PROTECT_PLACEHOLDER_PREFIX = '\uE000'
const PROTECT_PLACEHOLDER_SUFFIX = '\uE001'

// ─── Small pure helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n))
}

function wordCount(text: string): number {
    const t = text.trim()
    if (!t) return 0
    return t.split(/\s+/).filter(Boolean).length
}

function normalizeForSimilarity(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** Token Jaccard similarity in [0, 1]. */
export function computeTextSimilarity(a: string, b: string): number {
    const ta = normalizeForSimilarity(a).split(' ').filter(Boolean)
    const tb = normalizeForSimilarity(b).split(' ').filter(Boolean)
    if (ta.length === 0 && tb.length === 0) return 1
    if (ta.length === 0 || tb.length === 0) return 0

    const setA = new Set(ta)
    const setB = new Set(tb)
    let inter = 0
    for (const t of Array.from(setA)) {
        if (setB.has(t)) inter++
    }
    const union = setA.size + setB.size - inter
    return union === 0 ? 0 : inter / union
}

export function maxSimilarityToPrevious(
    text: string,
    previous: string[],
): number {
    if (!previous.length) return 0
    let max = 0
    for (const p of previous) {
        const s = computeTextSimilarity(text, p)
        if (s > max) max = s
    }
    return max
}

function buildGenerationSeed(
    profileSeed: string,
    input: ReviewStyleGenerateInput,
): string {
    if (input.generationSeed) return input.generationSeed
    const fingerprint = [
        input.baseText,
        input.locationName ?? '',
        input.category ?? '',
        String(input.rating),
        input.locationContext ?? '',
    ].join('|')
    return `${profileSeed}:${hashStringToSeed(fingerprint).toString(16)}`
}

// ─── Protected tokens ────────────────────────────────────────────────────────

interface ProtectResult {
    text: string
    tokens: string[]
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace URLs, emails, and location name with placeholders so later
 * mutation passes cannot corrupt proper nouns / links.
 */
export function protectSensitiveTokens(
    text: string,
    locationName?: string,
): ProtectResult {
    const tokens: string[] = []
    let working = text

    const stash = (match: string): string => {
        const idx = tokens.length
        tokens.push(match)
        return `${PROTECT_PLACEHOLDER_PREFIX}${idx}${PROTECT_PLACEHOLDER_SUFFIX}`
    }

    // URLs
    working = working.replace(
        /https?:\/\/[^\s]+|www\.[^\s]+/gi,
        (m) => stash(m),
    )
    // Emails
    working = working.replace(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        (m) => stash(m),
    )
    // Location name (longest match first; case-insensitive)
    if (locationName && locationName.trim().length >= 2) {
        const name = locationName.trim()
        const re = new RegExp(escapeRegExp(name), 'gi')
        working = working.replace(re, (m) => stash(m))
    }

    return { text: working, tokens }
}

export function restoreSensitiveTokens(
    text: string,
    tokens: string[],
): string {
    return text.replace(
        new RegExp(
            `${PROTECT_PLACEHOLDER_PREFIX}(\\d+)${PROTECT_PLACEHOLDER_SUFFIX}`,
            'g',
        ),
        (_m, idxStr: string) => {
            const idx = Number(idxStr)
            return tokens[idx] ?? ''
        },
    )
}

function allProtectedPreserved(
    original: string,
    styled: string,
    locationName?: string,
): boolean {
    const urlRe = /https?:\/\/[^\s]+|www\.[^\s]+/gi
    const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    const origUrls: string[] = original.match(urlRe) ?? []
    const styledUrls: string[] = styled.match(urlRe) ?? []
    for (const u of origUrls) {
        if (!styledUrls.includes(u) && !styled.includes(u)) return false
    }
    const origEmails: string[] = original.match(emailRe) ?? []
    for (const e of origEmails) {
        if (!styled.includes(e)) return false
    }
    if (locationName && locationName.trim().length >= 2) {
        // At least one occurrence preserved (case-insensitive ok if exact present)
        const name = locationName.trim()
        if (original.toLowerCase().includes(name.toLowerCase())) {
            if (!styled.toLowerCase().includes(name.toLowerCase())) return false
        }
    }
    return true
}

// ─── Transform steps ─────────────────────────────────────────────────────────

function applyFormality(
    text: string,
    formality: number,
    rng: SeededRng,
): string {
    const pairs = formality < 0.4
        ? FORMAL_TO_CASUAL
        : formality > 0.65
            ? CASUAL_TO_FORMAL
            : []

    let out = text
    for (const [from, to] of pairs) {
        if (rng() < 0.55 && out.toLowerCase().includes(from.toLowerCase())) {
            const re = new RegExp(escapeRegExp(from), 'i')
            out = out.replace(re, to)
        }
    }
    return out
}

function injectVocabulary(
    text: string,
    profile: ReviewStyleProfile,
    rng: SeededRng,
    rating: number,
): { text: string; steps: string[] } {
    const steps: string[] = []
    let out = text.trim()
    const vocab = profile.vocabulary

    // Opener for lower formality / short text
    if (
        vocab.openers.length > 0 &&
        profile.formality < 0.55 &&
        rng() < 0.35 &&
        wordCount(out) < 40
    ) {
        const opener = vocab.openers[Math.floor(rng() * vocab.openers.length)]
        if (!out.toLowerCase().startsWith(opener.toLowerCase())) {
            out = `${opener} ${out.charAt(0).toLowerCase()}${out.slice(1)}`
            steps.push('opener')
        }
    }

    // Intensifier swap for high ratings
    if (rating >= 4 && vocab.intensifiers.length > 0 && rng() < 0.4) {
        const intensifier =
            vocab.intensifiers[Math.floor(rng() * vocab.intensifiers.length)]
        if (/\brất\b/i.test(out) && intensifier !== 'rất') {
            out = out.replace(/\brất\b/i, intensifier)
            steps.push('intensifier')
        } else if (!out.toLowerCase().includes(intensifier.toLowerCase()) && rng() < 0.3) {
            // soft prepend intensifier phrase if none
            const phrase =
                vocab.positivePhrases[
                    Math.floor(rng() * Math.max(1, vocab.positivePhrases.length))
                ]
            if (phrase && !out.toLowerCase().includes(phrase.toLowerCase())) {
                out = `${out.replace(/[.!]?$/, '')}, ${intensifier} ${phrase}.`
                steps.push('positive_phrase')
            }
        }
    }

    // Closer
    if (vocab.closers.length > 0 && rng() < 0.3) {
        const closer = vocab.closers[Math.floor(rng() * vocab.closers.length)]
        if (!out.toLowerCase().includes(closer.toLowerCase())) {
            const needsSpace = !/[.!?…]$/.test(out.trim())
            out = needsSpace ? `${out.trim()}. ${closer}.` : `${out.trim()} ${closer}.`
            steps.push('closer')
        }
    }

    return { text: out, steps }
}

function reshapeSentences(
    text: string,
    profile: ReviewStyleProfile,
    rng: SeededRng,
): string {
    const parts = text
        .split(/(?<=[.!?…])\s+/)
        .map((s) => s.trim())
        .filter(Boolean)

    if (parts.length === 0) return text

    const target = profile.avgSentenceLength
    const variance = profile.sentenceLengthVariance
    const out: string[] = []

    for (const sentence of parts) {
        const words = sentence.split(/\s+/).filter(Boolean)
        const desired = clamp(
            target + (rng() * 2 - 1) * variance,
            REVIEW_STYLE_BOUNDS.avgSentenceLength.min,
            REVIEW_STYLE_BOUNDS.avgSentenceLength.max,
        )

        if (words.length > desired + variance + 2 && words.length >= 8) {
            // Split long sentence near midpoint
            const mid = Math.floor(words.length / 2)
            let splitAt = mid
            for (let i = mid - 2; i <= mid + 2; i++) {
                if (i > 0 && i < words.length - 1) {
                    splitAt = i
                    break
                }
            }
            const a = words.slice(0, splitAt).join(' ')
            const b = words.slice(splitAt).join(' ')
            out.push(ensureTerminal(a, profile, rng))
            out.push(ensureTerminal(capitalizeFirst(b), profile, rng))
        } else if (
            words.length < desired - variance &&
            out.length > 0 &&
            wordCount(out[out.length - 1]) + words.length <= desired + variance + 3
        ) {
            // Merge short into previous
            const prev = out.pop()!.replace(/[.!?…]+$/, '')
            out.push(ensureTerminal(`${prev}, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`, profile, rng))
        } else {
            out.push(ensureTerminal(sentence, profile, rng))
        }
    }

    // Preferred length band — soft trim/pad
    let joined = out.join(' ')
    const wc = wordCount(joined)
    if (profile.preferredLength === 'short' && wc > 45) {
        const keep = joined.split(/\s+/).slice(0, 40).join(' ')
        joined = ensureTerminal(keep, profile, rng)
    } else if (profile.preferredLength === 'long' && wc < 25 && profile.vocabulary.positivePhrases.length) {
        const phrase =
            profile.vocabulary.positivePhrases[
                Math.floor(rng() * profile.vocabulary.positivePhrases.length)
            ]
        if (phrase && !joined.toLowerCase().includes(phrase.toLowerCase())) {
            joined = `${joined.replace(/[.!]?$/, '')}. Thêm nữa là ${phrase}.`
        }
    }

    return joined
}

function ensureTerminal(
    sentence: string,
    profile: ReviewStyleProfile,
    rng: SeededRng,
): string {
    const t = sentence.trim()
    if (!t) return t
    if (/[.!?…]$/.test(t)) return t
    if (profile.punctuationStyle === 'expressive' && rng() < 0.35) {
        return `${t}!`
    }
    if (profile.punctuationStyle === 'minimal' && rng() < 0.4) {
        return t
    }
    return `${t}.`
}

function capitalizeFirst(s: string): string {
    if (!s) return s
    return s.charAt(0).toUpperCase() + s.slice(1)
}

function injectCodeSwitch(
    text: string,
    profile: ReviewStyleProfile,
    rng: SeededRng,
): { text: string; count: number } {
    const rate = profile.codeSwitchRate
    if (rate <= 0 || profile.vocabulary.englishLoanwords.length === 0) {
        return { text, count: 0 }
    }

    let count = 0
    let out = text
    const maxInserts = rate > 0.15 ? 2 : 1

    for (let i = 0; i < maxInserts; i++) {
        if (rng() > rate) continue
        const word =
            profile.vocabulary.englishLoanwords[
                Math.floor(rng() * profile.vocabulary.englishLoanwords.length)
            ]
        if (!word) continue
        if (out.toLowerCase().includes(word.toLowerCase())) continue

        // Insert before final punctuation of a mid/late sentence
        const sentences = out.split(/(?<=[.!?…])\s+/)
        if (sentences.length === 0) continue
        const idx = Math.min(
            sentences.length - 1,
            Math.floor(rng() * sentences.length),
        )
        const s = sentences[idx]
        const replaced = s.replace(
            /([.!?…])?$/,
            (m) => ` (${word})${m || ''}`,
        )
        if (replaced !== s) {
            sentences[idx] = replaced
            out = sentences.join(' ')
            count++
        }
    }

    return { text: out, count }
}

function injectTypos(
    text: string,
    profile: ReviewStyleProfile,
    rng: SeededRng,
): { text: string; count: number } {
    const rate = profile.typoRate
    if (rate <= 0) return { text, count: 0 }

    let out = text
    let count = 0
    const maxTypos = REVIEW_STYLE_BOUNDS.maxTyposPerReview

    // Prefer known mild Vietnamese typos
    const candidates = TYPO_MAP.filter(([from]) =>
        new RegExp(escapeRegExp(from), 'i').test(out),
    )

    for (const [from, to] of candidates) {
        if (count >= maxTypos) break
        // Probability scaled by profile typoRate
        if (rng() > rate * 8) continue // typoRate max 0.06 → ~0.48 chance per candidate
        const re = new RegExp(escapeRegExp(from), 'i')
        if (re.test(out)) {
            out = out.replace(re, to)
            count++
        }
    }

    // Optional single-character double-type on a safe lowercase ASCII word
    if (count < maxTypos && rng() < rate * 5) {
        out = out.replace(
            /\b([a-z]{4,})\b/,
            (full, word: string) => {
                if (count >= maxTypos) return full
                if (rng() > 0.5) return full
                const i = Math.floor(rng() * word.length)
                count++
                return word.slice(0, i) + word.charAt(i) + word.slice(i)
            },
        )
    }

    return { text: out, count }
}

function injectEmojis(
    text: string,
    profile: ReviewStyleProfile,
    rng: SeededRng,
    rating: number,
): { text: string; count: number } {
    if (profile.emojiStyle === 'none' || profile.emojiRate <= 0) {
        return { text, count: 0 }
    }

    const pool = EMOJI_BY_STYLE[profile.emojiStyle] ?? EMOJI_BY_STYLE.sparse
    if (pool.length === 0) return { text, count: 0 }

    // Lower ratings use fewer emojis
    const rateBoost = rating >= 4 ? 1 : 0.5
    if (rng() > profile.emojiRate * rateBoost * 2.5) {
        return { text, count: 0 }
    }

    const maxE = Math.min(
        REVIEW_STYLE_BOUNDS.maxEmojisPerReview,
        profile.emojiStyle === 'expressive' ? 2 : 1,
    )
    let count = 0
    let out = text.trim()

    for (let i = 0; i < maxE; i++) {
        if (i > 0 && rng() > profile.emojiRate) break
        const emoji = pool[Math.floor(rng() * pool.length)]
        if (out.includes(emoji)) continue
        if (i === 0) {
            out = `${out} ${emoji}`
        } else {
            // mid insert rare
            const words = out.split(/\s+/)
            const pos = Math.max(1, Math.floor(rng() * (words.length - 1)))
            words.splice(pos, 0, emoji)
            out = words.join(' ')
        }
        count++
    }

    return { text: out, count }
}

function applyDedupePass(
    text: string,
    previous: string[],
    profile: ReviewStyleProfile,
    rng: SeededRng,
): { text: string; applied: boolean; similarity: number } {
    let current = text
    let similarity = maxSimilarityToPrevious(current, previous)
    const threshold = REVIEW_STYLE_BOUNDS.dedupeSimilarityThreshold
    if (similarity < threshold || previous.length === 0) {
        return { text: current, applied: false, similarity }
    }

    let applied = false
    for (let attempt = 0; attempt < REVIEW_STYLE_BOUNDS.maxDedupeAttempts; attempt++) {
        // Swap closer / reorder mild fragments
        const vocab = profile.vocabulary
        if (vocab.closers.length > 0 && rng() < 0.7) {
            const closer = vocab.closers[Math.floor(rng() * vocab.closers.length)]
            current = current.replace(
                /\s*(Sẽ quay lại|Recommend nha|Đáng thử|Ok lắm|Sẽ ủng hộ tiếp|Nên ghé một lần|Hài lòng|Ổn áp)\.?$/i,
                '',
            )
            current = `${current.replace(/[.!]?$/, '')}. ${closer}.`
        }
        if (vocab.intensifiers.length > 0) {
            const intensifier =
                vocab.intensifiers[Math.floor(rng() * vocab.intensifiers.length)]
            current = current.replace(
                /\b(rất|khá|siêu|cực kỳ|hơi|thật sự|khá là|cũng khá)\b/i,
                intensifier,
            )
        }
        // Drop a filler if present; else add one
        if (vocab.fillerWords.length > 0) {
            const filler =
                vocab.fillerWords[Math.floor(rng() * vocab.fillerWords.length)]
            if (rng() < 0.5 && !current.includes(filler)) {
                const words = current.split(/\s+/)
                const pos = Math.min(words.length - 1, 2 + Math.floor(rng() * 3))
                words.splice(Math.max(1, pos), 0, filler)
                current = words.join(' ')
            }
        }

        applied = true
        similarity = maxSimilarityToPrevious(current, previous)
        if (similarity < threshold) break
    }

    return { text: current, applied, similarity }
}

function enforceLengthBound(original: string, styled: string): string {
    const ow = wordCount(original)
    const sw = wordCount(styled)
    if (ow === 0) return styled
    const maxDelta = Math.ceil(ow * REVIEW_STYLE_BOUNDS.maxLengthDeltaRatio) + 8
    if (sw <= ow + maxDelta) return styled

    // Trim excess words from the end, keep terminal punctuation
    const words = styled.trim().split(/\s+/)
    const keep = words.slice(0, ow + maxDelta)
    let trimmed = keep.join(' ')
    // The class intentionally includes multi-code-unit emoji terminal markers.
    // eslint-disable-next-line no-misleading-character-class
    if (!/[.!?…😊🙂👍✨💖👏😍🔥💯🥰⭐🙌💕🎉)]$/.test(trimmed)) {
        trimmed = `${trimmed.replace(/[,;:]$/, '')}.`
    }
    return trimmed
}

// ─── Pure public API ─────────────────────────────────────────────────────────

/**
 * Apply account style profile to base review text.
 * Fully deterministic for a fixed (profile, generationSeed, input).
 */
export function styleReviewText(
    input: ReviewStyleGenerateInput,
    profile: ReviewStyleProfile,
): ReviewStyleGenerateOutput {
    const steps: string[] = ['start']
    const generationSeed = buildGenerationSeed(profile.seed, input)
    const rng = createSeededRng(`gen:${generationSeed}`)
    const previous = input.previousReviews ?? []
    const original = (input.baseText || '').trim()

    if (!original) {
        return {
            styledText: '',
            audit: buildAudit({
                input,
                profile,
                generationSeed,
                styled: '',
                typoCount: 0,
                emojiCount: 0,
                codeSwitchCount: 0,
                similarity: 0,
                dedupeApplied: false,
                protectedOk: true,
                steps: ['empty_base'],
            }),
        }
    }

    // 1. Protect
    const protected_ = protectSensitiveTokens(original, input.locationName)
    steps.push('protect')
    let working = protected_.text

    // 2. Formality
    working = applyFormality(working, profile.formality, rng)
    steps.push('formality')

    // 3. Vocabulary
    const vocabResult = injectVocabulary(working, profile, rng, input.rating)
    working = vocabResult.text
    steps.push(...vocabResult.steps.map((s) => `vocab:${s}`))

    // 4. Sentence reshape
    working = reshapeSentences(working, profile, rng)
    steps.push('reshape')

    // 5. Code-switch
    const cs = injectCodeSwitch(working, profile, rng)
    working = cs.text
    if (cs.count > 0) steps.push(`code_switch:${cs.count}`)

    // 6. Typos (on unprotected regions only)
    const ty = injectTypos(working, profile, rng)
    working = ty.text
    if (ty.count > 0) steps.push(`typos:${ty.count}`)

    // 7. Emoji
    const em = injectEmojis(working, profile, rng, input.rating)
    working = em.text
    if (em.count > 0) steps.push(`emoji:${em.count}`)

    // 8. Restore protected tokens before dedupe / length checks
    working = restoreSensitiveTokens(working, protected_.tokens)
    steps.push('restore')

    // 9. Dedupe
    const dedupe = applyDedupePass(working, previous, profile, rng)
    working = dedupe.text
    if (dedupe.applied) steps.push('dedupe')

    // 10. Length bound
    working = enforceLengthBound(original, working)
    steps.push('length_bound')

    // Cleanup whitespace
    working = working.replace(/\s{2,}/g, ' ').trim()

    const protectedOk = allProtectedPreserved(
        original,
        working,
        input.locationName,
    )

    return {
        styledText: working,
        audit: buildAudit({
            input,
            profile,
            generationSeed,
            styled: working,
            typoCount: ty.count,
            emojiCount: em.count,
            codeSwitchCount: cs.count,
            similarity: dedupe.similarity,
            dedupeApplied: dedupe.applied,
            protectedOk,
            steps,
        }),
    }
}

function buildAudit(args: {
    input: ReviewStyleGenerateInput
    profile: ReviewStyleProfile
    generationSeed: string
    styled: string
    typoCount: number
    emojiCount: number
    codeSwitchCount: number
    similarity: number
    dedupeApplied: boolean
    protectedOk: boolean
    steps: string[]
}): ReviewStyleAuditMetadata {
    const originalWordCount = wordCount(args.input.baseText || '')
    const styledWordCount = wordCount(args.styled)
    return {
        accountId: args.input.accountId,
        seed: args.profile.seed,
        generationSeed: args.generationSeed,
        profileVersion: args.profile.version,
        formality: args.profile.formality,
        typoRate: args.profile.typoRate,
        emojiRate: args.profile.emojiRate,
        codeSwitchRate: args.profile.codeSwitchRate,
        typoCount: args.typoCount,
        emojiCount: args.emojiCount,
        codeSwitchCount: args.codeSwitchCount,
        similarityToPrevious: Math.round(args.similarity * 1000) / 1000,
        dedupeApplied: args.dedupeApplied,
        lengthDelta: styledWordCount - originalWordCount,
        originalWordCount,
        styledWordCount,
        protectedTokensPreserved: args.protectedOk,
        steps: args.steps,
    }
}

// ─── Service class ───────────────────────────────────────────────────────────

export class ReviewContentGenerator {
    constructor(private readonly styleService: ReviewStyleService = reviewStyleService) {}

    /**
     * Style a review for an account.
     * Loads/creates style profile; loads previous reviews from DB when not provided.
     */
    async generate(
        input: ReviewStyleGenerateInput,
    ): Promise<ReviewStyleGenerateOutput> {
        if (!input.baseText || !input.baseText.trim()) {
            throw new Error('baseText is required')
        }
        if (!Number.isFinite(input.accountId) || input.accountId <= 0) {
            throw new Error('accountId must be a positive number')
        }
        const rating = clamp(Math.round(input.rating || 5), 1, 5)

        const { profile } = await this.styleService.getOrCreateProfile(input.accountId)

        const previousReviews =
            input.previousReviews ??
            (await this.loadPreviousReviewTexts(input.accountId))

        return styleReviewText(
            {
                ...input,
                rating,
                previousReviews,
            },
            profile,
        )
    }

    /** Pure path when profile is already known (no DB). */
    generateWithProfile(
        input: ReviewStyleGenerateInput,
        profile: ReviewStyleProfile,
    ): ReviewStyleGenerateOutput {
        const rating = clamp(Math.round(input.rating || 5), 1, 5)
        return styleReviewText({ ...input, rating }, profile)
    }

    private async loadPreviousReviewTexts(accountId: number): Promise<string[]> {
        try {
            const db = getDatabase()
            // Content history / dedupe must only use successful posts
            const rows = db
                .select({
                    reviewText: schema.reviewHistory.reviewText,
                })
                .from(schema.reviewHistory)
                .where(and(
                    eq(schema.reviewHistory.accountId, accountId),
                    eq(schema.reviewHistory.status, 'success'),
                ))
                .orderBy(desc(schema.reviewHistory.createdAt))
                .limit(20)
                .all()

            return rows
                .map((r) => r.reviewText)
                .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        } catch {
            // DB unavailable (unit tests / early boot) — skip history
            return []
        }
    }
}

export const reviewContentGenerator = new ReviewContentGenerator()
