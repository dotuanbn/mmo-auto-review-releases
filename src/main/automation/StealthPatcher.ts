/**
 * StealthPatcher — Centralized, production-grade anti-detection layer for Playwright.
 *
 * This is the single source of truth for all stealth / anti-bot patches in the app.
 * It combines:
 *   - Strong CDP commands (more powerful than JS for some signals)
 *   - Comprehensive JS init scripts (webdriver removal, cdc_ cleanup, Permissions, Plugins, etc.)
 *   - Integration point for future FingerprintService v2 and BehaviorProfile
 *
 * Usage (Phase 1):
 *   import { applyStealth } from './StealthPatcher'
 *   await applyStealth(context, { level: 'high', fingerprint })
 *
 * All future browser launches (BrowserService, TrafficBoostEngine, review engines, manual login, etc.)
 * should eventually route through this module.
 */

import { BrowserContext, Page } from 'playwright'
import { BrowserFingerprint } from '../services/FingerprintService'
import { writeAgenticLog } from '../utils/agenticLog'

export type StealthLevel = 'off' | 'low' | 'medium' | 'high' | 'paranoid'

export interface StealthOptions {
    level?: StealthLevel
    fingerprint?: BrowserFingerprint
    /** Future: pass per-account behavior profile for fatigue / mood simulation */
    behaviorProfile?: any
}

const DEFAULT_LEVEL: StealthLevel = 'high'

function log(msg: string) {
    console.log(`[StealthPatcher] ${msg}`)
    writeAgenticLog('StealthPatcher', msg)
}

/**
 * Main entry point.
 * Applies the strongest possible stealth for the given level.
 */
export async function applyStealth(context: BrowserContext, opts: StealthOptions = {}): Promise<void> {
    const level = opts.level || DEFAULT_LEVEL

    if (level === 'off') {
        log('Stealth disabled (level=off)')
        return
    }

    log(`Applying stealth patches (level=${level})`)

    // 1. JS-level patches (run on every new page / frame)
    await applyJSInitScripts(context, opts)

    // 2. CDP-level patches (more powerful for certain signals)
    await applyCDPPatches(context, level)

    log('Stealth patches applied successfully')
}

/**
 * Apply on an already-created page (useful for late injection or recovery).
 */
export async function applyStealthToPage(page: Page, opts: StealthOptions = {}): Promise<void> {
    const level = opts.level || DEFAULT_LEVEL
    if (level === 'off') return

    // Re-inject JS patches on this specific page
    await page.addInitScript(stealthInitScript, buildScriptArgs(opts))

    // Best-effort CDP on the page
    try {
        const cdp = await page.context().newCDPSession(page)
        await applyPageCDP(cdp, level)
        await cdp.detach().catch(() => {})
    } catch (e) {
        // Non-fatal in some contexts
    }
}

// ============================================================
// JS Init Scripts (the heart of stealth)
// ============================================================

async function applyJSInitScripts(context: BrowserContext, opts: StealthOptions) {
    const args = buildScriptArgs(opts)
    await context.addInitScript(stealthInitScript, args)
}

function buildScriptArgs(opts: StealthOptions) {
    const fp = opts.fingerprint
    return {
        level: opts.level || DEFAULT_LEVEL,
        fp: fp
            ? {
                  languages: fp.languages,
                  platform: fp.platform,
                  hardwareConcurrency: fp.hardwareConcurrency,
                  deviceMemory: fp.deviceMemory,
                  screen: fp.screenResolution,
                  colorDepth: fp.colorDepth,
                  devicePixelRatio: fp.devicePixelRatio,
                  webglVendor: fp.webgl.vendor,
                  webglRenderer: fp.webgl.renderer,
                  canvasNoise: fp.canvasNoise,
                  audioNoise: fp.audioNoise,
              }
            : null,
    }
}

