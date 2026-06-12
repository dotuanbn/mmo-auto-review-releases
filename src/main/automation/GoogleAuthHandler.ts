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

    // Small inline email normalizer (defensive; AccountService already normalizes on write)
    private normalizeEmailForLogin(email: string): string {
        const t = (email || '').trim()
        if (!t) return t
        return t.includes('@') ? t : `${t}@gmail.com`
    }

    // Login to Google account (supports auto 2FA TOTP if secret provided)
    async login(
        email: string,
        password: string,
        config?: BrowserConfig,
        twoFactorSecret?: string | null,
        recoveryEmail?: string | null
    ): Promise<{ success: boolean; contextId: number; error?: string; requires2FA?: boolean }> {
        const normalizedEmail = this.normalizeEmailForLogin(email)
        if (!normalizedEmail || !normalizedEmail.trim()) {
            return { success: false, contextId: -1, error: 'Thiếu email' }
        }
        if (!password || !password.trim()) {
            return { success: false, contextId: -1, error: 'Thiếu mật khẩu' }
        }

        const contextId = await browserService.createContext(config)
        const page = browserService.getPage(contextId)

        if (!page) {
            return { success: false, contextId: -1, error: 'Failed to create browser context' }
        }

        try {
            // Use domcontentloaded + explicit input wait for reliability on v3 identifier pages
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' })
            await browserService.randomDelay(800, 1600)

            await this.enterEmail(page, normalizedEmail)
            await browserService.randomDelay(1800, 3200)

            if (await this.hasError(page)) {
                return { success: false, contextId, error: 'Email not found or invalid' }
            }

            await this.enterPassword(page, password)
            await browserService.randomDelay(1800, 3200)

            if (await this.hasPasswordError(page)) {
                return { success: false, contextId, error: 'Incorrect password' }
            }

            if (await this.isAccountDisabledOrSuspended(page)) {
                return { success: false, contextId, error: 'Account disabled or suspended by Google' }
            }

            // Handle "Verify it's you" (challenge/selection) recovery email step if present (after password)
            const chal = await this.handleRecoveryEmailChallenge(page, recoveryEmail || null).catch(() => null)
            if (chal && chal.error) {
                return { success: false, contextId, error: chal.error }
            }

            // Auto handle TOTP 2FA if secret available
            if (await this.requires2FA(page)) {
                if (twoFactorSecret) {
                    const code = this.generateTOTP(twoFactorSecret)
                    if (code) {
                        const submitted = await this.enter2FACode(page, code)
                        if (submitted) {
                            await browserService.randomDelay(1800, 3200)
                            if (await this.isAccountDisabledOrSuspended(page)) {
                                return { success: false, contextId, error: 'Account disabled or suspended by Google' }
                            }
                            const loggedIn = await this.isLoggedIn(page)
                            if (loggedIn) {
                                return { success: true, contextId }
                            }
                        }
                    }
                }
                return { success: false, contextId, error: '2FA required - please complete manually', requires2FA: true }
            }

            if (await this.isAccountDisabledOrSuspended(page)) {
                return { success: false, contextId, error: 'Account disabled or suspended by Google' }
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
        } finally {
            // Ensure page/context left in clean state for caller to decide close/save (per existing finally in ipc)
        }
    }

    // Enter email in login form (v3 identifier: #identifierId primary)
    private async enterEmail(page: Page, email: string): Promise<void> {
        // Primary per current Google: input#identifierId ; fallback type=email for resilience
        const emailSelectors = ['input#identifierId', 'input[type="email"]']
        let emailInputSel = emailSelectors[0]
        for (const sel of emailSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 15000 })
                emailInputSel = sel
                break
            } catch {
                // try next
            }
        }
        // Final wait (will throw if none)
        await page.waitForSelector(emailInputSel, { state: 'visible', timeout: 15000 })

        // Prefer human-like, fallback to fill for reliability if click/type blocked
        try {
            await browserService.humanType(page, emailInputSel, email)
        } catch {
            await page.fill(emailInputSel, email).catch(() => {})
        }
        await browserService.randomDelay(400, 900)

        await this.clickNextButton(page, true) // email step
    }

    // Robust Next click: support button, div[role=button], #id variants, text (EN/VI), fallback Enter
    private async clickNextButton(page: Page, isEmailStep = false): Promise<void> {
        const id = isEmailStep ? '#identifierNext' : '#passwordNext'
        const candidates = [
            `${id} button`,
            id,
            'button:has-text("Next"), button:has-text("Tiếp theo")',
            'div[role="button"]:has-text("Next"), div[role="button"]:has-text("Tiếp theo")',
            '[role="button"]:has-text("Next"), [role="button"]:has-text("Tiếp theo")',
            'button[type="button"]:has-text("Next")',
        ]
        let clicked = false
        for (const sel of candidates) {
            try {
                const el = await page.waitForSelector(sel, { state: 'visible', timeout: 2500 }).catch(() => null)
                if (el) {
                    await el.click().catch(async () => {
                        // fallback click via coords if needed
                        const box = await el.boundingBox().catch(() => null)
                        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
                    })
                    clicked = true
                    break
                }
            } catch { /* next */ }
        }
        if (!clicked) {
            // Last resort: press Enter after typing (many flows accept it on focused input)
            await page.keyboard.press('Enter').catch(() => {})
        }
        await browserService.randomDelay(300, 700)
    }

    // Enter password in login form (name=Passwd primary for current Google)
    private async enterPassword(page: Page, password: string): Promise<void> {
        // Wait explicitly for password step after email Next (critical)
        const pwdSelectors = ['input[name="Passwd"]', 'input[type="password"]']
        let pwdSel = pwdSelectors[0]
        for (const sel of pwdSelectors) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 15000 })
                pwdSel = sel
                break
            } catch { /* try next */ }
        }
        await page.waitForSelector(pwdSel, { state: 'visible', timeout: 15000 })

        try {
            await browserService.humanType(page, pwdSel, password)
        } catch {
            await page.fill(pwdSel, password).catch(() => {})
        }
        await browserService.randomDelay(400, 900)

        await this.clickNextButton(page, false)
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

    // Check if 2FA is required (TOTP code input) — waited visible checks
    private async requires2FA(page: Page): Promise<boolean> {
        try {
            const twoFASelectors = [
                '#totpPin',
                'input[name="totpPin"]',
                'input[autocomplete="one-time-code"]',
                'input[type="tel"]',
                'input[aria-label*="code" i]',
            ]
            for (const selector of twoFASelectors) {
                const el = await page.waitForSelector(selector, { state: 'visible', timeout: 2200 }).catch(() => null)
                if (el) return true
            }
            // Text prompts (short non-blocking)
            const bodyText = await page.textContent('body').catch(() => '')
            if (bodyText && /enter.*code|nhập.*mã|2-step|2 bước|verification code|totp|google authenticator/i.test(bodyText)) return true
            return false
        } catch {
            return false
        }
    }

    // Enter TOTP code (auto for secret case) — waited + fill + enter
    private async enter2FACode(page: Page, code: string): Promise<boolean> {
        try {
            const selectors = [
                '#totpPin',
                'input[name="totpPin"]',
                'input[autocomplete="one-time-code"]',
                'input[type="tel"]',
                'input[aria-label*="code" i]',
            ]
            let inputSel: string | null = null
            for (const sel of selectors) {
                const el = await page.waitForSelector(sel, { state: 'visible', timeout: 4000 }).catch(() => null)
                if (el) { inputSel = sel; break }
            }
            if (!inputSel) {
                const any = await page.waitForSelector('input[type="text"], input[type="tel"]', { state: 'visible', timeout: 3000 }).catch(() => null)
                if (any) inputSel = 'input[type="text"], input[type="tel"]'
            }
            if (inputSel) {
                await page.fill(inputSel, '').catch(async () => {
                    const h = await page.$(inputSel!)
                    if (h) await h.fill('').catch(() => {})
                })
                await page.type(inputSel, code, { delay: 55 }).catch(async () => {
                    await browserService.humanType(page, inputSel!, code).catch(() => {})
                })
                await browserService.randomDelay(300, 700)
                await page.keyboard.press('Enter').catch(() => {})
                await browserService.randomDelay(1400, 2400)
                return true
            }
            return false
        } catch {
            return false
        }
    }

    // Check if successfully logged in (now uses shared reliable helper via context cookies primary)
    private async isLoggedIn(page: Page): Promise<boolean> {
        try {
            const ctx = page.context()
            // Direct call (public on BrowserService); cookie-based primary
            if (ctx) {
                const ok = await browserService.isGoogleLoggedIn(undefined, ctx).catch(() => false)
                if (ok) return true
            }
            // Fallback legacy light check (URL/avatar) to keep behavior for edge
            const url = page.url()
            if (url.includes('myaccount.google.com') || (url.includes('google.com') && !/signin|ServiceLogin/i.test(url))) return true
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
        } catch {
            return false
        }
    }

    // Detect real Google account disabled/suspended signals (for correct 'banned'/'suspended' only)
    private async isAccountDisabledOrSuspended(page: Page): Promise<boolean> {
        try {
            const disabledTexts = [
                'account has been disabled',
                'your account is disabled',
                'account disabled',
                'account suspended',
                'your account has been suspended',
                'violated Google',
                'disabled for violating',
                'tài khoản đã bị vô hiệu hóa',
                'tài khoản bị đình chỉ',
                'bị vô hiệu hóa',
            ]
            const bodyText = await page.textContent('body').catch(() => '') || ''
            const lower = bodyText.toLowerCase()
            for (const t of disabledTexts) {
                if (lower.includes(t.toLowerCase())) return true
            }
            // Also check common disabled landing
            const url = page.url()
            if (/disabled|accountdisabled|suspended/i.test(url)) return true
            return false
        } catch {
            return false
        }
    }

    // Handle recovery email challenge after password (selection -> kpe input). Returns early error only for pending cases (never banned here).
    private async handleRecoveryEmailChallenge(page: Page, recoveryEmail: string | null): Promise<{ handled?: boolean; error?: string }> {
        try {
            await browserService.randomDelay(1200, 2200)
            const url = page.url()
            let bodyText = ''
            try {
                bodyText = (await page.textContent('body', { timeout: 4000 }).catch(() => '')) || ''
            } catch {}
            const lower = bodyText.toLowerCase()
            const isSelection = url.includes('/challenge/selection') ||
                url.includes('/v3/signin/challenge') ||
                /verify it'?s you|xác minh đó là bạn/i.test(lower) ||
                /challenge/i.test(url)
            if (!isSelection) return { handled: false }

            const hasRecoveryOpt = /confirm your recovery email|xác nhận email khôi phục/i.test(lower)
            const isPhoneLike = /phone|sms|verification code at|use your phone|xác nhận bằng điện thoại|get a verification code/i.test(lower)

            if (!recoveryEmail || !recoveryEmail.trim()) {
                const msg = hasRecoveryOpt
                    ? 'Cần xác minh thủ công: Xác nhận email khôi phục'
                    : (isPhoneLike ? 'Cần xác minh thủ công: Xác minh điện thoại' : 'Cần xác minh thủ công: Bước xác minh Google')
                return { handled: true, error: msg }
            }

            // Have recoveryEmail: click option
            const clicked = await this.clickRecoveryEmailOption(page)
            if (!clicked) {
                return { handled: true, error: 'Cần xác minh thủ công: Không tìm thấy tùy chọn email khôi phục' }
            }
            await browserService.randomDelay(1000, 2000)

            // Wait input (primary name per Google v3 kpe, fallback type=email)
            const inputSel = await this.waitForRecoveryEmailInput(page)
            if (!inputSel) {
                return { handled: true, error: 'Cần xác minh thủ công: Không tìm thấy ô nhập email khôi phục' }
            }

            try {
                await browserService.humanType(page, inputSel, recoveryEmail.trim())
            } catch {
                await page.fill(inputSel, recoveryEmail.trim()).catch(() => {})
            }
            await browserService.randomDelay(400, 900)

            // Reuse robust next (covers text EN/VI, role=button, #next, Enter fallback)
            await this.clickNextButton(page, false)
            await browserService.randomDelay(1800, 3200)

            if (await this.isAccountDisabledOrSuspended(page)) {
                return { handled: true, error: 'Account disabled or suspended by Google' }
            }
            return { handled: true }
        } catch {
            return { handled: false }
        }
    }

    // Click "Confirm your recovery email" (EN/VI). Search text then clickable container (div[role], li, button etc).
    private async clickRecoveryEmailOption(page: Page): Promise<boolean> {
        const phrases = ['Confirm your recovery email', 'Xác nhận email khôi phục']
        for (const phrase of phrases) {
            try {
                const loc = page.locator(`text="${phrase}"`).first()
                if (await loc.count() > 0) {
                    const visible = await loc.isVisible().catch(() => false)
                    if (visible) {
                        await loc.click({ timeout: 5000 }).catch(async () => {
                            const h = await loc.elementHandle().catch(() => null)
                            if (h) await h.click().catch(() => {})
                        })
                        return true
                    }
                }
                // Fallback $ text=
                const el = await page.$(`text=${phrase}`).catch(() => null)
                if (el && await el.isVisible().catch(() => false)) {
                    await el.click().catch(async () => {
                        const box = await el.boundingBox().catch(() => null)
                        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {})
                    })
                    return true
                }
            } catch {}
        }
        // Broad container scan
        try {
            const containers = await page.$$('div[role="link"],div[role="button"],li,button,[role="listitem"],a,[data-challengeid]')
            for (const c of containers) {
                const txt = ((await c.textContent().catch(() => '')) || '').toLowerCase()
                if (txt.includes('confirm your recovery') || txt.includes('xác nhận email khôi phục')) {
                    if (await c.isVisible().catch(() => false)) {
                        await c.click().catch(async () => {
                            const b = await c.boundingBox().catch(() => null)
                            if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2).catch(() => {})
                        })
                        return true
                    }
                }
            }
        } catch {}
        return false
    }

    // Wait for recovery email input with 12s timeout per sel (per req ~10-15s)
    private async waitForRecoveryEmailInput(page: Page): Promise<string | null> {
        const sels = [
            'input[name="knowledgePreregisteredEmailResponse"]',
            'input[type="email"]',
            'input[autocomplete*="email" i]',
            'input[name*="email" i]'
        ]
        for (const sel of sels) {
            try {
                await page.waitForSelector(sel, { state: 'visible', timeout: 12000 })
                return sel
            } catch { /* try next */ }
        }
        return null
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
