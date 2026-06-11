import { Page } from 'playwright'
import { HumanBehavior } from './HumanBehavior'
import { VietnameseDataGenerator } from './VietnameseDataGenerator'
import { DOMUtils, ObservedElementSummary } from './DOMUtils'
import { contextualInterruptionResolver, ContextualInterruptionResolveResult } from './ContextualInterruptionResolver'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'
import { captchaSolverService } from '../services/CaptchaSolverService'

export interface SeoFlowConfig {
    keyword: string
    targetDomain: string
    minTimeOnPageSeconds: number
    maxTimeOnPageSeconds: number
    captchaStrategy?: 'auto_skip' | 'manual'
}

export interface SeoFlowResult {
    success: boolean
    foundWebsite: boolean
    actionsPerformed: { action: string; success: boolean }[]
    message: string
}

export type StatusCallback = (status: {
    action: string
    success: boolean
    message?: string
}) => void

export class WebSeoFlow {
    private onStatus: StatusCallback
    private actionsLog: { action: string; success: boolean }[] = []

    constructor(onStatus?: StatusCallback) {
        this.onStatus = onStatus || (() => { })
    }

    private report(action: string, success: boolean, message?: string) {
        this.onStatus({ action, success, message })
        this.actionsLog.push({ action, success })
    }

    private async cleanupExtraTabs(activePage: Page, reason: string): Promise<void> {
        if (activePage.isClosed()) {
            return
        }

        const pages = activePage.context().pages()
        let closedCount = 0

        for (const tab of pages) {
            if (tab === activePage || tab.isClosed()) {
                continue
            }

            try {
                await tab.close({ runBeforeUnload: false })
                closedCount++
            } catch {
                // Ignore tabs that cannot be closed.
            }
        }

        if (closedCount > 0) {
            this.report('tab_cleanup', true, `Closed ${closedCount} background tab(s) (${reason})`)
        }

        await activePage.bringToFront().catch(() => { })
    }

    private normalizeText(value?: string): string {
        if (!value) return ''
        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
    }

    private summaryText(summary?: ObservedElementSummary): string {
        if (!summary) return ''
        return this.normalizeText([
            summary.textContent,
            summary.ariaLabel,
            summary.title,
            summary.placeholder,
            summary.href,
            summary.role,
            summary.tagName,
            summary.type,
        ].filter(Boolean).join(' '))
    }

    private isLikelyBlockingPrompt(text: string): boolean {
        if (!text) return false
        return /(vi tri chinh xac|location|near your location|cookie|consent|thong bao|notification|sign in|dang nhap|allow|cho phep)/i.test(text)
    }

    private scorePromptCandidate(summary: ObservedElementSummary): number {
        const text = this.summaryText(summary)
        if (!text) return -99

        let score = 0
        if (summary.tagName === 'button' || summary.role === 'button') score += 2
        if (/(de sau|later|not now|skip|close|dismiss|cancel|dong|ok|got it|continue|da hieu|hieu roi|xong)/i.test(text)) score += 8
        if (/(accept|i agree|dong y|chap nhan|allow once)/i.test(text)) score += 3
        if (/(su dung vi tri chinh xac|use precise location|always allow|allow location|cho phep vi tri)/i.test(text)) score -= 8
        if (/(dang nhap|sign in|login|create account|tao tai khoan|submit|publish|post|upload)/i.test(text)) score -= 10
        if (summary.href && /^https?:\/\//i.test(summary.href)) score -= 3

        return score
    }

    private async clickObservedCandidate(page: Page, elementId: number): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        const count = await locator.count().catch(() => 0)
        if (count === 0) {
            throw new Error(`Prompt candidate ${elementId} not found`)
        }

        await locator.waitFor({ state: 'visible', timeout: 2000 })
        await locator.scrollIntoViewIfNeeded().catch(() => { })
        await HumanBehavior.randomDelay(120, 260)
        await locator.click({ timeout: 1500 }).catch(async () => {
            await locator.click({ timeout: 1500, force: true })
        })
    }

    private async resolveBlockingPrompt(page: Page, reason: string): Promise<boolean> {
        const sharedRecovery = await contextualInterruptionResolver.resolve(page, {
            reason: `web_seo_${reason}`,
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 2,
            goal: 'website_browse',
            campaignType: 'web_seo',
            domain: page.url(),
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))
        if (sharedRecovery.handled) {
            this.report('prompt_resolved', true, `${reason}: resolved by shared context resolver (${sharedRecovery.via || 'unknown'})`)
            return true
        }

        const signal = await page.evaluate(() => {
            const dialogEl = document.querySelector('[role="dialog"], [aria-modal="true"], [role="alertdialog"]') as HTMLElement | null
            const rect = dialogEl?.getBoundingClientRect()
            const hasVisibleDialog = !!dialogEl && !!rect && rect.width > 0 && rect.height > 0
            const rawText = (dialogEl?.innerText || document.body?.innerText || '').slice(0, 1800)
            return { hasVisibleDialog, text: rawText.replace(/\s+/g, ' ').trim() }
        }).catch(() => ({ hasVisibleDialog: false, text: '' }))

        const normalizedSignal = this.normalizeText(signal.text)
        if (!signal.hasVisibleDialog && !this.isLikelyBlockingPrompt(normalizedSignal)) {
            return false
        }

        const snapshot = await DOMUtils.extractInteractiveDOM(page)
        const candidates = snapshot.summaries
            .filter(summary => {
                const tag = (summary.tagName || '').toLowerCase()
                const role = (summary.role || '').toLowerCase()
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    return false
                }
                return tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'menuitem'
            })
            .map(summary => ({
                summary,
                score: this.scorePromptCandidate(summary),
                label: this.summaryText(summary).slice(0, 100),
            }))
            .sort((a, b) => b.score - a.score)

        for (const candidate of candidates.slice(0, 6)) {
            if (candidate.score < 4) continue
            try {
                await this.clickObservedCandidate(page, candidate.summary.id)
                await HumanBehavior.randomDelay(220, 480)
                this.report('prompt_resolved', true, `${reason}: resolved with "${candidate.label || candidate.summary.id}"`)
                return true
            } catch {
                // Try next candidate.
            }
        }

        if (signal.hasVisibleDialog) {
            await page.keyboard.press('Escape').catch(() => { })
            await HumanBehavior.randomDelay(160, 360)
            this.report('prompt_escape', true, `${reason}: fallback escape`)
            return true
        }

