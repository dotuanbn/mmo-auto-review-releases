import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { Scripts } from './Scripts'
import {
    Plus,
    FileText,
    Trash2,
    RefreshCw,
    Edit,
    Eye,
    Folder,
    Images,
    Wand2,
    CheckCircle,
    Copy,
    Sparkles,
    Bot,
    Loader2,
    Save,
    Key,
    Zap,
    Film,
    MapPin
} from 'lucide-react'
import {
    PageHeader,
    PageShell,
    SegmentedTabs,
    Panel,
    PrimaryButton,
    IconButton,
    Modal,
    Badge,
    EmptyState,
    AlertBanner,
    CardGrid,
    Divider,
    TextInput,
    Select,
    Toggle
} from '../components/ui/surface'

type TopTab = 'content' | 'scripts'

export function ContentManager() {
    const { t } = useI18n()
    const [topTab, setTopTab] = useState<TopTab>('content')

    return (
        <div className="h-full flex flex-col">
            <div className="border-b border-[#eeeaf8] px-5 py-5 lg:px-7">
                <PageHeader
                    icon={Film}
                    tone="violet"
                    title={t('sidebar.contentScripts')}
                    subtitle="Quản lý nội dung review, hình ảnh và automation scripts"
                >
                    <SegmentedTabs<TopTab>
                        value={topTab}
                        onChange={setTopTab}
                        items={[
                            { id: 'content', label: 'Nội dung', icon: FileText },
                            { id: 'scripts', label: 'Scripts', icon: Zap },
                        ]}
                    />
                </PageHeader>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-auto">
                {topTab === 'content' ? <ContentTab /> : <Scripts />}
            </div>
        </div>
    )
}

interface ReviewTemplate {
    id: number
    name: string
    content: string
    category: string
    isActive: boolean
    useCount: number
    createdAt: string
    updatedAt: string
}

interface ImageFolder {
    id: number
    name: string
    path: string
    category: string
    imageCount: number
}

