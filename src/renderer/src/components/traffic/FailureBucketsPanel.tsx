import { AlertTriangle } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Badge, EmptyState, Panel, SectionPanel } from '../ui/surface'
import { buildFailureBuckets, sumFailureBuckets } from './failureBuckets'
import type { TrafficAuditIssues } from './types'

const BUCKET_FALLBACKS: Record<string, string> = {
    'traffic.audit.buckets.captchaBlocked': 'CAPTCHA blocked',
    'traffic.audit.buckets.watchdogTimeout': 'Watchdog timeout',
    'traffic.audit.buckets.loginGate': 'Login gate',
    'traffic.audit.buckets.proxyErrors': 'Proxy errors',
    'traffic.audit.buckets.navigationErrors': 'Navigation errors',
    'traffic.audit.buckets.browserCrashes': 'Browser crashes',
    'traffic.audit.buckets.otherErrors': 'Other errors',
}

export function FailureBucketsPanel({ issues }: { issues: TrafficAuditIssues | null }) {
    const { t } = useI18n()
    const buckets = buildFailureBuckets(issues)
    const total = sumFailureBuckets(buckets)

    return (
        <SectionPanel
            icon={AlertTriangle}
            title={t('traffic.audit.failureBuckets', 'Failure buckets')}
            tone="rose"
        >
            {buckets.length === 0 ? (
                <EmptyState
                    icon={AlertTriangle}
                    title={t('traffic.audit.noFailures', 'No classified failures')}
                    subtitle={t('traffic.audit.noFailuresHint', 'Failed visits will appear here by root-cause bucket')}
                />
            ) : (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#6f697c]">
                        <span>{t('traffic.audit.failureTotal', 'Classified failures')}</span>
                        <Badge tone="rose">{total}</Badge>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {buckets.map(bucket => {
                            const pct = total > 0 ? Math.round((bucket.count / total) * 100) : 0
                            return (
                                <Panel key={bucket.key} tone={bucket.tone} className="!p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-semibold text-[#17171f]">
                                                {t(bucket.i18nKey, BUCKET_FALLBACKS[bucket.i18nKey] || bucket.key)}
                                            </div>
                                            <div className="mt-1 text-[11px] text-[#6f697c]">{pct}%</div>
                                        </div>
                                        <div className="text-lg font-bold text-[#17171f]">{bucket.count}</div>
                                    </div>
                                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70">
                                        <div
                                            className="h-full rounded-full bg-current opacity-60"
                                            style={{ width: `${Math.max(pct, 4)}%` }}
                                        />
                                    </div>
                                </Panel>
                            )
                        })}
                    </div>
                </div>
            )}
        </SectionPanel>
    )
}
