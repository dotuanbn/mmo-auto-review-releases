import * as https from 'https'
import type { IncomingMessage } from 'http'
import { isIP } from 'net'

const FPROXY_HOST = 'fproxy.me'
const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
/** Typical FProxy rotate cycle when provider omits/zeros waiting_time. */
const DEFAULT_ROTATE_WINDOW_MS = 120_000
/** IP lifetime fallback when time_die is missing. */
const DEFAULT_IP_LIFETIME_MS = 30 * 60_000
/**
 * Provider getcurrent often mirrors waiting_time = time_die (~30m).
 * Real rotate countdowns from getnew are ~0-180s. Anything near IP life is not a rotate timer.
 */
const MAX_TRUSTED_ROTATE_WINDOW_MS = 5 * 60_000
const MIRROR_TOLERANCE_MS = 3_000

export type FProxyClientErrorCode =
    | 'aborted'
    | 'invalid_api_key'
    | 'provider_http_error'
    | 'provider_rejected'
    | 'provider_response_invalid'
    | 'request_timeout'
    | 'network_error'

export interface FProxyProxySnapshot {
    host: string
    port: number
    username: string
    password: string
    type: 'http'
}

export interface FProxyEndpoint {
    proxySnapshot: FProxyProxySnapshot
    observedIp: string | null
    endpointExpiresAt: number
    rotateAllowedAt: number
    location: string
    receivedAt: number
    /** True when provider indicated the key is still in rotation cooldown (e.g. "Vui lòng chờ X giây"). */
    coolingDown?: boolean
}

export interface FProxyRequestOptions {
    signal?: AbortSignal
    timeoutMs?: number
}

export interface FProxyDeadlineResolution {
    endpointExpiresAt: number
    rotateAllowedAt: number
    /** True when waiting_time looked like IP life and was discarded as rotate timer. */
    rotateMirroredIpLife: boolean
    waitingRawMs: number | null
    timeDieRawMs: number | null
}

type ProviderPayload = {
    success?: unknown
    message?: unknown
    error?: unknown
    waiting_time?: unknown
    data?: unknown
}

type ProviderData = {
    httpuserpass: string
    observedIp: string
    location: string
    timeDie: string
    waitingTime: string
    coolingDown: boolean
}

export class FProxyApiError extends Error {
    constructor(
        public readonly code: FProxyClientErrorCode,
        public readonly retryable: boolean,
        public readonly retryAfterMs: number | null = null,
    ) {
        super(code)
        this.name = 'FProxyApiError'
    }
}

export class FProxyApiClient {
    async getNew(apiKey: string, options: FProxyRequestOptions = {}): Promise<FProxyEndpoint> {
        return this.requestEndpoint('getnew', apiKey, options)
    }

    async getCurrent(apiKey: string, options: FProxyRequestOptions = {}): Promise<FProxyEndpoint> {
        return this.requestEndpoint('getcurrent', apiKey, options)
    }

    private async requestEndpoint(
        action: 'getnew' | 'getcurrent',
        rawApiKey: string,
        options: FProxyRequestOptions,
    ): Promise<FProxyEndpoint> {
        const apiKey = normalizeFProxyApiKey(rawApiKey)
        if (!apiKey) throw new FProxyApiError('invalid_api_key', false)

        const payload = await requestJson(action, apiKey, options)
        const data = parseProviderPayload(payload)
        return buildEndpoint(data, action)
    }
}

export function normalizeFProxyApiKey(raw: string): string {
    const value = raw.trim()
    if (!value) return ''
    if (!/^https?:\/\//i.test(value)) {
        return value.replace(/^api_key=/i, '').replace(/^key=/i, '').trim()
    }
    try {
        const parsed = new URL(value)
        return (
            parsed.searchParams.get('api_key')
            || parsed.searchParams.get('key')
            || ''
        ).trim()
    } catch {
        return ''
    }
}

/**
 * Split FProxy dual timers correctly:
 * - time_die => IP/endpoint lifetime (often ~30 min)
 * - waiting_time => next rotate countdown (~2 min on getnew)
 * getcurrent frequently copies waiting_time = time_die; that must NOT drive "Xoay IP".
 */
