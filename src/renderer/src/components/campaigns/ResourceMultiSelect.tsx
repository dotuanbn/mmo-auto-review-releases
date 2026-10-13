import { type LucideIcon } from 'lucide-react'

export interface ResourceOption {
    id: number
    label: string
    sublabel?: string
    /** Optional status badge text (e.g. active / dead) */
    badge?: string
    badgeTone?: 'emerald' | 'rose' | 'amber' | 'slate'
}

export interface ResourceMultiSelectProps {
    title: string
    /** e.g. "3 selected / 12 available" */
    countLabel: string
    options: ResourceOption[]
    selectedIds: number[]
    onChange: (ids: number[]) => void
    /** Shown when nothing selected — empty = use full pool */
    emptyPoolHint: string
    noOptionsLabel: string
    selectAllLabel: string
    clearLabel: string
    icon?: LucideIcon
    maxHeightClassName?: string
}

const badgeToneClass: Record<NonNullable<ResourceOption['badgeTone']>, string> = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60',
    rose: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/60',
    amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/40',
    slate: 'bg-[#f4f1fa] text-[#5f5a6d] border-[#e9e4f2] dark:bg-[#2a2540] dark:text-[#c8c0d8] dark:border-[#3d3558]',
}

export function ResourceMultiSelect({
    title,
    countLabel,
    options,
    selectedIds,
    onChange,
    emptyPoolHint,
    noOptionsLabel,
    selectAllLabel,
    clearLabel,
    icon: Icon,
    maxHeightClassName = 'max-h-40',
}: ResourceMultiSelectProps) {
    const selectedSet = new Set(selectedIds)
    const allSelected = options.length > 0 && selectedIds.length === options.length
    const isEmptySelection = selectedIds.length === 0

    const toggle = (id: number, checked: boolean) => {
        if (checked) {
            onChange(selectedIds.includes(id) ? selectedIds : [...selectedIds, id])
            return
        }
        onChange(selectedIds.filter((item) => item !== id))
    }

    const selectAll = () => {
        onChange(options.map((opt) => opt.id))
    }

    const clear = () => {
        onChange([])
    }

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <label className="block text-sm font-semibold text-[#24222c] dark:text-[#f0ecff]">
                    {Icon && <Icon className="w-3.5 h-3.5 inline mr-1 text-[#8d74e8]" />}
                    {title}
                    <span className="ml-2 text-[#8d74e8] font-normal">{countLabel}</span>
                </label>
                {options.length > 0 && (
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={selectAll}
                            className="text-xs text-[#8d74e8] hover:text-[#735bd6] font-semibold"
                        >
                            {selectAllLabel}
                        </button>
                        <button
                            type="button"
                            onClick={clear}
                            className="text-xs text-[#908a9e] dark:text-[#9a8fba] hover:text-[#5f5a6d] dark:hover:text-[#c8c0d8] font-semibold"
                        >
                            {clearLabel}
                        </button>
                    </div>
                )}
            </div>

            {isEmptySelection && options.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/40 rounded-[12px] px-3 py-2 mb-2">
                    {emptyPoolHint}
                </p>
            )}

            <div
                className={`${maxHeightClassName} overflow-y-auto bg-[#f7f7f9] dark:bg-[#111019] rounded-[16px] p-2 space-y-1 border border-[#e9e4f2] dark:border-[#3d3558]`}
            >
                {options.length === 0 ? (
                    <div className="p-3 text-center text-sm text-[#908a9e] dark:text-[#9a8fba]">{noOptionsLabel}</div>
                ) : (
                    options.map((opt) => {
                        const checked = selectedSet.has(opt.id)
                        return (
                            <label
                                key={opt.id}
                                className={`flex items-center gap-3 p-2.5 rounded-[12px] cursor-pointer transition-colors ${
                                    checked
                                        ? 'bg-[#f4f0ff] dark:bg-[#2a2540] border border-[#e6e0fb] dark:border-[#3d3558]'
                                        : 'hover:bg-white dark:hover:bg-[#352f4a] border border-transparent'
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => toggle(opt.id, e.target.checked)}
                                    className="h-4 w-4 rounded accent-[#8d74e8] shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm text-[#17171f] dark:text-[#f0ecff] truncate" title={opt.label}>{opt.label}</div>
                                    {opt.sublabel && (
                                        <div className="text-xs text-[#908a9e] dark:text-[#9a8fba] truncate" title={opt.sublabel}>{opt.sublabel}</div>
                                    )}
                                </div>
                                {opt.badge && (
                                    <span
                                        className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0 ${
                                            badgeToneClass[opt.badgeTone || 'slate']
                                        }`}
                                    >
                                        {opt.badge}
                                    </span>
                                )}
                            </label>
                        )
                    })
                )}
            </div>

            {allSelected && options.length > 0 && (
                <p className="text-xs text-[#908a9e] dark:text-[#9a8fba] mt-1.5">
                    {selectAllLabel} — {options.length}
                </p>
            )}
        </div>
    )
}
