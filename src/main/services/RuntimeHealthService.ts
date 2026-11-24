import { app } from 'electron'
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { dataRootService } from './DataRootService'

export const MAX_SNAPSHOT_BYTES = 64 * 1024
export const MIN_HEARTBEAT_INTERVAL_MS = 5000
export const MAX_HEARTBEAT_INTERVAL_MS = 3600000
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000

export const ALLOWED_EXIT_REASONS = [
    'clean_shutdown',
    'unknown_unclean',
    'uncaught_exception',
    'unhandled_rejection',
    'app_quit',
    'corrupt_snapshot',
    'oversized_snapshot_ignored',
] as const
export type AllowedExitReason = (typeof ALLOWED_EXIT_REASONS)[number]

export const ALLOWED_PROCESS_LOSS_REASONS = [
    'clean-exit',
    'abnormal-exit',
    'killed',
    'crashed',
    'oom',
    'launch-failed',
    'integrity-failure',
    'unknown_loss',
] as const
export type AllowedProcessLossReason = (typeof ALLOWED_PROCESS_LOSS_REASONS)[number]

export const ALLOWED_CHILD_TYPES = [
    'GPU',
    'Utility',
    'Zygote',
    'SandboxHelper',
    'PepperPlugin',
    'Unknown',
    'other_process',
] as const
export type AllowedChildType = (typeof ALLOWED_CHILD_TYPES)[number]

export interface ProcessMemoryMetrics {
    rssMb: number
    heapTotalMb: number
    heapUsedMb: number
    externalMb?: number
}

export interface AppProcessMetrics {
    processCount: number
    totalWorkingSetMb: number
}

export interface SessionHealthRecord {
    sessionId: string
    startedAt: string
    updatedAt: string
    endedAt: string | null
    cleanExit: boolean
    exitReason: AllowedExitReason | null
    uptimeSeconds: number
    heartbeatCount: number
    mainMemoryMb: ProcessMemoryMetrics
    appMetrics?: AppProcessMetrics
    rendererLossCount: number
    lastRendererLossReason: string | null
    childProcessLossCount: number
    lastChildLossReason: string | null
}

export interface RuntimeHealthSnapshot {
    version: 1
    current: SessionHealthRecord
    previous: SessionHealthRecord | null
}

export interface RuntimeHealthFs {
    existsSync(path: string): boolean
    readFileSync(path: string, encoding: 'utf8'): string
    writeFileSync(path: string, data: string, encoding: 'utf8'): void
    renameSync(oldPath: string, newPath: string): void
    mkdirSync(path: string, options?: { recursive?: boolean }): void
    unlinkSync?(path: string): void
    statSync?(path: string): { size: number }
}

export interface RuntimeHealthDependencies {
    fs?: RuntimeHealthFs
    now?: () => number
    uptime?: () => number
    getMemoryUsage?: () => NodeJS.MemoryUsage
    getAppMetrics?: () => Array<{ type: string; memory: { workingSetSize: number } }>
    setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout
    clearTimeout?: (timer: NodeJS.Timeout) => void
    logger?: (message: string, error?: unknown) => void
    logsDir?: string
    heartbeatIntervalMs?: number
}

export interface RecoverableWindow {
    isDestroyed(): boolean
    webContents?: {
        isDestroyed(): boolean
        reloadIgnoringCache(): void
    }
}

export interface RendererRecoveryOptions {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    stableUptimeMs?: number
    setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout
    clearTimeout?: (timer: NodeJS.Timeout) => void
    logger?: (message: string, error?: unknown) => void
}

export interface BootstrapLogPathOptions {
    smokeDataRoot?: string | null
    appDataPath?: string
    fallbackCwd?: string
    fs?: {
        existsSync(path: string): boolean
        mkdirSync(path: string, options?: { recursive?: boolean }): void
    }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SYNTHETIC_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/

function generateUuid(): string {
    if (typeof randomUUID === 'function') {
        return randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function toNonNegativeFinite(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value
    }
    return fallback
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return Math.floor(value)
    }
    return fallback
}

export function sanitizeSessionId(input: unknown): string {
    if (typeof input === 'string') {
        const trimmed = input.trim()
        if (UUID_REGEX.test(trimmed)) {
            return trimmed
        }
        if (
            SYNTHETIC_ID_REGEX.test(trimmed) &&
            !trimmed.includes('=') &&
            !trimmed.includes(':') &&
            !trimmed.includes('/') &&
            !trimmed.includes('\\')
        ) {
            return trimmed
        }
    }
    return 'synthetic_session'
}

export function sanitizeIsoDate(input: unknown, fallback: string | null = null): string | null {
    if (typeof input === 'string') {
        const trimmed = input.trim()
        const parsed = Date.parse(trimmed)
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 4102444800000) {
            return new Date(parsed).toISOString()
        }
    }
    return fallback
}

