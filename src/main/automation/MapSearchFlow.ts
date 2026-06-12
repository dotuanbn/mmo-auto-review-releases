import { Page } from 'playwright'
import { HumanBehavior } from './HumanBehavior'
import { contextualInterruptionResolver } from './ContextualInterruptionResolver'

// ============================================================
// Types
// ============================================================

export interface LocationInfo {
    name: string
    address?: string | null
    placeId?: string | null
    url: string
}

export interface MapSearchFlowResult {
    success: boolean
    foundMap: boolean
    actionsPerformed: { action: string; success: boolean; detail?: string; source?: string }[]
    searchKeyword: string
    message: string
}

// Status callback for live monitoring
type StatusCallback = (status: string) => void

const DEFAULT_MAX_MAP_CARDS_TO_SCAN = 15
const MAX_ALLOWED_MAP_CARDS_TO_SCAN = 100
const MAPS_URL = 'https://www.google.com/maps'

// ============================================================
// Map Search Flow (SEO trên Google Maps search)
// ============================================================

export class MapSearchFlow {
    private onStatus: StatusCallback

    constructor(onStatus?: StatusCallback) {
        this.onStatus = onStatus || (() => { })
    }

    private async resolveUnexpectedPrompt(page: Page, reason: string): Promise<void> {
        const recovered = await contextualInterruptionResolver.resolve(page, {
            reason: `map_search_${reason}`,
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 2,
            goal: 'map_interaction',
            campaignType: 'traffic',
            domain: page.url(),
        }).catch(() => ({ handled: false }))

        if (recovered.handled) {
            this.onStatus(`Da xu ly prompt bat ngo (${reason})`)
            await HumanBehavior.randomDelay(120, 320)
        }
    }

    async execute(page: Page, keyword: string, location: LocationInfo, isLoggedIn: boolean = false, maxMapScroll?: number): Promise<MapSearchFlowResult> {
        const result: MapSearchFlowResult = {
            success: false,
            foundMap: false,
            actionsPerformed: [],
            searchKeyword: keyword,
            message: '',
        }

        // Compute effective max with clamp: invalid/<1 -> DEFAULT 15; cap at 100
        const effectiveMax = (() => {
            if (typeof maxMapScroll !== 'number' || !Number.isFinite(maxMapScroll) || maxMapScroll < 1) {
                return DEFAULT_MAX_MAP_CARDS_TO_SCAN
            }
            return Math.min(MAX_ALLOWED_MAP_CARDS_TO_SCAN, Math.floor(maxMapScroll))
        })()

        try {
            this.onStatus(`Đang mở Google Maps: "${keyword}"`)
            const navigated = await this.gotoMapsAndHandleConsent(page)
            if (!navigated) {
                result.message = 'Failed to open Google Maps'
                return result
            }
            await this.resolveUnexpectedPrompt(page, 'after_maps_landing')

            // Type keyword into Maps search box and submit
            const typed = await this.typeKeywordIntoMapsSearch(page, keyword)
            if (!typed) {
                result.message = 'Failed to type keyword into Maps search'
                return result
            }
            await HumanBehavior.randomDelay(1500, 3000)
            await this.resolveUnexpectedPrompt(page, 'after_search_submit')

            // Scroll feed and find target (use effective max from param or default)
            this.onStatus(`Đang quét feed Maps tìm: ${location.name}`)
            const found = await this.scrollAndFindTargetInFeed(page, location, effectiveMax)
            if (!found) {
                result.message = `Map "${location.name}" not found after scanning ${effectiveMax} cards`
                return result
            }
            result.foundMap = true

            await HumanBehavior.randomDelay(2500, 4500)
            await this.resolveUnexpectedPrompt(page, 'after_open_target')

            // We are now on the detail place page. Stop here — autonomous agent will do KPI actions.
            result.success = true
            result.message = `Found map via Maps search for "${keyword}"`
            result.actionsPerformed = [{ action: 'opened_map_detail', success: true }]
            return result
        } catch (error) {
            result.message = `Error: ${error instanceof Error ? error.message : String(error)}`
            return result
        }
    }