function stealthInitScript(args: any) {
    const { level, fp } = args
    const isHigh = level === 'high' || level === 'paranoid'

    // === 1. Core automation removal (most important) ===
    try {
        // webdriver
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
            configurable: true,
        })
        // Remove from prototype if present
        const navProto = Object.getPrototypeOf(navigator)
        if (navProto && 'webdriver' in navProto) {
            try { delete (navProto as any).webdriver } catch {}
        }

        // Common CDP / automation artifacts
        const toDelete = [
            'cdc_adoQpoSDhc0lD3c0CrgA',
            'cdc_adoQpoSDhc0lD3c0CrgB',
            'cdc_adoQpoSDhc0lD3c0CrgC',
            'cdc_adoQpoSDhc0lD3c0CrgD',
            'cdc_adoQpoSDhc0lD3c0CrgE',
            '$chrome_asyncScriptInfo',
            '$cdc_asdjflasutopfhvcZLmcfl_',
        ]
        for (const key of toDelete) {
            try { delete (window as any)[key] } catch {}
            try { delete (document as any)[key] } catch {}
        }

        // domAutomation / phantom / callPhantom etc.
        const automationProps = [
            'domAutomation',
            'domAutomationController',
            '__webdriver_script_fn',
            '__driver_evaluate',
            '__webdriver_evaluate',
            '__selenium_evaluate',
            '__fxdriver_evaluate',
            '__driver_unwrapped',
            '__webdriver_unwrapped',
            '__selenium_unwrapped',
            '__fxdriver_unwrapped',
            '_phantom',
            'callPhantom',
            '__nightmare',
            '_selenium',
        ]
        for (const p of automationProps) {
            try { delete (window as any)[p] } catch {}
        }
    } catch (e) {
        // swallow — stealth must never break the page
    }

    // === 2. Navigator properties (use fingerprint when available) ===
    try {
        if (fp?.languages) {
            Object.defineProperty(navigator, 'languages', { get: () => fp.languages })
        }
        if (fp?.platform) {
            Object.defineProperty(navigator, 'platform', { get: () => fp.platform })
        }
        if (fp?.hardwareConcurrency != null) {
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency })
        }
        if (fp?.deviceMemory != null) {
            Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.deviceMemory })
        }
        if (isHigh) {
            Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 })
        }
    } catch {}

    // === 3. Permissions API (very important for Google) ===
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const origQuery = navigator.permissions.query.bind(navigator.permissions)
            navigator.permissions.query = (parameters: any) => {
                const name = (parameters && parameters.name) || ''
                // For common Google Maps / review permissions, lie convincingly
                if (['geolocation', 'notifications', 'midi', 'camera', 'microphone'].includes(name)) {
                    return Promise.resolve({ state: 'prompt', onchange: null } as any)
                }
                return origQuery(parameters as any).catch(() => ({ state: 'prompt', onchange: null } as any))
            }
        }
    } catch {}

    // === 4. Plugins / MimeTypes (realistic Chrome set) ===
    try {
        const makeFakePlugin = (name: string, desc: string, filename: string) => {
            const p: any = {}
            Object.defineProperties(p, {
                name: { get: () => name },
                description: { get: () => desc },
                filename: { get: () => filename },
                length: { get: () => 1 },
                0: { get: () => ({ type: 'application/pdf', suffixes: 'pdf', description: '' }) },
            })
            return p
        }

        const pluginList = [
            makeFakePlugin('PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
            makeFakePlugin('Chrome PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
            makeFakePlugin('Chromium PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
            makeFakePlugin('Microsoft Edge PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer'),
            makeFakePlugin('WebKit built-in PDF', 'Portable Document Format', 'internal-pdf-viewer'),
        ]

        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const arr: any = [...pluginList]
                arr.length = pluginList.length
                arr.item = (i: number) => arr[i] || null
                arr.namedItem = (n: string) => arr.find((p: any) => p.name === n) || null
                arr.refresh = () => {}
                return arr
            },
            configurable: true,
        })

        const mimeTypes: any = [
            { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: pluginList[0] },
        ]
        mimeTypes.length = 1
        mimeTypes.item = (i: number) => mimeTypes[i] || null
        mimeTypes.namedItem = (n: string) => mimeTypes.find((m: any) => m.type === n) || null

        Object.defineProperty(navigator, 'mimeTypes', {
            get: () => mimeTypes,
            configurable: true,
        })
    } catch {}

    // === 5. Screen + hardware (when fingerprint provided) ===
    try {
        if (fp?.screen) {
            Object.defineProperty(screen, 'width', { get: () => fp.screen.width })
            Object.defineProperty(screen, 'height', { get: () => fp.screen.height })
            Object.defineProperty(screen, 'availWidth', { get: () => fp.screen.width })
            Object.defineProperty(screen, 'availHeight', { get: () => fp.screen.height - 40 })
            Object.defineProperty(screen, 'colorDepth', { get: () => fp.colorDepth || 24 })
            Object.defineProperty(window, 'devicePixelRatio', { get: () => fp.devicePixelRatio || 1 })
        }
    } catch {}

    // === 6. WebGL spoofing (when fingerprint provided) ===
    try {
        if (fp?.webglVendor && fp?.webglRenderer) {
            const patchWebGL = (proto: any) => {
                if (!proto) return
                const origGet = proto.getParameter
                proto.getParameter = function (param: number) {
                    if (param === 37445) return fp.webglVendor // UNMASKED_VENDOR_WEBGL
                    if (param === 37446) return fp.webglRenderer // UNMASKED_RENDERER_WEBGL
                    return origGet.call(this, param)
                }
            }
            patchWebGL(WebGLRenderingContext && WebGLRenderingContext.prototype)
            patchWebGL(WebGL2RenderingContext && WebGL2RenderingContext.prototype)
        }
    } catch {}

    // === 7. Canvas noise (when fingerprint provided) ===
    try {
        if (typeof fp?.canvasNoise === 'number') {
            const noise = fp.canvasNoise
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL
            HTMLCanvasElement.prototype.toDataURL = function (...a: any[]) {
                try {
                    const ctx = this.getContext('2d')
                    if (ctx && this.width > 0 && this.height > 0) {
                        const w = Math.min(this.width, 32)
                        const h = Math.min(this.height, 32)
                        const img = ctx.getImageData(0, 0, w, h)
                        for (let i = 0; i < img.data.length; i += 4) {
                            img.data[i] = (img.data[i] + Math.floor((noise - 0.5) * 6)) & 0xff
                        }
                        ctx.putImageData(img, 0, 0)
                    }
                } catch {}
                return origToDataURL.apply(this, a as any)
            }
        }
    } catch {}

    // === 8. AudioContext noise (light) ===
    try {
        if (typeof AudioContext !== 'undefined' && typeof fp?.audioNoise === 'number') {
            const noise = fp.audioNoise
            const origOsc = AudioContext.prototype.createOscillator
            AudioContext.prototype.createOscillator = function () {
                const osc = origOsc.call(this)
                const origConnect = osc.connect.bind(osc)
                osc.connect = function (dest: any) {
                    if (dest instanceof AnalyserNode) {
                        const g = (osc.context as AudioContext).createGain()
                        g.gain.value = 1 + (noise - 0.5) * 0.0002
                        origConnect(g)
                        return g as any
                    }
                    return origConnect(dest)
                } as any
                return osc
            }
        }
    } catch {}

    // === 9. Extra paranoid cleanup (level === 'paranoid') ===
    if (level === 'paranoid') {
        try {
            // Remove common automation detection helpers
            const extra = ['__puppeteer', '__playwright', 'puppeteer', 'playwright']
            for (const k of extra) {
                try { delete (window as any)[k] } catch {}
            }
        } catch {}
    }

    // Mark that stealth ran (useful for debugging)
    try {
        ;(window as any).__mmor_stealth_applied = true
        ;(window as any).__mmor_stealth_level = level
    } catch {}
}

