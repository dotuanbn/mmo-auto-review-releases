import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
    Activity,
    AlertTriangle,
    CheckCircle,
    Clock,
    Eye,
    EyeOff,
    Gauge,
    History,
    LayoutDashboard,
    Plus,
    RefreshCw,
    ShieldCheck,
    Star,
    Users,
    XCircle,
    Zap,
} from 'lucide-react'
import { type Page } from '../app/navigation'
import { AccountHealthPanel, type AccountHealthData } from '../components/dashboard/AccountHealthPanel'
import { CampaignActivityPanel, type FailureCountItem, type RunningCampaignItem } from '../components/dashboard/CampaignActivityPanel'
import { TrafficOverviewPanel, type DiscoveryCounts, type TrafficOverviewData } from '../components/dashboard/TrafficOverviewPanel'
import {
    AlertBanner,
    Badge,
    EmptyState,
    IconButton,
    IconFrame,
    PageHeader,
    PageShell,
    Panel,
    PrimaryButton,
    SectionPanel,
    Sparkline,
    StatCard,
    StatRow,
    StatusPill,
} from '../components/ui/surface'
import { useI18n } from '../i18n'

interface RecentReview {
    status?: string
    locationId?: number | string
    accountId?: number | string
    rating?: number
    createdAt?: string | number | Date
    locationName?: string
}

interface ReviewSurvivalStats {
    totalVerified: number
    liveCount: number
    removedCount: number
    pendingCount: number
    overallSurvivalRate: number
    avgSurvivalDays: number
    styledSurvivalRate: number
    unstyledSurvivalRate: number
    survivalByWarmupTier: {
        blocked: number
        throttled: number
        ready: number
    }
}

interface DashboardOverview {
    reviews: {
        reviewsThisMonth: number
        reviewsToday: number
        sparkline30d: number[]
        recent: RecentReview[]
    }
    traffic: TrafficOverviewData
    accounts: AccountHealthData
    campaigns: {
        running: RunningCampaignItem[]
        recentFailures: FailureCountItem[]
    }
    survival: ReviewSurvivalStats
}

interface DashboardProps {
    onNavigate?: (page: Page) => void
}

/** Dedicated overview endpoint when present; otherwise the same shape is built from existing IPC. */
interface DashboardBridge {
    api?: {
        dashboard?: {
            getOverview?: () => Promise<unknown>
        }
    }
    accounts?: {
        getAll?: () => Promise<unknown>
        getStats?: () => Promise<unknown>
    }
    reviews?: {
        getStats?: () => Promise<unknown>
        getAll?: () => Promise<unknown>
        getRecent?: (limit?: number) => Promise<unknown>
    }
    campaigns?: {
        getAll?: () => Promise<unknown>
        getRunning?: () => Promise<unknown>
    }
    trafficBoost?: {
        getCampaigns?: () => Promise<unknown>
        getLogs?: (campaignId: number) => Promise<unknown>
    }
}

const DAY_MS = 24 * 60 * 60 * 1000
const SPARKLINE_DAYS = 30
const FAILURE_WINDOW_DAYS = 30
/** Cap log reads so a large campaign library does not fan out unbounded IPC. */
const TRAFFIC_LOG_CAMPAIGN_CAP = 12
const WARMUP_BLOCKED_BELOW = 25
const WARMUP_READY_MIN_LEVEL = 55

const emptyDiscovery: DiscoveryCounts = { organic: 0, direct: 0, captchaCooldown: 0 }

function emptySurvival(): ReviewSurvivalStats {
    return {
        totalVerified: 0,
        liveCount: 0,
        removedCount: 0,
        pendingCount: 0,
        overallSurvivalRate: 0,
        avgSurvivalDays: 0,
        styledSurvivalRate: 0,
        unstyledSurvivalRate: 0,
        survivalByWarmupTier: { blocked: 0, throttled: 0, ready: 0 },
    }
}

const emptyOverview: DashboardOverview = {
    reviews: {
        reviewsThisMonth: 0,
        reviewsToday: 0,
        sparkline30d: flatSeries(),
        recent: [],
    },
    traffic: {
        totalVisits: 0,
        successVisits: 0,
        sparkline30d: flatSeries(),
        avgQualityScore: 0,
        organicPercent: 0,
        avgDurationSeconds: 0,
        successRate: 0,
        discovery: emptyDiscovery,
    },
    accounts: {
        active: 0,
        avgWarmupLevel: 0,
        tiers: { blocked: 0, throttled: 0, ready: 0 },
        birthStoryCompletionPercent: 0,
        autoWarmupEnabled: 0,
    },
    campaigns: {
        running: [],
        recentFailures: [],
    },
    survival: emptySurvival(),
}

