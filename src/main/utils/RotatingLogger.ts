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

const loggerCache = new Map<string, RotatingLogger>()

function normalizeMaxSize(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SIZE_BYTES
    return Math.floor(value)
}

function normalizeMaxBackups(value: number): number {
    if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_BACKUPS
    return Math.floor(value)
}

function isErrno(error: unknown, code: string): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false
    return (error as { code?: unknown }).code === code
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error('RotatingLogger write failed')
}

/**
 * Size-based log writer. Appends go through a WriteStream so the main thread
 * is not blocked on every line. Byte length is tracked in memory; statSync
 * runs only once, when the logger is constructed.
 * Rotation closes the owned fd only after in-flight writes finish, then
 * renameSync shifts backups. That keeps Windows from locking the active file.
 */
export class RotatingLogger {
    private readonly filePath: string
    private readonly maxSizeBytes: number
    private readonly maxBackups: number
    private bytesWritten: number
    private stream: WriteStream | null
    private fd: number | null
    private inFlight: number
    private pendingRotate: boolean
    private closing: boolean
    private readonly queue: string[]

    constructor(
        filePath: string,
        maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
        maxBackups: number = DEFAULT_MAX_BACKUPS,
    ) {
        this.filePath = filePath
        this.maxSizeBytes = normalizeMaxSize(maxSizeBytes)
        this.maxBackups = normalizeMaxBackups(maxBackups)
        this.bytesWritten = 0
        this.stream = null
        this.fd = null
        this.inFlight = 0
        this.pendingRotate = false
        this.closing = false
        this.queue = []
        this.prepareFile()
        this.openStream()
    }

    write(line: string): void {
        try {
            if (this.closing || this.pendingRotate) {
                this.queue.push(line)
                return
            }
            const size = Buffer.byteLength(line, 'utf8')
            if (this.bytesWritten >= this.maxSizeBytes && this.bytesWritten > 0) {
                this.rotate()
                if (this.pendingRotate || this.closing) {
                    this.queue.push(line)
                    return
                }
            }
            this.writeToStream(line, size)
        } catch (error) {
            console.error('[RotatingLogger] write failed:', error)
            console.error(line)
        }
    }

    rotate(): void {
        if (this.closing || this.pendingRotate) return
        if (this.inFlight > 0) {
            // renameSync while a write syscall is in flight fails on Windows and can drop bytes.
            this.pendingRotate = true
            return
        }
        this.finishRotate()
    }

    close(): void {
        if (this.closing) return
        this.closing = true
        this.pendingRotate = false
        this.drainThenClose()
    }

    private prepareFile(): void {
        try {
            this.ensureDirectory()
            this.bytesWritten = this.readExistingSize()
            if (this.bytesWritten >= this.maxSizeBytes) {
                this.shiftBackups()
                this.bytesWritten = 0
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
        let fd: number | null = null
        try {
            this.ensureDirectory()
            fd = openSync(this.filePath, 'a')
            const stream = createWriteStream(this.filePath, {
                fd,
                autoClose: false,
                encoding: 'utf8',
            })
            this.bindStream(stream, fd)
        } catch (error) {
            console.error('[RotatingLogger] open failed:', error)
            this.stream = null
            this.fd = null
            this.closeFd(fd)
        }
    }

    private bindStream(stream: WriteStream, fd: number): void {
        stream.on('error', (error: Error) => {
            console.error(`[RotatingLogger] stream error (${this.filePath}):`, error)
        })
        this.stream = stream
        this.fd = fd
    }

    private writeToStream(line: string, size: number): void {
        if (!this.stream || this.stream.destroyed || this.stream.writableEnded) {
            this.openStream()
        }
        const stream = this.stream
        if (!stream) {
            console.error('[RotatingLogger] dropped log line:', line)
            return
        }

        this.inFlight += 1
        this.bytesWritten += size
        let settled = false
        const finish = (error: Error | null) => {
            if (settled) return
            settled = true
            // Let write() return before rotate/close so a sync callback cannot re-enter.
            queueMicrotask(() => {
                this.onWriteSettled(error)
            })
        }

        try {
            stream.write(line, (error) => {
                finish(error ?? null)
            })
        } catch (error) {
            this.bytesWritten -= size
            finish(toError(error))
        }
    }

    private onWriteSettled(error: Error | null): void {
        this.inFlight = Math.max(0, this.inFlight - 1)
        if (error) {
            console.error('[RotatingLogger] stream write failed:', error)
        }
        if (this.inFlight > 0) return
        if (this.closing) {
            this.drainThenClose()
            return
        }
        if (this.pendingRotate) {
            this.finishRotate()
        }
    }

    private finishRotate(): void {
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
        this.flushQueue()
    }

    private flushQueue(): void {
        while (this.queue.length > 0 && !this.pendingRotate && !this.closing) {
            const next = this.queue.shift()
            if (next === undefined) return
            this.write(next)
        }
    }

    private drainThenClose(): void {
        if (this.inFlight > 0) return
        while (this.queue.length > 0) {
            const next = this.queue.shift()
            if (next === undefined) break
            this.writeToStream(next, Buffer.byteLength(next, 'utf8'))
            if (this.inFlight > 0) return
        }
        if (this.inFlight > 0) return
        this.releaseStream()
        this.closing = false
    }

    private releaseStream(): void {
        const { stream, fd } = this.detachStream()
        // Close the fd before destroy so Windows can rename immediately.
        // destroy() also closes; its EBADF is expected and ignored.
        this.closeFd(fd)
        if (!stream || stream.destroyed) return
        this.swallowStreamError(stream, 'stream close error')
        try {
            stream.destroy()
        } catch (error) {
            console.error('[RotatingLogger] destroy failed:', error)
        }
    }

    private detachStream(): { stream: WriteStream | null; fd: number | null } {
        const stream = this.stream
        const fd = this.fd
        this.stream = null
        this.fd = null
        return { stream, fd }
    }

    private swallowStreamError(stream: WriteStream, label: string): void {
        stream.removeAllListeners('error')
        stream.on('error', (error: Error) => {
            if (isErrno(error, 'EBADF')) return
            console.error(`[RotatingLogger] ${label}:`, error.message)
        })
    }

    private closeFd(fd: number | null): void {
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

export function getRotatingLogger(name: string, filePath: string): RotatingLogger {
    const cached = loggerCache.get(name)
    if (cached) return cached
    const created = new RotatingLogger(filePath)
    loggerCache.set(name, created)
    return created
}
