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

export type OrganicAction = 'directions' | 'call' | 'website' | 'share' | 'view_photos' | 'view_reviews' | 'view_menu' | 'save_place' | 'browse_questions' | 'view_nearby' | 'view_street_view' | 'search_interactions'

export interface OrganicFlowResult {
    success: boolean
    foundMap: boolean
    actionsPerformed: { action: string; success: boolean }[]
    searchKeyword: string
    message: string
}

// Status callback for live monitoring
type StatusCallback = (status: string) => void

// ============================================================
// Organic Search Flow
// ============================================================

export class OrganicSearchFlow {
    private onStatus: StatusCallback

    constructor(onStatus?: StatusCallback) {
        this.onStatus = onStatus || (() => { })
    }

    private async resolveUnexpectedPrompt(page: Page, reason: string): Promise<void> {
        const recovered = await contextualInterruptionResolver.resolve(page, {
            reason: `organic_${reason}`,
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 2,
            goal: 'map_interaction',
            campaignType: 'organic',
            domain: page.url(),
        }).catch(() => ({ handled: false }))

        if (recovered.handled) {
            this.onStatus(`Da xu ly prompt bat ngo (${reason})`)
            await HumanBehavior.randomDelay(120, 320)
        }
    }

    /**
     * Execute the full organic search flow:
     * 1. Open google.com.vn
     * 2. Search keyword
     * 3. Find target map in results
     * 4. Click into map listing
     * 5. Perform contextual actions (directions, call, website, etc.)
     * 6. Return to map listing page
     */
    async execute(page: Page, keyword: string, location: LocationInfo, isLoggedIn: boolean = false): Promise<OrganicFlowResult> {
        const result: OrganicFlowResult = {
            success: false,
            foundMap: false,
            actionsPerformed: [],
            searchKeyword: keyword,
            message: '',
        }

        try {
            // Step 1: Search on Google
            this.onStatus(`Đang tìm kiếm: "${keyword}"`)
            const searchOk = await this.searchOnGoogle(page, keyword)
            if (!searchOk) {
                result.message = 'Failed to search on Google'
                return result
            }

            await HumanBehavior.randomDelay(2000, 4000)
            await this.resolveUnexpectedPrompt(page, 'after_search')

            // Step 2: Find and click the target map
            this.onStatus(`Đang tìm map: ${location.name}`)
            const found = await this.findAndClickTargetMap(page, location)
            if (!found) {
                result.message = `Map "${location.name}" not found in search results`
                return result
            }
            result.foundMap = true

            await HumanBehavior.randomDelay(3000, 6000)
            await this.resolveUnexpectedPrompt(page, 'after_open_target')

            // Step 3: Perform contextual actions (filtered by login status)
            this.onStatus(`Đang thực hiện SEO actions...`)
            const actions = await this.performContextualActions(page, location, isLoggedIn)
            result.actionsPerformed = actions

            // Step 4: Ensure we're back on the map page
            this.onStatus(`Đang quay lại trang map...`)
            await this.ensureOnMapPage(page, location)
            await this.resolveUnexpectedPrompt(page, 'before_finish')

            await HumanBehavior.randomDelay(2000, 4000)

            result.success = true
            result.message = `Completed ${actions.length} contextual actions`
            return result
        } catch (error) {
            result.message = `Error: ${error instanceof Error ? error.message : String(error)}`
            return result
        }
    }

    // ============================================================
    // Step 1: Search on Google
    // ============================================================

    private async searchOnGoogle(page: Page, keyword: string): Promise<boolean> {
        try {
            // Navigate to google.com.vn
            await page.goto('https://www.google.com.vn', {
                waitUntil: 'commit',
                timeout: 30000,
            })
            await HumanBehavior.randomDelay(1500, 3000)
            await this.resolveUnexpectedPrompt(page, 'search_landing')

            // Accept cookies/consent if present
            try {
                const consentBtn = await page.$('button:has-text("Accept all"), button:has-text("Đồng ý"), button:has-text("Accept"), button:has-text("I agree")')
                if (consentBtn) {
                    await consentBtn.click()
                    await HumanBehavior.randomDelay(500, 1000)
                }
            } catch { /* no consent dialog */ }
            await this.resolveUnexpectedPrompt(page, 'search_after_consent')

            // Click on search box and type keyword naturally
            const searchSelector = 'textarea[name="q"], input[name="q"]'
            await HumanBehavior.humanClick(page, searchSelector)
            await HumanBehavior.randomDelay(300, 700)

            await HumanBehavior.humanType(page, searchSelector, keyword)
            await HumanBehavior.randomDelay(800, 1500)

            // Press Enter to search
            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
            await HumanBehavior.randomDelay(2000, 4000)
            await this.resolveUnexpectedPrompt(page, 'search_results')

            // Simulate reading search results
            await HumanBehavior.randomScroll(page, 2)
            await HumanBehavior.randomDelay(1000, 2000)

            return true
        } catch (error) {
            console.error('[OrganicSearch] Failed to search:', error)
            return false
        }
    }

    // ============================================================
    // Step 2: Find and click target map in search results
    // ============================================================