export function Dashboard({ onNavigate }: DashboardProps) {
    const { t } = useI18n()
    const [stats, setStats] = useState<DashboardOverview | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const fetchData = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const overview = await loadDashboardOverview()
            setStats(overview)
        } catch (err) {
            const message = err instanceof Error && err.message ? err.message : 'Failed to load dashboard'
            setError(message)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void fetchData()
    }, [fetchData])

    const showSkeleton = loading && stats === null

    return (
        <PageShell>
            <PageHeader
                icon={LayoutDashboard}
                tone="violet"
                title={t('dashboard.title', 'Dashboard')}
                subtitle={t('dashboard.subtitle', 'Reviews, traffic, and account health')}
            >
                <IconButton icon={History} label="Review history" variant="dark" onClick={() => onNavigate?.('history')} />
                <PrimaryButton icon={RefreshCw} variant="quiet" onClick={() => void fetchData()} disabled={loading}>
                    {loading ? 'Refreshing' : 'Refresh'}
                </PrimaryButton>
                <PrimaryButton icon={Plus} onClick={() => onNavigate?.('campaigns')}>
                    Create campaign
                </PrimaryButton>
            </PageHeader>

            {error && (
                <AlertBanner type="error" title="Could not refresh dashboard" onDismiss={() => setError(null)}>
                    {error}
                </AlertBanner>
            )}

            {showSkeleton ? (
                <DashboardSkeleton />
            ) : stats === null ? (
                <EmptyState
                    icon={AlertTriangle}
                    title="Dashboard unavailable"
                    subtitle={error ?? 'No overview data was returned.'}
                    action={(
                        <PrimaryButton icon={RefreshCw} onClick={() => void fetchData()}>
                            Retry
                        </PrimaryButton>
                    )}
                />
            ) : (
                <div className="flex flex-col gap-4">
                    <TopMetrics stats={stats} />
                    <SectionPanel icon={Activity} title="Traffic overview" description="Quality, discovery source, and 30-day visit volume" tone="blue">
                        <TrafficOverviewPanel traffic={stats.traffic} />
                    </SectionPanel>
                    <SectionPanel icon={Users} title="Account health" description="Warmup gate, birth story, and auto warmup" tone="amber">
                        <AccountHealthPanel accounts={stats.accounts} />
                    </SectionPanel>
                    <SectionPanel icon={Zap} title="Campaign activity" description="Live campaigns and the errors that stopped work" tone="violet">
                        <CampaignActivityPanel running={stats.campaigns.running} failures={stats.campaigns.recentFailures} />
                    </SectionPanel>
                    <SectionPanel icon={ShieldCheck} title="Review survival" description="Live rate after verification, by style and warmup tier" tone="emerald">
                        <SurvivalPanel survival={stats.survival} />
                    </SectionPanel>
                    <RecentActivity reviews={stats.reviews.recent} />
                </div>
            )}
        </PageShell>
    )
}

function TopMetrics({ stats }: { stats: DashboardOverview }) {
    return (
        <StatRow className="!grid-cols-1 sm:!grid-cols-2 lg:!grid-cols-4 xl:!grid-cols-4">
            <StatCard
                icon={Star}
                tone="violet"
                label="Reviews this month"
                value={formatCount(stats.reviews.reviewsThisMonth)}
                subtext={metricSubtext(`+${formatCount(stats.reviews.reviewsToday)} today`, stats.reviews.sparkline30d, 'violet')}
            />
            <StatCard
                icon={Activity}
                tone="blue"
                label="Traffic visits"
                value={formatCount(stats.traffic.totalVisits)}
                subtext={metricSubtext(`${formatCount(stats.traffic.successVisits)} success`, stats.traffic.sparkline30d, 'blue')}
            />
            <StatCard
                icon={Gauge}
                tone="emerald"
                label="Quality score"
                value={`${Math.round(clamp(stats.traffic.avgQualityScore, 0, 100))}/100`}
                subtext={`${Math.round(clamp(stats.traffic.organicPercent, 0, 100))}% organic`}
            />
            <StatCard
                icon={Users}
                tone="amber"
                label="Active accounts"
                value={formatCount(stats.accounts.active)}
                subtext={`${formatLevel(stats.accounts.avgWarmupLevel)} avg warmup`}
            />
        </StatRow>
    )
}

