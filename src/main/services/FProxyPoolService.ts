import { randomUUID, timingSafeEqual } from 'crypto'
import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../database'
import type { FproxyKeyRow } from '../database/schema'
import {
    type FProxyLeaseOwnerDto,
    type FProxyPoolPolicy,
    type FProxyPoolSnapshotDto,
    type FProxySlotPublicDto,
    type FProxySlotTestResultDto,
} from '../../shared/fproxy-pool-contracts'
import { secretVault } from './SecretVault'
import {
    FProxyApiClient,
    FProxyApiError,
    normalizeFProxyApiKey,
    type FProxyEndpoint,
    type FProxyProxySnapshot,
} from './FProxyApiClient'

const DEFAULT_POLICY: FProxyPoolPolicy = {
    strictUnique: true,
    rotationPolicy: 'rotate_per_visit',
}
const POLICY_STRICT_KEY = 'fproxy_pool_strict_unique'
const POLICY_ROTATION_KEY = 'fproxy_pool_rotation_policy'
const LEGACY_SLOT_LABEL = 'Legacy FProxy'
const LEASE_EXPIRY_SAFETY_MS = 5_000
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000
const DEFAULT_MIN_REMAINING_MS = 45_000

type SlotBusyState = 'testing' | 'rotating' | null

type LeaseRecord = {
    id: string
    generation: number
    owner: FProxyLeaseOwnerDto
    endpointKey: string
    observedIp: string
    abortController: AbortController
    expiryTimer: ReturnType<typeof setTimeout>
}

type SlotRuntime = {
    epoch: number
    generation: number
    endpoint: FProxyEndpoint | null
    /** Active leases keyed by lease id. One slot may be shared across locations. */
    leases: Map<string, LeaseRecord>
    /** Compatibility: first active lease, if any. */
    readonly lease: LeaseRecord | null
    busy: SlotBusyState
    operationAbort: AbortController | null
    rotationPending: boolean
    stickyOwnerId: string | null
    lastLeaseAt: number | null
    lastTest: number | null
    error: FProxyPoolErrorCode | null
}

type AcquireWaiter = {
    id: string
    request: FProxyLeaseRequest
    expiresAt: number
    resolve: (lease: FProxyLease) => void
    reject: (error: FProxyPoolError) => void
    timeout: ReturnType<typeof setTimeout>
    abortHandler?: () => void
}

export type FProxyPoolErrorCode =
    | 'aborted'
    | 'duplicate_slot'
    | 'egress_unknown'
    | 'no_slot_available'
    | 'slot_busy'
    | 'slot_cooldown'
    | 'slot_disabled'
    | 'slot_leased'
    | 'slot_not_found'
    | 'stale_configuration'
    | 'secret_unavailable'
    | 'provider_error'

export interface FProxyLeaseRequest {
    owner: FProxyLeaseOwnerDto
    timeoutMs?: number
    minRemainingMs?: number
    signal?: AbortSignal
}

export interface FProxyLease {
    leaseId: string
    slotId: number
    generation: number
    proxySnapshot: Readonly<FProxyProxySnapshot>
    observedIp: string
    endpointExpiresAt: number
    rotateAllowedAt: number
    signal: AbortSignal
    release(reason?: string): Promise<void>
}

export class FProxyPoolError extends Error {
    constructor(public readonly code: FProxyPoolErrorCode) {
        super(code)
        this.name = 'FProxyPoolError'
    }
}

export class FProxyPoolService {
    private readonly apiClient: FProxyApiClient
    private readonly runtimes = new Map<number, SlotRuntime>()
    private readonly waiters: AcquireWaiter[] = []
    private readonly listeners = new Set<(snapshot: FProxyPoolSnapshotDto) => void>()
    private policy: FProxyPoolPolicy = { ...DEFAULT_POLICY }
    private policyLoaded = false
    private revision = 0
    private draining = false
    private wakeTimer: ReturnType<typeof setTimeout> | null = null
    private autoRefreshTimer: ReturnType<typeof setInterval> | null = null
    /** Consecutive 30s ticks skipped because no slot held a lease. */
    private autoRefreshIdleSkips = 0

    constructor(apiClient: FProxyApiClient = new FProxyApiClient()) {
        this.apiClient = apiClient
    }

    async getSnapshot(): Promise<FProxyPoolSnapshotDto> {
        await this.ensurePolicyLoaded()
        const rows = this.getRows()
        this.syncRuntimeRows(rows)
        const slots = rows.map(row => this.toPublicSlot(row))
        return {
            slots,
            policy: { ...this.policy },
            capacity: slots.filter(slot => slot.available).length,
            revision: this.revision,
            serverNow: Date.now(),
        }
    }

