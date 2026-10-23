/**
 * LayaService — client for the local Laya AI proxy (OpenAI-compatible).
 *
 * Base URL is the owned sidecar loopback endpoint from LayaSidecarManager.
 * Chat: POST /chat/completions  model=tier1-local
 * User message content is JSON: { request_type, ...payload }
 * Result JSON lives in choices[0].message.content
 *
 * The local sidecar is unauthenticated. Cloud credentials must never be sent.
 */

import {
    LAYA_RISK_LEVELS,
    type LayaDecisionResult,
    type LayaHealthStatus,
    type LayaRiskContext,
    type LayaRiskLevel,
    type LayaRiskResult,
} from '../../shared/laya-types'
import { layaSidecarManager } from './LayaSidecarManager'


const REQUEST_TIMEOUT_MS = 3000
const LAYA_MODEL = 'tier1-local'

const DEFAULT_RISK_RESULT: LayaRiskResult = {
    score: 50,
    level: 'medium',
    reason: 'Laya proxy unreachable; using default medium risk',
    shouldProceed: true,
}

const DEFAULT_DECISION_RESULT: LayaDecisionResult = {
    decision: 'proceed',
    confidence: 0.5,
    reasoning: 'Laya proxy unreachable; using default proceed',
    tier: 'fallback',
}

const OFFLINE_HEALTH: Omit<LayaHealthStatus, 'latencyMs'> = {
    online: false,
    tier1Ready: false,
    tier2Ready: false,
    version: '',
}

export class LayaService {
    private static singleton: LayaService | undefined

    private constructor() {}

    static get instance(): LayaService {
        if (!LayaService.singleton) {
            LayaService.singleton = new LayaService()
        }
        return LayaService.singleton
    }

    /** GET /models with round-trip timing. Offline when the owned sidecar is not ready. */
    async healthCheck(): Promise<LayaHealthStatus> {
        if (layaSidecarManager.isLowResourceMode() && layaSidecarManager.getStatus().state !== 'ready') {
            return { ...OFFLINE_HEALTH, latencyMs: 0 }
        }
        const startedAt = Date.now()
        try {
            const body = await this.getJson('/models')
            return parseHealthStatus(body, Date.now() - startedAt)
        } catch {
            return { ...OFFLINE_HEALTH, latencyMs: Date.now() - startedAt }
        }
    }

    /** POST chat/completions with request_type=risk_score. */
    async riskScore(ctx: LayaRiskContext): Promise<LayaRiskResult> {
        try {
            const raw = await this.chatCompletion('risk_score', toRecord(ctx))
            if (!isRecord(raw)) {
                throw new Error('Invalid risk_score payload')
            }
            return parseRiskResult(raw)
        } catch {
            return { ...DEFAULT_RISK_RESULT }
        }
    }

    /** POST chat/completions with request_type set to `type`. */
    async decide(type: string, payload: Record<string, unknown>): Promise<LayaDecisionResult> {
        try {
            const raw = await this.chatCompletion(type, payload)
            if (!isRecord(raw)) {
                throw new Error('Invalid decision payload')
            }
            return parseDecisionResult(raw)
        } catch {
            return { ...DEFAULT_DECISION_RESULT }
        }
    }

    private async chatCompletion(
        requestType: string,
        payload: Record<string, unknown>,
    ): Promise<unknown> {
        const content = JSON.stringify({ request_type: requestType, ...payload })
        const body = await this.postJson('/chat/completions', {
            model: LAYA_MODEL,
            messages: [{ role: 'user', content }],
        })
        const parsed = extractMessageContent(body)
        if (parsed === undefined) {
            throw new Error('Laya completion missing message content')
        }
        return parsed
    }

    private async getJson(path: string): Promise<unknown> {
        const release = layaSidecarManager.beginUse(false)
        try {
            const response = await this.request(path, {
                method: 'GET',
                headers: { Accept: 'application/json' },
            })
            return await readJson(response)
        } finally { release() }
    }

    private async postJson(path: string, body: unknown): Promise<unknown> {
        const release = layaSidecarManager.beginUse()
        try {
            const response = await this.request(path, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            return await readJson(response)
        } finally { release() }
    }

    private async request(path: string, init: RequestInit): Promise<Response> {
        const sidecar = await layaSidecarManager.ensureRunning()
        if (sidecar.state !== 'ready') {
            throw new Error(sidecar.error || 'Laya sidecar is unavailable')
        }
        const response = await fetch(`${layaSidecarManager.endpoint}/api/v1${path}`, {
            ...init,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) {
            throw new Error(`Laya HTTP ${response.status}`)
        }
        return response
    }
}

export const layaService = LayaService.instance

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRecord(value: object): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
        result[key] = (value as Record<string, unknown>)[key]
    }
    return result
}

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return {}
    try {
        return JSON.parse(text) as unknown
    } catch {
        throw new Error('Laya returned non-JSON body')
    }
}

function stripMarkdownFence(raw: string): string {
    const match = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
    return match?.[1] ?? raw
}

function parseJsonValue(raw: string): unknown {
    try {
        return JSON.parse(stripMarkdownFence(raw.trim())) as unknown
    } catch {
        return undefined
    }
}

function extractMessageContent(body: unknown): unknown {
    if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
        return undefined
    }
    const first = body.choices[0]
    if (!isRecord(first) || !isRecord(first.message)) return undefined
    const content = first.message.content
    if (typeof content === 'string') return parseJsonValue(content)
    return content
}

function extractModelIds(body: Record<string, unknown>): string[] {
    if (!Array.isArray(body.data)) return []
    const ids: string[] = []
    for (const item of body.data) {
        if (isRecord(item) && typeof item.id === 'string') ids.push(item.id)
    }
    return ids
}

function parseHealthStatus(body: unknown, latencyMs: number): LayaHealthStatus {
    const record = isRecord(body) ? body : {}
    const models = extractModelIds(record)
    const hybrid = models.some((id) => id.includes('hybrid'))
    return {
        online: true,
        latencyMs,
        tier1Ready: asBoolean(record.tier1Ready ?? record.tier1_ready, models.length > 0),
        tier2Ready: asBoolean(record.tier2Ready ?? record.tier2_ready, hybrid || models.length > 1),
        version: asString(record.version ?? record.laya_version, 'unknown'),
    }
}

function parseRiskLevel(value: unknown, score: number): LayaRiskLevel {
    if (typeof value === 'string' && (LAYA_RISK_LEVELS as readonly string[]).includes(value)) {
        return value as LayaRiskLevel
    }
    if (score >= 85) return 'critical'
    if (score >= 70) return 'high'
    if (score >= 40) return 'medium'
    return 'low'
}

function parseRiskResult(record: Record<string, unknown>): LayaRiskResult {
    const score = clamp(asNumber(record.score, 50), 0, 100)
    const result: LayaRiskResult = {
        score,
        level: parseRiskLevel(record.level, score),
        reason: asString(record.reason, 'No reason provided'),
        shouldProceed: asBoolean(record.shouldProceed, score < 70),
    }
    const suggestedDelayMs = optionalNumber(record.suggestedDelayMs)
    if (suggestedDelayMs !== undefined) result.suggestedDelayMs = suggestedDelayMs
    return result
}

function parseDecisionResult(record: Record<string, unknown>): LayaDecisionResult {
    return {
        decision: asString(record.decision, 'proceed'),
        confidence: clamp(asNumber(record.confidence, 0.5), 0, 1),
        reasoning: asString(record.reasoning, 'No reasoning provided'),
        tier: asString(record.tier, 'unknown'),
    }
}
