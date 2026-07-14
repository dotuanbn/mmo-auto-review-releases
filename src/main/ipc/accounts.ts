import { ipcMain } from 'electron'
import { accountService } from '../services/AccountService'
import { profileService } from '../services/ProfileService'
import { isProfileLockBusyError } from '../services/ProfileLockService'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { loadSettings } from './settings'
import type { Account } from '../database/schema'
import {
    accountCreateSchema,
    accountIdSchema,
    accountImportListSchema,
    accountUpdateArgsSchema,
    type AccountUpdatePayload,
    type PublicAccount,
} from '../../shared/account-contracts'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

// Track open manual login browsers so we don't open duplicates
const openManualBrowsers: Map<number, number> = new Map()

type LegacyAccount = {
    loginType?: 'auto' | 'manual'
}

function isManualAccount(account: unknown): boolean {
    return (account as LegacyAccount).loginType === 'manual'
}

function normalizeLoginType(value: unknown): 'auto' | 'manual' {
    return value === 'manual' ? 'manual' : 'auto'
}

/**
 * Map validated update payload to DB fields.
 * Blank password / blank TOTP secret are ignored so existing secrets
 * are not overwritten accidentally from the UI. null TOTP clears.
 */
function toAccountUpdateFields(input: AccountUpdatePayload): Partial<Account> {
    const update: Partial<Account> = {}

    if (typeof input.email === 'string') update.email = input.email.trim()

    // Blank password must NOT overwrite stored secret
    if (typeof input.password === 'string' && input.password.trim() !== '') {
        update.password = input.password
    }

    if (input.recoveryEmail !== undefined) {
        update.recoveryEmail = input.recoveryEmail
    }
    if (input.recoveryPhone !== undefined) {
        update.recoveryPhone = input.recoveryPhone
    }

    // null clears TOTP; blank string leaves unchanged
    if (input.twoFactorSecret === null) {
        update.twoFactorSecret = null
    } else if (typeof input.twoFactorSecret === 'string' && input.twoFactorSecret.trim() !== '') {
        update.twoFactorSecret = input.twoFactorSecret
    }

    if (input.loginType === 'auto' || input.loginType === 'manual') {
        update.loginType = input.loginType
    }
    if (input.status !== undefined) {
        update.status = input.status
    }
    // profilePath must NOT come from accounts:update — profiles:* owns path mutation

    return update
}

function toPublicOrUndefined(account: Account | undefined): PublicAccount | undefined {
    return account ? accountService.toPublicAccount(account) : undefined
}

