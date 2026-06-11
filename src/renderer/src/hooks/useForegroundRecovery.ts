import { useEffect, useRef } from 'react'
import { formatUnknownError, reportRendererEvent } from '../utils/rendererDiagnostics'

interface RunningStatus {
    isRunning?: boolean
}

function isRunningStatus(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
        return false
    }
    return (value as RunningStatus).isRunning === true
}

async function hasActiveForegroundWork(): Promise<boolean> {
    const [automation, trafficBoost] = await Promise.allSettled([
        window.electronAPI.automation.getStatus(),
        window.electronAPI.trafficBoost.getStatus(),
    ])

    return (
        (automation.status === 'fulfilled' && isRunningStatus(automation.value)) ||
        (trafficBoost.status === 'fulfilled' && isRunningStatus(trafficBoost.value))
    )
}

function shouldRecoverRenderer(lastHiddenAt: number, lastRecoveredAt: number): boolean {
    if (document.visibilityState !== 'visible') {
        return false
    }

    const hiddenDurationMs = lastHiddenAt > 0 ? Date.now() - lastHiddenAt : 0
    const recoveredRecently = Date.now() - lastRecoveredAt < 10_000

    return hiddenDurationMs >= 1_500 && !recoveredRecently
}

export function useForegroundRecovery(): void {
    const lastHiddenAtRef = useRef(0)
    const lastRecoveredAtRef = useRef(0)

    useEffect(() => {
        void reportRendererEvent('Renderer boot complete')

        const requestRecovery = async (reason: string): Promise<void> => {
            if (!shouldRecoverRenderer(lastHiddenAtRef.current, lastRecoveredAtRef.current)) {
                return
            }

            const hasActiveWork = await hasActiveForegroundWork()
            if (!hasActiveWork) {
                return
            }

            lastRecoveredAtRef.current = Date.now()
            await reportRendererEvent(`Foreground recovery requested: ${reason}`)
            await window.electronAPI.reloadWindow(reason)
        }

        const handleVisibilityChange = (): void => {
            if (document.visibilityState === 'hidden') {
                lastHiddenAtRef.current = Date.now()
                return
            }

            void requestRecovery('visibility_visible')
        }

        const handleFocus = (): void => {
            void requestRecovery('window_focus')
        }

        const handleError = (event: ErrorEvent): void => {
            const message = event.error ? formatUnknownError(event.error) : (event.message || 'Unknown renderer error')
            void reportRendererEvent(`window.error: ${message}`, 'error')
        }

        const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
            void reportRendererEvent(`unhandledrejection: ${formatUnknownError(event.reason)}`, 'error')
        }

        window.addEventListener('focus', handleFocus)
        window.addEventListener('error', handleError)
        window.addEventListener('unhandledrejection', handleUnhandledRejection)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleFocus)
            window.removeEventListener('error', handleError)
            window.removeEventListener('unhandledrejection', handleUnhandledRejection)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [])
}
