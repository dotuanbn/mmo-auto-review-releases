import { Page, BrowserContext } from 'playwright'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'

/**
 * HumanBehavior - Simulate human-like browser interactions
 * Designed to bypass automation detection by mimicking real user behavior
 */

export class HumanBehavior {
    /**
     * Human-like typing with variable speed and occasional mistakes
     * @param page - Playwright page
     * @param selector - Element selector to type into
     * @param text - Text to type
     * @param options - Typing options
     */
    static async humanType(
        page: Page,
        selector: string,
        text: string,
        options: {
            minDelay?: number
            maxDelay?: number
            mistakeRate?: number
        } = {}
    ): Promise<void> {
        const { minDelay = 50, maxDelay = 150, mistakeRate = 0.02 } = options

        // Click and focus the element first
        await page.click(selector)
        await this.randomDelay(200, 500)

        for (let i = 0; i < text.length; i++) {
            // Occasionally make a "mistake" and correct it
            if (Math.random() < mistakeRate && i > 0) {
                const wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26))
                await page.keyboard.type(wrongChar)
                await this.randomDelay(100, 300)
                await page.keyboard.press('Backspace')
                await this.randomDelay(50, 150)
            }

            // Type the character with variable speed
            await page.keyboard.type(text[i])

            // Variable delay between characters
            const delay = this.getRandomDelay(minDelay, maxDelay)

