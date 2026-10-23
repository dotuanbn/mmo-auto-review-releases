import { useEffect, useMemo, useState } from 'react'
import {
    AlertCircle,
    CheckCircle2,
    Clock3,
    Info,
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
        (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
        template,
    )
}

function RuntimeStatusIcon({ status }: { status: FProxySlotPublicDto['status'] }) {
    const iconClass = 'h-4 w-4 shrink-0'
    if (status === 'idle') return <CheckCircle2 className={`${iconClass} text-emerald-600 dark:text-emerald-400`} />
    if (status === 'leased') return <ShieldCheck className={`${iconClass} text-blue-600 dark:text-blue-400`} />
    if (status === 'cooldown') return <Clock3 className={`${iconClass} text-amber-600 dark:text-amber-400`} />
    if (status === 'testing') return <Loader2 className={`${iconClass} text-cyan-600 dark:text-cyan-400 motion-safe:animate-spin`} />
    if (status === 'rotating') return <RotateCw className={`${iconClass} text-[#735bd6] motion-safe:animate-spin`} />
    if (status === 'disabled') return <PauseCircle className={`${iconClass} text-[#6f697c] dark:text-[#c8c0d8]`} />
    return <AlertCircle className={`${iconClass} text-rose-600 dark:text-rose-400`} />
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
        <li className="grid gap-2 rounded-[14px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-3 py-2.5 md:grid-cols-[minmax(140px,0.85fr)_minmax(150px,1fr)_minmax(170px,1.1fr)] md:items-center">
            <div className="flex min-w-0 items-center gap-2">
                <RuntimeStatusIcon status={slot.status} />
                <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-[#24222c] dark:text-[#f0ecff]" title={slot.label}>{slot.label}</div>
                    <div className="mt-0.5 text-[11px] font-medium text-[#6f697c] dark:text-[#c8c0d8]">
                        {t(`traffic.fproxyPool.status.${statusKey}`)}
                    </div>
                </div>
            </div>
            <div className="min-w-0 text-xs text-[#5f5a6d] dark:text-[#c8c0d8]">
                {slot.currentEgress ? (
                    <>
                        <span className="font-mono text-[#24222c] dark:text-[#f0ecff]">{slot.currentEgress.ip}</span>
                        {slot.currentEgress.location && (
                            <span className="ml-2">{slot.currentEgress.location}</span>
                        )}
                    </>
                ) : (
                    <span className="text-[#908a9e] dark:text-[#9a8fba]">{t('traffic.fproxyPool.noEgress')}</span>
                )}
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    <span className={`font-mono tabular-nums ${rotateCountdown > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-400'}`}>
                        {t('traffic.fproxyPool.rotateIn', 'Xoay IP con')}: {formatFProxyCountdown(rotateCountdown)}
                    </span>
                    <span className={`font-mono tabular-nums ${ipLeft > 0 ? 'text-[#5f5a6d] dark:text-[#c8c0d8]' : 'text-[#908a9e] dark:text-[#9a8fba]'}`}>
                        {t('traffic.fproxyPool.ipLeft', 'IP con')}: {formatFProxyCountdown(ipLeft)}
                    </span>
                </div>
            </div>
            <div className="min-w-0 text-xs text-[#5f5a6d] dark:text-[#c8c0d8]">
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
                    <span className="line-clamp-2 text-rose-700 dark:text-rose-300" title={slot.error}>{slot.error}</span>
                ) : rotateCountdown > 0 ? (
                    <span className="text-amber-700 dark:text-amber-300">
                        {t('traffic.fproxyPool.waitingRotate', 'Cho xoay IP')} {formatFProxyCountdown(rotateCountdown)}
                    </span>
                ) : (
                    <span className="text-[#908a9e] dark:text-[#9a8fba]">{t('traffic.fproxyPool.unassigned')}</span>
                )}
            </div>
        </li>
    )
}

type CapacityNoticeTone = 'amber' | 'emerald' | 'info'

interface CapacityNoticeContent {
    tone: CapacityNoticeTone
    message: string
}

const CAPACITY_NOTICE_TONE_CLASS: Record<CapacityNoticeTone, string> = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200',
    emerald: 'border-emerald-100 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200',
    info: 'border-blue-100 bg-blue-50 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200',
}

function CapacityNoticeIcon({ tone }: { tone: CapacityNoticeTone }) {
    const iconClass = 'mt-0.5 h-4 w-4 shrink-0'
    if (tone === 'amber') return <Clock3 className={iconClass} />
    if (tone === 'info') return <Info className={iconClass} />
    return <CheckCircle2 className={iconClass} />
}

