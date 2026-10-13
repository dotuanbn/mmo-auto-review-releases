import {
    type ClipboardEvent,
    type FormEvent,
    type RefObject,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import {
    AlertCircle,
    CheckCircle2,
    Clock3,
    KeyRound,
    Loader2,
    PauseCircle,
    PlayCircle,
    Plus,
    RefreshCw,
    RotateCw,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react'
import type {
    FProxyPoolPolicy,
    FProxySlotPublicDto,
} from '../../../../shared/fproxy-pool-contracts'
import { useI18n } from '../../i18n'
import {
    formatFProxyCountdown,
    getFProxyCooldownSeconds,
    getFProxyPoolServerOffset,
    getFProxyRemainingSeconds,
    useFProxyPoolStore,
    type FProxyPoolErrorCode,
} from '../../stores/fproxyPoolStore'
import { AlertBanner, Badge, PrimaryButton } from '../ui/surface'

interface SecretRow {
    id: number
    value: string
}

const actionButtonClass =
    'min-h-11 rounded-full px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8d74e8]/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45'

function replaceTokens(template: string, values: Record<string, string | number>): string {
    return Object.entries(values).reduce(
        (text, [key, value]) => text.replace(`{${key}}`, String(value)),
        template,
    )
}

function splitPastedKeys(value: string): string[] {
    return [...new Set(value.split(/\r?\n/).map(key => key.trim()).filter(Boolean))]
}

function statusPresentation(
    slot: FProxySlotPublicDto,
    labels: Record<FProxySlotPublicDto['status'], string>,
) {
    const presentations = {
        disabled: { Icon: PauseCircle, tone: 'slate', label: labels.disabled },
        idle: { Icon: CheckCircle2, tone: 'emerald', label: labels.idle },
        testing: { Icon: Loader2, tone: 'cyan', label: labels.testing },
        rotating: { Icon: RotateCw, tone: 'violet', label: labels.rotating },
        leased: { Icon: ShieldCheck, tone: 'blue', label: labels.leased },
        cooldown: { Icon: Clock3, tone: 'amber', label: labels.cooldown },
        error: { Icon: AlertCircle, tone: 'rose', label: labels.error },
    } as const
    return presentations[slot.status]
}

function errorText(
    code: FProxyPoolErrorCode,
    t: (key: string, fallback?: string) => string,
): string {
    return t(`settings.fproxyPool.errors.${code}`, t('settings.fproxyPool.errors.request_failed'))
}

function PoolSummary({
    configured,
    ready,
    inUse,
    capacity,
}: {
    configured: number
    ready: number
    inUse: number
    capacity: number
}) {
    const { t } = useI18n()
    return (
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge tone="slate">
                {replaceTokens(t('settings.fproxyPool.summaryConfigured'), { count: configured })}
            </Badge>
            <Badge tone="emerald">
                {replaceTokens(t('settings.fproxyPool.summaryReady'), { count: ready })}
            </Badge>
            <Badge tone="blue">
                {replaceTokens(t('settings.fproxyPool.summaryInUse'), { count: inUse })}
            </Badge>
            <span className="text-xs font-medium text-[#6f697c] dark:text-[#c8c0d8]">
                {replaceTokens(t('settings.fproxyPool.availableCapacity'), { count: capacity })}
            </span>
        </div>
    )
}

function SecretInputRow({
    row,
    index,
    canRemove,
    onChange,
    onPaste,
    onRemove,
    inputRef,
}: {
    row: SecretRow
    index: number
    canRemove: boolean
    onChange: (value: string) => void
    onPaste: (event: ClipboardEvent<HTMLInputElement>) => void
    onRemove: () => void
    inputRef?: RefObject<HTMLInputElement>
}) {
    const { t } = useI18n()
    const inputId = `fproxy-secret-${row.id}`
    return (
        <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
                {replaceTokens(t('settings.fproxyPool.apiKeyNumber'), { number: index + 1 })}
            </label>
            <input
                ref={inputRef}
                id={inputId}
                type="password"
                value={row.value}
                onChange={event => onChange(event.target.value)}
                onPaste={onPaste}
                autoComplete="new-password"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-[16px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 text-sm text-[#17171f] dark:text-[#f0ecff] placeholder:text-[#908a9e] dark:placeholder:text-[#9a8fba] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/20"
                placeholder={replaceTokens(t('settings.fproxyPool.apiKeyPlaceholder'), {
                    number: index + 1,
                })}
            />
            {canRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#eceaf2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] text-[#6f697c] dark:text-[#c8c0d8] transition-colors hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8d74e8]/50"
                    aria-label={replaceTokens(t('settings.fproxyPool.removeDraftKey'), {
                        number: index + 1,
                    })}
                >
                    <X className="h-4 w-4" />
                </button>
            )}
        </div>
    )
}

function FProxySlotRow({
    slot,
    now,
}: {
    slot: FProxySlotPublicDto
    now: number
}) {
    const { t } = useI18n()
    const snapshot = useFProxyPoolStore(state => state.snapshot)
    const action = useFProxyPoolStore(state => state.actionBySlot[slot.id])
    const testSlot = useFProxyPoolStore(state => state.testSlot)
    const setEnabled = useFProxyPoolStore(state => state.setEnabled)
    const removeSlot = useFProxyPoolStore(state => state.removeSlot)
    const offset = getFProxyPoolServerOffset(snapshot)
    const rotateInRaw = getFProxyRemainingSeconds(slot.nextRotateAt, offset, now)
    const cooldownSec = getFProxyCooldownSeconds(slot.cooldownUntil, offset, now)
    // waiting_time only; reject mirrored time_die values (>5 min).
    const rotateIn = (() => {
        const raw = Math.max(rotateInRaw, cooldownSec)
        return raw > 300 ? 0 : raw
    })()
    const ipLeft = getFProxyRemainingSeconds(slot.ipExpiresAt, offset, now)
    const labels = {
        disabled: t('settings.fproxyPool.status.disabled'),
        idle: t('settings.fproxyPool.status.ready'),
        testing: t('settings.fproxyPool.status.testing'),
        rotating: t('settings.fproxyPool.status.rotating'),
        leased: t('settings.fproxyPool.status.inUse'),
        cooldown: t('settings.fproxyPool.status.cooldown'),
        error: t('settings.fproxyPool.status.error'),
    }
    const presentation = statusPresentation(slot, labels)
    const StatusIcon = presentation.Icon
    const busy = action !== undefined || slot.status === 'testing' || slot.status === 'rotating'
    const removeBlocked = slot.status === 'leased' || slot.status === 'rotating'

    const handleRemove = async () => {
        if (removeBlocked) return
        const confirmed = window.confirm(
            replaceTokens(t('settings.fproxyPool.removeConfirm'), { label: slot.label }),
        )
        if (confirmed) await removeSlot(slot.id)
    }

    return (
        <li className="rounded-[18px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] p-3.5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                            {slot.label}
                        </span>
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                            presentation.tone === 'emerald' ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                                : presentation.tone === 'amber' ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                                    : presentation.tone === 'rose' ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
                                        : presentation.tone === 'blue' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                                            : presentation.tone === 'cyan' ? 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-300'
                                                : presentation.tone === 'violet' ? 'bg-[#f4f0ff] dark:bg-[#2a2540] text-[#735bd6]'
                                                    : 'bg-[#f4f1fa] dark:bg-[#2a2540] text-[#5f5a6d] dark:text-[#c8c0d8]'
                        }`}>
                            <StatusIcon className={`h-3.5 w-3.5 ${
                                slot.status === 'testing' || slot.status === 'rotating'
                                    ? 'motion-safe:animate-spin'
                                    : ''
                            }`} />
                            {presentation.label}
                        {(slot.status === 'cooldown' || rotateIn > 0) && ` · xoay ${formatFProxyCountdown(rotateIn)}`}
                        {ipLeft > 0 && ` ? IP ${formatFProxyCountdown(ipLeft)}`}
                        </span>
                        {slot.hasSecret && (
                            <span className="inline-flex items-center gap-1 text-xs text-[#6f697c] dark:text-[#c8c0d8]">
                                <KeyRound className="h-3.5 w-3.5" />
                                {t('settings.fproxyPool.secretStored')}
                            </span>
                        )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#6f697c] dark:text-[#c8c0d8]">
                        {slot.currentEgress && (
                            <span>
                                IP <span className="font-mono text-[#24222c] dark:text-[#f0ecff]">{slot.currentEgress.ip}</span>
                                {slot.currentEgress.location ? ` · ${slot.currentEgress.location}` : ''}
                            </span>
                        )}
                        {slot.leaseOwner && (
                            <span>
                                {replaceTokens(t('settings.fproxyPool.leasedByThread'), {
                                    thread: slot.leaseOwner.threadId,
                                })}
                            </span>
                        )}
                        {slot.lastTest && (
                            <span>
                                {t('settings.fproxyPool.lastTest')}{' '}
                                {new Date(slot.lastTest).toLocaleString()}
                            </span>
                        )}
                    </div>
                    {slot.error && (
                        <p className="mt-1.5 text-xs font-medium text-rose-700 dark:text-rose-300" role="status">
                            {slot.error}
                        </p>
                    )}
                    {removeBlocked && (
                        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
                            {t('settings.fproxyPool.removeBlocked')}
                        </p>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <button
                        type="button"
                        onClick={() => void testSlot(slot.id)}
                        disabled={busy || !slot.enabled || slot.status === 'leased'}
                        className={`${actionButtonClass} border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] text-[#5f5a6d] dark:text-[#c8c0d8] hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a]`}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            {action === 'testing'
                                ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                                : <RefreshCw className="h-4 w-4" />}
                            {t('settings.fproxyPool.testSlot')}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => void setEnabled(slot.id, !slot.enabled)}
                        disabled={busy || slot.status === 'leased'}
                        aria-pressed={slot.enabled}
                        className={`${actionButtonClass} border ${
                            slot.enabled
                                ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
                                : 'border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] text-[#5f5a6d] dark:text-[#c8c0d8] hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a]'
                        }`}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            {slot.enabled
                                ? <PauseCircle className="h-4 w-4" />
                                : <PlayCircle className="h-4 w-4" />}
                            {slot.enabled
                                ? t('settings.fproxyPool.disable')
                                : t('settings.fproxyPool.enable')}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleRemove()}
                        disabled={busy || removeBlocked}
                        className={`${actionButtonClass} border border-rose-100 dark:border-rose-900/50 bg-white dark:bg-[#1e1b2e] text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40`}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            {action === 'removing'
                                ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
                                : <Trash2 className="h-4 w-4" />}
                            {t('settings.fproxyPool.remove')}
                        </span>
                    </button>
                </div>
            </div>
        </li>
    )
}

