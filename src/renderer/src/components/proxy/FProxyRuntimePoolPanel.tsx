import { useEffect, useMemo, useState } from 'react'
import {
    AlertCircle,
    CheckCircle2,
    Clock3,
    Loader2,
    PauseCircle,
    RefreshCw,
    RotateCw,
    ShieldCheck,
} from 'lucide-react'
import type { FProxySlotPublicDto } from '../../../../shared/fproxy-pool-contracts'
import { useI18n } from '../../i18n'
import {
    formatFProxyCountdown,
    getFProxyCooldownSeconds,
    getFProxyPoolServerOffset,
    getFProxyRemainingSeconds,
    useFProxyPoolStore,
} from '../../stores/fproxyPoolStore'
import { AlertBanner, Badge, Panel } from '../ui/surface'

function replaceTokens(template: string, values: Record<string, string | number>): string {
    return Object.entries(values).reduce(
        (text, [key, value]) => text.replace(`{${key}}`, String(value)),
        template,
    )
}

function RuntimeStatusIcon({ status }: { status: FProxySlotPublicDto['status'] }) {
    const iconClass = 'h-4 w-4 shrink-0'
    if (status === 'idle') return <CheckCircle2 className={`${iconClass} text-emerald-600`} />
    if (status === 'leased') return <ShieldCheck className={`${iconClass} text-blue-600`} />
    if (status === 'cooldown') return <Clock3 className={`${iconClass} text-amber-600`} />
    if (status === 'testing') return <Loader2 className={`${iconClass} text-cyan-600 motion-safe:animate-spin`} />
    if (status === 'rotating') return <RotateCw className={`${iconClass} text-[#735bd6] motion-safe:animate-spin`} />
    if (status === 'disabled') return <PauseCircle className={`${iconClass} text-[#6f697c]`} />
    return <AlertCircle className={`${iconClass} text-rose-600`} />
}

