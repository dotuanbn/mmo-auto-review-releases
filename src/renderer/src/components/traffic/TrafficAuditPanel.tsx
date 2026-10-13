import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { useI18n } from '../../i18n'
import {
    AlertBanner,
    EmptyState,
    IconButton,
    Panel,
    SectionPanel,
} from '../ui/surface'
import { AuditQualityCards } from './AuditQualityCards'
import { FailureBucketsPanel } from './FailureBucketsPanel'
import { SampleLogsPanel } from './SampleLogsPanel'
import { useTrafficAuditData } from './useTrafficAuditData'

interface TrafficAuditPanelProps {
    campaignId: number | null
    /** Disable fetch when parent tab is not active */
    enabled?: boolean
    /** Compact header label for Monitor vs Reports */
    variant?: 'reports' | 'monitor'
}

export function TrafficAuditPanel({
    campaignId,
    enabled = true,
    variant = 'reports',
}: TrafficAuditPanelProps) {
    const { t } = useI18n()
    const {
        state,
        audit,
        sampleLogs,
        totalLogCount,
        errorMessage,
        isRefreshing,
        lastFetchedAt,
        refresh,
    } = useTrafficAuditData({ campaignId, enabled })

    const title = variant === 'monitor'
        ? t('traffic.audit.monitorTitle', 'Live quality & failures')
        : t('traffic.audit.title', 'Traffic quality audit')

    const subtitle = variant === 'monitor'
        ? t('traffic.audit.monitorSubtitle', 'Audit snapshot for the running campaign (manual refresh)')
        : t('traffic.audit.subtitle', 'Quality score, countable estimate, failure buckets, and sample logs')

    if (!campaignId) {
        return (
            <EmptyState
                icon={ShieldAlert}
                title={t('traffic.audit.noCampaign', 'Select a campaign')}
                subtitle={t('traffic.audit.noCampaignHint', 'Pick a campaign to inspect quality and failures')}
            />
        )
    }

    return (
        <div className="space-y-4">
            <SectionPanel icon={ShieldAlert} title={title} tone="violet">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-[#6f697c] dark:text-[#c8c0d8]">{subtitle}</p>
                    <div className="flex items-center gap-2">
                        {lastFetchedAt && (
                            <span className="text-[11px] text-[#908a9e] dark:text-[#9a8fba]">
                                {t('traffic.audit.updatedAt', 'Updated')}{' '}
                                {new Date(lastFetchedAt).toLocaleTimeString('vi-VN')}
                            </span>
                        )}
                        <IconButton
                            icon={isRefreshing ? Loader2 : RefreshCw}
                            label={t('traffic.audit.refresh', 'Refresh audit')}
                            onClick={() => {
                                void refresh(true)
                            }}
                            disabled={isRefreshing}
                            className={isRefreshing ? '[&_svg]:animate-spin' : undefined}
                        />
                    </div>
                </div>

                {errorMessage && (
                    <div className="mb-3">
                        <AlertBanner type="error" title={t('traffic.audit.error', 'Could not load audit')}>
                            {errorMessage}
                        </AlertBanner>
                    </div>
                )}

                {state === 'loading' && (
                    <Panel tone="slate" className="flex items-center justify-center gap-2 !p-8 text-sm text-[#6f697c] dark:text-[#c8c0d8]">
                        <Loader2 className="h-5 w-5 animate-spin text-[#8d74e8]" />
                        {t('traffic.audit.loading', 'Loading quality audit…')}
                    </Panel>
                )}

                {state === 'error' && !audit && (
                    <EmptyState
                        icon={ShieldAlert}
                        title={t('traffic.audit.error', 'Could not load audit')}
                        subtitle={errorMessage || t('traffic.audit.errorHint', 'Try refresh or re-select the campaign')}
                    />
                )}

                {state === 'empty' && (
                    <EmptyState
                        icon={ShieldAlert}
                        title={t('traffic.audit.empty', 'No audit data yet')}
                        subtitle={t('traffic.audit.emptyHint', 'Run visits first, then refresh this panel')}
                    />
                )}

                {state === 'ready' && audit && (
                    <div className="space-y-4">
                        <AuditQualityCards audit={audit} />

                        {audit.summary.length > 0 && (
                            <Panel tone="slate" className="!p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#6f697c] dark:text-[#c8c0d8]">
                                    {t('traffic.audit.summary', 'Summary')}
                                </div>
                                <ul className="space-y-1 text-sm text-[#3f3a4d] dark:text-[#c8c0d8]">
                                    {audit.summary.map((line, index) => (
                                        <li key={`${index}-${line.slice(0, 24)}`} className="break-words">
                                            • {line}
                                        </li>
                                    ))}
                                </ul>
                            </Panel>
                        )}
                    </div>
                )}

                {state === 'ready' && !audit && sampleLogs.length > 0 && (
                    <Panel tone="amber" className="!p-3 text-sm text-amber-800 dark:text-amber-300">
                        {t('traffic.audit.partialLogsOnly', 'Audit summary unavailable; showing sample logs only')}
                    </Panel>
                )}
            </SectionPanel>

            {(state === 'ready' || state === 'empty') && (
                <>
                    <FailureBucketsPanel issues={audit?.issues ?? null} />
                    <SampleLogsPanel logs={sampleLogs} totalLogCount={totalLogCount} />
                </>
            )}
        </div>
    )
}