export function FProxyPoolSettings() {
    const { t } = useI18n()
    const snapshot = useFProxyPoolStore(state => state.snapshot)
    const loading = useFProxyPoolStore(state => state.loading)
    const adding = useFProxyPoolStore(state => state.adding)
    const testingAll = useFProxyPoolStore(state => state.testingAll)
    const policySaving = useFProxyPoolStore(state => state.policySaving)
    const error = useFProxyPoolStore(state => state.error)
    const load = useFProxyPoolStore(state => state.load)
    const addSlots = useFProxyPoolStore(state => state.addSlots)
    const updatePolicy = useFProxyPoolStore(state => state.updatePolicy)
    const testAll = useFProxyPoolStore(state => state.testAll)
    const refreshAll = useFProxyPoolStore(state => state.refreshAll)
    const subscribe = useFProxyPoolStore(state => state.subscribe)
    const clearError = useFProxyPoolStore(state => state.clearError)
    const [label, setLabel] = useState('')
    const [secretRows, setSecretRows] = useState<SecretRow[]>([{ id: 1, value: '' }])
    const [nextSecretId, setNextSecretId] = useState(2)
    const [now, setNow] = useState(Date.now())
    const [resultMessage, setResultMessage] = useState('')
    const firstSecretRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        void load()
        const unsubscribe = subscribe()
        const refreshInterval = window.setInterval(() => void refreshAll(), 30_000)
        return () => {
            unsubscribe()
            window.clearInterval(refreshInterval)
        }
    }, [load, refreshAll, subscribe])

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1_000)
        return () => window.clearInterval(timer)
    }, [])

    const stats = useMemo(() => {
        const slots = snapshot?.slots || []
        return {
            configured: slots.length,
            ready: slots.filter(slot => slot.enabled && slot.status === 'idle').length,
            inUse: slots.filter(slot => slot.enabled && slot.status === 'leased').length,
        }
    }, [snapshot])

    const updateSecret = (id: number, value: string) => {
        setSecretRows(rows => rows.map(row => row.id === id ? { ...row, value } : row))
    }

    const handleSecretPaste = (id: number, event: ClipboardEvent<HTMLInputElement>) => {
        const pasted = splitPastedKeys(event.clipboardData.getData('text'))
        if (pasted.length <= 1) return
        event.preventDefault()
        const inserted = pasted.map((value, index) => ({ id: nextSecretId + index, value }))
        setSecretRows(rows => rows.flatMap(row => row.id === id ? inserted : [row]))
        setNextSecretId(value => value + inserted.length)
    }

    const addSecretRow = () => {
        setSecretRows(rows => [...rows, { id: nextSecretId, value: '' }])
        setNextSecretId(value => value + 1)
    }

    const handleAdd = async (event: FormEvent) => {
        event.preventDefault()
        const keys = secretRows.map(row => row.value.trim()).filter(Boolean)
        if (keys.length === 0) {
            firstSecretRef.current?.focus()
            return
        }

        const start = snapshot?.slots.length || 0
        const baseLabel = label.trim()
        const drafts = keys.map((apiKey, index) => ({
            apiKey,
            enabled: true,
            label: keys.length === 1 && baseLabel
                ? baseLabel
                : `${baseLabel || t('settings.fproxyPool.defaultSlotLabel')} ${start + index + 1}`,
        }))

        setSecretRows([{ id: nextSecretId, value: '' }])
        setNextSecretId(value => value + 1)
        setLabel('')
        setResultMessage('')
        const result = await addSlots(drafts)
        setResultMessage(
            replaceTokens(t('settings.fproxyPool.addResult'), {
                added: result.added,
                failed: result.failed,
            }),
        )
        window.setTimeout(() => firstSecretRef.current?.focus(), 0)
    }

    const handlePolicy = (patch: Partial<FProxyPoolPolicy>) => {
        if (!snapshot) return
        void updatePolicy({ ...snapshot.policy, ...patch })
    }

    return (
        <section
            className="rounded-[20px] border border-[#e6e0fb] dark:border-[#3d3558] bg-[#faf8ff] dark:bg-[#2a2540] p-4"
            aria-labelledby="fproxy-pool-title"
            aria-busy={loading || adding || testingAll || policySaving}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="h-5 w-5 text-[#735bd6]" aria-hidden="true" />
                        <h3 id="fproxy-pool-title" className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                            {t('settings.fproxyPool.title')}
                        </h3>
                    </div>
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[#6f697c] dark:text-[#c8c0d8]">
                        {t('settings.fproxyPool.description')}
                    </p>
                </div>
                <PrimaryButton
                    variant="quiet"
                    icon={testingAll ? Loader2 : RefreshCw}
                    onClick={() => void testAll()}
                    disabled={testingAll || !snapshot?.slots.some(slot => slot.enabled)}
                    className={`min-h-11 shrink-0 ${testingAll ? '[&_svg]:animate-spin' : ''}`}
                >
                    {testingAll
                        ? t('settings.fproxyPool.testingAll')
                        : t('settings.fproxyPool.testAll')}
                </PrimaryButton>
            </div>

            <div className="mt-3">
                <PoolSummary
                    configured={stats.configured}
                    ready={stats.ready}
                    inUse={stats.inUse}
                    capacity={snapshot?.capacity || 0}
                />
            </div>

            {error && (
                <AlertBanner
                    type="error"
                    className="mt-3"
                    onDismiss={clearError}
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <span>{errorText(error, t)}</span>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="min-h-11 rounded-full px-3 font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
                        >
                            {t('settings.fproxyPool.retry')}
                        </button>
                    </div>
                </AlertBanner>
            )}

            <form onSubmit={handleAdd} className="mt-4 border-t border-[#e9e4f2] dark:border-[#3d3558] pt-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)]">
                    <div>
                        <label htmlFor="fproxy-slot-label" className="mb-1.5 block text-xs font-semibold text-[#5f5a6d] dark:text-[#c8c0d8]">
                            {t('settings.fproxyPool.label')}
                        </label>
                        <input
                            id="fproxy-slot-label"
                            type="text"
                            value={label}
                            onChange={event => setLabel(event.target.value)}
                            maxLength={100}
                            className="h-11 w-full rounded-[16px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 text-sm text-[#17171f] dark:text-[#f0ecff] placeholder:text-[#908a9e] dark:placeholder:text-[#9a8fba] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/20"
                            placeholder={t('settings.fproxyPool.labelPlaceholder')}
                        />
                        <p className="mt-1 text-xs leading-relaxed text-[#8e899b] dark:text-[#9a8fba]">
                            {t('settings.fproxyPool.labelHint')}
                        </p>
                    </div>
                    <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[#5f5a6d] dark:text-[#c8c0d8]">
                                {t('settings.fproxyPool.apiKeys')}
                            </span>
                            <button
                                type="button"
                                onClick={addSecretRow}
                                className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-semibold text-[#735bd6] hover:bg-[#f0ecfb] dark:hover:bg-[#352f4a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8d74e8]/50"
                            >
                                <Plus className="h-4 w-4" />
                                {t('settings.fproxyPool.addAnother')}
                            </button>
                        </div>
                        <div className="space-y-2">
                            {secretRows.map((row, index) => (
                                <SecretInputRow
                                    key={row.id}
                                    row={row}
                                    index={index}
                                    canRemove={secretRows.length > 1}
                                    onChange={value => updateSecret(row.id, value)}
                                    onPaste={event => handleSecretPaste(row.id, event)}
                                    onRemove={() => setSecretRows(rows => rows.filter(item => item.id !== row.id))}
                                    inputRef={index === 0 ? firstSecretRef : undefined}
                                />
                            ))}
                        </div>
                        <p id="fproxy-secret-hint" className="mt-1.5 text-xs leading-relaxed text-[#8e899b] dark:text-[#9a8fba]">
                            {t('settings.fproxyPool.secretHint')}
                        </p>
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-[#8e899b] dark:text-[#9a8fba]" aria-live="polite">
                        {resultMessage}
                    </span>
                    <PrimaryButton
                        type="submit"
                        icon={adding ? Loader2 : Plus}
                        disabled={adding || secretRows.every(row => !row.value.trim())}
                        className={`min-h-11 ${adding ? '[&_svg]:animate-spin' : ''}`}
                    >
                        {adding
                            ? t('settings.fproxyPool.adding')
                            : t('settings.fproxyPool.addSlots')}
                    </PrimaryButton>
                </div>
            </form>

            <fieldset className="mt-4 border-t border-[#e9e4f2] dark:border-[#3d3558] pt-4" disabled={!snapshot || policySaving}>
                <legend className="text-xs font-semibold uppercase tracking-wide text-[#6f697c] dark:text-[#c8c0d8]">
                    {t('settings.fproxyPool.policyTitle')}
                </legend>
                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-[16px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] p-3.5">
                    <input
                        type="checkbox"
                        checked={snapshot?.policy.strictUnique || false}
                        onChange={event => handlePolicy({ strictUnique: event.target.checked })}
                        className="mt-0.5 h-5 w-5 rounded border-[#d8d1e8] dark:border-[#3d3558] text-[#8d74e8] focus:ring-[#8d74e8]"
                    />
                    <span>
                        <span className="block text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                            {t('settings.fproxyPool.strictUnique')}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-[#6f697c] dark:text-[#c8c0d8]">
                            {t('settings.fproxyPool.strictUniqueDesc')}
                        </span>
                    </span>
                </label>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {(['rotate_per_visit', 'sticky_session'] as const).map(policy => (
                        <label
                            key={policy}
                            className={`flex cursor-pointer items-start gap-3 rounded-[16px] border p-3.5 transition-colors ${
                                snapshot?.policy.rotationPolicy === policy
                                    ? 'border-[#cbbff3] dark:border-[#735bd6] bg-[#f4f0ff] dark:bg-[#2a2540]'
                                    : 'border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] hover:bg-[#faf8ff] dark:hover:bg-[#2a2540]'
                            }`}
                        >
                            <input
                                type="radio"
                                name="fproxy-rotation-policy"
                                value={policy}
                                checked={snapshot?.policy.rotationPolicy === policy}
                                onChange={() => handlePolicy({ rotationPolicy: policy })}
                                className="mt-0.5 h-5 w-5 border-[#d8d1e8] dark:border-[#3d3558] text-[#8d74e8] focus:ring-[#8d74e8]"
                            />
                            <span>
                                <span className="block text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                                    {t(`settings.fproxyPool.policy.${policy}`)}
                                </span>
                                <span className="mt-0.5 block text-xs leading-relaxed text-[#6f697c] dark:text-[#c8c0d8]">
                                    {t(`settings.fproxyPool.policy.${policy}Desc`)}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <div className="mt-4 border-t border-[#e9e4f2] dark:border-[#3d3558] pt-4">
                {loading && !snapshot ? (
                    <div className="space-y-2" role="status" aria-label={t('settings.fproxyPool.loading')}>
                        {[0, 1].map(index => (
                            <div key={index} className="h-20 animate-pulse rounded-[18px] bg-[#eeebf5] dark:bg-[#2a2540] motion-reduce:animate-none" />
                        ))}
                    </div>
                ) : snapshot && snapshot.slots.length > 0 ? (
                    <ul className="space-y-2" aria-label={t('settings.fproxyPool.slotList')}>
                        {snapshot.slots.map(slot => (
                            <FProxySlotRow key={slot.id} slot={slot} now={now} />
                        ))}
                    </ul>
                ) : (
                    <div className="rounded-[18px] border border-dashed border-[#dcd5eb] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 py-7 text-center">
                        <KeyRound className="mx-auto h-6 w-6 text-[#8d74e8]" />
                        <p className="mt-2 text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                            {t('settings.fproxyPool.empty')}
                        </p>
                        <p className="mt-1 text-xs text-[#6f697c] dark:text-[#c8c0d8]">
                            {t('settings.fproxyPool.emptyHint')}
                        </p>
                    </div>
                )}
            </div>
        </section>
    )
}