export function resolveFProxyDeadlines(
    timeDieRaw: string,
    waitingTimeRaw: string,
    receivedAt: number = Date.now(),
    action: 'getnew' | 'getcurrent' | 'unknown' = 'unknown',
): FProxyDeadlineResolution {
    const timeDieRawMs = parseDurationMs(timeDieRaw)
    const waitingRawMs = parseDurationMs(waitingTimeRaw)

    const endpointExpiresAt = timeDieRawMs !== null && timeDieRawMs > 0
        ? receivedAt + timeDieRawMs
        : parseDeadline(timeDieRaw, receivedAt, DEFAULT_IP_LIFETIME_MS)

    if (waitingRawMs === 0) {
        return {
            endpointExpiresAt,
            rotateAllowedAt: receivedAt,
            rotateMirroredIpLife: false,
            waitingRawMs: 0,
            timeDieRawMs,
        }
    }

    if (waitingRawMs !== null && waitingRawMs > 0) {
        const dieMs = Math.max(0, endpointExpiresAt - receivedAt)
        const mirrorsIpLife = (
            dieMs > 0
            && Math.abs(waitingRawMs - dieMs) <= MIRROR_TOLERANCE_MS
        ) || (
            waitingRawMs > MAX_TRUSTED_ROTATE_WINDOW_MS
            && dieMs > 0
            && waitingRawMs >= dieMs * 0.85
        )

        // getcurrent quirk: waiting_time is really remaining IP life, not rotate.
        // getnew with a true long wait is rare; still reject mirrored values.
        if (mirrorsIpLife || (action === 'getcurrent' && waitingRawMs > MAX_TRUSTED_ROTATE_WINDOW_MS)) {
            return {
                endpointExpiresAt,
                rotateAllowedAt: receivedAt,
                rotateMirroredIpLife: true,
                waitingRawMs,
                timeDieRawMs,
            }
        }

        // Trust real rotate countdown (typically <= 180s, hard-cap 5 min).
        const trustedMs = Math.min(waitingRawMs, MAX_TRUSTED_ROTATE_WINDOW_MS)
        return {
            endpointExpiresAt,
            rotateAllowedAt: receivedAt + trustedMs,
            rotateMirroredIpLife: false,
            waitingRawMs,
            timeDieRawMs,
        }
    }

    // Missing waiting_time: getnew default cycle; getcurrent => ready (no fake 30m rotate).
    return {
        endpointExpiresAt,
        rotateAllowedAt: action === 'getnew' ? receivedAt + DEFAULT_ROTATE_WINDOW_MS : receivedAt,
        rotateMirroredIpLife: false,
        waitingRawMs: null,
        timeDieRawMs,
    }
}

function requestJson(
    action: 'getnew' | 'getcurrent',
    apiKey: string,
    options: FProxyRequestOptions,
): Promise<unknown> {
    const timeoutMs = clampTimeout(options.timeoutMs)
    return new Promise((resolve, reject) => {
        const request = https.request({
            protocol: 'https:',
            hostname: FPROXY_HOST,
            port: 443,
            method: 'GET',
            path: `/api/${action}?api_key=${encodeURIComponent(apiKey)}`,
            headers: { Accept: 'application/json' },
            signal: options.signal,
        }, response => collectResponse(response, resolve, reject))

        request.setTimeout(timeoutMs, () => {
            request.destroy(new FProxyApiError('request_timeout', true))
        })
        request.on('error', error => reject(mapRequestError(error, options.signal)))
        request.end()
    })
}

function collectResponse(
    response: IncomingMessage,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
): void {
    const chunks: Buffer[] = []
    let received = 0
    response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        received += buffer.length
        if (received > MAX_RESPONSE_BYTES) {
            response.destroy()
            reject(new FProxyApiError('provider_response_invalid', false))
            return
        }
        chunks.push(buffer)
    })
    response.on('end', () => parseResponse(response.statusCode, chunks, resolve, reject))
    response.on('error', () => reject(new FProxyApiError('network_error', true)))
}

function parseResponse(
    statusCode: number | undefined,
    chunks: Buffer[],
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
): void {
    if (!statusCode || statusCode < 200 || statusCode >= 300) {
        reject(new FProxyApiError('provider_http_error', statusCode !== 401 && statusCode !== 403))
        return
    }
    try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    } catch {
        reject(new FProxyApiError('provider_response_invalid', false))
    }
}

