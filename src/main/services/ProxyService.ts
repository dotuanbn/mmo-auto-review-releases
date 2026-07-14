import { eq, sql } from 'drizzle-orm'
import * as http from 'http'
import * as net from 'net'
import { getDatabase, schema } from '../database'
import type { Proxy, NewProxy } from '../database/schema'
import type { ProxyBridgeMode } from './ProxyBridgeService'
import { secretVault, SecretStorageUnavailableError } from './SecretVault'
import type {
    PublicProxy,
    ProxyRuntimeReasonCode,
} from '../../shared/proxy-contracts'

type ProxyHealthCheckResult = {
    alive: boolean
    reason: string
    reasonCode: string
    observedIp: string | null
}

/** HTTP quick check result (native http/net — not Playwright). */
export interface ProxyHttpQuickCheckResult {
    alive: boolean
    responseTime: number
    latencyMs: number
    reason?: string
    reasonCode: string
    observedIp: string | null
    bridgeMode: 'none'
    mode: 'http_quick'
}

/** Runtime-parity preflight result (ProxyBridge + Playwright ephemeral path). */
export interface ProxyRuntimeCheckResult {
    ok: boolean
    alive: boolean
    responseTime: number
    latencyMs: number
    reasonCode: ProxyRuntimeReasonCode
    observedIp: string | null
    bridgeMode: ProxyBridgeMode | 'none'
    mode: 'runtime_parity'
    message?: string
    probeUrl?: string
}

export class ProxyService {
    /** Known paid / specialized proxy providers (for UI labels + future adapter logic) */
    static readonly KNOWN_PROVIDERS = [
        'manual',
        'dataimpulse',
        'fproxy',
        'smartproxy',
        'oxylabs',
        'iproyal',
        'lunaproxy',
        'custom',
    ] as const

    toPublicProxy(proxy: Proxy): PublicProxy {
        return {
            id: proxy.id,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            type: proxy.type,
            country: proxy.country,
            provider: proxy.provider,
            status: proxy.status,
            lastCheck: proxy.lastCheck,
            responseTime: proxy.responseTime,
            createdAt: proxy.createdAt,
            hasPassword: Boolean(proxy.password?.trim()),
        }
    }

    private hydrateProxy(proxy: Proxy): Proxy {
        const stored = proxy.password
        if (!stored) return proxy

        const migration = secretVault.migrateIfNeeded(stored)
        if (migration.migrated) {
            try {
                const db = getDatabase()
                db.update(schema.proxies)
                    .set({ password: migration.value })
                    .where(eq(schema.proxies.id, proxy.id))
                    .run()
            } catch (error) {
                console.warn(`[ProxyService] Failed to migrate proxy secret id=${proxy.id}`, error)
            }
        }

        return { ...proxy, password: secretVault.decrypt(stored) }
    }

    private parseKnownProxyType(value?: string): Proxy['type'] | null {
        const normalized = (value || '').toLowerCase().trim()
        if (normalized === 'http' || normalized === 'https' || normalized === 'socks5') {
            return normalized
        }
        return null
    }

    private normalizeProxyType(value?: string): Proxy['type'] {
        return this.parseKnownProxyType(value) || 'http'
    }

    /** Suggest a provider based on host or username patterns (DataImpulse, etc.) */
    suggestProvider(host: string, username?: string): string | undefined {
        const h = (host || '').toLowerCase()
        const u = (username || '').toLowerCase()

        if (h.includes('dataimpulse')) return 'dataimpulse'
        if (h.includes('fproxy') || h.includes('sv1.fproxy')) return 'fproxy'
        if (h.includes('smartproxy')) return 'smartproxy'
        if (h.includes('oxylabs')) return 'oxylabs'
        if (h.includes('iproyal') || h.includes('iproyal.com')) return 'iproyal'
        if (h.includes('lunaproxy')) return 'lunaproxy'

        // Sticky session pattern very common with DataImpulse and similar providers
        if (u.includes('session-') || u.includes('-session')) return 'dataimpulse'

        return undefined
    }