export function matchAllowedExitReason(input: unknown): AllowedExitReason {
    if (typeof input === 'string') {
        const trimmed = input.trim()
        if ((ALLOWED_EXIT_REASONS as readonly string[]).includes(trimmed)) {
            return trimmed as AllowedExitReason
        }
    }
    return 'unknown_unclean'
}

export function matchAllowedProcessLossReason(input: unknown): AllowedProcessLossReason {
    if (typeof input === 'string') {
        const trimmed = input.trim()
        if ((ALLOWED_PROCESS_LOSS_REASONS as readonly string[]).includes(trimmed)) {
            return trimmed as AllowedProcessLossReason
        }
    }
    return 'unknown_loss'
}

export function matchAllowedChildType(input: unknown): AllowedChildType {
    if (typeof input === 'string') {
        const trimmed = input.trim()
        if ((ALLOWED_CHILD_TYPES as readonly string[]).includes(trimmed)) {
            return trimmed as AllowedChildType
        }
    }
    return 'other_process'
}

export function formatProcessLossString(
    reason: unknown,
    exitCode?: unknown,
    prefix?: string
): string {
    const matchedReason = matchAllowedProcessLossReason(reason)
    const codePart = typeof exitCode === 'number' && Number.isFinite(exitCode)
        ? `:code_${Math.floor(exitCode)}`
        : ''
    const base = `${matchedReason}${codePart}`
    return prefix ? `${prefix}:${base}` : base
}

export function sanitizeStoredProcessLossString(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    if (!trimmed) return null

    const parts = trimmed.split(':')
    if (parts.length === 1) {
        const reason = matchAllowedProcessLossReason(parts[0])
        return reason === 'unknown_loss' ? null : reason
    }

    let type: AllowedChildType | null = null
    let reason: AllowedProcessLossReason = 'unknown_loss'
    let exitCode: number | null = null

    for (const part of parts) {
        if (part.startsWith('code_')) {
            const parsedCode = parseInt(part.slice(5), 10)
            if (Number.isFinite(parsedCode)) {
                exitCode = parsedCode
            }
        } else if ((ALLOWED_CHILD_TYPES as readonly string[]).includes(part)) {
            type = part as AllowedChildType
        } else if ((ALLOWED_PROCESS_LOSS_REASONS as readonly string[]).includes(part)) {
            reason = part as AllowedProcessLossReason
        }
    }

    if (reason === 'unknown_loss' && !type && exitCode === null) {
        return null
    }

    const codePart = exitCode !== null ? `:code_${exitCode}` : ''
    if (type) {
        return `${type}:${reason}${codePart}`
    }
    return `${reason}${codePart}`
}

export function resolveBootstrapLogPath(options: BootstrapLogPathOptions = {}): string {
    const fs = options.fs ?? {
        existsSync,
        mkdirSync,
    }

    // When smoke dataRoot is validated (MMO_SMOKE_MODE=1), route bootstrap.log
    // under the smoke dataRoot/logs/bootstrap.log to keep production AppData untouched.
    if (options.smokeDataRoot && typeof options.smokeDataRoot === 'string' && options.smokeDataRoot.trim().length > 0) {
        try {
            const smokeLogs = join(options.smokeDataRoot.trim(), 'logs')
            if (!fs.existsSync(smokeLogs)) {
                fs.mkdirSync(smokeLogs, { recursive: true })
            }
            return join(smokeLogs, 'bootstrap.log')
        } catch {
            // Fall through to standard path on error
        }
    }

    try {
        const appData = options.appDataPath || (typeof app !== 'undefined' && typeof app.getPath === 'function' ? app.getPath('appData') : '')
        if (appData) {
            const base = join(appData, 'MMO Auto Review')
            if (!fs.existsSync(base)) {
                fs.mkdirSync(base, { recursive: true })
            }
            return join(base, 'bootstrap.log')
        }
    } catch {
        // Fall through to cwd fallback
    }

    const cwd = options.fallbackCwd || process.cwd()
    return join(cwd, 'bootstrap.log')
}

