import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { LayaSidecarManager, type LayaSidecarSpawnOptions } from '../../src/main/services/LayaSidecarManager'

const tempRoots: string[] = []
const managers: LayaSidecarManager[] = []

afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.stop()))
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function executableFixture(): string {
    const root = join(tmpdir(), `laya-sidecar-test-${Date.now()}-${Math.random()}`)
    mkdirSync(root, { recursive: true })
    tempRoots.push(root)
    const executable = join(root, 'laya-sidecar.exe')
    writeFileSync(executable, 'test fixture')
    return executable
}

function ownedHealth(pid: number): Record<string, unknown> {
    return {
        service: 'mmo-laya-sidecar',
        protocol: 1,
        pid,
        model_loaded: true,
        tier1Ready: true,
        data: [{ id: 'tier1-local' }],
    }
}

function createFakeChild(pid: number): ChildProcess {
    const child = new EventEmitter() as ChildProcess
    child.pid = pid
    child.killed = false
    child.exitCode = null
    child.stdout = new EventEmitter() as unknown as ChildProcess['stdout']
    child.stderr = new EventEmitter() as unknown as ChildProcess['stderr']
    child.kill = () => {
        if (child.killed || child.exitCode !== null) return false
        child.killed = true
        child.exitCode = 0
        queueMicrotask(() => child.emit('exit', 0, null))
        return true
    }
    return child
}

function track(manager: LayaSidecarManager): LayaSidecarManager {
    managers.push(manager)
    return manager
}

