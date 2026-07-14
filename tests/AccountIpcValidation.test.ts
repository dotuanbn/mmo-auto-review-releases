/**
 * Account IPC boundary schemas — positive IDs, strict create/update/import,
 * length/path guards, blank password/TOTP semantics preserved at parse layer.
 */
import { describe, expect, it } from 'vitest'
import {
    ACCOUNT_EMAIL_MAX,
    ACCOUNT_IMPORT_MAX_ROWS,
    ACCOUNT_PASSWORD_MAX,
    ACCOUNT_TOTP_MAX,
    accountCreateSchema,
    accountIdSchema,
    accountImportListSchema,
    accountImportRowSchema,
    accountPasswordRequiredSchema,
    accountPasswordUpdateSchema,
    accountProfilePathSchema,
    accountUpdateArgsSchema,
    accountUpdateSchema,
} from '../src/shared/account-contracts'

function expectOk(schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify({ input, result })).toBe(true)
    return result
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
    return result
}

// ---------------------------------------------------------------------------
// Positive IDs (getById / delete / login / test / manual / checkLiveDie)
// ---------------------------------------------------------------------------

describe('accountIdSchema', () => {
    it('accepts positive integers', () => {
        expectOk(accountIdSchema, 1)
        expectOk(accountIdSchema, 42)
        expectOk(accountIdSchema, 999999)
    })

    it('rejects garbage ids used by login/test/manual handlers', () => {
        for (const bad of [0, -1, 1.5, NaN, Infinity, '1', 'abc', null, undefined, {}, [], true, false]) {
            expectFail(accountIdSchema, bad)
        }
    })
})

// ---------------------------------------------------------------------------
// Create — strict + required password
// ---------------------------------------------------------------------------

describe('accountCreateSchema', () => {
    const valid = {
        email: 'user@gmail.com',
        password: 'secret-pass',
    }

    it('accepts minimal create payload', () => {
        expectOk(accountCreateSchema, valid)
    })

    it('accepts short local email (service normalizes to @gmail.com)', () => {
        expectOk(accountCreateSchema, { email: 'user123', password: 'x' })
    })

    it('accepts optional recovery / TOTP / loginType', () => {
        expectOk(accountCreateSchema, {
            email: 'a@b.co',
            password: 'p@ss',
            recoveryEmail: 'r@b.co',
            recoveryPhone: '+84123456789',
            twoFactorSecret: 'JBSWY3DPEHPK3PXP',
            loginType: 'manual',
        })
    })

    it('rejects blank password', () => {
        expectFail(accountCreateSchema, { email: 'a@b.co', password: '' })
        expectFail(accountCreateSchema, { email: 'a@b.co', password: '   ' })
    })

    it('rejects missing email/password and unknown keys', () => {
        expectFail(accountCreateSchema, { password: 'x' })
        expectFail(accountCreateSchema, { email: 'a@b.co' })
        expectFail(accountCreateSchema, { ...valid, inject: true })
        expectFail(accountCreateSchema, { ...valid, password_hash: 'x' })
    })

    it('rejects oversized email / password / TOTP', () => {
        expectFail(accountCreateSchema, {
            email: 'a'.repeat(ACCOUNT_EMAIL_MAX + 1),
            password: 'x',
        })
        expectFail(accountCreateSchema, {
            email: 'a@b.co',
            password: 'x'.repeat(ACCOUNT_PASSWORD_MAX + 1),
        })
        expectFail(accountCreateSchema, {
            email: 'a@b.co',
            password: 'x',
            twoFactorSecret: 'A'.repeat(ACCOUNT_TOTP_MAX + 1),
        })
    })
})

// ---------------------------------------------------------------------------
// Update — blank password/TOTP accepted (handler ignores); null TOTP clears
// ---------------------------------------------------------------------------

