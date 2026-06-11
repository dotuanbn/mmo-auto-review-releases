import { useEffect, useState, useCallback } from 'react'
import {
    Activity,
    Database,
    Terminal,
    RefreshCw,
    CheckCircle,
    Clock,
    Cpu,
    Zap,
    Search,
    Play,
    Square,
    Trash2,
    BarChart3,
    Gauge,
    Brain,
    Table,
    ArrowUpDown,
    XCircle,
    type LucideIcon
} from 'lucide-react'
import {
    PageHeader,
    PageShell,
    SegmentedTabs,
    Panel,
    SectionPanel,
    StatCard,
    StatRow,
    EmptyState,
    PrimaryButton,
    IconButton,
    AlertBanner,
    ProgressBar,
    Badge,
    Toolbar,
    DataTable,
    TextInput,
    Select,
    CardGrid,
    StatusPill,
} from '../components/ui/surface'

// ============================================================
// Types
// ============================================================

interface MetricsSummary {
    totalCalls: number
    successRate: number
    avgDurationMs: number
    p95DurationMs: number
    peakMemoryMB: number
    byTask: Record<string, {
        calls: number
        avgDurationMs: number
        successRate: number
    }>
}

interface MetricAlert {
    level: 'info' | 'warn' | 'error'
    title: string
    message: string
    timestamp: Date | string | number
}

interface HistoryEntry {
    id: number
    task: string
    modelId: string
    operation: string
    durationMs: number
    success: boolean
    memoryMB: number | null
    errorMessage: string | null
    createdAt: Date | string | number
}

interface ToolInfo {
    name: string
    ext: string
    fullPath: string
}

interface ToolResult {
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
}

type TabId = 'metrics' | 'datasets' | 'tools'

function formatMetricTime(value: Date | string | number): string {
    const date = value instanceof Date
        ? value
        : typeof value === 'number'
            ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
            : new Date(value)

    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString()
}

// ============================================================
// Main Component
// ============================================================

export function AIHub() {
    const [activeTab, setActiveTab] = useState<TabId>('metrics')

    const tabs: { id: TabId; label: string; icon: LucideIcon }[] = [
        { id: 'metrics', label: 'AI Metrics', icon: Activity },
        { id: 'datasets', label: 'Dataset Browser', icon: Database },
        { id: 'tools', label: 'Tool Runner', icon: Terminal },
    ]

    return (
        <PageShell>
            <PageHeader
                icon={Brain}
                tone="violet"
                title="AI Hub"
                subtitle="Monitor AI performance, browse datasets, and run automation tools"
            />

            <SegmentedTabs<TabId>
                value={activeTab}
                onChange={setActiveTab}
                items={tabs.map(tab => ({ id: tab.id, label: tab.label, icon: tab.icon }))}
            />

            {/* Tab Content */}
            {activeTab === 'metrics' && <MetricsPanel />}
            {activeTab === 'datasets' && <DatasetPanel />}
            {activeTab === 'tools' && <ToolsPanel />}
        </PageShell>
    )
}

// ============================================================
// Tab 1: Metrics Dashboard
// ============================================================

