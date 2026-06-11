/**
 * Simple Test Automation - Để test flow cơ bản
 * Test Steps:
 * 1. Open browser with proxy/fingerprint
 * 2. Go to Google.com
 * 3. Search for location
 * 4. Navigate to Google Maps
 * 5. Find review button
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { BrowserWindow } from 'electron'
import { loadSettings } from '../ipc/settings'

class SimpleTestAutomation {
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private page: Page | null = null

    // Send log to renderer
    private log(message: string) {
        console.log(`[SimpleTest] ${message}`)
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('automation:log', { message, timestamp: new Date().toISOString() })
        }
    }

    // Test basic browser launch
    async testBrowserLaunch(): Promise<{ success: boolean; error?: string }> {
        this.log('Starting browser test...')

        try {
            // Launch browser (visible for debugging)
            this.log('Launching Chromium...')
            this.browser = await chromium.launch({
                headless: loadSettings().headless ?? false,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                ]
            })
            this.log('Browser launched successfully!')

            // Create context with fingerprint
            this.log('Creating browser context...')
            this.context = await this.browser.newContext({
                viewport: { width: 1366, height: 768 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'vi-VN',
                timezoneId: 'Asia/Ho_Chi_Minh',
            })
            this.log('Context created!')

            // Apply anti-detection
            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
            })

            // Create page
            this.log('Creating page...')
            this.page = await this.context.newPage()
            this.log('Page created!')

            // Go to Google
            this.log('Navigating to Google.com...')
            await this.page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' })
            this.log('Google loaded!')

            // Wait 2 seconds
            await this.page.waitForTimeout(2000)

            // Take screenshot
            this.log('Taking screenshot...')
            await this.page.screenshot({ path: 'test-screenshot.png' })
            this.log('Screenshot saved!')

            // Close
            this.log('Closing browser...')
            await this.browser.close()
            this.browser = null
            this.log('Test completed successfully!')

            return { success: true }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.log(`ERROR: ${errorMsg}`)

            if (this.browser) {
                await this.browser.close().catch(() => { })
            }

            return { success: false, error: errorMsg }
        }
    }

    // Test full flow: Google -> Search -> Maps -> Review
    async testFullFlow(
        searchQuery: string = 'quán cà phê Hà Nội'
    ): Promise<{ success: boolean; step: string; error?: string }> {
        let currentStep = 'init'

        try {
            // Step 1: Launch browser
            currentStep = 'launch_browser'
            this.log(`[Step 1] Launching browser...`)
            this.browser = await chromium.launch({
                headless: loadSettings().headless ?? false,
                args: ['--disable-blink-features=AutomationControlled']
            })

            this.context = await this.browser.newContext({
                viewport: { width: 1366, height: 768 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'vi-VN',
            })

            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
            })

            this.page = await this.context.newPage()
            this.log(`[Step 1] Browser launched OK`)

            // Step 2: Go to Google
            currentStep = 'google_navigate'
            this.log(`[Step 2] Going to Google...`)
            await this.page.goto('https://www.google.com', { waitUntil: 'networkidle' })
            await this.page.waitForTimeout(1000)
            this.log(`[Step 2] Google loaded OK`)

            // Step 3: Search
            currentStep = 'google_search'
            this.log(`[Step 3] Searching for: ${searchQuery}...`)

            // Find search box
            const searchBox = await this.page.$('textarea[name="q"], input[name="q"]')
            if (!searchBox) {
                throw new Error('Search box not found')
            }

            // Type slowly like human
            await searchBox.click()
            await this.page.waitForTimeout(500)

            for (const char of searchQuery) {
                await this.page.keyboard.type(char, { delay: 50 + Math.random() * 100 })
            }
            await this.page.waitForTimeout(500)

            // Press Enter
            await this.page.keyboard.press('Enter')
            await this.page.waitForTimeout(2000)
            this.log(`[Step 3] Search completed OK`)

            // Step 4: Click on Maps tab
            currentStep = 'maps_tab'
            this.log(`[Step 4] Looking for Maps tab...`)

            // Try to find Maps link
            const mapsLink = await this.page.$('a[href*="maps.google.com"], a[data-hveid][href*="maps"]')
            if (mapsLink) {
                await mapsLink.click()
                await this.page.waitForTimeout(3000)
                this.log(`[Step 4] Maps page loaded OK`)
            } else {
                // Go directly to Maps
                await this.page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`)
                await this.page.waitForTimeout(3000)
                this.log(`[Step 4] Navigated to Maps directly`)
            }

            // Step 5: Look for a place to click
            currentStep = 'find_place'
            this.log(`[Step 5] Looking for places...`)
            await this.page.waitForTimeout(2000)

            // Take screenshot of results
            await this.page.screenshot({ path: 'test-maps-result.png' })
            this.log(`[Step 5] Screenshot saved OK`)

            // Close browser
            currentStep = 'cleanup'
            this.log(`[Cleanup] Closing browser...`)
            await this.browser.close()
            this.browser = null
            this.log(`[Done] Full flow test completed!`)

            return { success: true, step: 'completed' }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.log(`[ERROR at ${currentStep}] ${errorMsg}`)

            if (this.browser) {
                await this.browser.close().catch(() => { })
            }

            return { success: false, step: currentStep, error: errorMsg }
        }
    }
}

export const simpleTestAutomation = new SimpleTestAutomation()