    private isKnownProvider(value?: string): boolean {
        if (!value) return false
        return (ProxyService.KNOWN_PROVIDERS as readonly string[]).includes(value.toLowerCase().trim())
    }

    private parseProxyImportLine(line: string, defaultProvider?: string): NewProxy | null {
        const trimmed = line.trim()
        if (!trimmed) return null

        // URL format: http://user:pass@host:port or socks5://host:port
        if (trimmed.includes('://')) {
            try {
                const parsed = new URL(trimmed)
                const type = this.normalizeProxyType(parsed.protocol.replace(':', ''))
                const defaultPort = type === 'https' ? 443 : type === 'socks5' ? 1080 : 80
                const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort
                if (!parsed.hostname || !Number.isFinite(port) || port <= 0) {
                    return null
                }

                const provider = this.suggestProvider(parsed.hostname, parsed.username) ||
                    (this.isKnownProvider(defaultProvider) ? defaultProvider : undefined)

                return {
                    host: parsed.hostname,
                    port,
                    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
                    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
                    type,
                    provider,
                    status: 'active',
                    createdAt: new Date(),
                }
            } catch {
                return null
            }
        }

        // Plain format:
        // - host:port
        // - host:port:user:pass
        // - host:port:user:pass:type
        // - host:port:user:pass:provider   (new for DataImpulse etc.)
        // - host:port:user:pass:type:provider
        const parts = trimmed.split(':').map(part => part.trim())
        if (parts.length < 2) return null

        const host = parts[0]
        const port = Number.parseInt(parts[1], 10)
        if (!host || !Number.isFinite(port) || port <= 0) return null

        let username: string | undefined
        let password: string | undefined
        let type: Proxy['type'] = 'http'
        let provider: string | undefined

        // Detect trailing provider (last token)
        const last = parts[parts.length - 1]
        if (this.isKnownProvider(last)) {
            provider = last
        }

        if (parts.length === 3) {
            const explicitType = this.parseKnownProxyType(parts[2])
            if (explicitType) {
                type = explicitType
            } else if (!provider) {
                username = parts[2] || undefined
            }
        }

        if (parts.length >= 4) {
            const tailType = this.parseKnownProxyType(parts[parts.length - 1])
            const tailProvider = this.isKnownProvider(parts[parts.length - 1])

            // Determine where auth ends
            let authEndIndex = parts.length - 1
            if (tailType || tailProvider) authEndIndex--

            const authParts = parts.slice(2, authEndIndex + 1)

            if (tailType) type = tailType

            username = authParts[0] || undefined
            if (authParts.length > 1) {
                password = authParts.slice(1).join(':') || undefined
            }
        }

        // Fallback auto-detect provider (DataImpulse sticky sessions, known hosts, etc.)
        if (!provider) {
            provider = this.suggestProvider(host, username)
        }

        // If user passed a defaultProvider and we still have nothing, use it
        if (!provider && this.isKnownProvider(defaultProvider)) {
            provider = defaultProvider
        }

        return {
            host,
            port,
            username,
            password,
            type,
            provider,
            status: 'active',
            createdAt: new Date(),
        }
    }

    // Get all proxies
    async getAll(): Promise<Proxy[]> {
        const db = getDatabase()
        return db.select().from(schema.proxies).all().map(proxy => this.hydrateProxy(proxy))
    }

    async getAllPublic(): Promise<PublicProxy[]> {
        const proxies = await this.getAll()
        return proxies.map(proxy => this.toPublicProxy(proxy))
    }

    // Get active proxies
    async getActive(): Promise<Proxy[]> {
        const db = getDatabase()
        return db.select().from(schema.proxies)
            .where(eq(schema.proxies.status, 'active'))
            .all()
            .map(proxy => this.hydrateProxy(proxy))
    }

    async getActivePublic(): Promise<PublicProxy[]> {
        const proxies = await this.getActive()
        return proxies.map(proxy => this.toPublicProxy(proxy))
    }

