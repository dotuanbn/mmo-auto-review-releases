/**
 * Pure unit tests for Web SEO URL/keyword contracts.
 * Source: src/shared/web-seo-contracts.ts
 * No Electron / network / Playwright.
 */
import { describe, expect, it } from 'vitest'
import {
    buildWebSeoFallbackUrls,
    extractWebSeoDestination,
    isSameWebSeoSite,
    normalizeWebSeoTargetUrl,
    parseWebSeoKeywords,
    resolveWebSeoTarget,
} from '../src/shared/web-seo-contracts'

// ---------------------------------------------------------------------------
// normalizeWebSeoTargetUrl
// ---------------------------------------------------------------------------

describe('normalizeWebSeoTargetUrl', () => {
    it('accepts public http(s) domains and normalizes', () => {
        const a = normalizeWebSeoTargetUrl('https://example.com/path')
        const b = normalizeWebSeoTargetUrl('http://www.example.com/')
        const c = normalizeWebSeoTargetUrl('example.com')

        expect(a).toBeTruthy()
        expect(String(a)).toMatch(/^https?:\/\//i)
        expect(String(a).toLowerCase()).toContain('example.com')

        expect(b).toBeTruthy()
        expect(String(b).toLowerCase()).toContain('example.com')

        expect(c).toBeTruthy()
        expect(String(c).toLowerCase()).toContain('example.com')
    })

    it('rejects javascript / file / data schemes', () => {
        for (const raw of [
            'javascript:alert(1)',
            'file:///C:/secrets.txt',
            'data:text/html,hi',
            'JAVASCRIPT:void(0)',
            'FILE:///etc/passwd',
        ]) {
            expect(normalizeWebSeoTargetUrl(raw), raw).toBeNull()
        }
    })

    it('rejects URLs with credentials', () => {
        for (const raw of [
            'https://user:pass@example.com',
            'https://admin@example.com/path',
            'http://u:p@www.example.com',
        ]) {
            expect(normalizeWebSeoTargetUrl(raw), raw).toBeNull()
        }
    })

    it('rejects localhost, loopback, private ranges, link-local, and .local', () => {
        for (const raw of [
            'http://localhost',
            'https://localhost:8080/x',
            'http://127.0.0.1',
            'https://127.0.0.1:3000',
            'http://10.0.0.5',
            'http://10.255.1.2/path',
            'http://172.16.0.1',
            'http://172.31.255.255',
            'http://192.168.1.1',
            'http://192.168.0.10/admin',
            'http://169.254.1.1',
            'http://printer.local',
            'https://nas.home.local/share',
        ]) {
            expect(normalizeWebSeoTargetUrl(raw), raw).toBeNull()
        }
    })

    it('rejects mapped IPv6, rebinding hosts, metadata, and unsafe transactional paths', () => {
        for (const raw of [
            'http://[::ffff:7f00:1]/',
            'http://[::ffff:127.0.0.1]/',
            'https://127.0.0.1.nip.io',
            'https://localtest.me',
            'https://metadata.google.internal',
            'https://example.com/cart',
            'https://example.com/checkout',
            'https://example.com/account/login',
            'https://example.com/product?id=1&add-to-cart=5',
        ]) {
            expect(normalizeWebSeoTargetUrl(raw), raw).toBeNull()
        }
    })
})

// ---------------------------------------------------------------------------
// resolveWebSeoTarget
// ---------------------------------------------------------------------------

describe('resolveWebSeoTarget', () => {
    it('resolves a public domain to a structured ok result', () => {
        const result = resolveWebSeoTarget('https://Example.com/Shop')
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.host.toLowerCase()).toContain('example.com')
            expect(result.url).toMatch(/^https?:\/\//i)
            expect(result.url.toLowerCase()).toContain('example.com')
        }
    })

    it('rejects unsafe schemes and private hosts via ok=false', () => {
        for (const raw of [
            'javascript:alert(1)',
            'file:///tmp/x',
            'data:text/plain,x',
            'https://user:pass@example.com',
            'http://localhost',
            'http://127.0.0.1',
            'http://10.1.2.3',
            'http://172.16.4.5',
            'http://192.168.10.20',
            'http://169.254.10.10',
            'http://device.local',
        ]) {
            const result = resolveWebSeoTarget(raw)
            expect(result.ok, raw).toBe(false)
        }
    })
})

// ---------------------------------------------------------------------------
// isSameWebSeoSite — exact / subdomain; reject suffix tricks
// ---------------------------------------------------------------------------