function metricSubtext(label: string, series: number[], tone: 'violet' | 'blue'): ReactNode {
    return (
        <span className="mt-1 flex w-full items-end justify-between gap-3">
            <span>{label}</span>
            <Sparkline data={series} tone={tone} width={88} height={28} />
        </span>
    )
}

function SurvivalPanel({ survival }: { survival: ReviewSurvivalStats }) {
    const verified = nonNegative(survival.totalVerified)
    const live = nonNegative(survival.liveCount)
    const removed = nonNegative(survival.removedCount)
    const pending = nonNegative(survival.pendingCount)
    const overall = nonNegative(survival.overallSurvivalRate)
    const hasVerified = verified > 0
    const tierRows: Array<{ label: string; hint: string; rate: number; tone: 'rose' | 'amber' | 'emerald' }> = [
        { label: 'Blocked', hint: 'Warmup under 25', rate: nonNegative(survival.survivalByWarmupTier.blocked), tone: 'rose' },
        { label: 'Throttled', hint: 'Warmup 25–54', rate: nonNegative(survival.survivalByWarmupTier.throttled), tone: 'amber' },
        { label: 'Ready', hint: 'Warmup 55 or more', rate: nonNegative(survival.survivalByWarmupTier.ready), tone: 'emerald' },
    ]

    return (
        <div className="flex flex-col gap-4">
            <Panel className="p-4" tone="slate">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                        <IconFrame icon={ShieldCheck} tone="emerald" />
                        <div className="min-w-0">
                            <div className="text-4xl font-semibold tabular-nums leading-none tracking-tight text-[#17171f] dark:text-[#f0ecff]">
                                {formatPercent(overall)}
                            </div>
                            <div className="mt-2 text-sm font-medium text-[#6f697c] dark:text-[#c8c0d8]">Overall survival rate</div>
                            <div className="mt-1 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">
                                {hasVerified
                                    ? `${formatLevel(nonNegative(survival.avgSurvivalDays))} days average`
                                    : 'No verified reviews yet'}
                            </div>
                        </div>
                    </div>
                    <StatusPill tone={hasVerified ? survivalTone(overall) : 'slate'}>
                        {hasVerified ? `${formatCount(live)} of ${formatCount(verified)} live` : 'Awaiting checks'}
                    </StatusPill>
                </div>
            </Panel>

            <StatRow className="!grid-cols-1 sm:!grid-cols-2 lg:!grid-cols-4 xl:!grid-cols-4">
                <StatCard icon={ShieldCheck} tone="violet" label="Total verified" value={formatCount(verified)} />
                <StatCard icon={Eye} tone="emerald" label="Live" value={formatCount(live)} />
                <StatCard icon={EyeOff} tone="rose" label="Removed" value={formatCount(removed)} />
                <StatCard icon={Clock} tone="amber" label="Pending" value={formatCount(pending)} />
            </StatRow>

            <div>
                <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Style comparison</h3>
                <p className="mt-0.5 mb-3 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">
                    Styled reviews versus reviews left unstyled
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <SurvivalRateCard label="Styled" hint="Style applied" rate={nonNegative(survival.styledSurvivalRate)} tone="violet" />
                    <SurvivalRateCard label="Unstyled" hint="Style not applied" rate={nonNegative(survival.unstyledSurvivalRate)} tone="slate" />
                </div>
            </div>

            <div>
                <h3 className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">Survival by warmup tier</h3>
                <p className="mt-0.5 mb-3 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">
                    {hasVerified ? 'Share of verified reviews still live in each gate' : 'Rates stay at 0% until a review is verified'}
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {tierRows.map((row) => (
                        <SurvivalRateCard key={row.label} label={row.label} hint={row.hint} rate={row.rate} tone={row.tone} />
                    ))}
                </div>
            </div>
        </div>
    )
}

function SurvivalRateCard({
    label,
    hint,
    rate,
    tone,
}: {
    label: string
    hint: string
    rate: number
    tone: 'violet' | 'slate' | 'rose' | 'amber' | 'emerald'
}) {
    return (
        <Panel className="p-4" tone="slate">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">{label}</div>
                    <div className="mt-0.5 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">{hint}</div>
                </div>
                <Badge tone={tone}>{formatPercent(rate)}</Badge>
            </div>
        </Panel>
    )
}

function survivalTone(rate: number): 'emerald' | 'amber' | 'rose' {
    if (rate >= 70) return 'emerald'
    if (rate >= 40) return 'amber'
    return 'rose'
}

