/**
 * Proxy / FProxy IPC contracts + runtime Zod schemas.
 * Public DTOs never carry password secrets — only `hasPassword` flag.
 * Blank password on update keeps the stored secret; `null` clears it.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Constants / bounds
// ---------------------------------------------------------------------------

export const PROXY_TYPES = ['http', 'https', 'socks5'] as const
export const PROXY_STATUSES = ['active', 'dead', 'checking'] as const

/** Hostname / IP max length (DNS label budget). */
export const PROXY_HOST_MAX = 253
export const PROXY_PORT_MIN = 1
export const PROXY_PORT_MAX = 65535
export const PROXY_USERNAME_MAX = 256
export const PROXY_PASSWORD_MAX = 512
export const PROXY_PROVIDER_MAX = 64
export const PROXY_COUNTRY_MAX = 64
/** Max characters for proxies:importText bulk body. */
export const PROXY_IMPORT_TEXT_MAX = 500_000
/** Max length for fproxy:setApiKey (raw key or URL-wrapped key). */
export const FPROXY_API_KEY_MAX = 512

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ProxyBridgeMode = 'direct' | 'anonymized' | 'none'
export type ProxyType = (typeof PROXY_TYPES)[number]
export type ProxyStatus = (typeof PROXY_STATUSES)[number]

/**
 * Public proxy shape returned by proxies:* IPC.
 * Never includes password — use `hasPassword` instead.
 */
export interface PublicProxy {
    id: number
    host: string
    port: number
    username?: string | null
    type: ProxyType
    country?: string | null
    provider?: string | null
    status: ProxyStatus
    lastCheck?: Date | string | null
    responseTime?: number | null
    createdAt: Date | string
    /** True when a non-empty password is stored (value never sent to renderer). */
    hasPassword: boolean
}

/** Payload for proxies:add — secrets accepted at create only, never returned. */
export interface ProxyCreatePayload {
    host: string
    port: number
    username?: string
    password?: string
    type?: ProxyType
    country?: string
    provider?: string
}

/**
 * Payload for proxies:update.
 * - blank / whitespace password is ignored (does not overwrite stored secret)
 * - password: null clears the stored secret
 */
export interface ProxyUpdatePayload {
    host?: string
    port?: number
    username?: string | null
    password?: string | null
    type?: ProxyType
    country?: string | null
    provider?: string | null
    status?: ProxyStatus
}

export interface ProxyStats {
    total: number
    active: number
    dead: number
}

export type ProxyRuntimeReasonCode =
    | 'ok'
    | 'proxy_not_found'
    | 'bridge_acquire_failed'
    | 'context_create_failed'
    | 'navigation_timeout'
    | 'proxy_connection_failed'
    | 'proxy_auth_required'
    | 'ip_unobserved'
    | 'navigation_failed'
    | 'timeout'
    | 'unknown_error'

export interface ProxyRuntimeCheckResult {
    ok: boolean
    alive: boolean
    responseTime: number
    latencyMs: number
    reasonCode: ProxyRuntimeReasonCode
    observedIp: string | null
    bridgeMode: ProxyBridgeMode
    mode: 'runtime_parity'
    message?: string
    probeUrl?: string
}

// ---------------------------------------------------------------------------
// Zod primitives
// ---------------------------------------------------------------------------

export const proxyTypeSchema = z.enum(PROXY_TYPES)
export const proxyStatusSchema = z.enum(PROXY_STATUSES)

/** Positive integer ID (proxy row id). */
export const proxyIdSchema = z.number().int().positive()

export const proxyHostSchema = z
    .string()
    .trim()
    .min(1, 'host is required')
    .max(PROXY_HOST_MAX)

export const proxyPortSchema = z
    .number()
    .int()
    .min(PROXY_PORT_MIN, 'port must be 1-65535')
    .max(PROXY_PORT_MAX, 'port must be 1-65535')

const emptyToUndefined = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value

/**
 * Optional credential field: empty string → undefined (omit).
 * Does not trim password content beyond empty-check (preserve intentional spaces).
 */
const optionalCredentialSchema = (max: number) =>
    z
        .union([z.string().max(max), z.literal('')])
        .optional()
        .transform((value) => {
            if (value === undefined || value === '') return undefined
            return value
        })

