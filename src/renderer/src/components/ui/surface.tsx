import { type ButtonHTMLAttributes, type InputHTMLAttributes, isValidElement, type ReactNode, useEffect } from 'react'
import { type LucideIcon, Search, X, ChevronLeft, ChevronRight, ChevronDown, AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react'

type Tone = 'blue' | 'cyan' | 'amber' | 'emerald' | 'violet' | 'slate' | 'rose'

const toneStyles: Record<Tone, { icon: string; panel: string; button: string; soft: string }> = {
    blue: {
        icon: 'bg-blue-500 text-white',
        panel: 'border-blue-100 bg-blue-50 text-blue-700',
        button: 'bg-blue-600 text-white hover:bg-blue-500',
        soft: 'text-blue-600',
    },
    cyan: {
        icon: 'bg-cyan-500 text-white',
        panel: 'border-cyan-100 bg-cyan-50 text-cyan-700',
        button: 'bg-cyan-500 text-white hover:bg-cyan-400',
        soft: 'text-cyan-600',
    },
    amber: {
        icon: 'bg-amber-400 text-[#1f1b12]',
        panel: 'border-amber-100 bg-amber-50 text-amber-700',
        button: 'bg-amber-400 text-[#1f1b12] hover:bg-amber-300',
        soft: 'text-amber-600',
    },
    emerald: {
        icon: 'bg-emerald-500 text-white',
        panel: 'border-emerald-100 bg-emerald-50 text-emerald-700',
        button: 'bg-emerald-500 text-white hover:bg-emerald-400',
        soft: 'text-emerald-600',
    },
    violet: {
        icon: 'bg-[#8d74e8] text-white',
        panel: 'border-[#e6e0fb] bg-[#f4f0ff] text-[#735bd6]',
        button: 'bg-[#8d74e8] text-white hover:bg-[#7b60db]',
        soft: 'text-[#735bd6]',
    },
    slate: {
        icon: 'bg-[#232229] text-white',
        panel: 'border-[#eceaf2] bg-[#f7f7f9] text-[#565263]',
        button: 'bg-[#232229] text-white hover:bg-[#34323b]',
        soft: 'text-[#706c7d]',
    },
    rose: {
        icon: 'bg-rose-500 text-white',
        panel: 'border-rose-100 bg-rose-50 text-rose-700',
        button: 'bg-rose-500 text-white hover:bg-rose-400',
        soft: 'text-rose-600',
    },
}

function classes(...values: Array<string | false | null | undefined>) {
    return values.filter(Boolean).join(' ')
}

export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={classes('flex min-h-full w-full flex-col gap-4 p-4 sm:p-5 lg:p-7', className)}>
            {children}
        </div>
    )
}

export function PageHeader({
    title,
    subtitle,
    icon: Icon,
    tone = 'violet',
    children,
}: {
    title: ReactNode
    subtitle?: ReactNode
    icon: LucideIcon
    tone?: Tone
    children?: ReactNode
}) {
    return (
        <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
                <IconFrame icon={Icon} tone={tone} />
                <div className="min-w-0">
                    <h1 className="truncate text-2xl font-semibold tracking-normal text-[#17171f]">{title}</h1>
                    {subtitle && <p className="mt-1 text-sm font-medium text-[#8e899b]">{subtitle}</p>}
                </div>
            </div>
            {children && <div className="flex flex-wrap items-center gap-2.5">{children}</div>}
        </header>
    )
}

export function Panel({
    children,
    className,
    tone = 'slate',
}: {
    children: ReactNode
    className?: string
    tone?: Tone
}) {
    return (
        <div className={classes('rounded-[24px] border p-5 shadow-[0_18px_48px_rgba(40,36,54,0.06)]', toneStyles[tone].panel, className)}>
            {children}
        </div>
    )
}

export function IconFrame({ icon: Icon, tone }: { icon: LucideIcon; tone: Tone }) {
    return (
        <div className={classes('flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-[0_12px_22px_rgba(40,36,54,0.12)]', toneStyles[tone].icon)}>
            <Icon className="h-5 w-5" />
        </div>
    )
}

