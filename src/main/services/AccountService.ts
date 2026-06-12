import { eq, or, sql } from 'drizzle-orm'
import * as crypto from 'crypto'
import { getDatabase, schema } from '../database'
import type { Account, NewAccount } from '../database/schema'
import { profileService } from './ProfileService'
import { fingerprintService, BrowserFingerprint } from './FingerprintService'
import { accountWarmupService } from './AccountWarmupService'
import { browserService } from '../automation/BrowserService'
import { googleAuthHandler } from '../automation/GoogleAuthHandler'
import { app } from 'electron'
import * as path from 'path'

// Inline TOTP implementation to avoid external dependency issues
function generateTOTP(secret: string): string {
    try {
        // Decode base32 secret
        const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
        const cleanSecret = secret.replace(/\s/g, '').toUpperCase()
        let bits = ''
        for (const char of cleanSecret) {
            const val = base32chars.indexOf(char)
            if (val === -1) continue
            bits += val.toString(2).padStart(5, '0')
        }
        const bytes = []
        for (let i = 0; i < bits.length - 7; i += 8) {
            bytes.push(parseInt(bits.substr(i, 8), 2))
        }
        const key = Buffer.from(bytes)

        // Get current time step
        const epoch = Math.floor(Date.now() / 1000)
        const timeStep = Math.floor(epoch / 30)

        // Create time buffer
        const timeBuffer = Buffer.alloc(8)
        timeBuffer.writeBigUInt64BE(BigInt(timeStep))

        // HMAC-SHA1
        const hmac = crypto.createHmac('sha1', key)
        hmac.update(timeBuffer)
        const hash = hmac.digest()

        // Dynamic truncation
        const offset = hash[hash.length - 1] & 0x0f
        const binary = ((hash[offset] & 0x7f) << 24) |
            ((hash[offset + 1] & 0xff) << 16) |
            ((hash[offset + 2] & 0xff) << 8) |
            (hash[offset + 3] & 0xff)

        const otp = binary % 1000000
        return otp.toString().padStart(6, '0')
    } catch (error) {
        console.error('TOTP generation failed:', error)
        return ''
    }
}

export interface AccountWithProfile extends Account {
    fingerprint?: BrowserFingerprint
    profileInfo?: {
        exists: boolean
        hasCookies: boolean
        sizeBytes: number
    }
}

export interface FullAccountImport {
    email: string
    password: string
    recoveryEmail?: string
    recoveryPhone?: string
    twoFactorSecret?: string
}

export class AccountService {
    // Normalize short email like "user123" -> "user123@gmail.com" before persist (single source for add + import)
    private normalizeEmail(email: string | null | undefined): string | null | undefined {
        if (!email || typeof email !== 'string') return email
        const t = email.trim()
        if (!t) return t
        return t.includes('@') ? t : `${t}@gmail.com`
    }

    // Heal profile path in case DB was copied from another computer
    private healProfilePath(account: Account): Account {
        if (!account.profilePath) return account
        
        try {
            const userDataPath = app.getPath('userData')
            // If the absolute path doesn't start with the current user's AppData/Roaming/... directory
            if (!account.profilePath.startsWith(userDataPath)) {
                const isTrafficProfile = account.profilePath.includes('traffic_profiles')
                const basename = path.basename(account.profilePath)
                const expectedPath = path.join(
                    userDataPath,
                    isTrafficProfile ? 'traffic_profiles' : 'profiles',
                    basename
                )
                
                // Update the memory object and database
                account.profilePath = expectedPath
                const db = getDatabase()
                db.update(schema.accounts)
                  .set({ profilePath: expectedPath })
                  .where(eq(schema.accounts.id, account.id))
                  .run()
                console.log(`[AccountService] Self-healed profile path for ${account.email}`)
            }
        } catch (err) {
            console.error('[AccountService] Failed to heal profile path:', err)
        }
        
        return account
    }

    // Get all accounts
    async getAll(): Promise<Account[]> {
        const db = getDatabase()
        const accounts = db.select().from(schema.accounts).all()
        return accounts.map(a => this.healProfilePath(a))
    }

