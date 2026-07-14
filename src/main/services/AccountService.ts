import { eq, or, sql } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import type { Account, NewAccount } from '../database/schema'
import { profileService } from './ProfileService'
import { fingerprintService, BrowserFingerprint } from './FingerprintService'
import { browserService } from '../automation/BrowserService'
import { googleAuthHandler } from '../automation/GoogleAuthHandler'
import { app } from 'electron'
import * as path from 'path'
import { secretVault } from './SecretVault'
import type { PublicAccount } from '../../shared/account-contracts'

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

/** Writable secret fields that must be sealed before DB insert/update. */
type SecretWriteFields = {
    password?: string | null
    twoFactorSecret?: string | null
}

export class AccountService {
    // Normalize short email like "user123" -> "user123@gmail.com" before persist (single source for add + import)
    private normalizeEmail(email: string | null | undefined): string | null | undefined {
        if (!email || typeof email !== 'string') return email
        const t = email.trim()
        if (!t) return t
        return t.includes('@') ? t : `${t}@gmail.com`
    }

    /**
     * Strip secrets for renderer IPC. Never includes password / twoFactorSecret values.
     */
    toPublicAccount(account: Account): PublicAccount {
        const hasPassword = Boolean(account.password && account.password.trim())
        const hasTwoFactorSecret = Boolean(account.twoFactorSecret && account.twoFactorSecret.trim())

        return {
            id: account.id,
            email: account.email,
            recoveryEmail: account.recoveryEmail,
            recoveryPhone: account.recoveryPhone,
            loginType: account.loginType,
            profilePath: account.profilePath,
            fingerprintId: account.fingerprintId,
            status: account.status,
            lastUsed: account.lastUsed,
            lastCheckAt: account.lastCheckAt,
            totalReviews: account.totalReviews,
            createdAt: account.createdAt,
            hasPassword,
            hasTwoFactorSecret,
            firstReviewDate: account.firstReviewDate,
            lastReviewDate: account.lastReviewDate,
            warmupLevel: account.warmupLevel,
            reputationScore: account.reputationScore,
            warmupSessions: account.warmupSessions,
            lastWarmupAt: account.lastWarmupAt,
            nextWarmupAt: account.nextWarmupAt,
        }
    }

    /** Seal password / TOTP for at-rest storage. Blank password is omitted (no overwrite). */
    private sealSecretsForWrite<T extends SecretWriteFields>(data: T): T {
        const next: T = { ...data }

        if ('password' in next && next.password !== undefined) {
            if (typeof next.password === 'string' && next.password.trim() === '') {
                delete (next as SecretWriteFields).password
            } else if (typeof next.password === 'string') {
                next.password = secretVault.seal(next.password)
            } else if (next.password === null) {
                delete (next as SecretWriteFields).password
            }
        }

        if ('twoFactorSecret' in next && next.twoFactorSecret !== undefined) {
            if (next.twoFactorSecret === null) {
                next.twoFactorSecret = null
            } else if (typeof next.twoFactorSecret === 'string' && next.twoFactorSecret.trim() === '') {
                // Blank TOTP on update = leave unchanged
                delete (next as SecretWriteFields).twoFactorSecret
            } else if (typeof next.twoFactorSecret === 'string') {
                next.twoFactorSecret = secretVault.seal(next.twoFactorSecret)
            }
        }

        return next
    }

    /**
     * Decrypt secrets for main-process use and lazily re-encrypt legacy plaintext rows.
     */
    private hydrateAccount(account: Account): Account {
        const passwordPlain = secretVault.decrypt(account.password)
        const totpStored = account.twoFactorSecret
        const totpPlain = totpStored != null && totpStored !== ''
            ? secretVault.decrypt(totpStored)
            : null

        this.lazyMigrateSecrets(account.id, account.password, totpStored)

        return {
            ...account,
            password: passwordPlain,
            twoFactorSecret: totpPlain,
        }
    }

