import { useState } from 'react'
import { Network, Loader2 } from 'lucide-react'
import { IconButton } from '../ui/surface'
import { ProxyPreflightInlineBadge } from './ProxyPreflightResult'
import {
    getProxiesApi,
    type ProxyRuntimePreflightResult,
} from './types'

export function ProxyRuntimePreflightButton({
    proxyId,
    label,
    onResult,
    disabled,
}: {
    proxyId: number
    label?: string
    onResult?: (result: ProxyRuntimePreflightResult) => void
    disabled?: boolean
}) {
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<ProxyRuntimePreflightResult | null>(null)
    const [error, setError] = useState<string | null>(null)

    const handleClick = async () => {
        const api = getProxiesApi()
        if (!api?.checkRuntime) {
            const msg = 'proxies.checkRuntime not available (preload not wired)'
            setError(msg)
            setResult(null)
            return
        }

        setLoading(true)
        setError(null)
        try {
            const res = await api.checkRuntime(proxyId)
            setResult(res)
            onResult?.(res)
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Runtime preflight failed'
            setError(message.slice(0, 160))
            setResult(null)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-1">
                <IconButton
                    icon={loading ? Loader2 : Network}
                    label={label || 'Runtime preflight'}
                    onClick={() => {
                        void handleClick()
                    }}
                    disabled={disabled || loading}
                    className={loading ? '[&_svg]:animate-spin' : ''}
                />
            </div>
            {error ? (
                <span className="max-w-[140px] truncate text-[10px] text-rose-600" title={error}>
                    {error}
                </span>
            ) : (
                <ProxyPreflightInlineBadge result={result} />
            )}
        </div>
    )
}
