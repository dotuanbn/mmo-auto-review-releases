/**
 * Backup / Restore + Compliance audit panel contracts — public DTO shape + pure helpers.
 * Ensures Settings panels never depend on secret-bearing fields.
 * Canonical: backupId, totalSizeBytes, includeProfiles, label.
 */
import { describe, expect, it } from 'vitest'
import {
    BACKUP_FORBIDDEN_KEYS,
    BACKUP_INCLUDE_OPTIONS,
    BACKUP_MANDATORY_INCLUDES,
    BACKUP_PUBLIC_LIST_KEYS,
    RESTORE_CONFIRM_PHRASE,
    backupDtoHasNoSecrets,
    canConfirmRestore,
    canCreateBackup,
    defaultIncludeSelection,
    formatBackupBytes,
    includesFromItem,
    isMandatoryInclude,
    normalizeListItems,
    resolveBackupListState,
    selectedIncludes,
    type BackupListItem,
} from '../src/renderer/src/components/backup/BackupRestorePanel'
import {
    COMPLIANCE_AUDIT_PAGE_SIZE,
    COMPLIANCE_AUDIT_PUBLIC_KEYS,
    auditDtoHasNoSecrets,
    emptyComplianceAuditPage,
    normalizeAuditPage,
    outcomeTone,
    resolveAuditState,
    totalAuditPages,
    type ComplianceAuditEntry,
} from '../src/renderer/src/components/backup/ComplianceAuditPanel'
import {
    RESTORE_CONFIRM_PHRASE as SHARED_RESTORE_PHRASE,
    restoreBackupOptionsSchema,
} from '../src/shared/backup-contracts'

function sampleBackup(over: Partial<BackupListItem> = {}): BackupListItem {
    return {
        backupId: 'backup-2026-07-14T10-00-00-000Z-abcd',
        createdAt: '2026-07-14T10:00:00.000Z',
        appVersion: '1.0.8',
        manifestVersion: 1,
        includeProfiles: false,
        schemaVersion: 3,
        totalSizeBytes: 2048,
        fileCount: 2,
        label: 'nightly',
        ...over,
    }
}

function sampleAudit(over: Partial<ComplianceAuditEntry> = {}): ComplianceAuditEntry {
    return {
        id: 1,
        createdAt: '2026-07-14T11:00:00.000Z',
        action: 'approve',
        actor: 'operator',
        targetType: 'review_submission',
        targetId: 'req-1',
        outcome: 'success',
        summary: 'Approved manual submit',
        ...over,
    }
}

describe('Backup public contract', () => {
    it('include options are database / settings / profiles', () => {
        expect([...BACKUP_INCLUDE_OPTIONS]).toEqual(['database', 'settings', 'profiles'])
        expect([...BACKUP_MANDATORY_INCLUDES]).toEqual(['database', 'settings'])
        expect(isMandatoryInclude('database')).toBe(true)
        expect(isMandatoryInclude('settings')).toBe(true)
        expect(isMandatoryInclude('profiles')).toBe(false)
    })

    it('restore confirmation phrase is RESTORE (UI + shared schema)', () => {
        expect(RESTORE_CONFIRM_PHRASE).toBe('RESTORE')
        expect(SHARED_RESTORE_PHRASE).toBe('RESTORE')
        expect(
            restoreBackupOptionsSchema.safeParse({
                backupId: 'backup-ok-1',
                confirmation: 'RESTORE',
            }).success,
        ).toBe(true)
        expect(
            restoreBackupOptionsSchema.safeParse({
                backupId: 'backup-ok-1',
                confirmation: 'restore',
            }).success,
        ).toBe(false)
        expect(
            restoreBackupOptionsSchema.safeParse({
                backupId: 'backup-ok-1',
            }).success,
        ).toBe(false)
    })

    it('list item sample only uses canonical public keys', () => {
        const item = sampleBackup()
        const keys = Object.keys(item).sort()
        for (const k of keys) {
            expect(BACKUP_PUBLIC_LIST_KEYS).toContain(k)
        }
        for (const forbidden of BACKUP_FORBIDDEN_KEYS) {
            expect(keys).not.toContain(forbidden)
        }
        expect(keys).toContain('backupId')
        expect(keys).toContain('totalSizeBytes')
        expect(keys).toContain('includeProfiles')
        expect(keys).toContain('label')
        expect(backupDtoHasNoSecrets(item)).toBe(true)
    })

    it('rejects DTO JSON that embeds secret field names', () => {
        expect(backupDtoHasNoSecrets({ backupId: 'x', apiKey: 'secret' })).toBe(false)
        expect(backupDtoHasNoSecrets({ backupId: 'x', password: 'x' })).toBe(false)
        expect(backupDtoHasNoSecrets({ backupId: 'x', token: 't' })).toBe(false)
    })
})

