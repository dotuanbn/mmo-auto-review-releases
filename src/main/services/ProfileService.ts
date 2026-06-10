import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { accountService } from './AccountService'

/**
 * ProfileService - Manages browser profiles for each account
 * Each account gets a unique profile folder with:
 * - Cookies
 * - Local Storage
 * - Browser cache
 * - Session data
 */
export class ProfileService {
    private profilesBasePath: string

    constructor() {
        // Default profiles path in app data
        this.profilesBasePath = path.join(app.getPath('userData'), 'profiles')
        this.ensureProfilesDirectory()
    }

    // Ensure profiles directory exists
    private ensureProfilesDirectory(): void {
        if (!fs.existsSync(this.profilesBasePath)) {
            fs.mkdirSync(this.profilesBasePath, { recursive: true })
        }
    }

    // Set custom profiles base path
    setProfilesPath(basePath: string): void {
        this.profilesBasePath = basePath
        this.ensureProfilesDirectory()
    }

    // Get profiles base path
    getProfilesPath(): string {
        return this.profilesBasePath
    }

    // Generate profile folder name from email (sanitized)
    private sanitizeEmail(email: string): string {
        return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    }

    // Get profile path for an account
    getProfilePath(accountId: number, email: string): string {
        const sanitizedEmail = this.sanitizeEmail(email)
        return path.join(this.profilesBasePath, `profile_${accountId}_${sanitizedEmail}`)
    }

    // Create profile folder for account
    async createProfile(accountId: number, email: string): Promise<string> {
        const profilePath = this.getProfilePath(accountId, email)

        if (!fs.existsSync(profilePath)) {
            fs.mkdirSync(profilePath, { recursive: true })

            // Create subdirectories for organization
            fs.mkdirSync(path.join(profilePath, 'cookies'), { recursive: true })
            fs.mkdirSync(path.join(profilePath, 'storage'), { recursive: true })
            fs.mkdirSync(path.join(profilePath, 'cache'), { recursive: true })
        }

        // Update account with profile path
        await accountService.update(accountId, { profilePath })

        return profilePath
    }

    // Check if profile exists
    profileExists(accountId: number, email: string): boolean {
        const profilePath = this.getProfilePath(accountId, email)
        return fs.existsSync(profilePath)
    }

    // Save cookies to profile
    async saveCookies(profilePath: string, cookies: any[]): Promise<void> {
        const cookiesPath = path.join(profilePath, 'cookies', 'cookies.json')
        fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2), 'utf-8')
    }

    // Load cookies from profile
    loadCookies(profilePath: string): any[] | null {
        const cookiesPath = path.join(profilePath, 'cookies', 'cookies.json')

        if (fs.existsSync(cookiesPath)) {
            try {
                const data = fs.readFileSync(cookiesPath, 'utf-8')
                return JSON.parse(data)
            } catch (error) {
                console.error('Failed to load cookies:', error)
                return null
            }
        }

        return null
    }

    // Save local storage data
    async saveLocalStorage(profilePath: string, origin: string, data: Record<string, string>): Promise<void> {
        const sanitizedOrigin = origin.replace(/[^a-zA-Z0-9]/g, '_')
        const storagePath = path.join(profilePath, 'storage', `${sanitizedOrigin}.json`)
        fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf-8')
    }

    // Load local storage data
    loadLocalStorage(profilePath: string, origin: string): Record<string, string> | null {
        const sanitizedOrigin = origin.replace(/[^a-zA-Z0-9]/g, '_')
        const storagePath = path.join(profilePath, 'storage', `${sanitizedOrigin}.json`)

        if (fs.existsSync(storagePath)) {
            try {
                const data = fs.readFileSync(storagePath, 'utf-8')
                return JSON.parse(data)
            } catch (error) {
                console.error('Failed to load local storage:', error)
                return null
            }
        }

        return null
    }

    // Delete profile folder
    async deleteProfile(accountId: number, email: string): Promise<void> {
        const profilePath = this.getProfilePath(accountId, email)

        if (fs.existsSync(profilePath)) {
            fs.rmSync(profilePath, { recursive: true, force: true })
        }
    }

    // Get profile size in bytes
    getProfileSize(profilePath: string): number {
        if (!fs.existsSync(profilePath)) return 0

        let totalSize = 0
        const files = fs.readdirSync(profilePath, { recursive: true, withFileTypes: true })

        for (const file of files) {
            if (file.isFile()) {
                const filePath = path.join(file.parentPath || file.path, file.name)
                try {
                    const stats = fs.statSync(filePath)
                    totalSize += stats.size
                } catch {
                    // Skip inaccessible files
                }
            }
        }

        return totalSize
    }

    // List all profiles
    listProfiles(): Array<{ path: string; size: number }> {
        if (!fs.existsSync(this.profilesBasePath)) return []

        const profiles: Array<{ path: string; size: number }> = []
        const entries = fs.readdirSync(this.profilesBasePath, { withFileTypes: true })

        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('profile_')) {
                const fullPath = path.join(this.profilesBasePath, entry.name)
                profiles.push({
                    path: fullPath,
                    size: this.getProfileSize(fullPath)
                })
            }
        }

        return profiles
    }

    // Clear profile cache (keeps cookies and storage)
    clearProfileCache(profilePath: string): void {
        const cachePath = path.join(profilePath, 'cache')

        if (fs.existsSync(cachePath)) {
            fs.rmSync(cachePath, { recursive: true, force: true })
            fs.mkdirSync(cachePath, { recursive: true })
        }
    }

    // Get profile info
    getProfileInfo(profilePath: string): {
        exists: boolean
        hasCookies: boolean
        hasStorage: boolean
        sizeBytes: number
        createdAt?: Date
    } {
        if (!fs.existsSync(profilePath)) {
            return { exists: false, hasCookies: false, hasStorage: false, sizeBytes: 0 }
        }

        const cookiesPath = path.join(profilePath, 'cookies', 'cookies.json')
        const storagePath = path.join(profilePath, 'storage')

        let createdAt: Date | undefined
        try {
            const stats = fs.statSync(profilePath)
            createdAt = stats.birthtime
        } catch {
            // Ignore
        }

        return {
            exists: true,
            hasCookies: fs.existsSync(cookiesPath),
            hasStorage: fs.existsSync(storagePath) && fs.readdirSync(storagePath).length > 0,
            sizeBytes: this.getProfileSize(profilePath),
            createdAt
        }
    }
}

export const profileService = new ProfileService()
