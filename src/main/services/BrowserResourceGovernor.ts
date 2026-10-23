import { freemem, totalmem } from 'node:os'
import { LOW_RESOURCE_LIMITS, type PerformanceSnapshot } from '../../shared/performance-contracts'

export interface BrowserAdmissionOptions {
    signal?: AbortSignal
    shouldAbort?: () => boolean
}

/** A reservation can be consumed once, and cannot release a live browser's slot. */
export class BrowserResourceReservation {
    private state: 'reserved' | 'consumed' | 'released' = 'reserved'
    constructor(private readonly owner: BrowserResourceGovernor, private readonly release: () => void) {}

    consume(owner: BrowserResourceGovernor): () => void {
        if (owner !== this.owner || this.state !== 'reserved') {
            throw new BrowserResourceWaitError('Invalid or already consumed browser reservation')
        }
        this.state = 'consumed'
        return this.release
    }

    releaseUnused(): void {
        if (this.state !== 'reserved') return
        this.state = 'released'
        this.release()
    }
}

export class BrowserResourceWaitError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BrowserResourceWaitError'
    }
}

/** Lifecycle accounting only: low-resource mode never throttles browser work. */
export class BrowserResourceGovernor {
    private enabled = false
    private active = 0
    private pressured = false

    constructor(
        private readonly memory = () => ({ freeMB: freemem() / 1048576, totalMB: totalmem() / 1048576 }),
    ) {}

    isEnabled(): boolean { return this.enabled }

    configure(enabled: boolean): boolean {
        if (enabled === this.enabled) return false
        this.enabled = enabled
        this.pressured = false
        return true
    }

    getSnapshot(): PerformanceSnapshot {
        const memory = this.memory()
        return {
            enabled: this.enabled,
            activeContexts: this.active,
            queuedLaunches: 0,
            maxContexts: null,
            freeMemoryMB: Math.round(memory.freeMB),
            totalMemoryMB: Math.round(memory.totalMB),
            memoryPressure: this.enabled && this.hasMemoryPressure(memory.freeMB),
        }
    }

    async acquire(options: BrowserAdmissionOptions = {}): Promise<() => void> {
        if (options.signal?.aborted || options.shouldAbort?.()) {
            throw new BrowserResourceWaitError('Browser launch cancelled')
        }
        // Admission is immediate even under memory pressure. The campaign and
        // proxy policies, not this optimisation toggle, own concurrency.
        this.active += 1
        let released = false
        return () => {
            if (released) return
            released = true
            this.active = Math.max(0, this.active - 1)
        }
    }

    private hasMemoryPressure(freeMB: number): boolean {
        if (!Number.isFinite(freeMB)) return true
        // Advisory only; hysteresis keeps the RAM warning from flickering.
        this.pressured = this.pressured
            ? freeMB < LOW_RESOURCE_LIMITS.memoryRecoveryMB
            : freeMB < LOW_RESOURCE_LIMITS.memoryWarningMB
        return this.pressured
    }
}

export const browserResourceGovernor = new BrowserResourceGovernor()