// ============================================================
// CDP Patches (stronger than pure JS for some signals)
// ============================================================

async function applyCDPPatches(context: BrowserContext, level: StealthLevel) {
    if (level === 'off' || level === 'low') return

    // We apply CDP on the first page that appears (and future pages via context event)
    const applyToPage = async (page: Page) => {
        try {
            const cdp = await context.newCDPSession(page)

            // Remove webdriver flag at CDP level
            await cdp.send('Emulation.setUserAgentOverride', {
                userAgent: await page.evaluate(() => navigator.userAgent),
                acceptLanguage: 'en-US,en;q=0.9,vi;q=0.8',
            }).catch(() => {})

            // Hardware concurrency override (when we have consistent value)
            // Note: Playwright 1.4x+ supports it via context options; we keep it here for older paths

            // Permissions
            await cdp.send('Browser.grantPermissions', {
                permissions: ['geolocation', 'notifications'],
            }).catch(() => {})

            await cdp.detach().catch(() => {})
        } catch (e) {
            // Non-fatal
        }
    }

    // Apply to existing pages
    for (const p of context.pages()) {
        await applyToPage(p).catch(() => {})
    }

    // Apply to future pages
    context.on('page', (p) => {
        applyToPage(p).catch(() => {})
    })
}

async function applyPageCDP(cdp: any, level: StealthLevel) {
    if (level === 'off' || level === 'low') return
    try {
        await cdp.send('Emulation.setUserAgentOverride', {
            userAgent: await cdp.send('Runtime.evaluate', { expression: 'navigator.userAgent' }).then((r: any) => r.result.value),
        }).catch(() => {})
    } catch {}
}

export const stealthPatcher = {
    applyStealth,
    applyStealthToPage,
    StealthLevel: {} as any, // for type import convenience
}

/** Default stealth level used across the app (Phase 1 foundation) */
export const DEFAULT_STEALTH_LEVEL: StealthLevel = 'high'
