/**
 * AI / Ollama IPC contracts + runtime Zod schemas.
 * Pure module (no Electron). Handlers validate untrusted renderer payloads
 * before touching AIService, encrypted settings, or Ollama network calls.
 */

import { z } from 'zod'
import { boundedString, idSchema } from './ipc-schemas'

// ---------------------------------------------------------------------------
// Constants / bounds
// ---------------------------------------------------------------------------

export const AI_LANGUAGES = ['vi', 'en'] as const
export const AI_REVIEW_STYLES = ['casual', 'professional', 'enthusiastic'] as const
export const AI_REVIEW_LENGTHS = ['short', 'medium', 'long'] as const

/** Location name shown to the LLM prompt. */
export const AI_LOCATION_NAME_MAX = 200
/** Optional business category label. */
export const AI_CATEGORY_MAX = 128
/** improveReview / free-text prompt body. */
export const AI_PROMPT_MAX = 10_000
/** Generated review content persisted via ai:saveReview. */
export const AI_REVIEW_CONTENT_MAX = 10_000
/** Bulk generation hard cap. */
export const AI_BULK_COUNT_MAX = 50
/** Groq API key max (matches settingsPatchSchema groqApiKey). */
export const AI_API_KEY_MAX = 512
/** Ollama base URL max length. */
export const OLLAMA_URL_MAX = 512
/** Path component max on Ollama base URL. */
export const OLLAMA_PATH_MAX = 128
export const OLLAMA_PORT_MIN = 1
export const OLLAMA_PORT_MAX = 65535

/** Hostnames allowed for ollama:testConnection (loopback only). */
export const OLLAMA_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'] as const

// ---------------------------------------------------------------------------
// Domain types (mirror AIService public shapes without importing main)
// ---------------------------------------------------------------------------

export type AiLanguage = (typeof AI_LANGUAGES)[number]
export type AiReviewStyle = (typeof AI_REVIEW_STYLES)[number]
export type AiReviewLength = (typeof AI_REVIEW_LENGTHS)[number]

export interface AiGenerateReviewOptions {
    category?: string
    style?: AiReviewStyle
    language?: AiLanguage
    rating?: number
    length?: AiReviewLength
}

export interface AiGeneratedReview {
    content: string
    rating: number
    style: string
    language: AiLanguage
}

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

export const aiLanguageSchema = z.enum(AI_LANGUAGES)
export const aiReviewStyleSchema = z.enum(AI_REVIEW_STYLES)
export const aiReviewLengthSchema = z.enum(AI_REVIEW_LENGTHS)

export const aiLocationNameSchema = boundedString(AI_LOCATION_NAME_MAX)

export const aiCategorySchema = boundedString(AI_CATEGORY_MAX)

/** Optional category: omit / empty → undefined. */
export const aiOptionalCategorySchema = z
    .union([aiCategorySchema, z.literal(''), z.undefined()])
    .transform((value): string | undefined => {
        if (value === undefined || value === '') return undefined
        return value
    })

export const aiPromptTextSchema = boundedString(AI_PROMPT_MAX)

export const aiBulkCountSchema = z
    .number()
    .int()
    .min(1, 'bulk count must be at least 1')
    .max(AI_BULK_COUNT_MAX, `bulk count must be <= ${AI_BULK_COUNT_MAX}`)

export const aiRatingSchema = z.number().int().min(1).max(5)

/** Groq API key — empty string allowed (clears encrypted setting). */
export const aiApiKeySchema = z.string().max(AI_API_KEY_MAX)

export const aiLocationIdSchema = idSchema
export const aiOptionalLocationIdSchema = idSchema.optional()

/**
 * Strict generation options (no unknown keys).
 * category may ride on the options bag for ai:generateReview.
 */
export const aiGenerateOptionsSchema = z
    .object({
        category: aiOptionalCategorySchema,
        style: aiReviewStyleSchema.optional(),
        language: aiLanguageSchema.optional(),
        rating: aiRatingSchema.optional(),
        length: aiReviewLengthSchema.optional(),
    })
    .strict()

/** Options without category (bulk passes category as a separate arg). */
export const aiBulkOptionsSchema = z
    .object({
        style: aiReviewStyleSchema.optional(),
        language: aiLanguageSchema.optional(),
        rating: aiRatingSchema.optional(),
        length: aiReviewLengthSchema.optional(),
    })
    .strict()

