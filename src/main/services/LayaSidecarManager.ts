import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

export type LayaSidecarState = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'failed'

export interface LayaSidecarStatus {
    state: LayaSidecarState
    endpoint: string
    executablePath?: string
    pid?: number
    error?: string
}

export type LayaSidecarSpawnOptions = {
    cwd: string
    windowsHide: boolean
    stdio: ['ignore', 'pipe', 'pipe']
}

export interface LayaSidecarOptions {
    resourcesPath?: string
    cwd?: string
    executablePath?: string
    port?: number
    startupTimeoutMs?: number
    healthPath?: string
    platform?: NodeJS.Platform
    allocateLoopbackPort?: () => Promise<number>
    spawnProcess?: (file: string, args: string[], options: LayaSidecarSpawnOptions) => ChildProcess
    fetchHealth?: (url: string, timeoutMs: number) => Promise<unknown>
}

const OWNED_SERVICE = 'mmo-laya-sidecar'
const OWNED_PROTOCOL = 1
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_HEALTH_PATH = '/api/v1/models'
const HEALTH_TIMEOUT_MS = 1_500
const POLL_INTERVAL_MS = 250
const STOP_WAIT_MS = 2_000
const MAX_DIAGNOSTIC_CHARS = 4_096

/** Owns the optional local Laya process and never treats fallback as readiness. */
export class LayaSidecarManager {
    private readonly options: LayaSidecarOptions & {
        startupTimeoutMs: number
        healthPath: string
        platform: NodeJS.Platform
    }
    private child: ChildProcess | null = null
    private startPromise: Promise<LayaSidecarStatus> | null = null
    private status: LayaSidecarStatus
    private runtimePort: number | undefined
    private startEpoch = 0
    private startupAbort: AbortController | null = null
    private diagnosticTail = ''

    constructor(options: LayaSidecarOptions = {}) {
        this.options = {
            ...options,
            startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
            healthPath: options.healthPath ?? DEFAULT_HEALTH_PATH,
            platform: options.platform ?? process.platform,
        }
        this.runtimePort = options.port
        this.status = {
            state: 'stopped',
            endpoint: this.endpoint,
        }
    }

    get endpoint(): string {
        return `http://127.0.0.1:${this.activePort}`
    }

    getStatus(): LayaSidecarStatus {
        return { ...this.status }
    }

    async ensureRunning(): Promise<LayaSidecarStatus> {
        if (this.status.state === 'ready' && await this.isOwnedChildHealthy()) {
            return this.getStatus()
        }
        if (this.startPromise) return this.startPromise
        this.startPromise = this.startInternal().finally(() => {
            this.startPromise = null
        })
        return this.startPromise
    }

    async stop(): Promise<void> {
        this.startEpoch += 1
        this.startupAbort?.abort()
        this.status = { state: 'stopped', endpoint: this.endpoint }
        await this.killOwnedChild()
        this.status = { state: 'stopped', endpoint: this.endpoint }
    }

    private get activePort(): number {
        return this.runtimePort ?? this.options.port ?? 0
    }

