/**
 * ScriptRunner - Engine thực thi các automation scripts
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { BrowserWindow } from 'electron'
import type { AutomationScript, ScriptAction, ScriptExecutionResult, ScriptError } from './ScriptTypes'
import * as path from 'path'
import * as fs from 'fs'

export class ScriptRunner {
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private page: Page | null = null
    private shouldStop = false
    private variables: Record<string, any> = {}
    private errors: ScriptError[] = []
    private screenshots: string[] = []

    // Send status to renderer
    private sendStatus(message: string, progress: number) {
        console.log(`[ScriptRunner] ${message}`)
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('script:status', { message, progress })
        }
    }

    // Log helper
    private log(msg: string) {
        console.log(`[ScriptRunner] ${msg}`)
    }

    // Random delay
    private delay(min: number, max: number): Promise<void> {
        const ms = Math.floor(Math.random() * (max - min + 1)) + min
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    // Replace variables in text: {{variable_name}} -> value
    private replaceVariables(text: string): string {
        return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
            return this.variables[varName] !== undefined ? String(this.variables[varName]) : match
        })
    }

    // Stop execution
    stop() {
        this.shouldStop = true
    }

    // Execute script
    async execute(
        script: AutomationScript,
        inputVariables: Record<string, any> = {},
        accountOptions?: { profilePath?: string; email?: string; name?: string }
    ): Promise<ScriptExecutionResult> {
        const startTime = new Date()
        this.shouldStop = false
        this.errors = []
        this.screenshots = []
        let completedActions = 0
        let failedActions = 0

        // Initialize variables
        this.variables = { ...inputVariables }
        for (const v of script.variables) {
            if (this.variables[v.name] === undefined && v.defaultValue !== undefined) {
                this.variables[v.name] = v.defaultValue
            }
        }

        // Set account variables if provided
        if (accountOptions) {
            if (accountOptions.email) this.variables['account_email'] = accountOptions.email
            if (accountOptions.name) this.variables['account_name'] = accountOptions.name || accountOptions.email
        }

        // Add timestamp variable
        this.variables['timestamp'] = Date.now()

        try {
            // Launch browser
            this.log('Launching browser...')
            this.sendStatus('Khởi động trình duyệt...', 0)

            const browserArgs = [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
            ]

            // If account has a profile path, use persistent context for cookies/sessions
            if (accountOptions?.profilePath) {
                this.log(`Using profile: ${accountOptions.profilePath}`)
                this.sendStatus(`Dùng profile: ${accountOptions.email || 'Unknown'}`, 0)

                // Ensure profile directory exists
                if (!fs.existsSync(accountOptions.profilePath)) {
                    fs.mkdirSync(accountOptions.profilePath, { recursive: true })
                }

                this.context = await chromium.launchPersistentContext(accountOptions.profilePath, {
                    headless: script.settings.headless,
                    args: browserArgs,
                    viewport: script.settings.viewport,
                    userAgent: script.settings.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    locale: script.settings.locale || 'vi-VN',
                    timezoneId: script.settings.timezone || 'Asia/Ho_Chi_Minh',
                })

                // Anti-detection
                await this.context.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
                })

                this.page = this.context.pages()[0] || await this.context.newPage()
            } else {
                // Normal launch without persistent profile
                this.browser = await chromium.launch({
                    headless: script.settings.headless,
                    args: browserArgs,
                })

                // Create context
                this.context = await this.browser.newContext({
                    viewport: script.settings.viewport,
                    userAgent: script.settings.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    locale: script.settings.locale || 'vi-VN',
                    timezoneId: script.settings.timezone || 'Asia/Ho_Chi_Minh',
                })

                // Anti-detection
                await this.context.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
                })

                this.page = await this.context.newPage()
            }

            // Execute actions
            const enabledActions = script.actions.filter(a => a.enabled)
            const totalActions = enabledActions.length

            for (let i = 0; i < enabledActions.length && !this.shouldStop; i++) {
                const action = enabledActions[i]
                const progress = Math.floor(((i + 1) / totalActions) * 100)

                this.sendStatus(`Đang thực hiện: ${action.name}`, progress)
                this.log(`Executing action ${i + 1}/${totalActions}: ${action.name} (${action.type})`)

                try {
                    await this.executeAction(action)
                    completedActions++
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
                    this.log(`Error in action ${action.name}: ${errorMsg}`)

                    this.errors.push({
                        actionId: action.id,
                        actionName: action.name,
                        error: errorMsg,
                        timestamp: new Date()
                    })
                    failedActions++

                    // Handle error based on action config
                    if (action.onError === 'stop') {
                        this.log('Stopping due to error')
                        break
                    } else if (action.onError === 'retry' && action.maxRetries) {
                        // Retry logic
                        let retried = false
                        for (let retry = 0; retry < action.maxRetries; retry++) {
                            this.log(`Retrying... attempt ${retry + 1}`)
                            await this.delay(1000, 2000)
                            try {
                                await this.executeAction(action)
                                retried = true
                                completedActions++
                                failedActions--
                                break
                            } catch {
                                // Continue retrying
                            }
                        }
                        if (!retried) {
                            this.log('All retries failed')
                        }
                    }
                    // continue by default
                }
            }

            this.sendStatus('Hoàn thành!', 100)

            return {
                success: failedActions === 0,
                startTime,
                endTime: new Date(),
                totalActions,
                completedActions,
                failedActions,
                errors: this.errors,
                variables: this.variables,
                screenshots: this.screenshots
            }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.log(`Fatal error: ${errorMsg}`)

            return {
                success: false,
                startTime,
                endTime: new Date(),
                totalActions: script.actions.filter(a => a.enabled).length,
                completedActions,
                failedActions: failedActions + 1,
                errors: [...this.errors, { actionId: 'system', actionName: 'System', error: errorMsg, timestamp: new Date() }],
                variables: this.variables,
                screenshots: this.screenshots
            }
        } finally {
            if (this.context) await this.context.close().catch(() => { })
            if (this.browser) await this.browser.close().catch(() => { })
            this.context = null
            this.browser = null
            this.page = null
        }
    }

    // Normalize text for fuzzy comparison (lowercase, strip accents, trim)
    private normalizeText(text: string): string {
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') // strip diacritics/accents
            .replace(/[^a-z0-9\s]/g, '')     // remove special chars
            .replace(/\s+/g, ' ')
            .trim()
    }

    // Check if two texts are a fuzzy match (one contains the other or high overlap)
    private isFuzzyMatch(text1: string, text2: string): boolean {
        const n1 = this.normalizeText(text1)
        const n2 = this.normalizeText(text2)
        if (!n1 || !n2) return false
        // Direct containment
        if (n1.includes(n2) || n2.includes(n1)) return true
        // Word overlap: at least 60% of shorter text's words found in longer
        const words1 = n1.split(' ')
        const words2 = n2.split(' ')
        const shorter = words1.length <= words2.length ? words1 : words2
        const longer = words1.length > words2.length ? words1 : words2
        const matchCount = shorter.filter(w => longer.some(lw => lw.includes(w) || w.includes(lw))).length
        return matchCount / shorter.length >= 0.6
    }

    // Multi-strategy Maps click: find and click the correct Maps result
    private async executeMapsClick(): Promise<void> {
        if (!this.page) throw new Error('Page not initialized')

        const locationName = String(this.variables['location_name'] || '')
        this.log(`[maps_click] Looking for: "${locationName}"`)

        // === Strategy 1: Google Knowledge Panel (right-side Maps card) ===
        this.log('[maps_click] Strategy 1: Knowledge Panel...')
        try {
            const kpSelectors = [
                'div.kp-header a[href*="/maps/place"]',
                'a.FLP8od[href*="/maps/"]',
                'div[data-attrid="kc:/location"] a[href*="maps"]',
                'a[data-url*="maps.google.com"]',
            ]
            for (const sel of kpSelectors) {
                const el = await this.page.$(sel)
                if (el) {
                    this.log(`[maps_click] ✓ Found Knowledge Panel link: ${sel}`)
                    await el.click()
                    await this.page.waitForLoadState('networkidle')
                    await this.delay(2000, 3000)
                    await this.verifyMapsLanding(locationName)
                    return
                }
            }
        } catch (e) {
            this.log(`[maps_click] Strategy 1 failed: ${e instanceof Error ? e.message : e}`)
        }

        // === Strategy 2: Local Pack (3-pack Maps results) with name matching ===
        this.log('[maps_click] Strategy 2: Local Pack name matching...')
        try {
            const localPackItems = await this.page.$$('div.VkpGBb, div[jscontroller] div[data-cid]')
            if (localPackItems.length > 0) {
                this.log(`[maps_click] Found ${localPackItems.length} Local Pack items`)

                for (const item of localPackItems) {
                    const title = await item.$eval(
                        'span.OSrXXb, div.dbg0pd, a div.fontBodyLarge, div.qBF1Pd',
                        (el: Element) => el.textContent || ''
                    ).catch(() => '')

                    if (title && locationName && this.isFuzzyMatch(title, locationName)) {
                        this.log(`[maps_click] ✓ Matched Local Pack: "${title}"`)
                        const link = await item.$('a[href*="google.com/maps"], a')
                        if (link) {
                            await link.click()
                            await this.page.waitForLoadState('networkidle')
                            await this.delay(2000, 3000)
                            await this.verifyMapsLanding(locationName)
                            return
                        }
                    }
                }

                // No name match but no location_name — click first
                if (!locationName) {
                    const firstLink = await localPackItems[0].$('a[href*="google.com/maps"], a')
                    if (firstLink) {
                        this.log('[maps_click] ✓ No location_name, clicking first Local Pack result')
                        await firstLink.click()
                        await this.page.waitForLoadState('networkidle')
                        await this.delay(2000, 3000)
                        return
                    }
                }
            }
        } catch (e) {
            this.log(`[maps_click] Strategy 2 failed: ${e instanceof Error ? e.message : e}`)
        }

        // === Strategy 3: Any Maps link on page, with name matching ===
        this.log('[maps_click] Strategy 3: Scanning all Maps links...')
        try {
            const allMapsLinks = await this.page.$$('a[href*="google.com/maps/place"], a[href*="/maps/place"]')
            this.log(`[maps_click] Found ${allMapsLinks.length} Maps place links`)

            if (allMapsLinks.length > 0 && locationName) {
                for (const link of allMapsLinks) {
                    const href = await link.getAttribute('href') || ''
                    const linkText = await link.textContent() || ''
                    const ariaLabel = await link.getAttribute('aria-label') || ''

                    // Decode place name from URL: /maps/place/Cafe+Name/
                    let urlName = ''
                    const placeMatch = href.match(/\/maps\/place\/([^/]+)/)
                    if (placeMatch) {
                        urlName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '))
                    }

                    const matchText = `${linkText} ${ariaLabel} ${urlName}`
                    if (this.isFuzzyMatch(matchText, locationName)) {
                        this.log(`[maps_click] ✓ Found matching Maps link`)
                        await link.click()
                        await this.page.waitForLoadState('networkidle')
                        await this.delay(2000, 3000)
                        await this.verifyMapsLanding(locationName)
                        return
                    }
                }
            }

            // Fallback: click first Maps link if exists
            if (allMapsLinks.length > 0) {
                this.log('[maps_click] ✓ No name match, clicking first Maps place link')
                await allMapsLinks[0].click()
                await this.page.waitForLoadState('networkidle')
                await this.delay(2000, 3000)
                await this.verifyMapsLanding(locationName)
                return
            }

            // Try generic Maps tab link
            const mapsTabLink = await this.page.$('a:has-text("Maps"), a:has-text("Bản đồ")')
            if (mapsTabLink) {
                this.log('[maps_click] ✓ Clicking Maps tab')
                await mapsTabLink.click()
                await this.page.waitForLoadState('networkidle')
                await this.delay(2000, 3000)
                await this.clickFirstMapsResult(locationName)
                return
            }
        } catch (e) {
            this.log(`[maps_click] Strategy 3 failed: ${e instanceof Error ? e.message : e}`)
        }

        // === Strategy 4: Direct navigation fallback ===
        this.log('[maps_click] Strategy 4: Direct Maps URL fallback...')
        const searchTerm = locationName || 'địa điểm'
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`
        this.log(`[maps_click] Navigating to: ${mapsUrl}`)
        await this.page.goto(mapsUrl, { waitUntil: 'networkidle' })
        await this.delay(3000, 5000)
        await this.clickFirstMapsResult(locationName)
    }

    // Click first result in a Google Maps search results list
    private async clickFirstMapsResult(locationName: string): Promise<void> {
        if (!this.page) return

        try {
            await this.page.waitForSelector('div[role="feed"] a, a.hfpxzc', { timeout: 10000 }).catch(() => { })

            if (locationName) {
                const results = await this.page.$$('a.hfpxzc')
                for (const result of results) {
                    const ariaLabel = await result.getAttribute('aria-label') || ''
                    if (this.isFuzzyMatch(ariaLabel, locationName)) {
                        this.log(`[maps_click] ✓ Clicking Maps result: "${ariaLabel}"`)
                        await result.click()
                        await this.delay(2000, 3000)
                        return
                    }
                }
            }

            // Just click the first result
            const firstResult = await this.page.$('a.hfpxzc')
            if (firstResult) {
                const label = await firstResult.getAttribute('aria-label') || 'unknown'
                this.log(`[maps_click] ✓ Clicking first Maps result: "${label}"`)
                await firstResult.click()
                await this.delay(2000, 3000)
            }
        } catch (e) {
            this.log(`[maps_click] clickFirstMapsResult failed: ${e instanceof Error ? e.message : e}`)
        }
    }

    // Verify we landed on the correct Maps place page
    private async verifyMapsLanding(expectedName: string): Promise<void> {
        if (!this.page || !expectedName) return

        try {
            const heading = await this.page.$eval(
                'h1.DUwDvf, h1.fontHeadlineLarge, h1',
                (el: Element) => el.textContent || ''
            ).catch(() => '')

            if (heading) {
                const isMatch = this.isFuzzyMatch(String(heading), expectedName)
                if (isMatch) {
                    this.log(`[maps_click] ✅ Verified: "${heading}" matches "${expectedName}"`)
                } else {
                    this.log(`[maps_click] ⚠️ WARNING: Landed on "${heading}" but expected "${expectedName}"`)
                }
            }
        } catch {
            // Verification is best-effort
        }
    }

    // Execute single action
    private async executeAction(action: ScriptAction): Promise<void> {
        if (!this.page) throw new Error('Page not initialized')
        const p = action.params

        switch (action.type) {
            case 'navigate':
                await this.page.goto(this.replaceVariables(p.url || ''), { waitUntil: 'networkidle' })
                break

            case 'click':
                const clickSelector = this.replaceVariables(p.selector || '')
                await this.page.click(clickSelector, { timeout: p.timeout || 30000 })
                break

            case 'type':
                const typeSelector = this.replaceVariables(p.selector || '')
                const typeText = this.replaceVariables(p.text || '')
                if (p.clearFirst) {
                    await this.page.fill(typeSelector, '')
                }
                await this.page.type(typeSelector, typeText)
                break

            case 'human_type':
                const htSelector = this.replaceVariables(p.selector || '')
                const htText = this.replaceVariables(p.text || '')
                if (p.clearFirst) {
                    await this.page.fill(htSelector, '')
                }
                // Type like a human - character by character
                await this.page.click(htSelector)
                for (const char of htText) {
                    await this.page.keyboard.type(char)
                    await this.delay(p.minDelay || 50, p.maxDelay || 150)
                }
                break

            case 'wait':
                if (p.waitType === 'time') {
                    await this.delay(p.waitTime || 1000, p.waitTime || 1000)
                } else if (p.waitType === 'element' && p.waitSelector) {
                    await this.page.waitForSelector(this.replaceVariables(p.waitSelector), { timeout: p.timeout || 30000 })
                } else if (p.waitType === 'navigation') {
                    await this.page.waitForLoadState('networkidle')
                }
                break

            case 'random_delay':
                await this.delay(p.minDelayMs || 1000, p.maxDelayMs || 3000)
                break

            case 'scroll':
                if (p.scrollToElement) {
                    const el = await this.page.$(this.replaceVariables(p.scrollToElement))
                    if (el) await el.scrollIntoViewIfNeeded()
                } else {
                    const amount = p.scrollAmount || 300
                    const direction = p.scrollDirection || 'down'
                    if (direction === 'down') {
                        await this.page.mouse.wheel(0, amount)
                    } else if (direction === 'up') {
                        await this.page.mouse.wheel(0, -amount)
                    }
                }
                break

            case 'random_scroll':
                const scrollCount = Math.floor(Math.random() * ((p.maxScrolls || 5) - (p.minScrolls || 1) + 1)) + (p.minScrolls || 1)
                for (let i = 0; i < scrollCount; i++) {
                    const scrollAmount = Math.floor(Math.random() * 400) + 100
                    await this.page.mouse.wheel(0, scrollAmount)
                    await this.delay(500, 1500)
                }
                break

            case 'keyboard':
                if (p.key) {
                    if (p.modifiers && p.modifiers.length > 0) {
                        for (const mod of p.modifiers) {
                            await this.page.keyboard.down(mod)
                        }
                    }
                    await this.page.keyboard.press(p.key)
                    if (p.modifiers && p.modifiers.length > 0) {
                        for (const mod of p.modifiers.reverse()) {
                            await this.page.keyboard.up(mod)
                        }
                    }
                }
                break

            case 'screenshot':
                const ssName = this.replaceVariables(p.screenshotName || `screenshot-${Date.now()}`)
                const ssPath = path.join(process.cwd(), `${ssName}.png`)
                await this.page.screenshot({ path: ssPath, fullPage: p.fullPage })
                this.screenshots.push(ssPath)
                this.log(`Screenshot saved: ${ssPath}`)
                break

            case 'hover':
                const hoverSelector = this.replaceVariables(p.selector || '')
                await this.page.hover(hoverSelector)
                break

            case 'select':
                const selectSelector = this.replaceVariables(p.selector || '')
                const selectValue = this.replaceVariables(p.selectValue || '')
                if (p.selectByText) {
                    await this.page.selectOption(selectSelector, { label: selectValue })
                } else {
                    await this.page.selectOption(selectSelector, selectValue)
                }
                break

            case 'upload':
                const uploadSelector = this.replaceVariables(p.inputSelector || p.selector || '')
                const filePath = this.replaceVariables(p.filePath || '')
                if (fs.existsSync(filePath)) {
                    await this.page.setInputFiles(uploadSelector, filePath)
                } else {
                    throw new Error(`File not found: ${filePath}`)
                }
                break

            case 'extract':
                const extractSelector = this.replaceVariables(p.selector || '')
                const text = await this.page.textContent(extractSelector)
                if (p.variableName) {
                    this.variables[p.variableName] = text?.trim() || ''
                }
                break

            case 'variable':
                if (p.variableName) {
                    if (p.extractFrom) {
                        const extractedText = await this.page.textContent(this.replaceVariables(p.extractFrom))
                        this.variables[p.variableName] = extractedText?.trim() || ''
                    } else {
                        this.variables[p.variableName] = this.replaceVariables(p.variableValue || '')
                    }
                }
                break

            case 'google_search':
                const searchQuery = this.replaceVariables(p.searchQuery || '')
                // Find and click search box
                const searchBox = await this.page.$('textarea[name="q"], input[name="q"]')
                if (!searchBox) throw new Error('Search box not found')
                await searchBox.click()
                await this.delay(300, 500)
                // Type like human
                for (const char of searchQuery) {
                    await this.page.keyboard.type(char)
                    await this.delay(30, 100)
                }
                await this.delay(500, 1000)
                await this.page.keyboard.press('Enter')
                await this.page.waitForLoadState('networkidle')
                break

            case 'maps_click':
                await this.executeMapsClick()
                break

            case 'set_rating':
                const rating = p.rating || 5
                // Click on star rating (usually the nth star element)
                const starSelector = `div[role="radiogroup"] [role="radio"]:nth-child(${rating}), button[aria-label*="${rating}"]`
                const starEl = await this.page.$(starSelector)
                if (starEl) {
                    await starEl.click()
                } else {
                    this.log(`Warning: Could not find rating element for ${rating} stars`)
                }
                break

            case 'write_review':
                const reviewText = this.replaceVariables(p.reviewText || '')
                const reviewTextarea = await this.page.$('textarea[aria-label*="review"], textarea[placeholder*="review"], textarea[jsname]')
                if (reviewTextarea) {
                    await reviewTextarea.click()
                    for (const char of reviewText) {
                        await this.page.keyboard.type(char)
                        await this.delay(30, 100)
                    }
                } else {
                    throw new Error('Review textarea not found')
                }
                break

            case 'loop':
                if (p.loopActions && p.loopCount) {
                    for (let i = 0; i < p.loopCount && !this.shouldStop; i++) {
                        this.variables['loop_index'] = i
                        for (const loopAction of p.loopActions) {
                            if (loopAction.enabled) {
                                await this.executeAction(loopAction)
                            }
                        }
                    }
                }
                break

            case 'condition':
                if (action.condition) {
                    const varValue = String(this.variables[action.condition.variable] || '')
                    let conditionMet = false

                    switch (action.condition.operator) {
                        case 'equals':
                            conditionMet = varValue === action.condition.value
                            break
                        case 'not_equals':
                            conditionMet = varValue !== action.condition.value
                            break
                        case 'contains':
                            conditionMet = varValue.includes(action.condition.value)
                            break
                        case 'exists':
                            conditionMet = varValue.length > 0
                            break
                    }

                    const actionsToRun = conditionMet ? p.thenActions : p.elseActions
                    if (actionsToRun) {
                        for (const condAction of actionsToRun) {
                            if (condAction.enabled) {
                                await this.executeAction(condAction)
                            }
                        }
                    }
                }
                break

            case 'go_back':
                await this.page.goBack({ waitUntil: 'networkidle' })
                break

            case 'refresh_page':
                await this.page.reload({ waitUntil: 'networkidle' })
                break

            default:
                this.log(`Unknown action type: ${action.type}`)
        }
    }
}

export const scriptRunner = new ScriptRunner()
