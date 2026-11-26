import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Localhost-only control port for an agent on this same PC.
 * Off unless settings.agentBridgeEnabled is true.
 * Never binds a public or LAN address, never executes shell commands,
 * and every JSON response is passed through secret redaction.
 */
export const AGENT_BRIDGE_HOST = '127.0.0.1'
export const AGENT_BRIDGE_DEFAULT_PORT = 47321

const MAX_BODY_BYTES = 32 * 1024
const SECRET_KEY = /(password|secret|token|apikey|api_key|cookie|twofactor|two_factor|credential|authorization|recovery)/i

export interface AgentBridgeController {
    snapshot(): Promise<unknown> | unknown
    listAccounts(): Promise<unknown> | unknown
    listCampaigns(): Promise<unknown> | unknown
    listLocations(): Promise<unknown> | unknown
    readLog(name: string, lines: number): Promise<unknown> | unknown
    startTraffic(campaignId: number): Promise<unknown> | unknown
    pauseTraffic(): Promise<unknown> | unknown
    resumeTraffic(): Promise<unknown> | unknown
    stopTraffic(): Promise<unknown> | unknown
    startAutomation(campaignId: number): Promise<unknown> | unknown
    pauseAutomation(): Promise<unknown> | unknown
    resumeAutomation(): Promise<unknown> | unknown
    stopAutomation(): Promise<unknown> | unknown
    recycleBrowser(force: boolean): Promise<unknown> | unknown
}

export interface AgentBridgePublicState {
    enabled: boolean
    listening: boolean
    host: string
    port: number | null
    token: string | null
    baseUrl: string | null
    statePath: string | null
    error: string | null
}

interface BridgeConfig {
    statePath: string
    controller: AgentBridgeController
    preferredPort?: number
}

interface StoredState {
    enabled: boolean
    listening: boolean
    host: string
    port: number | null
    token: string | null
    baseUrl: string | null
    updatedAt: string
}

function redact(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[truncated]'
    if (typeof value === 'string') {
        return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1))
    if (typeof value !== 'object') return String(value)
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(child, depth + 1)
    }
    return out
}

function tokensMatch(provided: string, expected: string): boolean {
    const left = Buffer.from(provided)
    const right = Buffer.from(expected)
    if (left.length === 0 || left.length !== right.length) return false
    return timingSafeEqual(left, right)
}

function readBearer(req: IncomingMessage): string {
    const header = req.headers['x-agent-token']
    if (typeof header === 'string' && header.trim()) return header.trim()
    const authorization = req.headers.authorization
    if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim()
    }
    return ''
}

function hostAllowed(req: IncomingMessage, port: number): boolean {
    const host = String(req.headers.host || '').trim().toLowerCase()
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function remoteIsLoopback(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress || ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body_too_large'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({})
                return
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    reject(new Error('body_must_be_object'))
                    return
                }
                resolve(parsed as Record<string, unknown>)
            } catch {
                reject(new Error('invalid_json'))
            }
        })
        req.on('error', reject)
    })
}

function requireCampaignId(campaignId: number): number {
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
        throw new Error('campaign_id_required')
    }
    return campaignId
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    })
    res.end(payload)
}

export class AgentBridgeService {
    private server: Server | null = null
    private token = ''
    private port: number | null = null
    private lastError: string | null = null
    private desiredEnabled = false
    private config: BridgeConfig | null = null

    configure(config: BridgeConfig): void {
        this.config = config
    }

    getPublicState(): AgentBridgePublicState {
        const listening = this.server?.listening === true && this.port !== null
        return {
            enabled: this.desiredEnabled,
            listening,
            host: AGENT_BRIDGE_HOST,
            port: listening ? this.port : null,
            token: listening ? this.token : null,
            baseUrl: listening && this.port ? `http://${AGENT_BRIDGE_HOST}:${this.port}` : null,
            statePath: this.config?.statePath ?? null,
            error: this.lastError,
        }
    }

