import { useEffect, useMemo, useState } from 'react'
import {
    ArrowRight,
    Bell,
    Bot,
    CheckCircle,
    ChevronDown,
    MessageCircle,
    Maximize2,
    Package as PackageIcon,
    Plus,
    RefreshCw,
    Route,
    Search,
    Star,
    XCircle,
    LayoutDashboard,
} from 'lucide-react'
import { type Page } from '../app/navigation'
import {
    IconButton,
    PageHeader,
    PageShell,
    Panel,
    PrimaryButton,
    StatCard,
    StatRow,
    StatusPill,
} from '../components/ui/surface'
import { useI18n } from '../i18n'

interface DashboardStats {
    accounts: { total: number; active: number }
    proxies: { total: number; active: number }
    locations: { total: number; done: number }
    reviews: { total: number; today: number; successRate: number }
    campaigns: { total: number; running: number }
}

interface RecentReview {
    status?: 'success' | 'failed' | string
    locationId?: number | string
    accountId?: number | string
    rating?: number
    createdAt?: string | number | Date
}

interface DashboardProps {
    onNavigate?: (page: Page) => void
}


interface ReadinessState {
    ready: boolean
    missing: string[]
}

const emptyStats: DashboardStats = {
    accounts: { total: 0, active: 0 },
    proxies: { total: 0, active: 0 },
    locations: { total: 0, done: 0 },
    reviews: { total: 0, today: 0, successRate: 0 },
    campaigns: { total: 0, running: 0 },
}




export function Dashboard({ onNavigate }: DashboardProps) {
    const { t } = useI18n()
    const [stats, setStats] = useState<DashboardStats>(emptyStats)
    const [recentReviews, setRecentReviews] = useState<RecentReview[]>([])
    const [loading, setLoading] = useState(true)

    const loadDashboardData = async () => {
        try {
            setLoading(true)
            const result = await fetchDashboardData()
            setStats(result?.stats ?? emptyStats)
            setRecentReviews(result?.recentReviews ?? [])
        } catch (error) {
            console.error('Failed to load dashboard data:', error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void loadDashboardData()
    }, [])

    const readiness = useReadiness(stats)

    return (
        <DashboardLayout
            loading={loading}
            title={t('dashboard.title', 'Dashboard')}
            subtitle={t('dashboard.subtitle', 'Welcome back! Here is your overview')}
            stats={stats}
            readiness={readiness}
            recentReviews={recentReviews}
            onRefresh={loadDashboardData}
            onNavigate={onNavigate}
        />
    )
}

function DashboardLayout({
    loading,
    title,
    subtitle,
    stats,
    readiness,
    recentReviews,
    onRefresh,
    onNavigate,
}: {
    loading: boolean
    title: string
    subtitle: string
    stats: DashboardStats
    readiness: ReadinessState
    recentReviews: RecentReview[]
    onRefresh: () => void
    onNavigate?: (page: Page) => void
}) {
    return (
        <PageShell>
            <PageHeader
                icon={LayoutDashboard}
                tone="violet"
                title="Welcome back, Operator!"
                subtitle={subtitle}
            >
                <IconButton icon={Bell} label="Notifications" variant="dark" />
                <IconButton icon={Search} label="Search" variant="dark" />
                <IconButton icon={MessageCircle} label="Messages" variant="dark" />
                <PrimaryButton icon={Plus} onClick={() => onNavigate?.('campaigns')}>
                    Create campaign
                </PrimaryButton>
                <PrimaryButton icon={RefreshCw} variant="quiet" onClick={onRefresh} disabled={loading}>
                    Refresh
                </PrimaryButton>
                <span className="sr-only">{title}</span>
            </PageHeader>
            <TopMetricsSection stats={stats} />
            <BentoSection stats={stats} readiness={readiness} onNavigate={onNavigate} />
            <RecentReviews reviews={recentReviews} />
        </PageShell>
    )
}

function TopMetricsSection({ stats }: { stats: DashboardStats }) {
    const totalResources = stats.accounts.total + stats.proxies.total + stats.locations.total

    return (
        <StatRow className="lg:grid-cols-3">
            <StatCard icon={Star} label="This month reviews" value={stats.reviews.total} tone="violet" subtext={`+${stats.reviews.today} today`} />
            <StatCard icon={PackageIcon} label="Active resources" value={totalResources} tone="blue" subtext={`${stats.accounts.active} accounts ready`} />
            <StatCard icon={Route} label="Success distance" value={`${stats.reviews.successRate}%`} tone="emerald" subtext={`${stats.campaigns.running} running`} />
        </StatRow>
    )
}

function BentoSection({ stats, readiness, onNavigate }: { stats: DashboardStats; readiness: ReadinessState; onNavigate?: (page: Page) => void }) {
    return (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.78fr_1.28fr_1.04fr]">
            <div className="grid gap-4">
                <PackageDetailsPanel stats={stats} />
                <SpeedStatisticPanel successRate={stats.reviews.successRate} />
            </div>
            <div className="grid gap-4">
                <CampaignInfoPanel readiness={readiness} stats={stats} onNavigate={onNavigate} />
                <EngineShowcasePanel stats={stats} onNavigate={onNavigate} />
            </div>
            <MapOverviewPanel stats={stats} />
        </section>
    )
}

