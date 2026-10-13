import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAccountStore, useProxyStore } from '../stores'
import {
    UserPlus,
    Upload,
    Trash2,
    RefreshCw,
    MoreVertical,
    Edit,
    LogIn,
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
import {
    ProxyRuntimePreflightButton,
    ProxyPreflightResultPanel,
    type ProxyRuntimePreflightResult,
} from '../components/proxy'
import type {
    AccountImportPayload,
    AccountUpdatePayload,
    PublicAccount,
} from '../../../shared/account-contracts'
import {
    WarmupStatusCell,
    type WarmupActivityType,
} from '../components/accounts'

type Tab = 'accounts' | 'proxies'
type LoginStatus = 'idle' | 'logging_in' | 'success' | 'failed'
type EditableAccount = PublicAccount & {
    password: string
    twoFactorSecret: string
}

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
        importAccounts, testLogin, checkLiveDie, checkAllPending,
        warmupStatuses, warmupLoading, warmupError, warmupActionLoading, warmupApiAvailable,
        fetchWarmupStatuses, startWarmup, cancelWarmup,
    } = useAccountStore()
    const [selectedIds, setSelectedIds] = useState<Set<number | string>>(new Set())
    const [showAddModal, setShowAddModal] = useState(false)
    const [showImportModal, setShowImportModal] = useState(false)
    const [showEditModal, setShowEditModal] = useState(false)
    const [editingAccount, setEditingAccount] = useState<EditableAccount | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [newAccount, setNewAccount] = useState({ email: '', password: '', recoveryEmail: '', recoveryPhone: '', twoFactorSecret: '', loginType: 'auto' as 'auto' | 'manual' })
    const [importText, setImportText] = useState('')
    const [openDropdown, setOpenDropdown] = useState<number | null>(null)
    const [anchorRect, setAnchorRect] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null)
    const [loginStates, setLoginStates] = useState<Record<number, { status: LoginStatus; message?: string }>>({})
    const [checkingAll, setCheckingAll] = useState(false)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const watchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const watchCancelledRef = useRef(false)
    const warmupStatusesRef = useRef(warmupStatuses)
    warmupStatusesRef.current = warmupStatuses

    // Normalize short email (no @) -> @gmail.com before save/login. Applied for add + import.
    const normalizeEmail = (email: string): string => {
        const t = (email || '').trim()
        if (!t) return t
        return t.includes('@') ? t : `${t}@gmail.com`
    }

    useEffect(() => {
        fetchAccounts()
        fetchStats()
        void fetchWarmupStatuses()
    }, [])

    // Poll batch statuses while any warmup is running (single getAllStatuses, no N+1).
    // The boolean flips only when a run starts or stops, so status payloads do not rebuild the timer.
    const hasRunningWarmup = Object.values(warmupStatuses).some((status) => status.state === 'running')
    useEffect(() => {
        if (!hasRunningWarmup || !warmupApiAvailable) return
        const timer = window.setInterval(() => {
            const stillRunning = Object.values(warmupStatusesRef.current).some((status) => status.state === 'running')
            if (!stillRunning) return
            void fetchWarmupStatuses()
        }, 4000)
        return () => window.clearInterval(timer)
    }, [hasRunningWarmup, warmupApiAvailable, fetchWarmupStatuses])

    useEffect(() => {
        watchCancelledRef.current = false
        return () => {
            watchCancelledRef.current = true
            if (watchTimerRef.current !== null) {
                clearTimeout(watchTimerRef.current)
                watchTimerRef.current = null
            }
        }
    }, [])

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setOpenDropdown(null)
                setAnchorRect(null)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    // Close portal menu on scroll/resize (capture to hit nested scrollers) or Esc. Position is viewport-fixed so stale rects on scroll are avoided by close.
    useEffect(() => {
        if (openDropdown === null) return
        const close = () => {
            setOpenDropdown(null)
            setAnchorRect(null)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close()
        }
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        document.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('scroll', close, true)
            window.removeEventListener('resize', close)
            document.removeEventListener('keydown', onKey)
        }
    }, [openDropdown])

    const filteredAccounts = accounts.filter(acc =>
        acc.email.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const watchAccountUntilActive = (accountId: number, attempts = 0) => {
        if (watchCancelledRef.current) return
        if (attempts > 120) return
        void (async () => {
            if (watchCancelledRef.current) return
            try {
                await fetchAccounts()
                if (watchCancelledRef.current) return
                const acc = useAccountStore.getState().accounts.find((account) => account.id === accountId)
                if (acc && acc.status === 'active') {
                    setLoginStates(prev => ({
                        ...prev,
                        [accountId]: { status: 'success', message: 'Dang nhap thu cong thanh cong!' },
                    }))
                    watchTimerRef.current = setTimeout(() => {
                        if (watchCancelledRef.current) return
                        setLoginStates(prev => {
                            const next = { ...prev }
                            delete next[accountId]
                            return next
                        })
                    }, 4500)
                    return
                }
            } catch {
                // Retry until the safety cap or unmount.
            }
            if (watchCancelledRef.current) return
            watchTimerRef.current = setTimeout(() => {
                watchAccountUntilActive(accountId, attempts + 1)
            }, 3000)
        })()
    }

    const handleAddAccount = async () => {
        if (!newAccount.email || !newAccount.password) return
        const payload = { ...newAccount, email: normalizeEmail(newAccount.email) }
        const created = await addAccount(payload)
        setNewAccount({ email: '', password: '', recoveryEmail: '', recoveryPhone: '', twoFactorSecret: '', loginType: 'auto' })
        setShowAddModal(false)

        // Post-add auto-trigger per loginType (reuses existing testLogin / openManualLogin flows + loginStates UI)
        // Non-blocking: modal closed, list refreshed inside addAccount; bg login updates status + temp loginStates.
        if (created && created.id) {
            const id: number = created.id
            const lt: 'auto' | 'manual' = created.loginType || 'auto'
            if (lt === 'auto') {
                setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in', message: 'Đang đăng nhập...' } }))
                try {
                    const result = await testLogin(id)
                    setLoginStates(prev => ({
                        ...prev,
                        [id]: { status: result?.success ? 'success' : 'failed', message: result?.message }
                    }))
                    setTimeout(() => {
                        setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
                    }, 5000)
                } catch {
                    setLoginStates(prev => ({ ...prev, [id]: { status: 'failed', message: 'Lỗi auto login' } }))
                    setTimeout(() => {
                        setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
                    }, 5000)
                }
            } else {
                setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in', message: 'Dang mo browser...' } }))
                try {
                    const result = await window.electronAPI.accounts.openManualLogin(id)
                    if (result.success) {
                        setLoginStates(prev => ({
                            ...prev,
                            [id]: { status: 'logging_in', message: 'Browser da mo - hay dang nhap!' }
                        }))
                        // Watch until main-process login detection marks the account active.
                        watchAccountUntilActive(id)
                    } else {
                        setLoginStates(prev => ({
                            ...prev,
                            [id]: { status: 'failed', message: result.message }
                        }))
                        setTimeout(() => {
                            setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
                        }, 5000)
                    }
                } catch {
                    setLoginStates(prev => ({
                        ...prev,
                        [id]: { status: 'failed', message: 'Loi mo browser' }
                    }))
                    setTimeout(() => {
                        setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
                    }, 5000)
                }
            }
        }
    }

    const handleImport = async () => {
        if (!importText.trim()) return
        const lines = importText.split('\n').filter(l => l.trim())
        const accountsToImport: AccountImportPayload[] = []
        let hasHeader = false
        const first = lines[0]?.toLowerCase() || ''
        if (first.includes('email') && first.includes('pass')) { hasHeader = true }

        const header = hasHeader
            ? lines[0].split(/[:|,;\t]/).map(value => value.trim().toLowerCase())
            : []
        const headerIndex = (...names: string[]) => header.findIndex(value => names.includes(value))

        for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
            const line = lines[i]
            const parts = line.split(/[:|,;\t]/).map(p => p.trim())
            if (parts.length < 2) continue

            const read = (index: number) => index >= 0 ? parts[index]?.trim() || undefined : undefined
            const email = hasHeader ? read(headerIndex('email', 'gmail')) : read(0)
            const password = hasHeader ? read(headerIndex('password', 'pass', 'pwd')) : read(1)
            if (!email || !password) continue

            const entry: AccountImportPayload = {
                email: normalizeEmail(email),
                password,
            }

            if (hasHeader) {
                entry.recoveryEmail = read(headerIndex('recoveryemail', 'recovery_email'))
                entry.recoveryPhone = read(headerIndex('recoveryphone', 'recovery_phone'))
                entry.twoFactorSecret = read(headerIndex('2fa', '2fa_secret', 'totp', 'twofactorsecret'))
                const loginType = read(headerIndex('login_type', 'logintype'))?.toLowerCase()
                if (loginType === 'auto' || loginType === 'manual') entry.loginType = loginType
            } else {
                const third = read(2)
                const fourth = read(3)?.toLowerCase()
                const fifth = read(4)?.toLowerCase()
                const isLegacyRecoveryLayout = Boolean(third?.includes('@') && read(3) && fifth)
                if (isLegacyRecoveryLayout) {
                    entry.recoveryEmail = third
                    entry.twoFactorSecret = read(3)
                    if (fifth === 'auto' || fifth === 'manual') entry.loginType = fifth
                } else {
                    entry.twoFactorSecret = third
                    if (fourth === 'auto' || fourth === 'manual') entry.loginType = fourth
                }
            }
            accountsToImport.push(entry)
        }

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

    const handleEdit = (account: PublicAccount) => {
        setEditingAccount({ ...account, password: '', twoFactorSecret: '' })
        setShowEditModal(true)
        closeDropdown()
    }

    const handleSaveEdit = async () => {
        if (!editingAccount) return
        const update: AccountUpdatePayload = {
            email: editingAccount.email,
            recoveryEmail: editingAccount.recoveryEmail,
            recoveryPhone: editingAccount.recoveryPhone,
            loginType: editingAccount.loginType,
            status: editingAccount.status,
        }
        if (editingAccount.password.trim()) update.password = editingAccount.password
        if (editingAccount.twoFactorSecret.trim()) {
            update.twoFactorSecret = editingAccount.twoFactorSecret
        }
        await updateAccount(editingAccount.id, update)
        setShowEditModal(false)
        setEditingAccount(null)
    }

    const handleDelete = async (id: number) => {
        if (!confirm(t('accounts.deleteConfirm'))) return
        await deleteAccount(id)
        closeDropdown()
    }

    const handleTestLogin = async (id: number) => {
        closeDropdown()
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

    const handleOpenManualLogin = async (id: number) => {
        closeDropdown()
        setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in', message: 'Dang mo browser...' } }))
        try {
            const result = await window.electronAPI.accounts.openManualLogin(id)
            if (result.success) {
                setLoginStates(prev => ({
                    ...prev,
                    [id]: { status: 'logging_in', message: 'Browser da mo - hay dang nhap!' }
                }))
                watchAccountUntilActive(id)
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

    const handleCheck = async (id: number) => {
        closeDropdown()
        setLoginStates(prev => ({ ...prev, [id]: { status: 'logging_in', message: 'Dang kiem tra...' } }))
        const result = await checkLiveDie(id)
        const ok = (result as any)?.alive
        setLoginStates(prev => ({
            ...prev,
            [id]: { status: ok ? 'success' : 'failed', message: ok ? 'Live' : ((result as any)?.error || 'Die') }
        }))
        setTimeout(() => {
            setLoginStates(prev => { const next = { ...prev }; delete next[id]; return next })
        }, 4500)
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

    const handleStartWarmup = (accountId: number, activityType: WarmupActivityType) => {
        void startWarmup(accountId, { activityType })
    }

    const handleCancelWarmup = (accountId: number) => {
        void cancelWarmup(accountId)
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

    // Portal menu position calc: right-aligned by default (right edge to button right), switch to left if near viewport right edge.
    // Flip above (bung lên) if near bottom of viewport. Uses fixed + viewport rects to escape all overflow-hidden containers (DataTable, AppShell etc).
    const getMenuPosition = (rect: { top: number; bottom: number; left: number; right: number }) => {
        const MENU_W = 208
        const MENU_H_EST = 260
        const GAP = 4
        const PAD = 8
        const vw = window.innerWidth
        const vh = window.innerHeight

        let left = rect.right - MENU_W   // right-aligned
        let top = rect.bottom + GAP

        if (left + MENU_W > vw - PAD) {
            left = Math.max(PAD, rect.left)  // left-align fallback near right edge
        }
        if (top + MENU_H_EST > vh - PAD) {
            top = Math.max(PAD, rect.top - MENU_H_EST - GAP)  // open upwards near bottom
        }
        if (top < PAD) top = rect.bottom + GAP
        if (left < PAD) left = PAD
        return { top, left }
    }

    const closeDropdown = () => {
        setOpenDropdown(null)
        setAnchorRect(null)
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
            key: 'warmup',
            header: t('accounts.warmup.column', 'Warmup'),
            render: (account: PublicAccount) => (
                <WarmupStatusCell
                    account={account}
                    status={warmupStatuses[account.id]}
                    apiAvailable={warmupApiAvailable}
                    actionLoading={Boolean(warmupActionLoading[account.id])}
                    t={t}
                    onStart={handleStartWarmup}
                    onCancel={handleCancelWarmup}
                />
            ),
        },
        {
            key: 'lastUsed',
            header: t('accounts.lastUsed'),
            render: (account: any) => {
                const lu = account.lastUsed
                let txt = t('accounts.never') || 'Chua dung'
                if (lu) {
                    try {
                        const d = new Date(lu)
                        txt = d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
                    } catch { txt = String(lu) }
                }
                return <span className="text-sm text-[#908a9e]">{txt}</span>
            },
        },
        {
            key: 'actions',
            header: t('common.actions'),
            width: '60px',
            align: 'center' as const,
            render: (account: any) => (
                <IconButton
                    icon={MoreVertical}
                    label={t('accounts.accountActions')}
                    onClick={(e) => {
                        e.stopPropagation()
                        const id = account.id
                        if (openDropdown === id) {
                            closeDropdown()
                            return
                        }
                        const btn = e.currentTarget as HTMLElement
                        const r = btn.getBoundingClientRect()
                        setOpenDropdown(id)
                        setAnchorRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
                    }}
                />
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
                <IconButton
                    icon={RefreshCw}
                    label={t('common.refresh')}
                    onClick={() => {
                        void fetchAccounts()
                        void fetchWarmupStatuses()
                    }}
                    className={loading || warmupLoading ? '[&_svg]:animate-spin' : ''}
                />
            </Toolbar>

            {/* Error */}
            {error && <AlertBanner type="error" title={error} />}
            {warmupError && (
                <AlertBanner type="error" title={t('accounts.warmup.error', 'Warmup error')}>
                    {warmupError}
                </AlertBanner>
            )}

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
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.twoFactorSecret', 'Mã 2FA (TOTP secret)')} ({t('common.optional')})</label>
                        <TextInput value={newAccount.twoFactorSecret} onChange={(v) => setNewAccount({ ...newAccount, twoFactorSecret: v })} placeholder="JBSWY3DPEHPK3PXP" />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.loginType', 'Loai dang nhap')}</label>
                        <Select
                            value={newAccount.loginType}
                            onChange={(v) => setNewAccount({ ...newAccount, loginType: v as 'auto' | 'manual' })}
                            options={[
                                { value: 'auto', label: 'Tu dong (AI - tu go + TOTP)' },
                                { value: 'manual', label: 'Thu cong (mo browser cho user)' },
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
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.twoFactorSecret', 'Mã 2FA (TOTP secret)')} ({t('common.optional')})</label>
                            <TextInput value={editingAccount.twoFactorSecret || ''} onChange={(v) => setEditingAccount({ ...editingAccount, twoFactorSecret: v })} />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[#5f5a6d]">{t('accounts.loginType', 'Loai dang nhap')}</label>
                            <Select
                                value={editingAccount.loginType || 'auto'}
                                onChange={(v) => setEditingAccount({ ...editingAccount, loginType: v })}
                                options={[
                                    { value: 'auto', label: 'Tu dong (AI - tu go + TOTP)' },
                                    { value: 'manual', label: 'Thu cong (mo browser cho user)' },
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
                        {t('accounts.importFormat')} <code className="rounded bg-[#f4f1fa] px-1.5 py-0.5 text-xs font-medium text-[#735bd6]">email,password,2fa_secret,login_type</code> {t('accounts.importFormatSuffix')}
                        <br />Hỗ trợ header (email,password,2fa,login_type), dấu phân cách :,; | tab. 2fa_secret = TOTP secret (base32). login_type=auto|manual.
                    </p>
                    <textarea
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        className="h-48 w-full rounded-[16px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 py-3 font-mono text-sm text-[#17171f] dark:text-[#f0ecff] placeholder:text-[#908a9e] dark:placeholder:text-[#9a8fba] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        placeholder={"email1@gmail.com:password1:2faSECRETBASE32:auto\nemail2@gmail.com,password2,,manual\nemail,password,2FASECRET"}
                    />
                </div>
            </Modal>

            {/* Portal dropdown menu (fixed to body) - escapes DataTable overflow-hidden + AppShell scroll containers.
                 Position computed from trigger rect; right-aligned + upward flip near edges. */}
            {openDropdown !== null && anchorRect && createPortal(
                <div
                    ref={menuRef}
                    style={{
                        position: 'fixed',
                        ...getMenuPosition(anchorRect),
                        zIndex: 99999,
                    } as React.CSSProperties}
                    className="w-52 overflow-hidden rounded-[16px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] shadow-[0_20px_48px_rgba(27,24,38,0.18)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                    onClick={(e) => e.stopPropagation()}
                >
                    {(() => {
                        const account = accounts.find((a) => a.id === openDropdown)
                        if (!account) return null
                        const isLogging = loginStates[account.id]?.status === 'logging_in'
                        return (
                            <>
                                <button onClick={() => handleEdit(account)}
                                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[#5f5a6d] dark:text-[#c8c0d8] hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a] hover:text-[#17171f] dark:hover:text-[#f0ecff] transition-colors">
                                    <Edit className="h-4 w-4" /> {t('accounts.editAccount')}
                                </button>
                                <button onClick={() => handleTestLogin(account.id)}
                                    disabled={isLogging}
                                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[#5f5a6d] dark:text-[#c8c0d8] hover:bg-[#f4f1fa] dark:hover:bg-[#352f4a] hover:text-[#17171f] dark:hover:text-[#f0ecff] transition-colors disabled:opacity-50">
                                    {isLogging ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                                    {account.loginType === 'manual' ? 'Thu cong (dung manual)' : t('accounts.testLogin')}
                                </button>
                                <button onClick={() => handleOpenManualLogin(account.id)}
                                    disabled={isLogging}
                                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors disabled:opacity-50">
                                    {isLogging ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                                    {t('accounts.manualLogin', 'Dang nhap thu cong')}
                                </button>
                                <button onClick={() => handleCheck(account.id)}
                                    disabled={isLogging}
                                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors disabled:opacity-50">
                                    {isLogging ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                                    {t('accounts.checkAccount', 'Kiem tra')}
                                </button>
                                <Divider />
                                <button onClick={() => handleDelete(account.id)}
                                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors">
                                    <Trash2 className="h-4 w-4" /> {t('accounts.deleteAccount')}
                                </button>
                            </>
                        )
                    })()}
                </div>,
                document.body
            )}
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
    const [runtimeResults, setRuntimeResults] = useState<Record<number, ProxyRuntimePreflightResult>>({})
    const [runtimeFocusId, setRuntimeFocusId] = useState<number | null>(null)

    useEffect(() => {
        fetchProxies()
        fetchStats()
    }, [])

    const handleRuntimeResult = (proxyId: number, result: ProxyRuntimePreflightResult) => {
        setRuntimeResults((prev) => ({ ...prev, [proxyId]: result }))
        setRuntimeFocusId(proxyId)
        void fetchProxies()
        void fetchStats()
    }

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
            width: '160px',
            align: 'center' as const,
            render: (proxy: { id: number }) => (
                <div className="flex items-center justify-center gap-1">
                    <IconButton
                        icon={Zap}
                        label={t('proxies.checkProxy')}
                        onClick={() => {
                            void checkProxy(proxy.id)
                        }}
                    />
                    <ProxyRuntimePreflightButton
                        proxyId={proxy.id}
                        label="Runtime preflight"
                        onResult={(result) => handleRuntimeResult(proxy.id, result)}
                    />
                    <IconButton icon={Trash2} label={t('common.delete')} onClick={() => deleteProxy(proxy.id)} />
                </div>
            ),
        },
    ]

    const focusedRuntimeResult =
        runtimeFocusId !== null ? runtimeResults[runtimeFocusId] ?? null : null
    const focusedProxy = runtimeFocusId !== null
        ? proxies.find((p) => p.id === runtimeFocusId)
        : undefined

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

            {/* Runtime-parity preflight result (Playwright + ProxyBridge path) */}
            {focusedRuntimeResult && (
                <ProxyPreflightResultPanel
                    result={focusedRuntimeResult}
                    proxyLabel={
                        focusedProxy
                            ? `${focusedProxy.host}:${focusedProxy.port}`
                            : runtimeFocusId != null
                                ? `#${runtimeFocusId}`
                                : undefined
                    }
                />
            )}

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
                        className="h-48 w-full rounded-[16px] border border-[#e9e4f2] dark:border-[#3d3558] bg-white dark:bg-[#1e1b2e] px-4 py-3 font-mono text-sm text-[#17171f] dark:text-[#f0ecff] placeholder:text-[#908a9e] dark:placeholder:text-[#9a8fba] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                        placeholder={"192.168.1.1:8080\n192.168.1.2:8080:user:pass"}
                    />
                </div>
            </Modal>
        </>
    )
}