    private async findAndClickTargetMap(page: Page, location: LocationInfo): Promise<boolean> {
        const maxScrollAttempts = 5

        for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
            await this.resolveUnexpectedPrompt(page, `find_target_attempt_${attempt + 1}`)

            // Strategy 1: Look in Local Pack / Maps section (the map widget in Google results)
            const foundInLocalPack = await this.findInLocalPack(page, location)
            if (foundInLocalPack) return true

            // Strategy 2: Look for map-related links in organic results
            const foundInOrganic = await this.findInOrganicResults(page, location)
            if (foundInOrganic) return true

            // Strategy 3: Click "More places" / "Xem thêm" if available
            try {
                const morePlaces = await page.$('a:has-text("More places"), a:has-text("Xem thêm địa điểm"), a:has-text("More results")')
                if (morePlaces) {
                    await morePlaces.click()
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 })
                    await HumanBehavior.randomDelay(2000, 3000)
                    continue
                }
            } catch { /* ignore */ }

            // Scroll down to load more results
            this.onStatus(`Đang cuộn tìm map (lần ${attempt + 1}/${maxScrollAttempts})...`)
            await HumanBehavior.randomScroll(page, 3)
            await HumanBehavior.randomDelay(1500, 3000)
        }

        // Last resort: Try clicking "Maps" tab on Google
        try {
            const mapsTab = await page.$('a[data-hveid]:has-text("Maps"), a:has-text("Bản đồ"), div[role="listitem"] a:has-text("Maps")')
            if (mapsTab) {
                this.onStatus('Đang chuyển sang tab Maps...')
                await mapsTab.click()
                await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
                await HumanBehavior.randomDelay(2000, 4000)

                // Now in Maps tab, find the target
                return await this.findInMapsTab(page, location)
            }
        } catch { /* ignore */ }

        return false
    }

    /**
     * Find target in Google Local Pack (the map + 3 businesses widget)
     */
    private async findInLocalPack(page: Page, location: LocationInfo): Promise<boolean> {
        try {
            // Google Local Pack contains business listings — search for matching names
            const localResults = await page.$$('div[data-cid], div.VkpGBb, div[jscontroller] a[data-cid], div.rllt__details, div[class*="local"] a')

            for (const el of localResults) {
                const text = await el.textContent().catch(() => '')
                if (text && this.isMatchingLocationLegacy(text, location)) {
                    this.onStatus(`Tìm thấy map trong Local Pack!`)

                    // Try to find the clickable link/title within this element
                    const link = await el.$('a[href*="maps"], a[href*="place"], a[data-cid]')
                    if (link) {
                        await link.click()
                    } else {
                        await el.click()
                    }

                    await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
                    await HumanBehavior.randomDelay(2000, 4000)

                    // VERIFY after click; back+continue if wrong map
                    if (await HumanBehavior.verifyOnTargetMap(page, location).catch(() => false)) return true
                    await page.goBack().catch(() => {})
                    await HumanBehavior.randomDelay(800, 1500)
                    continue
                }
            }

            // Also check for the "place cards" directly
            const placeCards = await page.$$('a[href*="maps/place"], a[href*="/maps?"], div[data-attrid*="place"]')
            for (const card of placeCards) {
                const text = await card.textContent().catch(() => '')
                const href = await card.getAttribute('href').catch(() => '')
                if (
                    (text && this.isMatchingLocation(text, location, href)) ||
                    (href && location.placeId && href.includes(location.placeId))
                ) {
                    this.onStatus(`Tìm thấy map qua place card!`)
                    await card.click()
                    await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
                    await HumanBehavior.randomDelay(2000, 4000)

                    if (await HumanBehavior.verifyOnTargetMap(page, location).catch(() => false)) return true
                    await page.goBack().catch(() => {})
                    await HumanBehavior.randomDelay(800, 1500)
                    continue
                }
            }
        } catch (error) {
            console.error('[OrganicSearch] Error finding in local pack:', error)
        }
        return false
    }

    /**
     * Find target in organic Google search results (links to Google Maps)
     */
    private async findInOrganicResults(page: Page, location: LocationInfo): Promise<boolean> {
        try {
            // Search organic results for maps.google links containing the business name
            const allLinks = await page.$$('div#search a[href*="google.com/maps"], div#search a[href*="maps.google"], a[href*="place/"]')

            for (const link of allLinks) {
                const href = await link.getAttribute('href').catch(() => '')
                const text = await link.textContent().catch(() => '')

                if (
                    (text && this.isMatchingLocation(text, location, href)) ||
                    (href && location.placeId && href.includes(location.placeId))
                ) {
                    this.onStatus(`Tìm thấy map trong kết quả organic!`)
                    await link.click()
                    await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
                    await HumanBehavior.randomDelay(2000, 4000)

                    if (await HumanBehavior.verifyOnTargetMap(page, location).catch(() => false)) return true
                    await page.goBack().catch(() => {})
                    await HumanBehavior.randomDelay(800, 1500)
                    return false
                }
            }
        } catch (error) {
            console.error('[OrganicSearch] Error finding in organic results:', error)
        }
        return false
    }

    /**
     * Find target after switching to Google Maps tab
     */
    private async findInMapsTab(page: Page, location: LocationInfo): Promise<boolean> {
        try {
            await HumanBehavior.randomScroll(page, 2)
            await HumanBehavior.randomDelay(1500, 2500)

            // In Maps tab, results appear as place listings
            const mapResults = await page.$$('div[role="article"], div.Nv2PK, a[href*="maps/place"], div[jsaction] a[data-cid]')

            for (const result of mapResults) {
                const text = await result.textContent().catch(() => '')
                if (text && this.isMatchingLocationLegacy(text, location)) {
                    this.onStatus(`Tìm thấy map trong tab Maps!`)

                    const link = await result.$('a')
                    if (link) {
                        await link.click()
                    } else {
                        await result.click()
                    }

                    await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
                    await HumanBehavior.randomDelay(2000, 4000)

                    if (await HumanBehavior.verifyOnTargetMap(page, location).catch(() => false)) return true
                    await page.goBack().catch(() => {})
                    await HumanBehavior.randomDelay(800, 1500)
                    return false
                }
            }
        } catch (error) {
            console.error('[OrganicSearch] Error finding in Maps tab:', error)
        }
        return false
    }

    // ============================================================
    // Step 3: Perform contextual actions on the map page
    // ============================================================

    /**
     * Detect available actions on the map listing and perform 1-3 random ones
     */
    private async performContextualActions(page: Page, location: LocationInfo, isLoggedIn: boolean = false): Promise<{ action: string; success: boolean }[]> {
        const performed: { action: string; success: boolean }[] = []
        const availableActions: OrganicAction[] = []

        // Detect what's available on the page
        const hasDirections = await page.$('button[data-value="Directions"], button[data-value="Chỉ đường"], button[aria-label*="Direction"], button[aria-label*="Chỉ đường"], a[data-value="Directions"]').catch(() => null)
        const hasPhone = await page.$('button[data-tooltip*="phone"], button[data-tooltip*="điện thoại"], a[data-tooltip*="Call"], button[aria-label*="Call"], a[href^="tel:"], button[data-item-id*="phone"]').catch(() => null)
        const hasWebsite = await page.$('a[data-value="Website"], a[data-item-id*="authority"], a[aria-label*="Website"], a[data-tooltip*="website"], a[data-tooltip*="Open website"]').catch(() => null)
        const hasPhotos = await page.$('button[aria-label*="photo" i], button[aria-label*="ảnh" i], button[data-tab-id="photos"], a[aria-label*="All photos"]').catch(() => null)
        const hasReviews = await page.$('button[aria-label*="review" i], button[aria-label*="đánh giá" i], button[data-tab-id="reviews"]').catch(() => null)
        const hasMenu = await page.$('button[aria-label*="Menu" i], button[aria-label*="Thực đơn" i], button[data-tab-id="menu"], a:has-text("Menu"), a:has-text("Thực đơn")').catch(() => null)
        const hasNearby = await page.$('div[data-section-id="relatives"], div:has-text("People also search"), div:has-text("Mọi người cũng tìm")').catch(() => null)

        // These actions are SAFE for anonymous (no login required)
        if (hasDirections) availableActions.push('directions')
        if (hasPhone) availableActions.push('call')
        if (hasWebsite) availableActions.push('website')
        if (hasPhotos) availableActions.push('view_photos')
        if (hasReviews) availableActions.push('view_reviews')
        if (hasMenu) availableActions.push('view_menu')
        if (hasNearby) availableActions.push('view_nearby')
        availableActions.push('browse_questions')
        availableActions.push('view_street_view')

        // These actions REQUIRE Google login — only add if logged in
        if (isLoggedIn) {
            const hasShare = await page.$('button[data-value="Share"], button[aria-label*="Share"], button[aria-label*="Chia sẻ"], button[data-value="Chia sẻ"]').catch(() => null)
            const hasSave = await page.$('button[data-value="Save"], button[aria-label*="Save" i], button[aria-label*="Lưu" i], button[data-value="Lưu"]').catch(() => null)
            if (hasShare) availableActions.push('share')
            if (hasSave) availableActions.push('save_place')
        }

        this.onStatus(`Phát hiện ${availableActions.length} actions: ${availableActions.join(', ')}`)

        if (availableActions.length === 0) {
            performed.push({ action: 'browse_naturally', success: true })
            await HumanBehavior.randomScroll(page, 3)
            await HumanBehavior.randomDelay(3000, 6000)
            return performed
        }

        // Randomly select 2-5 actions (increased from 1-3)
        const shuffled = [...availableActions].sort(() => Math.random() - 0.5)
        const numActions = Math.min(
            shuffled.length,
            HumanBehavior.getRandomDelay(2, Math.min(5, shuffled.length))
        )
        const selectedActions = shuffled.slice(0, numActions)

        const mapPageUrl = page.url()

        for (const action of selectedActions) {
            this.onStatus(`Dang thuc hien: ${this.getActionLabel(action)}`)
            await this.resolveUnexpectedPrompt(page, `before_action_${action}`)
            try {
                switch (action) {
                    case 'directions': await this.actionGetDirections(page); break
                    case 'call': await this.actionClickCall(page); break
                    case 'website': await this.actionBrowseWebsite(page, location); break
                    case 'share': await this.actionShare(page); break
                    case 'view_photos': await this.actionViewPhotos(page); break
                    case 'view_reviews': await this.actionViewReviews(page); break
                    case 'view_menu': await this.actionViewMenu(page); break
                    case 'save_place': await this.actionSavePlace(page); break
                    case 'browse_questions': await this.actionBrowseQuestions(page); break
                    case 'view_nearby': await this.actionViewNearby(page, location); break
                    case 'view_street_view': await this.actionViewStreetView(page); break
                    case 'search_interactions': break // handled in search page
                }

                // After each action, check if a login popup appeared and close it
                await this.dismissLoginPopup(page)

                performed.push({ action, success: true })
            } catch (error) {
                console.error(`[OrganicSearch] Action ${action} failed:`, error)
                // Try dismiss login popup in case it caused the error
                await this.dismissLoginPopup(page)
                performed.push({ action, success: false })
            }

            await this.resolveUnexpectedPrompt(page, `after_action_${action}`)
            await this.ensureOnMapPage(page, location, mapPageUrl)
            await HumanBehavior.randomDelay(2000, 4000)
        }

        return performed
    }

    // ============================================================
    // Login Popup Detection & Dismissal
    // ============================================================

    /**
     * Detect if we landed on a Google login page and go back
     */
    private async dismissLoginPopup(page: Page) {
        try {
            const currentUrl = page.url()
            if (currentUrl.includes('accounts.google.com') ||
                currentUrl.includes('/signin') ||
                currentUrl.includes('/ServiceLogin') ||
                currentUrl.includes('consent.google.com')) {
                console.log('[OrganicSearch] Login popup detected, navigating back...')
                this.onStatus('Phát hiện trang đăng nhập, bỏ qua...')
                await page.goBack({ timeout: 10000 }).catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch { /* ignore */ }
    }

    // ============================================================
    // Contextual Action Implementations
    // ============================================================

    /**
     * Click Directions, enter a fake starting point, view route, then go back
     */
    private async actionGetDirections(page: Page) {
        const directionsBtn = await page.$('button[data-value="Directions"], button[data-value="Chỉ đường"], button[aria-label*="Direction"], button[aria-label*="Chỉ đường"], a[data-value="Directions"]')
        if (!directionsBtn) throw new Error('No directions button')

        await directionsBtn.click()
        await HumanBehavior.randomDelay(2000, 4000)

        // Look for the starting point input and enter a generic location
        try {
            const startInput = await page.$('input[aria-label*="Starting point"], input[aria-label*="Điểm bắt đầu"], input[aria-label*="Choose starting point"], div.tactile-searchbox-input input')
            if (startInput) {
                const fakeStarts = [
                    'Hà Nội', 'Sài Gòn', 'Đà Nẵng', 'Huế', 'Nha Trang',
                    'Bến xe', 'Sân bay', 'Ga tàu', 'Trung tâm thành phố',
                    'My location', 'Bệnh viện', 'Trường học', 'Chợ'
                ]
                const fakeStart = fakeStarts[Math.floor(Math.random() * fakeStarts.length)]

                await startInput.click()
                await HumanBehavior.randomDelay(500, 1000)
                await startInput.fill(fakeStart)
                await HumanBehavior.randomDelay(500, 1000)
                await page.keyboard.press('Enter')
                await HumanBehavior.randomDelay(3000, 5000)
            }
        } catch { /* ignore input errors */ }

        // Browse the directions result
        await HumanBehavior.randomScroll(page, 2)
        await HumanBehavior.randomDelay(2000, 4000)

        // Look at different route options if available
        try {
            const routeOptions = await page.$$('div[data-trip-index], button[aria-label*="Route"]')
            if (routeOptions.length > 1) {
                const randomRoute = routeOptions[Math.floor(Math.random() * routeOptions.length)]
                await randomRoute.click()
                await HumanBehavior.randomDelay(1500, 3000)
            }
        } catch { /* ignore */ }

        // Wait a bit more as if reading
        await HumanBehavior.randomDelay(2000, 4000)
    }

    /**
     * Click on the phone number / call button
     */
    private async actionClickCall(page: Page) {
        const phoneBtn = await page.$('button[data-tooltip*="phone"], button[data-tooltip*="điện thoại"], a[data-tooltip*="Call"], button[aria-label*="Call"], a[href^="tel:"], button[data-item-id*="phone"]')
        if (!phoneBtn) throw new Error('No phone button')

        await phoneBtn.click()
        await HumanBehavior.randomDelay(1500, 3000)

        // Just "viewed" the phone number — simulate reading it
        await HumanBehavior.randomDelay(2000, 4000)

        // Close any popup
        try {
            const closeBtn = await page.$('button[aria-label="Close"], button[aria-label="Đóng"], button[jsaction*="close"]')
            if (closeBtn) {
                await closeBtn.click()
                await HumanBehavior.randomDelay(500, 1000)
            }
        } catch { /* ignore */ }
    }

    /**
     * Click the website link, browse it naturally, then come back
     */
    private async actionBrowseWebsite(page: Page, location: LocationInfo) {
        const websiteLink = await page.$('a[data-value="Website"], a[data-item-id*="authority"], a[aria-label*="Website"], a[data-tooltip*="website"], a[data-tooltip*="Open website"]')
        if (!websiteLink) throw new Error('No website link')

        // Save map URL to return to
        const mapUrl = page.url()

        await websiteLink.click()
        await HumanBehavior.randomDelay(3000, 6000)

        // Browse the website naturally
        this.onStatus('Đang lướt website...')

        // Wait for page to load
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
        } catch { /* timeout ok */ }

        // Check if redirected to login page
        if (page.url().includes('accounts.google.com')) {
            this.onStatus('Bỏ qua login, quay lại map...')
            await page.goBack({ timeout: 10000 }).catch(() => { })
            await HumanBehavior.randomDelay(1000, 2000)
            return
        }

        // Simulate reading the website
        await HumanBehavior.randomScroll(page, 3)
        await HumanBehavior.randomDelay(3000, 5000)

        // Maybe click a random link on the website
        try {
            const navLinks = await page.$$('nav a, header a, .menu a, a[href^="/"]')
            if (navLinks.length > 0 && Math.random() > 0.4) {
                const randomLink = navLinks[Math.floor(Math.random() * Math.min(navLinks.length, 5))]
                const href = await randomLink.getAttribute('href')
                if (href && !href.startsWith('http')) {
                    await randomLink.click()
                    await HumanBehavior.randomDelay(3000, 5000)
                    await HumanBehavior.randomScroll(page, 2)
                    await HumanBehavior.randomDelay(2000, 4000)
                }
            }
        } catch { /* ignore navigation errors */ }

        // Browse a bit more
        await HumanBehavior.randomDelay(3000, 6000)

        // Return to map page
        this.onStatus('Quay lại map sau khi lướt web...')
        try {
            await page.goBack({ timeout: 10000 })
            await HumanBehavior.randomDelay(1000, 2000)
            // If still not on maps, try going back more
            if (!page.url().includes('google.com/maps')) {
                await page.goBack({ timeout: 10000 }).catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch {
            // Fallback: navigate directly to map
            await page.goto(mapUrl, { waitUntil: 'commit', timeout: 15000 }).catch(() => { })
            await HumanBehavior.randomDelay(1000, 2000)
        }
    }

    /**
     * Click Share button and interact with share dialog
     */
    private async actionShare(page: Page) {
        const shareBtn = await page.$('button[data-value="Share"], button[aria-label*="Share"], button[aria-label*="Chia sẻ"], button[data-value="Chia sẻ"]')
        if (!shareBtn) throw new Error('No share button')

        await shareBtn.click()
        await HumanBehavior.randomDelay(2000, 3000)

        // Look at the share dialog
        try {
            // Maybe click "Copy link"
            const copyLink = await page.$('button:has-text("Copy link"), button:has-text("Sao chép liên kết"), button[aria-label*="Copy"]')
            if (copyLink && Math.random() > 0.5) {
                await copyLink.click()
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch { /* ignore */ }

        // Close share dialog
        try {
            const closeBtn = await page.$('button[aria-label="Close"], button[aria-label="Đóng"], button[jsaction*="close"], div[role="dialog"] button[aria-label="Close"]')
            if (closeBtn) {
                await closeBtn.click()
                await HumanBehavior.randomDelay(500, 1000)
            } else {
                await page.keyboard.press('Escape')
                await HumanBehavior.randomDelay(500, 1000)
            }
        } catch { /* ignore */ }
    }

    // ============================================================
    // NEW: Deep Photo Browsing
    // ============================================================

    private async actionViewPhotos(page: Page) {
        // Click photos tab/button
        const photosBtn = await page.$('button[aria-label*="photo" i], button[aria-label*="ảnh" i], button[data-tab-id="photos"], a[aria-label*="All photos"]')
        if (!photosBtn) {
            // Try clicking on the main photo area
            const heroPhoto = await page.$('img[decoding="async"][src*="googleusercontent"], button[jsaction*="photos"], div[class*="hero"] img')
            if (heroPhoto) await heroPhoto.click()
            else throw new Error('No photos access')
        } else {
            await photosBtn.click()
        }
        await HumanBehavior.randomDelay(2000, 4000)

        // Scroll through photo gallery
        const scrollCount = HumanBehavior.getRandomDelay(3, 6)
        for (let i = 0; i < scrollCount; i++) {
            await HumanBehavior.randomScroll(page, 1)
            await HumanBehavior.randomDelay(800, 1500)
        }

        // Click a random photo thumbnail
        try {
            const thumbnails = await page.$$('a[data-photo-index], div[data-photo-index], button[data-photo-index], div[role="img"], img[src*="googleusercontent"]')
            if (thumbnails.length > 0) {
                const idx = Math.floor(Math.random() * Math.min(thumbnails.length, 12))
                await thumbnails[idx].click()
                await HumanBehavior.randomDelay(2000, 4000)

                // Browse through photos using arrow keys or next button
                const numPhotos = HumanBehavior.getRandomDelay(2, 5)
                for (let i = 0; i < numPhotos; i++) {
                    // Try next button first, then arrow key
                    try {
                        const nextBtn = await page.$('button[aria-label*="Next" i], button[aria-label*="Tiếp" i], button[jsaction*="forward"]')
                        if (nextBtn) await nextBtn.click()
                        else await page.keyboard.press('ArrowRight')
                    } catch { await page.keyboard.press('ArrowRight') }
                    await HumanBehavior.randomDelay(1500, 3500)

                    // 40% chance to zoom in
                    if (Math.random() > 0.6) {
                        try {
                            const zoomBtn = await page.$('button[aria-label*="Zoom" i], button[aria-label*="Phóng" i]')
                            if (zoomBtn) {
                                await zoomBtn.click()
                                await HumanBehavior.randomDelay(1500, 3000)
                                // Zoom back
                                await zoomBtn.click()
                                await HumanBehavior.randomDelay(500, 1000)
                            }
                        } catch { /* ignore */ }
                    }
                }

                // Close photo viewer
                try {
                    const closeBtn = await page.$('button[aria-label="Close" i], button[aria-label="Đóng" i], button[jsaction*="close"], button[aria-label="Back" i]')
                    if (closeBtn) await closeBtn.click()
                    else await page.keyboard.press('Escape')
                } catch { await page.keyboard.press('Escape') }
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch { /* ignore photo click errors */ }

        // Try clicking photo category tabs (All, Menu, Interior, etc.)
        try {
            const categoryTabs = await page.$$('button[role="tab"][data-tab-id], div[role="tablist"] button')
            if (categoryTabs.length > 1) {
                const randomTab = categoryTabs[Math.floor(Math.random() * categoryTabs.length)]
                await randomTab.click()
                await HumanBehavior.randomDelay(2000, 3000)
                await HumanBehavior.randomScroll(page, 2)
                await HumanBehavior.randomDelay(1500, 3000)
            }
        } catch { /* ignore */ }
    }

    // ============================================================
    // NEW: Deep Review Reading
    // ============================================================

    private async actionViewReviews(page: Page) {
        const reviewsBtn = await page.$('button[aria-label*="review" i], button[aria-label*="đánh giá" i], button[data-tab-id="reviews"]')
        if (!reviewsBtn) throw new Error('No reviews button')
        await reviewsBtn.click()
        await HumanBehavior.randomDelay(2000, 4000)

        // Scroll through reviews
        const scrollCount = HumanBehavior.getRandomDelay(5, 10)
        for (let i = 0; i < scrollCount; i++) {
            await HumanBehavior.randomScroll(page, 1)
            await HumanBehavior.randomDelay(1000, 2500)
        }

        // Expand "More" on random reviews
        try {
            const moreButtons = await page.$$('button:has-text("More"), button:has-text("Thêm"), button[aria-label*="See more"], button[jsaction*="review.expandReview"]')
            const expandCount = Math.min(moreButtons.length, HumanBehavior.getRandomDelay(1, 3))
            for (let i = 0; i < expandCount; i++) {
                try {
                    await moreButtons[i].click()
                    await HumanBehavior.randomDelay(1000, 2000)
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        // 25% chance: Sort reviews
        if (Math.random() > 0.75) {
            try {
                const sortBtn = await page.$('button[aria-label*="Sort" i], button[aria-label*="Sắp xếp" i], button[data-value="Sort"]')
                if (sortBtn) {
                    await sortBtn.click()
                    await HumanBehavior.randomDelay(1000, 2000)
                    // Pick a random sort option
                    const sortOptions = await page.$$('div[role="menuitemradio"], li[role="menuitemradio"], div[role="option"]')
                    if (sortOptions.length > 1) {
                        const randomSort = sortOptions[Math.floor(Math.random() * sortOptions.length)]
                        await randomSort.click()
                        await HumanBehavior.randomDelay(2000, 3000)
                        await HumanBehavior.randomScroll(page, 3)
                        await HumanBehavior.randomDelay(2000, 4000)
                    }
                }
            } catch { /* ignore */ }
        }

        // Read for a bit longer
        await HumanBehavior.randomDelay(3000, 6000)

        // Go back to overview
        try {
            const overviewTab = await page.$('button[data-tab-id="overview"], button[aria-label*="Overview" i], button[aria-label*="Tổng quan" i]')
            if (overviewTab) {
                await overviewTab.click()
                await HumanBehavior.randomDelay(1000, 2000)
            }
        } catch { /* ignore */ }
    }

    // ============================================================
    // NEW: View Menu (restaurants)
    // ============================================================

    private async actionViewMenu(page: Page) {
        const menuBtn = await page.$('button[aria-label*="Menu" i], button[aria-label*="Thực đơn" i], button[data-tab-id="menu"], a:has-text("Menu"), a:has-text("Thực đơn")')
        if (!menuBtn) throw new Error('No menu button')
        await menuBtn.click()
        await HumanBehavior.randomDelay(2000, 4000)

        // Scroll through menu items
        const scrollCount = HumanBehavior.getRandomDelay(4, 8)
        for (let i = 0; i < scrollCount; i++) {
            await HumanBehavior.randomScroll(page, 1)
            await HumanBehavior.randomDelay(800, 2000)
        }

        // Click on food photos if available
        try {
            const menuPhotos = await page.$$('img[src*="googleusercontent"], div[role="img"]')
            if (menuPhotos.length > 0 && Math.random() > 0.4) {
                const photo = menuPhotos[Math.floor(Math.random() * Math.min(menuPhotos.length, 6))]
                await photo.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await page.keyboard.press('Escape')
                await HumanBehavior.randomDelay(500, 1000)
            }
        } catch { /* ignore */ }

        await HumanBehavior.randomDelay(2000, 4000)
    }

    // ============================================================
    // NEW: Save Place
    // ============================================================

    private async actionSavePlace(page: Page) {
        const saveBtn = await page.$('button[data-value="Save"], button[aria-label*="Save" i], button[aria-label*="Lưu" i], button[data-value="Lưu"]')
        if (!saveBtn) throw new Error('No save button')
        await saveBtn.click()
        await HumanBehavior.randomDelay(2000, 3000)

        // Pick a random save list
        try {
            const lists = await page.$$('div[role="menuitemcheckbox"], div[role="option"], li[data-index]')
            if (lists.length > 0) {
                const randomList = lists[Math.floor(Math.random() * lists.length)]
                await randomList.click()
                await HumanBehavior.randomDelay(1500, 3000)
            }
        } catch { /* ignore */ }

        // Close the save dialog
        try {
            const closeBtn = await page.$('button[aria-label="Close" i], button[aria-label="Đóng" i]')
            if (closeBtn) await closeBtn.click()
            else await page.keyboard.press('Escape')
        } catch { await page.keyboard.press('Escape') }
        await HumanBehavior.randomDelay(500, 1000)
    }

    // ============================================================
    // NEW: Browse Questions & Answers
    // ============================================================

    private async actionBrowseQuestions(page: Page) {
        // Scroll down to Q&A section
        await HumanBehavior.randomScroll(page, 5)
        await HumanBehavior.randomDelay(2000, 3000)

        // Look for Q&A elements
        try {
            const questions = await page.$$('div[data-question-id], div[jsaction*="questions"], button:has-text("See all questions"), a:has-text("Questions")')
            if (questions.length > 0) {
                const q = questions[Math.floor(Math.random() * Math.min(questions.length, 3))]
                await q.click()
                await HumanBehavior.randomDelay(2000, 4000)
                await HumanBehavior.randomScroll(page, 3)
                await HumanBehavior.randomDelay(3000, 5000)
            } else {
                // Just read the page content
                await HumanBehavior.randomScroll(page, 2)
                await HumanBehavior.randomDelay(2000, 4000)
            }
        } catch { /* ignore */ }
    }

    // ============================================================
    // NEW: View Nearby Places
    // ============================================================

    private async actionViewNearby(page: Page, location: LocationInfo) {
        // Scroll down to "People also search for" section
        await HumanBehavior.randomScroll(page, 6)
        await HumanBehavior.randomDelay(2000, 3000)

        try {
            const nearbyPlaces = await page.$$('div[data-section-id="relatives"] a, div:has-text("People also search") ~ div a, div:has-text("Mọi người cũng tìm") ~ div a')
            if (nearbyPlaces.length > 0) {
                // Click a random nearby place
                const place = nearbyPlaces[Math.floor(Math.random() * Math.min(nearbyPlaces.length, 5))]
                await place.click()
                await HumanBehavior.randomDelay(3000, 5000)

                // Browse it briefly
                await HumanBehavior.randomScroll(page, 3)
                await HumanBehavior.randomDelay(3000, 6000)

                // Go back
                try {
                    await page.goBack({ timeout: 10000 })
                    await HumanBehavior.randomDelay(2000, 3000)
                } catch { /* will be handled by ensureOnMapPage */ }
            }
        } catch { /* ignore */ }
    }

    // ============================================================
    // NEW: View Street View
    // ============================================================

    private async actionViewStreetView(page: Page) {
        // Try to find street view entry
        const streetViewBtn = await page.$('button[aria-label*="Street View" i], a[aria-label*="Street View" i], img[alt*="Street View" i], button[data-value="See outside"], div[class*="streetview"] img')
        if (!streetViewBtn) {
            // Try clicking the main photo which sometimes opens street view
            const mainPhoto = await page.$('img[decoding="async"][src*="streetview"], div[data-embed-type="streetview"]')
            if (!mainPhoto) throw new Error('No street view')
            await mainPhoto.click()
        } else {
            await streetViewBtn.click()
        }
        await HumanBehavior.randomDelay(3000, 5000)

        // Look around by pressing arrow keys
        const lookActions = HumanBehavior.getRandomDelay(3, 6)
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const
        for (let i = 0; i < lookActions; i++) {
            const key = keys[Math.floor(Math.random() * keys.length)]
            await page.keyboard.press(key)
            await HumanBehavior.randomDelay(1000, 2500)
        }

        // 30% chance: zoom in/out with +/-
        if (Math.random() > 0.7) {
            await page.keyboard.press('+')
            await HumanBehavior.randomDelay(1500, 3000)
            await page.keyboard.press('-')
            await HumanBehavior.randomDelay(500, 1000)
        }

        await HumanBehavior.randomDelay(2000, 4000)

        // Close street view
        try {
            const closeBtn = await page.$('button[aria-label="Close" i], button[aria-label="Đóng" i], button[jsaction*="close"]')
            if (closeBtn) await closeBtn.click()
            else await page.keyboard.press('Escape')
        } catch { await page.keyboard.press('Escape') }
        await HumanBehavior.randomDelay(1000, 2000)
    }

    // ============================================================
    // Navigation & Matching Helpers
    // ============================================================

    /**
     * Ensure we're back on the map listing page. Try multiple strategies.
     */
    private async ensureOnMapPage(page: Page, location: LocationInfo, savedUrl?: string) {
        const currentUrl = page.url()

        // If we're already on a maps page with the right info, we're good
        if (currentUrl.includes('google.com/maps') && currentUrl.includes('place')) {
            return
        }

        // Strategy 1: Use browser back
        try {
            await page.goBack({ timeout: 10000 })
            await HumanBehavior.randomDelay(2000, 3000)
            const afterBack = page.url()
            if (afterBack.includes('google.com/maps') || afterBack.includes('place')) {
                return
            }
        } catch { /* ignore */ }

        // Strategy 2: Go to the saved map URL
        if (savedUrl && savedUrl.includes('google.com/maps')) {
            try {
                await page.goto(savedUrl, { waitUntil: 'commit', timeout: 15000 })
                await HumanBehavior.randomDelay(2000, 3000)
                return
            } catch { /* ignore */ }
        }

        // Strategy 3: Go to the location's original URL
        try {
            await page.goto(location.url, { waitUntil: 'commit', timeout: 15000 })
            await HumanBehavior.randomDelay(2000, 3000)
        } catch {
            console.error('[OrganicSearch] Failed to return to map page')
        }
    }

    /**
     * Strict match: prefer strong identifiers (placeId / CID in href/attr), else high-confidence name + address.
     * No loose partial substring match.
     */
    private isMatchingLocation(text: string, location: LocationInfo, href?: string | null): boolean {
        const nText = HumanBehavior.normalizeName(text)
        const nName = HumanBehavior.normalizeName(location.name)
        if (!nName) return false

        // 1) Strong ID: placeId in href/attr or data-cid
        if (location.placeId) {
            const pid = location.placeId
            if (href && (href.includes(pid) || href.includes(encodeURIComponent(pid)))) return true
            if (text && text.includes(pid)) return true
        }

        // 2) Strict name + address corroboration
        if (nText === nName || nText.includes(nName)) {
            if (!location.address) return true
            const nAddr = HumanBehavior.normalizeName(location.address)
            const addrParts = nAddr.split(/[,\s]+/).filter(p => p.length > 3)
            if (addrParts.filter(p => nText.includes(p)).length >= Math.max(1, Math.ceil(addrParts.length * 0.4))) return true
        }
        const nameWords = nName.split(/\s+/).filter(p => p.length > 1)
        const textSet = new Set(nText.split(/\s+/))
        const nameHits = nameWords.filter(w => textSet.has(w)).length
        const nameScore = nameWords.length ? nameHits / nameWords.length : 0
        if (nameScore >= 0.85) {
            if (!location.address) return true
            const nAddr = HumanBehavior.normalizeName(location.address)
            const addrParts = nAddr.split(/[,\s]+/).filter(p => p.length > 3)
            if (addrParts.filter(p => nText.includes(p)).length >= Math.ceil(addrParts.length * 0.4)) return true
        }
        return false
    }

    // 2-arg legacy for old call sites
    private isMatchingLocationLegacy(text: string, location: LocationInfo): boolean {
        return this.isMatchingLocation(text, location)
    }

    /**
     * Human-readable label for actions
     */
    private getActionLabel(action: OrganicAction): string {
        switch (action) {
            case 'directions': return 'Xem chỉ đường'
            case 'call': return 'Xem số điện thoại'
            case 'website': return 'Lướt website'
            case 'share': return 'Chia sẻ'
            case 'view_photos': return 'Xem ảnh'
            case 'view_reviews': return 'Đọc đánh giá'
            case 'view_menu': return 'Xem thực đơn'
            case 'save_place': return 'Lưu địa điểm'
            case 'browse_questions': return 'Xem hỏi đáp'
            case 'view_nearby': return 'Xem lân cận'
            case 'view_street_view': return 'Xem Street View'
            case 'search_interactions': return 'Tương tác tìm kiếm'
            default: return action
        }
    }
}
