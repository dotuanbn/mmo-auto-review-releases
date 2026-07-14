import { CheckCircle, Eye, Gauge, Target, TrendingUp } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Badge, Panel, ProgressBar, StatCard, StatRow } from '../ui/surface'
import type { TrafficAuditReport } from './types'

function qualityTone(score: number): 'emerald' | 'amber' | 'rose' | 'slate' {
    if (score >= 60) return 'emerald'
    if (score >= 40) return 'amber'
    if (score > 0) return 'rose'
    return 'slate'
}

export function AuditQualityCards({ audit }: { audit: TrafficAuditReport }) {
    const { t } = useI18n()
    const score = audit.quality.avgQualityScore
    const tone = qualityTone(score)

    return (
        <div className="space-y-3">
            <StatRow>
                <StatCard
                    icon={Gauge}
                    label={t('traffic.audit.avgQuality', 'Avg quality score')}
                    value={`${score}/100`}
                    tone={tone}
                />
                <StatCard
                    icon={Target}
                    label={t('traffic.audit.estimatedCountable', 'Est. Google countable')}
                    value={audit.quality.estimatedGoogleCountable}
                    tone="violet"
                />
                <StatCard
                    icon={TrendingUp}
                    label={t('traffic.audit.estimatedRate', 'Est. countable rate')}
                    value={`${audit.quality.estimatedGoogleRate}%`}
                    tone="blue"
                />
                <StatCard
                    icon={CheckCircle}
                    label={t('traffic.audit.successRate', 'App success rate')}
                    value={`${audit.successRate}%`}
                    tone="emerald"
                />
            </StatRow>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Panel tone="emerald" className="!p-3">
                    <div className="text-xs font-semibold text-emerald-700">
                        {t('traffic.audit.highQuality', 'High quality')}
                    </div>
                    <div className="mt-1 text-xl font-bold text-[#17171f]">{audit.quality.highQuality}</div>
                    <div className="mt-1 text-[11px] text-[#6f697c]">
                        {t('traffic.audit.highQualityHint', 'Likely counted by Google')}
                    </div>
                </Panel>
                <Panel tone="amber" className="!p-3">
                    <div className="text-xs font-semibold text-amber-700">
                        {t('traffic.audit.mediumQuality', 'Medium quality')}
                    </div>
                    <div className="mt-1 text-xl font-bold text-[#17171f]">{audit.quality.mediumQuality}</div>
                    <div className="mt-1 text-[11px] text-[#6f697c]">
                        {t('traffic.audit.mediumQualityHint', 'Partially countable (~50%)')}
                    </div>
                </Panel>
                <Panel tone="rose" className="!p-3">
                    <div className="text-xs font-semibold text-rose-700">
                        {t('traffic.audit.lowQuality', 'Low quality')}
                    </div>
                    <div className="mt-1 text-xl font-bold text-[#17171f]">{audit.quality.lowQuality}</div>
                    <div className="mt-1 text-[11px] text-[#6f697c]">
                        {t('traffic.audit.lowQualityHint', 'May not be counted')}
                    </div>
                </Panel>
            </div>

            <Panel tone="slate" className="!p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#24222c]">
                        <Eye className="h-4 w-4 text-[#8d74e8]" />
                        {t('traffic.audit.visitBreakdown', 'Visit breakdown')}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        <Badge tone="violet">
                            {t('traffic.audit.totalAttempted', 'Attempted')}: {audit.totalAttempted}
                        </Badge>
                        <Badge tone="emerald">
                            {t('traffic.audit.totalSuccess', 'Success')}: {audit.totalSuccess}
                        </Badge>
                        <Badge tone="rose">
                            {t('traffic.audit.totalFailed', 'Failed')}: {audit.totalFailed}
                        </Badge>
                    </div>
                </div>
                <ProgressBar value={score} tone={tone === 'slate' ? 'violet' : tone} />
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-[#6f697c]">
                    <span>
                        {t('traffic.audit.veryShortVisits', 'Very short visits')}: {audit.issues.veryShortVisits}
                    </span>
                    <span>
                        {t('traffic.audit.proxyRotatedVisits', 'Cut by proxy rotate')}: {audit.issues.proxyRotatedVisits}
                    </span>
                </div>
            </Panel>
        </div>
    )
}
