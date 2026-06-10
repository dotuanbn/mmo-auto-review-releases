import { proxyService } from '../services/ProxyService'

/**
 * ProxyRotator - Automatic proxy rotation with error handling
 * Switches proxies on errors or after N actions
 */

export interface ProxyConfig {
    host: string
    port: number
    username?: string
    password?: string
    type: 'http' | 'https' | 'socks5'
}

export interface RotatorConfig {
    rotateAfterActions: number // Rotate after N successful actions (0 = never)
    rotateOnError: boolean // Automatically rotate on connection error
    cooldownMs: number // Cooldown before reusing a proxy
    maxFailures: number // Max failures before marking proxy dead
}

interface ProxyState {
    proxyId: number
    usageCount: number
    failureCount: number
    lastUsed: number
    inCooldown: boolean
}

export class ProxyRotator {
    private config: RotatorConfig
    private proxyStates: Map<number, ProxyState> = new Map()
    private currentProxyId: number | null = null
    private actionCount: number = 0

    constructor(config: Partial<RotatorConfig> = {}) {
        this.config = {
            rotateAfterActions: config.rotateAfterActions ?? 10,
            rotateOnError: config.rotateOnError ?? true,
            cooldownMs: config.cooldownMs ?? 60000, // 1 minute
            maxFailures: config.maxFailures ?? 3,
        }
    }

    /**
     * Get the next available proxy
     */
    async getNextProxy(): Promise<ProxyConfig | null> {
        const proxies = await proxyService.getActive()
        if (proxies.length === 0) return null

        // Filter out proxies in cooldown or with too many failures
        const now = Date.now()
        const availableProxies = proxies.filter(proxy => {
            const state = this.proxyStates.get(proxy.id)
            if (!state) return true
            if (state.failureCount >= this.config.maxFailures) return false
            if (state.inCooldown && now - state.lastUsed < this.config.cooldownMs) return false
            return true
        })

        if (availableProxies.length === 0) {
            // Reset all states if no proxies available
            console.log('ProxyRotator: All proxies exhausted, resetting states')
            this.proxyStates.clear()
            return this.getNextProxy()
        }

        // Select proxy with least usage
        const sortedByUsage = [...availableProxies].sort((a, b) => {
            const stateA = this.proxyStates.get(a.id)
            const stateB = this.proxyStates.get(b.id)
            return (stateA?.usageCount ?? 0) - (stateB?.usageCount ?? 0)
        })

        const selectedProxy = sortedByUsage[0]
        this.currentProxyId = selectedProxy.id

        // Initialize or update state
        if (!this.proxyStates.has(selectedProxy.id)) {
            this.proxyStates.set(selectedProxy.id, {
                proxyId: selectedProxy.id,
                usageCount: 0,
                failureCount: 0,
                lastUsed: now,
                inCooldown: false,
            })
        }

        const state = this.proxyStates.get(selectedProxy.id)!
        state.usageCount++
        state.lastUsed = now
        state.inCooldown = false

        return {
            host: selectedProxy.host,
            port: selectedProxy.port,
            username: selectedProxy.username || undefined,
            password: selectedProxy.password || undefined,
            type: selectedProxy.type as 'http' | 'https' | 'socks5',
        }
    }

    /**
     * Get current proxy
     */
    async getCurrentProxy(): Promise<ProxyConfig | null> {
        if (this.currentProxyId === null) {
            return this.getNextProxy()
        }

        const proxy = await proxyService.getById(this.currentProxyId)
        if (!proxy || proxy.status !== 'active') {
            return this.getNextProxy()
        }

        return {
            host: proxy.host,
            port: proxy.port,
            username: proxy.username || undefined,
            password: proxy.password || undefined,
            type: proxy.type as 'http' | 'https' | 'socks5',
        }
    }

    /**
     * Report successful action - may trigger rotation
     */
    async onSuccess(): Promise<boolean> {
        this.actionCount++

        if (this.config.rotateAfterActions > 0 &&
            this.actionCount >= this.config.rotateAfterActions) {
            await this.rotate()
            return true
        }

        return false
    }

    /**
     * Report failed action - may trigger rotation
     */
    async onError(error?: string): Promise<boolean> {
        if (this.currentProxyId === null) return false

        const state = this.proxyStates.get(this.currentProxyId)
        if (state) {
            state.failureCount++

            // Mark proxy as dead if too many failures
            if (state.failureCount >= this.config.maxFailures) {
                await proxyService.updateStatus(this.currentProxyId, 'dead')
                console.log(`ProxyRotator: Proxy ${this.currentProxyId} marked as dead after ${state.failureCount} failures`)
            }
        }

        if (this.config.rotateOnError) {
            await this.rotate()
            return true
        }

        return false
    }

    /**
     * Force rotation to next proxy
     */
    async rotate(): Promise<ProxyConfig | null> {
        // Put current proxy in cooldown
        if (this.currentProxyId !== null) {
            const state = this.proxyStates.get(this.currentProxyId)
            if (state) {
                state.inCooldown = true
                state.lastUsed = Date.now()
            }
        }

        this.currentProxyId = null
        this.actionCount = 0
        return this.getNextProxy()
    }

    /**
     * Reset all proxy states
     */
    reset(): void {
        this.proxyStates.clear()
        this.currentProxyId = null
        this.actionCount = 0
    }

    /**
     * Get rotator statistics
     */
    getStats(): {
        currentProxyId: number | null
        actionCount: number
        proxyStates: Array<{
            proxyId: number
            usageCount: number
            failureCount: number
            inCooldown: boolean
        }>
    } {
        return {
            currentProxyId: this.currentProxyId,
            actionCount: this.actionCount,
            proxyStates: Array.from(this.proxyStates.values()).map(s => ({
                proxyId: s.proxyId,
                usageCount: s.usageCount,
                failureCount: s.failureCount,
                inCooldown: s.inCooldown,
            }))
        }
    }
}

export const proxyRotator = new ProxyRotator()