export function isStreamPipeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const err = error as { code?: unknown }
    return err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED'
}

export function containConsolePipeErrors(targetProcess: NodeJS.Process = process): () => void {
    const handlePipeError = (err: unknown) => {
        if (isStreamPipeError(err)) {
            // Closed console pipe - ignore to prevent recursive uncaughtException loops
            return
        }
        // Do not silently swallow other fatal errors
        throw err
    }

    const stdout = targetProcess.stdout
    const stderr = targetProcess.stderr

    if (stdout && typeof stdout.on === 'function') {
        stdout.on('error', handlePipeError)
    }
    if (stderr && typeof stderr.on === 'function') {
        stderr.on('error', handlePipeError)
    }

    return () => {
        if (stdout && typeof stdout.removeListener === 'function') {
            stdout.removeListener('error', handlePipeError)
        }
        if (stderr && typeof stderr.removeListener === 'function') {
            stderr.removeListener('error', handlePipeError)
        }
    }
}

function defaultGetAppMetrics(): Array<{ type: string; memory: { workingSetSize: number } }> {
    try {
        if (typeof app !== 'undefined' && typeof app.getAppMetrics === 'function') {
            return app.getAppMetrics()
        }
    } catch {
        // App metrics not accessible outside Electron main runtime
    }
    return []
}

function parseAndSanitizeRecord(input: unknown): SessionHealthRecord | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null
    }
    const obj = input as Record<string, unknown>
    const sessionId = sanitizeSessionId(obj.sessionId)
    const startedAt = sanitizeIsoDate(obj.startedAt, new Date(0).toISOString())!
    const updatedAt = sanitizeIsoDate(obj.updatedAt, startedAt)!
    const endedAt = sanitizeIsoDate(obj.endedAt, null)
    const cleanExit = obj.cleanExit === true
    const exitReason = obj.exitReason ? matchAllowedExitReason(obj.exitReason) : null
    const uptimeSeconds = toNonNegativeFinite(obj.uptimeSeconds)
    const heartbeatCount = toNonNegativeInt(obj.heartbeatCount)

    let mainMemoryMb: ProcessMemoryMetrics = { rssMb: 0, heapTotalMb: 0, heapUsedMb: 0 }
    if (obj.mainMemoryMb && typeof obj.mainMemoryMb === 'object') {
        const memObj = obj.mainMemoryMb as Record<string, unknown>
        mainMemoryMb = {
            rssMb: toNonNegativeFinite(memObj.rssMb),
            heapTotalMb: toNonNegativeFinite(memObj.heapTotalMb),
            heapUsedMb: toNonNegativeFinite(memObj.heapUsedMb),
            externalMb: typeof memObj.externalMb === 'number' ? toNonNegativeFinite(memObj.externalMb) : undefined,
        }
    }

    let appMetrics: AppProcessMetrics | undefined
    if (obj.appMetrics && typeof obj.appMetrics === 'object') {
        const appObj = obj.appMetrics as Record<string, unknown>
        appMetrics = {
            processCount: toNonNegativeInt(appObj.processCount),
            totalWorkingSetMb: toNonNegativeFinite(appObj.totalWorkingSetMb),
        }
    }

    const rendererLossCount = toNonNegativeInt(obj.rendererLossCount)
    const lastRendererLossReason = sanitizeStoredProcessLossString(obj.lastRendererLossReason)
    const childProcessLossCount = toNonNegativeInt(obj.childProcessLossCount)
    const lastChildLossReason = sanitizeStoredProcessLossString(obj.lastChildLossReason)

    return {
        sessionId,
        startedAt,
        updatedAt,
        endedAt,
        cleanExit,
        exitReason,
        uptimeSeconds,
        heartbeatCount,
        mainMemoryMb,
        appMetrics,
        rendererLossCount,
        lastRendererLossReason,
        childProcessLossCount,
        lastChildLossReason,
    }
}

export class RuntimeHealthService {
    private readonly fs: RuntimeHealthFs
    private readonly now: () => number
    private readonly uptime: () => number
    private readonly getMemoryUsage: () => NodeJS.MemoryUsage
    private readonly getAppMetrics: () => Array<{ type: string; memory: { workingSetSize: number } }>
    private readonly setTimeoutFn: (callback: () => void, ms: number) => NodeJS.Timeout
    private readonly clearTimeoutFn: (timer: NodeJS.Timeout) => void
    private readonly logger: (message: string, error?: unknown) => void
    private heartbeatIntervalMs: number

