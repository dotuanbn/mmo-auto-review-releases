import {
    closeSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    openSync,
    renameSync,
    statSync,
    unlinkSync,
    type WriteStream,
} from 'fs'
import { dirname } from 'path'

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_BACKUPS = 3
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 // 64 KB
const DEFAULT_MAX_QUEUE_ENTRIES = 1000
const DEFAULT_MAX_QUEUE_BYTES = 1 * 1024 * 1024 // 1 MB
const DEFAULT_MAX_IN_FLIGHT_BYTES = 256 * 1024 // 256 KB
const MAX_CONSECUTIVE_ERRORS = 3

export type StreamFactory = (
    filePath: string,
    options: { fd: number | null; flags?: string; encoding?: BufferEncoding; autoClose?: boolean }
) => WriteStream

export interface RotatingLoggerOptions {
    maxLineBytes?: number
    maxQueueEntries?: number
    maxQueueBytes?: number
    maxInFlight?: number
    maxInFlightBytes?: number
    streamFactory?: StreamFactory
}

export interface RotatingLoggerStats {
    filePath: string
    bytesWritten: number
    inFlight: number
    inFlightBytes: number
    queueLength: number
    queueBytes: number
    droppedCount: number
    droppedBytes: number
    isDraining: boolean
    closing: boolean
    pendingRotate: boolean
}

interface QueueItem {
    line: string
    size: number
}

interface ActiveWrite {
    size: number
    settled: boolean
}

interface StreamWithFd extends WriteStream {
    fd?: number | null
}

const loggerCache = new Map<string, RotatingLogger>()

function normalizeMaxSize(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SIZE_BYTES
    return Math.max(1, Math.floor(value))
}

function normalizeMaxBackups(value: number): number {
    if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_BACKUPS
    return Math.floor(value)
}

function normalizePositiveInt(value: number | undefined, defaultValue: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultValue
    return Math.max(1, Math.floor(value))
}

function isErrno(error: unknown, code: string): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false
    return (error as { code?: unknown }).code === code
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error('RotatingLogger write failed')
}

function truncateToByteLength(str: string, maxBytes: number): string {
    if (maxBytes <= 0) return ''
    // Slice by character length first so a multi-megabyte line is not copied whole.
    const candidate = str.length > maxBytes ? str.slice(0, maxBytes) : str
    const buf = Buffer.from(candidate, 'utf8')
    if (buf.byteLength <= maxBytes) return candidate
    let end = maxBytes
    let sub = buf.subarray(0, end).toString('utf8')
    while (Buffer.byteLength(sub, 'utf8') > maxBytes && end > 0) {
        end -= 1
        sub = buf.subarray(0, end).toString('utf8')
    }
    return sub
}

/**
 * Size-based log writer with one stream write in flight.
 * Pending entries and bytes (queued plus that single write) stay finite.
 * The owned fd is closed only after the active write callback settles, so a
 * Windows rename cannot reuse the descriptor under a live write.
 */
export class RotatingLogger {
    private readonly filePath: string
    private readonly maxSizeBytes: number
    private readonly maxBackups: number
    private readonly maxLineBytes: number
    private readonly maxQueueEntries: number
    private readonly maxQueueBytes: number
    private readonly maxInFlightBytes: number
    private readonly effectiveMaxLineBytes: number
    private readonly streamFactory?: StreamFactory

    private bytesWritten: number
    private stream: WriteStream | null
    private fd: number | null
    private generation: number
    private activeWrite: ActiveWrite | null
    private inFlight: number
    private inFlightBytes: number
    private queueBytes: number
    private pendingRotate: boolean
    private closing: boolean
    private needDrain: boolean
    private pausedForErrors: boolean
    private consecutiveErrors: number
    private droppedCount: number
    private droppedBytes: number
    private readonly queue: QueueItem[]