function ContentTab() {
    const { t } = useI18n()
    const [templates, setTemplates] = useState<ReviewTemplate[]>([])
    const [imageFolders, setImageFolders] = useState<ImageFolder[]>([])
    const [selectedTemplateIds, setSelectedTemplateIds] = useState<number[]>([])
    const [selectedFolderIds, setSelectedFolderIds] = useState<number[]>([])
    const [templateSelectionMode, setTemplateSelectionMode] = useState(false)
    const [folderSelectionMode, setFolderSelectionMode] = useState(false)
    const [loading, setLoading] = useState(false)
    const [activeTab, setActiveTab] = useState<'templates' | 'images'>('templates')
    const [showAddModal, setShowAddModal] = useState(false)
    const [showPreviewModal, setShowPreviewModal] = useState(false)
    const [editingTemplate, setEditingTemplate] = useState<ReviewTemplate | null>(null)
    const [newTemplate, setNewTemplate] = useState({ name: '', content: '', category: '5_star' })
    const [previewText, setPreviewText] = useState('')
    const [previewVariations, setPreviewVariations] = useState<string[]>([])

    // AI Generate states
    const [showAIModal, setShowAIModal] = useState(false)
    const [aiGenerating, setAiGenerating] = useState(false)
    const [aiConfig, setAiConfig] = useState({
        locationName: '',
        category: '',
        style: 'casual' as 'casual' | 'professional' | 'enthusiastic',
        language: 'vi' as 'vi' | 'en',
        rating: 5,
        length: 'medium' as 'short' | 'medium' | 'long',
        count: 3
    })
    const [aiGeneratedReviews, setAiGeneratedReviews] = useState<any[]>([])
    const [aiApiKeyStatus, setAiApiKeyStatus] = useState<{ hasKey: boolean; isValid?: boolean }>({ hasKey: false })
    const [showApiKeyInput, setShowApiKeyInput] = useState(false)
    const [apiKeyInput, setApiKeyInput] = useState('')
    const [apiKeySaving, setApiKeySaving] = useState(false)

    useEffect(() => {
        fetchData()
    }, [])

    const fetchData = async () => {
        setLoading(true)
        try {
            const data = await window.electronAPI.templates.getAll()
            setTemplates(data || [])
            setSelectedTemplateIds(prev => prev.filter(id => (data || []).some((template: ReviewTemplate) => template.id === id)))
            // Load image folders
            const folders = await window.electronAPI.images.getFolders()
            setImageFolders(folders || [])
            setSelectedFolderIds(prev => prev.filter(id => (folders || []).some((folder: ImageFolder) => folder.id === id)))
        } catch (error) {
            console.error('Failed to fetch data:', error)
        }
        setLoading(false)
    }

    const handleAddTemplate = async () => {
        if (!newTemplate.name || !newTemplate.content) return
        try {
            await window.electronAPI.templates.create(newTemplate)
            setNewTemplate({ name: '', content: '', category: '5_star' })
            setShowAddModal(false)
            fetchData()
        } catch (error) {
            console.error('Failed to create template:', error)
        }
    }

    const handleUpdateTemplate = async () => {
        if (!editingTemplate) return
        try {
            await window.electronAPI.templates.update(editingTemplate.id, {
                name: editingTemplate.name,
                content: editingTemplate.content,
                category: editingTemplate.category,
                isActive: editingTemplate.isActive
            })
            setEditingTemplate(null)
            fetchData()
        } catch (error) {
            console.error('Failed to update template:', error)
        }
    }

    const handleDeleteTemplate = async (id: number) => {
        if (!confirm(t('content.deleteConfirm'))) return
        try {
            await window.electronAPI.templates.delete(id)
            fetchData()
        } catch (error) {
            console.error('Failed to delete template:', error)
        }
    }

    const handleDeleteSelectedTemplates = async () => {
        if (selectedTemplateIds.length === 0) return
        const translated = t('content.deleteSelectedTemplatesConfirm')
        const confirmText = translated.includes('deleteSelectedTemplatesConfirm')
            ? `Delete ${selectedTemplateIds.length} templates?`
            : translated.replace('{count}', String(selectedTemplateIds.length))
        if (!confirm(confirmText)) return
        for (const id of selectedTemplateIds) {
            try {
                await window.electronAPI.templates.delete(id)
            } catch (error) {
                console.error(`Failed to delete template ${id}:`, error)
            }
        }
        setSelectedTemplateIds([])
        setTemplateSelectionMode(false)
        await fetchData()
    }

    const handleDeleteSelectedFolders = async () => {
        if (selectedFolderIds.length === 0) return
        const translated = t('content.deleteSelectedFoldersConfirm')
        const confirmText = translated.includes('deleteSelectedFoldersConfirm')
            ? `Delete ${selectedFolderIds.length} image folders?`
            : translated.replace('{count}', String(selectedFolderIds.length))
        if (!confirm(confirmText)) return
        for (const id of selectedFolderIds) {
            try {
                await window.electronAPI.images.deleteFolder(id)
            } catch (error) {
                console.error(`Failed to delete image folder ${id}:`, error)
            }
        }
        setSelectedFolderIds([])
        setFolderSelectionMode(false)
        const folders = await window.electronAPI.images.getFolders()
        setImageFolders(folders || [])
    }

    const toggleTemplateSelection = (id: number) => {
        setSelectedTemplateIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
    }

    const toggleFolderSelection = (id: number) => {
        setSelectedFolderIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
    }

    const handleSelectAllTemplates = () => {
        setSelectedTemplateIds(templates.map(template => template.id))
    }

    const handleClearTemplateSelection = () => {
        setSelectedTemplateIds([])
    }

    const handleSelectAllFolders = () => {
        setSelectedFolderIds(imageFolders.map(folder => folder.id))
    }

    const handleClearFolderSelection = () => {
        setSelectedFolderIds([])
    }

    const handlePreviewSpintax = async (content: string) => {
        try {
            const result = await window.electronAPI.templates.preview(content)
            setPreviewText(content)
            setPreviewVariations(result.variations || [])
            setShowPreviewModal(true)
        } catch (error) {
            console.error('Preview failed:', error)
        }
    }

    const handleGenerateMore = async () => {
        try {
            const result = await window.electronAPI.templates.generateVariations(previewText, 5)
            setPreviewVariations(result || [])
        } catch (error) {
            console.error('Generate failed:', error)
        }
    }

    // AI Generate Functions
    const checkApiKeyStatus = async () => {
        try {
            const status = await window.electronAPI.ai.getApiKeyStatus()
            setAiApiKeyStatus(status)
            if (!status.hasKey) {
                setShowApiKeyInput(true)
            }
        } catch (error) {
            console.error('Failed to check API key status:', error)
        }
    }

    const handleOpenAIModal = async () => {
        await checkApiKeyStatus()
        setShowAIModal(true)
        setAiGeneratedReviews([])
    }

    const handleAIGenerate = async () => {
        if (!aiConfig.locationName.trim()) {
            alert('Vui lòng nhập tên địa điểm')
            return
        }
        setAiGenerating(true)
        try {
            const result = await window.electronAPI.ai.generateBulk(
                aiConfig.count,
                aiConfig.locationName,
                aiConfig.category,
                {
                    style: aiConfig.style,
                    language: aiConfig.language,
                    rating: aiConfig.rating,
                    length: aiConfig.length
                }
            )
            if (result.success && result.reviews) {
                setAiGeneratedReviews(result.reviews)
            } else {
                alert(result.error || 'Failed to generate reviews')
            }
        } catch (error: any) {
            alert(error.message || 'Failed to generate reviews')
        }
        setAiGenerating(false)
    }

    const handleSaveAIReview = async (review: any) => {
        try {
            const result = await window.electronAPI.ai.saveReview(review)
            if (result.success) {
                await fetchData()
                // Remove from generated list
                setAiGeneratedReviews(prev => prev.filter(r => r.content !== review.content))
            } else {
                alert(result.error || 'Failed to save review')
            }
        } catch (error: any) {
            alert(error.message || 'Failed to save review')
        }
    }

    const handleSetApiKey = async () => {
        if (!apiKeyInput.trim()) return
        setApiKeySaving(true)
        try {
            const result = await window.electronAPI.ai.setApiKey(apiKeyInput)
            if (result.success) {
                setAiApiKeyStatus({ hasKey: true, isValid: true })
                setShowApiKeyInput(false)
                setApiKeyInput('')
            } else {
                alert(result.error || 'Invalid API key')
            }
        } catch (error: any) {
            alert(error.message || 'Failed to set API key')
        }
        setApiKeySaving(false)
    }

    const getCategoryBadge = (category: string): 'violet' | 'blue' | 'emerald' | 'amber' | 'slate' => {
        const map: Record<string, 'violet' | 'blue' | 'emerald' | 'amber' | 'slate'> = {
            '5_star': 'amber',
            '4_star': 'blue',
            'short': 'emerald',
            'detailed': 'violet',
            'general': 'slate',
        }
        return map[category] || 'slate'
    }

    return (
        <PageShell>
            {/* Header */}
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-[#17171f]">{t('content.title')}</h2>
                    <p className="text-sm text-[#8e899b] mt-1">{t('content.subtitle')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                    <IconButton
                        icon={RefreshCw}
                        label="Refresh"
                        onClick={fetchData}
                        className={loading ? 'animate-spin' : undefined}
                    />
                    <PrimaryButton icon={Bot} onClick={handleOpenAIModal}>
                        {t('content.aiGenerate')}
                    </PrimaryButton>
                    <PrimaryButton icon={Plus} tone="blue" onClick={() => setShowAddModal(true)}>
                        {t('content.addTemplate')}
                    </PrimaryButton>
                </div>
            </div>

            {/* Tabs */}
            <SegmentedTabs<'templates' | 'images'>
                value={activeTab}
                onChange={setActiveTab}
                items={[
                    { id: 'templates', label: `${t('content.templates')} (${templates.length})`, icon: FileText },
                    { id: 'images', label: `${t('content.imageFolders')} (${imageFolders.length})`, icon: Images },
                ]}
            />

            {/* Spintax Guide */}
            {activeTab === 'templates' && (
                <Panel tone="violet" className="p-4">
                    <h3 className="text-[#735bd6] font-semibold mb-2 flex items-center gap-2">
                        <Sparkles className="w-4 h-4" />
                        Spintax Guide
                    </h3>
                    <div className="text-sm text-[#5f5a6d] space-y-2">
                        <p>Use <code className="bg-[#f4f1fa] px-1.5 py-0.5 rounded text-[#735bd6] text-xs font-mono">{'{option1|option2|option3}'}</code> to create variations</p>
                        <div className="bg-white/60 p-3 rounded-[14px] border border-[#e9e4f2]">
                            <p className="text-[#908a9e] text-xs mb-1">Example:</p>
                            <code className="text-[#735bd6] text-xs">
                                {'Dịch vụ {tuyệt vời|rất tốt|xuất sắc}! {Tôi|Mình} rất {hài lòng|thích}.'}
                            </code>
                            <p className="text-[#908a9e] text-xs mt-2">
                                Could generate: "Dịch vụ tuyệt vời! Mình rất hài lòng."
                            </p>
                        </div>
                    </div>
                </Panel>
            )}

            {/* Templates List */}
            {activeTab === 'templates' && (
                <div className="space-y-4">
                    {/* Selection Toolbar */}
                    <div className="flex items-center justify-end gap-2">
                        <PrimaryButton
                            variant="quiet"
                            icon={CheckCircle}
                            onClick={() => {
                                if (templateSelectionMode) {
                                    setTemplateSelectionMode(false)
                                    setSelectedTemplateIds([])
                                    return
                                }
                                setTemplateSelectionMode(true)
                            }}
                            className={templateSelectionMode ? '!border-[#8d74e8] !bg-[#f4f0ff] !text-[#735bd6]' : ''}
                        >
                            {templateSelectionMode ? t('common.cancel') : t('common.selected')}
                        </PrimaryButton>
                        {templateSelectionMode && (
                            <>
                                <PrimaryButton variant="quiet" onClick={handleSelectAllTemplates}>
                                    {t('common.selectAll')}
                                </PrimaryButton>
                                <PrimaryButton variant="quiet" onClick={handleClearTemplateSelection}>
                                    {t('common.deselectAll')}
                                </PrimaryButton>
                            </>
                        )}
                        {selectedTemplateIds.length > 0 && (
                            <PrimaryButton icon={Trash2} tone="rose" onClick={handleDeleteSelectedTemplates}>
                                {t('common.delete')} ({selectedTemplateIds.length})
                            </PrimaryButton>
                        )}
                    </div>

                    {templates.length === 0 ? (
                        <EmptyState
                            icon={FileText}
                            title="No templates yet"
                            subtitle="Create your first review template!"
                            action={
                                <PrimaryButton icon={Plus} onClick={() => setShowAddModal(true)}>
                                    {t('content.addTemplate')}
                                </PrimaryButton>
                            }
                        />
                    ) : (
                        <div className="space-y-3">
                            {templates.map((template) => (
                                <Panel key={template.id} tone="slate" className={`p-4 transition-colors ${selectedTemplateIds.includes(template.id) ? '!border-[#8d74e8] !bg-[#f8f6ff]' : ''}`}>
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-3 mb-2">
                                                {templateSelectionMode && (
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedTemplateIds.includes(template.id)}
                                                        onChange={() => toggleTemplateSelection(template.id)}
                                                        className="h-4 w-4 rounded accent-[#8d74e8]"
                                                    />
                                                )}
                                                <span className="text-[#17171f] font-semibold">{template.name}</span>
                                                <Badge tone={getCategoryBadge(template.category)}>{template.category}</Badge>
                                                {template.isActive ? (
                                                    <Badge tone="emerald" dot>
                                                        {t('common.active')}
                                                    </Badge>
                                                ) : (
                                                    <Badge tone="slate">{t('common.inactive')}</Badge>
                                                )}
                                            </div>
                                            <div className="bg-[#f7f7f9] border border-[#e9e4f2] rounded-[14px] p-2.5 font-mono text-sm text-[#5f5a6d]">
                                                {template.content.length > 200
                                                    ? template.content.substring(0, 200) + '...'
                                                    : template.content}
                                            </div>
                                            <div className="flex items-center gap-4 mt-2 text-xs text-[#908a9e]">
                                                <span>Used: {template.useCount} times</span>
                                                <span>Created: {new Date(template.createdAt).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 ml-4">
                                            <IconButton
                                                icon={Eye}
                                                label="Preview variations"
                                                onClick={() => handlePreviewSpintax(template.content)}
                                            />
                                            <IconButton
                                                icon={Edit}
                                                label="Edit"
                                                onClick={() => setEditingTemplate(template)}
                                            />
                                            <IconButton
                                                icon={Trash2}
                                                label="Delete"
                                                onClick={() => handleDeleteTemplate(template.id)}
                                                disabled={templateSelectionMode}
                                            />
                                        </div>
                                    </div>
                                </Panel>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Image Folders List */}
            {activeTab === 'images' && (
                <div className="space-y-4">
                    {/* Toolbar */}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <PrimaryButton
                            variant="quiet"
                            icon={CheckCircle}
                            onClick={() => {
                                if (folderSelectionMode) {
                                    setFolderSelectionMode(false)
                                    setSelectedFolderIds([])
                                    return
                                }
                                setFolderSelectionMode(true)
                            }}
                            className={folderSelectionMode ? '!border-[#8d74e8] !bg-[#f4f0ff] !text-[#735bd6]' : ''}
                        >
                            {folderSelectionMode ? t('common.cancel') : t('common.selected')}
                        </PrimaryButton>
                        {folderSelectionMode && (
                            <>
                                <PrimaryButton variant="quiet" onClick={handleSelectAllFolders}>
                                    {t('common.selectAll')}
                                </PrimaryButton>
                                <PrimaryButton variant="quiet" onClick={handleClearFolderSelection}>
                                    {t('common.deselectAll')}
                                </PrimaryButton>
                            </>
                        )}
                        {selectedFolderIds.length > 0 && (
                            <PrimaryButton icon={Trash2} tone="rose" onClick={handleDeleteSelectedFolders}>
                                {t('common.delete')} ({selectedFolderIds.length})
                            </PrimaryButton>
                        )}
                        <PrimaryButton
                            icon={Plus}
                            tone="blue"
                            onClick={async () => {
                                const folder = await window.electronAPI.images.selectFolder()
                                if (folder) {
                                    const result = await window.electronAPI.images.addFolder(folder.path)
                                    if (result.success) {
                                        const folders = await window.electronAPI.images.getFolders()
                                        setImageFolders(folders || [])
                                    }
                                }
                            }}
                        >
                            {t('content.browseFolder')}
                        </PrimaryButton>
                    </div>

                    {/* Folders Grid */}
                    {imageFolders.length === 0 ? (
                        <EmptyState
                            icon={Folder}
                            title="No image folders configured"
                            subtitle='Click "Add Folder" to import image folders for reviews.'
                        />
                    ) : (
                        <CardGrid cols={3}>
                            {imageFolders.map((folder) => (
                                <Panel
                                    key={folder.id}
                                    tone="slate"
                                    className={`p-4 group transition-colors ${selectedFolderIds.includes(folder.id) ? '!border-[#8d74e8] !bg-[#f8f6ff]' : ''}`}
                                >
                                    <div className="flex items-start justify-between">
                                        <div className="flex items-center gap-3 min-w-0">
                                            {folderSelectionMode && (
                                                <input
                                                    type="checkbox"
                                                    checked={selectedFolderIds.includes(folder.id)}
                                                    onChange={() => toggleFolderSelection(folder.id)}
                                                    className="h-4 w-4 rounded accent-[#8d74e8]"
                                                />
                                            )}
                                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-500">
                                                <Folder className="w-5 h-5" />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="text-[#17171f] font-semibold text-sm">{folder.name}</h3>
                                                <p className="text-[#5f5a6d] text-xs">{folder.imageCount} images</p>
                                                <p className="text-[#908a9e] text-xs truncate max-w-[180px]" title={folder.path}>
                                                    {folder.path}
                                                </p>
                                            </div>
                                        </div>
                                        <IconButton
                                            icon={Trash2}
                                            label="Delete folder"
                                            onClick={async () => {
                                                if (confirm('Delete this folder?')) {
                                                    await window.electronAPI.images.deleteFolder(folder.id)
                                                    const folders = await window.electronAPI.images.getFolders()
                                                    setImageFolders(folders || [])
                                                }
                                            }}
                                            disabled={folderSelectionMode}
                                            className="opacity-0 group-hover:opacity-100 transition-all"
                                        />
                                    </div>
                                </Panel>
                            ))}
                        </CardGrid>
                    )}
                </div>
            )}

            {/* Add Template Modal */}
            <Modal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                title="Create Template"
                size="lg"
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowAddModal(false)}>
                            {t('common.cancel')}
                        </PrimaryButton>
                        <PrimaryButton
                            onClick={handleAddTemplate}
                            disabled={!newTemplate.name || !newTemplate.content}
                        >
                            {t('content.addTemplate')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.templateName')}</label>
                            <TextInput
                                value={newTemplate.name}
                                onChange={(val) => setNewTemplate({ ...newTemplate, name: val })}
                                placeholder="e.g., 5 Star Review"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.category')}</label>
                            <Select
                                value={newTemplate.category}
                                onChange={(val) => setNewTemplate({ ...newTemplate, category: val })}
                                options={[
                                    { value: '5_star', label: '5 Star' },
                                    { value: '4_star', label: '4 Star' },
                                    { value: 'short', label: 'Short' },
                                    { value: 'detailed', label: 'Detailed' },
                                    { value: 'general', label: 'General' },
                                ]}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-semibold text-[#24222c] mb-1.5">
                            {t('common.content')} <span className="text-[#735bd6] font-normal">(Spintax)</span>
                        </label>
                        <textarea
                            value={newTemplate.content}
                            onChange={(e) => setNewTemplate({ ...newTemplate, content: e.target.value })}
                            className="w-full h-40 px-4 py-3 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] font-mono placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                            placeholder="{Dịch vụ|Trải nghiệm} {tuyệt vời|rất tốt}! {Tôi|Mình} rất {hài lòng|thích}."
                        />
                    </div>
                </div>
            </Modal>

            {/* Edit Template Modal */}
            <Modal
                open={!!editingTemplate}
                onClose={() => setEditingTemplate(null)}
                title={t('content.editTemplate')}
                size="lg"
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setEditingTemplate(null)}>
                            {t('common.cancel')}
                        </PrimaryButton>
                        <PrimaryButton onClick={handleUpdateTemplate}>
                            {t('common.save')}
                        </PrimaryButton>
                    </>
                }
            >
                {editingTemplate && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.templateName')}</label>
                                <TextInput
                                    value={editingTemplate.name}
                                    onChange={(val) => setEditingTemplate({ ...editingTemplate, name: val })}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.category')}</label>
                                <Select
                                    value={editingTemplate.category}
                                    onChange={(val) => setEditingTemplate({ ...editingTemplate, category: val })}
                                    options={[
                                        { value: '5_star', label: '5 Star' },
                                        { value: '4_star', label: '4 Star' },
                                        { value: 'short', label: 'Short' },
                                        { value: 'detailed', label: 'Detailed' },
                                        { value: 'general', label: 'General' },
                                    ]}
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('common.content')}</label>
                            <textarea
                                value={editingTemplate.content}
                                onChange={(e) => setEditingTemplate({ ...editingTemplate, content: e.target.value })}
                                className="w-full h-40 px-4 py-3 rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] font-mono focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                            />
                        </div>

                        <div className="flex items-center gap-3">
                            <Toggle
                                checked={editingTemplate.isActive}
                                onChange={(val) => setEditingTemplate({ ...editingTemplate, isActive: val })}
                            />
                            <span className="text-sm text-[#5f5a6d] font-medium">Active</span>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Preview Modal */}
            <Modal
                open={showPreviewModal}
                onClose={() => setShowPreviewModal(false)}
                title={t('content.previewSpintax')}
                size="lg"
            >
                <div className="space-y-3">
                    {previewVariations.map((variation, index) => (
                        <div
                            key={index}
                            className="bg-[#f7f7f9] border border-[#e9e4f2] p-3 rounded-[14px] flex items-start justify-between gap-3"
                        >
                            <p className="text-[#5f5a6d] text-sm flex-1">{variation}</p>
                            <IconButton
                                icon={Copy}
                                label="Copy"
                                onClick={() => navigator.clipboard.writeText(variation)}
                            />
                        </div>
                    ))}
                </div>

                <div className="flex justify-center mt-4">
                    <PrimaryButton icon={Wand2} onClick={handleGenerateMore}>
                        {t('common.generate')}
                    </PrimaryButton>
                </div>
            </Modal>

            {/* AI Generate Modal */}
            <Modal
                open={showAIModal}
                onClose={() => setShowAIModal(false)}
                title={t('content.aiGenerate')}
                size="xl"
            >
                {/* API Key Status */}
                {!aiApiKeyStatus.hasKey || showApiKeyInput ? (
                    <AlertBanner type="warning" title={t('content.apiKeyRequired')} className="mb-4">
                        <p className="text-sm mt-1">
                            Để sử dụng tính năng AI Generate, bạn cần có OpenRouter API key.{' '}
                            <a href="#" className="underline mt-1 block hover:text-amber-800 font-medium" onClick={(e) => { e.preventDefault(); window.electronAPI.openExternal('https://console.groq.com/keys'); }}>
                                Lấy OpenRouter API key miễn phí tại đây (Khuyên dùng)
                            </a>
                        </p>
                        <div className="flex gap-2 mt-3">
                            <TextInput
                                value={apiKeyInput}
                                onChange={setApiKeyInput}
                                placeholder={t('content.apiKeyPlaceholder')}
                                type="password"
                                className="flex-1"
                                icon={Key}
                            />
                            <PrimaryButton
                                icon={apiKeySaving ? Loader2 : Key}
                                tone="amber"
                                onClick={handleSetApiKey}
                                disabled={apiKeySaving || !apiKeyInput.trim()}
                            >
                                {t('common.save')}
                            </PrimaryButton>
                        </div>
                    </AlertBanner>
                ) : (
                    <AlertBanner type="success" className="mb-4">
                        <div className="flex items-center justify-between w-full">
                            <span className="text-sm font-medium">API key đã được cấu hình</span>
                            <PrimaryButton
                                variant="quiet"
                                onClick={() => setShowApiKeyInput(true)}
                                className="!px-2.5 !py-1 !text-xs"
                            >
                                Đổi key
                            </PrimaryButton>
                        </div>
                    </AlertBanner>
                )}

                {/* AI Config Form */}
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.locationName')} *</label>
                            <TextInput
                                value={aiConfig.locationName}
                                onChange={(val) => setAiConfig({ ...aiConfig, locationName: val })}
                                placeholder="VD: Nhà hàng ABC, Khách sạn XYZ..."
                                icon={MapPin}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.category')}</label>
                            <TextInput
                                value={aiConfig.category}
                                onChange={(val) => setAiConfig({ ...aiConfig, category: val })}
                                placeholder="VD: Nhà hàng, Cafe, Spa..."
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-4 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.style')}</label>
                            <Select
                                value={aiConfig.style}
                                onChange={(val) => setAiConfig({ ...aiConfig, style: val as 'casual' | 'professional' | 'enthusiastic' })}
                                options={[
                                    { value: 'casual', label: t('content.casual') },
                                    { value: 'professional', label: t('content.professional') },
                                    { value: 'enthusiastic', label: t('content.enthusiastic') },
                                ]}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.language')}</label>
                            <Select
                                value={aiConfig.language}
                                onChange={(val) => setAiConfig({ ...aiConfig, language: val as 'vi' | 'en' })}
                                options={[
                                    { value: 'vi', label: t('content.vietnamese') },
                                    { value: 'en', label: t('content.english') },
                                ]}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.ratingLabel')}</label>
                            <Select
                                value={String(aiConfig.rating)}
                                onChange={(val) => setAiConfig({ ...aiConfig, rating: parseInt(val) })}
                                options={[5, 4, 3, 2, 1].map(r => ({ value: String(r), label: `${r} sao` }))}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-[#24222c] mb-1.5">{t('content.count')}</label>
                            <Select
                                value={String(aiConfig.count)}
                                onChange={(val) => setAiConfig({ ...aiConfig, count: parseInt(val) })}
                                options={[1, 3, 5, 10].map(c => ({ value: String(c), label: `${c} reviews` }))}
                            />
                        </div>
                    </div>

                    <PrimaryButton
                        className="w-full"
                        icon={aiGenerating ? Loader2 : Sparkles}
                        onClick={handleAIGenerate}
                        disabled={aiGenerating || !aiConfig.locationName.trim() || !aiApiKeyStatus.hasKey}
                    >
                        {aiGenerating ? t('content.generating') : t('content.generateReview')}
                    </PrimaryButton>
                </div>

                {/* Generated Reviews */}
                {aiGeneratedReviews.length > 0 && (
                    <div className="mt-6 space-y-3">
                        <Divider />
                        <h3 className="text-base font-semibold text-[#24222c] flex items-center gap-2 pt-2">
                            <Sparkles className="w-4 h-4 text-[#8d74e8]" />
                            {t('content.generatedReviews')} ({aiGeneratedReviews.length})
                        </h3>
                        {aiGeneratedReviews.map((review, index) => (
                            <Panel key={index} tone="slate" className="p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Badge tone="amber">{'*'.repeat(review.rating)} {review.rating} sao</Badge>
                                            <Badge tone="slate">
                                                {review.style} / {review.language === 'vi' ? t('content.vietnamese') : t('content.english')}
                                            </Badge>
                                        </div>
                                        <p className="text-[#5f5a6d] text-sm">{review.content}</p>
                                    </div>
                                    <div className="flex gap-1 flex-shrink-0">
                                        <IconButton
                                            icon={Copy}
                                            label="Copy"
                                            onClick={() => navigator.clipboard.writeText(review.content)}
                                        />
                                        <IconButton
                                            icon={Save}
                                            label="Lưu vào Templates"
                                            onClick={() => handleSaveAIReview(review)}
                                        />
                                    </div>
                                </div>
                            </Panel>
                        ))}
                    </div>
                )}
            </Modal>
        </PageShell>
    )
}
