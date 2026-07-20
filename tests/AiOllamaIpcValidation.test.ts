/**
 * AI / Ollama IPC boundary — Zod schema unit tests.
 * Does not load Electron handlers; validates contracts only.
 */
import { describe, expect, it } from 'vitest'
import {
    AI_API_KEY_MAX,
    AI_BULK_COUNT_MAX,
    AI_CATEGORY_MAX,
    AI_LOCATION_NAME_MAX,
    AI_PROMPT_MAX,
    AI_REVIEW_CONTENT_MAX,
    OLLAMA_PATH_MAX,
    OLLAMA_URL_MAX,
    aiApiKeySchema,
    aiBulkCountSchema,
    aiGenerateBulkArgsSchema,
    aiGenerateOptionsSchema,
    aiGenerateReviewArgsSchema,
    aiGeneratedReviewSchema,
    aiImproveReviewArgsSchema,
    aiLanguageSchema,
    aiLocationNameSchema,
    aiSaveReviewArgsSchema,
    isSafeOllamaBaseUrl,
    ollamaTestConnectionUrlSchema,
} from '../src/shared/ai-contracts'

function expectOk<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    input: unknown,
): T {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify({ input, result })).toBe(true)
    return result.data as T
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
}

// ---------------------------------------------------------------------------
// Language / options / bounds
// ---------------------------------------------------------------------------

describe('aiLanguageSchema', () => {
    it('accepts vi and en only', () => {
        expectOk(aiLanguageSchema, 'vi')
        expectOk(aiLanguageSchema, 'en')
    })

    it('rejects other languages and non-strings', () => {
        expectFail(aiLanguageSchema, 'fr')
        expectFail(aiLanguageSchema, 'VI')
        expectFail(aiLanguageSchema, '')
        expectFail(aiLanguageSchema, 1)
        expectFail(aiLanguageSchema, null)
    })
})

describe('aiLocationNameSchema / prompt bounds', () => {
    it('accepts bounded location names', () => {
        expectOk(aiLocationNameSchema, 'Cafe ABC')
        expectOk(aiLocationNameSchema, 'x'.repeat(AI_LOCATION_NAME_MAX))
        expectOk(aiLocationNameSchema, '  trimmed  ')
    })

    it('rejects empty / oversized location names', () => {
        expectFail(aiLocationNameSchema, '')
        expectFail(aiLocationNameSchema, '   ')
        expectFail(aiLocationNameSchema, 'x'.repeat(AI_LOCATION_NAME_MAX + 1))
    })
})

describe('aiGenerateOptionsSchema (strict)', () => {
    it('accepts empty and full valid options', () => {
        expectOk(aiGenerateOptionsSchema, {})
        expectOk(aiGenerateOptionsSchema, {
            category: 'restaurant',
            style: 'casual',
            language: 'vi',
            rating: 5,
            length: 'medium',
        })
    })

    it('treats empty category as undefined', () => {
        const data = expectOk(aiGenerateOptionsSchema, { category: '' })
        expect(data.category).toBeUndefined()
    })

    it('rejects unknown keys and invalid enums / ratings', () => {
        expectFail(aiGenerateOptionsSchema, { inject: true })
        expectFail(aiGenerateOptionsSchema, { style: 'angry' })
        expectFail(aiGenerateOptionsSchema, { language: 'jp' })
        expectFail(aiGenerateOptionsSchema, { length: 'huge' })
        expectFail(aiGenerateOptionsSchema, { rating: 0 })
        expectFail(aiGenerateOptionsSchema, { rating: 6 })
        expectFail(aiGenerateOptionsSchema, { rating: 3.5 })
        expectFail(aiGenerateOptionsSchema, { category: 'c'.repeat(AI_CATEGORY_MAX + 1) })
    })
})

// ---------------------------------------------------------------------------
// generateReview / generateBulk / improveReview arg tuples
// ---------------------------------------------------------------------------

describe('aiGenerateReviewArgsSchema', () => {
    it('accepts location only and location + options', () => {
        expectOk(aiGenerateReviewArgsSchema, ['Shop A'])
        expectOk(aiGenerateReviewArgsSchema, ['Shop A', undefined])
        expectOk(aiGenerateReviewArgsSchema, ['Shop A', { style: 'professional', language: 'en' }])
    })

    it('rejects missing location, bad options, extra args', () => {
        expectFail(aiGenerateReviewArgsSchema, [''])
        expectFail(aiGenerateReviewArgsSchema, [123])
        expectFail(aiGenerateReviewArgsSchema, ['Shop', { evil: 1 }])
        expectFail(aiGenerateReviewArgsSchema, ['Shop', {}, 'extra'])
    })
})

