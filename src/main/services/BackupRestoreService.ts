/**
 * BackupRestoreService — managed application data backup / restore.
 *
 * Package layout under <userData>/managed-backups/<backupId>/:
 *   manifest.json, database/mmo-review.db, settings/settings.json, profiles/ (optional)
 *
 * Public results never include secret values or settings/db file contents.
 * ComplianceAuditService is optional (best-effort record on create/restore).
 */

import { createHash, randomBytes } from 'node:crypto'
import {
    copyFileSync,
    createReadStream,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import {
    BACKUP_DB_RELATIVE_PATH,
    BACKUP_MANIFEST_FILE,
    BACKUP_MANIFEST_VERSION,
    BACKUP_PROFILES_RELATIVE_DIR,
    BACKUP_SETTINGS_RELATIVE_PATH,
    RESTORE_CONFIRM_PHRASE,
    isRestoreConfirmation,
    isSafeBackupId,
    toPublicBackupSummary,
    type BackupFileChecksum,
    type BackupManifest,
    type CreateBackupOptions,
    type CreateBackupResult,
    type PublicBackupInspect,
    type PublicBackupSummary,
    type RestoreBackupOptions,
    type RestoreBackupResult,
} from '../../shared/backup-contracts'
import { closeDatabase, initDatabase } from '../database'
import { migrations } from '../database/migrations'
import { dataRootService } from './DataRootService'
import { profileService } from './ProfileService'

// ---------------------------------------------------------------------------
// Bounds / constants
// ---------------------------------------------------------------------------

const MANAGED_BACKUPS_DIRNAME = 'managed-backups'
const STAGING_DIRNAME = '.staging'
const PRE_RESTORE_PREFIX = 'pre-restore'

/** Profile tree copy limits (symlink escape + runaway trees). */
const MAX_PROFILE_DEPTH = 8
const MAX_PROFILE_FILES = 5000
const MAX_PROFILE_TOTAL_BYTES = 512 * 1024 * 1024

const APP_MAX_SCHEMA_VERSION = Math.max(0, ...migrations.map((m) => m.version))

// ---------------------------------------------------------------------------
// Injectable dependencies (unit tests)
// ---------------------------------------------------------------------------

export interface BackupAuditEvent {
    action: 'backup.create' | 'backup.restore'
    backupId?: string
    success: boolean
    message: string
    includeProfiles?: boolean
    preRestoreBackupId?: string
    restartRequired?: boolean
}

export interface BackupRestoreDeps {
    getUserDataPath: () => string
    getAppVersion: () => string
    getDbPath: () => string
    getSettingsPath: () => string
    getProfilesPath: () => string
    closeDatabase: () => void
    reopenDatabase: () => void
    /** Live-consistent SQLite copy. Defaults to better-sqlite3 backup API. */
    backupSqliteTo: (sourcePath: string, destPath: string) => Promise<void>
    readSchemaVersion: (dbPath: string) => number | null
    assertDbIntegrity: (dbPath: string) => void
    recordAudit?: (event: BackupAuditEvent) => void
    now: () => Date
    randomId: () => string
}

function defaultUserDataPath(): string {
    return dataRootService.getDataRoot()
}

function defaultAppVersion(): string {
    try {
        return app.getVersion()
    } catch {
        return '0.0.0'
    }
}

function defaultDbPath(): string {
    return join(defaultUserDataPath(), 'data', 'mmo-review.db')
}

function defaultSettingsPath(): string {
    return join(defaultUserDataPath(), 'settings.json')
}

function defaultProfilesPath(): string {
    try {
        return profileService.getProfilesPath()
    } catch {
        return join(defaultUserDataPath(), 'profiles')
    }
}

/** better-sqlite3 live backup (or open+backup) for a consistent on-disk image. */
export async function defaultBackupSqliteTo(
    sourcePath: string,
    destPath: string,
): Promise<void> {
    ensureParentDir(destPath)
    if (!existsSync(sourcePath)) {
        writeFileSync(destPath, Buffer.alloc(0))
        return
    }
    const Database = (await import('better-sqlite3')).default
    const source = new Database(sourcePath, { fileMustExist: true })
    try {
        try {
            source.pragma('wal_checkpoint(TRUNCATE)')
        } catch {
            // best-effort checkpoint before backup API
        }
        await source.backup(destPath)
    } finally {
        source.close()
    }
}

export function defaultReadSchemaVersion(dbPath: string): number | null {
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) return null
    // Lazy require keeps unit tests free of native ABI when they inject stubs.
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
        const row = db
            .prepare('SELECT MAX(version) AS v FROM schema_migrations')
            .get() as { v: number | null } | undefined
        return row?.v ?? null
    } catch {
        return null
    } finally {
        db.close()
    }
}

