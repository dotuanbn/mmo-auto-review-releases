import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Flame, Loader2, XCircle } from 'lucide-react'
import type { AccountWarmupStatus, WarmupActivityType } from './types'
import { WARMUP_ACTIVITY_OPTIONS, WARMUP_DAILY_CAP } from './types'
import { formatWarmupDate, isWarmupCooldownActive } from './formatWarmup'

type Translate = (key: string, fallback?: string) => string

export function WarmupActions({
    status,
    disabled,
    actionLoading,
    apiAvailable,
    t,
    onStart,
    onCancel,
}: {
    status: AccountWarmupStatus
    disabled?: boolean
    actionLoading?: boolean
    apiAvailable: boolean
    t: Translate
    onStart: (activityType: WarmupActivityType) => void
    onCancel: () => void
}) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)

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
                className="text-[10px] text-[#908a9e]"
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

    if (running) {
        return (
            <button
                type="button"
                disabled={busy}
                onClick={() => onCancel()}
                className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50"
            >
                {actionLoading
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <XCircle className="h-3 w-3" />}
                {t('accounts.warmup.cancel', 'Cancel')}
            </button>
        )
    }

    return (
        <div ref={rootRef} className="relative inline-block">
            <button
                type="button"
                disabled={startBlocked}
                title={startTitle}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full border border-[#e9e4f2] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#5f5a6d] transition-colors hover:border-[#cbbff3] hover:bg-[#f4f1fa] hover:text-[#17171f] disabled:opacity-50"
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
                <div className="absolute right-0 z-40 mt-1 min-w-[140px] overflow-hidden rounded-[12px] border border-[#e9e4f2] bg-white py-1 shadow-[0_12px_28px_rgba(27,24,38,0.14)]">
                    {WARMUP_ACTIVITY_OPTIONS.map((opt) => (
                        <button
                            key={opt.type}
                            type="button"
                            disabled={busy}
                            className="flex w-full items-center px-3 py-2 text-left text-xs font-medium text-[#5f5a6d] hover:bg-[#f4f1fa] hover:text-[#17171f] disabled:opacity-50"
                            onClick={() => {
                                setOpen(false)
                                onStart(opt.type)
                            }}
                        >
                            {t(opt.labelKey, opt.fallback)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