    private logsDir: string | null = null
    private snapshotPath: string | null = null
    private running = false
    private samplingInProgress = false
    private heartbeatTimer: NodeJS.Timeout | null = null

    private currentRecord: SessionHealthRecord | null = null
    private previousRecord: SessionHealthRecord | null = null

    constructor(deps: RuntimeHealthDependencies = {}) {
        this.fs = deps.fs ?? {
            existsSync,
            readFileSync,
            writeFileSync,
            renameSync,
            mkdirSync,
            unlinkSync,
            statSync,
        }
        this.now = deps.now ?? Date.now
        this.uptime = deps.uptime ?? process.uptime
        this.getMemoryUsage = deps.getMemoryUsage ?? process.memoryUsage
        this.getAppMetrics = deps.getAppMetrics ?? defaultGetAppMetrics
        this.setTimeoutFn = deps.setTimeout ?? setTimeout
        this.clearTimeoutFn = deps.clearTimeout ?? clearTimeout
        this.logger = deps.logger ?? ((msg, err) => {
            if (err) console.error(msg, err)
            else console.log(msg)
        })
        this.heartbeatIntervalMs = deps.heartbeatIntervalMs
            ? Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.min(MAX_HEARTBEAT_INTERVAL_MS, deps.heartbeatIntervalMs))
            : DEFAULT_HEARTBEAT_INTERVAL_MS
        if (deps.logsDir) {
            this.logsDir = deps.logsDir
        }
    }

    start(options: { logsDir?: string; heartbeatIntervalMs?: number } = {}): void {
        if (this.running) {
            return
        }

        try {
            if (typeof options.heartbeatIntervalMs === 'number' && Number.isFinite(options.heartbeatIntervalMs)) {
                this.heartbeatIntervalMs = Math.max(
                    MIN_HEARTBEAT_INTERVAL_MS,
                    Math.min(MAX_HEARTBEAT_INTERVAL_MS, options.heartbeatIntervalMs)
                )
            }

            const targetLogsDir = options.logsDir || this.logsDir || join(dataRootService.getDataRoot(), 'logs')
            this.logsDir = targetLogsDir
            this.snapshotPath = join(targetLogsDir, 'runtime-health.json')

            try {
                this.fs.mkdirSync(targetLogsDir, { recursive: true })
            } catch (mkdirErr) {
                this.safeLog('[RuntimeHealthService] Failed to create logs directory', mkdirErr)
            }

            // Bounded read and sanitization of prior snapshot
            let previous: SessionHealthRecord | null = null
            let exists = false
            try {
                exists = this.fs.existsSync(this.snapshotPath)
            } catch (existErr) {
                this.safeLog('[RuntimeHealthService] existsSync failed on snapshotPath; ignoring prior safely', existErr)
            }

            if (exists) {
                let statsValid = false
                let fileSize = 0

                if (typeof this.fs.statSync === 'function') {
                    try {
                        const stats = this.fs.statSync(this.snapshotPath)
                        if (stats && typeof stats.size === 'number' && Number.isFinite(stats.size)) {
                            fileSize = stats.size
                            statsValid = true
                        }
                    } catch (statErr) {
                        this.safeLog('[RuntimeHealthService] statSync failed on snapshotPath; ignoring prior safely', statErr)
                    }
                }

                if (!statsValid) {
                    // When statSync fails or is unavailable, do not perform unbounded read fallback; safely ignore prior
                    this.safeLog('[RuntimeHealthService] Stat validation failed; safely ignoring previous snapshot')
                    previous = {
                        sessionId: 'corrupt_prior',
                        startedAt: new Date(0).toISOString(),
                        updatedAt: new Date(this.now()).toISOString(),
                        endedAt: new Date(this.now()).toISOString(),
                        cleanExit: false,
                        exitReason: 'corrupt_snapshot',
                        uptimeSeconds: 0,
                        heartbeatCount: 0,
                        mainMemoryMb: { rssMb: 0, heapTotalMb: 0, heapUsedMb: 0 },
                        rendererLossCount: 0,
                        lastRendererLossReason: null,
                        childProcessLossCount: 0,
                        lastChildLossReason: null,
                    }
                } else if (fileSize > MAX_SNAPSHOT_BYTES) {
                    this.safeLog('[RuntimeHealthService] Prior snapshot file is oversized; ignoring content')
                    previous = {
                        sessionId: 'oversized_prior',
                        startedAt: new Date(0).toISOString(),
                        updatedAt: new Date(this.now()).toISOString(),
                        endedAt: new Date(this.now()).toISOString(),
                        cleanExit: false,
                        exitReason: 'oversized_snapshot_ignored',
                        uptimeSeconds: 0,
                        heartbeatCount: 0,
                        mainMemoryMb: { rssMb: 0, heapTotalMb: 0, heapUsedMb: 0 },
                        rendererLossCount: 0,
                        lastRendererLossReason: null,
                        childProcessLossCount: 0,
                        lastChildLossReason: null,
                    }
                } else {
                    try {
                        const raw = this.fs.readFileSync(this.snapshotPath, 'utf8')
                        const byteLen = Buffer.byteLength(raw, 'utf8')
                        if (byteLen > MAX_SNAPSHOT_BYTES) {
                            this.safeLog('[RuntimeHealthService] Read data byteLength exceeds max snapshot bytes; ignoring')
                            previous = {
                                sessionId: 'oversized_prior',
                                startedAt: new Date(0).toISOString(),
                                updatedAt: new Date(this.now()).toISOString(),
                                endedAt: new Date(this.now()).toISOString(),
                                cleanExit: false,
                                exitReason: 'oversized_snapshot_ignored',
                                uptimeSeconds: 0,
                                heartbeatCount: 0,
                                mainMemoryMb: { rssMb: 0, heapTotalMb: 0, heapUsedMb: 0 },
                                rendererLossCount: 0,
                                lastRendererLossReason: null,
                                childProcessLossCount: 0,
                                lastChildLossReason: null,
                            }
                        } else {
                            const parsed = JSON.parse(raw) as Record<string, unknown>
                            const parsedCurrent = parseAndSanitizeRecord(parsed.current)
                            const parsedPrevious = parseAndSanitizeRecord(parsed.previous)

                            if (parsedCurrent) {
                                if (parsedCurrent.cleanExit === true) {
                                    previous = parsedCurrent
                                } else {
                                    previous = {
                                        ...parsedCurrent,
                                        cleanExit: false,
                                        exitReason: parsedCurrent.exitReason || 'unknown_unclean',
                                        endedAt: parsedCurrent.endedAt || parsedCurrent.updatedAt || new Date(this.now()).toISOString(),
                                    }
                                }
                            } else if (parsedPrevious) {
                                previous = parsedPrevious
                            }
                        }
                    } catch (readErr) {
                        this.safeLog('[RuntimeHealthService] Failed to read or parse previous snapshot', readErr)
                        previous = {
                            sessionId: 'corrupt_prior',
                            startedAt: new Date(0).toISOString(),
                            updatedAt: new Date(this.now()).toISOString(),
                            endedAt: new Date(this.now()).toISOString(),
                            cleanExit: false,
                            exitReason: 'corrupt_snapshot',
                            uptimeSeconds: 0,
                            heartbeatCount: 0,
                            mainMemoryMb: { rssMb: 0, heapTotalMb: 0, heapUsedMb: 0 },
                            rendererLossCount: 0,
                            lastRendererLossReason: null,
                            childProcessLossCount: 0,
                            lastChildLossReason: null,
                        }
                    }
                }
            }

            const nowIso = new Date(this.now()).toISOString()
            this.previousRecord = previous
            this.currentRecord = {
                sessionId: generateUuid(),
                startedAt: nowIso,
                updatedAt: nowIso,
                endedAt: null,
                cleanExit: false,
                exitReason: null,
                uptimeSeconds: toNonNegativeFinite(this.uptime()),
                heartbeatCount: 0,
                mainMemoryMb: this.sampleMainMemory(),
                appMetrics: this.sampleAppMetrics(),
                rendererLossCount: 0,
                lastRendererLossReason: null,
                childProcessLossCount: 0,
                lastChildLossReason: null,
            }

            this.running = true

            // Persist initial snapshot immediately so an abrupt exit records unclean state
            this.flushSnapshot()

            // Schedule periodic non-overlapping unref heartbeat
            this.scheduleNextHeartbeat()
        } catch (fatalErr) {
            this.safeLog('[RuntimeHealthService] Fatal startup error in start(); operating in degraded mode', fatalErr)
            this.running = false
        }
    }

    stop(clean = true): void {
        if (!this.running) {
            return
        }
        this.running = false
        if (this.heartbeatTimer) {
            this.clearTimeoutFn(this.heartbeatTimer)
            this.heartbeatTimer = null
        }

        if (this.currentRecord) {
            const nowIso = new Date(this.now()).toISOString()
            this.currentRecord.updatedAt = nowIso
            this.currentRecord.endedAt = nowIso
            this.currentRecord.uptimeSeconds = toNonNegativeFinite(this.uptime())
            this.currentRecord.mainMemoryMb = this.sampleMainMemory()
            const appMetrics = this.sampleAppMetrics()
            if (appMetrics) {
                this.currentRecord.appMetrics = appMetrics
            }

            // Fatal marker must not be overwritten clean
            if (this.currentRecord.exitReason === 'uncaught_exception') {
                clean = false
            }

            if (clean) {
                this.currentRecord.cleanExit = true
                if (!this.currentRecord.exitReason) {
                    this.currentRecord.exitReason = 'clean_shutdown'
                }
            } else {
                this.currentRecord.cleanExit = false
                if (!this.currentRecord.exitReason) {
                    this.currentRecord.exitReason = 'unknown_unclean'
                }
            }
            this.flushSnapshot()
        }
    }

    recordRendererLoss(details: { reason?: unknown; exitCode?: unknown }): void {
        if (!this.currentRecord) return
        this.currentRecord.rendererLossCount += 1
        this.currentRecord.lastRendererLossReason = formatProcessLossString(details.reason, details.exitCode)
        this.currentRecord.updatedAt = new Date(this.now()).toISOString()
        this.flushSnapshot()
    }

    recordChildProcessLoss(details: { type?: unknown; reason?: unknown; exitCode?: unknown }): void {
        if (!this.currentRecord) return
        this.currentRecord.childProcessLossCount += 1
        const typePart = matchAllowedChildType(details.type)
        this.currentRecord.lastChildLossReason = formatProcessLossString(details.reason, details.exitCode, typePart)
        this.currentRecord.updatedAt = new Date(this.now()).toISOString()
        this.flushSnapshot()
    }

    recordExitReason(reason: unknown): void {
        if (!this.currentRecord) return
        this.currentRecord.exitReason = matchAllowedExitReason(reason)
        this.currentRecord.updatedAt = new Date(this.now()).toISOString()
        this.flushSnapshot()
    }

    getSnapshot(): RuntimeHealthSnapshot | null {
        if (!this.currentRecord) return null
        return {
            version: 1,
            current: this.cloneRecord(this.currentRecord),
            previous: this.previousRecord ? this.cloneRecord(this.previousRecord) : null,
        }
    }

    getSessionId(): string | null {
        return this.currentRecord?.sessionId ?? null
    }

    isRunning(): boolean {
        return this.running
    }

    private scheduleNextHeartbeat(): void {
        if (!this.running) return
        this.heartbeatTimer = this.setTimeoutFn(() => {
            this.runHeartbeat()
        }, this.heartbeatIntervalMs)
        if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref()
        }
    }

    private runHeartbeat(): void {
        if (!this.running || this.samplingInProgress) return
        this.samplingInProgress = true
        try {
            if (this.currentRecord) {
                this.currentRecord.heartbeatCount += 1
                this.currentRecord.updatedAt = new Date(this.now()).toISOString()
                this.currentRecord.uptimeSeconds = toNonNegativeFinite(this.uptime())
                this.currentRecord.mainMemoryMb = this.sampleMainMemory()
                const appMetrics = this.sampleAppMetrics()
                if (appMetrics) {
                    this.currentRecord.appMetrics = appMetrics
                }
                this.flushSnapshot()
            }
        } catch (err) {
            this.safeLog('[RuntimeHealthService] Heartbeat error', err)
        } finally {
            this.samplingInProgress = false
            if (this.running) {
                this.scheduleNextHeartbeat()
            }
        }
    }

    private flushSnapshot(): void {
        if (!this.currentRecord || !this.snapshotPath) return
        const snapshot: RuntimeHealthSnapshot = {
            version: 1,
            current: this.cloneRecord(this.currentRecord),
            previous: this.previousRecord ? this.cloneRecord(this.previousRecord) : null,
        }
        const content = JSON.stringify(snapshot, null, 2)
        if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_BYTES) {
            this.safeLog('[RuntimeHealthService] Snapshot serialization exceeds size limit, write skipped')
            return
        }

        const uniqueId = generateUuid()
        const tmpPath = `${this.snapshotPath}.${uniqueId}.tmp`

        try {
            this.fs.writeFileSync(tmpPath, content, 'utf8')
        } catch (writeErr) {
            this.safeLog('[RuntimeHealthService] Failed to write temp snapshot', writeErr)
            this.safeUnlink(tmpPath)
            return
        }

        try {
            this.fs.renameSync(tmpPath, this.snapshotPath)
        } catch (renameErr) {
            // Atomic / LKG preservation: on rename failure leave destination file untouched
            this.safeLog('[RuntimeHealthService] Rename failed, preserving existing snapshot', renameErr)
            this.safeUnlink(tmpPath)
        }
    }

    private sampleMainMemory(): ProcessMemoryMetrics {
        try {
            const mem = this.getMemoryUsage()
            const toMb = (bytes: number) => {
                const finiteBytes = toNonNegativeFinite(bytes)
                return Math.round((finiteBytes / (1024 * 1024)) * 100) / 100
            }
            return {
                rssMb: toMb(mem.rss),
                heapTotalMb: toMb(mem.heapTotal),
                heapUsedMb: toMb(mem.heapUsed),
                externalMb: typeof mem.external === 'number' ? toMb(mem.external) : undefined,
            }
        } catch {
            return { rssMb: 0, heapTotalMb: 0, heapUsedMb: 0 }
        }
    }

    private sampleAppMetrics(): AppProcessMetrics | undefined {
        try {
            const metrics = this.getAppMetrics()
            if (!Array.isArray(metrics) || metrics.length === 0) {
                return undefined
            }
            let totalWorkingSetKb = 0
            for (const item of metrics) {
                if (item && item.memory && typeof item.memory.workingSetSize === 'number') {
                    totalWorkingSetKb += toNonNegativeFinite(item.memory.workingSetSize)
                }
            }
            return {
                processCount: metrics.length,
                totalWorkingSetMb: Math.round((totalWorkingSetKb / 1024) * 100) / 100,
            }
        } catch {
            return undefined
        }
    }

    private cloneRecord(record: SessionHealthRecord): SessionHealthRecord {
        return {
            sessionId: record.sessionId,
            startedAt: record.startedAt,
            updatedAt: record.updatedAt,
            endedAt: record.endedAt,
            cleanExit: record.cleanExit,
            exitReason: record.exitReason,
            uptimeSeconds: record.uptimeSeconds,
            heartbeatCount: record.heartbeatCount,
            mainMemoryMb: { ...record.mainMemoryMb },
            appMetrics: record.appMetrics ? { ...record.appMetrics } : undefined,
            rendererLossCount: record.rendererLossCount,
            lastRendererLossReason: record.lastRendererLossReason,
            childProcessLossCount: record.childProcessLossCount,
            lastChildLossReason: record.lastChildLossReason,
        }
    }

    private safeLog(message: string, error?: unknown): void {
        try {
            this.logger(message, error)
        } catch {
            // Injected logger throwing must not escape
        }
    }

    private safeUnlink(path: string): void {
        try {
            if (this.fs.unlinkSync && this.fs.existsSync(path)) {
                this.fs.unlinkSync(path)
            }
        } catch {
            // Ignore cleanup failure
        }
    }
}

