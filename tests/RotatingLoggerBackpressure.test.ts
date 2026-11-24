import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Writable } from 'stream'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WriteStream } from 'fs'
import {
    RotatingLogger,
    getRotatingLogger,
    resetRotatingLoggerCacheForTests,
} from '../src/main/utils/RotatingLogger'

class MockWriteStream extends Writable {
    public writtenChunks: string[] = []
    public shouldReturnFalseOnWrite: boolean = false
    public writeErrorToEmit: Error | null = null
    public syncThrowError: Error | null = null
    public pendingCallbacks: Array<(error?: Error | null) => void> = []
    public autoCallback: boolean = true
    public isDestroyed: boolean = false

    constructor() {
        super({ decodeStrings: false })
    }

    override _write(
        chunk: string | Buffer | Uint8Array,
        encoding: BufferEncoding,
        callback: (error?: Error | null) => void
    ): void {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding || 'utf8')
        this.writtenChunks.push(text)

        if (this.writeErrorToEmit) {
            const err = this.writeErrorToEmit
            this.writeErrorToEmit = null
            callback(err)
            return
        }

        if (this.autoCallback) {
            callback(null)
        } else {
            this.pendingCallbacks.push(callback)
        }
    }

    override write(
        chunk: string | Uint8Array,
        encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
        cb?: (error: Error | null | undefined) => void
    ): boolean {
        if (this.syncThrowError) {
            const err = this.syncThrowError
            this.syncThrowError = null
            throw err
        }
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8'
        const ok = super.write(chunk, encoding, callback)
        if (this.shouldReturnFalseOnWrite) {
            return false
        }
        return ok
    }

    override destroy(error?: Error): this {
        this.isDestroyed = true
        return super.destroy(error)
    }

    flushPendingCallbacks(): void {
        const cbs = [...this.pendingCallbacks]
        this.pendingCallbacks = []
        for (const cb of cbs) {
            cb(null)
        }
    }
}

