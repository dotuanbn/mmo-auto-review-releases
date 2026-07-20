/**
 * Backup / restore IPC boundary — Zod schema unit tests.
 * Pure contracts only (no Electron / DB / filesystem).
 */
import { describe, expect, it } from 'vitest'
import {
    BACKUP_ID_MAX,
    BACKUP_LABEL_MAX,
    BACKUP_MANIFEST_VERSION,
    RESTORE_CONFIRM_PHRASE,
    backupCreateArgsSchema,
    backupIdSchema,
    backupInspectArgsSchema,
    backupLabelSchema,
    backupRestoreArgsSchema,
    createBackupOptionsSchema,
    isRestoreConfirmation,
    isSafeBackupId,
    restoreBackupOptionsSchema,
    toPublicBackupSummary,
    type BackupManifest,
} from '../src/shared/backup-contracts'

function expectOk<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    input: unknown,
): T {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
    return result.data as T
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
}

// ---------------------------------------------------------------------------
// backupIdSchema / isSafeBackupId
// ---------------------------------------------------------------------------

describe('backupIdSchema', () => {
    it('accepts safe managed backup basenames', () => {
        expectOk(backupIdSchema, 'backup-2026-07-14T10-00-00-000Z-ab12')
        expectOk(backupIdSchema, 'pre-restore-snap.1')
        expectOk(backupIdSchema, 'A')
        expect(isSafeBackupId('backup-ok-1')).toBe(true)
    })

    it('rejects traversal, separators, empty, and oversized ids', () => {
        for (const bad of [
            '',
            '   ',
            '../evil',
            '..',
            'a/b',
            'a\\b',
            'has space',
            'has:colon',
            null,
            undefined,
            1,
            {},
            'x'.repeat(BACKUP_ID_MAX + 1),
        ]) {
            expectFail(backupIdSchema, bad)
            expect(isSafeBackupId(bad)).toBe(false)
        }
    })
})

// ---------------------------------------------------------------------------
// create / restore option schemas
// ---------------------------------------------------------------------------

describe('createBackupOptionsSchema', () => {
    it('accepts empty object and optional flags', () => {
        expectOk(createBackupOptionsSchema, {})
        const full = expectOk(createBackupOptionsSchema, {
            includeProfiles: true,
            label: 'nightly',
        })
        expect(full.includeProfiles).toBe(true)
        expect(full.label).toBe('nightly')
    })

    it('trims label and rejects unknown keys / oversize label', () => {
        const trimmed = expectOk(createBackupOptionsSchema, { label: '  keep  ' })
        expect(trimmed.label).toBe('keep')
        expectFail(createBackupOptionsSchema, { includeProfiles: 'yes' })
        expectFail(createBackupOptionsSchema, { extra: true })
        expectFail(createBackupOptionsSchema, { label: 'x'.repeat(BACKUP_LABEL_MAX + 1) })
    })
})

describe('RESTORE confirmation', () => {
    it('phrase is exact RESTORE and isRestoreConfirmation is strict', () => {
        expect(RESTORE_CONFIRM_PHRASE).toBe('RESTORE')
        expect(isRestoreConfirmation('RESTORE')).toBe(true)
        expect(isRestoreConfirmation('restore')).toBe(false)
        expect(isRestoreConfirmation('  RESTORE  ')).toBe(false)
        expect(isRestoreConfirmation('YES')).toBe(false)
        expect(isRestoreConfirmation(null)).toBe(false)
        expect(isRestoreConfirmation(undefined)).toBe(false)
    })
})