describe('aiBulkCountSchema / aiGenerateBulkArgsSchema', () => {
    it('accepts count 1..50', () => {
        expectOk(aiBulkCountSchema, 1)
        expectOk(aiBulkCountSchema, AI_BULK_COUNT_MAX)
    })

    it('rejects count outside 1..50', () => {
        expectFail(aiBulkCountSchema, 0)
        expectFail(aiBulkCountSchema, AI_BULK_COUNT_MAX + 1)
        expectFail(aiBulkCountSchema, 1.5)
        expectFail(aiBulkCountSchema, '10')
        expectFail(aiBulkCountSchema, null)
    })

    it('accepts valid bulk arg tuples', () => {
        expectOk(aiGenerateBulkArgsSchema, [3, 'Loc', undefined, undefined])
        expectOk(aiGenerateBulkArgsSchema, [3, 'Loc', 'cafe', { style: 'casual' }])
        expectOk(aiGenerateBulkArgsSchema, [1, 'Loc'])
    })

    it('rejects bulk over cap, bad category type, non-strict options', () => {
        expectFail(aiGenerateBulkArgsSchema, [AI_BULK_COUNT_MAX + 1, 'Loc'])
        expectFail(aiGenerateBulkArgsSchema, [5, ''])
        expectFail(aiGenerateBulkArgsSchema, [5, 'Loc', { style: 'casual' }]) // category must be string
        expectFail(aiGenerateBulkArgsSchema, [5, 'Loc', 'cafe', { style: 'nope' }])
        expectFail(aiGenerateBulkArgsSchema, [5, 'Loc', 'cafe', { inject: 1 }])
    })
})

describe('aiImproveReviewArgsSchema', () => {
    it('accepts bounded text and optional language', () => {
        expectOk(aiImproveReviewArgsSchema, ['great food'])
        expectOk(aiImproveReviewArgsSchema, ['great food', 'en'])
        expectOk(aiImproveReviewArgsSchema, ['x'.repeat(AI_PROMPT_MAX), 'vi'])
    })

    it('rejects empty / oversized text and bad language', () => {
        expectFail(aiImproveReviewArgsSchema, [''])
        expectFail(aiImproveReviewArgsSchema, ['x'.repeat(AI_PROMPT_MAX + 1)])
        expectFail(aiImproveReviewArgsSchema, ['ok', 'fr'])
        expectFail(aiImproveReviewArgsSchema, [123])
    })
})

// ---------------------------------------------------------------------------
// setApiKey / saveReview
// ---------------------------------------------------------------------------

describe('aiApiKeySchema', () => {
    it('accepts empty (clear) and bounded keys', () => {
        expectOk(aiApiKeySchema, '')
        expectOk(aiApiKeySchema, 'gsk_test_key')
        expectOk(aiApiKeySchema, 'k'.repeat(AI_API_KEY_MAX))
    })

    it('rejects oversized keys and non-strings', () => {
        expectFail(aiApiKeySchema, 'k'.repeat(AI_API_KEY_MAX + 1))
        expectFail(aiApiKeySchema, 123)
        expectFail(aiApiKeySchema, null)
        expectFail(aiApiKeySchema, undefined)
    })
})

describe('aiGeneratedReviewSchema / aiSaveReviewArgsSchema', () => {
    const validReview = {
        content: 'Rất ngon và phục vụ tốt',
        rating: 5,
        style: 'casual',
        language: 'vi' as const,
    }

    it('accepts valid review + optional positive location id', () => {
        expectOk(aiGeneratedReviewSchema, validReview)
        expectOk(aiSaveReviewArgsSchema, [validReview])
        expectOk(aiSaveReviewArgsSchema, [validReview, undefined])
        expectOk(aiSaveReviewArgsSchema, [validReview, 42])
        expectOk(aiGeneratedReviewSchema, {
            ...validReview,
            content: 'x'.repeat(AI_REVIEW_CONTENT_MAX),
        })
    })

    it('rejects invalid review shape / location id', () => {
        expectFail(aiGeneratedReviewSchema, { ...validReview, language: 'fr' })
        expectFail(aiGeneratedReviewSchema, { ...validReview, rating: 0 })
        expectFail(aiGeneratedReviewSchema, { ...validReview, inject: true })
        expectFail(aiGeneratedReviewSchema, { ...validReview, content: '' })
        expectFail(aiGeneratedReviewSchema, {
            ...validReview,
            content: 'x'.repeat(AI_REVIEW_CONTENT_MAX + 1),
        })
        expectFail(aiSaveReviewArgsSchema, [validReview, 0])
        expectFail(aiSaveReviewArgsSchema, [validReview, -1])
        expectFail(aiSaveReviewArgsSchema, [validReview, 1.5])
        expectFail(aiSaveReviewArgsSchema, [validReview, '1'])
        expectFail(aiSaveReviewArgsSchema, [{ content: 'x' }])
    })
})

