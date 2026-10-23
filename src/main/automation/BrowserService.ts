import {
    chromium,
    type Browser,
    type BrowserContext,
    type BrowserContextOptions,
    type Page,
} from 'playwright'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { getRotatingLogger } from '../utils/RotatingLogger'
import { app } from 'electron'
import { injectCursorOverlay, setupAutoReinject } from './BrowserCursorOverlay'
import { loadSettings } from '../ipc/settings'
import { fingerprintService, BrowserFingerprint } from '../services/FingerprintService'
import { proxyBridgeService, type ProxyBridgeMode } from '../services/ProxyBridgeService'
import { profileLockService } from '../services/ProfileLockService'
import { applyStealth, DEFAULT_STEALTH_LEVEL, type StealthLevel } from './StealthPatcher'
import type { ProxyRuntimeReasonCode } from '../../shared/proxy-contracts'
import { LOW_RESOURCE_LIMITS } from '../../shared/performance-contracts'
import { browserResourceGovernor, BrowserResourceGovernor, BrowserResourceReservation, BrowserResourceWaitError, type BrowserAdmissionOptions } from '../services/BrowserResourceGovernor'

type PersistentContextOptions = NonNullable<
    Parameters<typeof chromium.launchPersistentContext>[1]
>

export interface BrowserConfig extends BrowserAdmissionOptions {
    resourceReservation?: BrowserResourceReservation
    headless?: boolean
    hideAutomation?: boolean
    saveProfiles?: boolean
    cleanProfileOnStart?: boolean
    proxy?: {
        host: string
        port: number
        username?: string
        password?: string
        type?: 'http' | 'https' | 'socks5'
    }
    profilePath?: string
    viewport?: { width: number; height: number }
    userAgent?: string
}

/** Structured reason codes for runtime-parity proxy preflight (Playwright + ProxyBridge path). */
export type ProxyRuntimePreflightReasonCode = Exclude<ProxyRuntimeReasonCode, 'proxy_not_found'>

export interface ProxyRuntimePreflightResult {
    ok: boolean
    reasonCode: ProxyRuntimePreflightReasonCode
    latencyMs: number
    observedIp: string | null
    bridgeMode: ProxyBridgeMode
    probeUrl: string
}

const RUNTIME_PREFLIGHT_DEFAULT_TIMEOUT_MS = 20_000
const RUNTIME_PREFLIGHT_PROBE_URL = 'https://api.ipify.org?format=json'

export interface BrowserRuntimeStats {
    contextCount: number
    trackedPageCount: number
    totalTabCount: number
    timestamp: string
}

type ProxyType = 'http' | 'https' | 'socks5'

// ============================================================
// Chrome Arguments Generation
// ============================================================
const getChromeArgs = () => {
    const settings = loadSettings()
    return [
        // Anti-detection
        ...(settings.hideAutomation !== false ? ['--disable-blink-features=AutomationControlled'] : []),

        // Essential stability flags (safe, do not leak automation)
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-features=TranslateUI',

        // NOTE: Re-added GPU flags - many Windows VM/RDP setups render a black screen without these.
        // Standard Chrome behavior flags (non-suspicious)
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-notifications',
        '--lang=en-US',
        '--window-size=1366,900',

        // WebRTC: prevent local IP leak through WebRTC
        '--enforce-webrtc-ip-permission-check',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]
}

function isStealthLevel(value: unknown): value is StealthLevel {
    return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'paranoid'
}

const resolveStealthLevel = (): StealthLevel => {
    const settings = loadSettings()
    return isStealthLevel(settings.stealthLevel) ? settings.stealthLevel : DEFAULT_STEALTH_LEVEL
}

// Legacy allow/block list kept only for future diagnostics.
// Runtime resource blocking is intentionally disabled so Chrome can render
// fonts, icons, stylesheets, images, and map tiles completely.
const BLOCKED_DOMAINS = [
    'googlesyndication.com',
    'googleadservices.com',
    'doubleclick.net',
    'facebook.com/tr',
    // NOTE: GA/GTM are NOT blocked — websites need these to count traffic visits
    // 'analytics.google.com',
    // 'google-analytics.com',
    // 'googletagmanager.com',
    'hotjar.com',
    'clarity.ms',
    'sentry.io',
    // NOTE: Fonts are NOT blocked — blocking fonts is detectable behavior
    // 'fonts.googleapis.com',
    // 'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'unpkg.com',
    'cdn.jsdelivr.net',
    'code.jquery.com',
]