function toFriendlyAccountError(err: unknown): string {
    // In-process profile ownership conflict (manual/auto/script concurrent open).
    if (isProfileLockBusyError(err)) {
        return err.message
    }
    const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error')
    if (/PROFILE_LOCK_BUSY|Profile đang được dùng bởi phiên khác/i.test(raw)) {
        return 'Profile đang được dùng bởi phiên khác. Đóng browser/script đang mở profile này rồi thử lại.'
    }
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
    // Get all accounts — public DTO only (no password / TOTP)
    ipcMain.handle('accounts:getAll', withIpcValidation('accounts:getAll', async () => {
        return accountService.getAllPublic()
    }))

    ipcMain.handle('accounts:getActiveCount', withIpcValidation('accounts:getActiveCount', async () => {
        return accountService.getActiveCount()
    }))

    // Get account by ID — public DTO only; reject non-positive / garbage ids
    ipcMain.handle('accounts:getById', withIpcValidation('accounts:getById', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('accounts:getById', accountIdSchema, id)
        return accountService.getByIdPublic(parsedId)
    }))

    // Add new account (supports 2FA secret) — returns public DTO
    ipcMain.handle('accounts:add', withIpcValidation('accounts:add', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('accounts:add', accountCreateSchema, data)
        const created = await accountService.create({
            email: parsed.email,
            password: parsed.password,
            recoveryEmail: parsed.recoveryEmail,
            recoveryPhone: parsed.recoveryPhone,
            loginType: normalizeLoginType(parsed.loginType),
            twoFactorSecret: parsed.twoFactorSecret?.trim() ? parsed.twoFactorSecret : null,
            status: 'pending',
            totalReviews: 0,
            createdAt: new Date(),
        })
        return accountService.toPublicAccount(created)
    }))

    // Update account — blank password/TOTP ignored; returns public DTO
    ipcMain.handle('accounts:update', withIpcValidation('accounts:update', async (_event, id: unknown, data: unknown) => {
        const [parsedId, parsedData] = parseIpcArgs(
            'accounts:update',
            accountUpdateArgsSchema,
            [id, data],
        )
        const update = toAccountUpdateFields(parsedData)
        if (Object.keys(update).length === 0) {
            return accountService.getByIdPublic(parsedId)
        }
        const updated = await accountService.update(parsedId, update)
        return toPublicOrUndefined(updated)
    }))

    // Delete account
    ipcMain.handle('accounts:delete', withIpcValidation('accounts:delete', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('accounts:delete', accountIdSchema, id)
        return accountService.delete(parsedId)
    }))

    // Import from CSV (rich: supports 2fa + loginType)
    ipcMain.handle('accounts:importCSV', withIpcValidation('accounts:importCSV', async (_event, accounts: unknown) => {
        const parsed = parseIpcPayload('accounts:importCSV', accountImportListSchema, accounts)
        return accountService.importFromCSV(parsed)
    }))

    // Get statistics
    ipcMain.handle('accounts:getStats', withIpcValidation('accounts:getStats', async () => {
        return accountService.getStats()
    }))

    ipcMain.handle('accounts:checkLiveDie', withIpcValidation('accounts:checkLiveDie', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('accounts:checkLiveDie', accountIdSchema, id)
        return accountService.checkLiveDie(parsedId)
    }))

    // Test account login (headless - FULL AUTO: credential + TOTP if secret; uses GoogleAuthHandler for reliability)
    ipcMain.handle('accounts:testLogin', withIpcValidation('accounts:testLogin', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('accounts:testLogin', accountIdSchema, id)
        let contextId: number | null = null
        try {
            // Internal getById decrypts secrets for login only (never returned to renderer)
            const account = await accountService.getById(parsedId)
            if (!account) return { success: false, message: 'Account not found' }

            if (isManualAccount(account)) {
                return { success: false, message: 'Tài khoản thủ công: Hãy dùng nút Đăng nhập thủ công' }
            }
            if (!account.password || !account.password.trim()) {
                await accountService.updateStatus(parsedId, 'pending')
                return { success: false, message: 'Thiếu mật khẩu (cập nhật lại tài khoản)' }
            }

            await accountService.updateStatus(parsedId, 'checking')

            const { googleAuthHandler } = await import('../automation/GoogleAuthHandler')
            const { profileService: ps } = await import('../services/ProfileService')

            const profilePath = account.profilePath || await ps.createProfile(parsedId, account.email)

            // Single create via handler (reuses BrowserService with channel/args/stealth/lock-clean). No outer create to avoid same-profile lock conflict.
            const headless = loadSettings().headless === true
            const loginResult = await googleAuthHandler.login(
                account.email,
                account.password,
                { headless, profilePath },
                account.twoFactorSecret || undefined,
                account.recoveryEmail || undefined,
                account.recoveryPhone || undefined
            )
            contextId = loginResult.contextId >= 0 ? loginResult.contextId : null

            if (loginResult.success) {
                await googleAuthHandler.saveSession(contextId!, profilePath)
                try {
                    const { browserService } = await import('../automation/BrowserService')
                    const ctx = browserService.getContext(contextId!)
                    if (ctx) {
                        const ck = await ctx.cookies().catch(() => [])
                        if (ck && ck.length) await accountService.saveCookies(parsedId, JSON.stringify(ck))
                    }
                } catch {
                    // ignore cookie persistence errors
                }
                await accountService.updateStatus(parsedId, 'active')
                await accountService.updateLastUsed(parsedId)
                return { success: true, message: 'Auto login successful (TOTP handled if present) - account active!' }
            }

            if (loginResult.requires2FA) {
                await accountService.updateStatus(parsedId, 'pending')
                return { success: false, message: '2FA required but no valid secret - use manual login', needs2FA: true }
            }

            // Only banned/suspended on explicit Google disabled; auth fail (wrong pass etc) = pending for retry
            const err = (loginResult.error || '').toLowerCase()
            if (err.includes('disabled') || err.includes('suspended')) {
                await accountService.updateStatus(parsedId, err.includes('suspended') ? 'suspended' : 'banned')
            } else {
                await accountService.updateStatus(parsedId, 'pending')
            }
            return { success: false, message: loginResult.error || 'Auto login failed' }
        } catch (error) {
            await accountService.updateStatus(parsedId, 'pending')
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
    }))

    // Login with visible browser (visible for user intervention/CAPTCHA; tries auto + TOTP first)
    ipcMain.handle('accounts:loginVisible', withIpcValidation('accounts:loginVisible', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('accounts:loginVisible', accountIdSchema, id)
        let contextId: number | null = null
        let keepContextOpen = false
        try {
            const account = await accountService.getById(parsedId)
            if (!account) return { success: false, message: 'Account not found' }

            if (isManualAccount(account)) {
                return { success: false, message: 'Tài khoản thủ công: Hãy dùng nút Đăng nhập thủ công' }
            }
            if (!account.password || !account.password.trim()) {
                await accountService.updateStatus(parsedId, 'pending')
                return { success: false, message: 'Thiếu mật khẩu (cập nhật lại tài khoản)' }
            }

            await accountService.updateStatus(parsedId, 'checking')

            const { googleAuthHandler } = await import('../automation/GoogleAuthHandler')
            const { profileService: ps } = await import('../services/ProfileService')

            const profilePath = account.profilePath || await ps.createProfile(parsedId, account.email)

            // Single create via handler (BrowserService channel/args/stealth + lock clean). No duplicate create on same profile.
            const loginResult = await googleAuthHandler.login(
                account.email,
                account.password,
                { headless: false, profilePath },
                account.twoFactorSecret || undefined,
                account.recoveryEmail || undefined
            )
            contextId = loginResult.contextId >= 0 ? loginResult.contextId : null

            if (loginResult.success) {
                await googleAuthHandler.saveSession(contextId!, profilePath)
                try {
                    const { browserService } = await import('../automation/BrowserService')
                    const ctx = browserService.getContext(contextId!)
                    if (ctx) {
                        const ck = await ctx.cookies().catch(() => [])
                        if (ck && ck.length) await accountService.saveCookies(parsedId, JSON.stringify(ck))
                    }
                } catch {
                    // ignore cookie persistence errors
                }
                await accountService.updateStatus(parsedId, 'active')
                await accountService.updateLastUsed(parsedId)
                return { success: true, message: 'Visible auto-login successful!' }
            }

            if (loginResult.requires2FA || loginResult.error?.includes('2FA')) {
                keepContextOpen = true
                await accountService.updateStatus(parsedId, 'pending')
                return {
                    success: false,
                    message: 'Trình duyệt đã mở (cần thao tác 2FA/CAPTCHA). Hãy hoàn tất rồi đóng hoặc dùng Kiểm tra.',
                    needs2FA: true,
                    contextId,
                }
            }

            // Only banned/suspended on explicit Google disabled; other fails (pass, incomplete) = pending
            const err = (loginResult.error || '').toLowerCase()
            if (err.includes('disabled') || err.includes('suspended')) {
                await accountService.updateStatus(parsedId, err.includes('suspended') ? 'suspended' : 'banned')
            } else {
                await accountService.updateStatus(parsedId, 'pending')
            }
            return { success: false, message: loginResult.error || 'Visible login failed' }
        } catch (error) {
            await accountService.updateStatus(parsedId, 'pending')
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
    }))

    // Check all pending accounts
    ipcMain.handle('accounts:checkAllPending', withIpcValidation('accounts:checkAllPending', async () => {
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
    }))

    // Open browser for manual login (user completes themselves). Keeps visible context alive; polls strict isGoogleLoggedIn (strong cookies) up to ~10min.
    // Only sets active + saves cookies + auto-closes when isGoogleLoggedIn(true). Timeout or close without => pending. No URL heuristics.
    ipcMain.handle('accounts:openManualLogin', withIpcValidation('accounts:openManualLogin', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('accounts:openManualLogin', accountIdSchema, id)
        try {
            // Check if browser already open for this account
            if (openManualBrowsers.has(parsedId)) {
                return { success: false, message: 'Browser đã mở cho tài khoản này rồi!' }
            }

            const account = await accountService.getById(parsedId)
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
            openManualBrowsers.set(parsedId, contextId)

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
            await accountService.update(parsedId, { profilePath })

            // Detect ONLY via strict isGoogleLoggedIn (SAPISID+SID strong cookies). No URL heuristic (myaccount alone or "left signin" is not enough).
            // If URL myaccount but cookies not yet strong => keep waiting (per spec).
            const tryDetectAndSave = async (isFinalCheck = false): Promise<boolean> => {
                try {
                    const ctx = browserService.getContext(contextId) || rawContext
                    if (!ctx) return false
                    const isLogged = await browserService.isGoogleLoggedIn(contextId, ctx).catch(() => false)
                    if (isLogged) {
                        await accountService.updateStatus(parsedId, 'active')
                        await accountService.updateLastUsed(parsedId)
                        try { await ctx.storageState({ path: join(profilePath, 'state.json') }).catch(() => {}) } catch { /* ignore */ }
                        try {
                            const ck = await ctx.cookies().catch(() => [])
                            if (ck && ck.length) await accountService.saveCookies(parsedId, JSON.stringify(ck))
                        } catch { /* ignore */ }
                        console.log(`[ManualLogin] Detected login for ${account.email}, saved cookies + active`)
                        return true
                    }
                    if (isFinalCheck) {
                        // User closed without completing: explicit pending (never banned for manual).
                        // Guard: do not demote an already-active (race with poll-detect + auto-close emitting close event).
                        const curr = await accountService.getById(parsedId).catch(() => null)
                        if (!curr || curr.status !== 'active') {
                            await accountService.updateStatus(parsedId, 'pending')
                        }
                    }
                    return false
                } catch {
                    if (isFinalCheck) {
                        const curr = await accountService.getById(parsedId).catch(() => null)
                        if (!curr || curr.status !== 'active') {
                            await accountService.updateStatus(parsedId, 'pending').catch(() => {})
                        }
                    }
                    return false
                }
            }

            // Poll WIDE window (~10min max) every ~2.5s using strict isGoogleLoggedIn (SAPISID+SID cookies ONLY) on the live manual context;
            // stop on detect (then auto-close + active), user close, or ctx gone. On timeout/close without strong cookies => pending (no fake active).
            ;(async () => {
                const deadline = Date.now() + 10 * 60 * 1000
                try {
                    while (Date.now() < deadline) {
                        if (!openManualBrowsers.has(parsedId)) break
                        const liveCtx = browserService.getContext(contextId)
                        if (!liveCtx) { openManualBrowsers.delete(parsedId); break }
                        const detected = await tryDetectAndSave(false)
                        if (detected) {
                            openManualBrowsers.delete(parsedId)
                            try { await browserService.closeContext(contextId) } catch { /* ignore */ }
                            break
                        }
                        await new Promise(r => setTimeout(r, 2500))
                    }
                } finally {
                    openManualBrowsers.delete(parsedId)
                }
            })()

            // On user close (or external close): LAST CHECK cookies before context gone; active if logged, else pending (no banned)
            if (rawContext) {
                rawContext.on('close', async () => {
                    openManualBrowsers.delete(parsedId)
                    await tryDetectAndSave(true) // final cookie check
                    try { await browserService.closeContext(contextId) } catch { /* ignore */ }
                    console.log(`[ManualLogin] Browser closed for ${account.email}`)
                })
            }

            return { success: true, message: 'Browser đã mở! Hãy đăng nhập Google. App sẽ tự lưu phiên khi phát hiện thành công.' }
        } catch (error) {
            openManualBrowsers.delete(parsedId)
            return {
                success: false,
                message: toFriendlyAccountError(error),
            }
        }
    }))
}
