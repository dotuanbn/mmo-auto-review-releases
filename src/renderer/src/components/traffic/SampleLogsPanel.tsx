import { CheckCircle, FileText, XCircle } from 'lucide-react'
import { useI18n } from '../../i18n'
import { Badge, EmptyState, SectionPanel, StatusPill } from '../ui/surface'
import { formatLogTime } from './sampleLogs'
import type { TrafficLogRow } from './types'

function extractRetryCategory(log: TrafficLogRow): string | null {
    const actions = Array.isArray(log.actions) ? log.actions : []
    for (const action of actions) {
        if (action.retryCategory) {
            return action.retryCategory
        }
        if (action.action === 'visit_failure_classified' && typeof action.detail === 'string') {
            return action.detail
        }
    }
    return null
}

export function SampleLogsPanel({
    logs,
    totalLogCount,
}: {
    logs: TrafficLogRow[]
    totalLogCount: number
}) {
    const { t } = useI18n()

    return (
        <SectionPanel
            icon={FileText}
            title={t('traffic.audit.sampleLogs', 'Sample visit logs')}
            tone="violet"
        >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[#6f697c]">
                <span>
                    {t('traffic.audit.sampleLogsHint', 'Showing a bounded sample (failed-first), not full history')}
                </span>
                <Badge tone="violet">
                    {logs.length}/{totalLogCount}
                </Badge>
            </div>

            {logs.length === 0 ? (
                <EmptyState
                    icon={FileText}
                    title={t('traffic.audit.noSampleLogs', 'No visit logs yet')}
                    subtitle={t('traffic.audit.noSampleLogsHint', 'Logs appear after visits complete')}
                />
            ) : (
                <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                    {logs.map(log => {
                        const isSuccess = log.status === 'success'
                        const bucket = extractRetryCategory(log)
                        return (
                            <div
                                key={log.id}
                                className="rounded-[14px] border border-[#e9e4f2] bg-white p-3 text-sm"
                            >
                                <div className="flex items-start gap-2">
                                    {isSuccess ? (
                                        <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                                    ) : (
                                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-xs text-[#908a9e]">{formatLogTime(log.createdAt)}</span>
                                            <StatusPill tone={isSuccess ? 'emerald' : 'rose'}>
                                                {isSuccess
                                                    ? t('traffic.audit.statusSuccess', 'success')
                                                    : t('traffic.audit.statusFailed', 'failed')}
                                            </StatusPill>
                                            {bucket && <Badge tone="amber">{bucket}</Badge>}
                                            <Badge tone="slate">
                                                {t('traffic.audit.round', 'Round')} {log.round}
                                            </Badge>
                                            <Badge tone="violet">
                                                {t('traffic.audit.duration', 'Duration')} {log.duration}s
                                            </Badge>
                                        </div>
                                        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-[#5f5a6d]">
                                            <span className="truncate font-medium text-[#17171f]">
                                                {log.locationName || `Location #${log.locationId}`}
                                            </span>
                                            <span className="text-[#e9e4f2]">·</span>
                                            <span className="truncate">{log.accountEmail || 'Anonymous'}</span>
                                        </div>
                                        {log.errorMessage && (
                                            <div className="mt-1 break-words text-xs text-rose-600">
                                                {log.errorMessage}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </SectionPanel>
    )
}