describe('isSameWebSeoSite', () => {
    it('matches exact host and subdomains of the target', () => {
        expect(isSameWebSeoSite('example.com', 'example.com')).toBe(true)
        expect(isSameWebSeoSite('www.example.com', 'example.com')).toBe(true)
        expect(isSameWebSeoSite('blog.example.com', 'example.com')).toBe(true)
        expect(isSameWebSeoSite('a.b.example.com', 'example.com')).toBe(true)
        expect(isSameWebSeoSite('https://shop.example.com/path', 'example.com')).toBe(true)
        expect(isSameWebSeoSite('EXAMPLE.COM', 'example.com')).toBe(true)
    })

    it('rejects evil-example.com and example.com.evil suffix tricks', () => {
        expect(isSameWebSeoSite('evil-example.com', 'example.com')).toBe(false)
        expect(isSameWebSeoSite('example.com.evil', 'example.com')).toBe(false)
        expect(isSameWebSeoSite('example.com.evil.com', 'example.com')).toBe(false)
        expect(isSameWebSeoSite('notexample.com', 'example.com')).toBe(false)
        expect(isSameWebSeoSite('example.com.attacker.net', 'example.com')).toBe(false)
        expect(isSameWebSeoSite('https://evil-example.com', 'https://example.com')).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// extractWebSeoDestination — Google redirect unwrap + relative
// ---------------------------------------------------------------------------

describe('extractWebSeoDestination', () => {
    it('unwraps Google redirect /url?q= destinations', () => {
        const googleRedirect =
            'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Flanding%3Fid%3D1&sa=U&ved=2ah'
        const dest = extractWebSeoDestination(googleRedirect)
        expect(dest).toBeTruthy()
        expect(String(dest).toLowerCase()).toContain('example.com/landing')
        expect(String(dest)).not.toContain('google.com/url')
    })

    it('unwraps Google redirect with nested url= param variants', () => {
        const variants = [
            'https://www.google.com/url?url=https%3A%2F%2Fshop.example.com%2Fp&sa=t',
            'https://google.com/url?q=http://example.com/a&usg=AFQ',
        ]
        for (const href of variants) {
            const dest = extractWebSeoDestination(href)
            expect(dest, href).toBeTruthy()
            expect(String(dest).toLowerCase(), href).toMatch(/example\.com/)
        }
    })

    it('resolves relative URLs against base', () => {
        const dest = extractWebSeoDestination('/about/team', 'https://example.com')
        expect(dest).toBeTruthy()
        expect(String(dest)).toMatch(/^https:\/\/example\.com\/about\/team/i)

        const dest2 = extractWebSeoDestination('products', 'https://example.com/shop/')
        expect(dest2).toBeTruthy()
        expect(String(dest2).toLowerCase()).toContain('example.com')
        expect(String(dest2).toLowerCase()).toMatch(/products/)
    })

    it('returns null for unsafe extracted destinations', () => {
        expect(extractWebSeoDestination('javascript:alert(1)')).toBeNull()
        expect(extractWebSeoDestination('file:///etc/passwd')).toBeNull()
        expect(extractWebSeoDestination('data:text/html,x')).toBeNull()
        expect(
            extractWebSeoDestination('https://www.google.com/url?q=javascript%3Aalert(1)'),
        ).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// buildWebSeoFallbackUrls
// ---------------------------------------------------------------------------

describe('buildWebSeoFallbackUrls', () => {
    it('returns non-empty fallback list including apex and www variants', () => {
        const urls = buildWebSeoFallbackUrls('https://example.com/path')
        expect(Array.isArray(urls)).toBe(true)
        expect(urls.length).toBeGreaterThanOrEqual(1)

        const joined = urls.map((u) => u.toLowerCase()).join(' ')
        expect(joined).toContain('example.com')

        // Prefer both apex and www when starting from either form
        const hasApex = urls.some((u) => /:\/\/example\.com(\/|$)/i.test(u))
        const hasWww = urls.some((u) => /:\/\/www\.example\.com(\/|$)/i.test(u))
        expect(hasApex || hasWww).toBe(true)
        // At least one of the pair should appear; full pair is preferred
        if (urls.length >= 2) {
            expect(hasApex && hasWww).toBe(true)
        }
    })

    it('does not invent private/local fallbacks for public hosts', () => {
        const urls = buildWebSeoFallbackUrls('https://example.com')
        for (const u of urls) {
            expect(u.toLowerCase()).not.toMatch(/localhost|127\.0\.0\.1|192\.168\.|\.local/)
        }
    })
})

// ---------------------------------------------------------------------------
// parseWebSeoKeywords — trim / dedupe / limit
// ---------------------------------------------------------------------------

describe('parseWebSeoKeywords', () => {
    it('trims whitespace from keywords', () => {
        const result = parseWebSeoKeywords(['  cafe ha noi  ', '\tcoffee\n', '  '])
        expect(result).toEqual(expect.arrayContaining(['cafe ha noi', 'coffee']))
        expect(result.every((k) => k === k.trim())).toBe(true)
        expect(result.some((k) => k === '')).toBe(false)
    })

    it('accepts comma/newline-delimited string input', () => {
        const result = parseWebSeoKeywords('cafe ha noi, coffee\ntra da')
        expect(result.map((k) => k.toLowerCase())).toEqual(
            expect.arrayContaining(['cafe ha noi', 'coffee', 'tra da']),
        )
    })

    it('dedupes keywords (case-insensitive)', () => {
        const result = parseWebSeoKeywords(['Cafe', 'cafe', 'CAFE', 'coffee', 'Coffee'])
        const lower = result.map((k) => k.toLowerCase())
        expect(new Set(lower).size).toBe(lower.length)
        expect(lower).toContain('cafe')
        expect(lower).toContain('coffee')
        expect(lower.filter((k) => k === 'cafe').length).toBe(1)
    })

    it('limits keyword count to a hard max', () => {
        const many = Array.from({ length: 100 }, (_, i) => `keyword-${i}`)
        const result = parseWebSeoKeywords(many)
        expect(result.length).toBeLessThanOrEqual(50)
        expect(result.length).toBeGreaterThan(0)
    })
})
