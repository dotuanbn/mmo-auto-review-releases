import {
    BarChart3,
    Brain,
    Film,
    History,
    LayoutDashboard,
    MapPin,
    Settings,
    Star,
    TrendingUp,
    Users,
    type LucideIcon,
} from 'lucide-react'

export type Page =
    | 'dashboard'
    | 'accounts'
    | 'locations'
    | 'campaigns'
    | 'content'
    | 'traffic'
    | 'history'
    | 'settings'
    | 'analytics'
    | 'aihub'

export type NavTone = 'blue' | 'cyan' | 'amber' | 'emerald' | 'violet' | 'slate'

export interface NavigationItem {
    id: Page
    labelKey: string
    icon: LucideIcon
    tone: NavTone
}

export interface NavigationSection {
    titleKey: string
    items: NavigationItem[]
}

export const navigationSections: NavigationSection[] = [
    {
        titleKey: 'sidebar.sections.overview',
        items: [
            { id: 'dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard, tone: 'blue' },
        ],
    },
    {
        titleKey: 'sidebar.sections.resources',
        items: [
            { id: 'accounts', labelKey: 'sidebar.accounts', icon: Users, tone: 'slate' },
            { id: 'locations', labelKey: 'sidebar.locations', icon: MapPin, tone: 'slate' },
            { id: 'content', labelKey: 'sidebar.contentScripts', icon: Film, tone: 'emerald' },
        ],
    },
    {
        titleKey: 'sidebar.sections.growth',
        items: [
            { id: 'campaigns', labelKey: 'sidebar.campaigns', icon: Star, tone: 'amber' },
            { id: 'traffic', labelKey: 'sidebar.traffic', icon: TrendingUp, tone: 'cyan' },
        ],
    },
    {
        titleKey: 'sidebar.sections.system',
        items: [
            { id: 'aihub', labelKey: 'sidebar.aihub', icon: Brain, tone: 'emerald' },
            { id: 'analytics', labelKey: 'sidebar.analytics', icon: BarChart3, tone: 'violet' },
            { id: 'history', labelKey: 'sidebar.history', icon: History, tone: 'slate' },
            { id: 'settings', labelKey: 'sidebar.settings', icon: Settings, tone: 'slate' },
        ],
    },
]

export function findNavigationItem(page: Page): NavigationItem | undefined {
    return navigationSections.flatMap((section) => section.items).find((item) => item.id === page)
}