    constructor(
        filePath: string,
        maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
        maxBackups: number = DEFAULT_MAX_BACKUPS,
        options?: RotatingLoggerOptions,
    ) {
        this.filePath = filePath
        this.maxSizeBytes = normalizeMaxSize(maxSizeBytes)
        this.maxBackups = normalizeMaxBackups(maxBackups)
        this.maxLineBytes = normalizePositiveInt(options?.maxLineBytes, DEFAULT_MAX_LINE_BYTES)
        this.maxQueueEntries = normalizePositiveInt(options?.maxQueueEntries, DEFAULT_MAX_QUEUE_ENTRIES)
        this.maxQueueBytes = normalizePositiveInt(options?.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES)
        // maxInFlight is accepted for compatibility. One write is within every positive bound.
        this.maxInFlightBytes = normalizePositiveInt(options?.maxInFlightBytes, DEFAULT_MAX_IN_FLIGHT_BYTES)
        this.streamFactory = options?.streamFactory
        this.effectiveMaxLineBytes = Math.max(
            1,
            Math.min(this.maxLineBytes, this.maxQueueBytes, this.maxInFlightBytes),
        )

        this.bytesWritten = 0
        this.stream = null
        this.fd = null
        this.generation = 0
        this.activeWrite = null
        this.inFlight = 0
        this.inFlightBytes = 0
        this.queueBytes = 0
        this.pendingRotate = false
        this.closing = false
        this.needDrain = false
        this.pausedForErrors = false
        this.consecutiveErrors = 0
        this.droppedCount = 0
        this.droppedBytes = 0
        this.queue = []

        this.prepareFile()
        this.openStream()
    }

    write(line: string): void {
        try {
            if (this.closing) return
            // A later explicit write may recover after persistent I/O errors. Queued
            // retries are not started on their own, so a failing disk cannot spin.
            if (this.pausedForErrors) {
                this.pausedForErrors = false
                this.consecutiveErrors = 0
            }
            const prepared = this.sanitizeLine(line)
            if (prepared.size <= 0) return
            if (
                this.pendingEntries() >= this.maxQueueEntries ||
                this.pendingBytes() + prepared.size > this.maxQueueBytes
            ) {
                this.noteDrop(prepared.size)
                return
            }
            this.queue.push(prepared)
            this.queueBytes += prepared.size
            this.pump()
        } catch (error) {
            console.error('[RotatingLogger] write failed:', error)
        }
    }

    rotate(): void {
        if (this.closing || this.pendingRotate) return
        this.pendingRotate = true
        if (!this.activeWrite) this.performRotate()
    }

    close(): void {
        if (this.closing) return
        this.closing = true
        this.pendingRotate = false
        if (this.pausedForErrors) {
            this.dropQueued()
            if (!this.activeWrite) this.finishClose()
            return
        }
        this.pump()
    }

    getStats(): RotatingLoggerStats {
        return {
            filePath: this.filePath,
            bytesWritten: this.bytesWritten,
            inFlight: this.inFlight,
            inFlightBytes: this.inFlightBytes,
            queueLength: this.queue.length,
            queueBytes: this.queueBytes,
            droppedCount: this.droppedCount,
            droppedBytes: this.droppedBytes,
            isDraining: this.needDrain,
            closing: this.closing,
            pendingRotate: this.pendingRotate,
        }
    }

    private pendingEntries(): number {
        return this.queue.length + this.inFlight
    }

    private pendingBytes(): number {
        return this.queueBytes + this.inFlightBytes
    }

    private sanitizeLine(line: string): QueueItem {
        const limit = this.effectiveMaxLineBytes
        if (line.length <= limit && Buffer.byteLength(line, 'utf8') <= limit) {
            return { line, size: Buffer.byteLength(line, 'utf8') }
        }
        const fullMarker = ' ... [truncated]\n'
        const fullMarkerBytes = Buffer.byteLength(fullMarker, 'utf8')
        let marker = fullMarker
        if (limit < fullMarkerBytes) marker = truncateToByteLength(fullMarker, limit)
        const markerBytes = Buffer.byteLength(marker, 'utf8')
        const contentBudget = Math.max(0, limit - markerBytes)
        const content = contentBudget > 0 ? truncateToByteLength(line, contentBudget) : ''
        const text = content + marker
        return { line: text, size: Buffer.byteLength(text, 'utf8') }
    }

