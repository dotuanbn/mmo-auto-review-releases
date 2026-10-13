import { Badge } from '../ui/surface'
import type { AccountWarmupStatus } from './types'
import { deriveWarmupTier } from './types'
import { levelTone, tierDescription, tierLabel, tierTone } from './formatWarmup'

type Translate = (key: string, fallback?: string) => string

type WarmupStatusExtras = AccountWarmupStatus & {
    birthStoryCompleted?: boolean
}

export function WarmupBadges({
    status,
    t,
}: {
    status: AccountWarmupStatus
    t: Translate
}) {
    const tier = deriveWarmupTier(status.level)
    const tierTitle = `${tierLabel(tier, t)} — ${tierDescription(tier, t)}`
    const extras = status as WarmupStatusExtras
    const birthStoryDay = status.birthStoryDay ?? 0
    const birthStoryCompleted = Boolean(extras.birthStoryCompleted)
    const showBirthStory = birthStoryDay > 0 && !birthStoryCompleted
    const birthDayShown = Math.min(birthStoryDay, 7)
    const birthStoryLabel = t('accounts.warmup.birthStoryDay', 'Day {{day}}/7').replace(
        '{{day}}',
        String(birthDayShown),
    )
    const birthStoryTitle = t(
        'accounts.warmup.birthStoryDayTitle',
        'Birth story day {{day}} of 7',
    ).replace('{{day}}', String(birthDayShown))

    return (
        <div className="flex flex-wrap items-center gap-1">
            <span title={t('accounts.warmup.level', 'Level')}>
                <Badge tone={levelTone(status.level)}>
                    {t('accounts.warmup.levelShort', 'Lv')} {Math.round(status.level)}
                </Badge>
            </span>
            <span title={t('accounts.warmup.reputation', 'Reputation')}>
                <Badge tone="slate">
                    {t('accounts.warmup.repShort', 'Rep')} {Math.round(status.reputation)}
                </Badge>
            </span>
            <span title={t('accounts.warmup.sessions', 'Sessions')}>
                <Badge tone="blue">
                    {Math.round(status.sessions)} {t('accounts.warmup.sessionsShort', 'sess')}
                </Badge>
            </span>
            <span title={tierTitle}>
                <Badge tone={tierTone(tier)} dot>
                    {tierLabel(tier, t)}
                </Badge>
            </span>
            {showBirthStory && (
                <span title={birthStoryTitle}>
                    <Badge tone="violet">{birthStoryLabel}</Badge>
                </span>
            )}
        </div>
    )
}
