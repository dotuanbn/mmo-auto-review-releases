import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain'
import { createHash } from 'crypto'

type ProxyType = 'http' | 'https' | 'socks5'

/** How Playwright will receive the proxy endpoint. */
export type ProxyBridgeMode = 'direct' | 'anonymized'

export interface ProxyBridgeInput {
    host: string
    port: number
    username?: string
    password?: string
    type?: ProxyType
}

export interface ResolvedProxyConfig {
    server: string
    username?: string
    password?: string
    bridgeKey?: string
    /** direct = Playwright auth; anonymized = local proxy-chain bridge (no auth). */
    bridgeMode: ProxyBridgeMode
}

/**
 * Per-key bridge slot.
 *
 * Invariants:
 * - `refs` is reserved BEFORE any await (pending share safe).
 * - Close only when `refs` hits 0 for the current generation (or closeAll).
 * - `generation` invalidates in-flight creates after teardown so peers never
 *   receive a URL that has already been closed.
 */
interface BridgeSlot {
    key: string
    /** Holders that reserved or currently use this bridge. */
    refs: number
    /** Bumped on teardown; mismatches mean the slot was closed under us. */
    generation: number
    localProxyUrl?: string
    /** Shared in-flight anonymize for this generation (pending share). */
    createPromise?: Promise<string>
}

function normalizeProxyType(type?: string): ProxyType {
    const normalized = (type || 'http').toLowerCase().trim()
    if (normalized === 'https' || normalized === 'socks5') return normalized
    return 'http'
}

