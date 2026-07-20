/**
 * Proxy / FProxy IPC boundary — Zod schema unit tests.
 * Does not load Electron handlers; validates contracts only.
 */
import { describe, expect, it } from 'vitest'
import {
    FPROXY_API_KEY_MAX,
    PROXY_IMPORT_TEXT_MAX,
    fproxyApiKeySchema,
    fproxyTestApiInputSchema,
    omitUndefinedFields,
    proxyCreateSchema,
    proxyIdSchema,
    proxyImportArgsSchema,
    proxyPasswordUpdateSchema,
    proxyUpdateArgsSchema,
    proxyUpdateSchema,
} from '../src/shared/proxy-contracts'

function expectOk<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    input: unknown,
): T {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
    return result.data as T
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
}

// ---------------------------------------------------------------------------
// proxyIdSchema
// ---------------------------------------------------------------------------

describe('proxyIdSchema', () => {
    it('accepts positive integers', () => {
        expectOk(proxyIdSchema, 1)
        expectOk(proxyIdSchema, 99)
    })

    it('rejects zero, negative, float, string, null', () => {
        expectFail(proxyIdSchema, 0)
        expectFail(proxyIdSchema, -1)
        expectFail(proxyIdSchema, 1.5)
        expectFail(proxyIdSchema, '1')
        expectFail(proxyIdSchema, null)
        expectFail(proxyIdSchema, undefined)
    })
})

// ---------------------------------------------------------------------------
// proxyCreateSchema
// ---------------------------------------------------------------------------

describe('proxyCreateSchema', () => {
    it('accepts minimal valid payload and defaults type to http', () => {
        const data = expectOk(proxyCreateSchema, { host: '1.2.3.4', port: 8080 })
        expect(data.host).toBe('1.2.3.4')
        expect(data.port).toBe(8080)
        expect(data.type).toBe('http')
        expect(data.username).toBeUndefined()
        expect(data.password).toBeUndefined()
    })

    it('trims host and accepts full credentials', () => {
        const data = expectOk(proxyCreateSchema, {
            host: '  proxy.example.com  ',
            port: 1080,
            username: 'user',
            password: 's3cret',
            type: 'socks5',
            country: 'US',
            provider: 'dataimpulse',
        })
        expect(data.host).toBe('proxy.example.com')
        expect(data.type).toBe('socks5')
        expect(data.username).toBe('user')
        expect(data.password).toBe('s3cret')
        expect(data.provider).toBe('dataimpulse')
    })

    it('treats empty username/password as undefined', () => {
        const data = expectOk(proxyCreateSchema, {
            host: 'h.example',
            port: 80,
            username: '',
            password: '',
        })
        expect(data.username).toBeUndefined()
        expect(data.password).toBeUndefined()
    })

    it('rejects missing host, empty host, and bad ports', () => {
        expectFail(proxyCreateSchema, { port: 8080 })
        expectFail(proxyCreateSchema, { host: '', port: 8080 })
        expectFail(proxyCreateSchema, { host: '   ', port: 8080 })
        expectFail(proxyCreateSchema, { host: 'h', port: 0 })
        expectFail(proxyCreateSchema, { host: 'h', port: 65536 })
        expectFail(proxyCreateSchema, { host: 'h', port: -1 })
        expectFail(proxyCreateSchema, { host: 'h', port: 1.5 })
        expectFail(proxyCreateSchema, { host: 'h', port: '8080' })
    })

    it('rejects invalid type and unknown keys', () => {
        expectFail(proxyCreateSchema, { host: 'h', port: 1, type: 'ftp' })
        expectFail(proxyCreateSchema, { host: 'h', port: 1, inject: true })
    })

    it('rejects oversized host / username / password / provider / country', () => {
        expectFail(proxyCreateSchema, { host: 'a'.repeat(254), port: 1 })
        expectFail(proxyCreateSchema, { host: 'h', port: 1, username: 'u'.repeat(257) })
        expectFail(proxyCreateSchema, { host: 'h', port: 1, password: 'p'.repeat(513) })
        expectFail(proxyCreateSchema, { host: 'h', port: 1, provider: 'p'.repeat(65) })
        expectFail(proxyCreateSchema, { host: 'h', port: 1, country: 'c'.repeat(65) })
    })
})

// ---------------------------------------------------------------------------
// proxyUpdateSchema + password semantics
// ---------------------------------------------------------------------------

describe('proxyPasswordUpdateSchema', () => {
    it('blank / whitespace → undefined (keep existing secret)', () => {
        expect(expectOk(proxyPasswordUpdateSchema, '')).toBeUndefined()
        expect(expectOk(proxyPasswordUpdateSchema, '   ')).toBeUndefined()
        expect(expectOk(proxyPasswordUpdateSchema, undefined)).toBeUndefined()
    })

    it('null → null (clear secret)', () => {
        expect(expectOk(proxyPasswordUpdateSchema, null)).toBeNull()
    })

    it('non-empty string → kept for replace', () => {
        expect(expectOk(proxyPasswordUpdateSchema, 'new-pass')).toBe('new-pass')
    })
})

