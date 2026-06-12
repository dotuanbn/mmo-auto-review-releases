import { ipcMain } from 'electron'
import { accountService } from '../services/AccountService'
import { profileService } from '../services/ProfileService'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { loadSettings } from './settings'
import type { Account } from '../database/schema'

// Track open manual login browsers so we don't open duplicates
const openManualBrowsers: Map<number, any> = new Map()

type LegacyAccount = {
    loginType?: 'auto' | 'manual'
}

function isManualAccount(account: unknown): boolean {
    return (account as LegacyAccount).loginType === 'manual'
}

const ACCOUNT_STATUSES: ReadonlySet<Account['status']> = new Set<Account['status']>([
    'active',
    'banned',
    'pending',
    'suspended',
    'checking',
])

type AccountUpdatePayload = {
    email?: unknown
    password?: unknown
    recoveryEmail?: unknown
    recoveryPhone?: unknown
    twoFactorSecret?: unknown
    loginType?: unknown
    status?: unknown
}

function normalizeLoginType(value: unknown): 'auto' | 'manual' {
    return value === 'manual' ? 'manual' : 'auto'
}

function sanitizeAccountUpdatePayload(data: unknown): Partial<Account> {
    const input = (data && typeof data === 'object' ? data : {}) as AccountUpdatePayload
    const update: Partial<Account> = {}

    if (typeof input.email === 'string') update.email = input.email.trim()
    if (typeof input.password === 'string') update.password = input.password
    if (typeof input.recoveryEmail === 'string' || input.recoveryEmail === null) update.recoveryEmail = input.recoveryEmail
    if (typeof input.recoveryPhone === 'string' || input.recoveryPhone === null) update.recoveryPhone = input.recoveryPhone
    if (typeof input.twoFactorSecret === 'string' || input.twoFactorSecret === null) update.twoFactorSecret = input.twoFactorSecret
    if (input.loginType === 'auto' || input.loginType === 'manual') update.loginType = input.loginType
    if (typeof input.status === 'string' && ACCOUNT_STATUSES.has(input.status as Account['status'])) {
        update.status = input.status as Account['status']
    }

    return update
}

function toFriendlyAccountError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error')
    // Never leak secrets/args; map launch/profile closed (common lock or conflict) to actionable UI text
    if (/target page, context or browser has been closed|launchPersistentContext|browser has been closed/i.test(raw)) {
        return 'Không mở được trình duyệt (profile có thể bị khóa bởi Chrome khác hoặc lỗi khởi động). Đóng Chrome đang dùng, thử lại hoặc xóa profile rồi đăng nhập.'
    }
    if (/executablePath|channel|user-data-dir/i.test(raw)) {
        return 'Lỗi cấu hình trình duyệt. Vui lòng thử lại hoặc kiểm tra Chrome đã cài.'
    }
    return raw.length > 200 ? raw.slice(0, 200) + '...' : raw
}

