/**
 * User-facing Backup / Restore panel for Settings.
 * Canonical public fields: backupId, totalSizeBytes, includeProfiles, label.
 * Database + settings always included; profiles optional. Restore requires RESTORE.
 * Public DTO only — no secrets displayed. Does not edit IPC/preload/i18n.
 */
import { useCallback, useEffect, useState } from 'react'
import {
    Archive,
    CheckCircle,
    Database,
    FolderOpen,
    HardDrive,
    Info,
    Loader2,
    RefreshCw,
    RotateCcw,
    Settings2,
    ShieldAlert,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
    AlertBanner,
    Badge,
    EmptyState,
    IconButton,
    Panel,
    PrimaryButton,
    SectionPanel,
    TextInput,
} from '../ui/surface'

// ── Public contracts (aligned with src/shared/backup-contracts) ─────────────

export type BackupIncludeKey = 'database' | 'settings' | 'profiles'

export const BACKUP_INCLUDE_OPTIONS: readonly BackupIncludeKey[] = [
    'database',
    'settings',
    'profiles',
] as const

/** Include keys that cannot be turned off in the UI (always packaged). */
export const BACKUP_MANDATORY_INCLUDES: readonly BackupIncludeKey[] = [
    'database',
    'settings',
] as const

/** Typed confirmation required before restore (exact literal). */
export const RESTORE_CONFIRM_PHRASE = 'RESTORE'

/** Canonical public list keys — must match PublicBackupSummary. */
export const BACKUP_PUBLIC_LIST_KEYS = [
    'backupId',
    'createdAt',
    'appVersion',
    'manifestVersion',
    'includeProfiles',
    'schemaVersion',
    'totalSizeBytes',
    'fileCount',
    'label',
] as const

export const BACKUP_FORBIDDEN_KEYS = [
    'apiKey',
    'api_key',
    'token',
    'secret',
    'password',
    'authorization',
    'bearer',
    'cookie',
    'cookies',
    'privateKey',
] as const

export type BackupLoadState = 'loading' | 'ready' | 'error' | 'empty'