// ---------------------------------------------------------------------------
// Ollama SSRF / loopback-only URL
// ---------------------------------------------------------------------------

describe('isSafeOllamaBaseUrl', () => {
    it('accepts localhost / 127.0.0.1 / [::1] http(s) with optional port/path', () => {
        expect(isSafeOllamaBaseUrl('http://localhost:11434')).toBe(true)
        expect(isSafeOllamaBaseUrl('http://127.0.0.1:11434')).toBe(true)
        expect(isSafeOllamaBaseUrl('https://localhost')).toBe(true)
        expect(isSafeOllamaBaseUrl('http://[::1]:11434')).toBe(true)
        expect(isSafeOllamaBaseUrl('http://127.0.0.1:11434/')).toBe(true)
        expect(isSafeOllamaBaseUrl('http://localhost:11434/v1')).toBe(true)
    })

    it('rejects remote hosts and cloud metadata', () => {
        expect(isSafeOllamaBaseUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://metadata.google.internal')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://evil.com:11434')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://192.168.1.1:11434')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://10.0.0.1')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://0.0.0.0:11434')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://localhost.evil.com')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://127.0.0.1.nip.io')).toBe(false)
    })

    it('rejects non-http schemes, credentials, query/hash, oversized path', () => {
        expect(isSafeOllamaBaseUrl('file:///etc/passwd')).toBe(false)
        expect(isSafeOllamaBaseUrl('ftp://localhost:11434')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://user:pass@localhost:11434')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://localhost:11434?x=1')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://localhost:11434#frag')).toBe(false)
        expect(isSafeOllamaBaseUrl(`http://localhost:11434/${'a'.repeat(OLLAMA_PATH_MAX)}`)).toBe(
            false,
        )
        expect(isSafeOllamaBaseUrl('http://localhost:0')).toBe(false)
        expect(isSafeOllamaBaseUrl('http://localhost:99999')).toBe(false)
        expect(isSafeOllamaBaseUrl('not-a-url')).toBe(false)
        expect(isSafeOllamaBaseUrl('')).toBe(false)
        expect(isSafeOllamaBaseUrl('x'.repeat(OLLAMA_URL_MAX + 1))).toBe(false)
    })
})

describe('ollamaTestConnectionUrlSchema', () => {
    it('maps omit / null / empty to undefined', () => {
        expect(expectOk(ollamaTestConnectionUrlSchema, undefined)).toBeUndefined()
        expect(expectOk(ollamaTestConnectionUrlSchema, null)).toBeUndefined()
        expect(expectOk(ollamaTestConnectionUrlSchema, '')).toBeUndefined()
        expect(expectOk(ollamaTestConnectionUrlSchema, '   ')).toBeUndefined()
    })

    it('accepts safe loopback URLs', () => {
        expect(expectOk(ollamaTestConnectionUrlSchema, 'http://localhost:11434')).toBe(
            'http://localhost:11434',
        )
        expect(expectOk(ollamaTestConnectionUrlSchema, '  http://127.0.0.1:11434  ')).toBe(
            'http://127.0.0.1:11434',
        )
        expect(expectOk(ollamaTestConnectionUrlSchema, 'http://[::1]:11434')).toBe(
            'http://[::1]:11434',
        )
    })

    it('rejects SSRF / remote / metadata URLs', () => {
        expectFail(ollamaTestConnectionUrlSchema, 'http://169.254.169.254/')
        expectFail(ollamaTestConnectionUrlSchema, 'http://example.com')
        expectFail(ollamaTestConnectionUrlSchema, 'https://api.groq.com')
        expectFail(ollamaTestConnectionUrlSchema, 'http://user@localhost')
        expectFail(ollamaTestConnectionUrlSchema, 12345)
        expectFail(ollamaTestConnectionUrlSchema, { url: 'http://localhost' })
    })
})
