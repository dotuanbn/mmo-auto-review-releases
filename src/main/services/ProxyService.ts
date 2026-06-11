import { eq, sql } from 'drizzle-orm'
import * as http from 'http'
import * as net from 'net'
import { getDatabase, schema } from '../database'
import type { Proxy, NewProxy } from '../database/schema'

type ProxyHealthCheckResult = {
    alive: boolean
    reason: string
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
        return db.select().from(schema.proxies).all()
    }

    // Get active proxies
    async getActive(): Promise<Proxy[]> {
        const db = getDatabase()
        return db.select().from(schema.proxies).where(eq(schema.proxies.status, 'active')).all()
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
        return results[0]
    }

    // Create new proxy
    async create(data: NewProxy): Promise<Proxy> {
        const db = getDatabase()
        const result = db.insert(schema.proxies).values({
            ...data,
            createdAt: new Date(),
        }).returning().get()
        return result
    }

    // Update proxy
    async update(id: number, data: Partial<Proxy>): Promise<Proxy | undefined> {
        const db = getDatabase()
        const result = db.update(schema.proxies)
            .set(data)
            .where(eq(schema.proxies.id, id))
            .returning()
            .get()
        return result
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

    // Check proxy health — lightweight test using native Node.js http/net
    async checkProxy(id: number): Promise<{ alive: boolean; responseTime: number; reason?: string }> {
        const proxy = await this.getById(id)
        if (!proxy) return { alive: false, responseTime: 0 }

        const startTime = Date.now()

        try {
            console.log(`[ProxyCheck] Testing ${proxy.host}:${proxy.port} (type: ${proxy.type || 'http'}, user: ${proxy.username || 'none'})...`)

            const health = await this.testProxyConnection(proxy)
            const alive = health.alive
            const responseTime = Date.now() - startTime

            // Look up country/location for the proxy IP
            let country = proxy.country || null
            if (alive) {
                try {
                    country = await this.lookupProxyCountry(proxy.host)
                } catch (e) {
                    console.log(`[ProxyCheck] Country lookup failed: ${e}`)
                }
            }

            await this.update(id, {
                status: alive ? 'active' : 'dead',
                lastCheck: new Date(),
                responseTime,
                country: country || undefined,
            })

            console.log(`[ProxyCheck] ${proxy.host}:${proxy.port} → ${alive ? 'ALIVE' : 'DEAD'} (${responseTime}ms, ${country || 'unknown'})`)
            return { alive, responseTime, reason: health.reason }
        } catch (error) {
            const responseTime = Date.now() - startTime
            console.log(`[ProxyCheck] ${proxy.host}:${proxy.port} → DEAD (error: ${error instanceof Error ? error.message : error})`)

            await this.update(id, {
                status: 'dead',
                lastCheck: new Date(),
                responseTime: 0,
            })
            return {
                alive: false,
                responseTime: 0,
                reason: error instanceof Error ? error.message : 'proxy_check_failed',
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
                // For SOCKS5, test TCP connectivity
                const socket = net.connect({ host: proxy.host, port: proxy.port, timeout }, () => {
                    socket.destroy()
                    resolve({ alive: true, reason: 'socks5_tcp_connect_ok' })
                })
                socket.on('error', () => { socket.destroy(); resolve({ alive: false, reason: 'socks5_tcp_connect_failed' }) })
                socket.on('timeout', () => { socket.destroy(); resolve({ alive: false, reason: 'socks5_tcp_timeout' }) })
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
                // Any response means the proxy gateway is alive
                // 200 = proxy worked perfectly
                // 204 = proxy responded (Google generate_204)
                // 301/302 = proxy redirected (still alive)
                // 407 = proxy auth required (proxy gateway is ALIVE, auth issue)
                const statusCode = res.statusCode || 0
                const alive = statusCode >= 200 && statusCode < 400
                const reason = statusCode === 407
                    ? 'proxy_auth_required'
                    : alive
                        ? `http_probe_status_${statusCode}`
                        : `http_probe_rejected_status_${statusCode}`
                console.log(`[ProxyCheck] HTTP response: ${statusCode} (${alive ? 'ALIVE' : 'DEAD'}, ${reason})`)

                // Try to read body for IP info
                let data = ''
                res.on('data', (chunk: Buffer) => { data += chunk.toString() })
                res.on('end', () => {
                    if (data && statusCode === 200) {
                        try {
                            const json = JSON.parse(data)
                            if (json.origin) {
                                console.log(`[ProxyCheck] Proxy exit IP: ${json.origin}`)
                            }
                        } catch { /* not JSON */ }
                    }
                    resolve({ alive, reason })
                })
            })

            req.on('error', (err) => {
                console.log(`[ProxyCheck] HTTP error: ${err.message}`)
                // For rotating proxies, connection errors might be temporary
                // Try a simple TCP check as fallback
                console.log(`[ProxyCheck] Trying TCP fallback...`)
                const socket = net.connect({ host: proxy.host, port: proxy.port, timeout: 10000 }, () => {
                    socket.destroy()
                    console.log(`[ProxyCheck] TCP connection OK → marking as alive`)
                    resolve({ alive: true, reason: `tcp_fallback_ok (http_error: ${err.message})` })
                })
                socket.on('error', () => { socket.destroy(); resolve({ alive: false, reason: `http_probe_error:${err.message}` }) })
                socket.on('timeout', () => { socket.destroy(); resolve({ alive: false, reason: `http_probe_error:${err.message}` }) })
            })

            req.on('timeout', () => {
                console.log(`[ProxyCheck] HTTP timeout`)
                req.destroy()
                resolve({ alive: false, reason: 'http_probe_timeout' })
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

        for (const line of lines) {
            try {
                const proxy = this.parseProxyImportLine(line, defaultProvider)
                if (!proxy) {
                    console.log(`Failed to import proxy (invalid format): ${line}`)
                    continue
                }
                db.insert(schema.proxies).values(proxy).run()
                imported++
            } catch {
                console.log(`Failed to import proxy: ${line}`)
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

export const proxyService = new ProxyService()
