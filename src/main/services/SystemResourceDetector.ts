import * as os from 'os'
import { getRuntimeLogger } from '../utils/runtimeLogger'

const logProxy = getRuntimeLogger({ module: 'system-resource' })

export type SystemProfile = 'low' | 'medium' | 'high'

export interface ResourceRecommendation {
    profile: SystemProfile
    maxSafeThreads: number
    queueConcurrency: number
    staggerDelayMs: number
}

class SystemResourceDetector {
    // 1GB in bytes
    private readonly GB = 1024 * 1024 * 1024

    private getTotalRamGB(): number {
        return os.totalmem() / this.GB
    }

    private getFreeRamGB(): number {
        return os.freemem() / this.GB
    }

    private getCpuCores(): number {
        return os.cpus().length
    }

    /**
     * Determines the system profile based on total RAM and CPU cores.
     */
    getSystemProfile(): SystemProfile {
        const ramGB = this.getTotalRamGB()
        const cores = this.getCpuCores()

        if (ramGB <= 4.5 || cores <= 2) {
            return 'low'
        }
        if (ramGB <= 8.5 || cores <= 4) {
            return 'medium'
        }
        return 'high'
    }

    /**
     * Recommends safe limits based on the system profile and current memory.
     */
    getRecommendations(): ResourceRecommendation {
        const profile = this.getSystemProfile()
        const ramGB = this.getTotalRamGB()
        const freeRamGB = this.getFreeRamGB()

        let maxSafeThreads = 3
        let queueConcurrency = 2
        let staggerDelayMs = 2000

        if (profile === 'low') {
            // For 4GB RAM or 2 cores
            maxSafeThreads = 1
            queueConcurrency = 1
            staggerDelayMs = 4000
        } else if (profile === 'medium') {
            // For 8GB RAM or 4 cores
            maxSafeThreads = 3
            queueConcurrency = 2
            staggerDelayMs = 2500
            
            // If running out of RAM, clamp harder
            if (freeRamGB < 1.0) {
                maxSafeThreads = 2
            }
        } else {
            // High spec (16GB+ RAM)
            // Still reasonable defaults, users can override higher
            maxSafeThreads = 8
            queueConcurrency = 3
            staggerDelayMs = 1500
        }

        // Hard clamp based on absolute free memory to prevent crashes
        // A Playwright browser context usually takes 150-300MB.
        if (freeRamGB < 0.8) {
             maxSafeThreads = Math.min(maxSafeThreads, 1)
        } else if (freeRamGB < 1.5) {
             maxSafeThreads = Math.min(maxSafeThreads, 2)
        }

        return {
            profile,
            maxSafeThreads,
            queueConcurrency,
            staggerDelayMs
        }
    }

    /**
     * Clamps the user-requested thread count to safe system limits, logging warnings if exceeded.
     */
    clampThreads(requestedCount: number, context: string = 'Campaign'): number {
        const recs = this.getRecommendations()
        
        if (requestedCount > recs.maxSafeThreads) {
            logProxy.warn(`[WARNING] Configured ${requestedCount} threads for ${context}, but system profile is '${recs.profile}' (Free RAM: ${this.getFreeRamGB().toFixed(1)}GB). Limiting to safe maximum of ${recs.maxSafeThreads} thread(s) to prevent crashes.`)
            return recs.maxSafeThreads
        }
        
        return Math.max(1, requestedCount) // At least 1
    }
    
    logCurrentStats(): void {
        const recs = this.getRecommendations()
        logProxy.info(`[System Stats] Profile: ${recs.profile.toUpperCase()} | CPU Cores: ${this.getCpuCores()} | Total RAM: ${this.getTotalRamGB().toFixed(1)}GB | Free RAM: ${this.getFreeRamGB().toFixed(1)}GB | Safe Threads: ${recs.maxSafeThreads}`)
    }
}

export const systemResourceDetector = new SystemResourceDetector()
