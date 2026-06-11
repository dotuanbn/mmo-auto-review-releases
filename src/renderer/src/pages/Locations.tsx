import { useEffect, useState } from 'react'
import {
    Plus,
    Trash2,
    RefreshCw,
    MapPin,
    ExternalLink,
    CheckCircle,
    BarChart3,
    Save
} from 'lucide-react'
import { useI18n } from '../i18n'
import {
    PageHeader,
    PageShell,
    PrimaryButton,
    IconButton,
    StatCard,
    StatRow,
    Toolbar,
    Panel,
    CardGrid,
    Modal,
    TextInput,
    Select,
    StatusPill,
    ProgressBar,
    Badge,
    EmptyState,
    Divider,
} from '../components/ui/surface'
import type { Tone } from '../components/ui/surface'

interface Location {
    id: number
    name: string
    url: string
    address?: string
    placeId?: string
    targetReviews: number
    currentReviews: number
    status: 'pending' | 'in_progress' | 'done'
    createdAt: Date
    analyticsMode?: 'api' | 'scrape' | 'none'
    ga4PropertyId?: string
    gscSiteUrl?: string
}

export function Locations() {
    const { t } = useI18n()
    const [locations, setLocations] = useState<Location[]>([])
    const [stats, setStats] = useState({ total: 0, pending: 0, done: 0 })
    const [loading, setLoading] = useState(true)
    const [selectedIds, setSelectedIds] = useState<number[]>([])
    const [selectionMode, setSelectionMode] = useState(false)
    const [showAddModal, setShowAddModal] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [newLocation, setNewLocation] = useState({ url: '', targetReviews: 10 })

    const [showAnalyticsModal, setShowAnalyticsModal] = useState(false)
    const [editingConfig, setEditingConfig] = useState<any>({})
    const [editingLocationId, setEditingLocationId] = useState<number | null>(null)
    const [analyticsLoading, setAnalyticsLoading] = useState(false)

    useEffect(() => {
        fetchLocations()
        fetchStats()
    }, [])

    const fetchLocations = async () => {
        try {
            setLoading(true)
            const data = await window.electronAPI.locations.getAll()
            setLocations(data)
            setSelectedIds(prev => prev.filter(id => data.some((loc: Location) => loc.id === id)))
        } catch (error) {
            console.error('Failed to fetch locations:', error)
        } finally {
            setLoading(false)
        }
    }

    const fetchStats = async () => {
        try {
            const data = await window.electronAPI.locations.getStats()
            setStats(data)
        } catch (error) {
            console.error('Failed to fetch stats:', error)
        }
    }

    const handleAddLocation = async () => {
        if (!newLocation.url) return
        try {
            const result = await window.electronAPI.locations.addFromUrl(newLocation.url, newLocation.targetReviews)
            if (result) {
                await fetchLocations()
                await fetchStats()
                setNewLocation({ url: '', targetReviews: 10 })
                setShowAddModal(false)
            }
        } catch (error: any) {
            console.error('Failed to add location:', error)
            alert(`${t('locations.addFailed')}: ${error?.message || t('locations.checkUrl')}`)
        }
    }

    const handleOpenAnalyticsConfig = async (id: number) => {
        setEditingLocationId(id)
        setAnalyticsLoading(true)
        setShowAnalyticsModal(true)
        try {
            const config = await window.electronAPI.analytics.getLocationConfig(id)
            setEditingConfig(config || { analyticsMode: 'none', ga4PropertyId: '', gscSiteUrl: '' })
        } catch (error) {
            console.error('Failed to load analytics config:', error)
            alert(t('common.error'))
        } finally {
            setAnalyticsLoading(false)
        }
    }

    const handleSaveAnalyticsConfig = async () => {
        if (!editingLocationId) return
        setAnalyticsLoading(true)
        try {
            const result = await window.electronAPI.analytics.updateLocationConfig(editingLocationId, editingConfig)
            if (result?.success) {
                setShowAnalyticsModal(false)
                await fetchLocations()
                alert(t('locations.saveSuccess') || 'Success')
            } else {
                alert(result?.error || t('common.error'))
            }
        } catch (error) {
            console.error('Failed to save config:', error)
            alert(t('common.error'))
        } finally {
            setAnalyticsLoading(false)
        }
    }

    const handleDelete = async (id: number) => {
        if (!confirm(t('locations.deleteConfirm'))) return
        try {
            const result = await window.electronAPI.locations.delete(id)
            if (result?.error) {
                alert(`${t('locations.deleteFailed')}: ${result.error}`)
            }
            await fetchLocations()
            await fetchStats()
        } catch (error: any) {
            console.error('Failed to delete:', error)
            alert(`${t('locations.deleteFailed')}: ${error?.message || t('common.error')}`)
        }
    }

    const handleDeleteSelected = async () => {
        if (!confirm(t('locations.deleteSelectedConfirm').replace('{count}', String(selectedIds.length)))) return
        for (const id of selectedIds) {
            try {
                await window.electronAPI.locations.delete(id)
            } catch (error) {
                console.error(`Failed to delete location ${id}:`, error)
            }
        }
        setSelectedIds([])
        setSelectionMode(false)
        await fetchLocations()
        await fetchStats()
    }

    const filteredLocations = locations.filter(loc =>
        loc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (loc.address && loc.address.toLowerCase().includes(searchQuery.toLowerCase()))
    )

    const statusToneMap: Record<string, Tone> = {
        pending: 'amber',
        in_progress: 'blue',
        done: 'emerald',
    }

    const getProgress = (current: number, target: number) => {
        return target > 0 ? Math.min((current / target) * 100, 100) : 0
    }

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => {
            if (prev.includes(id)) {
                return prev.filter(item => item !== id)
            }
            return [...prev, id]
        })
    }

    const handleSelectAllFiltered = () => {
        setSelectedIds(filteredLocations.map(loc => loc.id))
    }

    const handleClearSelection = () => {
        setSelectedIds([])
    }

    return (
        <PageShell>
            <PageHeader
                icon={MapPin}
                tone="violet"
                title={t('locations.title')}
                subtitle={t('locations.subtitle')}
            >
                <PrimaryButton
                    icon={Plus}
                    onClick={() => setShowAddModal(true)}
                >
                    {t('locations.addLocation')}
                </PrimaryButton>
            </PageHeader>

            {/* Stats */}
            <StatRow>
                <StatCard icon={MapPin} tone="slate" value={stats.total} label={t('locations.totalLocations')} />
                <StatCard icon={BarChart3} tone="amber" value={stats.pending} label={t('common.pending')} />
                <StatCard icon={CheckCircle} tone="emerald" value={stats.done} label={t('common.completed')} />
            </StatRow>

            {/* Toolbar */}
            <Toolbar
                search={searchQuery}
                onSearchChange={setSearchQuery}
                searchPlaceholder={t('locations.searchPlaceholder')}
            >
                <PrimaryButton
                    icon={CheckCircle}
                    variant={selectionMode ? 'solid' : 'quiet'}
                    onClick={() => {
                        if (selectionMode) {
                            setSelectionMode(false)
                            setSelectedIds([])
                            return
                        }
                        setSelectionMode(true)
                    }}
                >
                    {selectionMode ? t('common.cancel') : t('common.selected')}
                </PrimaryButton>
                {selectionMode && (
                    <>
                        <PrimaryButton variant="quiet" onClick={handleSelectAllFiltered}>
                            {t('common.selectAll')}
                        </PrimaryButton>
                        <PrimaryButton variant="quiet" onClick={handleClearSelection}>
                            {t('common.deselectAll')}
                        </PrimaryButton>
                    </>
                )}
                {selectedIds.length > 0 && (
                    <PrimaryButton icon={Trash2} tone="rose" onClick={handleDeleteSelected}>
                        {t('common.delete')} ({selectedIds.length})
                    </PrimaryButton>
                )}
                <IconButton
                    icon={RefreshCw}
                    label={t('common.refresh') || 'Refresh'}
                    onClick={fetchLocations}
                    className={loading ? '[&_svg]:animate-spin' : ''}
                />
            </Toolbar>

            {/* Locations Grid */}
            {loading && locations.length === 0 ? (
                <EmptyState icon={MapPin} title={t('locations.loadingLocations')} />
            ) : filteredLocations.length === 0 ? (
                <EmptyState
                    icon={MapPin}
                    title={t('locations.noLocationsFound')}
                    action={
                        <PrimaryButton icon={Plus} onClick={() => setShowAddModal(true)}>
                            {t('locations.addLocation')}
                        </PrimaryButton>
                    }
                />
            ) : (
                <CardGrid cols={3}>
                    {filteredLocations.map((location) => (
                        <Panel
                            key={location.id}
                            tone="slate"
                            className={`p-4 transition-all ${selectedIds.includes(location.id)
                                ? '!border-[#8d74e8] !bg-[#f4f0ff] ring-2 ring-[#8d74e8]/20'
                                : ''
                                }`}
                        >
                            {selectionMode && (
                                <div className="mb-3">
                                    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-[#5f5a6d]">
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.includes(location.id)}
                                            onChange={() => toggleSelection(location.id)}
                                            className="h-4 w-4 rounded accent-[#8d74e8]"
                                        />
                                        {selectedIds.includes(location.id) ? t('common.selected') : t('common.selectAll')}
                                    </label>
                                </div>
                            )}

                            <div className="mb-3 flex items-start justify-between">
                                <div className="flex items-center gap-2.5">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f4f1fa] text-[#8d74e8]">
                                        <MapPin className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <h3 className="max-w-[180px] truncate text-sm font-semibold text-[#17171f]">{location.name}</h3>
                                        <p className="max-w-[180px] truncate text-xs text-[#908a9e]">{location.address || t('locations.noAddress')}</p>
                                    </div>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                    <StatusPill tone={statusToneMap[location.status] || 'amber'}>
                                        {location.status.replace('_', ' ')}
                                    </StatusPill>
                                    {location.analyticsMode && location.analyticsMode !== 'none' && (
                                        <Badge tone="violet">{location.analyticsMode.toUpperCase()}</Badge>
                                    )}
                                </div>
                            </div>

                            {/* Progress */}
                            <div className="mb-3">
                                <div className="mb-1.5 flex justify-between text-sm">
                                    <span className="font-medium text-[#908a9e]">{t('locations.progress')}</span>
                                    <span className="font-semibold text-[#17171f]">{location.currentReviews} / {location.targetReviews}</span>
                                </div>
                                <ProgressBar
                                    value={getProgress(location.currentReviews, location.targetReviews)}
                                    tone="violet"
                                />
                            </div>

                            {/* Actions */}
                            <Divider className="my-3" />
                            <div className="flex items-center justify-between">
                                <a
                                    href={location.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-sm font-medium text-[#8d74e8] hover:text-[#735bd6] transition-colors"
                                >
                                    <ExternalLink className="h-3 w-3" />
                                    {t('locations.viewOnMaps')}
                                </a>
                                <div className="flex gap-1">
                                    <IconButton
                                        icon={BarChart3}
                                        label={t('locations.analyticsConfig')}
                                        onClick={() => handleOpenAnalyticsConfig(location.id)}
                                        disabled={selectionMode}
                                    />
                                    <IconButton
                                        icon={Trash2}
                                        label={t('common.delete')}
                                        onClick={() => handleDelete(location.id)}
                                        disabled={selectionMode}
                                    />
                                </div>
                            </div>
                        </Panel>
                    ))}
                </CardGrid>
            )}

            {/* Add Location Modal */}
            <Modal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                title={t('locations.addLocation')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowAddModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton onClick={handleAddLocation} disabled={!newLocation.url}>
                            {t('locations.addLocation')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('locations.googleMapsUrl')}</label>
                        <TextInput
                            value={newLocation.url}
                            onChange={(v) => setNewLocation({ ...newLocation, url: v })}
                            placeholder="https://maps.google.com/..."
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('locations.targetReviews')}</label>
                        <TextInput
                            value={String(newLocation.targetReviews)}
                            onChange={(v) => setNewLocation({ ...newLocation, targetReviews: parseInt(v) || 10 })}
                            placeholder="10"
                            type="number"
                        />
                    </div>
                </div>
            </Modal>

            {/* Analytics Config Modal */}
            <Modal
                open={showAnalyticsModal}
                onClose={() => setShowAnalyticsModal(false)}
                title={t('locations.analyticsConfig')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowAnalyticsModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton
                            icon={analyticsLoading ? RefreshCw : Save}
                            onClick={handleSaveAnalyticsConfig}
                            disabled={analyticsLoading}
                            className={analyticsLoading ? '[&_svg]:animate-spin' : ''}
                        >
                            {t('locations.saveConfig')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('locations.analyticsMode')}</label>
                        <Select
                            value={editingConfig.analyticsMode || 'none'}
                            onChange={(v) => setEditingConfig({ ...editingConfig, analyticsMode: v })}
                            options={[
                                { value: 'none', label: t('locations.modeNone') },
                                { value: 'scrape', label: t('locations.modeScrape') },
                                { value: 'api', label: t('locations.modeApi') },
                            ]}
                        />
                    </div>

                    {editingConfig.analyticsMode === 'api' && (
                        <Panel tone="slate" className="space-y-4">
                            <div>
                                <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('locations.ga4PropertyId')}</label>
                                <TextInput
                                    value={editingConfig.ga4PropertyId || ''}
                                    onChange={(v) => setEditingConfig({ ...editingConfig, ga4PropertyId: v })}
                                    placeholder="e.g. 123456789"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('locations.gscSiteUrl')}</label>
                                <TextInput
                                    value={editingConfig.gscSiteUrl || ''}
                                    onChange={(v) => setEditingConfig({ ...editingConfig, gscSiteUrl: v })}
                                    placeholder="e.g. sc-domain:example.com"
                                />
                            </div>
                        </Panel>
                    )}
                </div>
            </Modal>
        </PageShell>
    )
}