    async getActiveCount(): Promise<number> {
        const db = getDatabase()
        const row = db.select({ count: sql<number>`count(*)` })
            .from(schema.proxies)
            .where(eq(schema.proxies.status, 'active'))
            .get()
        return Number(row?.count) || 0
    }

    // Get proxy by ID
    async getById(id: number): Promise<Proxy | undefined> {
        const db = getDatabase()
        const results = db.select().from(schema.proxies).where(eq(schema.proxies.id, id)).all()
        return results[0] ? this.hydrateProxy(results[0]) : undefined
    }

    // Create new proxy
    async create(data: NewProxy): Promise<Proxy> {
        const db = getDatabase()
        const result = db.insert(schema.proxies).values({
            ...data,
            password: data.password ? secretVault.seal(data.password) : null,
            createdAt: new Date(),
        }).returning().get()
        return this.hydrateProxy(result)
    }

    // Update proxy
    async update(id: number, data: Partial<Proxy>): Promise<Proxy | undefined> {
        const db = getDatabase()
        const update: Partial<Proxy> = { ...data }
        if (typeof update.password === 'string') {
            if (update.password.trim()) update.password = secretVault.seal(update.password)
            else delete update.password
        }
        const result = db.update(schema.proxies)
            .set(update)
            .where(eq(schema.proxies.id, id))
            .returning()
            .get()
        return result ? this.hydrateProxy(result) : undefined
    }

    // Delete proxy
    async delete(id: number): Promise<void> {
        const db = getDatabase()
        db.delete(schema.proxies).where(eq(schema.proxies.id, id)).run()
    }

    // Update proxy status
    async updateStatus(id: number, status: Proxy['status']): Promise<void> {
        const db = getDatabase()
        db.update(schema.proxies)
            .set({ status, lastCheck: new Date() })
            .where(eq(schema.proxies.id, id))
            .run()
    }

    // Check proxy health — lightweight test using native Node.js http/net (HTTP quick check)
    async checkProxy(id: number): Promise<ProxyHttpQuickCheckResult> {
        const proxy = await this.getById(id)
        if (!proxy) {
            return {
                alive: false,
                responseTime: 0,
                latencyMs: 0,
                reason: 'proxy_not_found',
                reasonCode: 'proxy_not_found',
                observedIp: null,
                bridgeMode: 'none',
                mode: 'http_quick',
            }
        }

        const startTime = Date.now()
        const hasAuth = !!(proxy.username && proxy.password)

        try {
            await this.updateStatus(id, 'checking')
            // Never log credentials — only host/port/type/auth presence
            console.log(
                `[ProxyCheck] HTTP quick test ${proxy.host}:${proxy.port} type=${proxy.type || 'http'} auth=${hasAuth ? 'yes' : 'no'}`
            )

            const health = await this.testProxyConnection(proxy)
            const alive = health.alive
            const responseTime = Date.now() - startTime

            // Look up country/location for the proxy IP (prefer observed egress when available)
            let country = proxy.country || null
            if (alive) {
                try {
                    const lookupTarget = health.observedIp || proxy.host
                    country = await this.lookupProxyCountry(lookupTarget)
                } catch (e) {
                    console.log(`[ProxyCheck] Country lookup failed: ${e instanceof Error ? e.message : String(e)}`)
                }
            }

            await this.update(id, {
                status: alive ? 'active' : 'dead',
                lastCheck: new Date(),
                responseTime,
                country: country || undefined,
            })

            console.log(
                `[ProxyCheck] ${proxy.host}:${proxy.port} → ${alive ? 'ALIVE' : 'DEAD'} (${responseTime}ms, ${country || 'unknown'}, reasonCode=${health.reasonCode})`
            )
            return {
                alive,
                responseTime,
                latencyMs: responseTime,
                reason: health.reason,
                reasonCode: health.reasonCode,
                observedIp: health.observedIp,
                bridgeMode: 'none',
                mode: 'http_quick',
            }
        } catch (error) {
            const responseTime = Date.now() - startTime
            const message = error instanceof Error ? error.message : 'proxy_check_failed'
            console.log(`[ProxyCheck] ${proxy.host}:${proxy.port} → DEAD (error: ${message})`)

            await this.update(id, {
                status: 'dead',
                lastCheck: new Date(),
                responseTime,
            })
            return {
                alive: false,
                responseTime,
                latencyMs: responseTime,
                reason: message,
                reasonCode: 'http_probe_error',
                observedIp: null,
                bridgeMode: 'none',
                mode: 'http_quick',
            }
        }
    }

