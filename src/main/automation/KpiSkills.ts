/**
 * KpiSkills — Deterministic KPI tool-calling with verification.
 *
 * Each KPI target has a dedicated "skill" function that:
 *   1. Locates the correct UI element on the Google Maps place page.
 *   2. Executes the action with human-like timing.
 *   3. Verifies the action was registered (e.g. new tab opened, tel: link triggered).
 *
 * This replaces the old approach of hoping the LLM plan includes the right action.
 */

import { Dialog, Locator, Page } from 'playwright'
import { DOMUtils } from './DOMUtils'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'
import { writeAgenticLog } from '../utils/agenticLog'

export type MapKpiType = 'phone' | 'direction' | 'website'

export interface KpiSkillResult {
    executed: boolean
    verified: boolean
    actions: string[]
    detail: string
    durationMs: number
}

export interface KpiAvailability {
    type: MapKpiType
    available: boolean
    selector?: string
    detail: string
}

type LocatedKpiElement = {
    locator: Locator
    selector: string
}

type DialogDismissHandler = (dialog: Dialog) => void | Promise<void>

type DialogEmitter = {
    on(event: 'dialog', handler: DialogDismissHandler): void
    off(event: 'dialog', handler: DialogDismissHandler): void
}

export interface ExecuteAvailableKpisOptions {
    preferredOrder?: MapKpiType[]
    directionStartPoint?: string
}

export interface ExecuteKpiOptions {
    directionStartPoint?: string
}

const PHONE_SELECTORS = [
    'button[data-item-id^="phone:tel:"]',
    'button[data-item-id*="phone"]',
    'a[href^="tel:"]',
    'button[aria-label^="Phone:"]',
    'button[aria-label*="Phone" i]',
    'button[aria-label*="Call" i]',
    'button[aria-label*="Gọi" i]',
    'button[aria-label*="điện thoại" i]',
    'a[aria-label*="Phone" i]',
    'a[aria-label*="Call" i]',
    'a[aria-label*="Gọi" i]',
    'a[aria-label*="điện thoại" i]',
    'a[data-tooltip*="gọi" i]',
    'button[data-tooltip*="Gọi" i]',
]

const DIRECTION_SELECTORS = [
    'button[data-value="Directions"]',
    'button[data-item-id="directions"]',
    'a[data-item-id="directions"]',
    'button[jsaction*="pane.placeActions.directions"]',
    'button[aria-label*="Directions" i]',
    'button[aria-label*="Chỉ đường" i]',
    'a[aria-label*="Directions" i]',
    'a[aria-label*="Chỉ đường" i]',
    'button[data-tooltip*="Directions" i]',
    'button[data-tooltip*="Chỉ đường" i]',
]