async function fetchDashboardData() {
    const api = window.electronAPI

    if (!api?.accounts || !api?.proxies || !api?.locations || !api?.reviews || !api?.campaigns) {
        return null
    }

    const [accountStats, proxyStats, locationStats, reviewStats, campaignStats, recent] = await Promise.all([
        api.accounts.getStats(),
        api.proxies.getStats(),
        api.locations.getStats(),
        api.reviews.getStats(),
        api.campaigns.getStats(),
        api.reviews.getRecent(5),
    ])

    return {
        stats: {
            accounts: accountStats,
            proxies: proxyStats,
            locations: { total: locationStats.total, done: locationStats.done },
            reviews: {
                total: reviewStats.totalReviews,
                today: reviewStats.reviewsToday,
                successRate: reviewStats.successRate,
            },
            campaigns: campaignStats,
        },
        recentReviews: Array.isArray(recent) ? recent : [],
    }
}

function useReadiness(stats: DashboardStats) {
    return useMemo(() => {
        const missing = [
            stats.accounts.active === 0 ? 'Add active Google accounts' : null,
            stats.locations.total === 0 ? 'Add Google Maps locations' : null,
            stats.proxies.active === 0 ? 'Add proxies for safer rotation' : null,
        ].filter((item): item is string => Boolean(item))

        return {
            ready: stats.accounts.active > 0 && stats.locations.total > 0,
            missing,
        }
    }, [stats])
}

function PackageDetailsPanel({ stats }: { stats: DashboardStats }) {
    return (
        <Panel className="p-4 xl:h-[210px]">
            <PanelTitle title="Resource Details" subtitle="Accounts, proxies and maps" />
            <div className="mt-3 grid grid-cols-3 gap-2">
                <ResourceChip value={stats.accounts.active} label="Active" />
                <ResourceChip value={stats.proxies.active} label="Proxy" />
                <ResourceChip value={stats.locations.total} label="Maps" />
            </div>
            <div className="mt-4 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#8d74e8] to-[#d6cdf9] text-sm font-bold text-white">
                    AI
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#24222c]">Automation workspace</p>
                    <p className="text-xs text-[#8e899b]">Google Maps review system</p>
                </div>
                <button className="flex h-10 w-10 items-center justify-center rounded-full bg-[#8d74e8] text-white shadow-[0_14px_26px_rgba(141,116,232,0.24)]" type="button">
                    <Bot className="h-[18px] w-[18px]" />
                </button>
            </div>
        </Panel>
    )
}

