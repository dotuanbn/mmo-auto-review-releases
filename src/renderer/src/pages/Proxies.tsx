import { useEffect, useState } from 'react'
import { useProxyStore } from '../stores'
import {
    Plus,
    Upload,
    Trash2,
    RefreshCw,
    Wifi,
    Zap,
    Globe,
    XCircle
} from 'lucide-react'
import { useI18n } from '../i18n'
import {
    PageHeader,
    PageShell,
    StatCard,
    StatRow,
    Toolbar,
    PrimaryButton,
    IconButton,
    DataTable,
    StatusPill,
    Modal,
    TextInput,
    Select,
    AlertBanner,
    Badge,
} from '../components/ui/surface'
import type { Tone } from '../components/ui/surface'

export function Proxies() {
    const { t } = useI18n()
    const { proxies, stats, loading, error, fetchProxies, fetchStats, addProxy, deleteProxy, checkProxy, checkAllProxies, importFromText, deleteDeadProxies } = useProxyStore()
    const [selectedIds, setSelectedIds] = useState<Set<number | string>>(new Set())
    const [showAddModal, setShowAddModal] = useState(false)
    const [showImportModal, setShowImportModal] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [newProxy, setNewProxy] = useState({ host: '', port: '', username: '', password: '', type: 'http' as const, provider: '' as string })
    const [importText, setImportText] = useState('')
    const [importDefaultProvider, setImportDefaultProvider] = useState('' as string)

    useEffect(() => {
        fetchProxies()
        fetchStats()
    }, [])

    const filteredProxies = proxies.filter(proxy =>
        proxy.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (proxy.country && proxy.country.toLowerCase().includes(searchQuery.toLowerCase()))
    )

    const handleAddProxy = async () => {
        if (!newProxy.host || !newProxy.port) return
        await addProxy({
            host: newProxy.host,
            port: parseInt(newProxy.port),
            username: newProxy.username || undefined,
            password: newProxy.password || undefined,
            type: newProxy.type,
            provider: newProxy.provider || undefined,
        })
        setNewProxy({ host: '', port: '', username: '', password: '', type: 'http', provider: '' })
        setShowAddModal(false)
    }

    const handleImport = async () => {
        if (!importText.trim()) return
        const providerToUse = importDefaultProvider || undefined
        const count = await importFromText(importText, providerToUse)
        alert(t('proxies.importSuccess').replace('{count}', String(count)))
        setImportText('')
        setImportDefaultProvider('')
        setShowImportModal(false)
    }

    const handleDeleteSelected = async () => {
        const ids = Array.from(selectedIds) as number[]
        if (!confirm(t('proxies.deleteConfirm').replace('{count}', String(ids.length)))) return
        for (const id of ids) {
            await deleteProxy(id)
        }
        setSelectedIds(new Set())
    }

    const statusToneMap: Record<string, Tone> = {
        active: 'emerald',
        dead: 'rose',
        checking: 'amber',
    }

    const columns = [
        {
            key: 'hostPort',
            header: t('proxies.hostPort'),
            render: (proxy: any) => (
                <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-[#908a9e]" />
                    <span className="font-mono text-sm font-medium text-[#17171f]">{proxy.host}:{proxy.port}</span>
                </div>
            ),
        },
        {
            key: 'type',
            header: t('proxies.type'),
            render: (proxy: any) => <Badge tone="slate">{proxy.type.toUpperCase()}</Badge>,
        },
        {
            key: 'provider',
            header: 'Provider',
            render: (proxy: any) => (
                proxy.provider
                    ? <Badge tone="violet">{proxy.provider}</Badge>
                    : <span className="text-sm text-[#908a9e]">-</span>
            ),
        },
        {
            key: 'country',
            header: t('proxies.country'),
            render: (proxy: any) => <span className="text-[#5f5a6d]">{proxy.country || '-'}</span>,
        },
        {
            key: 'status',
            header: t('common.status'),
            render: (proxy: any) => (
                <StatusPill tone={statusToneMap[proxy.status] || 'rose'}>{proxy.status}</StatusPill>
            ),
        },
        {
            key: 'responseTime',
            header: t('proxies.response'),
            render: (proxy: any) => (
                <span className="text-sm text-[#908a9e]">{proxy.responseTime ? `${proxy.responseTime}ms` : '-'}</span>
            ),
        },
        {
            key: 'actions',
            header: t('common.actions'),
            width: '100px',
            align: 'center' as const,
            render: (proxy: any) => (
                <div className="flex items-center justify-center gap-1">
                    <IconButton icon={Zap} label={t('proxies.checkProxy')} onClick={() => checkProxy(proxy.id)} />
                    <IconButton icon={Trash2} label={t('common.delete')} onClick={() => deleteProxy(proxy.id)} />
                </div>
            ),
        },
    ]

    return (
        <PageShell>
            <PageHeader
                icon={Globe}
                tone="violet"
                title={t('proxies.title')}
                subtitle={t('proxies.subtitle')}
            >
                <PrimaryButton icon={Upload} variant="quiet" onClick={() => setShowImportModal(true)}>
                    {t('common.import')}
                </PrimaryButton>
                <PrimaryButton icon={Plus} onClick={() => setShowAddModal(true)}>
                    {t('proxies.addProxy')}
                </PrimaryButton>
            </PageHeader>

            {/* Stats */}
            <StatRow>
                <StatCard icon={Globe} tone="slate" value={stats.total} label={t('proxies.totalProxies')} />
                <StatCard icon={Wifi} tone="emerald" value={stats.active} label={t('common.active')} />
                <StatCard icon={XCircle} tone="rose" value={stats.dead} label={t('proxies.dead')} />
            </StatRow>

            {/* Toolbar */}
            <Toolbar
                search={searchQuery}
                onSearchChange={setSearchQuery}
                searchPlaceholder={t('proxies.searchPlaceholder')}
            >
                {selectedIds.size > 0 && (
                    <PrimaryButton icon={Trash2} tone="rose" onClick={handleDeleteSelected}>
                        {t('common.delete')} ({selectedIds.size})
                    </PrimaryButton>
                )}
                <PrimaryButton icon={Zap} tone="emerald" variant="quiet" onClick={() => checkAllProxies()}>
                    {t('proxies.checkAll')}
                </PrimaryButton>
                <PrimaryButton icon={Trash2} tone="amber" variant="quiet" onClick={() => deleteDeadProxies()}>
                    {t('proxies.deleteDead')}
                </PrimaryButton>
                <IconButton icon={RefreshCw} label={t('common.refresh') || 'Refresh'} onClick={() => fetchProxies()}
                    className={loading ? '[&_svg]:animate-spin' : ''} />
            </Toolbar>

            {/* Error */}
            {error && <AlertBanner type="error" title={error} />}

            {/* Table */}
            <DataTable
                columns={columns}
                data={filteredProxies}
                selectable
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                emptyIcon={Globe}
                emptyTitle={loading && proxies.length === 0 ? t('proxies.loadingProxies') : t('proxies.noProxiesFound')}
                stickyHeader
            />

            {/* Add Proxy Modal */}
            <Modal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                title={t('proxies.addProxy')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowAddModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton onClick={handleAddProxy} disabled={!newProxy.host || !newProxy.port}>
                            {t('proxies.addProxy')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('proxies.host')}</label>
                            <TextInput value={newProxy.host} onChange={(v) => setNewProxy({ ...newProxy, host: v })} placeholder="192.168.1.1" />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('proxies.port')}</label>
                            <TextInput value={newProxy.port} onChange={(v) => setNewProxy({ ...newProxy, port: v })} placeholder="8080" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('proxies.username')} ({t('common.optional')})</label>
                            <TextInput value={newProxy.username} onChange={(v) => setNewProxy({ ...newProxy, username: v })} />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('common.password')} ({t('common.optional')})</label>
                            <TextInput value={newProxy.password} onChange={(v) => setNewProxy({ ...newProxy, password: v })} type="password" />
                        </div>
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('proxies.type')}</label>
                        <Select
                            value={newProxy.type}
                            onChange={(v) => setNewProxy({ ...newProxy, type: v as any })}
                            options={[
                                { value: 'http', label: 'HTTP' },
                                { value: 'https', label: 'HTTPS' },
                                { value: 'socks5', label: 'SOCKS5' },
                            ]}
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">Provider ({t('common.optional')})</label>
                        <Select
                            value={newProxy.provider || ''}
                            onChange={(v) => setNewProxy({ ...newProxy, provider: v })}
                            options={[
                                { value: '', label: '-- Manual / Other --' },
                                { value: 'dataimpulse', label: 'DataImpulse' },
                                { value: 'fproxy', label: 'FProxy.me' },
                                { value: 'smartproxy', label: 'Smartproxy' },
                                { value: 'oxylabs', label: 'Oxylabs' },
                                { value: 'iproyal', label: 'IPRoyal' },
                                { value: 'custom', label: 'Custom' },
                            ]}
                        />
                        <p className="mt-1 text-[11px] text-[#908a9e]">Chon provider giup de quan ly sau nay (DataImpulse, Smartproxy...)</p>
                    </div>
                </div>
            </Modal>

            {/* Import Modal */}
            <Modal
                open={showImportModal}
                onClose={() => setShowImportModal(false)}
                title={t('proxies.importProxies')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowImportModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton onClick={handleImport} disabled={!importText.trim()}>
                            {t('proxies.importProxies')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <p className="text-sm text-[#908a9e]">
                        {t('proxies.importFormat')} <code className="rounded bg-[#f4f1fa] px-1.5 py-0.5 text-xs font-medium text-[#735bd6]">{t('proxies.importFormatCode1')}</code> {t('proxies.importFormatOr')} <code className="rounded bg-[#f4f1fa] px-1.5 py-0.5 text-xs font-medium text-[#735bd6]">{t('proxies.importFormatCode2')}</code> {t('proxies.importFormatSuffix')}
                    </p>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">Default Provider ({t('common.optional')})</label>
                        <Select
                            value={importDefaultProvider}
                            onChange={(v) => setImportDefaultProvider(v)}
                            options={[
                                { value: '', label: '-- Khong dat (tu nhan dien) --' },
                                { value: 'dataimpulse', label: 'DataImpulse (khuyen nghi cho sticky session)' },
                                { value: 'fproxy', label: 'FProxy.me' },
                                { value: 'smartproxy', label: 'Smartproxy' },
                                { value: 'oxylabs', label: 'Oxylabs' },
                                { value: 'custom', label: 'Custom' },
                            ]}
                        />
                    </div>

                    {importDefaultProvider === 'dataimpulse' && (
                        <AlertBanner type="info" title="DataImpulse Tip">
                            Nen dung <strong>sticky session</strong> (username co <code className="rounded bg-[#f4f1fa] px-1 text-xs">session-XXXX</code>).
                            Vi du: <code className="rounded bg-[#f4f1fa] px-1 text-xs">gw.dataimpulse.com:823:youruser-session-12345678:pass</code>
                        </AlertBanner>
                    )}

                    <textarea
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        className="h-48 w-full rounded-[16px] border border-[#e9e4f2] bg-white px-4 py-3 font-mono text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        placeholder={"192.168.1.1:8080\n192.168.1.2:8080:user:pass\ndataimpulse.gw:823:user-session-abc123:pass"}
                    />
                </div>
            </Modal>
        </PageShell>
    )
}
