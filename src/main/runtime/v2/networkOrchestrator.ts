import { loadSettings } from '../../ipc/settings'
import { fproxyService } from '../../services/FProxyService'
import { proxyService } from '../../services/ProxyService'
import { NetworkStateV2 } from './types'

function sanitizeApiKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim()
}

function nowIso(): string {
    return new Date().toISOString()
}

class NetworkOrchestrator {
    private currentState: NetworkStateV2 = {
        mode: 'direct',
        reason: 'default_direct_mode',
        useProxySetting: false,
        hasFProxyApiKey: false,
        checkedAt: nowIso(),
    }

    async resolveEffectiveMode(): Promise<NetworkStateV2> {
        const settings = loadSettings()
        const useProxySetting = settings.useProxy === true
        const configuredFProxyApiKey = sanitizeApiKey(settings.fproxyApiKey)
        const activeFProxyKey = sanitizeApiKey(fproxyService.getApiKey())
        const hasFProxyApiKey = configuredFProxyApiKey.length > 0 || activeFProxyKey.length > 0

        if (!useProxySetting) {
            this.currentState = {
                mode: 'direct',
                reason: 'proxy_disabled_in_settings',
                useProxySetting,
                hasFProxyApiKey,
                checkedAt: nowIso(),
            }
            return this.currentState
        }

        if (hasFProxyApiKey) {
            this.currentState = {
                mode: 'fproxy',
                reason: 'fproxy_available',
                proxyInfo: this.formatFProxyInfo(),
                useProxySetting,
                hasFProxyApiKey,
                checkedAt: nowIso(),
            }
            return this.currentState
        }

        const staticProxy = await proxyService.getRandomActive().catch(() => null)
        if (staticProxy) {
            this.currentState = {
                mode: 'static_proxy',
                reason: 'using_static_proxy_pool',
                proxyInfo: `${staticProxy.host}:${staticProxy.port}`,
                useProxySetting,
                hasFProxyApiKey,
                checkedAt: nowIso(),
            }
            return this.currentState
        }

        this.currentState = {
            mode: 'direct',
            reason: 'proxy_enabled_but_no_provider_available',
            useProxySetting,
            hasFProxyApiKey,
            checkedAt: nowIso(),
        }
        return this.currentState
    }

    getCurrentState(): NetworkStateV2 {
        return this.currentState
    }

    async testConfig(): Promise<{
        success: boolean
        state: NetworkStateV2
        message: string
    }> {
        const state = await this.resolveEffectiveMode()
        if (state.mode === 'direct') {
            return {
                success: true,
                state,
                message: 'Running in direct mode',
            }
        }

        if (state.mode === 'fproxy') {
            const proxy = await fproxyService.getProxyForBrowser()
            if (!proxy) {
                return {
                    success: false,
                    state: {
                        ...state,
                        checkedAt: nowIso(),
                    },
                    message: 'FProxy enabled but no proxy could be fetched',
                }
            }
            return {
                success: true,
                state: {
                    ...state,
                    proxyInfo: `${proxy.host}:${proxy.port}`,
                    checkedAt: nowIso(),
                },
                message: 'FProxy configuration is valid',
            }
        }

        const staticProxy = await proxyService.getRandomActive().catch(() => null)
        if (!staticProxy) {
            return {
                success: false,
                state: {
                    ...state,
                    checkedAt: nowIso(),
                },
                message: 'Static proxy mode selected but no active proxies were found',
            }
        }

        return {
            success: true,
            state: {
                ...state,
                proxyInfo: `${staticProxy.host}:${staticProxy.port}`,
                checkedAt: nowIso(),
            },
            message: 'Static proxy pool is available',
        }
    }

    private formatFProxyInfo(): string | undefined {
        const info = fproxyService.getProxyInfo()
        if (!info) return undefined
        return `${info.ip}:${info.port}${info.location ? ` (${info.location})` : ''}`
    }
}

export const networkOrchestrator = new NetworkOrchestrator()