    onSnapshot(listener: (snapshot: FProxyPoolSnapshotDto) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async addSlot(input: { label: string; apiKey: string; enabled?: boolean }): Promise<FProxyPoolSnapshotDto> {
        const apiKey = normalizeFProxyApiKey(input.apiKey)
        await this.assertUniqueApiKey(apiKey)
        const ciphertext = secretVault.seal(apiKey)
        if (!ciphertext) throw new FProxyPoolError('secret_unavailable')
        const now = new Date()
        const db = getDatabase()
        const row = db.insert(schema.fproxyKeys).values({
            label: input.label.trim(),
            apiKeyCiphertext: ciphertext,
            enabled: input.enabled ?? true,
            createdAt: now,
            updatedAt: now,
        }).returning().get()
        this.runtimes.set(row.id, createRuntime())
        return this.changed()
    }

    async removeSlot(id: number): Promise<FProxyPoolSnapshotDto> {
        const row = this.requireRow(id)
        this.assertMutable(row, this.runtimeFor(id))
        getDatabase().delete(schema.fproxyKeys).where(eq(schema.fproxyKeys.id, id)).run()
        this.abortRuntime(this.runtimeFor(id))
        this.runtimes.delete(id)
        return this.changed()
    }

    async setEnabled(id: number, enabled: boolean): Promise<FProxyPoolSnapshotDto> {
        const row = this.requireRow(id)
        const runtime = this.runtimeFor(id)
        this.assertMutable(row, runtime)
        runtime.epoch += 1
        this.abortOperation(runtime)
        runtime.error = null
        getDatabase().update(schema.fproxyKeys).set({
            enabled,
            updatedAt: new Date(),
        }).where(eq(schema.fproxyKeys.id, id)).run()
        return this.changed()
    }

    async updatePolicy(policy: FProxyPoolPolicy): Promise<FProxyPoolSnapshotDto> {
        await this.ensurePolicyLoaded()
        if (policy.strictUnique && !this.policy.strictUnique) {
            this.assertActiveLeasesUnique()
        }
        this.policy = { ...policy }
        this.savePolicy()
        return this.changed()
    }

    async acquire(request: FProxyLeaseRequest): Promise<FProxyLease> {
        await this.ensurePolicyLoaded()
        validateOwner(request.owner)
        if (request.signal?.aborted) throw new FProxyPoolError('aborted')
        return new Promise<FProxyLease>((resolve, reject) => {
            const waiter = this.createWaiter(request, resolve, reject)
            this.waiters.push(waiter)
            this.scheduleDrain()
        })
    }

    /**
     * Classic v1.0.11 countdown sync, multi-key version.
     * Uses provider waiting_time (rotateAllowedAt / nextRotateAt) exactly like FProxyService.proxyDieAt.
     * If a free slot already has enough remaining rotate window, return it immediately.
     * Otherwise wait until the earliest free-slot countdown hits 0 (and slot becomes ready).
     * Returns available rotate-window ms for the next visit (server-synced).
     */
    async waitForFreshRotation(
        minTimeRequiredSec: number,
        shouldStop: () => boolean,
        onStatus?: (msg: string) => void,
        signal?: AbortSignal,
        locationId?: number,
    ): Promise<{ availableMs: number; nextRotateAt: number | null; readySlotIds: number[] }> {
        await this.ensurePolicyLoaded()
        const minRequired = Math.max(1, Math.floor(minTimeRequiredSec || 1))
        const minRequiredMs = minRequired * 1000

        while (!shouldStop() && !signal?.aborted) {
            const snapshot = await this.getSnapshot()
            const now = Date.now()
            // Free keys, plus leased keys that another location can still share.
            const candidates = snapshot.slots.filter(slot =>
                slot.enabled
                && slot.hasSecret
                && slot.status !== 'disabled'
                && slot.status !== 'testing'
                && slot.status !== 'rotating'
                && slot.status !== 'error'
                && (
                    slot.status !== 'leased'
                    || canShareLeasedSlot(slot, locationId)
                )
            )

            if (candidates.length === 0) {
                onStatus?.('Waiting for an available FProxy key...')
                await sleep(500)
                continue
            }

            // Rotate countdown only: cooldownUntil (pending getnew) or trusted nextRotateAt (waiting_time).
            // Never use ipExpiresAt/time_die here — that is the ~30 min IP lifetime.
            const withRemaining = candidates.map(slot => {
                const rotateAt = slot.cooldownUntil
                    ?? (slot.nextRotateAt && slot.nextRotateAt > now ? slot.nextRotateAt : null)
                const remainingSec = rotateAt && rotateAt > now
                    ? Math.max(0, Math.round((rotateAt - now) / 1000))
                    : 0
                // Cap absurd values so mirrored time_die (~1800s) cannot block traffic.
                const safeRemainingSec = remainingSec > 300 ? 0 : remainingSec
                return {
                    slot,
                    dieAt: rotateAt,
                    remainingSec: safeRemainingSec,
                    available: slot.available === true,
                }
            })

            // Ready now: free slots whose rotate countdown is already 0 / not cooling,
            // or leased slots running a different location with enough IP lifetime left.
            const readyNow = withRemaining.filter(item => {
                if (item.slot.status === 'leased') {
                    const remainingMs = (item.slot.ipExpiresAt ?? 0) - now
                    return remainingMs >= minRequiredMs
                }
                return item.available || item.remainingSec <= 0
            })
            if (readyNow.length > 0) {
                // Visit budget should fit one rotate cycle (~2 min), not IP lifetime.
                const intervalMs = 120_000
                onStatus?.(`Proxy ready (${readyNow.length} key available)`)
                return {
                    availableMs: intervalMs,
                    nextRotateAt: now + intervalMs,
                    readySlotIds: readyNow.map(item => item.slot.id),
                }
            }

            // All free keys still cooling: wait earliest trusted waiting_time.
            // Leased share-candidates only lose remaining time, so they never become "more ready".
            const earliest = withRemaining
                .filter(item => item.slot.status !== 'leased' && item.remainingSec > 0)
                .sort((a, b) => a.remainingSec - b.remainingSec)[0]

            if (!earliest) {
                onStatus?.('Waiting for FProxy key...')
                await sleep(500)
                continue
            }

            // Classic UI message from v1.0.11 single-key path.
            onStatus?.(`Waiting for proxy rotation... ${earliest.remainingSec}s remaining`)
            await sleep(500)
        }

        return { availableMs: 0, nextRotateAt: null, readySlotIds: [] }
    }

    async testSlot(id: number): Promise<FProxySlotTestResultDto> {
        const row = this.requireRow(id)
        const runtime = this.runtimeFor(id)
        this.assertTestable(row, runtime)
        const startedAt = Date.now()
        try {
            const endpoint = await this.fetchInitialEndpoint(row, runtime, 'testing')
            this.assertEndpointObservable(endpoint)
            this.acceptEndpoint(runtime, endpoint)
            return this.buildTestResult(row.id, startedAt, runtime, true)
        } catch (error) {
            runtime.error = mapPoolError(error)
            return this.buildTestResult(row.id, startedAt, runtime, false)
        } finally {
            this.finishOperation(runtime)
            await this.changed()
        }
    }

    async testAll(): Promise<FProxySlotTestResultDto[]> {
        const enabledIds = this.getRows().filter(row => row.enabled).map(row => row.id)
        return Promise.all(enabledIds.map(async id => {
            try {
                return await this.testSlot(id)
            } catch (error) {
                return failedTestResult(id, mapPoolError(error))
            }
        }))
    }

    /**
     * Refresh a single slot by calling getCurrent (read-only, no IP rotation).
     * Unlike testSlot() which prefers getnew (rotates IP), this only reads
     * the current endpoint state from the provider.
     *
     * For leased slots (active thread), timers are updated in-place without
     * touching the busy flag or lease record, so the active connection is
     * never disrupted.
     *
     * Silently skips slots that are busy or disabled.
     */
    async refreshSlot(id: number): Promise<void> {
        const row = this.getRows().find(r => r.id === id)
        if (!row || !row.enabled) return
        const runtime = this.runtimeFor(id)
        if (runtime.busy) return

        if (runtime.lease) {
            // Leased slot: call getCurrent directly to refresh timers
            // without setting busy state or disrupting the active lease.
            try {
                const key = this.decryptSlotKey(row)
                const endpoint = await this.apiClient.getCurrent(key)
                if (runtime.endpoint) {
                    runtime.endpoint.endpointExpiresAt = endpoint.endpointExpiresAt
                    // Only update rotateAllowedAt if getCurrent returns a valid future rotate time.
                    // If getCurrent returns 0 (ready on server) while the active lease rotation
                    // countdown is still ticking, preserve the active countdown.
                    if (endpoint.rotateAllowedAt > Date.now()) {
                        runtime.endpoint.rotateAllowedAt = endpoint.rotateAllowedAt
                    }
                    if (endpoint.location) runtime.endpoint.location = endpoint.location
                }
            } catch {
                // Silently ignore — stale timers are acceptable for leased slots
            }
            return
        }

        try {
            const endpoint = await this.fetchForOperation(row, runtime, 'testing', 'current')
            this.acceptEndpoint(runtime, endpoint)
        } catch {
            // Silently ignore refresh errors — stale cache is acceptable
        } finally {
            this.finishOperation(runtime)
        }
    }

    /**
     * Refresh all enabled slots (including leased) by calling getCurrent.
     * Returns a fresh snapshot after all refreshes complete.
     * Slots are refreshed sequentially to avoid rate-limiting.
     */
    async refreshAllSlots(): Promise<FProxyPoolSnapshotDto> {
        const rows = this.getRows().filter(row => row.enabled)
        for (const row of rows) {
            await this.refreshSlot(row.id)
        }
        return this.changed()
    }

    /** Start periodic auto-refresh (every 30s). Idle ticks skip the provider API. */
    startAutoRefresh(): void {
        if (this.autoRefreshTimer) return
        this.autoRefreshIdleSkips = 0
        this.autoRefreshTimer = setInterval(() => {
            this.runAutoRefreshTick()
        }, 30_000)
    }

    /** Stop the periodic auto-refresh timer. */
    stopAutoRefresh(): void {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer)
            this.autoRefreshTimer = null
        }
        this.autoRefreshIdleSkips = 0
    }

    /** True when any slot still has a caller holding a lease. */
    private hasActiveLease(): boolean {
        for (const runtime of Array.from(this.runtimes.values())) {
            if (runtime.leases.size > 0) return true
        }
        return false
    }

    private noteIdleAutoRefreshSkip(): void {
        this.autoRefreshIdleSkips += 1
        const count = this.autoRefreshIdleSkips
        if (count === 1 || count % 10 === 0) {
            console.info(`[FProxyPool] Auto-refresh idle skip count=${count} (no active leases)`)
        }
    }

    /**
     * Keep the 30s timer armed, but call FProxy only while a lease is active
     * so an idle app does not poll the provider forever.
     */
    private runAutoRefreshTick(): void {
        try {
            if (!this.hasActiveLease()) {
                this.noteIdleAutoRefreshSkip()
                return
            }
            this.autoRefreshIdleSkips = 0
            const hasEnabled = this.getRows().some((row) => row.enabled)
            if (!hasEnabled) return
            void this.refreshAllSlots().catch(() => {
                // Auto-refresh failures are non-critical
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[FProxyPool] Auto-refresh tick failed: ${message}`)
        }
    }

    async rotateSlot(id: number): Promise<FProxyPoolSnapshotDto> {
        const row = this.requireRow(id)
        const runtime = this.runtimeFor(id)
        this.assertTestable(row, runtime)
        if (runtime.endpoint && runtime.endpoint.rotateAllowedAt > Date.now()) {
            throw new FProxyPoolError('slot_cooldown')
        }
        try {
            const endpoint = await this.fetchForOperation(row, runtime, 'rotating', 'new')
            this.assertEndpointObservable(endpoint)
            this.acceptEndpoint(runtime, endpoint)
            runtime.rotationPending = false
        } catch (error) {
            runtime.error = mapPoolError(error)
            throw new FProxyPoolError(runtime.error)
        } finally {
            this.finishOperation(runtime)
        }
        return this.changed()
    }

    async upsertLegacyApiKey(rawApiKey: string): Promise<FProxyPoolSnapshotDto> {
        const apiKey = normalizeFProxyApiKey(rawApiKey)
        const existing = this.getRows().find(row => row.label === LEGACY_SLOT_LABEL)
        if (!apiKey) {
            return existing ? this.removeSlot(existing.id) : this.getSnapshot()
        }
        if (!existing) {
            return this.addSlot({ label: LEGACY_SLOT_LABEL, apiKey, enabled: true })
        }
        return this.replaceSlotSecret(existing, apiKey)
    }

    getDefaultSlotId(): number | null {
        const rows = this.getRows()
        return rows.find(row => row.label === LEGACY_SLOT_LABEL)?.id
            ?? rows.find(row => row.enabled)?.id
            ?? null
    }

    private createWaiter(
        request: FProxyLeaseRequest,
        resolve: (lease: FProxyLease) => void,
        reject: (error: FProxyPoolError) => void,
    ): AcquireWaiter {
        const timeoutMs = clampAcquireTimeout(request.timeoutMs)
        const waiter: AcquireWaiter = {
            id: randomUUID(),
            request,
            expiresAt: Date.now() + timeoutMs,
            resolve,
            reject,
            timeout: setTimeout(() => this.cancelWaiter(waiter, 'no_slot_available'), timeoutMs),
        }
        this.attachWaiterAbort(waiter)
        return waiter
    }

    private attachWaiterAbort(waiter: AcquireWaiter): void {
        const signal = waiter.request.signal
        if (!signal) return
        waiter.abortHandler = () => this.cancelWaiter(waiter, 'aborted')
        signal.addEventListener('abort', waiter.abortHandler, { once: true })
    }

    private cancelWaiter(waiter: AcquireWaiter, code: FProxyPoolErrorCode): void {
        const index = this.waiters.findIndex(candidate => candidate.id === waiter.id)
        if (index < 0) return
        this.waiters.splice(index, 1)
        this.cleanupWaiter(waiter)
        waiter.reject(new FProxyPoolError(code))
        this.scheduleDrain()
    }

    private cleanupWaiter(waiter: AcquireWaiter): void {
        clearTimeout(waiter.timeout)
        if (waiter.abortHandler && waiter.request.signal) {
            waiter.request.signal.removeEventListener('abort', waiter.abortHandler)
        }
    }

    private scheduleDrain(): void {
        if (this.draining) return
        queueMicrotask(() => void this.drainWaiters())
    }

    private async drainWaiters(): Promise<void> {
        if (this.draining) return
        this.draining = true
        try {
            while (this.waiters.length > 0) {
                const waiter = this.waiters[0]
                const lease = await this.tryAcquire(waiter.request)
                if (this.waiters[0]?.id !== waiter.id) {
                    if (lease) await lease.release('waiter_cancelled')
                    continue
                }
                if (!lease) break
                this.waiters.shift()
                this.cleanupWaiter(waiter)
                waiter.resolve(lease)
            }
        } finally {
            this.draining = false
            this.scheduleNextWake()
        }
    }

    private async tryAcquire(request: FProxyLeaseRequest): Promise<FProxyLease | null> {
        const now = Date.now()
        const minRemaining = clampMinRemaining(request.minRemainingMs)
        const rows = this.rankCandidates(this.getRows(), request.owner)
        for (const row of rows) {
            const runtime = this.runtimeFor(row.id)
            if (!row.enabled || runtime.busy) continue

            if (runtime.leases.size > 0) {
                // Share a live slot across locations when no lease already covers this locationId
                // and the current endpoint still has enough IP lifetime.
                if (!canShareSlot(runtime, request.owner.locationId, minRemaining, now)) continue
                const endpoint = runtime.endpoint
                if (!endpoint) continue
                const lease = this.commitLease(row, runtime, endpoint, readObservedIp(endpoint), request.owner)
                this.emitSnapshot()
                return lease
            }

            // Skip cooling slots without locking them; wait for the earliest ready key instead.
            if (slotReadyAt(runtime, now) > now) continue
            const lease = await this.prepareLease(row, runtime, request)
            if (lease) return lease
        }
        return null
    }

    private rankCandidates(rows: FproxyKeyRow[], owner: FProxyLeaseOwnerDto): FproxyKeyRow[] {
        const now = Date.now()
        return rows.slice().sort((left, right) => {
            const leftRuntime = this.runtimeFor(left.id)
            const rightRuntime = this.runtimeFor(right.id)
            if (this.policy.rotationPolicy === 'sticky_session') {
                const leftSticky = leftRuntime.stickyOwnerId === owner.id ? 0 : 1
                const rightSticky = rightRuntime.stickyOwnerId === owner.id ? 0 : 1
                if (leftSticky !== rightSticky) return leftSticky - rightSticky
            }
            // Prefer immediately ready free slots, then the earliest cooling key that becomes ready.
            // Avoids stacking next visits onto one cooling key while other keys are already free.
            const leftReadyAt = slotReadyAt(leftRuntime, now)
            const rightReadyAt = slotReadyAt(rightRuntime, now)
            if (leftReadyAt !== rightReadyAt) return leftReadyAt - rightReadyAt
            const leftLeaseAt = leftRuntime.lastLeaseAt ?? 0
            const rightLeaseAt = rightRuntime.lastLeaseAt ?? 0
            if (leftLeaseAt !== rightLeaseAt) return leftLeaseAt - rightLeaseAt
            return left.id - right.id
        })
    }

    private async prepareLease(
        row: FproxyKeyRow,
        runtime: SlotRuntime,
        request: FProxyLeaseRequest,
    ): Promise<FProxyLease | null> {
        runtime.busy = 'rotating'
        this.bumpRevision()
        try {
            const endpoint = await this.ensureLeaseEndpoint(row, runtime, request)
            if (!endpoint) return null
            const observedIp = readObservedIp(endpoint)
            if (this.policy.strictUnique && !observedIp) {
                this.rememberRejectedEndpoint(runtime, endpoint, 'egress_unknown')
                return null
            }
            if (this.hasActiveCollision(endpoint, observedIp, row.id)) {
                this.rememberRejectedEndpoint(runtime, endpoint, null)
                runtime.rotationPending = true
                return null
            }
            return this.commitLease(row, runtime, endpoint, observedIp, request.owner)
        } catch (error) {
            runtime.error = request.signal?.aborted ? null : mapPoolError(error)
            return null
        } finally {
            this.finishOperation(runtime)
            this.emitSnapshot()
        }
    }

    private rememberRejectedEndpoint(
        runtime: SlotRuntime,
        endpoint: FProxyEndpoint,
        error: FProxyPoolErrorCode | null,
    ): void {
        this.acceptEndpoint(runtime, endpoint)
        runtime.rotationPending = true
        runtime.error = error
    }

    private async ensureLeaseEndpoint(
        row: FproxyKeyRow,
        runtime: SlotRuntime,
        request: FProxyLeaseRequest,
    ): Promise<FProxyEndpoint | null> {
        const minRemaining = clampMinRemaining(request.minRemainingMs)
        const current = runtime.endpoint
        const now = Date.now()

        // rotate_per_visit: always request a new IP after previous lease release (when cooldown allows).
        // sticky_session: reuse current endpoint until minRemaining is no longer satisfied.
        const forceFreshIp = this.policy.rotationPolicy === 'rotate_per_visit' && runtime.rotationPending
        const needsRotation = forceFreshIp
            || !current
            || current.endpointExpiresAt - now < minRemaining

        if (!needsRotation) {
            return current
        }

        // Wait for provider cooldown (waiting_time / rotateAllowedAt) instead of reusing old IP early.
        if (current && current.rotateAllowedAt > now) {
            return null
        }

        let endpoint = current
            ? await this.fetchForOperation(row, runtime, 'rotating', 'new', request.signal)
            : await this.fetchInitialEndpoint(row, runtime, 'rotating', request.signal)
        this.acceptEndpoint(runtime, endpoint)
        runtime.rotationPending = false

        // Reject near-expired endpoints so Traffic visits only start with enough IP lifetime.
        if (endpoint.endpointExpiresAt - Date.now() >= minRemaining) {
            return endpoint
        }

        // Provider returned a short window; if still cooling, wait for next drain wake.
        if (endpoint.rotateAllowedAt > Date.now()) {
            runtime.rotationPending = true
            return null
        }

        // One immediate retry for a longer-lived endpoint.
        endpoint = await this.fetchForOperation(row, runtime, 'rotating', 'new', request.signal)
        this.acceptEndpoint(runtime, endpoint)
        if (endpoint.endpointExpiresAt - Date.now() >= minRemaining) {
            return endpoint
        }
        runtime.rotationPending = true
        return null
    }

    private async fetchInitialEndpoint(
        row: FproxyKeyRow,
        runtime: SlotRuntime,
        busy: Exclude<SlotBusyState, null>,
        signal?: AbortSignal,
    ): Promise<FProxyEndpoint> {
        // Prefer getnew so waiting_time is the real ~2 min rotate countdown.
        // getcurrent often mirrors waiting_time = time_die (~30 min).
        try {
            return await this.fetchForOperation(row, runtime, busy, 'new', signal)
        } catch (error) {
            if (error instanceof FProxyPoolError && error.code === 'stale_configuration') throw error
            if (signal?.aborted) throw new FProxyPoolError('aborted')
            return this.fetchForOperation(row, runtime, busy, 'current', signal)
        }
    }

    private async fetchForOperation(
        row: FproxyKeyRow,
        runtime: SlotRuntime,
        busy: Exclude<SlotBusyState, null>,
        mode: 'current' | 'new',
        externalSignal?: AbortSignal,
    ): Promise<FProxyEndpoint> {
        const epoch = runtime.epoch
        const key = this.decryptSlotKey(row)
        const controller = new AbortController()
        runtime.busy = busy
        runtime.operationAbort = controller
        const abort = () => controller.abort()
        externalSignal?.addEventListener('abort', abort, { once: true })
        try {
            const endpoint = mode === 'new'
                ? await this.apiClient.getNew(key, { signal: controller.signal })
                : await this.apiClient.getCurrent(key, { signal: controller.signal })
            if (runtime.epoch !== epoch) throw new FProxyPoolError('stale_configuration')
            return endpoint
        } finally {
            externalSignal?.removeEventListener('abort', abort)
        }
    }

    private acceptEndpoint(runtime: SlotRuntime, endpoint: FProxyEndpoint): void {
        runtime.endpoint = endpoint
        runtime.generation += 1
        runtime.error = null
        runtime.lastTest = Date.now()
    }

    private assertEndpointObservable(endpoint: FProxyEndpoint): void {
        if (this.policy.strictUnique && !readObservedIp(endpoint)) {
            throw new FProxyPoolError('egress_unknown')
        }
    }

    private finishOperation(runtime: SlotRuntime): void {
        runtime.busy = null
        runtime.operationAbort = null
    }

    private commitLease(
        row: FproxyKeyRow,
        runtime: SlotRuntime,
        endpoint: FProxyEndpoint,
        observedIp: string,
        owner: FProxyLeaseOwnerDto,
    ): FProxyLease {
        // First exclusive lease publishes the endpoint; extra location leases reuse it as-is
        // so existing holders keep a stable generation.
        if (runtime.leases.size === 0) {
            this.acceptEndpoint(runtime, endpoint)
        }
        const leaseId = randomUUID()
        const hardExpiresAt = Math.max(Date.now() + 1, endpoint.endpointExpiresAt - LEASE_EXPIRY_SAFETY_MS)
        const abortController = new AbortController()
        const generation = runtime.generation
        const expiryTimer = setTimeout(() => {
            this.onLeaseExpired(row.id, leaseId, generation, abortController)
        }, Math.max(0, hardExpiresAt - Date.now()))
        const record: LeaseRecord = {
            id: leaseId,
            generation: runtime.generation,
            owner: sanitizeOwner(owner),
            endpointKey: endpointKey(endpoint.proxySnapshot),
            observedIp,
            abortController,
            expiryTimer,
        }
        runtime.leases.set(leaseId, record)
        runtime.stickyOwnerId = owner.id
        runtime.lastLeaseAt = Date.now()
        return this.makeLeaseHandle(row.id, endpoint, observedIp, record)
    }

    private makeLeaseHandle(
        slotId: number,
        endpoint: FProxyEndpoint,
        observedIp: string,
        lease: LeaseRecord,
    ): FProxyLease {
        let released = false
        return {
            leaseId: lease.id,
            slotId,
            generation: lease.generation,
            proxySnapshot: Object.freeze({ ...endpoint.proxySnapshot }),
            observedIp,
            endpointExpiresAt: endpoint.endpointExpiresAt,
            rotateAllowedAt: endpoint.rotateAllowedAt,
            signal: lease.abortController.signal,
            release: async () => {
                if (released) return
                released = true
                await this.releaseLease(slotId, lease.id, lease.generation)
            },
        }
    }

    /**
     * Expiry must drop the lease, not only abort the signal.
     * Abort alone leaves a ghost entry that pins the slot forever.
     */
    private onLeaseExpired(
        slotId: number,
        leaseId: string,
        generation: number,
        abortController: AbortController,
    ): void {
        try {
            abortController.abort()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[FProxyPool] Abort on expired lease ${leaseId} failed: ${message}`)
        }

        const runtime = this.runtimes.get(slotId)
        const active = runtime?.leases.get(leaseId)
        if (!runtime || !active || active.generation !== generation) return

        console.warn(`[FProxyPool] Force-released expired ghost lease ${leaseId} on slot ${slotId}`)
        void this.releaseLease(slotId, leaseId, generation).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[FProxyPool] Expired lease release failed on slot ${slotId}: ${message}`)
        })
    }

    private async releaseLease(slotId: number, leaseId: string, generation: number): Promise<void> {
        const runtime = this.runtimes.get(slotId)
        if (!runtime) return
        const active = runtime.leases.get(leaseId)
        if (!active || active.generation !== generation) return
        clearTimeout(active.expiryTimer)
        runtime.leases.delete(leaseId)
        // Other locations may still be using this IP; only the last release starts rotation.
        if (runtime.leases.size > 0) {
            await this.changed()
            this.scheduleDrain()
            return
        }
        if (this.policy.rotationPolicy === 'rotate_per_visit') {
            runtime.rotationPending = true
            // Do not pin the next visit to this slot; pick the earliest-ready free key.
            runtime.stickyOwnerId = null
        }
        await this.changed()
        this.scheduleDrain()
    }

    private hasActiveCollision(endpoint: FProxyEndpoint, observedIp: string, slotId: number): boolean {
        if (!this.policy.strictUnique) return false
        const targetEndpoint = endpointKey(endpoint.proxySnapshot)
        return Array.from(this.runtimes.entries()).some(([id, runtime]) => {
            if (id === slotId || !runtime.lease) return false
            return runtime.lease.endpointKey === targetEndpoint
                || runtime.lease.observedIp === observedIp
        })
    }

    private assertActiveLeasesUnique(): void {
        const endpoints = new Set<string>()
        const ips = new Set<string>()
        for (const runtime of Array.from(this.runtimes.values())) {
            if (!runtime.lease) continue
            if (!runtime.lease.observedIp
                || endpoints.has(runtime.lease.endpointKey)
                || ips.has(runtime.lease.observedIp)) {
                throw new FProxyPoolError('egress_unknown')
            }
            endpoints.add(runtime.lease.endpointKey)
            ips.add(runtime.lease.observedIp)
        }
    }

    private assertMutable(row: FproxyKeyRow, runtime: SlotRuntime): void {
        if (runtime.lease) throw new FProxyPoolError('slot_leased')
        if (runtime.busy) throw new FProxyPoolError('slot_busy')
        if (!row) throw new FProxyPoolError('slot_not_found')
    }

    private assertTestable(row: FproxyKeyRow, runtime: SlotRuntime): void {
        if (!row.enabled) throw new FProxyPoolError('slot_disabled')
        this.assertMutable(row, runtime)
    }

    private async replaceSlotSecret(
        row: FproxyKeyRow,
        apiKey: string,
    ): Promise<FProxyPoolSnapshotDto> {
        const runtime = this.runtimeFor(row.id)
        this.assertMutable(row, runtime)
        const currentKey = normalizeFProxyApiKey(this.decryptSlotKey(row))
        if (safeSecretEqual(currentKey, apiKey)) return this.getSnapshot()
        await this.assertUniqueApiKey(apiKey, row.id)
        const ciphertext = secretVault.seal(apiKey)
        if (!ciphertext) throw new FProxyPoolError('secret_unavailable')
        runtime.epoch += 1
        this.abortRuntime(runtime)
        getDatabase().update(schema.fproxyKeys).set({
            apiKeyCiphertext: ciphertext,
            enabled: true,
            updatedAt: new Date(),
        }).where(eq(schema.fproxyKeys.id, row.id)).run()
        return this.changed()
    }

    private async assertUniqueApiKey(apiKey: string, exceptId?: number): Promise<void> {
        if (!apiKey) throw new FProxyPoolError('secret_unavailable')
        for (const row of this.getRows()) {
            if (row.id === exceptId) continue
            const existing = normalizeFProxyApiKey(this.decryptSlotKey(row))
            if (existing && safeSecretEqual(existing, apiKey)) {
                throw new FProxyPoolError('duplicate_slot')
            }
        }
    }

    private decryptSlotKey(row: FproxyKeyRow): string {
        const key = secretVault.decrypt(row.apiKeyCiphertext)
        if (!key) throw new FProxyPoolError('secret_unavailable')
        return key
    }

    private requireRow(id: number): FproxyKeyRow {
        const row = getDatabase().select().from(schema.fproxyKeys)
            .where(eq(schema.fproxyKeys.id, id)).get()
        if (!row) throw new FProxyPoolError('slot_not_found')
        return row
    }

    private getRows(): FproxyKeyRow[] {
        return getDatabase().select().from(schema.fproxyKeys).all()
    }

    private runtimeFor(id: number): SlotRuntime {
        const existing = this.runtimes.get(id)
        if (existing) return existing
        const runtime = createRuntime()
        this.runtimes.set(id, runtime)
        return runtime
    }

    private syncRuntimeRows(rows: FproxyKeyRow[]): void {
        const ids = new Set(rows.map(row => row.id))
        for (const row of rows) this.runtimeFor(row.id)
        for (const [id, runtime] of Array.from(this.runtimes.entries())) {
            if (!ids.has(id) && !runtime.lease) {
                this.abortRuntime(runtime)
                this.runtimes.delete(id)
            }
        }
    }

    private toPublicSlot(row: FproxyKeyRow): FProxySlotPublicDto {
        const runtime = this.runtimeFor(row.id)
        const cooldownUntil = readCooldown(runtime)
        const status = readSlotStatus(row, runtime, cooldownUntil)
        const endpoint = runtime.endpoint
        return {
            id: row.id,
            label: row.label,
            enabled: row.enabled,
            hasSecret: Boolean(row.apiKeyCiphertext),
            status,
            available: row.enabled && !runtime.lease && !runtime.busy && cooldownUntil === null,
            cooldownUntil,
            // Dual timers: ipExpiresAt = time_die (~30m), nextRotateAt = waiting_time (~2m).
            // When rotateAllowedAt was sanitized (getcurrent mirrored time_die), nextRotateAt is ready/null.
            ipExpiresAt: endpoint ? endpoint.endpointExpiresAt : null,
            nextRotateAt: endpoint && endpoint.rotateAllowedAt > Date.now()
                ? endpoint.rotateAllowedAt
                : (cooldownUntil ?? null),
            currentEgress: readPublicEgress(endpoint),
            leaseOwner: getLease(runtime)?.owner ?? null,
            activeLocationIds: collectLocationIds(runtime),
            lastTest: runtime.lastTest,
            error: runtime.error,
        }
    }

    private buildTestResult(
        id: number,
        startedAt: number,
        runtime: SlotRuntime,
        success: boolean,
    ): FProxySlotTestResultDto {
        return {
            id,
            success,
            testedAt: Date.now(),
            latencyMs: Date.now() - startedAt,
            currentEgress: readPublicEgress(runtime.endpoint),
            error: success ? null : runtime.error ?? 'provider_error',
        }
    }

    private async ensurePolicyLoaded(): Promise<void> {
        if (this.policyLoaded) return
        const rows = getDatabase().select().from(schema.settings).all()
        const strict = rows.find(row => row.key === POLICY_STRICT_KEY)?.value
        const rotation = rows.find(row => row.key === POLICY_ROTATION_KEY)?.value
        this.policy = {
            strictUnique: strict == null ? DEFAULT_POLICY.strictUnique : strict === 'true',
            rotationPolicy: rotation === 'sticky_session' ? 'sticky_session' : 'rotate_per_visit',
        }
        this.policyLoaded = true
    }

    private savePolicy(): void {
        this.savePolicyValue(POLICY_STRICT_KEY, String(this.policy.strictUnique))
        this.savePolicyValue(POLICY_ROTATION_KEY, this.policy.rotationPolicy)
    }

    private savePolicyValue(key: string, value: string): void {
        getDatabase().insert(schema.settings).values({
            key,
            value,
            updatedAt: new Date(),
        }).onConflictDoUpdate({
            target: schema.settings.key,
            set: { value, updatedAt: new Date() },
        }).run()
    }

    private scheduleNextWake(): void {
        if (this.wakeTimer) clearTimeout(this.wakeTimer)
        if (this.waiters.length === 0) return
        const now = Date.now()
        const deadlines = Array.from(this.runtimes.values())
            .map(runtime => {
                if (runtime.lease || runtime.busy) return null
                const readyAt = slotReadyAt(runtime, now)
                return readyAt > now ? readyAt : null
            })
            .filter((value): value is number => value !== null)
        if (deadlines.length === 0) return
        const delay = Math.max(1, Math.min(...deadlines) - now)
        this.wakeTimer = setTimeout(() => this.scheduleDrain(), delay)
    }

    private abortOperation(runtime: SlotRuntime): void {
        runtime.operationAbort?.abort()
        runtime.operationAbort = null
        runtime.busy = null
    }

    private abortRuntime(runtime: SlotRuntime): void {
        this.abortOperation(runtime)
        for (const record of Array.from(runtime.leases.values())) {
            clearTimeout(record.expiryTimer)
            record.abortController.abort()
        }
        runtime.leases.clear()
        runtime.endpoint = null
    }

    private async changed(): Promise<FProxyPoolSnapshotDto> {
        this.bumpRevision()
        const snapshot = await this.getSnapshot()
        for (const listener of Array.from(this.listeners)) listener(snapshot)
        this.scheduleDrain()
        return snapshot
    }

    private emitSnapshot(): void {
        this.bumpRevision()
        void this.getSnapshot().then(snapshot => {
            for (const listener of Array.from(this.listeners)) listener(snapshot)
        }).catch(() => {
            // Snapshot delivery is best-effort; callers still receive operation errors.
        })
    }

    private bumpRevision(): void {
        this.revision += 1
    }
}

function createRuntime(): SlotRuntime {
    return {
        epoch: 0,
        generation: 0,
        endpoint: null,
        leases: new Map<string, LeaseRecord>(),
        get lease(): LeaseRecord | null {
            return getLease(this)
        },
        busy: null,
        operationAbort: null,
        rotationPending: false,
        stickyOwnerId: null,
        lastLeaseAt: null,
        lastTest: null,
        error: null,
    }
}

/** Compatibility helper: first active lease on the slot, if any. */
function getLease(runtime: Pick<SlotRuntime, 'leases'>): LeaseRecord | null {
    for (const record of Array.from(runtime.leases.values())) return record
    return null
}

function collectLocationIds(runtime: SlotRuntime): number[] {
    const ids: number[] = []
    for (const record of Array.from(runtime.leases.values())) {
        const locationId = record.owner.locationId
        if (typeof locationId === 'number' && !ids.includes(locationId)) {
            ids.push(locationId)
        }
    }
    return ids
}

function hasLeaseForLocation(runtime: SlotRuntime, locationId: number): boolean {
    for (const record of Array.from(runtime.leases.values())) {
        if (record.owner.locationId === locationId) return true
    }
    return false
}

function canShareSlot(
    runtime: SlotRuntime,
    locationId: number | undefined,
    minRemainingMs: number,
    now: number,
): boolean {
    if (typeof locationId !== 'number') return false
    if (runtime.leases.size === 0) return false
    if (hasLeaseForLocation(runtime, locationId)) return false
    const endpoint = runtime.endpoint
    if (!endpoint) return false
    return endpoint.endpointExpiresAt - now >= minRemainingMs
}

function canShareLeasedSlot(slot: FProxySlotPublicDto, locationId: number | undefined): boolean {
    if (typeof locationId !== 'number') return false
    if (slot.status !== 'leased') return false
    return !(slot.activeLocationIds ?? []).includes(locationId)
}

function validateOwner(owner: FProxyLeaseOwnerDto): void {
    if (!owner.id.trim() || owner.id.length > 160 || owner.threadId < 0) {
        throw new FProxyPoolError('no_slot_available')
    }
}

function sanitizeOwner(owner: FProxyLeaseOwnerDto): FProxyLeaseOwnerDto {
    const sanitized: FProxyLeaseOwnerDto = {
        kind: owner.kind,
        id: owner.id.replace(/[\0\r\n]/g, '').slice(0, 160),
        threadId: Math.max(0, Math.floor(owner.threadId)),
    }
    if (typeof owner.locationId === 'number') {
        sanitized.locationId = owner.locationId
    }
    return sanitized
}

function readObservedIp(endpoint: FProxyEndpoint): string {
    return endpoint.observedIp ?? ''
}

function endpointKey(proxy: FProxyProxySnapshot): string {
    return `${proxy.type}://${proxy.host.trim().toLowerCase()}:${proxy.port}`
}

function readPublicEgress(endpoint: FProxyEndpoint | null): FProxySlotPublicDto['currentEgress'] {
    if (!endpoint) return null
    const ip = readObservedIp(endpoint)
    if (!ip) return null
    return { ip, location: endpoint.location || null }
}

function readCooldown(runtime: SlotRuntime): number | null {
    if (!runtime.rotationPending || !runtime.endpoint) return null
    return runtime.endpoint.rotateAllowedAt > Date.now()
        ? runtime.endpoint.rotateAllowedAt
        : null
}

/**
 * Absolute timestamp when a free slot can accept a new lease.
 * 0 = ready immediately / never used
 * >now = still cooling after previous rotation
 * +inf = leased or busy
 */
function slotReadyAt(runtime: SlotRuntime, now: number): number {
    if (runtime.lease || runtime.busy) return Number.POSITIVE_INFINITY
    // No prior endpoint / no rotation pending => free to acquire immediately.
    if (!runtime.rotationPending) return 0
    if (!runtime.endpoint) return 0
    // Respect provider waiting_time (rotateAllowedAt). Once cooldown ends, slot is ready for getNew.
    return runtime.endpoint.rotateAllowedAt > now
        ? runtime.endpoint.rotateAllowedAt
        : 0
}

function readSlotStatus(
    row: FproxyKeyRow,
    runtime: SlotRuntime,
    cooldownUntil: number | null,
): FProxySlotPublicDto['status'] {
    if (!row.enabled) return 'disabled'
    if (runtime.lease) return 'leased'
    if (runtime.busy) return runtime.busy
    if (cooldownUntil !== null) return 'cooldown'
    if (runtime.error) return 'error'
    return 'idle'
}

function safeSecretEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8')
    const rightBuffer = Buffer.from(right, 'utf8')
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function mapPoolError(error: unknown): FProxyPoolErrorCode {
    if (error instanceof FProxyPoolError) return error.code
    if (error instanceof FProxyApiError) {
        if (error.code === 'aborted') return 'aborted'
        if (error.code === 'invalid_api_key') return 'secret_unavailable'
    }
    return 'provider_error'
}

function failedTestResult(id: number, code: FProxyPoolErrorCode): FProxySlotTestResultDto {
    return {
        id,
        success: false,
        testedAt: Date.now(),
        latencyMs: null,
        currentEgress: null,
        error: code,
    }
}

function clampAcquireTimeout(value?: number): number {
    if (!Number.isFinite(value)) return DEFAULT_ACQUIRE_TIMEOUT_MS
    return Math.max(1_000, Math.min(10 * 60_000, Math.floor(value!)))
}

function clampMinRemaining(value?: number): number {
    if (!Number.isFinite(value)) return DEFAULT_MIN_REMAINING_MS
    // Allow compact 2-minute FProxy windows; still reject trivially short leftovers.
    return Math.max(20_000, Math.min(30 * 60_000, Math.floor(value!)))
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export const fproxyPoolService = new FProxyPoolService()