function buildCapacityNotice(params: {
    mapCount: number
    threads: number
    capacity: number
    waiting: number
    translate: (key: string) => string
}): CapacityNoticeContent {
    const { mapCount, threads, capacity, waiting, translate } = params
    const tokens = { threads, capacity, maps: mapCount, waiting }

    // Strict 1 key = 1 browser rule: whenever threads exceed enabled keys (waiting > 0),
    // warn that concurrent browsers are capped at the number of enabled FProxy keys.
    if (waiting > 0) {
        if (mapCount === 1 && capacity === 1) {
            return {
                tone: 'amber',
                message: replaceTokens(translate('traffic.fproxyPool.singleMapMultiThreadWarning'), tokens),
            }
        }
        return {
            tone: 'amber',
            message: replaceTokens(translate('traffic.fproxyPool.capacityWarning'), tokens),
        }
    }

    if (mapCount === 1 && threads === 1) {
        return {
            tone: 'emerald',
            message: replaceTokens(translate('traffic.fproxyPool.singleMapSingleThreadReady'), tokens),
        }
    }

    if (mapCount > 1) {
        if (threads === 1) {
            return {
                tone: 'info',
                message: replaceTokens(translate('traffic.fproxyPool.multiMapSingleThreadInfo'), tokens),
            }
        }
        if (threads > 1 && threads <= mapCount) {
            let message = replaceTokens(translate('traffic.fproxyPool.multiMapParallelReady'), tokens)
            if (mapCount > threads) {
                message = `${message} ${replaceTokens(
                    translate('traffic.fproxyPool.multiMapMoreMapsThanThreadsNotice'),
                    tokens,
                )}`
            }
            return { tone: 'emerald', message }
        }
        if (threads > mapCount) {
            return {
                tone: 'amber',
                message: replaceTokens(translate('traffic.fproxyPool.multiMapMoreThreadsThanMapsWarning'), tokens),
            }
        }
    }

    return {
        tone: 'emerald',
        message: replaceTokens(translate('traffic.fproxyPool.capacityReady'), tokens),
    }
}

export function FProxyCapacityNotice({
    threads,
    locationCount,
}: {
    threads: number
    locationCount?: number
}) {
    const { t } = useI18n()
    const snapshot = useFProxyPoolStore(state => state.snapshot)
    const loading = useFProxyPoolStore(state => state.loading)
    const error = useFProxyPoolStore(state => state.error)
    const load = useFProxyPoolStore(state => state.load)
    const subscribe = useFProxyPoolStore(state => state.subscribe)

    useEffect(() => {
        // snapshot/loading update when load() settles. Keeping them as deps
        // tears down and recreates the IPC subscription on every update.
        if (!snapshot && !loading) void load()
        const unsubscribe = subscribe()
        return unsubscribe
    }, [load, subscribe])

    if (loading && !snapshot) {
        return (
            <div className="mt-2 flex min-h-11 items-center gap-2 text-xs text-[#6f697c] dark:text-[#c8c0d8]" role="status">
                <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                {t('traffic.fproxyPool.checkingCapacity')}
            </div>
        )
    }
    if (!snapshot || snapshot.slots.length === 0) {
        if (!error) return null
        return (
            <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300" role="status">
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
    const mapCount = Math.max(0, locationCount ?? 0)
    const notice = buildCapacityNotice({
        mapCount,
        threads,
        capacity: snapshot.capacity,
        waiting,
        translate: t,
    })

    return (
        <div
            className={`mt-2 flex min-h-11 items-start gap-2 rounded-[14px] border px-3 py-2 text-xs ${CAPACITY_NOTICE_TONE_CLASS[notice.tone]}`}
            role="status"
            aria-live="polite"
        >
            <CapacityNoticeIcon tone={notice.tone} />
            <span className="leading-relaxed">{notice.message}</span>
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
                <div className="flex items-center gap-2 text-sm text-[#5f5a6d] dark:text-[#c8c0d8]" role="status">
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
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                        <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
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
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] text-[#5f5a6d] dark:text-[#c8c0d8] transition-colors hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8d74e8]/50 disabled:opacity-50"
                    aria-label={t('traffic.fproxyPool.refresh')}
                >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'motion-safe:animate-spin' : ''}`} />
                </button>
            </div>

            {summary.waiting > 0 && (
                <div className="mt-3 flex items-start gap-2 rounded-[14px] border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" role="status">
                    <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                    {replaceTokens(t('traffic.fproxyPool.runtimeWaiting'), {
                        count: summary.waiting,
                    })}
                </div>
            )}

            {error && (
                <p className="mt-2 text-xs text-amber-800 dark:text-amber-200" role="status">
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
                <p className="mt-3 text-xs text-[#6f697c] dark:text-[#c8c0d8]">
                    {t('traffic.fproxyPool.empty')}
                </p>
            )}
        </Panel>
    )
}