    /**
     * Runtime-parity preflight: ProxyBridge + Playwright ephemeral context (same path as BrowserService traffic).
     * Updates lastCheck/status/responseTime. Bounded timeout; credentials never logged.
     */
    async checkProxyRuntime(id: number): Promise<ProxyRuntimeCheckResult> {
        const proxy = await this.getById(id)
        if (!proxy) {
            return {
                ok: false,
                alive: false,
                responseTime: 0,
                latencyMs: 0,
                reasonCode: 'proxy_not_found',
                observedIp: null,
                bridgeMode: 'none',
                mode: 'runtime_parity',
                message: 'Proxy not found',
            }
        }

        const hasAuth = !!(proxy.username && proxy.password)
        const startTime = Date.now()
        console.log(
            `[ProxyRuntime] Preflight ${proxy.host}:${proxy.port} type=${proxy.type || 'http'} auth=${hasAuth ? 'yes' : 'no'}`
        )

        try {
            await this.updateStatus(id, 'checking')
            const { browserService } = await import('../automation/BrowserService')
            const result = await browserService.testProxyRuntimeParity(
                {
                    host: proxy.host,
                    port: proxy.port,
                    username: proxy.username || undefined,
                    password: proxy.password || undefined,
                    type: proxy.type || 'http',
                },
                { timeoutMs: 20_000 }
            )

            // Persist health signals for table UI
            let country = proxy.country || null
            if (result.ok && result.observedIp) {
                try {
                    country = await this.lookupProxyCountry(result.observedIp)
                } catch {
                    // ignore country lookup failures
                }
            }

            await this.update(id, {
                status: result.ok ? 'active' : 'dead',
                lastCheck: new Date(),
                responseTime: result.latencyMs,
                country: country || undefined,
            })

            console.log(
                `[ProxyRuntime] ${proxy.host}:${proxy.port} → ${result.ok ? 'OK' : 'FAIL'} ` +
                    `reasonCode=${result.reasonCode} latencyMs=${result.latencyMs} ` +
                    `ip=${result.observedIp || '-'} bridgeMode=${result.bridgeMode}`
            )

            return {
                ok: result.ok,
                alive: result.ok,
                responseTime: result.latencyMs,
                latencyMs: result.latencyMs,
                reasonCode: result.reasonCode,
                observedIp: result.observedIp,
                bridgeMode: result.bridgeMode,
                mode: 'runtime_parity',
                message: runtimeReasonMessage(result.reasonCode),
                probeUrl: result.probeUrl,
            }
        } catch (error) {
            const responseTime = Date.now() - startTime
            const message = error instanceof Error ? error.message : 'runtime_preflight_failed'
            console.log(`[ProxyRuntime] ${proxy.host}:${proxy.port} → FAIL (${message})`)

            await this.update(id, {
                status: 'dead',
                lastCheck: new Date(),
                responseTime,
            })

            return {
                ok: false,
                alive: false,
                responseTime,
                latencyMs: responseTime,
                reasonCode: 'unknown_error',
                observedIp: null,
                bridgeMode: 'none',
                mode: 'runtime_parity',
                message: message.slice(0, 120),
            }
        }
    }