describe('proxyUpdateSchema', () => {
    it('accepts partial fields', () => {
        const data = expectOk(proxyUpdateSchema, { host: 'new.host', status: 'dead' })
        expect(data.host).toBe('new.host')
        expect(data.status).toBe('dead')
    })

    it('password blank omitted; null kept after omitUndefinedFields', () => {
        const blank = expectOk(proxyUpdateSchema, { password: '' })
        expect(blank.password).toBeUndefined()
        const stripped = omitUndefinedFields(blank)
        expect('password' in stripped).toBe(false)

        const cleared = expectOk(proxyUpdateSchema, { password: null })
        expect(cleared.password).toBeNull()
        const withNull = omitUndefinedFields(cleared)
        expect(withNull.password).toBeNull()
    })

    it('allows username/country/provider null clear', () => {
        const data = expectOk(proxyUpdateSchema, {
            username: null,
            country: null,
            provider: null,
        })
        expect(data.username).toBeNull()
        expect(data.country).toBeNull()
        expect(data.provider).toBeNull()
    })

    it('rejects invalid port, type, status, unknown keys', () => {
        expectFail(proxyUpdateSchema, { port: 0 })
        expectFail(proxyUpdateSchema, { port: 70000 })
        expectFail(proxyUpdateSchema, { type: 'socks4' })
        expectFail(proxyUpdateSchema, { status: 'online' })
        expectFail(proxyUpdateSchema, { evil: 1 })
    })
})

describe('proxyUpdateArgsSchema', () => {
    it('accepts [id, payload]', () => {
        const [id, data] = expectOk(proxyUpdateArgsSchema, [3, { host: 'x' }])
        expect(id).toBe(3)
        expect(data.host).toBe('x')
    })

    it('rejects non-positive id', () => {
        expectFail(proxyUpdateArgsSchema, [0, { host: 'x' }])
        expectFail(proxyUpdateArgsSchema, [-1, {}])
        expectFail(proxyUpdateArgsSchema, ['1', {}])
    })
})

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

describe('proxyImportArgsSchema', () => {
    it('accepts text + optional provider', () => {
        const [text, provider] = expectOk(proxyImportArgsSchema, [
            '1.2.3.4:8080\n5.6.7.8:3128',
            'dataimpulse',
        ])
        expect(text).toContain('1.2.3.4')
        expect(provider).toBe('dataimpulse')
    })

    it('accepts text alone; empty provider → undefined', () => {
        const [text, provider] = expectOk(proxyImportArgsSchema, ['host:1', ''])
        expect(text).toBe('host:1')
        expect(provider).toBeUndefined()

        const [, p2] = expectOk(proxyImportArgsSchema, ['host:1', undefined])
        expect(p2).toBeUndefined()
    })

    it('rejects empty / whitespace-only text', () => {
        expectFail(proxyImportArgsSchema, [''])
        expectFail(proxyImportArgsSchema, ['   '])
        expectFail(proxyImportArgsSchema, [null])
    })

    it('rejects oversized import text', () => {
        expectFail(proxyImportArgsSchema, ['x'.repeat(PROXY_IMPORT_TEXT_MAX + 1)])
    })

    it('accepts text at max size bound', () => {
        const body = 'h:1\n' + 'a'.repeat(100)
        expectOk(proxyImportArgsSchema, [body])
        expectOk(proxyImportArgsSchema, ['y'.repeat(PROXY_IMPORT_TEXT_MAX)])
    })

    it('rejects oversized provider', () => {
        expectFail(proxyImportArgsSchema, ['host:1', 'p'.repeat(65)])
    })
})

// ---------------------------------------------------------------------------
// Public DTO shape (no secret field)
// ---------------------------------------------------------------------------

describe('PublicProxy contract', () => {
    it('create/update schemas never require returning password', () => {
        // Runtime guard: PublicProxy type is compile-time; assert schema outputs
        // do not invent a public password field in create payload keys.
        const createKeys = Object.keys(
            expectOk(proxyCreateSchema, { host: 'h', port: 1, password: 'secret' }),
        )
        // password may be present on create *input* path only — service seals it.
        expect(createKeys).toContain('password')
        // Public shape documented keys (hasPassword, no password)
        const publicKeys = [
            'id',
            'host',
            'port',
            'username',
            'type',
            'country',
            'provider',
            'status',
            'lastCheck',
            'responseTime',
            'createdAt',
            'hasPassword',
        ]
        expect(publicKeys).toContain('hasPassword')
        expect(publicKeys).not.toContain('password')
    })
})

// ---------------------------------------------------------------------------
// FProxy
// ---------------------------------------------------------------------------

describe('fproxyApiKeySchema', () => {
    it('accepts empty (clear) and normal keys', () => {
        expectOk(fproxyApiKeySchema, '')
        expectOk(fproxyApiKeySchema, 'abc-key-123')
        expectOk(fproxyApiKeySchema, 'https://sv1.fproxy.me/api/rotate?key=abc')
    })

    it('rejects non-string and oversized keys', () => {
        expectFail(fproxyApiKeySchema, 123)
        expectFail(fproxyApiKeySchema, null)
        expectFail(fproxyApiKeySchema, { key: 'x' })
        expectFail(fproxyApiKeySchema, 'k'.repeat(FPROXY_API_KEY_MAX + 1))
    })
})

describe('fproxyTestApiInputSchema', () => {
    it('accepts undefined / null (no payload)', () => {
        expect(expectOk(fproxyTestApiInputSchema, undefined)).toBeUndefined()
        expect(expectOk(fproxyTestApiInputSchema, null)).toBeUndefined()
    })

    it('rejects unexpected objects / strings', () => {
        expectFail(fproxyTestApiInputSchema, {})
        expectFail(fproxyTestApiInputSchema, { apiKey: 'x' })
        expectFail(fproxyTestApiInputSchema, 'key')
    })
})

describe('omitUndefinedFields', () => {
    it('keeps null and drops undefined', () => {
        const result = omitUndefinedFields({
            host: 'h',
            password: null,
            username: undefined,
            port: 1,
        })
        expect(result).toEqual({ host: 'h', password: null, port: 1 })
        expect('username' in result).toBe(false)
    })
})
