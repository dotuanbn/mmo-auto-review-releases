import { useState, useEffect, lazy, Suspense } from 'react'
import { AppShell } from './components/layout/AppShell'
import { Dashboard } from './pages/Dashboard'
import { useForegroundRecovery } from './hooks/useForegroundRecovery'
import { type Page } from './app/navigation'
import { useTranslation } from './i18n'

// Load tools only when opened, reducing startup parsing and retained UI modules.
const Accounts = lazy(() => import('./pages/Accounts').then(module => ({ default: module.Accounts })))
const Locations = lazy(() => import('./pages/Locations').then(module => ({ default: module.Locations })))
const Campaigns = lazy(() => import('./pages/Campaigns').then(module => ({ default: module.Campaigns })))
const Traffic = lazy(() => import('./pages/Traffic').then(module => ({ default: module.Traffic })))
const History = lazy(() => import('./pages/History').then(module => ({ default: module.History })))
const Settings = lazy(() => import('./pages/Settings').then(module => ({ default: module.Settings })))
const ContentManager = lazy(() => import('./pages/ContentManager').then(module => ({ default: module.ContentManager })))
const Analytics = lazy(() => import('./pages/Analytics').then(module => ({ default: module.Analytics })))
const AIHub = lazy(() => import('./pages/AIHub').then(module => ({ default: module.AIHub })))

function App() {
    const { t } = useTranslation()
    const [currentPage, setCurrentPage] = useState<Page>('dashboard')
    useForegroundRecovery()

    // Problem 1 fix: on app mount (or return), if traffic campaign running or paused in DB/engine, auto-nav to Traffic + monitor view
    useEffect(() => {
        const checkAndRouteToActiveTraffic = async () => {
            try {
                const api: any = (window as any).electronAPI
                const [status, camps] = await Promise.all([
                    api?.trafficBoost?.getStatus ? api.trafficBoost.getStatus() : null,
                    api?.trafficBoost?.getCampaigns ? api.trafficBoost.getCampaigns() : null,
                ])
                const hasActive = !!status && (status.isRunning || status.isPaused)
                const hasPausedOrRunningCamp = Array.isArray(camps) && camps.some((c: any) => c && (c.status === 'running' || c.status === 'paused'))
                if ((hasActive || hasPausedOrRunningCamp) && currentPage === 'dashboard') {
                    setCurrentPage('traffic')
                }
            } catch { /* non-fatal on boot */ }
        }
        void checkAndRouteToActiveTraffic()
    }, []) // mount only; status inside Traffic will further force 'monitor' tab if active

    const renderPage = () => {
        switch (currentPage) {
            case 'dashboard':
                return <Dashboard onNavigate={setCurrentPage} />
            case 'accounts':
                return <Accounts />
            case 'locations':
                return <Locations />
            case 'campaigns':
                return <Campaigns />
            case 'content':
                return <ContentManager />
            case 'traffic':
                return <Traffic />
            case 'history':
                return <History />
            case 'settings':
                return <Settings />
            case 'analytics':
                return <Analytics />
            case 'aihub':
                return <AIHub />
            default:
                return <Dashboard />
        }
    }

    return (
        <AppShell currentPage={currentPage} onPageChange={setCurrentPage}>
            <Suspense fallback={<div className="p-6 text-sm" role="status">{t('common.loading')}</div>}>
                {renderPage()}
            </Suspense>
        </AppShell>
    )
}

export default App