export function registerAccountHandlers() {
    // Get all accounts
    ipcMain.handle('accounts:getAll', async () => {
        return accountService.getAll()
    })

    ipcMain.handle('accounts:getActiveCount', async () => {
        return accountService.getActiveCount()
    })

    // Get account by ID
    ipcMain.handle('accounts:getById', async (_event, id: number) => {
        return accountService.getById(id)
    })

    // Add new account (supports 2FA secret)
    ipcMain.handle('accounts:add', async (_event, data: {
        email: string
        password: string
        recoveryEmail?: string
        recoveryPhone?: string
        loginType?: 'auto' | 'manual'
        twoFactorSecret?: string
    }) => {
        return accountService.create({
            email: data.email,
            password: data.password,
            recoveryEmail: data.recoveryEmail,
            recoveryPhone: data.recoveryPhone,
            loginType: normalizeLoginType(data.loginType),
            twoFactorSecret: data.twoFactorSecret || null,
            status: 'pending',
            totalReviews: 0,
            createdAt: new Date(),
        })
    })

    // Update account
    ipcMain.handle('accounts:update', async (_event, id: number, data: unknown) => {
        const update = sanitizeAccountUpdatePayload(data)
        if (Object.keys(update).length === 0) {
            return accountService.getById(id)
        }
        return accountService.update(id, update)
    })

    // Delete account
    ipcMain.handle('accounts:delete', async (_event, id: number) => {
        return accountService.delete(id)
    })

    // Import from CSV (rich: supports 2fa + loginType)
    ipcMain.handle('accounts:importCSV', async (_event, accounts: Array<{
        email: string
        password: string
        recoveryEmail?: string
        recoveryPhone?: string
        twoFactorSecret?: string
        loginType?: 'auto' | 'manual'
    }>) => {
        return accountService.importFromCSV(accounts)
    })

    // Get statistics
    ipcMain.handle('accounts:getStats', async () => {
        return accountService.getStats()
    })

    ipcMain.handle('accounts:checkLiveDie', async (_event, id: number) => {
        return accountService.checkLiveDie(id)
    })

    // Test account login (headless - FULL AUTO: credential + TOTP if secret; uses GoogleAuthHandler for reliability)
    ipcMain.handle('accounts:testLogin', async (_event, id: number) => {
        let contextId: number | null = null
        try {
            const account = await accountService.getById(id)
            if (!account) return { success: false, message: 'Account not found' }

            if (isManualAccount(account)) {
                return { success: false, message: 'Tài khoản thủ công: Hãy dùng nút Đăng nhập thủ công' }
            }

            await accountService.updateStatus(id, 'checking')

            const { googleAuthHandler } = await import('../automation/GoogleAuthHandler')
            const { profileService } = await import('../services/ProfileService')

            const profilePath = account.profilePath || await profileService.createProfile(id, account.email)

            // Single create via handler (reuses BrowserService with channel/args/stealth/lock-clean). No outer create to avoid same-profile lock conflict.
            const loginResult = await googleAuthHandler.login(
                account.email,
                account.password,
                { headless: loadSettings().headless ?? false, profilePath },
                account.twoFactorSecret || undefined
            )
            contextId = loginResult.contextId >= 0 ? loginResult.contextId : null

            if (loginResult.success) {
                await googleAuthHandler.saveSession(contextId!, profilePath)
                // Explicitly persist cookies JSON to accounts.cookies for Traffic/Review engines
                try {
                    const { browserService } = await import('../automation/BrowserService')
                    const ctx = browserService.getContext(contextId!)
                    if (ctx) {
                        const ck = await ctx.cookies().catch(() => [])
                        if (ck && ck.length) await accountService.saveCookies(id, JSON.stringify(ck))
                    }
                } catch {}
                await accountService.updateStatus(id, 'active')
                await accountService.updateLastUsed(id)
                return { success: true, message: 'Auto login successful (TOTP handled if present) - account active!' }
            }

            if (loginResult.requires2FA) {
                await accountService.updateStatus(id, 'pending')
                return { success: false, message: '2FA required but no valid secret - use manual login', needs2FA: true }
            }

            await accountService.updateStatus(id, 'banned')
            return { success: false, message: loginResult.error || 'Auto login failed' }
        } catch (error) {
            await accountService.updateStatus(id, 'pending')
            return {
                success: false,
                message: toFriendlyAccountError(error),
            }
        } finally {
            if (contextId !== null) {
                try {
                    const { browserService } = await import('../automation/BrowserService')
                    await browserService.closeContext(contextId)
                } catch (closeError) {
                    console.error('[accounts:testLogin] Failed to close browser context:', closeError)
                }
            }
        }
    })

    // Login with visible browser (visible for user intervention/CAPTCHA; tries auto + TOTP first)
    ipcMain.handle('accounts:loginVisible', async (_event, id: number) => {
        let contextId: number | null = null
        let keepContextOpen = false
        try {
            const account = await accountService.getById(id)
            if (!account) return { success: false, message: 'Account not found' }

            if (isManualAccount(account)) {
                return { success: false, message: 'Tài khoản thủ công: Hãy dùng nút Đăng nhập thủ công' }
            }

            await accountService.updateStatus(id, 'checking')

            const { googleAuthHandler } = await import('../automation/GoogleAuthHandler')
            const { profileService } = await import('../services/ProfileService')

            const profilePath = account.profilePath || await profileService.createProfile(id, account.email)

            // Single create via handler (BrowserService channel/args/stealth + lock clean). No duplicate create on same profile.
            const loginResult = await googleAuthHandler.login(
                account.email,
                account.password,
                { headless: false, profilePath },
                account.twoFactorSecret || undefined
            )
            contextId = loginResult.contextId >= 0 ? loginResult.contextId : null

            if (loginResult.success) {
                await googleAuthHandler.saveSession(contextId!, profilePath)
                try {
                    const { browserService } = await import('../automation/BrowserService')
                    const ctx = browserService.getContext(contextId!)
                    if (ctx) {
                        const ck = await ctx.cookies().catch(() => [])
                        if (ck && ck.length) await accountService.saveCookies(id, JSON.stringify(ck))
                    }
                } catch {}
                await accountService.updateStatus(id, 'active')
                await accountService.updateLastUsed(id)
                return { success: true, message: 'Visible auto-login successful!' }
            }

            if (loginResult.requires2FA || loginResult.error?.includes('2FA')) {
                keepContextOpen = true
                await accountService.updateStatus(id, 'pending')
                return {
                    success: false,
                    message: 'Trình duyệt đã mở (cần thao tác 2FA/CAPTCHA). Hãy hoàn tất rồi đóng hoặc dùng Kiểm tra.',
                    needs2FA: true,
                    contextId,
                }
            }

            await accountService.updateStatus(id, 'banned')
            return { success: false, message: loginResult.error || 'Visible login failed' }
        } catch (error) {
            await accountService.updateStatus(id, 'pending')
            return {
                success: false,
                message: toFriendlyAccountError(error),
            }
        } finally {
            if (contextId !== null && !keepContextOpen) {
                try {
                    const { browserService } = await import('../automation/BrowserService')
                    await browserService.closeContext(contextId)
                } catch (closeError) {
                    console.error('[accounts:loginVisible] Failed to close browser context:', closeError)
                }
            }
        }
    })

    // Check all pending accounts
    ipcMain.handle('accounts:checkAllPending', async () => {
        try {
            return await accountService.checkAllPending()
        } catch (error) {
            return {
                checked: 0,
                alive: 0,
                dead: 0,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    })

    // Open browser for manual login - user logs in themselves (now reuses BrowserService for consistent channel/args/stealth/lock-clean; keeps context alive until user closes or login detected)
    ipcMain.handle('accounts:openManualLogin', async (_event, id: number) => {
        try {
            // Check if browser already open for this account
            if (openManualBrowsers.has(id)) {
                return { success: false, message: 'Browser đã mở cho tài khoản này rồi!' }
            }

            const account = await accountService.getById(id)
            if (!account) {
                return { success: false, message: 'Không tìm thấy tài khoản' }
            }

            // Determine profile path (prefer service, heal legacy traffic_profiles if needed)
            let profilePath = account.profilePath
            if (!profilePath || !existsSync(profilePath)) {
                const basePath = profileService.getProfilesPath()
                const emailClean = account.email.replace(/[@.]/g, '_')
                const legacyPath = join(basePath, `profile_${account.id}_${emailClean}`)
                if (existsSync(legacyPath)) {
                    profilePath = legacyPath
                } else {
                    profilePath = await profileService.createProfile(account.id, account.email)
                }
            }
            if (!profilePath || !existsSync(profilePath)) {
                const { app } = await import('electron')
                const trafficPath = join(app.getPath('userData'), 'traffic_profiles', `account_${account.id}_${account.email.replace(/[@.]/g, '_')}`)
                if (existsSync(trafficPath)) {
                    profilePath = trafficPath
                }
            }
            if (!profilePath) {
                const { app } = await import('electron')
                profilePath = join(app.getPath('userData'), 'traffic_profiles', `account_${account.id}_${account.email.replace(/[@.]/g, '_')}`)
                mkdirSync(profilePath, { recursive: true })
            }

            console.log(`[ManualLogin] Opening browser for ${account.email}, profile: ${profilePath}`)

            const { browserService } = await import('../automation/BrowserService')

            // Use BrowserService (channel:'chrome' + full stable args + StealthPatcher + fingerprint + lock recovery) — fixes instant close
            const contextId = await browserService.createContext({
                headless: false,
                profilePath,
            })
            openManualBrowsers.set(id, contextId)

            // Navigate to Google signin (reuse service page if present)
            const rawContext = browserService.getContext(contextId)
            let page = browserService.getPage(contextId)
            if (!page && rawContext) {
                page = rawContext.pages().find(p => !p.isClosed()) || await rawContext.newPage()
            }
            if (page) {
                await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' }).catch(() => {})
            }

            // Persist profilePath
            await accountService.update(id, { profilePath })

            // Detect + save cookies/state to accounts.cookies (compat with engines); idempotent
            const trySaveLoginState = async () => {
                try {
                    const ctx = browserService.getContext(contextId) || rawContext
                    if (!ctx) return
                    const currentPage = browserService.getPage(contextId) || (ctx.pages ? ctx.pages().find((p: any) => !p.isClosed()) : null)
                    const url = currentPage ? currentPage.url() : ''
                    const hasAvatar = currentPage ? await currentPage.$('img[aria-label*="Google Account"], a[aria-label*="Google Account"]').catch(() => null) : null
                    const loggedByUrl = url.includes('myaccount') || (url.includes('google.com') && !/signin|ServiceLogin|accounts\.google\.com\/ServiceLogin/i.test(url))
                    if (loggedByUrl || hasAvatar) {
                        await accountService.updateStatus(id, 'active')
                        await accountService.updateLastUsed(id)
                        try { await ctx.storageState({ path: join(profilePath, 'state.json') }).catch(() => {}) } catch {}
                        try {
                            const ck = await ctx.cookies().catch(() => [])
                            if (ck && ck.length) await accountService.saveCookies(id, JSON.stringify(ck))
                        } catch {}
                        console.log(`[ManualLogin] Detected login for ${account.email}, saved cookies + active`)
                    }
                } catch {}
            }

            // Poll for detection (non-blocking, ~60s; stops if map entry removed)
            ;(async () => {
                for (let i = 0; i < 12; i++) {
                    await new Promise(r => setTimeout(r, 5000))
                    if (!openManualBrowsers.has(id)) break
                    await trySaveLoginState()
                }
            })()

            // On user close (or external), save state/cookies then cleanup service map (no force-kill of active)
            if (rawContext) {
                rawContext.on('close', async () => {
                    openManualBrowsers.delete(id)
                    await trySaveLoginState()
                    try { await browserService.closeContext(contextId) } catch {}
                    // Leave status as-is if pending (user decides); active only on successful detect
                    console.log(`[ManualLogin] Browser closed for ${account.email}`)
                })
            }

            return { success: true, message: 'Browser đã mở! Hãy đăng nhập Google. App sẽ tự lưu phiên khi phát hiện thành công.' }
        } catch (error) {
            openManualBrowsers.delete(id)
            return {
                success: false,
                message: toFriendlyAccountError(error),
            }
        }
    })
}
