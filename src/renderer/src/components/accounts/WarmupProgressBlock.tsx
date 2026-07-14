import { ProgressBar } from '../ui/surface'
import type { AccountWarmupStatus } from './types'
import { WARMUP_DAILY_CAP, deriveWarmupTier } from './types'
import {
    activityLabel,
    formatWarmupDate,
    isWarmupCooldownActive,
    mapWarmupErrorMessage,
    runStateLabel,
    tierDescription,
} from './formatWarmup'

type Translate = (key: string, fallback?: string) => string

export function WarmupProgressBlock({
    status,
    t,
}: {
    status: AccountWarmupStatus
    t: Translate
}) {
    const never = t('accounts.warmup.never', 'Never')
    const isRunning = status.state === 'running'
    const value = isRunning ? status.progress : status.level
    const tone = status.state === 'failed' ? 'rose' : isRunning ? 'blue' : 'violet'
    const cooldownActive = isWarmupCooldownActive(status.nextActivityAt)
    const nextLabel = formatWarmupDate(status.nextActivityAt, never)
    const tier = deriveWarmupTier(status.level)
    const friendlyError = mapWarmupErrorMessage(status.error, t)

    return (
        <div className="min-w-[140px] max-w-[220px] space-y-1">
            <div className="flex items-center justify-between gap-2 text-[10px] font-medium text-[#908a9e]">
                <span className="truncate" title={tierDescription(tier, t)}>
                    {runStateLabel(status.state, t)}
                    {isRunning && status.activityType
                        ? ` · ${activityLabel(status.activityType, t)}`
                        : ''}
                </span>
                <span className="shrink-0 tabular-nums">{Math.round(value)}%</span>
            </div>
            <ProgressBar value={value} max={100} tone={tone} size="sm" />
            <div className="flex flex-col gap-0.5 text-[10px] leading-tight text-[#908a9e] sm:flex-row sm:flex-wrap sm:gap-x-2">
                <span className="truncate" title={formatWarmupDate(status.lastActivityAt, never)}>
                    {t('accounts.warmup.last', 'Last')}: {formatWarmupDate(status.lastActivityAt, never)}
                </span>
                <span
                    className={
                        cooldownActive
                            ? 'truncate font-semibold text-amber-700'
                            : 'truncate'
                    }
                    title={
                        cooldownActive
                            ? t(
                                'accounts.warmup.cooldownUntil',
                                'Cooldown until {{time}}',
                            ).replace('{{time}}', nextLabel)
                            : nextLabel
                    }
                >
                    {cooldownActive
                        ? `${t('accounts.warmup.cooldown', 'Cooldown')}: ${nextLabel}`
                        : `${t('accounts.warmup.next', 'Next')}: ${nextLabel}`}
                </span>
            </div>
            <p
                className="truncate text-[10px] leading-tight text-[#a39db3]"
                title={t(
                    'accounts.warmup.dailyCapHint',
                    'Max {{cap}} warmup sessions per day',
                ).replace('{{cap}}', String(WARMUP_DAILY_CAP))}
            >
                {t('accounts.warmup.dailyCapShort', 'Daily cap: {{cap}}/day').replace(
                    '{{cap}}',
                    String(WARMUP_DAILY_CAP),
                )}
            </p>
            {friendlyError && (
                <p
                    className="truncate text-[10px] text-rose-600"
                    title={friendlyError}
                >
                    {friendlyError}
                </p>
            )}
        </div>
    )
}