function logProxy(message: string) {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${message}\n`
    console.log(message)
    try {
        const logPath = join(app.getPath('userData'), 'proxy-debug.log')
        getRotatingLogger('fproxy', logPath).write(line)
    } catch { /* ignore */ }
}

function normalizeProxyType(type?: string): ProxyType {
    const normalized = (type || 'http').toLowerCase().trim()
    if (normalized === 'https' || normalized === 'socks5') return normalized
    return 'http'
}

function buildPlaywrightProxyServer(proxy: { host: string; port: number; type?: ProxyType }): string {
    const proxyType = normalizeProxyType(proxy.type)
    let host = proxy.host
        .trim()
        .replace(/^[a-z0-9+.-]+:\/\//i, '')
        .replace(/\/+$/, '')

    // If host already includes ":port" and it matches the dedicated port field, strip it to avoid duplication.
    if (host.startsWith('[')) {
        const ipv6WithPort = host.match(/^\[([^\]]+)\]:(\d+)$/)
        if (ipv6WithPort && Number.parseInt(ipv6WithPort[2], 10) === proxy.port) {
            host = `[${ipv6WithPort[1]}]`
        }
    } else {
        const lastColon = host.lastIndexOf(':')
        if (lastColon > -1 && host.indexOf(':') === lastColon) {
            const maybePort = Number.parseInt(host.slice(lastColon + 1), 10)
            if (Number.isFinite(maybePort) && maybePort === proxy.port) {
                host = host.slice(0, lastColon)
            }
        }
    }

    return `${proxyType}://${host}:${proxy.port}`
}

export class BrowserService {
    private browser: Browser | null = null
    private browserHeadless: boolean | null = null
    private browserOpChain: Promise<void> = Promise.resolve()

    private contexts: Map<number, BrowserContext> = new Map()
    private pages: Map<number, Page> = new Map()
    private contextFingerprints: Map<number, BrowserFingerprint> = new Map()
    private contextProxyBridgeKeys: Map<number, string> = new Map()
    /** Normalized profilePath held under ProfileLockService for this context (persistent only). */
    private contextProfilePaths: Map<number, string> = new Map()
    private contextLockTokens: Map<number, string> = new Map()
    /**
     * Context IDs created via createEphemeralContext (shared `this.browser`).
     * Persistent contexts (launchPersistentContext) are NEVER in this set.
     */
    private ephemeralContextIds: Set<number> = new Set()
    private contextIdCounter = 0
    private readonly resourceReleases = new Map<number, () => void>()
    private ephemeralLaunches = 0
    private idleBrowserTimer: ReturnType<typeof setTimeout> | null = null
    private admissionEpoch = 0

    constructor(private readonly governor: BrowserResourceGovernor = browserResourceGovernor) {}

    async reserveResources(options: BrowserAdmissionOptions = {}): Promise<BrowserResourceReservation> {
        return new BrowserResourceReservation(this.governor, await this.governor.acquire(options))
    }

    private async withContextAdmission(
        config: BrowserConfig,
        ephemeral: boolean,
        create: (contextId: number) => Promise<number>,
    ): Promise<number> {
        const epoch = this.admissionEpoch
        const release = config.resourceReservation?.consume(this.governor) ?? await this.governor.acquire(config)
        const contextId = ++this.contextIdCounter
        this.resourceReleases.set(contextId, release)
        if (ephemeral) {
            this.clearIdleBrowserTimer()
            this.ephemeralLaunches += 1
        }
        try {
            if (epoch !== this.admissionEpoch || config.signal?.aborted || config.shouldAbort?.()) {
                throw new BrowserResourceWaitError('Browser launch cancelled')
            }
            if (!ephemeral && this.governor.isEnabled() && this.browser
                && this.ephemeralContextIds.size === 0 && this.ephemeralLaunches === 0) {
                await this.withBrowserLock(async () => {
                    // A parallel ephemeral launch may have started while the
                    // lock was pending; never reclaim a browser it now owns.
                    if (this.ephemeralContextIds.size === 0 && this.ephemeralLaunches === 0) {
                        await this.resetBrowserState('low_resource_persistent_handoff')
                    }
                })
            }
            const result = await create(contextId)
            if (epoch !== this.admissionEpoch || config.signal?.aborted || config.shouldAbort?.()) {
                await this.closeContext(result)
                throw new BrowserResourceWaitError('Browser launch cancelled')
            }
            if (!this.contexts.has(result)) throw new Error('Browser closed during launch')
            return result
        } catch (error) {
            await this.disposeContextState(contextId)
            throw error
        } finally {
            if (ephemeral) this.ephemeralLaunches -= 1
            this.scheduleIdleBrowserClose()
        }
    }

    private resolveResourceViewport(config: BrowserConfig, fingerprint: BrowserFingerprint): { width: number; height: number } {
        const requested = config.viewport ?? fingerprint.screenResolution
        if (!this.governor.isEnabled()) return requested
        const viewport = { width: Math.min(1280, requested.width), height: Math.min(720, requested.height) }
        // Keep reported screen dimensions aligned with the smaller render surface.
        fingerprint.screenResolution = viewport
        return viewport
    }

    private clearIdleBrowserTimer(): void {
        if (!this.idleBrowserTimer) return
        clearTimeout(this.idleBrowserTimer)
        this.idleBrowserTimer = null
    }

