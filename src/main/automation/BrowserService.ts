import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, rmSync } from 'fs'
import { app } from 'electron'
import { injectCursorOverlay, setupAutoReinject } from './BrowserCursorOverlay'
import { loadSettings } from '../ipc/settings'
import { fingerprintService, BrowserFingerprint } from '../services/FingerprintService'
import { proxyBridgeService } from '../services/ProxyBridgeService'
import { applyStealth, StealthLevel } from './StealthPatcher'

export interface BrowserConfig {
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
        appendFileSync(logPath, line)
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
    private contextIdCounter = 0

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
        if (this.browser || this.browserHeadless !== null) {
            logProxy(`[BrowserService] Browser state cleared (${reason})`)
        }
        this.browser = null
        this.browserHeadless = null
    }

    private clearStaleContextState(reason: string): void {
        const staleContexts = this.contexts.size
        const stalePages = this.pages.size
        const staleBridges = this.contextProxyBridgeKeys.size
        if (staleContexts > 0 || stalePages > 0) {
            logProxy(
                `[BrowserService] Clearing stale state after ${reason}: contexts=${staleContexts}, pages=${stalePages}, bridges=${staleBridges}`
            )
        }
        this.contexts.clear()
        this.pages.clear()
        this.contextFingerprints.clear()
        this.contextProxyBridgeKeys.clear()
        void proxyBridgeService.closeAll()
    }

    private attachDisconnectHandler(browser: Browser): void {
        browser.on('disconnected', () => {
            if (this.browser === browser) {
                this.clearBrowserReferences('disconnected')
                this.clearStaleContextState('browser_disconnected')
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
        this.clearStaleContextState(reason)
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
            this.clearStaleContextState('detected_disconnected')
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

        if (this.contexts.size > 0) {
            logProxy(
                `[BrowserService] Browser mode mismatch requested=${headless} current=${this.browserHeadless}; keeping current mode because ${this.contexts.size} context(s) are active`
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
        await this.withBrowserLock(async () => {
            for (const [id] of Array.from(this.contexts.entries())) {
                try { await this.closeContextInternal(id) } catch { /* ignore */ }
            }
            this.contexts.clear()
            this.pages.clear()
            await this.resetBrowserState('close_browser')
            logProxy('[BrowserService] All browsers closed')
        })
    }

    // ============================================================
    // Create persistent context with full rendering enabled
    // ============================================================
    async createContext(config: BrowserConfig = {}): Promise<number> {
        const contextId = ++this.contextIdCounter
        const profilePath = this.prepareProfileDirectory(
            config.profilePath || join(this.getProfilesPath(), `runtime_context_${contextId}`),
            config.cleanProfileOnStart === true
        )

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
            const upstreamProxy = buildPlaywrightProxyServer(proxy)
            const bridgeLabel = bridgeKey ? ` (bridge -> ${upstreamProxy})` : ''
            logProxy(`[BrowserService] Context ${contextId}: proxy=${resolvedProxy.server}${bridgeLabel}`)
            usedProxy = true
        }

        const requestedHeadless = config.headless ?? false
        
        // Generate unique fingerprint for this session
        const fingerprint = fingerprintService.generate()
        this.contextFingerprints.set(contextId, fingerprint)

        // Anti-detection context options — unique fingerprint per session
        const launchOptions: any = {
            headless: requestedHeadless,
            channel: 'chrome',
            args: getChromeArgs(),
            viewport: config.viewport ?? fingerprint.screenResolution,
            userAgent: config.userAgent || fingerprint.userAgent,
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

        const context = await this.withBrowserLock(async () => {
            return await chromium.launchPersistentContext(profilePath, launchOptions)
        })

        try {
            // Apply centralized stealth (Phase 1 Anti-Detection Strategy)
            await applyStealth(context, { level: 'high', fingerprint })

            // Keep legacy applyStealthScripts for backward compatibility (will be phased out)
            await this.applyStealthScripts(context, fingerprint)

            this.contexts.set(contextId, context)
            if (bridgeKey) {
                this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            }

            const page = context.pages().find(candidate => !candidate.isClosed()) || await context.newPage()

            // Inject fake cursor overlay for visual feedback
            await injectCursorOverlay(page)
            setupAutoReinject(page)

            this.pages.set(contextId, page)
        } catch (error) {
            try { await context.close() } catch { /* ignore */ }
            this.contexts.delete(contextId)
            this.pages.delete(contextId)
            const trackedBridgeKey = this.contextProxyBridgeKeys.get(contextId) || bridgeKey
            this.contextProxyBridgeKeys.delete(contextId)
            if (trackedBridgeKey) {
                await proxyBridgeService.release(trackedBridgeKey)
            }
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
        const contextId = ++this.contextIdCounter
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
            const upstreamProxy = buildPlaywrightProxyServer(proxy)
            const bridgeLabel = bridgeKey ? ` (bridge -> ${upstreamProxy})` : ''
            logProxy(`[BrowserService] Ephemeral ${contextId}: proxy=${resolvedProxy.server}${bridgeLabel}`)
            usedProxy = true
        }

        // Generate unique fingerprint for this ephemeral session
        const fingerprint = fingerprintService.generate()
        this.contextFingerprints.set(contextId, fingerprint)

        const contextOptions: any = {
            viewport: config.viewport ?? fingerprint.screenResolution,
            userAgent: config.userAgent || fingerprint.userAgent,
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

        const context = await this.browser.newContext(contextOptions)

        try {
            // Apply centralized stealth (Phase 1 Anti-Detection Strategy)
            await applyStealth(context, { level: 'high', fingerprint })

            // Keep legacy for compatibility
            await this.applyStealthScripts(context, fingerprint)

            this.contexts.set(contextId, context)
            if (bridgeKey) {
                this.contextProxyBridgeKeys.set(contextId, bridgeKey)
            }

            const page = await context.newPage()

            // Inject fake cursor overlay for visual feedback
            await injectCursorOverlay(page)
            setupAutoReinject(page)

            this.pages.set(contextId, page)
        } catch (error) {
            try { await context.close() } catch { /* ignore */ }
            this.contexts.delete(contextId)
            this.pages.delete(contextId)
            const trackedBridgeKey = this.contextProxyBridgeKeys.get(contextId) || bridgeKey
            this.contextProxyBridgeKeys.delete(contextId)
            if (trackedBridgeKey) {
                await proxyBridgeService.release(trackedBridgeKey)
            }
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
        const bridgeKey = this.contextProxyBridgeKeys.get(contextId)
        if (context) {
            try { 
                await context.close() 
            } catch { /* ignore */ }
            this.contexts.delete(contextId)
            this.pages.delete(contextId)
            this.contextFingerprints.delete(contextId)
            this.contextProxyBridgeKeys.delete(contextId)
            if (bridgeKey) {
                await proxyBridgeService.release(bridgeKey)
            }
            logProxy(`[BrowserService] Context ${contextId} closed (remaining: ${this.contexts.size})`)
            return
        }

        // Context might already be gone, but bridge could still be tracked.
        this.contextFingerprints.delete(contextId)
        this.contextProxyBridgeKeys.delete(contextId)
        if (bridgeKey) {
            await proxyBridgeService.release(bridgeKey)
        }
    }

    async closeContext(contextId: number): Promise<void> {
        await this.withBrowserLock(async () => {
            await this.closeContextInternal(contextId)
        })
    }

    private async applyStealthScripts(context: BrowserContext, fingerprint?: BrowserFingerprint): Promise<void> {
        const fp = fingerprint || fingerprintService.generate()

        await context.addInitScript((fpData) => {
            // === Core: Hide automation ===
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            // Remove webdriver from prototype chain
            const proto = Object.getPrototypeOf(navigator);
            if (proto && 'webdriver' in proto) {
                delete (proto as any).webdriver;
            }

            // === Navigator properties (unique per session) ===
            Object.defineProperty(navigator, 'languages', { get: () => fpData.languages });
            Object.defineProperty(navigator, 'platform', { get: () => fpData.platform });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fpData.hardwareConcurrency });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => fpData.deviceMemory });
            Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 }); // Desktop

            // === Realistic navigator.plugins (Chrome-like Plugin objects) ===
            const fakePlugin = (name: string, desc: string, filename: string) => {
                const p = Object.create(Plugin.prototype);
                Object.defineProperties(p, {
                    name: { get: () => name },
                    description: { get: () => desc },
                    filename: { get: () => filename },
                    length: { get: () => 1 },
                    0: { get: () => ({ type: 'application/pdf', suffixes: 'pdf', description: '' }) },
                });
                return p;
            };
            const pluginArray = [
                fakePlugin('PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
                fakePlugin('Chrome PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
                fakePlugin('Chromium PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
                fakePlugin('Microsoft Edge PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
                fakePlugin('WebKit built-in PDF', 'Portable Document Format', 'internal-pdf-viewer'),
            ];
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const arr: any = pluginArray;
                    arr.length = pluginArray.length;
                    arr.item = (i: number) => pluginArray[i] || null;
                    arr.namedItem = (name: string) => pluginArray.find((p: any) => p.name === name) || null;
                    arr.refresh = () => {};
                    return arr;
                }
            });
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => {
                    const mt: any = [{ type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: pluginArray[0] }];
                    mt.length = 1;
                    mt.item = (i: number) => mt[i] || null;
                    mt.namedItem = (name: string) => mt.find((m: any) => m.type === name) || null;
                    return mt;
                }
            });

            // === Screen properties (unique per session) ===
            Object.defineProperty(screen, 'width', { get: () => fpData.screenResolution.width });
            Object.defineProperty(screen, 'height', { get: () => fpData.screenResolution.height });
            Object.defineProperty(screen, 'availWidth', { get: () => fpData.screenResolution.width });
            Object.defineProperty(screen, 'availHeight', { get: () => fpData.screenResolution.height - 40 });
            Object.defineProperty(screen, 'colorDepth', { get: () => fpData.colorDepth });
            Object.defineProperty(window, 'devicePixelRatio', { get: () => fpData.devicePixelRatio });

            // === WebGL fingerprint spoofing ===
            const getParamOrig = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(param: number) {
                if (param === 37445) return fpData.webgl.vendor;   // UNMASKED_VENDOR_WEBGL
                if (param === 37446) return fpData.webgl.renderer; // UNMASKED_RENDERER_WEBGL
                return getParamOrig.call(this, param);
            };
            // WebGL2 spoofing
            if (typeof WebGL2RenderingContext !== 'undefined') {
                const getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(param: number) {
                    if (param === 37445) return fpData.webgl.vendor;
                    if (param === 37446) return fpData.webgl.renderer;
                    return getParam2Orig.call(this, param);
                };
            }

            // === Canvas fingerprint noise ===
            const canvasNoiseSeed = fpData.canvasNoise;
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(...args: any[]) {
                try {
                    const ctx = this.getContext('2d');
                    if (ctx && this.width > 0 && this.height > 0) {
                        const imgData = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
                        for (let i = 0; i < imgData.data.length; i += 4) {
                            imgData.data[i] = (imgData.data[i] + Math.floor((canvasNoiseSeed - 0.5) * 4)) & 0xFF;
                        }
                        ctx.putImageData(imgData, 0, 0);
                    }
                } catch {}
                const [type, quality] = args as Parameters<HTMLCanvasElement['toDataURL']>;
                return origToDataURL.call(this, type, quality);
            };

            // === AudioContext fingerprint noise ===
            if (typeof AudioContext !== 'undefined') {
                const origCreateOsc = AudioContext.prototype.createOscillator;
                AudioContext.prototype.createOscillator = function() {
                    const osc = origCreateOsc.call(this);
                    const origConnect = osc.connect.bind(osc);
                    osc.connect = function(dest: any) {
                        if (dest instanceof AnalyserNode) {
                            const gain = (osc.context as AudioContext).createGain();
                            gain.gain.value = 1 + (fpData.audioNoise - 0.5) * 0.0001;
                            origConnect(gain);
                            gain.connect(dest);
                            return dest;
                        }
                        return origConnect(dest);
                    };
                    return osc;
                };
            }

            // === Permissions API ===
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters: any) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: 'prompt' } as PermissionStatus)
                    : originalQuery(parameters);

            // === Chrome object (essential for non-headless detection) ===
            const chrome = {
                runtime: {
                    connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {} }; },
                    sendMessage: function() {},
                    onMessage: { addListener: function() {} },
                    id: undefined,
                },
                loadTimes: function() {
                    return {
                        commitLoadTime: Date.now() / 1000 - Math.random() * 2,
                        finishDocumentLoadTime: Date.now() / 1000 - Math.random(),
                        finishLoadTime: Date.now() / 1000,
                        firstPaintAfterLoadTime: 0,
                        firstPaintTime: Date.now() / 1000 - Math.random() * 3,
                        navigationType: 'Other',
                        npnNegotiatedProtocol: 'h2',
                        requestTime: Date.now() / 1000 - Math.random() * 5,
                        startLoadTime: Date.now() / 1000 - Math.random() * 5,
                        wasAlternateProtocolAvailable: false,
                        wasFetchedViaSpdy: true,
                        wasNpnNegotiated: true,
                    };
                },
                csi: function() {
                    return { startE: Date.now(), onloadT: Date.now() + Math.floor(Math.random() * 500), pageT: Math.random() * 5000, tran: 15 };
                },
                app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
            };
            Object.defineProperty(window, 'chrome', { get: () => chrome, configurable: false });

            // === Remove automation indicators ===
            delete (window as any).callPhantom;
            delete (window as any)._phantom;
            delete (window as any).phantom;
            delete (window as any).domAutomation;
            delete (window as any).domAutomationController;
            delete (window as any).__webdriver_evaluate;
            delete (window as any).__selenium_evaluate;
            delete (window as any).__webdriver_script_function;
            delete (window as any).__webdriver_script_func;
            delete (window as any).__webdriver_script_fn;
            delete (window as any).__fxdriver_evaluate;
            delete (window as any).__driver_evaluate;
            delete (window as any).__webdriver_unwrapped;
            delete (window as any).__driver_unwrapped;
            delete (window as any).__selenium_unwrapped;
            delete (document as any).__webdriver_evaluate;
            delete (document as any).__selenium_evaluate;
            delete (document as any).__webdriver_script_function;
        }, {
            languages: fp.languages,
            platform: fp.platform,
            hardwareConcurrency: fp.hardwareConcurrency,
            deviceMemory: fp.deviceMemory,
            screenResolution: fp.screenResolution,
            colorDepth: fp.colorDepth,
            devicePixelRatio: fp.devicePixelRatio,
            webgl: fp.webgl,
            canvasNoise: fp.canvasNoise,
            audioNoise: fp.audioNoise,
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

    getRandomUserAgent(): string {
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        ]
        return userAgents[Math.floor(Math.random() * userAgents.length)]
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
}

export const browserService = new BrowserService()
