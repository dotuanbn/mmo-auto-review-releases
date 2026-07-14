/**
 * Account IPC contracts — public DTOs never carry password / TOTP secrets.
 * Secrets stay in main process only (encrypted at rest via SecretVault).
 *
 * Zod schemas validate untrusted renderer payloads at the IPC boundary.
 * Blank password / blank TOTP on update keep existing stored secrets
 * (handler applies ignore semantics after parse).
 */
import { z } from 'zod'
import { absolutePathSchema, boundedString, idSchema } from './ipc-schemas'

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type AccountLoginType = 'auto' | 'manual'

export type AccountStatus = 'active' | 'banned' | 'pending' | 'suspended' | 'checking'

/** Public account shape returned by accounts:* IPC (no password / twoFactorSecret). */
export interface PublicAccount {
    id: number
    email: string
    recoveryEmail?: string | null
    recoveryPhone?: string | null
    loginType: AccountLoginType
    profilePath?: string | null
    fingerprintId?: string | null
    status: AccountStatus
    lastUsed?: Date | string | null
    lastCheckAt?: Date | string | null
    totalReviews: number
    createdAt: Date | string
    /** True when a non-empty password is stored (value never sent to renderer). */
    hasPassword: boolean
    /** True when a non-empty TOTP secret is stored (value never sent to renderer). */
    hasTwoFactorSecret: boolean
    firstReviewDate?: Date | string | null
    lastReviewDate?: Date | string | null
    warmupLevel?: number
    reputationScore?: number
    warmupSessions?: number
    lastWarmupAt?: Date | string | null
    nextWarmupAt?: Date | string | null
}

/** Payload for accounts:add — password required at create time. */
export interface AccountCreatePayload {
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
    loginType?: AccountLoginType
    twoFactorSecret?: string
}

/**
 * Payload for accounts:update.
 * - blank / whitespace password is ignored (does not overwrite)
 * - blank twoFactorSecret is ignored; null clears the secret
 * - profilePath is intentionally omitted: only profiles:* IPC may set paths
 */
export interface AccountUpdatePayload {
    email?: string
    password?: string
    recoveryEmail?: string | null
    recoveryPhone?: string | null
    loginType?: AccountLoginType
    status?: AccountStatus
    twoFactorSecret?: string | null
}

/** Payload for profiles:update — basePath or profilePath (absolute) required. */
export interface ProfileUpdatePayload {
    accountId: number
    profilePath?: string
    basePath?: string
}

/** Payload for profiles:migrate */
export interface ProfileMigratePayload {
    accountId: number
    targetBasePath: string
}

/** Single row for accounts:importCSV */
export interface AccountImportPayload {
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
    twoFactorSecret?: string
    loginType?: AccountLoginType
}

export interface AccountLiveCheckResult {
    alive: boolean
    error?: string
    needs2FA?: boolean
}

export interface AccountStats {
    total: number
    active: number
    banned: number
    pending: number
    checking: number
}

export interface AccountLoginResult {
    success: boolean
    message: string
    needs2FA?: boolean
    contextId?: number
}

// ---------------------------------------------------------------------------
// Length / field bounds
// ---------------------------------------------------------------------------

/** RFC-ish email local+domain max; also covers short gmail-normalized locals. */
export const ACCOUNT_EMAIL_MAX = 320
export const ACCOUNT_PASSWORD_MAX = 512
export const ACCOUNT_TOTP_MAX = 256
export const ACCOUNT_RECOVERY_EMAIL_MAX = 320
export const ACCOUNT_RECOVERY_PHONE_MAX = 64
export const ACCOUNT_IMPORT_MAX_ROWS = 5000

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/** Positive account id (rejects 0, negative, float, non-number). */
export const accountIdSchema = idSchema

/**
 * Account email / identifier.
 * Short locals without @ are allowed (AccountService normalizes to @gmail.com).
 */
export const accountEmailSchema = boundedString(ACCOUNT_EMAIL_MAX, 1)

/**
 * Required non-blank password for create/import.
 * Does not strip internal spaces; only rejects all-whitespace.
 */
