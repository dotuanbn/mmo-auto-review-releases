import { type ComponentType } from 'react'
import { ChevronRight, Map, Moon, ShieldCheck, Sun } from 'lucide-react'
import {
    navigationSections,
    type NavTone,
    type Page,
} from '../../app/navigation'
import { useTranslation } from '../../i18n'
import { useTheme } from '../../contexts/ThemeContext'

interface SidebarProps {
    currentPage: Page
    onPageChange: (page: Page) => void
}

const toneClasses: Record<NavTone, { icon: string }> = {
    blue: { icon: 'text-blue-500' },
    cyan: { icon: 'text-cyan-500' },
    amber: { icon: 'text-amber-500' },
    emerald: { icon: 'text-emerald-500' },
    violet: { icon: 'text-violet-500' },
    slate: { icon: 'text-slate-500' },
}

export function Sidebar({ currentPage, onPageChange }: SidebarProps) {
    const { t } = useTranslation()
    const { isDark, toggleTheme } = useTheme()
    const themeLabel = isDark ? t('common.darkMode', 'Dark mode') : t('common.lightMode', 'Light mode')
    const toggleTitle = isDark ? t('common.switchToLight', 'Switch to light mode') : t('common.switchToDark', 'Switch to dark mode')
    const ThemeIcon = isDark ? Moon : Sun

    return (
        <aside className="app-sidebar flex max-h-[40vh] w-full shrink-0 flex-col border-b border-[#eeeaf8] lg:h-full lg:max-h-none lg:w-[224px] lg:border-b-0 lg:border-r">
            <div className="px-5 pb-4 pt-5 lg:px-6 lg:pt-7">
                <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#8d74e8] text-white shadow-[0_12px_24px_rgba(141,116,232,0.28)]">
                        <Map className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="truncate text-base font-semibold tracking-tight text-[#17171f]">MMO Review</h1>
                        <p className="text-[11px] font-medium text-[#8b8798]">Maps Automation</p>
                    </div>
                    <button
                        type="button"
                        onClick={toggleTheme}
                        aria-label={toggleTitle}
                        title={toggleTitle}
                        className="theme-icon-toggle ml-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#eeeaf8] bg-white text-[#2a2933] shadow-sm transition-all hover:bg-[#f5f2fb] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/40 lg:hidden"
                    >
                        <ThemeIcon className="h-4 w-4" />
                    </button>
                </div>
            </div>

            <nav className="flex-1 space-y-2 overflow-y-auto px-3 pb-3 lg:px-4">
                {navigationSections.map((section) => (
                    <section key={section.titleKey}>
                        <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#b4afc2]">
                            {t(section.titleKey)}
                        </div>
                        <ul className="space-y-1">
                            {section.items.map((item) => (
                                <SidebarItem
                                    key={item.id}
                                    page={item.id}
                                    icon={item.icon}
                                    iconClass={toneClasses[item.tone].icon}
                                    label={t(item.labelKey)}
                                    active={currentPage === item.id}
                                    onSelect={onPageChange}
                                />
                            ))}
                        </ul>
                    </section>
                ))}
            </nav>

            <div className="hidden p-4 pt-1 lg:block">
                <div className="rounded-[20px] bg-[#f6f4fa] p-2.5">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-sm font-semibold text-[#8d74e8] shadow-sm">
                            K
                        </div>
                        <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[#1d1c25]">Kiwi Operator</p>
                            <p className="text-[11px] text-[#8b8798]">Local workspace</p>
                        </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-emerald-600">
                        <ShieldCheck className="h-4 w-4" />
                        {t('common.active')}
                    </div>
                    <button
                        type="button"
                        onClick={toggleTheme}
                        aria-pressed={isDark}
                        title={toggleTitle}
                        className="theme-row-toggle mt-2 flex w-full items-center justify-between gap-3 rounded-full border border-[#eceaf2] bg-white px-3 py-2 text-xs font-semibold text-[#272530] shadow-sm transition-all hover:bg-[#f7f5fb] focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/40"
                    >
                        <span className="inline-flex min-w-0 items-center gap-2">
                            <ThemeIcon className="h-4 w-4 text-[#8d74e8]" />
                            <span className="truncate">{themeLabel}</span>
                        </span>
                        <span className="theme-toggle-track relative h-5 w-9 shrink-0 rounded-full bg-[#ddd8e8]">
                            <span
                                className={[
                                    'theme-toggle-thumb absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                                    isDark ? 'translate-x-[18px]' : 'translate-x-0.5',
                                ].join(' ')}
                            />
                        </span>
                    </button>
                </div>
            </div>
        </aside>
    )
}

function SidebarItem({
    page,
    icon: Icon,
    iconClass,
    label,
    active,
    onSelect,
}: {
    page: Page
    icon: ComponentType<{ className?: string }>
    iconClass: string
    label: string
    active: boolean
    onSelect: (page: Page) => void
}) {
    return (
        <li>
            <button
                type="button"
                onClick={() => onSelect(page)}
                className={[
                    'group flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-200',
                    'focus:outline-none focus:ring-2 focus:ring-[#8d74e8]/40 focus:ring-offset-2 focus:ring-offset-white',
                    active
                        ? 'bg-[#8d74e8] text-white shadow-[0_16px_26px_rgba(141,116,232,0.28)]'
                        : 'text-[#2a2933] hover:bg-[#f5f2fb] hover:text-[#17171f]',
                ].join(' ')}
            >
                <Icon className={['h-[18px] w-[18px] transition-colors', active ? 'text-current' : iconClass].join(' ')} />
                <span className="truncate">{label}</span>
                {active && <ChevronRight className="ml-auto h-4 w-4 text-white/80" />}
            </button>
        </li>
    )
}