export function defaultAssertDbIntegrity(dbPath: string): void {
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
        throw new Error('Backup database file is missing or empty')
    }
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
        const rows = db.prepare('PRAGMA integrity_check').all() as Array<
            Record<string, unknown>
        >
        const messages = rows.map((row) => String(Object.values(row)[0] ?? ''))
        if (messages.length !== 1 || messages[0] !== 'ok') {
            throw new Error(`SQLite integrity_check failed: ${messages.join('; ')}`)
        }
        const tables = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all() as Array<{ name: string }>
        if (tables.length === 0) {
            throw new Error('Backup database has no user tables')
        }
    } finally {
        db.close()
    }
}

function tryLoadOptionalAuditor(): ((event: BackupAuditEvent) => void) | undefined {
    try {
        // Soft dependency: present in production main process; optional for isolated tests.
        const mod = require('./ComplianceAuditService') as {
            complianceAuditService?: { record?: (event: BackupAuditEvent) => unknown }
        }
        const record = mod.complianceAuditService?.record
        if (typeof record !== 'function') return undefined
        return (event) => {
            record.call(mod.complianceAuditService, event)
        }
    } catch {
        return undefined
    }
}

function createDefaultDeps(): BackupRestoreDeps {
    return {
        getUserDataPath: defaultUserDataPath,
        getAppVersion: defaultAppVersion,
        getDbPath: defaultDbPath,
        getSettingsPath: defaultSettingsPath,
        getProfilesPath: defaultProfilesPath,
        closeDatabase,
        reopenDatabase: () => {
            initDatabase()
        },
        backupSqliteTo: defaultBackupSqliteTo,
        readSchemaVersion: defaultReadSchemaVersion,
        assertDbIntegrity: defaultAssertDbIntegrity,
        recordAudit: tryLoadOptionalAuditor(),
        now: () => new Date(),
        randomId: () => randomBytes(4).toString('hex'),
    }
}

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function ensureParentDir(filePath: string): void {
    ensureDir(dirname(filePath))
}

function normalizeForCompare(p: string): string {
    return resolve(p).replace(/[/\\]+$/, '')
}

function isPathInside(candidate: string, root: string): boolean {
    const c = normalizeForCompare(candidate).toLowerCase()
    const r = normalizeForCompare(root).toLowerCase()
    return c === r || c.startsWith(r + sep.toLowerCase()) || c.startsWith(r + '\\') || c.startsWith(r + '/')
}

function assertNoSymlinkComponents(candidate: string, root: string, label: string): void {
    if (!isPathInside(candidate, root)) {
        throw new Error(`${label} escapes the managed data root`)
    }

    const resolvedRoot = resolve(root)
    const relativePath = relative(resolvedRoot, resolve(candidate))
    const segments = relativePath.split(/[/\\]/).filter(Boolean)
    let current = resolvedRoot
    for (const segment of ['', ...segments]) {
        if (segment) current = join(current, segment)
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
            throw new Error(`${label} contains a symlink`)
        }
    }
}

function sha256File(filePath: string): Promise<string> {
    return new Promise((resolveHash, reject) => {
        const hash = createHash('sha256')
        const stream = createReadStream(filePath)
        stream.on('data', (chunk: string | Buffer) => {
            hash.update(chunk)
        })
        stream.on('error', reject)
        stream.on('end', () => resolveHash(hash.digest('hex')))
    })
}

function listFilesRecursive(
    rootDir: string,
    maxDepth: number,
    maxFiles: number,
    maxBytes: number,
): { files: string[]; totalBytes: number } {
    const files: string[] = []
    let totalBytes = 0

    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) {
            throw new Error(`Profile tree exceeds max depth ${maxDepth}`)
        }
        if (!existsSync(dir)) return
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
            const full = join(dir, entry.name)
            let st
            try {
                st = lstatSync(full)
            } catch {
                continue
            }
            if (st.isSymbolicLink()) {
                throw new Error(`Symlink rejected in backup tree: ${relative(rootDir, full)}`)
            }
            if (st.isDirectory()) {
                walk(full, depth + 1)
                continue
            }
            if (!st.isFile()) continue
            files.push(full)
            totalBytes += st.size
            if (files.length > maxFiles) {
                throw new Error(`Profile tree exceeds max file count ${maxFiles}`)
            }
            if (totalBytes > maxBytes) {
                throw new Error(`Profile tree exceeds max size ${maxBytes} bytes`)
            }
        }
    }

    walk(rootDir, 0)
    return { files, totalBytes }
}

