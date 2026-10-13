/**
 * Compliance audit history panel for Settings.
 * Uses expected window.electronAPI.data.getComplianceAudit.
 * Public DTO only — no secrets, tokens, or credentials.
 */
import { useCallback, useEffect, useState } from 'react'
import {
    ClipboardList,
    Filter,
    Loader2,
    RefreshCw,
    ShieldAlert,
    ShieldCheck,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
    AlertBanner,
    Badge,
    EmptyState,
    IconButton,
    Pagination,
    Panel,
    PrimaryButton,
    SectionPanel,
    Select,
    TextInput,
} from '../ui/surface'
import { BACKUP_FORBIDDEN_KEYS, formatBackupDate } from './BackupRestorePanel'

// ── Public contracts ────────────────────────────────────────────────────────

export type ComplianceAuditLoadState = 'loading' | 'ready' | 'error' | 'empty'

export const COMPLIANCE_AUDIT_PAGE_SIZE = 10

export const COMPLIANCE_AUDIT_PUBLIC_KEYS = [
    'id',
    'createdAt',
    'action',
    'actor',
    'targetType',
    'targetId',
    'outcome',
    'summary',
] as const

export type ComplianceAuditOutcome = 'success' | 'failure' | 'pending' | 'info' | string

export interface ComplianceAuditEntry {
    id: string | number
    createdAt: string
    action: string
    actor?: string | null
    targetType?: string | null
    targetId?: string | number | null
    outcome: ComplianceAuditOutcome
    summary?: string | null
}

export interface ComplianceAuditQuery {
    page?: number
    pageSize?: number
    action?: string
    outcome?: string
    from?: string
    to?: string
}

export interface ComplianceAuditPage {
    items: ComplianceAuditEntry[]
    total: number
    page: number
    pageSize: number
}

export interface DataComplianceAuditApi {
    getComplianceAudit: (query: ComplianceAuditQuery) => Promise<ComplianceAuditPage>
}

type Translate = (key: string, fallback?: string) => string

// ── Pure helpers ────────────────────────────────────────────────────────────

export function emptyComplianceAuditPage(
    page = 1,
    pageSize = COMPLIANCE_AUDIT_PAGE_SIZE,
): ComplianceAuditPage {
    return { items: [], total: 0, page, pageSize }
}

export function resolveAuditState(
    page: ComplianceAuditPage | null,
    error: string | null,
): ComplianceAuditLoadState {
    if (error && !page) return 'error'
    if (!page) return 'loading'
    if (page.total === 0 && page.items.length === 0) return 'empty'
    return 'ready'
}

export function totalAuditPages(total: number, pageSize: number): number {
    if (!Number.isFinite(total) || total <= 0) return 1
    if (!Number.isFinite(pageSize) || pageSize <= 0) return 1
    return Math.max(1, Math.ceil(total / pageSize))
}

export function outcomeTone(
    outcome: ComplianceAuditOutcome,
): 'emerald' | 'rose' | 'amber' | 'slate' | 'violet' {
    const o = String(outcome || '').toLowerCase()
    if (o === 'success' || o === 'approved' || o === 'ok') return 'emerald'
    if (o === 'failure' || o === 'failed' || o === 'rejected' || o === 'error') return 'rose'
    if (o === 'pending' || o === 'warning') return 'amber'
    if (o === 'info') return 'violet'
    return 'slate'
}

export function auditDtoHasNoSecrets(value: unknown): boolean {
    const json = JSON.stringify(value ?? null).toLowerCase()
    for (const key of BACKUP_FORBIDDEN_KEYS) {
        if (json.includes(`"${key.toLowerCase()}"`)) return false
    }
    return true
}

export function normalizeAuditPage(raw: unknown): ComplianceAuditPage {
    if (!raw || typeof raw !== 'object') return emptyComplianceAuditPage()
    const o = raw as Record<string, unknown>
    const items = Array.isArray(o.items)
        ? o.items.filter(isAuditEntry)
        : []
    const page = typeof o.page === 'number' && o.page > 0 ? o.page : 1
    const pageSize =
        typeof o.pageSize === 'number' && o.pageSize > 0
            ? o.pageSize
            : COMPLIANCE_AUDIT_PAGE_SIZE
    const total = typeof o.total === 'number' && o.total >= 0 ? o.total : items.length
    return { items, total, page, pageSize }
}

