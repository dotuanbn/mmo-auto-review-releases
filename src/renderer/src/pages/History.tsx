import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import {
    Star,
    CheckCircle,
    RefreshCw,
    Calendar,
    Download,
    BarChart3,
    TrendingUp,
    History as HistoryIcon,
    ChevronDown,
    ChevronUp,
    AlertTriangle,
    FileText,
    Eye,
} from 'lucide-react'
import {
    PageHeader,
    PageShell,
    Panel,
    Pagination,
    PrimaryButton,
    SearchInput,
    SegmentedTabs,
    StatCard,
    StatRow,
    StatusPill,
    type Tone,
} from '../components/ui/surface'

interface ReviewHistory {
    id: number
    accountId: number
    locationId: number
    campaignId: number
    rating: number
    reviewText: string
    status: 'success' | 'failed' | 'pending'
    errorMessage?: string
    createdAt: Date
    account?: { email: string }
    location?: { name: string }
}

type FilterStatus = 'all' | 'success' | 'failed' | 'pending'

const ITEMS_PER_PAGE = 20

export function History() {
    const { t } = useI18n()
    const [reviews, setReviews] = useState<ReviewHistory[]>([])
    const [stats, setStats] = useState({ totalReviews: 0, successfulReviews: 0, reviewsToday: 0, successRate: 0 })
    const [loading, setLoading] = useState(true)
    const [filter, setFilter] = useState<FilterStatus>('all')
    const [searchQuery, setSearchQuery] = useState('')
    const [expandedReviewId, setExpandedReviewId] = useState<number | null>(null)
    const [sortBy, setSortBy] = useState<'date' | 'rating'>('date')
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
    const [page, setPage] = useState(1)

    useEffect(() => {
        fetchReviews()
        fetchStats()
    }, [])

    const fetchReviews = async () => {
        try {
            setLoading(true)
            const data = await window.electronAPI.reviews.getAll()
            setReviews(data)
        } catch (error) {
            console.error('Failed to fetch reviews:', error)
        } finally {
            setLoading(false)
        }
    }

    const fetchStats = async () => {
        try {
            const data = await window.electronAPI.reviews.getStats()
            setStats(data)
        } catch (error) {
            console.error('Failed to fetch stats:', error)
        }
    }

    const filteredReviews = reviews
        .filter(review => {
            if (filter !== 'all' && review.status !== filter) return false
            if (searchQuery) {
                const q = searchQuery.toLowerCase()
                const matchEmail = review.account?.email?.toLowerCase().includes(q)
                const matchLocation = review.location?.name?.toLowerCase().includes(q)
                const matchText = review.reviewText?.toLowerCase().includes(q)
                return matchEmail || matchLocation || matchText
            }
            return true
        })
        .sort((a, b) => {
            if (sortBy === 'date') {
                const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                return sortOrder === 'desc' ? -diff : diff
            }
            const diff = a.rating - b.rating
            return sortOrder === 'desc' ? -diff : diff
        })

    const totalPages = Math.max(1, Math.ceil(filteredReviews.length / ITEMS_PER_PAGE))
    const paginatedReviews = filteredReviews.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

    // Reset page when filter/search changes
    useEffect(() => {
        setPage(1)
    }, [filter, searchQuery])

    const failedReviews = reviews.filter(r => r.status === 'failed').length

    const getStatusPill = (status: string) => {
        const toneMap: Record<string, Tone> = {
            success: 'emerald',
            failed: 'rose',
            pending: 'amber',
        }
        const labelMap: Record<string, string> = {
            success: 'Success',
            failed: 'Failed',
            pending: 'Pending',
        }
        return <StatusPill tone={toneMap[status] || 'slate'}>{labelMap[status] || status}</StatusPill>
    }

    const renderStars = (rating: number) => {
        return (
            <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                        key={star}
                        className={`h-3.5 w-3.5 ${star <= rating ? 'fill-amber-400 text-amber-400' : 'text-[#d7d2e3]'}`}
                    />
                ))}
            </div>
        )
    }

    const exportToCSV = () => {
        const headers = ['ID', 'Account', 'Location', 'Rating', 'Review', 'Status', 'Error', 'Date']
        const rows = filteredReviews.map(r => [
            r.id,
            r.account?.email || `Account #${r.accountId}`,
            r.location?.name || `Location #${r.locationId}`,
            r.rating,
            `"${(r.reviewText || '').replace(/"/g, '""')}"`,
            r.status,
            `"${(r.errorMessage || '').replace(/"/g, '""')}"`,
            new Date(r.createdAt).toLocaleString()
        ])
        const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
        const blob = new Blob([csv], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `review-history-${new Date().toISOString().split('T')[0]}.csv`
        a.click()
    }

    const filterTabs: Array<{ id: FilterStatus; label: string }> = [
        { id: 'all', label: `${t('history.allReviews')} (${reviews.length})` },
        { id: 'success', label: `${t('history.successfulOnly')} (${reviews.filter(r => r.status === 'success').length})` },
        { id: 'failed', label: `${t('history.failedOnly')} (${failedReviews})` },
        { id: 'pending', label: `Pending (${reviews.filter(r => r.status === 'pending').length})` },
    ]

    const toggleSort = (field: 'date' | 'rating') => {
        if (sortBy === field) {
            setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')
        } else {
            setSortBy(field)
            setSortOrder('desc')
        }
    }

    const columns = [
        {
            key: 'status',
            header: t('common.status'),
            render: (row: ReviewHistory) => getStatusPill(row.status),
            width: '120px',
        },
        {
            key: 'location',
            header: t('history.location'),
            render: (row: ReviewHistory) => (
                <span className="text-sm font-medium text-[#17171f]">
                    {row.location?.name || `Location #${row.locationId}`}
                </span>
            ),
        },
        {
            key: 'account',
            header: t('history.account'),
            render: (row: ReviewHistory) => (
                <span className="font-mono text-sm text-[#5f5a6d]">
                    {row.account?.email || `Account #${row.accountId}`}
                </span>
            ),
        },
        {
            key: 'rating',
            header: (
                <button
                    className="flex items-center gap-1 transition-colors hover:text-[#17171f]"
                    onClick={() => toggleSort('rating')}
                    type="button"
                >
                    {t('history.rating')}
                    {sortBy === 'rating' && (
                        sortOrder === 'desc' ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />
                    )}
                </button>
            ),
            render: (row: ReviewHistory) => renderStars(row.rating),
            width: '120px',
        },
        {
            key: 'reviewText',
            header: t('history.reviewText'),
            render: (row: ReviewHistory) => (
                <span className="block max-w-xs truncate text-sm text-[#908a9e]">
                    {row.reviewText || '-'}
                </span>
            ),
        },
        {
            key: 'date',
            header: (
                <button
                    className="flex items-center gap-1 transition-colors hover:text-[#17171f]"
                    onClick={() => toggleSort('date')}
                    type="button"
                >
                    {t('history.date')}
                    {sortBy === 'date' && (
                        sortOrder === 'desc' ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />
                    )}
                </button>
            ),
            render: (row: ReviewHistory) => (
                <div>
                    <div className="flex items-center gap-1.5 text-sm text-[#5f5a6d]">
                        <Calendar className="h-3 w-3" />
                        {new Date(row.createdAt).toLocaleDateString()}
                    </div>
                    <div className="mt-0.5 text-xs text-[#908a9e]">
                        {new Date(row.createdAt).toLocaleTimeString()}
                    </div>
                </div>
            ),
        },
        {
            key: 'expand',
            header: '',
            render: (row: ReviewHistory) => (
                <Eye className={`h-4 w-4 transition-colors ${expandedReviewId === row.id ? 'text-[#8d74e8]' : 'text-[#908a9e]'}`} />
            ),
            width: '40px',
        },
    ]

    return (
        <PageShell>
            <PageHeader
                icon={HistoryIcon}
                tone="violet"
                title={t('history.title')}
                subtitle={t('history.subtitle')}
            >
                <PrimaryButton
                    icon={RefreshCw}
                    variant="quiet"
                    onClick={fetchReviews}
                    disabled={loading}
                >
                    {t('common.refresh')}
                </PrimaryButton>
                <PrimaryButton
                    icon={Download}
                    onClick={exportToCSV}
                >
                    {t('history.exportCSV')}
                </PrimaryButton>
            </PageHeader>

            {/* Stats Row */}
            <StatRow className="lg:grid-cols-4">
                <StatCard
                    icon={BarChart3}
                    label={t('history.totalReviews')}
                    value={stats.totalReviews}
                    tone="blue"
                />
                <StatCard
                    icon={CheckCircle}
                    label={t('history.successful')}
                    value={stats.successfulReviews}
                    tone="emerald"
                />
                <StatCard
                    icon={Calendar}
                    label={t('history.todayReviews')}
                    value={stats.reviewsToday}
                    tone="cyan"
                />
                <StatCard
                    icon={TrendingUp}
                    label={t('history.successRate')}
                    value={`${stats.successRate}%`}
                    tone="violet"
                />
            </StatRow>

            {/* Search + Filter */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <SearchInput
                        value={searchQuery}
                        onChange={setSearchQuery}
                        placeholder="Tim theo email, dia diem, noi dung..."
                        className="w-full sm:w-72"
                    />
                    <SegmentedTabs
                        items={filterTabs}
                        value={filter}
                        onChange={setFilter}
                    />
                </div>
                <span className="text-sm font-medium text-[#908a9e]">
                    {filteredReviews.length} / {reviews.length} {t('history.totalReviews').toLowerCase()}
                </span>
            </div>

            {/* Reviews Table */}
            <Panel className="overflow-hidden p-0">
                {loading && reviews.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-[#908a9e]">
                        <RefreshCw className="h-6 w-6 animate-spin text-[#8d74e8]" />
                        <span className="text-sm">{t('history.loadingHistory')}</span>
                    </div>
                ) : paginatedReviews.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-[#908a9e]">
                        <FileText className="h-8 w-8 text-[#d7d2e3]" />
                        <span className="text-sm">{searchQuery ? 'Khong tim thay ket qua' : t('history.noReviewsYet')}</span>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="bg-[#f4f1fa]">
                                    {columns.map((col) => (
                                        <th
                                            key={col.key}
                                            className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-[#6d6678]"
                                            style={col.width ? { width: col.width } : undefined}
                                        >
                                            {col.header}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedReviews.map((review) => (
                                    <>
                                        <tr
                                            key={review.id}
                                            className={`cursor-pointer border-t border-[#f0ecf7] bg-white transition-colors hover:bg-[#f8f6fc] ${
                                                expandedReviewId === review.id ? 'bg-[#f8f6fc]' : ''
                                            }`}
                                            onClick={() => setExpandedReviewId(expandedReviewId === review.id ? null : review.id)}
                                        >
                                            {columns.map((col) => (
                                                <td key={col.key} className="px-4 py-3 text-[#5f5a6d]">
                                                    {col.render(review)}
                                                </td>
                                            ))}
                                        </tr>
                                        {expandedReviewId === review.id && (
                                            <tr key={`${review.id}-detail`} className="bg-[#f8f6fc]">
                                                <td colSpan={columns.length} className="px-4 py-4">
                                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                                        <div>
                                                            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-[#908a9e]">Noi dung review</label>
                                                            <p className="rounded-[16px] border border-[#e9e4f2] bg-white p-3 text-sm leading-relaxed text-[#5f5a6d]">
                                                                {review.reviewText || 'Khong co noi dung'}
                                                            </p>
                                                        </div>
                                                        <div className="space-y-3">
                                                            <div>
                                                                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-[#908a9e]">Campaign ID</label>
                                                                <p className="text-[#5f5a6d]">#{review.campaignId}</p>
                                                            </div>
                                                            {review.errorMessage && (
                                                                <div>
                                                                    <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-[#908a9e]">Loi</label>
                                                                    <p className="flex items-start gap-2 rounded-[16px] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-600">
                                                                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                                                                        {review.errorMessage}
                                                                    </p>
                                                                </div>
                                                            )}
                                                            <div>
                                                                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-[#908a9e]">Thoi gian chinh xac</label>
                                                                <p className="text-[#5f5a6d]">{new Date(review.createdAt).toLocaleString()}</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Panel>

            {/* Pagination + Footer */}
            <div className="flex items-center justify-between">
                <span className="text-sm text-[#908a9e]">
                    Hien thi {filteredReviews.length > 0 ? (page - 1) * ITEMS_PER_PAGE + 1 : 0}-{Math.min(page * ITEMS_PER_PAGE, filteredReviews.length)} / {filteredReviews.length} ban ghi
                </span>
                <Pagination
                    page={page}
                    totalPages={totalPages}
                    onPageChange={setPage}
                />
            </div>
        </PageShell>
    )
}