function RecentActivity({ reviews }: { reviews: RecentReview[] }) {
    return (
        <Panel className="p-5">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-lg font-semibold tracking-tight text-[#24222c] dark:text-[#f0ecff]">Recent activity</h2>
                    <p className="mt-0.5 text-xs font-medium text-[#9a95a7] dark:text-[#9a8fba]">Latest review results</p>
                </div>
                <StatusPill tone={reviews.length > 0 ? 'emerald' : 'slate'}>{reviews.length} items</StatusPill>
            </div>
            {reviews.length === 0 ? (
                <div className="mt-4">
                    <EmptyState
                        icon={Star}
                        title="No reviews yet"
                        subtitle="Start a campaign to see the latest review activity here."
                    />
                </div>
            ) : (
                <div className="mt-4 grid gap-2">
                    {reviews.map((review, index) => (
                        <ReviewRow key={`${review.locationId ?? 'loc'}-${review.accountId ?? 'acc'}-${index}`} review={review} />
                    ))}
                </div>
            )}
        </Panel>
    )
}

function ReviewRow({ review }: { review: RecentReview }) {
    const ok = review.status === 'success'
    const rating = clamp(review.rating ?? 0, 0, 5)
    const location = review.locationName?.trim() || (review.locationId != null ? `Location #${review.locationId}` : 'Location')

    const accent = ok ? 'border-l-emerald-500' : 'border-l-rose-500'

    return (
        <div className={`flex flex-col gap-3 rounded-[18px] border border-[#e9e4f2] dark:border-[#3d3558] border-l-4 bg-white dark:bg-[#1e1b2e] p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between ${accent}`}>
            <div className="flex min-w-0 items-center gap-3">
                <IconFrame icon={ok ? CheckCircle : XCircle} tone={ok ? 'emerald' : 'rose'} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">{location}</div>
                    <div className="text-xs text-[#9a95a7] dark:text-[#9a8fba]">
                        {review.accountId != null ? `Account #${review.accountId}` : 'Account'}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <StarRating rating={rating} />
                <Badge tone={ok ? 'emerald' : 'rose'}>{ok ? 'Success' : 'Failed'}</Badge>
                <span className="text-xs text-[#9a95a7] dark:text-[#9a8fba]">{formatReviewDate(review.createdAt)}</span>
            </div>
        </div>
    )
}

function StarRating({ rating }: { rating: number }) {
    return (
        <div className="flex" aria-label={`${rating} of 5 stars`}>
            {[1, 2, 3, 4, 5].map((star) => (
                <Star
                    key={star}
                    className={star <= rating ? 'h-3.5 w-3.5 fill-amber-400 text-amber-400' : 'h-3.5 w-3.5 text-[#d7d2e3] dark:text-[#4a4268]'}
                />
            ))}
        </div>
    )
}

function DashboardSkeleton() {
    return (
        <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="h-28 animate-pulse rounded-[24px] border border-[#eceaf2] dark:border-[#3d3558] bg-[#f4f1fa] dark:bg-[#2a2540]" />
                ))}
            </div>
            <div className="h-72 animate-pulse rounded-[24px] border border-[#eceaf2] dark:border-[#3d3558] bg-[#f4f1fa] dark:bg-[#2a2540]" />
            <div className="h-56 animate-pulse rounded-[24px] border border-[#eceaf2] dark:border-[#3d3558] bg-[#f4f1fa] dark:bg-[#2a2540]" />
            <div className="h-40 animate-pulse rounded-[24px] border border-[#eceaf2] dark:border-[#3d3558] bg-[#f4f1fa] dark:bg-[#2a2540]" />
            <div className="h-64 animate-pulse rounded-[24px] border border-[#eceaf2] dark:border-[#3d3558] bg-[#f4f1fa] dark:bg-[#2a2540]" />
        </div>
    )
}

async function loadDashboardOverview(): Promise<DashboardOverview> {
    const api = bridge()
    const getOverview = api.api?.dashboard?.getOverview
    if (typeof getOverview === 'function') {
        const overview = normalizeOverview(await getOverview())
        if (overview.reviews.recent.length === 0 && api.reviews?.getRecent) {
            const recent = await settle(api.reviews.getRecent(8), [])
            overview.reviews.recent = asArray(recent)
                .map(normalizeReview)
                .filter((row): row is RecentReview => row !== null)
                .slice(0, 8)
        }
        return overview
    }
    if (!api.reviews?.getStats && !api.accounts?.getAll && !api.accounts?.getStats) {
        throw new Error('Dashboard API is not available')
    }
    return assembleOverview(api)
}