function RuntimeSlotRow({
    slot,
    now,
}: {
    slot: FProxySlotPublicDto
    now: number
}) {
    const { t } = useI18n()
    const snapshot = useFProxyPoolStore(state => state.snapshot)
    const serverOffset = getFProxyPoolServerOffset(snapshot)
    // Dual timers from FProxy dashboard:
    // - Xoay IP = waiting_time / nextRotateAt / cooldownUntil (~2 min)
    // - IP con = time_die / ipExpiresAt (~30 min)
    // Never max() rotate with IP life — that produced the false 29-minute rotate UI.
    const cooldown = getFProxyCooldownSeconds(slot.cooldownUntil, serverOffset, now)
    const rotateIn = getFProxyRemainingSeconds(slot.nextRotateAt, serverOffset, now)
    const ipLeft = getFProxyRemainingSeconds(slot.ipExpiresAt, serverOffset, now)
    const statusKey = slot.status === 'idle'
        ? 'ready'
        : slot.status === 'leased'
            ? 'inUse'
            : slot.status
    // Prefer explicit rotate deadline; fall back to cooldown-only when provider is cooling.
    // Cap >5 min as untrusted (getcurrent mirror of time_die).
    const rawRotate = Math.max(cooldown, rotateIn)
    const rotateCountdown = rawRotate > 300 ? 0 : rawRotate

    return (
        <li className="grid gap-2 rounded-[14px] border border-[#ece7f5] bg-white px-3 py-2.5 md:grid-cols-[minmax(140px,0.85fr)_minmax(150px,1fr)_minmax(170px,1.1fr)] md:items-center">
            <div className="flex min-w-0 items-center gap-2">
                <RuntimeStatusIcon status={slot.status} />
                <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-[#24222c]">{slot.label}</div>
                    <div className="mt-0.5 text-[11px] font-medium text-[#6f697c]">
                        {t(`traffic.fproxyPool.status.${statusKey}`)}
                    </div>
                </div>
            </div>
            <div className="min-w-0 text-xs text-[#5f5a6d]">
                {slot.currentEgress ? (
                    <>
                        <span className="font-mono text-[#24222c]">{slot.currentEgress.ip}</span>
                        {slot.currentEgress.location && (
                            <span className="ml-2">{slot.currentEgress.location}</span>
                        )}
                    </>
                ) : (
                    <span className="text-[#908a9e]">{t('traffic.fproxyPool.noEgress')}</span>
                )}
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    <span className={`font-mono tabular-nums ${rotateCountdown > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                        {t('traffic.fproxyPool.rotateIn', 'Xoay IP con')}: {formatFProxyCountdown(rotateCountdown)}
                    </span>
                    <span className={`font-mono tabular-nums ${ipLeft > 0 ? 'text-[#5f5a6d]' : 'text-[#908a9e]'}`}>
                        {t('traffic.fproxyPool.ipLeft', 'IP con')}: {formatFProxyCountdown(ipLeft)}
                    </span>
                </div>
            </div>
            <div className="min-w-0 text-xs text-[#5f5a6d]">
                {slot.leaseOwner ? (
                    <span>
                        {replaceTokens(
                            t(
                                slot.leaseOwner.kind === 'automation_job'
                                    ? 'traffic.fproxyPool.jobLease'
                                    : 'traffic.fproxyPool.threadLease',
                            ),
                            {
                                thread: slot.leaseOwner.threadId,
                                owner: slot.leaseOwner.id,
                            },
                        )}
                    </span>
                ) : slot.error ? (
                    <span className="line-clamp-2 text-rose-700" title={slot.error}>{slot.error}</span>
                ) : rotateCountdown > 0 ? (
                    <span className="text-amber-700">
                        {t('traffic.fproxyPool.waitingRotate', 'Cho xoay IP')} {formatFProxyCountdown(rotateCountdown)}
                    </span>
                ) : (
                    <span className="text-[#908a9e]">{t('traffic.fproxyPool.unassigned')}</span>
                )}
            </div>
        </li>
    )
}

export function FProxyCapacityNotice({ threads }: { threads: number }) {
    const { t } = useI18n()
    const snapshot = useFProxyPoolStore(state => state.snapshot)
    const loading = useFProxyPoolStore(state => state.loading)
    const error = useFProxyPoolStore(state => state.error)
    const load = useFProxyPoolStore(state => state.load)
    const subscribe = useFProxyPoolStore(state => state.subscribe)

    useEffect(() => {
        if (!snapshot && !loading) void load()
        const unsubscribe = subscribe()
        return unsubscribe
    }, [load, loading, snapshot, subscribe])

    if (loading && !snapshot) {
        return (
            <div className="mt-2 flex min-h-11 items-center gap-2 text-xs text-[#6f697c]" role="status">
                <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                {t('traffic.fproxyPool.checkingCapacity')}
            </div>
        )
    }
    if (!snapshot || snapshot.slots.length === 0) {
        if (!error) return null
        return (
            <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2 text-xs text-amber-700" role="status">
                <AlertCircle className="h-4 w-4" />
                <span>{t('traffic.fproxyPool.capacityUnavailable')}</span>
                <button
                    type="button"
                    onClick={() => void load()}
                    className="min-h-11 rounded-full px-3 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                >
                    {t('traffic.fproxyPool.retry')}
                </button>
            </div>
        )
    }

    const waiting = snapshot.policy.strictUnique
        ? Math.max(0, threads - snapshot.capacity)
        : 0
    const warning = waiting > 0

    return (
        <div
            className={`mt-2 flex min-h-11 items-start gap-2 rounded-[14px] border px-3 py-2 text-xs ${
                warning
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-emerald-100 bg-emerald-50 text-emerald-800'
            }`}
            role="status"
            aria-live="polite"
        >
            {warning
                ? <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="leading-relaxed">
                {warning
                    ? replaceTokens(t('traffic.fproxyPool.capacityWarning'), {
                        threads,
                        capacity: snapshot.capacity,
                        waiting,
                    })
                    : replaceTokens(t('traffic.fproxyPool.capacityReady'), {
                        threads,
                        capacity: snapshot.capacity,
                    })}
            </span>
        </div>
    )
}

export function FProxyRuntimePoolPanel({
    active,
    requestedThreads,
}: {
    active: boolean
    requestedThreads: number
}) {
    const { t } = useI18n()
    const snapshot = useFProxyPoolStore(state => state.snapshot)
    const loading = useFProxyPoolStore(state => state.loading)
    const error = useFProxyPoolStore(state => state.error)
    const load = useFProxyPoolStore(state => state.load)
    const refreshAll = useFProxyPoolStore(state => state.refreshAll)
    const subscribe = useFProxyPoolStore(state => state.subscribe)
    const [now, setNow] = useState(Date.now())

    useEffect(() => {
        if (!active) return
        void load()
        const unsubscribe = subscribe()
        // Refresh from provider API every 30s; local clock ticks every 1s for countdown display
        const refreshInterval = window.setInterval(() => void refreshAll(), 30_000)
        const clockInterval = window.setInterval(() => setNow(Date.now()), 1_000)
        return () => {
            unsubscribe()
            window.clearInterval(refreshInterval)
            window.clearInterval(clockInterval)
        }
    }, [active, load, refreshAll, subscribe])

    const summary = useMemo(() => {
        const slots = snapshot?.slots || []
        const inUse = slots.filter(slot => slot.status === 'leased').length
        const cooldown = slots.filter(slot => slot.status === 'cooldown').length
        const failed = slots.filter(slot => slot.status === 'error').length
        const totalCapacity = inUse + (snapshot?.capacity || 0)
        const waiting = snapshot?.policy.strictUnique
            ? Math.max(0, requestedThreads - totalCapacity)
            : 0
        return { inUse, cooldown, failed, waiting }
    }, [requestedThreads, snapshot])

    if (loading && !snapshot) {
        return (
            <Panel tone="slate" className="p-4" >
                <div className="flex items-center gap-2 text-sm text-[#5f5a6d]" role="status">
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                    {t('traffic.fproxyPool.loading')}
                </div>
            </Panel>
        )
    }

    if (!snapshot) {
        return (
            <AlertBanner type="warning">
                <div className="flex flex-wrap items-center gap-2">
                    <span>{t('traffic.fproxyPool.runtimeUnavailable')}</span>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="min-h-11 rounded-full px-3 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
                    >
                        {t('traffic.fproxyPool.retry')}
                    </button>
                </div>
            </AlertBanner>
        )
    }

    return (
        <Panel tone={summary.failed > 0 ? 'amber' : 'emerald'} className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#24222c]">
                        <ShieldCheck className="h-4 w-4 text-emerald-600" />
                        {t('traffic.fproxyPool.runtimeTitle')}
                        <Badge tone="emerald">FProxy</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
                        <Badge tone="blue">
                            {replaceTokens(t('traffic.fproxyPool.inUseSummary'), {
                                count: summary.inUse,
                            })}
                        </Badge>
                        <Badge tone="emerald">
                            {replaceTokens(t('traffic.fproxyPool.availableSummary'), {
                                count: snapshot.capacity,
                            })}
                        </Badge>
                        {summary.cooldown > 0 && (
                            <Badge tone="amber">
                                {replaceTokens(t('traffic.fproxyPool.cooldownSummary'), {
                                    count: summary.cooldown,
                                })}
                            </Badge>
                        )}
                        {summary.failed > 0 && (
                            <Badge tone="rose">
                                {replaceTokens(t('traffic.fproxyPool.errorSummary'), {
                                    count: summary.failed,
                                })}
                            </Badge>
                        )}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#e9e4f2] bg-white text-[#5f5a6d] transition-colors hover:bg-[#f4f1fa] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8d74e8]/50 disabled:opacity-50"
                    aria-label={t('traffic.fproxyPool.refresh')}
                >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'motion-safe:animate-spin' : ''}`} />
                </button>
            </div>

            {summary.waiting > 0 && (
                <div className="mt-3 flex items-start gap-2 rounded-[14px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
                    <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                    {replaceTokens(t('traffic.fproxyPool.runtimeWaiting'), {
                        count: summary.waiting,
                    })}
                </div>
            )}

            {error && (
                <p className="mt-2 text-xs text-amber-800" role="status">
                    {t('traffic.fproxyPool.staleSnapshot')}
                </p>
            )}

            {snapshot.slots.length > 0 ? (
                <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1" aria-label={t('traffic.fproxyPool.slotList')}>
                    {snapshot.slots.map(slot => (
                        <RuntimeSlotRow key={slot.id} slot={slot} now={now} />
                    ))}
                </ul>
            ) : (
                <p className="mt-3 text-xs text-[#6f697c]">
                    {t('traffic.fproxyPool.empty')}
                </p>
            )}
        </Panel>
    )
}
