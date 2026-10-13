import { AlertTriangle } from 'lucide-react'
import { Badge, EmptyState, StatusPill } from '../ui/surface'

export interface RunningCampaignItem {
    id: string
    name: string
    status: string
    kind: 'review' | 'traffic'
}

export interface FailureCountItem {
    message: string
    count: number
}

export function CampaignActivityPanel({
    running,
    failures,
}: {
    running: RunningCampaignItem[]
    failures: FailureCountItem[]
}) {
    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="animate-slide-up" style={{ animationDelay: '0ms', animationFillMode: 'backwards' }}>
                <h3 className="mb-3 text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Running campaigns</h3>
                {running.length === 0 ? (
                    <EmptyState
                        icon={AlertTriangle}
                        title="No campaigns running"
                        subtitle="Start a review or traffic campaign to see it here."
                    />
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {running.map((campaign) => (
                            <StatusPill key={campaign.id} tone={campaign.status === 'paused' ? 'amber' : 'emerald'}>
                                {campaign.kind === 'traffic' ? 'Traffic' : 'Review'} · {campaign.name}
                            </StatusPill>
                        ))}
                    </div>
                )}
            </div>
            <div className="animate-slide-up" style={{ animationDelay: '70ms', animationFillMode: 'backwards' }}>
                <h3 className="mb-3 text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Recent failures</h3>
                {failures.length === 0 ? (
                    <EmptyState
                        icon={AlertTriangle}
                        title="No recent failures"
                        subtitle="Failed reviews and visits from the last 30 days show up here."
                    />
                ) : (
                    <ul className="space-y-2">
                        {failures.slice(0, 5).map((failure) => (
                            <li
                                key={failure.message}
                                className="flex items-start justify-between gap-3 rounded-[16px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-3 py-2.5"
                            >
                                <span className="min-w-0 text-sm font-medium leading-snug text-[#24222c] dark:text-[#f0ecff]">{failure.message}</span>
                                <Badge tone="rose" className="shrink-0 tabular-nums">{failure.count}</Badge>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    )
}