    private noteDrop(size: number): void {
        this.droppedCount += 1
        this.droppedBytes += size
    }

    private dropQueued(): void {
        if (this.queue.length === 0) return
        this.droppedCount += this.queue.length
        this.droppedBytes += this.queueBytes
        this.queue.length = 0
        this.queueBytes = 0
    }

    private maybeQueueNotice(): void {
        if (this.droppedCount <= 0) return
        const raw = `[RotatingLogger] dropped ${this.droppedCount} log line(s) (${this.droppedBytes} bytes) due to backpressure\n`
        const notice = this.sanitizeLine(raw)
        if (notice.size <= 0 || notice.size > this.maxInFlightBytes || notice.size > this.maxQueueBytes) return
        if (this.pendingEntries() + 1 > this.maxQueueEntries) return
        if (this.pendingBytes() + notice.size > this.maxQueueBytes) return
        // Clear before enqueue so a notice that itself cannot be written cannot
        // recurse into another notice carrying the same payload.
        this.droppedCount = 0
        this.droppedBytes = 0
        this.queue.unshift(notice)
        this.queueBytes += notice.size
    }

    private pump(): void {
        if (this.activeWrite || this.needDrain) return
        if (this.pausedForErrors && !this.closing) return
        if (!this.closing && this.pendingRotate) {
            this.performRotate()
            return
        }
        this.maybeQueueNotice()
        if (this.queue.length === 0) {
            if (this.closing) this.finishClose()
            return
        }
        // Rotate only when another accepted line is waiting, so the last successful
        // line remains in the active file instead of an empty trailing rotation.
        if (!this.closing && this.bytesWritten >= this.maxSizeBytes && this.bytesWritten > 0) {
            this.pendingRotate = true
            this.performRotate()
            return
        }
        const next = this.queue[0]
        if (!next) return
        if (next.size > this.maxInFlightBytes || next.size > this.effectiveMaxLineBytes) {
            this.queue.shift()
            this.queueBytes = Math.max(0, this.queueBytes - next.size)
            this.noteDrop(next.size)
            this.pump()
            return
        }
        this.queue.shift()
        this.queueBytes = Math.max(0, this.queueBytes - next.size)
        this.startWrite(next)
    }

    private startWrite(item: QueueItem): void {
        if (!this.stream || this.stream.destroyed || this.stream.writableEnded) this.openStream()
        const stream = this.stream
        if (!stream) {
            this.consecutiveErrors += 1
            if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                this.dropQueued()
                this.pausedForErrors = true
                if (this.closing) this.finishClose()
                return
            }
            queueMicrotask(() => this.pump())
            return
        }

        const active: ActiveWrite = { size: item.size, settled: false }
        this.activeWrite = active
        this.inFlight = 1
        this.inFlightBytes = item.size

        const finish = (error: Error | null) => {
            if (active.settled) return
            active.settled = true
            queueMicrotask(() => {
                // Identity, not generation: a retired callback must not clear a newer write,
                // and a generation bump must not strand this write's counters.
                if (this.activeWrite !== active) return
                this.completeWrite(error, active)
            })
        }

