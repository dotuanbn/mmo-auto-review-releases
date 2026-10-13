import { type ReactNode, useCallback } from 'react'
import { Sidebar } from './Sidebar'
import { type Page } from '../../app/navigation'
import { ComplianceBanner, useComplianceQueue } from '../compliance'

interface AppShellProps {
    currentPage: Page
    onPageChange: (page: Page) => void
    children: ReactNode
}

export function AppShell({ currentPage, onPageChange, children }: AppShellProps) {
    const { pending, actingId, approve, reject } = useComplianceQueue()

    const handleOpenCampaigns = useCallback(() => {
        onPageChange('campaigns')
    }, [onPageChange])

    const handleApprove = useCallback(
        (requestId: string) => {
            void approve(requestId)
        },
        [approve]
    )

    const handleReject = useCallback(
        (requestId: string) => {
            void reject(requestId, 'rejected_from_shell')
        },
        [reject]
    )

    return (
        <div className="app-shell h-screen min-h-0 overflow-hidden text-[#1f1f28] dark:text-[#f0ecff]">
            <div className="app-frame flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[#111019] lg:flex-row">
                <Sidebar currentPage={currentPage} onPageChange={onPageChange} />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <ComplianceBanner
                        pending={pending}
                        actingId={actingId}
                        onApprove={handleApprove}
                        onReject={handleReject}
                        onOpenCampaigns={handleOpenCampaigns}
                    />
                    <main className="app-workspace min-h-0 min-w-0 flex-1 overflow-auto">
                        {children}
                    </main>
                </div>
            </div>
        </div>
    )
}
