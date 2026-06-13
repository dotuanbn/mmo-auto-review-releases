import { useEffect, useState } from 'react'
import {
    Save,
    FolderOpen,
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
    Hash,
    Gauge,
    Key,
    TestTube2,
    Info,
    Cpu,
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
    const [maintenanceBusy, setMaintenanceBusy] = useState(false)
    const [storageInfo, setStorageInfo] = useState<any>(null)
    const [appVersion, setAppVersion] = useState<string>('1.0.6')

    useEffect(() => {
        loadSettings()
    }, [])

    useEffect(() => {
        // Load app version for About section (best effort)
        if (window.electronAPI?.getVersion) {
            window.electronAPI.getVersion().then((v: string) => { if (v) setAppVersion(v) }).catch(() => {})
        }
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
            await loadStorageInfo()
        } catch (error) {
            console.error('Failed to load settings:', error)
        } finally {
            setLoading(false)
        }
    }

    const loadStorageInfo = async () => {
        try {
            const storage = await window.electronAPI.data.getStorageInfo?.().catch(() => null)
            if (storage) setStorageInfo(storage)
        } catch (error) {
            console.error('Failed to load storage info:', error)
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
            setApiError(e.message || t('settings.testFailed'))
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

    const formatBytes = (bytes: number): string => {
        if (!bytes || bytes <= 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB']
        let i = 0
        let val = bytes
        while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
        return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
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

            {/* 1. CHUNG / APPEARANCE */}
            <SectionPanel icon={Languages} title={t('settings.appearance')} tone="violet">
                <FormRow
                    icon={<Languages className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.language')}
                    description={t('settings.languageDesc')}
                >
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => setLanguage('en')}
                            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-all ${language === 'en' ? 'bg-[#8d74e8] text-white shadow-[0_14px_24px_rgba(141,116,232,0.24)]' : 'border border-[#e9e4f2] bg-white text-[#5f5a6d] hover:bg-[#f4f1fa]'}`}
                            title="English"
                        >
                            EN
                        </button>
                        <button
                            onClick={() => setLanguage('vi')}
                            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-all ${language === 'vi' ? 'bg-[#8d74e8] text-white shadow-[0_14px_24px_rgba(141,116,232,0.24)]' : 'border border-[#e9e4f2] bg-white text-[#5f5a6d] hover:bg-[#f4f1fa]'}`}
                            title="Tiếng Việt"
                        >
                            VI
                        </button>
                    </div>
                </FormRow>
                <FormRow
                    icon={<Moon className="h-4 w-4 text-[#8d74e8]" />}
                    label={t('settings.darkMode')}
                    description={t('settings.darkModeDesc')}
                >
                    <DSToggle checked={isDark} onChange={toggleTheme} />
                </FormRow>
            </SectionPanel>

            {/* 2. TỰ ĐỘNG HÓA / AUTOMATION (real engine settings only) */}
            <SectionPanel icon={Zap} title={t('settings.automation')} tone="blue">
                {/* Browser */}
                <div className="mb-2 text-xs font-semibold text-[#6f697c] uppercase tracking-wide">{t('settings.browser')}</div>
                <FormRow icon={<Eye className="h-4 w-4 text-blue-500" />} label={t('settings.headlessMode')} description={t('settings.headlessModeDesc')}>
                    <DSToggle checked={settings.headless} onChange={() => update('headless', !settings.headless)} />
                </FormRow>
                <FormRow icon={<Shield className="h-4 w-4 text-emerald-500" />} label={t('settings.hideAutomation')} description={t('settings.hideAutomationDesc')}>
                    <DSToggle checked={settings.hideAutomation} onChange={() => update('hideAutomation', !settings.hideAutomation)} />
                </FormRow>
                <FormRow icon={<Database className="h-4 w-4 text-[#8d74e8]" />} label={t('settings.saveProfiles')} description={t('settings.saveProfilesDesc')}>
                    <DSToggle checked={settings.saveProfiles} onChange={() => update('saveProfiles', !settings.saveProfiles)} />
                </FormRow>
                <FormRow icon={<Monitor className="h-4 w-4 text-cyan-500" />} label={t('settings.maxConcurrentBrowsers')} description={t('settings.maxConcurrentBrowsersDesc')}>
                    <NumberInput value={settings.maxConcurrentBrowsers} onChange={(v) => update('maxConcurrentBrowsers', v)} min={1} max={10} />
                </FormRow>
                <FormRow icon={<Shuffle className="h-4 w-4 text-amber-500" />} label={t('settings.randomizeUserAgent')} description={t('settings.randomizeUserAgentDesc')}>
                    <DSToggle checked={settings.randomizeUserAgent} onChange={() => update('randomizeUserAgent', !settings.randomizeUserAgent)} />
                </FormRow>

                {/* Concurrency / CAPTCHA / Log */}
                <div className="mt-3 mb-2 text-xs font-semibold text-[#6f697c] uppercase tracking-wide">{t('settings.concurrency')}</div>
                <FormRow icon={<Cpu className="h-4 w-4 text-[#8d74e8]" />} label={t('settings.queueConcurrency')} description={t('settings.maxConcurrentBrowsersDesc')}>
                    <NumberInput value={settings.queueConcurrency} onChange={(v) => update('queueConcurrency', v)} min={1} max={12} />
                </FormRow>
                <FormRow label={t('settings.queueInterval')} description="">
                    <NumberInput value={settings.queueIntervalMs} onChange={(v) => update('queueIntervalMs', v)} min={500} max={30000} step={100} suffix="ms" />
                </FormRow>
                <FormRow label={t('settings.captchaMode')} description="">
                    <Select
                        value={settings.captchaMode}
                        onChange={(v) => update('captchaMode', v as AppSettings['captchaMode'])}
                        options={[
                            { value: 'hybrid', label: t('settings.captchaModeHybrid') },
                            { value: 'manual', label: t('settings.captchaModeManual') },
                            { value: 'auto_skip', label: t('settings.captchaModeAutoSkip') },
                        ]}
                        className="w-52"
                    />
                </FormRow>
                <FormRow label={t('settings.logLevel')} description="">
                    <Select
                        value={settings.logLevel}
                        onChange={(v) => update('logLevel', v as AppSettings['logLevel'])}
                        options={[
                            { value: 'info', label: 'Info' },
                            { value: 'debug', label: 'Debug' },
                            { value: 'warn', label: 'Warn' },
                            { value: 'error', label: 'Error' },
                        ]}
                        className="w-32"
                    />
                </FormRow>

                {/* Timing */}
                <div className="mt-3 mb-2 text-xs font-semibold text-[#6f697c] uppercase tracking-wide">{t('settings.timing')}</div>
                <div className="rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.minDelay')}</label>
                            <input type="number" value={settings.delayMin} onChange={(e) => update('delayMin', Math.max(5, parseInt(e.target.value) || 30))} className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15" min="5" />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.maxDelay')}</label>
                            <input type="number" value={settings.delayMax} onChange={(e) => update('delayMax', Math.max(settings.delayMin + 1, parseInt(e.target.value) || 60))} className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15" min={settings.delayMin + 1} />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-xs text-[#6f697c]">{t('settings.maxRetries')}</label>
                            <input type="number" value={settings.maxRetries} onChange={(e) => update('maxRetries', Math.max(1, Math.min(10, parseInt(e.target.value) || 3)))} className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1.5 text-center text-sm text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15" min="1" max="10" />
                        </div>
                    </div>
                    <p className="mt-2 text-xs text-[#908a9e]">{t('settings.generalTimingInfo').replace('{min}', String(settings.delayMin)).replace('{max}', String(settings.delayMax)).replace('{retries}', String(settings.maxRetries))}</p>
                </div>

                {/* Captcha Solver */}
                <div className="mt-3 mb-2 text-xs font-semibold text-[#6f697c] uppercase tracking-wide">{t('settings.captchaSolver')}</div>
                <div className="rounded-[18px] border border-[#ece7f5] bg-white p-3.5 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-xs text-[#6f697c]">{t('settings.provider')}</label>
                            <Select
                                value={(settings as any).captchaSolverProvider || 'none'}
                                onChange={(v) => update('captchaSolverProvider' as any, v)}
                                options={[
                                    { value: 'none', label: 'Off' },
                                    { value: '2captcha', label: '2Captcha' },
                                    { value: 'capsolver', label: 'CapSolver' },
                                ]}
                                className="w-full"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-[#6f697c]">{t('settings.apiKey')}</label>
                            <input type="password" value={(settings as any).captchaSolverApiKey || ''} onChange={(e) => update('captchaSolverApiKey' as any, e.target.value)} className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-1.5 text-sm" placeholder="API key..." disabled={(settings as any).captchaSolverProvider === 'none'} />
                        </div>
                    </div>
                    {(settings as any).captchaSolverProvider !== 'none' && (
                        <p className="text-xs text-amber-600">{t('settings.solverWarning').replace('{provider}', (settings as any).captchaSolverProvider)}</p>
                    )}
                </div>

                {/* Proxy */}
                <div className="mt-3 mb-2 text-xs font-semibold text-[#6f697c] uppercase tracking-wide">{t('settings.proxy')}</div>
                <FormRow icon={<Globe className="h-4 w-4 text-cyan-500" />} label={t('settings.useProxy')} description={t('settings.useProxyDesc')}>
                    <DSToggle checked={settings.useProxy} onChange={() => update('useProxy', !settings.useProxy)} />
                </FormRow>
                <FormRow icon={<Key className="h-4 w-4 text-cyan-600" />} label={t('settings.fproxyApiKey')} description={t('settings.fproxyApiKeyDesc')}>
                    <div className="flex gap-2 w-full max-w-md">
                        <input type="password" value={(settings as any).fproxyApiKey || ''} onChange={(e) => update('fproxyApiKey' as any, e.target.value)} className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-1.5 text-sm" placeholder="fproxy.me key" />
                    </div>
                </FormRow>
                {settings.useProxy && (
                    <>
                        <FormRow icon={<RotateCw className="h-4 w-4 text-[#8d74e8]" />} label={t('settings.rotateProxyPerSession')} description={t('settings.rotateProxyPerSessionDesc')}>
                            <DSToggle checked={settings.rotateProxyPerSession} onChange={() => update('rotateProxyPerSession', !settings.rotateProxyPerSession)} />
                        </FormRow>
                        <FormRow icon={<Trash2 className="h-4 w-4 text-rose-500" />} label={t('settings.autoRemoveDeadProxies')} description={t('settings.autoRemoveDeadProxiesDesc')}>
                            <DSToggle checked={settings.autoRemoveDeadProxies} onChange={() => update('autoRemoveDeadProxies', !settings.autoRemoveDeadProxies)} />
                        </FormRow>
                    </>
                )}
            </SectionPanel>

            {/* 3. AI & REVIEW */}
            <SectionPanel icon={Bot} title={t('settings.ai')} tone="violet">
                {/* Groq */}
                <div className="space-y-2 rounded-[18px] border border-[#ece7f5] bg-[#f9f7fe] p-3.5">
                    <div className="flex items-center gap-2 text-sm font-medium"><Key className="h-4 w-4 text-[#735bd6]" />{t('settings.groq')}</div>
                    <div className="flex gap-2">
                        <input type="password" value={settings.groqApiKey} onChange={(e) => update('groqApiKey', e.target.value)} className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-1.5 text-sm" placeholder="gsk_..." />
                        <PrimaryButton icon={apiTesting ? RefreshCw : TestTube2} onClick={handleTestApiKey} disabled={!settings.groqApiKey || apiTesting} className={apiTesting ? '[&_svg]:animate-spin' : ''}>{t('settings.test')}</PrimaryButton>
                    </div>
                    {apiStatus !== 'idle' && (
                        <AlertBanner type={apiStatus === 'valid' ? 'success' : 'error'}>
                            {apiStatus === 'valid' ? t('settings.testSuccess') : t('settings.testFailed')}
                            {apiError && <div className="mt-1 text-[11px] opacity-80">{apiError}</div>}
                        </AlertBanner>
                    )}
                    <div>
                        <label className="mb-1 block text-xs text-[#6f697c]">{t('settings.groqModel')}</label>
                        <Select value={settings.groqModel} onChange={(v) => update('groqModel', v)} options={[
                            { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
                            { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
                            { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
                        ]} className="w-56" />
                    </div>
                    <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.openExternal('https://console.groq.com/keys') }} className="text-xs text-[#735bd6] underline">{t('settings.groqLink')}</a>
                </div>

                {/* Ollama */}
                <div className="mt-3 space-y-2 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="flex items-center gap-2 text-sm font-medium"><Database className="h-4 w-4" />{t('settings.ollama')}</div>
                    <div className="flex gap-2">
                        <input type="text" value={settings.ollamaUrl} onChange={(e) => update('ollamaUrl', e.target.value)} className="flex-1 rounded-[14px] border border-[#e9e4f2] bg-white px-3 py-1.5 text-sm" placeholder="http://localhost:11434" />
                        <PrimaryButton variant="quiet" icon={ollamaTesting ? RefreshCw : TestTube2} onClick={handleTestOllama} disabled={!settings.ollamaUrl || ollamaTesting} className={ollamaTesting ? '[&_svg]:animate-spin' : ''} />
                    </div>
                    {ollamaStatus !== 'idle' && <AlertBanner type={ollamaStatus === 'valid' ? 'success' : 'error'}>{ollamaStatus === 'valid' ? t('settings.testSuccess') : t('settings.testFailed')}</AlertBanner>}
                    {ollamaModels.length > 0 && (
                        <div>
                            <label className="text-xs text-[#6f697c]">{t('settings.ollamaModel')}</label>
                            <Select value={settings.ollamaModel} onChange={(v) => update('ollamaModel', v)} options={ollamaModels.map(m => ({ value: m, label: m }))} />
                        </div>
                    )}
                </div>

                {/* Review defaults */}
                <div className="mt-3">
                    <div className="mb-2 text-xs font-semibold text-[#6f697c] uppercase tracking-wide">{t('settings.reviewDefaults')}</div>
                    <FormRow icon={<Star className="h-4 w-4 text-amber-500" />} label={t('settings.defaultRating')} description={t('settings.defaultRatingDesc')}>
                        <div className="flex items-center gap-1">
                            {[1,2,3,4,5].map(s => (
                                <button key={s} onClick={() => update('defaultRating', s)} className="transition hover:scale-110" title={`${s}`}>
                                    <Star className={`h-5 w-5 ${s <= settings.defaultRating ? 'fill-amber-400 text-amber-400' : 'text-[#908a9e]'}`} />
                                </button>
                            ))}
                        </div>
                    </FormRow>
                    <FormRow icon={<Image className="h-4 w-4 text-emerald-500" />} label={t('settings.includePhotos')} description={t('settings.includePhotosDesc')}>
                        <DSToggle checked={settings.includePhotos} onChange={() => update('includePhotos', !settings.includePhotos)} />
                    </FormRow>
                    <FormRow icon={<Bot className="h-4 w-4 text-[#8d74e8]" />} label={t('settings.autoGenerateReview')} description={t('settings.autoGenerateReviewDesc')}>
                        <DSToggle checked={settings.autoGenerateReview} onChange={() => update('autoGenerateReview', !settings.autoGenerateReview)} />
                    </FormRow>
                    <FormRow icon={<Languages className="h-4 w-4 text-[#8d74e8]" />} label={t('settings.defaultReviewLanguage')} description={t('settings.defaultReviewLanguageDesc')}>
                        <Select value={settings.defaultReviewLanguage} onChange={(v) => update('defaultReviewLanguage', v as 'vi'|'en')} options={[
                            { value: 'vi', label: 'Tiếng Việt' },
                            { value: 'en', label: 'English' },
                        ]} className="w-36" />
                    </FormRow>
                    <FormRow icon={<FileText className="h-4 w-4 text-rose-500" />} label={t('settings.defaultReviewStyle')} description={t('settings.defaultReviewStyleDesc')}>
                        <Select value={settings.defaultReviewStyle} onChange={(v) => update('defaultReviewStyle', v as any)} options={[
                            { value: 'casual', label: t('settings.styleCasual') },
                            { value: 'professional', label: t('settings.styleProfessional') },
                            { value: 'enthusiastic', label: t('settings.styleEnthusiastic') },
                        ]} className="w-36" />
                    </FormRow>
                    <FormRow icon={<Gauge className="h-4 w-4 text-amber-500" />} label={t('settings.defaultReviewLength')} description={t('settings.defaultReviewLengthDesc')}>
                        <Select value={settings.defaultReviewLength} onChange={(v) => update('defaultReviewLength', v as any)} options={[
                            { value: 'short', label: t('settings.lengthShort') },
                            { value: 'medium', label: t('settings.lengthMedium') },
                            { value: 'long', label: t('settings.lengthLong') },
                        ]} className="w-28" />
                    </FormRow>
                </div>
            </SectionPanel>

            {/* 4. TRAFFIC */}
            <SectionPanel icon={Car} title={t('settings.trafficDefaults')} tone="emerald">
                <FormRow icon={<Target className="h-4 w-4 text-emerald-500" />} label={t('settings.defaultTrafficMode')} description={t('settings.defaultTrafficModeDesc')}>
                    <Select value={settings.defaultTrafficMode} onChange={(v) => update('defaultTrafficMode', v as any)} options={[
                        { value: 'organic', label: t('settings.trafficModeOrganic') },
                        { value: 'direct', label: t('settings.trafficModeDirect') },
                    ]} className="w-44" />
                </FormRow>
                <FormRow icon={<Hash className="h-4 w-4 text-blue-500" />} label={t('settings.visitsPerLocation')} description="">
                    <NumberInput value={settings.defaultVisitsPerLocation} onChange={(v) => update('defaultVisitsPerLocation', v)} min={1} max={100} />
                </FormRow>
                <FormRow icon={<Zap className="h-4 w-4 text-amber-500" />} label={t('settings.actionsPerVisit')} description="">
                    <NumberInput value={settings.defaultActionsPerVisit} onChange={(v) => update('defaultActionsPerVisit', v)} min={1} max={100} />
                </FormRow>
                <div className="mt-2 rounded-[18px] border border-[#ece7f5] bg-white p-3.5">
                    <div className="mb-2 text-sm font-medium">{t('settings.visitDelayRange')}</div>
                    <div className="flex gap-3">
                        <div className="flex-1">
                            <div className="text-xs text-[#6f697c] mb-1">{t('settings.minSeconds')}</div>
                            <input type="number" value={settings.trafficDelayMin} onChange={(e) => update('trafficDelayMin', Math.max(5, parseInt(e.target.value)||5))} className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1 text-sm text-center" min="5" />
                        </div>
                        <div className="flex-1">
                            <div className="text-xs text-[#6f697c] mb-1">{t('settings.maxSeconds')}</div>
                            <input type="number" value={settings.trafficDelayMax} onChange={(e) => update('trafficDelayMax', Math.max(settings.trafficDelayMin+1, parseInt(e.target.value)||30))} className="w-full rounded-[14px] border border-[#e9e4f2] bg-white px-2.5 py-1 text-sm text-center" min={settings.trafficDelayMin+1} />
                        </div>
                    </div>
                    <p className="mt-2 text-xs text-[#908a9e]">{t('settings.randomDelay').replace('{min}', String(settings.trafficDelayMin)).replace('{max}', String(settings.trafficDelayMax))}</p>
                </div>
            </SectionPanel>

            {/* 5. DỮ LIỆU & LƯU TRỮ (real IPC) */}
            <SectionPanel icon={Database} title={t('settings.storage')} tone="emerald">
                <FormRow icon={<FolderOpen className="h-4 w-4 text-emerald-500" />} label={t('settings.dataDirectory')} description={t('settings.dataDirectoryDesc')}>
                    <div className="flex gap-2">
                        <TextInput value={settings.dataDir} onChange={(v) => update('dataDir', v)} placeholder={t('settings.dataDirectoryPlaceholder')} className="w-56" />
                        <PrimaryButton variant="dark" icon={FolderOpen} onClick={selectDataDir}>{t('settings.browseDirectory')}</PrimaryButton>
                    </div>
                </FormRow>
                <div className="mt-3 rounded-[16px] border border-[#e9e4f2] bg-white p-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">{t('settings.storageUsage')}</div>
                        <div className="flex gap-2">
                            <PrimaryButton variant="quiet" onClick={loadStorageInfo} className="text-xs" icon={RefreshCw}>{t('settings.refresh')}</PrimaryButton>
                            <PrimaryButton variant="quiet" onClick={() => window.electronAPI.data.openPath?.(storageInfo?.dataRoot)} className="text-xs" icon={FolderOpen}>{t('settings.openFolder')}</PrimaryButton>
                            <PrimaryButton tone="rose" variant="quiet" onClick={async () => { try { setMaintenanceBusy(true); const r = await window.electronAPI.data.clearCaches?.(); showMsg('success', `${t('settings.clearCachesDone')} (${r?.cleared ?? 0})`); await loadStorageInfo() } catch { showMsg('error', t('settings.saveFailed')) } finally { setMaintenanceBusy(false) } }} disabled={maintenanceBusy} className="text-xs" icon={Trash2}>{t('settings.clearCaches')}</PrimaryButton>
                        </div>
                    </div>
                    <div className="text-xs break-all text-[#6f697c]">{storageInfo?.dataRoot || 'N/A'}</div>
                    <div className="text-xs"><span className="text-[#908a9e]">{t('settings.totalSize')}:</span> <span className="font-medium">{formatBytes(storageInfo?.totalSize || 0)}</span></div>
                    {storageInfo?.items?.length ? (
                        <div className="space-y-1 text-xs pt-1">
                            {storageInfo.items.map((it: any, i: number) => (
                                <div key={i} className="flex justify-between rounded border border-[#f0edf7] bg-[#faf8ff] px-2 py-1">
                                    <span>{it.label} {it.count ? `(${it.count} ${t('settings.items')})` : ''}</span>
                                    <span className="font-mono text-[#5f5a6d]">{formatBytes(it.size || 0)} {it.path && <button onClick={() => window.electronAPI.data.openPath?.(it.path)} className="ml-1 text-[#8d74e8]">↗</button>}</span>
                                </div>
                            ))}
                        </div>
                    ) : <div className="text-xs text-[#6f697c]">{t('settings.noProfileData')}</div>}
                </div>
            </SectionPanel>

            {/* 6. GIỚI THIỆU / ABOUT */}
            <SectionPanel icon={Info} title={t('settings.appAbout')} tone="slate">
                <FormRow icon={<Zap className="h-4 w-4 text-amber-500" />} label={t('settings.autoUpdate')} description={t('settings.autoUpdateDesc')}>
                    <DSToggle checked={settings.autoUpdate} onChange={() => update('autoUpdate', !settings.autoUpdate)} />
                </FormRow>
                <div className="flex items-center gap-2 pt-2">
                    <PrimaryButton tone="rose" variant="quiet" icon={AlertTriangle} onClick={() => setShowResetConfirm(true)}>{t('settings.resetToDefaults')}</PrimaryButton>
                </div>
                {showResetConfirm && (
                    <AlertBanner type="error" title={t('settings.resetToDefaults')}>
                        <p className="mb-3 text-sm">{t('settings.resetConfirmMessage')}</p>
                        <div className="flex gap-2">
                            <PrimaryButton tone="rose" onClick={handleReset} className="text-xs">{t('settings.yesReset')}</PrimaryButton>
                            <PrimaryButton variant="quiet" onClick={() => setShowResetConfirm(false)} className="text-xs">{t('common.cancel')}</PrimaryButton>
                        </div>
                    </AlertBanner>
                )}
                <div className="pt-3 text-xs text-[#908a9e]">{t('settings.version')}: {appVersion}</div>
            </SectionPanel>
        </PageShell>
    )
}