export function StatCard({
    icon,
    label,
    value,
    tone = 'violet',
    subtext,
}: {
    icon: LucideIcon
    label: ReactNode
    value: ReactNode
    tone?: Tone
    subtext?: ReactNode
}) {
    return (
        <Panel className="p-4" tone="slate">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="text-2xl font-semibold leading-none tracking-normal text-[#17171f]">{value}</div>
                    <div className="mt-2 text-sm font-medium text-[#6f697c]">{label}</div>
                    {subtext && <div className="mt-1 text-xs font-medium text-[#9a95a7]">{subtext}</div>}
                </div>
                <IconFrame icon={icon} tone={tone} />
            </div>
        </Panel>
    )
}

export function EmptyState({
    icon,
    title,
    subtitle,
    action,
}: {
    icon: LucideIcon
    title: ReactNode
    subtitle?: ReactNode
    action?: ReactNode
}) {
    const Icon = icon

    return (
        <div className="rounded-[22px] border border-dashed border-[#ded8ed] bg-white px-5 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#f2effd] text-[#8d74e8]">
                <Icon className="h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-semibold text-[#24222c]">{title}</div>
            {subtitle && <div className="mx-auto mt-1 max-w-md text-sm text-[#8e899b]">{subtitle}</div>}
            {action && <div className="mt-4 flex justify-center">{action}</div>}
        </div>
    )
}

export function SectionPanel({
    icon,
    title,
    children,
    tone = 'violet',
    description,
}: {
    icon?: LucideIcon | ReactNode
    title: ReactNode
    children: ReactNode
    tone?: Tone
    description?: ReactNode
}) {
    const isComponent = (val: unknown): val is LucideIcon => {
        if (typeof val === 'function') return true
        if (val && typeof val === 'object') {
            const v = val as Record<string, unknown>
            // Lucide icons are forwardRef objects: support user's specified $ marker
            if (v.$ === Symbol.for('react.forward_ref')) return true
            // Standard React component symbols (forwardRef / memo created components)
            const sym = v.$$typeof
            if (sym === Symbol.for('react.forward_ref') || sym === Symbol.for('react.memo')) return true
        }
        return false
    }

    const Icon = icon != null && !isValidElement(icon) && isComponent(icon) ? (icon as LucideIcon) : null
    const iconNode = Icon ? null : (icon as ReactNode | undefined)

    return (
        <Panel className="overflow-hidden p-0" tone="slate">
            <div className="flex items-start gap-3 border-b border-[#e9e4f2] bg-white px-5 py-4">
                {Icon ? (
                    <IconFrame icon={Icon} tone={tone} />
                ) : iconNode ? (
                    <div className={classes('flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-[0_12px_22px_rgba(40,36,54,0.12)]', toneStyles[tone].panel)}>
                        {iconNode}
                    </div>
                ) : null}
                <div className="min-w-0">
                    <h2 className="text-base font-semibold tracking-normal text-[#24222c]">{title}</h2>
                    {description && <p className="mt-1 text-sm text-[#8e899b]">{description}</p>}
                </div>
            </div>
            <div className="space-y-3 p-4">{children}</div>
        </Panel>
    )
}

export function FormRow({
    icon,
    label,
    description,
    children,
    tone = 'violet',
}: {
    icon?: ReactNode
    label: ReactNode
    description?: ReactNode
    children: ReactNode
    tone?: Tone
}) {
    return (
        <div className="flex flex-col gap-3 rounded-[18px] border border-[#ece7f5] bg-white p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 items-start gap-3">
                {icon && (
                    <div className={classes('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', toneStyles[tone].panel)}>
                        {icon}
                    </div>
                )}
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#24222c]">{label}</div>
                    {description && <div className="mt-0.5 text-xs leading-relaxed text-[#8e899b]">{description}</div>}
                </div>
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    )
}

interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon?: LucideIcon
    tone?: Tone
    variant?: 'solid' | 'quiet' | 'dark'
}

export function PrimaryButton({
    children,
    className,
    icon: Icon,
    tone = 'violet',
    variant = 'solid',
    ...props
}: PrimaryButtonProps) {
    const color = getButtonColor(tone, variant)

    return (
        <button
            type="button"
            className={classes(
                'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-all duration-200',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/40 focus:ring-offset-2 focus:ring-offset-white',
                color,
                className,
            )}
            {...props}
        >
            {Icon && <Icon className="h-4 w-4" />}
            {children}
        </button>
    )
}