function copyFileBounded(src: string, dest: string): void {
    ensureParentDir(dest)
    copyFileSync(src, dest)
}

function copyTreeBounded(srcRoot: string, destRoot: string): BackupFileChecksum[] {
    if (!existsSync(srcRoot)) return []
    const rootStat = lstatSync(srcRoot)
    if (rootStat.isSymbolicLink()) {
        throw new Error('Profiles path is a symlink (rejected)')
    }
    if (!rootStat.isDirectory()) {
        throw new Error('Profiles path is not a directory')
    }

    const { files } = listFilesRecursive(
        srcRoot,
        MAX_PROFILE_DEPTH,
        MAX_PROFILE_FILES,
        MAX_PROFILE_TOTAL_BYTES,
    )
    const checksums: BackupFileChecksum[] = []
    for (const srcFile of files) {
        const rel = relative(srcRoot, srcFile).split(/[/\\]/).join('/')
        const destFile = join(destRoot, ...rel.split('/'))
        if (!isPathInside(destFile, destRoot)) {
            throw new Error(`Path escape rejected: ${rel}`)
        }
        copyFileBounded(srcFile, destFile)
        const sizeBytes = statSync(destFile).size
        checksums.push({
            relativePath: `${BACKUP_PROFILES_RELATIVE_DIR}/${rel}`,
            sha256: '', // filled later
            sizeBytes,
        })
    }
    return checksums
}

function replaceFileAtomic(sourceFile: string, targetFile: string): void {
    ensureParentDir(targetFile)
    const tmp = `${targetFile}.restoring-${process.pid}`
    copyFileSync(sourceFile, tmp)
    try {
        if (existsSync(targetFile)) rmSync(targetFile, { force: true })
        renameSync(tmp, targetFile)
    } catch (error) {
        try {
            if (existsSync(tmp)) rmSync(tmp, { force: true })
        } catch {
            // ignore cleanup
        }
        throw error
    }
}

function removeDirIfExists(dir: string): void {
    if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
    }
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

function parseManifestFileEntry(entry: unknown, index: number): BackupFileChecksum {
    if (!entry || typeof entry !== 'object') {
        throw new Error(`Invalid file entry at ${index}`)
    }
    const f = entry as Record<string, unknown>
    if (typeof f.relativePath !== 'string' || f.relativePath.includes('..')) {
        throw new Error(`Invalid relativePath at ${index}`)
    }
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(f.sha256)) {
        throw new Error(`Invalid sha256 at ${index}`)
    }
    if (typeof f.sizeBytes !== 'number' || !Number.isFinite(f.sizeBytes) || f.sizeBytes < 0) {
        throw new Error(`Invalid sizeBytes at ${index}`)
    }
    return {
        relativePath: f.relativePath.replace(/\\/g, '/'),
        sha256: f.sha256.toLowerCase(),
        sizeBytes: f.sizeBytes,
    }
}

function parseOptionalSchemaVersion(value: unknown): number | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    throw new Error('Invalid schemaVersion')
}

function parseOptionalLabel(value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value === 'string') return value
    throw new Error('Invalid label')
}

function parseManifest(raw: unknown): BackupManifest {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid manifest: not an object')
    }
    const m = raw as Record<string, unknown>
    if (typeof m.manifestVersion !== 'number') throw new Error('Invalid manifestVersion')
    if (typeof m.appVersion !== 'string') throw new Error('Invalid appVersion')
    if (typeof m.createdAt !== 'string') throw new Error('Invalid createdAt')
    if (typeof m.backupId !== 'string' || !isSafeBackupId(m.backupId)) {
        throw new Error('Invalid backupId in manifest')
    }
    if (typeof m.includeProfiles !== 'boolean') throw new Error('Invalid includeProfiles')
    if (!Array.isArray(m.files)) throw new Error('Invalid files list')

    return {
        manifestVersion: m.manifestVersion,
        appVersion: m.appVersion,
        createdAt: m.createdAt,
        backupId: m.backupId,
        label: parseOptionalLabel(m.label),
        includeProfiles: m.includeProfiles,
        schemaVersion: parseOptionalSchemaVersion(m.schemaVersion),
        files: m.files.map(parseManifestFileEntry),
    }
}

