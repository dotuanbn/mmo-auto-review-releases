import { useEffect, useState, useRef } from 'react'
import { useAccountStore, useProxyStore } from '../stores'
import {
    UserPlus,
    Upload,
    Trash2,
    RefreshCw,
    MoreVertical,
    Edit,
    LogIn,
    Eye,
    CheckCircle,
    XCircle,
    Loader2,
    ShieldCheck,
    Plus,
    Wifi,
    Zap,
    Users,
    Globe,
    Clock
} from 'lucide-react'
import { useI18n } from '../i18n'
import {
    PageHeader,
    PageShell,
    SegmentedTabs,
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
    Divider,
    Badge,
} from '../components/ui/surface'
import type { Tone } from '../components/ui/surface'

type Tab = 'accounts' | 'proxies'
type LoginStatus = 'idle' | 'logging_in' | 'success' | 'failed'

export function Accounts() {
    const { t } = useI18n()
    const [activeTab, setActiveTab] = useState<Tab>('accounts')

    return (
        <PageShell>
            <PageHeader
                icon={Users}
                tone="violet"
                title="Tai khoan & Proxy"
                subtitle="Quan ly tai khoan Google va proxy cho chien dich"
            />

            <SegmentedTabs<Tab>
                value={activeTab}
                onChange={setActiveTab}
                items={[
                    { id: 'accounts', label: t('accounts.title'), icon: Users },
                    { id: 'proxies', label: t('proxies.title'), icon: Globe },
                ]}
            />

            {activeTab === 'accounts' ? <AccountsTab /> : <ProxiesTab />}
        </PageShell>
    )
}

// =============================================================================
// ACCOUNTS TAB
// =============================================================================