export function IconButton({
    icon: Icon,
    label,
    className,
    variant = 'quiet',
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: LucideIcon
    label: string
    variant?: 'quiet' | 'dark' | 'accent'
}) {
    const color =
        variant === 'dark'
            ? 'bg-[#232229] text-white shadow-[0_12px_24px_rgba(35,34,41,0.16)] hover:bg-[#34323b]'
            : variant === 'accent'
                ? 'bg-[#8d74e8] text-white shadow-[0_14px_26px_rgba(141,116,232,0.24)] hover:bg-[#7b60db]'
                : 'border border-[#eceaf2] bg-white text-[#272530] shadow-sm hover:bg-[#f7f5fb]'

    return (
        <button
            type="button"
            aria-label={label}
            className={classes(
                'inline-flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200',
                'focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/40 focus:ring-offset-2 focus:ring-offset-white',
                color,
                className,
            )}
            {...props}
        >
            <Icon className="h-[18px] w-[18px]" />
        </button>
    )
}

export function SegmentedTabs<T extends string>({
    items,
    value,
    onChange,
    className,
}: {
    items: Array<{ id: T; label: ReactNode; icon?: LucideIcon }>
    value: T
    onChange: (value: T) => void
    className?: string
}) {
    return (
        <div className={classes('inline-flex flex-wrap items-center gap-1 rounded-full border border-[#e9e4f2] bg-[#f4f1fa] p-1', className)}>
            {items.map((item) => {
                const Icon = item.icon
                const active = item.id === value

                return (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => onChange(item.id)}
                        className={classes(
                            'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200',
                            active
                                ? 'bg-[#8d74e8] text-white shadow-[0_14px_24px_rgba(141,116,232,0.24)]'
                                : 'text-[#625d70] hover:bg-white hover:text-[#24222c]',
                        )}
                    >
                        {Icon && <Icon className="h-4 w-4" />}
                        {item.label}
                    </button>
                )
            })}
        </div>
    )
}

export function StatusPill({ children, tone }: { children: ReactNode; tone: Tone }) {
    return (
        <span className={classes('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold', toneStyles[tone].panel)}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {children}
        </span>
    )
}

// ============================================================
// Search Input
// ============================================================