describe('accountUpdateSchema', () => {
    it('accepts empty object (no-op update)', () => {
        expectOk(accountUpdateSchema, {})
    })

    it('accepts blank password (keep-existing semantics at handler)', () => {
        const blank = accountUpdateSchema.safeParse({ password: '' })
        expect(blank.success).toBe(true)
        if (blank.success) expect(blank.data.password).toBe('')

        const spaces = accountUpdateSchema.safeParse({ password: '   ' })
        expect(spaces.success).toBe(true)
        if (spaces.success) expect(spaces.data.password).toBe('   ')
    })

    it('accepts blank TOTP (keep) and null TOTP (clear)', () => {
        expectOk(accountUpdateSchema, { twoFactorSecret: '' })
        expectOk(accountUpdateSchema, { twoFactorSecret: '   ' })
        const cleared = accountUpdateSchema.safeParse({ twoFactorSecret: null })
        expect(cleared.success).toBe(true)
        if (cleared.success) expect(cleared.data.twoFactorSecret).toBeNull()
    })

    it('accepts status, loginType, recovery fields (no profilePath)', () => {
        expectOk(accountUpdateSchema, {
            email: 'new@gmail.com',
            status: 'active',
            loginType: 'auto',
        })
        expectOk(accountUpdateSchema, { recoveryEmail: null, recoveryPhone: null })
    })

    it('rejects profilePath from renderer (profiles:* owns path mutation)', () => {
        expectFail(accountUpdateSchema, {
            profilePath: 'C:\\Users\\x\\AppData\\profiles\\acc1',
        })
        expectFail(accountUpdateSchema, { profilePath: '/home/user/profiles/acc1' })
        expectFail(accountUpdateSchema, { profilePath: null })
        expectFail(accountUpdateSchema, { profilePath: 'relative/path' })
        expectFail(accountUpdateSchema, {
            email: 'a@b.co',
            profilePath: 'C:\\Users\\x\\AppData\\profiles\\acc1',
        })
    })

    it('rejects unknown keys and invalid status/loginType', () => {
        expectFail(accountUpdateSchema, { evil: 1 })
        expectFail(accountUpdateSchema, { status: 'deleted' })
        expectFail(accountUpdateSchema, { loginType: 'semi' })
        expectFail(accountUpdateSchema, { password: 123 })
    })
})

describe('accountUpdateArgsSchema', () => {
    it('requires positive id + strict update object', () => {
        expectOk(accountUpdateArgsSchema, [1, { email: 'a@b.co' }])
        expectFail(accountUpdateArgsSchema, [0, { email: 'a@b.co' }])
        expectFail(accountUpdateArgsSchema, [-5, {}])
        expectFail(accountUpdateArgsSchema, ['1', {}])
        expectFail(accountUpdateArgsSchema, [1, { inject: true }])
    })
})

// ---------------------------------------------------------------------------
// Import CSV
// ---------------------------------------------------------------------------

describe('accountImportListSchema', () => {
    it('accepts empty list and valid rows', () => {
        expectOk(accountImportListSchema, [])
        expectOk(accountImportListSchema, [
            { email: 'a@b.co', password: 'p1' },
            {
                email: 'b@c.co',
                password: 'p2',
                twoFactorSecret: 'JBSWY3DPEHPK3PXP',
                loginType: 'manual',
                recoveryEmail: 'r@c.co',
            },
        ])
    })

    it('rejects blank password rows and unknown keys', () => {
        expectFail(accountImportListSchema, [{ email: 'a@b.co', password: '' }])
        expectFail(accountImportListSchema, [{ email: 'a@b.co', password: 'x', extra: 1 }])
        expectFail(accountImportRowSchema, { email: '', password: 'x' })
    })

    it('rejects oversized import batches', () => {
        const rows = Array.from({ length: ACCOUNT_IMPORT_MAX_ROWS + 1 }, (_, i) => ({
            email: `u${i}@x.co`,
            password: 'p',
        }))
        expectFail(accountImportListSchema, rows)
    })
})

// ---------------------------------------------------------------------------
// Field-level password / path
// ---------------------------------------------------------------------------

describe('password field schemas', () => {
    it('required rejects blank; update allows blank', () => {
        expectFail(accountPasswordRequiredSchema, '')
        expectFail(accountPasswordRequiredSchema, '   ')
        expectOk(accountPasswordRequiredSchema, 'x')
        expectOk(accountPasswordUpdateSchema, '')
        expectOk(accountPasswordUpdateSchema, '   ')
        expectOk(accountPasswordUpdateSchema, 'keep-me')
    })
})

describe('accountProfilePathSchema', () => {
    it('accepts absolute Windows / POSIX paths', () => {
        expectOk(accountProfilePathSchema, 'C:\\data\\profiles\\a')
        expectOk(accountProfilePathSchema, 'D:/app/profiles/a')
        expectOk(accountProfilePathSchema, '/var/lib/profiles/a')
        expectOk(accountProfilePathSchema, '\\\\server\\share\\profiles')
    })

    it('rejects relative and empty', () => {
        expectFail(accountProfilePathSchema, '')
        expectFail(accountProfilePathSchema, 'relative')
        expectFail(accountProfilePathSchema, './profiles')
    })
})

// ---------------------------------------------------------------------------
// Public DTO contract: create/update/import schemas must not require secrets out
// ---------------------------------------------------------------------------

describe('secret surface', () => {
    it('create schema fields are input-only (password in, no secret-out shape)', () => {
        const parsed = accountCreateSchema.safeParse({
            email: 'x@y.z',
            password: 'super-secret',
            twoFactorSecret: 'TOTPSECRETVALUE',
        })
        expect(parsed.success).toBe(true)
        if (!parsed.success) return
        // Ensure we only carry expected keys (strict already) — no cookie/token leak keys
        expect(Object.keys(parsed.data).sort()).toEqual(
            ['email', 'password', 'twoFactorSecret'].sort(),
        )
        expect('cookies' in parsed.data).toBe(false)
        expect('hasPassword' in parsed.data).toBe(false)
    })
})
