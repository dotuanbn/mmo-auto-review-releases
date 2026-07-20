import type { ProxyRuntimePreflightResult } from './types'

function toneForResult(result: ProxyRuntimePreflightResult): {
    border: string
    bg: string
    text: string
} {
    if (result.ok) {
        return {
            border: 'border-emerald-200',
            bg: 'bg-emerald-50',
            text: 'text-emerald-800',
        }
    }
    return {
        border: 'border-rose-200',
        bg: 'bg-rose-50',
        text: 'text-rose-800',
    }
}

export function ProxyPreflightResultPanel({
    result,
    loading,
    proxyLabel,
}: {
    result: ProxyRuntimePreflightResult | null
    loading?: boolean
    proxyLabel?: string
}) {
    if (loading) {
        return (
            <div className="rounded-[14px] border border-[#e9e4f2] bg-[#faf8ff] px-3 py-2 text-xs text-[#5f5a6d]">
                Runtime preflight running{proxyLabel ? ` · ${proxyLabel}` : ''}…
            </div>
        )
    }

    if (!result) return null

    const tone = toneForResult(result)
    const latency = result.latencyMs ?? result.responseTime

    return (
        <div className={`rounded-[14px] border px-3 py-2 text-xs ${tone.border} ${tone.bg} ${tone.text}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium">
                <span>{result.ok ? 'Runtime OK' : 'Runtime FAIL'}</span>
                <span className="font-mono opacity-90">{result.reasonCode}</span>
                <span className="opacity-80">{latency}ms</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 opacity-90">
                <span>IP: {result.observedIp || '—'}</span>
                <span>Bridge: {result.bridgeMode}</span>
                {result.message ? <span className="max-w-full truncate">{result.message}</span> : null}
            </div>
        </div>
    )
}

export function ProxyPreflightInlineBadge({
    result,
}: {
    result: ProxyRuntimePreflightResult | null | undefined
}) {
    if (!result) return null
    const ok = result.ok
    return (
        <span
            className={
                ok
                    ? 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700'
                    : 'inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700'
            }
            title={`${result.reasonCode} · ${result.latencyMs}ms · IP ${result.observedIp || '—'} · bridge ${result.bridgeMode}`}
        >
            {ok ? 'RT OK' : 'RT FAIL'} · {result.latencyMs}ms
            {result.observedIp ? ` · ${result.observedIp}` : ''}
        </span>
    )
}