function bridge(): DashboardBridge {
    if (typeof window === 'undefined' || !window.electronAPI) {
        return {}
    }
    return window.electronAPI as unknown as DashboardBridge
}

async function assembleOverview(api: DashboardBridge): Promise<DashboardOverview> {
    const [accountStats, accounts, reviewStats, recentReviews, allReviews, runningCampaigns, allCampaigns, trafficCampaigns] = await Promise.all([
        settle(api.accounts?.getStats?.(), null),
        settle(api.accounts?.getAll?.(), []),
        settle(api.reviews?.getStats?.(), null),
        settle(api.reviews?.getRecent?.(8), []),
        settle(api.reviews?.getAll?.(), []),
        settle(api.campaigns?.getRunning?.(), []),
        settle(api.campaigns?.getAll?.(), []),
        settle(api.trafficBoost?.getCampaigns?.(), []),
    ])

    const reviewRows = asArray(allReviews)
    const accountRows = asArray(accounts)
    const trafficRows = asArray(trafficCampaigns).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    const logs = await loadTrafficLogs(api, trafficRows)

    const reviewRecord = asRecord(reviewStats)
    const reviewsToday = reviewRecord ? readNumber(reviewRecord, ['reviewsToday', 'today']) : countTodaySuccess(reviewRows)
    const reviewsThisMonth = reviewRecord
        ? readNumber(reviewRecord, ['reviewsThisMonth', 'thisMonth'])
        : countMonthSuccess(reviewRows)

    const accountHealth = summarizeAccounts(accountRows, asRecord(accountStats))
    const traffic = summarizeTraffic(trafficRows, logs)
    const running = collectRunning(asArray(runningCampaigns), asArray(allCampaigns), trafficRows)
    const failures = topFailures([
        ...failureMessages(reviewRows),
        ...failureMessages(logs),
    ])

    return {
        reviews: {
            reviewsThisMonth,
            reviewsToday,
            sparkline30d: bucketLastDays(reviewRows, (row) => row.status === 'success'),
            recent: asArray(recentReviews).map(normalizeReview).filter((row): row is RecentReview => row !== null).slice(0, 8),
        },
        traffic,
        accounts: accountHealth,
        campaigns: {
            running,
            recentFailures: failures,
        },
        survival: emptySurvival(),
    }
}

async function loadTrafficLogs(api: DashboardBridge, campaigns: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const getLogs = api.trafficBoost?.getLogs
    if (!getLogs) return []

    const ranked = [...campaigns].sort((left, right) => readNumber(right, ['totalVisits', 'completedVisits']) - readNumber(left, ['totalVisits', 'completedVisits']))
    const sample = ranked.slice(0, TRAFFIC_LOG_CAMPAIGN_CAP)
    const groups = await Promise.all(sample.map(async (campaign) => {
        const id = positiveId(campaign.id)
        if (id === null) return []
        const logs = await settle(getLogs(id), [])
        return asArray(logs).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    }))
    return groups.flat()
}

function summarizeAccounts(rows: unknown[], stats: Record<string, unknown> | null): AccountHealthData {
    const records = rows.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    const activeRows = records.filter((row) => row.status === 'active')
    const warmupPool = activeRows.length > 0 ? activeRows : records
    const avgWarmupLevel = warmupPool.length === 0
        ? 0
        : warmupPool.reduce((sum, row) => sum + readNumber(row, ['warmupLevel', 'level']), 0) / warmupPool.length

    const tiers = { blocked: 0, throttled: 0, ready: 0 }
    for (const row of records) {
        const level = readNumber(row, ['warmupLevel', 'level'])
        if (level < WARMUP_BLOCKED_BELOW) tiers.blocked += 1
        else if (level < WARMUP_READY_MIN_LEVEL) tiers.throttled += 1
        else tiers.ready += 1
    }

    const completed = records.filter((row) => isEnabledFlag(row.birthStoryCompleted) || readNumber(row, ['birthStoryDay']) >= 7).length
    const birthStoryCompletionPercent = records.length === 0 ? 0 : (completed / records.length) * 100
    const autoWarmupEnabled = records.filter((row) => isEnabledFlag(row.autoWarmupEnabled)).length

    return {
        active: stats ? readNumber(stats, ['active']) : activeRows.length,
        avgWarmupLevel,
        tiers,
        birthStoryCompletionPercent,
        autoWarmupEnabled,
    }
}

