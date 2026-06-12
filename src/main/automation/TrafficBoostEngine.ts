import { BrowserWindow, app } from 'electron'
import { browserService, BrowserConfig } from './BrowserService'
import { HumanBehavior } from './HumanBehavior'
import { proxyService } from '../services/ProxyService'
import { fproxyService } from '../services/FProxyService'
import { loadSettings } from '../ipc/settings'
import { runtimePolicyService } from '../runtime/v2/runtimePolicy'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import { Page } from 'playwright'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import pRetry from 'p-retry'
import PQueue from 'p-queue'
import { OrganicSearchFlow } from './OrganicSearchFlow'
import { AgenticSearchHandler } from './AgenticSearchHandler'
import { WebSeoFlow } from './WebSeoFlow'
import { MapSearchFlow } from './MapSearchFlow'
import { agenticTrafficHandler } from './AgenticTrafficHandler'
import { autonomousMapAgent } from './AutonomousMapAgent'
import { applyStealth, DEFAULT_STEALTH_LEVEL } from './StealthPatcher'
import { ollamaService } from '../services/OllamaService'
import { contextualInterruptionResolver, ContextualInterruptionResolveResult } from './ContextualInterruptionResolver'
import { networkOrchestrator } from '../runtime/v2/networkOrchestrator'
import { NetworkStateV2, RuntimeActionEvent, RuntimeDiagnosticsV2, RuntimePolicyV2 } from '../runtime/v2/types'
import { getRuntimeLogger } from '../utils/runtimeLogger'
import { miniRagService } from '../services/MiniRagService'
import { windowTilingService } from '../services/WindowTilingService'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'
import { systemResourceDetector } from '../services/SystemResourceDetector'
import { captchaSolverService } from '../services/CaptchaSolverService'
import {
    classifyTrafficFailure,
    classifyTrafficFailureMessage,
    readTrafficFailureBucketFromActions,
} from './TrafficFailureClassifier'

// ============================================================
// Types
// ============================================================

export type SEOAction =
    | 'map_zoom_in' | 'map_zoom_out' | 'map_drag_pan' | 'map_satellite_view'
    | 'map_street_view' | 'map_terrain_view' | 'map_fullscreen' | 'map_measure_distance'
    | 'photos_browse' | 'photos_view_single' | 'photos_next_prev' | 'photos_category'
    | 'photos_owner' | 'photos_latest' | 'photos_360'
    | 'reviews_read' | 'reviews_expand' | 'reviews_sort' | 'reviews_filter_stars'
    | 'reviews_view_photos' | 'reviews_helpful' | 'reviews_author_profile'
    | 'directions_driving' | 'directions_walking' | 'directions_transit'
    | 'directions_cycling' | 'directions_reverse'
    | 'info_view_hours' | 'info_view_about' | 'info_phone' | 'info_address_copy'
    | 'info_website' | 'info_menu' | 'info_price_range' | 'info_amenities'
    | 'share_link' | 'share_embed' | 'save_place' | 'send_to_phone' | 'print_location'
    | 'explore_nearby' | 'explore_similar' | 'explore_category' | 'explore_popular_times'
    | 'explore_qa' | 'explore_updates'
    | 'browse_scroll_deep' | 'browse_read_panel' | 'browse_random_click' | 'browse_back_forward'

export interface TrafficBoostStatus {
    isRunning: boolean
    campaignId: number | null
    campaignName: string
    activeThreads: number
    threadsTotal: number
    currentRound: number
    totalRounds: number
    completedVisits: number
    totalVisits: number
    failedVisits: number
    message: string
    threads: ThreadDetail[]
    effectiveNetworkMode?: 'direct' | 'fproxy' | 'static_proxy'
    networkState?: NetworkStateV2
}

export interface ThreadDetail {
    id: number
    accountEmail: string
    locationName: string
    currentAction: string
    currentUrl?: string
    currentKeyword?: string // Current search keyword being used
    status: 'idle' | 'visiting' | 'waiting' | 'done'
    progress: number
    proxyInfo?: string // e.g. "113.190.148.126:38733 (Quáº£ng BÃ¬nh, Vietnam)"
}

export interface VisitActionRecord {
    action: string
    success: boolean
    source?: string
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    threadId?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp?: string
}

type ActionContext = {
    campaignName: string
    round: number
    campaignId: number
    threadId: number
    accountEmail: string
    locationName: string
    domain?: string
    goal?: string
    riskType?: string
}

export interface TrafficReport {
    campaignId: number
    campaignName: string
    totalVisits: number
    completedVisits: number
    failedVisits: number
    totalRounds: number
    totalDuration: number // seconds
    avgVisitDuration: number
    visitsByLocation: { locationId: number; locationName: string; visits: number; avgDuration: number }[]
    visitsByAccount: { accountId: number; accountEmail: string; visits: number }[]
    actionStats: { action: string; count: number }[]
    logs: any[]
}

// ============================================================
// All SEO Actions
// ============================================================

const ALL_SEO_ACTIONS: SEOAction[] = [
    'map_zoom_in', 'map_zoom_out', 'map_drag_pan', 'map_satellite_view',
    'map_street_view', 'map_terrain_view', 'map_fullscreen', 'map_measure_distance',
    'photos_browse', 'photos_view_single', 'photos_next_prev', 'photos_category',
    'photos_owner', 'photos_latest', 'photos_360',
    'reviews_read', 'reviews_expand', 'reviews_sort', 'reviews_filter_stars',
    'reviews_view_photos', 'reviews_helpful', 'reviews_author_profile',
    'directions_driving', 'directions_walking', 'directions_transit',
    'directions_cycling', 'directions_reverse',
    'info_view_hours', 'info_view_about', 'info_phone', 'info_address_copy',
    'info_website', 'info_menu', 'info_price_range', 'info_amenities',
    'share_link', 'share_embed', 'save_place', 'send_to_phone', 'print_location',
    'explore_nearby', 'explore_similar', 'explore_category', 'explore_popular_times',
    'explore_qa', 'explore_updates',
    'browse_scroll_deep', 'browse_read_panel', 'browse_random_click', 'browse_back_forward',
]

// Actions that REQUIRE a Google account to be logged in
// These actions will only be performed when an account is assigned to the thread
const ACTIONS_REQUIRE_LOGIN = new Set([
    'reviews_helpful',        // Marking a review as helpful requires login
    'save_place',             // Saving a place to favorites requires login
    'share_link',             // Sharing via Google account requires login
    'share_embed',            // Embed sharing with account context
    'send_to_phone',          // Send to phone requires login
    'print_location',         // Print with account context
    'explore_qa',             // Q&A interaction requires login
    'explore_updates',        // Updates/posts interaction may require login
])

// Filter actions based on whether account is logged in
function getAvailableActions(enabledActions: SEOAction[], hasAccount: boolean): SEOAction[] {
    if (hasAccount) {
        // Logged in: all actions available
        return enabledActions
    }
    // Not logged in: filter out login-required actions
    const filtered = enabledActions.filter(action => !ACTIONS_REQUIRE_LOGIN.has(action))
    // Ensure we always have some actions
    if (filtered.length === 0) {
        return ['browse_scroll_deep', 'photos_browse', 'reviews_read', 'map_drag_pan', 'info_view_hours'] as SEOAction[]
    }
    return filtered
}

// ============================================================
// SEO Action Implementations
// ============================================================


class SEOActionExecutor {
    private static shouldRecoverOverlay(errorMessage: string): boolean {
        return /(intercepts pointer events|another element|element is detached|timeout|not receiving pointer events|subtree intercepts)/i.test(errorMessage)
    }

    private static async dismissUnexpectedOverlay(page: Page, useEscapeFallback = false): Promise<string | null> {
        const selectors = [
            'button[aria-label*="Close"]',
            'button[aria-label*="Dismiss"]',
            'button[aria-label*="Cancel"]',
            'button[aria-label*="OK"]',
            'button[aria-label*="Dong"]',
            'button[aria-label*="Dong y"]',
            'button[aria-label*="Tiep tuc"]',
            'button[aria-label*="Da hieu"]',
            'button:has-text("Close")',
            'button:has-text("Dismiss")',
            'button:has-text("Cancel")',
            'button:has-text("Not now")',
            'button:has-text("Skip")',
            'button:has-text("Later")',
            'button:has-text("Äá»ƒ sau")',
            'button:has-text("De sau")',
            'button:has-text("OK")',
            'button:has-text("Ok")',
            'button:has-text("Got it")',
            'button:has-text("Continue")',
            'button:has-text("ÄÃ³ng")',
            'button:has-text("Äá»“ng Ã½")',
            'button:has-text("ÄÃ£ hiá»ƒu")',
            'button:has-text("Hiá»ƒu rá»“i")',
            'button:has-text("Tiáº¿p tá»¥c")',
            '[role="dialog"] button:has-text("OK")',
            '[role="dialog"] button:has-text("Ok")',
            '[role="dialog"] button:has-text("Close")',
            '[role="dialog"] button:has-text("Dismiss")',
            '[role="dialog"] button:has-text("Got it")',
            '[role="dialog"] button:has-text("Äá»“ng Ã½")',
            '[role="dialog"] button:has-text("ÄÃ£ hiá»ƒu")',
            '[role="dialog"] button:has-text("Tiáº¿p tá»¥c")',
            '[role="dialog"] button:has-text("ÄÃ³ng")',
        ]

        for (const selector of selectors) {
            const locator = page.locator(selector).first()
            const count = await locator.count().catch(() => 0)
            if (count === 0) {
                continue
            }

            try {
                const visible = await locator.isVisible({ timeout: 600 }).catch(() => false)
                if (!visible) {
                    continue
                }

                await locator.click({ timeout: 1500 }).catch(async () => {
                    await locator.click({ timeout: 1500, force: true })
                })
                await HumanBehavior.randomDelay(200, 420)
                return selector
            } catch {
                // Try next selector.
            }
        }

        if (useEscapeFallback) {
            await page.keyboard.press('Escape').catch(() => { })
            await HumanBehavior.randomDelay(120, 280)
            return 'keyboard_escape'
        }

        return null
    }

