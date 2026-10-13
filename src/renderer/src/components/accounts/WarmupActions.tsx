import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Flame, Loader2, XCircle } from 'lucide-react'
import type { AccountWarmupStatus, WarmupActivityType } from './types'
import { WARMUP_ACTIVITY_OPTIONS, WARMUP_DAILY_CAP } from './types'
import { formatWarmupDate, isWarmupCooldownActive } from './formatWarmup'
import { Toggle } from '../ui/surface'

type Translate = (key: string, fallback?: string) => string

type WarmupStatusExtras = AccountWarmupStatus & {
    autoWarmupEnabled?: boolean
}

function readAutoWarmupEnabled(status: AccountWarmupStatus, explicit?: boolean): boolean {
    if (typeof explicit === 'boolean') return explicit
    return Boolean((status as WarmupStatusExtras).autoWarmupEnabled)
}

function activityOptionLabel(
    opt: { type: WarmupActivityType; labelKey: string; fallback: string },
    t: Translate,
): string {
    if (opt.type === 'gmail') {
        return t('accounts.warmup.activityGmail', opt.fallback || 'Gmail')
    }
    if (opt.type === 'photos_browse') {
        return t(
            'accounts.warmup.activityPhotosBrowse',
            t('accounts.warmup.activityPhotos', opt.fallback || 'Photos'),
        )
    }
    return t(opt.labelKey, opt.fallback)
}

async function invokeToggleAutoWarmup(accountId: number, enabled: boolean): Promise<void> {
    const warmup = window.electronAPI?.warmup as
        | { toggleAutoWarmup?: (id: number, enabled: boolean) => Promise<void> }
        | undefined
    if (typeof warmup?.toggleAutoWarmup !== 'function') {
        throw new Error('toggleAutoWarmup is not available')
    }
    await warmup.toggleAutoWarmup(accountId, enabled)
}

export function WarmupActions({
    status,
    disabled,
    actionLoading,
    apiAvailable,
    t,
    onStart,
    onCancel,
    autoWarmupEnabled,
    onToggleAutoWarmup,
}: {
    status: AccountWarmupStatus
    disabled?: boolean
    actionLoading?: boolean
    apiAvailable: boolean
    t: Translate
    onStart: (activityType: WarmupActivityType) => void
    onCancel: () => void
    autoWarmupEnabled?: boolean
    onToggleAutoWarmup?: (enabled: boolean) => void | Promise<void>
}) {
    const [open, setOpen] = useState(false)
    const [autoEnabled, setAutoEnabled] = useState(() => readAutoWarmupEnabled(status, autoWarmupEnabled))
    const [autoBusy, setAutoBusy] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const pendingAutoRef = useRef<boolean | null>(null)
    const incomingAuto = readAutoWarmupEnabled(status, autoWarmupEnabled)

    useEffect(() => {
        if (pendingAutoRef.current !== null && incomingAuto !== pendingAutoRef.current) return
        pendingAutoRef.current = null
        setAutoEnabled(incomingAuto)
    }, [incomingAuto, status.accountId])

    useEffect(() => {
        if (!open) return
        const onDoc = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDoc)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    if (!apiAvailable) {
        return (
            <span
                className="text-[10px] text-[#908a9e] dark:text-[#9a8fba]"
                title={t('accounts.warmup.apiUnavailable', 'Warmup API not available')}
            >
                {t('accounts.warmup.apiUnavailableShort', 'N/A')}
            </span>
        )
    }

    const busy = Boolean(actionLoading || disabled)
    const running = status.state === 'running'
    const cooldownActive = isWarmupCooldownActive(status.nextActivityAt)
    const never = t('accounts.warmup.never', 'Never')
    const nextLabel = formatWarmupDate(status.nextActivityAt, never)
    const startBlocked = busy || cooldownActive
    const startTitle = cooldownActive
        ? t('accounts.warmup.cooldownUntil', 'Cooldown until {{time}}').replace('{{time}}', nextLabel)
        : t(
            'accounts.warmup.dailyCapHint',
            'Max {{cap}} warmup sessions per day',
        ).replace('{{cap}}', String(WARMUP_DAILY_CAP))

    const handleToggleAuto = async (next: boolean) => {
        if (autoBusy || busy) return
        setAutoBusy(true)
        pendingAutoRef.current = next
        setAutoEnabled(next)
        try {
            if (onToggleAutoWarmup) await onToggleAutoWarmup(next)
            else await invokeToggleAutoWarmup(status.accountId, next)
        } catch {
            pendingAutoRef.current = null
            setAutoEnabled(!next)
        } finally {
            setAutoBusy(false)
        }
    }

    const autoToggle = (
        <label
            className="inline-flex items-center gap-1"
            title={t('accounts.warmup.autoWarmupHint', 'Automatically run daily warmup')}
        >
            <Toggle
                size="sm"
                checked={autoEnabled}
                disabled={autoBusy || busy}
                onChange={handleToggleAuto}
            />
            <span className="whitespace-nowrap text-[10px] font-semibold text-[#5f5a6d] dark:text-[#c8c0d8]">
                {t('accounts.warmup.autoWarmup', 'Auto Warmup')}
            </span>
        </label>
    )

    if (running) {
        return (
            <div className="flex flex-wrap items-center gap-1.5">
                {autoToggle}
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onCancel()}
                    className="inline-flex items-center gap-1 rounded-full border border-rose-200 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300 transition-colors hover:bg-rose-100 dark:hover:bg-rose-950/60 disabled:opacity-50"
                >
                    {actionLoading
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <XCircle className="h-3 w-3" />}
                    {t('accounts.warmup.cancel', 'Cancel')}
                </button>
            </div>
        )
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {autoToggle}
            <div ref={rootRef} className="relative inline-block">
                <button
                    type="button"
                    disabled={startBlocked}
                    title={startTitle}
                    onClick={() => setOpen((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-full border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-2.5 py-1 text-[11px] font-semibold text-[#5f5a6d] dark:text-[#c8c0d8] transition-colors hover:border-[#cbbff3] dark:hover:border-[#735bd6] hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a] hover:text-[#17171f] dark:hover:text-[#f0ecff] disabled:opacity-50"
                >
                    {actionLoading
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Flame className="h-3 w-3 text-[#8d74e8]" />}
                    {cooldownActive
                        ? t('accounts.warmup.cooldown', 'Cooldown')
                        : t('accounts.warmup.start', 'Start Warmup')}
                    {!cooldownActive && <ChevronDown className="h-3 w-3 opacity-70" />}
                </button>
                {open && !cooldownActive && (
                    <div className="animate-fade-in absolute right-0 z-40 mt-1 min-w-[140px] overflow-hidden rounded-[12px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] py-1 shadow-[0_12px_28px_rgba(27,24,38,0.14)]">
                        {WARMUP_ACTIVITY_OPTIONS.map((opt) => (
                            <button
                                key={opt.type}
                                type="button"
                                disabled={busy}
                                className="flex w-full items-center px-3 py-2 text-left text-xs font-medium text-[#5f5a6d] dark:text-[#c8c0d8] hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a] hover:text-[#17171f] dark:hover:text-[#f0ecff] disabled:opacity-50"
                                onClick={() => {
                                    setOpen(false)
                                    onStart(opt.type)
                                }}
                            >
                                {activityOptionLabel(opt, t)}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