export const accountPasswordRequiredSchema = z
    .string()
    .min(1)
    .max(ACCOUNT_PASSWORD_MAX)
    .refine((v) => v.trim().length > 0, { message: 'Password must not be blank' })

/**
 * Optional update password: blank / whitespace allowed (handler ignores = keep existing).
 */
export const accountPasswordUpdateSchema = z.string().max(ACCOUNT_PASSWORD_MAX)

/**
 * TOTP secret (base32-ish). Blank on update = keep; null on update = clear.
 * Create/import treat empty as absent.
 */
export const accountTotpSecretSchema = z
    .string()
    .max(ACCOUNT_TOTP_MAX)
    .refine((v) => !v.includes('\0'), { message: 'TOTP secret must not contain null bytes' })

export const accountLoginTypeSchema = z.enum(['auto', 'manual'])

export const accountStatusSchema = z.enum([
    'active',
    'banned',
    'pending',
    'suspended',
    'checking',
])

export const accountRecoveryEmailSchema = boundedString(ACCOUNT_RECOVERY_EMAIL_MAX, 0)

export const accountRecoveryPhoneSchema = boundedString(ACCOUNT_RECOVERY_PHONE_MAX, 0)

/** Absolute profile path syntax only (semantic root checks live in path guards if needed). */
export const accountProfilePathSchema = absolutePathSchema

// ---------------------------------------------------------------------------
// Payload schemas (strict — reject unknown keys)
// ---------------------------------------------------------------------------

export const accountCreateSchema = z
    .object({
        email: accountEmailSchema,
        password: accountPasswordRequiredSchema,
        recoveryEmail: accountRecoveryEmailSchema.optional(),
        recoveryPhone: accountRecoveryPhoneSchema.optional(),
        loginType: accountLoginTypeSchema.optional(),
        twoFactorSecret: accountTotpSecretSchema.optional(),
    })
    .strict()

/**
 * Update payload. Blank password / blank twoFactorSecret are accepted here;
 * handler must ignore them so stored secrets are not overwritten.
 * twoFactorSecret: null clears the secret.
 * profilePath is rejected (strict): path changes go through profiles:* only.
 */
export const accountUpdateSchema = z
    .object({
        email: accountEmailSchema.optional(),
        password: accountPasswordUpdateSchema.optional(),
        recoveryEmail: z.union([accountRecoveryEmailSchema, z.null()]).optional(),
        recoveryPhone: z.union([accountRecoveryPhoneSchema, z.null()]).optional(),
        loginType: accountLoginTypeSchema.optional(),
        status: accountStatusSchema.optional(),
        twoFactorSecret: z.union([accountTotpSecretSchema, z.null()]).optional(),
    })
    .strict()

export const accountImportRowSchema = z
    .object({
        email: accountEmailSchema,
        password: accountPasswordRequiredSchema,
        recoveryEmail: accountRecoveryEmailSchema.optional(),
        recoveryPhone: accountRecoveryPhoneSchema.optional(),
        twoFactorSecret: accountTotpSecretSchema.optional(),
        loginType: accountLoginTypeSchema.optional(),
    })
    .strict()

export const accountImportListSchema = z
    .array(accountImportRowSchema)
    .max(ACCOUNT_IMPORT_MAX_ROWS)

/** Tuple for accounts:update(id, data). */
export const accountUpdateArgsSchema = z.tuple([accountIdSchema, accountUpdateSchema])

// ---------------------------------------------------------------------------
// Profile IPC payloads (profiles:* — sole path mutation surface)
// ---------------------------------------------------------------------------

export const profileGetSchema = accountIdSchema
export const profileCreateSchema = accountIdSchema
export const profileDeleteSchema = accountIdSchema

export const profileUpdatePayloadSchema = z
    .object({
        accountId: accountIdSchema,
        profilePath: accountProfilePathSchema.optional(),
        basePath: accountProfilePathSchema.optional(),
    })
    .strict()
    .refine((v) => v.profilePath !== undefined || v.basePath !== undefined, {
        message: 'profilePath or basePath is required',
    })

export const profileMigratePayloadSchema = z
    .object({
        accountId: accountIdSchema,
        targetBasePath: accountProfilePathSchema,
    })
    .strict()
