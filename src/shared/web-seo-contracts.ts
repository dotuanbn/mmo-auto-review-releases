/**
 * Shared Web SEO flow contracts — pure types + fail-closed URL helpers
 * (no Electron/Playwright). Never fail-open raw unsafe input.
 */

export type WebSeoCaptchaStrategy = 'auto_skip' | 'manual'

export type WebSeoDiscoverySource =
    | 'organic'
    | 'direct_fallback'
    | 'captcha_cooldown'
    | 'unreachable'

export type WebSeoSiteType = 'ecommerce' | 'article' | 'local' | 'generic'

/** Strict error codes for target resolution / flow failures. */
export type WebSeoErrorCode =
    | 'empty'
    | 'invalid'
    | 'protocol'
    | 'credentials'
    | 'localhost'
    | 'private'
    | 'metadata'
    | 'unreachable'
    | 'captcha'
    | 'timeout'
    | 'cancelled'
    | 'host_mismatch'
    | 'unsafe_path'
    | 'organic_required'
    | 'unknown'

export interface WebSeoActionRecord {
    action: string
    success: boolean
    /** Optional wall-clock ms spent on this action. */
    durationMs?: number
    /** Optional human-readable detail for debugging. */
    detail?: string
}

export type WebSeoTargetResult =
    | { ok: true; url: string; host: string }
    | { ok: false; error: WebSeoErrorCode }

export interface WebSeoFlowConfig {
    keyword: string
    targetDomain: string
    minTimeOnPageSeconds: number
    maxTimeOnPageSeconds: number
    captchaStrategy?: WebSeoCaptchaStrategy
    /** Absolute timestamp (ms). Deadline always wins over dwell config. */
    deadlineAt?: number
    /** Cooperative cancel poll. */
    shouldStop?: () => boolean
    /** When true, direct fallback is not used after organic failure. */
    requireOrganic?: boolean
}

export interface WebSeoFlowResult {
    success: boolean
    foundWebsite: boolean
    organicHit: boolean
    discoverySource: WebSeoDiscoverySource
    hostVerified: boolean
    finalUrl: string
    siteType: WebSeoSiteType
    actionsPerformed: WebSeoActionRecord[]
    durationSeconds: number
    qualityScore: number
    countable: boolean
    message: string
    errorCode?: WebSeoErrorCode
}

export const WEB_SEO_KEYWORD_MAX_LEN = 200
export const WEB_SEO_KEYWORD_MAX_COUNT = 50
const WEB_SEO_URL_MAX_LEN = 2048

const METADATA_HOSTS = new Set([
    'metadata.google.internal',
    'metadata.goog',
    'metadata',
    'instance-data',
])

function isIpv4Octet(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 255
}

/**
 * Classify hostname as restricted. Returns error code or null when public-safe.
 */
function classifyRestrictedHost(hostname: string): WebSeoErrorCode | null {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

    if (!host) return 'invalid'

    if (
        host === 'localhost'
        || host === '0.0.0.0'
        || host === '::'
        || host === '::1'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
    ) {
        return 'localhost'
    }

    if (METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal')) {
        return 'metadata'
    }

    // Common wildcard DNS services can resolve public-looking hosts to loopback/private IPs.
    if (
        host === 'localtest.me'
        || host.endsWith('.localtest.me')
        || host === 'lvh.me'
        || host.endsWith('.lvh.me')
        || host.endsWith('.nip.io')
        || host.endsWith('.sslip.io')
        || host.endsWith('.xip.io')
    ) {
        return 'private'
    }

    // IPv4 literal
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    if (ipv4) {
        const a = Number(ipv4[1])
        const b = Number(ipv4[2])
        const c = Number(ipv4[3])
        const d = Number(ipv4[4])
        if (![a, b, c, d].every(isIpv4Octet)) return 'invalid'
        // Loopback 127/8
        if (a === 127) return 'localhost'
        // "This" network / unspecified
        if (a === 0) return 'private'
        // RFC1918
        if (a === 10) return 'private'
        if (a === 172 && b >= 16 && b <= 31) return 'private'
        if (a === 192 && b === 168) return 'private'
        // Link-local 169.254/16 (includes cloud metadata 169.254.169.254)
        if (a === 169 && b === 254) return 'private'
        // CGNAT 100.64/10
        if (a === 100 && b >= 64 && b <= 127) return 'private'
        return null
    }

    // IPv6 literal (simplified classification)
    if (host.includes(':')) {
        if (host === '::1') return 'localhost'

        // IPv4-mapped IPv6 may be normalized to hex groups, e.g. ::ffff:7f00:1.
        const mappedTail = /^::ffff:(.+)$/i.exec(host)?.[1]
        if (mappedTail) {
            const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mappedTail)
            if (dotted) {
                return classifyRestrictedHost(`${dotted[1]}.${dotted[2]}.${dotted[3]}.${dotted[4]}`)
            }

            const groups = mappedTail.split(':')
            if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
                const high = parseInt(groups[0], 16)
                const low = parseInt(groups[1], 16)
                const mappedIpv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
                return classifyRestrictedHost(mappedIpv4)
            }
            return 'private'
        }

        // Link-local fe80::/10
        if (host.startsWith('fe80:') || host.startsWith('fe8') || host.startsWith('fe9')
            || host.startsWith('fea') || host.startsWith('feb')) {
            return 'private'
        }
        // ULA fc00::/7
        if (host.startsWith('fc') || host.startsWith('fd')) {
            return 'private'
        }
    }

    return null
}