/** Canonical public list row (matches PublicBackupSummary). */
export interface BackupListItem {
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

/** Canonical public inspect row (matches PublicBackupInspect). */
export interface BackupInspectResult extends BackupListItem {
    files: Array<{ relativePath: string; sha256: string; sizeBytes: number }>
    valid: boolean
    validationErrors: string[]
}

/** Create options — only profiles optional; DB+settings always on in service. */
export interface CreateBackupOptions {
    includeProfiles?: boolean
    label?: string
}

export interface CreateBackupResult {
    success: boolean
    message: string
    backupId?: string
    summary?: BackupListItem
}

/** Restore options — confirmation must be exact RESTORE. */
export interface RestoreBackupOptions {
    backupId: string
    confirmation: typeof RESTORE_CONFIRM_PHRASE
    includeProfiles?: boolean
}

export interface RestoreBackupResult {
    success: boolean
    message: string
    preRestoreBackupId?: string
    restartRequired?: boolean
    stagedRestoreId?: string
}

export interface DataBackupApi {
    createBackup: (opts?: CreateBackupOptions) => Promise<CreateBackupResult>
    listBackups: () => Promise<BackupListItem[]>
    inspectBackup: (backupId: string) => Promise<BackupInspectResult>
    restoreBackup: (opts: RestoreBackupOptions) => Promise<RestoreBackupResult>
}

type Translate = (key: string, fallback?: string) => string

// ── Pure helpers (tested) ───────────────────────────────────────────────────

export function isMandatoryInclude(key: BackupIncludeKey): boolean {
    return key === 'database' || key === 'settings'
}

export function defaultIncludeSelection(): Record<BackupIncludeKey, boolean> {
    return { database: true, settings: true, profiles: false }
}

export function selectedIncludes(
    flags: Record<BackupIncludeKey, boolean>,
): BackupIncludeKey[] {
    return BACKUP_INCLUDE_OPTIONS.filter((k) => flags[k])
}

/** Create allowed when not busy and mandatory includes remain enabled. */
export function canCreateBackup(
    flags: Record<BackupIncludeKey, boolean>,
    busy: boolean,
): boolean {
    return !busy && flags.database === true && flags.settings === true
}

/**
 * Confirm restore when idle, selection present, and typed phrase matches
 * (case-insensitive for UX; API always sends exact RESTORE).
 */
export function canConfirmRestore(
    typed: string,
    busy: boolean,
    selectedId: string | null,
): boolean {
    return (
        !busy &&
        !!selectedId &&
        typed.trim().toUpperCase() === RESTORE_CONFIRM_PHRASE
    )
}

export function resolveBackupListState(
    items: BackupListItem[] | null,
    error: string | null,
): BackupLoadState {
    if (error && !items) return 'error'
    if (!items) return 'loading'
    if (items.length === 0) return 'empty'
    return 'ready'
}

export function formatBackupBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    if (bytes < 1024) return `${Math.round(bytes)} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatBackupDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso || '—'
    return d.toLocaleString()
}

/** Display badges derived from includeProfiles (DB+settings always present). */
export function includesFromItem(item: Pick<BackupListItem, 'includeProfiles'>): BackupIncludeKey[] {
    const keys: BackupIncludeKey[] = ['database', 'settings']
    if (item.includeProfiles) keys.push('profiles')
    return keys
}

/** True when JSON of public DTO has no secret field names. */
export function backupDtoHasNoSecrets(value: unknown): boolean {
    const json = JSON.stringify(value ?? null).toLowerCase()
    for (const key of BACKUP_FORBIDDEN_KEYS) {
        if (json.includes(`"${key.toLowerCase()}"`)) return false
    }
    return true
}

export function normalizeListItems(raw: unknown): BackupListItem[] {
    if (!Array.isArray(raw)) return []
    return raw.filter(isBackupListItem)
}

function isBackupListItem(v: unknown): v is BackupListItem {
    if (!v || typeof v !== 'object') return false
    const o = v as Record<string, unknown>
    return (
        typeof o.backupId === 'string' &&
        typeof o.createdAt === 'string' &&
        typeof o.totalSizeBytes === 'number' &&
        typeof o.includeProfiles === 'boolean'
    )
}

function isInspectResult(v: unknown): v is BackupInspectResult {
    if (!isBackupListItem(v)) return false
    const o = v as unknown as Record<string, unknown>
    return typeof o.valid === 'boolean' && Array.isArray(o.validationErrors)
}

// ── API bridge ──────────────────────────────────────────────────────────────

function getBackupApi(): DataBackupApi | null {
    const data = window.electronAPI?.data as
        | (Partial<DataBackupApi> & Record<string, unknown>)
        | undefined
    if (
        !data?.createBackup ||
        !data?.listBackups ||
        !data?.inspectBackup ||
        !data?.restoreBackup
    ) {
        return null
    }
    return data as DataBackupApi
}

// ── Hook ────────────────────────────────────────────────────────────────────

function useBackupRestore(t: Translate) {
    const [items, setItems] = useState<BackupListItem[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [includeFlags, setIncludeFlags] = useState(defaultIncludeSelection)
    const [label, setLabel] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [inspect, setInspect] = useState<BackupInspectResult | null>(null)
    const [confirmText, setConfirmText] = useState('')
    const [showRestore, setShowRestore] = useState(false)
    const [statusMsg, setStatusMsg] = useState<string | null>(null)
    const [restartRequired, setRestartRequired] = useState(false)

    const load = useCallback(async () => {
        const api = getBackupApi()
        if (!api) {
            setError(t('settings.backupUnavailable', 'Backup API is unavailable'))
            setItems(null)
            return
        }
        setBusy(true)
        setError(null)
        try {
            const list = normalizeListItems(await api.listBackups())
            setItems(list)
            setStatusMsg(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg || t('settings.backupLoadError', 'Could not load backups'))
            setItems(null)
        } finally {
            setBusy(false)
        }
    }, [t])

    const handleCreate = useCallback(async () => {
        const api = getBackupApi()
        if (!api || !canCreateBackup(includeFlags, busy)) return
        setBusy(true)
        setError(null)
        setStatusMsg(null)
        try {
            const result = await api.createBackup({
                includeProfiles: includeFlags.profiles === true,
                label: label.trim() || undefined,
            })
            if (!result?.success) {
                setError(result?.message || t('settings.backupCreateFailed', 'Backup failed'))
                return
            }
            setStatusMsg(t('settings.backupCreateSuccess', 'Backup created successfully'))
            setLabel('')
            const list = normalizeListItems(await api.listBackups())
            setItems(list)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg || t('settings.backupCreateFailed', 'Backup failed'))
        } finally {
            setBusy(false)
        }
    }, [busy, includeFlags, label, t])

    const handleInspect = useCallback(
        async (backupId: string) => {
            const api = getBackupApi()
            if (!api || busy) return
            setBusy(true)
            setError(null)
            setSelectedId(backupId)
            setInspect(null)
            setShowRestore(false)
            setConfirmText('')
            try {
                const detail = await api.inspectBackup(backupId)
                setInspect(isInspectResult(detail) ? detail : null)
                if (!isInspectResult(detail)) {
                    setError(t('settings.backupInspectFailed', 'Could not inspect backup'))
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                setError(msg || t('settings.backupInspectFailed', 'Could not inspect backup'))
            } finally {
                setBusy(false)
            }
        },
        [busy, t],
    )

    const handleRestore = useCallback(async () => {
        const api = getBackupApi()
        if (!api || !canConfirmRestore(confirmText, busy, selectedId)) return
        setBusy(true)
        setError(null)
        setStatusMsg(null)
        try {
            // Always send exact RESTORE literal required by restore schema.
            const result = await api.restoreBackup({
                backupId: selectedId as string,
                confirmation: RESTORE_CONFIRM_PHRASE,
                includeProfiles: inspect?.includeProfiles === true,
            })
            if (!result?.success) {
                setError(result?.message || t('settings.backupRestoreFailed', 'Restore failed'))
                return
            }
            setRestartRequired(!!result.restartRequired)
            setStatusMsg(
                result.message ||
                    t('settings.backupRestoreSuccess', 'Restore completed successfully'),
            )
            setShowRestore(false)
            setConfirmText('')
            const list = normalizeListItems(await api.listBackups())
            setItems(list)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg || t('settings.backupRestoreFailed', 'Restore failed'))
        } finally {
            setBusy(false)
        }
    }, [busy, confirmText, inspect, selectedId, t])

    useEffect(() => {
        void load()
    }, [load])

    return {
        items,
        error,
        busy,
        includeFlags,
        setIncludeFlags,
        label,
        setLabel,
        selectedId,
        inspect,
        confirmText,
        setConfirmText,
        showRestore,
        setShowRestore,
        statusMsg,
        restartRequired,
        load,
        handleCreate,
        handleInspect,
        handleRestore,
        state: resolveBackupListState(items, error),
    }
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function IncludeOptionRow({
    keyName,
    checked,
    disabled,
    locked,
    label,
    description,
    icon: Icon,
    onToggle,
}: {
    keyName: BackupIncludeKey
    checked: boolean
    disabled: boolean
    locked: boolean
    label: string
    description: string
    icon: typeof Database
    onToggle: (k: BackupIncludeKey) => void
}) {
    return (
        <label
            className={`flex items-start gap-3 rounded-[14px] border px-3 py-2.5 transition-colors ${
                locked ? 'cursor-default' : 'cursor-pointer'
            } ${
                checked
                    ? 'border-[#d4c8f8] dark:border-[#735bd6] bg-[#f7f4ff] dark:bg-[#2a2540]'
                    : 'border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] hover:bg-[#faf8ff] dark:hover:bg-[#352f4a]'
            } ${disabled && !locked ? 'pointer-events-none opacity-50' : ''} ${
                locked ? 'opacity-90' : ''
            }`}
        >
            <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#8d74e8]"
                checked={checked}
                disabled={disabled || locked}
                onChange={() => {
                    if (!locked) onToggle(keyName)
                }}
                title={
                    locked
                        ? 'Always included in every backup'
                        : undefined
                }
            />
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#735bd6]" />
            <div className="min-w-0">
                <div className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                    {label}
                    {locked ? (
                        <span className="ml-1 text-[10px] font-medium uppercase text-[#8e899b] dark:text-[#9a8fba]">
                            required
                        </span>
                    ) : null}
                </div>
                <div className="text-xs text-[#8e899b] dark:text-[#9a8fba]">{description}</div>
            </div>
        </label>
    )
}

function CreateSection({
    t,
    busy,
    flags,
    label,
    onLabel,
    onToggle,
    onCreate,
}: {
    t: Translate
    busy: boolean
    flags: Record<BackupIncludeKey, boolean>
    label: string
    onLabel: (v: string) => void
    onToggle: (k: BackupIncludeKey) => void
    onCreate: () => void
}) {
    const labels: Record<BackupIncludeKey, { label: string; desc: string; icon: typeof Database }> = {
        database: {
            label: t('settings.backupOptDatabase', 'Database'),
            desc: t('settings.backupOptDatabaseDesc', 'Accounts, campaigns, history, queues'),
            icon: Database,
        },
        settings: {
            label: t('settings.backupOptSettings', 'Settings'),
            desc: t('settings.backupOptSettingsDesc', 'App preferences (secrets stay encrypted)'),
            icon: Settings2,
        },
        profiles: {
            label: t('settings.backupOptProfiles', 'Browser profiles'),
            desc: t('settings.backupOptProfilesDesc', 'Profile folders (may be large)'),
            icon: FolderOpen,
        },
    }

    return (
        <Panel tone="slate" className="!p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#6f697c] dark:text-[#c8c0d8]">
                {t('settings.backupCreate', 'Create backup')}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
                {BACKUP_INCLUDE_OPTIONS.map((k) => (
                    <IncludeOptionRow
                        key={k}
                        keyName={k}
                        checked={flags[k]}
                        disabled={busy}
                        locked={isMandatoryInclude(k)}
                        label={labels[k].label}
                        description={labels[k].desc}
                        icon={labels[k].icon}
                        onToggle={onToggle}
                    />
                ))}
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <TextInput
                    value={label}
                    onChange={onLabel}
                    placeholder={t('settings.backupNotePlaceholder', 'Optional note')}
                    className="flex-1"
                    disabled={busy}
                />
                <PrimaryButton
                    icon={busy ? Loader2 : Archive}
                    onClick={onCreate}
                    disabled={!canCreateBackup(flags, busy)}
                    className={busy ? '[&_svg]:animate-spin' : undefined}
                >
                    {t('settings.backupCreateBtn', 'Create backup')}
                </PrimaryButton>
            </div>
        </Panel>
    )
}

function BackupListSection({
    t,
    state,
    items,
    busy,
    selectedId,
    onRefresh,
    onSelect,
}: {
    t: Translate
    state: BackupLoadState
    items: BackupListItem[] | null
    busy: boolean
    selectedId: string | null
    onRefresh: () => void
    onSelect: (backupId: string) => void
}) {
    if (state === 'loading' || (busy && !items)) {
        return (
            <Panel tone="slate" className="flex items-center justify-center gap-2 !p-8 text-sm text-[#6f697c] dark:text-[#c8c0d8]">
                <Loader2 className="h-5 w-5 animate-spin text-[#8d74e8]" />
                {t('settings.backupLoading', 'Loading backups…')}
            </Panel>
        )
    }
    if (state === 'error' && !items) {
        return (
            <EmptyState
                icon={ShieldAlert}
                title={t('settings.backupLoadError', 'Could not load backups')}
                subtitle={t('settings.backupLoadErrorHint', 'Try refresh or check that the data API is available')}
                action={
                    <PrimaryButton variant="quiet" icon={RefreshCw} onClick={onRefresh} disabled={busy}>
                        {t('common.refresh', 'Refresh')}
                    </PrimaryButton>
                }
            />
        )
    }
    if (state === 'empty') {
        return (
            <EmptyState
                icon={HardDrive}
                title={t('settings.backupEmpty', 'No backups yet')}
                subtitle={t('settings.backupEmptyHint', 'Create a backup to protect your local data')}
                action={
                    <PrimaryButton variant="quiet" icon={RefreshCw} onClick={onRefresh} disabled={busy}>
                        {t('common.refresh', 'Refresh')}
                    </PrimaryButton>
                }
            />
        )
    }
    if (!items) return null

    return (
        <Panel tone="slate" className="!p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-[#6f697c] dark:text-[#c8c0d8]">
                    {t('settings.backupList', 'Available backups')}
                </div>
                <IconButton
                    icon={busy ? Loader2 : RefreshCw}
                    label={t('common.refresh', 'Refresh')}
                    onClick={onRefresh}
                    disabled={busy}
                    className={busy ? '[&_svg]:animate-spin' : undefined}
                />
            </div>
            <ul className="max-h-72 space-y-2 overflow-y-auto">
                {items.map((item) => (
                    <li key={item.backupId}>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => onSelect(item.backupId)}
                            className={`flex w-full flex-col gap-1 rounded-[14px] border px-3 py-2.5 text-left transition-colors sm:flex-row sm:items-center sm:justify-between ${
                                selectedId === item.backupId
                                    ? 'border-[#8d74e8] dark:border-[#735bd6] bg-[#f4f0ff] dark:bg-[#2a2540]'
                                    : 'border-[#e9e4f2] dark:border-[#3d3558] bg-white/70 dark:bg-[#1e1b2e] hover:bg-[#faf8ff] dark:hover:bg-[#352f4a]'
                            } disabled:opacity-50`}
                        >
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]" title={item.backupId}>
                                    {item.backupId}
                                </div>
                                <div className="text-[11px] text-[#908a9e] dark:text-[#9a8fba]">
                                    {formatBackupDate(item.createdAt)}
                                    {item.label ? ` · ${item.label}` : ''}
                                </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                {includesFromItem(item).map((inc) => (
                                    <Badge key={inc} tone="violet">
                                        {inc}
                                    </Badge>
                                ))}
                                <span className="text-[11px] font-medium text-[#5f5a6d] dark:text-[#c8c0d8]">
                                    {formatBackupBytes(item.totalSizeBytes)}
                                </span>
                            </div>
                        </button>
                    </li>
                ))}
            </ul>
        </Panel>
    )
}

function InspectRestoreSection({
    t,
    busy,
    inspect,
    showRestore,
    confirmText,
    selectedId,
    onShowRestore,
    onConfirmText,
    onRestore,
    onCancelRestore,
}: {
    t: Translate
    busy: boolean
    inspect: BackupInspectResult | null
    showRestore: boolean
    confirmText: string
    selectedId: string | null
    onShowRestore: () => void
    onConfirmText: (v: string) => void
    onRestore: () => void
    onCancelRestore: () => void
}) {
    if (!inspect) {
        if (!selectedId || !busy) return null
        return (
            <Panel tone="slate" className="flex items-center gap-2 !p-4 text-sm text-[#6f697c] dark:text-[#c8c0d8]">
                <Loader2 className="h-4 w-4 animate-spin text-[#8d74e8]" />
                {t('settings.backupInspecting', 'Inspecting backup…')}
            </Panel>
        )
    }

    return (
        <Panel tone="slate" className="!p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-[#6f697c] dark:text-[#c8c0d8]">
                    {t('settings.backupInspect', 'Backup details')}
                </div>
                <Badge tone={inspect.valid ? 'emerald' : 'rose'}>
                    {inspect.valid
                        ? t('settings.backupValid', 'Valid')
                        : t('settings.backupInvalid', 'Invalid')}
                </Badge>
            </div>
            <div className="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                    <span className="text-[#908a9e] dark:text-[#9a8fba]">{t('settings.backupFileName', 'File')}: </span>
                    <span className="font-medium text-[#24222c] dark:text-[#f0ecff] break-all">{inspect.backupId}</span>
                </div>
                <div>
                    <span className="text-[#908a9e] dark:text-[#9a8fba]">{t('settings.backupSize', 'Size')}: </span>
                    <span className="font-medium">{formatBackupBytes(inspect.totalSizeBytes)}</span>
                </div>
                <div>
                    <span className="text-[#908a9e] dark:text-[#9a8fba]">{t('settings.backupCreatedAt', 'Created')}: </span>
                    <span className="font-medium">{formatBackupDate(inspect.createdAt)}</span>
                </div>
                {inspect.appVersion && (
                    <div>
                        <span className="text-[#908a9e] dark:text-[#9a8fba]">{t('settings.version', 'Version')}: </span>
                        <span className="font-medium">{inspect.appVersion}</span>
                    </div>
                )}
                {inspect.label && (
                    <div>
                        <span className="text-[#908a9e] dark:text-[#9a8fba]">Label: </span>
                        <span className="font-medium">{inspect.label}</span>
                    </div>
                )}
            </div>
            {inspect.validationErrors && inspect.validationErrors.length > 0 && (
                <AlertBanner type="warning" title={t('settings.backupWarnings', 'Warnings')}>
                    <ul className="list-disc pl-4 text-xs">
                        {inspect.validationErrors.map((w, i) => (
                            <li key={i}>{w}</li>
                        ))}
                    </ul>
                </AlertBanner>
            )}
            {!showRestore ? (
                <PrimaryButton
                    tone="rose"
                    variant="quiet"
                    icon={RotateCcw}
                    onClick={onShowRestore}
                    disabled={busy || !inspect.valid}
                    className="!px-3 !py-1.5 !text-xs"
                >
                    {t('settings.backupRestoreBtn', 'Restore this backup')}
                </PrimaryButton>
            ) : (
                <AlertBanner type="warning" title={t('settings.backupRestoreConfirmTitle', 'Confirm restore')}>
                    <p className="mb-2 text-sm">
                        {t(
                            'settings.backupRestoreConfirmHint',
                            'This overwrites selected local data. Type {phrase} to confirm.',
                        ).replace('{phrase}', RESTORE_CONFIRM_PHRASE)}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <TextInput
                            value={confirmText}
                            onChange={onConfirmText}
                            placeholder={RESTORE_CONFIRM_PHRASE}
                            className="flex-1 font-mono uppercase"
                            disabled={busy}
                        />
                        <div className="flex flex-wrap gap-2">
                            <PrimaryButton
                                tone="rose"
                                onClick={onRestore}
                                disabled={!canConfirmRestore(confirmText, busy, selectedId)}
                                className="!px-3 !py-1.5 !text-xs"
                                icon={busy ? Loader2 : RotateCcw}
                            >
                                {t('settings.backupRestoreConfirmBtn', 'Confirm restore')}
                            </PrimaryButton>
                            <PrimaryButton
                                variant="quiet"
                                onClick={onCancelRestore}
                                disabled={busy}
                                className="!px-3 !py-1.5 !text-xs"
                            >
                                {t('common.cancel', 'Cancel')}
                            </PrimaryButton>
                        </div>
                    </div>
                </AlertBanner>
            )}
        </Panel>
    )
}

// ── Main panel ──────────────────────────────────────────────────────────────

/**
 * Backup & Restore dashboard for Settings.
 * Progress-safe: all mutating actions disable while busy.
 * UI never allows turning off database/settings includes.
 */
export function BackupRestorePanel() {
    const { t } = useTranslation()
    const m = useBackupRestore(t)

    const toggleInclude = useCallback(
        (k: BackupIncludeKey) => {
            // database + settings are mandatory — UI cannot disable them
            if (isMandatoryInclude(k)) return
            m.setIncludeFlags((prev) => ({
                ...prev,
                database: true,
                settings: true,
                [k]: !prev[k],
            }))
        },
        [m.setIncludeFlags],
    )

    return (
        <SectionPanel
            icon={HardDrive}
            title={t('settings.backupRestore', 'Backup & Restore')}
            tone="emerald"
        >
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-[#6f697c] dark:text-[#c8c0d8]">
                    {t(
                        'settings.backupRestoreDesc',
                        'Create local backups of database, settings, and profiles. Restore requires typed confirmation. Secrets are never shown in this UI.',
                    )}
                </p>
                <IconButton
                    icon={m.busy ? Loader2 : RefreshCw}
                    label={t('common.refresh', 'Refresh')}
                    onClick={() => {
                        void m.load()
                    }}
                    disabled={m.busy}
                    className={m.busy ? '[&_svg]:animate-spin' : undefined}
                />
            </div>

            {m.restartRequired && (
                <div className="mb-3">
                    <AlertBanner
                        type="warning"
                        title={t('settings.backupRestartRequired', 'Restart required')}
                    >
                        {t(
                            'settings.backupRestartRequiredDesc',
                            'Restore finished. Restart the app to load restored data safely.',
                        )}
                    </AlertBanner>
                </div>
            )}

            {m.statusMsg && (
                <div className="mb-3">
                    <AlertBanner type="success">
                        <span className="inline-flex items-center gap-1.5">
                            <CheckCircle className="h-4 w-4" />
                            {m.statusMsg}
                        </span>
                    </AlertBanner>
                </div>
            )}

            {m.error && (
                <div className="mb-3">
                    <AlertBanner type="error" title={t('common.error', 'Error')}>
                        {m.error}
                    </AlertBanner>
                </div>
            )}

            <div className="space-y-3">
                <CreateSection
                    t={t}
                    busy={m.busy}
                    flags={m.includeFlags}
                    label={m.label}
                    onLabel={m.setLabel}
                    onToggle={toggleInclude}
                    onCreate={() => {
                        void m.handleCreate()
                    }}
                />

                <BackupListSection
                    t={t}
                    state={m.state}
                    items={m.items}
                    busy={m.busy}
                    selectedId={m.selectedId}
                    onRefresh={() => {
                        void m.load()
                    }}
                    onSelect={(backupId) => {
                        void m.handleInspect(backupId)
                    }}
                />

                <InspectRestoreSection
                    t={t}
                    busy={m.busy}
                    inspect={m.inspect}
                    showRestore={m.showRestore}
                    confirmText={m.confirmText}
                    selectedId={m.selectedId}
                    onShowRestore={() => m.setShowRestore(true)}
                    onConfirmText={m.setConfirmText}
                    onRestore={() => {
                        void m.handleRestore()
                    }}
                    onCancelRestore={() => {
                        m.setShowRestore(false)
                        m.setConfirmText('')
                    }}
                />

                <div className="flex items-start gap-2 text-[11px] text-[#908a9e] dark:text-[#9a8fba]">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                        {t(
                            'settings.backupPrivacyNote',
                            'This panel only shows public backup metadata. API keys, passwords, and tokens are never displayed.',
                        )}
                    </span>
                </div>
            </div>
        </SectionPanel>
    )
}