function SpeedStatisticPanel({ successRate }: { successRate: number }) {
    return (
        <Panel className="p-4 xl:h-[220px]">
            <PanelTitle title="Automation Health" subtitle="Average vs current quality" />
            <div className="mt-2 flex items-center justify-center">
                <div
                    className="grid h-32 w-32 place-items-center rounded-full"
                    style={{ background: `conic-gradient(#8d74e8 ${successRate * 3.6}deg, #ece7f5 0deg)` }}
                >
                    <div className="grid h-24 w-24 place-items-center rounded-full bg-[#f7f7f9] text-center">
                        <div>
                            <div className="text-4xl font-semibold text-[#24222c]">{successRate}</div>
                            <div className="text-[11px] font-medium text-[#8e899b]">success / 100</div>
                        </div>
                    </div>
                </div>
            </div>
            <LegendRow left="Average success" right="Current run" />
        </Panel>
    )
}

function CampaignInfoPanel({
    readiness,
    stats,
    onNavigate,
}: {
    readiness: ReadinessState
    stats: DashboardStats
    onNavigate?: (page: Page) => void
}) {
    const completed = Math.min(100, Math.max(0, stats.reviews.successRate || (readiness.ready ? 60 : 20)))

    return (
        <Panel className="p-4 xl:h-[280px]">
            <div className="flex items-start justify-between gap-3">
                <PanelTitle title="Campaign Info" subtitle="Live launch readiness" />
                <button className="text-xs font-semibold text-[#8d74e8]" onClick={() => onNavigate?.('campaigns')} type="button">
                    View more
                </button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[0.9fr_1fr]">
                <RouteCard />
                <TimelineCard ready={readiness.ready} running={stats.campaigns.running} />
            </div>
            <div className="mt-3 flex items-center gap-3 rounded-[20px] border border-[#e9e4f2] bg-white px-4 py-2.5 shadow-sm">
                <ProgressDot value={completed} />
                <span className="text-sm font-semibold text-[#24222c]">{completed}% Completed</span>
                <span className="h-6 w-px bg-[#e9e4f2]" />
                <span className="text-xs text-[#9a95a7]">{readiness.ready ? 'Deliveries ready' : readiness.missing[0]}</span>
                <ChevronDown className="ml-auto h-4 w-4 text-[#24222c]" />
            </div>
        </Panel>
    )
}

function RouteCard() {
    return (
        <div className="h-[138px] rounded-[22px] bg-gradient-to-br from-[#8d74e8] to-[#c3b7f6] p-3.5 text-white shadow-[0_18px_36px_rgba(141,116,232,0.22)]">
            <div className="flex justify-between text-lg font-semibold">
                <span>SEO</span>
                <span>MAP</span>
            </div>
            <div className="my-3 flex items-center justify-center">
                <Route className="h-8 w-8" />
            </div>
            <div className="h-px bg-white/70" />
            <div className="mt-3 flex justify-between text-[11px] font-medium text-white/85">
                <span>Review</span>
                <span>Traffic</span>
            </div>
        </div>
    )
}

