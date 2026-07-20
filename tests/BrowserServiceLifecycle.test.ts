/**
 * BrowserService lifecycle invariants (P0):
 * - Ephemeral context IDs are tracked separately from persistent.
 * - Shared browser disconnect disposes only ephemeral state
 *   (maps + per-context bridge release) — never closeAll / never drop persistent locks.
 * - disposeContextState is idempotent across external close, normal close, and error paths.
 *
 * Heavy Playwright/Electron deps are mocked; we exercise public API + lock service contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import {
    ProfileLockService,
    profileLockService,
} from '../src/main/services/ProfileLockService'

// ---- mocks (hoisted) ----

const mockRelease = vi.fn(async (_key?: string) => {})
const mockCloseAll = vi.fn(async () => {})
const mockAcquire = vi.fn(async () => ({
    server: 'http://127.0.0.1:9',
    bridgeKey: 'bridge-test-key',
    bridgeMode: 'anonymized' as const,
}))

vi.mock('electron', () => ({
    app: {
        getPath: () => 'C:\\tmp\\mmo-lifecycle-userData',
    },
}))

vi.mock('../src/main/ipc/settings', () => ({
    loadSettings: () => ({
        hideAutomation: true,
        dataDir: '',
        saveProfiles: true,
    }),
}))

vi.mock('../src/main/automation/BrowserCursorOverlay', () => ({
    injectCursorOverlay: vi.fn(async () => {}),
    setupAutoReinject: vi.fn(() => {}),
}))

vi.mock('../src/main/services/FingerprintService', () => ({
    fingerprintService: {
        generate: () => ({
            userAgent: 'Mozilla/5.0 Test',
            languages: ['en-US'],
            platform: 'Win32',
            hardwareConcurrency: 4,
            deviceMemory: 8,
            screenResolution: { width: 1366, height: 768 },
            colorDepth: 24,
            devicePixelRatio: 1,
            timezone: { name: 'UTC' },
            webgl: { vendor: 'Test', renderer: 'Test' },
            canvasNoise: 0.1,
            audioNoise: 0.1,
        }),
    },
}))

vi.mock('../src/main/automation/StealthPatcher', () => ({
    applyStealth: vi.fn(async () => {}),
    DEFAULT_STEALTH_LEVEL: 'high',
}))

vi.mock('../src/main/services/ProxyBridgeService', () => ({
    proxyBridgeService: {
        acquire: (...args: unknown[]) => mockAcquire(...args),
        release: (...args: unknown[]) => mockRelease(...args),
        closeAll: (...args: unknown[]) => mockCloseAll(...args),
        predictBridgeMode: () => 'anonymized' as const,
    },
}))

type FakeContext = EventEmitter & {
    pages: () => Array<{ isClosed: () => boolean }>
    newPage: () => Promise<FakePage>
    close: () => Promise<void>
    cookies: () => Promise<unknown[]>
    clearCookies: () => Promise<void>
    clearPermissions: () => Promise<void>
    addInitScript: () => Promise<void>
    storageState: () => Promise<unknown>
}

type FakePage = {
    isClosed: () => boolean
    screenshot: () => Promise<Buffer>
    goto: () => Promise<void>
    evaluate: () => Promise<string>
    click: () => Promise<void>
    keyboard: { type: (c: string) => Promise<void> }
    mouse: { wheel: (x: number, y: number) => Promise<void> }
}

function createFakePage(): FakePage {
    return {
        isClosed: () => false,
        screenshot: async () => Buffer.from(''),
        goto: async () => {},
        evaluate: async () => '',
        click: async () => {},
        keyboard: { type: async () => {} },
        mouse: { wheel: async () => {} },
    }
}

function createFakeContext(): FakeContext {
    const ee = new EventEmitter() as FakeContext
    const page = createFakePage()
    ee.pages = () => [page]
    ee.newPage = async () => page
    ee.close = async () => {
        ee.emit('close')
    }
    ee.cookies = async () => []
    ee.clearCookies = async () => {}
    ee.clearPermissions = async () => {}
    ee.addInitScript = async () => {}
    ee.storageState = async () => ({})
    return ee
}

type FakeBrowser = EventEmitter & {
    isConnected: () => boolean
    newContext: () => Promise<FakeContext>
    close: () => Promise<void>
    _setConnected: (v: boolean) => void
}

function createFakeBrowser(): FakeBrowser {
    const ee = new EventEmitter() as FakeBrowser
    let connected = true
    ee.isConnected = () => connected
    ee._setConnected = (v: boolean) => {
        connected = v
    }
    ee.newContext = async () => createFakeContext()
    ee.close = async () => {
        connected = false
        ee.emit('disconnected')
    }
    return ee
}

const fakeBrowser = createFakeBrowser()
const launchPersistentContext = vi.fn(async () => createFakeContext())
const launch = vi.fn(async () => {
    fakeBrowser._setConnected(true)
    return fakeBrowser
})

vi.mock('playwright', () => ({
    chromium: {
        launch: (...args: unknown[]) => launch(...args),
        launchPersistentContext: (...args: unknown[]) => launchPersistentContext(...args),
    },
}))

// Import after mocks
const { BrowserService } = await import('../src/main/automation/BrowserService')

describe('BrowserService lifecycle (ephemeral vs persistent)', () => {
    beforeEach(() => {
        mockRelease.mockClear()
        mockCloseAll.mockClear()
        mockAcquire.mockClear()
        mockAcquire.mockResolvedValue({
            server: 'http://127.0.0.1:9',
            bridgeKey: 'bridge-test-key',
            bridgeMode: 'anonymized' as const,
        })
        launch.mockClear()
        launchPersistentContext.mockClear()
        // Drop any leftover process-global locks from prior tests.
        profileLockService.releaseAll()
        fakeBrowser._setConnected(true)
        fakeBrowser.removeAllListeners('disconnected')
    })

    it('createEphemeralContext does not acquire profile lock', async () => {
        const svc = new BrowserService()
        const id = await svc.createEphemeralContext({ headless: true })
        expect(typeof id).toBe('number')
        expect(profileLockService.listHeld()).toHaveLength(0)
        expect(launch).toHaveBeenCalled()
        expect(launchPersistentContext).not.toHaveBeenCalled()
        await svc.closeContext(id)
    })

    it('createContext acquires normalized profile lock; close releases it (idempotent)', async () => {
        const svc = new BrowserService()
        const profilePath = 'C:\\profiles\\lifecycle-persistent-a'
        const id = await svc.createContext({
            headless: true,
            profilePath,
        })
        expect(profileLockService.isHeld(profilePath)).toBe(true)
        expect(launchPersistentContext).toHaveBeenCalled()

        await svc.closeContext(id)
        expect(profileLockService.isHeld(profilePath)).toBe(false)

        // Second close is no-op (idempotent dispose)
        await svc.closeContext(id)
        expect(profileLockService.isHeld(profilePath)).toBe(false)
    })

    it('external context close disposes lock without leaking', async () => {
        const svc = new BrowserService()
        const profilePath = 'C:\\profiles\\lifecycle-external-close'
        const id = await svc.createContext({ headless: true, profilePath })
        expect(profileLockService.isHeld(profilePath)).toBe(true)

        const ctx = svc.getContext(id)
        expect(ctx).toBeDefined()
        await ctx!.close()

        // close handler runs disposeContextState
        await new Promise((r) => setTimeout(r, 10))
        expect(profileLockService.isHeld(profilePath)).toBe(false)
        expect(svc.getContext(id)).toBeUndefined()

        // Normal close after external close stays idempotent
        await svc.closeContext(id)
        expect(profileLockService.isHeld(profilePath)).toBe(false)
    })

    it('shared browser disconnect disposes ephemeral only; keeps persistent lock', async () => {
        const svc = new BrowserService()
        const profilePath = 'C:\\profiles\\lifecycle-keep-persistent'

        const persistentId = await svc.createContext({ headless: true, profilePath })
        expect(profileLockService.isHeld(profilePath)).toBe(true)

        const ephemeralId = await svc.createEphemeralContext({
            headless: true,
            proxy: { host: '1.2.3.4', port: 8080, username: 'u', password: 'p', type: 'http' },
        })
        expect(svc.getContext(ephemeralId)).toBeDefined()
        expect(svc.getContext(persistentId)).toBeDefined()

        // Simulate shared browser death (ephemeral host only).
        fakeBrowser._setConnected(false)
        fakeBrowser.emit('disconnected')
        await new Promise((r) => setTimeout(r, 30))

        // Ephemeral disposed
        expect(svc.getContext(ephemeralId)).toBeUndefined()
        // Persistent still tracked + lock held
        expect(svc.getContext(persistentId)).toBeDefined()
        expect(profileLockService.isHeld(profilePath)).toBe(true)
        // Must NOT nuke all bridges via closeAll
        expect(mockCloseAll).not.toHaveBeenCalled()

        await svc.closeContext(persistentId)
        expect(profileLockService.isHeld(profilePath)).toBe(false)
    })

    it('create error path does not leave profile lock held', async () => {
        const svc = new BrowserService()
        const profilePath = 'C:\\profiles\\lifecycle-error'
        launchPersistentContext.mockRejectedValueOnce(new Error('launch failed'))

        await expect(
            svc.createContext({ headless: true, profilePath })
        ).rejects.toThrow(/launch failed/)

        expect(profileLockService.isHeld(profilePath)).toBe(false)
        expect(svc.getContext(1)).toBeUndefined()
    })

    it('proxy bridge released once on close (no leak / no double-count via closeAll)', async () => {
        const svc = new BrowserService()
        const id = await svc.createEphemeralContext({
            headless: true,
            proxy: { host: '9.9.9.9', port: 3128, username: 'a', password: 'b', type: 'http' },
        })
        expect(mockAcquire).toHaveBeenCalled()
        await svc.closeContext(id)
        // At least one release for the bridge key; never closeAll from normal close
        expect(mockRelease).toHaveBeenCalled()
        expect(mockCloseAll).not.toHaveBeenCalled()
        // Idempotent second close must not throw
        await svc.closeContext(id)
    })
})

describe('ProfileLockService dispose contract (lifecycle companion)', () => {
    it('release is idempotent and path-key stable via normalizePath', async () => {
        const svc = new ProfileLockService()
        const raw = 'C:\\Profiles\\Lifecycle_Idem'
        const key = svc.normalizePath(raw)

        await svc.acquire(raw, {
            ownerToken: 'browser:42',
            kind: 'browser_service',
            contextId: 42,
        })
        expect(svc.isHeld(key)).toBe(true)
        expect(svc.release(raw, 'browser:42')).toBe(true)
        expect(svc.release(raw, 'browser:42')).toBe(false)
        expect(svc.releaseByContextId(42)).toBeNull()
    })
})
