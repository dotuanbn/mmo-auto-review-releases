import { Clock, Percent, Activity } from 'lucide-react'
import { Panel, ProgressBar, Sparkline } from '../ui/surface'

export interface DiscoveryCounts {
    organic: number
    direct: number
    captchaCooldown: number
}

export interface TrafficOverviewData {
    totalVisits: number
    successVisits: number
    sparkline30d: number[]
    avgQualityScore: number
    organicPercent: number
    avgDurationSeconds: number
    successRate: number
    discovery: DiscoveryCounts
}

/**
 * Circular quality gauge. Conic-gradient is the one inline style Tailwind cannot express.
 * Pattern matches the previous Dashboard speed ring (score / 100 * 360deg).
 */
export function QualityGauge({ score }: { score: number }) {
    const clamped = clampPercent(score)
    const degrees = clamped * 3.6

    return (
        <div
            className="grid h-36 w-36 place-items-center rounded-full [--gauge-track:#ece7f5] dark:[--gauge-track:#3d3558]"
            style={{ background: `conic-gradient(#10b981 ${degrees}deg, var(--gauge-track, #ece7f5) 0deg)` }}
            role="img"
            aria-label={`Quality score ${Math.round(clamped)} out of 100`}
        >
            <div className="grid h-[108px] w-[108px] place-items-center rounded-full bg-white dark:bg-[#1e1b2e] text-center shadow-sm">
                <div>
                    <div className="text-3xl font-semibold leading-none text-[#24222c] dark:text-[#f0ecff]">{Math.round(clamped)}</div>
                    <div className="mt-1 text-[11px] font-medium text-[#8e899b] dark:text-[#9a8fba]">/ 100</div>
                </div>
            </div>
        </div>
    )
}

export function DiscoveryBreakdown({ discovery }: { discovery: DiscoveryCounts }) {
    const rows: Array<{ label: string; value: number; tone: 'emerald' | 'blue' | 'amber' }> = [
        { label: 'Organic', value: discovery.organic, tone: 'emerald' },
        { label: 'Direct', value: discovery.direct, tone: 'blue' },
        { label: 'Captcha cooldown', value: discovery.captchaCooldown, tone: 'amber' },
    ]
    const total = rows.reduce((sum, row) => sum + row.value, 0)
    const max = Math.max(total, 1)

    return (
        <div className="space-y-3">
            {rows.map((row) => (
                <div key={row.label}>
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-semibold text-[#625d70] dark:text-[#c8c0d8]">
                        <span>{row.label}</span>
                        <span className="tabular-nums text-[#8e899b] dark:text-[#9a8fba]">{formatCount(row.value)}</span>
                    </div>
                    <ProgressBar value={row.value} max={max} tone={row.tone} size="sm" showLabel />
                </div>
            ))}
        </div>
    )
}

export function TrafficOverviewPanel({ traffic }: { traffic: TrafficOverviewData }) {
    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="animate-slide-up h-full" style={{ animationDelay: '0ms', animationFillMode: 'backwards' }}>
            <Panel className="flex h-full flex-col gap-4 p-4" tone="slate">
                <div>
                    <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Quality score</h3>
                    <p className="mt-0.5 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">Average visit quality and how sessions were discovered</p>
                </div>
                <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5">
                    <QualityGauge score={traffic.avgQualityScore} />
                    <div className="text-center sm:text-left">
                        <div className="text-2xl font-semibold tabular-nums text-[#24222c] dark:text-[#f0ecff]">{Math.round(clampPercent(traffic.organicPercent))}%</div>
                        <div className="text-xs font-medium text-[#8e899b] dark:text-[#9a8fba]">organic share</div>
                    </div>
                </div>
                <DiscoveryBreakdown discovery={traffic.discovery} />
            </Panel>
            </div>

            <div className="animate-slide-up h-full" style={{ animationDelay: '70ms', animationFillMode: 'backwards' }}>
            <Panel className="flex h-full flex-col gap-4 p-4" tone="slate">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Traffic · 30 days</h3>
                        <p className="mt-0.5 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">Visit volume across the last month</p>
                    </div>
                    <Activity className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                </div>
                <div className="overflow-x-auto rounded-[18px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-3 py-4">
                    <Sparkline data={traffic.sparkline30d} tone="blue" width={440} height={96} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <TrafficStat icon={Clock} label="Avg duration" value={formatDuration(traffic.avgDurationSeconds)} />
                    <TrafficStat icon={Percent} label="Success rate" value={`${Math.round(clampPercent(traffic.successRate))}%`} />
                </div>
                <p className="text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">
                    {formatCount(traffic.successVisits)} successful of {formatCount(traffic.totalVisits)} visits
                </p>
            </Panel>
            </div>
        </div>
    )
}

function TrafficStat({
    icon: Icon,
    label,
    value,
}: {
    icon: typeof Clock
    label: string
    value: string
}) {
    return (
        <div className="rounded-[16px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-3 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#9a95a7] dark:text-[#9a8fba]">
                <Icon className="h-3.5 w-3.5" />
                {label}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-[#24222c] dark:text-[#f0ecff]">{value}</div>
        </div>
    )
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, value))
}

function formatCount(value: number): string {
    return Math.round(value).toLocaleString()
}

function formatDuration(seconds: number): string {
    const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0
    if (safe < 60) return `${safe}s`
    const minutes = Math.floor(safe / 60)
    const remainder = safe % 60
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}