export class RendererRecoveryController {
    private attempts = 0
    private recoveryPending = false
    private readonly maxAttempts: number
    private readonly baseDelayMs: number
    private readonly maxDelayMs: number
    private readonly stableUptimeMs: number
    private readonly setTimeoutFn: (callback: () => void, ms: number) => NodeJS.Timeout
    private readonly clearTimeoutFn: (timer: NodeJS.Timeout) => void
    private readonly logger: (message: string, error?: unknown) => void

    private activeWindow: RecoverableWindow | null = null
    private stableTargetWindow: RecoverableWindow | null = null
    private recoveryTimer: NodeJS.Timeout | null = null
    private stableTimer: NodeJS.Timeout | null = null

    constructor(options: RendererRecoveryOptions = {}) {
        this.maxAttempts = options.maxAttempts ?? 3
        this.baseDelayMs = options.baseDelayMs ?? 1000
        this.maxDelayMs = options.maxDelayMs ?? 30000
        this.stableUptimeMs = options.stableUptimeMs ?? 30000
        this.setTimeoutFn = options.setTimeout ?? setTimeout
        this.clearTimeoutFn = options.clearTimeout ?? clearTimeout
        this.logger = options.logger ?? ((msg, err) => {
            if (err) console.error(msg, err)
            else console.log(msg)
        })
    }