    private scheduleIdleBrowserClose(): void {
        if (!this.governor.isEnabled() || !this.browser
            || this.ephemeralContextIds.size > 0 || this.ephemeralLaunches > 0) {
            this.clearIdleBrowserTimer()
            return
        }
        if (this.idleBrowserTimer) return
        this.idleBrowserTimer = setTimeout(() => {
            this.idleBrowserTimer = null
            void this.withBrowserLock(async () => {
                if (this.governor.isEnabled() && this.ephemeralContextIds.size === 0
                    && this.ephemeralLaunches === 0) {
                    await this.resetBrowserState('low_resource_idle')
                }
            }).catch((error: unknown) => console.error('[BrowserService] Idle cleanup failed:', error))
        }, LOW_RESOURCE_LIMITS.browserIdleMs)
        this.idleBrowserTimer.unref?.()
    }

    private async withBrowserLock<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.browserOpChain
        let release: () => void = () => { }
        this.browserOpChain = new Promise<void>((resolve) => {
            release = resolve
        })

        await previous
        try {
            return await operation()
        } finally {
            release()
        }
    }

    private clearBrowserReferences(reason: string): void {
        this.clearIdleBrowserTimer()
        if (this.browser || this.browserHeadless !== null) {
            logProxy(`[BrowserService] Browser state cleared (${reason})`)
        }
        this.browser = null
        this.browserHeadless = null
    }

    /**
     * Single source of truth for profile path identity (matches ProfileLockService keys).
     */
    private resolveProfilePathKey(profilePath: string): string {
        return profileLockService.normalizePath(profilePath)
    }

    /** Drop in-process profile ownership for a persistent context (idempotent). */
    private releaseProfileLock(contextId: number): void {
        const profilePath = this.contextProfilePaths.get(contextId)
        const ownerToken = this.contextLockTokens.get(contextId)
        if (profilePath) {
            profileLockService.release(profilePath, ownerToken)
        } else if (this.contextLockTokens.has(contextId)) {
            // Partial state (path map missing) — free by contextId.
            profileLockService.releaseByContextId(contextId)
        }
        this.contextProfilePaths.delete(contextId)
        this.contextLockTokens.delete(contextId)
    }

    /**
     * Idempotent cleanup of all tracked maps / proxy bridge / profile lock for one context.
     * Does NOT close the Playwright BrowserContext (caller may already have closed it).
     * Safe for: external context close, normal close, create error, shared-browser disconnect.
     */
    private async disposeContextState(contextId: number): Promise<void> {
        const releaseResources = this.resourceReleases.get(contextId)
        this.resourceReleases.delete(contextId)
        // Take bridge key atomically before any await (JS single-thread until await).
        const bridgeKey = this.contextProxyBridgeKeys.get(contextId)
        this.contextProxyBridgeKeys.delete(contextId)

        const hadContext = this.contexts.delete(contextId)
        const hadPage = this.pages.delete(contextId)
        const hadFingerprint = this.contextFingerprints.delete(contextId)
        const hadEphemeral = this.ephemeralContextIds.delete(contextId)
        const hadLock =
            this.contextProfilePaths.has(contextId) || this.contextLockTokens.has(contextId)

        this.releaseProfileLock(contextId)

        try {
            if (bridgeKey) await proxyBridgeService.release(bridgeKey)
        } finally {
            releaseResources?.()
            this.scheduleIdleBrowserClose()
        }

        if (hadContext || hadPage || hadFingerprint || hadEphemeral || hadLock || bridgeKey) {
            logProxy(
                `[BrowserService] Disposed context state ${contextId}` +
                    ` (ephemeral=${hadEphemeral}, bridge=${bridgeKey ? 'yes' : 'no'}, lock=${hadLock})`
            )
        }
    }

    /**
     * Shared-browser disconnect path: dispose ONLY ephemeral contexts.
     * Persistent contexts use independent launchPersistentContext browsers and must keep
     * their maps, profile locks, and proxy bridges.
     * Does NOT call proxyBridgeService.closeAll().
     */
    private async disposeEphemeralStateOnly(reason: string): Promise<void> {
        const ids = Array.from(this.ephemeralContextIds)
        if (ids.length === 0) {
            return
        }
        logProxy(
            `[BrowserService] Disposing ${ids.length} ephemeral context(s) after ${reason}` +
                ` (persistent locks/bridges preserved)`
        )
        await Promise.all(ids.map((id) => this.disposeContextState(id)))
    }

    /** Remove locks whose context is no longer tracked (crash / missed close). */
    private cleanupStaleProfileLocks(): void {
        const removed = profileLockService.cleanupStale({
            isContextAlive: (contextId) =>
                this.contexts.has(contextId) || this.contextProfilePaths.has(contextId),
        })
        if (removed > 0) {
            logProxy(`[BrowserService] Cleaned ${removed} stale profile lock(s)`)
        }
    }

    private attachDisconnectHandler(browser: Browser): void {
        browser.on('disconnected', () => {
            if (this.browser === browser) {
                this.clearBrowserReferences('disconnected')
                // Shared browser hosts ephemeral contexts only — never nuke persistent state.
                void this.disposeEphemeralStateOnly('browser_disconnected')
            }
        })
    }

    private async resetBrowserState(reason: string): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close()
            } catch {
                // ignore
            }
        }
        this.clearBrowserReferences(reason)
        // Closing the shared browser only invalidates ephemeral contexts.
        await this.disposeEphemeralStateOnly(reason)
    }

    private isBrowserClosedError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error ?? '')
        return /target page, context or browser has been closed|target closed|browser\.newcontext|browser has been closed/i.test(message)
    }

    private getProfilesPath(): string {
        const settings = loadSettings()
        // If the user specified a custom data directory for storage, use it as the base
        const baseDir = (settings.dataDir && settings.dataDir.trim() !== '') 
            ? settings.dataDir 
            : app.getPath('userData')
            
        const profilesPath = join(baseDir, 'profiles')
        if (!existsSync(profilesPath)) {
            mkdirSync(profilesPath, { recursive: true })
        }
        return profilesPath
    }

    private cleanChromeLockFiles(profilePath: string): void {
        if (!existsSync(profilePath)) return
        // Stale singleton/lock files from crashed Chrome or prior launch cause "context closed" immediately on next launchPersistentContext
        const lockNames = ['SingletonLock', 'SingletonCookie', 'LOCK', 'LOCK~', 'LOCK.bak']
        for (const name of lockNames) {
            const p = join(profilePath, name)
            try {
                if (existsSync(p)) {
                    rmSync(p, { force: true })
                    logProxy(`[BrowserService] Removed stale Chrome lock: ${name}`)
                }
            } catch {
                // Locked by live Chrome or permission — ignore, launch will surface real conflict if any
            }
        }
    }

    private prepareProfileDirectory(profilePath: string, cleanProfileOnStart: boolean): string {
        // Always attempt stale lock recovery first (critical for account profile reuse after crash/other Chrome)
        this.cleanChromeLockFiles(profilePath)

        if (cleanProfileOnStart && existsSync(profilePath)) {
            rmSync(profilePath, { recursive: true, force: true })
        }

        if (!existsSync(profilePath)) {
            mkdirSync(profilePath, { recursive: true })
        }

        return profilePath
    }

    /** Get a browser context by its ID (used by window tiling) */
    getContext(contextId: number): BrowserContext | undefined {
        return this.contexts.get(contextId)
    }

    private async ensureBrowserMode(headless: boolean): Promise<void> {
        if (this.browser && !this.browser.isConnected()) {
            this.clearBrowserReferences('detected_disconnected')
            // Shared browser died — ephemeral only; leave persistent contexts/locks alone.
            await this.disposeEphemeralStateOnly('detected_disconnected')
        }

        if (!this.browser) {
            this.browser = await chromium.launch({
                headless,
                channel: 'chrome',
                args: getChromeArgs(),
            })
            this.attachDisconnectHandler(this.browser)
            this.browserHeadless = headless
            logProxy(`[BrowserService] Shared browser initialized (headless=${headless})`)
            return
        }

        if (this.browserHeadless === headless) {
            return
        }

        // Mode change only when no ephemeral contexts use the shared browser.
        // Persistent contexts are independent and do not block shared-browser relaunch.
        if (this.ephemeralContextIds.size > 0) {
            logProxy(
                `[BrowserService] Browser mode mismatch requested=${headless} current=${this.browserHeadless}; keeping current mode because ${this.ephemeralContextIds.size} ephemeral context(s) are active`
            )
            return
        }

        await this.resetBrowserState('headless_mode_change')

        this.browser = await chromium.launch({
            headless,
            channel: 'chrome',
            args: getChromeArgs(),
        })
        this.attachDisconnectHandler(this.browser)
        this.browserHeadless = headless
        logProxy(`[BrowserService] Relaunched shared browser with headless=${headless}`)
    }

    // Initialize shared browser (no proxy)
    async initBrowser(headless: boolean = true): Promise<void> {
        await this.withBrowserLock(async () => {
            await this.ensureBrowserMode(headless)
        })
    }

    async closeBrowser(): Promise<void> {
        this.admissionEpoch += 1
        this.clearIdleBrowserTimer()
        await this.withBrowserLock(async () => {
            // Close every tracked context (persistent + ephemeral) via unified dispose path.
            const trackedIds = new Set<number>([
                ...Array.from(this.contexts.keys()),
                ...Array.from(this.contextProxyBridgeKeys.keys()),
                ...Array.from(this.contextProfilePaths.keys()),
                ...Array.from(this.ephemeralContextIds),
            ])
            for (const id of Array.from(trackedIds)) {
                try {
                    await this.closeContextInternal(id)
                } catch {
                    /* ignore */
                }
            }
            await this.resetBrowserState('close_browser')
            logProxy('[BrowserService] All browsers closed')
        })
    }

    // ============================================================
    // Create persistent context with full rendering enabled
    // ============================================================
    async createContext(config: BrowserConfig = {}): Promise<number> {
        return this.withContextAdmission(config, false, (contextId) => this.createPersistentContextInternal(contextId, config))
    }

    private async createPersistentContextInternal(contextId: number, config: BrowserConfig): Promise<number> {
        const rawProfilePath =
            config.profilePath || join(this.getProfilesPath(), `runtime_context_${contextId}`)
        const ownerToken = `browser:${contextId}`
        const profilePathKey = this.resolveProfilePathKey(rawProfilePath)

        // Drop orphan in-process locks before attempting exclusive acquire.
        this.cleanupStaleProfileLocks()

        // Exclusive ownership BEFORE prepare/launch (ephemeral path never uses this).
        await profileLockService.acquire(rawProfilePath, {
            ownerToken,
            kind: 'browser_service',
            contextId,
            label: `browser #${contextId}`,
        })
        this.contextProfilePaths.set(contextId, profilePathKey)
        this.contextLockTokens.set(contextId, ownerToken)

        let usedProxy = false
        const proxy = config.proxy
        let bridgeKey: string | undefined
        let resolvedProxy: { server: string; username?: string; password?: string; bridgeKey?: string } | null = null

        if (proxy) {
            try {
                resolvedProxy = await proxyBridgeService.acquire({
                    host: proxy.host,
                    port: proxy.port,
                    username: proxy.username,
                    password: proxy.password,
                    type: normalizeProxyType(proxy.type),
                })
            } catch (proxyErr) {
                await this.disposeContextState(contextId)
                throw proxyErr
            }

            bridgeKey = resolvedProxy.bridgeKey
            if (bridgeKey) this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            const upstreamProxy = buildPlaywrightProxyServer(proxy)
            const bridgeLabel = bridgeKey ? ` (bridge -> ${upstreamProxy})` : ''
            logProxy(`[BrowserService] Context ${contextId}: proxy=${resolvedProxy.server}${bridgeLabel}`)
            usedProxy = true
        }

        const requestedHeadless = config.headless ?? false

        // Single source of truth: fingerprint UA + Client Hints + WebGL stay in sync
        const fingerprint = config.userAgent
            ? fingerprintService.generateForUserAgent(config.userAgent)
            : fingerprintService.generate()
        this.contextFingerprints.set(contextId, fingerprint)
        const viewport = this.resolveResourceViewport(config, fingerprint)

        // Anti-detection context options — unique fingerprint per session
        const launchOptions: PersistentContextOptions = {
            headless: requestedHeadless,
            channel: 'chrome',
            args: getChromeArgs(),
            viewport,
            userAgent: fingerprint.userAgent,
            locale: fingerprint.languages[0] || 'en-US',
            timezoneId: fingerprint.timezone.name,
        }

        if (proxy) {
            launchOptions.proxy = {
                server: resolvedProxy?.server || buildPlaywrightProxyServer(proxy),
                username: resolvedProxy?.username,
                password: resolvedProxy?.password
            }
        }

        let context: BrowserContext | null = null
        try {
            const profilePath = this.prepareProfileDirectory(
                rawProfilePath,
                config.cleanProfileOnStart === true
            )
            // Keep map aligned with prepared path (same normalized key via resolver).
            this.contextProfilePaths.set(contextId, this.resolveProfilePathKey(profilePath))

            context = await this.withBrowserLock(async () => {
                return await chromium.launchPersistentContext(profilePath, launchOptions)
            })

            // Single stealth path only (StealthPatcher) — no legacy double-inject
            await applyStealth(context, { level: resolveStealthLevel(), fingerprint })

            this.contexts.set(contextId, context)
            // Persistent — never mark as ephemeral.
            if (bridgeKey) {
                this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            }

            // External/user close: full idempotent dispose (maps + bridge + lock).
            context.on('close', () => {
                void this.disposeContextState(contextId)
            })

            const page = context.pages().find(candidate => !candidate.isClosed()) || await context.newPage()

            // Inject fake cursor overlay for visual feedback
            if (!this.governor.isEnabled()) {
                await injectCursorOverlay(page)
                setupAutoReinject(page)
            }

            this.pages.set(contextId, page)
        } catch (error) {
            if (context) {
                try { await context.close() } catch { /* ignore */ }
            }
            // Ensure bridge is tracked so dispose releases it even if never registered.
            if (bridgeKey) {
                this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            }
            await this.disposeContextState(contextId)
            throw error
        }

        logProxy(`[BrowserService] ✓ Context ${contextId} ready (proxy: ${usedProxy ? 'YES' : 'NO'}, total: ${this.contexts.size})`)
        return contextId
    }

    // ============================================================
    // Create ephemeral context (100% in-memory, zero disk I/O)
    // Used for traffic visits that don't need persistent login sessions.
    // Each call produces a brand-new browser context with unique fingerprint,
    // fresh cookies/localStorage, and optional proxy — all in RAM.
    // ============================================================
    async createEphemeralContext(config: BrowserConfig = {}): Promise<number> {
        return this.withContextAdmission(config, true, (contextId) => this.createEphemeralContextInternal(contextId, config))
    }

    private async createEphemeralContextInternal(contextId: number, config: BrowserConfig): Promise<number> {
        const requestedHeadless = config.headless ?? false

        // Ensure shared browser is running in the correct mode
        await this.withBrowserLock(async () => {
            await this.ensureBrowserMode(requestedHeadless)
        })

        if (!this.browser) {
            throw new Error('Browser not available after ensureBrowserMode')
        }

        let usedProxy = false
        const proxy = config.proxy
        let bridgeKey: string | undefined
        let resolvedProxy: { server: string; username?: string; password?: string; bridgeKey?: string } | null = null

        if (proxy) {
            resolvedProxy = await proxyBridgeService.acquire({
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password,
                type: normalizeProxyType(proxy.type),
            })

            bridgeKey = resolvedProxy.bridgeKey
            if (bridgeKey) this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            const upstreamProxy = buildPlaywrightProxyServer(proxy)
            const bridgeLabel = bridgeKey ? ` (bridge -> ${upstreamProxy})` : ''
            logProxy(`[BrowserService] Ephemeral ${contextId}: proxy=${resolvedProxy.server}${bridgeLabel}`)
            usedProxy = true
        }

        // Single source of truth: fingerprint stays consistent with effective UA
        const fingerprint = config.userAgent
            ? fingerprintService.generateForUserAgent(config.userAgent)
            : fingerprintService.generate()
        this.contextFingerprints.set(contextId, fingerprint)
        const viewport = this.resolveResourceViewport(config, fingerprint)

        const contextOptions: BrowserContextOptions = {
            viewport,
            userAgent: fingerprint.userAgent,
            locale: fingerprint.languages[0] || 'en-US',
            timezoneId: fingerprint.timezone.name,
        }

        if (proxy) {
            contextOptions.proxy = {
                server: resolvedProxy?.server || buildPlaywrightProxyServer(proxy),
                username: resolvedProxy?.username,
                password: resolvedProxy?.password,
            }
        }

        let context: BrowserContext | null = null
        try {
            context = await this.browser.newContext(contextOptions)

            // Single stealth path only (StealthPatcher) — no legacy double-inject
            await applyStealth(context, { level: resolveStealthLevel(), fingerprint })

            this.contexts.set(contextId, context)
            this.ephemeralContextIds.add(contextId)
            if (bridgeKey) {
                this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            }

            // External close / shared-browser teardown: full idempotent dispose.
            context.on('close', () => {
                void this.disposeContextState(contextId)
            })

            const page = await context.newPage()

            // Inject fake cursor overlay for visual feedback
            if (!this.governor.isEnabled()) {
                await injectCursorOverlay(page)
                setupAutoReinject(page)
            }

            this.pages.set(contextId, page)
        } catch (error) {
            if (context) {
                try { await context.close() } catch { /* ignore */ }
            }
            if (bridgeKey) {
                this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            }
            this.ephemeralContextIds.add(contextId)
            await this.disposeContextState(contextId)
            throw error
        }

        logProxy(`[BrowserService] ✓ Ephemeral ${contextId} ready (proxy: ${usedProxy ? 'YES' : 'NO'}, in-memory, total: ${this.contexts.size})`)
        return contextId
    }

    getPage(contextId: number): Page | undefined {
        return this.pages.get(contextId)
    }

    getRuntimeStats(): BrowserRuntimeStats {
        let totalTabCount = 0
        this.contexts.forEach((context) => {
            try {
                totalTabCount += context.pages().length
            } catch {
                // Context could be closing; ignore this sample.
            }
        })

        return {
            contextCount: this.contexts.size,
            trackedPageCount: this.pages.size,
            totalTabCount,
            timestamp: new Date().toISOString(),
        }
    }

    // Reliable Google login detection (STRICT): true ONLY if BOTH strong auth cookie groups present.
    // - SAPISID group: 'SAPISID' OR '__Secure-1PSAPISID' (API auth, only after real sign-in)
    // - SID group: 'SID' OR '__Secure-1PSID' (main session)
    // Cookies must be on .google.com domain AND have non-empty value.
    // HSID/SSID/APISID/NID/CONSENT or single group alone are NOT sufficient (appear early/mid-flow).
    // Used by manual/auto login, challenge loops, TrafficBoost verify, checkLiveDie.
    // Never logs cookie values. Concise confirm log only.
    private hasStrongGoogleAuthCookies(cookies: any[]): boolean {
        if (!Array.isArray(cookies) || cookies.length === 0) return false
        const gCookies = cookies.filter((c: any) =>
            c &&
            typeof c.domain === 'string' &&
            (c.domain === '.google.com' || c.domain.endsWith('.google.com') || c.domain.includes('google.com')) &&
            c.value && String(c.value).trim().length > 0
        )
        if (gCookies.length === 0) return false
        const names = new Set(gCookies.map((c: any) => c.name))
        const hasSapisid = names.has('SAPISID') || names.has('__Secure-1PSAPISID')
        const hasSid = names.has('SID') || names.has('__Secure-1PSID')
        return hasSapisid && hasSid
    }

    async isGoogleLoggedIn(contextId?: number, context?: BrowserContext): Promise<boolean> {
        try {
            let ctx = context
            if (!ctx && typeof contextId === 'number') {
                ctx = this.contexts.get(contextId)
            }
            if (!ctx) return false

            const ck = await ctx.cookies().catch(() => [])
            if (this.hasStrongGoogleAuthCookies(ck)) {
                console.log('[BrowserService] login confirmed (SAPISID+SID present)')
                return true
            }

            // No light URL/avatar supplement: isGoogleLoggedIn returns true ONLY on the strict cookie AND above.
            // (myaccount URL is secondary signal only in callers; still gated by this cookie check.)
            return false
        } catch {
            return false
        }
    }

    async saveContextState(contextId: number, profilePath: string): Promise<void> {
        const settings = loadSettings()
        if (settings.saveProfiles === false) return

        const context = this.contexts.get(contextId)
        if (!context) return
        if (!existsSync(profilePath)) mkdirSync(profilePath, { recursive: true })
        try {
            await context.storageState({ path: join(profilePath, 'state.json') })
        } catch { /* ignore - context may already be closed */ }
    }

    async clearBrowserCache(contextId: number): Promise<void> {
        const context = this.contexts.get(contextId)
        if (context) {
            try {
                await context.clearCookies()
                await context.clearPermissions()
            } catch { /* ignore */ }
        }
    }

    private async closeContextInternal(contextId: number): Promise<void> {
        const context = this.contexts.get(contextId)
        if (context) {
            try {
                await context.close()
            } catch {
                /* ignore — may already be closed externally */
            }
        }
        // Unified path: maps + bridge + lock (idempotent with context 'close' handler).
        await this.disposeContextState(contextId)
        logProxy(`[BrowserService] Context ${contextId} closed (remaining: ${this.contexts.size})`)
    }

    async closeContext(contextId: number): Promise<void> {
        await this.withBrowserLock(async () => {
            await this.closeContextInternal(contextId)
        })
    }

    getRandomViewport(): { width: number; height: number } {
        const viewports = [
            { width: 1366, height: 768 },
            { width: 1440, height: 900 },
            { width: 1536, height: 864 },
            { width: 1920, height: 1080 },
            { width: 1280, height: 720 }
        ]
        return viewports[Math.floor(Math.random() * viewports.length)]
    }

    /** Delegates to FingerprintService — single UA pool (Chrome 128–131). */
    getRandomUserAgent(): string {
        return fingerprintService.getRandomUserAgent()
    }

    async takeScreenshot(contextId: number, path: string): Promise<string> {
        const page = this.pages.get(contextId)
        if (!page) throw new Error('No page for context')
        await page.screenshot({ path, fullPage: false })
        return path
    }

    async randomDelay(minMs: number, maxMs: number): Promise<void> {
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
        await new Promise(resolve => setTimeout(resolve, delay))
    }

    async humanType(page: Page, selector: string, text: string): Promise<void> {
        await page.click(selector)
        for (const char of text) {
            await page.keyboard.type(char)
            await this.randomDelay(50, 150)
        }
    }

    async humanScroll(page: Page, direction: 'up' | 'down' = 'down', amount: number = 300): Promise<void> {
        const delta = direction === 'down' ? amount : -amount
        await page.mouse.wheel(0, delta)
        await this.randomDelay(200, 500)
    }

    /**
     * Runtime-parity proxy preflight: same ProxyBridge + ephemeral Playwright path as live traffic.
     * Bounded timeout; always closes context/bridge in finally. Never logs credentials.
     */
    async testProxyRuntimeParity(
        proxy: NonNullable<BrowserConfig['proxy']>,
        options: { timeoutMs?: number; probeUrl?: string } = {}
    ): Promise<ProxyRuntimePreflightResult> {
        const timeoutMs = Math.max(
            5_000,
            Math.min(options.timeoutMs ?? RUNTIME_PREFLIGHT_DEFAULT_TIMEOUT_MS, 45_000)
        )
        const probeUrl = options.probeUrl || RUNTIME_PREFLIGHT_PROBE_URL
        const navTimeoutMs = Math.max(3_000, Math.min(15_000, timeoutMs - 2_000))
        const start = Date.now()
        const deadline = start + timeoutMs

        const proxyType = normalizeProxyType(proxy.type)
        let bridgeMode: ProxyBridgeMode = proxyBridgeService.predictBridgeMode({
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            type: proxyType,
        })

        const safeLabel = `${sanitizeHostForLog(proxy.host)}:${proxy.port}`
        logProxy(`[BrowserService] Runtime preflight start host=${safeLabel} type=${proxyType} bridgeMode=${bridgeMode}`)

        let contextId: number | null = null

        const fail = (
            reasonCode: ProxyRuntimePreflightReasonCode,
            observedIp: string | null = null
        ): ProxyRuntimePreflightResult => ({
            ok: false,
            reasonCode,
            latencyMs: Date.now() - start,
            observedIp,
            bridgeMode,
            probeUrl,
        })

        try {
            if (Date.now() > deadline) {
                return fail('timeout')
            }

            try {
                contextId = await this.createEphemeralContext({
                    headless: true,
                    proxy: {
                        host: proxy.host,
                        port: proxy.port,
                        username: proxy.username,
                        password: proxy.password,
                        type: proxyType,
                    },
                })
            } catch (createErr) {
                const mapped = mapProxyNavigationError(createErr)
                if (mapped === 'proxy_auth_required' || mapped === 'proxy_connection_failed') {
                    return fail(mapped)
                }
                const msg = (createErr instanceof Error ? createErr.message : String(createErr)).toLowerCase()
                if (/anonymize|proxy-chain|bridge|econnrefused|enotfound/.test(msg)) {
                    return fail('bridge_acquire_failed')
                }
                return fail('context_create_failed')
            }

            // Reflect actual bridge usage after createEphemeralContext acquire
            bridgeMode = this.contextProxyBridgeKeys.has(contextId) ? 'anonymized' : 'direct'

            if (Date.now() > deadline) {
                return fail('timeout')
            }

            const page = this.getPage(contextId)
            if (!page) {
                return fail('context_create_failed')
            }

            const remainingNavMs = Math.max(1_000, Math.min(navTimeoutMs, deadline - Date.now()))
            try {
                await page.goto(probeUrl, {
                    timeout: remainingNavMs,
                    waitUntil: 'domcontentloaded',
                })
            } catch (navErr) {
                if (Date.now() >= deadline) {
                    return fail('timeout')
                }
                return fail(mapProxyNavigationError(navErr))
            }

            let observedIp: string | null = null
            try {
                const bodyText = await page.evaluate(() => (document.body?.textContent || '').trim())
                observedIp = parseObservedIp(bodyText)
            } catch {
                observedIp = null
            }

            if (!observedIp) {
                return fail('ip_unobserved')
            }

            const latencyMs = Date.now() - start
            logProxy(
                `[BrowserService] Runtime preflight OK host=${safeLabel} ip=${observedIp} latencyMs=${latencyMs} bridgeMode=${bridgeMode}`
            )
            return {
                ok: true,
                reasonCode: 'ok',
                latencyMs,
                observedIp,
                bridgeMode,
                probeUrl,
            }
        } catch (err) {
            const mapped = mapProxyNavigationError(err)
            return fail(mapped === 'navigation_failed' ? 'unknown_error' : mapped)
        } finally {
            if (contextId !== null) {
                try {
                    await this.closeContext(contextId)
                } catch {
                    // ignore cleanup errors
                }
            }
        }
    }
}