    static async execute(page: Page, action: SEOAction): Promise<{ action: SEOAction; success: boolean; duration: number; error?: string }> {
        const start = Date.now()
        try {
            const fn = (this as any)[action]
            const sharedRecovery = await contextualInterruptionResolver.resolve(page, {
                reason: `seo_action_${action}`,
                useLlmFallback: false,
                useEscapeFallback: false,
                maxPasses: 2,
                goal: 'map_interaction',
                campaignType: 'traffic',
                domain: page.url(),
            }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
            if (sharedRecovery.handled) {
                console.log(`[SEOAction] Recovered popup via shared resolver: ${sharedRecovery.via || 'unknown'}`)
            }
            const preRecoveredBy = await this.dismissUnexpectedOverlay(page, false)
            if (preRecoveredBy) {
                console.log(`[SEOAction] Recovered popup via ${preRecoveredBy} before action: ${action}`)
            }
            if (typeof fn === 'function') {
                console.log(`[SEOAction] Executing: ${action}`)
                try {
                    await fn.call(this, page)
                } catch (err: any) {
                    const firstError = err?.message ? String(err.message) : String(err)
                    if (!this.shouldRecoverOverlay(firstError)) {
                        throw err
                    }

                    const sharedRetryRecovery = await contextualInterruptionResolver.resolve(page, {
                        reason: `seo_retry_${action}`,
                        useLlmFallback: false,
                        useEscapeFallback: true,
                        maxPasses: 2,
                        goal: 'map_interaction',
                        campaignType: 'traffic',
                        domain: page.url(),
                    }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
                    if (sharedRetryRecovery.handled) {
                        console.log(`[SEOAction] Shared resolver recovered retry context via ${sharedRetryRecovery.via || 'unknown'}`)
                    }

                    const recoveredBy = await this.dismissUnexpectedOverlay(page, true)
                    if (!recoveredBy) {
                        throw err
                    }

                    console.log(`[SEOAction] Retry ${action} after overlay recovery via ${recoveredBy}`)
                    await HumanBehavior.randomDelay(220, 560)
                    await fn.call(this, page)
                }
            } else {
                console.log(`[SEOAction] Unknown action "${action}", fallback to browse_scroll_deep`)
                await this.browse_scroll_deep(page)
            }
            console.log(`[SEOAction] âœ“ ${action} completed in ${Date.now() - start}ms`)
            return { action, success: true, duration: Date.now() - start }
        } catch (err: any) {
            console.log(`[SEOAction] âœ— ${action} failed: ${err.message}`)
            const errorMessage = err?.message ? String(err.message) : String(err)
            return { action, success: false, duration: Date.now() - start, error: errorMessage }
        }
    }

    // ======== HELPER ========
    private static async clickSafe(page: Page, selector: string, timeout = 3000) {
        const el = await page.$(selector)
        if (!el) throw new Error('Not found: ' + selector)
        await el.click()
        await HumanBehavior.randomDelay(1500, timeout)
    }
    private static async goBackSafe(page: Page) {
        try {
            const b = await page.$('button[aria-label="Back"], button[jsaction*="back"]')
            if (b) { await b.click() } else { await page.goBack() }
        } catch { await page.goBack() }
        await HumanBehavior.randomDelay(1500, 2500)
    }
    private static async escSafe(page: Page) {
        try {
            const c = await page.$('button[aria-label="Close"], button[jsaction*="close"]')
            if (c) await c.click(); else await page.keyboard.press('Escape')
        } catch { await page.keyboard.press('Escape') }
        await HumanBehavior.randomDelay(500, 1000)
    }
    private static async getMap(page: Page) {
        return page.$('div[aria-label*="Map"], div.widget-scene-canvas, canvas')
    }
    private static async mapCenter(page: Page) {
        const m = await this.getMap(page)
        if (!m) return null
        const b = await m.boundingBox()
        return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height } : null
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• MAP (8) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async map_zoom_in(page: Page) {
        const c = await this.mapCenter(page)
        if (!c) throw new Error('No map')
        await moveCursor(page, c.x, c.y)
        await page.mouse.move(c.x, c.y)
        await page.mouse.wheel(0, -300)
        await HumanBehavior.randomDelay(2000, 4000)
        await page.mouse.wheel(0, -200)
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async map_zoom_out(page: Page) {
        const c = await this.mapCenter(page)
        if (!c) throw new Error('No map')
        await moveCursor(page, c.x, c.y)
        await page.mouse.move(c.x, c.y)
        await page.mouse.wheel(0, 300)
        await HumanBehavior.randomDelay(2000, 4000)
        await page.mouse.wheel(0, 200)
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async map_drag_pan(page: Page) {
        const c = await this.mapCenter(page)
        if (!c) throw new Error('No map')
        const ox = (Math.random() - 0.5) * c.w * 0.4
        const oy = (Math.random() - 0.5) * c.h * 0.4
        await moveCursor(page, c.x, c.y)
        await page.mouse.move(c.x, c.y)
        await page.mouse.down()
        await page.mouse.move(c.x + ox, c.y + oy, { steps: 12 })
        await page.mouse.up()
        await HumanBehavior.randomDelay(1500, 3000)
        // Pan back partially
        await page.mouse.move(c.x + ox, c.y + oy)
        await page.mouse.down()
        await page.mouse.move(c.x + ox * 0.3, c.y + oy * 0.3, { steps: 8 })
        await page.mouse.up()
        await HumanBehavior.randomDelay(1500, 2500)
    }

    static async map_satellite_view(page: Page) {
        try {
            const layerBtn = await page.$('button[aria-label*="Layers"], button[aria-label*="layers"], button[jsaction*="layers"]')
            if (layerBtn) {
                await layerBtn.click()
                await HumanBehavior.randomDelay(1500, 2500)
                const satBtn = await page.$('button[aria-label*="Satellite"], button:has-text("Satellite"), button:has-text("Vá»‡ tinh")')
                if (satBtn) await satBtn.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await this.escSafe(page)
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(2000, 4000)
    }

    static async map_street_view(page: Page) {
        try {
            const sv = await page.$('button[aria-label*="Street View"], button[aria-label*="street view"], div[aria-label*="pegman"]')
            if (sv) {
                await sv.click()
                await HumanBehavior.randomDelay(3000, 5000)
                await HumanBehavior.randomScroll(page, 2)
                await HumanBehavior.randomDelay(2000, 4000)
                await this.escSafe(page)
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async map_terrain_view(page: Page) {
        try {
            const layerBtn = await page.$('button[aria-label*="Layers"], button[aria-label*="layers"]')
            if (layerBtn) {
                await layerBtn.click()
                await HumanBehavior.randomDelay(1500, 2500)
                const terrainBtn = await page.$('button[aria-label*="Terrain"], button:has-text("Terrain"), button:has-text("Äá»‹a hÃ¬nh")')
                if (terrainBtn) await terrainBtn.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await this.escSafe(page)
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async map_fullscreen(page: Page) {
        try {
            const fsBtn = await page.$('button[aria-label*="fullscreen" i], button[aria-label*="full screen" i]')
            if (fsBtn) {
                await fsBtn.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 2)
                await HumanBehavior.randomDelay(2000, 3000)
                // Exit fullscreen
                await page.keyboard.press('Escape')
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch { /* ignore */ }
    }

    static async map_measure_distance(page: Page) {
        const c = await this.mapCenter(page)
        if (!c) throw new Error('No map')
        await clickCursor(page, c.x, c.y)
        await page.mouse.click(c.x, c.y, { button: 'right' })
        await HumanBehavior.randomDelay(1000, 2000)
        try {
            const measureOpt = await page.$('div[role="menuitem"]:has-text("Measure"), div[role="menuitem"]:has-text("Äo")')
            if (measureOpt) {
                await measureOpt.click()
                await HumanBehavior.randomDelay(2000, 3000)
            }
        } catch { /* ignore */ }
        await this.escSafe(page)
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• PHOTOS (7) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async photos_browse(page: Page) {
        const btn = await page.$('button[data-tab-id="photos"], button[aria-label*="Photo" i], button:has-text("Photos"), button:has-text("áº¢nh")')
        if (!btn) throw new Error('No photos tab')
        await btn.click()
        await HumanBehavior.randomDelay(2000, 4000)
        await HumanBehavior.randomScroll(page, HumanBehavior.getRandomDelay(3, 6))
        await HumanBehavior.randomDelay(2000, 4000)
    }

    static async photos_view_single(page: Page) {
        await this.photos_browse(page)
        const photos = await page.$$('a[data-photo-index], button[data-photo-index], div[role="img"], img[src*="googleusercontent"]')
        if (photos.length > 0) {
            await photos[Math.floor(Math.random() * Math.min(photos.length, 10))].click()
            await HumanBehavior.randomDelay(3000, 6000)
            await this.escSafe(page)
        }
    }

    static async photos_next_prev(page: Page) {
        await this.photos_view_single(page)
        const n = HumanBehavior.getRandomDelay(3, 7)
        for (let i = 0; i < n; i++) {
            try {
                const next = await page.$('button[aria-label*="Next" i], button[jsaction*="forward"]')
                if (next) await next.click(); else await page.keyboard.press('ArrowRight')
            } catch { await page.keyboard.press('ArrowRight') }
            await HumanBehavior.randomDelay(1500, 3500)
        }
        await this.escSafe(page)
    }

    static async photos_category(page: Page) {
        await this.photos_browse(page)
        try {
            const tabs = await page.$$('button[role="tab"][data-tab-id], div[role="tablist"] button')
            if (tabs.length > 1) {
                await tabs[Math.floor(Math.random() * tabs.length)].click()
                await HumanBehavior.randomDelay(1500, 3000)
                await HumanBehavior.randomScroll(page, 3)
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async photos_owner(page: Page) {
        await this.photos_browse(page)
        try {
            const ownerTab = await page.$('button:has-text("By owner"), button:has-text("Chá»§ sá»Ÿ há»¯u"), button:has-text("Owner")')
            if (ownerTab) {
                await ownerTab.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 3)
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async photos_latest(page: Page) {
        await this.photos_browse(page)
        try {
            const latestTab = await page.$('button:has-text("Latest"), button:has-text("Má»›i nháº¥t"), button:has-text("newest")')
            if (latestTab) {
                await latestTab.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 3)
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async photos_360(page: Page) {
        await this.photos_browse(page)
        try {
            const tab360 = await page.$('button:has-text("360"), button:has-text("Street View"), button[aria-label*="360"]')
            if (tab360) {
                await tab360.click()
                await HumanBehavior.randomDelay(3000, 5000)
                // Drag to look around
                const c = await this.mapCenter(page)
                if (c) {
                    await moveCursor(page, c.x, c.y)
                    await page.mouse.move(c.x, c.y)
                    await page.mouse.down()
                    await page.mouse.move(c.x + 100, c.y, { steps: 10 })
                    await page.mouse.up()
                    await HumanBehavior.randomDelay(2000, 3000)
                }
            }
        } catch { /* ignore */ }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• REVIEWS (7) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async reviews_read(page: Page) {
        const btn = await page.$('button[data-tab-id="reviews"], button[aria-label*="Review" i], button:has-text("Reviews"), button:has-text("ÄÃ¡nh giÃ¡")')
        if (!btn) throw new Error('No reviews')
        await btn.click()
        await HumanBehavior.randomDelay(2000, 4000)
        const panel = await page.$('div.m6QErb.DxyBCb.kA9KIf.dS8AEf, div[role="main"]')
        const n = HumanBehavior.getRandomDelay(5, 10)
        if (panel) {
            for (let i = 0; i < n; i++) {
                await panel.evaluate((el: Element) => el.scrollBy(0, 200 + Math.random() * 300))
                await HumanBehavior.randomDelay(1000, 2500)
            }
        } else { await HumanBehavior.randomScroll(page, n) }
        await HumanBehavior.randomDelay(3000, 6000)
    }

    static async reviews_expand(page: Page) {
        await this.reviews_read(page)
        try {
            const btns = await page.$$('button[aria-label*="more" i], button.w8nwRe, button:has-text("More"), button:has-text("ThÃªm")')
            const n = Math.min(btns.length, HumanBehavior.getRandomDelay(1, 3))
            for (let i = 0; i < n; i++) { try { await btns[i].click(); await HumanBehavior.randomDelay(1000, 2000) } catch { } }
        } catch { }
    }

    static async reviews_sort(page: Page) {
        await this.reviews_read(page)
        try {
            const sortBtn = await page.$('button[aria-label*="Sort" i], button[data-value="Sort"]')
            if (sortBtn) {
                await sortBtn.click()
                await HumanBehavior.randomDelay(1000, 2000)
                const opts = await page.$$('div[role="menuitemradio"], li[role="menuitemradio"], div[role="option"]')
                if (opts.length > 1) {
                    await opts[Math.floor(Math.random() * opts.length)].click()
                    await HumanBehavior.randomDelay(2000, 4000)
                    await HumanBehavior.randomScroll(page, 3)
                }
            }
        } catch { }
    }

    static async reviews_filter_stars(page: Page) {
        await this.reviews_read(page)
        try {
            const stars = await page.$$('button[aria-label*="star" i], div[aria-label*="star" i] button')
            if (stars.length > 0) {
                await stars[Math.floor(Math.random() * stars.length)].click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 3)
            }
        } catch { }
    }

    static async reviews_view_photos(page: Page) {
        await this.reviews_read(page)
        try {
            const reviewImgs = await page.$$('div.review-container img, button[aria-label*="review photo" i], div[data-review-id] img')
            if (reviewImgs.length > 0) {
                await reviewImgs[Math.floor(Math.random() * Math.min(reviewImgs.length, 5))].click()
                await HumanBehavior.randomDelay(3000, 5000)
                await this.escSafe(page)
            }
        } catch { }
    }

    static async reviews_helpful(page: Page) {
        await this.reviews_read(page)
        // Just hover over helpful buttons â€” don't actually click to avoid detection
        try {
            const helpBtns = await page.$$('button[aria-label*="helpful" i], button[aria-label*="Há»¯u Ã­ch"]')
            if (helpBtns.length > 0) {
                const el = helpBtns[Math.floor(Math.random() * helpBtns.length)]
                await el.hover()
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch { }
    }

    static async reviews_author_profile(page: Page) {
        await this.reviews_read(page)
        try {
            const authors = await page.$$('button[aria-label*="contributor" i], a[href*="/contrib/"], button.al6Kxe')
            if (authors.length > 0) {
                await authors[Math.floor(Math.random() * Math.min(authors.length, 5))].click()
                await HumanBehavior.randomDelay(3000, 5000)
                await HumanBehavior.randomScroll(page, 2)
                await this.goBackSafe(page)
            }
        } catch { }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• DIRECTIONS (5) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private static async openDirections(page: Page) {
        const btn = await page.$('button[data-value="Directions"], button[aria-label*="Direction" i], a[data-item-id="directions"], button:has-text("Directions"), button:has-text("Chá»‰ Ä‘Æ°á»ng")')
        if (!btn) throw new Error('No directions')
        await btn.click()
        await HumanBehavior.randomDelay(2000, 4000)
    }

    private static async selectTransportMode(page: Page, mode: string) {
        try {
            const btn = await page.$(`button[aria-label*="${mode}" i], div[data-travel_mode] button[aria-label*="${mode}" i]`)
            if (btn) { await btn.click(); await HumanBehavior.randomDelay(2000, 3000) }
        } catch { }
    }

    static async directions_driving(page: Page) {
        await this.openDirections(page)
        await this.selectTransportMode(page, 'Driving')
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(2000, 4000)
        await this.goBackSafe(page)
    }

    static async directions_walking(page: Page) {
        await this.openDirections(page)
        await this.selectTransportMode(page, 'Walking')
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(2000, 4000)
        await this.goBackSafe(page)
    }

    static async directions_transit(page: Page) {
        await this.openDirections(page)
        await this.selectTransportMode(page, 'Transit')
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(2000, 4000)
        await this.goBackSafe(page)
    }

    static async directions_cycling(page: Page) {
        await this.openDirections(page)
        await this.selectTransportMode(page, 'Cycling')
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(2000, 4000)
        await this.goBackSafe(page)
    }

    static async directions_reverse(page: Page) {
        await this.openDirections(page)
        try {
            const reverseBtn = await page.$('button[aria-label*="reverse" i], button[aria-label*="Swap" i], button[aria-label*="Ä‘áº£o" i]')
            if (reverseBtn) { await reverseBtn.click(); await HumanBehavior.randomDelay(2000, 3000) }
        } catch { }
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(1500, 3000)
        await this.goBackSafe(page)
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• BUSINESS INFO (8) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async info_view_hours(page: Page) {
        const el = await page.$('div[data-section-id="hours"], button[aria-label*="hours" i], span:has-text("Open"), span:has-text("Closed"), button[data-item-id*="oh"]')
        if (!el) throw new Error('No hours')
        try { await el.click(); await HumanBehavior.randomDelay(2000, 4000) } catch { }
        await HumanBehavior.randomDelay(1000, 2000)
    }

    static async info_view_about(page: Page) {
        const btn = await page.$('button[data-tab-id="about"], button[aria-label*="About" i], button:has-text("About"), button:has-text("Giá»›i thiá»‡u"), button[data-tab-id="overview"]')
        if (!btn) throw new Error('No about')
        await btn.click()
        await HumanBehavior.randomDelay(1500, 3000)
        await HumanBehavior.randomScroll(page, 3)
        await HumanBehavior.randomDelay(2000, 4000)
    }

    static async info_phone(page: Page) {
        try {
            const phone = await page.$('button[data-item-id*="phone"], a[data-item-id*="phone"], button[aria-label*="Phone" i]')
            if (phone) {
                await phone.hover()
                await HumanBehavior.randomDelay(2000, 3000)
            }
        } catch { }
        await HumanBehavior.randomDelay(1000, 2000)
    }

    static async info_address_copy(page: Page) {
        try {
            const addr = await page.$('button[data-item-id="address"], button[aria-label*="Address" i], button[data-item-id*="address"]')
            if (addr) {
                await addr.click()
                await HumanBehavior.randomDelay(1500, 3000)
            }
        } catch { }
        await HumanBehavior.randomDelay(1000, 2000)
    }

    static async info_website(page: Page) {
        const link = await page.$('a[data-item-id="authority"], a[aria-label*="website" i], a:has-text("Website"), a[data-tooltip*="website"]')
        if (!link) throw new Error('No website')
        await link.click()
        await HumanBehavior.randomDelay(3000, 6000)
        await HumanBehavior.randomScroll(page, 3)
        await HumanBehavior.randomDelay(2000, 4000)
        await page.goBack()
        await HumanBehavior.randomDelay(1500, 2500)
    }

    static async info_menu(page: Page) {
        try {
            const menuLink = await page.$('a[aria-label*="Menu" i], a[data-item-id*="menu"], button:has-text("Menu"), a:has-text("Menu")')
            if (menuLink) {
                await menuLink.click()
                await HumanBehavior.randomDelay(3000, 6000)
                await HumanBehavior.randomScroll(page, 3)
                await HumanBehavior.randomDelay(2000, 3000)
                await page.goBack()
                await HumanBehavior.randomDelay(1500, 2500)
            }
        } catch { }
    }

    static async info_price_range(page: Page) {
        try {
            const priceEl = await page.$('span[aria-label*="Price" i], span:has-text("â‚«"), span:has-text("$"), div[data-attrid*="price"]')
            if (priceEl) {
                await priceEl.hover()
                await HumanBehavior.randomDelay(2000, 3000)
            }
        } catch { }
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async info_amenities(page: Page) {
        try {
            const aboutBtn = await page.$('button[data-tab-id="about"], button:has-text("About"), button:has-text("Giá»›i thiá»‡u")')
            if (aboutBtn) {
                await aboutBtn.click()
                await HumanBehavior.randomDelay(1500, 3000)
            }
        } catch { }
        await HumanBehavior.randomScroll(page, HumanBehavior.getRandomDelay(4, 8))
        await HumanBehavior.randomDelay(2000, 4000)
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SOCIAL (5) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async share_link(page: Page) {
        const btn = await page.$('button[data-value="Share"], button[aria-label*="Share" i], button:has-text("Share"), button:has-text("Chia sáº»")')
        if (!btn) throw new Error('No share')
        await btn.click()
        await HumanBehavior.randomDelay(2000, 4000)
        await this.escSafe(page)
    }

    static async share_embed(page: Page) {
        await this.share_link(page)
        try {
            const embedTab = await page.$('button:has-text("Embed"), a:has-text("Embed"), button:has-text("NhÃºng")')
            if (embedTab) {
                await embedTab.click()
                await HumanBehavior.randomDelay(2000, 4000)
            }
        } catch { }
        await this.escSafe(page)
    }

    static async save_place(page: Page) {
        try {
            const saveBtn = await page.$('button[data-value="Save"], button[aria-label*="Save" i], button:has-text("Save"), button:has-text("LÆ°u")')
            if (saveBtn) {
                await saveBtn.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await this.escSafe(page)
            }
        } catch { }
    }

    static async send_to_phone(page: Page) {
        await this.share_link(page)
        try {
            const phoneOpt = await page.$('button:has-text("phone"), button:has-text("Ä‘iá»‡n thoáº¡i"), a:has-text("phone")')
            if (phoneOpt) {
                await phoneOpt.hover()
                await HumanBehavior.randomDelay(1500, 2500)
            }
        } catch { }
        await this.escSafe(page)
    }

    static async print_location(page: Page) {
        // Open share, look for print â€” don't actually print
        await this.share_link(page)
        await HumanBehavior.randomDelay(1000, 2000)
        await this.escSafe(page)
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• DISCOVERY (6) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async explore_nearby(page: Page) {
        await HumanBehavior.randomScroll(page, 5)
        await HumanBehavior.randomDelay(2000, 5000)
        try {
            const link = await page.$('div[data-section-id="relatives"] a, a[data-item-id*="place"]')
            if (link) {
                await link.click()
                await HumanBehavior.randomDelay(3000, 5000)
                await HumanBehavior.randomScroll(page, 2)
                await page.goBack()
                await HumanBehavior.randomDelay(1500, 2500)
            }
        } catch { }
    }

    static async explore_similar(page: Page) {
        await HumanBehavior.randomScroll(page, 6)
        await HumanBehavior.randomDelay(2000, 4000)
        try {
            const similar = await page.$$('div[data-section-id="relatives"] a, a[data-item-id*="place"]')
            if (similar.length > 1) {
                await similar[Math.floor(Math.random() * Math.min(similar.length, 5))].click()
                await HumanBehavior.randomDelay(3000, 5000)
                await HumanBehavior.randomScroll(page, 3)
                await page.goBack()
                await HumanBehavior.randomDelay(1500, 2500)
            }
        } catch { }
    }

    static async explore_category(page: Page) {
        try {
            const cats = await page.$$('button[aria-label*="category" i], a[data-category], span.DkEaL')
            if (cats.length > 0) {
                await cats[Math.floor(Math.random() * cats.length)].click()
                await HumanBehavior.randomDelay(3000, 5000)
                await HumanBehavior.randomScroll(page, 3)
                await page.goBack()
                await HumanBehavior.randomDelay(1500, 2500)
            }
        } catch { }
    }

    static async explore_popular_times(page: Page) {
        await HumanBehavior.randomScroll(page, 4)
        try {
            const popSection = await page.$('div[aria-label*="Popular times" i], div[data-section-id="poptimes"]')
            if (popSection) {
                await popSection.hover()
                await HumanBehavior.randomDelay(2000, 4000)
                // Click different day bars
                const bars = await page.$$('div[aria-label*="Popular times" i] div[role="img"], div[data-section-id="poptimes"] div[role="button"]')
                if (bars.length > 0) {
                    await bars[Math.floor(Math.random() * bars.length)].click()
                    await HumanBehavior.randomDelay(1500, 2500)
                }
            }
        } catch { }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async explore_qa(page: Page) {
        await HumanBehavior.randomScroll(page, 5)
        try {
            const qaSection = await page.$('div[data-section-id="questions"], button:has-text("Questions"), button:has-text("Q&A"), button:has-text("Há»i")')
            if (qaSection) {
                await qaSection.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 3)
            }
        } catch { }
        await HumanBehavior.randomDelay(2000, 4000)
    }

    static async explore_updates(page: Page) {
        try {
            const updatesBtn = await page.$('button[data-tab-id="updates"], button:has-text("Updates"), button:has-text("Cáº­p nháº­t")')
            if (updatesBtn) {
                await updatesBtn.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 4)
            }
        } catch { }
        await HumanBehavior.randomDelay(2000, 4000)
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• GENERAL BROWSING (4) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    static async browse_scroll_deep(page: Page) {
        const n = HumanBehavior.getRandomDelay(6, 12)
        for (let i = 0; i < n; i++) {
            const dir = Math.random() > 0.25 ? 1 : -1
            const amt = HumanBehavior.getRandomDelay(100, 400) * dir
            await page.mouse.wheel(0, amt)
            await HumanBehavior.randomDelay(1500, 4000)
        }
    }

    static async browse_read_panel(page: Page) {
        const panel = await page.$('div.m6QErb.DxyBCb.kA9KIf.dS8AEf, div[role="main"]')
        const n = HumanBehavior.getRandomDelay(5, 10)
        if (panel) {
            for (let i = 0; i < n; i++) {
                await panel.evaluate((el: Element) => el.scrollBy(0, 150 + Math.random() * 250))
                await HumanBehavior.randomDelay(2000, 5000)
            }
        } else {
            await HumanBehavior.randomScroll(page, n)
        }
    }

    static async browse_random_click(page: Page) {
        try {
            const clickables = await page.$$('button:visible, a:visible')
            const safe = clickables.slice(0, 20)
            if (safe.length > 0) {
                const el = safe[Math.floor(Math.random() * safe.length)]
                await el.hover()
                await HumanBehavior.randomDelay(1000, 2000)
                // Only click non-destructive elements
                const label = await el.getAttribute('aria-label') || ''
                if (!label.toLowerCase().includes('delete') && !label.toLowerCase().includes('sign')) {
                    await el.click()
                    await HumanBehavior.randomDelay(2000, 4000)
                }
            }
        } catch { }
        await HumanBehavior.randomDelay(1500, 3000)
    }

    static async browse_back_forward(page: Page) {
        await HumanBehavior.randomScroll(page, 3)
        await HumanBehavior.randomDelay(2000, 4000)
        await page.goBack()
        await HumanBehavior.randomDelay(2000, 4000)
        await page.goForward()
        await HumanBehavior.randomDelay(2000, 4000)
    }
}

// ============================================================
// Traffic Boost Engine
// ============================================================

export class TrafficBoostEngine {
    private readonly logger = getRuntimeLogger({ module: 'traffic-boost-engine' })
    private readonly visitWatchdogTimeoutMs = 150_000 // baseline minimum, proxy cap applied dynamically
    private readonly maxActionsPerVisitCap = 100
    private running = false
    private shouldStop = false
    private currentCampaignId: number | null = null
    private currentCampaignName = ''
    private activeContexts: Map<number, string> = new Map() // contextId -> profilePath
    private threadContextIds: Map<number, number> = new Map() // threadId -> contextId
    private threadDetails: ThreadDetail[] = []
    private _totalRounds = 0
    private _currentRound = 0
    private _completedVisits = 0
    private _totalVisits = 0
    private _failedVisits = 0
    private currentQueueDepth = 0
    private _keywordCounters: Record<string, number> = {} // Round-robin keyword index per location
    private captchaThreadStats: Map<number, { hits: number; lastDetectedAt: number; lastResolvedAt?: number }> = new Map()
    private readonly captchaCooldownWindowMs = 12 * 60 * 1000
    private runtimePolicy: RuntimePolicyV2 = runtimePolicyService.getPolicy()
    private networkState: NetworkStateV2 = {
        mode: 'direct',
        reason: 'default_direct_mode',
        useProxySetting: false,
        hasFProxyApiKey: false,
        checkedAt: new Date().toISOString(),
    }
    private statusListeners: Set<(status: TrafficBoostStatus) => void> = new Set()
    private actionListeners: Set<(event: RuntimeActionEvent) => void> = new Set()
    private threadUrlBroadcastAt: Map<number, number> = new Map()

    onStatus(listener: (status: TrafficBoostStatus) => void): () => void {
        this.statusListeners.add(listener)
        return () => this.statusListeners.delete(listener)
    }

    onAction(listener: (event: RuntimeActionEvent) => void): () => void {
        this.actionListeners.add(listener)
        return () => this.actionListeners.delete(listener)
    }

    // ============================================================
    // Profile Management - Each account gets a unique Chrome profile
    // ============================================================

    /**
     * Get or create a unique profile path for an account.
     * Each account gets its own Chrome profile folder that persists
     * cookies, localStorage, and login sessions.
     */
    private ensureAccountProfile(account: any): string {
        const db = getDatabase()
        const userDataPath = app.getPath('userData')
        const profilesDir = join(userDataPath, 'traffic_profiles')

        if (!existsSync(profilesDir)) {
            mkdirSync(profilesDir, { recursive: true })
        }

        const sanitizedEmail = account.email.replace(/[^a-zA-Z0-9]/g, '_')
        const profilePath = join(profilesDir, `account_${account.id}_${sanitizedEmail}`)

        if (!existsSync(profilePath)) {
            mkdirSync(profilePath, { recursive: true })
        }

        // Self-heal: If the database contains an old absolute path from another Windows user, update it
        if (account.profilePath !== profilePath) {
            try {
                db.update(schema.accounts)
                    .set({ profilePath })
                    .where(eq(schema.accounts.id, account.id))
                    .run()
            } catch (err) {
                console.error(`[TrafficBoost] Failed to update profilePath in DB:`, err)
            }
            account.profilePath = profilePath
        }

        console.log(`[TrafficBoost] Profile for ${account.email}: ${profilePath}`)
        return profilePath
    }

    // Send status to renderer
    private sendStatus(status: TrafficBoostStatus) {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('trafficBoost:status', status)
        }
        this.statusListeners.forEach((listener) => listener(status))
    }

    private emitActionEvent(event: RuntimeActionEvent): void {
        this.actionListeners.forEach((listener) => listener(event))
    }

    private isGoogleLoginUrl(rawUrl: string): boolean {
        const url = (rawUrl || '').toLowerCase()
        if (!url.includes('google.com')) {
            return false
        }
        return url.includes('accounts.google.com')
            || url.includes('/servicelogin')
            || url.includes('/v3/signin')
            || url.includes('signin/identifier')
            || url.includes('consent.google.com')
    }

    private updateThreadCurrentUrl(threadIdx: number, page: Page): void {
        if (page.isClosed()) {
            return
        }
        const current = this.threadDetails[threadIdx]
        if (!current) {
            return
        }
        const url = page.url() || ''
        if (!url || current.currentUrl === url) {
            return
        }
        this.threadDetails[threadIdx] = {
            ...current,
            currentUrl: url,
        }

        if (this.running) {
            const now = Date.now()
            const lastBroadcast = this.threadUrlBroadcastAt.get(threadIdx) ?? 0
            if (now - lastBroadcast >= 500) {
                this.threadUrlBroadcastAt.set(threadIdx, now)
                this.sendStatus(this.buildStatus())
            }
        }
    }

    private startThreadPageMonitor(threadIdx: number, page: Page): () => void {
        const timer = setInterval(() => {
            this.updateThreadCurrentUrl(threadIdx, page)
        }, 900)
        this.updateThreadCurrentUrl(threadIdx, page)
        return () => clearInterval(timer)
    }

    private applyRuntimeProxySettings(): { proxyEnabled: boolean; fproxyApiKey: string } {
        const savedSettings = loadSettings()
        const proxyEnabled = savedSettings.useProxy === true
        const fproxyApiKey = typeof savedSettings.fproxyApiKey === 'string' ? savedSettings.fproxyApiKey.trim() : ''

        if (!proxyEnabled) {
            if (fproxyService.hasConfiguration()) {
                fproxyService.clearConfiguration('runtime_proxy_disabled_in_settings')
            }
        } else if (fproxyApiKey) {
            if (fproxyService.getApiKey() !== fproxyApiKey) {
                fproxyService.setApiKey(fproxyApiKey)
            }
        } else if (fproxyService.getApiKey()) {
            // Proxy is enabled globally but FProxy key was removed at runtime.
            // Keep static proxy mode clean by removing stale FProxy config.
            fproxyService.clearConfiguration('runtime_proxy_key_missing')
        }

        return { proxyEnabled, fproxyApiKey }
    }

    private normalizeDomain(raw?: string): string {
        if (!raw) {
            return 'unknown'
        }
        try {
            const url = raw.startsWith('http://') || raw.startsWith('https://')
                ? new URL(raw)
                : new URL(`https://${raw}`)
            return (url.hostname || 'unknown').toLowerCase()
        } catch {
            return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || 'unknown'
        }
    }

    private deriveDecisionSource(
        source: string,
        explicit?: VisitActionRecord['decisionSource'],
        ragUsed?: boolean
    ): VisitActionRecord['decisionSource'] | undefined {
        if (explicit) {
            return explicit
        }
        const normalized = source.toLowerCase()
        if (normalized.includes('heuristic')) {
            return 'heuristic'
        }
        if (normalized.includes('llm')) {
            return ragUsed ? 'llm+rag' : 'llm'
        }
        return undefined
    }

    private recordAction(
        actionsPerformed: VisitActionRecord[],
        input: VisitActionRecord,
        context: ActionContext
    ): void {
        const timestamp = input.timestamp || new Date().toISOString()
        const normalized: VisitActionRecord = {
            ...input,
            timestamp,
            threadId: input.threadId ?? context.threadId,
        }
        const source = normalized.source || 'runtime'
        const decisionSource = this.deriveDecisionSource(source, normalized.decisionSource, normalized.ragUsed)
        const ragUsed = normalized.ragUsed === true || decisionSource === 'llm+rag'

        actionsPerformed.push(normalized)

        const actionEvent: RuntimeActionEvent = {
            eventId: `${timestamp}-${context.threadId}-${Math.random().toString(36).slice(2, 8)}`,
            campaignId: context.campaignId,
            campaignName: context.campaignName,
            round: context.round,
            threadId: normalized.threadId ?? context.threadId,
            accountEmail: context.accountEmail,
            locationName: context.locationName,
            action: normalized.action,
            source,
            success: normalized.success !== false,
            detail: normalized.detail,
            thought: normalized.thought,
            error: normalized.error,
            durationMs: normalized.durationMs,
            step: normalized.step,
            elementId: normalized.elementId,
            attempt: normalized.attempt,
            retryCategory: normalized.retryCategory,
            queueDepth: normalized.queueDepth ?? this.currentQueueDepth,
            latencyMs: normalized.latencyMs,
            recoverPath: normalized.recoverPath,
            decisionSource,
            ragUsed,
            ragHitCount: normalized.ragHitCount,
            ragEvidenceIds: normalized.ragEvidenceIds,
            decisionLatencyMs: normalized.decisionLatencyMs,
            timestamp,
        }
        this.logger.info({
            event: 'runtime_action',
            campaignId: actionEvent.campaignId,
            threadId: actionEvent.threadId,
            action: actionEvent.action,
            source: actionEvent.source,
            success: actionEvent.success,
            attempt: actionEvent.attempt,
            retryCategory: actionEvent.retryCategory,
            queueDepth: actionEvent.queueDepth,
            latencyMs: actionEvent.latencyMs,
            recoverPath: actionEvent.recoverPath,
            decisionSource: actionEvent.decisionSource,
            ragUsed: actionEvent.ragUsed,
            ragHitCount: actionEvent.ragHitCount,
            timestamp: actionEvent.timestamp,
        })
        void miniRagService.ingest({
            campaignType: 'traffic',
            campaignId: context.campaignId,
            threadId: normalized.threadId ?? context.threadId,
            domain: context.domain,
            goal: context.goal || 'map_interaction',
            riskType: normalized.retryCategory || normalized.action || context.riskType,
            signalText: normalized.thought || normalized.detail || normalized.action,
            action: normalized.action,
            decisionSource: decisionSource || source,
            success: normalized.success !== false,
            detail: normalized.detail,
            error: normalized.error,
            recoverPath: normalized.recoverPath,
            latencyMs: normalized.latencyMs ?? normalized.decisionLatencyMs ?? normalized.durationMs,
            metadata: actionEvent.ragEvidenceIds ? { ragEvidenceIds: actionEvent.ragEvidenceIds } : undefined,
            timestamp,
        }).catch(() => { })
        this.emitActionEvent(actionEvent)
    }

    // Build current status object
    private buildStatus(overrides: Partial<TrafficBoostStatus> = {}): TrafficBoostStatus {
        return {
            isRunning: this.running,
            campaignId: this.currentCampaignId ?? null,
            campaignName: this.currentCampaignName,
            activeThreads: this.threadDetails.filter(t => t.status === 'visiting').length,
            threadsTotal: this.threadDetails.length,
            currentRound: this._currentRound,
            totalRounds: this._totalRounds,
            completedVisits: this._completedVisits,
            totalVisits: this._totalVisits,
            failedVisits: this._failedVisits,
            message: 'Idle',
            threads: this.threadDetails.map(t => ({
                id: t.id,
                accountEmail: t.accountEmail,
                locationName: t.locationName,
                currentAction: t.currentAction,
                currentUrl: t.currentUrl || '',
                currentKeyword: t.currentKeyword || '',
                status: t.status,
                progress: t.progress ?? 0,
                proxyInfo: t.proxyInfo || '',
            })),
            effectiveNetworkMode: this.networkState.mode,
            networkState: this.networkState,
            ...overrides,
        }
    }

    private refreshRuntimePolicy(): RuntimePolicyV2 {
        this.runtimePolicy = runtimePolicyService.getPolicy()
        return this.runtimePolicy
    }

    getDiagnostics(): RuntimeDiagnosticsV2 {
        return {
            timestamp: new Date().toISOString(),
            isRunning: this.running,
            campaignId: this.currentCampaignId ?? null,
            activeContexts: this.activeContexts.size,
            activeThreads: this.threadDetails.filter(t => t.status === 'visiting').length,
            queueDepth: this.currentQueueDepth,
            captchaByThread: Array.from(this.captchaThreadStats.entries()).map(([threadId, stats]) => ({
                threadId,
                hits: stats.hits,
                lastDetectedAt: stats.lastDetectedAt,
                lastResolvedAt: stats.lastResolvedAt,
            })),
        }
    }

    getActionTrace(campaignId?: number, limit: number = 500): Array<Record<string, unknown>> {
        const db = getDatabase()
        const rows = campaignId
            ? db.select().from(schema.trafficLogs).where(eq(schema.trafficLogs.campaignId, campaignId)).all()
            : db.select().from(schema.trafficLogs).all()

        const trace: Array<Record<string, unknown>> = []
        const max = Math.max(1, Math.min(limit, 5000))
        for (const row of rows) {
            let actions: unknown = []
            try {
                actions = JSON.parse(row.actions || '[]')
            } catch {
                actions = []
            }

            if (!Array.isArray(actions)) {
                continue
            }

            for (const item of actions) {
                if (!item || typeof item !== 'object') {
                    continue
                }
                const event = item as Record<string, unknown>
                trace.push({
                    campaignId: row.campaignId,
                    logId: row.id,
                    accountId: row.accountId,
                    locationId: row.locationId,
                    round: row.round,
                    status: row.status,
                    createdAt: row.createdAt,
                    action: typeof event.action === 'string' ? event.action : 'unknown',
                    success: event.success !== false,
                    source: typeof event.source === 'string' ? event.source : undefined,
                    detail: typeof event.detail === 'string' ? event.detail : undefined,
                    thought: typeof event.thought === 'string' ? event.thought : undefined,
                    error: typeof event.error === 'string' ? event.error : undefined,
                    durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
                    step: typeof event.step === 'number' ? event.step : undefined,
                    elementId: typeof event.elementId === 'number' ? event.elementId : undefined,
                    attempt: typeof event.attempt === 'number' ? event.attempt : undefined,
                    retryCategory: typeof event.retryCategory === 'string' ? event.retryCategory : undefined,
                    queueDepth: typeof event.queueDepth === 'number' ? event.queueDepth : undefined,
                    latencyMs: typeof event.latencyMs === 'number' ? event.latencyMs : undefined,
                    recoverPath: typeof event.recoverPath === 'string' ? event.recoverPath : undefined,
                    decisionSource: typeof event.decisionSource === 'string' ? event.decisionSource : undefined,
                    ragUsed: event.ragUsed === true,
                    ragHitCount: typeof event.ragHitCount === 'number' ? event.ragHitCount : undefined,
                    ragEvidenceIds: Array.isArray(event.ragEvidenceIds)
                        ? event.ragEvidenceIds.filter((id): id is number => typeof id === 'number')
                        : undefined,
                    decisionLatencyMs: typeof event.decisionLatencyMs === 'number' ? event.decisionLatencyMs : undefined,
                    timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
                })
                if (trace.length >= max) {
                    return trace
                }
            }
        }

        return trace
    }

    private async cleanupExtraTabsForThread(page: Page, threadIdx: number, reason: string): Promise<void> {
        if (page.isClosed()) {
            return
        }

        const tabs = page.context().pages()
        let closedCount = 0

        for (const tab of tabs) {
            if (tab === page || tab.isClosed()) {
                continue
            }

            try {
                await tab.close({ runBeforeUnload: false })
                closedCount++
            } catch {
                // Ignore close failures for stubborn tabs.
            }
        }

        if (closedCount > 0) {
            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Closed ${closedCount} extra tab(s) (${reason})`)
        }

        await page.bringToFront().catch(() => { })
    }

    private isGoogleMapsUrl(url: string): boolean {
        const normalized = String(url || '').toLowerCase()
        return normalized.includes('google.com/maps')
            || /:\/\/maps\.google\./.test(normalized)
            || normalized.includes('/maps/place')
            || normalized.includes('/maps/search')
            || normalized.includes('/maps/dir')
    }

    private async isMapUiReady(page: Page): Promise<boolean> {
        if (page.isClosed()) {
            return false
        }

        const currentUrl = page.url()
        if (this.isGoogleLoginUrl(currentUrl)) {
            return false
        }

        if (!this.isGoogleMapsUrl(currentUrl)) {
            return false
        }

        const quickSignalCount = await page
            .locator('#searchboxinput, button[data-value="Directions"], div[role="main"], button[jsaction*="pane.placeActions.directions"]')
            .count()
            .catch(() => 0)
        if (quickSignalCount > 0) {
            return true
        }

        const pageTitle = await page.title().catch(() => '')
        return /google maps|maps|bản đồ/i.test(pageTitle)
    }

    private async hasVisibleBlockingDialog(page: Page): Promise<boolean> {
        if (page.isClosed()) {
            return false
        }

        return page.evaluate(() => {
            const selectors = '[role="dialog"], [aria-modal="true"], [role="alertdialog"]'
            const dialogs = Array.from(document.querySelectorAll<HTMLElement>(selectors))
            return dialogs.some(dialog => {
                const rect = dialog.getBoundingClientRect()
                const style = window.getComputedStyle(dialog)
                return rect.width > 20
                    && rect.height > 20
                    && style.visibility !== 'hidden'
                    && style.display !== 'none'
                    && style.opacity !== '0'
            })
        }).catch(() => false)
    }

    private async ensureDirectModeMapReady(
        page: Page,
        threadIdx: number,
        location: any,
        statusContext: {
            campaignName: string
            currentRound: number
            completedVisits: number
            totalVisits: number
            failedVisits: number
        },
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        hasAccount: boolean
    ): Promise<void> {
        if (await this.isMapUiReady(page)) {
            return
        }

        const locationName = String(location?.name || '').trim()
        const locationAddress = String(location?.address || '').trim()
        const locationPlaceId = String(location?.placeId || '').trim()
        const fallbackQuery = [locationName, locationAddress].filter(Boolean).join(' ').trim()
        const fallbackQueryUrl = fallbackQuery
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackQuery)}`
            : 'https://www.google.com/maps'

        this.threadDetails[threadIdx].currentAction = 'Direct mode: recovering map context'
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: Direct mode fallback to map recovery`,
        }))
        this.recordAction(actionsPerformed, {
            action: 'direct_mode_recover_start',
            success: true,
            source: 'runtime',
            detail: `Initial URL not map-ready: ${page.url()}`,
            threadId: threadIdx,
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)

        let recovered = false

        if (locationPlaceId) {
            const placeIdUrl = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(locationPlaceId)}`
            await page.goto(placeIdUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => { })
            await HumanBehavior.randomDelay(900, 1800)
            recovered = await this.isMapUiReady(page)
        }

        if (!recovered && fallbackQuery) {
            try {
                const organicFlow = new OrganicSearchFlow((status) => {
                    this.threadDetails[threadIdx].currentAction = status
                })
                const organicResult = await organicFlow.execute(page, fallbackQuery, {
                    name: locationName || fallbackQuery,
                    address: locationAddress || locationName || fallbackQuery,
                    placeId: locationPlaceId || undefined,
                    url: String(location?.url || fallbackQueryUrl),
                }, hasAccount)

                for (const organicAction of organicResult.actionsPerformed) {
                    this.recordAction(actionsPerformed, {
                        action: `direct_recover_organic:${organicAction.action}`,
                        success: organicAction.success,
                        source: 'organic',
                        detail: `Direct fallback organic action: ${organicAction.action}`,
                        threadId: threadIdx,
                        queueDepth: this.currentQueueDepth,
                        timestamp: new Date().toISOString(),
                    }, actionContext)
                }
                recovered = organicResult.foundMap || await this.isMapUiReady(page)
            } catch {
                // Ignore organic fallback exceptions and continue with URL fallback.
            }
        }

        if (!recovered) {
            await page.goto(fallbackQueryUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => { })
            await HumanBehavior.randomDelay(1000, 2200)
            recovered = await this.isMapUiReady(page)
        }

        this.recordAction(actionsPerformed, {
            action: recovered ? 'direct_mode_recover_success' : 'direct_mode_recover_failed',
            success: recovered,
            source: 'runtime',
            detail: recovered
                ? `Recovered map context via direct fallback (${page.url()})`
                : `Direct fallback failed to restore map context (${page.url()})`,
            threadId: threadIdx,
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)

        if (!recovered) {
            throw new Error('DIRECT_MODE_MAP_NOT_READY')
        }
    }

    private async handleGoogleLoginIfNeeded(
        page: Page,
        threadIdx: number,
        statusContext: {
            campaignName: string
            currentRound: number
            completedVisits: number
            totalVisits: number
            failedVisits: number
        },
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        fallbackUrl: string
    ): Promise<void> {
        if (page.isClosed()) {
            return
        }

        this.updateThreadCurrentUrl(threadIdx, page)
        if (!this.isGoogleLoginUrl(page.url())) {
            return
        }

        this.threadDetails[threadIdx].currentAction = 'Google Login gate detected'
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: Google login gate detected, auto-recovering`,
        }))
        this.recordAction(actionsPerformed, {
            action: 'google_login_detected',
            success: false,
            source: 'safety',
            detail: page.url(),
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)

        const resolved = await contextualInterruptionResolver.resolve(page, {
            threadId: threadIdx,
            reason: 'google_login_gate',
            useLlmFallback: true,
            llmTimeoutMs: 2200,
            useEscapeFallback: true,
            maxPasses: 3,
            goal: 'map_interaction',
            campaignType: 'traffic',
            campaignId: actionContext.campaignId,
            domain: page.url(),
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
        if (resolved.handled) {
            await HumanBehavior.randomDelay(140, 280)
            this.updateThreadCurrentUrl(threadIdx, page)
            if (!this.isGoogleLoginUrl(page.url())) {
                this.recordAction(actionsPerformed, {
                    action: 'context_recover_map_success',
                    success: true,
                    source: 'runtime',
                    detail: `Recovered by interruption resolver (${resolved.via || 'unknown'})`,
                    threadId: threadIdx,
                    retryCategory: 'google_login',
                    recoverPath: resolved.via,
                    queueDepth: this.currentQueueDepth,
                    timestamp: new Date().toISOString(),
                }, actionContext)
                return
            }
        }

        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3500 }).catch(() => { })
        await HumanBehavior.randomDelay(180, 420)
        this.updateThreadCurrentUrl(threadIdx, page)
        if (!this.isGoogleLoginUrl(page.url())) {
            this.recordAction(actionsPerformed, {
                action: 'context_recover_map_success',
                success: true,
                source: 'runtime',
                detail: 'Recovered by goBack',
                threadId: threadIdx,
                retryCategory: 'google_login',
                queueDepth: this.currentQueueDepth,
                timestamp: new Date().toISOString(),
            }, actionContext)
            return
        }

        await page.goto(fallbackUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => { })
        await this.stabilizeContextIfNeeded(
            page,
            threadIdx,
            'google_login_fallback_navigation',
            actionsPerformed,
            actionContext,
            statusContext
        )
        await HumanBehavior.randomDelay(220, 560)
        this.updateThreadCurrentUrl(threadIdx, page)
        if (!this.isGoogleLoginUrl(page.url())) {
            this.recordAction(actionsPerformed, {
                action: 'context_recover_map_success',
                success: true,
                source: 'runtime',
                detail: 'Recovered by fallback navigation',
                threadId: threadIdx,
                retryCategory: 'google_login',
                queueDepth: this.currentQueueDepth,
                timestamp: new Date().toISOString(),
            }, actionContext)
            return
        }

        this.threadDetails[threadIdx].currentAction = 'Google Login blocked (skip visit)'
        this.recordAction(actionsPerformed, {
            action: 'context_recover_map_failed',
            success: false,
            source: 'runtime',
            detail: 'Failed to return to map after resolver/goBack/fallback navigation',
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)
        this.recordAction(actionsPerformed, {
            action: 'google_login_blocked',
            success: false,
            source: 'safety',
            detail: 'Unable to leave Google login page',
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)
        this.recordAction(actionsPerformed, {
            action: 'visit_skipped_unrecoverable_login',
            success: false,
            source: 'safety',
            detail: 'Skipping visit because Google login gate could not be recovered',
            threadId: threadIdx,
            retryCategory: 'google_login',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)
        throw new Error('GOOGLE_LOGIN_BLOCKED')
    }

    private async isCaptchaOrSorryPage(page: Page): Promise<boolean> {
        if (page.isClosed()) {
            return false
        }

        const currentUrl = page.url().toLowerCase()
        if (
            currentUrl.includes('google.com/sorry')
            || currentUrl.includes('/sorry/index')
            || currentUrl.includes('ipv4.google.com/sorry')
            || currentUrl.includes('recaptcha')
        ) {
            return true
        }

        const hasRecaptchaFrame = await page.locator('iframe[src*="recaptcha"], div.g-recaptcha').count().catch(() => 0)
        if (hasRecaptchaFrame > 0) {
            return true
        }

        try {
            const snapshot = await page.evaluate(() => {
                const bodyText = (document.body?.innerText || '').toLowerCase().slice(0, 5000)
                const pageTitle = (document.title || '').toLowerCase()
                return `${pageTitle}\n${bodyText}`
            })
            if (
                snapshot.includes("i'm not a robot")
                || snapshot.includes('unusual traffic')
                || snapshot.includes('our systems have detected unusual traffic')
                || snapshot.includes('to continue')
                || snapshot.includes('toi khong phai la nguoi may')
                || snapshot.includes('captcha')
            ) {
                return true
            }
        } catch {
            // Ignore evaluate failures and treat as no-captcha.
        }

        return false
    }

    private async handleCaptchaIfNeeded(
        page: Page,
        threadIdx: number,
        statusContext: {
            campaignName: string
            currentRound: number
            completedVisits: number
            totalVisits: number
            failedVisits: number
        },
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        fallbackUrl: string
    ): Promise<void> {
        const captchaDetected = await this.isCaptchaOrSorryPage(page)
        if (!captchaDetected) {
            return
        }

        const captchaStats = this.markCaptchaDetected(threadIdx)

        await page.bringToFront().catch(() => { })
        this.recordAction(actionsPerformed, {
            action: 'captcha_detected',
            success: false,
            source: 'safety',
            detail: `Google CAPTCHA/sorry page detected (strike=${captchaStats.hits})`,
            threadId: threadIdx,
            attempt: captchaStats.hits,
            retryCategory: 'captcha',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)

        // === TRY AUTO-SOLVE CAPTCHA VIA API ===
        this.threadDetails[threadIdx].currentAction = 'Đang giải CAPTCHA tự động...'
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: CAPTCHA detected → trying auto-solve via API...`,
        }))

        const solveSuccess = await captchaSolverService.solveCaptchaOnPage(page, threadIdx)
        if (solveSuccess) {
            await HumanBehavior.randomDelay(1500, 3000)
            const stillBlocked = await this.isCaptchaOrSorryPage(page)
            if (!stillBlocked) {
                this.markCaptchaResolved(threadIdx)
                this.recordAction(actionsPerformed, {
                    action: 'captcha_auto_solved',
                    success: true,
                    source: 'captcha_solver',
                    detail: `CAPTCHA solved automatically via API solver`,
                    threadId: threadIdx,
                    attempt: captchaStats.hits,
                    retryCategory: 'captcha',
                    queueDepth: this.currentQueueDepth,
                    timestamp: new Date().toISOString(),
                }, actionContext)
                this.threadDetails[threadIdx].currentAction = 'CAPTCHA solved ✓ - continuing visit'
                return
            }
        }

        // === FALLBACK: AUTO-SKIP (old behavior) ===
        this.threadDetails[threadIdx].currentAction = 'CAPTCHA auto-skip: recovering context'
        this.sendStatus(this.buildStatus({
            campaignName: statusContext.campaignName,
            currentRound: statusContext.currentRound,
            completedVisits: statusContext.completedVisits,
            totalVisits: statusContext.totalVisits,
            failedVisits: statusContext.failedVisits,
            message: `Thread ${threadIdx + 1}: CAPTCHA auto-solve failed (strike ${captchaStats.hits}), fallback to auto-skip`,
        }))
        this.recordAction(actionsPerformed, {
            action: 'captcha_auto_skip',
            success: true,
            source: 'safety',
            detail: `Auto-solve failed → fallback to auto-skip (strike ${captchaStats.hits})`,
            threadId: threadIdx,
            attempt: captchaStats.hits,
            retryCategory: 'captcha',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)

        const confirmRecovered = async (recoverPath: string, detail: string): Promise<boolean> => {
            this.updateThreadCurrentUrl(threadIdx, page)
            const stillBlocked = await this.isCaptchaOrSorryPage(page)
            if (stillBlocked) {
                return false
            }

            this.markCaptchaResolved(threadIdx)
            this.recordAction(actionsPerformed, {
                action: 'context_recover_map_success',
                success: true,
                source: 'runtime',
                detail,
                threadId: threadIdx,
                attempt: captchaStats.hits,
                retryCategory: 'captcha',
                recoverPath,
                queueDepth: this.currentQueueDepth,
                timestamp: new Date().toISOString(),
            }, actionContext)
            this.threadDetails[threadIdx].currentAction = 'CAPTCHA recovered - continuing visit'
            return true
        }

        const resolved = await contextualInterruptionResolver.resolve(page, {
            threadId: threadIdx,
            reason: 'captcha_gate',
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 3,
            goal: 'map_interaction',
            campaignType: 'traffic',
            campaignId: actionContext.campaignId,
            domain: page.url(),
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
        if (resolved.handled) {
            await HumanBehavior.randomDelay(140, 280)
            if (await confirmRecovered(
                resolved.via || 'interruption_resolver',
                `Recovered from CAPTCHA via interruption resolver (${resolved.via || 'unknown'})`
            )) {
                return
            }
        }

        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3500 }).catch(() => { })
        await HumanBehavior.randomDelay(180, 420)
        if (await confirmRecovered('go_back', 'Recovered from CAPTCHA via goBack')) {
            return
        }

        await page.goto(fallbackUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => { })
        await this.stabilizeContextIfNeeded(
            page,
            threadIdx,
            'captcha_fallback_navigation',
            actionsPerformed,
            actionContext,
            statusContext
        )
        await HumanBehavior.randomDelay(220, 560)
        if (await confirmRecovered('goto_fallback', 'Recovered from CAPTCHA via fallback navigation')) {
            return
        }

        this.threadDetails[threadIdx].currentAction = 'CAPTCHA unrecoverable (skip visit)'
        this.recordAction(actionsPerformed, {
            action: 'context_recover_map_failed',
            success: false,
            source: 'runtime',
            detail: 'Failed to recover from CAPTCHA after resolver/goBack/fallback navigation',
            threadId: threadIdx,
            attempt: captchaStats.hits,
            retryCategory: 'captcha',
            queueDepth: this.currentQueueDepth,
            timestamp: new Date().toISOString(),
        }, actionContext)
        throw new Error('CAPTCHA_UNRECOVERABLE')
    }

    private markCaptchaDetected(threadIdx: number): { hits: number; lastDetectedAt: number; lastResolvedAt?: number } {
        const current = this.captchaThreadStats.get(threadIdx)
        const now = Date.now()
        const next = {
            hits: Math.min(8, (current?.hits || 0) + 1),
            lastDetectedAt: now,
            lastResolvedAt: current?.lastResolvedAt,
        }
        this.captchaThreadStats.set(threadIdx, next)
        return next
    }

    private markCaptchaResolved(threadIdx: number): void {
        const current = this.captchaThreadStats.get(threadIdx)
        if (!current) {
            return
        }
        const next = {
            hits: Math.max(0, current.hits - 1),
            lastDetectedAt: current.lastDetectedAt,
            lastResolvedAt: Date.now(),
        }
        this.captchaThreadStats.set(threadIdx, next)
    }

    private shouldAvoidGoogleSearch(threadIdx: number): boolean {
        const stats = this.captchaThreadStats.get(threadIdx)
        if (!stats) {
            return false
        }
        const policy = this.runtimePolicy
        const threshold = Math.max(1, policy.captchaAutoSkipMaxStrikes)
        const now = Date.now()
        return stats.hits >= threshold && (now - stats.lastDetectedAt) < this.captchaCooldownWindowMs
    }

    private getAdaptiveDelayFactor(threadIdx: number): number {
        const stats = this.captchaThreadStats.get(threadIdx)
        if (!stats || stats.hits <= 0) {
            return 1
        }
        return Math.min(2.4, 1 + (stats.hits * 0.35))
    }

    private randomBetweenInclusive(minValue: number, maxValue: number): number {
        const min = Math.floor(Math.min(minValue, maxValue))
        const max = Math.floor(Math.max(minValue, maxValue))
        return HumanBehavior.getRandomDelay(min, max)
    }

    private normalizeDesiredActions(value: unknown): number {
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) {
            return 4
        }
        return Math.max(1, Math.min(this.maxActionsPerVisitCap, Math.floor(parsed)))
    }

    private pickRandomActions(actions: SEOAction[], count: number): SEOAction[] {
        if (!Array.isArray(actions) || actions.length === 0 || count <= 0) {
            return []
        }
        const normalizedCount = Math.max(1, Math.floor(count))
        const shuffled = [...actions].sort(() => Math.random() - 0.5)
        if (normalizedCount <= shuffled.length) {
            return shuffled.slice(0, normalizedCount)
        }
        const picked: SEOAction[] = [...shuffled]
        while (picked.length < normalizedCount) {
            const randomAction = actions[Math.floor(Math.random() * actions.length)]
            picked.push(randomAction)
        }
        return picked
    }

    private computeVisitWatchdogTimeoutMs(
        desiredActions: number,
        delayMinSeconds: number,
        delayMaxSeconds: number,
        mode: 'agentic' | 'seo',
        threadIdx: number,
        fixedActionCount: boolean
    ): number {
        const safeActions = this.normalizeDesiredActions(desiredActions)
        const adaptiveFactor = this.getAdaptiveDelayFactor(threadIdx)
        const safeDelayMin = Math.max(0, Number(delayMinSeconds || 0))
        const safeDelayMax = Math.max(safeDelayMin, Number(delayMaxSeconds || safeDelayMin))
        const averageDelayMs = Math.max(500, Math.floor(((safeDelayMin + safeDelayMax) / 2) * 750 * adaptiveFactor))
        const averageActionExecutionMs = mode === 'agentic' ? 9000 : 6200
        const baseOverheadMs = fixedActionCount ? 60_000 : 45_000
        const fixedFactor = fixedActionCount ? 1.25 : 1
        const estimatedMs = Math.floor(baseOverheadMs + (safeActions * (averageDelayMs + averageActionExecutionMs) * fixedFactor))
        const hardMaxMs = 12 * 60 * 1000
        const computedMs = Math.max(this.visitWatchdogTimeoutMs, Math.min(hardMaxMs, estimatedMs))
        // If proxy auto-rotation is active, cap visit timeout to fit within rotation interval
        if (fproxyService.getApiKey() && fproxyService.isAutoRotateActive()) {
            const proxyIntervalMs = fproxyService.getRotateIntervalMs()
            const proxyCappedMs = Math.max(45_000, proxyIntervalMs - 5_000) // 5s buffer for cleanup
            return Math.min(computedMs, proxyCappedMs)
        }
        return computedMs
    }

    private computeMaxActionsForWatchdog(
        delayMinSeconds: number,
        delayMaxSeconds: number,
        threadIdx: number,
        mode: 'agentic' | 'seo',
        visitTimeoutMs: number,
        desiredActions: number
    ): number {
        const adaptiveFactor = this.getAdaptiveDelayFactor(threadIdx)
        const safeDelayMin = Math.max(0, Number(delayMinSeconds || 0))
        const safeDelayMax = Math.max(safeDelayMin, Number(delayMaxSeconds || 0))

        const delayMinMs = Math.max(650, Math.floor(safeDelayMin * 420 * adaptiveFactor))
        const delayMaxMs = Math.max(1200, Math.floor(safeDelayMax * 620 * adaptiveFactor))
        const averageDelayMs = Math.floor((delayMinMs + delayMaxMs) / 2)

        const averageActionExecutionMs = mode === 'agentic' ? 9000 : 6200
        const reservedOverheadMs = 24_000
        const availableMs = Math.max(15_000, visitTimeoutMs - reservedOverheadMs)
        const estimatedMax = Math.floor(availableMs / Math.max(1400, averageDelayMs + averageActionExecutionMs))
        const desiredCap = Math.max(1, Math.floor(this.normalizeDesiredActions(desiredActions) * 1.35))
        const hardCap = Math.min(this.maxActionsPerVisitCap, Math.max(6, desiredCap))

        return Math.max(1, Math.min(hardCap, estimatedMax))
    }

    private isBrowserContextClosedError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error ?? '')
        return /target page, context or browser has been closed|target closed|browser\.newcontext|browser has been closed/i.test(message)
    }

    private isProxyConnectionError(error: unknown): boolean {
        const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
        return /err_proxy_connection_failed|proxy connection failed|err_tunnel_connection_failed|proxy authentication required|407|socks|proxy/i.test(message)
    }

    private async runWithTimeout<T>(
        work: () => Promise<T>,
        timeoutMs: number,
        onTimeout: () => Promise<void>
    ): Promise<T> {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        let timedOut = false

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                timedOut = true
                void onTimeout().catch(() => { })
                reject(new Error('VISIT_WATCHDOG_TIMEOUT'))
            }, timeoutMs)
        })

        try {
            return await Promise.race([work(), timeoutPromise])
        } catch (error) {
            if (timedOut) {
                throw new Error('VISIT_WATCHDOG_TIMEOUT')
            }
            throw error
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle)
            }
        }
    }

    private async stabilizeContextIfNeeded(
        page: Page,
        threadIdx: number,
        reason: string,
        actionsPerformed: VisitActionRecord[],
        actionContext: ActionContext,
        statusContext?: {
            campaignName: string
            currentRound: number
            completedVisits: number
            totalVisits: number
            failedVisits: number
        }
    ): Promise<void> {
        if (page.isClosed()) {
            return
        }

        const mapReady = await this.isMapUiReady(page).catch(() => false)
        const blockingDialog = mapReady
            ? await this.hasVisibleBlockingDialog(page).catch(() => false)
            : false
        if (mapReady && !blockingDialog) {
            return
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            const resolved = await contextualInterruptionResolver.resolve(page, {
                threadId: threadIdx,
                reason: `traffic_${reason}_${attempt}`,
                useLlmFallback: attempt === 1,
                llmTimeoutMs: 2200,
                useEscapeFallback: true,
                maxPasses: 2,
                goal: 'map_interaction',
                campaignType: 'traffic',
                campaignId: actionContext.campaignId,
                domain: actionContext.domain,
            }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))

            if (!resolved.handled) {
                break
            }

            this.threadDetails[threadIdx].currentAction = `Resolving prompt (${reason})`
            if (statusContext) {
                this.sendStatus(this.buildStatus({
                    campaignName: statusContext.campaignName,
                    currentRound: statusContext.currentRound,
                    completedVisits: statusContext.completedVisits,
                    totalVisits: statusContext.totalVisits,
                    failedVisits: statusContext.failedVisits,
                }))
            }

            this.recordAction(actionsPerformed, {
                action: 'context_recovered',
                success: true,
                source: 'runtime',
                detail: `${reason}:${resolved.via || 'unknown'}${resolved.detail ? `:${resolved.detail}` : ''}`,
                durationMs: resolved.latencyMs,
                decisionSource: resolved.decisionSource,
                ragUsed: resolved.ragUsed,
                ragHitCount: resolved.ragHitCount,
                ragEvidenceIds: resolved.ragEvidenceIds,
                decisionLatencyMs: resolved.decisionLatencyMs,
                recoverPath: resolved.via,
                threadId: threadIdx,
                timestamp: new Date().toISOString(),
            }, actionContext)

            await HumanBehavior.randomDelay(160, 360)
        }
    }

    // ============================================================
    // Start Campaign
    // ============================================================

    async startCampaign(campaignId: number): Promise<void> {
        if (this.running) {
            console.log('[TrafficBoost] Already running')
            return
        }

        const db = getDatabase()
        const campaign = db.select().from(schema.trafficCampaigns).where(eq(schema.trafficCampaigns.id, campaignId)).get()
        if (!campaign) throw new Error('Campaign not found')

        this.running = true
        let terminalMessage = 'Traffic boost stopped'

        try {
        this.shouldStop = false
        this.currentCampaignId = campaignId
        this.currentQueueDepth = 0
        this.threadUrlBroadcastAt.clear()

        // Reset browser singleton state before each campaign start.
        // This prevents reusing an old hidden(headless) browser from previous account checks.
        try {
            await browserService.closeBrowser()
        } catch (error) {
            console.log('[TrafficBoost] Browser reset warning (non-fatal):', error)
        }
        this.activeContexts.clear()
        this.threadContextIds.clear()
        windowTilingService.reset()

        this.refreshRuntimePolicy()
        this.logger.info({
            event: 'campaign_start',
            campaignId,
            policy: this.runtimePolicy,
        })
        
        // Log system resources & calculate limits
        systemResourceDetector.logCurrentStats()
        const systemRecs = systemResourceDetector.getRecommendations()
        const globalSettings = loadSettings()
        const maxGlobalBrowsers = globalSettings.maxConcurrentBrowsers ?? 3
        const safeThreadCount = Math.min(maxGlobalBrowsers, Math.max(1, Math.floor(Number(campaign.threadsCount || 1))))

        // Load proxy runtime settings from a single source of truth
        const runtimeProxySettings = this.applyRuntimeProxySettings()
        const proxyEnabled = runtimeProxySettings.proxyEnabled
        this.networkState = await networkOrchestrator.resolveEffectiveMode()
        if (proxyEnabled && runtimeProxySettings.fproxyApiKey && !fproxyService.getApiKey()) {
            fproxyService.setApiKey(runtimeProxySettings.fproxyApiKey)
            console.log('[TrafficBoost] ðŸ”‘ FProxy API key loaded from settings')
        }
        if (!proxyEnabled) {
            if (fproxyService.hasConfiguration()) {
                fproxyService.clearConfiguration('campaign_start_proxy_disabled')
            }
            console.log('[TrafficBoost] Proxy disabled in settings -> direct connection mode')
            this.networkState = {
                ...this.networkState,
                mode: 'direct',
                reason: 'campaign_start_proxy_disabled',
                checkedAt: new Date().toISOString(),
            }
        }

        // Start FProxy auto-rotate if API key is configured
        if (proxyEnabled && fproxyService.getApiKey()) {
            this.networkState = {
                ...this.networkState,
                mode: 'fproxy',
                reason: 'fproxy_enabled',
                checkedAt: new Date().toISOString(),
            }
            console.log('[TrafficBoost] ðŸ›¡ï¸ FProxy proxy enabled â€” auto-rotate every 2 min')
            // Auto-rotate every 2 minutes (120s)
            fproxyService.startAutoRotate(120_000)
            fproxyService.setOnProxyChanged((newProxy) => {
                console.log(`[TrafficBoost] ðŸ”„ Proxy IP rotated: ${newProxy.httpuserpass?.split(':')[0]} (${newProxy.location})`)
            })
        } else {
            fproxyService.stopAutoRotate()
        }
        this.networkState = await networkOrchestrator.resolveEffectiveMode()

        // Parse account and location IDs
        const accountIds: number[] = JSON.parse(campaign.accountIds || '[]')
        const locationIds: number[] = JSON.parse(campaign.locationIds || '[]')
        const enabledActions: SEOAction[] = campaign.enabledActions
            ? (() => {
                // Map old action names to new ones for backward compatibility
                const OLD_TO_NEW: Record<string, SEOAction> = {
                    'browse_map': 'map_drag_pan',
                    'view_photos': 'photos_browse',
                    'view_reviews': 'reviews_read',
                    'get_directions': 'directions_driving',
                    'view_about': 'info_view_about',
                    'share_location': 'share_link',
                    'view_nearby': 'explore_nearby',
                    'click_website': 'info_website',
                    'view_hours': 'info_view_hours',
                    'scroll_read': 'browse_scroll_deep',
                }
                const parsed: string[] = JSON.parse(campaign.enabledActions!)
                return parsed.map(a => OLD_TO_NEW[a] || a as SEOAction)
            })()
            : ALL_SEO_ACTIONS
        const campaignUseFixedActionCount = campaign.fixedActionCount === true
        const runtimeSettings = loadSettings()
        // groqApiKey can be stored in settings.json OR in the SQLite database.
        // Check both sources to avoid the "always empty" bug.
        let groqKeyFromSettings = runtimeSettings.groqApiKey || ''
        if (!groqKeyFromSettings) {
            try {
                const dbKeyRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'groqApiKey')).get()
                if (dbKeyRow && dbKeyRow.value) {
                    groqKeyFromSettings = dbKeyRow.value
                }
            } catch (_e) { /* ignore db read errors */ }
        }
        const agenticEnabledBySettings = !!groqKeyFromSettings
        const aiAutoControlEnabled = campaign.aiAutoControl === true
        const allowAgenticMapPlanner = (runtimeSettings as Record<string, unknown>).enableAgenticMaps === true
        const agenticMapPlannerReady = aiAutoControlEnabled && allowAgenticMapPlanner && agenticEnabledBySettings
        if (agenticMapPlannerReady) {
            console.log('[TrafficBoost] Agentic Maps planner enabled by campaign AI auto-control and internal setting. LLM path is active.')
        } else {
            console.log('[TrafficBoost] Deterministic Maps SEO flow active. LLM planner is disabled for Maps traffic.')
        }

        if (locationIds.length === 0) {
            throw new Error('No locations configured')
        }

        // Get accounts
        const accounts = accountIds.length > 0
            ? db.select().from(schema.accounts).all().filter(a => accountIds.includes(a.id))
            : [null] // null = anonymous browsing (no account)

        // Get locations
        const allLocations = db.select().from(schema.locations).all().filter(l => locationIds.includes(l.id))
        if (allLocations.length === 0) throw new Error('No valid locations found')

        // Calculate total visits needed
        const totalVisits = allLocations.length * campaign.visitsPerLocation
        db.update(schema.trafficCampaigns)
            .set({ status: 'running', startedAt: new Date(), totalVisits })
            .where(eq(schema.trafficCampaigns.id, campaignId))
            .run()

        // Initialize class-level tracking fields
        this.currentCampaignName = campaign.name
        this._totalVisits = totalVisits
        this._totalRounds = campaign.visitsPerLocation
        this._completedVisits = campaign.completedVisits || 0
        this._failedVisits = campaign.failedVisits || 0
        this._currentRound = campaign.currentRound || 0

        // Initialize thread details
        this.threadDetails = Array.from({ length: safeThreadCount }, (_, i) => ({
            id: i,
            accountEmail: '',
            locationName: '',
            currentAction: '',
            currentUrl: '',
            status: 'idle' as const,
            progress: 0,
        }))

        this.sendStatus(this.buildStatus({
            message: `Starting traffic boost with ${safeThreadCount} threads (Recommended max: ${systemRecs.maxSafeThreads}, Campaign config: ${campaign.threadsCount})...`,
        }))

        let completedVisits = this._completedVisits
        let failedVisits = this._failedVisits
        let currentRound = this._currentRound

        // MAIN LOOP: keep feeding all remaining visit tasks until target attempts are reached
        while (!this.shouldStop && (completedVisits + failedVisits) < totalVisits) {
                currentRound++
                this._currentRound = currentRound

                console.log(`[TrafficBoost] Round ${currentRound} starting...`)

                this.sendStatus(this.buildStatus({
                    message: `Round ${currentRound}: Preparing visits...`,
                }))

                // Build task queue: each account visits each location
                interface VisitTask {
                    account: any | null
                    location: any
                    round: number
                    requestedActions: number
                    watchdogRetryCount: number
                    proxyRetryCount: number
                    forceDirectConnection: boolean
                }
                const visitTasks: VisitTask[] = []
                const campaignRequestedActions = this.normalizeDesiredActions(campaign.actionsPerVisit)
                const existingLogs = db.select().from(schema.trafficLogs)
                    .where(eq(schema.trafficLogs.campaignId, campaignId))
                    .all()
                const visitsByLocation = new Map<number, number>()
                for (const logEntry of existingLogs) {
                    visitsByLocation.set(logEntry.locationId, (visitsByLocation.get(logEntry.locationId) || 0) + 1)
                }
                const accountPool = accounts.length > 0 ? accounts : [null]
                for (let roundCursor = 1; roundCursor <= campaign.visitsPerLocation; roundCursor++) {
                    for (let locationIdx = 0; locationIdx < allLocations.length; locationIdx++) {
                        const location = allLocations[locationIdx]
                        const existingVisitsForLocation = visitsByLocation.get(location.id) || 0
                        if (existingVisitsForLocation >= roundCursor) {
                            continue
                        }
                        const account = accountPool[(roundCursor + locationIdx - 1) % accountPool.length]
                        visitTasks.push({
                            account,
                            location,
                            round: roundCursor,
                            requestedActions: campaignRequestedActions,
                            watchdogRetryCount: 0,
                            proxyRetryCount: 0,
                            forceDirectConnection: false,
                        })
                    }
                }

                if (visitTasks.length === 0) break // All locations have enough visits
                this.currentQueueDepth = visitTasks.length

                // Keep campaign workers fully utilized: when one visit finishes, hand off immediately.
                const queueConcurrency = safeThreadCount
                const visitQueue = new PQueue({
                    concurrency: queueConcurrency,
                    carryoverConcurrencyCount: true,
                })
                const threadPromises: Promise<void>[] = []
                let taskIndex = 0

                for (let t = 0; t < safeThreadCount; t++) {
                    const threadIdx = t
                    threadPromises.push((async () => {
                        try {
                            // Stagger thread starts to prevent huge RAM spikes on low spec PCs
                            if (threadIdx > 0 && systemRecs.staggerDelayMs > 0) {
                                const delayConfig = threadIdx * systemRecs.staggerDelayMs
                                console.log(`[TrafficBoost] Staggering Thread ${threadIdx + 1} start by ${delayConfig}ms to prevent RAM spike.`)
                                await HumanBehavior.randomDelay(delayConfig, delayConfig + 500)
                            }
                            const idlePollDelayMs = 120
                            const maxIdlePollsBeforeDone = 20
                            let idlePollCount = 0
                            while (!this.shouldStop) {
                                const myIdx = taskIndex++
                                if (myIdx >= visitTasks.length) {
                                    taskIndex = visitTasks.length
                                    this.currentQueueDepth = Math.max(0, visitQueue.size + visitQueue.pending)
                                    const hasInFlight = visitQueue.size > 0 || visitQueue.pending > 0
                                    if (hasInFlight || idlePollCount < maxIdlePollsBeforeDone) {
                                        idlePollCount += 1
                                        await new Promise(resolve => setTimeout(resolve, idlePollDelayMs))
                                        continue
                                    }
                                    break
                                }
                                idlePollCount = 0

                                const task = visitTasks[myIdx]
                                if (task.round > currentRound) {
                                    currentRound = task.round
                                    this._currentRound = currentRound
                                }
                                await visitQueue.add(async () => {
                                this.currentQueueDepth = Math.max(
                                    0,
                                    (visitTasks.length - taskIndex) + visitQueue.size + visitQueue.pending
                                )
                                const accountEmail = task.account?.email || 'Anonymous'
                                const locationName = task.location.name
                                const actionContext = {
                                    campaignId,
                                    campaignName: campaign.name,
                                    round: task.round,
                                    threadId: threadIdx,
                                    accountEmail,
                                    locationName,
                                    domain: this.normalizeDomain(task.location.url),
                                    goal: campaign.trafficMode === 'web_seo' ? 'website_browse' : 'map_interaction',
                                    riskType: 'campaign_step',
                                }

                            // Update thread detail
                            this.threadDetails[threadIdx] = {
                                id: threadIdx,
                                accountEmail,
                                locationName,
                                status: 'visiting',
                                currentAction: 'Opening browser...',
                                currentUrl: '',
                                progress: 0,
                            }

                            this.sendStatus(this.buildStatus({
                                campaignName: campaign.name,
                                currentRound,
                                completedVisits,
                                totalVisits,
                                failedVisits,
                                message: `Thread ${threadIdx + 1}: Visiting ${locationName}`,
                            }))

                            // === Proxy Countdown Sync: Wait for fresh rotation before starting visit ===
                            if (proxyEnabled && fproxyService.getApiKey() && fproxyService.isAutoRotateActive() && fproxyService.hasUsableProxy()) {
                                const proxyIntervalSec = Math.round(fproxyService.getRotateIntervalMs() / 1000)
                                // Require at least 80% of the rotation interval to start a visit
                                const minTimeRequired = Math.max(30, Math.floor(proxyIntervalSec * 0.8))
                                
                                const availableMs = await fproxyService.waitForFreshRotation(
                                    minTimeRequired,
                                    () => this.shouldStop,
                                    (msg) => {
                                        this.threadDetails[threadIdx].currentAction = msg
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                            message: `Thread ${threadIdx + 1}: ${msg}`,
                                        }))
                                    }
                                )
                                
                                if (this.shouldStop || availableMs <= 0) {
                                    return // Exit this visit task
                                }
                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Proxy ready! Starting visit with ${Math.round(availableMs / 1000)}s available`)
                            } else if (proxyEnabled && fproxyService.getApiKey() && fproxyService.isAutoRotateActive()) {
                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy has no usable lease yet, skipping countdown wait and attempting direct acquisition`)
                            }
                            
                            const visitStart = Date.now()
                            const requestedActionsForVisit = this.normalizeDesiredActions(task.requestedActions)
                            const watchdogMode: 'agentic' | 'seo' = (campaign.trafficMode !== 'web_seo' && agenticMapPlannerReady)
                                ? 'agentic'
                                : 'seo'
                            // Compute base watchdog, then hard-cap to 120s when proxy rotation is active
                            const isProxyRotationActive = proxyEnabled && fproxyService.getApiKey() && fproxyService.isAutoRotateActive()
                            const computedWatchdogMs = this.computeVisitWatchdogTimeoutMs(
                                requestedActionsForVisit,
                                Number(campaign.delayMinSeconds ?? 5),
                                Number(campaign.delayMaxSeconds ?? 12),
                                watchdogMode,
                                threadIdx,
                                campaignUseFixedActionCount
                            )
                            // STRICT 2-MIN LIFECYCLE: When proxy rotation is active, cap total visit to 120s
                            // to synchronize browser lifecycle with IP rotation interval
                            const visitWatchdogTimeoutMs = isProxyRotationActive
                                ? Math.min(computedWatchdogMs, 120_000)
                                : computedWatchdogMs
                            const visitSoftDeadlineAt = visitStart + Math.max(15_000, visitWatchdogTimeoutMs - 12_000)
                            const actionsPerformed: VisitActionRecord[] = []
                            let profilePath: string | undefined
                            let contextId: number | null = null
                            let stopPageMonitor: (() => void) | null = null
                            let watchdogTriggered = false
                            let contextCleanupStarted = false
                            let visitBudgetStopLogged = false
                            let usedProxyThisVisit = false
                            const visitProxySnapshotTime = Date.now() // Timestamp for per-thread proxy rotation check

                            const shouldStopForVisitBudget = () => Date.now() >= visitSoftDeadlineAt
                            const markVisitBudgetStop = (detail: string) => {
                                if (visitBudgetStopLogged) {
                                    return
                                }
                                visitBudgetStopLogged = true
                                this.recordAction(actionsPerformed, {
                                    action: 'visit_budget_stop',
                                    success: true,
                                    source: 'runtime',
                                    detail,
                                    threadId: threadIdx,
                                    retryCategory: 'visit_watchdog',
                                    queueDepth: this.currentQueueDepth,
                                    timestamp: new Date().toISOString(),
                                }, actionContext)
                            }

                            const recycleVisitContext = async (reason: 'watchdog_timeout' | 'visit_end') => {
                                if (contextCleanupStarted) {
                                    return
                                }

                                if (contextId === null) {
                                    return
                                }
                                contextCleanupStarted = true

                                try {
                                    stopPageMonitor?.()
                                } catch {
                                    // Ignore page monitor teardown errors.
                                }

                                // CLEAN-SLATE: Skip session save — ephemeral context is in-memory only.
                                // No cookies, cache, or state is persisted between visits.
                                // This ensures Google sees a completely new user each time.
                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Clean-slate mode — session not saved (ephemeral context)`)

                                try {
                                    await browserService.closeContext(contextId)
                                } catch {
                                    // Ignore close errors during recycle.
                                }
                                this.activeContexts.delete(contextId)
                                if (this.threadContextIds.get(threadIdx) === contextId) {
                                    this.threadContextIds.delete(threadIdx)
                                }
                            }

                            try {
                                await this.runWithTimeout(async () => {
                                    // CLEAN-SLATE: Traffic visits use ephemeral (in-memory) contexts.
                                    // No persistent profile needed — zero disk I/O, zero SSD wear.
                                    // Each visit gets a brand-new browser state (cookies, localStorage, cache).
                                    profilePath = undefined

                                    // Create browser context with account's profile + proxy
                                    // Try FProxy API first, then static proxies
                                    let proxyConfig: BrowserConfig['proxy'] = undefined
                                    let proxyInfoStr = ''
                                    const runtimeProxy = this.applyRuntimeProxySettings()
                                    const useProxyThisVisit = runtimeProxy.proxyEnabled && !task.forceDirectConnection
                                    usedProxyThisVisit = useProxyThisVisit

                                if (useProxyThisVisit) {
                                    const fproxyKey = fproxyService.getApiKey()
                                    if (fproxyKey) {
                                        // Use FProxy.me API for dynamic proxy
                                        console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Using FProxy API...`)
                                        try {
                                            const fproxy = await fproxyService.getProxyForBrowser()
                                            if (fproxy) {
                                                proxyConfig = fproxy
                                                const info = fproxyService.getProxyInfo()
                                                proxyInfoStr = `${fproxy.host}:${fproxy.port}${info?.location ? ` (${info.location})` : ''}`
                                                this.networkState = {
                                                    ...this.networkState,
                                                    mode: 'fproxy',
                                                    reason: 'active_fproxy_proxy_assigned',
                                                    proxyInfo: proxyInfoStr,
                                                    useProxySetting: true,
                                                    checkedAt: new Date().toISOString(),
                                                }
                                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy: ${proxyInfoStr}, user: ${fproxy.username}`)
                                            } else {
                                                console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy returned null, direct connection`)
                                            }
                                        } catch (fErr: any) {
                                            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: FProxy error: ${fErr.message}`)
                                        }
                                    } else {
                                        // Fallback: use static proxies from DB
                                        const activeProxy = await proxyService.getRandomActive()
                                        if (activeProxy) {
                                            proxyConfig = {
                                                host: activeProxy.host,
                                                port: activeProxy.port,
                                                username: activeProxy.username || undefined,
                                                password: activeProxy.password || undefined,
                                                type: (activeProxy.type as 'http' | 'https' | 'socks5') || 'http',
                                            }
                                            proxyInfoStr = `${activeProxy.host}:${activeProxy.port}${activeProxy.country ? ` (${activeProxy.country})` : ''}`
                                            this.networkState = {
                                                ...this.networkState,
                                                mode: 'static_proxy',
                                                reason: 'active_static_proxy_assigned',
                                                proxyInfo: proxyInfoStr,
                                                useProxySetting: true,
                                                checkedAt: new Date().toISOString(),
                                            }
                                            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Static proxy: ${proxyInfoStr}`)
                                        } else {
                                            console.log(`[TrafficBoost] Thread ${threadIdx + 1}: No proxy, direct connection`)
                                            this.networkState = {
                                                ...this.networkState,
                                                mode: 'direct',
                                                reason: 'static_proxy_pool_empty',
                                                proxyInfo: undefined,
                                                useProxySetting: true,
                                                checkedAt: new Date().toISOString(),
                                            }
                                        }
                                    }
                                } else {
                                    if (task.forceDirectConnection) {
                                        console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Proxy temporarily bypassed for retry, using direct connection`)
                                    } else {
                                        console.log(`[TrafficBoost] Thread ${threadIdx + 1}: Proxy disabled in settings, using direct connection`)
                                    }
                                    this.networkState = {
                                        ...this.networkState,
                                        mode: 'direct',
                                        reason: task.forceDirectConnection ? 'proxy_failed_fallback_direct' : 'proxy_disabled_in_settings',
                                        proxyInfo: undefined,
                                        useProxySetting: task.forceDirectConnection ? true : false,
                                        checkedAt: new Date().toISOString(),
                                    }
                                }

                                // EPHEMERAL CONFIG: No profilePath → 100% in-memory browser context
                                const config: BrowserConfig = {
                                    headless: globalSettings.headless ?? false,
                                    proxy: proxyConfig,
                                }

                                // Update thread detail with proxy info
                                this.threadDetails[threadIdx] = {
                                    ...this.threadDetails[threadIdx],
                                    proxyInfo: proxyInfoStr,
                                }

                                // Use ephemeral context: in-memory, zero disk I/O, fresh fingerprint per visit
                                contextId = await pRetry(
                                    async () => {
                                        try {
                                            return await browserService.createEphemeralContext(config)
                                        } catch (error) {
                                            if (this.isBrowserContextClosedError(error)) {
                                                this.threadDetails[threadIdx].currentAction = 'Browser disconnected - recreating context'
                                            }
                                            throw error
                                        }
                                    },
                                    {
                                        retries: Math.max(0, this.runtimePolicy.networkRetryMax),
                                        factor: 1.8,
                                        minTimeout: 700,
                                        maxTimeout: 5000,
                                        randomize: true,
                                        onFailedAttempt: async (attemptError: any) => {
                                            if (!this.isBrowserContextClosedError(attemptError)) {
                                                return
                                            }

                                            const attempt = Number(attemptError?.attemptNumber || 1)
                                            const retriesLeft = Number(attemptError?.retriesLeft || 0)
                                            const maxAttempts = attempt + retriesLeft
                                            const errorMessage = attemptError?.message || 'browser context closed'

                                            this.threadDetails[threadIdx].currentAction = `Browser disconnected - relaunching (${attempt}/${maxAttempts})`
                                            this.sendStatus(this.buildStatus({
                                                campaignName: campaign.name,
                                                currentRound,
                                                completedVisits,
                                                totalVisits,
                                                failedVisits,
                                                message: `Thread ${threadIdx + 1}: Browser disconnected, recovering (${attempt}/${maxAttempts})`,
                                            }))
                                            this.recordAction(actionsPerformed, {
                                                action: 'browser_context_recreate',
                                                success: false,
                                                source: 'runtime',
                                                detail: `createContext retry ${attempt}/${maxAttempts}: ${errorMessage}`,
                                                threadId: threadIdx,
                                                attempt,
                                                retryCategory: 'browser_recover',
                                                queueDepth: this.currentQueueDepth,
                                                timestamp: new Date().toISOString(),
                                            }, actionContext)

                                            await browserService.closeBrowser().catch(() => { })
                                            await HumanBehavior.randomDelay(180, 420)
                                        },
                                    }
                                )
                                this.activeContexts.set(contextId, profilePath || '')
                                this.threadContextIds.set(threadIdx, contextId)

                                // Apply centralized stealth (already done via BrowserService for ephemeral, here for any direct persistent paths)
                                // Traffic visits primarily use createEphemeralContext which now goes through StealthPatcher
                                try {
                                    const ctx = browserService.getContext(contextId)
                                    if (ctx) {
                                        await applyStealth(ctx, { level: DEFAULT_STEALTH_LEVEL }).catch(() => {})
                                    }
                                } catch {}
                                if (watchdogTriggered) {
                                    throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                }

                                try {
                                    const page = browserService.getPage(contextId!)
                                    if (!page) throw new Error('Could not get page')
                                    if (watchdogTriggered) {
                                        throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                    }
                                    stopPageMonitor = this.startThreadPageMonitor(threadIdx, page)
                                    await this.cleanupExtraTabsForThread(page, threadIdx, 'visit_start')

                                    // Apply window tiling based on active thread count
                                    try {
                                        const slotTargets: Array<{
                                            slot: number
                                            contextId: number
                                            context: { pages: () => any[] }
                                        }> = []
                                        for (const [slot, ctxId] of Array.from(this.threadContextIds.entries()).sort((a, b) => a[0] - b[0])) {
                                            const ctx = browserService.getContext(ctxId)
                                            if (ctx) {
                                                slotTargets.push({
                                                    slot,
                                                    contextId: ctxId,
                                                    context: ctx,
                                                })
                                            }
                                        }
                                        if (slotTargets.length > 0) {
                                            await windowTilingService.applyBySlots(slotTargets, safeThreadCount)
                                        }
                                    } catch (tilingErr) {
                                        console.log(`[TrafficBoost] Tiling error (non-fatal):`, tilingErr)
                                    }

                                    // Navigate to location - branch by traffic mode
                                    if (campaign.trafficMode === 'organic' || campaign.trafficMode === 'web_seo' || campaign.trafficMode === 'map_search') {
                                        // ORGANIC / MAP_SEARCH / WEB_SEO MODE (keyword per-location round-robin)
                                        let searchKeywords: string[] = [task.location.name]
                                        if ((task.location as any).searchKeywords) {
                                            try {
                                                const parsed = JSON.parse((task.location as any).searchKeywords)
                                                if (Array.isArray(parsed) && parsed.length > 0) {
                                                    searchKeywords = parsed
                                                }
                                            } catch {
                                                // If not JSON, try comma-separated
                                                searchKeywords = (task.location as any).searchKeywords
                                                    .split(',').map((k: string) => k.trim()).filter(Boolean)
                                                if (searchKeywords.length === 0) searchKeywords = [task.location.name]
                                            }
                                        }
                                        // Round-robin keyword selection: cycle through all keywords evenly
                                        const locationKey = `loc_${task.location.id}`
                                        if (!(locationKey in this._keywordCounters)) this._keywordCounters[locationKey] = 0
                                        const keywordIdx = this._keywordCounters[locationKey] % searchKeywords.length
                                        this._keywordCounters[locationKey]++
                                        const keyword = searchKeywords[keywordIdx]
                                        const avoidGoogleSearchForThread = this.shouldAvoidGoogleSearch(threadIdx)

                                        this.threadDetails[threadIdx].currentKeyword = keyword
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                            message: avoidGoogleSearchForThread
                                                ? `Thread ${threadIdx + 1}: CAPTCHA cooldown active, skipping Google search for this visit`
                                                : `Thread ${threadIdx + 1}: ${campaign.trafficMode === 'organic' ? 'Organic' : campaign.trafficMode === 'map_search' ? 'SEO Map' : 'Web SEO'} search "${keyword}"`,
                                        }))
                                        if (avoidGoogleSearchForThread) {
                                            this.recordAction(actionsPerformed, {
                                                action: 'captcha_cooldown_skip_search',
                                                success: true,
                                                source: 'safety',
                                                detail: `Skipped Google search due to repeated CAPTCHA on thread ${threadIdx + 1}`,
                                                threadId: threadIdx,
                                                timestamp: new Date().toISOString(),
                                            }, actionContext)
                                        }

                                        if (avoidGoogleSearchForThread && campaign.trafficMode === 'organic') {
                                            this.threadDetails[threadIdx].currentAction = 'Captcha cooldown: direct map navigation'
                                            await page.goto(task.location.url, {
                                                waitUntil: 'commit',
                                                timeout: 20000,
                                            })
                                            await HumanBehavior.randomDelay(1200, 2600)
                                        } else if (avoidGoogleSearchForThread && campaign.trafficMode === 'map_search') {
                                            // map_search cooldown: direct map URL (per spec, avoid Google search UI)
                                            this.threadDetails[threadIdx].currentAction = 'Captcha cooldown: direct map navigation (map_search)'
                                            await page.goto(task.location.url, {
                                                waitUntil: 'commit',
                                                timeout: 20000,
                                            })
                                            await HumanBehavior.randomDelay(1200, 2600)
                                        } else if (avoidGoogleSearchForThread && campaign.trafficMode === 'web_seo') {
                                            this.threadDetails[threadIdx].currentAction = 'Captcha cooldown: direct website browsing'
                                            let targetDomain = task.location.url
                                            try {
                                                targetDomain = new URL(task.location.url).hostname.replace('www.', '')
                                            } catch { /* use raw url */ }

                                            await page.goto(task.location.url, {
                                                waitUntil: 'domcontentloaded',
                                                timeout: 20000
                                            })
                                            await HumanBehavior.randomDelay(2000, 4200)
                                            const cooldownFlow = new WebSeoFlow((status) => {
                                                this.threadDetails[threadIdx].currentAction = status.message || status.action
                                            })
                                            try {
                                                await (cooldownFlow as any).browseWebsiteLikeRealUser(page, {
                                                    keyword,
                                                    targetDomain,
                                                    minTimeOnPageSeconds: campaign.delayMinSeconds,
                                                    maxTimeOnPageSeconds: campaign.delayMaxSeconds,
                                                })
                                            } catch { /* ignore */ }
                                            await this.cleanupExtraTabsForThread(page, threadIdx, 'after_web_seo_captcha_cooldown_browse')
                                        } else if (campaign.trafficMode === 'organic') {
                                            const searchHandler = new AgenticSearchHandler((status) => {
                                                this.threadDetails[threadIdx].currentAction = status
                                                this.sendStatus(this.buildStatus({
                                                    campaignName: campaign.name,
                                                    currentRound,
                                                    completedVisits,
                                                    totalVisits,
                                                    failedVisits,
                                                }))
                                            })

                                            const searchResult = await searchHandler.executeSearch(page, keyword, {
                                                name: task.location.name,
                                                address: task.location.address,
                                                placeId: task.location.placeId,
                                                url: task.location.url,
                                                                                                                                            }, threadIdx)

                                            // Log agentic search actions
                                            for (const a of searchResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `organic_discovery:${a.action}`,
                                                    success: a.success,
                                                    source: a.source || 'llm',
                                                    detail: a.detail || `Agentic Discovery: ${a.action}`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }

                                            if (!searchResult.foundMap) {
                                                // Fallback to direct mode if map not found
                                                this.threadDetails[threadIdx].currentAction = 'Fallback: Direct navigation'
                                                console.log(`[TrafficBoost] Agentic organic search failed for "${task.location.name}", falling back to direct URL`)
                                                await page.goto(task.location.url, {
                                                    waitUntil: 'commit',
                                                    timeout: 20000
                                                })
                                                await HumanBehavior.randomDelay(1000, 3000)
                                            }
                                            // After organic discovery flow, we're on the map page -> continue to SEO actions below
                                        } else if (campaign.trafficMode === 'map_search') {
                                            // MAP_SEARCH MODE: open maps.google.com/maps, type keyword (round-robin), scroll feed max 15 cards, match by name/placeId, click to detail.
                                            // On not found within limit -> fallback to direct URL. Then common path runs autonomous KPI agent (since !== 'web_seo').
                                            const mapSearchFlow = new MapSearchFlow((status: string) => {
                                                this.threadDetails[threadIdx].currentAction = status
                                                this.sendStatus(this.buildStatus({
                                                    campaignName: campaign.name,
                                                    currentRound,
                                                    completedVisits,
                                                    totalVisits,
                                                    failedVisits,
                                                }))
                                            })

                                            const mapSearchResult = await mapSearchFlow.execute(page, keyword, {
                                                name: task.location.name,
                                                address: task.location.address,
                                                placeId: task.location.placeId,
                                                url: task.location.url,
                                            }, !!task.account, (campaign.maxMapScroll ?? undefined))

                                            // Log discovery actions with prefix
                                            for (const a of mapSearchResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `map_search_discovery:${a.action}`,
                                                    success: a.success,
                                                    source: 'map_search',
                                                    detail: `Map search discovery: ${a.action}`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }

                                            if (!mapSearchResult.foundMap) {
                                                this.threadDetails[threadIdx].currentAction = 'Fallback: Direct navigation (map_search)'
                                                console.log(`[TrafficBoost] MapSearchFlow did not find "${task.location.name}" within limit for "${keyword}", falling back to direct URL`)
                                                await page.goto(task.location.url, {
                                                    waitUntil: 'commit',
                                                    timeout: 20000
                                                })
                                                await HumanBehavior.randomDelay(1000, 3000)
                                            }
                                            // On success or fallback we are on map page -> fall through to common consent/login/stabilize + autonomous KPI
                                        } else {
                                            // WEB SEO MODE
                                            let targetDomain = task.location.url
                                            try {
                                                targetDomain = new URL(task.location.url).hostname.replace('www.', '')
                                            } catch { /* use as-is if invalid URL */ }

                                            const webSeoFlow = new WebSeoFlow((status) => {
                                                this.threadDetails[threadIdx].currentAction = status.message || status.action
                                                this.sendStatus(this.buildStatus({
                                                    campaignName: campaign.name,
                                                    currentRound,
                                                    completedVisits,
                                                    totalVisits,
                                                    failedVisits,
                                                }))
                                            })

                                            const webSeoResult = await webSeoFlow.execute(page, {
                                                keyword,
                                                targetDomain,
                                                minTimeOnPageSeconds: campaign.delayMinSeconds,
                                                maxTimeOnPageSeconds: campaign.delayMaxSeconds,
                                                captchaStrategy: 'auto_skip',
                                            })
                                            await this.cleanupExtraTabsForThread(page, threadIdx, 'after_web_seo_flow')

                                            // Log web_seo actions
                                            for (const a of webSeoResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `web_seo:${a.action}`,
                                                    success: a.success,
                                                    source: 'web_seo',
                                                    detail: `Web SEO flow: ${a.action}`,
                                                    threadId: threadIdx,
                                                    timestamp: new Date().toISOString(),
                                                }, actionContext)
                                            }

                                            if (!webSeoResult.foundWebsite) {
                                                this.threadDetails[threadIdx].currentAction = 'Fallback: Direct navigation â†’ browsing website'
                                                console.log(`[TrafficBoost] Web SEO failed to find "${targetDomain}" for "${keyword}", falling back to direct URL + browsing`)
                                                await page.goto(task.location.url, {
                                                    waitUntil: 'domcontentloaded',
                                                    timeout: 20000
                                                })
                                                await HumanBehavior.randomDelay(2000, 4000)
                                                // Even on fallback, still browse the website like a real user
                                                const fallbackFlow = new WebSeoFlow((status) => {
                                                    this.threadDetails[threadIdx].currentAction = status.message || status.action
                                                })
                                                // Use the browseWebsiteLikeRealUser indirectly via a mini execute
                                                // Just perform browsing actions on current page
                                                try {
                                                    await (fallbackFlow as any).browseWebsiteLikeRealUser(page, {
                                                        keyword,
                                                        targetDomain,
                                                        minTimeOnPageSeconds: campaign.delayMinSeconds,
                                                        maxTimeOnPageSeconds: campaign.delayMaxSeconds,
                                                    })
                                                } catch { /* ignore browsing errors on fallback */ }
                                                await this.cleanupExtraTabsForThread(page, threadIdx, 'after_web_seo_fallback_browse')
                                            }
                                        }

                                    } else {
                                        // DIRECT MODE: Navigate straight to URL (original behavior)
                                        this.threadDetails[threadIdx].currentAction = 'Loading map...'
                                        this.sendStatus(this.buildStatus({
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }))

                                        await page.goto(task.location.url, {
                                            waitUntil: 'commit',
                                            timeout: 20000
                                        })
                                        await HumanBehavior.randomDelay(1000, 3000)
                                        await this.ensureDirectModeMapReady(
                                            page,
                                            threadIdx,
                                            task.location,
                                            {
                                                campaignName: campaign.name,
                                                currentRound,
                                                completedVisits,
                                                totalVisits,
                                                failedVisits,
                                            },
                                            actionsPerformed,
                                            actionContext,
                                            !!task.account
                                        )
                                    }
                                    await this.cleanupExtraTabsForThread(page, threadIdx, 'after_navigation')
                                    await this.handleGoogleLoginIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    await this.stabilizeContextIfNeeded(
                                        page,
                                        threadIdx,
                                        'after_navigation',
                                        actionsPerformed,
                                        actionContext,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }
                                    )

                                    // Accept cookies/consent if present (both modes)
                                    try {
                                        const consentBtn = await page.$('button:has-text("Accept all"), button:has-text("Äá»“ng Ã½"), button:has-text("Accept"), form[action*="consent"] button')
                                        if (consentBtn) {
                                            await consentBtn.click()
                                            await HumanBehavior.randomDelay(1000, 2000)
                                        }
                                    } catch { /* ignore */ }
                                    await this.handleGoogleLoginIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    await this.stabilizeContextIfNeeded(
                                        page,
                                        threadIdx,
                                        'after_consent',
                                        actionsPerformed,
                                        actionContext,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }
                                    )

                                    await this.handleCaptchaIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )
                                    await this.stabilizeContextIfNeeded(
                                        page,
                                        threadIdx,
                                        'post_captcha',
                                        actionsPerformed,
                                        actionContext,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        }
                                    )
                                    await this.handleGoogleLoginIfNeeded(
                                        page,
                                        threadIdx,
                                        {
                                            campaignName: campaign.name,
                                            currentRound,
                                            completedVisits,
                                            totalVisits,
                                            failedVisits,
                                        },
                                        actionsPerformed,
                                        actionContext,
                                        task.location.url
                                    )

                                    if (campaign.trafficMode !== 'web_seo') {
                                        await this.handleGoogleLoginIfNeeded(
                                            page,
                                            threadIdx,
                                            {
                                                campaignName: campaign.name,
                                                currentRound,
                                                completedVisits,
                                                totalVisits,
                                                failedVisits,
                                            },
                                            actionsPerformed,
                                            actionContext,
                                            task.location.url
                                        )
                                        // === AUTONOMOUS AI AGENT ===
                                        // Unified autonomous session: AI detects business type,
                                        // selects optimal KPI strategy, and executes full engagement.
                                        let autonomousResult;
                                        if (watchdogMode === 'agentic') {
                                            const agenticResult = await agenticTrafficHandler.performBrowsing(
                                                page,
                                                task.location.name,
                                                campaignUseFixedActionCount ? Number(campaign.actionsPerVisit ?? 5) : 10,
                                                threadIdx,
                                                (msg: string) => {
                                                    this.threadDetails[threadIdx].currentAction = msg
                                                    this.sendStatus(this.buildStatus({
                                                        campaignName: campaign.name,
                                                        currentRound,
                                                        completedVisits,
                                                        totalVisits,
                                                        failedVisits,
                                                        message: `Thread ${threadIdx + 1}: [AI] ${msg}`,
                                                    }))
                                                },
                                                () => this.shouldStop
                                                    || shouldStopForVisitBudget()
                                                    || (proxyEnabled && !!fproxyService.getApiKey()
                                                        && fproxyService.hasProxyRotatedSince(visitProxySnapshotTime)
                                                        && (Date.now() - visitStart) < (visitWatchdogTimeoutMs * 0.5)),
                                                'all',
                                                [Number(campaign.delayMinSeconds ?? 3), Number(campaign.delayMaxSeconds ?? 15)]
                                            );
                                            
                                            // Map agentic actions to expected SessionAction format
                                            autonomousResult = {
                                                actionsPerformed: agenticResult.actionsPerformed.map(a => ({
                                                    action: a.action,
                                                    success: a.success,
                                                    source: 'agentic' as const,
                                                    detail: a.detail,
                                                    durationMs: a.durationMs,
                                                    timestamp: new Date().toISOString()
                                                })),
                                                kpisExecuted: [],
                                                totalDurationMs: Date.now() - visitStart,
                                                businessType: 'generic' as const,
                                                strategyUsed: 'Agentic LLM'
                                            }
                                        } else {
                                            autonomousResult = await autonomousMapAgent.execute({
                                                page,
                                                locationName: task.location.name,
                                                locationUrl: task.location.url,
                                                threadId: threadIdx,
                                                onStatusUpdate: (msg: string) => {
                                                    this.threadDetails[threadIdx].currentAction = msg
                                                    this.sendStatus(this.buildStatus({
                                                        campaignName: campaign.name,
                                                        currentRound,
                                                        completedVisits,
                                                        totalVisits,
                                                        failedVisits,
                                                        message: `Thread ${threadIdx + 1}: ${msg}`,
                                                    }))
                                                },
                                                shouldStop: () => this.shouldStop
                                                    || shouldStopForVisitBudget()
                                                    || (proxyEnabled && !!fproxyService.getApiKey()
                                                        && fproxyService.hasProxyRotatedSince(visitProxySnapshotTime)
                                                        && (Date.now() - visitStart) < (visitWatchdogTimeoutMs * 0.5)),
                                            })
                                        }

                                        // Record autonomous session results
                                        if (autonomousResult && autonomousResult.actionsPerformed.length > 0) {
                                            for (const sessionAction of autonomousResult.actionsPerformed) {
                                                this.recordAction(actionsPerformed, {
                                                    action: `autonomous:${sessionAction.action}`,
                                                    success: sessionAction.success,
                                                    source: sessionAction.source === 'kpi_skill' ? 'kpi_skill' : 'runtime',
                                                    detail: sessionAction.detail || sessionAction.action,
                                                    durationMs: sessionAction.durationMs,
                                                    threadId: threadIdx,
                                                    timestamp: sessionAction.timestamp,
                                                }, actionContext)
                                            }
                                        }

                                        // Log strategy used for diagnostics
                                        this.recordAction(actionsPerformed, {
                                            action: 'autonomous_session_completed',
                                            success: true,
                                            source: 'runtime',
                                            detail: `Strategy: ${autonomousResult.strategyUsed}, Duration: ${Math.round(autonomousResult.totalDurationMs / 1000)}s, KPIs: ${autonomousResult.kpisExecuted.filter(k => k.executed).length}/${autonomousResult.kpisExecuted.length}`,
                                            threadId: threadIdx,
                                            timestamp: new Date().toISOString(),
                                        }, actionContext)
                                        }
                                    await this.cleanupExtraTabsForThread(page, threadIdx, 'visit_before_log')
                                    if (watchdogTriggered) {
                                        throw new Error('VISIT_ABORTED_BY_WATCHDOG')
                                    }

                                    // Log success with visit quality scoring
                                    const duration = Math.round((Date.now() - visitStart) / 1000)
                                    const successfulSeoActions = actionsPerformed.filter(a => a.success && !a.action.startsWith('context_') && !a.action.startsWith('visit_') && !a.action.startsWith('captcha_') && !a.action.startsWith('browser_') && !a.action.startsWith('google_login') && !a.action.startsWith('proxy_') && !a.action.startsWith('action_count')).length
                                    // Quality score: 0-100 based on duration and actions completed
                                    // Google typically counts visits with >10s duration and meaningful interaction
                                    const durationScore = Math.min(50, Math.floor((duration / 120) * 50)) // max 50 points for 2+ min
                                    const actionScore = Math.min(50, successfulSeoActions * 12) // max 50 points for 4+ actions
                                    const visitQualityScore = durationScore + actionScore

                                    db.insert(schema.trafficLogs).values({
                                        campaignId,
                                        accountId: task.account?.id || null,
                                        locationId: task.location.id,
                                        actions: JSON.stringify([
                                            ...actionsPerformed,
                                            {
                                                action: 'visit_quality_assessment',
                                                success: visitQualityScore >= 40,
                                                source: 'runtime',
                                                detail: `Quality=${visitQualityScore}/100 (duration=${duration}s→${durationScore}pts, actions=${successfulSeoActions}→${actionScore}pts)${visitQualityScore < 40 ? ' ⚠️ LOW QUALITY - Google may not count this visit' : ' ✅ Good quality'}`,
                                                threadId: threadIdx,
                                                timestamp: new Date().toISOString(),
                                            }
                                        ]),
                                        duration,
                                        round: task.round,
                                        status: 'success',
                                        createdAt: new Date(),
                                    }).run()

                                    completedVisits++
                                    this._completedVisits = completedVisits

                                } finally {
                                    await recycleVisitContext(watchdogTriggered ? 'watchdog_timeout' : 'visit_end')
                                }

                                }, visitWatchdogTimeoutMs * 1.2, async () => {
                                    watchdogTriggered = true
                                    await recycleVisitContext('watchdog_timeout')
                                })

                            } catch (error: any) {
                                const errMsg = error.message || String(error)
                                const errStack = error.stack || ''
                                console.error(`[TrafficBoost] Visit failed:`, errMsg)
                                console.error(`[TrafficBoost] Stack:`, errStack)

                                // Write error to debug log file
                                try {
                                    const { appendFileSync } = require('fs')
                                    const { join } = require('path')
                                    const { app } = require('electron')
                                    const logPath = join(app.getPath('userData'), 'proxy-debug.log')
                                    appendFileSync(logPath, `[${new Date().toISOString()}] VISIT ERROR: ${errMsg}\n${errStack}\n\n`)
                                } catch { /* ignore */ }

                                const failureClassification = classifyTrafficFailure(error)
                                this.recordAction(actionsPerformed, {
                                    action: 'visit_failure_classified',
                                    success: false,
                                    source: 'runtime',
                                    detail: `${failureClassification.message} (${failureClassification.code})`,
                                    thought: failureClassification.evidence.join(', '),
                                    error: errMsg,
                                    threadId: threadIdx,
                                    retryCategory: failureClassification.bucket,
                                    recoverPath: failureClassification.code,
                                    queueDepth: this.currentQueueDepth,
                                    timestamp: new Date().toISOString(),
                                }, actionContext)

                                const isWatchdogFailure = failureClassification.bucket === 'watchdog_timeout'
                                const isProxyFailure = failureClassification.bucket === 'proxy_error'
                                const canRetryWithoutProxy = isProxyFailure
                                    && usedProxyThisVisit
                                    && !task.forceDirectConnection
                                    && (task.proxyRetryCount ?? 0) < 1
                                    && !this.shouldStop
                                const canRetryWatchdog = isWatchdogFailure
                                    && (task.watchdogRetryCount ?? 0) < 1
                                    && !this.shouldStop

                                if (canRetryWithoutProxy) {
                                    visitTasks.push({
                                        ...task,
                                        forceDirectConnection: true,
                                        proxyRetryCount: (task.proxyRetryCount ?? 0) + 1,
                                    })
                                    this.recordAction(actionsPerformed, {
                                        action: 'proxy_error_retry_direct_requeued',
                                        success: true,
                                        source: 'runtime',
                                        detail: `Proxy connection failed (${errMsg}). Requeued visit with direct connection fallback`,
                                        threadId: threadIdx,
                                        retryCategory: 'network',
                                        queueDepth: this.currentQueueDepth,
                                        timestamp: new Date().toISOString(),
                                    }, actionContext)
                                } else if (canRetryWatchdog) {
                                    const requeueActions = campaignUseFixedActionCount
                                        ? this.normalizeDesiredActions(task.requestedActions)
                                        : Math.max(1, Math.floor(this.normalizeDesiredActions(task.requestedActions) * 0.65))
                                    visitTasks.push({
                                        ...task,
                                        requestedActions: requeueActions,
                                        watchdogRetryCount: (task.watchdogRetryCount ?? 0) + 1,
                                    })
                                    this.recordAction(actionsPerformed, {
                                        action: 'visit_watchdog_retry_requeued',
                                        success: true,
                                        source: 'runtime',
                                        detail: campaignUseFixedActionCount
                                            ? `Requeued fixed-count visit after watchdog timeout (actions=${requeueActions})`
                                            : `Requeued visit after watchdog timeout with reduced actions=${requeueActions}`,
                                        threadId: threadIdx,
                                        retryCategory: 'visit_watchdog',
                                        queueDepth: this.currentQueueDepth,
                                        timestamp: new Date().toISOString(),
                                    }, actionContext)
                                } else {
                                    const duration = Math.round((Date.now() - visitStart) / 1000)

                                    db.insert(schema.trafficLogs).values({
                                        campaignId,
                                        accountId: task.account?.id || null,
                                        locationId: task.location.id,
                                        actions: JSON.stringify(actionsPerformed),
                                        duration,
                                        round: task.round,
                                        status: 'failed',
                                        errorMessage: errMsg,
                                        createdAt: new Date(),
                                    }).run()

                                    failedVisits++
                                    this._failedVisits = failedVisits
                                }
                            }

                            // Update campaign progress
                            db.update(schema.trafficCampaigns)
                                .set({ completedVisits, failedVisits, currentRound })
                                .where(eq(schema.trafficCampaigns.id, campaignId))
                                .run()

                            // Thread idle -> waiting
                            this.threadDetails[threadIdx] = {
                                id: threadIdx,
                                accountEmail: '',
                                locationName: '',
                                currentAction: '',
                                currentUrl: '',
                                status: 'waiting',
                                progress: 0,
                            }

                            if (!this.shouldStop) {
                                this.sendStatus(this.buildStatus({
                                    campaignName: campaign.name,
                                    currentRound,
                                    completedVisits,
                                    totalVisits,
                                    failedVisits,
                                    message: `Thread ${threadIdx + 1}: Visit finished, starting next task immediately`,
                                }))
                            }
                                }).catch((queueError) => {
                                    console.error(`[TrafficBoost] Thread ${threadIdx + 1}: queue task crashed`, queueError)
                                })
                            }
                        } catch (threadError) {
                            console.error(`[TrafficBoost] Thread ${threadIdx + 1}: thread loop crashed`, threadError)
                        } finally {
                            // Thread done
                            this.threadDetails[threadIdx] = { id: threadIdx, accountEmail: '', locationName: '', currentAction: '', currentUrl: '', status: 'done', progress: 100 }
                        }
                    })())
                }

                // Wait for all threads to finish this round
                const threadResults = await Promise.allSettled(threadPromises)
                threadResults.forEach((result, idx) => {
                    if (result.status === 'rejected') {
                        console.error(`[TrafficBoost] Thread ${idx + 1} rejected`, result.reason)
                    }
                })
                this.currentQueueDepth = 0

                if (this.shouldStop) break
            }

        // Campaign complete or stopped
        const finalStatus = (completedVisits + failedVisits) >= totalVisits ? 'completed' : 'stopped'
        db.update(schema.trafficCampaigns)
            .set({
                status: finalStatus,
                completedVisits,
                failedVisits,
                currentRound,
                completedAt: finalStatus === 'completed' ? new Date() : null,
            })
            .where(eq(schema.trafficCampaigns.id, campaignId))
            .run()

        this.sendStatus(this.buildStatus({
            campaignName: campaign.name,
            completedVisits,
            totalVisits,
            failedVisits,
            message: finalStatus === 'completed' ? '✅ Traffic boost completed!' : '⏸ Traffic boost stopped',
        }))
        terminalMessage = finalStatus === 'completed'
            ? 'Traffic boost completed'
            : 'Traffic boost stopped'
        } catch (error: any) {
            console.error('[TrafficBoost] Campaign error:', error)
            db.update(schema.trafficCampaigns)
                .set({ status: 'stopped' })
                .where(eq(schema.trafficCampaigns.id, campaignId))
                .run()

            this.sendStatus(this.buildStatus({
                message: `❌ Error: ${error.message}`,
            }))
            terminalMessage = `Error: ${error.message}`
        } finally {
            this.running = false
            try {
                this.sendStatus(this.buildStatus({
                    isRunning: false,
                    message: terminalMessage,
                }))
            } catch (statusError) {
                console.error('[TrafficBoost] Failed to broadcast terminal status:', statusError)
            }
            this.currentCampaignId = null

            // Stop FProxy auto-rotate
            fproxyService.stopAutoRotate()

            // Clean up contexts (save state before closing)
            for (const entry of Array.from(this.activeContexts.entries())) {
                const [contextId, profilePath] = entry
                try {
                    if (profilePath) {
                        await browserService.saveContextState(contextId, profilePath)
                    }
                    await browserService.closeContext(contextId)
                    // Give V8 time to GC
                    await HumanBehavior.randomDelay(500, 1000)
                } catch { }
            }
            this.activeContexts.clear()
            this.threadContextIds.clear()
            this.threadDetails = []
            this.currentQueueDepth = 0
            this.threadUrlBroadcastAt.clear()

            // Close shared proxy browser
            await browserService.closeBrowser()
        }
    }

    // ============================================================
    // Stop / Pause
    // ============================================================

    async stopCampaign(): Promise<void> {
        this.shouldStop = true
        this.running = false
        if (this.currentCampaignId) {
            const db = getDatabase()
            db.update(schema.trafficCampaigns)
                .set({ status: 'stopped' })
                .where(eq(schema.trafficCampaigns.id, this.currentCampaignId))
                .run()
        }
        // Immediately close all active browser contexts
        for (const contextId of Array.from(this.activeContexts.keys())) {
            browserService.closeContext(contextId).catch(err => console.error('[TrafficBoost] Error closing context on stop:', err))
        }
        this.activeContexts.clear()
        this.threadContextIds.clear()
        this.threadDetails = []
        this.currentQueueDepth = 0
        // Broadcast stopped status to UI
        this.sendStatus(this.buildStatus({
            isRunning: false,
            message: '⏹ Campaign stopped',
        }))
    }

    async pauseCampaign(): Promise<void> {
        this.shouldStop = true
        this.running = false
        if (this.currentCampaignId) {
            const db = getDatabase()
            db.update(schema.trafficCampaigns)
                .set({ status: 'paused' })
                .where(eq(schema.trafficCampaigns.id, this.currentCampaignId))
                .run()
        }
        // Immediately close all active browser contexts
        for (const contextId of Array.from(this.activeContexts.keys())) {
            browserService.closeContext(contextId).catch(err => console.error('[TrafficBoost] Error closing context on pause:', err))
        }
        this.activeContexts.clear()
        this.threadContextIds.clear()
        this.threadDetails = []
        this.currentQueueDepth = 0
        // Broadcast paused status to UI
        this.sendStatus(this.buildStatus({
            isRunning: false,
            message: '⏸ Campaign paused',
        }))
    }

    // ============================================================
    // Status & Report
    // ============================================================

    isRunning(): boolean { return this.running }

    getStatus(): TrafficBoostStatus {
        return this.buildStatus()
    }

    getReport(campaignId: number): TrafficReport {
        const db = getDatabase()
        const campaign = db.select().from(schema.trafficCampaigns).where(eq(schema.trafficCampaigns.id, campaignId)).get()
        if (!campaign) throw new Error('Campaign not found')

        const logs = db.select().from(schema.trafficLogs)
            .where(eq(schema.trafficLogs.campaignId, campaignId))
            .all()

        // Aggregate by location
        const locationMap = new Map<number, { name: string; visits: number; totalDuration: number }>()
        const locationIds: number[] = JSON.parse(campaign.locationIds || '[]')
        const allLocations = db.select().from(schema.locations).all().filter(l => locationIds.includes(l.id))
        for (const loc of allLocations) {
            locationMap.set(loc.id, { name: loc.name, visits: 0, totalDuration: 0 })
        }

        // Aggregate by account
        const accountMap = new Map<number, { email: string; visits: number }>()
        const accountIds: number[] = JSON.parse(campaign.accountIds || '[]')
        if (accountIds.length > 0) {
            const allAccounts = db.select().from(schema.accounts).all().filter(a => accountIds.includes(a.id))
            for (const acc of allAccounts) {
                accountMap.set(acc.id, { email: acc.email, visits: 0 })
            }
        }

        const actionCounts = new Map<string, number>()
        let totalDuration = 0

        const normalizeActions = (rawActions: string, fallbackTimestamp: unknown): VisitActionRecord[] => {
            let parsed: unknown
            try {
                parsed = JSON.parse(rawActions || '[]')
            } catch {
                return []
            }

            if (!Array.isArray(parsed)) {
                return []
            }

            const fallbackDate = new Date(fallbackTimestamp as any)
            const fallbackIso = Number.isNaN(fallbackDate.getTime())
                ? new Date().toISOString()
                : fallbackDate.toISOString()

            return parsed.map((item, index) => {
                if (typeof item === 'string') {
                    return {
                        action: item,
                        success: true,
                        source: 'legacy',
                        detail: item.replace(/_/g, ' '),
                        timestamp: fallbackIso,
                    }
                }

                if (!item || typeof item !== 'object') {
                    return {
                        action: `step_${index + 1}`,
                        success: true,
                        source: 'legacy',
                        timestamp: fallbackIso,
                    }
                }

                const record = item as Record<string, unknown>
                const action = typeof record.action === 'string'
                    ? record.action
                    : `step_${index + 1}`

                return {
                    action,
                    success: record.success !== false,
                    source: typeof record.source === 'string' ? record.source : undefined,
                    detail: typeof record.detail === 'string' ? record.detail : undefined,
                    thought: typeof record.thought === 'string' ? record.thought : undefined,
                    error: typeof record.error === 'string' ? record.error : undefined,
                    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
                    threadId: typeof record.threadId === 'number' ? record.threadId : undefined,
                    step: typeof record.step === 'number' ? record.step : undefined,
                    elementId: typeof record.elementId === 'number' ? record.elementId : undefined,
                    attempt: typeof record.attempt === 'number' ? record.attempt : undefined,
                    retryCategory: typeof record.retryCategory === 'string' ? record.retryCategory : undefined,
                    queueDepth: typeof record.queueDepth === 'number' ? record.queueDepth : undefined,
                    latencyMs: typeof record.latencyMs === 'number' ? record.latencyMs : undefined,
                    recoverPath: typeof record.recoverPath === 'string' ? record.recoverPath : undefined,
                    decisionSource: typeof record.decisionSource === 'string' ? record.decisionSource as VisitActionRecord['decisionSource'] : undefined,
                    ragUsed: record.ragUsed === true,
                    ragHitCount: typeof record.ragHitCount === 'number' ? record.ragHitCount : undefined,
                    ragEvidenceIds: Array.isArray(record.ragEvidenceIds)
                        ? record.ragEvidenceIds.filter((id): id is number => typeof id === 'number')
                        : undefined,
                    decisionLatencyMs: typeof record.decisionLatencyMs === 'number' ? record.decisionLatencyMs : undefined,
                    timestamp: typeof record.timestamp === 'string' ? record.timestamp : fallbackIso,
                }
            })
        }

        const normalizedLogs = logs.map(log => {
            // Location stats
            const locData = locationMap.get(log.locationId)
            if (locData && log.status === 'success') {
                locData.visits++
                locData.totalDuration += log.duration || 0
            }

            // Account stats
            if (log.accountId) {
                const accData = accountMap.get(log.accountId)
                if (accData && log.status === 'success') {
                    accData.visits++
                }
            }

            const actions = normalizeActions(log.actions || '[]', log.createdAt)
            for (const action of actions) {
                actionCounts.set(action.action, (actionCounts.get(action.action) || 0) + 1)
            }

            totalDuration += log.duration || 0

            const accountEmail = log.accountId
                ? (accountMap.get(log.accountId)?.email || `Account #${log.accountId}`)
                : 'Anonymous'
            const locationName = locationMap.get(log.locationId)?.name || `Location #${log.locationId}`
            const successfulActionCount = actions.filter(action => action.success).length

            return {
                id: log.id,
                status: log.status,
                round: log.round,
                duration: log.duration || 0,
                createdAt: log.createdAt,
                locationId: log.locationId,
                locationName,
                accountId: log.accountId,
                accountEmail,
                errorMessage: log.errorMessage || null,
                actions,
                successfulActionCount,
                failedActionCount: actions.length - successfulActionCount,
                totalActionCount: actions.length,
            }
        })

        const successLogs = logs.filter(l => l.status === 'success')
        const recentLogs = normalizedLogs
            .slice()
            .sort((left, right) => {
                const leftTime = new Date(left.createdAt as any).getTime() || 0
                const rightTime = new Date(right.createdAt as any).getTime() || 0
                return rightTime - leftTime
            })
            .slice(0, 100)

        return {
            campaignId,
            campaignName: campaign.name,
            totalVisits: campaign.totalVisits,
            completedVisits: campaign.completedVisits,
            failedVisits: campaign.failedVisits,
            totalRounds: campaign.currentRound,
            totalDuration,
            avgVisitDuration: successLogs.length > 0 ? Math.round(totalDuration / successLogs.length) : 0,
            visitsByLocation: Array.from(locationMap.entries()).map(([id, data]) => ({
                locationId: id,
                locationName: data.name,
                visits: data.visits,
                avgDuration: data.visits > 0 ? Math.round(data.totalDuration / data.visits) : 0,
            })),
            visitsByAccount: Array.from(accountMap.entries()).map(([id, data]) => ({
                accountId: id,
                accountEmail: data.email,
                visits: data.visits,
            })),
            actionStats: Array.from(actionCounts.entries()).map(([action, count]) => ({
                action,
                count,
            })).sort((a, b) => b.count - a.count),
            logs: recentLogs,
        }
    }

    /**
     * Traffic Audit Report — analyzes visit quality to explain the gap
     * between "successful visits" in the app and actual visits counted by Google.
     */
    getAuditReport(campaignId: number) {
        const db = getDatabase()
        const campaign = db.select().from(schema.trafficCampaigns).where(eq(schema.trafficCampaigns.id, campaignId)).get()
        if (!campaign) throw new Error('Campaign not found')

        const logs = db.select().from(schema.trafficLogs)
            .where(eq(schema.trafficLogs.campaignId, campaignId))
            .all()

        const successLogs = logs.filter(l => l.status === 'success')
        const failedLogs = logs.filter(l => l.status === 'failed')

        // Analyze failed visits by error category
        const failureReasons: Record<string, number> = {}
        for (const log of failedLogs) {
            const msg = log.errorMessage || 'unknown'
            let category = classifyTrafficFailureMessage(msg).bucket
            try {
                const parsedActions = JSON.parse(log.actions || '[]') as unknown
                category = readTrafficFailureBucketFromActions(parsedActions) || category
            } catch {
                // Legacy or malformed rows still fall back to error_message classification.
            }
            failureReasons[category] = (failureReasons[category] || 0) + 1
        }

        // Analyze success visits by quality
        let highQualityVisits = 0
        let mediumQualityVisits = 0
        let lowQualityVisits = 0
        let proxyRotatedVisits = 0
        let veryShortVisits = 0
        let totalQualityScore = 0
        let qualityAssessmentCount = 0

        for (const log of successLogs) {
            if ((log.duration || 0) < 15) veryShortVisits++

            let actions: any[] = []
            try { actions = JSON.parse(log.actions || '[]') } catch { /* ignore */ }

            const qualityAction = actions.find((a: any) => a.action === 'visit_quality_assessment')
            if (qualityAction && typeof qualityAction.detail === 'string') {
                const match = qualityAction.detail.match(/Quality=(\d+)\/100/)
                if (match) {
                    const score = parseInt(match[1], 10)
                    totalQualityScore += score
                    qualityAssessmentCount++
                    if (score >= 60) highQualityVisits++
                    else if (score >= 40) mediumQualityVisits++
                    else lowQualityVisits++
                }
            }

            const proxyAction = actions.find((a: any) => a.action === 'proxy_rotated_visit_ended')
            if (proxyAction) proxyRotatedVisits++
        }

        const avgQuality = qualityAssessmentCount > 0 ? Math.round(totalQualityScore / qualityAssessmentCount) : 0
        const estimatedGoogleCountable = highQualityVisits + Math.floor(mediumQualityVisits * 0.5)

        return {
            campaignId,
            campaignName: campaign.name,
            totalAttempted: logs.length,
            totalSuccess: successLogs.length,
            totalFailed: failedLogs.length,
            successRate: logs.length > 0 ? Math.round((successLogs.length / logs.length) * 100) : 0,
            quality: {
                highQuality: highQualityVisits,
                mediumQuality: mediumQualityVisits,
                lowQuality: lowQualityVisits,
                avgQualityScore: avgQuality,
                estimatedGoogleCountable,
                estimatedGoogleRate: successLogs.length > 0
                    ? Math.round((estimatedGoogleCountable / successLogs.length) * 100)
                    : 0,
            },
            issues: {
                veryShortVisits,
                proxyRotatedVisits,
                captchaBlocked: failureReasons['captcha_blocked'] || 0,
                watchdogTimeout: failureReasons['watchdog_timeout'] || 0,
                loginGate: failureReasons['login_gate'] || 0,
                proxyErrors: failureReasons['proxy_error'] || 0,
                navigationErrors: failureReasons['navigation_error'] || 0,
                browserCrashes: failureReasons['browser_crash'] || 0,
                otherErrors: failureReasons['other'] || 0,
            },
            summary: this.buildAuditSummary(
                logs.length, successLogs.length, failedLogs.length,
                highQualityVisits, mediumQualityVisits, lowQualityVisits,
                estimatedGoogleCountable, failureReasons, proxyRotatedVisits, veryShortVisits
            ),
        }
    }

    private buildAuditSummary(
        total: number, success: number, failed: number,
        high: number, medium: number, low: number,
        estimated: number, failures: Record<string, number>,
        proxyRotated: number, veryShort: number,
    ): string[] {
        const lines: string[] = []
        lines.push(`Total: ${total} visits (${success} success, ${failed} failed)`)
        lines.push(`High quality (Google will count): ${high}`)
        lines.push(`Medium quality: ${medium}`)
        lines.push(`Low quality (Google may not count): ${low}`)
        lines.push(`Estimated Google-countable: ~${estimated} (${total > 0 ? Math.round((estimated / total) * 100) : 0}%)`)
        if (proxyRotated > 0) lines.push(`${proxyRotated} visits cut short by proxy rotation`)
        if (veryShort > 0) lines.push(`${veryShort} visits too short (<15s)`)
        if (failures['captcha_blocked']) lines.push(`${failures['captcha_blocked']} visits blocked by CAPTCHA`)
        if (failures['watchdog_timeout']) lines.push(`${failures['watchdog_timeout']} visits timed out`)
        return lines
    }

}

export const trafficBoostEngine = new TrafficBoostEngine()

