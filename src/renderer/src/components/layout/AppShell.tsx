import { type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { type Page } from '../../app/navigation'

interface AppShellProps {
    currentPage: Page
    onPageChange: (page: Page) => void
    children: ReactNode
}

export function AppShell({ currentPage, onPageChange, children }: AppShellProps) {
    return (
        <div className="app-shell h-screen min-h-0 overflow-hidden text-[#1f1f28]">
            <div className="app-frame flex h-full min-h-0 w-full flex-col overflow-hidden bg-white lg:flex-row">
                <Sidebar currentPage={currentPage} onPageChange={onPageChange} />
                <main className="app-workspace min-h-0 min-w-0 flex-1 overflow-auto">
                    {children}
                </main>
            </div>
        </div>
    )
}