function isAuditEntry(v: unknown): v is ComplianceAuditEntry {
    if (!v || typeof v !== 'object') return false
    const o = v as Record<string, unknown>
    return (
        (typeof o.id === 'string' || typeof o.id === 'number') &&
        typeof o.createdAt === 'string' &&
        typeof o.action === 'string'
    )
}

// ── API bridge ──────────────────────────────────────────────────────────────

function getAuditApi(): DataComplianceAuditApi | null {
    const data = window.electronAPI?.data as
        | (Partial<DataComplianceAuditApi> & Record<string, unknown>)
        | undefined
    if (!data?.getComplianceAudit) return null
    return data as DataComplianceAuditApi
}

// ── Hook ────────────────────────────────────────────────────────────────────

function useComplianceAudit(t: Translate) {
    const [pageData, setPageData] = useState<ComplianceAuditPage | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [page, setPage] = useState(1)
    const [actionDraft, setActionDraft] = useState('')
    const [outcomeDraft, setOutcomeDraft] = useState('')
    const [appliedAction, setAppliedAction] = useState('')
    const [appliedOutcome, setAppliedOutcome] = useState('')

    const load = useCallback(async () => {
        const api = getAuditApi()
        if (!api) {
            setError(t('settings.auditUnavailable', 'Compliance audit API is unavailable'))
            setPageData(null)
            return
        }
        setBusy(true)
        setError(null)
        try {
            const query: ComplianceAuditQuery = {
                page,
                pageSize: COMPLIANCE_AUDIT_PAGE_SIZE,
            }
            if (appliedAction) query.action = appliedAction
            if (appliedOutcome) query.outcome = appliedOutcome
            const raw = await api.getComplianceAudit(query)
            setPageData(normalizeAuditPage(raw))
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg || t('settings.auditLoadError', 'Could not load compliance audit'))
            setPageData(null)
        } finally {
            setBusy(false)
        }
    }, [appliedAction, appliedOutcome, page, t])

    useEffect(() => {
        void load()
    }, [load])

    const applyFilter = useCallback(() => {
        const nextAction = actionDraft.trim()
        const nextOutcome = outcomeDraft.trim()
        setAppliedAction(nextAction)
        setAppliedOutcome(nextOutcome)
        setPage(1)
    }, [actionDraft, outcomeDraft])

    return {
        pageData,
        error,
        busy,
        page,
        setPage,
        actionDraft,
        setActionDraft,
        outcomeDraft,
        setOutcomeDraft,
        applyFilter,
        load,
        state: resolveAuditState(pageData, error),
    }
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function AuditFilters({
    t,
    busy,
    actionDraft,
    outcomeDraft,
    onAction,
    onOutcome,
    onApply,
}: {
    t: Translate
    busy: boolean
    actionDraft: string
    outcomeDraft: string
    onAction: (v: string) => void
    onOutcome: (v: string) => void
    onApply: () => void
}) {
    return (
        <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-end">
            <div className="min-w-0 flex-1">
                <div className="mb-1 text-[11px] font-medium text-[#908a9e] dark:text-[#9a8fba]">
                    {t('settings.auditFilterAction', 'Action filter')}
                </div>
                <TextInput
                    value={actionDraft}
                    onChange={onAction}
                    placeholder={t('settings.auditFilterActionPh', 'e.g. approve, reject')}
                    disabled={busy}
                    className="w-full"
                />
            </div>
            <div className="w-full sm:w-44">
                <div className="mb-1 text-[11px] font-medium text-[#908a9e] dark:text-[#9a8fba]">
                    {t('settings.auditFilterOutcome', 'Outcome')}
                </div>
                <Select
                    value={outcomeDraft as '' | 'success' | 'failure' | 'pending'}
                    onChange={onOutcome}
                    className="w-full"
                    options={[
                        { value: '', label: t('settings.auditOutcomeAll', 'All') },
                        { value: 'success', label: t('settings.auditOutcomeSuccess', 'Success') },
                        { value: 'failure', label: t('settings.auditOutcomeFailure', 'Failure') },
                        { value: 'pending', label: t('settings.auditOutcomePending', 'Pending') },
                    ]}
                />
            </div>
            <PrimaryButton
                variant="quiet"
                icon={Filter}
                onClick={onApply}
                disabled={busy}
                className="!px-3 !py-1.5 !text-xs"
            >
                {t('settings.auditApplyFilter', 'Apply filter')}
            </PrimaryButton>
        </div>
    )
}