describe('restoreBackupOptionsSchema', () => {
    it('requires safe backupId, exact confirmation RESTORE, optional includeProfiles', () => {
        const data = expectOk(restoreBackupOptionsSchema, {
            backupId: 'backup-2026-07-14T10-00-00-000Z-ab12',
            confirmation: RESTORE_CONFIRM_PHRASE,
        })
        expect(data.backupId).toContain('backup-')
        expect(data.confirmation).toBe('RESTORE')
        expect(data.includeProfiles).toBeUndefined()

        const withProfiles = expectOk(restoreBackupOptionsSchema, {
            backupId: 'backup-ok',
            includeProfiles: false,
            confirmation: 'RESTORE',
        })
        expect(withProfiles.includeProfiles).toBe(false)
        expect(withProfiles.confirmation).toBe('RESTORE')
    })

    it('rejects missing confirmation, wrong phrase, missing backupId, traversal, unknown keys', () => {
        expectFail(restoreBackupOptionsSchema, {})
        expectFail(restoreBackupOptionsSchema, { backupId: 'ok' })
        expectFail(restoreBackupOptionsSchema, {
            backupId: 'ok',
            confirmation: 'restore',
        })
        expectFail(restoreBackupOptionsSchema, {
            backupId: 'ok',
            confirmation: 'YES',
        })
        expectFail(restoreBackupOptionsSchema, {
            backupId: '../x',
            confirmation: 'RESTORE',
        })
        expectFail(restoreBackupOptionsSchema, {
            backupId: 'ok',
            includeProfiles: true,
            confirmation: 'RESTORE',
            secret: 'nope',
        })
    })
})

describe('tuple arg schemas', () => {
    it('backupCreateArgsSchema allows missing options', () => {
        expectOk(backupCreateArgsSchema, [undefined])
        expectOk(backupCreateArgsSchema, [{}])
        expectOk(backupCreateArgsSchema, [{ includeProfiles: false }])
        expectFail(backupCreateArgsSchema, [{ evil: true }])
    })

    it('backupInspectArgsSchema validates single backupId', () => {
        expectOk(backupInspectArgsSchema, ['backup-ok-1'])
        expectFail(backupInspectArgsSchema, ['../escape'])
        expectFail(backupInspectArgsSchema, [])
        expectFail(backupInspectArgsSchema, [1])
    })

    it('backupRestoreArgsSchema validates canonical options + RESTORE confirmation', () => {
        expectOk(backupRestoreArgsSchema, [
            { backupId: 'backup-1', confirmation: RESTORE_CONFIRM_PHRASE },
        ])
        expectFail(backupRestoreArgsSchema, [{ backupId: 'backup-1' }])
        expectFail(backupRestoreArgsSchema, [
            { backupId: 'a/b', confirmation: RESTORE_CONFIRM_PHRASE },
        ])
        expectFail(backupRestoreArgsSchema, [])
    })
})

describe('backupLabelSchema', () => {
    it('accepts bounded optional labels', () => {
        expectOk(backupLabelSchema, undefined)
        expectOk(backupLabelSchema, 'ok')
        expectFail(backupLabelSchema, '')
        expectFail(backupLabelSchema, 'x'.repeat(BACKUP_LABEL_MAX + 1))
    })
})

// ---------------------------------------------------------------------------
// Public DTO helper — no secrets / contents
// ---------------------------------------------------------------------------

describe('toPublicBackupSummary', () => {
    it('maps manifest metadata without embedding file contents', () => {
        const manifest: BackupManifest = {
            manifestVersion: BACKUP_MANIFEST_VERSION,
            appVersion: '1.0.8',
            createdAt: '2026-07-14T12:00:00.000Z',
            backupId: 'backup-1',
            includeProfiles: false,
            schemaVersion: 3,
            label: 'daily',
            files: [
                {
                    relativePath: 'database/mmo-review.db',
                    sha256: 'a'.repeat(64),
                    sizeBytes: 100,
                },
                {
                    relativePath: 'settings/settings.json',
                    sha256: 'b'.repeat(64),
                    sizeBytes: 50,
                },
            ],
        }
        const summary = toPublicBackupSummary(manifest)
        expect(summary.backupId).toBe('backup-1')
        expect(summary.totalSizeBytes).toBe(150)
        expect(summary.fileCount).toBe(2)
        expect(summary.schemaVersion).toBe(3)
        expect(summary).not.toHaveProperty('password')
        expect(summary).not.toHaveProperty('settings')
        expect(JSON.stringify(summary)).not.toContain('apiKey')
    })
})
