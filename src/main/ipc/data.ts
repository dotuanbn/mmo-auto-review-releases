import { ipcMain, shell, app } from 'electron'
import { dataRootService } from '../services/DataRootService'
import { profileService } from '../services/ProfileService'
import { backupRestoreService } from '../services/BackupRestoreService'
import { existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
    backupIdSchema,
    createBackupOptionsSchema,
    restoreBackupOptionsSchema,
} from '../../shared/backup-contracts'
import { complianceAuditQuerySchema } from '../../shared/compliance-audit-contracts'
import { complianceAuditService } from '../services/ComplianceAuditService'
import {
    assertOptionalPathWithinRoots,
    assertPathWithinRoots,
    getDataOpenAllowedRoots,
    getLegacyMigrateAllowedRoots,
    parseIpcPayload,
    withIpcValidation,
} from './validate'

/** Roots allowed for backup package path resolution (managed-backups only + userData). */
function getBackupAllowedRoots(): string[] {
    const dataRoot = dataRootService.getDataRoot()
    return [
        dataRoot,
        join(dataRoot, 'managed-backups'),
        backupRestoreService.getManagedBackupsRoot(),
    ]
}

/** Resolve backupId → absolute dir and enforce managed-backups containment. */
function resolveValidatedBackupDir(channel: string, backupId: string): string {
    const dir = backupRestoreService.resolveBackupDir(backupId)
    return assertPathWithinRoots(channel, dir, getBackupAllowedRoots())
}

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
                if (e.name.startsWith('profile_') || e.name.startsWith('account_')) {
                    count++
                    size += safeGetDirSize(p)
                    const ck = join(p, 'cookies', 'cookies.json')
                    if (existsSync(ck)) cookiesAccounts++
                }
            }
        }
    } catch { /* ignore */ }
    return { size, count, cookiesAccounts }
}

function getDbSize(): number {
    try {
        const userData = app.getPath('userData')
        const dbPath = join(userData, 'data', 'mmo-review.db')
        if (existsSync(dbPath)) {
            return statSync(dbPath).size
        }
    } catch { /* ignore */ }
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

    let managedProfilesSize = 0
    try {
        const listed = profileService.listProfiles()
        managedProfilesSize = listed.reduce((s, p) => s + (p.size || 0), 0)
    } catch { /* ignore */ }

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
    ipcMain.handle('data:getRoot', withIpcValidation('data:getRoot', async () => {
        return {
            dataRoot: dataRootService.getDataRoot(),
        }
    }))

    ipcMain.handle('data:detectLegacy', withIpcValidation('data:detectLegacy', async () => {
        return dataRootService.detectLegacyRoots()
    }))

    ipcMain.handle('data:migrateLegacy', withIpcValidation('data:migrateLegacy', async (_event, sourcePath?: unknown) => {
        const safeSource = assertOptionalPathWithinRoots(
            'data:migrateLegacy',
            sourcePath,
            getLegacyMigrateAllowedRoots(),
        )
        return dataRootService.migrateLegacyData(safeSource)
    }))

    ipcMain.handle('data:getStorageInfo', withIpcValidation('data:getStorageInfo', async () => {
        return computeStorageInfo()
    }))

    ipcMain.handle('data:openPath', withIpcValidation('data:openPath', async (_event, targetPath?: unknown) => {
        if (targetPath === undefined || targetPath === null || targetPath === '') {
            return 'invalid'
        }

        let safePath: string
        try {
            const dataRoot = dataRootService.getDataRoot()
            let profilesPath: string | undefined
            try {
                profilesPath = profileService.getProfilesPath()
            } catch {
                profilesPath = undefined
            }
            safePath = assertPathWithinRoots(
                'data:openPath',
                targetPath,
                getDataOpenAllowedRoots(dataRoot, profilesPath),
            )
        } catch {
            return 'invalid'
        }

        try {
            if (!existsSync(safePath)) {
                const parent = join(safePath, '..')
                try {
                    const safeParent = assertPathWithinRoots(
                        'data:openPath',
                        parent,
                        getDataOpenAllowedRoots(dataRootService.getDataRoot()),
                    )
                    if (existsSync(safeParent)) return await shell.openPath(safeParent)
                } catch {
                    return 'invalid'
                }
            }
            return await shell.openPath(safePath)
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : 'error'
            return message
        }
    }))

    ipcMain.handle('data:clearCaches', withIpcValidation('data:clearCaches', async () => {
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
                        } catch { /* ignore */ }
                    }
                }
            }
        } catch { /* ignore */ }

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
                            } catch { /* ignore */ }
                        }
                    }
                }
            }
        } catch { /* ignore */ }

        return { success: true, cleared }
    }))

    // -----------------------------------------------------------------------
    // Managed backup / restore (path-validated; public DTOs only)
    // -----------------------------------------------------------------------

    ipcMain.handle(
        'data:backupCreate',
        withIpcValidation('data:backupCreate', async (_event, options?: unknown) => {
            const parsed =
                options === undefined || options === null
                    ? {}
                    : parseIpcPayload(
                          'data:backupCreate',
                          createBackupOptionsSchema,
                          options,
                      )
            assertPathWithinRoots(
                'data:backupCreate',
                backupRestoreService.getManagedBackupsRoot(),
                getBackupAllowedRoots(),
            )
            return backupRestoreService.createBackup(parsed)
        }),
    )

    ipcMain.handle(
        'data:backupList',
        withIpcValidation('data:backupList', async () => {
            assertPathWithinRoots(
                'data:backupList',
                backupRestoreService.getManagedBackupsRoot(),
                getBackupAllowedRoots(),
            )
            return backupRestoreService.listBackups()
        }),
    )

    ipcMain.handle(
        'data:backupInspect',
        withIpcValidation('data:backupInspect', async (_event, backupId?: unknown) => {
            const id = parseIpcPayload('data:backupInspect', backupIdSchema, backupId)
            resolveValidatedBackupDir('data:backupInspect', id)
            return backupRestoreService.inspectBackup(id)
        }),
    )

    ipcMain.handle(
        'data:backupRestore',
        withIpcValidation('data:backupRestore', async (_event, options?: unknown) => {
            // Canonical shared schema: backupId + confirmation RESTORE + optional includeProfiles
            const parsed = parseIpcPayload(
                'data:backupRestore',
                restoreBackupOptionsSchema,
                options,
            )
            resolveValidatedBackupDir('data:backupRestore', parsed.backupId)
            return backupRestoreService.restoreBackup(parsed)
        }),
    )

    // -----------------------------------------------------------------------
    // Compliance audit history (strict query; public DTOs only)
    // -----------------------------------------------------------------------

    ipcMain.handle(
        'data:getComplianceAudit',
        withIpcValidation('data:getComplianceAudit', async (_event, query?: unknown) => {
            const parsed =
                query === undefined || query === null
                    ? {}
                    : parseIpcPayload(
                          'data:getComplianceAudit',
                          complianceAuditQuerySchema,
                          query,
                      )
            return complianceAuditService.listEvents(parsed)
        }),
    )
}