    // Look up country for an IP using free ip-api.com
    private lookupProxyCountry(ip: string): Promise<string | null> {
        return new Promise((resolve) => {
            const req = http.get(`http://ip-api.com/json/${ip}?fields=status,country,city`, (res) => {
                let data = ''
                res.on('data', (chunk: Buffer) => { data += chunk.toString() })
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data)
                        if (json.status === 'success') {
                            const location = json.city ? `${json.city}, ${json.country}` : json.country
                            resolve(location)
                        } else {
                            resolve(null)
                        }
                    } catch {
                        resolve(null)
                    }
                })
            })
            req.on('error', () => resolve(null))
            req.setTimeout(5000, () => { req.destroy(); resolve(null) })
        })
    }

    // Test proxy by making an HTTP request through it
    private testProxyConnection(proxy: Proxy): Promise<ProxyHealthCheckResult> {
        return new Promise((resolve) => {
            const timeout = 20000 // Rotating proxies can be slower

            if (proxy.type === 'socks5') {
                // TCP reachability alone cannot prove SOCKS5 handshake/auth works.
                const socket = net.connect({ host: proxy.host, port: proxy.port, timeout }, () => {
                    socket.destroy()
                    resolve({
                        alive: false,
                        reason: 'socks5_tcp_reachable_runtime_check_required',
                        reasonCode: 'socks5_runtime_check_required',
                        observedIp: null,
                    })
                })
                socket.on('error', () => {
                    socket.destroy()
                    resolve({
                        alive: false,
                        reason: 'socks5_tcp_connect_failed',
                        reasonCode: 'socks5_tcp_connect_failed',
                        observedIp: null,
                    })
                })
                socket.on('timeout', () => {
                    socket.destroy()
                    resolve({
                        alive: false,
                        reason: 'socks5_tcp_timeout',
                        reasonCode: 'socks5_tcp_timeout',
                        observedIp: null,
                    })
                })
                return
            }

            // For HTTP/HTTPS proxies: send a real HTTP request through the proxy
            const authHeader = proxy.username && proxy.password
                ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') }
                : {}

            const req = http.request({
                host: proxy.host,
                port: proxy.port,
                method: 'GET',
                path: 'http://httpbin.org/ip',
                headers: {
                    ...authHeader,
                    'Host': 'httpbin.org',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                timeout,
            }, (res) => {
                // 200 = proxy worked perfectly
                // 204 = proxy responded (Google generate_204)
                // 301/302 = proxy redirected (still alive)
                // 407 = proxy auth failed, so this credential set is not usable.
                const statusCode = res.statusCode || 0
                const alive = statusCode >= 200 && statusCode < 400
                const reasonCode = statusCode === 407
                    ? 'proxy_auth_required'
                    : alive
                        ? `http_probe_status_${statusCode}`
                        : `http_probe_rejected_status_${statusCode}`
                console.log(`[ProxyCheck] HTTP response: ${statusCode} (${alive ? 'ALIVE' : 'DEAD'}, ${reasonCode})`)

                // Try to read body for IP info
                let data = ''
                res.on('data', (chunk: Buffer) => { data += chunk.toString() })
                res.on('end', () => {
                    let observedIp: string | null = null
                    if (data && statusCode === 200) {
                        try {
                            const json = JSON.parse(data) as { origin?: unknown; ip?: unknown }
                            if (typeof json.origin === 'string' && json.origin.trim()) {
                                observedIp = json.origin.split(',')[0].trim() || null
                                console.log(`[ProxyCheck] Proxy exit IP: ${observedIp}`)
                            } else if (typeof json.ip === 'string' && json.ip.trim()) {
                                observedIp = json.ip.trim()
                                console.log(`[ProxyCheck] Proxy exit IP: ${observedIp}`)
                            }
                        } catch { /* not JSON */ }
                    }
                    resolve({ alive, reason: reasonCode, reasonCode, observedIp })
                })
            })

            req.on('error', (err) => {
                console.log(`[ProxyCheck] HTTP error: ${err.message}`)
                // TCP reachability is diagnostic only; it must not mark HTTP forwarding usable.
                console.log(`[ProxyCheck] Trying TCP fallback...`)
                const socket = net.connect({ host: proxy.host, port: proxy.port, timeout: 10000 }, () => {
                    socket.destroy()
                    console.log('[ProxyCheck] TCP reachable, but HTTP forwarding is unverified')
                    resolve({
                        alive: false,
                        reason: `tcp_reachable_http_unverified:${err.message}`,
                        reasonCode: 'tcp_reachable_http_unverified',
                        observedIp: null,
                    })
                })
                socket.on('error', () => {
                    socket.destroy()
                    resolve({
                        alive: false,
                        reason: `http_probe_error:${err.message}`,
                        reasonCode: 'http_probe_error',
                        observedIp: null,
                    })
                })
                socket.on('timeout', () => {
                    socket.destroy()
                    resolve({
                        alive: false,
                        reason: `http_probe_error:${err.message}`,
                        reasonCode: 'http_probe_timeout',
                        observedIp: null,
                    })
                })
            })

            req.on('timeout', () => {
                console.log(`[ProxyCheck] HTTP timeout`)
                req.destroy()
                resolve({
                    alive: false,
                    reason: 'http_probe_timeout',
                    reasonCode: 'http_probe_timeout',
                    observedIp: null,
                })
            })

            req.end()
        })
    }

    // Check all proxies
    async checkAllProxies(): Promise<void> {
        const proxies = await this.getAll()
        for (const proxy of proxies) {
            await this.checkProxy(proxy.id)
        }
    }

    // Import from text.
    // Supported formats:
    // - host:port
    // - host:port:user:pass
    // - host:port:user:pass:type (type=http|https|socks5)
    // - host:port:user:pass:provider (provider = dataimpulse | smartproxy | fproxy | ...)
    // - type://host:port
    // - type://user:pass@host:port
    //
    // You can also pass a defaultProvider (used when the line does not contain explicit provider)
    async importFromText(text: string, defaultProvider?: string): Promise<number> {
        const db = getDatabase()
        const lines = text.split('\n').filter(l => l.trim())
        let imported = 0

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex]
            try {
                const proxy = this.parseProxyImportLine(line, defaultProvider)
                if (!proxy) {
                    console.log(`Failed to import proxy at line ${lineIndex + 1} (invalid format)`)
                    continue
                }
                db.insert(schema.proxies).values({
                    ...proxy,
                    password: proxy.password ? secretVault.seal(proxy.password) : null,
                }).run()
                imported++
            } catch (error) {
                if (error instanceof SecretStorageUnavailableError) throw error
                console.log(`Failed to import proxy at line ${lineIndex + 1}`)
            }
        }

        return imported
    }

    // Delete dead proxies
    async deleteDeadProxies(): Promise<number> {
        const db = getDatabase()
        const dead = await db.select().from(schema.proxies).where(eq(schema.proxies.status, 'dead')).all()

        for (const proxy of dead) {
            await this.delete(proxy.id)
        }

        return dead.length
    }

    // Get random active proxy
    async getRandomActive(): Promise<Proxy | undefined> {
        const active = await this.getActive()
        if (active.length === 0) return undefined
        return active[Math.floor(Math.random() * active.length)]
    }

    // Get statistics
    async getStats(): Promise<{
        total: number
        active: number
        dead: number
    }> {
        const all = await this.getAll()
        return {
            total: all.length,
            active: all.filter(p => p.status === 'active').length,
            dead: all.filter(p => p.status === 'dead').length,
        }
    }
}

function runtimeReasonMessage(code: ProxyRuntimeReasonCode): string {
    switch (code) {
        case 'ok':
            return 'Runtime proxy path OK'
        case 'proxy_not_found':
            return 'Proxy not found'
        case 'bridge_acquire_failed':
            return 'Proxy bridge acquire failed'
        case 'context_create_failed':
            return 'Browser context create failed'
        case 'navigation_timeout':
            return 'Navigation timed out through proxy'
        case 'proxy_connection_failed':
            return 'Proxy connection/tunnel failed'
        case 'proxy_auth_required':
            return 'Proxy authentication required or rejected'
        case 'ip_unobserved':
            return 'Reached probe but could not parse egress IP'
        case 'navigation_failed':
            return 'Navigation failed through proxy'
        case 'timeout':
            return 'Runtime preflight overall timeout'
        case 'unknown_error':
        default:
            return 'Runtime preflight failed'
    }
}

export const proxyService = new ProxyService()