/** Generated review payload for ai:saveReview. */
export const aiGeneratedReviewSchema = z
    .object({
        content: boundedString(AI_REVIEW_CONTENT_MAX),
        rating: aiRatingSchema,
        style: boundedString(64),
        language: aiLanguageSchema,
    })
    .strict()

// ---------------------------------------------------------------------------
// Arg tuples (match preload invoke arity)
// ---------------------------------------------------------------------------

/** ai:generateReview(locationName, options?) */
export const aiGenerateReviewArgsSchema = z.tuple([
    aiLocationNameSchema,
    aiGenerateOptionsSchema.optional(),
])

/** ai:generateBulk(count, locationName, category?, options?) */
export const aiGenerateBulkArgsSchema = z.tuple([
    aiBulkCountSchema,
    aiLocationNameSchema,
    aiOptionalCategorySchema,
    aiBulkOptionsSchema.optional(),
])

/** ai:improveReview(text, language?) */
export const aiImproveReviewArgsSchema = z.tuple([
    aiPromptTextSchema,
    aiLanguageSchema.optional(),
])

/** ai:setApiKey(key) */
export const aiSetApiKeyArgsSchema = z.tuple([aiApiKeySchema])

/** ai:saveReview(review, locationId?) */
export const aiSaveReviewArgsSchema = z.tuple([
    aiGeneratedReviewSchema,
    aiOptionalLocationIdSchema,
])

// ---------------------------------------------------------------------------
// Ollama localhost-only URL (SSRF guard)
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` is an http(s) URL pointing only at loopback
 * (localhost / 127.0.0.1 / ::1), with a bounded port and path.
 * Rejects remote hosts, link-local metadata (169.254.169.254), credentials,
 * non-http schemes, and oversized path/query/hash.
 */
export function isSafeOllamaBaseUrl(value: string): boolean {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > OLLAMA_URL_MAX) return false
    if (trimmed.includes('\0')) return false

    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        return false
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false
    }

    // Reject userinfo (credential injection / weird URL forms)
    if (parsed.username !== '' || parsed.password !== '') {
        return false
    }

    // Node may return IPv6 as "::1" or "[::1]" depending on platform/version
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        return false
    }

    // Explicit port when present; default ports are fine
    if (parsed.port !== '') {
        const port = Number(parsed.port)
        if (!Number.isInteger(port) || port < OLLAMA_PORT_MIN || port > OLLAMA_PORT_MAX) {
            return false
        }
    }

    // Path must stay small (base URL only — no remote path SSRF tricks)
    if (parsed.pathname.length > OLLAMA_PATH_MAX) {
        return false
    }

    // Disallow query/hash on base URL (keeps surface minimal)
    if (parsed.search !== '' || parsed.hash !== '') {
        return false
    }

    return true
}

/**
 * ollama:testConnection(url?)
 * - undefined / null / '' → undefined (handler uses configured default)
 * - otherwise must pass isSafeOllamaBaseUrl
 */
export const ollamaTestConnectionUrlSchema = z
    .union([z.string().max(OLLAMA_URL_MAX), z.undefined(), z.null(), z.literal('')])
    .transform((value): string | undefined => {
        if (value === undefined || value === null || value === '') return undefined
        const trimmed = value.trim()
        return trimmed === '' ? undefined : trimmed
    })
    .superRefine((value, ctx) => {
        if (value === undefined) return
        if (!isSafeOllamaBaseUrl(value)) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'Ollama URL must be http(s) loopback only (localhost / 127.0.0.1 / ::1) with bounded port/path',
            })
        }
    })

/** Tuple form for optional single-arg invoke. */
export const ollamaTestConnectionArgsSchema = z.tuple([
    ollamaTestConnectionUrlSchema.optional(),
]).rest(z.never())

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AiGenerateOptionsInput = z.output<typeof aiGenerateOptionsSchema>
export type AiBulkOptionsInput = z.output<typeof aiBulkOptionsSchema>
export type AiGeneratedReviewInput = z.output<typeof aiGeneratedReviewSchema>
export type AiGenerateReviewArgs = z.output<typeof aiGenerateReviewArgsSchema>
export type AiGenerateBulkArgs = z.output<typeof aiGenerateBulkArgsSchema>
export type AiImproveReviewArgs = z.output<typeof aiImproveReviewArgsSchema>
export type AiSaveReviewArgs = z.output<typeof aiSaveReviewArgsSchema>
export type OllamaTestConnectionUrl = z.output<typeof ollamaTestConnectionUrlSchema>