        return false
    }

    async execute(page: Page, config: SeoFlowConfig): Promise<SeoFlowResult> {
        const result: SeoFlowResult = {
            success: false,
            foundWebsite: false,
            actionsPerformed: [],
            message: ''
        }

        try {
            await HumanBehavior.randomDelay(1000, 2000)
            await this.cleanupExtraTabs(page, 'execute_start')
            await this.resolveBlockingPrompt(page, 'execute_start')

            let reachedWebsite = false
            const captchaStrategy = config.captchaStrategy || 'manual'

            // 1. Try searching on Google first
            this.report('search', true, `Searching: ${config.keyword}`)
            const searchSuccess = await this.searchOnGoogle(page, config.keyword, captchaStrategy)

            if (searchSuccess) {
                // 2. Try to find and click target domain in search results
                this.report('find_website', true, `Looking for: ${config.targetDomain}`)
                const found = await this.findAndClickTargetWebsite(page, config.targetDomain, captchaStrategy)
                if (found) {
                    result.foundWebsite = true
                    reachedWebsite = true
                    this.report('browse', true, 'Website found via Google! Browsing...')
                    await this.cleanupExtraTabs(page, 'after_find_target')
                }
            }

            // 3. FALLBACK: If search failed (CAPTCHA) or website not found,
            //    navigate directly to the target URL
            if (!reachedWebsite) {
                this.report('fallback_direct', true, `Navigating directly to ${config.targetDomain}...`)
                try {
                    const targetUrl = config.targetDomain.startsWith('http')
                        ? config.targetDomain
                        : `https://${config.targetDomain}`
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
                    await HumanBehavior.randomDelay(3000, 6000)
                    reachedWebsite = true
                    result.foundWebsite = true
                    this.report('fallback_success', true, 'Reached website via direct URL')
                    await this.cleanupExtraTabs(page, 'fallback_direct')
                } catch (navError) {
                    // Try with www prefix
                    try {
                        const wwwUrl = `https://www.${config.targetDomain.replace(/^(https?:\/\/)?(www\.)?/, '')}`
                        await page.goto(wwwUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
                        await HumanBehavior.randomDelay(3000, 6000)
                        reachedWebsite = true
                        result.foundWebsite = true
                        this.report('fallback_www', true, 'Reached website via www URL')
                        await this.cleanupExtraTabs(page, 'fallback_www')
                    } catch {
                        this.report('fallback_failed', false, 'Could not reach website at all')
                    }
                }
            }

            // 4. Perform realistic browsing actions on the website
            if (reachedWebsite) {
                const browseSuccess = await this.browseWebsiteLikeRealUser(page, config)
                result.success = browseSuccess
                result.actionsPerformed = this.actionsLog
                result.message = 'SEO flow completed successfully'
            } else {
                result.actionsPerformed = this.actionsLog
                result.message = 'Could not reach website via search or direct URL'
            }

            return result

        } catch (error: any) {
            console.error('Error in WebSeoFlow:', error)
            result.actionsPerformed = this.actionsLog
            result.message = error?.message || 'Unknown error'
            return result
        }
    }

    // ==================== CAPTCHA HANDLING ====================

    private async detectAndHandleCaptcha(
        page: Page,
        strategy: 'auto_skip' | 'manual'
    ): Promise<boolean> {
        try {
            const url = page.url()
            // Check if redirected to Google sorry/captcha page
            if (url.includes('google.com/sorry') || url.includes('ipv4.google.com/sorry') || url.includes('consent.google')) {
                // === TRY AUTO-SOLVE FIRST ===
                this.report('captcha_auto_solve_attempt', true, 'Trying to auto-solve CAPTCHA via API...')
                const solved = await captchaSolverService.solveCaptchaOnPage(page)
                if (solved) {
                    await HumanBehavior.randomDelay(1500, 3000)
                    const stillBlocked = url.includes('google.com/sorry') || url.includes('ipv4.google.com/sorry')
                    const currentUrl = page.url()
                    if (!currentUrl.includes('google.com/sorry') && !currentUrl.includes('ipv4.google.com/sorry')) {
                        this.report('captcha_auto_solved', true, 'CAPTCHA solved automatically via API!')
                        return true
                    }
                }

                // === FALLBACK TO OLD BEHAVIOR ===
                // Check if a CAPTCHA solver provider is actually configured
                const { loadSettings: loadCaptchaSettings } = await import('../ipc/settings')
                const captchaSettings = loadCaptchaSettings()
                const hasCaptchaProvider = captchaSettings.captchaSolverProvider && captchaSettings.captchaSolverProvider !== 'none' && captchaSettings.captchaSolverApiKey

                if (strategy === 'auto_skip' || !hasCaptchaProvider) {
                    // No provider configured OR auto_skip mode → skip manual wait, go directly to target
                    const reason = !hasCaptchaProvider
                        ? 'No CAPTCHA solver configured. Skipping manual solve, navigating directly.'
                        : 'Auto-solve failed. Google CAPTCHA detected. Auto-skip current search flow.'
                    this.report('captcha_auto_skip', false, reason)
                    return false
                }

                // Provider IS configured but solve failed → wait for manual resolution
                this.report('captcha_detected', false, 'Google CAPTCHA detected. Please solve manually in the browser window.')
                const start = Date.now()
                const timeoutMs = 180_000

                while (Date.now() - start < timeoutMs) {
                    await HumanBehavior.randomDelay(2000, 3000)
                    const current = page.url()
                    const stillBlocked = current.includes('google.com/sorry')
                        || current.includes('ipv4.google.com/sorry')
                        || current.includes('consent.google')

                    const hasRecaptcha = await page.locator('iframe[src*="recaptcha"], div.g-recaptcha').count().catch(() => 0)
                    if (!stillBlocked && hasRecaptcha === 0) {
                        this.report('captcha_solved_manual', true, 'Manual CAPTCHA verification completed')
                        await HumanBehavior.randomDelay(1500, 2500)
                        return true
                    }
                }

                this.report('captcha_failed', false, 'CAPTCHA was not solved within timeout window')
                return false
            }

            // Check for consent page
            if (url.includes('consent.google')) {
                const acceptBtn = await page.$('button[id*="accept"], button[aria-label*="Accept"], button:has-text("Accept"), button:has-text("I agree")')
                if (acceptBtn) {
                    await acceptBtn.click()
                    await HumanBehavior.randomDelay(2000, 4000)
                    return true
                }
            }

            return true // No CAPTCHA detected
        } catch {
            return true // Assume no CAPTCHA on error
        }
    }

    // ==================== GOOGLE SEARCH ====================

    private async searchOnGoogle(
        page: Page,
        keyword: string,
        captchaStrategy: 'auto_skip' | 'manual'
    ): Promise<boolean> {
        try {
            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 })
            await HumanBehavior.randomDelay(1000, 3000)
            await this.resolveBlockingPrompt(page, 'search_google_landing')

            // Handle consent/cookie popup
            try {
                const acceptBtn = await page.$('button[id*="accept"], button[id="L2AGLb"], button:has-text("Accept"), button:has-text("I agree")')
                if (acceptBtn) {
                    await acceptBtn.click()
                    await HumanBehavior.randomDelay(1000, 2000)
                }
            } catch { /* no consent popup */ }

            await this.resolveBlockingPrompt(page, 'search_google_post_consent')

            // Check for CAPTCHA before searching
            const captchaOk = await this.detectAndHandleCaptcha(page, captchaStrategy)
            if (!captchaOk) return false

            // Type the keyword like a human
            const searchBox = await page.$('textarea[name="q"], input[name="q"]')
            if (searchBox) {
                await HumanBehavior.humanType(page, 'textarea[name="q"], input[name="q"]', keyword)
                await HumanBehavior.randomDelay(500, 1500)
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { }),
                    page.keyboard.press('Enter')
                ])
                await HumanBehavior.randomDelay(2000, 4000)
                await this.resolveBlockingPrompt(page, 'search_results_loaded')

                // Check for CAPTCHA after search
                const captchaOkAfterSearch = await this.detectAndHandleCaptcha(page, captchaStrategy)
                if (!captchaOkAfterSearch) return false

                return true
            }
            return false
        } catch (e) {
            console.error('Error searching on Google:', e)
            return false
        }
    }

    // ==================== FIND & CLICK TARGET WEBSITE ====================

    private async findAndClickTargetWebsite(
        page: Page,
        targetDomain: string,
        captchaStrategy: 'auto_skip' | 'manual'
    ): Promise<boolean> {
        const MAX_PAGES = 3

        const normalizedTarget = targetDomain
            .replace(/^(https?:\/\/)?(www\.)?/, '')
            .replace(/\/$/, '')
            .toLowerCase()

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            await this.resolveBlockingPrompt(page, `find_target_page_${pageNum}`)

            // Check for CAPTCHA on search results page
            const captchaOk = await this.detectAndHandleCaptcha(page, captchaStrategy)
            if (!captchaOk) {
                return false
            }

            // Slowly scroll down to look at results
            await HumanBehavior.randomScroll(page, 2)
            await HumanBehavior.randomDelay(500, 1500)

            // Collect ALL links from search results
            const resultLinks = await page.evaluate((target) => {
                const selectors = [
                    '#search a[href]',
                    'div.g a[href]',
                    '#rso a[href]',
                    'div[data-sokoban-container] a[href]',
                    '.yuRUbf a[href]',
                ]

                const allLinks: { href: string; index: number; text: string }[] = []
                const seen = new Set<string>()

                for (const sel of selectors) {
                    const elements = document.querySelectorAll(sel)
                    elements.forEach((el, idx) => {
                        const anchor = el as HTMLAnchorElement
                        const href = anchor.href
                        if (href && !seen.has(href) && !href.includes('google.com') && !href.includes('webcache')) {
                            seen.add(href)
                            allLinks.push({
                                href,
                                index: idx,
                                text: anchor.textContent?.substring(0, 100) || ''
                            })
                        }
                    })
                }

                const normalizedTarget = target.toLowerCase()
                for (const link of allLinks) {
                    try {
                        const url = new URL(link.href)
                        const linkDomain = url.hostname.replace(/^www\./, '').toLowerCase()
                        if (linkDomain === normalizedTarget || linkDomain.endsWith('.' + normalizedTarget)) {
                            return { found: true, href: link.href, text: link.text }
                        }
                    } catch { /* skip invalid URLs */ }
                }

                return { found: false, href: '', text: '' }
            }, normalizedTarget)

            if (resultLinks.found) {
                this.report('found_result', true, `Found: "${resultLinks.text}"`)

                const targetLink = await page.$(`a[href="${resultLinks.href}"]`)
                if (targetLink) {
                    await targetLink.scrollIntoViewIfNeeded()
                    await HumanBehavior.randomDelay(500, 1000)
                    await targetLink.hover()
                    await HumanBehavior.randomDelay(300, 800)
                    await targetLink.evaluate((node) => {
                        const anchor = node as HTMLAnchorElement
                        if (anchor && anchor.tagName === 'A') {
                            anchor.target = '_self'
                            anchor.rel = 'noreferrer'
                        }
                    }).catch(() => { })

                    const [popupPage] = await Promise.all([
                        page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
                        Promise.all([
                            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { }),
                            targetLink.click()
                        ])
                    ])

                    if (popupPage && !popupPage.isClosed()) {
                        await popupPage.close({ runBeforeUnload: false }).catch(() => { })
                    }
                    await this.cleanupExtraTabs(page, 'after_target_click')
                    await HumanBehavior.randomDelay(3000, 6000)
                    return true
                }

                try {
                    await page.goto(resultLinks.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
                    await HumanBehavior.randomDelay(3000, 6000)
                    await this.cleanupExtraTabs(page, 'fallback_goto_target')
                    return true
                } catch { /* failed */ }
            }

            // Not found on this page, go to next
            const nextButton = await page.$('a#pnnext, a[aria-label="Next"]')
            if (nextButton && pageNum < MAX_PAGES) {
                this.report('next_page', true, `Page ${pageNum}: not found, going next...`)
                await nextButton.hover()
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => { }),
                    nextButton.click()
                ])
                await HumanBehavior.randomDelay(2000, 4000)
            } else {
                break
            }
        }

        return false
    }

    // ==================== BROWSE WEBSITE LIKE REAL USER ====================

    browseWebsiteLikeRealUser(page: Page, config: SeoFlowConfig): Promise<boolean> {
        return this._doBrowse(page, config)
    }

    private async _doBrowse(page: Page, config: SeoFlowConfig): Promise<boolean> {
        const timeToSpendMs = Math.floor(
            Math.random() * (config.maxTimeOnPageSeconds - config.minTimeOnPageSeconds + 1) + config.minTimeOnPageSeconds
        ) * 1000

        const minTime = Math.max(timeToSpendMs, 30000)
        const startTime = Date.now()

        // All possible actions with weights (higher = more common)
        const weightedActions: { fn: () => Promise<void>; weight: number }[] = [
            { fn: () => this.actionScrollReadContent(page), weight: 5 },
            { fn: () => this.actionViewImages(page), weight: 4 },
            { fn: () => this.actionClickProductImageGallery(page), weight: 3 },
            { fn: () => this.actionHoverElements(page), weight: 3 },
            { fn: () => this.actionClickInternalLink(page, config.targetDomain), weight: 4 },
            { fn: () => this.actionCheckContactInfo(page), weight: 3 },
            { fn: () => this.actionReadProductDetails(page), weight: 4 },
            { fn: () => this.actionScrollToFooter(page), weight: 2 },
            { fn: () => this.actionViewSocialLinks(page), weight: 2 },
            { fn: () => this.actionCheckPricing(page), weight: 4 },
            { fn: () => this.actionRandomMouseMovement(page), weight: 3 },
            { fn: () => this.actionScrollUpDown(page), weight: 4 },
            { fn: () => this.actionClickMenuNav(page), weight: 3 },
            { fn: () => this.actionAddToCart(page), weight: 3 },
            { fn: () => this.actionFillCheckoutForm(page, config.targetDomain), weight: 2 },
            { fn: () => this.actionSearchOnSite(page, config.keyword), weight: 3 },
            { fn: () => this.actionClickProductTabs(page), weight: 3 },
            { fn: () => this.actionBrowseCategories(page), weight: 3 },
            { fn: () => this.actionViewRelatedProducts(page), weight: 3 },
            { fn: () => this.actionReadReviews(page), weight: 3 },
            { fn: () => this.actionSelectProductVariant(page), weight: 2 },
            { fn: () => this.actionViewBreadcrumb(page), weight: 2 },
            { fn: () => this.actionHoverShareButtons(page), weight: 1 },
            { fn: () => this.actionZoomImage(page), weight: 2 },
            // NEW: More diverse actions
            { fn: () => this.actionClickZaloMessenger(page), weight: 3 },
            { fn: () => this.actionClickPhoneNumber(page), weight: 3 },
            { fn: () => this.actionClickImageToOpen(page), weight: 3 },
            { fn: () => this.actionViewPolicyPages(page), weight: 2 },
            { fn: () => this.actionClickBannerSlider(page), weight: 2 },
            { fn: () => this.actionExpandAccordionFAQ(page), weight: 2 },
            { fn: () => this.actionScrollToSpecificSection(page), weight: 3 },
            { fn: () => this.actionClickVideoPlay(page), weight: 2 },
            { fn: () => this.actionResizeAndScroll(page), weight: 1 },
            { fn: () => this.actionHighlightText(page), weight: 2 },
        ]

        // Build weighted list
        const actionPool: (() => Promise<void>)[] = []
        for (const wa of weightedActions) {
            for (let i = 0; i < wa.weight; i++) actionPool.push(wa.fn)
        }

        try {
            let actionsDone = 0
            const maxActions = Math.floor(Math.random() * 10) + 10 // 10-19 actions (more diverse)

            while (Date.now() - startTime < minTime && actionsDone < maxActions) {
                await this.resolveBlockingPrompt(page, `browse_loop_${actionsDone + 1}`)
                const actionFn = actionPool[Math.floor(Math.random() * actionPool.length)]
                try { await actionFn() } catch { /* ignore */ }
                await this.cleanupExtraTabs(page, `browse_action_${actionsDone + 1}`)
                actionsDone++
                await HumanBehavior.randomDelay(1500, 4000)
            }

            // Sometimes scroll back to top before leaving
            if (Math.random() > 0.4) {
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
                await HumanBehavior.randomDelay(1000, 2000)
            }

            this.report('browse_complete', true, `Done: ${Math.round((Date.now() - startTime) / 1000)}s, ${actionsDone} actions`)
            return true
        } catch (e) {
            console.error('Error browsing website:', e)
            return false
        }
    }

    // ==================== BASIC BROWSING ACTIONS ====================

    private async actionScrollReadContent(page: Page) {
        this.report('scroll_read', true, 'Reading page content...')
        const count = Math.floor(Math.random() * 4) + 2
        for (let i = 0; i < count; i++) {
            await page.evaluate(() => window.scrollBy({ top: 150 + Math.random() * 350, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(2000, 5000)
        }
    }

    private async actionScrollUpDown(page: Page) {
        this.report('scroll_updown', true, 'Scrolling up and down...')
        await page.evaluate(() => window.scrollBy({ top: 400 + Math.random() * 500, behavior: 'smooth' }))
        await HumanBehavior.randomDelay(1000, 2000)
        await page.evaluate(() => window.scrollBy({ top: -(200 + Math.random() * 300), behavior: 'smooth' }))
        await HumanBehavior.randomDelay(1500, 3000)
        await page.evaluate(() => window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'smooth' }))
        await HumanBehavior.randomDelay(1000, 2000)
    }

    private async actionRandomMouseMovement(page: Page) {
        this.report('mouse_move', true, 'Moving mouse naturally...')
        try {
            const vp = page.viewportSize()
            if (vp) {
                for (let i = 0; i < 4; i++) {
                    const mx = Math.floor(Math.random() * vp.width)
                    const my = Math.floor(Math.random() * vp.height)
                    await moveCursor(page, mx, my)
                    await page.mouse.move(
                        mx,
                        my,
                        { steps: 10 + Math.floor(Math.random() * 20) }
                    )
                    await HumanBehavior.randomDelay(200, 600)
                }
            }
        } catch { /* ignore */ }
    }

    private async actionScrollToFooter(page: Page) {
        this.report('view_footer', true, 'Viewing footer section...')
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }))
        await HumanBehavior.randomDelay(2000, 4000)
        const links = await page.$$('footer a')
        if (links.length > 0) {
            const l = links[Math.floor(Math.random() * Math.min(links.length, 5))]
            await l.hover().catch(() => { })
            await HumanBehavior.randomDelay(500, 1500)
        }
    }

    // ==================== IMAGE & MEDIA ACTIONS ====================

    private async actionViewImages(page: Page) {
        this.report('view_images', true, 'Viewing product images...')
        const sels = [
            '.product-image img', '.gallery img', '.swiper-slide img',
            '.product-gallery img', '.thumbnail img', '.product img',
            'figure img', '.owl-item img', '.slick-slide img', 'img[alt]',
        ]
        for (const sel of sels) {
            const imgs = await page.$$(sel)
            if (imgs.length > 0) {
                const img = imgs[Math.floor(Math.random() * Math.min(imgs.length, 5))]
                await img.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await img.hover().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
                return
            }
        }
    }

    private async actionClickProductImageGallery(page: Page) {
        this.report('gallery_click', true, 'Browsing image gallery...')
        const thumbSels = [
            '.thumbnail img', '.product-thumbnails img', '.slick-dots li',
            '.swiper-pagination-bullet', '.owl-dot', '.gallery-thumb img',
            '.product-gallery-thumb img', '[data-thumb] img',
        ]
        for (const sel of thumbSels) {
            const thumbs = await page.$$(sel)
            if (thumbs.length >= 2) {
                const count = Math.min(thumbs.length, 3 + Math.floor(Math.random() * 3))
                for (let i = 0; i < count; i++) {
                    await thumbs[i].click().catch(() => { })
                    await HumanBehavior.randomDelay(1000, 2500)
                }
                return
            }
        }
        const navBtns = await page.$$('.swiper-button-next, .slick-next, .owl-next, .gallery-next, [class*="next"]')
        if (navBtns.length > 0) {
            const clicks = Math.floor(Math.random() * 3) + 2
            for (let i = 0; i < clicks; i++) {
                await navBtns[0].click().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
            }
        }
    }

    private async actionZoomImage(page: Page) {
        this.report('zoom_image', true, 'Zooming product image...')
        const imgSels = ['.product-image img', '.main-image img', '.product img', 'figure img']
        for (const sel of imgSels) {
            const img = await page.$(sel)
            if (img) {
                await img.scrollIntoViewIfNeeded().catch(() => { })
                await img.hover().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await img.click().catch(() => { })
                await HumanBehavior.randomDelay(2000, 4000)

                // Try deeper image interaction: zoom + pan + next image
                const focusedImage = await page.$('.fancybox-image, .lightbox img, .mfp-img, .modal img, [role="dialog"] img')
                const imageForInteraction = focusedImage || img
                const box = await imageForInteraction.boundingBox().catch(() => null)
                if (box) {
                    const centerX = box.x + box.width / 2
                    const centerY = box.y + box.height / 2
                    await moveCursor(page, centerX, centerY)
                    await page.mouse.move(centerX, centerY).catch(() => { })
                    await HumanBehavior.randomDelay(200, 450)
                    await page.mouse.wheel(0, -240).catch(() => { })
                    await HumanBehavior.randomDelay(350, 700)
                    await page.mouse.down().catch(() => { })
                    await page.mouse.move(
                        centerX + (Math.random() > 0.5 ? 120 : -120),
                        centerY + (Math.random() > 0.5 ? 80 : -80),
                        { steps: 10 }
                    ).catch(() => { })
                    await page.mouse.up().catch(() => { })
                    await HumanBehavior.randomDelay(400, 800)
                    await page.mouse.wheel(0, 220).catch(() => { })
                    await HumanBehavior.randomDelay(300, 650)
                }

                await page.$('.swiper-button-next, .slick-next, .owl-next, .gallery-next, [aria-label*="Next"]')
                    .then(btn => btn?.click().catch(() => { }))
                    .catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)

                const close = await page.$('.close, .lightbox-close, [aria-label="Close"], .fancybox-close, .modal-close, button[data-dismiss="modal"], .mfp-close')
                if (close) await close.click().catch(() => { })
                await page.keyboard.press('Escape').catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                return
            }
        }
    }

    private async actionClickImageToOpen(page: Page) {
        this.report('click_image', true, 'Clicking image to view full size...')
        const sels = [
            'a[href*=".jpg"]', 'a[href*=".png"]', 'a[href*=".webp"]',
            '.product-image a', '.gallery a', 'figure a',
            'a[data-fancybox]', 'a[data-lightbox]', 'a[rel="lightbox"]',
            '.fancybox', '.lightbox', '[data-magnify]',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el && await el.isVisible().catch(() => false)) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await el.click().catch(() => { })
                await HumanBehavior.randomDelay(2000, 5000)
                // Close lightbox/modal
                const closeBtn = await page.$('.fancybox-close, .lightbox-close, .mfp-close, .close, [aria-label="Close"], .modal-close, button[data-dismiss="modal"]')
                if (closeBtn) await closeBtn.click().catch(() => { })
                // Also try pressing Escape
                await page.keyboard.press('Escape').catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                return
            }
        }
    }

    private async actionClickVideoPlay(page: Page) {
        this.report('click_video', true, 'Watching video...')
        const sels = [
            'video', 'iframe[src*="youtube"]', 'iframe[src*="vimeo"]',
            '.video-play', '.play-button', '[class*="video"]',
            'a[href*="youtube.com"]', 'a[href*="youtu.be"]',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el && await el.isVisible().catch(() => false)) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await el.click().catch(() => { })
                // Watch for a bit
                await HumanBehavior.randomDelay(5000, 10000)
                return
            }
        }
    }

    // ==================== PRODUCT INTERACTION ACTIONS ====================

    private async actionReadProductDetails(page: Page) {
        this.report('read_product', true, 'Reading product details...')
        const sels = [
            '.product-description', '.product-detail', '.product-info',
            '.product-content', '.description', '.chi-tiet', '.mo-ta',
            '.tab-content', '#product-description', 'article', '.entry-content',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
                for (let i = 0; i < 4; i++) {
                    await page.evaluate(() => window.scrollBy({ top: 180, behavior: 'smooth' }))
                    await HumanBehavior.randomDelay(1500, 3500)
                }
                return
            }
        }
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy({ top: 250, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(2000, 4000)
        }
    }

    private async actionCheckPricing(page: Page) {
        this.report('check_price', true, 'Checking product price...')
        const sels = [
            '.price', '.product-price', '.gia', '.current-price', '.sale-price',
            '[class*="price"]', '[class*="gia"]',
            '.add-to-cart', '.mua-ngay', '.buy-now', '.dat-hang',
            'button[class*="cart"]', 'button[class*="buy"]', 'button[class*="mua"]',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(1500, 3000)
                return
            }
        }
    }

    private async actionSelectProductVariant(page: Page) {
        this.report('select_variant', true, 'Selecting product variant...')
        const variantSels = [
            '.color-option', '.size-option', '.variant-option',
            '.product-variants label', '.swatch-element', '[data-variant]',
            'select[name*="variant"]', 'select[name*="size"]', 'select[name*="color"]',
            '.product-option input[type="radio"]',
        ]
        for (const sel of variantSels) {
            const options = await page.$$(sel)
            if (options.length >= 2) {
                const opt = options[Math.floor(Math.random() * options.length)]
                await opt.scrollIntoViewIfNeeded().catch(() => { })
                await opt.click().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
                this.report('variant_selected', true, 'Variant selected')
                return
            }
        }
    }

    private async actionClickProductTabs(page: Page) {
        this.report('product_tabs', true, 'Viewing product tabs...')
        const tabSels = [
            '.product-tabs a', '.tab-link', '.nav-tabs a', '.tab-title',
            '[role="tab"]', '.tabs a', '.product-tab',
        ]
        for (const sel of tabSels) {
            const tabs = await page.$$(sel)
            if (tabs.length >= 2) {
                const count = Math.min(tabs.length, 2 + Math.floor(Math.random() * 2))
                for (let i = 0; i < count; i++) {
                    const tab = tabs[Math.floor(Math.random() * tabs.length)]
                    await tab.scrollIntoViewIfNeeded().catch(() => { })
                    await tab.click().catch(() => { })
                    await HumanBehavior.randomDelay(2000, 4000)
                    await page.evaluate(() => window.scrollBy({ top: 150, behavior: 'smooth' }))
                    await HumanBehavior.randomDelay(1500, 3000)
                }
                return
            }
        }
    }

    private async actionReadReviews(page: Page) {
        this.report('read_reviews', true, 'Reading product reviews...')
        const reviewSels = [
            '.reviews', '.product-reviews', '.customer-reviews',
            '#reviews', '.comment-list', '.review-list', '.danh-gia',
            '[id*="review"]', '[class*="review"]',
        ]
        for (const sel of reviewSels) {
            const el = await page.$(sel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
                for (let i = 0; i < 3; i++) {
                    await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'smooth' }))
                    await HumanBehavior.randomDelay(2000, 4000)
                }
                return
            }
        }
    }

    private async actionViewRelatedProducts(page: Page) {
        this.report('related_products', true, 'Viewing related products...')
        const sels = [
            '.related-products a', '.product-related a', '.upsell a',
            '.san-pham-lien-quan a', '[class*="related"] a', '[class*="similar"] a',
            '.recently-viewed a', '.also-like a',
        ]
        for (const sel of sels) {
            const items = await page.$$(sel)
            if (items.length > 0) {
                const item = items[Math.floor(Math.random() * Math.min(items.length, 5))]
                await item.scrollIntoViewIfNeeded().catch(() => { })
                await item.hover().catch(() => { })
                await HumanBehavior.randomDelay(1500, 3000)
                if (Math.random() > 0.5) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                        item.click()
                    ]).catch(() => { })
                    await HumanBehavior.randomDelay(3000, 5000)
                }
                return
            }
        }
    }

    private async actionExpandAccordionFAQ(page: Page) {
        this.report('expand_faq', true, 'Reading FAQ / Accordion...')
        const sels = [
            '.accordion-header', '.faq-question', '.collapse-header',
            '[data-toggle="collapse"]', '.accordion-button', '.faq-item',
            'details summary', '.question', '[class*="accordion"]',
        ]
        for (const sel of sels) {
            const items = await page.$$(sel)
            if (items.length > 0) {
                const count = Math.min(items.length, 2 + Math.floor(Math.random() * 2))
                for (let i = 0; i < count; i++) {
                    const item = items[Math.floor(Math.random() * items.length)]
                    await item.scrollIntoViewIfNeeded().catch(() => { })
                    await item.click().catch(() => { })
                    await HumanBehavior.randomDelay(2000, 4000)
                    await page.evaluate(() => window.scrollBy({ top: 100, behavior: 'smooth' }))
                    await HumanBehavior.randomDelay(1500, 3000)
                }
                return
            }
        }
    }

    private async actionHighlightText(page: Page) {
        this.report('highlight_text', true, 'Selecting text to read...')
        try {
            const paragraphs = await page.$$('p, .description, .product-content, article')
            if (paragraphs.length > 0) {
                const p = paragraphs[Math.floor(Math.random() * Math.min(paragraphs.length, 5))]
                await p.scrollIntoViewIfNeeded().catch(() => { })
                const box = await p.boundingBox()
                if (box) {
                    // Simulate text selection by clicking and dragging
                    await moveCursor(page, box.x + 10, box.y + box.height / 2)
                    await page.mouse.move(box.x + 10, box.y + box.height / 2)
                    await page.mouse.down()
                    await page.mouse.move(box.x + Math.min(box.width * 0.6, 250), box.y + box.height / 2, { steps: 15 })
                    await HumanBehavior.randomDelay(1000, 2000)
                    await page.mouse.up()
                    await HumanBehavior.randomDelay(1500, 3000)
                    // Click elsewhere to deselect
                    await clickCursor(page, box.x + box.width / 2, box.y + box.height + 20)
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height + 20)
                }
            }
        } catch { /* ignore */ }
    }

    private async actionScrollToSpecificSection(page: Page) {
        this.report('scroll_section', true, 'Jumping to section...')
        const sels = [
            '#description', '#reviews', '#specifications', '#details',
            '.product-description', '.product-specs', '.product-reviews',
            '.about-section', '.contact-section', '.features',
            'h2', 'h3',
        ]
        const randomSel = sels[Math.floor(Math.random() * sels.length)]
        try {
            const el = await page.$(randomSel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await HumanBehavior.randomDelay(2000, 5000)
                await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'smooth' }))
                await HumanBehavior.randomDelay(1500, 3000)
            }
        } catch { /* ignore */ }
    }

    // ==================== SHOPPING FLOW ACTIONS ====================

    private async actionAddToCart(page: Page) {
        this.report('add_to_cart', true, 'Adding to cart...')
        const cartBtnSels = [
            'button.add-to-cart', '.add-to-cart', '.btn-add-cart',
            'button[class*="cart"]', 'button[class*="addtocart"]',
            '.them-gio-hang', '.mua-ngay',
            'button:has-text("Add to cart")', 'button:has-text("Mua ngay")',
            'a:has-text("Add to cart")',
            '[data-action="add-to-cart"]', '#add-to-cart',
        ]
        for (const sel of cartBtnSels) {
            try {
                const btn = await page.$(sel)
                if (btn) {
                    const isVisible = await btn.isVisible().catch(() => false)
                    if (!isVisible) continue
                    await btn.scrollIntoViewIfNeeded().catch(() => { })
                    await btn.hover().catch(() => { })
                    await HumanBehavior.randomDelay(800, 1500)
                    await btn.click().catch(() => { })
                    await HumanBehavior.randomDelay(2000, 4000)
                    this.report('added_to_cart', true, 'Product added to cart')
                    return
                }
            } catch { /* next */ }
        }
    }

    private async actionFillCheckoutForm(page: Page, domain: string) {
        this.report('fill_checkout', true, 'Viewing checkout page...')
        const cartLinks = [
            'a[href*="cart"]', 'a[href*="gio-hang"]', 'a[href*="checkout"]',
            'a[href*="thanh-toan"]', '.cart-icon a', '.cart-link',
            'a:has-text("Cart")',
        ]
        let navigated = false
        for (const sel of cartLinks) {
            try {
                const link = await page.$(sel)
                if (link) {
                    const isVisible = await link.isVisible().catch(() => false)
                    if (!isVisible) continue
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                        link.click()
                    ])
                    await HumanBehavior.randomDelay(2000, 4000)
                    navigated = true
                    break
                }
            } catch { /* next */ }
        }

        if (navigated) {
            const checkoutBtns = [
                'a[href*="checkout"]', 'a[href*="thanh-toan"]',
                'button:has-text("Checkout")',
                'a:has-text("Checkout")', '.checkout-btn',
            ]
            for (const sel of checkoutBtns) {
                try {
                    const btn = await page.$(sel)
                    if (btn) {
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                            btn.click()
                        ])
                        await HumanBehavior.randomDelay(2000, 3000)
                        break
                    }
                } catch { /* next */ }
            }
        }

        // Generate Vietnamese customer data
        const customer = VietnameseDataGenerator.generateCustomer()

        // Fill form fields
        const formFields = [
            { sels: ['input[name*="name"]', 'input[name*="ten"]', 'input[name*="fullname"]', 'input[name*="ho_ten"]', '#billing_first_name', '#shipping_first_name'], value: customer.fullName },
            { sels: ['input[name*="email"]', 'input[type="email"]', '#billing_email'], value: customer.email },
            { sels: ['input[name*="phone"]', 'input[name*="tel"]', 'input[name*="dien_thoai"]', 'input[type="tel"]', '#billing_phone'], value: customer.phone },
            { sels: ['input[name*="address"]', 'input[name*="dia_chi"]', 'textarea[name*="address"]', '#billing_address_1'], value: customer.address.full },
            { sels: ['input[name*="city"]', 'input[name*="tinh"]', '#billing_city'], value: customer.address.city },
            { sels: ['input[name*="district"]', 'input[name*="quan"]'], value: customer.address.district },
            { sels: ['textarea[name*="note"]', 'textarea[name*="ghi_chu"]', '#order_comments'], value: Math.random() > 0.5 ? 'Giao hang trong gio hanh chinh' : '' },
        ]

        let fieldsFilledCount = 0
        for (const field of formFields) {
            if (!field.value) continue
            for (const sel of field.sels) {
                try {
                    const input = await page.$(sel)
                    if (input) {
                        const isVisible = await input.isVisible().catch(() => false)
                        if (!isVisible) continue
                        await input.scrollIntoViewIfNeeded().catch(() => { })
                        await input.click().catch(() => { })
                        await HumanBehavior.randomDelay(300, 600)
                        await input.evaluate((el: any) => { el.value = '' })
                        await HumanBehavior.humanType(page, sel, field.value)
                        await HumanBehavior.randomDelay(500, 1500)
                        fieldsFilledCount++
                        break
                    }
                } catch { /* next selector */ }
            }
        }

        if (fieldsFilledCount > 0) {
            this.report('form_filled', true, `Filled ${fieldsFilledCount} form fields`)
        }

        // Wait then go BACK - do NOT submit
        await HumanBehavior.randomDelay(3000, 6000)
        await page.goBack().catch(() => { })
        await HumanBehavior.randomDelay(2000, 4000)
        await page.goBack().catch(() => { })
        await HumanBehavior.randomDelay(1000, 2000)
        this.report('back_to_product', true, 'Back to product page')
    }

    // ==================== NAVIGATION & DISCOVERY ACTIONS ====================

    private async actionClickMenuNav(page: Page) {
        this.report('click_menu', true, 'Browsing menu...')
        const sels = ['nav a', '.navbar a', '.main-menu a', '.menu a', 'header a', '.nav-link', '.menu-item a']
        for (const sel of sels) {
            const items = await page.$$(sel)
            const visible = []
            for (const it of items) {
                if (await it.isVisible().catch(() => false)) visible.push(it)
            }
            if (visible.length > 0) {
                const t = visible[Math.floor(Math.random() * visible.length)]
                await t.hover().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                    t.click()
                ]).catch(() => { })
                await HumanBehavior.randomDelay(2000, 4000)
                return
            }
        }
    }

    private async actionClickInternalLink(page: Page, domain: string) {
        this.report('click_internal', true, 'Clicking internal link...')
        const norm = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '')
        const links = await page.$$('a[href]')
        const internal = []
        for (const l of links) {
            try {
                const href = await l.evaluate((n: HTMLAnchorElement) => n.href)
                if (!href || href.includes('#') || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('mailto:')) continue
                try {
                    const u = new URL(href)
                    if (u.hostname.replace(/^www\./, '').includes(norm) && await l.isVisible().catch(() => false))
                        internal.push(l)
                } catch { /* skip */ }
            } catch { /* stale */ }
        }
        if (internal.length > 0) {
            const link = internal[Math.floor(Math.random() * internal.length)]
            await link.scrollIntoViewIfNeeded().catch(() => { })
            await link.hover().catch(() => { })
            await HumanBehavior.randomDelay(500, 1000)
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { }),
                link.click()
            ]).catch(() => { })
            await HumanBehavior.randomDelay(2000, 4000)
        }
    }

    private async actionBrowseCategories(page: Page) {
        this.report('browse_categories', true, 'Browsing product categories...')
        const catSels = [
            '.category a', '.categories a', '.danh-muc a', '.product-categories a',
            'a[href*="category"]', 'a[href*="danh-muc"]', 'a[href*="collections"]',
            '.sidebar a', '.widget-categories a', '.cat-item a',
        ]
        for (const sel of catSels) {
            const items = await page.$$(sel)
            const visible = []
            for (const i of items) { if (await i.isVisible().catch(() => false)) visible.push(i) }
            if (visible.length > 0) {
                const cat = visible[Math.floor(Math.random() * visible.length)]
                await cat.scrollIntoViewIfNeeded().catch(() => { })
                await cat.hover().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                    cat.click()
                ]).catch(() => { })
                await HumanBehavior.randomDelay(3000, 5000)
                await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }))
                await HumanBehavior.randomDelay(2000, 3000)
                return
            }
        }
    }

    private async actionSearchOnSite(page: Page, keyword: string) {
        this.report('search_on_site', true, 'Searching on website...')
        const searchSels = [
            'input[name="s"]', 'input[name="q"]', 'input[name="search"]',
            'input[type="search"]', 'input[placeholder*="Search"]',
            '.search-input', '#search-input',
        ]
        const shortKeyword = keyword.split(/\s+/).slice(0, 2).join(' ')
        for (const sel of searchSels) {
            try {
                const input = await page.$(sel)
                if (input && await input.isVisible().catch(() => false)) {
                    await input.scrollIntoViewIfNeeded().catch(() => { })
                    await input.click().catch(() => { })
                    await HumanBehavior.randomDelay(300, 600)
                    await HumanBehavior.humanType(page, sel, shortKeyword)
                    await HumanBehavior.randomDelay(500, 1000)
                    await page.keyboard.press('Enter')
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { })
                    await HumanBehavior.randomDelay(2000, 4000)
                    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }))
                    await HumanBehavior.randomDelay(2000, 3000)
                    this.report('searched', true, `Searched: "${shortKeyword}"`)
                    return
                }
            } catch { /* next */ }
        }
    }

    private async actionViewBreadcrumb(page: Page) {
        this.report('view_breadcrumb', true, 'Viewing breadcrumb...')
        const bcSels = ['.breadcrumb a', '.breadcrumbs a', '[class*="breadcrumb"] a', 'nav[aria-label="Breadcrumb"] a']
        for (const sel of bcSels) {
            const items = await page.$$(sel)
            if (items.length >= 2) {
                const mid = items[Math.floor(Math.random() * (items.length - 1))]
                await mid.hover().catch(() => { })
                await HumanBehavior.randomDelay(500, 1000)
                if (Math.random() > 0.5) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                        mid.click()
                    ]).catch(() => { })
                    await HumanBehavior.randomDelay(2000, 4000)
                }
                return
            }
        }
    }

    private async actionViewPolicyPages(page: Page) {
        this.report('view_policy', true, 'Viewing policy page...')
        const sels = [
            'a[href*="chinh-sach"]', 'a[href*="policy"]', 'a[href*="bao-hanh"]',
            'a[href*="doi-tra"]', 'a[href*="shipping"]', 'a[href*="van-chuyen"]',
            'a[href*="return"]', 'a[href*="warranty"]', 'a[href*="terms"]',
            'a:has-text("Warranty")', 'a:has-text("Shipping")', 'a:has-text("Return")',
        ]
        for (const sel of sels) {
            try {
                const el = await page.$(sel)
                if (el && await el.isVisible().catch(() => false)) {
                    await el.scrollIntoViewIfNeeded().catch(() => { })
                    await el.hover().catch(() => { })
                    await HumanBehavior.randomDelay(500, 1000)
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { }),
                        el.click()
                    ]).catch(() => { })
                    await HumanBehavior.randomDelay(3000, 5000)
                    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }))
                    await HumanBehavior.randomDelay(2000, 3000)
                    // Go back
                    await page.goBack().catch(() => { })
                    await HumanBehavior.randomDelay(1000, 2000)
                    return
                }
            } catch { /* next */ }
        }
    }

    private async actionClickBannerSlider(page: Page) {
        this.report('click_banner', true, 'Interacting with banner/slider...')
        const sels = [
            '.banner a', '.slider a', '.slideshow a', '.hero a',
            '.swiper-slide a', '.owl-item a', '.slick-slide a',
            '.carousel-item a', '[class*="banner"] a', '[class*="slider"] a',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el && await el.isVisible().catch(() => false)) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(800, 1500)
                await el.click().catch(() => { })
                await HumanBehavior.randomDelay(2000, 4000)
                return
            }
        }
        // Try slider arrows
        const arrows = await page.$$('.swiper-button-next, .slick-next, .owl-next, .carousel-control-next')
        if (arrows.length > 0) {
            const clicks = Math.floor(Math.random() * 3) + 1
            for (let i = 0; i < clicks; i++) {
                await arrows[0].click().catch(() => { })
                await HumanBehavior.randomDelay(1500, 3000)
            }
        }
    }

    private async actionResizeAndScroll(page: Page) {
        this.report('resize_scroll', true, 'Adjusting view...')
        try {
            // Scroll to a random position on the page
            const height = await page.evaluate(() => document.body.scrollHeight)
            const randomPos = Math.floor(Math.random() * height * 0.7)
            await page.evaluate((pos) => window.scrollTo({ top: pos, behavior: 'smooth' }), randomPos)
            await HumanBehavior.randomDelay(2000, 4000)
            // Scroll back up a bit
            await page.evaluate(() => window.scrollBy({ top: -200, behavior: 'smooth' }))
            await HumanBehavior.randomDelay(1000, 2000)
        } catch { /* ignore */ }
    }

    // ==================== CONTACT & SOCIAL ACTIONS ====================

    private async actionClickZaloMessenger(page: Page) {
        this.report('click_zalo_mess', true, 'Clicking Zalo/Messenger button...')
        const sels = [
            // Zalo
            'a[href*="zalo.me"]', 'a[href*="zl.me"]', '.zalo-chat', '.zalo',
            'a[href*="zalo"]', '[class*="zalo"]', '#zalo-btn',
            'img[src*="zalo"]', 'img[alt*="zalo"]', 'img[alt*="Zalo"]',
            // Messenger
            'a[href*="m.me"]', 'a[href*="messenger.com"]', '.messenger-chat',
            '[class*="messenger"]', 'a[href*="facebook.com/messages"]',
            'img[src*="messenger"]',
            // Chat widgets
            '.chat-widget', '.live-chat', '#chat-button', '.chat-btn',
            '[class*="chat-widget"]', '.tawk-widget', '.fb-customerchat',
            '#fb-root .fb-customerchat',
        ]
        for (const sel of sels) {
            try {
                const el = await page.$(sel)
                if (el && await el.isVisible().catch(() => false)) {
                    await el.scrollIntoViewIfNeeded().catch(() => { })
                    await el.hover().catch(() => { })
                    await HumanBehavior.randomDelay(1000, 2000)
                    // Click it (but handle popup/new tab)
                    const [newPage] = await Promise.all([
                        page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null),
                        el.click().catch(() => { })
                    ])
                    await HumanBehavior.randomDelay(2000, 4000)
                    // Close new tab if opened
                    if (newPage) {
                        await newPage.close().catch(() => { })
                    }
                    this.report('zalo_mess_clicked', true, 'Clicked Zalo/Messenger')
                    return
                }
            } catch { /* next */ }
        }
    }

    private async actionClickPhoneNumber(page: Page) {
        this.report('click_phone', true, 'Clicking phone number...')
        const sels = [
            'a[href^="tel:"]', '.hotline a', '.phone a', '.phone-number a',
            '[class*="hotline"] a', '[class*="phone"] a',
            'a[href*="tel:"]',
        ]
        for (const sel of sels) {
            try {
                const el = await page.$(sel)
                if (el && await el.isVisible().catch(() => false)) {
                    await el.scrollIntoViewIfNeeded().catch(() => { })
                    await el.hover().catch(() => { })
                    await HumanBehavior.randomDelay(1000, 2500)
                    // Just hover, don't actually call
                    this.report('phone_hovered', true, 'Viewed phone number')
                    return
                }
            } catch { /* next */ }
        }
    }

    private async actionCheckContactInfo(page: Page) {
        this.report('check_contact', true, 'Checking contact info...')
        const sels = [
            'a[href*="tel:"]', 'a[href*="zalo"]', 'a[href*="zl.me"]',
            'a[href*="mailto:"]', 'a[href*="messenger"]',
            '.contact', '.lien-he', '#contact', '.hotline', '.phone-number',
            '.zalo-chat', '.zalo', 'a[href*="wa.me"]',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2500)
                this.report('found_contact', true, 'Contact info found')
                return
            }
        }
    }

    private async actionViewSocialLinks(page: Page) {
        this.report('view_social', true, 'Viewing social media links...')
        const sels = [
            'a[href*="facebook.com"]', 'a[href*="instagram.com"]',
            'a[href*="youtube.com"]', 'a[href*="tiktok.com"]',
            '.social a', '.social-links a',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
                return
            }
        }
    }

    private async actionHoverElements(page: Page) {
        this.report('hover_elements', true, 'Hovering interactive elements...')
        const sels = [
            'a.btn, button.btn', '.add-to-cart', '.buy-now',
            'a[href*="product"]', 'a[href*="san-pham"]',
            '.card', '.product-card', 'nav a', '.menu a',
        ]
        for (const sel of sels) {
            const els = await page.$$(sel)
            if (els.length > 0) {
                const el = els[Math.floor(Math.random() * Math.min(els.length, 5))]
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(800, 2000)
                return
            }
        }
    }

    private async actionHoverShareButtons(page: Page) {
        this.report('hover_share', true, 'Viewing share buttons...')
        const sels = [
            '.share-buttons', '.social-share', '[class*="share"]',
            'a[href*="sharer"]', 'a[href*="share"]',
        ]
        for (const sel of sels) {
            const el = await page.$(sel)
            if (el) {
                await el.scrollIntoViewIfNeeded().catch(() => { })
                await el.hover().catch(() => { })
                await HumanBehavior.randomDelay(1000, 2000)
                return
            }
        }
    }
}