function loadManifestFromDir(backupDir: string): BackupManifest {
    const manifestPath = join(backupDir, BACKUP_MANIFEST_FILE)
    if (!existsSync(manifestPath)) {
        throw new Error('manifest.json missing')
    }
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown
    return parseManifest(raw)
}

async function fillChecksums(
    backupDir: string,
    entries: Array<Omit<BackupFileChecksum, 'sha256'> & { sha256?: string }>,
): Promise<BackupFileChecksum[]> {
    const out: BackupFileChecksum[] = []
    for (const entry of entries) {
        const full = join(backupDir, ...entry.relativePath.split('/'))
        if (!existsSync(full)) {
            throw new Error(`Missing backup file: ${entry.relativePath}`)
        }
        const sizeBytes = statSync(full).size
        const sha256 = await sha256File(full)
        out.push({ relativePath: entry.relativePath, sha256, sizeBytes })
    }
    return out
}

async function verifyChecksums(
    backupDir: string,
    files: BackupFileChecksum[],
): Promise<string[]> {
    const errors: string[] = []
    for (const file of files) {
        const full = join(backupDir, ...file.relativePath.split('/'))
        if (!isPathInside(full, backupDir)) {
            errors.push(`Path escape: ${file.relativePath}`)
            continue
        }
        if (!existsSync(full)) {
            errors.push(`Missing file: ${file.relativePath}`)
            continue
        }
        let st
        try {
            st = lstatSync(full)
        } catch {
            errors.push(`Cannot stat: ${file.relativePath}`)
            continue
        }
        if (st.isSymbolicLink()) {
            errors.push(`Symlink in backup: ${file.relativePath}`)
            continue
        }
        if (!st.isFile()) {
            errors.push(`Not a file: ${file.relativePath}`)
            continue
        }
        if (st.size !== file.sizeBytes) {
            errors.push(
                `Size mismatch ${file.relativePath}: expected ${file.sizeBytes}, got ${st.size}`,
            )
            continue
        }
        const digest = await sha256File(full)
        if (digest !== file.sha256.toLowerCase()) {
            errors.push(`Checksum mismatch: ${file.relativePath}`)
        }
    }
    return errors
}

