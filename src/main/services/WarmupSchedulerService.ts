/**
 * WarmupSchedulerService — background auto-warmup loop.
 *
 * Scans active accounts with autoWarmupEnabled, cooldown elapsed, and daily
 * session cap not reached. Birth-story type is applied when the story is still
 * open. Concurrent sessions are capped at 2. Every tick is crash-safe: overlapping
 * ticks are skipped, per-account failures do not abort the scan, and a process
 * crash simply drops in-memory reservations (engine re-reserves on next start).
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { Account } from '../database/schema'
import { getDatabase, schema } from '../database'
import { accountWarmupEngine } from '../automation/AccountWarmupEngine'
import {
    accountWarmupService,
    evaluateStartEligibility,
} from './AccountWarmupService'
import {
    birthStoryService,
    type BirthStoryActivityType,
} from './BirthStoryService'

const TICK_INTERVAL_MS = 5 * 60 * 1000
const STARTUP_DELAY_MS = 5_000
const MAX_CONCURRENT_WARMUPS = 2

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export class WarmupSchedulerService {
    private timer: ReturnType<typeof setInterval> | null = null
    private startupTimer: ReturnType<typeof setTimeout> | null = null
    private enabled = false
    /** Prevents overlapping ticks if a scan outlives the interval. */
    private ticking = false
    private readonly concurrentLimit = MAX_CONCURRENT_WARMUPS

    start(): void {
        if (this.enabled) return
        this.enabled = true
        this.timer = setInterval(() => {
            void this.tick()
        }, TICK_INTERVAL_MS)
        this.startupTimer = setTimeout(() => {
            this.startupTimer = null
            void this.tick()
        }, STARTUP_DELAY_MS)
        console.log('[WarmupScheduler] Started')
    }

    stop(): void {
        if (!this.enabled && !this.timer && !this.startupTimer) return
        this.enabled = false
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        if (this.startupTimer) {
            clearTimeout(this.startupTimer)
            this.startupTimer = null
        }
        console.log('[WarmupScheduler] Stopped')
    }

    isRunning(): boolean {
        return this.enabled
    }

    /**
     * One scan pass. Public so tests can drive the loop without waiting on timers.
     */
    async tick(): Promise<void> {
        if (!this.enabled || this.ticking) return
        this.ticking = true
        try {
            await this.scanAndQueue()
        } catch (error: unknown) {
            console.error(`[WarmupScheduler] tick failed: ${errorMessage(error)}`)
        } finally {
            this.ticking = false
        }
    }

    private async scanAndQueue(): Promise<void> {
        if (accountWarmupEngine.getRunningIds().size >= this.concurrentLimit) return

        const now = new Date()
        const accounts = this.loadDueAccounts()

        for (const account of accounts) {
            if (!this.enabled) return
            if (accountWarmupEngine.getRunningIds().size >= this.concurrentLimit) break
            if (accountWarmupEngine.isRunning(account.id)) continue

            try {
                await this.queueAccount(account, now)
            } catch (error: unknown) {
                console.error(
                    `[WarmupScheduler] account ${account.id} failed: ${errorMessage(error)}`,
                )
            }
        }
    }

    private loadDueAccounts(): Account[] {
        try {
            const db = getDatabase()
            const now = new Date()
            const rows = db
                .select()
                .from(schema.accounts)
                .where(
                    and(
                        eq(schema.accounts.status, 'active'),
                        eq(schema.accounts.autoWarmupEnabled, true),
                        or(
                            isNull(schema.accounts.nextWarmupAt),
                            lt(schema.accounts.nextWarmupAt, now)
                        )
                    ),
                )
                .all()
            return rows ?? []
        } catch (error: unknown) {
            console.error(`[WarmupScheduler] account scan failed: ${errorMessage(error)}`)
            return []
        }
    }

    private async queueAccount(account: Account, now: Date): Promise<void> {
        const data = await accountWarmupService.getWarmupData(account.id)
        const eligibility = evaluateStartEligibility(data, now)
        if (!eligibility.allowed) return

        let activityType: BirthStoryActivityType | undefined
        let durationSeconds: number | undefined

        if (!account.birthStoryCompleted) {
            const applied = await birthStoryService.applyPlan(account.id, now)
            if (applied) {
                activityType = applied
                durationSeconds = birthStoryService.durationSecondsFor(applied)
            }
        }

        console.log(
            `[WarmupScheduler] Starting warmup for account ${account.id}, type ${activityType ?? 'auto'}`,
        )

        const result = await accountWarmupEngine.start(account.id, {
            activityType,
            durationSeconds,
        })

        if (!result.success) {
            console.warn(
                `[WarmupScheduler] start rejected account=${account.id}: ${result.message ?? result.code ?? 'unknown'}`,
            )
        }
    }
}

export const warmupSchedulerService = new WarmupSchedulerService()