    // Get account by ID
    async getById(id: number): Promise<Account | undefined> {
        const db = getDatabase()
        const results = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).all()
        return results[0] ? this.healProfilePath(results[0]) : undefined
    }

    // Get active accounts (includes pending for testing - accounts that haven't been banned)
    async getActive(): Promise<Account[]> {
        const db = getDatabase()
        // Include both 'active' and 'pending' accounts for campaigns
        // Exclude only 'banned' and 'suspended' accounts
        const accounts = db.select().from(schema.accounts)
            .where(
                or(
                    eq(schema.accounts.status, 'active'),
                    eq(schema.accounts.status, 'pending')
                )
            )
            .all()
        return accounts.map(a => this.healProfilePath(a))
    }

    async getActiveCount(): Promise<number> {
        const db = getDatabase()
        const row = db.select({ count: sql<number>`count(*)` })
            .from(schema.accounts)
            .where(eq(schema.accounts.status, 'active'))
            .get()
        return Number(row?.count) || 0
    }

    // Get account with profile and fingerprint info
    async getWithProfile(id: number): Promise<AccountWithProfile | undefined> {
        const account = await this.getById(id)
        if (!account) return undefined

        const result: AccountWithProfile = { ...account }

        // Get fingerprint if exists
        if (account.fingerprintId) {
            result.fingerprint = fingerprintService.getById(account.fingerprintId)
        }

        // Get profile info if exists
        if (account.profilePath) {
            result.profileInfo = {
                exists: profileService.profileExists(account.id, account.email),
                hasCookies: false,
                sizeBytes: 0,
            }

            const profileInfo = profileService.getProfileInfo(account.profilePath)
            if (profileInfo.exists) {
                result.profileInfo.hasCookies = profileInfo.hasCookies
                result.profileInfo.sizeBytes = profileInfo.sizeBytes
            }
        }

        return result
    }

    // Create new account (supports loginType, twoFactorSecret)
    async create(data: NewAccount): Promise<Account> {
        const db = getDatabase()
        const toInsert = { ...data, email: this.normalizeEmail(data.email) as any }
        const result = db.insert(schema.accounts).values({
            ...toInsert,
            createdAt: new Date(),
        }).returning().get()
        return result
    }

    // Update account
    async update(id: number, data: Partial<Account>): Promise<Account | undefined> {
        const db = getDatabase()
        const result = db.update(schema.accounts)
            .set(data)
            .where(eq(schema.accounts.id, id))
            .returning()
            .get()
        return result
    }

    // Delete account
    async delete(id: number): Promise<void> {
        const db = getDatabase()
        const account = await this.getById(id)

        // Delete profile folder if exists (standard profiles/)
        if (account) {
            await profileService.deleteProfile(id, account.email)

            // Also cleanup traffic_profiles/ directory for this account
            try {
                const { existsSync, rmSync } = await import('fs')
                const emailClean = account.email.replace(/[@.]/g, '_')
                const trafficProfilePath = path.join(
                    app.getPath('userData'),
                    'traffic_profiles',
                    `account_${id}_${emailClean}`
                )
                if (existsSync(trafficProfilePath)) {
                    rmSync(trafficProfilePath, { recursive: true, force: true })
                    console.log(`[AccountService] Deleted traffic profile: ${trafficProfilePath}`)
                }
            } catch (cleanupErr) {
                console.error(`[AccountService] Traffic profile cleanup warning:`, cleanupErr)
            }
        }

        // Delete related logs first to satisfy foreign key constraints
        db.delete(schema.reviewHistory).where(eq(schema.reviewHistory.accountId, id)).run()
        db.delete(schema.trafficLogs).where(eq(schema.trafficLogs.accountId, id)).run()

        db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run()
    }

    // Update account status
    async updateStatus(id: number, status: Account['status']): Promise<void> {
        const db = getDatabase()
        db.update(schema.accounts)
            .set({ status })
            .where(eq(schema.accounts.id, id))
            .run()
    }

    // Update lastUsed timestamp (on login success, campaign use, check live)
    async updateLastUsed(id: number): Promise<void> {
        const db = getDatabase()
        db.update(schema.accounts)
            .set({ lastUsed: new Date() })
            .where(eq(schema.accounts.id, id))
            .run()
    }

    // Increment review count
    async incrementReviewCount(id: number): Promise<void> {
        const db = getDatabase()
        const account = await this.getById(id)
        if (account) {
            db.update(schema.accounts)
                .set({
                    totalReviews: account.totalReviews + 1,
                    lastUsed: new Date()
                })
                .where(eq(schema.accounts.id, id))
                .run()
        }
    }

    // Save cookies for account
    async saveCookies(id: number, cookies: string): Promise<void> {
        const db = getDatabase()
        db.update(schema.accounts)
            .set({ cookies })
            .where(eq(schema.accounts.id, id))
            .run()
    }

    // Import multiple accounts from CSV data (supports 2FA, loginType, recovery)
    async importFromCSV(accounts: Array<{ email: string; password: string; recoveryEmail?: string; recoveryPhone?: string; twoFactorSecret?: string; loginType?: 'auto' | 'manual' }>): Promise<number> {
        const db = getDatabase()
        let imported = 0

        for (const acc of accounts) {
            try {
                const email = this.normalizeEmail(acc.email) || acc.email
                db.insert(schema.accounts).values({
                    email,
                    password: acc.password,
                    recoveryEmail: acc.recoveryEmail || null,
                    recoveryPhone: acc.recoveryPhone || null,
                    twoFactorSecret: acc.twoFactorSecret || null,
                    loginType: (acc.loginType === 'manual' ? 'manual' : 'auto'),
                    status: 'pending',
                    totalReviews: 0,
                    createdAt: new Date(),
                }).run()
                imported++
            } catch (error) {
                // Skip duplicates
                console.log(`Skipped duplicate: ${acc.email}`)
            }
        }

        return imported
    }

    // Import accounts with all fields including 2FA
    async importWithAllFields(accounts: FullAccountImport[]): Promise<{
        imported: number
        skipped: number
        errors: string[]
    }> {
        const db = getDatabase()
        let imported = 0
        let skipped = 0
        const errors: string[] = []

        for (const acc of accounts) {
            try {
                // Generate fingerprint for this account
                const fingerprint = fingerprintService.generate()

                const result = db.insert(schema.accounts).values({
                    email: acc.email,
                    password: acc.password,
                    recoveryEmail: acc.recoveryEmail || null,
                    recoveryPhone: acc.recoveryPhone || null,
                    twoFactorSecret: acc.twoFactorSecret || null,
                    fingerprintId: fingerprint.id,
                    status: 'pending',
                    totalReviews: 0,
                    createdAt: new Date(),
                }).returning().get()

                // Create profile folder
                await profileService.createProfile(result.id, result.email)

                imported++
            } catch (error) {
                if (error instanceof Error && error.message.includes('UNIQUE')) {
                    skipped++
                } else {
                    errors.push(`${acc.email}: ${error instanceof Error ? error.message : 'Unknown error'}`)
                }
            }
        }

        return { imported, skipped, errors }
    }

    // Check account live/die status via auto-login
    async checkLiveDie(id: number): Promise<{
        alive: boolean
        error?: string
        needs2FA?: boolean
    }> {
        const account = await this.getById(id)
        if (!account) {
            return { alive: false, error: 'Account not found' }
        }
        if (!account.password || !account.password.trim()) {
            await this.updateStatus(id, 'pending')
            return { alive: false, error: 'Thiếu mật khẩu (cập nhật lại tài khoản)' }
        }

        // Update status to checking
        await this.updateStatus(id, 'checking')

        let contextId: number | null = null
        try {
            // Get or create fingerprint
            let fingerprint: BrowserFingerprint
            if (account.fingerprintId) {
                fingerprint = fingerprintService.getById(account.fingerprintId) || fingerprintService.generate()
            } else {
                fingerprint = fingerprintService.generate()
                await this.update(id, { fingerprintId: fingerprint.id })
            }

            // Create profile if not exists
            const profilePath = account.profilePath || await profileService.createProfile(id, account.email)

            // Attempt login (auto TOTP if secret present)
            const loginResult = await googleAuthHandler.login(
                account.email,
                account.password,
                {
                    headless: true,
                    profilePath,
                },
                account.twoFactorSecret || undefined
            )
            contextId = loginResult.contextId >= 0 ? loginResult.contextId : null

            // Update last check time
            const db = getDatabase()
            db.update(schema.accounts)
                .set({ lastCheckAt: new Date() })
                .where(eq(schema.accounts.id, id))
                .run()

            if (loginResult.success) {
                await this.updateStatus(id, 'active')
                await this.updateLastUsed(id)

                // Save session (profile state) + cookies JSON to DB column for campaign reuse
                if (contextId !== null) {
                    await googleAuthHandler.saveSession(contextId, profilePath)
                    try {
                        const { browserService } = await import('../automation/BrowserService')
                        const ctx = browserService.getContext(contextId)
                        if (ctx) {
                            const ck = await ctx.cookies().catch(() => [])
                            if (ck && ck.length > 0) {
                                await this.saveCookies(id, JSON.stringify(ck))
                            }
                        }
                    } catch {}
                }

                return { alive: true }
            } else {
                // Check for specific error types
                if (loginResult.error?.includes('2FA') || loginResult.error?.includes('2-Step')) {
                    await this.updateStatus(id, 'pending')
                    if (account.twoFactorSecret) {
                        const totpCode = this.generateTOTPCode(account.twoFactorSecret)
                        return { alive: false, needs2FA: true, error: '2FA required but not yet implemented' }
                    }
                    return { alive: false, needs2FA: true, error: '2FA required but no secret stored' }
                }

                // Map correctly: only real Google disabled/suspended -> banned/suspended; auth fail/wrong pass/incomplete -> pending
                const err = (loginResult.error || '').toLowerCase()
                if (err.includes('disabled') || err.includes('suspended')) {
                    await this.updateStatus(id, err.includes('suspended') ? 'suspended' : 'banned')
                } else {
                    await this.updateStatus(id, 'pending')
                }

                return { alive: false, error: loginResult.error }
            }
        } catch (error) {
            await this.updateStatus(id, 'pending')
            const raw = error instanceof Error ? error.message : 'Unknown error'
            const friendly = /target page, context or browser has been closed|launchPersistentContext/i.test(raw)
                ? 'Không mở được trình duyệt (profile bị khóa hoặc xung đột Chrome). Đóng Chrome khác, thử lại hoặc reset profile.'
                : raw
            return {
                alive: false,
                error: friendly
            }
        } finally {
            if (contextId !== null) {
                try {
                    await browserService.closeContext(contextId)
                } catch (closeError) {
                    console.error('[AccountService] Failed to close live-check context:', closeError)
                }
            }
        }
    }

    // Check all pending accounts
    async checkAllPending(): Promise<{
        checked: number
        alive: number
        dead: number
    }> {
        const db = getDatabase()
        const pending = db.select().from(schema.accounts)
            .where(eq(schema.accounts.status, 'pending'))
            .all()

        let alive = 0
        let dead = 0

        for (const account of pending) {
            const result = await this.checkLiveDie(account.id)
            if (result.alive) {
                alive++
            } else {
                dead++
            }

            // Small delay between checks
            await new Promise(resolve => setTimeout(resolve, 2000))
        }

        return { checked: pending.length, alive, dead }
    }

    // Generate TOTP code from secret (using inline implementation)
    private generateTOTPCode(secret: string): string {
        return generateTOTP(secret)
    }

    // Get statistics
    async getStats(): Promise<{
        total: number
        active: number
        banned: number
        pending: number
        checking: number
    }> {
        const db = getDatabase()
        const all = db.select().from(schema.accounts).all()

        return {
            total: all.length,
            active: all.filter(a => a.status === 'active').length,
            banned: all.filter(a => a.status === 'banned' || a.status === 'suspended').length,
            pending: all.filter(a => a.status === 'pending').length,
            checking: all.filter(a => a.status === 'checking').length,
        }
    }

    // Parse account import text (multiple formats)
    parseImportText(text: string): FullAccountImport[] {
        const accounts: FullAccountImport[] = []
        const lines = text.split('\n').filter(l => l.trim())

        for (const line of lines) {
            // Try different delimiters: | : ; , tab
            const delimiters = ['|', ':', ';', ',', '\t']
            let parts: string[] = []

            for (const delimiter of delimiters) {
                if (line.includes(delimiter)) {
                    parts = line.split(delimiter).map(p => p.trim())
                    if (parts.length >= 2) break
                }
            }

            if (parts.length >= 2) {
                accounts.push({
                    email: parts[0],
                    password: parts[1],
                    recoveryEmail: parts[2] || undefined,
                    twoFactorSecret: parts[3] || undefined,
                })
            }
        }

        return accounts
    }
}

export const accountService = new AccountService()