function extractCooldownRetryAfterMs(
    topRecord: Record<string, unknown>,
    dataRecord: Record<string, unknown> | null,
    message: string,
): number | null {
    const waitingRaw = dataRecord
        ? readString(dataRecord, 'waiting_time') || readString(topRecord, 'waiting_time')
        : readString(topRecord, 'waiting_time')
    const waitingMs = parseDurationMs(waitingRaw)
    if (waitingMs !== null && waitingMs > 0) {
        return Math.min(waitingMs, MAX_TRUSTED_ROTATE_WINDOW_MS)
    }
    const secMatch = /(\d+)\s*(?:gi[aâ]y|s\b|sec)/i.exec(message)
    if (secMatch) {
        const parsedSec = Number.parseInt(secMatch[1], 10)
        if (Number.isFinite(parsedSec) && parsedSec > 0) {
            return Math.min(parsedSec * 1000, MAX_TRUSTED_ROTATE_WINDOW_MS)
        }
    }
    if (/waiting|vui\s*l.*ch|wait/i.test(message)) {
        return 5_000
    }
    return null
}

function parseProviderPayload(value: unknown): ProviderData {
    if (!isRecord(value)) throw new FProxyApiError('provider_response_invalid', false)
    const payload = value as ProviderPayload
    const message = readString(value, 'message') || readString(value, 'error')
    if (!isRecord(payload.data)) {
        const retryAfterMs = extractCooldownRetryAfterMs(value, null, message)
        throw new FProxyApiError('provider_rejected', true, retryAfterMs)
    }
    const data = payload.data
    const httpuserpass = readString(data, 'httpuserpass')
    if (!httpuserpass) {
        const retryAfterMs = extractCooldownRetryAfterMs(value, data, message)
        throw new FProxyApiError(
            payload.success === false || retryAfterMs !== null ? 'provider_rejected' : 'provider_response_invalid',
            payload.success === false || retryAfterMs !== null,
            retryAfterMs,
        )
    }
    const coolingDown = /waiting|vui\s*l.*ch|ch.*\d+\s*gi/i.test(message)
    return {
        httpuserpass,
        observedIp: normalizeObservedIp(readString(data, 'ip')),
        location: readString(data, 'location'),
        timeDie: readString(data, 'time_die'),
        waitingTime: readString(data, 'waiting_time'),
        coolingDown,
    }
}

function buildEndpoint(data: ProviderData, action: 'getnew' | 'getcurrent'): FProxyEndpoint {
    const proxySnapshot = parseProxyCredentials(data.httpuserpass)
    const receivedAt = Date.now()
    const deadlines = resolveFProxyDeadlines(data.timeDie, data.waitingTime, receivedAt, action)
    const observedIp = data.observedIp || normalizeObservedIp(proxySnapshot.host) || null
    return {
        proxySnapshot,
        observedIp,
        endpointExpiresAt: deadlines.endpointExpiresAt,
        rotateAllowedAt: deadlines.rotateAllowedAt,
        location: data.location,
        receivedAt,
        ...(data.coolingDown ? { coolingDown: true } : {}),
    }
}

function parseProxyCredentials(value: string): FProxyProxySnapshot {
    const match = value.match(/^([^:]+):(\d+):([^:]+):(.+)$/)
    const port = match ? Number.parseInt(match[2], 10) : 0
    if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new FProxyApiError('provider_response_invalid', false)
    }
    return {
        host: match[1].trim(),
        port,
        username: match[3],
        password: match[4],
        type: 'http',
    }
}

/** Parse provider duration/deadline into milliseconds remaining (not absolute). */
function parseDurationMs(raw: string): number | null {
    if (!raw) return null
    const numeric = Number(raw)
    if (!Number.isFinite(numeric)) return null
    if (numeric === 0) return 0
    if (numeric < 0) return null
    // Absolute epoch ms
    if (numeric >= 10_000_000_000) return Math.max(0, Math.floor(numeric) - Date.now())
    // Absolute epoch seconds
    if (numeric >= 1_000_000_000) return Math.max(0, Math.floor(numeric * 1000) - Date.now())
    // Remaining seconds
    return Math.floor(numeric * 1000)
}

function parseDeadline(raw: string, now: number, fallbackMs: number): number {
    const durationMs = parseDurationMs(raw)
    if (durationMs !== null) return now + durationMs
    const parsedDate = Date.parse(raw)
    return Number.isFinite(parsedDate) && parsedDate > now ? parsedDate : now + fallbackMs
}

function normalizeObservedIp(value: string): string {
    return isIP(value) ? value : ''
}

function readString(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampTimeout(value?: number): number {
    if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
    return Math.max(1_000, Math.min(45_000, Math.floor(value!)))
}

function mapRequestError(error: Error, signal?: AbortSignal): FProxyApiError {
    if (signal?.aborted || error.name === 'AbortError') {
        return new FProxyApiError('aborted', true)
    }
    if (error instanceof FProxyApiError) return error
    return new FProxyApiError('network_error', true)
}