function TimelineCard({ ready, running }: { ready: boolean; running: number }) {
    const steps = [
        { label: 'Resources', value: 'Ready', active: ready },
        { label: 'Dispatch', value: `${running} live`, active: running > 0 },
        { label: 'Review', value: 'Queued', active: false },
        { label: 'Report', value: 'Auto', active: false },
    ]

    return (
        <div className="h-[138px] rounded-[22px] border border-[#e9e4f2] bg-white p-3.5 shadow-sm">
            <div className="text-xl font-semibold tracking-tight text-[#24222c]">#MMO4523</div>
            <div className="mt-3 space-y-2">
                {steps.map((step) => (
                    <div key={step.label} className="flex items-center gap-3 text-xs">
                        <span className={step.active ? 'h-2.5 w-2.5 rounded-full bg-[#8d74e8]' : 'h-2.5 w-2.5 rounded-full border border-[#d9d4e8]'} />
                        <span className={step.active ? 'font-semibold text-[#24222c]' : 'text-[#9a95a7]'}>{step.label}</span>
                        <span className="ml-auto text-[#8e899b]">{step.value}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}

function EngineShowcasePanel({ stats, onNavigate }: { stats: DashboardStats; onNavigate?: (page: Page) => void }) {
    return (
        <Panel className="relative min-h-[150px] overflow-hidden p-4 xl:h-[150px]">
            <div className="relative z-10 max-w-[52%]">
                <h2 className="text-xl font-semibold leading-tight text-[#24222c]">Review Engine</h2>
                <p className="mt-1 text-xs font-medium text-[#8e899b]">Maps SEO automation</p>
                <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] text-[#8e899b]">
                    <MiniField label="Payload" value={`${stats.reviews.total} reviews`} />
                    <MiniField label="Load" value={`${stats.campaigns.total} campaigns`} />
                    <MiniField label="Queue" value={`${stats.locations.total} maps`} />
                    <MiniField label="Width" value={`${stats.accounts.total} accounts`} />
                </div>
            </div>
            <AutomationIllustration />
            <button
                className="absolute right-5 top-5 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-[#e9e4f2] bg-white text-[#24222c] shadow-sm hover:bg-[#f7f5fb]"
                onClick={() => onNavigate?.('traffic')}
                type="button"
                aria-label="Open traffic"
            >
                <ArrowRight className="h-4 w-4" />
            </button>
        </Panel>
    )
}

function MapOverviewPanel({ stats }: { stats: DashboardStats }) {
    return (
        <Panel className="relative min-h-[430px] overflow-hidden p-4 xl:h-[442px] xl:min-h-0">
            <div className="relative z-10 flex items-start justify-between">
                <PanelTitle title="Map Overview" subtitle="Campaign route preview" />
                <StatusPill tone={stats.campaigns.running > 0 ? 'emerald' : 'violet'}>
                    {stats.campaigns.running > 0 ? 'Live' : 'Ready'}
                </StatusPill>
            </div>
            <MapCanvas />
            <div className="absolute bottom-5 left-5 z-10">
                <div className="text-2xl font-semibold text-[#24222c]">{stats.locations.done}</div>
                <div className="text-xs font-semibold text-[#9a95a7]">/ {stats.locations.total || 1} maps done</div>
            </div>
            <div className="absolute bottom-5 right-5 z-10 grid gap-2">
                <MapControl label="+" />
                <MapControl label="-" />
                <MapIconControl />
            </div>
        </Panel>
    )
}

function RecentReviews({ reviews }: { reviews: RecentReview[] }) {
    return (
        <Panel className="p-5">
            <div className="flex items-center justify-between">
                <PanelTitle title="Recent Reviews" subtitle="Latest execution results" />
                <StatusPill tone={reviews.length > 0 ? 'emerald' : 'slate'}>{reviews.length} items</StatusPill>
            </div>
            {reviews.length === 0 ? (
                <div className="mt-4 rounded-[20px] border border-dashed border-[#ded8ed] bg-white px-4 py-8 text-center text-sm text-[#8e899b]">
                    No reviews yet. Start a campaign to see activity here.
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
    const rating = Math.max(0, Math.min(5, review.rating ?? 0))

    return (
        <div className="flex flex-col gap-3 rounded-[18px] border border-[#e9e4f2] bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
                {ok ? <CheckCircle className="h-5 w-5 text-emerald-500" /> : <XCircle className="h-5 w-5 text-rose-500" />}
                <div>
                    <div className="text-sm font-semibold text-[#24222c]">Location #{review.locationId}</div>
                    <div className="text-xs text-[#9a95a7]">Account #{review.accountId}</div>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <StarRating rating={rating} />
                <span className="text-xs text-[#9a95a7]">{formatReviewDate(review.createdAt)}</span>
            </div>
        </div>
    )
}

function PanelTitle({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div>
            <h2 className="text-lg font-semibold tracking-tight text-[#24222c]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs font-medium text-[#9a95a7]">{subtitle}</p>}
        </div>
    )
}

function ResourceChip({ value, label }: { value: number; label: string }) {
    return (
        <div className="rounded-[16px] border border-[#e9e4f2] bg-white px-3 py-3 text-center shadow-sm">
            <div className="text-sm font-semibold text-[#24222c]">{value}</div>
            <div className="text-[10px] font-medium text-[#9a95a7]">{label}</div>
        </div>
    )
}

function MiniField({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="font-semibold text-[#24222c]">{value}</div>
            <div>{label}</div>
        </div>
    )
}

function LegendRow({ left, right }: { left: string; right: string }) {
    return (
        <div className="flex items-center justify-center gap-6 text-[11px] font-medium text-[#625d70]">
            <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#24222c]" />
                {left}
            </span>
            <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#8d74e8]" />
                {right}
            </span>
        </div>
    )
}

function ProgressDot({ value }: { value: number }) {
    return (
        <div
            className="h-6 w-6 rounded-full"
            style={{ background: `conic-gradient(#8d74e8 ${value * 3.6}deg, #ece7f5 0deg)` }}
        />
    )
}

function AutomationIllustration() {
    return (
        <div className="absolute bottom-0 right-0 h-full w-[58%]">
            <div className="absolute bottom-4 right-10 h-20 w-40 rounded-[28px] bg-gradient-to-br from-[#f4f1fa] to-[#8d74e8] shadow-[0_24px_50px_rgba(56,48,75,0.18)]" />
            <div className="absolute bottom-10 right-16 h-20 w-24 rounded-t-full border-[16px] border-[#e9e4f2] bg-transparent" />
            <div className="absolute bottom-3 right-16 h-12 w-12 rounded-full bg-[#24222c] p-2">
                <div className="h-full w-full rounded-full bg-[#8d74e8]" />
            </div>
            <div className="absolute bottom-3 right-40 h-10 w-10 rounded-full bg-[#24222c] p-2">
                <div className="h-full w-full rounded-full bg-[#8d74e8]" />
            </div>
            <div className="absolute bottom-16 right-4 h-24 w-24 rounded-full bg-[#8d74e8]/18 blur-2xl" />
        </div>
    )
}

function MapCanvas() {
    return (
        <div className="absolute inset-0 bg-[#f4f1fa]">
            <svg viewBox="0 0 360 560" className="h-full w-full opacity-90">
                <path d="M18 48 C82 96 112 72 166 116 S282 154 338 116" fill="none" stroke="#e9e4f2" strokeWidth="2" />
                <path d="M22 226 C92 192 126 256 186 222 S268 180 346 232" fill="none" stroke="#e9e4f2" strokeWidth="2" />
                <path d="M58 508 C106 452 142 430 190 394 S246 322 312 292" fill="none" stroke="#5f5a6d" strokeWidth="4" strokeLinecap="round" />
                <path d="M190 394 C222 358 236 334 260 304 S286 266 320 236" fill="none" stroke="#8d74e8" strokeWidth="4" strokeLinecap="round" />
                <circle cx="72" cy="492" r="10" fill="white" stroke="#8d74e8" strokeWidth="4" />
                <circle cx="318" cy="238" r="6" fill="#5f5a6d" />
                <path d="M244 332 l34 -26 l-6 42 z" fill="#8d74e8" opacity="0.88" />
                <text x="46" y="526" fill="#24222c" fontSize="22" fontWeight="700">SRC</text>
                <text x="294" y="224" fill="#24222c" fontSize="22" fontWeight="700">MAP</text>
                {Array.from({ length: 10 }).map((_, index) => (
                    <path key={index} d={`M${index * 38} 0 L${index * 38 + 80} 560`} stroke="#f4f1fa" strokeWidth="1" opacity="0.55" />
                ))}
            </svg>
        </div>
    )
}

function MapControl({ label }: { label: string }) {
    return (
        <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-[#e9e4f2] bg-white text-sm font-semibold text-[#24222c] shadow-sm hover:bg-[#f7f5fb]">
            {label}
        </button>
    )
}

function MapIconControl() {
    return (
        <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-[#e9e4f2] bg-white text-[#24222c] shadow-sm hover:bg-[#f7f5fb]" aria-label="Fit map">
            <Maximize2 className="h-4 w-4" />
        </button>
    )
}

function StarRating({ rating }: { rating: number }) {
    return (
        <div className="flex">
            {[1, 2, 3, 4, 5].map((star) => (
                <Star key={star} className={star <= rating ? 'h-3.5 w-3.5 fill-amber-400 text-amber-400' : 'h-3.5 w-3.5 text-[#d7d2e3]'} />
            ))}
        </div>
    )
}

function formatReviewDate(value: RecentReview['createdAt']) {
    if (!value) {
        return ''
    }

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}
