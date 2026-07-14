/**
 * BackupRestoreService — managed package create/list/inspect/restore.
 * Uses injectable deps (no native better-sqlite3 / Electron app runtime).
 * Covers: checksum before overwrite, symlink/path escape, SQLite integrity,
 * pre-restore snapshot, staged restore, RESTORE confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
    BACKUP_DB_RELATIVE_PATH,
    BACKUP_MANIFEST_FILE,
    BACKUP_MANIFEST_VERSION,
    BACKUP_SETTINGS_RELATIVE_PATH,
    RESTORE_CONFIRM_PHRASE,
} from '../src/shared/backup-contracts'

const harness = vi.hoisted(() => ({
    userDataDir: '',
}))

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => {
            if (name === 'userData') return harness.userDataDir
            return harness.userDataDir
        },
        getVersion: () => '1.0.8-test',
        isPackaged: false,
    },
}))

vi.mock('../src/main/database', () => ({
    closeDatabase: vi.fn(),
    initDatabase: vi.fn(),
}))

vi.mock('../src/main/database/migrations', () => ({
    migrations: [
        { version: 1, name: 'm1', up: () => undefined },
        { version: 2, name: 'm2', up: () => undefined },
        { version: 3, name: 'm3', up: () => undefined },
    ],
}))

vi.mock('../src/main/services/DataRootService', () => ({
    dataRootService: {
        getDataRoot: () => harness.userDataDir,
    },
}))

vi.mock('../src/main/services/ProfileService', () => ({
    profileService: {
        getProfilesPath: () => join(harness.userDataDir, 'profiles'),
    },
}))

import {
    BackupRestoreService,
    type BackupAuditEvent,
    type BackupRestoreDeps,
} from '../src/main/services/BackupRestoreService'
import { closeDatabase, initDatabase } from '../src/main/database'

function sha256(buf: Buffer | string): string {
    return createHash('sha256').update(buf).digest('hex')
}

function seedLiveData(root: string): void {
    mkdirSync(join(root, 'data'), { recursive: true })
    mkdirSync(join(root, 'profiles', 'profile_1_user'), { recursive: true })
    writeFileSync(join(root, 'data', 'mmo-review.db'), Buffer.from('LIVE-DB-V1'))
    writeFileSync(
        join(root, 'settings.json'),
        JSON.stringify({ theme: 'dark', apiKey: 'SECRET-KEY-DO-NOT-LEAK' }),
        'utf-8',
    )
    writeFileSync(
        join(root, 'profiles', 'profile_1_user', 'cookies.json'),
        JSON.stringify({ session: 'x' }),
        'utf-8',
    )
}

function createService(
    overrides: Partial<BackupRestoreDeps> = {},
    auditLog: BackupAuditEvent[] = [],
): BackupRestoreService {
    let seq = 0
    return new BackupRestoreService({
        getUserDataPath: () => harness.userDataDir,
        getAppVersion: () => '1.0.8-test',
        getDbPath: () => join(harness.userDataDir, 'data', 'mmo-review.db'),
        getSettingsPath: () => join(harness.userDataDir, 'settings.json'),
        getProfilesPath: () => join(harness.userDataDir, 'profiles'),
        closeDatabase: () => {
            closeDatabase()
        },
        reopenDatabase: () => {
            initDatabase()
        },
        backupSqliteTo: async (sourcePath, destPath) => {
            mkdirSync(join(destPath, '..'), { recursive: true })
            if (existsSync(sourcePath)) {
                writeFileSync(destPath, readFileSync(sourcePath))
            } else {
                writeFileSync(destPath, Buffer.alloc(0))
            }
        },
        readSchemaVersion: () => 3,
        assertDbIntegrity: (dbPath) => {
            if (!existsSync(dbPath) || readFileSync(dbPath).length === 0) {
                throw new Error('DB integrity failed')
            }
        },
        recordAudit: (event) => {
            auditLog.push(event)
        },
        now: () => {
            seq += 1
            return new Date(Date.parse('2026-07-14T12:00:00.000Z') + seq * 1000)
        },
        randomId: () => {
            seq += 1
            return `r${seq.toString(16).padStart(4, '0')}`
        },
        ...overrides,
    })
}

function restoreOpts(
    backupId: string,
    over: { includeProfiles?: boolean; confirmation?: string } = {},
): { backupId: string; confirmation: 'RESTORE'; includeProfiles?: boolean } {
    return {
        backupId,
        confirmation: (over.confirmation as 'RESTORE') ?? RESTORE_CONFIRM_PHRASE,
        includeProfiles: over.includeProfiles,
    }
}

beforeEach(() => {
    harness.userDataDir = mkdtempSync(join(tmpdir(), 'mmo-backup-'))
    seedLiveData(harness.userDataDir)
    vi.mocked(closeDatabase).mockClear()
    vi.mocked(initDatabase).mockClear()
    vi.mocked(closeDatabase).mockImplementation(() => undefined)
    vi.mocked(initDatabase).mockImplementation(() => ({}) as never)
})

afterEach(() => {
    try {
        rmSync(harness.userDataDir, { recursive: true, force: true })
    } catch {
        // ignore
    }
})

// ---------------------------------------------------------------------------
// create / list / inspect
// ---------------------------------------------------------------------------

describe('BackupRestoreService.createBackup', () => {
    it('creates managed package with manifest, checksums, settings; no secrets in public DTO', async () => {
        const audit: BackupAuditEvent[] = []
        const svc = createService(
            {
                now: () => new Date('2026-07-14T12:00:00.000Z'),
                randomId: () => 'abcd',
            },
            audit,
        )
        const result = await svc.createBackup({ label: 'unit' })

        expect(result.success).toBe(true)
        expect(result.backupId).toBe('backup-2026-07-14T12-00-00-000Z-abcd')
        expect(result.summary?.label).toBe('unit')
        expect(result.summary?.appVersion).toBe('1.0.8-test')
        expect(result.summary?.manifestVersion).toBe(BACKUP_MANIFEST_VERSION)
        expect(result.summary?.backupId).toBe(result.backupId)
        expect(typeof result.summary?.totalSizeBytes).toBe('number')
        expect(result.summary?.includeProfiles).toBe(false)
        expect(JSON.stringify(result)).not.toContain('SECRET-KEY')

        const dir = svc.resolveBackupDir(result.backupId!)
        const manifest = JSON.parse(
            readFileSync(join(dir, BACKUP_MANIFEST_FILE), 'utf-8'),
        ) as {
            files: Array<{ relativePath: string; sha256: string; sizeBytes: number }>
            includeProfiles: boolean
            label?: string
        }
        expect(manifest.includeProfiles).toBe(false)
        expect(manifest.label).toBe('unit')
        const dbEntry = manifest.files.find((f) => f.relativePath === BACKUP_DB_RELATIVE_PATH)
        expect(dbEntry?.sha256).toBe(sha256(Buffer.from('LIVE-DB-V1')))
        const settingsEntry = manifest.files.find(
            (f) => f.relativePath === BACKUP_SETTINGS_RELATIVE_PATH,
        )
        expect(settingsEntry).toBeTruthy()
        expect(
            existsSync(join(dir, ...BACKUP_SETTINGS_RELATIVE_PATH.split('/'))),
        ).toBe(true)
        expect(audit.some((e) => e.action === 'backup.create' && e.success)).toBe(true)
    })

    it('always includes settings even when live settings file is missing', async () => {
        rmSync(join(harness.userDataDir, 'settings.json'), { force: true })
        const svc = createService()
        const result = await svc.createBackup()
        expect(result.success).toBe(true)
        const dir = svc.resolveBackupDir(result.backupId!)
        const settingsPath = join(dir, ...BACKUP_SETTINGS_RELATIVE_PATH.split('/'))
        expect(existsSync(settingsPath)).toBe(true)
        expect(readFileSync(settingsPath, 'utf-8')).toBe('{}')
    })

    it('includes profiles when requested and rejects symlink trees', async () => {
        const svc = createService()
        const ok = await svc.createBackup({ includeProfiles: true })
        expect(ok.success).toBe(true)
        expect(ok.summary?.includeProfiles).toBe(true)
        const dir = svc.resolveBackupDir(ok.backupId!)
        expect(
            existsSync(join(dir, 'profiles', 'profile_1_user', 'cookies.json')),
        ).toBe(true)

        // Symlink escape under profiles
        const linkTarget = join(harness.userDataDir, 'outside-secret.txt')
        writeFileSync(linkTarget, 'leak')
        const linkPath = join(harness.userDataDir, 'profiles', 'evil-link')
        try {
            symlinkSync(linkTarget, linkPath)
        } catch {
            // Windows without privilege: skip symlink assertion
            return
        }
        const bad = await svc.createBackup({ includeProfiles: true })
        expect(bad.success).toBe(false)
        expect(bad.message.toLowerCase()).toMatch(/symlink/)
    })
})

describe('BackupRestoreService.listBackups / inspectBackup', () => {
    it('lists summaries newest-first and inspect validates checksums', async () => {
        let n = 0
        const svc = createService({
            randomId: () => `id${n++}`,
            now: () => {
                const base = Date.parse('2026-07-14T12:00:00.000Z')
                return new Date(base + n * 1000)
            },
        })
        const a = await svc.createBackup({ label: 'a' })
        const b = await svc.createBackup({ label: 'b' })
        expect(a.success && b.success).toBe(true)

        const list = svc.listBackups()
        expect(list.length).toBeGreaterThanOrEqual(2)
        expect(list[0].createdAt >= list[1].createdAt).toBe(true)
        expect(list[0].backupId).toBeTruthy()
        expect(typeof list[0].totalSizeBytes).toBe('number')

        const inspect = await svc.inspectBackup(a.backupId!)
        expect(inspect.valid).toBe(true)
        expect(inspect.validationErrors).toEqual([])
        expect(inspect.files.length).toBeGreaterThan(0)
        expect(inspect.backupId).toBe(a.backupId)
        expect(JSON.stringify(inspect)).not.toContain('SECRET-KEY')

        // Tamper db → inspect invalid
        writeFileSync(
            join(svc.resolveBackupDir(a.backupId!), ...BACKUP_DB_RELATIVE_PATH.split('/')),
            Buffer.from('TAMPERED'),
        )
        const bad = await svc.inspectBackup(a.backupId!)
        expect(bad.valid).toBe(false)
        expect(bad.validationErrors.some((e) => /checksum|size/i.test(e))).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('BackupRestoreService.restoreBackup', () => {
    it('restores db+settings after pre-restore snapshot; closes and reopens DB', async () => {
        const audit: BackupAuditEvent[] = []
        const svc = createService({}, audit)
        const created = await svc.createBackup()
        expect(created.success).toBe(true)

        // Mutate live data
        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('LIVE-DB-V2'))
        writeFileSync(join(harness.userDataDir, 'settings.json'), '{"theme":"light"}', 'utf-8')

        const restored = await svc.restoreBackup(restoreOpts(created.backupId!))
        expect(restored.success).toBe(true)
        expect(restored.preRestoreBackupId).toBeTruthy()
        expect(restored.restartRequired).toBe(false)
        expect(closeDatabase).toHaveBeenCalled()
        expect(initDatabase).toHaveBeenCalled()

        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('LIVE-DB-V1'),
        )
        const settings = readFileSync(join(harness.userDataDir, 'settings.json'), 'utf-8')
        expect(settings).toContain('dark')
        expect(audit.some((e) => e.action === 'backup.restore' && e.success)).toBe(true)

        // Pre-restore snapshot retained
        const pre = await svc.inspectBackup(restored.preRestoreBackupId!)
        expect(pre.valid).toBe(true)
    })

    it('rejects wrong confirmation without touching live data', async () => {
        const svc = createService()
        const created = await svc.createBackup()
        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('UNTOUCHED'))

        const result = await svc.restoreBackup({
            backupId: created.backupId!,
            confirmation: 'restore' as 'RESTORE',
        })
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/confirmation|RESTORE/i)
        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('UNTOUCHED'),
        )
        expect(closeDatabase).not.toHaveBeenCalled()
    })

    it('never overwrites live data when validation fails (checksum)', async () => {
        const svc = createService()
        const created = await svc.createBackup()
        const dir = svc.resolveBackupDir(created.backupId!)
        writeFileSync(
            join(dir, ...BACKUP_DB_RELATIVE_PATH.split('/')),
            Buffer.from('CORRUPT'),
        )

        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('UNTOUCHED'))
        const result = await svc.restoreBackup(restoreOpts(created.backupId!))
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/validation failed/i)
        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('UNTOUCHED'),
        )
        expect(closeDatabase).not.toHaveBeenCalled()
    })

    it('fails closed and asks for restart when DB cannot be closed', async () => {
        const svc = createService({
            closeDatabase: () => {
                throw new Error('busy')
            },
        })
        const created = await svc.createBackup()
        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('LIVE-DB-V2'))

        const result = await svc.restoreBackup(restoreOpts(created.backupId!))
        expect(result.success).toBe(false)
        expect(result.restartRequired).toBe(true)
        expect(result.stagedRestoreId).toBeUndefined()
        // Live not overwritten when close fails
        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('LIVE-DB-V2'),
        )
        expect(result.message).toMatch(/restart.*retry/i)
    })

    it('rejects a symlinked backup package directory', async () => {
        const svc = createService()
        const created = await svc.createBackup()
        const linkedId = 'backup-2026-07-14T12-00-00-000Z-linked'
        const linkedDir = join(harness.userDataDir, 'managed-backups', linkedId)
        try {
            symlinkSync(svc.resolveBackupDir(created.backupId!), linkedDir, 'junction')
        } catch {
            return
        }

        const inspected = await svc.inspectBackup(linkedId)
        expect(inspected.valid).toBe(false)
        expect(inspected.validationErrors.join(' ')).toMatch(/symlink/i)
        const restored = await svc.restoreBackup(restoreOpts(linkedId))
        expect(restored.success).toBe(false)
        expect(restored.message).toMatch(/symlink/i)
    })

    it('rejects symlinked live profile targets before overwriting database', async () => {
        const svc = createService()
        const created = await svc.createBackup({ includeProfiles: true })
        const liveDb = join(harness.userDataDir, 'data', 'mmo-review.db')
        writeFileSync(liveDb, Buffer.from('LIVE-DB-V2'))

        const profileDir = join(harness.userDataDir, 'profiles', 'profile_1_user')
        const outsideDir = join(harness.userDataDir, 'outside-profile-target')
        rmSync(profileDir, { recursive: true, force: true })
        mkdirSync(outsideDir, { recursive: true })
        writeFileSync(join(outsideDir, 'sentinel.txt'), 'KEEP', 'utf-8')
        try {
            symlinkSync(outsideDir, profileDir, 'junction')
        } catch {
            return
        }

        const result = await svc.restoreBackup({
            ...restoreOpts(created.backupId!),
            includeProfiles: true,
        })
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/symlink|unsafe live restore target/i)
        expect(readFileSync(liveDb)).toEqual(Buffer.from('LIVE-DB-V2'))
        expect(readFileSync(join(outsideDir, 'sentinel.txt'), 'utf-8')).toBe('KEEP')
    })

    it('returns restartRequired when reopen fails after apply', async () => {
        const svc = createService({
            reopenDatabase: () => {
                throw new Error('reopen failed')
            },
        })
        const created = await svc.createBackup()
        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('LIVE-DB-V2'))

        const result = await svc.restoreBackup(restoreOpts(created.backupId!))
        expect(result.success).toBe(true)
        expect(result.restartRequired).toBe(true)
        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('LIVE-DB-V1'),
        )
    })

    it('rejects schema newer than app without touching live files', async () => {
        const svc = createService()
        const created = await svc.createBackup()
        const dir = svc.resolveBackupDir(created.backupId!)
        const manifestPath = join(dir, BACKUP_MANIFEST_FILE)
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
        manifest.schemaVersion = 99
        writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8')

        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('KEEP'))
        const result = await svc.restoreBackup(restoreOpts(created.backupId!))
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/schema|newer|validation/i)
        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('KEEP'),
        )
    })

    it('rejects package missing settings entry without overwrite', async () => {
        const svc = createService()
        const created = await svc.createBackup()
        const dir = svc.resolveBackupDir(created.backupId!)
        const manifestPath = join(dir, BACKUP_MANIFEST_FILE)
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
            files: Array<{ relativePath: string; sha256: string; sizeBytes: number }>
        }
        manifest.files = manifest.files.filter(
            (f) => f.relativePath !== BACKUP_SETTINGS_RELATIVE_PATH,
        )
        writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8')

        writeFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'), Buffer.from('KEEP'))
        const result = await svc.restoreBackup(restoreOpts(created.backupId!))
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/settings|validation/i)
        expect(readFileSync(join(harness.userDataDir, 'data', 'mmo-review.db'))).toEqual(
            Buffer.from('KEEP'),
        )
    })
})

describe('path safety', () => {
    it('resolveBackupDir rejects unsafe ids', () => {
        const svc = createService()
        expect(() => svc.resolveBackupDir('../escape')).toThrow(/invalid/i)
        expect(() => svc.resolveBackupDir('a/b')).toThrow(/invalid/i)
    })
})