function hasUnsafeBrowsePath(url: URL): boolean {
    const unsafeSegment = /^(cart|checkout|payment|billing|place-order|order|login|signin|signup|register|account|wishlist|add-to-cart|buy-now)$/i
    const segments = url.pathname
        .split('/')
        .map((segment) => {
            try {
                return decodeURIComponent(segment).trim()
            } catch {
                return segment.trim()
            }
        })
        .filter(Boolean)

    if (segments.some((segment) => unsafeSegment.test(segment))) return true

    const query = url.search.toLowerCase()
    return /(add-to-cart|buy-now|checkout|payment|place-order|\/login|\/signin|\/signup)/i.test(query)
}

function stripWww(host: string): string {
    return host.replace(/^www\./i, '').toLowerCase()
}

/**
 * Parse + validate a public absolute http(s) URL.
 * Defaults to https when scheme is missing. Never returns unsafe raw input.
 */
function parsePublicHttpUrl(input: string): WebSeoTargetResult {
    if (typeof input !== 'string') return { ok: false, error: 'invalid' }

    const trimmed = input.trim()
    if (!trimmed) return { ok: false, error: 'empty' }
    if (trimmed.length > WEB_SEO_URL_MAX_LEN || trimmed.includes('\0')) {
        return { ok: false, error: 'invalid' }
    }

    // Reject obvious non-http schemes before URL() coerces them oddly
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase()
        if (scheme !== 'http' && scheme !== 'https') {
            return { ok: false, error: 'protocol' }
        }
    }

    let candidate = trimmed
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
        candidate = `https://${candidate.replace(/^\/*/, '')}`
    }

    let parsed: URL
    try {
        parsed = new URL(candidate)
    } catch {
        return { ok: false, error: 'invalid' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'protocol' }
    }
    if (parsed.username !== '' || parsed.password !== '') {
        return { ok: false, error: 'credentials' }
    }
    if (!parsed.hostname) return { ok: false, error: 'invalid' }

    const restricted = classifyRestrictedHost(parsed.hostname)
    if (restricted) return { ok: false, error: restricted }
    if (hasUnsafeBrowsePath(parsed)) return { ok: false, error: 'unsafe_path' }

    // Drop hash; keep path/query. Never echo credentials (already rejected).
    parsed.hash = ''
    parsed.username = ''
    parsed.password = ''

    return {
        ok: true,
        url: parsed.href,
        host: stripWww(parsed.hostname),
    }
}

/**
 * Return ABSOLUTE normalized public http/https URL, or null when unsafe.
 * Default scheme is https when missing. Fail-closed — never returns raw input.
 */
export function normalizeWebSeoTargetUrl(input: string): string | null {
    const result = parsePublicHttpUrl(input)
    return result.ok ? result.url : null
}

/** Resolve target to structured ok/error result (fail-closed). */
export function resolveWebSeoTarget(input: string): WebSeoTargetResult {
    return parsePublicHttpUrl(input)
}

/**
 * Parse free-text or list keywords: trim, case-insensitive dedupe,
 * each keyword <= 200 chars, max 50 keywords.
 */
export function parseWebSeoKeywords(input: string | string[] | null | undefined): string[] {
    const parts: string[] = []

    if (typeof input === 'string') {
        const trimmed = input.trim()
        if (!trimmed) return []
        if (trimmed.startsWith('[')) {
            try {
                const parsed: unknown = JSON.parse(trimmed)
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        if (typeof item === 'string') parts.push(item)
                    }
                } else {
                    parts.push(...trimmed.split(/[\n,]+/))
                }
            } catch {
                parts.push(...trimmed.split(/[\n,]+/))
            }
        } else {
            parts.push(...trimmed.split(/[\n,]+/))
        }
    } else if (Array.isArray(input)) {
        for (const item of input) {
            if (typeof item === 'string') parts.push(item)
        }
    } else {
        return []
    }

    const seen = new Set<string>()
    const keywords: string[] = []
    for (const part of parts) {
        const kw = part.trim().replace(/\s+/g, ' ')
        if (!kw) continue
        // Reject over-long keywords rather than silently truncating (fail-closed length)
        if (kw.length > WEB_SEO_KEYWORD_MAX_LEN) continue
        const key = kw.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        keywords.push(kw)
        if (keywords.length >= WEB_SEO_KEYWORD_MAX_COUNT) break
    }
    return keywords
}