const optionalBoundedLabelSchema = (max: number) =>
    z
        .union([z.string().trim().min(1).max(max), z.literal('')])
        .optional()
        .transform(emptyToUndefined)

/**
 * Update password field:
 * - omitted / blank whitespace → undefined (keep existing secret)
 * - null → clear secret
 * - non-empty string → replace secret
 */
export const proxyPasswordUpdateSchema = z
    .union([z.string().max(PROXY_PASSWORD_MAX), z.null()])
    .optional()
    .transform((value): string | null | undefined => {
        if (value === undefined) return undefined
        if (value === null) return null
        if (value.trim() === '') return undefined
        return value
    })

const nullableBoundedString = (max: number) =>
    z.union([z.string().trim().min(1).max(max), z.null()]).optional()

// ---------------------------------------------------------------------------
// Create / update / import / id
// ---------------------------------------------------------------------------

export const proxyCreateSchema = z
    .object({
        host: proxyHostSchema,
        port: proxyPortSchema,
        username: optionalCredentialSchema(PROXY_USERNAME_MAX),
        password: optionalCredentialSchema(PROXY_PASSWORD_MAX),
        type: proxyTypeSchema.optional().default('http'),
        country: optionalBoundedLabelSchema(PROXY_COUNTRY_MAX),
        provider: optionalBoundedLabelSchema(PROXY_PROVIDER_MAX),
    })
    .strict()

export const proxyUpdateSchema = z
    .object({
        host: proxyHostSchema.optional(),
        port: proxyPortSchema.optional(),
        username: z.union([z.string().max(PROXY_USERNAME_MAX), z.null()]).optional(),
        password: proxyPasswordUpdateSchema,
        type: proxyTypeSchema.optional(),
        country: nullableBoundedString(PROXY_COUNTRY_MAX),
        provider: nullableBoundedString(PROXY_PROVIDER_MAX),
        status: proxyStatusSchema.optional(),
    })
    .strict()

export const proxyUpdateArgsSchema = z.tuple([proxyIdSchema, proxyUpdateSchema])

export const proxyImportTextSchema = z
    .string()
    .max(PROXY_IMPORT_TEXT_MAX, `import text exceeds ${PROXY_IMPORT_TEXT_MAX} characters`)
    .refine((value) => value.trim().length > 0, { message: 'import text is required' })

export const proxyImportProviderSchema = z
    .union([z.string().trim().min(1).max(PROXY_PROVIDER_MAX), z.literal(''), z.undefined()])
    .transform((value) => {
        if (value === undefined || value === '' || value.trim() === '') return undefined
        return value.trim()
    })

export const proxyImportArgsSchema = z.tuple([
    proxyImportTextSchema,
    proxyImportProviderSchema.optional(),
])

// ---------------------------------------------------------------------------
// FProxy
// ---------------------------------------------------------------------------

/** fproxy:setApiKey — empty string allowed (clears configuration in service). */
export const fproxyApiKeySchema = z.string().max(FPROXY_API_KEY_MAX)

/**
 * fproxy:testApi currently takes no payload.
 * Accept undefined / no extra args; reject non-empty object payloads if passed.
 */
export const fproxyTestApiInputSchema = z
    .union([z.undefined(), z.null()])
    .optional()
    .transform(() => undefined)

// ---------------------------------------------------------------------------
// Inferred output types (post-transform, for handlers)
// ---------------------------------------------------------------------------

export type ProxyCreateInput = z.output<typeof proxyCreateSchema>
export type ProxyUpdateInput = z.output<typeof proxyUpdateSchema>
export type ProxyImportArgs = z.output<typeof proxyImportArgsSchema>
export type FproxyApiKeyInput = z.output<typeof fproxyApiKeySchema>

/**
 * Drop keys whose value is `undefined` so partial DB updates do not overwrite.
 * Keeps explicit `null` (used to clear nullable columns / secrets).
 */
export function omitUndefinedFields<T extends object>(input: T): Partial<T> {
    const out: Partial<T> = {}
    for (const key of Object.keys(input) as Array<keyof T>) {
        const value = input[key]
        if (value !== undefined) {
            out[key] = value
        }
    }
    return out
}