function assertManifestCompatible(manifest: BackupManifest): void {
    if (manifest.manifestVersion > BACKUP_MANIFEST_VERSION) {
        throw new Error(
            `Unsupported manifest version ${manifest.manifestVersion} (app supports ${BACKUP_MANIFEST_VERSION})`,
        )
    }
    if (
        manifest.schemaVersion !== null &&
        manifest.schemaVersion > APP_MAX_SCHEMA_VERSION
    ) {
        throw new Error(
            `Backup schema v${manifest.schemaVersion} is newer than app max v${APP_MAX_SCHEMA_VERSION}`,
        )
    }
    // database + settings are mandatory package contents; profiles optional
    const hasDb = manifest.files.some((f) => f.relativePath === BACKUP_DB_RELATIVE_PATH)
    if (!hasDb) {
        throw new Error('Manifest missing database file entry')
    }
    const hasSettings = manifest.files.some(
        (f) => f.relativePath === BACKUP_SETTINGS_RELATIVE_PATH,
    )
    if (!hasSettings) {
        throw new Error('Manifest missing settings file entry')
    }
    for (const file of manifest.files) {
        if (file.relativePath.includes('..') || file.relativePath.startsWith('/')) {
            throw new Error(`Unsafe relativePath in manifest: ${file.relativePath}`)
        }
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BackupRestoreService {
    private readonly deps: BackupRestoreDeps

    constructor(deps?: Partial<BackupRestoreDeps>) {
        this.deps = { ...createDefaultDeps(), ...deps }
    }

    getManagedBackupsRoot(): string {
        const root = join(this.deps.getUserDataPath(), MANAGED_BACKUPS_DIRNAME)
        ensureDir(root)
        return root
    }

    resolveBackupDir(backupId: string): string {
        if (!isSafeBackupId(backupId)) {
            throw new Error('Invalid backupId')
        }
        const root = this.getManagedBackupsRoot()
        const dir = join(root, backupId)
        if (!isPathInside(dir, root) || normalizeForCompare(dir) === normalizeForCompare(root)) {
            throw new Error('Backup path escapes managed root')
        }
        assertNoSymlinkComponents(dir, root, 'Backup path')
        return dir
    }

    async createBackup(options: CreateBackupOptions = {}): Promise<CreateBackupResult> {
        const includeProfiles = options.includeProfiles === true
        const backupId = this.buildBackupId()
        const backupDir = this.resolveBackupDir(backupId)
        ensureDir(backupDir)

        try {
            const fileEntries = await this.collectBackupFiles(backupDir, includeProfiles)
            const files = await fillChecksums(backupDir, fileEntries)
            const schemaVersion = this.deps.readSchemaVersion(
                join(backupDir, ...BACKUP_DB_RELATIVE_PATH.split('/')),
            )
            const manifest: BackupManifest = {
                manifestVersion: BACKUP_MANIFEST_VERSION,
                appVersion: this.deps.getAppVersion(),
                createdAt: this.deps.now().toISOString(),
                backupId,
                label: options.label,
                includeProfiles,
                schemaVersion,
                files,
            }
            writeFileSync(
                join(backupDir, BACKUP_MANIFEST_FILE),
                JSON.stringify(manifest, null, 2),
                'utf-8',
            )
            const summary = toPublicBackupSummary(manifest)
            this.safeAudit({
                action: 'backup.create',
                backupId,
                success: true,
                message: 'Backup created',
                includeProfiles,
            })
            return {
                success: true,
                message: 'Backup created',
                backupId,
                summary,
            }
        } catch (error) {
            removeDirIfExists(backupDir)
            const message = error instanceof Error ? error.message : String(error)
            this.safeAudit({
                action: 'backup.create',
                backupId,
                success: false,
                message,
                includeProfiles,
            })
            return { success: false, message }
        }
    }

    listBackups(): PublicBackupSummary[] {
        const root = this.getManagedBackupsRoot()
        if (!existsSync(root)) return []
        const summaries: PublicBackupSummary[] = []
        for (const name of readdirSync(root)) {
            if (name === STAGING_DIRNAME || name.startsWith('.')) continue
            if (!isSafeBackupId(name)) continue
            try {
                const dir = this.resolveBackupDir(name)
                const manifest = loadManifestFromDir(dir)
                if (manifest.backupId !== name) continue
                summaries.push(toPublicBackupSummary(manifest))
            } catch {
                // skip corrupt packages
            }
        }
        return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async inspectBackup(backupId: string): Promise<PublicBackupInspect> {
        let dir: string
        try {
            dir = this.resolveBackupDir(backupId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return this.emptyInspect(backupId, [message])
        }
        if (!existsSync(dir)) {
            return this.emptyInspect(backupId, ['Backup directory not found'])
        }
        let manifest: BackupManifest
        try {
            manifest = loadManifestFromDir(dir)
            if (manifest.backupId !== backupId) {
                throw new Error('Manifest backupId does not match its directory')
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return this.emptyInspect(backupId, [message])
        }

        const validationErrors: string[] = []
        try {
            assertManifestCompatible(manifest)
        } catch (error) {
            validationErrors.push(error instanceof Error ? error.message : String(error))
        }
        const checksumErrors = await verifyChecksums(dir, manifest.files)
        validationErrors.push(...checksumErrors)

        const dbPath = join(dir, ...BACKUP_DB_RELATIVE_PATH.split('/'))
        try {
            this.deps.assertDbIntegrity(dbPath)
        } catch (error) {
            validationErrors.push(error instanceof Error ? error.message : String(error))
        }

        return {
            ...toPublicBackupSummary(manifest),
            files: manifest.files,
            valid: validationErrors.length === 0,
            validationErrors,
        }
    }

    async restoreBackup(options: RestoreBackupOptions): Promise<RestoreBackupResult> {
        // Fail closed: schema + service both require exact RESTORE confirmation.
        if (!isRestoreConfirmation(options.confirmation)) {
            return this.failRestore(
                `Restore confirmation required (type ${RESTORE_CONFIRM_PHRASE})`,
            )
        }

        const backupId = options.backupId
        let backupDir: string
        try {
            backupDir = this.resolveBackupDir(backupId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return this.failRestore(message)
        }
        if (!existsSync(backupDir)) {
            return this.failRestore('Backup directory not found')
        }

        // Phase 1: full validation (checksum + SQLite + schema) — never touch live data.
        let manifest: BackupManifest
        try {
            manifest = loadManifestFromDir(backupDir)
            if (manifest.backupId !== backupId) {
                throw new Error('Manifest backupId does not match its directory')
            }
            assertManifestCompatible(manifest)
            const checksumErrors = await verifyChecksums(backupDir, manifest.files)
            if (checksumErrors.length > 0) {
                return this.failRestore(`Validation failed: ${checksumErrors[0]}`)
            }
            this.deps.assertDbIntegrity(
                join(backupDir, ...BACKUP_DB_RELATIVE_PATH.split('/')),
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return this.failRestore(`Validation failed: ${message}`)
        }

        // Phase 2: automatic pre-restore snapshot of live state (rollback point).
        const pre = await this.createBackup({
            includeProfiles: false,
            label: `${PRE_RESTORE_PREFIX}:${backupId}`,
        })
        if (!pre.success || !pre.backupId) {
            return this.failRestore(
                `Pre-restore snapshot failed: ${pre.message}`,
            )
        }

        const wantProfiles =
            options.includeProfiles !== false && manifest.includeProfiles

        // Phase 3: staged restore → re-verify staged checksums → close / apply / reopen.
        return this.applyValidatedRestore({
            manifest,
            backupDir,
            preRestoreBackupId: pre.backupId,
            wantProfiles,
        })
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private buildBackupId(): string {
        const stamp = this.deps
            .now()
            .toISOString()
            .replace(/[:.]/g, '-')
        const id = `backup-${stamp}-${this.deps.randomId()}`
        if (!isSafeBackupId(id)) {
            throw new Error(`Generated backupId is invalid: ${id}`)
        }
        return id
    }

    private async collectBackupFiles(
        backupDir: string,
        includeProfiles: boolean,
    ): Promise<Array<{ relativePath: string; sizeBytes: number }>> {
        const entries: Array<{ relativePath: string; sizeBytes: number }> = []

        // Database is always included (live-consistent SQLite backup API).
        const dbDest = join(backupDir, ...BACKUP_DB_RELATIVE_PATH.split('/'))
        await this.deps.backupSqliteTo(this.deps.getDbPath(), dbDest)
        entries.push({
            relativePath: BACKUP_DB_RELATIVE_PATH,
            sizeBytes: existsSync(dbDest) ? statSync(dbDest).size : 0,
        })

        // Settings are always included (empty object when live file is missing).
        entries.push(this.copySettingsIntoBackup(backupDir))

        if (includeProfiles) {
            const profilesDest = join(backupDir, BACKUP_PROFILES_RELATIVE_DIR)
            const profileEntries = copyTreeBounded(this.deps.getProfilesPath(), profilesDest)
            for (const pe of profileEntries) {
                entries.push({ relativePath: pe.relativePath, sizeBytes: pe.sizeBytes })
            }
        }

        return entries
    }

    /** Always write settings/settings.json into the package (mandatory). */
    private copySettingsIntoBackup(
        backupDir: string,
    ): { relativePath: string; sizeBytes: number } {
        const settingsDest = join(backupDir, ...BACKUP_SETTINGS_RELATIVE_PATH.split('/'))
        ensureParentDir(settingsDest)
        const settingsSrc = this.deps.getSettingsPath()
        if (existsSync(settingsSrc)) {
            const st = lstatSync(settingsSrc)
            if (st.isSymbolicLink()) {
                throw new Error('Settings path is a symlink (rejected)')
            }
            if (!st.isFile()) {
                throw new Error('Settings path is not a file')
            }
            copyFileBounded(settingsSrc, settingsDest)
        } else {
            writeFileSync(settingsDest, '{}', 'utf-8')
        }
        return {
            relativePath: BACKUP_SETTINGS_RELATIVE_PATH,
            sizeBytes: statSync(settingsDest).size,
        }
    }

    private async applyValidatedRestore(input: {
        manifest: BackupManifest
        backupDir: string
        preRestoreBackupId: string
        wantProfiles: boolean
    }): Promise<RestoreBackupResult> {
        const stagedId = `staged-${input.manifest.backupId}-${this.deps.randomId()}`
        const stagedDir = join(this.getManagedBackupsRoot(), STAGING_DIRNAME, stagedId)

        // Stage package under managed-backups/.staging then re-verify before overwrite.
        const staged = await this.tryStageAndVerify(input, stagedDir)
        if (staged) return staged

        try {
            this.assertLiveRestoreTargetsSafe(input.manifest, input.wantProfiles)
        } catch (error) {
            removeDirIfExists(stagedDir)
            const message = error instanceof Error ? error.message : String(error)
            return this.failRestore(`Unsafe live restore target: ${message}`, input.preRestoreBackupId)
        }

        try {
            this.deps.closeDatabase()
        } catch {
            removeDirIfExists(stagedDir)
            return this.failRestore(
                'Could not close database; restart the application and retry restore',
                input.preRestoreBackupId,
                true,
            )
        }

        return this.finishLiveRestore(input, stagedDir, stagedId)
    }

    /**
     * Copy package into staging and re-check checksums / SQLite integrity
     * before any live overwrite.
     */
    private async tryStageAndVerify(
        input: {
            manifest: BackupManifest
            backupDir: string
            preRestoreBackupId: string
            wantProfiles: boolean
        },
        stagedDir: string,
    ): Promise<RestoreBackupResult | null> {
        try {
            this.stageRestorePackage(
                input.backupDir,
                stagedDir,
                input.manifest,
                input.wantProfiles,
            )
            const filesToVerify = input.manifest.files.filter((file) => {
                if (
                    file.relativePath.startsWith(`${BACKUP_PROFILES_RELATIVE_DIR}/`) &&
                    !input.wantProfiles
                ) {
                    return false
                }
                return true
            })
            // Checksum review of staged tree — refuse overwrite on mismatch.
            const checksumErrors = await verifyChecksums(stagedDir, filesToVerify)
            if (checksumErrors.length > 0) {
                removeDirIfExists(stagedDir)
                return this.failRestore(
                    `Staged validation failed: ${checksumErrors[0]}`,
                    input.preRestoreBackupId,
                )
            }
            this.deps.assertDbIntegrity(
                join(stagedDir, ...BACKUP_DB_RELATIVE_PATH.split('/')),
            )
            return null
        } catch (error) {
            removeDirIfExists(stagedDir)
            const message = error instanceof Error ? error.message : String(error)
            return this.failRestore(message, input.preRestoreBackupId)
        }
    }

    private finishLiveRestore(
        input: {
            manifest: BackupManifest
            backupDir: string
            preRestoreBackupId: string
            wantProfiles: boolean
        },
        stagedDir: string,
        stagedId: string,
    ): RestoreBackupResult {
        try {
            this.applyStagedToLive(stagedDir, input.wantProfiles)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.safeAudit({
                action: 'backup.restore',
                backupId: input.manifest.backupId,
                success: false,
                message,
                preRestoreBackupId: input.preRestoreBackupId,
            })
            return {
                success: false,
                message: `Restore apply failed (pre-restore: ${input.preRestoreBackupId}): ${message}`,
                preRestoreBackupId: input.preRestoreBackupId,
                restartRequired: true,
                stagedRestoreId: stagedId,
            }
        }

        return this.reopenAfterRestore(input, stagedDir)
    }

    private reopenAfterRestore(
        input: {
            manifest: BackupManifest
            preRestoreBackupId: string
            wantProfiles: boolean
        },
        stagedDir: string,
    ): RestoreBackupResult {
        try {
            this.deps.reopenDatabase()
        } catch {
            this.safeAudit({
                action: 'backup.restore',
                backupId: input.manifest.backupId,
                success: true,
                message: 'Restored; reopen failed — restart required',
                preRestoreBackupId: input.preRestoreBackupId,
                restartRequired: true,
            })
            return {
                success: true,
                message:
                    'Backup restored; database reopen failed — application restart required',
                preRestoreBackupId: input.preRestoreBackupId,
                restartRequired: true,
            }
        }

        removeDirIfExists(stagedDir)
        this.safeAudit({
            action: 'backup.restore',
            backupId: input.manifest.backupId,
            success: true,
            message: 'Restore completed',
            preRestoreBackupId: input.preRestoreBackupId,
            includeProfiles: input.wantProfiles,
        })
        return {
            success: true,
            message: 'Backup restored successfully',
            preRestoreBackupId: input.preRestoreBackupId,
            restartRequired: false,
        }
    }

    private stageRestorePackage(
        backupDir: string,
        stagedDir: string,
        manifest: BackupManifest,
        wantProfiles: boolean,
    ): void {
        removeDirIfExists(stagedDir)
        ensureDir(stagedDir)
        for (const file of manifest.files) {
            if (file.relativePath.startsWith(`${BACKUP_PROFILES_RELATIVE_DIR}/`) && !wantProfiles) {
                continue
            }
            const src = join(backupDir, ...file.relativePath.split('/'))
            const dest = join(stagedDir, ...file.relativePath.split('/'))
            if (!isPathInside(src, backupDir) || !isPathInside(dest, stagedDir)) {
                throw new Error(`Path escape while staging: ${file.relativePath}`)
            }
            copyFileBounded(src, dest)
        }
    }

    private applyStagedToLive(stagedDir: string, wantProfiles: boolean): void {
        const stagedDb = join(stagedDir, ...BACKUP_DB_RELATIVE_PATH.split('/'))
        if (!existsSync(stagedDb)) {
            throw new Error('Staged database missing')
        }
        replaceFileAtomic(stagedDb, this.deps.getDbPath())

        const stagedSettings = join(stagedDir, ...BACKUP_SETTINGS_RELATIVE_PATH.split('/'))
        if (existsSync(stagedSettings)) {
            replaceFileAtomic(stagedSettings, this.deps.getSettingsPath())
        }

        if (wantProfiles) {
            this.applyStagedProfiles(stagedDir)
        }
    }

    private applyStagedProfiles(stagedDir: string): void {
        const stagedProfiles = join(stagedDir, BACKUP_PROFILES_RELATIVE_DIR)
        if (!existsSync(stagedProfiles)) return
        const liveProfiles = this.deps.getProfilesPath()
        // Validate staged tree before touching live profiles root.
        listFilesRecursive(
            stagedProfiles,
            MAX_PROFILE_DEPTH,
            MAX_PROFILE_FILES,
            MAX_PROFILE_TOTAL_BYTES,
        )
        ensureDir(liveProfiles)
        const { files } = listFilesRecursive(
            stagedProfiles,
            MAX_PROFILE_DEPTH,
            MAX_PROFILE_FILES,
            MAX_PROFILE_TOTAL_BYTES,
        )
        for (const srcFile of files) {
            const rel = relative(stagedProfiles, srcFile).split(/[/\\]/).join('/')
            const destFile = join(liveProfiles, ...rel.split('/'))
            if (!isPathInside(destFile, liveProfiles)) {
                throw new Error(`Profile path escape: ${rel}`)
            }
            assertNoSymlinkComponents(destFile, this.deps.getUserDataPath(), 'Profile restore target')
            replaceFileAtomic(srcFile, destFile)
        }
    }

    private assertLiveRestoreTargetsSafe(
        manifest: BackupManifest,
        wantProfiles: boolean,
    ): void {
        const dataRoot = this.deps.getUserDataPath()
        assertNoSymlinkComponents(this.deps.getDbPath(), dataRoot, 'Database restore target')
        assertNoSymlinkComponents(this.deps.getSettingsPath(), dataRoot, 'Settings restore target')
        if (!wantProfiles) return

        const profilesRoot = this.deps.getProfilesPath()
        assertNoSymlinkComponents(profilesRoot, dataRoot, 'Profiles restore root')
        for (const file of manifest.files) {
            if (!file.relativePath.startsWith(`${BACKUP_PROFILES_RELATIVE_DIR}/`)) continue
            const rel = file.relativePath.slice(BACKUP_PROFILES_RELATIVE_DIR.length + 1)
            const target = join(profilesRoot, ...rel.split('/'))
            assertNoSymlinkComponents(target, dataRoot, 'Profile restore target')
        }
    }

    private failRestore(
        message: string,
        preRestoreBackupId?: string,
        restartRequired = false,
    ): RestoreBackupResult {
        this.safeAudit({
            action: 'backup.restore',
            success: false,
            message,
            preRestoreBackupId,
            restartRequired,
        })
        return {
            success: false,
            message,
            preRestoreBackupId,
            ...(restartRequired ? { restartRequired: true } : {}),
        }
    }

    private emptyInspect(backupId: string, validationErrors: string[]): PublicBackupInspect {
        return {
            backupId,
            createdAt: '',
            appVersion: '',
            manifestVersion: 0,
            includeProfiles: false,
            schemaVersion: null,
            totalSizeBytes: 0,
            fileCount: 0,
            files: [],
            valid: false,
            validationErrors,
        }
    }

    private safeAudit(event: BackupAuditEvent): void {
        try {
            this.deps.recordAudit?.(event)
        } catch {
            // audit must never fail the backup path
        }
    }
}

export const backupRestoreService = new BackupRestoreService()