    private async gotoMapsAndHandleConsent(page: Page): Promise<boolean> {
        try {
            await page.goto(MAPS_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            })
            await HumanBehavior.randomDelay(1200, 2500)

            // Handle consent / cookie dialogs (common on Maps)
            try {
                const consentSelectors = [
                    'button:has-text("Accept all")',
                    'button:has-text("Đồng ý")',
                    'button:has-text("Accept")',
                    'button:has-text("I agree")',
                    'form[action*="consent"] button',
                    '[aria-label*="Accept"]',
                    'button[jsaction*="consent"]'
                ]
                for (const sel of consentSelectors) {
                    const btn = await page.$(sel).catch(() => null)
                    if (btn) {
                        await btn.click().catch(() => { })
                        await HumanBehavior.randomDelay(600, 1200)
                        break
                    }
                }
            } catch { /* no consent */ }

            await HumanBehavior.randomDelay(800, 1600)
            return true
        } catch (error) {
            console.error('[MapSearchFlow] Failed to goto Maps:', error)
            return false
        }
    }

    private async typeKeywordIntoMapsSearch(page: Page, keyword: string): Promise<boolean> {
        try {
            // Common Maps search input selectors (desktop)
            const searchSelector = 'input#searchboxinput, input[name="q"], input[aria-label*="Search"], input[aria-label*="Tìm kiếm"], input[placeholder*="Search Google Maps"]'

            // Focus the search box with human-like interaction
            await HumanBehavior.humanClick(page, searchSelector).catch(async () => {
                // Fallback direct focus
                await page.click(searchSelector, { timeout: 4000 }).catch(() => { })
            })
            await HumanBehavior.randomDelay(250, 600)

            // Clear existing value if any
            try {
                await page.keyboard.press('Control+A').catch(() => { })
                await page.keyboard.press('Backspace').catch(() => { })
            } catch { /* ignore */ }
            await HumanBehavior.randomDelay(100, 250)

            // Human-like type
            await HumanBehavior.humanType(page, searchSelector, keyword, { minDelay: 45, maxDelay: 140, mistakeRate: 0.015 })
            await HumanBehavior.randomDelay(600, 1100)

            // Submit
            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { })
            await HumanBehavior.randomDelay(1800, 3200)

            // Optional: small scroll to trigger feed render
            await HumanBehavior.randomScroll(page, 1).catch(() => { })
            return true
        } catch (error) {
            console.error('[MapSearchFlow] Failed to type/submit Maps search:', error)
            return false
        }
    }

    private async scrollAndFindTargetInFeed(page: Page, location: LocationInfo, maxCards: number): Promise<boolean> {
        let cardsScanned = 0

        // Prefer the results feed panel
        const feedSelector = 'div[role="feed"]'

        for (let attempt = 0; attempt < 6; attempt++) {
            await this.resolveUnexpectedPrompt(page, `feed_scan_attempt_${attempt + 1}`)

            // Collect candidate cards in current viewport
            const cardSelectors = 'div.Nv2PK, div[role="article"], a.hfpxzc, div[jsaction] a[href*="maps/place"], a[href*="maps/place"]'
            const cards = await page.$$(cardSelectors).catch(() => [])

            for (const card of cards) {
                if (cardsScanned >= maxCards) break

                cardsScanned++

                try {
                    const text = await card.textContent().catch(() => '')
                    const href = await card.getAttribute('href').catch(() => '')

                    const matches =
                        (text && this.isMatchingLocation(text, href, location)) ||
                        (href && location.placeId && href.includes(location.placeId)) ||
                        (href && location.name && this.isMatchingLocation(href, href, location))

                    if (matches) {
                        this.onStatus(`Tìm thấy map trong feed Maps (card ${cardsScanned})`)

                        // Prefer inner <a> if present, else click the card itself
                        const link = await card.$('a').catch(() => null)
                        if (link) {
                            await link.click().catch(async () => { await card.click() })
                        } else {
                            await card.click().catch(() => { })
                        }

                        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { })
                        await HumanBehavior.randomDelay(1800, 3500)

                        // POST-CLICK VERIFY: only accept if we landed on the real target; else back and keep scanning
                        const verified = await HumanBehavior.verifyOnTargetMap(page, location).catch(() => false)
                        if (verified) {
                            return true
                        }
                        // Wrong map clicked - back out and continue feed scan (within max limit)
                        await page.goBack().catch(() => { })
                        await HumanBehavior.randomDelay(900, 1600)
                        continue
                    }
                } catch { /* card read/click error, continue */ }
            }

            if (cardsScanned >= maxCards) {
                break
            }

            // Scroll the feed or page to load more
            this.onStatus(`Đang cuộn feed Maps (${cardsScanned}/${maxCards})...`)
            try {
                const feed = await page.$(feedSelector).catch(() => null)
                if (feed) {
                    await feed.evaluate((el: HTMLElement) => {
                        el.scrollBy(0, 420 + Math.random() * 180)
                    }).catch(async () => {
                        await HumanBehavior.randomScroll(page, 2)
                    })
                } else {
                    await HumanBehavior.randomScroll(page, 2)
                }
            } catch {
                await HumanBehavior.randomScroll(page, 2).catch(() => { })
            }

            await HumanBehavior.randomDelay(900, 1800)
        }

        return false
    }

    /**
     * Strict match: prefer strong identifiers (placeId / CID in href or attr), else require high-confidence name+address overlap.
     * Only return true when sufficiently confident to click (no loose substring).
     */
    private isMatchingLocation(text: string, href: string | null, location: LocationInfo): boolean {
        const nText = HumanBehavior.normalizeName(text)
        const nName = HumanBehavior.normalizeName(location.name)
        if (!nName) return false

        // 1) Strong ID priority (placeId in href is reliable)
        if (location.placeId) {
            const pid = location.placeId
            if (href && (href.includes(pid) || href.includes(encodeURIComponent(pid)))) return true
            if (text && text.includes(pid)) return true
        }

        // 2) Strict name match (full-ish, not partial token): high word overlap or contains full name
        if (nText === nName || nText.includes(nName)) {
            // If address present, require some corroboration to raise confidence
            if (!location.address) return true
            const nAddr = HumanBehavior.normalizeName(location.address)
            const addrParts = nAddr.split(/[,\s]+/).filter(p => p.length > 3)
            const addrHits = addrParts.filter(p => nText.includes(p)).length
            if (addrHits >= Math.max(1, Math.ceil(addrParts.length * 0.4))) return true
            // else fall to name-only high overlap below
        }
        const nameWords = nName.split(/\s+/).filter(p => p.length > 1)
        const textSet = new Set(nText.split(/\s+/))
        const nameHits = nameWords.filter(w => textSet.has(w)).length
        const nameScore = nameWords.length ? nameHits / nameWords.length : 0
        if (nameScore >= 0.85) {
            if (!location.address) return true
            const nAddr = HumanBehavior.normalizeName(location.address)
            const addrParts = nAddr.split(/[,\s]+/).filter(p => p.length > 3)
            const addrHits = addrParts.filter(p => nText.includes(p)).length
            if (addrHits >= Math.ceil(addrParts.length * 0.4)) return true
        }
        return false
    }

    // Legacy thin wrapper (some call sites used 2-arg). Delegates with null href.
    private isMatchingLocationLegacy(text: string, location: LocationInfo): boolean {
        return this.isMatchingLocation(text, null, location)
    }
}