describe('Backup pure helpers', () => {
    it('default include selection enables database+settings only; UI cannot create without them', () => {
        const flags = defaultIncludeSelection()
        expect(selectedIncludes(flags)).toEqual(['database', 'settings'])
        expect(canCreateBackup(flags, false)).toBe(true)
        expect(canCreateBackup(flags, true)).toBe(false)
        expect(canCreateBackup({ database: false, settings: true, profiles: false }, false)).toBe(
            false,
        )
        expect(canCreateBackup({ database: true, settings: false, profiles: true }, false)).toBe(
            false,
        )
    })

    it('includesFromItem always reports database+settings; profiles when flagged', () => {
        expect(includesFromItem({ includeProfiles: false })).toEqual(['database', 'settings'])
        expect(includesFromItem({ includeProfiles: true })).toEqual([
            'database',
            'settings',
            'profiles',
        ])
    })

    it('canConfirmRestore requires phrase, selection, and idle state', () => {
        expect(canConfirmRestore('RESTORE', false, 'bk-1')).toBe(true)
        expect(canConfirmRestore('restore', false, 'bk-1')).toBe(true)
        expect(canConfirmRestore('RESTO', false, 'bk-1')).toBe(false)
        expect(canConfirmRestore('RESTORE', true, 'bk-1')).toBe(false)
        expect(canConfirmRestore('RESTORE', false, null)).toBe(false)
    })

    it('resolveBackupListState covers loading / error / empty / ready', () => {
        expect(resolveBackupListState(null, null)).toBe('loading')
        expect(resolveBackupListState(null, 'boom')).toBe('error')
        expect(resolveBackupListState([], null)).toBe('empty')
        expect(resolveBackupListState([sampleBackup()], null)).toBe('ready')
        expect(resolveBackupListState([sampleBackup()], 'soft')).toBe('ready')
    })

    it('formatBackupBytes is safe for edge values', () => {
        expect(formatBackupBytes(0)).toBe('0 B')
        expect(formatBackupBytes(500)).toBe('500 B')
        expect(formatBackupBytes(2048)).toBe('2.0 KB')
        expect(formatBackupBytes(Number.NaN)).toBe('0 B')
        expect(formatBackupBytes(-1)).toBe('0 B')
    })

    it('normalizeListItems filters invalid rows and requires canonical fields', () => {
        const rows = normalizeListItems([
            sampleBackup(),
            { id: 'legacy', createdAt: 'x' },
            { backupId: 1 },
            null,
            sampleBackup({ backupId: 'backup-2', label: 'b' }),
        ])
        expect(rows).toHaveLength(2)
        expect(rows[0].backupId).toBe('backup-2026-07-14T10-00-00-000Z-abcd')
        expect(rows[0].totalSizeBytes).toBe(2048)
        expect(rows[1].backupId).toBe('backup-2')
        expect(rows[1].label).toBe('b')
    })
})

describe('Compliance audit public contract', () => {
    it('page size is finite and positive', () => {
        expect(COMPLIANCE_AUDIT_PAGE_SIZE).toBeGreaterThan(0)
        expect(COMPLIANCE_AUDIT_PAGE_SIZE).toBeLessThanOrEqual(100)
    })

    it('audit entry only exposes public keys', () => {
        const entry = sampleAudit()
        const keys = Object.keys(entry).sort()
        expect(keys).toEqual([...COMPLIANCE_AUDIT_PUBLIC_KEYS].sort())
        for (const forbidden of BACKUP_FORBIDDEN_KEYS) {
            expect(keys).not.toContain(forbidden)
        }
        expect(auditDtoHasNoSecrets(entry)).toBe(true)
    })

    it('empty page has zero items and total', () => {
        const empty = emptyComplianceAuditPage(2, 10)
        expect(empty.items).toEqual([])
        expect(empty.total).toBe(0)
        expect(empty.page).toBe(2)
        expect(empty.pageSize).toBe(10)
    })
})

describe('Compliance audit pure helpers', () => {
    it('resolveAuditState covers loading / error / empty / ready', () => {
        expect(resolveAuditState(null, null)).toBe('loading')
        expect(resolveAuditState(null, 'boom')).toBe('error')
        expect(resolveAuditState(emptyComplianceAuditPage(), null)).toBe('empty')
        expect(
            resolveAuditState(
                { items: [sampleAudit()], total: 1, page: 1, pageSize: 10 },
                null,
            ),
        ).toBe('ready')
    })

    it('totalAuditPages clamps and ceilings correctly', () => {
        expect(totalAuditPages(0, 10)).toBe(1)
        expect(totalAuditPages(10, 10)).toBe(1)
        expect(totalAuditPages(11, 10)).toBe(2)
        expect(totalAuditPages(25, 10)).toBe(3)
        expect(totalAuditPages(5, 0)).toBe(1)
    })

    it('outcomeTone maps known outcomes', () => {
        expect(outcomeTone('success')).toBe('emerald')
        expect(outcomeTone('failure')).toBe('rose')
        expect(outcomeTone('pending')).toBe('amber')
        expect(outcomeTone('info')).toBe('violet')
        expect(outcomeTone('other')).toBe('slate')
    })

    it('normalizeAuditPage coerces raw payloads', () => {
        const page = normalizeAuditPage({
            items: [sampleAudit(), { bad: true }, sampleAudit({ id: 2 })],
            total: 2,
            page: 1,
            pageSize: 10,
        })
        expect(page.items).toHaveLength(2)
        expect(page.total).toBe(2)
        expect(auditDtoHasNoSecrets(page)).toBe(true)
    })
})