function AuditRow({ entry }: { entry: ComplianceAuditEntry }) {
    return (
        <li className="flex flex-col gap-1.5 rounded-[14px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white/70 dark:bg-[#2a2540] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={outcomeTone(entry.outcome)}>{String(entry.outcome)}</Badge>
                    <span className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">{entry.action}</span>
                </div>
                {entry.summary && (
                    <p className="truncate text-xs text-[#6f697c] dark:text-[#c8c0d8]" title={entry.summary}>{entry.summary}</p>
                )}
                <div className="text-[11px] text-[#908a9e] dark:text-[#9a8fba]">
                    {formatBackupDate(entry.createdAt)}
                    {entry.actor ? ` · ${entry.actor}` : ''}
                    {entry.targetType
                        ? ` · ${entry.targetType}${entry.targetId != null ? `#${entry.targetId}` : ''}`
                        : ''}
                </div>
            </div>
            <div className="shrink-0 font-mono text-[11px] text-[#908a9e] dark:text-[#9a8fba]">#{entry.id}</div>
        </li>
    )
}

function AuditViews({
    t,
    state,
    pageData,
    busy,
    error,
    onRefresh,
    onPageChange,
}: {
    t: Translate
    state: ComplianceAuditLoadState
    pageData: ComplianceAuditPage | null
    busy: boolean
    error: string | null
    onRefresh: () => void
    onPageChange: (p: number) => void
}) {
    if (state === 'loading' || (busy && !pageData)) {
        return (
            <Panel tone="slate" className="flex items-center justify-center gap-2 !p-8 text-sm text-[#6f697c] dark:text-[#c8c0d8]">
                <Loader2 className="h-5 w-5 animate-spin text-[#8d74e8]" />
                {t('settings.auditLoading', 'Loading compliance audit…')}
            </Panel>
        )
    }
    if (state === 'error' && !pageData) {
        return (
            <EmptyState
                icon={ShieldAlert}
                title={t('settings.auditLoadError', 'Could not load compliance audit')}
                subtitle={error || t('settings.auditLoadErrorHint', 'Try refresh')}
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
                icon={ClipboardList}
                title={t('settings.auditEmpty', 'No audit events yet')}
                subtitle={t(
                    'settings.auditEmptyHint',
                    'Approve/reject and other compliance actions will appear here',
                )}
                action={
                    <PrimaryButton variant="quiet" icon={RefreshCw} onClick={onRefresh} disabled={busy}>
                        {t('common.refresh', 'Refresh')}
                    </PrimaryButton>
                }
            />
        )
    }
    if (!pageData) return null

    const pages = totalAuditPages(pageData.total, pageData.pageSize)

    return (
        <div className="space-y-3">
            <div className="text-xs text-[#908a9e] dark:text-[#9a8fba]">
                {t('settings.auditTotal', 'Total events')}:{' '}
                <span className="font-semibold text-[#5f5a6d] dark:text-[#c8c0d8]">{pageData.total}</span>
            </div>
            <ul className="space-y-2">
                {pageData.items.map((entry) => (
                    <AuditRow key={String(entry.id)} entry={entry} />
                ))}
            </ul>
            <Pagination page={pageData.page} totalPages={pages} onPageChange={onPageChange} />
        </div>
    )
}

// ── Main panel ──────────────────────────────────────────────────────────────

export function ComplianceAuditPanel() {
    const { t } = useTranslation()
    const m = useComplianceAudit(t)

    return (
        <SectionPanel
            icon={ShieldCheck}
            title={t('settings.complianceAudit', 'Compliance audit')}
            tone="violet"
        >
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-[#6f697c] dark:text-[#c8c0d8]">
                    {t(
                        'settings.complianceAuditDesc',
                        'History of compliance actions. Public metadata only — no secrets.',
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

            <AuditFilters
                t={t}
                busy={m.busy}
                actionDraft={m.actionDraft}
                outcomeDraft={m.outcomeDraft}
                onAction={m.setActionDraft}
                onOutcome={m.setOutcomeDraft}
                onApply={m.applyFilter}
            />

            {m.error && m.pageData && (
                <div className="mb-3">
                    <AlertBanner type="error" title={t('common.error', 'Error')}>
                        {m.error}
                    </AlertBanner>
                </div>
            )}

            <AuditViews
                t={t}
                state={m.state}
                pageData={m.pageData}
                busy={m.busy}
                error={m.error}
                onRefresh={() => {
                    void m.load()
                }}
                onPageChange={(p) => m.setPage(p)}
            />
        </SectionPanel>
    )
}