    /** Persist encrypted form when encryption becomes available (legacy plaintext rows). */
    private lazyMigrateSecrets(
        accountId: number,
        passwordStored: string,
        totpStored: string | null | undefined
    ): void {
        const pwdMig = secretVault.migrateIfNeeded(passwordStored)
        const totpMig = totpStored != null && totpStored !== ''
            ? secretVault.migrateIfNeeded(totpStored)
            : { value: totpStored ?? null, migrated: false }

        if (!pwdMig.migrated && !totpMig.migrated) return

        try {
            const patch: Partial<Account> = {}
            if (pwdMig.migrated) patch.password = pwdMig.value
            if (totpMig.migrated) patch.twoFactorSecret = totpMig.value as string

            const db = getDatabase()
            db.update(schema.accounts)
                .set(patch)
                .where(eq(schema.accounts.id, accountId))
                .run()
            console.log(`[AccountService] Migrated secrets to enc:v1 for account id=${accountId}`)
        } catch (err) {
            console.error('[AccountService] Secret migration failed (non-fatal):', err)
        }
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

    private processRow(account: Account): Account {
        return this.hydrateAccount(this.healProfilePath(account))
    }

    // Get all accounts (main process — secrets decrypted for automation)
    async getAll(): Promise<Account[]> {
        const db = getDatabase()
        const accounts = db.select().from(schema.accounts).all()
        return accounts.map(a => this.processRow(a))
    }

    /** Public DTO list for IPC (no password / TOTP values). */
    async getAllPublic(): Promise<PublicAccount[]> {
        const accounts = await this.getAll()
        return accounts.map(a => this.toPublicAccount(a))
    }

    // Get account by ID (main process — secrets decrypted for login/automation)
    async getById(id: number): Promise<Account | undefined> {
        const db = getDatabase()
        const results = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).all()
        return results[0] ? this.processRow(results[0]) : undefined
    }

    /** Public DTO for IPC. */
    async getByIdPublic(id: number): Promise<PublicAccount | undefined> {
        const account = await this.getById(id)
        return account ? this.toPublicAccount(account) : undefined
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
        return accounts.map(a => this.processRow(a))
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

    // Create new account (supports loginType, twoFactorSecret) — secrets sealed at rest
    async create(data: NewAccount): Promise<Account> {
        const db = getDatabase()
        const email = (this.normalizeEmail(data.email) || data.email) as string
        const sealedPassword = secretVault.seal(data.password)
        const sealedTotp = data.twoFactorSecret
            ? secretVault.seal(data.twoFactorSecret)
            : null

        const result = db.insert(schema.accounts).values({
            ...data,
            email,
            password: sealedPassword,
            twoFactorSecret: sealedTotp,
            createdAt: new Date(),
        }).returning().get()

        return this.processRow(result)
    }

    // Update account — blank password does not overwrite; secrets sealed when provided
    async update(id: number, data: Partial<Account>): Promise<Account | undefined> {
        const db = getDatabase()
        const sealed = this.sealSecretsForWrite(data)

        if (Object.keys(sealed).length === 0) {
            return this.getById(id)
        }

        const result = db.update(schema.accounts)
            .set(sealed)
            .where(eq(schema.accounts.id, id))
            .returning()
            .get()

        return result ? this.processRow(result) : undefined
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
    async importFromCSV(accounts: Array<{
        email: string
        password: string
        recoveryEmail?: string
        recoveryPhone?: string
        twoFactorSecret?: string
        loginType?: 'auto' | 'manual'
    }>): Promise<number> {
        const db = getDatabase()
        let imported = 0

        for (const acc of accounts) {
            try {
                const email = this.normalizeEmail(acc.email) || acc.email
                db.insert(schema.accounts).values({
                    email,
                    password: secretVault.seal(acc.password),
                    recoveryEmail: acc.recoveryEmail || null,
                    recoveryPhone: acc.recoveryPhone || null,
                    twoFactorSecret: acc.twoFactorSecret
                        ? secretVault.seal(acc.twoFactorSecret)
                        : null,
                    loginType: (acc.loginType === 'manual' ? 'manual' : 'auto'),
                    status: 'pending',
                    totalReviews: 0,
                    createdAt: new Date(),
                }).run()
                imported++
            } catch (error) {
                if (error instanceof Error && /unique/i.test(error.message)) {
                    console.log(`Skipped duplicate account import for email ending ${acc.email.slice(-8)}`)
                    continue
                }
                throw error
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
                    email: this.normalizeEmail(acc.email) || acc.email,
                    password: secretVault.seal(acc.password),
                    recoveryEmail: acc.recoveryEmail || null,
                    recoveryPhone: acc.recoveryPhone || null,
                    twoFactorSecret: acc.twoFactorSecret
                        ? secretVault.seal(acc.twoFactorSecret)
                        : null,
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
                account.twoFactorSecret || undefined,
                account.recoveryEmail || undefined,
                account.recoveryPhone || undefined
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
                        const { browserService: bs } = await import('../automation/BrowserService')
                        const ctx = bs.getContext(contextId)
                        if (ctx) {
                            const ck = await ctx.cookies().catch(() => [])
                            if (ck && ck.length > 0) {
                                await this.saveCookies(id, JSON.stringify(ck))
                            }
                        }
                    } catch {
                        // ignore cookie save errors
                    }
                }

                return { alive: true }
            } else {
                // Check for specific error types
                if (loginResult.error?.includes('2FA') || loginResult.error?.includes('2-Step')) {
                    await this.updateStatus(id, 'pending')
                    if (account.twoFactorSecret) {
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