        try {
            const canContinue = stream.write(item.line, (error?: Error | null) => {
                finish(error ?? null)
            })
            if (!canContinue) {
                this.needDrain = true
                stream.once('drain', () => {
                    if (this.stream !== stream) return
                    this.needDrain = false
                    this.pump()
                })
            }
        } catch (error) {
            finish(toError(error))
        }
    }

    private completeWrite(error: Error | null, active: ActiveWrite): void {
        if (this.activeWrite !== active) return
        this.activeWrite = null
        this.inFlight = 0
        this.inFlightBytes = 0

        if (error) {
            this.consecutiveErrors += 1
            if (this.consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
                console.error('[RotatingLogger] stream write failed:', error.message)
            }
            this.releaseStream()
            if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                this.dropQueued()
                this.pausedForErrors = true
                if (this.closing) this.finishClose()
                return
            }
            if (this.closing && this.queue.length === 0) {
                this.finishClose()
                return
            }
            this.pump()
            return
        }

        this.bytesWritten += active.size
        this.consecutiveErrors = 0
        if (this.needDrain) {
            if (this.closing && this.queue.length === 0) this.finishClose()
            return
        }
        this.pump()
    }

    private performRotate(): void {
        if (this.activeWrite) {
            this.pendingRotate = true
            return
        }
        if (this.bytesWritten === 0 && this.readExistingSize() === 0) {
            this.pendingRotate = false
            this.pump()
            return
        }
        this.pendingRotate = true
        try {
            this.releaseStream()
            if (!this.shiftBackups()) {
                console.error('[RotatingLogger] rotate did not move the active file:', this.filePath)
            }
            this.bytesWritten = 0
            this.openStream()
        } catch (error) {
            console.error('[RotatingLogger] rotate failed:', error)
            this.openStream()
        } finally {
            this.pendingRotate = false
        }
        this.pump()
    }

    private finishClose(): void {
        if (this.activeWrite) return
        this.releaseStream()
        this.pendingRotate = false
        this.closing = false
    }

    private prepareFile(): void {
        if (this.streamFactory) {
            this.bytesWritten = 0
            return
        }
        try {
            this.ensureDirectory()
            const existing = this.readExistingSize()
            if (existing >= this.maxSizeBytes && existing > 0) {
                this.shiftBackups()
                this.bytesWritten = 0
            } else {
                this.bytesWritten = existing
            }
        } catch (error) {
            console.error('[RotatingLogger] prepare failed:', error)
            this.bytesWritten = 0
        }
    }

    private ensureDirectory(): void {
        try {
            const dir = dirname(this.filePath)
            if (!dir || existsSync(dir)) return
            mkdirSync(dir, { recursive: true })
        } catch (error) {
            console.error('[RotatingLogger] mkdir failed:', error)
        }
    }

    private readExistingSize(): number {
        try {
            if (!existsSync(this.filePath)) return 0
            const size = statSync(this.filePath).size
            return Number.isFinite(size) && size > 0 ? size : 0
        } catch (error) {
            console.error('[RotatingLogger] stat failed:', error)
            return 0
        }
    }

    private openStream(): void {
        if (this.stream && !this.stream.destroyed && !this.stream.writableEnded) return
        this.releaseStream()
        try {
            if (this.streamFactory) {
                const stream = this.streamFactory(this.filePath, {
                    fd: null,
                    flags: 'a',
                    encoding: 'utf8',
                    autoClose: false,
                })
                this.bindStream(stream, null)
                return
            }
            this.ensureDirectory()
            const numericFd = openSync(this.filePath, 'a')
            try {
                const stream = createWriteStream(this.filePath, {
                    fd: numericFd,
                    autoClose: false,
                    encoding: 'utf8',
                })
                this.bindStream(stream, numericFd)
            } catch (error) {
                this.closeOwnedFd(numericFd)
                throw error
            }
        } catch (error) {
            console.error('[RotatingLogger] open failed:', error)
            this.stream = null
            this.fd = null
        }
    }

    private bindStream(stream: WriteStream, fd: number | null): void {
        this.generation += 1
        const generation = this.generation
        this.stream = stream
        this.fd = fd
        this.needDrain = false
        stream.on('error', (error: Error) => {
            if (this.stream !== stream || this.generation !== generation) return
            if (isErrno(error, 'EBADF')) return
            const active = this.activeWrite
            if (active) {
                // The write callback owns settlement once it has been scheduled.
                // Releasing here would bump generation and leave inFlight stuck.
                if (!active.settled) {
                    active.settled = true
                    this.completeWrite(error, active)
                }
                return
            }
            if (this.consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
                console.error(`[RotatingLogger] stream error (${this.filePath}):`, error.message)
            }
            this.consecutiveErrors += 1
            this.releaseStream()
            if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                this.dropQueued()
                this.pausedForErrors = true
                if (this.closing) this.finishClose()
            }
        })
        stream.on('close', () => {
            if (this.stream !== stream || this.generation !== generation) return
            this.needDrain = false
            const active = this.activeWrite
            if (!active || active.settled) return
            // The handle went away without a write callback. Settle so counters cannot stick.
            active.settled = true
            this.completeWrite(new Error('log stream closed'), active)
        })
    }

    private releaseStream(): void {
        const stream = this.stream
        const fd = this.fd
        this.stream = null
        this.fd = null
        this.needDrain = false
        this.generation += 1
        if (stream && !stream.destroyed) {
            stream.removeAllListeners('error')
            stream.removeAllListeners('drain')
            stream.on('error', (error: Error) => {
                if (isErrno(error, 'EBADF')) return
                console.error('[RotatingLogger] stream close error:', error.message)
            })
            if (typeof fd === 'number') {
                // Node closes stream.fd from _destroy. Null it first so a late async
                // close cannot hit a descriptor number reused by the replacement file.
                try {
                    (stream as StreamWithFd).fd = null
                } catch (error) {
                    console.error('[RotatingLogger] detach fd failed:', error)
                }
            }
            try {
                stream.destroy()
            } catch (error) {
                console.error('[RotatingLogger] destroy failed:', error)
            }
        }
        this.closeOwnedFd(fd)
    }

    private closeOwnedFd(fd: number | null): void {
        if (typeof fd !== 'number') return
        try {
            closeSync(fd)
        } catch (error) {
            if (!isErrno(error, 'EBADF')) {
                console.error('[RotatingLogger] closeSync failed:', error)
            }
        }
    }

    private shiftBackups(): boolean {
        try {
            if (this.maxBackups < 1) {
                this.removeIfExists(this.filePath)
                return !existsSync(this.filePath)
            }
            this.removeIfExists(`${this.filePath}.${this.maxBackups}`)
            for (let index = this.maxBackups - 1; index >= 1; index -= 1) {
                this.renameIfExists(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`)
            }
            this.renameIfExists(this.filePath, `${this.filePath}.1`)
            return !existsSync(this.filePath)
        } catch (error) {
            console.error('[RotatingLogger] shift backups failed:', error)
            return false
        }
    }

    private renameIfExists(from: string, to: string): void {
        if (!existsSync(from)) return
        try {
            // Windows renameSync does not replace an existing destination.
            if (existsSync(to)) unlinkSync(to)
            renameSync(from, to)
        } catch (error) {
            console.error(`[RotatingLogger] rename failed (${from} -> ${to}):`, error)
        }
    }

    private removeIfExists(target: string): void {
        if (!existsSync(target)) return
        try {
            unlinkSync(target)
        } catch (error) {
            console.error('[RotatingLogger] unlink failed:', target, error)
        }
    }
}

export function getRotatingLogger(
    name: string,
    filePath: string,
    options?: RotatingLoggerOptions,
): RotatingLogger {
    const cached = loggerCache.get(name)
    if (cached) return cached
    const created = new RotatingLogger(filePath, DEFAULT_MAX_SIZE_BYTES, DEFAULT_MAX_BACKUPS, options)
    loggerCache.set(name, created)
    return created
}

export function resetRotatingLoggerCacheForTests(): void {
    const loggers = Array.from(loggerCache.values())
    for (let index = 0; index < loggers.length; index += 1) {
        try {
            loggers[index].close()
        } catch {
            // Ignore close errors during test cleanup.
        }
    }
    loggerCache.clear()
}