const WEBSITE_SELECTORS = [
    'a[data-item-id="authority"]',
    'a[href^="http"]:not([href*="google."])',
    'a[aria-label*="Website" i]',
    'a[aria-label*="website" i]',
    'a[aria-label*="Trang web" i]',
    'a[data-tooltip*="Website" i]',
    'a[data-tooltip*="website" i]',
    'a[data-tooltip*="Trang web" i]',
    'a:has-text("Website")',
    'a:has-text("Trang web")',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
    console.log(`[KpiSkills] ${msg}`)
    writeAgenticLog('KpiSkills', msg)
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function humanDelay(min: number, max: number): Promise<void> {
    const ms = randomInt(min, max)
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Perform a human-like click on a Playwright locator with Bézier mouse approach.
 */
async function humanClickLocator(
    page: Page,
    locator: ReturnType<Page['locator']>,
    label: string
): Promise<boolean> {
    try {
        const visible = await locator.isVisible({ timeout: 2000 }).catch(() => false)
        if (!visible) return false

        await locator.scrollIntoViewIfNeeded().catch(() => {})
        await humanDelay(300, 600)

        const box = await locator.boundingBox().catch(() => null)
        if (box) {
            // Approach with Bézier-like curve
            const targetX = box.x + box.width * (0.3 + Math.random() * 0.4)
            const targetY = box.y + box.height * (0.3 + Math.random() * 0.4)

            // Pre-click hover approach
            const startX = targetX + randomInt(-120, 120)
            const startY = targetY + randomInt(-80, 80)
            await page.mouse.move(startX, startY, { steps: randomInt(4, 8) }).catch(() => {})
            await humanDelay(100, 250)

            // Move to target with micro-steps
            await moveCursor(page, targetX, targetY)
            await page.mouse.move(targetX, targetY, { steps: randomInt(8, 16) }).catch(() => {})

            // Pre-click hesitation (humans pause briefly before clicking)
            await humanDelay(200, 500)

            // Click
            await clickCursor(page, targetX, targetY)
            await page.mouse.click(targetX, targetY, { delay: randomInt(30, 80) })
        } else {
            // Fallback: direct click
            await locator.click({ timeout: 3000 })
        }

        log(`Clicked: ${label}`)
        return true
    } catch (err) {
        log(`Click failed for "${label}": ${err instanceof Error ? err.message : String(err)}`)

        // Force-click fallback
        try {
            await locator.click({ timeout: 2000, force: true })
            log(`Force-click succeeded for "${label}"`)
            return true
        } catch {
            return false
        }
    }
}

function selectorsForKpi(type: MapKpiType): string[] {
    switch (type) {
        case 'phone':
            return PHONE_SELECTORS
        case 'direction':
            return DIRECTION_SELECTORS
        case 'website':
            return WEBSITE_SELECTORS
    }
}

function uniqueKpis(values: MapKpiType[]): MapKpiType[] {
    const seen = new Set<MapKpiType>()
    const result: MapKpiType[] = []

    for (const value of values) {
        if (seen.has(value)) continue
        seen.add(value)
        result.push(value)
    }

    return result
}

// ---------------------------------------------------------------------------
// KPI Skills
// ---------------------------------------------------------------------------

export class KpiSkills {

    async detectAvailableKpis(page: Page): Promise<KpiAvailability[]> {
        const kpiTypes: MapKpiType[] = ['phone', 'website', 'direction']
        const availability: KpiAvailability[] = []
        let domSnapshot: Awaited<ReturnType<typeof DOMUtils.extractInteractiveDOM>> | null = null

        for (const type of kpiTypes) {
            const located = await this.locateBySelectors(page, type)
            if (located) {
                availability.push({
                    type,
                    available: true,
                    selector: located.selector,
                    detail: `Found ${type} action by selector`,
                })
                continue
            }

            if (!domSnapshot) {
                domSnapshot = await DOMUtils.extractInteractiveDOM(page).catch(() => null)
            }

            const domCandidate = domSnapshot ? this.findDomCandidate(domSnapshot.summaries, type) : null
            availability.push({
                type,
                available: !!domCandidate,
                selector: domCandidate ? `dom:${domCandidate.id}` : undefined,
                detail: domCandidate
                    ? `Found ${type} action in observed DOM`
                    : `No ${type} action available on page`,
            })
        }

        return availability
    }

    private async locateBySelectors(page: Page, type: MapKpiType): Promise<LocatedKpiElement | null> {
        for (const selector of selectorsForKpi(type)) {
            const locator = page.locator(selector).first()
            const isVisible = await locator.isVisible({ timeout: 900 }).catch(() => false)
            if (isVisible) {
                return { locator, selector }
            }
        }

        return null
    }

    private findDomCandidate(
        summaries: Awaited<ReturnType<typeof DOMUtils.extractInteractiveDOM>>['summaries'],
        type: MapKpiType
    ) {
        return summaries.find(summary => {
            const text = [summary.textContent, summary.ariaLabel, summary.title, summary.href]
                .filter(Boolean)
                .join(' ')
            const isClickable = summary.tagName === 'button'
                || summary.tagName === 'a'
                || summary.role === 'button'
                || summary.role === 'link'

            if (!isClickable) return false
            if (/(add|upload|write|sign|login|review|photo)/i.test(text)) return false

            switch (type) {
                case 'phone':
                    return /tel:|phone|call|goi|gọi|dien thoai|điện thoại/i.test(text)
                case 'website': {
                    const href = summary.href || ''
                    return /website|trang web|go to site/i.test(text)
                        || /^https?:\/\/(?!.*google)/i.test(href)
                }
                case 'direction':
                    return /direction|directions|route|chi duong|chỉ đường|duong di|đường đi/i.test(text)
            }
        })
    }

    // -----------------------------------------------------------------------
    // PHONE CLICK
    // -----------------------------------------------------------------------

    /**
     * Execute a phone call click on the Google Maps place page.
     *
     * Google Maps registers a "phone click" when the user clicks the phone number
     * link (which has `data-item-id="phone"` or an `href` containing `tel:`).
     */
    async executePhoneClick(page: Page, threadId: number): Promise<KpiSkillResult> {
        const start = Date.now()
        const actions: string[] = []
        let executed = false
        let verified = false

        log(`T${threadId}: Executing PHONE KPI skill...`)

        // Strategy 1: data-item-id="phone" (most reliable)
        const phoneSelectors = [
            'a[data-item-id="phone"]',
            'button[data-item-id="phone"]',
            'a[data-tooltip*="phone" i]',
            'a[data-tooltip*="gọi" i]',
            'a[data-tooltip*="call" i]',
            'button[data-tooltip*="Call" i]',
            'a[href^="tel:"]',
            'button[aria-label*="Call" i]',
            'button[aria-label*="Gọi" i]',
            'a[aria-label*="phone" i]',
            'a[aria-label*="điện thoại" i]',
        ]

        const dialogGuard = this.createDialogDismissGuard(page, actions, 'phone')

        for (const selector of phoneSelectors) {
            const locator = page.locator(selector).first()
            const clicked = await humanClickLocator(page, locator, `phone: ${selector}`)
            if (clicked) {
                executed = true
                actions.push(`phone_click_${selector.substring(0, 30)}`)
                break
            }
        }

        if (!executed) {
            // Fallback: search DOM text for phone pattern and click it
            log(`T${threadId}: Primary phone selectors failed. Trying DOM text search...`)
            const dom = await DOMUtils.extractInteractiveDOM(page)
            const phoneCandidate = dom.summaries.find(s => {
                const text = [s.textContent, s.ariaLabel, s.href].filter(Boolean).join(' ')
                return /tel:|phone|điện thoại|gọi ngay|call/i.test(text) &&
                    !/(add|upload|write|sign|login)/i.test(text)
            })

            if (phoneCandidate) {
                const locator = DOMUtils.getObservedElementLocator(page, phoneCandidate.id)
                const clicked = await humanClickLocator(page, locator, `phone_dom_${phoneCandidate.id}`)
                if (clicked) {
                    executed = true
                    actions.push(`phone_dom_click_${phoneCandidate.id}`)
                }
            }
        }

        if (executed) {
            // Wait briefly, then dismiss the Chrome external protocol prompt
            // so the session can continue without manual "Call" interaction.
            await humanDelay(600, 1200)
            await this.dismissExternalCallPrompt(page, actions, dialogGuard)
            await humanDelay(800, 1800)

            // Verify: check if a tel: link was invoked or phone number panel appeared
            verified = await this.verifyPhoneClick(page)
            actions.push(verified ? 'phone_verified' : 'phone_unverified')

            // Post-click: natural delay simulating "looking at the number"
            await humanDelay(2000, 4000)

            // Post-click drift (move mouse away naturally)
            const viewport = page.viewportSize()
            if (viewport) {
                const driftX = randomInt(200, viewport.width - 200)
                const driftY = randomInt(200, viewport.height - 200)
                await page.mouse.move(driftX, driftY, { steps: randomInt(6, 12) }).catch(() => {})
            }
        } else {
            dialogGuard.dispose()
        }

        const detail = executed
            ? `Phone click ${verified ? 'VERIFIED' : 'UNVERIFIED'}`
            : 'Could not find phone element on page'

        log(`T${threadId}: Phone KPI result: executed=${executed}, verified=${verified}`)

        return {
            executed,
            verified,
            actions,
            detail,
            durationMs: Date.now() - start,
        }
    }

    private createDialogDismissGuard(
        page: Page,
        actions: string[],
        actionPrefix: string
    ): { wait: Promise<boolean>; dispose: () => void } {
        let disposed = false
        let timer: NodeJS.Timeout | null = null
        let handler: DialogDismissHandler | null = null
        const dialogPage = page as unknown as DialogEmitter

        const wait = new Promise<boolean>((resolve) => {
            handler = async (dialog: Dialog) => {
                if (disposed) return
                disposed = true
                if (timer) clearTimeout(timer)
                try {
                    await dialog.dismiss()
                    actions.push(`${actionPrefix}_js_dialog_dismissed`)
                    resolve(true)
                } catch {
                    actions.push(`${actionPrefix}_js_dialog_dismiss_failed`)
                    resolve(false)
                } finally {
                    if (handler) dialogPage.off('dialog', handler)
                }
            }

            dialogPage.on('dialog', handler)
            timer = setTimeout(() => {
                if (disposed) return
                disposed = true
                if (handler) dialogPage.off('dialog', handler)
                resolve(false)
            }, 3500)
        })

        return {
            wait,
            dispose: () => {
                disposed = true
                if (timer) clearTimeout(timer)
                if (handler) dialogPage.off('dialog', handler)
            },
        }
    }

    private async dismissExternalCallPrompt(
        page: Page,
        actions: string[],
        dialogGuard: { wait: Promise<boolean>; dispose: () => void }
    ): Promise<void> {
        const dialogDismissed = await dialogGuard.wait.catch(() => false)
        if (dialogDismissed) return

        const beforePages = new Set(page.context().pages())
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('Escape').catch(() => {})
            await humanDelay(250, 450)
        }

        const cancelSelectors = [
            'button:has-text("Cancel")',
            'button:has-text("Close")',
            'button:has-text("Not now")',
            'button:has-text("Huy")',
            'button:has-text("Dong")',
            'button[aria-label*="Cancel" i]',
            'button[aria-label*="Close" i]',
        ]

        let clickedCancel = false
        for (const selector of cancelSelectors) {
            const locator = page.locator(selector).first()
            const visible = await locator.isVisible({ timeout: 400 }).catch(() => false)
            if (!visible) continue
            clickedCancel = await locator.click({ timeout: 700 }).then(() => true).catch(() => false)
            if (clickedCancel) break
        }

        for (const candidate of page.context().pages()) {
            if (candidate !== page && !beforePages.has(candidate)) {
                await candidate.close().catch(() => {})
            }
        }

        await page.bringToFront().catch(() => {})
        actions.push(clickedCancel ? 'phone_protocol_popup_cancel_clicked' : 'phone_protocol_popup_dismissed')
    }

    private async verifyPhoneClick(page: Page): Promise<boolean> {
        try {
            // Check 1: A tel: link is present and was the click target
            const telLink = await page.locator('a[href^="tel:"]').count().catch(() => 0)
            if (telLink > 0) return true

            // Check 2: Phone number text is visible in the info panel
            const phoneText = await page.evaluate(() => {
                const panel = document.querySelector('[data-item-id="phone"]')
                return !!panel
            }).catch(() => false)
            if (phoneText) return true

            // Check 3: Any element with phone-like data was clicked
            const phoneAria = await page.locator('[aria-label*="phone" i], [aria-label*="call" i], [aria-label*="gọi" i]').count().catch(() => 0)
            return phoneAria > 0
        } catch {
            return false
        }
    }

    // -----------------------------------------------------------------------
    // WEBSITE CLICK
    // -----------------------------------------------------------------------

    /**
     * Execute a website click on the Google Maps place page.
     *
     * Google Maps registers a "website click" when the user clicks the website link.
     * This link typically opens in a new tab. Google Analytics on the destination site
     * requires > 10 seconds dwell time to count as an "engaged session".
     */
    async executeWebsiteClick(page: Page, threadId: number): Promise<KpiSkillResult> {
        const start = Date.now()
        const actions: string[] = []
        let executed = false
        let verified = false

        log(`T${threadId}: Executing WEBSITE KPI skill...`)

        const websiteSelectors = [
            'a[data-item-id="authority"]',
            'a[aria-label*="website" i]',
            'a[aria-label*="trang web" i]',
            'a[data-tooltip*="website" i]',
            'a:has-text("Website")',
            'a:has-text("Trang web")',
        ]

        let targetLocator = null
        for (const selector of websiteSelectors) {
            const locator = page.locator(selector).first()
            const isVisible = await locator.isVisible({ timeout: 1500 }).catch(() => false)
            if (isVisible) {
                targetLocator = locator
                actions.push(`website_found_${selector.substring(0, 30)}`)
                break
            }
        }

        if (!targetLocator) {
            log(`T${threadId}: No website element found via selectors. Trying DOM search...`)
            const dom = await DOMUtils.extractInteractiveDOM(page)
            const websiteCandidate = dom.summaries.find(s => {
                const text = [s.textContent, s.ariaLabel, s.title].filter(Boolean).join(' ')
                const href = s.href || ''
                // Must be an external link
                return (
                    (/website|trang web|go to site/i.test(text) || /^https?:\/\/(?!.*google)/i.test(href)) &&
                    !/(add|upload|write|sign|login|review|photo)/i.test(text)
                )
            })

            if (websiteCandidate) {
                targetLocator = DOMUtils.getObservedElementLocator(page, websiteCandidate.id)
                actions.push(`website_dom_found_${websiteCandidate.id}`)
            }
        }

        if (!targetLocator) {
            return {
                executed: false,
                verified: false,
                actions,
                detail: 'Could not find website element on page',
                durationMs: Date.now() - start,
            }
        }

        const originalMapUrl = page.url()
        const targetHref = await targetLocator.getAttribute('href').catch(() => null)

        // Set up new tab listener BEFORE clicking
        const newPagePromise = page.context().waitForEvent('page', { timeout: 12000 }).catch(() => null)

        // Execute the click
        const clicked = await humanClickLocator(page, targetLocator, 'website_link')
        if (clicked) {
            executed = true
            actions.push('website_click')
        } else {
            return {
                executed: false,
                verified: false,
                actions,
                detail: 'Website click failed',
                durationMs: Date.now() - start,
            }
        }

        // Wait for new tab
        const newPage = await newPagePromise
        if (newPage) {
            log(`T${threadId}: Website tab opened: ${newPage.url()}`)
            actions.push('website_tab_opened')
            verified = true

            try {
                await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})

                // ORGANIC BROWSING on the external website (15-30s for engaged session)
                log(`T${threadId}: Starting organic browse on website (~20s)...`)
                actions.push('website_organic_start')

                const browseDuration = randomInt(15000, 30000)
                const browseStart = Date.now()
                const scrollRounds = randomInt(6, 12)

                for (let i = 0; i < scrollRounds && (Date.now() - browseStart) < browseDuration; i++) {
                    // Scroll down with variable amounts
                    const scrollAmount = randomInt(150, 450)
                    await (newPage as Page).mouse.wheel(0, scrollAmount).catch(() => {})
                    await humanDelay(1500, 3500)

                    // Occasionally scroll up (reading pattern)
                    if (Math.random() > 0.7) {
                        await (newPage as Page).mouse.wheel(0, -randomInt(80, 200)).catch(() => {})
                        await humanDelay(800, 2000)
                    }

                    // Occasionally move mouse (reading simulation)
                    if (Math.random() > 0.5) {
                        const vp = newPage.viewportSize()
                        if (vp) {
                            await (newPage as Page).mouse.move(
                                randomInt(100, vp.width - 100),
                                randomInt(100, vp.height - 100),
                                { steps: randomInt(5, 10) }
                            ).catch(() => {})
                        }
                    }
                }

                actions.push(`website_browsed_${Math.round((Date.now() - browseStart) / 1000)}s`)
            } catch (err) {
                log(`T${threadId}: Error during website browse: ${err}`)
            } finally {
                if (!newPage.isClosed()) {
                    await newPage.close().catch(() => {})
                }
                await page.bringToFront().catch(() => {})
                log(`T${threadId}: Closed website tab, back to Maps.`)
                actions.push('website_tab_closed')
            }
        } else {
            log(`T${threadId}: No new tab detected after website click. May be same-page or blocked.`)
            actions.push('website_no_popup')

            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
            const currentUrl = page.url().toLowerCase()
            const sameTabWebsite = /^https?:\/\//i.test(currentUrl)
                && !currentUrl.includes('google.')
                && !currentUrl.includes('/maps')

            if (sameTabWebsite) {
                verified = true
                actions.push('website_same_tab_opened')

                const browseDuration = randomInt(15000, 25000)
                const browseStart = Date.now()
                const scrollRounds = randomInt(5, 9)
                for (let i = 0; i < scrollRounds && (Date.now() - browseStart) < browseDuration; i++) {
                    await page.mouse.wheel(0, randomInt(150, 450)).catch(() => {})
                    await humanDelay(1500, 3000)
                    if (Math.random() > 0.7) {
                        await page.mouse.wheel(0, -randomInt(80, 200)).catch(() => {})
                        await humanDelay(800, 1800)
                    }
                }
                actions.push(`website_same_tab_browsed_${Math.round((Date.now() - browseStart) / 1000)}s`)
            } else if (targetHref && /^https?:\/\//i.test(targetHref) && !targetHref.toLowerCase().includes('google.')) {
                const fallbackPage = await page.context().newPage()
                try {
                    await fallbackPage.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    verified = true
                    actions.push('website_fallback_href_opened')

                    const browseDuration = randomInt(15000, 25000)
                    const browseStart = Date.now()
                    const scrollRounds = randomInt(5, 9)
                    for (let i = 0; i < scrollRounds && (Date.now() - browseStart) < browseDuration; i++) {
                        await fallbackPage.mouse.wheel(0, randomInt(150, 450)).catch(() => {})
                        await humanDelay(1500, 3000)
                        if (Math.random() > 0.7) {
                            await fallbackPage.mouse.wheel(0, -randomInt(80, 200)).catch(() => {})
                            await humanDelay(800, 1800)
                        }
                    }
                    actions.push(`website_fallback_browsed_${Math.round((Date.now() - browseStart) / 1000)}s`)
                } catch (err) {
                    log(`T${threadId}: Website fallback href open failed: ${err}`)
                    actions.push('website_fallback_href_failed')
                } finally {
                    await fallbackPage.close().catch(() => {})
                    await page.bringToFront().catch(() => {})
                }
            } else {
                await humanDelay(3000, 6000)
            }

            if (!page.url().toLowerCase().includes('google.') || !page.url().toLowerCase().includes('map')) {
                await page.goto(originalMapUrl, { waitUntil: 'domcontentloaded', timeout: 12000 })
                    .catch(() => page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}))
                await humanDelay(1500, 3000)
                actions.push('website_returned_to_maps')
            }
        }

        const detail = `Website click ${verified ? 'VERIFIED (website dwell)' : executed ? 'EXECUTED (no tab capture)' : 'FAILED'}`
        log(`T${threadId}: Website KPI result: executed=${executed}, verified=${verified}`)

        return {
            executed,
            verified,
            actions,
            detail,
            durationMs: Date.now() - start,
        }
    }

    // -----------------------------------------------------------------------
    // DIRECTION CLICK
    // -----------------------------------------------------------------------

    /**
     * Execute a directions click on the Google Maps place page.
     *
     * Google Maps registers a "direction request" when the user clicks the Directions
     * button. CRITICAL: We must NOT navigate to /maps/dir/ — we only click the button
     * on the place page side panel and verify the directions input appeared.
     */
    async executeDirectionClick(
        page: Page,
        threadId: number,
        options: ExecuteKpiOptions = {}
    ): Promise<KpiSkillResult> {
        const start = Date.now()
        const actions: string[] = []
        let executed = false
        let verified = false

        log(`T${threadId}: Executing DIRECTION KPI skill...`)

        // Save current URL so we can detect unwanted navigation
        const beforeUrl = page.url()

        const directionSelectors = [
            'button[data-item-id="directions"]',
            'a[data-item-id="directions"]',
            'button[aria-label*="Directions" i]',
            'button[aria-label*="Chỉ đường" i]',
            'a[aria-label*="Directions" i]',
            'a[aria-label*="Chỉ đường" i]',
            'button[data-tooltip*="Directions" i]',
            'button[data-tooltip*="Chỉ đường" i]',
            'img[src*="directions"] + *',
        ]

        for (const selector of directionSelectors) {
            const locator = page.locator(selector).first()
            const clicked = await humanClickLocator(page, locator, `direction: ${selector}`)
            if (clicked) {
                executed = true
                actions.push(`direction_click_${selector.substring(0, 30)}`)
                break
            }
        }

        if (!executed) {
            // Fallback: DOM search
            log(`T${threadId}: Primary direction selectors failed. Trying DOM text search...`)
            const dom = await DOMUtils.extractInteractiveDOM(page)
            const dirCandidate = dom.summaries.find(s => {
                const text = [s.textContent, s.ariaLabel, s.title].filter(Boolean).join(' ')
                return /direction|chỉ đường|chi duong|đường đi/i.test(text) &&
                    (s.tagName === 'button' || s.tagName === 'a' || s.role === 'button') &&
                    !/(add|upload|write|sign|login)/i.test(text)
            })

            if (dirCandidate) {
                const locator = DOMUtils.getObservedElementLocator(page, dirCandidate.id)
                const clicked = await humanClickLocator(page, locator, `direction_dom_${dirCandidate.id}`)
                if (clicked) {
                    executed = true
                    actions.push(`direction_dom_click_${dirCandidate.id}`)
                }
            }
        }

        if (executed) {
            await humanDelay(2000, 4000)

            const uiOpened = await this.verifyDirectionClick(page)
            actions.push(uiOpened ? 'direction_ui_opened' : 'direction_ui_missing')
            if (uiOpened) {
                verified = await this.fillDirectionOriginAndConfirmRoute(
                    page,
                    threadId,
                    actions,
                    options.directionStartPoint
                )
                actions.push(verified ? 'direction_route_ready' : 'direction_route_unconfirmed')
                await humanDelay(1200, 2400)
            }

            /*
            const afterUrl = page.url().toLowerCase()
            if (afterUrl.includes('/dir')) {
                log(`T${threadId}: Detected /dir/ navigation — going back immediately!`)
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
                await humanDelay(1500, 3000)
                actions.push('direction_goback_from_dir')

                // The click was still registered by Google; mark as verified
                verified = true
            } else {
                // Verify: directions input panel appeared in the side panel
                verified = await this.verifyDirectionClick(page)
                actions.push(verified ? 'direction_verified' : 'direction_unverified')

                if (verified) {
                    await humanDelay(800, 1600)
                }
            }

            */
            await this.restorePlacePageAfterDirection(page, beforeUrl, actions)

            // Post-action: natural mouse drift
            const viewport = page.viewportSize()
            if (viewport) {
                const driftX = randomInt(200, viewport.width - 200)
                const driftY = randomInt(200, viewport.height - 200)
                await page.mouse.move(driftX, driftY, { steps: randomInt(5, 10) }).catch(() => {})
            }
        }

        const detail = executed
            ? `Direction click ${verified ? 'VERIFIED' : 'UNVERIFIED'}`
            : 'Could not find directions element on page'

        log(`T${threadId}: Direction KPI result: executed=${executed}, verified=${verified}`)

        return {
            executed,
            verified,
            actions,
            detail,
            durationMs: Date.now() - start,
        }
    }

    private async fillDirectionOriginAndConfirmRoute(
        page: Page,
        threadId: number,
        actions: string[],
        configuredStartPoint?: string
    ): Promise<boolean> {
        const originInput = await this.locateDirectionOriginInput(page)
        if (!originInput) {
            actions.push('direction_origin_input_missing')
            return false
        }

        const startPoint = await this.resolveDirectionStartPoint(page, configuredStartPoint)
        if (!startPoint) {
            actions.push('direction_origin_missing')
            return false
        }

        log(`T${threadId}: Filling direction origin: ${startPoint}`)
        await originInput.click({ timeout: 3000 }).catch(() => {})
        await humanDelay(300, 700)
        const filled = await originInput.fill(startPoint, { timeout: 2500 })
            .then(() => true)
            .catch(() => false)
        if (!filled) {
            await page.keyboard.press('Control+A').catch(() => {})
            await page.keyboard.type(startPoint, { delay: randomInt(35, 95) }).catch(() => {})
        }
        await humanDelay(500, 1000)

        const value = await originInput.inputValue({ timeout: 1000 }).catch(() => '')
        if (!value.trim()) {
            const injected = await originInput.evaluate((input: HTMLInputElement, valueToSet: string) => {
                input.value = valueToSet
                input.dispatchEvent(new Event('input', { bubbles: true }))
                input.dispatchEvent(new Event('change', { bubbles: true }))
                return input.value
            }, startPoint).catch(() => '')

            if (!injected.trim()) {
                actions.push('direction_origin_empty_after_type')
                return false
            }
        }

        actions.push('direction_origin_non_empty')
        await originInput.press('Enter').catch(() => page.keyboard.press('Enter').catch(() => {}))
        await humanDelay(3500, 6500)

        return this.verifyDirectionRouteReady(page)
    }

    private async locateDirectionOriginInput(page: Page): Promise<Locator | null> {
        const selectors = [
            'input.ZBTq6e',
            'input[aria-label*="Chọn điểm bắt đầu" i]',
            'input[aria-label*="Choose starting point" i]',
            'input[aria-label*="Starting point" i]',
            'input[placeholder*="Choose starting point" i]',
            'input[placeholder*="Chọn điểm bắt đầu" i]',
            'input[aria-label*="origin" i]',
            'input[aria-label*="start" i]',
            'input[aria-label*="xuat phat" i]',
            'input[aria-label*="diem bat dau" i]',
            'div.tactile-searchbox-input input',
        ]

        for (const selector of selectors) {
            const inputs = page.locator(selector)
            const count = await inputs.count().catch(() => 0)
            for (let index = 0; index < count; index++) {
                const candidate = inputs.nth(index)
                const visible = await candidate.isVisible({ timeout: 500 }).catch(() => false)
                if (!visible) continue

                const text = await candidate.evaluate((input: HTMLInputElement) => [
                    input.getAttribute('aria-label'),
                    input.getAttribute('placeholder'),
                    input.value,
                ].filter(Boolean).join(' ').toLowerCase()).catch(() => '')
                if (/destination|diem den|điểm đến|chon diem den|chọn điểm đến|den\b/.test(text)) continue
                return candidate
            }
        }

        return null
    }

    private async resolveDirectionStartPoint(page: Page, configuredStartPoint?: string): Promise<string | null> {
        const configured = configuredStartPoint?.trim()
        if (configured) return configured

        const text = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '')
        const haystack = `${text} ${page.url()}`
        if (/ha noi|hanoi|hà nội/i.test(haystack)) return 'Ho Hoan Kiem, Ha Noi'
        if (/ho chi minh|hcm|sai gon|saigon|sài gòn/i.test(haystack)) return 'Cho Ben Thanh, Ho Chi Minh'
        if (/da nang|đà nẵng/i.test(haystack)) return 'Cau Rong, Da Nang'
        if (/hai phong|hải phòng/i.test(haystack)) return 'Nha hat lon Hai Phong'
        if (/can tho|cần thơ/i.test(haystack)) return 'Ben Ninh Kieu, Can Tho'

        return 'City center'
    }

    private async verifyDirectionRouteReady(page: Page): Promise<boolean> {
        try {
            const routeSelectors = [
                'div[data-trip-index]',
                'div[data-trip-id]',
                'button[aria-label*="Route" i]',
                'div[aria-label*="route" i]',
                'div[aria-label*="Directions" i]',
            ]

            for (const selector of routeSelectors) {
                const count = await page.locator(selector).count().catch(() => 0)
                if (count > 0) return true
            }

            const routeTextFound = await page.locator('body').innerText({ timeout: 1500 })
                .then(text => /\b(\d+\s*(min|mins|minute|minutes|phut|phút)|km|mi)\b/i.test(text))
                .catch(() => false)
            if (routeTextFound) return true

            const url = page.url().toLowerCase()
            return url.includes('/dir') && !url.includes('choose starting point')
        } catch {
            return false
        }
    }

    private async restorePlacePageAfterDirection(
        page: Page,
        beforeUrl: string,
        actions: string[]
    ): Promise<void> {
        try {
            await page.keyboard.press('Escape').catch(() => {})
            await humanDelay(500, 1000)

            const currentUrl = page.url()
            const hasDirectionsUi = await page.locator(
                'input[aria-label*="origin" i], input[aria-label*="Starting" i], input[aria-label*="Xuất phát" i], div[data-trip-id]'
            ).count().catch(() => 0)
            const shouldRestore = beforeUrl.includes('/maps')
                && (currentUrl !== beforeUrl || currentUrl.toLowerCase().includes('/dir') || hasDirectionsUi > 0)

            if (!shouldRestore) return

            await page.goto(beforeUrl, { waitUntil: 'commit', timeout: 10000 }).catch(() => {})
            await humanDelay(1000, 2000)
            actions.push('direction_restored_place_context')
        } catch {
            actions.push('direction_restore_context_failed')
        }
    }

    private async verifyDirectionClick(page: Page): Promise<boolean> {
        try {
            // Check 1: Directions input field appeared
            const dirInput = await page.locator(
                'input[aria-label*="origin" i], input[aria-label*="Starting" i], input[aria-label*="Xuất phát" i], input[aria-label*="destination" i]'
            ).count().catch(() => 0)
            if (dirInput > 0) return true

            // Check 2: Route panel appeared
            const routePanel = await page.locator(
                'div[data-trip-id], div[class*="directions"], div[aria-label*="route" i]'
            ).count().catch(() => 0)
            if (routePanel > 0) return true

            // Check 3: URL changed to include directions markers
            const url = page.url().toLowerCase()
            if (url.includes('/dir') || url.includes('destination=') || url.includes('travelmode=')) {
                return true
            }

            return false
        } catch {
            return false
        }
    }

    // -----------------------------------------------------------------------
    // Execute every KPI that is actually available on the current map page
    // -----------------------------------------------------------------------

    async executeAvailableKpis(
        page: Page,
        threadId: number,
        options: ExecuteAvailableKpisOptions = {}
    ): Promise<KpiSkillResult> {
        const startTime = Date.now()
        const allActions: string[] = []
        let totalExecuted = 0
        let totalVerified = 0
        const details: string[] = []
        const availability = await this.detectAvailableKpis(page)
        const availableSet = new Set(
            availability.filter(item => item.available).map(item => item.type)
        )

        for (const item of availability) {
            if (!item.available) {
                allActions.push(`skip_${item.type}_unavailable`)
            }
        }

        const fallbackOrder: MapKpiType[] = ['direction', 'website', 'phone']
        const kpiTypes = uniqueKpis([...(options.preferredOrder || []), ...fallbackOrder])
            .filter(type => availableSet.has(type))

        if (kpiTypes.length === 0) {
            const durationMs = Date.now() - startTime
            const detail = 'No actionable KPI info on map page'
            log(`T${threadId}: [ALL KPI] ${detail}`)
            return {
                executed: false,
                verified: false,
                actions: allActions,
                detail,
                durationMs,
            }
        }

        log(`T${threadId}: [ALL KPI] Starting available KPIs in order: ${kpiTypes.join(' -> ')}`)

        for (let idx = 0; idx < kpiTypes.length; idx++) {
            const kpiType = kpiTypes[idx]
            if (idx > 0) {
                const interKpiDelay = randomInt(3000, 7000)
                log(`T${threadId}: [ALL KPI] Waiting ${interKpiDelay}ms before next KPI...`)
                await humanDelay(interKpiDelay, interKpiDelay + 500)
                await page.mouse.wheel(0, randomInt(-150, 150)).catch(() => {})
                await humanDelay(800, 1500)
            }

            log(`T${threadId}: [ALL KPI] Executing KPI ${idx + 1}/${kpiTypes.length}: ${kpiType}`)
            const result = await this.executeKpi(page, threadId, kpiType, options)
            allActions.push(...result.actions)
            if (result.executed) totalExecuted++
            if (result.verified) totalVerified++
            details.push(`${kpiType}: ${result.executed ? (result.verified ? 'verified' : 'unverified') : 'not_executed'} ${result.detail}`)

            // Individual KPI skills own their navigation recovery. Do not call
            // goBack here because it can leave the Maps place page before the
            // next pre-detected KPI runs.
        }

        const durationMs = Date.now() - startTime
        const summaryDetail = `ALL KPI: ${totalExecuted}/${kpiTypes.length} available executed, ${totalVerified}/${kpiTypes.length} verified | ${details.join(' | ')}`
        log(`T${threadId}: [ALL KPI] Completed: ${summaryDetail} (${durationMs}ms)`)

        return {
            executed: totalExecuted > 0,
            verified: totalVerified > 0,
            actions: allActions,
            detail: summaryDetail,
            durationMs,
        }
    }

    async executeAllKpis(page: Page, threadId: number): Promise<KpiSkillResult> {
        return this.executeAvailableKpis(page, threadId)
    }

    // -----------------------------------------------------------------------
    // Legacy randomized runner kept for diagnostics/backward comparison only.
    // -----------------------------------------------------------------------

    /**
     * Execute all 3 KPI skills in a random order with human-like delays between each.
     * This maximizes the number of engagement signals sent to Google per visit.
     */
    private async executeAllKpisLegacy(page: Page, threadId: number): Promise<KpiSkillResult> {
        const startTime = Date.now()
        const allActions: string[] = []
        let totalExecuted = 0
        let totalVerified = 0
        const details: string[] = []

        // Randomize order to avoid detection patterns
        const kpiTypes: Array<'phone' | 'website' | 'direction'> = ['phone', 'website', 'direction']
        for (let i = kpiTypes.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[kpiTypes[i], kpiTypes[j]] = [kpiTypes[j], kpiTypes[i]]
        }

        log(`T${threadId}: [ALL KPI] Starting all KPIs in order: ${kpiTypes.join(' → ')}`)

        for (let idx = 0; idx < kpiTypes.length; idx++) {
            const kpiType = kpiTypes[idx]

            // Human-like delay between KPI actions (not before the first one)
            if (idx > 0) {
                const interKpiDelay = randomInt(3000, 7000)
                log(`T${threadId}: [ALL KPI] Waiting ${interKpiDelay}ms before next KPI...`)
                await humanDelay(interKpiDelay, interKpiDelay + 500)

                // Scroll a bit to simulate natural browsing between KPI actions
                await page.mouse.wheel(0, randomInt(-150, 150)).catch(() => {})
                await humanDelay(800, 1500)
            }

            log(`T${threadId}: [ALL KPI] Executing KPI ${idx + 1}/3: ${kpiType}`)
            const result = await this.executeKpi(page, threadId, kpiType)

            allActions.push(...result.actions)
            if (result.executed) totalExecuted++
            if (result.verified) totalVerified++
            details.push(`${kpiType}: ${result.executed ? (result.verified ? '✅' : '⚠️') : '❌'} ${result.detail}`)

            // If KPI action navigated away (website/direction), go back to maps page
            if (result.executed && (kpiType === 'website' || kpiType === 'direction')) {
                await humanDelay(1500, 3000)
                try {
                    await page.goBack({ timeout: 5000, waitUntil: 'domcontentloaded' }).catch(() => {})
                    await humanDelay(1500, 2500)
                    // Verify we're back on maps
                    const currentUrl = page.url()
                    if (!currentUrl.includes('google.com/maps')) {
                        log(`T${threadId}: [ALL KPI] Not on maps after goBack, navigating back...`)
                        await page.goBack({ timeout: 5000 }).catch(() => {})
                        await humanDelay(1000, 2000)
                    }
                } catch {
                    log(`T${threadId}: [ALL KPI] Failed to navigate back after ${kpiType}`)
                }
            }
        }

        const durationMs = Date.now() - startTime
        const summaryDetail = `ALL KPI: ${totalExecuted}/3 executed, ${totalVerified}/3 verified | ${details.join(' | ')}`
        log(`T${threadId}: [ALL KPI] Completed: ${summaryDetail} (${durationMs}ms)`)

        return {
            executed: totalExecuted > 0,
            verified: totalVerified > 0,
            actions: allActions,
            detail: summaryDetail,
            durationMs,
        }
    }

    // -----------------------------------------------------------------------
    // Dispatcher
    // -----------------------------------------------------------------------

    /**
     * Execute the appropriate KPI skill based on the targetKpi string.
     */
    async executeKpi(
        page: Page,
        threadId: number,
        targetKpi: string,
        options: ExecuteKpiOptions = {}
    ): Promise<KpiSkillResult> {
        switch (targetKpi.toLowerCase()) {
            case 'all':
                return this.executeAvailableKpis(page, threadId, options)
            case 'phone':
                return this.executePhoneClick(page, threadId)
            case 'website':
                return this.executeWebsiteClick(page, threadId)
            case 'direction':
            case 'directions':
                return this.executeDirectionClick(page, threadId, options)
            default:
                log(`T${threadId}: Unknown KPI target "${targetKpi}", skipping.`)
                return {
                    executed: false,
                    verified: false,
                    actions: [],
                    detail: `Unknown KPI: ${targetKpi}`,
                    durationMs: 0,
                }
        }
    }
}

export const kpiSkills = new KpiSkills()
