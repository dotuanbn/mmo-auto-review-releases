import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { join, resolve } from 'node:path'
import {
    RuntimeHealthService,
    RendererRecoveryController,
    containConsolePipeErrors,
    isStreamPipeError,
    formatProcessLossString,
    matchAllowedExitReason,
    matchAllowedProcessLossReason,
    matchAllowedChildType,
    sanitizeSessionId,
    sanitizeIsoDate,
    sanitizeStoredProcessLossString,
    resolveBootstrapLogPath,
    MAX_SNAPSHOT_BYTES,
    type RuntimeHealthFs,
    type RecoverableWindow,
    type RuntimeHealthSnapshot,
} from '../src/main/services/RuntimeHealthService'

describe('RuntimeHealthService', () => {
    const FAKE_LOGS_DIR = resolve('fake', 'userData', 'logs')
    const SNAPSHOT_PATH = join(FAKE_LOGS_DIR, 'runtime-health.json')

    let mockStorage: Map<string, string>
    let mockFs: RuntimeHealthFs
    let currentTime: number
    let currentUptime: number

    beforeEach(() => {
        mockStorage = new Map<string, string>()
        currentTime = 1700000000000
        currentUptime = 100

        mockFs = {
            existsSync: vi.fn((path: string) => mockStorage.has(path)),
            readFileSync: vi.fn((path: string) => {
                const val = mockStorage.get(path)
                if (val === undefined) throw new Error(`ENOENT: ${path}`)
                return val
            }),
            writeFileSync: vi.fn((path: string, data: string) => {
                mockStorage.set(path, data)
            }),
            renameSync: vi.fn((oldPath: string, newPath: string) => {
                const val = mockStorage.get(oldPath)
                if (val === undefined) throw new Error(`ENOENT: ${oldPath}`)
                mockStorage.delete(oldPath)
                mockStorage.set(newPath, val)
            }),
            mkdirSync: vi.fn(),
            unlinkSync: vi.fn((path: string) => {
                mockStorage.delete(path)
            }),
            statSync: vi.fn((path: string) => {
                const val = mockStorage.get(path)
                if (val === undefined) throw new Error(`ENOENT: ${path}`)
                return { size: Buffer.byteLength(val, 'utf8') }
            }),
        }
    })

    function createService(overrides: Partial<Parameters<typeof RuntimeHealthService['prototype']['constructor']>[0]> = {}) {
        return new RuntimeHealthService({
            fs: mockFs,
            now: () => currentTime,
            uptime: () => currentUptime,
            getMemoryUsage: () => ({
                rss: 100 * 1024 * 1024,
                heapTotal: 50 * 1024 * 1024,
                heapUsed: 30 * 1024 * 1024,
                external: 5 * 1024 * 1024,
                arrayBuffers: 1024 * 1024,
            }),
            getAppMetrics: () => [
                { type: 'Tab', memory: { workingSetSize: 50 * 1024 } },
                { type: 'GPU', memory: { workingSetSize: 30 * 1024 } },
            ],
            logsDir: FAKE_LOGS_DIR,
            heartbeatIntervalMs: 10000,
            ...overrides,
        })
    }

    describe('Session marker & previous unclean detection', () => {
        it('starts a new session with cleanExit false and records initial metrics', () => {
            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            expect(snapshot).not.toBeNull()
            expect(snapshot?.version).toBe(1)
            expect(snapshot?.current.cleanExit).toBe(false)
            expect(snapshot?.current.exitReason).toBeNull()
            expect(snapshot?.current.mainMemoryMb.rssMb).toBe(100)
            expect(snapshot?.current.mainMemoryMb.heapUsedMb).toBe(30)
            expect(snapshot?.current.appMetrics?.processCount).toBe(2)
            expect(snapshot?.current.appMetrics?.totalWorkingSetMb).toBe(80)
            expect(snapshot?.previous).toBeNull()

            const savedRaw = mockStorage.get(SNAPSHOT_PATH)
            expect(savedRaw).toBeDefined()
            const parsed = JSON.parse(savedRaw!) as RuntimeHealthSnapshot
            expect(parsed.current.cleanExit).toBe(false)

            service.stop(true)
        })

        it('records cleanExit true and clean_shutdown on intentional stop', () => {
            const service = createService()
            service.start()
            currentTime += 5000
            currentUptime += 5
            service.stop(true)

            const snapshot = service.getSnapshot()
            expect(snapshot?.current.cleanExit).toBe(true)
            expect(snapshot?.current.exitReason).toBe('clean_shutdown')
            expect(snapshot?.current.endedAt).toBeDefined()

            const savedRaw = mockStorage.get(SNAPSHOT_PATH)
            const parsed = JSON.parse(savedRaw!) as RuntimeHealthSnapshot
            expect(parsed.current.cleanExit).toBe(true)
            expect(parsed.current.exitReason).toBe('clean_shutdown')
        })

        it('detects a previous unclean run accurately as unknown/unclean rather than assuming proven crash', () => {
            const service1 = createService()
            service1.start()

            currentTime += 10000
            currentUptime = 10
            const service2 = createService()
            service2.start()

            const snapshot = service2.getSnapshot()
            expect(snapshot?.previous).not.toBeNull()
            expect(snapshot?.previous?.cleanExit).toBe(false)
            expect(snapshot?.previous?.exitReason).toBe('unknown_unclean')
            expect(snapshot?.previous?.sessionId).toBe(service1.getSessionId())

            expect(snapshot?.current.cleanExit).toBe(false)
            expect(snapshot?.current.sessionId).not.toBe(service1.getSessionId())

            service2.stop(true)
        })

        it('preserves cleanExit true for previous session when previous exit was clean', () => {
            const service1 = createService()
            service1.start()
            service1.stop(true)

            currentTime += 20000
            const service2 = createService()
            service2.start()

            const snapshot = service2.getSnapshot()
            expect(snapshot?.previous?.cleanExit).toBe(true)
            expect(snapshot?.previous?.exitReason).toBe('clean_shutdown')

            service2.stop(true)
        })

        it('does not allow fatal uncaught_exception marker to be overwritten clean', () => {
            const service = createService()
            service.start()
            service.recordExitReason('uncaught_exception')

            service.stop(true)

            const snapshot = service.getSnapshot()
            expect(snapshot?.current.cleanExit).toBe(false)
            expect(snapshot?.current.exitReason).toBe('uncaught_exception')
        })
    })

    describe('Atomic snapshot & Last Known Good (LKG) preservation', () => {
        it('preserves existing snapshot intact when renameSync fails', () => {
            const loggerMock = vi.fn()
            const service = createService({ logger: loggerMock })
            service.start()

            const originalContent = mockStorage.get(SNAPSHOT_PATH)
            expect(originalContent).toBeDefined()

            mockFs.renameSync = vi.fn(() => {
                throw new Error('EPERM: operation not permitted, rename')
            })

            expect(() => {
                service.recordExitReason('clean_shutdown')
            }).not.toThrow()

            expect(mockStorage.get(SNAPSHOT_PATH)).toBe(originalContent)
            expect(loggerMock).toHaveBeenCalled()

            service.stop(false)
        })

        it('preserves existing snapshot intact when temp file write fails', () => {
            const loggerMock = vi.fn()
            const service = createService({ logger: loggerMock })
            service.start()

            const originalContent = mockStorage.get(SNAPSHOT_PATH)
            expect(originalContent).toBeDefined()

            mockFs.writeFileSync = vi.fn(() => {
                throw new Error('ENOSPC: no space left on device')
            })

            expect(() => {
                service.recordExitReason('clean_shutdown')
            }).not.toThrow()

            expect(mockStorage.get(SNAPSHOT_PATH)).toBe(originalContent)
            expect(loggerMock).toHaveBeenCalled()

            service.stop(false)
        })
    })

    describe('Untrusted / corrupt / oversized previous JSON handling', () => {
        it('safely handles corrupt prior snapshot with fixed diagnostic reason', () => {
            mockStorage.set(SNAPSHOT_PATH, '{ corrupt json content ...')

            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            expect(snapshot?.previous).not.toBeNull()
            expect(snapshot?.previous?.exitReason).toBe('corrupt_snapshot')
            expect(snapshot?.previous?.cleanExit).toBe(false)

            service.stop(true)
        })

        it('safely ignores oversized prior snapshot exceeding MAX_SNAPSHOT_BYTES', () => {
            const hugePayload = JSON.stringify({
                version: 1,
                current: {
                    sessionId: 'huge',
                    extraData: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1000),
                },
            })
            mockStorage.set(SNAPSHOT_PATH, hugePayload)

            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            expect(snapshot?.previous?.exitReason).toBe('oversized_snapshot_ignored')
            expect(snapshot?.previous?.cleanExit).toBe(false)

            service.stop(true)
        })

        it('rebuilds only known fields and drops unknown or malicious properties', () => {
            const priorWithExtras = JSON.stringify({
                version: 1,
                current: {
                    sessionId: 'clean-prior',
                    startedAt: '2026-11-23T00:00:00.000Z',
                    cleanExit: true,
                    exitReason: 'clean_shutdown',
                    secretToken: 'SECRET_API_KEY_12345',
                    maliciousPayload: { nested: 'danger' },
                    uptimeSeconds: 50,
                    heartbeatCount: 5,
                    mainMemoryMb: { rssMb: 120, heapTotalMb: 60, heapUsedMb: 40, secretMem: 999 },
                },
            })
            mockStorage.set(SNAPSHOT_PATH, priorWithExtras)

            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            const prev = snapshot?.previous as unknown as Record<string, unknown>
            expect(prev).toBeDefined()
            expect(prev.secretToken).toBeUndefined()
            expect(prev.maliciousPayload).toBeUndefined()
            expect((prev.mainMemoryMb as Record<string, unknown>).secretMem).toBeUndefined()
            expect(prev.cleanExit).toBe(true)

            service.stop(true)
        })

        it('sanitizes NaN and negative metric values to 0', () => {
            const priorWithInvalidMetrics = JSON.stringify({
                version: 1,
                current: {
                    sessionId: 'bad-metrics',
                    uptimeSeconds: -500,
                    heartbeatCount: 'not-a-number',
                    mainMemoryMb: { rssMb: -10, heapTotalMb: 'invalid', heapUsedMb: null },
                    appMetrics: { processCount: -5, totalWorkingSetMb: NaN },
                },
            })
            mockStorage.set(SNAPSHOT_PATH, priorWithInvalidMetrics)

            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            expect(snapshot?.previous?.uptimeSeconds).toBe(0)
            expect(snapshot?.previous?.heartbeatCount).toBe(0)
            expect(snapshot?.previous?.mainMemoryMb.rssMb).toBe(0)
            expect(snapshot?.previous?.mainMemoryMb.heapTotalMb).toBe(0)
            expect(snapshot?.previous?.mainMemoryMb.heapUsedMb).toBe(0)
            expect(snapshot?.previous?.appMetrics?.processCount).toBe(0)
            expect(snapshot?.previous?.appMetrics?.totalWorkingSetMb).toBe(0)

            service.stop(true)
        })

        it('sanitizes previous arbitrary strings in sessionId, dates and loss reasons', () => {
            const priorWithUnsafeStrings = JSON.stringify({
                version: 1,
                current: {
                    sessionId: 'token=super_secret_session_key',
                    startedAt: 'not-a-date',
                    updatedAt: 'malformed-date',
                    endedAt: 'invalid-date',
                    cleanExit: false,
                    lastRendererLossReason: 'crashed on https://secret.com with password=123',
                    lastChildLossReason: 'malicious child payload',
                },
            })
            mockStorage.set(SNAPSHOT_PATH, priorWithUnsafeStrings)

            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            expect(snapshot?.previous?.sessionId).toBe('synthetic_session')
            expect(snapshot?.previous?.startedAt).toBe(new Date(0).toISOString())
            expect(snapshot?.previous?.lastRendererLossReason).toBeNull()
            expect(snapshot?.previous?.lastChildLossReason).toBeNull()

            service.stop(true)
        })

        it('safely ignores prior snapshot when statSync throws without doing unbounded read', () => {
            mockStorage.set(SNAPSHOT_PATH, '{"version":1}')
            mockFs.statSync = vi.fn(() => {
                throw new Error('EPERM: cannot stat')
            })

            const service = createService()
            service.start()

            const snapshot = service.getSnapshot()
            expect(snapshot?.previous).not.toBeNull()
            expect(snapshot?.previous?.exitReason).toBe('corrupt_snapshot')

            service.stop(true)
        })
    })

    describe('Startup safety with throwing filesystem operations', () => {
        it('never breaks start when existsSync throws', () => {
            mockFs.existsSync = vi.fn(() => {
                throw new Error('EIO: hardware I/O error')
            })

            const service = createService()
            expect(() => service.start()).not.toThrow()
            expect(service.isRunning()).toBe(true)

            service.stop(true)
        })

        it('never breaks start when mkdirSync throws', () => {
            mockFs.mkdirSync = vi.fn(() => {
                throw new Error('EACCES: permission denied')
            })

            const service = createService()
            expect(() => service.start()).not.toThrow()
            expect(service.isRunning()).toBe(true)

            service.stop(true)
        })
    })

    describe('Fixed categories and secret-free diagnostics', () => {
        it('maps arbitrary free text with tokens to unknown_loss category', () => {
            const rawWithSecret = 'crashed on https://secret-customer.com/dashboard?token=xyz123'
            const formatted = formatProcessLossString(rawWithSecret, -1073741819)
            expect(formatted).toBe('unknown_loss:code_-1073741819')
            expect(formatted).not.toContain('secret')
            expect(formatted).not.toContain('https://')
        })

        it('preserves approved process loss reasons and child types', () => {
            expect(matchAllowedProcessLossReason('crashed')).toBe('crashed')
            expect(matchAllowedProcessLossReason('oom')).toBe('oom')
            expect(matchAllowedProcessLossReason('killed')).toBe('killed')
            expect(matchAllowedProcessLossReason('unknown_reason')).toBe('unknown_loss')

            expect(matchAllowedChildType('GPU')).toBe('GPU')
            expect(matchAllowedChildType('Utility')).toBe('Utility')
            expect(matchAllowedChildType('UnknownHelper')).toBe('other_process')

            const formatted = formatProcessLossString('crashed', 1, 'GPU')
            expect(formatted).toBe('GPU:crashed:code_1')
        })

        it('maps exit reasons to approved categories only', () => {
            expect(matchAllowedExitReason('clean_shutdown')).toBe('clean_shutdown')
            expect(matchAllowedExitReason('uncaught_exception')).toBe('uncaught_exception')
            expect(matchAllowedExitReason('arbitrary_exit_text')).toBe('unknown_unclean')
        })

        it('sanitizes and parses stored loss strings correctly', () => {
            expect(sanitizeStoredProcessLossString('crashed:code_1')).toBe('crashed:code_1')
            expect(sanitizeStoredProcessLossString('GPU:oom:code_2')).toBe('GPU:oom:code_2')
            expect(sanitizeStoredProcessLossString('crashed')).toBe('crashed')
            expect(sanitizeStoredProcessLossString('arbitrary secret password')).toBeNull()
        })

        it('validates and sanitizes session IDs and ISO dates', () => {
            expect(sanitizeSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000')
            expect(sanitizeSessionId('valid-synthetic-id_123')).toBe('valid-synthetic-id_123')
            expect(sanitizeSessionId('token=secret/bad\\id')).toBe('synthetic_session')

            expect(sanitizeIsoDate('2026-11-23T10:00:00.000Z')).toBe('2026-11-23T10:00:00.000Z')
            expect(sanitizeIsoDate('invalid-date')).toBeNull()
            expect(sanitizeIsoDate(null, 'fallback')).toBe('fallback')
        })
    })

    describe('Bootstrap log path resolution', () => {
        const SMOKE_DATA_ROOT = resolve('smoke-temp', 'mmo-packaged-smoke', 'test-user-data')
        const EXPECTED_SMOKE_LOGS_DIR = join(SMOKE_DATA_ROOT, 'logs')
        const EXPECTED_SMOKE_BOOTSTRAP_LOG = join(EXPECTED_SMOKE_LOGS_DIR, 'bootstrap.log')

        const FAKE_APP_DATA_PATH = resolve('Users', 'User', 'AppData', 'Roaming')
        const EXPECTED_PROD_BOOTSTRAP_LOG = join(FAKE_APP_DATA_PATH, 'MMO Auto Review', 'bootstrap.log')

        const FALLBACK_CWD = resolve('fake', 'mmo-app')
        const EXPECTED_FALLBACK_BOOTSTRAP_LOG = join(FALLBACK_CWD, 'bootstrap.log')

        it('routes to smoke userData logs folder when smokeDataRoot is provided', () => {
            const fsMock = {
                existsSync: vi.fn(() => false),
                mkdirSync: vi.fn(),
            }
            const path = resolveBootstrapLogPath({
                smokeDataRoot: SMOKE_DATA_ROOT,
                appDataPath: FAKE_APP_DATA_PATH,
                fs: fsMock,
            })

            expect(path).toBe(EXPECTED_SMOKE_BOOTSTRAP_LOG)
            expect(fsMock.mkdirSync).toHaveBeenCalledWith(
                EXPECTED_SMOKE_LOGS_DIR,
                { recursive: true }
            )
        })

        it('routes to standard AppData folder in normal production mode', () => {
            const fsMock = {
                existsSync: vi.fn(() => true),
                mkdirSync: vi.fn(),
            }
            const path = resolveBootstrapLogPath({
                smokeDataRoot: null,
                appDataPath: FAKE_APP_DATA_PATH,
                fs: fsMock,
            })

            expect(path).toBe(EXPECTED_PROD_BOOTSTRAP_LOG)
        })

        it('falls back to cwd when appDataPath is unavailable', () => {
            const path = resolveBootstrapLogPath({
                smokeDataRoot: null,
                appDataPath: '',
                fallbackCwd: FALLBACK_CWD,
            })

            expect(path).toBe(EXPECTED_FALLBACK_BOOTSTRAP_LOG)
        })
    })

    describe('Options, logger safety and snapshot immutability', () => {
        it('honors and clamps heartbeatIntervalMs in start options', () => {
            const service = createService()
            service.start({ heartbeatIntervalMs: 2000 })
            expect(service.isRunning()).toBe(true)
            service.stop(true)

            const service2 = createService()
            service2.start({ heartbeatIntervalMs: 15000 })
            expect(service2.isRunning()).toBe(true)
            service2.stop(true)
        })

        it('contains injected logger failures without crashing', () => {
            const throwingLogger = vi.fn(() => {
                throw new Error('Logger disk write failure')
            })
            const service = createService({ logger: throwingLogger })

            expect(() => {
                service.start()
                service.recordExitReason('clean_shutdown')
                service.stop(true)
            }).not.toThrow()
        })

        it('returns deep clones from getSnapshot preventing caller mutation', () => {
            const service = createService()
            service.start()

            const snap1 = service.getSnapshot()
            expect(snap1).not.toBeNull()
            if (snap1) {
                snap1.current.mainMemoryMb.rssMb = 999999
                snap1.current.cleanExit = true
            }

            const snap2 = service.getSnapshot()
            expect(snap2?.current.mainMemoryMb.rssMb).toBe(100)
            expect(snap2?.current.cleanExit).toBe(false)

            service.stop(true)
        })
    })
})