function summarizeTraffic(campaigns: Record<string, unknown>[], logs: Record<string, unknown>[]): TrafficOverviewData {
    const totalFromCampaigns = campaigns.reduce((sum, row) => sum + readNumber(row, ['totalVisits']), 0)
    const successFromCampaigns = campaigns.reduce((sum, row) => sum + readNumber(row, ['completedVisits', 'successVisits']), 0)
    const failedFromCampaigns = campaigns.reduce((sum, row) => sum + readNumber(row, ['failedVisits']), 0)

    const successLogs = logs.filter((row) => row.status === 'success')
    const discovery = { organic: 0, direct: 0, captchaCooldown: 0 }
    let qualitySum = 0
    let qualityCount = 0
    let durationSum = 0

    for (const log of logs) {
        const source = typeof log.discoverySource === 'string' ? log.discoverySource : ''
        if (source === 'organic') discovery.organic += 1
        else if (source === 'direct' || source === 'direct_fallback') discovery.direct += 1
        else if (source === 'captcha_cooldown' || source === 'captcha') discovery.captchaCooldown += 1
    }

    for (const log of successLogs) {
        if (typeof log.qualityScore === 'number' && Number.isFinite(log.qualityScore)) {
            qualitySum += log.qualityScore
            qualityCount += 1
        }
        durationSum += readNumber(log, ['duration'])
    }

    const classified = discovery.organic + discovery.direct + discovery.captchaCooldown
    const totalVisits = totalFromCampaigns > 0 ? totalFromCampaigns : logs.length
    const successVisits = successFromCampaigns > 0 ? successFromCampaigns : successLogs.length
    const attempted = totalVisits > 0 ? totalVisits : successVisits + failedFromCampaigns
    const successRate = attempted > 0 ? (successVisits / attempted) * 100 : 0

    return {
        totalVisits,
        successVisits,
        sparkline30d: bucketLastDays(logs),
        avgQualityScore: qualityCount > 0 ? qualitySum / qualityCount : 0,
        organicPercent: classified > 0 ? (discovery.organic / classified) * 100 : 0,
        avgDurationSeconds: successLogs.length > 0 ? durationSum / successLogs.length : 0,
        successRate,
        discovery,
    }
}

function collectRunning(runningRows: unknown[], allRows: unknown[], trafficCampaigns: Record<string, unknown>[]): RunningCampaignItem[] {
    const reviewSource = runningRows.length > 0
        ? runningRows
        : allRows.filter((row) => asRecord(row)?.status === 'running')

    const reviewItems = reviewSource
        .map((row, index) => toRunningCampaign(row, 'review', index))
        .filter((row): row is RunningCampaignItem => row !== null)

    const trafficItems = trafficCampaigns
        .filter((row) => row.status === 'running')
        .map((row, index) => toRunningCampaign(row, 'traffic', index))
        .filter((row): row is RunningCampaignItem => row !== null)

    return [...reviewItems, ...trafficItems]
}

function toRunningCampaign(value: unknown, kind: 'review' | 'traffic', index: number): RunningCampaignItem | null {
    const record = asRecord(value)
    if (!record) return null
    const rawId = record.id
    const idPart = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : String(index)
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : `Campaign #${idPart}`
    const status = typeof record.status === 'string' ? record.status : 'running'
    return { id: `${kind}-${idPart}`, name, status, kind }
}

function failureMessages(rows: unknown[]): string[] {
    const cutoff = Date.now() - FAILURE_WINDOW_DAYS * DAY_MS
    const messages: string[] = []
    for (const value of rows) {
        const record = asRecord(value)
        if (!record || record.status !== 'failed') continue
        const created = toTime(record.createdAt)
        if (created !== null && created < cutoff) continue
        messages.push(readText(record, ['errorMessage', 'error', 'message']) || 'Unknown error')
    }
    return messages
}

function topFailures(messages: string[]): FailureCountItem[] {
    const counts = new Map<string, number>()
    for (const message of messages) {
        const key = message.trim() || 'Unknown error'
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([message, count]) => ({ message, count }))
}