/**
 * True when candidate is exact target host or a subdomain of target.
 * www is normalized. NEVER allows target.endsWith(candidate) (broadens trust).
 * Rejects suffix tricks like evil-example.com / example.com.evil.
 */
export function isSameWebSeoSite(candidate: string, target: string): boolean {
    if (!candidate || !target) return false

    const targetResolved = parsePublicHttpUrl(target)
    // Target may be bare host; still require it to resolve as public URL
    if (!targetResolved.ok) return false
    const targetHost = targetResolved.host
    if (!targetHost) return false

    const candidateResolved = parsePublicHttpUrl(candidate)
    if (!candidateResolved.ok) return false
    const candidateHost = candidateResolved.host
    if (!candidateHost) return false

    if (candidateHost === targetHost) return true
    // candidate is subdomain of target (blog.example.com under example.com)
    if (candidateHost.endsWith(`.${targetHost}`)) return true
    return false
}

function isGoogleRedirectHost(hostname: string): boolean {
    const host = hostname.toLowerCase()
    return (
        host === 'google.com'
        || host.endsWith('.google.com')
        || host === 'google.com.vn'
        || host.endsWith('.google.com.vn')
        || /^([a-z0-9-]+\.)*google\.[a-z.]+$/i.test(host)
    )
}

/**
 * Resolve relative href against base, unwrap Google q/url/u redirect params,
 * then validate as public http(s) URL. Unsafe destinations return null.
 */
export function extractWebSeoDestination(href: string, baseUrl?: string): string | null {
    if (!href || typeof href !== 'string') return null
    const raw = href.trim()
    if (!raw) return null

    // Hard reject dangerous schemes early (before relative resolution)
    if (/^(javascript|data|file|vbscript|blob):/i.test(raw)) return null

    let absolute: string
    try {
        if (baseUrl) {
            const baseOk = parsePublicHttpUrl(baseUrl)
            if (!baseOk.ok) return null
            absolute = new URL(raw, baseOk.url).href
        } else if (/^https?:\/\//i.test(raw)) {
            absolute = raw
        } else if (raw.startsWith('//')) {
            absolute = `https:${raw}`
        } else {
            // Relative without base cannot be resolved safely
            return null
        }
    } catch {
        return null
    }

    // Unwrap Google redirect wrappers
    try {
        const url = new URL(absolute)
        if (isGoogleRedirectHost(url.hostname) && (url.pathname === '/url' || url.pathname.startsWith('/url'))) {
            const dest = url.searchParams.get('q')
                || url.searchParams.get('url')
                || url.searchParams.get('u')
            if (!dest) return null
            let decoded = dest
            try {
                decoded = decodeURIComponent(dest)
            } catch {
                decoded = dest
            }
            if (/^(javascript|data|file|vbscript|blob):/i.test(decoded)) return null
            const nested = parsePublicHttpUrl(decoded)
            return nested.ok ? nested.url : null
        }
    } catch {
        return null
    }

    const validated = parsePublicHttpUrl(absolute)
    return validated.ok ? validated.url : null
}

/**
 * Ordered fallback URLs for direct navigation.
 * Only safe HTTPS (or original HTTPS) variants — never HTTP downgrade.
 * Preserves path/query; emits apex + www when host-based.
 */
export function buildWebSeoFallbackUrls(target: string): string[] {
    const resolved = parsePublicHttpUrl(target)
    if (!resolved.ok) return []

    let parsed: URL
    try {
        parsed = new URL(resolved.url)
    } catch {
        return []
    }

    // Never downgrade: if original was http, upgrade to https for fallbacks
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`
    const pathPart = path === '/' ? '' : path
    const apex = stripWww(parsed.hostname)
    if (!apex) return []

    // Re-validate apex is still public after strip
    if (classifyRestrictedHost(apex)) return []

    const variants = [
        `https://${apex}${pathPart || '/'}`,
        `https://www.${apex}${pathPart || '/'}`,
    ]

    // If caller already used www, still emit both; if original had different casing/path, include normalized original https
    const out: string[] = []
    const seen = new Set<string>()
    for (const u of variants) {
        const ok = parsePublicHttpUrl(u)
        if (!ok.ok) continue
        if (seen.has(ok.url)) continue
        seen.add(ok.url)
        out.push(ok.url)
    }
    return out
}

export function createEmptyWebSeoFlowResult(): WebSeoFlowResult {
    return {
        success: false,
        foundWebsite: false,
        organicHit: false,
        discoverySource: 'unreachable',
        hostVerified: false,
        finalUrl: '',
        siteType: 'generic',
        actionsPerformed: [],
        durationSeconds: 0,
        qualityScore: 0,
        countable: false,
        message: '',
    }
}