    private async startInternal(): Promise<LayaSidecarStatus> {
        const epoch = this.startEpoch
        this.diagnosticTail = ''
        this.startupAbort?.abort()
        this.startupAbort = new AbortController()
        const signal = this.startupAbort.signal

        if (this.options.platform !== 'win32') {
            this.status = {
                state: 'unavailable',
                endpoint: this.endpoint,
                error: 'Laya sidecar is only available on Windows',
            }
            return this.getStatus()
        }

        const executablePath = this.resolveExecutablePath()
        if (!executablePath || !existsSync(executablePath)) {
            this.status = {
                state: 'unavailable',
                endpoint: this.endpoint,
                executablePath: executablePath || undefined,
                error: 'Laya sidecar executable is not packaged',
            }
            return this.getStatus()
        }

        if (this.child) {
            await this.killOwnedChild()
        }

        if (this.startEpoch !== epoch || signal.aborted) {
            return this.getStatus()
        }

        try {
            this.runtimePort = this.options.port ?? await this.allocatePort()
        } catch (error) {
            this.status = {
                state: 'failed',
                endpoint: this.endpoint,
                executablePath,
                error: `Laya sidecar port allocation failed: ${errorMessage(error)}`,
            }
            return this.getStatus()
        }

        if (this.startEpoch !== epoch || signal.aborted) {
            return this.getStatus()
        }

        this.status = { state: 'starting', endpoint: this.endpoint, executablePath }
        const spawnProcess = this.options.spawnProcess ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions))
        const modelDirectory = join(resolve(executablePath, '..'), 'model', 'multilingual')
        const spawnArgs = [
            '--host=127.0.0.1',
            `--port=${this.activePort}`,
            `--model-dir=${modelDirectory}`,
        ]
        const spawnOptions: LayaSidecarSpawnOptions = {
            cwd: this.options.cwd ?? resolve(executablePath, '..'),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }

        let child: ChildProcess
        try {
            child = spawnProcess(executablePath, spawnArgs, spawnOptions)
        } catch (error) {
            this.status = {
                state: 'failed',
                endpoint: this.endpoint,
                executablePath,
                error: `Laya sidecar spawn failed: ${errorMessage(error)}`,
            }
            return this.getStatus()
        }

        this.child = child
        this.drain(child.stdout)
        this.drain(child.stderr)
        child.once('error', (error) => {
            this.appendDiagnostic(errorMessage(error))
            if (this.child !== child) return
            this.child = null
            try {
                child.kill()
            } catch {
                // Child may already be gone; never let spawn errors crash Electron.
            }
            if (this.startEpoch === epoch && this.status.state === 'starting') {
                this.status = {
                    state: 'failed',
                    endpoint: this.endpoint,
                    executablePath,
                    error: `Laya sidecar spawn failed: ${errorMessage(error)}${this.formatDiagnosticSuffix()}`,
                }
            }
        })
        child.once('exit', (code, signalName) => {
            if (this.child !== child) return
            this.child = null
            if (this.startEpoch !== epoch) return
            if (this.status.state === 'starting' || this.status.state === 'ready') {
                this.status = {
                    state: 'failed',
                    endpoint: this.endpoint,
                    executablePath,
                    error: `Laya sidecar exited (${code ?? signalName ?? 'unknown'})${this.formatDiagnosticSuffix()}`,
                }
            }
        })

        if (this.startEpoch !== epoch || signal.aborted) {
            await this.killOwnedChild()
            return this.getStatus()
        }

        const deadline = Date.now() + this.options.startupTimeoutMs
        while (Date.now() < deadline) {
            if (this.startEpoch !== epoch || signal.aborted) {
                return this.getStatus()
            }
            if (this.child !== child || child.exitCode !== null) {
                return this.getStatus()
            }
            const body = await this.readHealth(signal)
            if (this.startEpoch !== epoch || signal.aborted) {
                return this.getStatus()
            }
            const pid = child.pid
            if (pid !== undefined && isOwnedSidecarHealth(body, pid)) {
                if (this.child !== child || this.status.state !== 'starting') {
                    return this.getStatus()
                }
                this.status = { state: 'ready', endpoint: this.endpoint, executablePath, pid }
                return this.getStatus()
            }
            await sleep(POLL_INTERVAL_MS, signal)
        }

        if (this.startEpoch !== epoch || signal.aborted) {
            return this.getStatus()
        }

        const timeoutError = `Laya sidecar did not become healthy within ${this.options.startupTimeoutMs}ms${this.formatDiagnosticSuffix()}`
        await this.killOwnedChild()
        if (this.startEpoch !== epoch) {
            return this.getStatus()
        }
        this.status = {
            state: 'failed',
            endpoint: this.endpoint,
            executablePath,
            error: timeoutError,
        }
        return this.getStatus()
    }

    private async allocatePort(): Promise<number> {
        if (this.options.allocateLoopbackPort) {
            return this.options.allocateLoopbackPort()
        }
        return allocateFreeLoopbackPort()
    }

    private resolveExecutablePath(): string | undefined {
        if (this.options.executablePath) return resolve(this.options.executablePath)
        const configured = process.env.MMO_LAYA_SIDECAR_PATH?.trim()
        if (configured) return resolve(configured)
        const resourcesPath = this.resolveResourcesPath()
        if (resourcesPath) {
            const packaged = join(resourcesPath, 'laya-sidecar', 'laya-sidecar.exe')
            if (existsSync(packaged)) return packaged
        }
        return join(this.options.cwd ?? process.cwd(), 'resources', 'laya-sidecar', 'laya-sidecar.exe')
    }

    private resolveResourcesPath(): string | undefined {
        if (this.options.resourcesPath) return this.options.resourcesPath
        const fromProcess = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath
        return typeof fromProcess === 'string' && fromProcess.length > 0 ? fromProcess : undefined
    }

    private async isOwnedChildHealthy(): Promise<boolean> {
        const pid = this.child?.pid
        if (pid === undefined) return false
        const body = await this.readHealth(AbortSignal.timeout(HEALTH_TIMEOUT_MS))
        return isOwnedSidecarHealth(body, pid)
    }

    private async readHealth(signal: AbortSignal): Promise<unknown> {
        if (signal.aborted) return null
        const fetchHealth = this.options.fetchHealth ?? defaultFetchHealth
        return Promise.race([
            fetchHealth(`${this.endpoint}${this.options.healthPath}`, HEALTH_TIMEOUT_MS),
            abortToNull(signal),
        ])
    }

    private async killOwnedChild(): Promise<void> {
        const child = this.child
        this.child = null
        if (!child || child.killed || child.exitCode !== null) return
        try {
            child.kill()
        } catch {
            return
        }
        await new Promise<void>((resolveStop) => {
            const timer = setTimeout(resolveStop, STOP_WAIT_MS)
            child.once('exit', () => {
                clearTimeout(timer)
                resolveStop()
            })
        })
    }

    private drain(stream: ChildProcess['stdout'] | ChildProcess['stderr']): void {
        if (!stream) return
        stream.on('data', (chunk: Buffer | string) => {
            this.appendDiagnostic(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        })
        stream.on('error', (error: Error) => {
            this.appendDiagnostic(error.message)
        })
    }

    private appendDiagnostic(chunk: string): void {
        if (!chunk) return
        this.diagnosticTail += chunk
        if (this.diagnosticTail.length > MAX_DIAGNOSTIC_CHARS) {
            this.diagnosticTail = this.diagnosticTail.slice(-MAX_DIAGNOSTIC_CHARS)
        }
    }

    private formatDiagnosticSuffix(): string {
        const tail = this.diagnosticTail.trim()
        return tail ? `; output: ${tail}` : ''
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOwnedSidecarHealth(body: unknown, childPid: number): boolean {
    if (!isRecord(body)) return false
    return body.service === OWNED_SERVICE
        && body.protocol === OWNED_PROTOCOL
        && body.model_loaded === true
        && body.pid === childPid
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error'
}

function abortToNull(signal: AbortSignal): Promise<null> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve(null)
            return
        }
        signal.addEventListener('abort', () => resolve(null), { once: true })
    })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
        }, { once: true })
    })
}

function allocateFreeLoopbackPort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const server = createServer()
        server.unref()
        server.once('error', (error) => {
            server.close()
            reject(error)
        })
        server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('Failed to allocate loopback port'))
                return
            }
            const port = address.port
            server.close((closeError) => {
                if (closeError) reject(closeError)
                else resolvePort(port)
            })
        })
    })
}

async function defaultFetchHealth(url: string, timeoutMs: number): Promise<unknown> {
    try {
        const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return null
        return await response.json() as unknown
    } catch {
        return null
    }
}

export const layaSidecarManager = new LayaSidecarManager()
