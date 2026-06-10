import { Page } from 'playwright'
import { browserService, BrowserConfig } from './BrowserService'

export interface GoogleLoginResult {
    success: boolean
    error?: string
    requires2FA?: boolean
}

export class GoogleAuthHandler {
    // Login to Google account
    async login(
        email: string,
        password: string,
        config?: BrowserConfig
    ): Promise<{ success: boolean; contextId: number; error?: string }> {
        const contextId = await browserService.createContext(config)
        const page = browserService.getPage(contextId)

        if (!page) {
            return { success: false, contextId: -1, error: 'Failed to create browser context' }
        }

        try {
            // Navigate to Google login
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' })
            await browserService.randomDelay(1000, 2000)

            // Enter email
            await this.enterEmail(page, email)
            await browserService.randomDelay(2000, 4000)

            // Check for error
            if (await this.hasError(page)) {
                return { success: false, contextId, error: 'Email not found or invalid' }
            }

            // Enter password
            await this.enterPassword(page, password)
            await browserService.randomDelay(2000, 4000)

            // Check for 2FA
            if (await this.requires2FA(page)) {
                return { success: false, contextId, error: '2FA required - please complete manually' }
            }

            // Check for password error
            if (await this.hasPasswordError(page)) {
                return { success: false, contextId, error: 'Incorrect password' }
            }

            // Check if logged in
            const isLoggedIn = await this.isLoggedIn(page)
            if (isLoggedIn) {
                return { success: true, contextId }
            }

            return { success: false, contextId, error: 'Login failed for unknown reason' }
        } catch (error) {
            console.error('Login error:', error)
            return {
                success: false,
                contextId,
                error: error instanceof Error ? error.message : 'Unknown error'
            }
        }
    }

    // Enter email in login form
    private async enterEmail(page: Page, email: string): Promise<void> {
        const emailInput = 'input[type="email"]'
        await page.waitForSelector(emailInput, { timeout: 10000 })
        await browserService.humanType(page, emailInput, email)
        await browserService.randomDelay(500, 1000)

        // Click next button
        const nextButton = 'button:has-text("Next"), button:has-text("Tiếp theo"), #identifierNext'
        await page.click(nextButton)
    }

    // Enter password in login form
    private async enterPassword(page: Page, password: string): Promise<void> {
        const passwordInput = 'input[type="password"]'
        await page.waitForSelector(passwordInput, { timeout: 15000 })
        await browserService.humanType(page, passwordInput, password)
        await browserService.randomDelay(500, 1000)

        // Click next button
        const nextButton = 'button:has-text("Next"), button:has-text("Tiếp theo"), #passwordNext'
        await page.click(nextButton)
    }

    // Check for login errors
    private async hasError(page: Page): Promise<boolean> {
        try {
            const errorSelector = '[jsname="B34EJ"], .o6cuMc'
            const error = await page.$(errorSelector)
            return error !== null
        } catch {
            return false
        }
    }

    // Check for password error
    private async hasPasswordError(page: Page): Promise<boolean> {
        try {
            const errorTexts = ['Wrong password', 'Sai mật khẩu', 'Incorrect password']
            for (const text of errorTexts) {
                const hasError = await page.$(`text=${text}`)
                if (hasError) return true
            }
            return false
        } catch {
            return false
        }
    }

    // Check if 2FA is required
    private async requires2FA(page: Page): Promise<boolean> {
        try {
            const twoFASelectors = [
                'input[type="tel"]', // Phone verification
                '#idvPin', // PIN input
                'text="2-Step Verification"',
                'text="Xác minh 2 bước"',
            ]

            for (const selector of twoFASelectors) {
                const element = await page.$(selector)
                if (element) return true
            }
            return false
        } catch {
            return false
        }
    }

    // Check if successfully logged in
    private async isLoggedIn(page: Page): Promise<boolean> {
        try {
            // Wait for redirect to myaccount or google.com
            await page.waitForURL(/myaccount\.google\.com|google\.com\/(?!ServiceLogin)/, {
                timeout: 10000
            })
            return true
        } catch {
            // Check for avatar or account menu
            const avatarSelectors = [
                'img[aria-label*="Google Account"]',
                'a[aria-label*="Google Account"]',
                'img.gb_D',
            ]

            for (const selector of avatarSelectors) {
                const avatar = await page.$(selector)
                if (avatar) return true
            }

            return false
        }
    }

    // Handle 2FA with backup code
    async handle2FAWithBackupCode(
        contextId: number,
        code: string
    ): Promise<{ success: boolean; error?: string }> {
        const page = browserService.getPage(contextId)
        if (!page) return { success: false, error: 'No page found' }

        try {
            // Click "Use another method" or backup code option
            const backupOption = 'text="Use your backup code", text="Sử dụng mã dự phòng"'
            const hasBackupOption = await page.$(backupOption)
            if (hasBackupOption) {
                await page.click(backupOption)
                await browserService.randomDelay(1000, 2000)
            }

            // Enter backup code
            const codeInput = 'input[type="text"], input[type="tel"]'
            await browserService.humanType(page, codeInput, code)
            await browserService.randomDelay(500, 1000)

            // Submit
            await page.keyboard.press('Enter')
            await browserService.randomDelay(3000, 5000)

            // Check if logged in
            const isLoggedIn = await this.isLoggedIn(page)
            return { success: isLoggedIn, error: isLoggedIn ? undefined : '2FA verification failed' }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }
        }
    }

    // Save session after successful login
    async saveSession(contextId: number, profilePath: string): Promise<void> {
        await browserService.saveContextState(contextId, profilePath)
    }
}

export const googleAuthHandler = new GoogleAuthHandler()
