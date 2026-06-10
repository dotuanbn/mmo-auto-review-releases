import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { browserService } from '../automation/BrowserService'
import { runtimeCore } from '../runtime/v2/runtimeCore'
import { dataRootService } from './DataRootService'
import { getRuntimeLogger } from '../utils/runtimeLogger'

export interface SoakTestStartInput {
    durationHours?: number
    intervalSeconds?: number
    tag?: string
}

export interface SoakTestStatus {
    running: boolean
    sessionId: string | null
    startedAt: string | null
    endsAt: string | null
    durationHours: number
    intervalSeconds: number
    sampleCount: number
    logPath: string | null
    summaryPath: string | null
    lastSnapshotAt: string | null
    stopReason: string | null
}

type SoakSession = {
    id: string
    startedAt: string
    endsAt: string
    durationHours: number
    intervalSeconds: number
    logPath: string
    summaryPath: string
    tag?: string
}

type SoakAggregate = {
    samples: number
    sumRssMb: number
    sumHeapMb: number
    sumTabCount: number
    sumContextCount: number
    sumActiveThreads: number
    maxRssMb: number
    maxHeapMb: number
    maxAppWorkingSetMb: number
    maxTabCount: number
    maxBrowserContextCount: number
    maxRuntimeContextCount: number
    maxActiveThreads: number
    maxQueueDepth: number
}

function nowIso(): string {
    return new Date().toISOString()
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}

class SoakTestService {
    private readonly logger = getRuntimeLogger({ module: 'soak-test' })
    private timer: NodeJS.Timeout | null = null
    private stopTimer: NodeJS.Timeout | null = null
    private samplingInProgress = false
    private session: SoakSession | null = null
    private aggregate: SoakAggregate | null = null
    private lastSnapshotAt: string | null = null
    private lastStopReason: string | null = null

