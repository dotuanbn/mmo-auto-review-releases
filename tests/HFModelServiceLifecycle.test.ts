/**
 * HFModelService worker lifecycle:
 * concurrent init is single-flight, stale callbacks cannot clobber a
 * replacement, and dispose cancels in-flight initialization.
 *
 * worker_threads is mocked; models are never downloaded or loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
    type Handler = (...args: unknown[]) => void

    class FakeWorker {
        readonly scriptPath: string
        terminated = false
        autoReply = true
        messages: Array<{ type: string; taskId: string }> = []
        private readonly listeners = new Map<string, Handler[]>()

        constructor(scriptPath: string) {
            this.scriptPath = scriptPath
            workers.push(this)
        }

        on(event: string, handler: Handler): this {
            const list = this.listeners.get(event) ?? []
            list.push(handler)
            this.listeners.set(event, list)
            return this
        }

        emit(event: string, ...args: unknown[]): boolean {
            const list = this.listeners.get(event) ?? []
            for (const handler of [...list]) {
                handler(...args)
            }
            return list.length > 0
        }

        postMessage(msg: { type: string; taskId: string }): void {
            this.messages.push(msg)
            if (!this.autoReply || this.terminated) return
            queueMicrotask(() => {
                if (this.terminated) return
                this.replyTo(msg)
            })
        }

        replyTo(msg: { type: string; taskId: string }): void {
            switch (msg.type) {
                case 'load':
                case 'unload':
                    this.emit('message', { type: 'ready', taskId: msg.taskId })
                    break
                case 'predict':
                    this.emit('message', {
                        type: 'result',
                        taskId: msg.taskId,
                        data: [{ generated_text: 'ok' }],
                    })
                    break
                case 'status':
                    this.emit('message', {
                        type: 'status',
                        taskId: msg.taskId,
                        loadedModels: [],
                        memoryUsageMB: 1,
                    })
                    break
            }
        }

        terminate(): Promise<number> {
            if (!this.terminated) {
                this.terminated = true
                this.emit('exit', 0)
            }
            return Promise.resolve(0)
        }
    }

    const workers: FakeWorker[] = []
    return { FakeWorker, workers }
})

vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('worker_threads')>()
    return {
        ...actual,
        Worker: harness.FakeWorker,
    }
})

vi.mock('electron', () => ({
    app: {
        getPath: () => 'C:\\tmp\\mmo-hf-lifecycle-userData',
        getAppPath: () => 'C:\\tmp\\mmo-hf-lifecycle-app',
    },
}))

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>()
    return {
        ...actual,
        existsSync: () => true,
        mkdirSync: vi.fn(),
    }
})

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>()
    return {
        ...actual,
        freemem: () => 8 * 1024 * 1024 * 1024,
        totalmem: () => 16 * 1024 * 1024 * 1024,
        cpus: () => Array.from({ length: 8 }, () => ({ model: 'test' })),
    }
})

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: () => ({
        hfModelEnabled: true,
        hfTextGenModel: '',
        hfAutoUnloadMinutes: 5,
        hfMaxMemoryMB: 2048,
    }),
}))

vi.mock('../src/main/services/TrackioService', () => ({
    trackioService: {
        logInference: vi.fn(),
    },
}))

vi.mock('../src/main/services/SystemResourceDetector', () => ({
    systemResourceDetector: {
        getSystemProfile: () => 'high',
        getRecommendations: () => ({
            profile: 'high',
            maxSafeThreads: 8,
            queueConcurrency: 3,
            staggerDelayMs: 1500,
        }),
    },
}))

vi.mock('../src/main/services/hf-model-registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/main/services/hf-model-registry')>()
    return {
        ...actual,
        getRegistryEntry: (task: Parameters<typeof actual.getRegistryEntry>[0]) => ({
            ...actual.getRegistryEntry(task),
            minRamGB: 0,
        }),
    }
})

import { hfModelService } from '../src/main/services/HFModelService'

const unhandled: unknown[] = []

function trackUnhandled(reason: unknown): void {
    unhandled.push(reason)
}

function lastWorker(): (typeof harness.workers)[number] {
    const worker = harness.workers[harness.workers.length - 1]
    if (!worker) {
        throw new Error('expected a worker to be spawned')
    }
    return worker
}

function emitInitReady(worker = lastWorker()): void {
    worker.emit('message', { type: 'ready', taskId: '__init__' })
}

async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

beforeEach(() => {
    unhandled.length = 0
    harness.workers.length = 0
    process.on('unhandledRejection', trackUnhandled)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
    process.removeListener('unhandledRejection', trackUnhandled)
    await hfModelService.dispose()
    vi.useRealTimers()
    expect(unhandled).toEqual([])
    vi.restoreAllMocks()
})

describe('HFModelService worker lifecycle', () => {
    it('spawns a single worker when callers initialize simultaneously', async () => {
        const first = hfModelService.preloadModel('text-generation')
        const second = hfModelService.preloadModel('zero-shot-image-classification')

        expect(harness.workers).toHaveLength(1)
        expect(lastWorker().scriptPath).toContain('hf-inference.worker.js')

        emitInitReady()
        await Promise.all([first, second])

        expect(harness.workers).toHaveLength(1)
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)
    })

    it('releases pending work and terminates the owned worker on init timeout', async () => {
        vi.useFakeTimers()
        const pending = hfModelService.preloadModel('text-generation')
        const worker = lastWorker()
        const terminate = vi.spyOn(worker, 'terminate')
        const pendingRejected = expect(pending).rejects.toThrow('Worker failed to initialize within 30s')

        await vi.advanceTimersByTimeAsync(30_000)
        await pendingRejected

        expect(terminate).toHaveBeenCalled()
        expect(worker.terminated).toBe(true)
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)

        const retry = hfModelService.preloadModel('text-generation')
        expect(harness.workers).toHaveLength(2)
        emitInitReady()
        await retry
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)
    })

    it('releases every waiter when the worker errors during init', async () => {
        const first = hfModelService.preloadModel('text-generation')
        const second = hfModelService.preloadModel('zero-shot-object-detection')
        expect(harness.workers).toHaveLength(1)

        lastWorker().emit('error', new Error('init boom'))

        await expect(first).rejects.toThrow('init boom')
        await expect(second).rejects.toThrow('init boom')
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)
    })

    it('releases pending work when the worker exits during init', async () => {
        const pending = hfModelService.preloadModel('text-generation')
        lastWorker().emit('exit', 7)

        await expect(pending).rejects.toThrow('Worker exited unexpectedly (code=7)')
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)
    })

    it('does not let a stale worker exit clobber a replacement or its pending work', async () => {
        const firstLoad = hfModelService.preloadModel('text-generation')
        const workerA = lastWorker()
        emitInitReady(workerA)
        await firstLoad

        workerA.emit('error', new Error('native crash'))
        await flush()

        const replacement = hfModelService.preloadModel('text-generation')
        expect(harness.workers).toHaveLength(2)
        const workerB = lastWorker()
        expect(workerB).not.toBe(workerA)
        workerB.autoReply = false

        workerA.emit('exit', 1)

        emitInitReady(workerB)
        await vi.waitFor(() => {
            expect(workerB.messages.some((msg) => msg.type === 'load')).toBe(true)
        })
        const loadMessage = workerB.messages.find((msg) => msg.type === 'load')
        if (!loadMessage) {
            throw new Error('expected load request on replacement worker')
        }
        workerB.emit('message', { type: 'ready', taskId: loadMessage.taskId })

        await replacement
        workerB.autoReply = true
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)

        const generated = hfModelService.generateText('hello')
        workerA.emit('exit', 1)
        await expect(generated).resolves.toBe('ok')
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)
    })

    it('dispose during init terminates the worker without resurrection or unhandled rejection', async () => {
        const pending = hfModelService.preloadModel('text-generation')
        const worker = lastWorker()
        const observed = pending.then(
            () => {
                throw new Error('preload should reject after dispose')
            },
            (err: unknown) => err,
        )

        await hfModelService.dispose()
        expect(worker.terminated).toBe(true)

        const err = await observed
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toMatch(/disposed/)

        worker.emit('message', { type: 'ready', taskId: '__init__' })
        await flush()
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)

        const later = hfModelService.preloadModel('text-generation')
        expect(harness.workers).toHaveLength(2)
        expect(lastWorker()).not.toBe(worker)
        emitInitReady()
        await later
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)
    })

    it('dispose rejects every pre-dispose queued generate and does not spawn a replacement', async () => {
        vi.useFakeTimers()
        const first = hfModelService.generateText('one')
        const second = hfModelService.generateText('two')
        const third = hfModelService.generateText('three')
        expect(harness.workers).toHaveLength(1)
        const worker = lastWorker()

        const firstRejected = expect(first).rejects.toThrow(/disposed/)
        const secondRejected = expect(second).rejects.toThrow(/disposed/)
        const thirdRejected = expect(third).rejects.toThrow(/disposed/)

        await hfModelService.dispose()
        await Promise.all([firstRejected, secondRejected, thirdRejected])

        expect(worker.terminated).toBe(true)
        expect(harness.workers).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(0)
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)

        await flush()
        expect(harness.workers).toHaveLength(1)

        const later = hfModelService.generateText('fresh')
        expect(harness.workers).toHaveLength(2)
        expect(lastWorker()).not.toBe(worker)
        emitInitReady()
        await later
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)
    })

    it('dispose during in-flight generate rejects queued callers and ignores stale load completion', async () => {
        const first = hfModelService.generateText('one')
        const worker = lastWorker()
        worker.autoReply = false
        emitInitReady(worker)
        await vi.waitFor(() => {
            expect(worker.messages.some((msg) => msg.type === 'load')).toBe(true)
        })

        const second = hfModelService.generateText('two')
        const third = hfModelService.generateText('three')
        expect(harness.workers).toHaveLength(1)

        const firstRejected = expect(first).rejects.toThrow(/disposed/)
        const secondRejected = expect(second).rejects.toThrow(/disposed/)
        const thirdRejected = expect(third).rejects.toThrow(/disposed/)

        await hfModelService.dispose()
        await Promise.all([firstRejected, secondRejected, thirdRejected])
        expect(worker.terminated).toBe(true)
        expect(harness.workers).toHaveLength(1)

        const loadMessage = worker.messages.find((msg) => msg.type === 'load')
        if (loadMessage) {
            worker.emit('message', { type: 'ready', taskId: loadMessage.taskId })
        }
        await flush()
        expect(harness.workers).toHaveLength(1)
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)

        const later = hfModelService.generateText('fresh')
        expect(harness.workers).toHaveLength(2)
        emitInitReady()
        await later
        expect((await hfModelService.getStatus()).workerAlive).toBe(true)
    })

    it('dispose clears idle state so a later timer cannot respawn the worker', async () => {
        vi.useFakeTimers()
        const pending = hfModelService.generateText('hello')
        emitInitReady()
        await pending
        expect(vi.getTimerCount()).toBeGreaterThan(0)
        const spawned = harness.workers.length

        await hfModelService.dispose()
        expect(vi.getTimerCount()).toBe(0)
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(harness.workers).toHaveLength(spawned)
        expect((await hfModelService.getStatus()).workerAlive).toBe(false)
    })
})
