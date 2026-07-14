import type {
    ProxyBridgeMode,
    ProxyRuntimeCheckResult,
    ProxyRuntimeReasonCode as SharedProxyRuntimeReasonCode,
} from '../../../../shared/proxy-contracts'

export type ProxyRuntimePreflightResult = ProxyRuntimeCheckResult
export type ProxyBridgeModeUi = ProxyBridgeMode
export type ProxyRuntimeReasonCode = SharedProxyRuntimeReasonCode

export interface ProxyHttpQuickCheckResult {
    alive: boolean
    responseTime: number
    latencyMs?: number
    reason?: string
    reasonCode?: string
    observedIp?: string | null
    bridgeMode?: 'none'
    mode?: 'http_quick'
}

/** Preload may not expose checkRuntime until root wires it — optional on the API surface. */
export type ProxiesApiWithRuntime = {
    check: (id: number) => Promise<ProxyHttpQuickCheckResult>
    checkRuntime?: (id: number) => Promise<ProxyRuntimePreflightResult>
}

export function getProxiesApi(): ProxiesApiWithRuntime | null {
    if (typeof window === 'undefined' || !window.electronAPI?.proxies) {
        return null
    }
    return window.electronAPI.proxies as ProxiesApiWithRuntime
}
