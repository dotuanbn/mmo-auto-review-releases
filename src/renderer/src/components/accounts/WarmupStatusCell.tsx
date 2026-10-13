import type { PublicAccount } from '../../../../shared/account-contracts'
import type { AccountWarmupStatus, WarmupActivityType } from './types'
import { deriveWarmupFromAccount } from './formatWarmup'
import { WarmupBadges } from './WarmupBadges'
import { WarmupProgressBlock } from './WarmupProgressBlock'
import { WarmupActions } from './WarmupActions'

type Translate = (key: string, fallback?: string) => string

export function WarmupStatusCell({
    account,
    status,
    apiAvailable,
    actionLoading,
    t,
    onStart,
    onCancel,
}: {
    account: PublicAccount
    status: AccountWarmupStatus | undefined
    apiAvailable: boolean
    actionLoading?: boolean
    t: Translate
    onStart: (accountId: number, activityType: WarmupActivityType) => void
    onCancel: (accountId: number) => void
}) {
    const base = status ?? deriveWarmupFromAccount(account)
    const resolved = {
        ...base,
        birthStoryDay: base.birthStoryDay ?? account.birthStoryDay,
        birthStoryCompleted: account.birthStoryCompleted,
        autoWarmupEnabled: account.autoWarmupEnabled,
    }

    return (
        <div className="flex min-w-[200px] max-w-[320px] flex-col gap-2 py-0.5 sm:min-w-[240px]">
            <WarmupBadges status={resolved} t={t} />
            <WarmupProgressBlock status={resolved} t={t} />
            <WarmupActions
                status={resolved}
                apiAvailable={apiAvailable}
                actionLoading={actionLoading}
                t={t}
                autoWarmupEnabled={Boolean(account.autoWarmupEnabled)}
                onStart={(activityType) => onStart(account.id, activityType)}
                onCancel={() => onCancel(account.id)}
            />
        </div>
    )
}