function sanitizeHostForLog(rawHost: string): string {
    return rawHost
        .trim()
        .replace(/^[a-z0-9+.-]+:\/\//i, '')
        .replace(/\/+$/, '')
        .split('@')
        .pop() || 'unknown'
}

function parseObservedIp(bodyText: string): string | null {
    if (!bodyText) return null
    try {
        const json = JSON.parse(bodyText) as { ip?: unknown; origin?: unknown }
        if (typeof json.ip === 'string' && json.ip.trim()) {
            return json.ip.trim()
        }
        if (typeof json.origin === 'string' && json.origin.trim()) {
            // httpbin-style: may be "ip" or "ip, ip"
            return json.origin.split(',')[0].trim() || null
        }
    } catch {
        // plain text IP
    }
    const ipv4 = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
    if (ipv4) return ipv4[0]
    return null
}

function mapProxyNavigationError(error: unknown): ProxyRuntimePreflightReasonCode {
    const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
    if (/timeout|timed[_ ]?out/.test(msg)) return 'navigation_timeout'
    if (/407|proxy.?auth|authentication required|proxy authentication/.test(msg)) return 'proxy_auth_required'
    if (
        /err_proxy_connection_failed|err_tunnel_connection_failed|proxy connection|err_proxy|socks|tunnel_connection/.test(
            msg
        )
    ) {
        return 'proxy_connection_failed'
    }
    if (/net::err|navigation|page\.goto/.test(msg)) return 'navigation_failed'
    return 'navigation_failed'
}

export const browserService = new BrowserService()
