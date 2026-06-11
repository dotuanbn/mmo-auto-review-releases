import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import {
    FolderPlus,
    Folder,
    Trash2,
    CheckCircle,
    Edit,
    MoreVertical,
    MapPin,
    Rocket,
    TrendingUp,
    Archive,
    RefreshCw,
} from 'lucide-react'
import {
    CardGrid,
    EmptyState,
    Modal,
    PageHeader,
    PageShell,
    Panel,
    PrimaryButton,
    StatCard,
    StatRow,
    TextInput,
    Toolbar,
} from '../components/ui/surface'

interface Project {
    id: number
    name: string
    description?: string
    color: string
    icon: string
    status: string
    createdAt: Date
    locationCount?: number
    campaignCount?: number
    trafficCount?: number
}

const COLORS = [
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#06b6d4', // cyan
    '#10b981', // green
    '#f59e0b', // amber
    '#ef4444', // red
    '#ec4899', // pink
    '#6366f1', // indigo
]

export function Projects() {
    const { t } = useI18n()
    const [projects, setProjects] = useState<Project[]>([])
    const [loading, setLoading] = useState(true)
    const [showAddModal, setShowAddModal] = useState(false)
    const [showEditModal, setShowEditModal] = useState(false)
    const [selectedProject, setSelectedProject] = useState<Project | null>(null)
    const [selectedIds, setSelectedIds] = useState<number[]>([])
    const [selectionMode, setSelectionMode] = useState(false)
    const [activeDropdown, setActiveDropdown] = useState<number | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [newProject, setNewProject] = useState({
        name: '',
        description: '',
        color: '#3b82f6',
    })

    useEffect(() => {
        loadProjects()
    }, [])

    const loadProjects = async () => {
        try {
            setLoading(true)
            const data = await window.electronAPI.projects.getAllWithSummary()
            setProjects(data)
            setSelectedIds(prev => prev.filter(id => data.some((project: Project) => project.id === id)))
        } catch (error) {
            console.error('Failed to load projects:', error)
        } finally {
            setLoading(false)
        }
    }

    const handleCreate = async () => {
        if (!newProject.name.trim()) return
        try {
            await window.electronAPI.projects.create({
                name: newProject.name,
                description: newProject.description,
                color: newProject.color,
            })
            setShowAddModal(false)
            setNewProject({ name: '', description: '', color: '#3b82f6' })
            loadProjects()
        } catch (error) {
            console.error('Failed to create project:', error)
        }
    }

    const handleUpdate = async () => {
        if (!selectedProject) return
        try {
            await window.electronAPI.projects.update(selectedProject.id, {
                name: selectedProject.name,
                description: selectedProject.description,
                color: selectedProject.color,
            })
            setShowEditModal(false)
            setSelectedProject(null)
            loadProjects()
        } catch (error) {
            console.error('Failed to update project:', error)
        }
    }

    const handleDelete = async (id: number) => {
        if (!confirm(t('projects.deleteConfirm'))) return
        try {
            await window.electronAPI.projects.delete(id, false)
            loadProjects()
        } catch (error) {
            console.error('Failed to delete project:', error)
        }
    }

    const handleDeleteSelected = async () => {
        if (selectedIds.length === 0) return
        const translated = t('projects.deleteSelectedConfirm')
        const confirmText = translated.includes('deleteSelectedConfirm')
            ? `Delete ${selectedIds.length} projects?`
            : translated.replace('{count}', String(selectedIds.length))
        if (!confirm(confirmText)) return
        for (const id of selectedIds) {
            try {
                await window.electronAPI.projects.delete(id, false)
            } catch (error) {
                console.error(`Failed to delete project ${id}:`, error)
            }
        }
        setSelectedIds([])
        setSelectionMode(false)
        setActiveDropdown(null)
        await loadProjects()
    }

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
    }

    const handleArchive = async (id: number) => {
        try {
            await window.electronAPI.projects.archive(id)
            loadProjects()
        } catch (error) {
            console.error('Failed to archive project:', error)
        }
    }

    const filteredProjects = projects.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description?.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const activeProjects = filteredProjects.filter(p => p.status === 'active')
    const archivedProjects = filteredProjects.filter(p => p.status === 'archived')

    const handleSelectAllFiltered = () => {
        setSelectedIds(filteredProjects.map(project => project.id))
    }

    const handleClearSelection = () => {
        setSelectedIds([])
    }

    if (loading) {
        return (
            <PageShell>
                <div className="flex items-center justify-center py-20">
                    <RefreshCw className="h-6 w-6 animate-spin text-[#8d74e8]" />
                </div>
            </PageShell>
        )
    }

    return (
        <PageShell>
            {/* Header */}
            <PageHeader
                icon={Folder}
                tone="violet"
                title={t('projects.title')}
                subtitle={t('projects.subtitle')}
            >
                <PrimaryButton
                    variant="quiet"
                    icon={CheckCircle}
                    onClick={() => {
                        if (selectionMode) {
                            setSelectionMode(false)
                            setSelectedIds([])
                            setActiveDropdown(null)
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
                    <PrimaryButton
                        tone="rose"
                        icon={Trash2}
                        onClick={handleDeleteSelected}
                    >
                        {t('common.delete')} ({selectedIds.length})
                    </PrimaryButton>
                )}
                <PrimaryButton
                    icon={FolderPlus}
                    onClick={() => setShowAddModal(true)}
                >
                    {t('projects.newProject')}
                </PrimaryButton>
            </PageHeader>

            {/* Search */}
            <Toolbar
                search={searchQuery}
                onSearchChange={setSearchQuery}
                searchPlaceholder={t('projects.searchPlaceholder')}
            />

            {/* Stats Cards */}
            <StatRow className="lg:grid-cols-3">
                <StatCard
                    icon={Folder}
                    label={t('projects.activeProjects')}
                    value={activeProjects.length}
                    tone="violet"
                />
                <StatCard
                    icon={Rocket}
                    label={t('projects.totalCampaigns')}
                    value={projects.reduce((sum, p) => sum + (p.campaignCount || 0), 0)}
                    tone="blue"
                />
                <StatCard
                    icon={TrendingUp}
                    label={t('projects.trafficTasks')}
                    value={projects.reduce((sum, p) => sum + (p.trafficCount || 0), 0)}
                    tone="emerald"
                />
            </StatRow>

            {/* Active Projects */}
            <div>
                <h2 className="mb-4 text-lg font-semibold text-[#24222c]">{t('projects.activeProjects')}</h2>
                {activeProjects.length === 0 ? (
                    <EmptyState
                        icon={Folder}
                        title={t('projects.noActiveProjects')}
                        subtitle={t('projects.createFirstProject')}
                        action={
                            <PrimaryButton icon={FolderPlus} onClick={() => setShowAddModal(true)}>
                                {t('projects.newProject')}
                            </PrimaryButton>
                        }
                    />
                ) : (
                    <CardGrid cols={3}>
                        {activeProjects.map((project) => (
                            <Panel
                                key={project.id}
                                className={`relative overflow-hidden p-4 transition-colors ${
                                    selectedIds.includes(project.id)
                                        ? 'ring-2 ring-[#8d74e8] ring-offset-2'
                                        : ''
                                }`}
                            >
                                {/* Color indicator */}
                                <div
                                    className="absolute left-0 right-0 top-0 h-1 rounded-t-[24px]"
                                    style={{ backgroundColor: project.color }}
                                />

                                {/* Header */}
                                <div className="mt-2 flex items-start justify-between">
                                    <div className="flex items-center gap-3">
                                        {selectionMode && (
                                            <input
                                                type="checkbox"
                                                checked={selectedIds.includes(project.id)}
                                                onChange={() => toggleSelection(project.id)}
                                                className="h-4 w-4 rounded accent-[#8d74e8]"
                                            />
                                        )}
                                        <div
                                            className="rounded-[12px] p-2"
                                            style={{ backgroundColor: `${project.color}15` }}
                                        >
                                            <Folder className="h-5 w-5" style={{ color: project.color }} />
                                        </div>
                                        <div>
                                            <h3 className="font-semibold text-[#17171f]">{project.name}</h3>
                                            {project.description && (
                                                <p className="line-clamp-1 text-sm text-[#8e899b]">{project.description}</p>
                                            )}
                                        </div>
                                    </div>

                                    {/* Actions dropdown */}
                                    <div className="relative">
                                        <button
                                            disabled={selectionMode}
                                            onClick={() => setActiveDropdown(activeDropdown === project.id ? null : project.id)}
                                            className="rounded-full p-1 text-[#908a9e] opacity-0 transition-opacity hover:bg-[#f4f1fa] group-hover:opacity-100 [div:hover>&]:opacity-100"
                                            type="button"
                                        >
                                            <MoreVertical className="h-4 w-4" />
                                        </button>

                                        {activeDropdown === project.id && (
                                            <div className="absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-[16px] border border-[#e9e4f2] bg-white shadow-[0_18px_48px_rgba(40,36,54,0.12)]">
                                                <button
                                                    onClick={() => {
                                                        setSelectedProject(project)
                                                        setShowEditModal(true)
                                                        setActiveDropdown(null)
                                                    }}
                                                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-[#5f5a6d] hover:bg-[#f4f1fa]"
                                                    type="button"
                                                >
                                                    <Edit className="h-4 w-4" />
                                                    {t('common.edit')}
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        handleArchive(project.id)
                                                        setActiveDropdown(null)
                                                    }}
                                                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-[#5f5a6d] hover:bg-[#f4f1fa]"
                                                    type="button"
                                                >
                                                    <Archive className="h-4 w-4" />
                                                    {t('projects.archive')}
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        handleDelete(project.id)
                                                        setActiveDropdown(null)
                                                    }}
                                                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-rose-500 hover:bg-rose-50"
                                                    type="button"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                    {t('common.delete')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Stats */}
                                <div className="mt-4 flex items-center gap-4 border-t border-[#e9e4f2] pt-4">
                                    <div className="flex items-center gap-1 text-sm text-[#908a9e]">
                                        <MapPin className="h-4 w-4" />
                                        <span>{project.locationCount || 0}</span>
                                    </div>
                                    <div className="flex items-center gap-1 text-sm text-[#908a9e]">
                                        <Rocket className="h-4 w-4" />
                                        <span>{project.campaignCount || 0}</span>
                                    </div>
                                    <div className="flex items-center gap-1 text-sm text-[#908a9e]">
                                        <TrendingUp className="h-4 w-4" />
                                        <span>{project.trafficCount || 0}</span>
                                    </div>
                                </div>
                            </Panel>
                        ))}
                    </CardGrid>
                )}
            </div>

            {/* Archived Projects */}
            {archivedProjects.length > 0 && (
                <div>
                    <h2 className="mb-4 text-lg font-semibold text-[#908a9e]">{t('projects.archivedProjects')}</h2>
                    <CardGrid cols={3}>
                        {archivedProjects.map((project) => (
                            <Panel
                                key={project.id}
                                className={`p-4 opacity-60 ${
                                    selectedIds.includes(project.id)
                                        ? 'ring-2 ring-[#8d74e8] ring-offset-2'
                                        : ''
                                }`}
                            >
                                <div className="flex items-center gap-3">
                                    {selectionMode && (
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.includes(project.id)}
                                            onChange={() => toggleSelection(project.id)}
                                            className="h-4 w-4 rounded accent-[#8d74e8]"
                                        />
                                    )}
                                    <Archive className="h-5 w-5 text-[#908a9e]" />
                                    <span className="text-[#5f5a6d]">{project.name}</span>
                                </div>
                            </Panel>
                        ))}
                    </CardGrid>
                </div>
            )}

            {/* Add Project Modal */}
            <Modal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                title={t('projects.newProject')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowAddModal(false)}>
                            {t('common.cancel')}
                        </PrimaryButton>
                        <PrimaryButton onClick={handleCreate} disabled={!newProject.name.trim()}>
                            {t('projects.createProject')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="mb-2 block text-sm font-medium text-[#5f5a6d]">{t('projects.projectNameRequired')}</label>
                        <TextInput
                            value={newProject.name}
                            onChange={(val) => setNewProject({ ...newProject, name: val })}
                            placeholder="My Google Maps Project"
                        />
                    </div>

                    <div>
                        <label className="mb-2 block text-sm font-medium text-[#5f5a6d]">{t('projects.projectDescription')}</label>
                        <textarea
                            value={newProject.description}
                            onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                            className="h-20 w-full rounded-[16px] border border-[#e9e4f2] bg-white px-4 py-3 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                            placeholder="Optional description..."
                        />
                    </div>

                    <div>
                        <label className="mb-2 block text-sm font-medium text-[#5f5a6d]">{t('common.color')}</label>
                        <div className="flex gap-2">
                            {COLORS.map((color) => (
                                <button
                                    key={color}
                                    onClick={() => setNewProject({ ...newProject, color })}
                                    className={`h-8 w-8 rounded-full transition-all ${newProject.color === color ? 'ring-2 ring-[#8d74e8] ring-offset-2 ring-offset-white' : ''}`}
                                    style={{ backgroundColor: color }}
                                    type="button"
                                />
                            ))}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Edit Project Modal */}
            <Modal
                open={showEditModal && selectedProject !== null}
                onClose={() => setShowEditModal(false)}
                title={t('projects.editProject')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowEditModal(false)}>
                            {t('common.cancel')}
                        </PrimaryButton>
                        <PrimaryButton onClick={handleUpdate} disabled={!selectedProject?.name.trim()}>
                            {t('common.save')}
                        </PrimaryButton>
                    </>
                }
            >
                {selectedProject && (
                    <div className="space-y-4">
                        <div>
                            <label className="mb-2 block text-sm font-medium text-[#5f5a6d]">{t('projects.projectNameRequired')}</label>
                            <TextInput
                                value={selectedProject.name}
                                onChange={(val) => setSelectedProject({ ...selectedProject, name: val })}
                            />
                        </div>

                        <div>
                            <label className="mb-2 block text-sm font-medium text-[#5f5a6d]">{t('projects.projectDescription')}</label>
                            <textarea
                                value={selectedProject.description || ''}
                                onChange={(e) => setSelectedProject({ ...selectedProject, description: e.target.value })}
                                className="h-20 w-full rounded-[16px] border border-[#e9e4f2] bg-white px-4 py-3 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                            />
                        </div>

                        <div>
                            <label className="mb-2 block text-sm font-medium text-[#5f5a6d]">{t('common.color')}</label>
                            <div className="flex gap-2">
                                {COLORS.map((color) => (
                                    <button
                                        key={color}
                                        onClick={() => setSelectedProject({ ...selectedProject, color })}
                                        className={`h-8 w-8 rounded-full transition-all ${selectedProject.color === color ? 'ring-2 ring-[#8d74e8] ring-offset-2 ring-offset-white' : ''}`}
                                        style={{ backgroundColor: color }}
                                        type="button"
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </Modal>
        </PageShell>
    )
}