export function SearchInput({
    value,
    onChange,
    placeholder = 'Tìm kiếm...',
    className,
    ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
    value: string
    onChange: (value: string) => void
}) {
    return (
        <div className={classes('relative', className)}>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#908a9e]" />
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="h-10 w-full rounded-full border border-[#e9e4f2] bg-white pl-10 pr-9 text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
                {...props}
            />
            {value && (
                <button
                    type="button"
                    onClick={() => onChange('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-[#908a9e] hover:bg-[#f4f1fa] hover:text-[#735bd6]"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    )
}

// ============================================================
// Toolbar — row with search + action buttons
// ============================================================

export function Toolbar({
    children,
    search,
    onSearchChange,
    searchPlaceholder,
    className,
}: {
    children?: ReactNode
    search?: string
    onSearchChange?: (value: string) => void
    searchPlaceholder?: string
    className?: string
}) {
    return (
        <div className={classes('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', className)}>
            {search !== undefined && onSearchChange && (
                <SearchInput
                    value={search}
                    onChange={onSearchChange}
                    placeholder={searchPlaceholder}
                    className="w-full sm:max-w-xs"
                />
            )}
            {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
        </div>
    )
}

// ============================================================
// Badge
// ============================================================

export function Badge({
    children,
    tone = 'slate',
    dot,
    className,
}: {
    children: ReactNode
    tone?: Tone
    dot?: boolean
    className?: string
}) {
    return (
        <span className={classes(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5',
            toneStyles[tone].panel,
            className,
        )}>
            {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
            {children}
        </span>
    )
}

// ============================================================
// Progress Bar
// ============================================================

export function ProgressBar({
    value,
    max = 100,
    tone = 'violet',
    size = 'md',
    showLabel,
    className,
}: {
    value: number
    max?: number
    tone?: Tone
    size?: 'sm' | 'md'
    showLabel?: boolean
    className?: string
}) {
    const pct = Math.min(100, Math.max(0, (value / max) * 100))
    const h = size === 'sm' ? 'h-1.5' : 'h-2.5'

    return (
        <div className={classes('flex items-center gap-2', className)}>
            <div className={classes('flex-1 overflow-hidden rounded-full bg-[#ece7f5]', h)}>
                <div
                    className={classes('rounded-full transition-all duration-500', h, toneStyles[tone].button.split(' ')[0])}
                    style={{ width: `${pct}%` }}
                />
            </div>
            {showLabel && (
                <span className="shrink-0 text-xs font-semibold text-[#6f697c]">{Math.round(pct)}%</span>
            )}
        </div>
    )
}

// ============================================================
// Alert Banner
// ============================================================

const alertIconMap = {
    info: Info,
    success: CheckCircle,
    warning: AlertTriangle,
    error: AlertCircle,
} as const

const alertToneMap: Record<string, Tone> = {
    info: 'blue',
    success: 'emerald',
    warning: 'amber',
    error: 'rose',
}

export function AlertBanner({
    type = 'info',
    title,
    children,
    onDismiss,
    className,
}: {
    type?: 'info' | 'success' | 'warning' | 'error'
    title?: ReactNode
    children?: ReactNode
    onDismiss?: () => void
    className?: string
}) {
    const Icon = alertIconMap[type]
    const tone = alertToneMap[type]

    return (
        <div className={classes(
            'flex items-start gap-3 rounded-[18px] border p-4',
            toneStyles[tone].panel,
            className,
        )}>
            <Icon className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
                {title && <div className="text-sm font-semibold">{title}</div>}
                {children && <div className="mt-0.5 text-sm opacity-80">{children}</div>}
            </div>
            {onDismiss && (
                <button type="button" onClick={onDismiss} className="shrink-0 rounded-full p-1 hover:bg-black/5">
                    <X className="h-4 w-4" />
                </button>
            )}
        </div>
    )
}

// ============================================================
// Toggle Switch
// ============================================================

export function Toggle({
    checked,
    onChange,
    disabled,
    size = 'md',
}: {
    checked: boolean
    onChange: (value: boolean) => void
    disabled?: boolean
    size?: 'sm' | 'md'
}) {
    const w = size === 'sm' ? 'w-9' : 'w-11'
    const h = size === 'sm' ? 'h-5' : 'h-6'
    const dot = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4.5 w-4.5'
    const translate = size === 'sm' ? 'translate-x-4' : 'translate-x-5'

    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={classes(
                'relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200',
                w, h,
                checked ? 'bg-[#8d74e8]' : 'bg-[#dcd6ee]',
                disabled && 'cursor-not-allowed opacity-50',
            )}
        >
            <span
                className={classes(
                    'inline-block rounded-full bg-white shadow-sm transition-transform duration-200',
                    dot,
                    checked ? translate : 'translate-x-0.5',
                )}
            />
        </button>
    )
}

// ============================================================
// Modal / Dialog
// ============================================================

export function Modal({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    size = 'md',
}: {
    open: boolean
    onClose: () => void
    title?: ReactNode
    description?: ReactNode
    children: ReactNode
    footer?: ReactNode
    size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
    const sizeClass = {
        sm: 'max-w-sm',
        md: 'max-w-lg',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
    }[size]

    useEffect(() => {
        if (!open) return
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [open, onClose])

    if (!open) return null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
            {/* Backdrop */}
            <div className="absolute inset-0 bg-[#22202a]/60" />
            {/* Dialog */}
            <div
                className={classes(
                    'relative w-full rounded-[24px] border border-[#e9e4f2] bg-white shadow-[0_32px_70px_rgba(27,24,38,0.22)]',
                    sizeClass,
                )}
                onClick={(e) => e.stopPropagation()}
            >
                {(title || description) && (
                    <div className="border-b border-[#e9e4f2] px-6 py-4">
                        {title && <h2 className="text-lg font-semibold text-[#17171f]">{title}</h2>}
                        {description && <p className="mt-1 text-sm text-[#8e899b]">{description}</p>}
                    </div>
                )}
                <div className="max-h-[65vh] overflow-y-auto px-6 py-5">{children}</div>
                {footer && (
                    <div className="flex items-center justify-end gap-2.5 border-t border-[#e9e4f2] px-6 py-4">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    )
}

// ============================================================
// Data Table
// ============================================================

interface Column<T> {
    key: string
    header: ReactNode
    render: (row: T, index: number) => ReactNode
    width?: string
    sortable?: boolean
    align?: 'left' | 'center' | 'right'
}

export function DataTable<T extends { id?: number | string }>({
    columns,
    data,
    emptyIcon,
    emptyTitle,
    emptySubtitle,
    selectable,
    selectedIds,
    onSelectionChange,
    onRowClick,
    className,
    maxHeight,
    stickyHeader,
}: {
    columns: Column<T>[]
    data: T[]
    emptyIcon?: LucideIcon
    emptyTitle?: string
    emptySubtitle?: string
    selectable?: boolean
    selectedIds?: Set<number | string>
    onSelectionChange?: (ids: Set<number | string>) => void
    onRowClick?: (row: T) => void
    className?: string
    maxHeight?: string
    stickyHeader?: boolean
}) {
    if (data.length === 0 && emptyIcon) {
        return <EmptyState icon={emptyIcon} title={emptyTitle || 'Không có dữ liệu'} subtitle={emptySubtitle} />
    }

    const allSelected = selectable && data.length > 0 && data.every(r => r.id !== undefined && selectedIds?.has(r.id))

    const toggleAll = () => {
        if (!onSelectionChange) return
        if (allSelected) {
            onSelectionChange(new Set())
        } else {
            onSelectionChange(new Set(data.map(r => r.id!).filter(id => id !== undefined)))
        }
    }

    const toggleRow = (id: number | string) => {
        if (!onSelectionChange || !selectedIds) return
        const next = new Set(selectedIds)
        if (next.has(id)) { next.delete(id) } else { next.add(id) }
        onSelectionChange(next)
    }

    return (
        <div
            className={classes('overflow-hidden rounded-[20px] border border-[#e9e4f2]', className)}
            style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
        >
            <table className="w-full text-left text-sm">
                <thead className={stickyHeader ? 'sticky top-0 z-10' : ''}>
                    <tr className="bg-[#f4f1fa]">
                        {selectable && (
                            <th className="w-10 px-3 py-3">
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    onChange={toggleAll}
                                    className="h-4 w-4 rounded accent-[#8d74e8]"
                                />
                            </th>
                        )}
                        {columns.map((col) => (
                            <th
                                key={col.key}
                                className={classes(
                                    'px-4 py-3 text-xs font-bold uppercase tracking-wider text-[#6d6678]',
                                    col.align === 'center' && 'text-center',
                                    col.align === 'right' && 'text-right',
                                )}
                                style={col.width ? { width: col.width } : undefined}
                            >
                                {col.header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.map((row, i) => (
                        <tr
                            key={row.id !== undefined ? String(row.id) : i}
                            className={classes(
                                'border-t border-[#f0ecf7] bg-white transition-colors hover:bg-[#f8f6fc]',
                                onRowClick && 'cursor-pointer',
                            )}
                            onClick={() => onRowClick?.(row)}
                        >
                            {selectable && row.id !== undefined && (
                                <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                    <input
                                        type="checkbox"
                                        checked={selectedIds?.has(row.id) ?? false}
                                        onChange={() => toggleRow(row.id!)}
                                        className="h-4 w-4 rounded accent-[#8d74e8]"
                                    />
                                </td>
                            )}
                            {columns.map((col) => (
                                <td
                                    key={col.key}
                                    className={classes(
                                        'px-4 py-3 text-[#5f5a6d]',
                                        col.align === 'center' && 'text-center',
                                        col.align === 'right' && 'text-right',
                                    )}
                                >
                                    {col.render(row, i)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

// ============================================================
// Pagination
// ============================================================

export function Pagination({
    page,
    totalPages,
    onPageChange,
    className,
}: {
    page: number
    totalPages: number
    onPageChange: (page: number) => void
    className?: string
}) {
    if (totalPages <= 1) return null

    return (
        <div className={classes('flex items-center justify-center gap-1', className)}>
            <button
                type="button"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#e9e4f2] bg-white text-[#6f697c] disabled:opacity-40 hover:bg-[#f4f1fa]"
            >
                <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-3 text-sm font-medium text-[#6f697c]">
                {page} / {totalPages}
            </span>
            <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => onPageChange(page + 1)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#e9e4f2] bg-white text-[#6f697c] disabled:opacity-40 hover:bg-[#f4f1fa]"
            >
                <ChevronRight className="h-4 w-4" />
            </button>
        </div>
    )
}

// ============================================================
// Card Grid — responsive grid wrapper
// ============================================================

export function CardGrid({
    children,
    cols = 3,
    className,
}: {
    children: ReactNode
    cols?: 1 | 2 | 3 | 4
    className?: string
}) {
    const gridCols = {
        1: 'grid-cols-1',
        2: 'grid-cols-1 sm:grid-cols-2',
        3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
        4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
    }[cols]

    return (
        <div className={classes('grid gap-4', gridCols, className)}>
            {children}
        </div>
    )
}

// ============================================================
// Stat Row — horizontal row of StatCards
// ============================================================

export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={classes('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5', className)}>
            {children}
        </div>
    )
}

// ============================================================
// Select
// ============================================================

export function Select<T extends string>({
    value,
    onChange,
    options,
    placeholder,
    className,
}: {
    value: T | ''
    onChange: (value: T) => void
    options: Array<{ value: T; label: string }>
    placeholder?: string
    className?: string
}) {
    return (
        <div className={classes('relative', className)}>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
                className="h-10 w-full appearance-none rounded-full border border-[#e9e4f2] bg-white pl-4 pr-10 text-sm font-medium text-[#17171f] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15"
            >
                {placeholder && <option value="">{placeholder}</option>}
                {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#908a9e]" />
        </div>
    )
}

// ============================================================
// TextInput
// ============================================================

export function TextInput({
    value,
    onChange,
    placeholder,
    type = 'text',
    className,
    icon: Icon,
    ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
    value: string
    onChange: (value: string) => void
    icon?: LucideIcon
}) {
    return (
        <div className={classes('relative', className)}>
            {Icon && <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#908a9e]" />}
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className={classes(
                    'h-10 w-full rounded-[16px] border border-[#e9e4f2] bg-white text-sm text-[#17171f] placeholder:text-[#908a9e] focus:border-[#cbbff3] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/15',
                    Icon ? 'pl-10 pr-4' : 'px-4',
                )}
                {...props}
            />
        </div>
    )
}

// ============================================================
// Divider
// ============================================================

export function Divider({ className }: { className?: string }) {
    return <hr className={classes('border-t border-[#e9e4f2]', className)} />
}

// ============================================================
// Mini Sparkline SVG (for stat cards)
// ============================================================

export function Sparkline({
    data,
    tone = 'violet',
    width = 80,
    height = 28,
}: {
    data: number[]
    tone?: Tone
    width?: number
    height?: number
}) {
    if (data.length < 2) return null

    const max = Math.max(...data)
    const min = Math.min(...data)
    const range = max - min || 1
    const step = width / (data.length - 1)

    const points = data.map((v, i) => `${i * step},${height - ((v - min) / range) * height}`).join(' ')

    const colorMap: Record<Tone, string> = {
        violet: '#8d74e8', blue: '#3b82f6', cyan: '#06b6d4', amber: '#f59e0b',
        emerald: '#10b981', slate: '#64748b', rose: '#f43f5e',
    }

    return (
        <svg width={width} height={height} className="shrink-0">
            <polyline
                points={points}
                fill="none"
                stroke={colorMap[tone]}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

function getButtonColor(tone: Tone, variant: 'solid' | 'quiet' | 'dark') {
    if (variant === 'dark') {
        return 'bg-[#232229] text-white shadow-[0_12px_24px_rgba(35,34,41,0.18)] hover:bg-[#34323b]'
    }

    if (variant === 'quiet') {
        return 'border border-[#eceaf2] bg-white text-[#272530] shadow-sm hover:bg-[#f7f5fb]'
    }

    return `${toneStyles[tone].button} shadow-[0_14px_26px_rgba(141,116,232,0.24)]`
}

export type { Tone }
