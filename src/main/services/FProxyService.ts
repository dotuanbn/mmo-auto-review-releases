import * as https from 'https'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { browserService } from '../automation/BrowserService'

// FProxy.me API response format
export interface FProxyData {
    http: string
    sock: string
    httpuserpass: string
    sockuserpass: string
    location: string
    time_die: string
    waiting_time: string
}

export interface FProxyResponse {
    success: boolean
    message?: string
    data?: FProxyData
}

type ParsedProxyCred = {
    host: string
    port: number
    username: string
    password: string
}

function logFProxy(message: string) {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${message}\n`
    console.log(message)
    try {
        const logPath = join(app.getPath('userData'), 'proxy-debug.log')
        appendFileSync(logPath, line)
    } catch {
        // ignore
    }
}

export class FProxyService {
    private currentProxy: FProxyData | null = null
    private proxyExpireAt: number = 0
    private apiKey: string = ''
    private lastRotateTime: number = 0
    private autoRotateInterval: ReturnType<typeof setInterval> | null = null
    private rotateIntervalMs: number = 120_000 // 2 minutes default
    private proxyDieAt: number = 0 // Server-synced: timestamp when current proxy cycle ends
    private onProxyChanged: ((newProxy: FProxyData) => void) | null = null
    private _proxyRotated: boolean = false
    private _lastRotatedAt: number = 0
    private rotationInFlight: Promise<FProxyData | null> | null = null
    private pausedRemaining: number | null = null

    hasConfiguration(): boolean {
        return !!(this.apiKey || this.currentProxy || this.autoRotateInterval)
    }

    clearConfiguration(reason: string = 'disabled') {
        if (!this.hasConfiguration()) {
            return
        }

        this.stopAutoRotate()
        this.apiKey = ''
        this.currentProxy = null
        this.proxyExpireAt = 0
        this.lastRotateTime = 0
        this._proxyRotated = false
        this._lastRotatedAt = 0
        this.proxyDieAt = 0
        this.rotationInFlight = null
        this.pausedRemaining = null
        logFProxy(`[FProxy] Configuration cleared (${reason})`)
    }

    setApiKey(key: string) {
        let normalized = key.trim()
        if (normalized.toLowerCase().startsWith('http://') || normalized.toLowerCase().startsWith('https://')) {
            try {
                const parsed = new URL(normalized)
                normalized = parsed.searchParams.get('key')?.trim() || normalized
            } catch {
                // keep original string if URL parsing fails
            }
        }
        if (normalized.toLowerCase().startsWith('key=')) {
            normalized = normalized.slice(4).trim()
        }

        if (!normalized) {
            this.clearConfiguration('empty_api_key')
            return
        }

        if (this.apiKey === normalized) {
            return
        }

        if (this.apiKey && this.apiKey !== normalized) {
            this.currentProxy = null
            this.proxyExpireAt = 0
            this.lastRotateTime = 0
        }

        this.apiKey = normalized
        logFProxy(`[FProxy] API key set: ${this.apiKey.substring(0, 10)}...`)
    }

    getApiKey(): string {
        return this.apiKey
    }

    // Check if proxy has rotated since last check (resets flag) — legacy, use hasProxyRotatedSince() for multi-thread safety
    hasProxyRotated(): boolean {
        if (this._proxyRotated) {
            this._proxyRotated = false
            return true
        }
        return false
    }

    // Thread-safe: check if proxy rotated since the given timestamp (does NOT reset any flag)
    hasProxyRotatedSince(sinceTimestamp: number): boolean {
        return this._lastRotatedAt > 0 && this._lastRotatedAt > sinceTimestamp
    }

    // Get the timestamp of the last proxy rotation
    getLastRotatedAt(): number {
        return this._lastRotatedAt
    }

    // Get the current auto-rotation interval in milliseconds
    getRotateIntervalMs(): number {
        return this.rotateIntervalMs
    }

    // Check if auto-rotation is active
    isAutoRotateActive(): boolean {
        return this.autoRotateInterval !== null
    }

    /**
     * Wait for a fresh proxy rotation before starting a new visit.
     * If the remaining countdown time is less than minTimeRequiredSec,
     * waits until the proxy rotates and the full countdown restarts.
     * Returns the available time in ms for the visit.
     */
    async waitForFreshRotation(
        minTimeRequiredSec: number,
        shouldStop: () => boolean,
        onStatus?: (msg: string) => void
    ): Promise<number> {
        if (!this.autoRotateInterval || !this.apiKey) {
            return this.rotateIntervalMs // No auto-rotate, return full interval
        }

        const remainingSec = this.getNextRotateIn()
        
        if (remainingSec >= minTimeRequiredSec) {
            // Enough time remaining, use current window
            logFProxy(`[FProxy] Enough time remaining: ${remainingSec}s >= ${minTimeRequiredSec}s threshold`)
            return remainingSec * 1000
        }

        // Not enough time — wait for server countdown to reach 0, then actively rotate
        logFProxy(`[FProxy] Only ${remainingSec}s remaining (need ${minTimeRequiredSec}s). Waiting for countdown to expire...`)

        while (!shouldStop()) {
            const currentRemaining = this.getNextRotateIn()

            if (currentRemaining <= 0) {
                // Server countdown expired — ACTIVELY rotate immediately (don't wait for setInterval)
                logFProxy(`[FProxy] Countdown expired! Actively calling forceRotate()...`)
                if (onStatus) {
                    onStatus('Proxy expired — rotating now...')
                }
                const newProxy = await this.forceRotate()
                if (newProxy) {
                    const newIp = this.parseHttpUserpass(newProxy.httpuserpass)?.host || ''
                    logFProxy(`[FProxy] Active rotation complete! New IP: ${newIp}, countdown: ${this.getNextRotateIn()}s`)
                    // Return available time from fresh rotation
                    return this.getNextRotateIn() * 1000
                }
                // If rotate failed, wait a bit and retry
                await new Promise(resolve => setTimeout(resolve, 2000))
                continue
            }

            // Update status for UI — show live countdown
            if (onStatus) {
                onStatus(`Waiting for proxy rotation... ${currentRemaining}s remaining`)
            }

            // Poll every 500ms for faster response when countdown hits 0
            await new Promise(resolve => setTimeout(resolve, 500))
        }

        return 0 // Stopped
    }

    // Set callback for when proxy IP changes (BrowserService uses this)
    setOnProxyChanged(callback: (newProxy: FProxyData) => void) {
        this.onProxyChanged = callback
    }

    private parseHttpUserpass(value: string | undefined): ParsedProxyCred | null {
        if (!value) return null
        const parts = value.split(':')
        if (parts.length < 4) return null

        const host = parts[0]
        const port = Number.parseInt(parts[1], 10)
        const username = parts[2]
        const password = parts[3]

        if (!host || !Number.isFinite(port) || port <= 0 || !username || !password) {
            return null
        }

        return { host, port, username, password }
    }

    private isValidProxyData(data?: FProxyData): data is FProxyData {
        return !!data && !!this.parseHttpUserpass(data.httpuserpass)
    }

    // Start auto-rotation timer
    startAutoRotate(intervalMs: number = 120_000) {
        this.stopAutoRotate()
        this.pausedRemaining = null
        this.rotateIntervalMs = intervalMs
        logFProxy(`[FProxy] Starting auto-rotate every ${intervalMs / 1000}s`)

        this.autoRotateInterval = setInterval(async () => {
            logFProxy(`[FProxy] Auto-rotate triggered`)
            const oldIp = this.parseHttpUserpass(this.currentProxy?.httpuserpass)?.host || ''
            const newData = await this.forceRotate()
            if (newData) {
                const newIp = this.parseHttpUserpass(newData.httpuserpass)?.host || ''
                if (oldIp && newIp && oldIp !== newIp) {
                    logFProxy(`[FProxy] IP CHANGED: ${oldIp} -> ${newIp} (${newData.location})`)
                    this._proxyRotated = true
                    this._lastRotatedAt = Date.now()
                    if (this.onProxyChanged) {
                        this.onProxyChanged(newData)
                    }
                } else {
                    logFProxy(`[FProxy] IP unchanged: ${newIp} (${newData.location})`)
                }
            }
        }, intervalMs)
    }

    // Stop auto-rotation
    stopAutoRotate() {
        if (this.autoRotateInterval) {
            clearInterval(this.autoRotateInterval)
            this.autoRotateInterval = null
            logFProxy(`[FProxy] Auto-rotate stopped`)
        }
    }

    // Pause rotation timer for campaign pause: capture remaining to freeze cycle (do not consume pause time)
    pauseAutoRotate() {
        if (!this.autoRotateInterval) return
        const rem = this.getNextRotateIn()
        this.stopAutoRotate()
        this.pausedRemaining = rem > 0 ? rem : null
        logFProxy(`[FProxy] Auto-rotate paused, remaining=${this.pausedRemaining}s (freeze for resume)`)
    }

    // Resume rotation: restore remaining into proxyDieAt so cycle continues from pause point (freeze), restart timer; refresh if expired
    resumeAutoRotate() {
        const interval = this.rotateIntervalMs || 120_000
        if (this.pausedRemaining != null && this.pausedRemaining > 0) {
            // App-controlled freeze: continue countdown from captured remaining, pause duration not counted in cycle
            this.proxyDieAt = Date.now() + (this.pausedRemaining * 1000)
            logFProxy(`[FProxy] Auto-rotate resume: restored remaining=${this.pausedRemaining}s into proxyDieAt (freeze mode)`)
        }
        this.pausedRemaining = null
        if (!this.autoRotateInterval && this.apiKey) {
            this.startAutoRotate(interval)
        }
        // Provider time-based safeguard: if now expired (lease may have lapsed during pause), refresh current endpoint
        if (this.getNextRotateIn() <= 0) {
            this.forceRotate().then(() => {
                logFProxy(`[FProxy] Resume refresh: forced rotate due to expired/zero remaining`)
            }).catch(() => {})
        }
        logFProxy(`[FProxy] Auto-rotate resumed, next in ~${this.getNextRotateIn()}s`)
    }

    // Get time until next auto-rotate (seconds) - SERVER-SYNCED using proxyDieAt
    getNextRotateIn(): number {
        // Use server-synced proxyDieAt if available (from API waiting_time)
        if (this.proxyDieAt > 0) {
            return Math.max(0, Math.round((this.proxyDieAt - Date.now()) / 1000))
        }
        // Fallback to local timer if proxyDieAt not yet set
        if (!this.lastRotateTime || !this.autoRotateInterval) return 0
        const elapsed = Date.now() - this.lastRotateTime
        return Math.max(0, Math.round((this.rotateIntervalMs - elapsed) / 1000))
    }

    // HTTPS GET request
    private httpGet(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            logFProxy(`[FProxy] GET ${url.replace(this.apiKey, this.apiKey.substring(0, 8) + '...')}`)
            const req = https.get(url, (res) => {
                let data = ''
                res.on('data', (chunk: Buffer) => { data += chunk.toString() })
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data)
                        logFProxy(`[FProxy] Response: ${JSON.stringify(json).substring(0, 300)}`)
                        resolve(json)
                    } catch {
                        logFProxy(`[FProxy] Invalid JSON: ${data.substring(0, 200)}`)
                        reject(new Error(`Invalid JSON: ${data.substring(0, 100)}`))
                    }
                })
            })
            req.on('error', (err) => {
                logFProxy(`[FProxy] Request error: ${err.message}`)
                reject(err)
            })
            req.setTimeout(15000, () => {
                req.destroy()
                reject(new Error('Request timeout'))
            })
        })
    }

    // Force rotate - ignores waiting_time (for auto-rotate timer)
    async forceRotate(): Promise<FProxyData | null> {
        if (!this.apiKey) return null
        if (this.rotationInFlight) {
            return this.rotationInFlight
        }

        this.rotationInFlight = this.forceRotateInternal().finally(() => {
            this.rotationInFlight = null
        })

        return this.rotationInFlight
    }

    private async forceRotateInternal(): Promise<FProxyData | null> {
        try {
            const url = `https://sv1.fproxy.me/api/rotate?key=${this.apiKey}`
            const response: FProxyResponse = await this.httpGet(url)

            if (this.isValidProxyData(response.data)) {
                this.currentProxy = response.data
                const ttl = Number.parseInt(response.data.time_die || '1800', 10)
                this.proxyExpireAt = Date.now() + ((Number.isFinite(ttl) ? ttl : 1800) * 1000)
                this.lastRotateTime = Date.now()

                // Server-synced countdown: use waiting_time from API response
                const waitingSec = Number.parseInt(response.data.waiting_time || '120', 10)
                const safeWaitingSec = Number.isFinite(waitingSec) && waitingSec > 0 ? waitingSec : Math.round(this.rotateIntervalMs / 1000)
                this.proxyDieAt = Date.now() + (safeWaitingSec * 1000)
                this.rotateIntervalMs = safeWaitingSec * 1000 // Sync interval with server
                logFProxy(`[FProxy] Server countdown synced: ${safeWaitingSec}s (proxyDieAt: ${new Date(this.proxyDieAt).toISOString()})`)

                const parsed = this.parseHttpUserpass(response.data.httpuserpass)!
                logFProxy(`[FProxy] Proxy: ${parsed.host}:${parsed.port} (${response.data.location})`)
                return response.data
            }

            if (response.data && !this.isValidProxyData(response.data)) {
                logFProxy('[FProxy] Ignored invalid proxy payload from API')
            }

            if (response.message) {
                logFProxy(`[FProxy] API: ${response.message}`)
            } else {
                logFProxy('[FProxy] API: no data')
            }

            return this.currentProxy
        } catch (err: any) {
            logFProxy(`[FProxy] Error: ${err.message}`)
            return this.currentProxy
        }
    }

    // Rotate with rate limiting (for manual/first-time calls)
    async rotateProxy(): Promise<FProxyData | null> {
        if (!this.apiKey) {
            logFProxy('[FProxy] No API key set!')
            return null
        }

        // Respect waiting_time for non-auto calls
        const now = Date.now()
        const waitSec = this.currentProxy ? Number.parseInt(this.currentProxy.waiting_time || '30', 10) : 0
        const waitTime = (Number.isFinite(waitSec) ? Math.max(0, waitSec) : 0) * 1000
        const timeSinceLastRotate = now - this.lastRotateTime
        if (timeSinceLastRotate < waitTime && this.lastRotateTime > 0) {
            return this.currentProxy
        }

        return await this.forceRotate()
    }

    // Get proxy for browser - auto-rotates if no proxy yet
    async getProxyForBrowser(): Promise<{ host: string; port: number; username: string; password: string; type: 'http' } | null> {
        if (!this.apiKey) return null

        // Get proxy if we don't have one
        if (!this.currentProxy) {
            await this.rotateProxy()
        }

        const parsed = this.parseHttpUserpass(this.currentProxy?.httpuserpass)
        if (!parsed) {
            if (this.currentProxy?.httpuserpass) {
                logFProxy(`[FProxy] Invalid httpuserpass: ${this.currentProxy.httpuserpass}`)
            }
            return null
        }

        return {
            host: parsed.host,
            port: parsed.port,
            username: parsed.username,
            password: parsed.password,
            type: 'http' as const,
        }
    }

    isProxyValid(): boolean {
        return !!this.currentProxy && Date.now() < this.proxyExpireAt
    }

    hasUsableProxy(): boolean {
        return this.parseHttpUserpass(this.currentProxy?.httpuserpass) !== null
    }

    // Get current proxy info for display
    getProxyInfo(): {
        ip: string; port: string; location: string;
        expiresIn: number; user: string; nextRotateIn: number;
        autoRotate: boolean; proxyDieAt: number
    } | null {
        if (!this.apiKey || !this.currentProxy) return null
        const parsed = this.parseHttpUserpass(this.currentProxy.httpuserpass)

        return {
            ip: parsed?.host || '',
            port: parsed ? String(parsed.port) : '',
            location: this.currentProxy.location || '',
            expiresIn: Math.max(0, Math.round((this.proxyExpireAt - Date.now()) / 1000)),
            user: parsed?.username || '',
            nextRotateIn: this.getNextRotateIn(),
            proxyDieAt: this.proxyDieAt,
            autoRotate: !!this.autoRotateInterval,
        }
    }

    /**
     * Test proxy *API config* (not the current runtime proxy):
     * 1) Call fproxy rotate endpoint (HTTP OK + parse data)
     * 2) If valid proxy in response, attempt short live connect via that proxy to ipify (confirm LIVE + return real egress IP)
     * Timeout ~10s total for connect test. Never logs full key (httpGet masks).
     */
    async testApiConnection(): Promise<{ success: boolean; message: string; ip?: string; latencyMs?: number; location?: string }> {
        if (!this.apiKey) {
            return { success: false, message: 'Chưa cấu hình API key (fproxyApiKey)' }
        }
        const start = Date.now()
        let testProxy: ParsedProxyCred | null = null
        let apiLocation = ''

        try {
            // 1) API call + parse (dedicated one-shot, does not force main currentProxy to protect running sessions if possible)
            const url = `https://sv1.fproxy.me/api/rotate?key=${this.apiKey}`
            const response: FProxyResponse = await this.httpGet(url)  // logs masked key internally

            if (!response.success || !response.data) {
                const msg = response.message || 'API trả về không thành công'
                return { success: false, message: msg.includes('key') ? 'Sai API key hoặc hết hạn' : msg }
            }

            if (!this.isValidProxyData(response.data)) {
                return { success: false, message: 'Parse proxy thất bại (dữ liệu API không hợp lệ)' }
            }

            const parsed = this.parseHttpUserpass(response.data.httpuserpass)!
            testProxy = parsed
            apiLocation = response.data.location || ''
        } catch (err: any) {
            const m = (err?.message || String(err)).toLowerCase()
            if (m.includes('timeout')) return { success: false, message: 'Kết nối API timeout' }
            if (m.includes('invalid json')) return { success: false, message: 'API trả JSON không hợp lệ' }
            return { success: false, message: 'Không kết nối được API proxy (sai key / mạng / server)' }
        }

        const apiLatency = Date.now() - start
        // 2) Live connect test via obtained proxy (ephemeral, ~8-10s budget)
        let contextId: number | null = null
        try {
            contextId = await browserService.createEphemeralContext({
                headless: true,
                proxy: {
                    host: testProxy!.host,
                    port: testProxy!.port,
                    username: testProxy!.username,
                    password: testProxy!.password,
                    type: 'http',
                },
            })
            const page = browserService.getPage(contextId)
            if (!page) throw new Error('Không tạo được page để test proxy')

            const connectStart = Date.now()
            await page.goto('https://api.ipify.org?format=json', {
                timeout: 10000,
                waitUntil: 'domcontentloaded',
            })
            const bodyText = await page.evaluate(() => (document.body.textContent || '').trim())
            let egressIp = ''
            try {
                const j = JSON.parse(bodyText)
                egressIp = j.ip || ''
            } catch {
                egressIp = bodyText.replace(/[^0-9.]/g, '').slice(0, 15)
            }
            const liveLatency = Date.now() - connectStart
            const total = Date.now() - start

            return {
                success: true,
                message: 'API OK + proxy LIVE',
                ip: egressIp || testProxy!.host,
                latencyMs: Math.round(total),
                location: apiLocation,
            }
        } catch (err: any) {
            const m = err instanceof Error ? err.message : String(err)
            // API succeeded + parsed, but live connect failed (common for bad/expired proxy from pool)
            return {
                success: false,
                message: `API reachable nhưng proxy không live: ${m.split('\n')[0].slice(0, 80)}`,
                ip: testProxy!.host,
                latencyMs: apiLatency,
                location: apiLocation,
            }
        } finally {
            if (contextId !== null) {
                await browserService.closeContext(contextId).catch(() => {})
            }
        }
    }
}

export const fproxyService = new FProxyService()
