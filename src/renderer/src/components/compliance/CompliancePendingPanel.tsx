import { AlertCircle } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Panel, PrimaryButton } from '../ui/surface'
import { formatComplianceTimestamp } from './api'
import type { PendingReviewSubmission } from './types'
import { COMPLIANCE_PANEL_MAX } from './types'

interface CompliancePendingPanelProps {
    pending: PendingReviewSubmission[]
    actingId: string | null
    onApprove: (requestId: string) => void
    onReject: (requestId: string) => void
    maxItems?: number
}

export function CompliancePendingPanel({
    pending,
    actingId,
    onApprove,
    onReject,
    maxItems = COMPLIANCE_PANEL_MAX,
}: CompliancePendingPanelProps) {
    const { t } = useI18n()

    if (pending.length === 0) {
        return null
    }

    const visible = pending.slice(0, maxItems)
    const remaining = pending.length - visible.length

    return (
        <Panel tone="amber" className="space-y-3 p-4" key="compliance-pending-panel">
            <div className="flex flex-wrap items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                    {t('compliance.pendingTitle', 'Manual review submit approvals pending')} (
                    {pending.length})
                </div>
            </div>
            <div className="space-y-2">
                {visible.map((request) => {
                    const busy = actingId === request.requestId
                    const locationLabel = request.locationName || request.locationUrl
                    return (
                        <div
                            key={request.requestId}
                            className="rounded-[14px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white/70 dark:bg-[#2a2540] p-3"
                        >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-[#17171f] dark:text-[#f0ecff]" title={locationLabel}>
                                        {locationLabel}
                                    </div>
                                    <div className="mt-1 break-all text-xs text-[#908a9e] dark:text-[#9a8fba]">
                                        {request.locationUrl}
                                    </div>
                                    <div className="mt-1 text-xs text-[#908a9e] dark:text-[#9a8fba]">
                                        {request.accountEmail ||
                                            t('compliance.unknownAccount', 'Unknown account')}{' '}
                                        · {t('compliance.thread', 'Thread')} #
                                        {request.threadId ?? '—'}
                                        {request.campaignId != null && (
                                            <>
                                                {' '}
                                                · {t('compliance.campaign', 'Campaign')} #
                                                {request.campaignId}
                                            </>
                                        )}
                                        {' · '}
                                        {t('compliance.created', 'created')}{' '}
                                        {formatComplianceTimestamp(request.createdAt)}
                                    </div>
                                    {request.reason && (
                                        <div className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/80">
                                            {t('compliance.reason', 'Reason')}: {request.reason}
                                        </div>
                                    )}
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <PrimaryButton
                                        tone="emerald"
                                        onClick={() => onApprove(request.requestId)}
                                        disabled={busy}
                                        className="!px-3 !py-1.5 !text-xs"
                                    >
                                        {t('compliance.approve', 'Approve')}
                                    </PrimaryButton>
                                    <PrimaryButton
                                        tone="rose"
                                        onClick={() => onReject(request.requestId)}
                                        disabled={busy}
                                        className="!px-3 !py-1.5 !text-xs"
                                    >
                                        {t('compliance.reject', 'Reject')}
                                    </PrimaryButton>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
            {remaining > 0 && (
                <p className="text-xs text-amber-700/80 dark:text-amber-300/80">
                    {t('compliance.morePending', '+{n} more pending').replace(
                        '{n}',
                        String(remaining)
                    )}
                </p>
            )}
        </Panel>
    )
}
