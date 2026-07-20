import { useCallback, useEffect, useState } from 'react'
import {
    CheckCircle,
    Clock,
    Loader2,
    RefreshCw,
    ShieldAlert,
    Target,
    Trash2,
    XCircle,
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
    StatCard,
    StatRow,
} from '../ui/surface'
import {
    emptyCaptchaMetricsSnapshot,
    type CaptchaMetricsBucket,
    type CaptchaMetricsSnapshot,
    type CaptchaRecentAttempt,
} from '../../../../shared/captcha-metrics-contracts'

export type CaptchaMetricsLoadState = 'loading' | 'ready' | 'error' | 'empty'

type Translate = (key: string, fallback?: string) => string

/** Public snapshot field names — secrets must never appear. */
export const CAPTCHA_METRICS_PUBLIC_ATTEMPT_KEYS = [
    'id',
    'captchaType',
    'provider',
    'success',
    'durationMs',
    'retryCount',
    'errorCode',
    'createdAt',
] as const

export const CAPTCHA_METRICS_FORBIDDEN_KEYS = [
    'apiKey',
    'api_key',
    'token',
    'sitekey',
    'siteKey',
    'secret',
    'password',
    'authorization',
    'bearer',
] as const

export function isEmptyMetrics(snap: CaptchaMetricsSnapshot): boolean {
    return snap.totals.attempts === 0
}

export function formatDurationMs(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0ms'
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

export function formatPercent(rate: number): string {
    if (!Number.isFinite(rate)) return '0%'
    return `${rate.toFixed(1)}%`
}

export function successTone(rate: number): 'emerald' | 'amber' | 'rose' | 'slate' {
    if (rate >= 70) return 'emerald'
    if (rate >= 40) return 'amber'
    if (rate > 0) return 'rose'
    return 'slate'
}

/** True when snapshot JSON has only public keys (no secret field names). */
export function snapshotHasNoSecrets(snap: CaptchaMetricsSnapshot): boolean {
    const json = JSON.stringify(snap).toLowerCase()
    for (const key of CAPTCHA_METRICS_FORBIDDEN_KEYS) {
        if (json.includes(`"${key.toLowerCase()}"`)) return false
    }
    return true
}

export function resolveMetricsState(
    snap: CaptchaMetricsSnapshot | null,
    error: string | null,
): CaptchaMetricsLoadState {
    if (error && !snap) return 'error'
    if (!snap) return 'loading'
    if (isEmptyMetrics(snap)) return 'empty'
    return 'ready'
}

function getCaptchaApi(): {
    getMetrics: () => Promise<CaptchaMetricsSnapshot>
    resetMetrics: () => Promise<{ success: boolean; deleted: number }>
} | null {
    const api = window.electronAPI?.captcha
    if (!api?.getMetrics || !api?.resetMetrics) return null
    return api
}

function useCaptchaMetrics(t: Translate) {
    const [snap, setSnap] = useState<CaptchaMetricsSnapshot | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [confirmReset, setConfirmReset] = useState(false)
    const [resetMsg, setResetMsg] = useState<string | null>(null)

    const load = useCallback(async () => {
        const api = getCaptchaApi()
        if (!api) {
            setError(t('settings.captchaMetricsUnavailable', 'Metrics API is unavailable'))
            setSnap(null)
            return
        }
        setBusy(true)
        setError(null)
        try {
            const next = await api.getMetrics()
            setSnap(next ?? emptyCaptchaMetricsSnapshot())
            setResetMsg(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg || t('settings.captchaMetricsError', 'Could not load CAPTCHA metrics'))
        } finally {
            setBusy(false)
        }
    }, [t])

    const handleReset = useCallback(async () => {
        const api = getCaptchaApi()
        if (!api) return
        setBusy(true)
        setError(null)
        try {
            const result = await api.resetMetrics()
            setConfirmReset(false)
            setResetMsg(
                t('settings.captchaMetricsResetDone', 'Metrics reset ({n} rows deleted)').replace(
                    '{n}',
                    String(result?.deleted ?? 0),
                ),
            )
            setSnap(emptyCaptchaMetricsSnapshot())
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg || t('settings.captchaMetricsError', 'Could not load CAPTCHA metrics'))
        } finally {
            setBusy(false)
        }
    }, [t])

    useEffect(() => {
        void load()
    }, [load])

    return {
        snap,
        error,
        busy,
        confirmReset,
        setConfirmReset,
        resetMsg,
        load,
        handleReset,
        state: resolveMetricsState(snap, error),
    }
}