describe('Laya low-resource policy', () => {
    it('does not load the local model when the PC has less than 2 GB free', async () => {
        const spawn = vi.fn()
        const manager = track(new LayaSidecarManager({ freeMemoryMB: () => 1700, spawnProcess: spawn }))
        manager.setLowResourceMode(true)
        expect(await manager.ensureRunning()).toMatchObject({ state: 'unavailable', error: expect.stringContaining('2 GB') })
        expect(spawn).not.toHaveBeenCalled()
    })

    it('limits inference threads and unloads after idle, without interrupting in-flight work', async () => {
        vi.useFakeTimers()
        const child = createFakeChild(2222)
        const spawn = vi.fn<(file: string, args: string[], options: LayaSidecarSpawnOptions) => ChildProcess>(() => child)
        const manager = track(new LayaSidecarManager({
            executablePath: executableFixture(), platform: 'win32', port: 18765,
            freeMemoryMB: () => 4096, spawnProcess: spawn, fetchHealth: async () => ownedHealth(2222),
        }))
        manager.setLowResourceMode(true)
        try {
            const release = manager.beginUse()
            expect((await manager.ensureRunning()).state).toBe('ready')
            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ env: { OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' } })
            await vi.advanceTimersByTimeAsync(90_000)
            expect(child.killed).toBe(false)
            release()
            release()
            await vi.advanceTimersByTimeAsync(1)
            expect(child.killed).toBe(true)
            expect(manager.getStatus().state).toBe('stopped')
        } finally { await manager.stop(); vi.useRealTimers() }
    })

    it('passive health checks do not keep an unused model resident', async () => {
        vi.useFakeTimers()
        const child = createFakeChild(2223)
        const manager = track(new LayaSidecarManager({
            executablePath: executableFixture(), platform: 'win32', port: 18766,
            freeMemoryMB: () => 4096, spawnProcess: () => child, fetchHealth: async () => ownedHealth(2223),
        }))
        manager.setLowResourceMode(true)
        try {
            await manager.ensureRunning()
            for (let tick = 0; tick < 2; tick += 1) {
                await vi.advanceTimersByTimeAsync(20_000)
                manager.beginUse(false)()
            }
            await vi.advanceTimersByTimeAsync(20_001)
            expect(child.killed).toBe(true)
        } finally { await manager.stop(); vi.useRealTimers() }
    })
})

describe('LayaSidecarManager', () => {
    it('reports an explicit unavailable state when the artifact is absent', async () => {
        const manager = track(new LayaSidecarManager({
            executablePath: join(tmpdir(), 'missing-laya-sidecar.exe'),
            fetchHealth: async () => null,
        }))

        const status = await manager.ensureRunning()

        expect(status.state).toBe('unavailable')
        expect(status.error).toContain('not packaged')
    })

    it('returns unavailable promptly on non-Windows platforms', async () => {
        const executablePath = executableFixture()
        let spawnCalls = 0
        const manager = track(new LayaSidecarManager({
            executablePath,
            platform: 'linux',
            spawnProcess: () => {
                spawnCalls += 1
                throw new Error('must not spawn on non-Windows')
            },
        }))

        const status = await manager.ensureRunning()

        expect(status.state).toBe('unavailable')
        expect(status.error).toMatch(/windows/i)
        expect(spawnCalls).toBe(0)
    })

    it('does not throw when process.resourcesPath is absent outside Electron', async () => {
        const manager = track(new LayaSidecarManager({
            cwd: join(tmpdir(), `laya-no-resources-${Date.now()}`),
            spawnProcess: () => {
                throw new Error('must not spawn without a packaged executable')
            },
        }))

        const status = await manager.ensureRunning()

        expect(status.state).toBe('unavailable')
        expect(status.error).toContain('not packaged')
    })

    it('never reuses an unrelated healthy listener and only accepts owned identity + PID', async () => {
        const executablePath = executableFixture()
        let spawnCalls = 0
        const child = createFakeChild(4242)
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34567,
            fetchHealth: async () => ownedHealth(4242),
            spawnProcess: () => {
                spawnCalls += 1
                return child
            },
        }))

        const status = await manager.ensureRunning()

        expect(spawnCalls).toBe(1)
        expect(status.state).toBe('ready')
        expect(status.pid).toBe(4242)
        expect(status.endpoint).toBe('http://127.0.0.1:34567')
        expect(manager.endpoint).toBe('http://127.0.0.1:34567')
    })

    it('rejects invalid health payloads and does not mark an unrelated service ready', async () => {
        const executablePath = executableFixture()
        let spawnCalls = 0
        const child = createFakeChild(99)
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34568,
            startupTimeoutMs: 200,
            fetchHealth: async () => ({ data: [{ id: 'tier1-local' }], ok: true }),
            spawnProcess: () => {
                spawnCalls += 1
                return child
            },
        }))

        const status = await manager.ensureRunning()

        expect(spawnCalls).toBe(1)
        expect(status.state).toBe('failed')
        expect(status.error).toContain('did not become healthy')
        expect(child.killed).toBe(true)
        expect(manager.getStatus().state).toBe('failed')
    })

    it('rejects health that does not match the owned child PID', async () => {
        const executablePath = executableFixture()
        const child = createFakeChild(11)
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34569,
            startupTimeoutMs: 200,
            fetchHealth: async () => ownedHealth(999),
            spawnProcess: () => child,
        }))

        const status = await manager.ensureRunning()

        expect(status.state).toBe('failed')
        expect(child.killed).toBe(true)
    })

    it('passes the model directory beside the executable', async () => {
        const executablePath = executableFixture()
        let spawnArgs: string[] = []
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34570,
            fetchHealth: async () => ownedHealth(7),
            spawnProcess: (_file, args) => {
                spawnArgs = args
                return createFakeChild(7)
            },
        }))

        await manager.ensureRunning()

        expect(spawnArgs).toContain('--host=127.0.0.1')
        expect(spawnArgs).toContain('--port=34570')
        expect(spawnArgs).toContain(`--model-dir=${join(resolve(executablePath, '..'), 'model', 'multilingual')}`)
    })

    it('allocates a free loopback port by default and reflects it on the endpoint', async () => {
        const executablePath = executableFixture()
        let spawnArgs: string[] = []
        const allocatedPort = 41234
        const manager = track(new LayaSidecarManager({
            executablePath,
            allocateLoopbackPort: async () => allocatedPort,
            fetchHealth: async () => ownedHealth(8),
            spawnProcess: (_file, args) => {
                spawnArgs = args
                return createFakeChild(8)
            },
        }))

        const status = await manager.ensureRunning()

        expect(spawnArgs).toContain(`--port=${allocatedPort}`)
        expect(status.endpoint).toBe(`http://127.0.0.1:${allocatedPort}`)
        expect(manager.endpoint).toBe(`http://127.0.0.1:${allocatedPort}`)
        expect(status.endpoint).not.toBe('http://127.0.0.1:8765')
    })

    it('spawns only one child when ensureRunning is called concurrently', async () => {
        const executablePath = executableFixture()
        let spawnCalls = 0
        let releaseHealth: ((value: unknown) => void) | undefined
        const healthGate = new Promise<unknown>((resolve) => {
            releaseHealth = resolve
        })
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34571,
            fetchHealth: async () => healthGate,
            spawnProcess: () => {
                spawnCalls += 1
                return createFakeChild(21)
            },
        }))

        const first = manager.ensureRunning()
        const second = manager.ensureRunning()
        await vi.waitFor(() => expect(spawnCalls).toBe(1))
        releaseHealth?.(ownedHealth(21))
        const [a, b] = await Promise.all([first, second])

        expect(spawnCalls).toBe(1)
        expect(a.state).toBe('ready')
        expect(b.state).toBe('ready')
        expect(a.pid).toBe(21)
    })

    it('records spawn errors as failed without throwing', async () => {
        const executablePath = executableFixture()
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34572,
            spawnProcess: () => {
                throw new Error('spawn ENOENT')
            },
        }))

        const status = await manager.ensureRunning()

        expect(status.state).toBe('failed')
        expect(status.error).toContain('spawn ENOENT')
    })

    it('records early child exit as failed and does not mark ready later', async () => {
        const executablePath = executableFixture()
        const child = createFakeChild(33)
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34573,
            startupTimeoutMs: 1_000,
            fetchHealth: async () => {
                await new Promise((resolveWait) => setTimeout(resolveWait, 30))
                return ownedHealth(33)
            },
            spawnProcess: () => child,
        }))

        queueMicrotask(() => {
            child.exitCode = 1
            child.emit('exit', 1, null)
        })

        const status = await manager.ensureRunning()

        expect(status.state).toBe('failed')
        expect(status.error).toContain('exited')
        expect(manager.getStatus().state).toBe('failed')
    })

    it('retains failed status and the timeout error after killing the owned child', async () => {
        const executablePath = executableFixture()
        const child = createFakeChild(44)
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34574,
            startupTimeoutMs: 200,
            fetchHealth: async () => null,
            spawnProcess: () => child,
        }))

        const status = await manager.ensureRunning()

        expect(status.state).toBe('failed')
        expect(status.error).toContain('did not become healthy within 200ms')
        expect(child.killed).toBe(true)
        expect(manager.getStatus().state).toBe('failed')
        expect(manager.getStatus().error).toContain('did not become healthy')
    })

    it('stop during pending startup cannot spawn again or mark that attempt ready', async () => {
        const executablePath = executableFixture()
        let spawnCalls = 0
        let releaseHealth: ((value: unknown) => void) | undefined
        const healthGate = new Promise<unknown>((resolve) => {
            releaseHealth = resolve
        })
        const child = createFakeChild(55)
        const manager = track(new LayaSidecarManager({
            executablePath,
            port: 34575,
            fetchHealth: async () => healthGate,
            spawnProcess: () => {
                spawnCalls += 1
                return child
            },
        }))

        const pending = manager.ensureRunning()
        await vi.waitFor(() => expect(spawnCalls).toBe(1))
        await manager.stop()
        releaseHealth?.(ownedHealth(55))
        const status = await pending

        expect(spawnCalls).toBe(1)
        expect(status.state).toBe('stopped')
        expect(child.killed).toBe(true)
        expect(manager.getStatus().state).toBe('stopped')
    })
})