    async start(): Promise<void> {
        this.desiredEnabled = true
        this.lastError = null
        if (!this.config) throw new Error('agent bridge is not configured')
        if (this.server?.listening) {
            this.writeState()
            return
        }
        this.token = this.readStoredToken() || randomBytes(24).toString('hex')
        const preferred = this.config.preferredPort ?? AGENT_BRIDGE_DEFAULT_PORT
        try {
            const started = await this.listen(preferred)
            this.port = started
            this.writeState()
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error)
            this.writeState()
            throw error
        }
    }

    async stop(): Promise<void> {
        this.desiredEnabled = false
        this.lastError = null
        const server = this.server
        this.server = null
        this.port = null
        if (server) {
            await new Promise<void>((resolve) => {
                server.close(() => resolve())
            })
        }
        this.writeState()
    }

    rotateToken(): AgentBridgePublicState {
        this.token = randomBytes(24).toString('hex')
        this.writeState()
        return this.getPublicState()
    }

    private readStoredToken(): string {
        if (!this.config) return ''
        try {
            const parsed = JSON.parse(readFileSync(this.config.statePath, 'utf8')) as { token?: unknown }
            return typeof parsed.token === 'string' ? parsed.token : ''
        } catch {
            return ''
        }
    }

    private writeState(): void {
        if (!this.config) return
        const publicState = this.getPublicState()
        const stored: StoredState = {
            enabled: publicState.enabled,
            listening: publicState.listening,
            host: AGENT_BRIDGE_HOST,
            port: publicState.port,
            token: this.token || null,
            baseUrl: publicState.baseUrl,
            updatedAt: new Date().toISOString(),
        }
        mkdirSync(dirname(this.config.statePath), { recursive: true })
        writeFileSync(this.config.statePath, JSON.stringify(stored, null, 2), 'utf8')
    }

    private listen(preferredPort: number): Promise<number> {
        const server = createServer((req, res) => {
            void this.handle(req, res)
        })
        this.server = server
        const ports = preferredPort === 0
            ? [0]
            : Array.from({ length: 10 }, (_, index) => preferredPort + index)

        return new Promise((resolve, reject) => {
            let index = 0
            const tryNext = (): void => {
                if (index >= ports.length) {
                    reject(new Error(`agent bridge could not bind ${AGENT_BRIDGE_HOST}:${preferredPort}`))
                    return
                }
                const port = ports[index]
                index += 1
                const onError = (error: NodeJS.ErrnoException): void => {
                    server.off('listening', onListening)
                    if (error.code === 'EADDRINUSE' && port !== 0) {
                        tryNext()
                        return
                    }
                    reject(error)
                }
                const onListening = (): void => {
                    server.off('error', onError)
                    const address = server.address()
                    if (!address || typeof address === 'string' || address.address !== AGENT_BRIDGE_HOST) {
                        server.close()
                        reject(new Error('agent bridge refused a non-loopback bind'))
                        return
                    }
                    resolve(address.port)
                }
                server.once('error', onError)
                server.once('listening', onListening)
                server.listen(port, AGENT_BRIDGE_HOST)
            }
            tryNext()
        })
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            if (!this.port || !remoteIsLoopback(req) || !hostAllowed(req, this.port)) {
                sendJson(res, 403, { ok: false, error: 'loopback_only' })
                return
            }
            if (req.method === 'OPTIONS') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
                return
            }
            if (!tokensMatch(readBearer(req), this.token)) {
                sendJson(res, 401, { ok: false, error: 'unauthorized' })
                return
            }
            const url = new URL(req.url || '/', `http://${AGENT_BRIDGE_HOST}:${this.port}`)
            const controller = this.config?.controller
            if (!controller) {
                sendJson(res, 503, { ok: false, error: 'controller_unavailable' })
                return
            }
            if (req.method === 'GET' && url.pathname === '/v1/help') {
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        auth: 'Header X-Agent-Token or Authorization: Bearer',
                        bind: `${AGENT_BRIDGE_HOST} only`,
                        routes: [
                            'GET /v1/help',
                            'GET /v1/snapshot',
                            'GET /v1/accounts',
                            'GET /v1/campaigns',
                            'GET /v1/locations',
                            'GET /v1/logs?name=bootstrap|runtime-health|proxy-debug&lines=200',
                            'POST /v1/traffic/start {campaignId}',
                            'POST /v1/traffic/pause',
                            'POST /v1/traffic/resume',
                            'POST /v1/traffic/stop',
                            'POST /v1/automation/start {campaignId}',
                            'POST /v1/automation/pause',
                            'POST /v1/automation/resume',
                            'POST /v1/automation/stop',
                            'POST /v1/browser/recycle {force?:boolean}',
                        ],
                    },
                })
                return
            }
            const data = await this.dispatch(controller, req, url)
            if (data === undefined) {
                sendJson(res, 404, { ok: false, error: 'not_found' })
                return
            }
            sendJson(res, 200, { ok: true, data: redact(data) })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'request_failed'
            if (!res.headersSent) {
                sendJson(res, 400, { ok: false, error: message.slice(0, 300) })
            }
        }
    }

    private async dispatch(
        controller: AgentBridgeController,
        req: IncomingMessage,
        url: URL,
    ): Promise<unknown> {
        if (req.method === 'GET' && url.pathname === '/v1/snapshot') return controller.snapshot()
        if (req.method === 'GET' && url.pathname === '/v1/accounts') return controller.listAccounts()
        if (req.method === 'GET' && url.pathname === '/v1/campaigns') return controller.listCampaigns()
        if (req.method === 'GET' && url.pathname === '/v1/locations') return controller.listLocations()
        if (req.method === 'GET' && url.pathname === '/v1/logs') {
            const name = url.searchParams.get('name') || 'bootstrap'
            const lines = Math.max(1, Math.min(400, Number(url.searchParams.get('lines') || 200)))
            return controller.readLog(name, lines)
        }
        if (req.method !== 'POST') return undefined
        const body = await readBody(req)
        const campaignId = typeof body.campaignId === 'number' ? body.campaignId : Number.NaN
        if (url.pathname === '/v1/traffic/start') return controller.startTraffic(requireCampaignId(campaignId))
        if (url.pathname === '/v1/traffic/pause') return controller.pauseTraffic()
        if (url.pathname === '/v1/traffic/resume') return controller.resumeTraffic()
        if (url.pathname === '/v1/traffic/stop') return controller.stopTraffic()
        if (url.pathname === '/v1/automation/start') return controller.startAutomation(requireCampaignId(campaignId))
        if (url.pathname === '/v1/automation/pause') return controller.pauseAutomation()
        if (url.pathname === '/v1/automation/resume') return controller.resumeAutomation()
        if (url.pathname === '/v1/automation/stop') return controller.stopAutomation()
        if (url.pathname === '/v1/browser/recycle') return controller.recycleBrowser(body.force === true)
        return undefined
    }
}

let singleton: AgentBridgeService | null = null

export function getAgentBridgeService(): AgentBridgeService {
    if (!singleton) singleton = new AgentBridgeService()
    return singleton
}

export function configureAgentBridge(config: BridgeConfig): AgentBridgeService {
    const service = getAgentBridgeService()
    service.configure(config)
    return service
}

export async function syncAgentBridgeFromSettings(): Promise<void> {
    const { loadSettings } = await import('../ipc/settings')
    const enabled = loadSettings().agentBridgeEnabled === true
    const service = getAgentBridgeService()
    if (enabled) {
        await service.start()
        return
    }
    await service.stop()
}

export function rotateAgentBridgeToken(): AgentBridgePublicState {
    return getAgentBridgeService().rotateToken()
}
