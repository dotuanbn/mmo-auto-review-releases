import { loadSettings, saveSettings } from '../../ipc/settings'
import { RuntimePolicyV2 } from './types'
import { setRuntimeLogLevel } from '../../utils/runtimeLogger'

const POLICY_KEYS: Array<keyof RuntimePolicyV2> = [
    'captchaMode',
    'captchaAutoSkipMaxStrikes',
    'captchaManualWaitSeconds',
    'queueConcurrency',
    'queueIntervalMs',
    'networkRetryMax',
    'uiRetryMax',
    'logLevel',
    'ragEnabled',
    'ragTopK',
    'ragMaxContextChars',
    'ragWriteMode',
    'ragLatencyBudgetMs',
    'ragMinScore',
    'ragEntryTtlHours',
    'ragDedupeWindowMinutes',
]

const DEFAULT_POLICY: RuntimePolicyV2 = {
    captchaMode: 'hybrid',
    captchaAutoSkipMaxStrikes: 2,
    captchaManualWaitSeconds: 180,
    queueConcurrency: 2,
    queueIntervalMs: 5000,
    networkRetryMax: 3,
    uiRetryMax: 2,
    logLevel: 'info',
    ragEnabled: true,
    ragTopK: 4,
    ragMaxContextChars: 1200,
    ragWriteMode: 'risk_only',
    ragLatencyBudgetMs: 850,
    ragMinScore: 0.16,
    ragEntryTtlHours: 336,
    ragDedupeWindowMinutes: 240,
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback
    }
    return Math.max(min, Math.min(max, Math.round(value)))
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback
    }
    return Math.max(min, Math.min(max, value))
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
        return value
    }
    return fallback
}

function normalizePolicy(raw: Record<string, unknown> = {}): RuntimePolicyV2 {
    const rawMode = typeof raw.captchaMode === 'string' ? raw.captchaMode.trim().toLowerCase() : ''
    const captchaMode = rawMode === 'manual' || rawMode === 'auto_skip' || rawMode === 'hybrid'
        ? rawMode
        : DEFAULT_POLICY.captchaMode

    const rawLevel = typeof raw.logLevel === 'string' ? raw.logLevel.trim().toLowerCase() : ''
    const logLevel = rawLevel === 'debug' || rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error'
        ? rawLevel
        : DEFAULT_POLICY.logLevel

    const rawWriteMode = typeof raw.ragWriteMode === 'string' ? raw.ragWriteMode.trim().toLowerCase() : ''
    const ragWriteMode = rawWriteMode === 'off' || rawWriteMode === 'risk_only' || rawWriteMode === 'all'
        ? rawWriteMode
        : DEFAULT_POLICY.ragWriteMode

    return {
        captchaMode,
        captchaAutoSkipMaxStrikes: clampNumber(raw.captchaAutoSkipMaxStrikes, DEFAULT_POLICY.captchaAutoSkipMaxStrikes, 0, 10),
        captchaManualWaitSeconds: clampNumber(raw.captchaManualWaitSeconds, DEFAULT_POLICY.captchaManualWaitSeconds, 30, 600),
        queueConcurrency: clampNumber(raw.queueConcurrency, DEFAULT_POLICY.queueConcurrency, 1, 12),
        queueIntervalMs: clampNumber(raw.queueIntervalMs, DEFAULT_POLICY.queueIntervalMs, 500, 30000),
        networkRetryMax: clampNumber(raw.networkRetryMax, DEFAULT_POLICY.networkRetryMax, 0, 10),
        uiRetryMax: clampNumber(raw.uiRetryMax, DEFAULT_POLICY.uiRetryMax, 0, 10),
        logLevel,
        ragEnabled: normalizeBoolean(raw.ragEnabled, DEFAULT_POLICY.ragEnabled),
        ragTopK: clampNumber(raw.ragTopK, DEFAULT_POLICY.ragTopK, 1, 12),
        ragMaxContextChars: clampNumber(raw.ragMaxContextChars, DEFAULT_POLICY.ragMaxContextChars, 200, 6000),
        ragWriteMode,
        ragLatencyBudgetMs: clampNumber(raw.ragLatencyBudgetMs, DEFAULT_POLICY.ragLatencyBudgetMs, 100, 5000),
        ragMinScore: clampFloat(raw.ragMinScore, DEFAULT_POLICY.ragMinScore, 0, 1),
        ragEntryTtlHours: clampNumber(raw.ragEntryTtlHours, DEFAULT_POLICY.ragEntryTtlHours, 24, 2160),
        ragDedupeWindowMinutes: clampNumber(raw.ragDedupeWindowMinutes, DEFAULT_POLICY.ragDedupeWindowMinutes, 1, 10080),
    }
}

function policyToSettingsPatch(policy: RuntimePolicyV2): Record<string, unknown> {
    return {
        captchaMode: policy.captchaMode,
        captchaAutoSkipMaxStrikes: policy.captchaAutoSkipMaxStrikes,
        captchaManualWaitSeconds: policy.captchaManualWaitSeconds,
        queueConcurrency: policy.queueConcurrency,
        queueIntervalMs: policy.queueIntervalMs,
        networkRetryMax: policy.networkRetryMax,
        uiRetryMax: policy.uiRetryMax,
        logLevel: policy.logLevel,
        ragEnabled: policy.ragEnabled,
        ragTopK: policy.ragTopK,
        ragMaxContextChars: policy.ragMaxContextChars,
        ragWriteMode: policy.ragWriteMode,
        ragLatencyBudgetMs: policy.ragLatencyBudgetMs,
        ragMinScore: policy.ragMinScore,
        ragEntryTtlHours: policy.ragEntryTtlHours,
        ragDedupeWindowMinutes: policy.ragDedupeWindowMinutes,
    }
}

class RuntimePolicyService {
    getPolicy(): RuntimePolicyV2 {
        const settings = loadSettings()
        const policy = normalizePolicy(settings)
        setRuntimeLogLevel(policy.logLevel)
        return policy
    }

    updatePolicy(input: Partial<RuntimePolicyV2>): RuntimePolicyV2 {
        const settings = loadSettings()
        const nextRaw = { ...settings, ...input }
        const normalized = normalizePolicy(nextRaw)
        saveSettings({
            ...settings,
            ...policyToSettingsPatch(normalized),
        })
        setRuntimeLogLevel(normalized.logLevel)
        return normalized
    }

    applyDefaultsIfMissing(): RuntimePolicyV2 {
        const settings = loadSettings()
        const hasAnyPolicyValue = POLICY_KEYS.some((key) => settings[key] !== undefined)
        if (!hasAnyPolicyValue) {
            saveSettings({
                ...settings,
                ...policyToSettingsPatch(DEFAULT_POLICY),
            })
            setRuntimeLogLevel(DEFAULT_POLICY.logLevel)
            return DEFAULT_POLICY
        }
        const policy = normalizePolicy(settings)
        setRuntimeLogLevel(policy.logLevel)
        return policy
    }
}

export const runtimePolicyService = new RuntimePolicyService()
export { DEFAULT_POLICY as DEFAULT_RUNTIME_POLICY }
