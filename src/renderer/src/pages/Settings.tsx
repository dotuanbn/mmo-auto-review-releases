import { useEffect, useState } from 'react'
import {
    Save,
    FolderOpen,
    Clock,
    Zap,
    Database,
    RefreshCw,
    Eye,
    Shield,
    Bot,
    Star,
    Car,
    Globe,
    RotateCw,
    Trash2,
    AlertTriangle,
    Monitor,
    Shuffle,
    Image,
    FileText,
    Languages,
    Target,
    Timer,
    Hash,
    Gauge,
    Key,
    TestTube2,
    Info,
    BarChart3,
    Cpu,
    MemoryStick,
    Power,
    Moon
} from 'lucide-react'
import { useTranslation } from '../i18n'
import {
    FormRow,
    PageHeader,
    PageShell,
    PrimaryButton,
    SectionPanel,
    Toggle as DSToggle,
    TextInput,
    Select,
    Badge,
    AlertBanner,
    ProgressBar,
    DataTable,
    Divider,
} from '../components/ui/surface'
import { useTheme } from '../contexts/ThemeContext'

interface AppSettings {
    // Browser
    headless: boolean
    hideAutomation: boolean
    saveProfiles: boolean
    maxConcurrentBrowsers: number
    randomizeUserAgent: boolean
    randomizeViewport: boolean

    // AI / Groq
    groqApiKey: string
    groqModel: string
    defaultReviewLanguage: 'vi' | 'en'
    defaultReviewStyle: 'casual' | 'professional' | 'enthusiastic'
    defaultReviewLength: 'short' | 'medium' | 'long'

    // Local AI / Ollama
    ollamaUrl: string
    ollamaModel: string

    // Review Defaults
    defaultRating: number
    includePhotos: boolean
    autoGenerateReview: boolean
    manualReviewSubmit: boolean
    allowAutoSubmitOnTrustedHosts: boolean
    trustedAutoSubmitHosts: string

    // Traffic Defaults
    defaultTrafficMode: 'direct' | 'organic'
    defaultVisitsPerLocation: number
    defaultActionsPerVisit: number
    trafficDelayMin: number
    trafficDelayMax: number

    // Proxy
    useProxy: boolean
    rotateProxyPerSession: boolean
    autoRemoveDeadProxies: boolean
    fproxyApiKey: string
    fproxyLocation: number

    // Timing
    delayMin: number
    delayMax: number
    maxRetries: number

    // Storage
    dataDir: string

    // App
    autoUpdate: boolean

    // Runtime Policy V2
    captchaMode: 'manual' | 'auto_skip' | 'hybrid'
    captchaAutoSkipMaxStrikes: number
    captchaManualWaitSeconds: number
    queueConcurrency: number
    queueIntervalMs: number
    networkRetryMax: number
    uiRetryMax: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
    ragEnabled: boolean
    ragTopK: number
    ragMaxContextChars: number
    ragWriteMode: 'off' | 'risk_only' | 'all'
    ragLatencyBudgetMs: number
    ragMinScore: number
    ragEntryTtlHours: number
    ragDedupeWindowMinutes: number

    // CAPTCHA Solver
    captchaSolverProvider: 'none' | '2captcha' | 'capsolver' | 'local-ai'
    captchaSolverApiKey: string

    // In-house AI (Hugging Face)
    hfModelEnabled: boolean
    hfTextGenModel: string
    hfAutoUnloadMinutes: number
    hfMaxMemoryMB: number

    // Analytics
    analyticsKeyFilePath: string
}

interface DataRootInfo {
    dataRoot: string
}

interface LegacyDataRoot {
    path: string
    exists: boolean
    fileCount: number
}

interface UpdaterState {
    enabled: boolean
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled'
    checking: boolean
    available: boolean
    downloaded: boolean
    progress: number
    pendingInstall: boolean
    blockedReason?: string
    currentVersion: string
    latestVersion?: string
    error?: string
    checkedAt?: string
}

interface RagStats {
    enabled: boolean
    totalEntries: number
    retrievalCount: number
    retrievalHitCount: number
    hitRate: number
    p95LatencyMs: number
    avgLatencyMs: number
    lastRetrievalAt?: string
    updatedAt: string
}

interface McpAdapterHealth {
    name: string
    enabled: boolean
    healthy: boolean
    latencyMs?: number
    detail?: string
    checkedAt: string
}

interface McpHealthReport {
    healthy: boolean
    adapters: McpAdapterHealth[]
    checkedAt: string
}

interface SoakTestStatus {
    running: boolean
    sessionId: string | null
    startedAt: string | null
    endsAt: string | null
    durationHours: number
    intervalSeconds: number
    sampleCount: number
    logPath: string | null
    summaryPath: string | null
    lastSnapshotAt: string | null
    stopReason: string | null
}

const DEFAULTS: AppSettings = {
    headless: false,
    hideAutomation: true,
    saveProfiles: true,
    maxConcurrentBrowsers: 3,
    randomizeUserAgent: true,
    randomizeViewport: true,
    groqApiKey: '',
    groqModel: 'llama-3.3-70b-versatile',
    defaultReviewLanguage: 'vi',
    defaultReviewStyle: 'casual',
    defaultReviewLength: 'medium',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5:latest',
    defaultRating: 5,
    includePhotos: false,
    autoGenerateReview: true,
    manualReviewSubmit: true,
    allowAutoSubmitOnTrustedHosts: true,
    trustedAutoSubmitHosts: 'localhost,127.0.0.1',
    defaultTrafficMode: 'organic',
    defaultVisitsPerLocation: 10,
    defaultActionsPerVisit: 4,
    trafficDelayMin: 10,
    trafficDelayMax: 30,
    useProxy: false,
    rotateProxyPerSession: true,
    autoRemoveDeadProxies: false,
    fproxyApiKey: '',
    fproxyLocation: 0,
    delayMin: 30,
    delayMax: 60,
    maxRetries: 3,
    dataDir: '',
    autoUpdate: true,

    // Runtime Policy V2
    captchaMode: 'hybrid',
    captchaAutoSkipMaxStrikes: 2,
    captchaManualWaitSeconds: 180,
    queueConcurrency: 2,
    queueIntervalMs: 5000,
    networkRetryMax: 3,
    uiRetryMax: 2,
    logLevel: 'info',
    ragEnabled: true,
    ragTopK: 4,
    ragMaxContextChars: 1200,
    ragWriteMode: 'risk_only',
    ragLatencyBudgetMs: 850,
    ragMinScore: 0.16,
    ragEntryTtlHours: 336,
    ragDedupeWindowMinutes: 240,

    // CAPTCHA Solver
    captchaSolverProvider: 'none',
    captchaSolverApiKey: '',

    // In-house AI (Hugging Face)
    hfModelEnabled: false,
    hfTextGenModel: '',
    hfAutoUnloadMinutes: 5,
    hfMaxMemoryMB: 2048,

    // Analytics
    analyticsKeyFilePath: '',
}

