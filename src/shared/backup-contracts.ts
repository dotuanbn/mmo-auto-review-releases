/**
 * Backup / restore contracts — public DTOs never carry secrets or settings contents.
 * Zod schemas validate untrusted renderer payloads at the data:* IPC boundary.
 *
 * Canonical public fields: backupId, totalSizeBytes, includeProfiles, label.
 * Package always includes database + settings; profiles are optional.
 * Restore requires typed confirmation literal RESTORE (schema-enforced).
 */

import { z } from 'zod'
import { boundedString } from './ipc-schemas'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Manifest format version written by BackupRestoreService. */
export const BACKUP_MANIFEST_VERSION = 1

/** Max length for backupId (directory basename under managed-backups). */
export const BACKUP_ID_MAX = 96

/** Max length for optional human label. */
export const BACKUP_LABEL_MAX = 120

/** Safe backup directory name: timestamp-ish + alnum/._- only (no path seps). */
export const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

/**
 * Typed restore confirmation phrase — must match exactly (case-sensitive).
 * Enforced by restoreBackupOptionsSchema and BackupRestoreService.
 */
export const RESTORE_CONFIRM_PHRASE = 'RESTORE' as const

/** Relative paths stored inside a managed backup package. */
export const BACKUP_DB_RELATIVE_PATH = 'database/mmo-review.db'
export const BACKUP_SETTINGS_RELATIVE_PATH = 'settings/settings.json'
export const BACKUP_PROFILES_RELATIVE_DIR = 'profiles'
export const BACKUP_MANIFEST_FILE = 'manifest.json'

// ---------------------------------------------------------------------------
// Domain types (internal + public)
// ---------------------------------------------------------------------------

/** Per-file integrity entry stored in the on-disk manifest. */
export interface BackupFileChecksum {
    relativePath: string
    sha256: string
    sizeBytes: number
}

/**
 * On-disk manifest (written under managed backup dir).
 * Must not embed secret values — only metadata + content hashes.
 */
export interface BackupManifest {
    manifestVersion: number
    appVersion: string
    createdAt: string
    backupId: string
    label?: string
    includeProfiles: boolean
    schemaVersion: number | null
    files: BackupFileChecksum[]
}

/**
 * Public list/summary row — no absolute paths, no file contents.
 * Canonical fields: backupId, totalSizeBytes, includeProfiles, label.
 */
export interface PublicBackupSummary {
    backupId: string
    createdAt: string
    appVersion: string
    manifestVersion: number
    includeProfiles: boolean
    schemaVersion: number | null
    totalSizeBytes: number
    fileCount: number
    label?: string
}

/** Public inspect result — checksum list only, never settings/db body. */
export interface PublicBackupInspect extends PublicBackupSummary {
    files: BackupFileChecksum[]
    valid: boolean
    validationErrors: string[]
}

export interface CreateBackupOptions {
    /** Profiles are optional; database + settings are always included. */
    includeProfiles?: boolean
    label?: string
}

export interface CreateBackupResult {
    success: boolean
    message: string
    backupId?: string
    summary?: PublicBackupSummary
}

export interface RestoreBackupOptions {
    backupId: string
    /** Required literal confirmation — must be exactly RESTORE. */
    confirmation: typeof RESTORE_CONFIRM_PHRASE
    /** When true and backup includes profiles, restore profile tree. Default true if present. */
    includeProfiles?: boolean
}

/**
 * Restore outcome.
 * - restartRequired on failure: restart the app and retry because live DB could not close.
 * - restartRequired on success: files were applied but DB reopen requires an app restart.
 * - stagedRestoreId is reserved for a future persisted restart-time restore workflow.
 */
export interface RestoreBackupResult {
    success: boolean
    message: string
    preRestoreBackupId?: string
    restartRequired?: boolean
    stagedRestoreId?: string
}

// ---------------------------------------------------------------------------
// Zod schemas (IPC boundary)
// ---------------------------------------------------------------------------

export const backupIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(BACKUP_ID_MAX)
    .regex(BACKUP_ID_PATTERN, { message: 'backupId must be a safe directory basename' })

export const backupLabelSchema = boundedString(BACKUP_LABEL_MAX).optional()

export const createBackupOptionsSchema = z
    .object({
        includeProfiles: z.boolean().optional(),
        label: backupLabelSchema,
    })
    .strict()

/** Restore options — confirmation must be the exact literal RESTORE. */
export const restoreBackupOptionsSchema = z
    .object({
        backupId: backupIdSchema,
        confirmation: z.literal(RESTORE_CONFIRM_PHRASE),
        includeProfiles: z.boolean().optional(),
    })
    .strict()

/** data:backupCreate(options?) */
export const backupCreateArgsSchema = z.tuple([createBackupOptionsSchema.optional()])

/** data:backupInspect(backupId) */
export const backupInspectArgsSchema = z.tuple([backupIdSchema])

/** data:backupRestore(options) */
export const backupRestoreArgsSchema = z.tuple([restoreBackupOptionsSchema])

export type BackupId = z.infer<typeof backupIdSchema>
export type CreateBackupOptionsInput = z.infer<typeof createBackupOptionsSchema>
export type RestoreBackupOptionsInput = z.infer<typeof restoreBackupOptionsSchema>

/** True when value is a safe managed-backup directory basename. */
export function isSafeBackupId(value: unknown): value is string {
    return backupIdSchema.safeParse(value).success
}

/** True when confirmation is exactly the required restore phrase. */
export function isRestoreConfirmation(value: unknown): value is typeof RESTORE_CONFIRM_PHRASE {
    return value === RESTORE_CONFIRM_PHRASE
}

/** Build public summary from a parsed manifest + optional size override. */
export function toPublicBackupSummary(
    manifest: BackupManifest,
    totalSizeBytes?: number,
): PublicBackupSummary {
    const computed =
        totalSizeBytes ??
        manifest.files.reduce((sum, file) => sum + Math.max(0, file.sizeBytes), 0)
    return {
        backupId: manifest.backupId,
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        manifestVersion: manifest.manifestVersion,
        includeProfiles: manifest.includeProfiles,
        schemaVersion: manifest.schemaVersion,
        totalSizeBytes: computed,
        fileCount: manifest.files.length,
        label: manifest.label,
    }
}