    private getLogsDir(): string {
        const root = dataRootService.getDataRoot()
        const dir = join(root, 'logs', 'soak-tests')
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }
        return dir
    }

    private initAggregate(): SoakAggregate {
        return {
            samples: 0,
            sumRssMb: 0,
            sumHeapMb: 0,
            sumTabCount: 0,
            sumContextCount: 0,
            sumActiveThreads: 0,
            maxRssMb: 0,
            maxHeapMb: 0,
            maxAppWorkingSetMb: 0,
            maxTabCount: 0,
            maxBrowserContextCount: 0,
            maxRuntimeContextCount: 0,
            maxActiveThreads: 0,
            maxQueueDepth: 0,
        }
    }

    private appendLine(logPath: string, payload: Record<string, unknown>): void {
        appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8')
    }

    private getCpuUsageMicros(): { user: number; system: number } {
        const usage = process.cpuUsage()
        return {
            user: usage.user,
            system: usage.system,
        }
    }

    private getElectronProcessMetrics() {
        const metrics = app.getAppMetrics()
        let totalWorkingSetKb = 0
        let totalPrivateKb = 0

        for (const item of metrics) {
            const memory = item.memory
            if (!memory) {
                continue
            }
            totalWorkingSetKb += memory.workingSetSize || 0
            totalPrivateKb += memory.privateBytes || 0
        }

        return {
            processCount: metrics.length,
            totalWorkingSetMb: Number((totalWorkingSetKb / 1024).toFixed(2)),
            totalPrivateMb: Number((totalPrivateKb / 1024).toFixed(2)),
        }
    }

    private async writeSample(): Promise<void> {
        if (!this.session || !this.aggregate) {
            return
        }
        if (this.samplingInProgress) {
            return
        }
        this.samplingInProgress = true
        try {
            const timestamp = nowIso()
            const [status, diagnostics] = await Promise.all([
                runtimeCore.getStatusV2(),
                runtimeCore.getDiagnostics(),
            ])
            const browserStats = browserService.getRuntimeStats()
            const memory = process.memoryUsage()
            const cpuMicros = this.getCpuUsageMicros()
            const electronMetrics = this.getElectronProcessMetrics()

            const rssMb = Number((memory.rss / (1024 * 1024)).toFixed(2))
            const heapUsedMb = Number((memory.heapUsed / (1024 * 1024)).toFixed(2))

            const sample = {
                type: 'sample',
                timestamp,
                sessionId: this.session.id,
                campaignId: status.campaignId,
                campaignName: status.campaignName,
                running: status.isRunning,
                status: {
                    currentRound: status.currentRound,
                    totalRounds: status.totalRounds,
                    activeThreads: status.activeThreads,
                    completedVisits: status.completedVisits,
                    totalVisits: status.totalVisits,
                    failedVisits: status.failedVisits,
                    networkMode: status.effectiveNetworkMode,
                },
                runtimeDiagnostics: diagnostics,
                browser: browserStats,
                processMemoryMb: {
                    rss: rssMb,
                    heapTotal: Number((memory.heapTotal / (1024 * 1024)).toFixed(2)),
                    heapUsed: heapUsedMb,
                    external: Number((memory.external / (1024 * 1024)).toFixed(2)),
                    arrayBuffers: Number((((memory as any).arrayBuffers || 0) / (1024 * 1024)).toFixed(2)),
                },
                cpuUsageMicros: cpuMicros,
                electronMetrics,
                queueDepth: diagnostics.queueDepth,
                contextCount: diagnostics.activeContexts,
                tabCount: browserStats.totalTabCount,
            }

            this.appendLine(this.session.logPath, sample)
            this.lastSnapshotAt = timestamp

            this.aggregate.samples += 1
            this.aggregate.sumRssMb += rssMb
            this.aggregate.sumHeapMb += heapUsedMb
            this.aggregate.sumTabCount += browserStats.totalTabCount
            this.aggregate.sumContextCount += browserStats.contextCount
            this.aggregate.sumActiveThreads += status.activeThreads
            this.aggregate.maxRssMb = Math.max(this.aggregate.maxRssMb, rssMb)
            this.aggregate.maxHeapMb = Math.max(this.aggregate.maxHeapMb, heapUsedMb)
            this.aggregate.maxAppWorkingSetMb = Math.max(this.aggregate.maxAppWorkingSetMb, electronMetrics.totalWorkingSetMb)
            this.aggregate.maxTabCount = Math.max(this.aggregate.maxTabCount, browserStats.totalTabCount)
            this.aggregate.maxBrowserContextCount = Math.max(this.aggregate.maxBrowserContextCount, browserStats.contextCount)
            this.aggregate.maxRuntimeContextCount = Math.max(this.aggregate.maxRuntimeContextCount, diagnostics.activeContexts)
            this.aggregate.maxActiveThreads = Math.max(this.aggregate.maxActiveThreads, status.activeThreads)
            this.aggregate.maxQueueDepth = Math.max(this.aggregate.maxQueueDepth, diagnostics.queueDepth)
        } catch (error: unknown) {
            if (this.session) {
                this.appendLine(this.session.logPath, {
                    type: 'sample_error',
                    timestamp: nowIso(),
                    sessionId: this.session.id,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
            this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'soak sample failed')
        } finally {
            this.samplingInProgress = false
        }
    }

    private writeSummary(reason: string): void {
        if (!this.session || !this.aggregate) {
            return
        }
        const endedAt = nowIso()
        const samples = Math.max(1, this.aggregate.samples)
        const summary = {
            sessionId: this.session.id,
            startedAt: this.session.startedAt,
            endedAt,
            plannedEndAt: this.session.endsAt,
            durationHours: this.session.durationHours,
            intervalSeconds: this.session.intervalSeconds,
            stopReason: reason,
            sampleCount: this.aggregate.samples,
            averages: {
                rssMb: Number((this.aggregate.sumRssMb / samples).toFixed(2)),
                heapUsedMb: Number((this.aggregate.sumHeapMb / samples).toFixed(2)),
                tabCount: Number((this.aggregate.sumTabCount / samples).toFixed(2)),
                browserContextCount: Number((this.aggregate.sumContextCount / samples).toFixed(2)),
                activeThreads: Number((this.aggregate.sumActiveThreads / samples).toFixed(2)),
            },
            peaks: {
                rssMb: this.aggregate.maxRssMb,
                heapUsedMb: this.aggregate.maxHeapMb,
                appWorkingSetMb: this.aggregate.maxAppWorkingSetMb,
                tabCount: this.aggregate.maxTabCount,
                browserContextCount: this.aggregate.maxBrowserContextCount,
                runtimeContextCount: this.aggregate.maxRuntimeContextCount,
                activeThreads: this.aggregate.maxActiveThreads,
                queueDepth: this.aggregate.maxQueueDepth,
            },
            logPath: this.session.logPath,
        }

        writeFileSync(this.session.summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        this.appendLine(this.session.logPath, {
            type: 'session_end',
            timestamp: endedAt,
            sessionId: this.session.id,
            summaryPath: this.session.summaryPath,
            stopReason: reason,
            sampleCount: this.aggregate.samples,
        })
    }

    start(input: SoakTestStartInput = {}): SoakTestStatus {
        if (this.session) {
            return this.getStatus()
        }

        const durationHours = clamp(Math.floor(input.durationHours ?? 8), 1, 72)
        const intervalSeconds = clamp(Math.floor(input.intervalSeconds ?? 30), 5, 600)
        const startedAt = nowIso()
        const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()
        const sessionId = `soak-${startedAt.replace(/[:.]/g, '-')}`
        const logsDir = this.getLogsDir()
        const suffix = (input.tag || 'default').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'default'
        const base = `${sessionId}-${suffix}`
        const logPath = join(logsDir, `${base}.ndjson`)
        const summaryPath = join(logsDir, `${base}.summary.json`)

        this.session = {
            id: sessionId,
            startedAt,
            endsAt,
            durationHours,
            intervalSeconds,
            logPath,
            summaryPath,
            tag: input.tag,
        }
        this.aggregate = this.initAggregate()
        this.lastSnapshotAt = null
        this.lastStopReason = null

        this.appendLine(logPath, {
            type: 'session_start',
            timestamp: startedAt,
            sessionId,
            durationHours,
            intervalSeconds,
            endsAt,
            logPath,
            summaryPath,
            tag: input.tag || null,
        })

        this.timer = setInterval(() => {
            void this.writeSample()
        }, intervalSeconds * 1000)
        this.stopTimer = setTimeout(() => {
            this.stop('duration_reached')
        }, durationHours * 60 * 60 * 1000)

        void this.writeSample()

        this.logger.info({
            event: 'soak_test_started',
            sessionId,
            durationHours,
            intervalSeconds,
            logPath,
            summaryPath,
        })

        return this.getStatus()
    }

    stop(reason: string = 'manual_stop'): SoakTestStatus {
        if (!this.session) {
            return this.getStatus()
        }

        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        if (this.stopTimer) {
            clearTimeout(this.stopTimer)
            this.stopTimer = null
        }

        this.writeSummary(reason)
        this.lastStopReason = reason

        this.logger.info({
            event: 'soak_test_stopped',
            sessionId: this.session.id,
            reason,
            summaryPath: this.session.summaryPath,
            logPath: this.session.logPath,
            sampleCount: this.aggregate?.samples ?? 0,
        })

        this.session = null
        this.aggregate = null
        return this.getStatus()
    }

    getStatus(): SoakTestStatus {
        if (!this.session) {
            return {
                running: false,
                sessionId: null,
                startedAt: null,
                endsAt: null,
                durationHours: 0,
                intervalSeconds: 0,
                sampleCount: 0,
                logPath: null,
                summaryPath: null,
                lastSnapshotAt: this.lastSnapshotAt,
                stopReason: this.lastStopReason,
            }
        }

        return {
            running: true,
            sessionId: this.session.id,
            startedAt: this.session.startedAt,
            endsAt: this.session.endsAt,
            durationHours: this.session.durationHours,
            intervalSeconds: this.session.intervalSeconds,
            sampleCount: this.aggregate?.samples ?? 0,
            logPath: this.session.logPath,
            summaryPath: this.session.summaryPath,
            lastSnapshotAt: this.lastSnapshotAt,
            stopReason: null,
        }
    }

    startFromEnvironment(): SoakTestStatus | null {
        const autoRaw = String(process.env.MMO_SOAK_TEST_AUTO || '').trim().toLowerCase()
        const autoEnabled = autoRaw === '1' || autoRaw === 'true' || autoRaw === 'yes'
        if (!autoEnabled) {
            return null
        }

        const durationHours = Number.parseInt(String(process.env.MMO_SOAK_TEST_HOURS || ''), 10)
        const intervalSeconds = Number.parseInt(String(process.env.MMO_SOAK_TEST_INTERVAL_SECONDS || ''), 10)
        const tag = String(process.env.MMO_SOAK_TEST_TAG || '').trim() || 'env'

        return this.start({
            durationHours: Number.isFinite(durationHours) ? durationHours : 8,
            intervalSeconds: Number.isFinite(intervalSeconds) ? intervalSeconds : 30,
            tag,
        })
    }
}

export const soakTestService = new SoakTestService()

