import { ipcMain, shell, app } from 'electron'
import { dataRootService } from '../services/DataRootService'
import { profileService } from '../services/ProfileService'
import { existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs'
import { join, basename } from 'path'

function safeGetDirSize(dir: string): number {
    if (!existsSync(dir)) return 0
    let total = 0
    try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
            const full = join(dir, entry.name)
            try {
                if (entry.isDirectory()) {
                    total += safeGetDirSize(full)
                } else if (entry.isFile()) {
                    const st = statSync(full)
                    total += st.size
                }
            } catch { /* skip bad file */ }
        }
    } catch { /* skip bad dir */ }
    return total
}

function scanProfileLikeDir(baseDir: string): { size: number; count: number; cookiesAccounts: number } {
    if (!existsSync(baseDir)) return { size: 0, count: 0, cookiesAccounts: 0 }
    let size = 0
    let count = 0
    let cookiesAccounts = 0
    try {
        const entries = readdirSync(baseDir, { withFileTypes: true })
        for (const e of entries) {
            if (e.isDirectory()) {
                const p = join(baseDir, e.name)
                // include profile_* and account_* (legacy traffic)
                if (e.name.startsWith('profile_') || e.name.startsWith('account_')) {
                    count++
                    size += safeGetDirSize(p)
                    const ck = join(p, 'cookies', 'cookies.json')
                    if (existsSync(ck)) cookiesAccounts++
                }
            }
        }
    } catch {}
    return { size, count, cookiesAccounts }
}

function getDbSize(): number {
    try {
        const userData = app.getPath('userData')
        const dbPath = join(userData, 'data', 'mmo-review.db')
        if (existsSync(dbPath)) {
            return statSync(dbPath).size
        }
    } catch {}
    return 0
}

function getScreenshotsSize(dataRoot: string): number {
    return safeGetDirSize(join(dataRoot, 'screenshots'))
}

async function computeStorageInfo() {
    const dataRoot = dataRootService.getDataRoot()
    const profilesBase = profileService.getProfilesPath()
    const trafficBase = join(app.getPath('userData'), 'traffic_profiles')

    const prof = scanProfileLikeDir(profilesBase)
    const traf = scanProfileLikeDir(trafficBase)
    const dbSize = getDbSize()
    const shotsSize = getScreenshotsSize(dataRoot)

    // Also add profileService disk list for profiles (more accurate for its managed)
    let managedProfilesSize = 0
    try {
        const listed = profileService.listProfiles()
        managedProfilesSize = listed.reduce((s, p) => s + (p.size || 0), 0)
    } catch {}

    const items = [
        {
            key: 'profiles',
            label: 'Profiles',
            path: profilesBase,
            size: Math.max(prof.size, managedProfilesSize),
            count: prof.count,
            cookies: prof.cookiesAccounts,
        },
        {
            key: 'trafficProfiles',
            label: 'Traffic Profiles',
            path: trafficBase,
            size: traf.size,
            count: traf.count,
            cookies: traf.cookiesAccounts,
        },
        {
            key: 'database',
            label: 'Database',
            path: join(dataRoot, 'data', 'mmo-review.db'),
            size: dbSize,
        },
        {
            key: 'screenshots',
            label: 'Screenshots',
            path: join(dataRoot, 'screenshots'),
            size: shotsSize,
        },
    ]

    const totalSize = items.reduce((s, it) => s + (it.size || 0), 0)
    const totalProfileCount = prof.count + traf.count
    const totalCookiesAccounts = prof.cookiesAccounts + traf.cookiesAccounts

    return {
        dataRoot,
        totalSize,
        items,
        profileCount: totalProfileCount,
        accountsWithCookies: totalCookiesAccounts,
    }
}

export function registerDataHandlers() {
    ipcMain.handle('data:getRoot', async () => {
        return {
            dataRoot: dataRootService.getDataRoot(),
        }
    })

    ipcMain.handle('data:detectLegacy', async () => {
        return dataRootService.detectLegacyRoots()
    })

    ipcMain.handle('data:migrateLegacy', async (_event, sourcePath?: string) => {
        return dataRootService.migrateLegacyData(sourcePath)
    })

    ipcMain.handle('data:getStorageInfo', async () => {
        return computeStorageInfo()
    })

    ipcMain.handle('data:openPath', async (_event, targetPath?: string) => {
        if (!targetPath || typeof targetPath !== 'string') return 'invalid'
        try {
            // ensure exists for root cases
            if (!existsSync(targetPath)) {
                // open parent if child missing
                const parent = join(targetPath, '..')
                if (existsSync(parent)) return await shell.openPath(parent)
            }
            return await shell.openPath(targetPath)
        } catch (e: any) {
            return e?.message || 'error'
        }
    })

    ipcMain.handle('data:clearCaches', async () => {
        let cleared = 0
        try {
            const profBase = profileService.getProfilesPath()
            if (existsSync(profBase)) {
                const entries = readdirSync(profBase, { withFileTypes: true })
                for (const e of entries) {
                    if (e.isDirectory() && (e.name.startsWith('profile_') || e.name.startsWith('account_'))) {
                        const full = join(profBase, e.name)
                        try {
                            profileService.clearProfileCache(full)
                            cleared++
                        } catch {}
                    }
                }
            }
        } catch {}

        // traffic_profiles caches (manual, same structure)
        try {
            const tBase = join(app.getPath('userData'), 'traffic_profiles')
            if (existsSync(tBase)) {
                const entries = readdirSync(tBase, { withFileTypes: true })
                for (const e of entries) {
                    if (e.isDirectory()) {
                        const full = join(tBase, e.name)
                        const cacheP = join(full, 'cache')
                        if (existsSync(cacheP)) {
                            try {
                                rmSync(cacheP, { recursive: true, force: true })
                                mkdirSync(cacheP, { recursive: true })
                                cleared++
                            } catch {}
                        }
                    }
                }
            }
        } catch {}

        return { success: true, cleared }
    })
}