function MetricsToolbar({
    t,
    busy,
    canReset,
    onRefresh,
    onResetClick,
}: {
    t: Translate
    busy: boolean
    canReset: boolean
    onRefresh: () => void
    onResetClick: () => void
}) {
    return (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="text-sm text-[#6f697c]">
                {t(
                    'settings.captchaMetricsDesc',
                    'Solve attempt rates by type and provider. No secrets are stored or shown.',
                )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <IconButton
                    icon={busy ? Loader2 : RefreshCw}
                    label={t('settings.captchaMetricsRefresh', 'Refresh metrics')}
                    onClick={onRefresh}
                    disabled={busy}
                    className={busy ? '[&_svg]:animate-spin' : undefined}
                />
                <PrimaryButton
                    tone="rose"
                    variant="quiet"
                    icon={Trash2}
                    onClick={onResetClick}
                    disabled={busy || !canReset}
                    className="!px-3 !py-1.5 !text-xs"
                >
                    {t('settings.captchaMetricsReset', 'Reset metrics')}
                </PrimaryButton>
            </div>
        </div>
    )
}

function ResetConfirmBlock({
    t,
    busy,
    onConfirm,
    onCancel,
}: {
    t: Translate
    busy: boolean
    onConfirm: () => void
    onCancel: () => void
}) {
    return (
        <div className="mb-3">
            <AlertBanner type="warning" title={t('settings.captchaMetricsReset', 'Reset metrics')}>
                <p className="mb-2">
                    {t(
                        'settings.captchaMetricsResetConfirm',
                        'Delete all CAPTCHA metric history? This cannot be undone.',
                    )}
                </p>
                <div className="flex flex-wrap gap-2">
                    <PrimaryButton
                        tone="rose"
                        onClick={onConfirm}
                        disabled={busy}
                        className="!px-3 !py-1.5 !text-xs"
                    >
                        {t('common.confirm', 'Confirm')}
                    </PrimaryButton>
                    <PrimaryButton
                        variant="quiet"
                        onClick={onCancel}
                        disabled={busy}
                        className="!px-3 !py-1.5 !text-xs"
                    >
                        {t('common.cancel', 'Cancel')}
                    </PrimaryButton>
                </div>
            </AlertBanner>
        </div>
    )
}

function BucketTable({
    title,
    buckets,
    emptyLabel,
}: {
    title: string
    buckets: Record<string, CaptchaMetricsBucket>
    emptyLabel: string
}) {
    const entries = Object.entries(buckets)
    return (
        <Panel tone="slate" className="!p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#6f697c]">
                {title}
            </div>
            {entries.length === 0 ? (
                <p className="text-xs text-[#908a9e]">{emptyLabel}</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[280px] text-left text-xs">
                        <thead>
                            <tr className="text-[#908a9e]">
                                <th className="pb-1.5 pr-2 font-medium">Key</th>
                                <th className="pb-1.5 pr-2 font-medium">N</th>
                                <th className="pb-1.5 pr-2 font-medium">OK</th>
                                <th className="pb-1.5 pr-2 font-medium">Fail</th>
                                <th className="pb-1.5 pr-2 font-medium">Rate</th>
                                <th className="pb-1.5 font-medium">Avg</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map(([key, b]) => (
                                <tr key={key} className="border-t border-[#ece7f5] text-[#24222c]">
                                    <td className="py-1.5 pr-2 font-medium">{key}</td>
                                    <td className="py-1.5 pr-2">{b.attempts}</td>
                                    <td className="py-1.5 pr-2 text-emerald-600">{b.successes}</td>
                                    <td className="py-1.5 pr-2 text-rose-600">{b.failures}</td>
                                    <td className="py-1.5 pr-2">{formatPercent(b.successRate)}</td>
                                    <td className="py-1.5">{formatDurationMs(b.averageDurationMs)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    )
}

function RecentList({
    attempts,
    labels,
}: {
    attempts: CaptchaRecentAttempt[]
    labels: { recent: string; empty: string; ok: string; fail: string; retries: string }
}) {
    return (
        <Panel tone="slate" className="!p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#6f697c]">
                {labels.recent}
            </div>
            {attempts.length === 0 ? (
                <p className="text-xs text-[#908a9e]">{labels.empty}</p>
            ) : (
                <ul className="max-h-64 space-y-2 overflow-y-auto">
                    {attempts.map((a) => (
                        <li
                            key={a.id}
                            className="flex flex-col gap-1 rounded-[12px] border border-[#e9e4f2] bg-white/70 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between"
                        >
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                <Badge tone={a.success ? 'emerald' : 'rose'}>
                                    {a.success ? labels.ok : labels.fail}
                                </Badge>
                                <span className="text-xs font-medium text-[#24222c]">{a.captchaType}</span>
                                <span className="text-xs text-[#908a9e]">· {a.provider}</span>
                                {a.errorCode && (
                                    <span className="truncate text-[11px] text-rose-600/80">
                                        {a.errorCode}
                                    </span>
                                )}
                            </div>
                            <div className="shrink-0 text-[11px] text-[#908a9e]">
                                {formatDurationMs(a.durationMs)}
                                {a.retryCount > 0 && ` · ${labels.retries} ${a.retryCount}`}
                                {' · '}
                                {new Date(a.createdAt).toLocaleString()}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </Panel>
    )
}

function MetricsBody({ snap, t }: { snap: CaptchaMetricsSnapshot; t: Translate }) {
    const rate = snap.successRate
    return (
        <div className="space-y-3">
            <StatRow>
                <StatCard
                    icon={Target}
                    label={t('settings.captchaMetricsAttempts', 'Attempts')}
                    value={snap.totals.attempts}
                    tone="violet"
                />
                <StatCard
                    icon={CheckCircle}
                    label={t('settings.captchaMetricsSuccesses', 'Successes')}
                    value={snap.totals.successes}
                    tone="emerald"
                />
                <StatCard
                    icon={XCircle}
                    label={t('settings.captchaMetricsFailures', 'Failures')}
                    value={snap.totals.failures}
                    tone="rose"
                />
                <StatCard
                    icon={ShieldAlert}
                    label={t('settings.captchaMetricsSuccessRate', 'Success rate')}
                    value={formatPercent(rate)}
                    tone={successTone(rate)}
                />
                <StatCard
                    icon={Clock}
                    label={t('settings.captchaMetricsAvgDuration', 'Avg duration')}
                    value={formatDurationMs(snap.averageDurationMs)}
                    tone="blue"
                />
            </StatRow>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <BucketTable
                    title={t('settings.captchaMetricsByType', 'By CAPTCHA type')}
                    buckets={snap.byType}
                    emptyLabel={t('settings.captchaMetricsNoBreakdown', 'No breakdown yet')}
                />
                <BucketTable
                    title={t('settings.captchaMetricsByProvider', 'By solver provider')}
                    buckets={snap.byProvider}
                    emptyLabel={t('settings.captchaMetricsNoBreakdown', 'No breakdown yet')}
                />
            </div>
            <RecentList
                attempts={snap.recentAttempts}
                labels={{
                    recent: t('settings.captchaMetricsRecent', 'Recent attempts'),
                    empty: t('settings.captchaMetricsNoRecent', 'No recent attempts'),
                    ok: t('settings.captchaMetricsOk', 'OK'),
                    fail: t('settings.captchaMetricsFail', 'Fail'),
                    retries: t('settings.captchaMetricsRetries', 'retries'),
                }}
            />
        </div>
    )
}

function MetricsViews({
    t,
    state,
    snap,
    error,
    busy,
    onRefresh,
}: {
    t: Translate
    state: CaptchaMetricsLoadState
    snap: CaptchaMetricsSnapshot | null
    error: string | null
    busy: boolean
    onRefresh: () => void
}) {
    if (state === 'loading' || (busy && !snap)) {
        return (
            <Panel tone="slate" className="flex items-center justify-center gap-2 !p-8 text-sm text-[#6f697c]">
                <Loader2 className="h-5 w-5 animate-spin text-[#8d74e8]" />
                {t('settings.captchaMetricsLoading', 'Loading CAPTCHA metrics…')}
            </Panel>
        )
    }
    if (state === 'error' && !snap) {
        return (
            <EmptyState
                icon={ShieldAlert}
                title={t('settings.captchaMetricsError', 'Could not load CAPTCHA metrics')}
                subtitle={error || t('settings.captchaMetricsErrorHint', 'Try refresh')}
                action={
                    <PrimaryButton variant="quiet" icon={RefreshCw} onClick={onRefresh} disabled={busy}>
                        {t('common.refresh', 'Refresh')}
                    </PrimaryButton>
                }
            />
        )
    }
    if (state === 'empty' && snap) {
        return (
            <EmptyState
                icon={ShieldAlert}
                title={t('settings.captchaMetricsEmpty', 'No CAPTCHA attempts recorded yet')}
                subtitle={t(
                    'settings.captchaMetricsEmptyHint',
                    'Metrics appear after auto-solve attempts run',
                )}
                action={
                    <PrimaryButton variant="quiet" icon={RefreshCw} onClick={onRefresh} disabled={busy}>
                        {t('common.refresh', 'Refresh')}
                    </PrimaryButton>
                }
            />
        )
    }
    if (state === 'ready' && snap) return <MetricsBody snap={snap} t={t} />
    return null
}

/**
 * CAPTCHA solve metrics dashboard for Settings.
 * Public DTO only — never displays tokens, sitekeys, API keys, or full URLs.
 */
export function CaptchaMetricsPanel() {
    const { t } = useTranslation()
    const m = useCaptchaMetrics(t)

    return (
        <SectionPanel
            icon={ShieldAlert}
            title={t('settings.captchaMetrics', 'CAPTCHA Metrics')}
            tone="violet"
        >
            <MetricsToolbar
                t={t}
                busy={m.busy}
                canReset={!!m.snap && !isEmptyMetrics(m.snap)}
                onRefresh={() => {
                    void m.load()
                }}
                onResetClick={() => m.setConfirmReset(true)}
            />
            {m.confirmReset && (
                <ResetConfirmBlock
                    t={t}
                    busy={m.busy}
                    onConfirm={() => {
                        void m.handleReset()
                    }}
                    onCancel={() => m.setConfirmReset(false)}
                />
            )}
            {m.error && (
                <div className="mb-3">
                    <AlertBanner
                        type="error"
                        title={t('settings.captchaMetricsError', 'Could not load CAPTCHA metrics')}
                    >
                        {m.error}
                    </AlertBanner>
                </div>
            )}
            {m.resetMsg && (
                <div className="mb-3">
                    <AlertBanner type="success">{m.resetMsg}</AlertBanner>
                </div>
            )}
            <MetricsViews
                t={t}
                state={m.state}
                snap={m.snap}
                error={m.error}
                busy={m.busy}
                onRefresh={() => {
                    void m.load()
                }}
            />
        </SectionPanel>
    )
}
