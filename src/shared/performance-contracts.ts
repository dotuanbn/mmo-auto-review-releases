/** Public resource counters. No profiles, credentials or process command lines. */
export interface PerformanceSnapshot {
    enabled: boolean
    activeContexts: number
    queuedLaunches: number
    maxContexts: number | null
    freeMemoryMB: number
    totalMemoryMB: number
    memoryPressure: boolean
}

export const LOW_RESOURCE_LIMITS = {
    memoryWarningMB: 768,
    memoryRecoveryMB: 1280,
    browserIdleMs: 30_000,
} as const
