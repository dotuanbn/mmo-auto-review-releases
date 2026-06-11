import { useState, useEffect } from 'react'
import {
    BarChart3, RefreshCw, Search, Eye, MousePointerClick,
    MapPin, Star, Phone, Navigation, Globe, TrendingDown,
    CheckCircle, Settings, Loader2,
    ArrowUpRight, Activity, Zap, Target, LogIn, LogOut,
} from 'lucide-react'
import {
    PageHeader,
    PageShell,
    PrimaryButton,
    IconButton,
    Panel,
    SectionPanel,
    StatCard,
    StatRow,
    EmptyState,
    AlertBanner,
    Select,
    TextInput,
    DataTable,
    Divider,
    StatusPill,
} from '../components/ui/surface'

const api = window.electronAPI

// ============================================================
// Types
// ============================================================

interface LocationConfig {
    id: number
    name: string
    url: string
    category: string
    analyticsMode: string
    ga4PropertyId: string
    gscSiteUrl: string
    analyticsGoogleEmail?: string
}

// ============================================================
// Helper Components
// ============================================================

function MiniChart({ data, color = '#8d74e8', height = 40 }: { data: number[], color?: string, height?: number }) {
    if (!data || data.length < 2) return <div className="h-10 flex items-center justify-center text-[#908a9e] text-xs">No trend data</div>
    const max = Math.max(...data, 1)
    const min = Math.min(...data, 0)
    const range = max - min || 1
    const w = 100 / (data.length - 1)

    const points = data.map((v, i) => `${i * w},${height - ((v - min) / range) * (height - 4)}`).join(' ')
    const areaPoints = `0,${height} ${points} 100,${height}`

    return (
        <svg viewBox={`0 0 100 ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
            <defs>
                <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                </linearGradient>
            </defs>
            <polygon points={areaPoints} fill={`url(#grad-${color.replace('#', '')})`} />
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function ModeSelector({ value, onChange }: { value: string, onChange: (v: string) => void }) {
    const modes = [
        { id: 'none', label: 'Tat', desc: 'Khong thu thap' },
        { id: 'scrape', label: 'Scrape', desc: 'Tu dong doc tu Maps/GBP' },
        { id: 'api', label: 'API', desc: 'Google Analytics + Search Console' },
    ]
    return (
        <div className="flex gap-2">
            {modes.map(m => (
                <PrimaryButton
                    key={m.id}
                    onClick={() => onChange(m.id)}
                    variant={value === m.id ? 'solid' : 'quiet'}
                    tone={value === m.id ? 'violet' : 'slate'}
                    className="!flex-1 !flex-col !items-start !rounded-[14px] !px-3 !py-2"
                >
                    <span className="text-xs font-medium">{m.label}</span>
                    <span className="text-[10px] opacity-70 mt-0.5">{m.desc}</span>
                </PrimaryButton>
            ))}
        </div>
    )
}

// ============================================================
// Setup Guide Component
// ============================================================

function SetupGuide({ mode }: { mode: string }) {
    if (mode === 'scrape') {
        return (
            <AlertBanner type="success" title="Scrape Mode — San sang su dung!">
                <div className="space-y-1 text-sm mt-1">
                    <div>Mode nay <strong>khong can</strong> cai dat gi them. App se tu dong mo Google Maps, doc so lieu review va rating.</div>
                    <div>Tu dong doc <strong>so review</strong> va <strong>rating trung binh</strong> tu Google Maps</div>
                    <div>Khong can quyen admin cua Google Business Profile</div>
                    <div>Bam <strong>"Thu thap du lieu"</strong> de bat dau</div>
                </div>
            </AlertBanner>
        )
    }

    if (mode === 'api') {
        return (
            <AlertBanner type="info" title="API Mode — Ket noi tai khoan Google">
                <div className="text-sm mt-1">
                    Bam <strong>"Dang nhap Google"</strong> o phan cai dat phia tren de tu dong ket noi.
                    Sau khi dang nhap, chon GA4 Property va Search Console site cua ban.
                </div>
            </AlertBanner>
        )
    }

    return null
}

// ============================================================
// Main Analytics Page
// ============================================================

export function Analytics() {
    const [locations, setLocations] = useState<LocationConfig[]>([])
    const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null)
    const [analyticsData, setAnalyticsData] = useState<any>(null)
    const [loading, setLoading] = useState(false)
    const [collecting, setCollecting] = useState(false)
    const [collectResult, setCollectResult] = useState<any>(null)
    const [mode, setMode] = useState<string>('none')
    const [ga4PropertyId, setGa4PropertyId] = useState('')
    const [gscSiteUrl, setGscSiteUrl] = useState('')
    const [showConfig, setShowConfig] = useState(false)
    const [savingConfig, setSavingConfig] = useState(false)
    const [analyticsGoogleEmail, setAnalyticsGoogleEmail] = useState('')
    // OAuth2 state
    const [googleLoginStatus, setGoogleLoginStatus] = useState<{ loggedIn: boolean; email?: string; allEmails?: string[] }>({ loggedIn: false })
    const [loggingIn, setLoggingIn] = useState(false)
    const [ga4Properties, setGa4Properties] = useState<{ id: string; displayName: string }[]>([])
    const [gscSites, setGscSites] = useState<{ siteUrl: string; permissionLevel: string }[]>([])
    const [loadingProperties, setLoadingProperties] = useState(false)
    const [apiError, setApiError] = useState('')
    const [accounts, setAccounts] = useState<any[]>([])
    const [selectedLoginEmail, setSelectedLoginEmail] = useState('')

    // Load locations + Google login status + accounts
    useEffect(() => {
        loadLocations()
        checkGoogleLoginStatus()
        loadAccounts()
    }, [])

    const loadAccounts = async () => {
        try {
            const accs = await api.accounts.getAll()
            setAccounts(accs || [])
        } catch (err) {
            console.error('Failed to load accounts:', err)
        }
    }

    const checkGoogleLoginStatus = async (emailToCheck?: string) => {
        try {
            const status = await api.analytics.getGoogleLoginStatus(emailToCheck)
            setGoogleLoginStatus(status)
            if (status.loggedIn && status.email) {
                loadPropertiesAndSites(status.email)
            }
        } catch (err) {
            console.error('Failed to check Google login status:', err)
        }
    }

    const loadPropertiesAndSites = async (emailToLoad?: string) => {
        setLoadingProperties(true)
        setApiError('')
        setGa4Properties([])
        setGscSites([])
        try {
            const [props, sites] = await Promise.all([
                api.analytics.listGA4Properties(emailToLoad),
                api.analytics.listSearchConsoleSites(emailToLoad),
            ])
            console.log('[Analytics UI] GA4 Properties result:', props)
            console.log('[Analytics UI] GSC Sites result:', sites)

            const errors: string[] = []
            if (props?.error) {
                errors.push(`GA4: ${props.error}`)
            } else if (Array.isArray(props)) {
                setGa4Properties(props)
            }
            if (sites?.error) {
                errors.push(`GSC: ${sites.error}`)
            } else if (Array.isArray(sites)) {
                setGscSites(sites)
            }
            if (errors.length > 0) {
                setApiError(errors.join(' | '))
            }
        } catch (err: any) {
            console.error('Failed to load GA4/GSC:', err)
            setApiError(err.message || 'Loi khong xac dinh')
        }
        setLoadingProperties(false)
    }

    const handleGoogleLogin = async () => {
        setLoggingIn(true)
        try {
            const result = await api.analytics.startGoogleLogin(selectedLoginEmail || undefined)
            if (result.success && result.email) {
                setAnalyticsGoogleEmail(result.email)
                const newStatus = await api.analytics.getGoogleLoginStatus(result.email)
                setGoogleLoginStatus(newStatus)
                await loadPropertiesAndSites(result.email)
            }
        } catch (err) {
            console.error('Google login failed:', err)
        }
        setLoggingIn(false)
    }

    const handleGoogleLogout = async (emailToLogout?: string) => {
        await api.analytics.logoutGoogle(emailToLogout)
        if (emailToLogout === analyticsGoogleEmail) {
            setAnalyticsGoogleEmail('')
        }
        // Refresh status
        checkGoogleLoginStatus(analyticsGoogleEmail === emailToLogout ? undefined : analyticsGoogleEmail)
        setGa4Properties([])
        setGscSites([])
    }

    const loadLocations = async () => {
        try {
            const locs = await api.analytics.getLocationsWithConfig()
            setLocations(locs || [])
            if (locs && locs.length > 0 && !selectedLocationId) {
                setSelectedLocationId(locs[0].id)
            }
        } catch (err) {
            console.error('Failed to load locations:', err)
        }
    }

    // Load data when location changes
    useEffect(() => {
        if (selectedLocationId) {
            loadLocationData()
            loadLocationConfig()
        }
    }, [selectedLocationId])

    const loadLocationConfig = async () => {
        if (!selectedLocationId) return
        try {
            const config = await api.analytics.getLocationConfig(selectedLocationId)
            setMode(config.analyticsMode || 'none')
            setGa4PropertyId(config.ga4PropertyId || '')
            setGscSiteUrl(config.gscSiteUrl || '')
            setAnalyticsGoogleEmail(config.analyticsGoogleEmail || '')

            checkGoogleLoginStatus(config.analyticsGoogleEmail || undefined)
        } catch (err) {
            console.error('Failed to load config:', err)
        }
    }

    const loadLocationData = async () => {
        if (!selectedLocationId) return
        setLoading(true)
        try {
            const data = await api.analytics.getData(selectedLocationId)
            setAnalyticsData(data)
        } catch (err) {
            console.error('Failed to load analytics:', err)
        }
        setLoading(false)
    }

    const handleCollect = async () => {
        if (!selectedLocationId) return
        setCollecting(true)
        setCollectResult(null)
        try {
            const result = await api.analytics.collect(selectedLocationId)
            setCollectResult(result)
            // Reload data after collection
            await loadLocationData()
        } catch (err: any) {
            setCollectResult({ success: false, error: err.message })
        }
        setCollecting(false)
    }

    const handleSaveConfig = async () => {
        if (!selectedLocationId) return
        setSavingConfig(true)
        try {
            const result = await api.analytics.updateLocationConfig(selectedLocationId, {
                analyticsMode: mode,
                ga4PropertyId,
                gscSiteUrl,
                analyticsGoogleEmail,
            })
            if (!result?.success) {
                throw new Error(result?.error || 'Failed to save analytics config')
            }
            await loadLocations()
            setShowConfig(false)
        } catch (err) {
            console.error('Failed to save config:', err)
        }
        setSavingConfig(false)
    }

    const handleModeChange = (newMode: string) => {
        setMode(newMode)
    }

    const selectedLocation = locations.find(l => l.id === selectedLocationId)

    // Extract metrics from snapshots
    const ga4Data = analyticsData?.latest?.ga4_api
    const gscData = analyticsData?.latest?.gsc_api
    const mapsData = analyticsData?.latest?.maps_scrape
    const gbpData = analyticsData?.latest?.gbp_scrape

    // Build trend data for charts
    const mapsTrend = (analyticsData?.trends?.maps || []).map((s: any) => s.review_count || 0)
    const ga4Trend = (analyticsData?.trends?.ga4 || []).map((s: any) => s.sessions || 0)
    const gscTrend = (analyticsData?.trends?.gsc || []).map((s: any) => s.clicks || 0)

    // Parse top queries from GSC
    let topQueries: any[] = []
    if (gscData?.top_queries) {
        try { topQueries = JSON.parse(gscData.top_queries) } catch { }
    }

    return (
        <PageShell>
            <PageHeader
                icon={BarChart3}
                tone="violet"
                title="Analytics"
                subtitle="Theo doi hieu qua traffic va thu hang tim kiem"
            >
                <PrimaryButton
                    icon={Settings}
                    variant="quiet"
                    onClick={() => setShowConfig(!showConfig)}
                >
                    Cai dat
                </PrimaryButton>
                <PrimaryButton
                    icon={collecting ? Loader2 : RefreshCw}
                    onClick={handleCollect}
                    disabled={collecting || mode === 'none'}
                >
                    {collecting ? 'Dang thu thap...' : 'Thu thap du lieu'}
                </PrimaryButton>
            </PageHeader>

            {/* Location Selector */}
            <div className="flex items-center gap-3">
                <Select
                    value={String(selectedLocationId || '')}
                    onChange={(val) => setSelectedLocationId(Number(val))}
                    options={locations.map(loc => ({
                        value: String(loc.id),
                        label: `${loc.name}${loc.analyticsMode && loc.analyticsMode !== 'none' ? ` (${loc.analyticsMode === 'api' ? 'API' : 'Scrape'})` : ''}`,
                    }))}
                    placeholder="Chon location"
                    className="flex-1 max-w-md"
                />

                {selectedLocation && (
                    <StatusPill
                        tone={mode === 'api' ? 'blue' : mode === 'scrape' ? 'emerald' : 'slate'}
                    >
                        {mode === 'api' ? 'API Mode' : mode === 'scrape' ? 'Scrape Mode' : 'Chua bat'}
                    </StatusPill>
                )}
            </div>

            {/* Config Panel */}
            {showConfig && (
                <Panel className="mb-6">
                    <h3 className="text-sm font-semibold text-[#17171f] mb-4">Cai dat Analytics cho: {selectedLocation?.name}</h3>

                    <ModeSelector value={mode} onChange={handleModeChange} />

                    {mode === 'api' && (
                        <div className="mt-4 space-y-4">
                            {/* Google Login Area */}
                            <div className="p-4 rounded-[18px] border border-[#e9e4f2] bg-white">
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${googleLoginStatus.loggedIn ? 'bg-emerald-50' : 'bg-blue-50'}`}>
                                                {googleLoginStatus.loggedIn ? <CheckCircle className="w-5 h-5 text-emerald-500" /> : <LogIn className="w-5 h-5 text-blue-500" />}
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-[#17171f]">
                                                    Ket noi Google Analytics
                                                </p>
                                                <p className="text-xs text-[#8e899b]">
                                                    Chon tai khoan de lay du lieu cho MAP nay
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        {/* Account selector */}
                                        <Select
                                            value={analyticsGoogleEmail}
                                            onChange={(val) => {
                                                setAnalyticsGoogleEmail(val);
                                                if (val) {
                                                    checkGoogleLoginStatus(val);
                                                } else {
                                                    setGa4Properties([])
                                                    setGscSites([])
                                                    setApiError('')
                                                    checkGoogleLoginStatus(undefined)
                                                }
                                            }}
                                            options={(googleLoginStatus.allEmails || []).map((email: string) => ({
                                                value: email,
                                                label: email,
                                            }))}
                                            placeholder="-- Chon tai khoan da dang nhap --"
                                            className="flex-1"
                                        />

                                        {analyticsGoogleEmail && googleLoginStatus.loggedIn && (
                                            <IconButton
                                                icon={LogOut}
                                                label="Ngat ket noi tai khoan nay"
                                                onClick={() => handleGoogleLogout(analyticsGoogleEmail)}
                                            />
                                        )}
                                    </div>

                                    <Divider />
                                    <div>
                                        <p className="text-xs text-[#908a9e] mb-2">Hoac dang nhap tai khoan moi (Goi y username tu tool):</p>
                                        <div className="flex items-center gap-2">
                                            <Select
                                                value={selectedLoginEmail}
                                                onChange={(val) => setSelectedLoginEmail(val)}
                                                options={accounts.map((acc: any) => ({
                                                    value: acc.email,
                                                    label: acc.email,
                                                }))}
                                                placeholder="-- Khong chon (Mac dinh) --"
                                                className="flex-1"
                                            />
                                            <PrimaryButton
                                                onClick={handleGoogleLogin}
                                                disabled={loggingIn}
                                                icon={loggingIn ? Loader2 : LogIn}
                                                tone="blue"
                                            >
                                                Them dang nhap
                                            </PrimaryButton>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Auto-discover GA4 Properties */}
                            {googleLoginStatus.loggedIn && (
                                <>
                                    {/* Error display */}
                                    {apiError && (
                                        <AlertBanner type="error" title="Loi">
                                            {apiError}
                                            <PrimaryButton
                                                variant="quiet"
                                                onClick={() => loadPropertiesAndSites(analyticsGoogleEmail)}
                                                className="!ml-2 !px-2 !py-1 !text-xs"
                                                icon={RefreshCw}
                                            >
                                                Thu lai
                                            </PrimaryButton>
                                        </AlertBanner>
                                    )}
                                    {/* Refresh button */}
                                    {!loadingProperties && !apiError && ga4Properties.length === 0 && (
                                        <div className="flex items-center gap-2">
                                            <p className="text-xs text-[#908a9e]">Khong tim thay GA4 Properties</p>
                                            <PrimaryButton
                                                variant="quiet"
                                                onClick={() => loadPropertiesAndSites(analyticsGoogleEmail)}
                                                icon={RefreshCw}
                                                className="!px-2 !py-1 !text-xs"
                                            >
                                                Tai lai
                                            </PrimaryButton>
                                        </div>
                                    )}
                                    <div>
                                        <label className="text-sm font-medium text-[#17171f] mb-1.5 flex items-center gap-2">
                                            GA4 Property (Google Analytics 4)
                                            {loadingProperties && <Loader2 className="w-3 h-3 animate-spin text-[#8d74e8]" />}
                                        </label>
                                        <p className="text-xs text-[#8e899b] mb-2">
                                            Chon Website/Ung dung tuong ung voi MAP nay de theo doi luong **Truy cap (Traffic)** tu Google do ve.
                                        </p>
                                        {ga4Properties.length > 0 ? (
                                            <Select
                                                value={ga4PropertyId}
                                                onChange={(val) => setGa4PropertyId(val)}
                                                options={ga4Properties.map((prop) => ({
                                                    value: prop.id,
                                                    label: `${prop.displayName} (${prop.id})`,
                                                }))}
                                                placeholder="-- Chon GA4 Property --"
                                                className="w-full"
                                            />
                                        ) : (
                                            <TextInput
                                                value={ga4PropertyId}
                                                onChange={setGa4PropertyId}
                                                placeholder="vd: properties/123456789 (Nhap thu cong neu loi)"
                                                className="w-full font-mono"
                                            />
                                        )}
                                    </div>

                                    <div>
                                        <label className="text-sm font-medium text-[#17171f] mt-4 mb-1.5 flex items-center gap-2">
                                            Search Console Site
                                            {loadingProperties && <Loader2 className="w-3 h-3 animate-spin text-[#8d74e8]" />}
                                        </label>
                                        <p className="text-xs text-[#8e899b] mb-2">
                                            Chon ten mien SEO de theo doi so **Lan hien thi (Impressions), Luot click, va Tu khoa (Keywords)** cua MAP/Website tren Google.
                                        </p>
                                        {gscSites.length > 0 ? (
                                            <Select
                                                value={gscSiteUrl}
                                                onChange={(val) => setGscSiteUrl(val)}
                                                options={gscSites.map(s => ({
                                                    value: s.siteUrl,
                                                    label: s.siteUrl,
                                                }))}
                                                placeholder="-- Chon Search Console Site --"
                                                className="w-full"
                                            />
                                        ) : (
                                            <TextInput
                                                value={gscSiteUrl}
                                                onChange={setGscSiteUrl}
                                                placeholder="vd: https://example.com"
                                                className="w-full"
                                            />
                                        )}
                                    </div>
                                </>
                            )}

                            {/* Not logged in hint */}
                            {!googleLoginStatus.loggedIn && (
                                <p className="text-xs text-[#908a9e] text-center py-2">
                                    Dang nhap Google de tu dong tim GA4 Properties va Search Console Sites
                                </p>
                            )}
                        </div>
                    )}

                    <div className="mt-4 flex items-center justify-between">
                        <PrimaryButton
                            variant="quiet"
                            onClick={() => setShowConfig(false)}
                        >
                            Huy
                        </PrimaryButton>
                        <PrimaryButton
                            onClick={handleSaveConfig}
                            disabled={savingConfig}
                            icon={savingConfig ? Loader2 : CheckCircle}
                        >
                            Luu cai dat
                        </PrimaryButton>
                    </div>

                    <div className="mt-4">
                        <SetupGuide mode={mode} />
                    </div>
                </Panel>
            )}

            {/* Collection Result Toast */}
            {collectResult && (
                <AlertBanner
                    type={collectResult.success ? 'success' : 'error'}
                    title={collectResult.success ? `Thu thap thanh cong! (${collectResult.source})` : `Loi: ${collectResult.error}`}
                    onDismiss={() => setCollectResult(null)}
                />
            )}

            {/* No Location */}
            {locations.length === 0 && (
                <EmptyState
                    icon={MapPin}
                    title="Chua co location nao"
                    subtitle="Them location trong trang Locations truoc"
                />
            )}

            {/* Mode Not Set */}
            {selectedLocationId && mode === 'none' && (
                <EmptyState
                    icon={Activity}
                    title="Chua bat Analytics cho location nay"
                    subtitle={'Bam "Cai dat" -> Chon che do Scrape hoac API'}
                    action={
                        <PrimaryButton icon={Settings} onClick={() => setShowConfig(true)}>
                            Bat Analytics
                        </PrimaryButton>
                    }
                />
            )}

            {/* Loading */}
            {loading && (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-8 h-8 animate-spin text-[#8d74e8]" />
                </div>
            )}

            {/* Data Display */}
            {!loading && selectedLocationId && mode !== 'none' && (
                <div className="space-y-6">
                    {/* Maps / Scrape Metrics (always shown for both modes) */}
                    {(mapsData || mode === 'scrape') && (
                        <>
                            <SectionPanel icon={MapPin} title="Google Maps — Thong tin co ban" tone="emerald">
                                <StatRow className="grid-cols-2 sm:grid-cols-4">
                                    <StatCard
                                        icon={Star}
                                        label="Rating trung binh"
                                        value={mapsData?.avg_rating ? Number(mapsData.avg_rating).toFixed(1) : '--'}
                                        tone="amber"
                                    />
                                    <StatCard
                                        icon={Eye}
                                        label="Tong so reviews"
                                        value={mapsData?.review_count?.toLocaleString() || '--'}
                                        tone="blue"
                                    />
                                    <StatCard
                                        icon={Globe}
                                        label="Nguon du lieu"
                                        value={mode === 'api' ? 'API' : 'Scrape'}
                                        subtext={mapsData?.created_at ? `Cap nhat: ${new Date(mapsData.created_at * 1000).toLocaleDateString('vi-VN')}` : 'Chua co du lieu'}
                                        tone="violet"
                                    />
                                    <StatCard
                                        icon={Target}
                                        label="Analytics Mode"
                                        value={mode === 'api' ? 'API' : 'Scrape'}
                                        tone="emerald"
                                    />
                                </StatRow>
                            </SectionPanel>

                            {/* Maps Trend Chart */}
                            {mapsTrend.length > 1 && (
                                <Panel>
                                    <h3 className="text-xs font-medium text-[#6f697c] mb-2">Xu huong Reviews</h3>
                                    <MiniChart data={mapsTrend} color="#3b82f6" height={60} />
                                </Panel>
                            )}
                        </>
                    )}

                    {/* GBP Scrape Metrics */}
                    {gbpData && (
                        <SectionPanel icon={Zap} title="Google Business Profile — Tuong tac" tone="amber">
                            <StatRow className="grid-cols-2 sm:grid-cols-4">
                                <StatCard icon={Activity} label="Tuong tac" value={gbpData.gbp_interactions?.toLocaleString() || '0'} tone="violet" />
                                <StatCard icon={Phone} label="Cuoc goi" value={gbpData.gbp_calls?.toLocaleString() || '0'} tone="emerald" />
                                <StatCard icon={Navigation} label="Chi duong" value={gbpData.gbp_directions?.toLocaleString() || '0'} tone="cyan" />
                                <StatCard icon={Globe} label="Click website" value={gbpData.gbp_website_clicks?.toLocaleString() || '0'} tone="blue" />
                            </StatRow>
                        </SectionPanel>
                    )}

                    {/* GA4 Data */}
                    {ga4Data && (
                        <SectionPanel icon={BarChart3} title="Google Analytics (GA4) — Traffic" tone="blue">
                            <StatRow>
                                <StatCard icon={Eye} label="Sessions" value={ga4Data.sessions?.toLocaleString() || '0'} tone="blue" />
                                <StatCard icon={Activity} label="Users" value={ga4Data.users?.toLocaleString() || '0'} tone="violet" />
                                <StatCard icon={MousePointerClick} label="Pageviews" value={ga4Data.pageviews?.toLocaleString() || '0'} tone="cyan" />
                                <StatCard icon={TrendingDown} label="Bounce Rate" value={ga4Data.bounce_rate ? `${(ga4Data.bounce_rate * 100).toFixed(1)}%` : '--'} tone="rose" />
                                <StatCard icon={Activity} label="Avg Duration" value={ga4Data.avg_session_duration ? `${Math.round(ga4Data.avg_session_duration)}s` : '--'} tone="emerald" />
                            </StatRow>
                            {ga4Trend.length > 1 && (
                                <Panel className="mt-3">
                                    <h3 className="text-xs font-medium text-[#6f697c] mb-2">Sessions Trend</h3>
                                    <MiniChart data={ga4Trend} color="#8d74e8" height={60} />
                                </Panel>
                            )}
                        </SectionPanel>
                    )}

                    {/* GSC Data */}
                    {gscData && (
                        <SectionPanel icon={Search} title="Google Search Console — Tim kiem" tone="emerald">
                            <StatRow className="grid-cols-2 sm:grid-cols-4">
                                <StatCard icon={Eye} label="Impressions" value={gscData.impressions?.toLocaleString() || '0'} tone="emerald" />
                                <StatCard icon={MousePointerClick} label="Clicks" value={gscData.clicks?.toLocaleString() || '0'} tone="blue" />
                                <StatCard icon={Target} label="CTR" value={gscData.ctr ? `${(gscData.ctr * 100).toFixed(2)}%` : '--'} tone="amber" />
                                <StatCard icon={ArrowUpRight} label="Avg Position" value={gscData.avg_position ? gscData.avg_position.toFixed(1) : '--'} tone="violet" />
                            </StatRow>

                            {gscTrend.length > 1 && (
                                <Panel className="mt-3">
                                    <h3 className="text-xs font-medium text-[#6f697c] mb-2">Clicks Trend</h3>
                                    <MiniChart data={gscTrend} color="#10b981" height={60} />
                                </Panel>
                            )}

                            {/* Top Queries */}
                            {topQueries.length > 0 && (
                                <div className="mt-3">
                                    <DataTable
                                        columns={[
                                            { key: 'query', header: 'Query', render: (row: any) => <span className="font-medium text-[#17171f]">{row.query}</span> },
                                            { key: 'impressions', header: 'Impressions', align: 'right' as const, render: (row: any) => row.impressions?.toLocaleString() },
                                            { key: 'clicks', header: 'Clicks', align: 'right' as const, render: (row: any) => row.clicks?.toLocaleString() },
                                            { key: 'ctr', header: 'CTR', align: 'right' as const, render: (row: any) => <span className="text-[#735bd6]">{(row.ctr * 100).toFixed(2)}%</span> },
                                            { key: 'position', header: 'Position', align: 'right' as const, render: (row: any) => <span className="text-amber-600">{row.position?.toFixed(1)}</span> },
                                        ]}
                                        data={topQueries.map((q: any, i: number) => ({ id: i, ...q }))}
                                    />
                                </div>
                            )}
                        </SectionPanel>
                    )}

                    {/* No Data Message */}
                    {!ga4Data && !gscData && !mapsData && !gbpData && !loading && (
                        <EmptyState
                            icon={BarChart3}
                            title="Chua co du lieu"
                            subtitle={'Bam "Thu thap du lieu" de bat dau'}
                        />
                    )}
                </div>
            )}
        </PageShell>
    )
}