function AccountsTab() {
    const { t } = useI18n()
    const {
        accounts, stats, loading, error,
        fetchAccounts, fetchStats, addAccount, deleteAccount, updateAccount,
        importAccounts, testLogin, loginVisible, checkAllPending
    } = useAccountStore()
    const [selectedIds, setSelectedIds] = useState<Set<number | string>>(new Set())
    const [showAddModal, setShowAddModal] = useState(false)
    const [showImportModal, setShowImportModal] = useState(false)
    const [showEditModal, setShowEditModal] = useState(false)
    const [editingAccount, setEditingAccount] = useState<any>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [newAccount, setNewAccount] = useState({ email: '', password: '', recoveryEmail: '', recoveryPhone: '', loginType: 'auto' as 'auto' | 'manual' })
    const [importText, setImportText] = useState('')
    const [openDropdown, setOpenDropdown] = useState<number | null>(null)
    const [loginStates, setLoginStates] = useState<Record<number, { status: LoginStatus; message?: string }>>({})
    const [checkingAll, setCheckingAll] = useState(false)
    const dropdownRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        fetchAccounts()
        fetchStats()
    }, [])

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setOpenDropdown(null)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const filteredAccounts = accounts.filter(acc =>
        acc.email.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const handleAddAccount = async () => {
        if (!newAccount.email || !newAccount.password) return
        await addAccount(newAccount)
        setNewAccount({ email: '', password: '', recoveryEmail: '', recoveryPhone: '', loginType: 'auto' })
        setShowAddModal(false)
    }

    const handleImport = async () => {
        if (!importText.trim()) return
        const lines = importText.split('\n').filter(l => l.trim())
        const accountsToImport = lines.map(line => {
            const parts = line.split(/[:|,;]/).map(p => p.trim())
            return {
                email: parts[0] || '',
                password: parts[1] || '',
                recoveryEmail: parts[2],
                recoveryPhone: parts[3],
            }
        }).filter(a => a.email && a.password)

        const count = await importAccounts(accountsToImport)
        alert(t('accounts.importSuccess').replace('{count}', String(count)))
        setImportText('')
        setShowImportModal(false)
    }

    const handleDeleteSelected = async () => {
        const ids = Array.from(selectedIds) as number[]
        if (!confirm(t('accounts.deleteSelectedConfirm').replace('{count}', String(ids.length)))) return
        for (const id of ids) {
            await deleteAccount(id)
        }
        setSelectedIds(new Set())
    }

    const handleEdit = (account: any) => {
        setEditingAccount({ ...account })
        setShowEditModal(true)
        setOpenDropdown(null)
    }

    const handleSaveEdit = async () => {
        if (!editingAccount) return
        await updateAccount(editingAccount.id, {
            email: editingAccount.email,
            password: editingAccount.password,
            recoveryEmail: editingAccount.recoveryEmail,
            recoveryPhone: editingAccount.recoveryPhone,
            loginType: editingAccount.loginType,
            status: editingAccount.status,
        })
        setShowEditModal(false)
        setEditingAccount(null)
    }

    const handleDelete = async (id: number) => {
        if (!confirm(t('accounts.deleteConfirm'))) return
        await deleteAccount(id)
        setOpenDropdown(null)
    }

    const handleTestLogin = async (id: number) => {
        setOpenDropdown(null)
        setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in' } }))
        const result = await testLogin(id)
        setLoginStates(prev => ({
            ...prev,
            [id]: { status: result.success ? 'success' : 'failed', message: result.message }
        }))
        setTimeout(() => {
            setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
        }, 5000)
    }

    const handleLoginVisible = async (id: number) => {
        setOpenDropdown(null)
        setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in', message: t('accounts.openingBrowser') } }))
        const result = await loginVisible(id)
        setLoginStates(prev => ({
            ...prev,
            [id]: { status: result.success ? 'success' : 'failed', message: result.message }
        }))
        setTimeout(() => {
            setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
        }, 5000)
    }

    const handleOpenManualLogin = async (id: number) => {
        setOpenDropdown(null)
        setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in', message: 'Dang mo browser...' } }))
        try {
            const result = await window.electronAPI.accounts.openManualLogin(id)
            if (result.success) {
                setLoginStates(prev => ({
                    ...prev,
                    [id]: { status: 'logging_in', message: 'Browser da mo - hay dang nhap!' }
                }))
            } else {
                setLoginStates(prev => ({
                    ...prev,
                    [id]: { status: 'failed', message: result.message }
                }))
                setTimeout(() => {
                    setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
                }, 5000)
            }
        } catch (error) {
            setLoginStates(prev => ({
                ...prev,
                [id]: { status: 'failed', message: 'Loi mo browser' }
            }))
            setTimeout(() => {
                setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
            }, 5000)
        }
    }

    const handleCheckAll = async () => {
        setCheckingAll(true)
        try {
            const result = await checkAllPending()
            alert(t('accounts.checkedResult').replace('{checked}', String(result.checked)).replace('{alive}', String(result.alive)).replace('{dead}', String(result.dead)))
        } catch {
            alert(t('accounts.checkFailed'))
        }
        setCheckingAll(false)
    }

    const statusToneMap: Record<string, Tone> = {
        active: 'emerald',
        banned: 'rose',
        suspended: 'amber',
        pending: 'amber',
        checking: 'blue',
    }

    const getLoginStatusIcon = (id: number) => {
        const state = loginStates[id]
        if (!state) return null
        switch (state.status) {
            case 'logging_in': return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
            case 'success': return <CheckCircle className="h-4 w-4 text-emerald-500" />
            case 'failed': return <XCircle className="h-4 w-4 text-rose-500" />
            default: return null
        }
    }

    const columns = [
        {
            key: 'email',
            header: t('common.email'),
            render: (account: any) => (
                <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f4f1fa] text-sm font-semibold text-[#8d74e8]">
                        {account.email.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="font-medium text-[#17171f]">{account.email}</span>
                        {getLoginStatusIcon(account.id)}
                        {loginStates[account.id]?.message && (
                            <span className={`text-xs ${loginStates[account.id]?.status === 'success' ? 'text-emerald-600' :
                                loginStates[account.id]?.status === 'failed' ? 'text-rose-600' : 'text-blue-600'}`}>
                                {loginStates[account.id]?.message}
                            </span>
                        )}
                    </div>
                </div>
            ),
        },
        {
            key: 'status',
            header: t('common.status'),
            render: (account: any) => (
                <StatusPill tone={statusToneMap[account.status] || 'amber'}>{account.status}</StatusPill>
            ),
        },
        {
            key: 'totalReviews',
            header: t('accounts.totalReviews'),
            render: (account: any) => <span className="font-medium text-[#17171f]">{account.totalReviews}</span>,
        },
        {
            key: 'lastUsed',
            header: t('accounts.lastUsed'),
            render: (account: any) => (
                <span className="text-sm text-[#908a9e]">
                    {account.lastUsed ? new Date(account.lastUsed).toLocaleDateString() : t('accounts.never')}
                </span>
            ),
        },
        {
            key: 'actions',
            header: t('common.actions'),
            width: '60px',
            align: 'center' as const,
            render: (account: any) => (
                <div className="relative" ref={openDropdown === account.id ? dropdownRef : null}>
                    <IconButton
                        icon={MoreVertical}
                        label={t('accounts.accountActions')}
                        onClick={(e) => { e.stopPropagation(); setOpenDropdown(openDropdown === account.id ? null : account.id) }}
                    />
                    {openDropdown === account.id && (
                        <div className="absolute right-0 bottom-full mb-1 z-50 w-52 overflow-hidden rounded-[16px] border border-[#e9e4f2] bg-white shadow-[0_20px_48px_rgba(27,24,38,0.18)]">
                            <button onClick={() => handleEdit(account)}
                                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[#5f5a6d] hover:bg-[#f4f1fa] hover:text-[#17171f] transition-colors">
                                <Edit className="h-4 w-4" /> {t('accounts.editAccount')}
                            </button>
                            <button onClick={() => handleTestLogin(account.id)}
                                disabled={loginStates[account.id]?.status === 'logging_in'}
                                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[#5f5a6d] hover:bg-[#f4f1fa] hover:text-[#17171f] transition-colors disabled:opacity-50">
                                {loginStates[account.id]?.status === 'logging_in' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                                {t('accounts.testLogin')}
                            </button>
                            <button onClick={() => handleLoginVisible(account.id)}
                                disabled={loginStates[account.id]?.status === 'logging_in'}
                                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-50">
                                {loginStates[account.id]?.status === 'logging_in' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                                {t('accounts.loginVisible')}
                            </button>
                            <button onClick={() => handleOpenManualLogin(account.id)}
                                disabled={loginStates[account.id]?.status === 'logging_in'}
                                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-50">
                                {loginStates[account.id]?.status === 'logging_in' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                                Dang nhap thu cong
                            </button>
                            <Divider />
                            <button onClick={() => handleDelete(account.id)}
                                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50 transition-colors">
                                <Trash2 className="h-4 w-4" /> {t('accounts.deleteAccount')}
                            </button>
                        </div>
                    )}
                </div>
            ),
        },
    ]

    return (
        <>
            {/* Stats */}
            <StatRow>
                <StatCard icon={Users} tone="slate" value={stats.total} label={t('accounts.totalAccounts')} />
                <StatCard icon={CheckCircle} tone="emerald" value={stats.active} label={t('accounts.activeAccounts')} />
                <StatCard icon={Clock} tone="amber" value={stats.pending} label={t('accounts.pendingAccounts')} />
                <StatCard icon={Loader2} tone="violet" value={stats.checking || 0} label={t('accounts.checkingAccounts')} />
                <StatCard icon={XCircle} tone="rose" value={stats.banned} label={t('accounts.bannedAccounts')} />
            </StatRow>

            {/* Toolbar */}
            <Toolbar
                search={searchQuery}
                onSearchChange={setSearchQuery}
                searchPlaceholder={t('accounts.searchPlaceholder')}
            >
                {selectedIds.size > 0 && (
                    <PrimaryButton icon={Trash2} tone="rose" onClick={handleDeleteSelected}>
                        {t('common.delete')} ({selectedIds.size})
                    </PrimaryButton>
                )}
                <PrimaryButton icon={ShieldCheck} tone="emerald" variant="quiet" onClick={handleCheckAll} disabled={checkingAll}>
                    {checkingAll ? t('accounts.checkingAll') : t('accounts.checkAll')}
                </PrimaryButton>
                <PrimaryButton icon={Upload} variant="quiet" onClick={() => setShowImportModal(true)}>
                    {t('accounts.importCSV')}
                </PrimaryButton>
                <PrimaryButton icon={UserPlus} onClick={() => setShowAddModal(true)}>
                    {t('accounts.addAccount')}
                </PrimaryButton>
                <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={() => fetchAccounts()}
                    className={loading ? '[&_svg]:animate-spin' : ''} />
            </Toolbar>

            {/* Error */}
            {error && <AlertBanner type="error" title={error} />}

            {/* Table */}
            <DataTable
                columns={columns}
                data={filteredAccounts}
                selectable
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                emptyIcon={Users}
                emptyTitle={loading && accounts.length === 0 ? t('accounts.loadingAccounts') : t('accounts.noAccountsFound')}
                stickyHeader
            />

            {/* Add Account Modal */}
            <Modal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                title={t('accounts.addAccount')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowAddModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton onClick={handleAddAccount} disabled={!newAccount.email || !newAccount.password}>
                            {t('accounts.addAccount')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('common.email')}</label>
                        <TextInput value={newAccount.email} onChange={(v) => setNewAccount({ ...newAccount, email: v })} placeholder="example@gmail.com" />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('common.password')}</label>
                        <TextInput value={newAccount.password} onChange={(v) => setNewAccount({ ...newAccount, password: v })} placeholder="••••••••" type="password" />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.recoveryEmail')} ({t('common.optional')})</label>
                        <TextInput value={newAccount.recoveryEmail} onChange={(v) => setNewAccount({ ...newAccount, recoveryEmail: v })} placeholder="recovery@gmail.com" />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.loginType', 'Loai dang nhap')}</label>
                        <Select
                            value={newAccount.loginType}
                            onChange={(v) => setNewAccount({ ...newAccount, loginType: v as 'auto' | 'manual' })}
                            options={[
                                { value: 'auto', label: 'Tu dong (AI)' },
                                { value: 'manual', label: 'Thu cong' },
                            ]}
                        />
                    </div>
                </div>
            </Modal>

            {/* Edit Account Modal */}
            <Modal
                open={showEditModal && !!editingAccount}
                onClose={() => setShowEditModal(false)}
                title={t('accounts.editAccount')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowEditModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton onClick={handleSaveEdit}>{t('common.saveChanges')}</PrimaryButton>
                    </>
                }
            >
                {editingAccount && (
                    <div className="space-y-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('common.email')}</label>
                            <TextInput value={editingAccount.email} onChange={(v) => setEditingAccount({ ...editingAccount, email: v })} />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('common.password')}</label>
                            <TextInput value={editingAccount.password} onChange={(v) => setEditingAccount({ ...editingAccount, password: v })} type="password" />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.loginType', 'Loai dang nhap')}</label>
                            <Select
                                value={editingAccount.loginType || 'auto'}
                                onChange={(v) => setEditingAccount({ ...editingAccount, loginType: v })}
                                options={[
                                    { value: 'auto', label: 'Tu dong (AI)' },
                                    { value: 'manual', label: 'Thu cong' },
                                ]}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('common.status')}</label>
                            <Select
                                value={editingAccount.status}
                                onChange={(v) => setEditingAccount({ ...editingAccount, status: v })}
                                options={[
                                    { value: 'active', label: t('common.active') },
                                    { value: 'pending', label: t('common.pending') },
                                    { value: 'banned', label: t('accounts.bannedAccounts') },
                                    { value: 'suspended', label: t('accounts.suspended') },
                                ]}
                            />
                        </div>
                    </div>
                )}
            </Modal>

            {/* Import Modal */}
            <Modal
                open={showImportModal}
                onClose={() => setShowImportModal(false)}
                title={t('accounts.importAccounts')}
                footer={
                    <>
                        <PrimaryButton variant="quiet" onClick={() => setShowImportModal(false)}>{t('common.cancel')}</PrimaryButton>
                        <PrimaryButton onClick={handleImport} disabled={!importText.trim()}>
                            {t('accounts.importAccounts')}
                        </PrimaryButton>
                    </>
                }
            >
                <div className="space-y-4">
                    <p className="text-sm text-[#908a9e]">
                        {t('accounts.importFormat')} <code className="rounded bg-[#f4f1fa] px-1.5 py-0.5 text-xs font-medium text-[#735bd6]">{t('accounts.importFormatCode')}</code> {t('accounts.importFormatSuffix')}
                    </p>
                    <textarea
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        className="h-48 w-full rounded-[16px] border border-[#e9e4f2] bg-white px-4 py-3 font-mono text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        placeholder={"email1@gmail.com:password1\nemail2@gmail.com:password2"}
                    />
                </div>
            </Modal>
        </>
    )
}

// =============================================================================
// PROXIES TAB
// =============================================================================

function ProxiesTab() {
    const { t } = useI18n()
    const { proxies, stats, loading, error, fetchProxies, fetchStats, addProxy, deleteProxy, checkProxy, checkAllProxies, importFromText, deleteDeadProxies } = useProxyStore()
    const [selectedIds, setSelectedIds] = useState<Set<number | string>>(new Set())
    const [showAddModal, setShowAddModal] = useState(false)
    const [showImportModal, setShowImportModal] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [newProxy, setNewProxy] = useState({ host: '', port: '', username: '', password: '', type: 'http' as const })
    const [importText, setImportText] = useState('')

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
        })
        setNewProxy({ host: '', port: '', username: '', password: '', type: 'http' })
        setShowAddModal(false)
    }

    const handleImport = async () => {
        if (!importText.trim()) return
        const count = await importFromText(importText)
        alert(t('proxies.importSuccess').replace('{count}', String(count)))
        setImportText('')
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
        <>
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
                <PrimaryButton icon={Upload} variant="quiet" onClick={() => setShowImportModal(true)}>
                    {t('common.import')}
                </PrimaryButton>
                <PrimaryButton icon={Plus} tone="emerald" onClick={() => setShowAddModal(true)}>
                    {t('proxies.addProxy')}
                </PrimaryButton>
                <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={() => fetchProxies()}
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
                        <PrimaryButton tone="emerald" onClick={handleAddProxy} disabled={!newProxy.host || !newProxy.port}>
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
                </div>
            </Modal>

            {/* Import Proxy Modal */}
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
                    <textarea
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        className="h-48 w-full rounded-[16px] border border-[#e9e4f2] bg-white px-4 py-3 font-mono text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        placeholder={"192.168.1.1:8080\n192.168.1.2:8080:user:pass"}
                    />
                </div>
            </Modal>
        </>
    )
}