function sanitizeHost(rawHost: string): string {
    return rawHost
        .trim()
        .replace(/^[a-z0-9+.-]+:\/\//i, '')
        .replace(/\/+$/, '')
}

function buildServerUrl(type: ProxyType, host: string, port: number): string {
    return `${type}://${sanitizeHost(host)}:${port}`
}

async function safeClose(url: string): Promise<void> {
    try {
        await closeAnonymizedProxy(url, true)
    } catch {
        // ignore close failures (already closed / process teardown)
    }
}

export class ProxyBridgeService {
    private readonly slots = new Map<string, BridgeSlot>()

    private shouldBridge(input: ProxyBridgeInput, type: ProxyType): boolean {
        return type !== 'socks5' && !!input.username && !!input.password
    }

    /** Predict bridge mode without acquiring (preflight UI / diagnostics). Never logs secrets. */
    predictBridgeMode(input: ProxyBridgeInput): ProxyBridgeMode {
        const type = normalizeProxyType(input.type)
        return this.shouldBridge(input, type) ? 'anonymized' : 'direct'
    }

    private buildBridgeKey(input: ProxyBridgeInput, type: ProxyType): string {
        const host = sanitizeHost(input.host)
        const username = input.username || ''
        const credentialHash = createHash('sha256')
            .update(`${username}:${input.password || ''}`)
            .digest('hex')
        return `${type}|${host}|${input.port}|${credentialHash}`
    }

    private buildUpstreamUrl(input: ProxyBridgeInput, type: ProxyType): string {
        const host = sanitizeHost(input.host)
        const username = encodeURIComponent(input.username || '')
        const password = encodeURIComponent(input.password || '')
        return `${type}://${username}:${password}@${host}:${input.port}`
    }

    private getOrCreateSlot(bridgeKey: string): BridgeSlot {
        let slot = this.slots.get(bridgeKey)
        if (!slot) {
            slot = { key: bridgeKey, refs: 0, generation: 0 }
            this.slots.set(bridgeKey, slot)
        }
        return slot
    }

    /**
     * Drop one reservation after a failed acquire.
     * Does not close a live URL belonging to remaining holders.
     */
    private dropReservation(bridgeKey: string, slot: BridgeSlot, generation: number): void {
        if (slot.generation !== generation) return
        if (slot.refs <= 0) return

        slot.refs -= 1
        if (slot.refs > 0) return

        const url = slot.localProxyUrl
        slot.generation += 1
        slot.localProxyUrl = undefined
        slot.createPromise = undefined
        if (this.slots.get(bridgeKey) === slot) {
            this.slots.delete(bridgeKey)
        }
        if (url) {
            void safeClose(url)
        }
    }

    /** Start or join a single anonymize call for this slot generation. */
    private ensureCreate(slot: BridgeSlot, generation: number, upstreamUrl: string): Promise<string> {
        if (slot.createPromise) return slot.createPromise

        const createPromise = anonymizeProxy(upstreamUrl)
            .then((url) => {
                if (this.slots.get(slot.key) === slot && slot.generation === generation) {
                    slot.localProxyUrl = url
                    return url
                }
                // Orphaned create (closeAll / last release raced): close to avoid leak.
                void safeClose(url)
                throw new Error('Proxy bridge was closed during create')
            })
            .finally(() => {
                if (slot.createPromise === createPromise) {
                    slot.createPromise = undefined
                }
            })

        slot.createPromise = createPromise
        return createPromise
    }

    async acquire(input: ProxyBridgeInput): Promise<ResolvedProxyConfig> {
        const type = normalizeProxyType(input.type)

        if (!this.shouldBridge(input, type)) {
            return {
                server: buildServerUrl(type, input.host, input.port),
                username: input.username,
                password: input.password,
                bridgeMode: 'direct',
            }
        }

        const bridgeKey = this.buildBridgeKey(input, type)
        const slot = this.getOrCreateSlot(bridgeKey)

        // Reservation MUST happen before any await so early peer release cannot
        // drop refs to 0 and close the URL another waiter will receive.
        slot.refs += 1
        const generation = slot.generation

        try {
            if (slot.localProxyUrl) {
                return {
                    server: slot.localProxyUrl,
                    bridgeKey,
                    bridgeMode: 'anonymized',
                }
            }

            const upstreamUrl = this.buildUpstreamUrl(input, type)
            await this.ensureCreate(slot, generation, upstreamUrl)

            if (
                this.slots.get(bridgeKey) !== slot ||
                slot.generation !== generation ||
                !slot.localProxyUrl
            ) {
                throw new Error('Proxy bridge was closed during acquire')
            }

            return {
                server: slot.localProxyUrl,
                bridgeKey,
                bridgeMode: 'anonymized',
            }
        } catch (err) {
            this.dropReservation(bridgeKey, slot, generation)
            throw err
        }
    }

    /**
     * Release one hold on a bridge key. Idempotent when key is missing / already closed.
     * Only the last holder closes the local anonymized proxy.
     */
    async release(bridgeKey?: string): Promise<void> {
        if (!bridgeKey) return

        const slot = this.slots.get(bridgeKey)
        if (!slot || slot.refs <= 0) return

        slot.refs -= 1
        if (slot.refs > 0) return

        const url = slot.localProxyUrl
        slot.generation += 1
        slot.localProxyUrl = undefined
        slot.createPromise = undefined
        if (this.slots.get(bridgeKey) === slot) {
            this.slots.delete(bridgeKey)
        }

        if (url) {
            await safeClose(url)
        }
    }

    async closeAll(): Promise<void> {
        const snapshots = Array.from(this.slots.values())
        const urls: string[] = []

        for (const slot of snapshots) {
            if (slot.localProxyUrl) {
                urls.push(slot.localProxyUrl)
            }
            // Invalidate in-flight waiters; orphaned creates close themselves.
            slot.generation += 1
            slot.refs = 0
            slot.localProxyUrl = undefined
            slot.createPromise = undefined
        }
        this.slots.clear()

        // Unique URLs only — never double-close the same endpoint.
        const unique = Array.from(new Set(urls))
        await Promise.all(unique.map((url) => safeClose(url)))
    }
}

export const proxyBridgeService = new ProxyBridgeService()
