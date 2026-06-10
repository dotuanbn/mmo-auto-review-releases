import { Page } from 'playwright'
import { ollamaService } from '../services/OllamaService'
import { DOMUtils, ExtractedInteractiveDOM } from './DOMUtils'
import { HumanBehavior } from './HumanBehavior'
import { contextualInterruptionResolver } from './ContextualInterruptionResolver'
import { AgenticPerformedAction } from './AgenticTrafficHandler'
import { captchaSolverService } from '../services/CaptchaSolverService'

export interface LocationInfo {
    name: string
    address?: string | null
    placeId?: string | null
    url: string
}

export interface AgenticSearchResult {
    success: boolean
    foundMap: boolean
    actionsPerformed: AgenticPerformedAction[]
    message: string
}

type StatusCallback = (status: string) => void

export class AgenticSearchHandler {
    private onStatusUpdate: StatusCallback
    private readonly LLM_TIMEOUT_MS = 60000
    private readonly MAX_SEARCH_STEPS = 6

    constructor(
        onStatusUpdate: StatusCallback
    ) {
        this.onStatusUpdate = onStatusUpdate || (() => { })
    }

    private log(message: string): void {
        console.log(`[AgenticSearch] ${message}`)
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) return error.message
        return String(error)
    }

    private pushAction(
        history: AgenticPerformedAction[],
        action: Omit<AgenticPerformedAction, 'timestamp'>
    ) {
        const fullAction: AgenticPerformedAction = {
            ...action,
            timestamp: new Date().toISOString()
        }
        history.push(fullAction)
    }

    private async delay(min: number, max: number): Promise<void> {
        await HumanBehavior.randomDelay(min, max)
    }

    private async resolveUnexpectedPrompt(page: Page, reason: string): Promise<void> {
        const recovered = await contextualInterruptionResolver.resolve(page, {
            reason: `agentic_search_${reason}`,
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 2,
            goal: 'map_interaction',
            campaignType: 'organic',
            domain: page.url(),
        }).catch(() => ({ handled: false }))

        if (recovered.handled) {
            this.onStatusUpdate(`Da xu ly prompt bat ngo (${reason})`)
            await this.delay(120, 320)
        }
    }

    /**
     * Heuristic fallback: Find and click Maps/business links WITHOUT AI.
     * Used when both Groq and Ollama are unavailable.
     */
    private async heuristicFindTarget(page: Page, location: LocationInfo, threadId: number): Promise<string | null> {
        const nameLC = location.name.toLowerCase()
        const nameParts = nameLC.split(/\s+/).filter(p => p.length > 2)

        try {
            // Strategy 1: Click the "Maps" / "Bản đồ" tab on Google Search
            const mapsTab = await page.$('a[href*="tbm=lcl"], a:has-text("Maps"), a:has-text("Bản đồ"), a[data-hveid]:has-text("Maps")')
            if (mapsTab) {
                this.log(`T${threadId}: Heuristic: Found Maps tab, clicking...`)
                this.onStatusUpdate('[Heuristic] Click tab Bản đồ...')
                await mapsTab.click()
                return 'maps_tab'
            }

            // Strategy 2: Find link with location name text in Local Pack
            const allLinks = await page.$$('a[href*="maps/place"], a[href*="/maps?"], div.VkpGBb a, a[data-cid]')
            for (const link of allLinks) {
                const text = (await link.textContent() || '').toLowerCase()
                const href = (await link.getAttribute('href') || '').toLowerCase()
                const matchCount = nameParts.filter(p => text.includes(p) || href.includes(p)).length
                if (matchCount >= Math.max(1, Math.ceil(nameParts.length * 0.75))) {
                    this.log(`T${threadId}: Heuristic: Found matching link "${text.substring(0, 60)}"`)
                    this.onStatusUpdate(`[Heuristic] Click: ${text.substring(0, 50)}...`)
                    await link.scrollIntoViewIfNeeded().catch(() => {})
                    await this.delay(300, 600)
                    await link.click()
                    return `matched_link: ${text.substring(0, 50)}`
                }
            }

            // Strategy 3: Find any heading/title that matches the name
            const headings = await page.$$('h3, [data-attrid="title"], span.OSrXXb, div.dbg0pd')
            for (const h of headings) {
                const text = (await h.textContent() || '').toLowerCase()
                const matchCount = nameParts.filter(p => text.includes(p)).length
                if (matchCount >= Math.max(1, Math.ceil(nameParts.length * 0.75))) {
                    this.log(`T${threadId}: Heuristic: Found matching heading "${text.substring(0, 60)}"`)
                    this.onStatusUpdate(`[Heuristic] Click: ${text.substring(0, 50)}...`)
                    await h.scrollIntoViewIfNeeded().catch(() => {})
                    await this.delay(300, 600)
                    await h.click()
                    return `matched_heading: ${text.substring(0, 50)}`
                }
            }

            // Strategy 4: Find "More places" / "Xem thêm" button
            const moreBtn = await page.$('a:has-text("More places"), a:has-text("Xem thêm địa điểm"), a:has-text("More results")')
            if (moreBtn) {
                this.onStatusUpdate('[Heuristic] Click Xem thêm...')
                await moreBtn.click()
                return 'more_places'
            }

        } catch (err) {
            this.log(`T${threadId}: Heuristic error: ${err}`)
        }

        return null
    }

    private async isOnTargetMapPage(page: Page, location: LocationInfo): Promise<boolean> {
        const url = page.url().toLowerCase()
        const isPlacePage = url.includes('google.com/maps/place/') ||
            (url.includes('google.com/maps') && url.includes('ftid='))
        const isSidePanel = url.includes('google.com/search') && url.includes('tbm=lcl')

        if (!isPlacePage && !isSidePanel) {
            // Additional check: Does the page title state it's Google Maps and the name?
            const title = await page.title().catch(() => '')
            if (title.toLowerCase().includes('google maps') && this.fuzzyMatch(title, location.name)) {
                return true
            }
            return false
        }

        if (isSidePanel) {
            const sidePanel = await page.$('div.SPZz6b, div[data-attrid="title"]')
            if (!sidePanel) return false
        }

        // ---- Fuzzy Name Verification ----
        // Extract the business name from the DOM and compare
        try {
            const nameOnPage = await page.evaluate(() => {
                // Google Maps place page: the business name is in h1 or span.DUwDvf
                const nameEl = document.querySelector('h1, span.DUwDvf, h2.qrShPb span, div[data-attrid="title"] span')
                return nameEl?.textContent?.trim() || ''
            })

            if (nameOnPage && this.fuzzyMatch(nameOnPage, location.name)) {
                this.log(`Name verified on page: "${nameOnPage}" matches target "${location.name}"`)
                return true
            } else if (nameOnPage) {
                this.log(`Name mismatch: page="${nameOnPage}" vs target="${location.name}". Checking URL fallback...`)
                // Even if name doesn't match perfectly, if URL looks right, trust it
                if (isPlacePage) {
                    // Extract place name from URL
                    const urlPlaceName = decodeURIComponent(url.split('/place/')[1]?.split('/')[0]?.replace(/\+/g, ' ') || '')
                    if (urlPlaceName && this.fuzzyMatch(urlPlaceName, location.name)) {
                        return true
                    }
                }
                return false
            }
        } catch (e) {
            this.log(`Name verification error: ${e}. Falling back to URL check.`)
        }

        // If can't extract name, trust URL pattern
        return isPlacePage
    }

    /**
     * Fuzzy match two strings: returns true if >50% of name words match.
     * Handles Vietnamese diacritics and case insensitivity.
     */
    private fuzzyMatch(text: string, targetName: string): boolean {
        const normalize = (s: string) => s.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd').replace(/Đ/g, 'D')
            .replace(/[^a-z0-9\s]/g, '')
            .trim()

        const normalizedText = normalize(text)
        const normalizedTarget = normalize(targetName)

        // Exact substring match
        if (normalizedText.includes(normalizedTarget) || normalizedTarget.includes(normalizedText)) {
            return true
        }

        // Word-by-word match: at least 50% of target words appear in text
        const targetWords = normalizedTarget.split(/\s+/).filter(w => w.length > 1)
        if (targetWords.length === 0) return false

        const matchCount = targetWords.filter(w => normalizedText.includes(w)).length
        const requiredMatches = Math.max(1, Math.ceil(targetWords.length * 0.75))
        return matchCount >= requiredMatches
    }

    private async isCaptchaOrSorryPage(page: Page): Promise<boolean> {
        if (page.isClosed()) return false;
        try {
            const currentUrl = page.url().toLowerCase();
            if (currentUrl.includes('google.com/sorry') ||
                currentUrl.includes('/sorry/index') ||
                currentUrl.includes('ipv4.google.com/sorry') ||
                currentUrl.includes('recaptcha')) {
                return true;
            }
            const hasRecaptchaFrame = await page.locator('iframe[src*="recaptcha"], div.g-recaptcha').count().catch(() => 0);
            if (hasRecaptchaFrame > 0) return true;
        } catch { /* ignore */ }
        return false;
    }

    /**
     * Executes the search and map finding phase entirely via LLM.
     */
    async executeSearch(
        page: Page,
        keyword: string,
        location: LocationInfo,
        threadId: number = 0
    ): Promise<AgenticSearchResult> {
        this.log(`T${threadId}: Starting Agentic Google Search for "${keyword}" (Target: ${location.name})`)
        const actionsPerformed: AgenticPerformedAction[] = []
        let currentStep = 1

        try {
            // ========= STRATEGY 0: Direct URL Navigation =========
            // If the location URL is a Google Maps URL, and NO explicit search keyword is provided, navigate directly.
            // If a keyword is provided, we MUST perform an organic Google search (skip straight to Strategy 1).
            const hasKeyword = keyword && keyword.trim().length > 0;
            if (!hasKeyword && location.url && /google\.\w+\/maps/i.test(location.url)) {
                this.log(`T${threadId}: Location has direct Maps URL and no keyword provided: ${location.url}. Navigating directly...`)
                this.onStatusUpdate(`[AI] Mở trực tiếp URL Maps...`)
                await page.goto(location.url, { waitUntil: 'commit', timeout: 25000 })
                await this.delay(2000, 4000)

                if (await this.isOnTargetMapPage(page, location)) {
                    this.log(`T${threadId}: Direct URL navigation to target Maps page succeeded.`)
                    this.pushAction(actionsPerformed, {
                        action: 'direct_url_navigation',
                        detail: `Navigated directly to ${location.url}`,
                        source: 'organic',
                        step: currentStep++,
                        success: true
                    })
                    return {
                        success: true,
                        foundMap: true,
                        actionsPerformed,
                        message: 'Navigated directly to Maps URL'
                    }
                }

                this.log(`T${threadId}: Direct URL didn't land on target. Falling back to search...`)
                this.pushAction(actionsPerformed, {
                    action: 'direct_url_fallback',
                    detail: `Direct URL did not reach target, falling back to search`,
                    source: 'organic',
                    step: currentStep++,
                    success: false
                })
            }

            // ========= STRATEGY 1: Google Search → Navigate to Maps =========
            this.onStatusUpdate(`[AI] Truy cập google.com.vn...`)
            await page.goto('https://www.google.com.vn', {
                waitUntil: 'commit',
                timeout: 30000,
            })
            await this.delay(1500, 3000)
            await this.resolveUnexpectedPrompt(page, 'search_landing')

            try {
                const consentBtn = await page.$('button:has-text("Accept all"), button:has-text("Đồng ý"), button:has-text("Accept"), button:has-text("I agree")')
                if (consentBtn) {
                    await consentBtn.click()
                    await this.delay(500, 1000)
                }
            } catch { /* ignore */ }
            await this.resolveUnexpectedPrompt(page, 'search_after_consent')

            this.onStatusUpdate(`[AI] Đang gõ từ khóa: "${keyword}"`)
            const searchSelector = 'textarea[name="q"], input[name="q"]'
            await HumanBehavior.humanClick(page, searchSelector)
            await this.delay(300, 700)
            await HumanBehavior.humanType(page, searchSelector, keyword)
            await this.delay(800, 1500)

            await page.keyboard.press('Enter')
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
            await this.delay(2000, 4000)

            this.pushAction(actionsPerformed, {
                action: 'search_keyword',
                detail: `Searched for ${keyword}`,
                source: 'organic',
                step: currentStep++,
                success: true
            })

            // STEP 2: The Agentic Loop to find the map
            let foundMap = false
            for (let i = 0; i < this.MAX_SEARCH_STEPS; i++) {
                // Emergency Back-out Protocol
                const currentUrl = page.url().toLowerCase()
                const isGoogle = currentUrl.includes('google.')
                if (!isGoogle) {
                    this.log(`T${threadId}: EMERGENCY BACK-OUT. Navigated to non-target external site: ${currentUrl}`)
                    this.pushAction(actionsPerformed, { action: 'emergency_backout', detail: `Reverted from external site: ${currentUrl}`, source: 'safety', step: currentStep++, success: true })
                    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
                    await this.delay(1000, 2000)
                    continue
                }
                if (await this.isOnTargetMapPage(page, location)) {
                    this.log(`T${threadId}: Target map reached successfully!`)
                    foundMap = true
                    break
                }

                if (await this.isCaptchaOrSorryPage(page)) {
                    this.onStatusUpdate(`[AI] Phát hiện mã xác nhận (CAPTCHA), đang xử lý...`)
                    this.log(`T${threadId}: CAPTCHA detected on step ${i + 1}`)
                    
                    // Check if a CAPTCHA solver provider is configured
                    const settings = (await import('../ipc/settings')).loadSettings()
                    const hasCaptchaProvider = settings.captchaSolverProvider && settings.captchaSolverProvider !== 'none' && settings.captchaSolverApiKey

                    if (hasCaptchaProvider) {
                        // Attempt auto-solve via configured provider
                        const solved = await captchaSolverService.solveCaptchaOnPage(page, threadId)
                        if (solved) {
                            this.log(`T${threadId}: CAPTCHA auto-solved via API.`)
                            this.pushAction(actionsPerformed, { action: 'captcha_auto_solved', detail: 'CAPTCHA auto-solved via API', source: 'safety', step: currentStep++, success: true })
                            await this.delay(2000, 4000)
                            continue
                        }

                        // Provider configured but solve failed: Wait up to 60s for manual resolution
                        this.onStatusUpdate(`[AI] Chờ giải CAPTCHA thủ công (60s)...`)
                        this.log(`T${threadId}: Auto-solve failed. Waiting 60s for manual resolution.`)
                        let manuallySolved = false
                        for (let waitSec = 0; waitSec < 60; waitSec += 5) {
                            await this.delay(5000, 5000)
                            if (!(await this.isCaptchaOrSorryPage(page))) {
                                manuallySolved = true
                                break
                            }
                        }

                        if (manuallySolved) {
                            this.log(`T${threadId}: CAPTCHA manually solved.`)
                            this.pushAction(actionsPerformed, { action: 'captcha_manual_solved', detail: 'CAPTCHA manually solved', source: 'safety', step: currentStep++, success: true })
                            continue
                        }

                        this.log(`T${threadId}: CAPTCHA not solved after 60s. Aborting search.`)
                        this.pushAction(actionsPerformed, { action: 'captcha_timeout', detail: 'CAPTCHA not solved in time', source: 'safety', step: currentStep++, success: false })
                        return { success: false, foundMap: false, actionsPerformed, message: 'CAPTCHA_BLOCKED' }
                    }

                    // No CAPTCHA provider configured → skip manual solve, navigate directly to target URL
                    this.log(`T${threadId}: No CAPTCHA provider configured. Skipping manual solve, navigating directly to target URL: ${location.url}`)
                    this.onStatusUpdate(`[AI] Bỏ qua CAPTCHA, vào thẳng URL map...`)
                    this.pushAction(actionsPerformed, { action: 'captcha_bypass_direct_nav', detail: `No solver configured, navigating directly to ${location.url}`, source: 'safety', step: currentStep++, success: true })

                    if (location.url) {
                        await page.goto(location.url, { waitUntil: 'commit', timeout: 25000 }).catch(() => {})
                        await this.delay(2000, 4000)

                        if (await this.isOnTargetMapPage(page, location)) {
                            this.log(`T${threadId}: Direct navigation after CAPTCHA bypass succeeded.`)
                            return { success: true, foundMap: true, actionsPerformed, message: 'Bypassed CAPTCHA via direct URL navigation' }
                        }
                        // Even if not on target, break out of loop — let the fallback at the end handle it
                        break
                    }

                    // No URL available — abort
                    return { success: false, foundMap: false, actionsPerformed, message: 'CAPTCHA_BLOCKED_NO_URL' }
                }

                await this.resolveUnexpectedPrompt(page, `ai_search_loop_${i}`)

                this.onStatusUpdate(`[AI] Đang đọc kết quả tìm kiếm (Lần ${i + 1}/${this.MAX_SEARCH_STEPS})...`)
                
                // Extract lightweight DOM representation
                const domSnapshot = await DOMUtils.extractInteractiveDOM(page)
                
                // If there's barely anything, maybe it's still loading
                if (domSnapshot.summaries.length === 0) {
                    await this.delay(1000, 2000)
                    continue
                }

                this.onStatusUpdate(`[AI] Đang suy nghĩ phải click vào đâu...`)
                
                const systemPrompt = `You are an autonomous agent using Google Search.
Your goal is to reach the Google Maps listing for a business named "${location.name}".
URL keywords to look out for: ${location.url.substring(0, 100)}

Visible interactive elements on the screen:
${domSnapshot.domText}

Decide carefully on your next action:
1. If you see a link or button that looks like the Google Maps listing for "${location.name}" (e.g., in a Local Pack or Places list), output "click" and its ID. Look closely at the text. E.g.: "Kaff Hà Nội - Thiết Bị Bếp".
2. If you see a "Maps" or "Bản đồ" tab link at the top of Google Search and haven't clicked it yet, it's a good idea to click it, output "click" and its ID.
3. If you see a "More places" or "Xem thêm" button and the target isn't visible, click it.
4. If you aren't sure and want to see more results, output "scroll_down".

IMPORTANT RULES:
- **CRITICAL**: DO NOT click on standard website search results. You MUST ONLY click on Google Maps related links (the Maps tab, Local Pack listings, View More Places, etc). Do not navigate away from Google.
- Reply with strictly ONE valid JSON object, NO MARKDOWN, NO OTHER TEXT.
- Format: {"thought": "your reason", "action": "click", "elementId": 123} OR {"thought": "reason", "action": "scroll_down"}
- Allowed actions: "click", "scroll_down"`

                const aiResult = await ollamaService.chat(
                    'Analyze search results and decide next action.',
                    systemPrompt,
                    true,
                    this.LLM_TIMEOUT_MS
                )

                if (!aiResult.success || !aiResult.response) {
                    this.log(`T${threadId}: AI returned error: ${aiResult.error}. Using heuristic fallback.`)
                    this.onStatusUpdate(`[AI] Tìm bằng heuristic...`)
                    
                    // HEURISTIC FALLBACK: Find Maps/business links without AI
                    const heuristicResult = await this.heuristicFindTarget(page, location, threadId)
                    if (heuristicResult) {
                        this.pushAction(actionsPerformed, {
                            action: 'heuristic_click',
                            detail: `Heuristic clicked: ${heuristicResult}`,
                            source: 'heuristic',
                            step: currentStep++,
                            success: true
                        })
                        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
                        await this.delay(2000, 4000)
                    } else {
                        // No heuristic match — scroll to reveal more
                        await HumanBehavior.randomScroll(page, 2)
                        await this.delay(1000, 2000)
                    }
                    continue
                }

                this.log(`T${threadId}: AI Response: ${aiResult.response}`)
                
                let actionObj: { thought?: string, action: string, elementId?: number }
                try {
                    let cleanJson = aiResult.response.trim()
                    if (cleanJson.startsWith('\`\`\`json')) cleanJson = cleanJson.substring(7)
                    if (cleanJson.startsWith('\`\`\`')) cleanJson = cleanJson.substring(3)
                    if (cleanJson.endsWith('\`\`\`')) cleanJson = cleanJson.substring(0, cleanJson.length - 3)
                    actionObj = JSON.parse(cleanJson.trim())
                } catch (e) {
                    this.log(`T${threadId}: Failed to parse AI JSON: ${e}`)
                    await HumanBehavior.randomScroll(page, 2)
                    continue
                }

                if (actionObj.thought) {
                    this.onStatusUpdate(`[AI] Nghĩ: ${actionObj.thought.substring(0, 80)}`)
                    await this.delay(1000, 2000)
                }

                switch (actionObj.action) {
                    case 'click':
                        if (typeof actionObj.elementId === 'number') {
                            const locator = DOMUtils.getObservedElementLocator(page, actionObj.elementId)
                            const count = await locator.count().catch(() => 0)
                            if (count > 0) {
                                this.onStatusUpdate(`[AI] Click vào phần tử ID ${actionObj.elementId}...`)
                                await locator.first().scrollIntoViewIfNeeded().catch(() => { })
                                await this.delay(500, 1000)
                                await locator.first().click().catch(async () => {
                                    await locator.first().click({ force: true }).catch(() => {})
                                })
                                this.pushAction(actionsPerformed, {
                                    action: 'ai_organic_click',
                                    detail: `Clicked element ${actionObj.elementId} (Thought: ${actionObj.thought})`,
                                    source: 'llm',
                                    step: currentStep++,
                                    success: true
                                })
                                await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
                                await this.delay(2000, 4000)
                            } else {
                                this.log(`T${threadId}: Element ID ${actionObj.elementId} not found, scrolling instead...`)
                                await HumanBehavior.randomScroll(page, 2)
                            }
                        } else {
                            await HumanBehavior.randomScroll(page, 2)
                        }
                        break
                    case 'scroll_down':
                        this.onStatusUpdate(`[AI] Đang cuộn xuống tìm tiếp...`)
                        await HumanBehavior.randomScroll(page, 3)
                        this.pushAction(actionsPerformed, {
                            action: 'ai_organic_scroll',
                            detail: `Scrolled down (Thought: ${actionObj.thought})`,
                            source: 'llm',
                            step: currentStep++,
                            success: true
                        })
                        await this.delay(1500, 3000)
                        break
                    default:
                        this.log(`T${threadId}: Unknown action: ${actionObj.action}`)
                        await HumanBehavior.randomScroll(page, 2)
                        break
                }
            }

            if (!foundMap) {
                // Secondary check: sometimes the map is loaded inside a small panel, we need to click the map body
                if (await this.isOnTargetMapPage(page, location)) {
                    foundMap = true
                } else if (location.url) {
                    this.log(`T${threadId}: AI could not find the map organically. Falling back to DIRECT URL NAVIGATION.`)
                    this.onStatusUpdate(`[AI] Không tìm thấy tự nhiên, chuyển hướng tới url...`)
                    await page.goto(location.url, { waitUntil: 'commit', timeout: 25000 }).catch(() => {})
                    await this.delay(3000, 5000)
                    if (await this.isOnTargetMapPage(page, location)) {
                        foundMap = true
                        this.pushAction(actionsPerformed, { action: 'direct_url_fallback', detail: 'Direct URL Navigation after failed search', source: 'safety', step: currentStep++, success: true })
                    }
                }
            }

            return {
                success: true,
                foundMap: foundMap,
                actionsPerformed: actionsPerformed,
                message: foundMap ? 'AI successfully navigated to Map' : 'AI could not find the map after max steps'
            }

        } catch (error) {
            this.log(`T${threadId}: Critical error in AgenticSearchHandler: ${this.formatError(error)}`)
            return {
                success: false,
                foundMap: false,
                actionsPerformed,
                message: this.formatError(error)
            }
        }
    }
}