    getActiveWindow(): RecoverableWindow | null {
        return this.activeWindow
    }

    scheduleRecovery(
        window: RecoverableWindow | null,
        reason: string,
        onReload: () => void
    ): boolean {
        if (!window || window.isDestroyed()) {
            this.safeLog('[RendererRecovery] Window destroyed or null, skipping recovery')
            return false
        }

        // If window identity changed, reset attempts and timers for new window
        if (this.activeWindow && this.activeWindow !== window) {
            this.clearRecoveryTimer()
            this.clearStableTimer()
            this.attempts = 0
        }
        this.activeWindow = window
        this.clearStableTimer()

        if (this.attempts >= this.maxAttempts) {
            this.safeLog(
                `[RendererRecovery] Max recovery attempts reached (${this.attempts}/${this.maxAttempts}). ` +
                `Suppressing reload loop for reason: ${reason}`
            )
            return false
        }

        const delay = Math.min(
            this.baseDelayMs * Math.pow(2, this.attempts),
            this.maxDelayMs
        )
        const attemptNumber = this.attempts + 1
        this.attempts = attemptNumber
        this.recoveryPending = true

        this.clearRecoveryTimer()

        this.safeLog(
            `[RendererRecovery] Scheduling reload attempt ${attemptNumber}/${this.maxAttempts} ` +
            `in ${delay}ms for reason: ${reason}`
        )

        this.recoveryTimer = this.setTimeoutFn(() => {
            this.recoveryTimer = null
            this.recoveryPending = false

            // Guard stale window identity
            if (!window || window.isDestroyed() || window !== this.activeWindow) {
                this.safeLog('[RendererRecovery] Window destroyed or changed before reload timer fired, aborting')
                return
            }
            if (window.webContents && window.webContents.isDestroyed()) {
                this.safeLog('[RendererRecovery] webContents destroyed before reload timer fired, aborting')
                return
            }

            try {
                this.safeLog(`[RendererRecovery] Executing reload attempt ${attemptNumber}`)
                onReload()
            } catch (err) {
                this.safeLog('[RendererRecovery] Error executing reload', err)
            }
        }, delay)

        if (this.recoveryTimer && typeof this.recoveryTimer.unref === 'function') {
            this.recoveryTimer.unref()
        }

        return true
    }