function MetricsPanel() {
    const [metrics, setMetrics] = useState<MetricsSummary | null>(null)
    const [alerts, setAlerts] = useState<MetricAlert[]>([])
    const [history, setHistory] = useState<HistoryEntry[]>([])
    const [timeRange, setTimeRange] = useState<'hour' | 'day' | 'week'>('day')
    const [loading, setLoading] = useState(true)

    const loadData = useCallback(async () => {
        try {
            setLoading(true)
            const [m, a, h] = await Promise.all([
                window.electronAPI.trackio.getMetrics(timeRange),
                window.electronAPI.trackio.getAlerts(),
                window.electronAPI.trackio.getHistory(30),
            ])
            setMetrics(m)
            setAlerts(a)
            setHistory(h)
        } catch (err) {
            console.error('Failed to load metrics:', err)
        } finally {
            setLoading(false)
        }
    }, [timeRange])

    useEffect(() => {
        loadData()
    }, [loadData])

    const handleCleanup = async () => {
        if (!confirm('Xoa du lieu metrics cu hon 30 ngay?')) return
        try {
            const result = await window.electronAPI.trackio.cleanup(30)
            alert(`Da xoa ${result.deleted} records`)
            loadData()
        } catch (err) {
            console.error('Cleanup failed:', err)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <RefreshCw className="w-6 h-6 text-[#8d74e8] animate-spin" />
                <span className="text-[#8e899b] ml-3">Dang tai metrics...</span>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Alerts Banner */}
            {alerts.length > 0 && (
                <div className="space-y-2">
                    {alerts.map((alert, i) => (
                        <AlertBanner
                            key={i}
                            type={alert.level === 'error' ? 'error' : 'warning'}
                            title={alert.title}
                        >
                            {alert.message}
                        </AlertBanner>
                    ))}
                </div>
            )}

            {/* Controls */}
            <div className="flex items-center justify-between">
                <SegmentedTabs
                    value={timeRange}
                    onChange={setTimeRange}
                    items={[
                        { id: 'hour' as const, label: '1 gio' },
                        { id: 'day' as const, label: '24 gio' },
                        { id: 'week' as const, label: '7 ngay' },
                    ]}
                />
                <div className="flex gap-2">
                    <IconButton icon={RefreshCw} label="Refresh" onClick={loadData} />
                    <IconButton icon={Trash2} label="Cleanup" onClick={handleCleanup} />
                </div>
            </div>

            {/* Summary Cards */}
            {metrics && (
                <StatRow>
                    <StatCard
                        icon={Zap}
                        label="Total Calls"
                        value={metrics.totalCalls.toString()}
                        tone="blue"
                    />
                    <StatCard
                        icon={CheckCircle}
                        label="Success Rate"
                        value={`${metrics.successRate.toFixed(1)}%`}
                        tone={metrics.successRate >= 90 ? 'emerald' : 'amber'}
                    />
                    <StatCard
                        icon={Clock}
                        label="Avg Latency"
                        value={`${metrics.avgDurationMs.toFixed(0)}ms`}
                        tone="violet"
                    />
                    <StatCard
                        icon={Gauge}
                        label="P95 Latency"
                        value={`${metrics.p95DurationMs.toFixed(0)}ms`}
                        tone="cyan"
                    />
                    <StatCard
                        icon={Cpu}
                        label="Peak Memory"
                        value={`${metrics.peakMemoryMB}MB`}
                        tone="amber"
                    />
                </StatRow>
            )}

            {/* Task Breakdown + History */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Task Breakdown */}
                <SectionPanel icon={BarChart3} title="Performance theo Task" tone="emerald">
                    {metrics && Object.keys(metrics.byTask).length > 0 ? (
                        <div className="space-y-3">
                            {Object.entries(metrics.byTask).map(([task, data]) => (
                                <div key={task} className="rounded-[16px] border border-[#ece7f5] bg-white p-3">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[#17171f] text-sm font-medium">{task}</span>
                                        <span className="text-[#8e899b] text-xs">{data.calls} calls</span>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs">
                                        <span className={data.successRate >= 90 ? 'text-emerald-600' : 'text-amber-600'}>
                                            {data.successRate.toFixed(0)}% success
                                        </span>
                                        <span className="text-[#e9e4f2]">|</span>
                                        <span className="text-[#735bd6]">{data.avgDurationMs.toFixed(0)}ms avg</span>
                                    </div>
                                    <ProgressBar value={data.successRate} tone="emerald" size="sm" className="mt-2" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <EmptyState
                            icon={Activity}
                            title="Chua co du lieu inference"
                        />
                    )}
                </SectionPanel>

                {/* Recent History */}
                <SectionPanel icon={Clock} title="Lich su gan day" tone="blue">
                    {history.length > 0 ? (
                        <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
                            {history.map(h => (
                                <div key={h.id} className="flex items-center gap-3 p-2.5 rounded-[14px] border border-[#ece7f5] bg-white">
                                    {h.success ? (
                                        <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                                    ) : (
                                        <XCircle className="w-4 h-4 text-rose-500 shrink-0" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[#17171f] text-xs font-medium">{h.task}</span>
                                            <span className="text-[#908a9e] text-[10px]">{h.modelId}</span>
                                        </div>
                                        <div className="flex items-center gap-3 mt-0.5">
                                            <span className="text-[#735bd6] text-[10px]">{h.durationMs}ms</span>
                                            {h.memoryMB && (
                                                <span className="text-cyan-600 text-[10px]">{h.memoryMB}MB</span>
                                            )}
                                            {h.errorMessage && (
                                                <span className="text-rose-500 text-[10px] truncate max-w-[150px]">{h.errorMessage}</span>
                                            )}
                                        </div>
                                    </div>
                                    <span className="text-[#908a9e] text-[10px] shrink-0">
                                        {formatMetricTime(h.createdAt)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <EmptyState
                            icon={Clock}
                            title="Chua co lich su inference"
                        />
                    )}
                </SectionPanel>
            </div>
        </div>
    )
}

// ============================================================
// Tab 2: Dataset Browser
// ============================================================

function DatasetPanel() {
    const [datasetId, setDatasetId] = useState('')
    const [configs, setConfigs] = useState<any[]>([])
    const [selectedConfig, setSelectedConfig] = useState('')
    const [selectedSplit, setSelectedSplit] = useState('')
    const [rows, setRows] = useState<any[]>([])
    const [columns, setColumns] = useState<string[]>([])
    const [searchQuery, setSearchQuery] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [datasetSize, setDatasetSize] = useState<any>(null)
    const [offset, setOffset] = useState(0)
    const pageSize = 20

    const loadDataset = async () => {
        if (!datasetId.trim()) return
        setLoading(true)
        setError('')
        setRows([])
        setColumns([])
        setConfigs([])
        setDatasetSize(null)

        try {
            const [splits, size] = await Promise.all([
                window.electronAPI.datasets.listSplits(datasetId.trim()),
                window.electronAPI.datasets.getSize(datasetId.trim()),
            ])

            if (!splits || splits.length === 0) {
                setError('Dataset khong tim thay hoac khong co du lieu')
                return
            }

            setConfigs(splits)
            setDatasetSize(size)

            // Auto-select first config/split
            const firstConfig = splits[0]?.config || 'default'
            const firstSplit = splits[0]?.split || 'train'
            setSelectedConfig(firstConfig)
            setSelectedSplit(firstSplit)
            setOffset(0)

            await loadRows(datasetId.trim(), firstConfig, firstSplit, 0)
        } catch (err: any) {
            setError(err?.message || 'Khong the tai dataset')
        } finally {
            setLoading(false)
        }
    }

    const loadRows = async (id: string, config: string, split: string, off: number) => {
        setLoading(true)
        try {
            const result = await window.electronAPI.datasets.getRows(id, config, split, off, pageSize)
            if (result?.rows && result.rows.length > 0) {
                setRows(result.rows)
                setColumns(result.features ? result.features.map((f: any) => f.name || f) : Object.keys(result.rows[0]))
            } else {
                setRows([])
                setColumns([])
            }
        } catch (err: any) {
            setError(err?.message || 'Loi tai rows')
        } finally {
            setLoading(false)
        }
    }

    const handleSearch = async () => {
        if (!datasetId || !searchQuery.trim()) return
        setLoading(true)
        try {
            const result = await window.electronAPI.datasets.search(
                datasetId, selectedConfig, selectedSplit, searchQuery.trim(), 0, pageSize
            )
            if (result?.rows) {
                setRows(result.rows)
                setColumns(result.features ? result.features.map((f: any) => f.name || f) : Object.keys(result.rows[0] || {}))
            }
        } catch (err: any) {
            setError(err?.message || 'Loi tim kiem')
        } finally {
            setLoading(false)
        }
    }

    const handlePageChange = (direction: 'next' | 'prev') => {
        const newOffset = direction === 'next' ? offset + pageSize : Math.max(0, offset - pageSize)
        setOffset(newOffset)
        loadRows(datasetId, selectedConfig, selectedSplit, newOffset)
    }

    // Common sample datasets for quick access
    const sampleDatasets = [
        { id: 'squad', label: 'SQuAD (QA)' },
        { id: 'imdb', label: 'IMDB Reviews' },
        { id: 'ag_news', label: 'AG News' },
        { id: 'wikitext', label: 'WikiText' },
    ]

    return (
        <div className="space-y-6">
            {/* Search bar */}
            <Panel>
                <div className="flex gap-3">
                    <TextInput
                        value={datasetId}
                        onChange={setDatasetId}
                        onKeyDown={e => e.key === 'Enter' && loadDataset()}
                        placeholder="Nhap dataset ID (vd: squad, imdb, ag_news...)"
                        icon={Database}
                        className="flex-1"
                    />
                    <PrimaryButton
                        onClick={loadDataset}
                        disabled={loading || !datasetId.trim()}
                        icon={loading ? RefreshCw : Search}
                    >
                        Tai
                    </PrimaryButton>
                </div>

                {/* Quick access */}
                <div className="flex items-center gap-2 mt-3">
                    <span className="text-[#908a9e] text-xs">Goi y:</span>
                    {sampleDatasets.map(d => (
                        <PrimaryButton
                            key={d.id}
                            variant="quiet"
                            onClick={() => { setDatasetId(d.id); }}
                            className="!px-2.5 !py-1 !text-xs"
                        >
                            {d.label}
                        </PrimaryButton>
                    ))}
                </div>
            </Panel>

            {/* Error */}
            {error && (
                <AlertBanner type="error" title="Loi">
                    {error}
                </AlertBanner>
            )}

            {/* Dataset Info */}
            {datasetSize && (
                <div className="flex items-center gap-4 text-sm">
                    <span className="text-[#5f5a6d]">
                        Config: <Badge tone="violet">{selectedConfig}</Badge>
                    </span>
                    <span className="text-[#5f5a6d]">
                        Split: <Badge tone="violet">{selectedSplit}</Badge>
                    </span>
                    {configs.length > 1 && (
                        <Select
                            value={`${selectedConfig}|${selectedSplit}` as string}
                            onChange={(val) => {
                                const [c, s] = val.split('|')
                                setSelectedConfig(c)
                                setSelectedSplit(s)
                                setOffset(0)
                                loadRows(datasetId, c, s, 0)
                            }}
                            options={configs.map((cfg: any, _i: number) => ({
                                value: `${cfg.config}|${cfg.split}`,
                                label: `${cfg.config} / ${cfg.split}`,
                            }))}
                            className="w-48"
                        />
                    )}
                </div>
            )}

            {/* Search within dataset */}
            {rows.length > 0 && (
                <Toolbar
                    search={searchQuery}
                    onSearchChange={setSearchQuery}
                    searchPlaceholder="Tim kiem trong dataset..."
                >
                    <IconButton
                        icon={Search}
                        label="Search"
                        onClick={handleSearch}
                    />
                </Toolbar>
            )}

            {/* Data Table */}
            {rows.length > 0 && (
                <>
                    <DataTable
                        columns={[
                            {
                                key: '_index',
                                header: '#',
                                width: '60px',
                                render: (_row: any, idx: number) => (
                                    <span className="text-[#908a9e] text-xs">{offset + idx + 1}</span>
                                ),
                            },
                            ...columns.slice(0, 6).map(col => ({
                                key: col,
                                header: (
                                    <span className="flex items-center gap-1">
                                        {col}
                                        <ArrowUpDown className="w-3 h-3 opacity-50" />
                                    </span>
                                ),
                                render: (row: any) => (
                                    <span className="text-xs max-w-[300px] truncate block">
                                        {typeof row[col] === 'object'
                                            ? JSON.stringify(row[col]).slice(0, 100)
                                            : String(row[col] ?? '').slice(0, 200)}
                                    </span>
                                ),
                            })),
                        ]}
                        data={rows.map((row, idx) => ({ id: idx, ...row }))}
                    />

                    {/* Pagination */}
                    <div className="flex items-center justify-between">
                        <span className="text-[#908a9e] text-xs">
                            Rows {offset + 1} - {offset + rows.length}
                        </span>
                        <div className="flex gap-2">
                            <PrimaryButton
                                onClick={() => handlePageChange('prev')}
                                disabled={offset === 0}
                                variant="quiet"
                            >
                                Truoc
                            </PrimaryButton>
                            <PrimaryButton
                                onClick={() => handlePageChange('next')}
                                disabled={rows.length < pageSize}
                                variant="quiet"
                            >
                                Sau
                            </PrimaryButton>
                        </div>
                    </div>
                </>
            )}

            {/* Empty state */}
            {!loading && rows.length === 0 && !error && !datasetSize && (
                <EmptyState
                    icon={Table}
                    title="Nhap Dataset ID de bat dau"
                    subtitle="Browse public datasets tu HuggingFace Hub"
                />
            )}
        </div>
    )
}

// ============================================================
// Tab 3: Tools Panel
// ============================================================

function ToolsPanel() {
    const [tools, setTools] = useState<ToolInfo[]>([])
    const [runningTool, setRunningTool] = useState<string | null>(null)
    const [result, setResult] = useState<ToolResult | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        loadTools()
    }, [])

    const loadTools = async () => {
        try {
            setLoading(true)
            const list = await window.electronAPI.toolBuilder.list()
            setTools(list || [])
        } catch (err) {
            console.error('Failed to load tools:', err)
        } finally {
            setLoading(false)
        }
    }

    const runTool = async (toolName: string) => {
        setRunningTool(toolName)
        setResult(null)
        try {
            const res = await window.electronAPI.toolBuilder.run(toolName)
            setResult(res)
        } catch (err: any) {
            setResult({
                exitCode: -1,
                stdout: '',
                stderr: err?.message || 'Unknown error',
                durationMs: 0,
            })
        } finally {
            setRunningTool(null)
        }
    }

    const stopTool = async () => {
        try {
            await window.electronAPI.toolBuilder.stop()
            setRunningTool(null)
        } catch (err) {
            console.error('Failed to stop:', err)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <RefreshCw className="w-6 h-6 text-[#8d74e8] animate-spin" />
                <span className="text-[#8e899b] ml-3">Dang tai tools...</span>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Tools grid */}
            {tools.length > 0 ? (
                <CardGrid cols={3}>
                    {tools.map(tool => (
                        <Panel key={tool.name} className="group transition-colors">
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-600 shadow-[0_12px_22px_rgba(40,36,54,0.12)]">
                                        <Terminal className="w-5 h-5" />
                                    </div>
                                    <div>
                                        <h4 className="text-[#17171f] font-medium text-sm">{tool.name}</h4>
                                        <Badge tone="slate">.{tool.ext}</Badge>
                                    </div>
                                </div>
                                <IconButton
                                    icon={runningTool === tool.name ? Square : Play}
                                    label={runningTool === tool.name ? 'Stop' : 'Run'}
                                    onClick={() => runningTool === tool.name ? stopTool() : runTool(tool.name)}
                                    disabled={runningTool !== null && runningTool !== tool.name}
                                    variant={runningTool === tool.name ? 'accent' : 'quiet'}
                                />
                            </div>
                            <div className="mt-3 text-[10px] text-[#908a9e] truncate">
                                {tool.fullPath}
                            </div>
                            {runningTool === tool.name && (
                                <StatusPill tone="amber">Dang chay...</StatusPill>
                            )}
                        </Panel>
                    ))}
                </CardGrid>
            ) : (
                <EmptyState
                    icon={Terminal}
                    title="Chua co tools"
                    subtitle={<>Them scripts vao <code className="rounded bg-[#f4f1fa] px-1.5 py-0.5 text-[#735bd6]">scripts/tools/</code></>}
                />
            )}

            {/* Execution Result */}
            {result && (
                <SectionPanel icon={Terminal} title="Ket qua thuc thi" tone="amber">
                    <div className="flex items-center justify-end gap-3 text-xs mb-3">
                        <span className={`flex items-center gap-1 ${result.exitCode === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {result.exitCode === 0 ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                            Exit: {result.exitCode}
                        </span>
                        <span className="text-[#908a9e]">{result.durationMs}ms</span>
                    </div>
                    {result.stdout && (
                        <pre className="text-emerald-700 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-y-auto bg-emerald-50 border border-emerald-100 p-3 rounded-[14px]">
                            {result.stdout}
                        </pre>
                    )}
                    {result.stderr && (
                        <pre className="text-rose-700 text-xs font-mono whitespace-pre-wrap max-h-40 overflow-y-auto bg-rose-50 border border-rose-100 p-3 rounded-[14px] mt-2">
                            {result.stderr}
                        </pre>
                    )}
                </SectionPanel>
            )}
        </div>
    )
}