            // Longer pause after punctuation or spaces
            if (['.', ',', '!', '?', ' '].includes(text[i])) {
                await this.randomDelay(delay + 50, delay + 200)
            } else {
                await this.sleep(delay)
            }
        }
    }

    /**
     * Human-like mouse movement using Bezier curves
     * @param page - Playwright page
     * @param toX - Target X coordinate
     * @param toY - Target Y coordinate
     * @param steps - Number of movement steps
     */
    static async naturalMouseMove(
        page: Page,
        toX: number,
        toY: number,
        steps: number = 25
    ): Promise<void> {
        // Get current mouse position (or start from random position)
        const viewportSize = await page.viewportSize()
        if (!viewportSize) return

        const fromX = Math.random() * viewportSize.width
        const fromY = Math.random() * viewportSize.height

        // Generate control points for Bezier curve
        const cp1x = fromX + (toX - fromX) * 0.25 + (Math.random() - 0.5) * 100
        const cp1y = fromY + (toY - fromY) * 0.25 + (Math.random() - 0.5) * 100
        const cp2x = fromX + (toX - fromX) * 0.75 + (Math.random() - 0.5) * 100
        const cp2y = fromY + (toY - fromY) * 0.75 + (Math.random() - 0.5) * 100

        // Move along the curve
        for (let i = 0; i <= steps; i++) {
            const t = i / steps

            // Cubic Bezier formula
            const x = Math.pow(1 - t, 3) * fromX +
                3 * Math.pow(1 - t, 2) * t * cp1x +
                3 * (1 - t) * Math.pow(t, 2) * cp2x +
                Math.pow(t, 3) * toX

            const y = Math.pow(1 - t, 3) * fromY +
                3 * Math.pow(1 - t, 2) * t * cp1y +
                3 * (1 - t) * Math.pow(t, 2) * cp2y +
                Math.pow(t, 3) * toY

            await moveCursor(page, x, y)
            await page.mouse.move(x, y)
            await this.sleep(this.getRandomDelay(5, 20))
        }
    }

    /**
     * Random scrolling to simulate reading
     * @param page - Playwright page
     * @param scrollCount - Number of scroll actions
     */
    static async randomScroll(page: Page, scrollCount: number = 3): Promise<void> {
        for (let i = 0; i < scrollCount; i++) {
            // Random scroll direction and amount
            const direction = Math.random() > 0.3 ? 1 : -1 // 70% down, 30% up
            const amount = this.getRandomDelay(100, 400) * direction

            await page.mouse.wheel(0, amount)
            await this.randomDelay(500, 1500)
        }
    }

    /**
     * Micro-jitter: small random mouse movement around a point (humans never hold perfectly still)
     * @param page - Playwright page
     * @param cx - Center X
     * @param cy - Center Y
     * @param rounds - Number of jitter movements (1-4)
     */
    static async microJitter(page: Page, cx: number, cy: number, rounds: number = 2): Promise<void> {
        for (let i = 0; i < rounds; i++) {
            const jx = cx + (Math.random() - 0.5) * this.getRandomDelay(4, 10) // ±2-5px
            const jy = cy + (Math.random() - 0.5) * this.getRandomDelay(4, 10)
            await moveCursor(page, jx, jy)
            await page.mouse.move(jx, jy, { steps: 2 })
            await this.sleep(this.getRandomDelay(30, 120))
        }
    }

    /**
     * Post-click drift: after clicking, move mouse away naturally
     * (real users don't leave the cursor on the button they just clicked)
     * @param page - Playwright page
     * @param fromX - Click X position
     * @param fromY - Click Y position
     */
    static async postClickDrift(page: Page, fromX: number, fromY: number): Promise<void> {
        const viewportSize = await page.viewportSize()
        if (!viewportSize) return

        // Drift 80-250px in a semi-random direction
        const angle = Math.random() * Math.PI * 2
        const dist = this.getRandomDelay(80, 250)
        let driftX = fromX + Math.cos(angle) * dist
        let driftY = fromY + Math.sin(angle) * dist

        // Keep within viewport bounds
        driftX = Math.max(20, Math.min(viewportSize.width - 20, driftX))
        driftY = Math.max(20, Math.min(viewportSize.height - 20, driftY))

        await this.naturalMouseMove(page, driftX, driftY, this.getRandomDelay(8, 15))
        await this.randomDelay(100, 400)
    }

    /**
     * Reading simulation: move mouse slowly downward following text content
     * @param page - Playwright page
     * @param scrollAmount - How many scroll iterations
     */
    static async readingSimulation(page: Page, scrollAmount: number = 3): Promise<void> {
        const viewportSize = await page.viewportSize()
        if (!viewportSize) return

        // Start mouse near the top-center "reading area"
        let mouseX = viewportSize.width * (0.3 + Math.random() * 0.4)
        let mouseY = viewportSize.height * 0.15

        for (let i = 0; i < scrollAmount; i++) {
            // Drift mouse downward as if following text
            mouseY += this.getRandomDelay(40, 100)
            mouseX += (Math.random() - 0.5) * 30
            mouseX = Math.max(50, Math.min(viewportSize.width - 50, mouseX))
            mouseY = Math.min(viewportSize.height * 0.85, mouseY)

            await page.mouse.move(mouseX, mouseY, { steps: this.getRandomDelay(3, 8) })
            await this.randomDelay(400, 1200)

            // Scroll a bit
            await page.mouse.wheel(0, this.getRandomDelay(100, 300))
            await this.randomDelay(600, 1800)

            // Occasionally pause longer (reader finds interesting content)
            if (Math.random() > 0.7) {
                await this.randomDelay(1000, 3000)
            }
        }
    }

    /**
     * Human-like click with pre-movement, micro-jitter, hesitation, and post-click drift
     * @param page - Playwright page  
     * @param selector - Element to click
     */
    static async humanClick(page: Page, selector: string): Promise<void> {
        // Get element bounding box
        const element = await page.$(selector)
        if (!element) throw new Error(`Element not found: ${selector}`)

        const box = await element.boundingBox()
        if (!box) throw new Error(`Element has no bounding box: ${selector}`)

        // Calculate random point within element (inner 60% area)
        const x = box.x + box.width * (0.2 + Math.random() * 0.6)
        const y = box.y + box.height * (0.2 + Math.random() * 0.6)

        // Move mouse naturally to the element
        await this.naturalMouseMove(page, x, y)

        // Micro-jitter: hover around target briefly (humans wiggle slightly)
        await this.microJitter(page, x, y, this.getRandomDelay(1, 3))

        // Pre-click hesitation: pause 200-600ms (cognitive decision moment)
        await this.randomDelay(200, 600)

        // Click with natural button press duration
        await clickCursor(page, x, y)
        await page.mouse.click(x, y, { delay: this.getRandomDelay(30, 80) })

        // Post-click drift: move cursor away naturally
        await this.postClickDrift(page, x, y)
    }

    /**
     * Natural search flow: Google -> Search -> Find Maps
     * @param page - Playwright page
     * @param keyword - Search keyword (business name)
     */
    static async naturalSearch(page: Page, keyword: string): Promise<boolean> {
        // Go to Google
        await page.goto('https://www.google.com', { waitUntil: 'networkidle' })
        await this.randomDelay(1000, 2000)

        // Accept cookies if present
        try {
            const acceptBtn = await page.$('button:has-text("Accept all"), button:has-text("I agree")')
            if (acceptBtn) {
                await acceptBtn.click()
                await this.randomDelay(500, 1000)
            }
        } catch {
            // No cookie dialog
        }

        // Find and click search box
        await this.humanClick(page, 'textarea[name="q"], input[name="q"]')
        await this.randomDelay(300, 600)

        // Type search query naturally
        await this.humanType(page, 'textarea[name="q"], input[name="q"]', keyword)
        await this.randomDelay(500, 1000)

        // Press Enter
        await page.keyboard.press('Enter')
        await page.waitForLoadState('networkidle')
        await this.randomDelay(1500, 2500)

        // Random scroll to simulate reading
        await this.randomScroll(page, 2)

        // Look for Maps link
        try {
            const mapsLink = await page.$('a[href*="maps.google"], a[data-hveid][href*="/maps/"]')
            if (mapsLink) {
                await mapsLink.click()
                await page.waitForLoadState('networkidle')
                return true
            }

            // Or click on Maps tab
            const mapsTab = await page.$('a:has-text("Maps"), a:has-text("Bản đồ")')
            if (mapsTab) {
                await mapsTab.click()
                await page.waitForLoadState('networkidle')
                return true
            }
        } catch (error) {
            console.error('Failed to find Maps link:', error)
        }

        return false
    }

    /**
     * Trust building interactions (click photos, FAQ, etc.)
     * @param page - Playwright page
     */
    static async trustBuilding(page: Page): Promise<void> {
        await this.randomDelay(2000, 4000)

        // Random actions pool
        const actions = [
            async () => {
                // View photos
                const photosBtn = await page.$('button[data-value="Photos"], button[aria-label*="photo"]')
                if (photosBtn) {
                    await photosBtn.click()
                    await this.randomDelay(2000, 4000)
                    await this.randomScroll(page, 2)
                    await page.keyboard.press('Escape')
                }
            },
            async () => {
                // View reviews
                const reviewsTab = await page.$('button[data-value="Reviews"]')
                if (reviewsTab) {
                    await reviewsTab.click()
                    await this.randomDelay(1500, 3000)
                    await this.randomScroll(page, 3)
                }
            },
            async () => {
                // Click on directions
                const directionsBtn = await page.$('button[data-value="Directions"], a[data-item-id="directions"]')
                if (directionsBtn) {
                    await directionsBtn.click()
                    await this.randomDelay(1500, 2500)
                    await page.goBack()
                }
            },
            async () => {
                // Just scroll and read
                await this.randomScroll(page, 4)
            }
        ]

        // Execute 2-3 random actions
        const actionCount = this.getRandomDelay(2, 3)
        const shuffled = actions.sort(() => Math.random() - 0.5)

        for (let i = 0; i < actionCount; i++) {
            try {
                await shuffled[i]()
            } catch {
                // Ignore action failures
            }
            await this.randomDelay(1000, 2000)
        }
    }

    /**
     * Random delay within range
     */
    static async randomDelay(min: number, max: number): Promise<void> {
        const delay = this.getRandomDelay(min, max)
        await this.sleep(delay)
    }

    /**
     * Get random number in range
     */
    static getRandomDelay(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    /**
     * Sleep for specified milliseconds
     */
    static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Simulate reading time based on text length
     */
    static async simulateReading(textLength: number): Promise<void> {
        // Average reading speed: 200-400 words per minute
        // Assume average word length is 5 characters
        const words = textLength / 5
        const readingTimeMs = (words / 300) * 60 * 1000 // 300 WPM average
        const variation = readingTimeMs * 0.3 // ±30% variation

        await this.randomDelay(
            Math.floor(readingTimeMs - variation),
            Math.floor(readingTimeMs + variation)
        )
    }
}

export const humanBehavior = new HumanBehavior()
