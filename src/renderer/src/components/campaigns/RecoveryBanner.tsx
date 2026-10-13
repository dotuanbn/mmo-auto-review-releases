/**
 * Crash recovery banner for Review Campaigns.
 * Shows pending durable jobs + candidate campaigns with manual Resume only (never auto-start).
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Play, RefreshCw } from 'lucide-react'
import {
    hasPendingRecoveryWork,
    listResumeCandidateIds,
    type RecoveryReportDto,
} from '../../../../shared/automation-contracts'
import { AlertBanner, PrimaryButton } from '../ui/surface'
import { useI18n } from '../../i18n'

export interface RecoveryCampaignLabel {
    id: number
    name: string
}

export interface RecoveryBannerProps {
    report: RecoveryReportDto | null
    campaigns: RecoveryCampaignLabel[]
    loading?: boolean
    resumingId?: number | null
    disabled?: boolean
    onResume: (campaignId: number) => void | Promise<void>
    onRefresh?: () => void | Promise<void>
}

function campaignLabel(
    campaignId: number,
    campaigns: RecoveryCampaignLabel[],
    unknownLabel: string,
): string {
    const found = campaigns.find((c) => c.id === campaignId)
    return found?.name ?? `${unknownLabel} #${campaignId}`
}

function pendingForCampaign(report: RecoveryReportDto, campaignId: number): number {
    const zombie = report.zombieCampaigns.find((z) => z.campaignId === campaignId)
    if (zombie) return zombie.pendingJobs
    // When only pendingCampaignIds is set, show global total only once or leave 0
    return 0
}

export function RecoveryBanner({
    report,
    campaigns,
    loading = false,
    resumingId = null,
    disabled = false,
    onResume,
    onRefresh,
}: RecoveryBannerProps) {
    const { t } = useI18n()
    const [dismissed, setDismissed] = useState(false)

    const candidateIds = useMemo(() => listResumeCandidateIds(report), [report])
    const visible = hasPendingRecoveryWork(report) && !dismissed

    if (!visible || !report) return null

    const title = t(
        'campaigns.recoveryTitle',
        'Crash recovery — pending review jobs detected',
    )
    const subtitle = t(
        'campaigns.recoverySubtitle',
        'Automation did not auto-start. Resume a campaign only when you are ready.',
    )
    const pendingLabel = t('campaigns.recoveryPendingJobs', 'Pending jobs')
    const candidatesLabel = t('campaigns.recoveryCandidates', 'Resume candidates')
    const requeuedLabel = t('campaigns.recoveryRequeued', 'Requeued running jobs')
    const resumeLabel = t('campaigns.recoveryResume', 'Resume')
    const resumingLabel = t('campaigns.recoveryResuming', 'Resuming…')
    const refreshLabel = t('campaigns.recoveryRefresh', 'Refresh recovery')
    const unknownCampaign = t('campaigns.recoveryUnknownCampaign', 'Campaign')
    const noNameHint = t(
        'campaigns.recoveryManualHint',
        'Each resume starts only that campaign’s pending jobs.',
    )

    return (
        <AlertBanner
            type="warning"
            title={title}
            onDismiss={() => setDismissed(true)}
            className="flex-col sm:flex-row"
        >
            <div className="space-y-3">
                <p className="text-sm opacity-90">{subtitle}</p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {pendingLabel}:{' '}
                        <strong className="tabular-nums">{report.totalPendingJobs}</strong>
                    </span>
                    <span className="text-[#5f5a6d] dark:text-[#c8c0d8]">
                        {candidatesLabel}:{' '}
                        <strong className="tabular-nums">{candidateIds.length}</strong>
                    </span>
                    {report.requeuedRunningJobs && report.requeuedRunningCount > 0 && (
                        <span className="text-[#5f5a6d] dark:text-[#c8c0d8]">
                            {requeuedLabel}:{' '}
                            <strong className="tabular-nums">{report.requeuedRunningCount}</strong>
                        </span>
                    )}
                </div>

                <p className="text-xs opacity-75">{noNameHint}</p>

                <ul className="flex flex-col gap-2 sm:gap-2">
                    {candidateIds.map((id) => {
                        const name = campaignLabel(id, campaigns, unknownCampaign)
                        const pending = pendingForCampaign(report, id)
                        const isResuming = resumingId === id
                        return (
                            <li
                                key={id}
                                className="flex flex-col gap-2 rounded-[14px] border border-amber-200/80 bg-white/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900/40 dark:bg-[#2a2540]"
                            >
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-[#17171f] dark:text-inherit" title={name}>
                                        {name}
                                    </div>
                                    <div className="text-xs opacity-75">
                                        ID {id}
                                        {pending > 0 ? (
                                            <>
                                                {' · '}
                                                {pendingLabel}: {pending}
                                            </>
                                        ) : null}
                                    </div>
                                </div>
                                <PrimaryButton
                                    icon={Play}
                                    tone="emerald"
                                    disabled={disabled || loading || isResuming}
                                    onClick={() => void onResume(id)}
                                    className="!w-full !px-3 !py-1.5 !text-xs sm:!w-auto"
                                >
                                    {isResuming ? resumingLabel : resumeLabel}
                                </PrimaryButton>
                            </li>
                        )
                    })}
                </ul>

                {onRefresh && (
                    <div className="pt-1">
                        <PrimaryButton
                            variant="quiet"
                            icon={RefreshCw}
                            disabled={loading}
                            onClick={() => void onRefresh()}
                            className={`!px-3 !py-1.5 !text-xs ${loading ? 'animate-pulse' : ''}`}
                        >
                            {refreshLabel}
                        </PrimaryButton>
                    </div>
                )}
            </div>
        </AlertBanner>
    )
}