    onRendererLoaded(window: RecoverableWindow | null): void {
        if (!window || window.isDestroyed()) return
        if (this.activeWindow && window !== this.activeWindow) {
            return
        }
        this.activeWindow = window
        this.stableTargetWindow = window
        this.clearRecoveryTimer()
        this.clearStableTimer()

        this.stableTimer = this.setTimeoutFn(() => {
            this.stableTimer = null
            // Guard stable-timer target identity
            if (
                this.stableTargetWindow &&
                this.stableTargetWindow === this.activeWindow &&
                !this.stableTargetWindow.isDestroyed()
            ) {
                if (this.attempts > 0) {
                    this.safeLog(
                        `[RendererRecovery] Stable uptime achieved (${this.stableUptimeMs}ms). ` +
                        `Resetting recovery attempts from ${this.attempts} to 0`
                    )
                    this.attempts = 0
                }
            }
            this.stableTargetWindow = null
        }, this.stableUptimeMs)

        if (this.stableTimer && typeof this.stableTimer.unref === 'function') {
            this.stableTimer.unref()
        }
    }

    onWindowClosed(window: RecoverableWindow | null): void {
        if (!window) return
        if (this.activeWindow === window) {
            this.dispose()
        }
    }

    dispose(): void {
        this.clearRecoveryTimer()
        this.clearStableTimer()
        this.activeWindow = null
        this.stableTargetWindow = null
        this.recoveryPending = false
    }

    reset(): void {
        this.dispose()
        this.attempts = 0
    }

    getAttempts(): number {
        return this.attempts
    }

    isRecoveryPending(): boolean {
        return this.recoveryPending
    }

    private clearRecoveryTimer(): void {
        if (this.recoveryTimer) {
            this.clearTimeoutFn(this.recoveryTimer)
            this.recoveryTimer = null
        }
    }

    private clearStableTimer(): void {
        if (this.stableTimer) {
            this.clearTimeoutFn(this.stableTimer)
            this.stableTimer = null
        }
    }

    private safeLog(message: string, error?: unknown): void {
        try {
            this.logger(message, error)
        } catch {
            // Injected logger throwing must not escape
        }
    }
}

export const runtimeHealthService = new RuntimeHealthService()
export const rendererRecoveryController = new RendererRecoveryController()
