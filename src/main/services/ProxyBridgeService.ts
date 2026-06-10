import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain'

type ProxyType = 'http' | 'https' | 'socks5'

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
}

interface BridgeRecord {
    key: string
    localProxyUrl: string
    refs: number
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

export class ProxyBridgeService {
    private readonly activeBridges = new Map<string, BridgeRecord>()

    private shouldBridge(input: ProxyBridgeInput, type: ProxyType): boolean {
        return type !== 'socks5' && !!input.username && !!input.password
    }

    private buildBridgeKey(input: ProxyBridgeInput, type: ProxyType): string {
        const host = sanitizeHost(input.host)
        const username = input.username || ''
        const password = input.password || ''
        return `${type}|${host}|${input.port}|${username}|${password}`
    }

    private buildUpstreamUrl(input: ProxyBridgeInput, type: ProxyType): string {
        const host = sanitizeHost(input.host)
        const username = encodeURIComponent(input.username || '')
        const password = encodeURIComponent(input.password || '')
        return `${type}://${username}:${password}@${host}:${input.port}`
    }

    async acquire(input: ProxyBridgeInput): Promise<ResolvedProxyConfig> {
        const type = normalizeProxyType(input.type)

        if (!this.shouldBridge(input, type)) {
            return {
                server: buildServerUrl(type, input.host, input.port),
                username: input.username,
                password: input.password,
            }
        }

        const bridgeKey = this.buildBridgeKey(input, type)
        const existing = this.activeBridges.get(bridgeKey)
        if (existing) {
            existing.refs += 1
            return {
                server: existing.localProxyUrl,
                bridgeKey,
            }
        }

        const upstreamUrl = this.buildUpstreamUrl(input, type)
        const localProxyUrl = await anonymizeProxy(upstreamUrl)
        this.activeBridges.set(bridgeKey, {
            key: bridgeKey,
            localProxyUrl,
            refs: 1,
        })

        return {
            server: localProxyUrl,
            bridgeKey,
        }
    }

    async release(bridgeKey?: string): Promise<void> {
        if (!bridgeKey) return

        const record = this.activeBridges.get(bridgeKey)
        if (!record) return

        record.refs -= 1
        if (record.refs > 0) return

        this.activeBridges.delete(bridgeKey)
        try {
            await closeAnonymizedProxy(record.localProxyUrl, true)
        } catch {
            // ignore
        }
    }

    async closeAll(): Promise<void> {
        const snapshots = Array.from(this.activeBridges.values())
        this.activeBridges.clear()

        await Promise.all(
            snapshots.map(async (record) => {
                try {
                    await closeAnonymizedProxy(record.localProxyUrl, true)
                } catch {
                    // ignore
                }
            })
        )
    }
}

export const proxyBridgeService = new ProxyBridgeService()
