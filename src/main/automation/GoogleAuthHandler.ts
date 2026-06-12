import { Page } from 'playwright'
import { browserService, BrowserConfig } from './BrowserService'
import * as crypto from 'crypto'

export interface GoogleLoginResult {
    success: boolean
    error?: string
    requires2FA?: boolean
    contextId?: number
}

export class GoogleAuthHandler {
    // Inline TOTP (same logic as AccountService for independence, no plaintext secret log)
    private generateTOTP(secret: string): string {
        try {
            const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
            const cleanSecret = secret.replace(/\s/g, '').toUpperCase()
            let bits = ''
            for (const char of cleanSecret) {
                const val = base32chars.indexOf(char)
                if (val === -1) continue
                bits += val.toString(2).padStart(5, '0')
            }
            const bytes: number[] = []
            for (let i = 0; i < bits.length - 7; i += 8) {
                bytes.push(parseInt(bits.substr(i, 8), 2))
            }
            const key = Buffer.from(bytes)
            const epoch = Math.floor(Date.now() / 1000)
            const timeStep = Math.floor(epoch / 30)
            const timeBuffer = Buffer.alloc(8)
            timeBuffer.writeBigUInt64BE(BigInt(timeStep))
            const hmac = crypto.createHmac('sha1', key)
            hmac.update(timeBuffer)
            const hash = hmac.digest()
            const offset = hash[hash.length - 1] & 0x0f
            const binary = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff)
            const otp = binary % 1000000
            return otp.toString().padStart(6, '0')
        } catch {
            return ''
        }
    }

    // Login to Google account (supports auto 2FA TOTP if secret provided)
    async login(
        email: string,
        password: string,
        config?: BrowserConfig,
        twoFactorSecret?: string | null
    ): Promise<{ success: boolean; contextId: number; error?: string; requires2FA?: boolean }> {
        const contextId = await browserService.createContext(config)
        const page = browserService.getPage(contextId)

        if (!page) {
            return { success: false, contextId: -1, error: 'Failed to create browser context' }
        }

        try {
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' })
            await browserService.randomDelay(1000, 2000)

            await this.enterEmail(page, email)
            await browserService.randomDelay(2000, 4000)

            if (await this.hasError(page)) {
                return { success: false, contextId, error: 'Email not found or invalid' }
            }

            await this.enterPassword(page, password)
            await browserService.randomDelay(2000, 4000)

            if (await this.hasPasswordError(page)) {
                return { success: false, contextId, error: 'Incorrect password' }
            }

            // Auto handle TOTP 2FA if secret available
            if (await this.requires2FA(page)) {
                if (twoFactorSecret) {
                    const code = this.generateTOTP(twoFactorSecret)
                    if (code) {
                        const submitted = await this.enter2FACode(page, code)
                        if (submitted) {
                            await browserService.randomDelay(2000, 4000)
                            const loggedIn = await this.isLoggedIn(page)
                            if (loggedIn) {
                                return { success: true, contextId }
                            }
                        }
                    }
                }
                return { success: false, contextId, error: '2FA required - please complete manually', requires2FA: true }
            }

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

    // Check if 2FA is required (TOTP code input)
    private async requires2FA(page: Page): Promise<boolean> {
        try {
            const twoFASelectors = [
                'input[type="tel"]',
                '#totpPin',
                'input[name="totpPin"]',
                'input[autocomplete="one-time-code"]',
                'text="2-Step Verification"',
                'text="Xác minh 2 bước"',
                'text="Enter code"',
                'text="Nhập mã"',
            ]
            for (const selector of twoFASelectors) {
                const element = await page.$(selector)
                if (element) return true
            }
            // Fallback: look for common 6-digit prompt text
            const bodyText = await page.textContent('body').catch(() => '')
            if (bodyText && /enter.*code|nhập.*mã|2-step|2 bước|verification code/i.test(bodyText)) return true
            return false
        } catch {
            return false
        }
    }

    // Enter TOTP code (auto for secret case)
    private async enter2FACode(page: Page, code: string): Promise<boolean> {
        try {
            const selectors = [
                '#totpPin',
                'input[name="totpPin"]',
                'input[type="tel"]',
                'input[autocomplete="one-time-code"]',
                'input[aria-label*="code" i]',
            ]
            let input = null
            for (const sel of selectors) {
                input = await page.$(sel)
                if (input) break
            }
            if (!input) {
                // Try any visible text/tel input on 2fa step
                const inputs = await page.$$('input[type="text"], input[type="tel"]')
                if (inputs.length > 0) input = inputs[0]
            }
            if (input) {
                await input.fill('')
                await input.type(code, { delay: 60 })
                await browserService.randomDelay(400, 800)
                // Submit
                await page.keyboard.press('Enter')
                await browserService.randomDelay(1500, 2500)
                return true
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
