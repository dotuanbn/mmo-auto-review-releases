import { AlertTriangle, Check, ExternalLink, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { formatComplianceTimestamp } from './api'
import type { PendingReviewSubmission } from './types'
import { COMPLIANCE_BANNER_MAX } from './types'

interface ComplianceBannerProps {
    pending: PendingReviewSubmission[]
    actingId: string | null
    onApprove: (requestId: string) => void
    onReject: (requestId: string) => void
    onOpenCampaigns: () => void
    maxItems?: number
}

/**
 * Global shell banner: pending badge + compact approve/reject + deep-link to Campaigns.
 */
export function ComplianceBanner({
    pending,
    actingId,
    onApprove,
    onReject,
    onOpenCampaigns,
    maxItems = COMPLIANCE_BANNER_MAX,
}: ComplianceBannerProps) {
    const { t } = useI18n()

    if (pending.length === 0) {
        return null
    }

    const visible = pending.slice(0, maxItems)

    return (
        <div
            className="border-b border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 sm:px-5"
            role="status"
            aria-live="polite"
        >
            <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex min-w-0 items-start gap-2">
                    <span className="mt-0.5 inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white">
                        {pending.length}
                    </span>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                            <span className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                                {t(
                                    'compliance.bannerTitle',
                                    'Compliance: manual review submit pending'
                                )}
                            </span>
                        </div>
                        <ul className="mt-1.5 space-y-1.5">
                            {visible.map((item) => {
                                const busy = actingId === item.requestId
                                const locationLabel = item.locationName || item.locationUrl
                                const accountLabel = item.accountEmail || t('compliance.unknownAccount', 'Unknown account')
                                const metaLabel = [
                                    accountLabel,
                                    formatComplianceTimestamp(item.createdAt),
                                    item.expiresAt
                                        ? `${t('compliance.expires', 'expires')} ${formatComplianceTimestamp(item.expiresAt)}`
                                        : null,
                                ].filter(Boolean).join(' · ')
                                return (
                                    <li
                                        key={item.requestId}
                                        className="flex flex-col gap-1.5 rounded-xl border border-amber-200/80 dark:border-amber-900/40 bg-white/80 dark:bg-[#2a2540] px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate text-xs font-medium text-[#17171f] dark:text-[#f0ecff]" title={locationLabel}>
                                                {locationLabel}
                                            </p>
                                            <p className="truncate text-[11px] text-[#908a9e] dark:text-[#9a8fba]" title={metaLabel}>
                                                {accountLabel}
                                                {' · '}
                                                {formatComplianceTimestamp(item.createdAt)}
                                                {item.expiresAt && (
                                                    <>
                                                        {' · '}
                                                        {t('compliance.expires', 'expires')}{' '}
                                                        {formatComplianceTimestamp(item.expiresAt)}
                                                    </>
                                                )}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1.5">
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => onApprove(item.requestId)}
                                                className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
                                            >
                                                <Check className="h-3 w-3" />
                                                {t('compliance.approve', 'Approve')}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => onReject(item.requestId)}
                                                className="inline-flex items-center gap-1 rounded-full bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-400 disabled:opacity-50"
                                            >
                                                <X className="h-3 w-3" />
                                                {t('compliance.reject', 'Reject')}
                                            </button>
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={onOpenCampaigns}
                    className="inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-full border border-amber-300 dark:border-amber-800/60 bg-white dark:bg-[#1e1b2e] px-3 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-200 shadow-sm transition hover:bg-amber-100 dark:hover:bg-amber-950/40"
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('compliance.openCampaigns', 'Open Campaigns')}
                </button>
            </div>
        </div>
    )
}
