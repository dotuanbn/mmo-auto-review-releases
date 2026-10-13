import { ProgressBar, StatusPill } from '../ui/surface'

export interface WarmupTierCounts {
    blocked: number
    throttled: number
    ready: number
}

export interface AccountHealthData {
    active: number
    avgWarmupLevel: number
    tiers: WarmupTierCounts
    birthStoryCompletionPercent: number
    autoWarmupEnabled: number
}

/** Three horizontal bars, one per warmup gate tier. Thresholds match the review gate. */
export function TierBars({ tiers }: { tiers: WarmupTierCounts }) {
    const total = Math.max(0, tiers.blocked) + Math.max(0, tiers.throttled) + Math.max(0, tiers.ready)
    const rows: Array<{ label: string; hint: string; value: number; tone: 'rose' | 'amber' | 'emerald' }> = [
        { label: 'Blocked', hint: 'level < 25', value: tiers.blocked, tone: 'rose' },
        { label: 'Throttled', hint: 'level 25–54', value: tiers.throttled, tone: 'amber' },
        { label: 'Ready', hint: 'level ≥ 55', value: tiers.ready, tone: 'emerald' },
    ]

    return (
        <div className="space-y-3">
            {rows.map((row) => (
                <div key={row.label} className="rounded-[16px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-[#625d70] dark:text-[#c8c0d8]">
                        <span>{row.label}</span>
                        <span className="font-medium text-[#9a95a7] dark:text-[#9a8fba]">
                            {formatCount(row.value)} · {row.hint}
                        </span>
                    </div>
                    <ProgressBar value={Math.max(0, row.value)} max={Math.max(total, 1)} tone={row.tone} showLabel />
                </div>
            ))}
        </div>
    )
}

export function AccountHealthPanel({ accounts }: { accounts: AccountHealthData }) {
    const birth = clampPercent(accounts.birthStoryCompletionPercent)

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_0.8fr]">
            <div className="animate-slide-up" style={{ animationDelay: '0ms', animationFillMode: 'backwards' }}>
                <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Warmup tiers</h3>
                <p className="mt-0.5 mb-3 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">
                    {formatCount(accounts.active)} active · avg warmup {formatLevel(accounts.avgWarmupLevel)}
                </p>
                <TierBars tiers={accounts.tiers} />
            </div>
            <div className="flex flex-col gap-3">
                <div className="animate-slide-up rounded-[18px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 py-4" style={{ animationDelay: '70ms', animationFillMode: 'backwards' }}>
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Birth story</h3>
                        <span className="text-sm font-semibold tabular-nums text-[#24222c] dark:text-[#f0ecff]">{Math.round(birth)}%</span>
                    </div>
                    <p className="mt-0.5 mb-3 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">Accounts that finished the 7-day story</p>
                    <ProgressBar value={birth} max={100} tone="violet" showLabel />
                </div>
                <div className="animate-slide-up flex items-center justify-between gap-3 rounded-[18px] border border-[#ece7f5] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 py-4" style={{ animationDelay: '140ms', animationFillMode: 'backwards' }}>
                    <div>
                        <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Auto warmup</h3>
                        <p className="mt-0.5 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">Scheduler enabled on the account</p>
                    </div>
                    <StatusPill tone={accounts.autoWarmupEnabled > 0 ? 'emerald' : 'slate'}>
                        {formatCount(accounts.autoWarmupEnabled)} enabled
                    </StatusPill>
                </div>
            </div>
        </div>
    )
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, value))
}

function formatCount(value: number): string {
    return Math.round(Number.isFinite(value) ? value : 0).toLocaleString()
}

function formatLevel(value: number): string {
    if (!Number.isFinite(value)) return '0'
    const rounded = Math.round(value * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
