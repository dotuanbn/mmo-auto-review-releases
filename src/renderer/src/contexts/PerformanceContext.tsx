import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const PerformanceContext = createContext(false)

export function PerformanceProvider({ children }: { children: ReactNode }) {
    const [enabled, setEnabled] = useState(false)
    useEffect(() => {
        let disposed = false
        let changed = false
        const unsubscribe = window.electronAPI?.performance?.onChanged((value) => {
            changed = true
            if (!disposed) setEnabled(value)
        })
        void window.electronAPI?.settings.get('lowResourceMode').then((value) => {
            if (!disposed && !changed) setEnabled(value === true)
        }).catch((error: unknown) => console.error('Failed to load performance mode:', error))
        return () => { disposed = true; unsubscribe?.() }
    }, [])

    useEffect(() => {
        document.documentElement.dataset.lowResourceMode = String(enabled)
    }, [enabled])

    return <PerformanceContext.Provider value={enabled}>{children}</PerformanceContext.Provider>
}

export const useLowResourceMode = () => useContext(PerformanceContext)