/** ---- HF Model Status Dashboard (embedded component) ---- */
function HFStatusDashboard() {
    const [status, setStatus] = useState<any>(null)
    const [loading, setLoading] = useState(false)
    const [testResult, setTestResult] = useState<string | null>(null)
    const [testLoading, setTestLoading] = useState(false)
    const [preloadTask, setPreloadTask] = useState<string>('text-generation')

    const fetchStatus = async () => {
        try {
            setLoading(true)
            const s = await window.electronAPI.hfmodel.getStatus()
            setStatus(s)
        } catch (err) {
            console.error('HF status fetch failed:', err)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchStatus()
        const interval = setInterval(fetchStatus, 10_000) // refresh every 10s
        return () => clearInterval(interval)
    }, [])

    const handlePreload = async () => {
        try {
            setLoading(true)
            await window.electronAPI.hfmodel.preload(preloadTask)
            await fetchStatus()
        } catch (err: any) {
            console.error('Preload failed:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleUnload = async (task: string) => {
        try {
            setLoading(true)
            await window.electronAPI.hfmodel.unload(task)
            await fetchStatus()
        } catch (err: any) {
            console.error('Unload failed:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleTest = async () => {
        try {
            setTestLoading(true)
            setTestResult(null)
            const result = await window.electronAPI.hfmodel.testGenerate(
                'Write a short positive review about a coffee shop.'
            )
            setTestResult(result?.result || result?.error || JSON.stringify(result))
        } catch (err: any) {
            setTestResult(`Error: ${err.message}`)
        } finally {
            setTestLoading(false)
        }
    }

    const handleDispose = async () => {
        try {
            setLoading(true)
            await window.electronAPI.hfmodel.dispose()
            setStatus(null)
            await fetchStatus()
        } catch (err: any) {
            console.error('Dispose failed:', err)
        } finally {
            setLoading(false)
        }
    }

    const workerRunning = status?.workerAlive === true
    const loadedModels: Array<{ task: string; model: string; memoryMB: number }> = status?.loadedModels || []

    return (
        <div className="mt-3 space-y-3">
            {/* Status Header */}
            <div className="flex items-center justify-between rounded-[18px] border border-[#e9e4f2] bg-[#f4f1fa] p-3">
                <div className="flex items-center gap-3">
                    <div className={`h-2.5 w-2.5 rounded-full ${workerRunning ? 'bg-emerald-500 animate-pulse' : 'bg-[#908a9e]'}`} />
                    <div>
                        <span className="text-sm font-medium text-[#17171f]">Worker Status</span>
                        <Badge tone={workerRunning ? 'emerald' : 'slate'} className="ml-2">
                            {workerRunning ? 'RUNNING' : 'IDLE'}
                        </Badge>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <PrimaryButton
                        variant="quiet"
                        onClick={fetchStatus}
                        disabled={loading}
                        icon={RefreshCw}
                        className={`h-8 w-8 !p-0 ${loading ? '[&_svg]:animate-spin' : ''}`}
                    >
                        {''}
                    </PrimaryButton>
                    {workerRunning && (
                        <PrimaryButton
                            tone="rose"
                            onClick={handleDispose}
                            disabled={loading}
                            className="!px-2.5 !py-1 text-xs"
                        >
                            Dispose All
                        </PrimaryButton>
                    )}
                </div>
            </div>

            {/* Loaded Models as DataTable */}
            {loadedModels.length > 0 && (
                <DataTable
                    columns={[
                        {
                            key: 'task',
                            header: 'Task',
                            render: (row) => (
                                <div className="flex items-center gap-2">
                                    <Cpu className="h-3.5 w-3.5 text-[#8d74e8]" />
                                    <span className="text-xs font-medium text-[#8d74e8]">{row.task}</span>
                                </div>
                            ),
                        },
                        {
                            key: 'model',
                            header: 'Model',
                            render: (row) => (
                                <span className="max-w-[200px] truncate font-mono text-xs text-[#17171f]">{row.model}</span>
                            ),
                        },
                        {
                            key: 'memory',
                            header: 'Memory',
                            render: (row) => (
                                <span className="text-xs text-[#5f5a6d]">{row.memoryMB > 0 ? `${row.memoryMB}MB` : '-'}</span>
                            ),
                            align: 'right' as const,
                        },
                        {
                            key: 'actions',
                            header: '',
                            render: (row) => (
                                <button
                                    onClick={() => handleUnload(row.task)}
                                    className="text-xs font-semibold text-rose-600 hover:text-rose-500 transition-colors"
                                >
                                    Unload
                                </button>
                            ),
                            align: 'right' as const,
                        },
                    ]}
                    data={loadedModels.map((m, i) => ({ ...m, id: i }))}
                />
            )}

            {/* Memory Info */}
            {status?.totalMemoryMB > 0 && (
                <div className="flex gap-3 text-xs text-[#5f5a6d]">
                    <span>Worker Memory: {status.totalMemoryMB}MB</span>
                    <span>System: {status.systemProfile || 'N/A'}</span>
                </div>
            )}

            {/* Actions Row */}
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    value={preloadTask}
                    onChange={(v) => setPreloadTask(v)}
                    options={[
                        { value: 'text-generation', label: 'Text Generation' },
                        { value: 'zero-shot-classification', label: 'Classification' },
                        { value: 'zero-shot-image-classification', label: 'Image Classification' },
                    ]}
                    className="w-44"
                />
                <PrimaryButton
                    tone="cyan"
                    onClick={handlePreload}
                    disabled={loading}
                    className="text-xs"
                >
                    {loading ? 'Loading...' : 'Preload'}
                </PrimaryButton>
                <PrimaryButton
                    tone="emerald"
                    onClick={handleTest}
                    disabled={testLoading}
                    className="text-xs"
                >
                    {testLoading ? 'Generating...' : 'Test Generate'}
                </PrimaryButton>
            </div>

            {/* Test Result */}
            {testResult && (
                <AlertBanner type="success" title="Test Output:">
                    <p className="font-mono text-xs whitespace-pre-wrap leading-relaxed">{testResult}</p>
                </AlertBanner>
            )}
        </div>
    )
}

export function Settings() {
    const { t, language, setLanguage } = useTranslation()
    const { isDark, toggleTheme } = useTheme()
    const [settings, setSettings] = useState<AppSettings>({ ...DEFAULTS })
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
    const [apiTesting, setApiTesting] = useState(false)
    const [apiStatus, setApiStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')
    const [apiError, setApiError] = useState<string>('')
    const [ollamaTesting, setOllamaTesting] = useState(false)
    const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')
    const [ollamaModels, setOllamaModels] = useState<string[]>([])
    const [showResetConfirm, setShowResetConfirm] = useState(false)
    const [hasChanges, setHasChanges] = useState(false)
    const [originalSettings, setOriginalSettings] = useState<AppSettings>({ ...DEFAULTS })
    const [fproxyTesting, setFproxyTesting] = useState(false)
    const [fproxyResult, setFproxyResult] = useState<{ success: boolean; text: string } | null>(null)
    const [dataRootInfo, setDataRootInfo] = useState<DataRootInfo | null>(null)
    const [legacyRoots, setLegacyRoots] = useState<LegacyDataRoot[]>([])
    const [updaterState, setUpdaterState] = useState<UpdaterState | null>(null)
    const [ragStats, setRagStats] = useState<RagStats | null>(null)
    const [mcpHealth, setMcpHealth] = useState<McpHealthReport | null>(null)
    const [ragClearScope, setRagClearScope] = useState({
        campaignId: '',
        domain: '',
        riskType: '',
    })
    const [soakStatus, setSoakStatus] = useState<SoakTestStatus | null>(null)
    const [maintenanceBusy, setMaintenanceBusy] = useState(false)
    const [storageInfo, setStorageInfo] = useState<any>(null)

    useEffect(() => {
        loadSettings()
    }, [])

    useEffect(() => {
        const unsubscribe = window.electronAPI.updates.onState((state: UpdaterState) => {
            setUpdaterState(state)
        })
        return unsubscribe
    }, [])

    const loadSettings = async () => {
        try {
            setLoading(true)
            const data = await window.electronAPI.settings.getAll()
            if (data) {
                const merged = { ...DEFAULTS, ...data }
                setSettings(merged)
                setOriginalSettings(merged)
            }
            await loadV2Maintenance()
        } catch (error) {
            console.error('Failed to load settings:', error)
        } finally {
            setLoading(false)
        }
    }

    const loadV2Maintenance = async () => {
        try {
            const [root, legacy, updater, ragStatsResult, mcpHealthResult, soakStatusResult, storage] = await Promise.all([
                window.electronAPI.data.getRoot(),
                window.electronAPI.data.detectLegacy(),
                window.electronAPI.updates.getState(),
                window.electronAPI.rag?.getStats?.() ?? Promise.resolve(null),
                window.electronAPI.mcp?.getHealth?.() ?? Promise.resolve(null),
                window.electronAPI.soak?.status?.() ?? Promise.resolve(null),
                window.electronAPI.data.getStorageInfo?.() ?? Promise.resolve(null),
            ])
            setDataRootInfo(root)
            setLegacyRoots(Array.isArray(legacy) ? legacy : [])
            setUpdaterState(updater)
            if (ragStatsResult) {
                setRagStats(ragStatsResult)
            }
            if (mcpHealthResult) {
                setMcpHealth(mcpHealthResult)
            }
            if (soakStatusResult) {
                setSoakStatus(soakStatusResult)
            }
            if (storage) setStorageInfo(storage)
        } catch (error) {
            console.error('Failed to load V2 maintenance data:', error)
        }
    }

    const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
        setSettings(prev => {
            const next = { ...prev, [key]: value }
            setHasChanges(JSON.stringify(next) !== JSON.stringify(originalSettings))
            return next
        })
    }

    const handleSave = async () => {
        try {
            setSaving(true)
            await window.electronAPI.settings.saveAll(settings)
            if (window.electronAPI.runtime?.updatePolicy) {
                await window.electronAPI.runtime.updatePolicy({
                    captchaMode: settings.captchaMode,
                    captchaAutoSkipMaxStrikes: settings.captchaAutoSkipMaxStrikes,
                    captchaManualWaitSeconds: settings.captchaManualWaitSeconds,
                    queueConcurrency: settings.queueConcurrency,
                    queueIntervalMs: settings.queueIntervalMs,
                    networkRetryMax: settings.networkRetryMax,
                    uiRetryMax: settings.uiRetryMax,
                    logLevel: settings.logLevel,
                    ragEnabled: settings.ragEnabled,
                    ragTopK: settings.ragTopK,
                    ragMaxContextChars: settings.ragMaxContextChars,
                    ragWriteMode: settings.ragWriteMode,
                    ragLatencyBudgetMs: settings.ragLatencyBudgetMs,
                    ragMinScore: settings.ragMinScore,
                    ragEntryTtlHours: settings.ragEntryTtlHours,
                    ragDedupeWindowMinutes: settings.ragDedupeWindowMinutes,
                })
            }
            setOriginalSettings({ ...settings })
            setHasChanges(false)
            showMsg('success', t('settings.saved'))
        } catch (error) {
            console.error('Failed to save:', error)
            showMsg('error', t('settings.saveFailed'))
        } finally {
            setSaving(false)
        }
    }

    const handleReset = async () => {
        try {
            const data = await window.electronAPI.settings.resetDefaults()
            const merged = { ...DEFAULTS, ...data }
            setSettings(merged)
            setOriginalSettings(merged)
            setHasChanges(false)
            setShowResetConfirm(false)
            showMsg('success', t('settings.resetSuccess'))
        } catch (error) {
            showMsg('error', t('settings.resetFailed'))
        }
    }

    const handleTestApiKey = async () => {
        if (!settings.groqApiKey.trim()) return
        try {
            setApiTesting(true)
            setApiStatus('idle')
            setApiError('')
            const saveResult = await window.electronAPI.ai.setApiKey(settings.groqApiKey.trim())
            if (!saveResult?.success) {
                setApiStatus('invalid')
                setApiError(saveResult?.error || 'Unknown error')
                return
            }
            const statusResult = await window.electronAPI.ai.getApiKeyStatus()
            if (statusResult?.hasKey && statusResult?.isValid !== false) {
                setApiStatus('valid')
            } else {
                setApiStatus('invalid')
                setApiError('API Key is invalid')
            }
        } catch (e: any) {
            setApiStatus('invalid')
            setApiError(e.message || 'Loi mang hoac khong the ket noi toi Google')
        } finally {
            setApiTesting(false)
        }
    }

    const handleTestOllama = async () => {
        if (!settings.ollamaUrl.trim()) return
        try {
            setOllamaTesting(true)
            setOllamaStatus('idle')
            const result = await window.electronAPI.ollama.testConnection(settings.ollamaUrl)
            if (result.success && result.models) {
                setOllamaStatus('valid')
                setOllamaModels(result.models)
                // If current model is not set but we found models, auto-select first one
                if (!settings.ollamaModel && result.models.length > 0) {
                    update('ollamaModel', result.models[0])
                }
            } else {
                setOllamaStatus('invalid')
            }
        } catch {
            setOllamaStatus('invalid')
        } finally {
            setOllamaTesting(false)
        }
    }

    const selectDataDir = async () => {
        try {
            const dir = await window.electronAPI.selectDirectory()
            if (dir) update('dataDir', dir)
        } catch (error) {
            console.error('Failed to select directory:', error)
        }
    }

    const showMsg = (type: 'success' | 'error', text: string) => {
        setMessage({ type, text })
        setTimeout(() => setMessage(null), 3000)
    }

    const formatPercent = (value: number) => `${Math.max(0, Math.min(100, value * 100)).toFixed(1)}%`

    const formatBytes = (bytes: number): string => {
        if (!bytes || bytes <= 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB']
        let i = 0
        let val = bytes
        while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
        return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
    }

    const getUpdaterStatusLabel = (state: UpdaterState | null): string => {
        if (!state) return 'N/A'
        const labels: Record<UpdaterState['status'], string> = {
            idle: 'Idle',
            checking: 'Dang kiem tra',
            available: 'Co ban cap nhat moi',
            downloading: 'Dang tai cap nhat',
            downloaded: 'Da tai xong',
            error: 'Loi cap nhat',
            disabled: 'Khong ho tro auto update',
        }
        return labels[state.status]
    }

    const handleMigrateLegacy = async () => {
        try {
            setMaintenanceBusy(true)
            const preferred = legacyRoots.find(item => item.exists && item.fileCount > 0)
            const result = await window.electronAPI.data.migrateLegacy(preferred?.path)
            if (result?.success) {
                showMsg('success', 'Da migrate du lieu cu thanh cong')
            } else {
                showMsg('error', result?.message || 'Khong tim thay du lieu cu de migrate')
            }
            await loadV2Maintenance()
        } catch (error) {
            console.error('Failed to migrate legacy data:', error)
            showMsg('error', 'Migrate du lieu cu that bai')
        } finally {
            setMaintenanceBusy(false)
        }
    }

    const handleClearRag = async () => {
        try {
            if (!window.electronAPI.rag?.clear) {
                showMsg('error', 'RAG API unavailable')
                return
            }
            setMaintenanceBusy(true)
            const campaignRaw = ragClearScope.campaignId.trim()
            let campaignId: number | undefined
            if (campaignRaw) {
                const parsed = Number.parseInt(campaignRaw, 10)
                if (!Number.isFinite(parsed) || parsed <= 0) {
                    showMsg('error', 'Campaign ID is invalid')
                    return
                }
                campaignId = parsed
            }
            const domain = ragClearScope.domain.trim()
            const riskType = ragClearScope.riskType.trim()
            const scope: { campaignId?: number; domain?: string; riskType?: string } = {}
            if (campaignId) {
                scope.campaignId = campaignId
            }
            if (domain) {
                scope.domain = domain
            }
            if (riskType) {
                scope.riskType = riskType
            }
            const result = await window.electronAPI.rag.clear(Object.keys(scope).length ? scope : undefined)
            showMsg('success', `Da xoa ${result?.deleted ?? 0} knowledge item(s)`)
            await loadV2Maintenance()
        } catch (error) {
            console.error('Failed to clear RAG knowledge:', error)
            showMsg('error', 'Xoa RAG knowledge that bai')
        } finally {
            setMaintenanceBusy(false)
        }
    }

    const handleCheckAndDownloadUpdate = async () => {
        try {
            setMaintenanceBusy(true)
            const state = await window.electronAPI.updates.checkAndDownload()
            setUpdaterState(state)
        } catch (error) {
            console.error('Failed to check/download update:', error)
            showMsg('error', 'Kiem tra hoac tai cap nhat that bai')
        } finally {
            setMaintenanceBusy(false)
        }
    }

    const handleStartSoak8h = async () => {
        try {
            if (!window.electronAPI.soak?.start) {
                showMsg('error', 'Soak API unavailable')
                return
            }
            setMaintenanceBusy(true)
            const status = await window.electronAPI.soak.start({
                durationHours: 8,
                intervalSeconds: 30,
                tag: 'settings',
            })
            setSoakStatus(status)
            showMsg('success', 'Da bat dau soak test 8h')
        } catch (error) {
            console.error('Failed to start soak test:', error)
            showMsg('error', 'Bat dau soak test that bai')
        } finally {
            setMaintenanceBusy(false)
        }
    }

    const handleStopSoak = async () => {
        try {
            if (!window.electronAPI.soak?.stop) {
                showMsg('error', 'Soak API unavailable')
                return
            }
            setMaintenanceBusy(true)
            const status = await window.electronAPI.soak.stop('settings_stop')
            setSoakStatus(status)
            showMsg('success', 'Da dung soak test')
        } catch (error) {
            console.error('Failed to stop soak test:', error)
            showMsg('error', 'Dung soak test that bai')
        } finally {
            setMaintenanceBusy(false)
        }
    }

    const handleInstallUpdate = async () => {
        try {
            setMaintenanceBusy(true)
            const state = await window.electronAPI.updates.install()
            setUpdaterState(state)
            if (state?.pendingInstall && state?.blockedReason) {
                showMsg('error', state.blockedReason)
            }
        } catch (error) {
            console.error('Failed to install update:', error)
            showMsg('error', 'Cai dat cap nhat that bai')
        } finally {
            setMaintenanceBusy(false)
        }
    }

    // ---- Reusable helper components ----
    const NumberInput = ({ value, onChange, min, max, step = 1, suffix }: {
        value: number
        onChange: (v: number) => void
        min: number
        max: number
        step?: number
        suffix?: string
    }) => (
        <div className="flex items-center gap-2">
            <input
                type="number"
                value={value}
                onChange={(e) => {
                    const v = parseInt(e.target.value) || min
                    onChange(Math.max(min, Math.min(max, v)))
                }}
                className="w-20 rounded-[16px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                min={min}
                max={max}
                step={step}
                title={`Value between ${min} and ${max}`}
            />
            {suffix && <span className="text-xs text-[#908a9e]">{suffix}</span>}
        </div>
    )

    if (loading) {
        return (
            <PageShell>
                <div className="flex h-full items-center justify-center p-6">
                    <div className="flex items-center gap-3 text-[#5f5a6d]">
                        <RefreshCw className="h-5 w-5 animate-spin text-[#8d74e8]" />
                        <span>{t('settings.loadingSettings')}</span>
                    </div>
                </div>
            </PageShell>
        )
    }

    return (
        <PageShell className="mx-auto max-w-4xl">
            <PageHeader
                icon={Shield}
                tone="violet"
                title={t('settings.title')}
                subtitle={t('settings.subtitle')}
            >
                {hasChanges && (
                    <Badge tone="amber" dot>
                        {t('settings.unsavedChanges')}
                    </Badge>
                )}
                <PrimaryButton
                    icon={Save}
                    onClick={handleSave}
                    disabled={saving || !hasChanges}
                    title={t('settings.saveSettings')}
                >
                    {saving ? t('settings.saving') : t('settings.saveSettings')}
                </PrimaryButton>
            </PageHeader>

            {/* Message */}
            {message && (
                <AlertBanner
                    type={message.type === 'success' ? 'success' : 'error'}
                    onDismiss={() => setMessage(null)}
                >
                    {message.text}
                </AlertBanner>
            )}

            {/* ==================== 0. APPEARANCE / LANGUAGE ==================== */}
            <SectionPanel icon={Languages} title={t('settings.appearance')} tone="violet">
                <FormRow
                    icon={<Languages className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.language')}
                    description={t('settings.languageDesc')}
                >
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => setLanguage('en')}
                            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-all ${language === 'en'
                                ? 'bg-[#8d74e8] text-white shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                : 'border border-[#e9e4f2] bg-white text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                }`}
                            title="English"
                        >
                            EN
                        </button>
                        <button
                            onClick={() => setLanguage('vi')}
                            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-all ${language === 'vi'
                                ? 'bg-[#8d74e8] text-white shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                : 'border border-[#e9e4f2] bg-white text-[#5f5a6d] hover:bg-[#f4f1fa]'
                                }`}
                            title="Tieng Viet"
                        >
                            VI
                        </button>
                    </div>
                </FormRow>
                <FormRow
                    icon={<Moon className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.darkMode', 'Dark mode')}
                    description={t('settings.darkModeDesc', 'Switch the app shell and workspace to a low-light interface.')}
                >
                    <DSToggle checked={isDark} onChange={toggleTheme} />
                </FormRow>
            </SectionPanel>

            {/* ==================== 1. BROWSER ==================== */}
            <SectionPanel icon={Globe} title={t('settings.browser')} tone="blue">
                <FormRow
                    icon={<Eye className="h-4 w-4 text-blue-500" />}
                    label={t('settings.headlessMode')}
                    description={t('settings.headlessModeDesc')}
                >
                    <DSToggle checked={settings.headless} onChange={() => update('headless', !settings.headless)} />
                </FormRow>

                <FormRow
                    icon={<Shield className="h-4 w-4 text-emerald-500" />}
                    label={t('settings.hideAutomation')}
                    description={t('settings.hideAutomationDesc')}
                >
                    <DSToggle checked={settings.hideAutomation} onChange={() => update('hideAutomation', !settings.hideAutomation)} />
                </FormRow>

                <FormRow
                    icon={<Database className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.saveProfiles')}
                    description={t('settings.saveProfilesDesc')}
                >
                    <DSToggle checked={settings.saveProfiles} onChange={() => update('saveProfiles', !settings.saveProfiles)} />
                </FormRow>

                <FormRow
                    icon={<Monitor className="h-4 w-4 text-cyan-500" />}
                    label={t('settings.maxConcurrentBrowsers')}
                    description={t('settings.maxConcurrentBrowsersDesc')}
                >
                    <NumberInput value={settings.maxConcurrentBrowsers} onChange={(v) => update('maxConcurrentBrowsers', v)} min={1} max={10} />
                </FormRow>

                <FormRow
                    icon={<Shuffle className="h-4 w-4 text-amber-500" />}
                    label={t('settings.randomizeUserAgent')}
                    description={t('settings.randomizeUserAgentDesc')}
                >
                    <DSToggle checked={settings.randomizeUserAgent} onChange={() => update('randomizeUserAgent', !settings.randomizeUserAgent)} />
                </FormRow>

                <FormRow
                    icon={<Monitor className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.defaultReviewLanguage')}
                    description={t('settings.defaultReviewLanguageDesc')}
                >
                    <Select
                        value={settings.defaultReviewLanguage}
                        onChange={(v) => update('defaultReviewLanguage', v as 'vi' | 'en')}
                        options={[
                            { value: 'vi' as const, label: 'Tieng Viet' },
                            { value: 'en' as const, label: 'English' },
                        ]}
                        className="w-36"
                    />
                </FormRow>

                <FormRow
                    icon={<FileText className="h-4 w-4 text-rose-500" />}
                    label={t('settings.defaultReviewStyle')}
                    description={t('settings.defaultReviewStyleDesc')}
                >
                    <Select
                        value={settings.defaultReviewStyle}
                        onChange={(v) => update('defaultReviewStyle', v as any)}
                        options={[
                            { value: 'casual' as const, label: t('settings.styleCasual') },
                            { value: 'professional' as const, label: t('settings.styleProfessional') },
                            { value: 'enthusiastic' as const, label: t('settings.styleEnthusiastic') },
                        ]}
                        className="w-36"
                    />
                </FormRow>

                <FormRow
                    icon={<Gauge className="h-4 w-4 text-amber-500" />}
                    label={t('settings.defaultReviewLength')}
                    description={t('settings.defaultReviewLengthDesc')}
                >
                    <Select
                        value={settings.defaultReviewLength}
                        onChange={(v) => update('defaultReviewLength', v as any)}
                        options={[
                            { value: 'short' as const, label: t('settings.lengthShort') },
                            { value: 'medium' as const, label: t('settings.lengthMedium') },
                            { value: 'long' as const, label: t('settings.lengthLong') },
                        ]}
                        className="w-36"
                    />
                </FormRow>
            </SectionPanel>

            {/* ==================== 2. AI & FALLBACK ==================== */}
            <SectionPanel icon={Bot} title={t('settings.aiSettings', 'AI & Fallback')} tone="violet">
                {/* Groq Fallback */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-[#f9f7fe] p-3.5">
                    <div className="flex items-center gap-2">
                        <Key className="h-4 w-4 text-[#735bd6]" />
                        <span className="text-sm font-medium text-[#17171f]">Ma API Groq (Auto Fallback)</span>
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={settings.groqApiKey}
                            onChange={(e) => update('groqApiKey', e.target.value)}
                            className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-2 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/20"
                            placeholder="Nhap API key tu Groq..."
                            title="Groq API Key"
                        />
                        <PrimaryButton
                            icon={apiTesting ? RefreshCw : TestTube2}
                            onClick={handleTestApiKey}
                            disabled={!settings.groqApiKey || apiTesting}
                            className={apiTesting ? '[&_svg]:animate-spin' : ''}
                        >
                            Test
                        </PrimaryButton>
                    </div>
                    {apiStatus !== 'idle' && (
                        <AlertBanner type={apiStatus === 'valid' ? 'success' : 'error'}>
                            {apiStatus === 'valid' ? 'Ket noi Groq API thanh cong!' : 'API Key khong hop le hoac loi mang.'}
                            {apiStatus === 'invalid' && apiError && (
                                <div className="mt-1 text-[11px] opacity-80 break-words">{apiError}</div>
                            )}
                        </AlertBanner>
                    )}
                    <div className="mt-2">
                        <label className="mb-1.5 block text-xs text-[#6f697c]">Model</label>
                        <Select
                            value={settings.groqModel}
                            onChange={(v) => update('groqModel', v)}
                            options={[
                                { value: 'gemma2-9b-it' as const, label: 'Llama 3.1 8B Instruct (Free)' },
                                { value: 'llama-3.1-8b-instant' as const, label: 'Gemma 2 9B IT (Free)' },
                                { value: 'mixtral-8x7b-32768' as const, label: 'Mistral 7B Instruct (Free)' },
                                { value: 'cognitivecomputations/dolphin-mixtral-8x7b' as const, label: 'Dolphin Mixtral 8x7B (Free)' },
                                { value: 'deepseek-r1-distill-llama-70b' as const, label: 'Qwen 2.5 72B Instruct (Free)' },
                                { value: 'deepseek/deepseek-chat:free' as const, label: 'DeepSeek Chat (Free)' },
                                { value: 'anthropic/claude-3-haiku' as const, label: 'Claude 3 Haiku (Paid)' },
                                { value: 'openai/chatgpt-4o-latest' as const, label: 'GPT-4o (Paid)' },
                            ]}
                        />
                    </div>
                    <a
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            window.electronAPI.openExternal('https://console.groq.com/keys');
                        }}
                        className="mt-2 block text-xs text-[#735bd6] underline hover:text-[#8d74e8]"
                    >
                        Nhan vao day de nhan ma API Groq mien phi (Khuyen dung)
                    </a>
                </div>

                {/* Local Ollama */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="flex items-center gap-2">
                        <Database className="h-4 w-4 text-[#6f697c]" />
                        <span className="text-sm font-medium text-[#17171f]">Local AI (Ollama)</span>
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={settings.ollamaUrl}
                            onChange={(e) => update('ollamaUrl', e.target.value)}
                            className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-2 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/20"
                            placeholder="http://localhost:11434"
                        />
                        <PrimaryButton
                            variant="quiet"
                            icon={ollamaTesting ? RefreshCw : TestTube2}
                            onClick={handleTestOllama}
                            disabled={!settings.ollamaUrl || ollamaTesting}
                            className={ollamaTesting ? '[&_svg]:animate-spin' : ''}
                        >
                            {''}
                        </PrimaryButton>
                    </div>
                    {ollamaStatus !== 'idle' && (
                        <AlertBanner type={ollamaStatus === 'valid' ? 'success' : 'error'}>
                            {ollamaStatus === 'valid' ? 'Ket noi Ollama thanh cong!' : 'Loi ket noi Ollama.'}
                        </AlertBanner>
                    )}
                    {ollamaModels.length > 0 && (
                        <div className="mt-2">
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Model</label>
                            <Select
                                value={settings.ollamaModel}
                                onChange={(v) => update('ollamaModel', v)}
                                options={ollamaModels.map(m => ({ value: m as string, label: m }))}
                            />
                        </div>
                    )}
                </div>
            </SectionPanel>

            {/* ==================== 3. ANALYTICS & APIS ==================== */}
            <SectionPanel icon={BarChart3} title={t('settings.analytics')} tone="violet">
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="flex items-center gap-2">
                        <Key className="h-4 w-4 text-[#8d74e8]" />
                        <span className="text-sm font-medium text-[#17171f]">{t('settings.analyticsKeyFilePath')}</span>
                    </div>
                    <p className="text-xs text-[#6f697c]">
                        {t('settings.analyticsKeyFilePathDesc')}
                    </p>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={settings.analyticsKeyFilePath}
                            onChange={(e) => update('analyticsKeyFilePath', e.target.value)}
                            className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-2 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                            placeholder="C:\path\to\service-account-key.json"
                            readOnly
                        />
                        <PrimaryButton
                            variant="dark"
                            icon={FolderOpen}
                            onClick={async () => {
                                const path = await window.electronAPI.analytics.selectKeyFile()
                                if (path) {
                                    update('analyticsKeyFilePath', path)
                                }
                            }}
                        >
                            {t('settings.browseFile')}
                        </PrimaryButton>
                    </div>
                </div>
            </SectionPanel>

            {/* ==================== 4. REVIEW DEFAULTS ==================== */}
            <SectionPanel icon={Star} title={t('settings.reviewDefaults')} tone="amber">
                <FormRow
                    icon={<Star className="h-4 w-4 text-amber-500" />}
                    label={t('settings.defaultRating')}
                    description={t('settings.defaultRatingDesc')}
                    tone="amber"
                >
                    <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map(star => (
                            <button
                                key={star}
                                onClick={() => update('defaultRating', star)}
                                className="transition-transform hover:scale-110"
                                title={`${star} star${star > 1 ? 's' : ''}`}
                            >
                                <Star
                                    className={`h-5 w-5 transition-colors ${star <= settings.defaultRating
                                        ? 'fill-amber-400 text-amber-400'
                                        : 'text-[#908a9e]'
                                        }`}
                                />
                            </button>
                        ))}
                    </div>
                </FormRow>

                <FormRow
                    icon={<Image className="h-4 w-4 text-emerald-500" />}
                    label={t('settings.includePhotos')}
                    description={t('settings.includePhotosDesc')}
                >
                    <DSToggle checked={settings.includePhotos} onChange={() => update('includePhotos', !settings.includePhotos)} />
                </FormRow>

                <FormRow
                    icon={<Bot className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.autoGenerateReview')}
                    description={t('settings.autoGenerateReviewDesc')}
                >
                    <DSToggle checked={settings.autoGenerateReview} onChange={() => update('autoGenerateReview', !settings.autoGenerateReview)} />
                </FormRow>

                <FormRow
                    icon={<Shield className="h-4 w-4 text-amber-500" />}
                    label="Manual Confirm Before Submit"
                    description="Recommended for production targets. App fills review but does not auto-submit unless target host is trusted."
                    tone="amber"
                >
                    <DSToggle checked={settings.manualReviewSubmit} onChange={() => update('manualReviewSubmit', !settings.manualReviewSubmit)} />
                </FormRow>

                <FormRow
                    icon={<Globe className="h-4 w-4 text-cyan-500" />}
                    label="Allow Auto Submit On Trusted Hosts"
                    description="Only used when manual confirm is enabled. Useful for staging/local QA."
                >
                    <DSToggle
                        checked={settings.allowAutoSubmitOnTrustedHosts}
                        onChange={() => update('allowAutoSubmitOnTrustedHosts', !settings.allowAutoSubmitOnTrustedHosts)}
                    />
                </FormRow>

                <FormRow
                    label="Trusted auto-submit hosts"
                    description="Example: localhost, 127.0.0.1, *.staging.internal"
                >
                    <TextInput
                        value={settings.trustedAutoSubmitHosts}
                        onChange={(v) => update('trustedAutoSubmitHosts', v)}
                        placeholder="localhost,127.0.0.1,*.internal"
                        className="w-64"
                    />
                </FormRow>
            </SectionPanel>

            {/* ==================== 4. TRAFFIC DEFAULTS ==================== */}
            <SectionPanel icon={Car} title={t('settings.trafficDefaults')} tone="emerald">
                <FormRow
                    icon={<Target className="h-4 w-4 text-emerald-500" />}
                    label={t('settings.defaultTrafficMode')}
                    description={t('settings.defaultTrafficModeDesc')}
                >
                    <Select
                        value={settings.defaultTrafficMode}
                        onChange={(v) => update('defaultTrafficMode', v as 'direct' | 'organic')}
                        options={[
                            { value: 'organic' as const, label: t('settings.modeOrganic') },
                            { value: 'direct' as const, label: t('settings.modeDirect') },
                        ]}
                        className="w-36"
                    />
                </FormRow>

                <FormRow
                    icon={<Hash className="h-4 w-4 text-blue-500" />}
                    label={t('settings.visitsPerLocation')}
                    description={t('settings.visitsPerLocationDesc')}
                >
                    <NumberInput value={settings.defaultVisitsPerLocation} onChange={(v) => update('defaultVisitsPerLocation', v)} min={1} max={100} />
                </FormRow>

                <FormRow
                    icon={<Zap className="h-4 w-4 text-amber-500" />}
                    label={t('settings.actionsPerVisit')}
                    description={t('settings.actionsPerVisitDesc')}
                >
                    <NumberInput value={settings.defaultActionsPerVisit} onChange={(v) => update('defaultActionsPerVisit', v)} min={1} max={100} />
                </FormRow>

                <div className="rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="mb-3 flex items-center gap-2">
                        <Timer className="h-4 w-4 text-amber-500" />
                        <span className="text-sm font-medium text-[#17171f]">{t('settings.visitDelayRange')}</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex-1">
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.minSeconds')}</label>
                            <input
                                type="number"
                                value={settings.trafficDelayMin}
                                onChange={(e) => update('trafficDelayMin', Math.max(5, parseInt(e.target.value) || 5))}
                                className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                min="5"
                                title={t('settings.minSeconds')}
                            />
                        </div>
                        <span className="mt-5 text-[#908a9e]">&mdash;</span>
                        <div className="flex-1">
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.maxSeconds')}</label>
                            <input
                                type="number"
                                value={settings.trafficDelayMax}
                                onChange={(e) => update('trafficDelayMax', Math.max(settings.trafficDelayMin + 1, parseInt(e.target.value) || 30))}
                                className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                min={settings.trafficDelayMin + 1}
                                title={t('settings.maxSeconds')}
                            />
                        </div>
                    </div>
                    <p className="mt-2 text-xs text-[#908a9e]">
                        {t('settings.randomDelay').replace('{min}', String(settings.trafficDelayMin)).replace('{max}', String(settings.trafficDelayMax))}
                    </p>
                </div>
            </SectionPanel>

            {/* ==================== 5. PROXY ==================== */}
            <SectionPanel icon={Globe} title={t('settings.proxy')} tone="cyan">
                {/* FProxy.me API Key */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-[#f9f7fe] p-3.5">
                    <div className="flex items-center gap-2">
                        <Key className="h-4 w-4 text-cyan-600" />
                        <span className="text-sm font-medium text-[#17171f]">FProxy.me API Key</span>
                        <Badge tone="cyan">Proxy Xoay</Badge>
                    </div>
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={(settings as any).fproxyApiKey || ''}
                            onChange={(e) => update('fproxyApiKey' as any, e.target.value)}
                            className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-2 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/20"
                            placeholder="Nhap API key tu fproxy.me..."
                            title="FProxy API Key"
                        />
                        <PrimaryButton
                            icon={fproxyTesting ? RefreshCw : TestTube2}
                            onClick={async () => {
                                const key = (settings as any).fproxyApiKey
                                if (!key) return
                                setFproxyTesting(true)
                                setFproxyResult(null)
                                try {
                                    await (window as any).electronAPI.fproxy.setApiKey(key)
                                    const result = await (window as any).electronAPI.fproxy.test()
                                    if (result?.success) {
                                        const runtimeWarnings = [
                                            !settings.useProxy ? 'bat Use Proxy' : '',
                                            hasChanges ? 'luu settings' : '',
                                        ].filter(Boolean)
                                        const runtimeSuffix = runtimeWarnings.length > 0
                                            ? ` - Runtime can ${runtimeWarnings.join(' + ')} truoc khi chay campaign`
                                            : ''
                                        const suffix = result?.message ? ` - ${result.message}${runtimeSuffix}` : runtimeSuffix
                                        setFproxyResult({ success: true, text: `Proxy: ${result.proxy} (${result.location || ''})${suffix}` })
                                    } else {
                                        setFproxyResult({ success: false, text: result?.message || 'Khong lay duoc proxy' })
                                    }
                                } catch (err: any) {
                                    setFproxyResult({ success: false, text: `Loi: ${err.message}` })
                                } finally {
                                    setFproxyTesting(false)
                                }
                            }}
                            disabled={!(settings as any).fproxyApiKey || fproxyTesting}
                            className={fproxyTesting ? '[&_svg]:animate-spin' : ''}
                        >
                            {fproxyTesting ? 'Dang test...' : 'Test'}
                        </PrimaryButton>
                    </div>
                    {fproxyResult && (
                        <AlertBanner type={fproxyResult.success ? 'success' : 'error'}>
                            {fproxyResult.text}
                        </AlertBanner>
                    )}
                    <p className="text-xs text-[#6f697c]">
                        Nhap API key tu fproxy.me de su dung proxy xoay tu dong. Khi co API key, app se tu lay proxy moi cho moi luot truy cap.
                    </p>
                </div>

                <FormRow
                    icon={<Globe className="h-4 w-4 text-cyan-500" />}
                    label={t('settings.useProxy')}
                    description={t('settings.useProxyDesc')}
                >
                    <DSToggle checked={settings.useProxy} onChange={() => update('useProxy', !settings.useProxy)} />
                </FormRow>

                {settings.useProxy && (
                    <>
                        <FormRow
                            icon={<RotateCw className="h-4 w-4 text-[#8d74e8]" />}
                            label={t('settings.rotateProxyPerSession')}
                            description={t('settings.rotateProxyPerSessionDesc')}
                        >
                            <DSToggle checked={settings.rotateProxyPerSession} onChange={() => update('rotateProxyPerSession', !settings.rotateProxyPerSession)} />
                        </FormRow>

                        <FormRow
                            icon={<Trash2 className="h-4 w-4 text-rose-500" />}
                            label={t('settings.autoRemoveDeadProxies')}
                            description={t('settings.autoRemoveDeadProxiesDesc')}
                        >
                            <DSToggle checked={settings.autoRemoveDeadProxies} onChange={() => update('autoRemoveDeadProxies', !settings.autoRemoveDeadProxies)} />
                        </FormRow>
                    </>
                )}
            </SectionPanel>

            {/* ==================== 6. TIMING ==================== */}
            <SectionPanel icon={Clock} title={t('settings.timing')} tone="violet">
                <div className="rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.minDelay')}</label>
                            <input
                                type="number"
                                value={settings.delayMin}
                                onChange={(e) => update('delayMin', Math.max(5, parseInt(e.target.value) || 30))}
                                className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                min="5"
                                title={t('settings.minDelay')}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.maxDelay')}</label>
                            <input
                                type="number"
                                value={settings.delayMax}
                                onChange={(e) => update('delayMax', Math.max(settings.delayMin + 1, parseInt(e.target.value) || 60))}
                                className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                min={settings.delayMin + 1}
                                title={t('settings.maxDelay')}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.maxRetries')}</label>
                            <input
                                type="number"
                                value={settings.maxRetries}
                                onChange={(e) => update('maxRetries', Math.max(1, Math.min(10, parseInt(e.target.value) || 3)))}
                                className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                min="1"
                                max="10"
                                title={t('settings.maxRetries')}
                            />
                        </div>
                    </div>
                    <p className="mt-3 text-xs text-[#908a9e]">
                        {t('settings.generalTimingInfo')
                            .replace('{min}', String(settings.delayMin))
                            .replace('{max}', String(settings.delayMax))
                            .replace('{retries}', String(settings.maxRetries))}
                    </p>
                </div>
            </SectionPanel>

            {/* ==================== 7. RUNTIME POLICY ==================== */}
            <SectionPanel icon={Target} title="Runtime Policy" tone="violet">
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Captcha Mode</label>
                            <Select
                                value={settings.captchaMode}
                                onChange={(value) => update('captchaMode', value as AppSettings['captchaMode'])}
                                options={[
                                    { value: 'hybrid' as const, label: 'Hybrid' },
                                    { value: 'manual' as const, label: 'Manual only' },
                                    { value: 'auto_skip' as const, label: 'Auto skip' },
                                ]}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Log level</label>
                            <Select
                                value={settings.logLevel}
                                onChange={(value) => update('logLevel', value as AppSettings['logLevel'])}
                                options={[
                                    { value: 'info' as const, label: 'Info' },
                                    { value: 'debug' as const, label: 'Debug' },
                                    { value: 'warn' as const, label: 'Warn' },
                                    { value: 'error' as const, label: 'Error' },
                                ]}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Auto-skip strikes</label>
                            <NumberInput
                                value={settings.captchaAutoSkipMaxStrikes}
                                onChange={(value) => update('captchaAutoSkipMaxStrikes', value)}
                                min={0}
                                max={10}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Manual wait (s)</label>
                            <NumberInput
                                value={settings.captchaManualWaitSeconds}
                                onChange={(value) => update('captchaManualWaitSeconds', value)}
                                min={30}
                                max={600}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Queue concurrency</label>
                            <NumberInput
                                value={settings.queueConcurrency}
                                onChange={(value) => update('queueConcurrency', value)}
                                min={1}
                                max={12}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Queue interval (ms)</label>
                            <NumberInput
                                value={settings.queueIntervalMs}
                                onChange={(value) => update('queueIntervalMs', value)}
                                min={500}
                                max={30000}
                                step={100}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Network retry max</label>
                            <NumberInput
                                value={settings.networkRetryMax}
                                onChange={(value) => update('networkRetryMax', value)}
                                min={0}
                                max={10}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">UI retry max</label>
                            <NumberInput
                                value={settings.uiRetryMax}
                                onChange={(value) => update('uiRetryMax', value)}
                                min={0}
                                max={10}
                            />
                        </div>
                    </div>

                    <Divider />

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Mini-RAG enabled</label>
                            <DSToggle checked={settings.ragEnabled} onChange={() => update('ragEnabled', !settings.ragEnabled)} />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG write mode</label>
                            <Select
                                value={settings.ragWriteMode}
                                onChange={(value) => update('ragWriteMode', value as AppSettings['ragWriteMode'])}
                                options={[
                                    { value: 'risk_only' as const, label: 'Risk only' },
                                    { value: 'all' as const, label: 'All actions' },
                                    { value: 'off' as const, label: 'Off' },
                                ]}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG Top-K</label>
                            <NumberInput
                                value={settings.ragTopK}
                                onChange={(value) => update('ragTopK', value)}
                                min={1}
                                max={12}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG context chars</label>
                            <NumberInput
                                value={settings.ragMaxContextChars}
                                onChange={(value) => update('ragMaxContextChars', value)}
                                min={200}
                                max={6000}
                                step={50}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG budget (ms)</label>
                            <NumberInput
                                value={settings.ragLatencyBudgetMs}
                                onChange={(value) => update('ragLatencyBudgetMs', value)}
                                min={100}
                                max={5000}
                                step={50}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG min score</label>
                            <input
                                type="number"
                                value={settings.ragMinScore}
                                onChange={(e) => {
                                    const parsed = parseFloat(e.target.value)
                                    if (Number.isNaN(parsed)) {
                                        return
                                    }
                                    update('ragMinScore', Math.max(0, Math.min(1, Number(parsed.toFixed(3)))))
                                }}
                                min={0}
                                max={1}
                                step={0.01}
                                className="w-20 rounded-[16px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                title="RAG minimum confidence score"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG entry TTL (hours)</label>
                            <NumberInput
                                value={settings.ragEntryTtlHours}
                                onChange={(value) => update('ragEntryTtlHours', value)}
                                min={24}
                                max={2160}
                                step={12}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">RAG dedupe window (minutes)</label>
                            <NumberInput
                                value={settings.ragDedupeWindowMinutes}
                                onChange={(value) => update('ragDedupeWindowMinutes', value)}
                                min={1}
                                max={10080}
                                step={5}
                            />
                        </div>
                    </div>

                    <p className="text-xs text-[#6f697c]">
                        Hybrid mode: tu skip CAPTCHA o strike thap, vuot nguong se chuyen manual gate va tu resume sau khi ban xac minh.
                    </p>
                </div>

                {/* CAPTCHA Solver */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="mb-2 flex items-center gap-2">
                        <Bot className="h-4 w-4 text-emerald-500" />
                        <span className="text-sm font-medium text-[#17171f]">Auto-Solve CAPTCHA API</span>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">Solver Service Provider</label>
                            <Select
                                value={(settings as any).captchaSolverProvider || 'none'}
                                onChange={(value) => update('captchaSolverProvider' as any, value)}
                                options={[
                                    { value: 'none' as const, label: 'Off / Do not auto-solve' },
                                    { value: '2captcha' as const, label: '2Captcha' },
                                    { value: 'capsolver' as const, label: 'CapSolver' },
                                    { value: 'local-ai' as const, label: 'Local AI (Free)' },
                                ]}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 flex items-center gap-1.5 text-xs text-[#6f697c]">
                                <Key className="h-3 w-3" />
                                API Key
                            </label>
                            <input
                                type="password"
                                value={(settings as any).captchaSolverApiKey || ''}
                                onChange={(e) => update('captchaSolverApiKey' as any, e.target.value)}
                                className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-1.5 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                                placeholder={(settings as any).captchaSolverProvider === 'none' ? 'Bat provider de nhap key' : 'Nhap API key...'}
                                disabled={(settings as any).captchaSolverProvider === 'none'}
                            />
                        </div>
                    </div>
                    {(settings as any).captchaSolverProvider !== 'none' && (
                        <AlertBanner type="warning">
                            Luu y: Ban phai nap tien vao tai khoan {(settings as any).captchaSolverProvider === '2captcha' ? '2captcha.com' : 'capsolver.com'} de co the su dung API tu giai CAPTCHA.
                        </AlertBanner>
                    )}
                </div>
            </SectionPanel>

            {/* ==================== 7.5 IN-HOUSE AI ==================== */}
            <SectionPanel icon={Cpu} title="In-house AI (Local)" tone="cyan">
                <FormRow
                    icon={<Power className="h-4 w-4 text-cyan-500" />}
                    label="Enable In-house AI"
                    description="Bat AI chay truc tiep tren may (Qwen 0.5B). Khong can API key, hoan toan mien phi."
                >
                    <DSToggle checked={(settings as any).hfModelEnabled || false} onChange={() => update('hfModelEnabled' as any, !(settings as any).hfModelEnabled)} />
                </FormRow>

                {(settings as any).hfModelEnabled && (
                    <>
                        <FormRow
                            icon={<Bot className="h-4 w-4 text-cyan-500" />}
                            label="Text Generation Model"
                            description="Model mac dinh: Xenova/Qwen1.5-0.5B-Chat (quantized, ~300MB). De trong de dung mac dinh."
                        >
                            <TextInput
                                value={(settings as any).hfTextGenModel || ''}
                                onChange={(v) => update('hfTextGenModel' as any, v)}
                                placeholder="Xenova/Qwen1.5-0.5B-Chat"
                                className="w-56"
                            />
                        </FormRow>

                        <FormRow
                            icon={<Timer className="h-4 w-4 text-cyan-500" />}
                            label="Auto-Unload Idle (phut)"
                            description="Tu dong giai phong model khoi RAM sau N phut khong hoat dong. Set 0 de tat."
                        >
                            <NumberInput
                                value={(settings as any).hfAutoUnloadMinutes ?? 5}
                                onChange={(v) => update('hfAutoUnloadMinutes' as any, v)}
                                min={0}
                                max={60}
                                suffix="min"
                            />
                        </FormRow>

                        <FormRow
                            icon={<MemoryStick className="h-4 w-4 text-cyan-500" />}
                            label="Max RAM cho AI (MB)"
                            description="Gioi han bo nho toi da cho local AI. Khuyen nghi: 2048MB cho 8GB RAM, 4096MB cho 16GB+."
                        >
                            <NumberInput
                                value={(settings as any).hfMaxMemoryMB ?? 2048}
                                onChange={(v) => update('hfMaxMemoryMB' as any, v)}
                                min={512}
                                max={8192}
                                suffix="MB"
                            />
                        </FormRow>

                        <AlertBanner type="info">
                            Khi bat, he thong tu dong dung AI local khi Groq API khong kha dung (offline hoac het key).
                            Model se duoc tai xuong lan dau tien (~300MB) va cache tai thu muc userData.
                        </AlertBanner>

                        {/* ---- HF Status Dashboard ---- */}
                        <HFStatusDashboard />
                    </>
                )}
            </SectionPanel>

            {/* ==================== 8. STORAGE ==================== */}
            <SectionPanel icon={Database} title={t('settings.storage')} tone="emerald">
                <FormRow
                    icon={<FolderOpen className="h-4 w-4 text-emerald-500" />}
                    label={t('settings.dataDirectory')}
                    description={t('settings.dataDirectoryDesc')}
                >
                    <div className="flex gap-2">
                        <TextInput
                            value={settings.dataDir}
                            onChange={(v) => update('dataDir', v)}
                            placeholder={t('settings.dataDirectoryPlaceholder')}
                            className="w-56"
                        />
                        <PrimaryButton
                            variant="dark"
                            icon={FolderOpen}
                            onClick={selectDataDir}
                            title={t('settings.browseDirectory')}
                        >
                            {''}
                        </PrimaryButton>
                    </div>
                </FormRow>

                {/* Real disk usage - scanned from userData/profiles + traffic_profiles + DB */}
                <div className="mt-3 space-y-2 rounded-[16px] border border-[#e9e4f2] bg-white p-3">
                    <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-[#17171f]">{t('settings.storageUsage', 'Storage Usage')}</div>
                        <div className="flex items-center gap-2">
                            <PrimaryButton variant="quiet" onClick={loadV2Maintenance} className="text-xs" icon={RefreshCw}>{t('settings.refresh', 'Refresh')}</PrimaryButton>
                            <PrimaryButton variant="quiet" onClick={() => window.electronAPI.data.openPath?.(storageInfo?.dataRoot || dataRootInfo?.dataRoot)} className="text-xs" icon={FolderOpen}>{t('settings.openFolder', 'Open folder')}</PrimaryButton>
                            <PrimaryButton tone="rose" variant="quiet" onClick={async () => {
                                try { setMaintenanceBusy(true); const r = await window.electronAPI.data.clearCaches?.(); showMsg('success', `${t('settings.clearCachesDone', 'Caches cleared')} (${r?.cleared ?? 0})`); await loadV2Maintenance() } catch { showMsg('error', 'Clear failed') } finally { setMaintenanceBusy(false) }
                            }} disabled={maintenanceBusy} className="text-xs" icon={Trash2}>{t('settings.clearCaches', 'Clear caches')}</PrimaryButton>
                        </div>
                    </div>

                    <div className="text-xs text-[#6f697c] break-all">{storageInfo?.dataRoot || dataRootInfo?.dataRoot || 'N/A'}</div>
                    <div className="text-xs"><span className="text-[#908a9e]">{t('settings.totalSize', 'Total')}:</span> <span className="font-medium text-[#17171f]">{formatBytes(storageInfo?.totalSize || 0)}</span></div>

                    {(!storageInfo || (storageInfo.profileCount || 0) === 0) ? (
                        <div className="text-xs text-[#6f697c] py-1">{t('settings.noProfileData', 'Chưa có dữ liệu profile — đăng nhập account để tạo')}</div>
                    ) : (
                        <div className="space-y-1 text-xs">
                            {(storageInfo.items || []).map((it: any, idx: number) => (
                                <div key={idx} className="flex items-center justify-between rounded border border-[#f0edf7] bg-[#faf8ff] px-2 py-1">
                                    <div>
                                        <span className="font-medium text-[#17171f]">{it.label || it.key}</span>
                                        {typeof it.count === 'number' && <span className="ml-1 text-[#908a9e]">({it.count} {t('settings.items', 'items')})</span>}
                                        {typeof it.cookies === 'number' && it.cookies > 0 && <span className="ml-1 text-emerald-600">({it.cookies} {t('settings.accountsWithCookies', 'cookies')})</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-[#5f5a6d]">{formatBytes(it.size || 0)}</span>
                                        {it.path && (
                                            <button onClick={() => window.electronAPI.data.openPath?.(it.path)} className="text-[#8d74e8] hover:underline" title={t('settings.openFolder')}>↗</button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </SectionPanel>

            {/* ==================== 9. RUNTIME V2 ==================== */}
            <SectionPanel icon={RefreshCw} title="Runtime V2" tone="cyan">
                {/* Portable Data Root */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="text-sm font-medium text-[#17171f]">Portable Data Root</div>
                    <div className="break-all text-xs text-[#5f5a6d]">
                        {dataRootInfo?.dataRoot || 'N/A'}
                    </div>
                    <div className="text-xs text-[#6f697c]">
                        Legacy sources: {legacyRoots.filter(item => item.exists).length}
                    </div>
                    {legacyRoots.filter(item => item.exists).length > 0 && (
                        <div className="space-y-1">
                            {legacyRoots.filter(item => item.exists).map(item => (
                                <div key={item.path} className="break-all text-xs text-[#6f697c]">
                                    {item.path} ({item.fileCount} files)
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                        <PrimaryButton
                            variant="quiet"
                            onClick={loadV2Maintenance}
                            disabled={maintenanceBusy}
                            className="text-xs"
                        >
                            Refresh
                        </PrimaryButton>
                        <PrimaryButton
                            onClick={handleMigrateLegacy}
                            disabled={maintenanceBusy || legacyRoots.filter(item => item.exists && item.fileCount > 0).length === 0}
                            className="text-xs"
                        >
                            Migrate Legacy
                        </PrimaryButton>
                    </div>
                </div>

                {/* Mini-RAG Knowledge */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="text-sm font-medium text-[#17171f]">Mini-RAG Knowledge</div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <div className="text-xs">
                            <div className="text-[#908a9e]">Enabled</div>
                            <div className={`font-medium ${ragStats?.enabled ? 'text-emerald-600' : 'text-[#5f5a6d]'}`}>
                                {ragStats?.enabled ? 'Yes' : 'No'}
                            </div>
                        </div>
                        <div className="text-xs">
                            <div className="text-[#908a9e]">Entries</div>
                            <div className="font-medium text-[#17171f]">{ragStats?.totalEntries ?? 0}</div>
                        </div>
                        <div className="text-xs">
                            <div className="text-[#908a9e]">Hit rate</div>
                            <div className="font-medium text-[#17171f]">{formatPercent(ragStats?.hitRate ?? 0)}</div>
                        </div>
                        <div className="text-xs">
                            <div className="text-[#908a9e]">P95 latency</div>
                            <div className="font-medium text-[#17171f]">{ragStats?.p95LatencyMs ?? 0} ms</div>
                        </div>
                    </div>
                    <div className="text-xs text-[#6f697c]">
                        Retrievals: {ragStats?.retrievalCount ?? 0} · Hits: {ragStats?.retrievalHitCount ?? 0} · Avg latency: {ragStats?.avgLatencyMs ?? 0} ms
                    </div>
                    <div className="text-xs text-[#6f697c]">
                        Last retrieval: {ragStats?.lastRetrievalAt ? new Date(ragStats.lastRetrievalAt).toLocaleString() : 'N/A'}
                    </div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                        <input
                            type="number"
                            value={ragClearScope.campaignId}
                            onChange={(e) => setRagClearScope(prev => ({ ...prev, campaignId: e.target.value }))}
                            placeholder="Campaign ID (optional)"
                            className="rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-xs text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                            min="1"
                        />
                        <input
                            type="text"
                            value={ragClearScope.domain}
                            onChange={(e) => setRagClearScope(prev => ({ ...prev, domain: e.target.value }))}
                            placeholder="Domain (optional)"
                            className="rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-xs text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        />
                        <input
                            type="text"
                            value={ragClearScope.riskType}
                            onChange={(e) => setRagClearScope(prev => ({ ...prev, riskType: e.target.value }))}
                            placeholder="Risk type (optional)"
                            className="rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-xs text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        />
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                        <PrimaryButton
                            variant="quiet"
                            onClick={loadV2Maintenance}
                            disabled={maintenanceBusy}
                            className="text-xs"
                        >
                            Refresh metrics
                        </PrimaryButton>
                        <PrimaryButton
                            tone="amber"
                            onClick={handleClearRag}
                            disabled={maintenanceBusy}
                            className="text-xs"
                        >
                            Clear knowledge
                        </PrimaryButton>
                    </div>
                </div>

                {/* MCP Health */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="text-sm font-medium text-[#17171f]">MCP control-plane health</div>
                    <div className="text-xs text-[#5f5a6d]">
                        Overall: <span className={mcpHealth?.healthy ? 'font-semibold text-emerald-600' : 'font-semibold text-amber-600'}>{mcpHealth?.healthy ? 'Healthy' : 'Degraded'}</span>
                        {mcpHealth?.checkedAt ? ` · Checked: ${new Date(mcpHealth.checkedAt).toLocaleString()}` : ''}
                    </div>
                    <div className="space-y-1.5">
                        {(mcpHealth?.adapters || []).map(adapter => (
                            <div key={adapter.name} className="rounded-[14px] border border-[#ece7f5] bg-[#f4f1fa] px-2 py-1.5 text-xs text-[#5f5a6d]">
                                <span className="font-medium text-[#17171f]">{adapter.name}</span>
                                <span className="text-[#908a9e]"> · enabled: {adapter.enabled ? 'yes' : 'no'}</span>
                                <span className={`ml-1 ${adapter.healthy ? 'text-emerald-600' : 'text-amber-600'}`}>· {adapter.healthy ? 'healthy' : 'issue'}</span>
                                {typeof adapter.latencyMs === 'number' ? <span className="text-[#908a9e]"> · {adapter.latencyMs} ms</span> : null}
                                {adapter.detail ? <div className="mt-0.5 break-words text-[#908a9e]">{adapter.detail}</div> : null}
                            </div>
                        ))}
                        {(!mcpHealth || !mcpHealth.adapters || mcpHealth.adapters.length === 0) && (
                            <div className="text-xs text-[#6f697c]">No MCP adapter diagnostics yet.</div>
                        )}
                    </div>
                </div>

                {/* Soak Test */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="text-sm font-medium text-[#17171f]">Soak test (8h)</div>
                    <div className="text-xs text-[#5f5a6d]">
                        Status: <span className={soakStatus?.running ? 'font-semibold text-emerald-600' : 'text-[#908a9e]'}>{soakStatus?.running ? 'Running' : 'Stopped'}</span>
                        {soakStatus?.sessionId ? ` · Session: ${soakStatus.sessionId}` : ''}
                    </div>
                    <div className="text-xs text-[#6f697c]">
                        Samples: {soakStatus?.sampleCount ?? 0}
                        {soakStatus?.lastSnapshotAt ? ` · Last snapshot: ${new Date(soakStatus.lastSnapshotAt).toLocaleString()}` : ''}
                    </div>
                    <div className="text-xs text-[#6f697c]">
                        Start: {soakStatus?.startedAt ? new Date(soakStatus.startedAt).toLocaleString() : 'N/A'}
                        {soakStatus?.endsAt ? ` · End: ${new Date(soakStatus.endsAt).toLocaleString()}` : ''}
                    </div>
                    <div className="break-all text-xs text-[#6f697c]">
                        Log: {soakStatus?.logPath || 'N/A'}
                    </div>
                    <div className="break-all text-xs text-[#6f697c]">
                        Summary: {soakStatus?.summaryPath || 'N/A'}
                    </div>
                    {soakStatus?.stopReason && (
                        <div className="text-xs text-amber-600">
                            Last stop reason: {soakStatus.stopReason}
                        </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                        <PrimaryButton
                            tone="emerald"
                            onClick={handleStartSoak8h}
                            disabled={maintenanceBusy || soakStatus?.running}
                            className="text-xs"
                        >
                            Start 8h soak
                        </PrimaryButton>
                        <PrimaryButton
                            tone="rose"
                            onClick={handleStopSoak}
                            disabled={maintenanceBusy || !soakStatus?.running}
                            className="text-xs"
                        >
                            Stop soak
                        </PrimaryButton>
                        <PrimaryButton
                            variant="quiet"
                            onClick={loadV2Maintenance}
                            disabled={maintenanceBusy}
                            className="text-xs"
                        >
                            Refresh soak
                        </PrimaryButton>
                    </div>
                </div>

                {/* Updater */}
                <div className="space-y-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="text-sm font-medium text-[#17171f]">Updater</div>
                    <div className="text-xs text-[#5f5a6d]">
                        Current: {updaterState?.currentVersion || 'N/A'}
                        {updaterState?.latestVersion ? ` - Latest: ${updaterState.latestVersion}` : ''}
                    </div>
                    <div className="text-xs text-[#6f697c]">
                        Status: {getUpdaterStatusLabel(updaterState)}
                        {updaterState?.checkedAt ? ` - Last check: ${new Date(updaterState.checkedAt).toLocaleString()}` : ''}
                    </div>
                    {typeof updaterState?.progress === 'number' && updaterState.progress > 0 && (
                        <div className="space-y-1">
                            <ProgressBar
                                value={Math.max(0, Math.min(100, updaterState.progress))}
                                tone="cyan"
                                showLabel
                            />
                        </div>
                    )}
                    {updaterState?.blockedReason && (
                        <div className="break-words text-xs text-amber-600">{updaterState.blockedReason}</div>
                    )}
                    {updaterState?.error && (
                        <div className="break-words text-xs text-rose-600">{updaterState.error}</div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                        <PrimaryButton
                            tone="emerald"
                            onClick={handleCheckAndDownloadUpdate}
                            disabled={maintenanceBusy || !updaterState?.enabled || updaterState?.checking || updaterState?.status === 'downloading'}
                            className="text-xs"
                        >
                            Kiem tra & Tai cap nhat
                        </PrimaryButton>
                        <PrimaryButton
                            onClick={handleInstallUpdate}
                            disabled={maintenanceBusy || !updaterState?.enabled || !updaterState?.downloaded || updaterState?.pendingInstall}
                            title={updaterState?.pendingInstall ? 'Campaign dang chay, update se cai sau khi ranh' : 'Khoi dong lai de cai dat ban cap nhat'}
                            className="text-xs"
                        >
                            Khoi dong lai de cap nhat
                        </PrimaryButton>
                        <PrimaryButton
                            variant="quiet"
                            onClick={loadV2Maintenance}
                            disabled={maintenanceBusy}
                            className="text-xs"
                        >
                            Refresh updater
                        </PrimaryButton>
                    </div>
                </div>
            </SectionPanel>

            {/* ==================== 10. APP & ABOUT ==================== */}
            <SectionPanel icon={Info} title={t('settings.appAbout')} tone="slate">
                <FormRow
                    icon={<Zap className="h-4 w-4 text-amber-500" />}
                    label={t('settings.autoUpdate')}
                    description={t('settings.autoUpdateDesc')}
                >
                    <DSToggle checked={settings.autoUpdate} onChange={() => update('autoUpdate', !settings.autoUpdate)} />
                </FormRow>

                <div className="flex items-center gap-2 pt-2">
                    <PrimaryButton
                        tone="rose"
                        variant="quiet"
                        icon={AlertTriangle}
                        onClick={() => setShowResetConfirm(true)}
                        title={t('settings.resetToDefaults')}
                    >
                        {t('settings.resetToDefaults')}
                    </PrimaryButton>
                </div>

                {showResetConfirm && (
                    <AlertBanner type="error" title={t('settings.resetToDefaults')}>
                        <p className="mb-3 text-sm">
                            {t('settings.resetConfirmMessage')}
                        </p>
                        <div className="flex gap-2">
                            <PrimaryButton
                                tone="rose"
                                onClick={handleReset}
                                className="text-xs"
                            >
                                {t('settings.yesReset')}
                            </PrimaryButton>
                            <PrimaryButton
                                variant="quiet"
                                onClick={() => setShowResetConfirm(false)}
                                className="text-xs"
                            >
                                {t('common.cancel')}
                            </PrimaryButton>
                        </div>
                    </AlertBanner>
                )}
            </SectionPanel>

            {/* Version */}
            <div className="py-4 text-center text-xs text-[#908a9e]">
                MMO Auto Review v1.0.0
            </div>
        </PageShell>
    )
}