describe('RendererRecoveryController', () => {
    let mockWindow1: RecoverableWindow
    let mockWindow2: RecoverableWindow
    let reloadMock1: vi.Mock
    let reloadMock2: vi.Mock
    let scheduledTimers: Array<{ id: number; callback: () => void; ms: number }>
    let nextTimerId: number
    let controller: RendererRecoveryController

    beforeEach(() => {
        scheduledTimers = []
        nextTimerId = 1
        reloadMock1 = vi.fn()
        reloadMock2 = vi.fn()

        mockWindow1 = {
            isDestroyed: vi.fn(() => false),
            webContents: {
                isDestroyed: vi.fn(() => false),
                reloadIgnoringCache: reloadMock1,
            },
        }

        mockWindow2 = {
            isDestroyed: vi.fn(() => false),
            webContents: {
                isDestroyed: vi.fn(() => false),
                reloadIgnoringCache: reloadMock2,
            },
        }

        controller = new RendererRecoveryController({
            maxAttempts: 3,
            baseDelayMs: 1000,
            maxDelayMs: 8000,
            stableUptimeMs: 30000,
            setTimeout: ((cb: () => void, ms: number) => {
                const id = nextTimerId++
                scheduledTimers.push({ id, callback: cb, ms })
                return id as unknown as NodeJS.Timeout
            }) as unknown as typeof setTimeout,
            clearTimeout: ((id: unknown) => {
                const numId = Number(id)
                scheduledTimers = scheduledTimers.filter((t) => t.id !== numId)
            }) as unknown as typeof clearTimeout,
        })
    })

    it('schedules recovery with bounded exponential backoff', () => {
        const ok1 = controller.scheduleRecovery(mockWindow1, 'crash_1', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(ok1).toBe(true)
        expect(controller.getAttempts()).toBe(1)
        expect(scheduledTimers[0].ms).toBe(1000)

        scheduledTimers[0].callback()
        expect(reloadMock1).toHaveBeenCalledTimes(1)

        scheduledTimers = []
        const ok2 = controller.scheduleRecovery(mockWindow1, 'crash_2', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(ok2).toBe(true)
        expect(controller.getAttempts()).toBe(2)
        expect(scheduledTimers[0].ms).toBe(2000)

        scheduledTimers[0].callback()
        expect(reloadMock1).toHaveBeenCalledTimes(2)

        scheduledTimers = []
        const ok3 = controller.scheduleRecovery(mockWindow1, 'crash_3', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(ok3).toBe(true)
        expect(controller.getAttempts()).toBe(3)
        expect(scheduledTimers[0].ms).toBe(4000)

        scheduledTimers[0].callback()
        expect(reloadMock1).toHaveBeenCalledTimes(3)

        scheduledTimers = []
        const ok4 = controller.scheduleRecovery(mockWindow1, 'crash_4', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(ok4).toBe(false)
        expect(scheduledTimers.length).toBe(0)
        expect(reloadMock1).toHaveBeenCalledTimes(3)
    })

    it('guards stale window identity when a new window replaces the previous one', () => {
        controller.scheduleRecovery(mockWindow1, 'crash_1', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(scheduledTimers.length).toBe(1)

        controller.scheduleRecovery(mockWindow2, 'crash_on_new_window', () => {
            mockWindow2.webContents?.reloadIgnoringCache()
        })

        expect(controller.getAttempts()).toBe(1)
    })

    it('guards stable-timer target identity so stale window cannot reset attempts for new window', () => {
        controller.scheduleRecovery(mockWindow1, 'crash_1', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        scheduledTimers[0].callback()

        scheduledTimers = []
        controller.onRendererLoaded(mockWindow1)
        expect(scheduledTimers.length).toBe(1)
        const stableTimerCallback = scheduledTimers[0].callback

        controller.scheduleRecovery(mockWindow2, 'crash_2', () => {
            mockWindow2.webContents?.reloadIgnoringCache()
        })
        expect(controller.getAttempts()).toBe(1)

        stableTimerCallback()
        expect(controller.getAttempts()).toBe(1)
    })

    it('onWindowClosed clears timers only when closing the owned active window', () => {
        controller.scheduleRecovery(mockWindow1, 'crash_1', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(scheduledTimers.length).toBe(1)

        // Closing an unowned / stale window does NOT clear timers
        controller.onWindowClosed(mockWindow2)
        expect(scheduledTimers.length).toBe(1)
        expect(controller.getActiveWindow()).toBe(mockWindow1)

        // Closing the owned active window clears all timers
        controller.onWindowClosed(mockWindow1)
        expect(scheduledTimers.length).toBe(0)
        expect(controller.getActiveWindow()).toBeNull()
    })

    it('clears all timers and references when disposed', () => {
        controller.scheduleRecovery(mockWindow1, 'crash_1', () => {
            mockWindow1.webContents?.reloadIgnoringCache()
        })
        expect(scheduledTimers.length).toBe(1)

        controller.dispose()
        expect(controller.isRecoveryPending()).toBe(false)
        expect(scheduledTimers.length).toBe(0)
    })
})

describe('Console pipe error containment (EPIPE)', () => {
    it('identifies EPIPE and ERR_STREAM_DESTROYED as stream pipe errors', () => {
        expect(isStreamPipeError({ code: 'EPIPE' })).toBe(true)
        expect(isStreamPipeError({ code: 'ERR_STREAM_DESTROYED' })).toBe(true)
        expect(isStreamPipeError({ code: 'ECONNRESET' })).toBe(false)
        expect(isStreamPipeError(new Error('general error'))).toBe(false)
        expect(isStreamPipeError(null)).toBe(false)
        expect(isStreamPipeError('string error')).toBe(false)
    })

    it('contains EPIPE error on stdout and stderr without throwing', () => {
        const mockStdout = new EventEmitter()
        const mockStderr = new EventEmitter()
        const fakeProcess = {
            stdout: mockStdout,
            stderr: mockStderr,
        } as unknown as NodeJS.Process

        const teardown = containConsolePipeErrors(fakeProcess)

        expect(() => {
            mockStdout.emit('error', { code: 'EPIPE' })
            mockStderr.emit('error', { code: 'EPIPE' })
        }).not.toThrow()

        expect(() => {
            mockStdout.emit('error', { code: 'ENOMEM' })
        }).toThrow()

        teardown()
    })
})