function normalizeOverview(value: unknown): DashboardOverview {
    const root = asRecord(value)
    if (!root) return emptyOverview
    const source = asRecord(root.stats) ?? root
    const reviews = asRecord(source.reviews)
    const traffic = asRecord(source.traffic)
    const accounts = asRecord(source.accounts)
    const campaigns = asRecord(source.campaigns)
    const discovery = asRecord(traffic?.discovery) ?? asRecord(traffic?.sources)

    const reviewSeries = seriesOrFlat(asNumberArray(reviews?.sparkline30d ?? reviews?.sparkline))
    const trafficSeries = seriesOrFlat(asNumberArray(traffic?.sparkline30d ?? traffic?.sparkline))
    const recent = asArray(reviews?.recent ?? source.recentReviews ?? source.recent).map(normalizeReview).filter((row): row is RecentReview => row !== null)

    const tiers = asRecord(accounts?.tiers) ?? asRecord(accounts?.warmupTiers)
    const survival = asRecord(source.survival)
    const survivalTiers = asRecord(survival?.survivalByWarmupTier) ?? asRecord(survival?.survival_by_warmup_tier)
    const organic = discovery ? readNumber(discovery, ['organic']) : readNumber(traffic ?? {}, ['organic'])
    const direct = discovery ? readNumber(discovery, ['direct', 'direct_fallback', 'directFallback']) : readNumber(traffic ?? {}, ['direct'])
    const captcha = discovery
        ? readNumber(discovery, ['captchaCooldown', 'captcha_cooldown', 'captcha'])
        : readNumber(traffic ?? {}, ['captchaCooldown', 'captcha_cooldown'])

    return {
        reviews: {
            reviewsThisMonth: readNumber(reviews ?? {}, ['reviewsThisMonth', 'thisMonth', 'total']),
            reviewsToday: readNumber(reviews ?? {}, ['reviewsToday', 'today']),
            sparkline30d: reviewSeries,
            recent: recent.slice(0, 8),
        },
        traffic: {
            totalVisits: readNumber(traffic ?? {}, ['totalVisits', 'visits']),
            successVisits: readNumber(traffic ?? {}, ['successVisits', 'successfulVisits', 'completedVisits']),
            sparkline30d: trafficSeries,
            avgQualityScore: readNumber(traffic ?? {}, ['avgQualityScore', 'qualityScore']),
            organicPercent: readNumber(traffic ?? {}, ['organicPercent', 'organicShare']),
            avgDurationSeconds: readNumber(traffic ?? {}, ['avgDurationSeconds', 'avgDuration', 'avgVisitDuration']),
            successRate: readNumber(traffic ?? {}, ['successRate']),
            discovery: { organic, direct, captchaCooldown: captcha },
        },
        accounts: {
            active: readNumber(accounts ?? {}, ['active']),
            avgWarmupLevel: readNumber(accounts ?? {}, ['avgWarmupLevel', 'averageWarmupLevel']),
            tiers: {
                blocked: readNumber(tiers ?? {}, ['blocked']),
                throttled: readNumber(tiers ?? {}, ['throttled']),
                ready: readNumber(tiers ?? {}, ['ready']),
            },
            birthStoryCompletionPercent: readNumber(accounts ?? {}, ['birthStoryCompletionPercent', 'birthStoryPercent']),
            autoWarmupEnabled: readNumber(accounts ?? {}, ['autoWarmupEnabled', 'autoWarmupCount']),
        },
        campaigns: {
            running: readRunning(campaigns?.running ?? source.runningCampaigns),
            recentFailures: readFailures(campaigns?.recentFailures ?? campaigns?.failures ?? source.recentFailures).slice(0, 5),
        },
        survival: {
            totalVerified: readNumber(survival ?? {}, ['totalVerified', 'total_verified']),
            liveCount: readNumber(survival ?? {}, ['liveCount', 'live_count']),
            removedCount: readNumber(survival ?? {}, ['removedCount', 'removed_count']),
            pendingCount: readNumber(survival ?? {}, ['pendingCount', 'pending_count']),
            overallSurvivalRate: readNumber(survival ?? {}, ['overallSurvivalRate', 'overall_survival_rate']),
            avgSurvivalDays: readNumber(survival ?? {}, ['avgSurvivalDays', 'avg_survival_days']),
            styledSurvivalRate: readNumber(survival ?? {}, ['styledSurvivalRate', 'styled_survival_rate']),
            unstyledSurvivalRate: readNumber(survival ?? {}, ['unstyledSurvivalRate', 'unstyled_survival_rate']),
            survivalByWarmupTier: {
                blocked: readNumber(survivalTiers ?? {}, ['blocked']),
                throttled: readNumber(survivalTiers ?? {}, ['throttled']),
                ready: readNumber(survivalTiers ?? {}, ['ready']),
            },
        },
    }
}

function readRunning(value: unknown): RunningCampaignItem[] {
    return asArray(value)
        .map((entry, index) => toRunningCampaign(entry, inferKind(entry), index))
        .filter((row): row is RunningCampaignItem => row !== null)
}

