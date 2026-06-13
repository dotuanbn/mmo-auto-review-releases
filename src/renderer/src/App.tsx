import { useState, useEffect } from 'react'
import { AppShell } from './components/layout/AppShell'
import { Dashboard } from './pages/Dashboard'
import { Accounts } from './pages/Accounts'
import { Locations } from './pages/Locations'
import { Campaigns } from './pages/Campaigns'
import { Traffic } from './pages/Traffic'
import { History } from './pages/History'
import { Settings } from './pages/Settings'
import { ContentManager } from './pages/ContentManager'
import { Analytics } from './pages/Analytics'
import { AIHub } from './pages/AIHub'
import { useForegroundRecovery } from './hooks/useForegroundRecovery'
import { type Page } from './app/navigation'

function App() {
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
            {renderPage()}
        </AppShell>
    )
}

export default App
