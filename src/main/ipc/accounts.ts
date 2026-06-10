import { ipcMain } from 'electron'
import { accountService } from '../services/AccountService'
import { chromium } from 'playwright'
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

    // Add new account
    ipcMain.handle('accounts:add', async (_event, data: {
        email: string
        password: string
        recoveryEmail?: string
        recoveryPhone?: string
        loginType?: 'auto' | 'manual'
    }) => {
        return accountService.create({
            email: data.email,
            password: data.password,
            recoveryEmail: data.recoveryEmail,
            recoveryPhone: data.recoveryPhone,
            loginType: normalizeLoginType(data.loginType),
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

    // Import from CSV
    ipcMain.handle('accounts:importCSV', async (_event, accounts: Array<{
        email: string
        password: string
        recoveryEmail?: string
        recoveryPhone?: string
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

    // Test account login (headless - auto check live/die)
    ipcMain.handle('accounts:testLogin', async (_event, id: number) => {
        let contextId: number | null = null
        try {
            const account = await accountService.getById(id)
            if (!account) return { success: false, message: 'Account not found' }

            if (isManualAccount(account)) {
                return { success: false, message: 'Tài khoản thủ công: Hãy dùng nút Đăng nhập thủ công' }
            }

            // Update status
            await accountService.updateStatus(id, 'checking')

            const { browserService } = await import('../automation/BrowserService')
            const { AgenticLoginHandler } = await import('../automation/AgenticLoginHandler')
            const { googleAuthHandler } = await import('../automation/GoogleAuthHandler')
            const { profileService } = await import('../services/ProfileService')

            const profilePath = account.profilePath || await profileService.createProfile(id, account.email)

            contextId = await browserService.createContext({
                headless: loadSettings().headless ?? false,
                profilePath,
            })
            const page = browserService.getPage(contextId)
            if (!page) {
                await accountService.updateStatus(id, 'pending')
                return { success: false, message: 'Failed to create browser context' }
            }

            const handler = new AgenticLoginHandler()
            const result = await handler.executeLogin(page, account, id)

            if (result.success) {
                await googleAuthHandler.saveSession(contextId, profilePath)
                await accountService.updateStatus(id, 'active')

                return { success: true, message: 'AI Login successful - account is active!' }
            }

            if (result.requiresManual) {
                await accountService.updateStatus(id, 'pending')
                return { success: false, message: 'AI needs manual help using Login Visible', needs2FA: true }
            }

            await accountService.updateStatus(id, 'banned')
            return { success: false, message: result.error || 'AI login failed' }
        } catch (error) {
            await accountService.updateStatus(id, 'pending')
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Unknown error',
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

    // Login with visible browser (user can see and intervene for CAPTCHA/2FA)
    ipcMain.handle('accounts:loginVisible', async (_event, id: number) => {
        let contextId: number | null = null
        let keepContextOpen = false
        try {
            const account = await accountService.getById(id)
            if (!account) return { success: false, message: 'Account not found' }

            if (isManualAccount(account)) {
                return { success: false, message: 'Tài khoản thủ công: Hãy dùng nút Đăng nhập thủ công' }
            }

            // Update status
            await accountService.updateStatus(id, 'checking')

            const { browserService } = await import('../automation/BrowserService')
            const { AgenticLoginHandler } = await import('../automation/AgenticLoginHandler')
            const { googleAuthHandler } = await import('../automation/GoogleAuthHandler')
            const { profileService } = await import('../services/ProfileService')

            const profilePath = account.profilePath || await profileService.createProfile(id, account.email)

            contextId = await browserService.createContext({
                headless: false,
                profilePath,
            })
            const page = browserService.getPage(contextId)
            if (!page) {
                await accountService.updateStatus(id, 'pending')
                return { success: false, message: 'Failed to create browser context' }
            }

            const handler = new AgenticLoginHandler()
            const result = await handler.executeLogin(page, account, id)

            // Even if AI fails, we leave the browser open so user can do it manually,
            // but we alert them if it's successful.
            if (result.success) {
                await googleAuthHandler.saveSession(contextId, profilePath)
                await accountService.updateStatus(id, 'active')
                return { success: true, message: 'AI Login successful!' }
            }

            if (result.requiresManual) {
                keepContextOpen = true
                await accountService.updateStatus(id, 'pending')
                return {
                    success: false,
                    message: 'AI requires manual intervention. Trình duyệt đã mở, vui lòng thao tác tiếp.',
                    needs2FA: true,
                    contextId,
                }
            }

            await accountService.updateStatus(id, 'banned')
            return { success: false, message: result.error || 'AI login failed' }
        } catch (error) {
            await accountService.updateStatus(id, 'pending')
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Unknown error',
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

    // Open browser for manual login - user logs in themselves
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

            // Determine profile path
            let profilePath = account.profilePath
            if (!profilePath || !existsSync(profilePath)) {
                // Try legacy naming
                const basePath = profileService.getProfilesPath()
                const emailClean = account.email.replace(/[@.]/g, '_')
                const legacyPath = join(basePath, `profile_${account.id}_${emailClean}`)
                if (existsSync(legacyPath)) {
                    profilePath = legacyPath
                } else {
                    // Create new profile
                    profilePath = await profileService.createProfile(account.id, account.email)
                }
            }

            // Also check traffic_profiles folder
            if (!profilePath || !existsSync(profilePath)) {
                const { app } = await import('electron')
                const trafficPath = join(app.getPath('userData'), 'traffic_profiles', `account_${account.id}_${account.email.replace(/[@.]/g, '_')}`)
                if (existsSync(trafficPath)) {
                    profilePath = trafficPath
                }
            }

            // If still no profile path, create one
            if (!profilePath) {
                const { app } = await import('electron')
                profilePath = join(app.getPath('userData'), 'traffic_profiles', `account_${account.id}_${account.email.replace(/[@.]/g, '_')}`)
                mkdirSync(profilePath, { recursive: true })
            }

            console.log(`[ManualLogin] Opening browser for ${account.email}, profile: ${profilePath}`)

            // Launch persistent context (headless: false so user can see)
            const context = await chromium.launchPersistentContext(profilePath, {
                headless: false,
                viewport: { width: 1366, height: 768 },
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--no-first-run',
                ],
            })

            openManualBrowsers.set(id, context)

            // Navigate to Google login
            const page = context.pages()[0] || await context.newPage()
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' })

            // Update account profilePath in DB
            await accountService.update(id, { profilePath })

            // When browser is closed by user, update status
            context.on('close', async () => {
                openManualBrowsers.delete(id)
                // Set account as active since user presumably logged in
                await accountService.updateStatus(id, 'active')
                console.log(`[ManualLogin] Browser closed for ${account.email}, set status to active`)
            })

            return { success: true, message: 'Browser đã mở! Hãy đăng nhập Google rồi đóng browser.' }
        } catch (error) {
            openManualBrowsers.delete(id)
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Lỗi không xác định',
            }
        }
    })
}