function inferKind(value: unknown): 'review' | 'traffic' {
    const record = asRecord(value)
    const kind = record?.kind ?? record?.type
    return kind === 'traffic' ? 'traffic' : 'review'
}

function readFailures(value: unknown): FailureCountItem[] {
    const items: FailureCountItem[] = []
    for (const entry of asArray(value)) {
        const record = asRecord(entry)
        if (!record) continue
        const message = readText(record, ['message', 'errorMessage', 'error']) || 'Unknown error'
        items.push({ message, count: Math.max(0, Math.round(readNumber(record, ['count']))) })
    }
    return items
}

function normalizeReview(value: unknown): RecentReview | null {
    const record = asRecord(value)
    if (!record) return null
    const locationId = idLike(record.locationId)
    const accountId = idLike(record.accountId)
    const createdAt = dateLike(record.createdAt)
    return {
        status: typeof record.status === 'string' ? record.status : undefined,
        locationId,
        accountId,
        rating: Number.isFinite(readNumber(record, ['rating'], Number.NaN)) ? readNumber(record, ['rating']) : undefined,
        createdAt,
        locationName: typeof record.locationName === 'string' ? record.locationName : undefined,
    }
}

function bucketLastDays(rows: unknown[], include?: (row: Record<string, unknown>) => boolean): number[] {
    const buckets = new Array<number>(SPARKLINE_DAYS).fill(0)
    const start = startOfDay(Date.now()) - (SPARKLINE_DAYS - 1) * DAY_MS
    for (const value of rows) {
        const record = asRecord(value)
        if (!record) continue
        if (include && !include(record)) continue
        const created = toTime(record.createdAt)
        if (created === null) continue
        const index = Math.floor((startOfDay(created) - start) / DAY_MS)
        if (index >= 0 && index < SPARKLINE_DAYS) buckets[index] += 1
    }
    return buckets
}

function countTodaySuccess(rows: unknown[]): number {
    const start = startOfDay(Date.now())
    return rows.filter((value) => {
        const record = asRecord(value)
        if (!record || record.status !== 'success') return false
        const created = toTime(record.createdAt)
        return created !== null && created >= start
    }).length
}

function countMonthSuccess(rows: unknown[]): number {
    const start = startOfDay(Date.now()) - (SPARKLINE_DAYS - 1) * DAY_MS
    return rows.filter((value) => {
        const record = asRecord(value)
        if (!record || record.status !== 'success') return false
        const created = toTime(record.createdAt)
        return created !== null && created >= start
    }).length
}

function seriesOrFlat(data: number[]): number[] {
    if (data.length >= 2) return data
    if (data.length === 1) return [data[0], data[0]]
    return flatSeries()
}

function flatSeries(): number[] {
    return [0, 0]
}

function asNumberArray(value: unknown): number[] {
    if (!Array.isArray(value)) return []
    return value.map((item) => {
        const number = typeof item === 'number' ? item : Number(item)
        return Number.isFinite(number) ? number : 0
    })
}

async function settle<T>(task: Promise<T> | undefined, fallback: T): Promise<T> {
    if (!task) return fallback
    try {
        return await task
    } catch {
        return fallback
    }
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function readNumber(record: Record<string, unknown>, keys: string[], fallback = 0): number {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) return parsed
        }
    }
    return fallback
}

function readText(record: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

function isEnabledFlag(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 'true'
}

function positiveId(value: unknown): number | null {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(number) || number <= 0) return null
    return number
}

function idLike(value: unknown): number | string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) return value
    return undefined
}

function dateLike(value: unknown): RecentReview['createdAt'] {
    if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) return value
    return undefined
}

function toTime(value: unknown): number | null {
    if (value instanceof Date) {
        const time = value.getTime()
        return Number.isNaN(time) ? null : time
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const time = new Date(value).getTime()
        return Number.isNaN(time) ? null : time
    }
    return null
}

function startOfDay(time: number): number {
    const date = new Date(time)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
}

function formatCount(value: number): string {
    return Math.round(Number.isFinite(value) ? value : 0).toLocaleString()
}

function formatPercent(value: number): string {
    if (!Number.isFinite(value)) return '0%'
    const rounded = Math.round(clamp(value, 0, 100) * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

function nonNegative(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, value)
}

function formatLevel(value: number): string {
    if (!Number.isFinite(value)) return '0'
    const rounded = Math.round(value * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function formatReviewDate(value: RecentReview['createdAt']): string {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}