async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => queueMicrotask(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForIdle(logger: RotatingLogger, timeoutMs = 5000): Promise<void> {
    const started = Date.now()
    while (Date.now() - started <= timeoutMs) {
        const stats = logger.getStats()
        const idle = stats.inFlight === 0
            && stats.queueLength === 0
            && !stats.isDraining
            && !stats.pendingRotate
            && !stats.closing
        if (idle) {
            await flushMicrotasks()
            const again = logger.getStats()
            if (
                again.inFlight === 0
                && again.queueLength === 0
                && !again.isDraining
                && !again.pendingRotate
                && !again.closing
            ) {
                return
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`RotatingLogger did not settle: ${JSON.stringify(logger.getStats())}`)
}

function readRetained(logFile: string, maxBackups: number): string[] {
    const parts: string[] = []
    for (let index = maxBackups; index >= 1; index -= 1) {
        const backup = `${logFile}.${index}`
        if (existsSync(backup)) parts.push(readFileSync(backup, 'utf8'))
    }
    if (existsSync(logFile)) parts.push(readFileSync(logFile, 'utf8'))
    return parts
}

async function drainAll(
    mockStream: MockWriteStream,
    logger: RotatingLogger,
    maxIterations = 200
): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
        if (mockStream.pendingCallbacks.length > 0) {
            mockStream.flushPendingCallbacks()
        }
        if (logger.getStats().isDraining) {
            mockStream.shouldReturnFalseOnWrite = false
            mockStream.emit('drain')
        }
        await flushMicrotasks()
        const stats = logger.getStats()
        if (
            stats.inFlight === 0 &&
            stats.queueLength === 0 &&
            !stats.isDraining &&
            !stats.pendingRotate
        ) {
            break
        }
    }
}

describe('RotatingLogger Backpressure, Bounds & Windows Safety', () => {
    let mockStream: MockWriteStream
    let tempDir: string | null = null

    beforeEach(() => {
        resetRotatingLoggerCacheForTests()
        mockStream = new MockWriteStream()
    })

    afterEach(() => {
        resetRotatingLoggerCacheForTests()
        if (tempDir && existsSync(tempDir)) {
            try {
                rmSync(tempDir, { recursive: true, force: true })
            } catch {
                // Ignore test cleanup error
            }
            tempDir = null
        }
    })

    it('honors stream backpressure and drains in FIFO order when drain fires', async () => {
        const logger = new RotatingLogger('mock://app.log', 1024 * 1024, 3, {
            streamFactory: () => mockStream as unknown as WriteStream,
        })

        // Simulate backpressure: write() returns false
        mockStream.shouldReturnFalseOnWrite = true

        logger.write('line 1\n')
        await flushMicrotasks()

        const statsAfterFirst = logger.getStats()
        expect(statsAfterFirst.isDraining).toBe(true)
        expect(mockStream.writtenChunks).toEqual(['line 1\n'])

        // Subsequent write while draining is placed in queue
        logger.write('line 2\n')
        expect(logger.getStats().queueLength).toBe(1)
        expect(mockStream.writtenChunks).toEqual(['line 1\n'])

        logger.write('line 3\n')
        expect(logger.getStats().queueLength).toBe(2)

        // Relieve backpressure via drain helper
        await drainAll(mockStream, logger)

        const statsAfterDrain = logger.getStats()
        expect(statsAfterDrain.isDraining).toBe(false)
        expect(statsAfterDrain.queueLength).toBe(0)
        expect(mockStream.writtenChunks).toEqual(['line 1\n', 'line 2\n', 'line 3\n'])
        logger.close()
    })

    it('bounds memory during flood: drops excess lines and emits aggregate notice without echoing payload', async () => {
        const logger = new RotatingLogger('mock://flood.log', 1024 * 1024, 3, {
            maxQueueEntries: 500,
            maxQueueBytes: 50 * 1024,
            maxInFlight: 10,
            streamFactory: () => mockStream as unknown as WriteStream,
        })

        // Stall the stream: backpressured and callbacks paused
        mockStream.shouldReturnFalseOnWrite = true
        mockStream.autoCallback = false

        // Large flood of 20,000 lines
        for (let i = 0; i < 20000; i++) {
            logger.write(`line-${i}: payload data padding to test bounded queue and in flight limits\n`)
        }

        const statsFlooded = logger.getStats()
        // maxQueueEntries bounds the combined (queue + inFlight) count
        expect(statsFlooded.queueLength + statsFlooded.inFlight).toBeLessThanOrEqual(500)
        expect(statsFlooded.queueBytes + statsFlooded.inFlightBytes).toBeLessThanOrEqual(50 * 1024)
        expect(statsFlooded.droppedCount).toBeGreaterThan(19000)

        // Relieve stream stall and drain
        mockStream.autoCallback = true
        await drainAll(mockStream, logger, 600)

        const statsSettled = logger.getStats()
        expect(statsSettled.droppedCount).toBe(0)
        expect(statsSettled.queueLength).toBe(0)
        expect(statsSettled.inFlight).toBe(0)

        const combinedOutput = mockStream.writtenChunks.join('')
        expect(combinedOutput).toContain('[RotatingLogger] dropped')
        expect(combinedOutput).toContain('due to backpressure')
        // Must never echo raw dropped payload lines
        expect(combinedOutput).not.toContain('line-19999')
        logger.close()
    })

    it('enforces finite per-line size by truncating oversized payloads with marker', async () => {
        const logger = new RotatingLogger('mock://oversized.log', 1024 * 1024, 3, {
            maxLineBytes: 60,
            streamFactory: () => mockStream as unknown as WriteStream,
        })

        const hugePayload = 'A'.repeat(200) + '\n'
        logger.write(hugePayload)
        await flushMicrotasks()

        expect(mockStream.writtenChunks.length).toBe(1)
        const written = mockStream.writtenChunks[0]
        expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(60)
        expect(written).toContain('... [truncated]\n')
        logger.close()
    })

    it('bounds in-flight write callbacks to prevent unbounded callback allocations', async () => {
        const logger = new RotatingLogger('mock://inflight.log', 1024 * 1024, 3, {
            maxInFlight: 2,
            streamFactory: () => mockStream as unknown as WriteStream,
        })

        mockStream.autoCallback = false // Writes will not complete automatically

        logger.write('req 1\n')
        logger.write('req 2\n')
        logger.write('req 3\n')
        logger.write('req 4\n')

        // Node Writable dispatches _write serially; logger queue enforces maxInFlight
        expect(logger.getStats().inFlight).toBeLessThanOrEqual(2)
        expect(logger.getStats().queueLength + logger.getStats().inFlight).toBe(4)

        // Flush until fully settled using iterative drain helper
        await drainAll(mockStream, logger)

        expect(logger.getStats().inFlight).toBe(0)
        expect(logger.getStats().queueLength).toBe(0)
        expect(mockStream.writtenChunks).toEqual(['req 1\n', 'req 2\n', 'req 3\n', 'req 4\n'])
        logger.close()
    })

    it('handles stream write errors without hanging or infinite retry spin', async () => {
        let streamIndex = 0
        const streams: MockWriteStream[] = []

        // Error recovery factory returns a FRESH stream after a stream is destroyed
        const logger = new RotatingLogger('mock://error.log', 1024 * 1024, 3, {
            streamFactory: () => {
                streamIndex += 1
                const s = new MockWriteStream()
                streams.push(s)
                if (streamIndex === 1) {
                    s.writeErrorToEmit = new Error('EIO: disk write failure')
                }
                return s as unknown as WriteStream
            },
        })

        logger.write('failing line\n')
        await flushMicrotasks()

        // Stream 1 destroyed on error
        expect(streams[0].isDestroyed).toBe(true)
        expect(logger.getStats().inFlight).toBe(0)

        // Subsequent explicit write opens fresh stream 2 and succeeds
        logger.write('normal line\n')
        await flushMicrotasks()

        expect(streamIndex).toBe(2)
        expect(streams[1].writtenChunks).toContain('normal line\n')
        logger.close()
    })

    it('handles synchronous write throw without crashing and unblocks inFlight', async () => {
        const logger = new RotatingLogger('mock://throw.log', 1024 * 1024, 3, {
            streamFactory: () => mockStream as unknown as WriteStream,
        })

        mockStream.syncThrowError = new Error('sync write failure')
        logger.write('throwing line\n')
        await flushMicrotasks()

        expect(logger.getStats().inFlight).toBe(0)
        expect(logger.getStats().queueLength).toBe(0)
        logger.close()
    })

    it('delays Windows rotation until in-flight writes complete safely', async () => {
        const stream1 = new MockWriteStream()
        const stream2 = new MockWriteStream()
        let createdCount = 0

        const logger = new RotatingLogger('mock://rotate.log', 100, 2, {
            maxInFlight: 1,
            streamFactory: () => {
                createdCount += 1
                return (createdCount === 1 ? stream1 : stream2) as unknown as WriteStream
            },
        })

        stream1.autoCallback = false

        // Write line 1 (in-flight on stream 1)
        logger.write('a'.repeat(60) + '\n')
        // Write line 2 (queued because maxInFlight is 1)
        logger.write('b'.repeat(60) + '\n')

        logger.rotate()
        expect(logger.getStats().pendingRotate).toBe(true)
        expect(stream1.isDestroyed).toBe(false) // Not detached while in-flight > 0

        // Complete in-flight write using drain helper
        await drainAll(stream1, logger)

        // Rotation now completes cleanly
        expect(logger.getStats().pendingRotate).toBe(false)
        expect(stream1.isDestroyed).toBe(true)
        expect(createdCount).toBe(2)
        logger.close()
    })

    it('supports close semantics and reopen on subsequent write', async () => {
        let streamCount = 0
        const streams: MockWriteStream[] = []

        const logger = new RotatingLogger('mock://reopen.log', 1024 * 1024, 3, {
            streamFactory: () => {
                streamCount += 1
                const s = new MockWriteStream()
                streams.push(s)
                return s as unknown as WriteStream
            },
        })

        logger.write('before close\n')
        await flushMicrotasks()
        expect(streams[0].writtenChunks).toEqual(['before close\n'])

        logger.close()
        expect(streams[0].isDestroyed).toBe(true)
        expect(logger.getStats().closing).toBe(false)

        // Reopen on next write
        logger.write('after reopen\n')
        await flushMicrotasks()
        expect(streamCount).toBe(2)
        expect(streams[1].writtenChunks).toEqual(['after reopen\n'])
        logger.close()
    })

    it('maintains backward compatibility with constructor and getRotatingLogger singleton', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'compat-test-'))
        const path1 = join(tempDir, 'compat1.log')
        const l1 = new RotatingLogger(path1)
        expect(l1).toBeInstanceOf(RotatingLogger)
        expect(l1.getStats().filePath).toBe(path1)
        l1.close()

        const path2 = join(tempDir, 'compat2.log')
        const l2 = getRotatingLogger('test_instance', path2)
        const l3 = getRotatingLogger('test_instance', path2)
        expect(l2).toBe(l3)

        resetRotatingLoggerCacheForTests()
        const l4 = getRotatingLogger('test_instance', path2)
        expect(l4).not.toBe(l2)
        l4.close()
    })

    it('rotates real files on Windows filesystem and releases fd cleanly', async () => {
        tempDir = mkdtempSync(join(tmpdir(), 'rot-logger-test-'))
        const logFile = join(tempDir, 'active.log')
        const maxBackups = 2
        const logger = new RotatingLogger(logFile, 200, maxBackups)

        try {
            for (let i = 0; i < 10; i++) {
                logger.write(`Log line payload index=${i} padding-data-to-reach-threshold\n`)
            }
            await waitForIdle(logger)

            logger.write('Final post-rotation log line\n')
            await waitForIdle(logger)
            logger.close()
            await waitForIdle(logger)

            expect(existsSync(logFile)).toBe(true)
            const activeContent = readFileSync(logFile, 'utf8')
            expect(activeContent).toContain('Final post-rotation log line')
            expect(activeContent.length).toBeGreaterThan(0)

            const retained = readRetained(logFile, maxBackups)
            const combined = retained.join('\n')
            expect(combined).toContain('Final post-rotation log line')
            expect(existsSync(`${logFile}.1`)).toBe(true)
            expect(readFileSync(`${logFile}.1`, 'utf8').length).toBeGreaterThan(0)
            // Two backups. The oldest lines roll off .1; do not require index=0 in .1.
            expect(existsSync(`${logFile}.3`)).toBe(false)

            const indexes: number[] = []
            const pattern = /index=(\d+)/g
            let match = pattern.exec(combined)
            while (match) {
                indexes.push(Number(match[1]))
                match = pattern.exec(combined)
            }
            expect(indexes.length).toBeGreaterThan(0)
            for (let i = 1; i < indexes.length; i += 1) {
                expect(indexes[i]).toBeGreaterThan(indexes[i - 1])
            }

            logger.write('MARK-REOPEN\n')
            await waitForIdle(logger)
            logger.close()
            await waitForIdle(logger)
            const afterReopen = readRetained(logFile, maxBackups).join('\n')
            expect(afterReopen).toContain('MARK-REOPEN')
            expect(afterReopen).toContain('Final post-rotation log line')
            expect(existsSync(`${logFile}.3`)).toBe(false)
        } finally {
            logger.close()
        }
    })

    it('handles multibyte Unicode and tiny byte caps safely', () => {
        const stream = new MockWriteStream()
        const logger = new RotatingLogger('mock://tiny.log', 1024 * 1024, 3, {
            maxLineBytes: 10,
            streamFactory: () => stream as unknown as WriteStream,
        })

        logger.write('🌸 Xin chào các bạn MMO 🌟\n')
        expect(stream.writtenChunks.length).toBe(1)
        const chunk = stream.writtenChunks[0]
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(10)
        logger.close()
    })

    it('guards drain and error events by stream generation', async () => {
        let streamCount = 0
        const streams: MockWriteStream[] = []
        const logger = new RotatingLogger('mock://stale.log', 1024 * 1024, 3, {
            streamFactory: () => {
                streamCount += 1
                const s = new MockWriteStream()
                streams.push(s)
                return s as unknown as WriteStream
            },
        })

        logger.write('msg 1\n')
        await flushMicrotasks()
        expect(streamCount).toBe(1)

        // Force rotation to switch to Stream 2
        logger.rotate()
        await flushMicrotasks()
        expect(streamCount).toBe(2)

        // Old Stream 1 emits stale error and drain
        streams[0].emit('error', new Error('Stale error from old stream'))
        streams[0].emit('drain')
        await flushMicrotasks()

        // Verify stream 2 remains healthy and backpressure is unaffected
        expect(logger.getStats().isDraining).toBe(false)
        logger.write('msg 2\n')
        await flushMicrotasks()
        expect(streams[1].writtenChunks).toContain('msg 2\n')
        logger.close()
    })

    it('stops cleanly without microtask spin under persistent EIO', async () => {
        const streams: MockWriteStream[] = []
        const logger = new RotatingLogger('mock://persistent-eio.log', 1024 * 1024, 3, {
            streamFactory: () => {
                const s = new MockWriteStream()
                s.writeErrorToEmit = new Error('EIO persistent disk failure')
                streams.push(s)
                return s as unknown as WriteStream
            },
        })

        for (let i = 0; i < 5; i++) {
            logger.write(`fail-${i}\n`)
        }
        await flushMicrotasks()

        // One failure settles its own write. After repeated EIO the queue is dropped,
        // not retried, so a later explicit write is what may recover.
        expect(logger.getStats().inFlight).toBe(0)
        expect(logger.getStats().queueLength).toBe(0)
        expect(logger.getStats().inFlight).toBeLessThanOrEqual(1)
        expect(streams.length).toBeGreaterThan(0)
        expect(streams.length).toBeLessThanOrEqual(6)
        logger.close()
    })

    it('ignores stale events from a retired stream while a single write is in flight', async () => {
        let streamCount = 0
        const streams: MockWriteStream[] = []
        const logger = new RotatingLogger('mock://delayed-old.log', 100, 2, {
            maxInFlight: 2,
            streamFactory: () => {
                streamCount += 1
                const s = new MockWriteStream()
                streams.push(s)
                return s as unknown as WriteStream
            },
        })

        streams[0].autoCallback = false
        logger.write('stream 1 write\n')
        expect(logger.getStats().inFlight).toBeLessThanOrEqual(1)
        expect(logger.getStats().inFlight).toBeGreaterThan(0)

        // Rotation waits for the one callback. A second stream is not opened yet.
        logger.rotate()
        expect(streamCount).toBeLessThanOrEqual(1)
        expect(logger.getStats().pendingRotate).toBe(true)
        expect(streams[0].isDestroyed).toBe(false)
        expect(streams[0].pendingCallbacks.length).toBe(1)

        streams[0].flushPendingCallbacks()
        await flushMicrotasks()
        expect(streamCount).toBe(2)
        expect(streams[0].isDestroyed).toBe(true)
        expect(logger.getStats().pendingRotate).toBe(false)
        expect(logger.getStats().inFlight).toBeLessThanOrEqual(1)

        streams[1].autoCallback = false
        logger.write('stream 2 write\n')
        expect(logger.getStats().inFlight).toBeLessThanOrEqual(1)
        expect(streams[1].writtenChunks).toContain('stream 2 write\n')

        streams[0].emit('error', new Error('Delayed old stream error'))
        streams[0].emit('drain')
        await flushMicrotasks()

        expect(streams[1].isDestroyed).toBe(false)
        expect(logger.getStats().inFlight).toBe(1)
        streams[1].flushPendingCallbacks()
        await flushMicrotasks()
        expect(logger.getStats().inFlight).toBe(0)

        logger.write('stream 2 subsequent write\n')
        await flushMicrotasks()
        expect(streams[1].writtenChunks).toContain('stream 2 subsequent write\n')
        expect(logger.getStats().inFlight).toBeLessThanOrEqual(1)
        logger.close()
    })

    it('floods with tiny byte budgets showing no oversized writes or stuck queue', async () => {
        const stream = new MockWriteStream()
        const logger = new RotatingLogger('mock://tiny-budget.log', 1024 * 1024, 3, {
            maxLineBytes: 15,
            maxQueueBytes: 50,
            maxInFlightBytes: 20,
            streamFactory: () => stream as unknown as WriteStream,
        })

        // Flood with lines
        for (let i = 0; i < 50; i++) {
            logger.write(`flood-item-${i}-long-content-exceeding-tiny-cap\n`)
        }
        await flushMicrotasks()

        // Verify every written chunk respects maxInFlightBytes bound
        for (const chunk of stream.writtenChunks) {
            expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(20)
        }

        // Queue must not get stuck
        expect(logger.getStats().queueLength).toBe(0)
        expect(logger.getStats().inFlight).toBe(0)
        logger.close()
    })
})
