import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { runtimePolicyService } from '../runtime/v2/runtimePolicy'
import { RuntimeRagStats } from '../runtime/v2/types'
import { getRuntimeLogger } from '../utils/runtimeLogger'

export interface RagIngestInput {
    campaignType?: string
    campaignId?: number | null
    threadId?: number
    domain?: string
    goal?: string
    riskType?: string
    signalText?: string
    action: string
    decisionSource?: string
    success?: boolean
    detail?: string
    error?: string
    recoverPath?: string
    latencyMs?: number
    metadata?: Record<string, unknown>
    timestamp?: string
}

export interface RagRetrieveInput {
    campaignType?: string
    campaignId?: number | null
    threadId?: number
    domain?: string
    goal?: string
    riskType?: string
    signalText: string
    topK?: number
    maxContextChars?: number
    minScore?: number
    latencyBudgetMs?: number
}

export interface RagHit {
    id: number
    score: number
    action: string
    decisionSource: string
    success: boolean
    signalText: string
    detail?: string
    recoverPath?: string
    createdAt?: string
}

export interface RagRetrieveResult {
    used: boolean
    weak: boolean
    timedOut: boolean
    latencyMs: number
    hits: RagHit[]
    context: string
}

export interface RagClearScope {
    campaignId?: number
    domain?: string
    riskType?: string
}

type KnowledgeRow = typeof schema.agentKnowledge.$inferSelect

const RISKY_TYPES = new Set(['popup', 'modal', 'captcha', 'recover', 'interruption'])

class MiniRagService {
    private readonly logger = getRuntimeLogger({ module: 'mini-rag' })
    private retrievalLatencies: number[] = []
    private retrievalCount = 0
    private retrievalHitCount = 0
    private lastRetrievalAt?: string

    private normalizeText(value: string): string {
        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    private tokenize(value: string): Set<string> {
        const normalized = this.normalizeText(value)
        if (!normalized) {
            return new Set()
        }
        const parts = normalized
            .split(' ')
            .filter(token => token.length >= 3)
        return new Set(parts)
    }

    private safeDomain(input?: string): string {
        if (!input) return 'unknown'
        const raw = input.trim()
        if (!raw) return 'unknown'
        try {
            const url = raw.startsWith('http://') || raw.startsWith('https://')
                ? new URL(raw)
                : new URL(`https://${raw}`)
            return (url.hostname || 'unknown').toLowerCase()
        } catch {
            return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || 'unknown'
        }
    }

    private hash(input: string): string {
        let hash = 0
        for (let i = 0; i < input.length; i++) {
            hash = ((hash << 5) - hash) + input.charCodeAt(i)
            hash |= 0
        }
        return Math.abs(hash).toString(36)
    }

    private toIso(value: unknown): string | undefined {
        if (value instanceof Date) {
            return value.toISOString()
        }
        if (typeof value === 'number') {
            const date = new Date(value)
            return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
        }
        if (typeof value === 'string') {
            const date = new Date(value)
            return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
        }
        return undefined
    }

    private overlapScore(query: Set<string>, candidate: Set<string>): number {
        if (query.size === 0 || candidate.size === 0) {
            return 0
        }
        let intersection = 0
        query.forEach(token => {
            if (candidate.has(token)) {
                intersection += 1
            }
        })
        const union = (query.size + candidate.size) - intersection
        if (union <= 0) {
            return 0
        }
        return intersection / union
    }

    private trackRetrieval(latencyMs: number, hitCount: number): void {
        this.retrievalCount += 1
        if (hitCount > 0) {
            this.retrievalHitCount += 1
        }
        this.lastRetrievalAt = new Date().toISOString()
        this.retrievalLatencies.push(latencyMs)
        if (this.retrievalLatencies.length > 2000) {
            this.retrievalLatencies.splice(0, this.retrievalLatencies.length - 2000)
        }
    }

    private getP95LatencyMs(): number {
        if (this.retrievalLatencies.length === 0) {
            return 0
        }
        const sorted = [...this.retrievalLatencies].sort((a, b) => a - b)
        const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
        return Math.round(sorted[index] || 0)
    }

    private getAvgLatencyMs(): number {
        if (this.retrievalLatencies.length === 0) {
            return 0
        }
        const total = this.retrievalLatencies.reduce((sum, value) => sum + value, 0)
        return Math.round(total / this.retrievalLatencies.length)
    }

    private buildContext(hits: RagHit[], maxChars: number): string {
        if (hits.length === 0) {
            return ''
        }

        const lines: string[] = []
        let used = 0
        for (const hit of hits) {
            const line = `#${hit.id} score=${hit.score.toFixed(2)} action=${hit.action} source=${hit.decisionSource} success=${hit.success ? 'yes' : 'no'} signal="${hit.signalText.slice(0, 120)}"${hit.detail ? ` detail="${hit.detail.slice(0, 120)}"` : ''}`
            if (used + line.length > maxChars) {
                break
            }
            lines.push(line)
            used += line.length
        }
        return lines.join('\n')
    }

    private isWriteAllowed(riskType: string): boolean {
        const policy = runtimePolicyService.getPolicy()
        if (!policy.ragEnabled || policy.ragWriteMode === 'off') {
            return false
        }
        if (policy.ragWriteMode === 'all') {
            return true
        }
        const normalized = riskType.toLowerCase()
        return RISKY_TYPES.has(normalized) || /(popup|modal|captcha|recover|interruption|context_)/.test(normalized)
    }

    private async pruneExpired(): Promise<void> {
        const db = getDatabase()
        db.delete(schema.agentKnowledge)
            .where(and(
                sql`${schema.agentKnowledge.expiresAt} is not null`,
                lt(schema.agentKnowledge.expiresAt, new Date()),
            ))
            .run()
    }

    async ingest(input: RagIngestInput): Promise<void> {
        const goal = (input.goal || 'generic').toLowerCase()
        const riskType = (input.riskType || 'generic').toLowerCase()
        if (!this.isWriteAllowed(riskType)) {
            return
        }

        const policy = runtimePolicyService.getPolicy()
        const signalText = this.normalizeText(input.signalText || input.detail || input.action || '')
        if (!signalText) {
            return
        }

        const now = input.timestamp ? new Date(input.timestamp) : new Date()
        const nowMs = Number.isNaN(now.getTime()) ? Date.now() : now.getTime()
        const dedupeWindowMs = Math.max(60_000, policy.ragDedupeWindowMinutes * 60_000)
        const dedupeBucket = Math.floor(nowMs / dedupeWindowMs)
        const domain = this.safeDomain(input.domain)
        const signatureSeed = [
            input.campaignType || 'generic',
            domain,
            goal,
            riskType,
            signalText,
            input.action,
            input.success === false ? '0' : '1',
            dedupeBucket.toString(),
        ].join('|')
        const signature = this.hash(signatureSeed)
        const expiresAt = new Date(nowMs + (policy.ragEntryTtlHours * 60 * 60 * 1000))

        const db = getDatabase()
        try {
            db.insert(schema.agentKnowledge).values({
                signature,
                campaignType: input.campaignType || 'generic',
                campaignId: input.campaignId ?? null,
                threadId: input.threadId ?? null,
                domain,
                goal,
                riskType,
                signalText,
                action: input.action,
                decisionSource: input.decisionSource || 'runtime',
                success: input.success !== false,
                detail: input.detail,
                error: input.error,
                recoverPath: input.recoverPath,
                latencyMs: input.latencyMs,
                metadata: input.metadata ? JSON.stringify(input.metadata) : null,
                createdAt: new Date(nowMs),
                expiresAt,
            }).run()
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            if (!/unique/i.test(message)) {
                this.logger.warn({
                    event: 'rag_ingest_failed',
                    error: message,
                })
            }
        }

        // Keep memory table bounded by TTL.
        void this.pruneExpired()
    }

    async retrieve(input: RagRetrieveInput): Promise<RagRetrieveResult> {
        const policy = runtimePolicyService.getPolicy()
        const startedAt = Date.now()
        if (!policy.ragEnabled) {
            return {
                used: false,
                weak: true,
                timedOut: false,
                latencyMs: 0,
                hits: [],
                context: '',
            }
        }

        const topK = Math.max(1, Math.min(12, input.topK || policy.ragTopK))
        const maxContextChars = Math.max(200, Math.min(6000, input.maxContextChars || policy.ragMaxContextChars))
        const minScore = Math.max(0, Math.min(1, input.minScore ?? policy.ragMinScore))
        const latencyBudgetMs = Math.max(100, input.latencyBudgetMs || policy.ragLatencyBudgetMs)
        const domain = this.safeDomain(input.domain)
        const goal = (input.goal || 'generic').toLowerCase()
        const riskType = (input.riskType || 'generic').toLowerCase()
        const queryTokens = this.tokenize(input.signalText)

        const db = getDatabase()
        const since = new Date(Date.now() - (policy.ragEntryTtlHours * 60 * 60 * 1000))
        const rows = db.select()
            .from(schema.agentKnowledge)
            .where(and(
                sql`${schema.agentKnowledge.expiresAt} is null or ${schema.agentKnowledge.expiresAt} >= ${new Date()}`,
                sql`${schema.agentKnowledge.createdAt} >= ${since}`,
            ))
            .orderBy(desc(schema.agentKnowledge.createdAt))
            .limit(500)
            .all()

        const scored = rows.map((row) => {
            const rowDomain = this.safeDomain(row.domain)
            const rowTokens = this.tokenize(`${row.signalText || ''} ${row.detail || ''} ${row.action || ''}`)
            const textScore = this.overlapScore(queryTokens, rowTokens)

            let score = 0
            if (rowDomain === domain) {
                score += 0.30
            } else if (domain !== 'unknown' && rowDomain.endsWith(domain.split('.').slice(-2).join('.'))) {
                score += 0.10
            }

            if ((row.goal || '').toLowerCase() === goal) {
                score += 0.20
            }
            if ((row.riskType || '').toLowerCase() === riskType) {
                score += 0.22
            }
            if (row.success) {
                score += 0.12
            } else {
                score -= 0.06
            }
            if (input.campaignId !== undefined && input.campaignId !== null && row.campaignId === input.campaignId) {
                score += 0.05
            }
            if ((row.decisionSource || '').toLowerCase() === 'llm+rag') {
                score += 0.03
            }

            score += (textScore * 0.48)
            return {
                row,
                score: Math.max(0, Math.min(1, score)),
            }
        })

        const hits: RagHit[] = scored
            .filter(item => item.score >= minScore)
            .sort((left, right) => right.score - left.score)
            .slice(0, topK)
            .map(item => ({
                id: item.row.id,
                score: Number(item.score.toFixed(4)),
                action: item.row.action,
                decisionSource: item.row.decisionSource,
                success: item.row.success === true,
                signalText: item.row.signalText,
                detail: item.row.detail || undefined,
                recoverPath: item.row.recoverPath || undefined,
                createdAt: this.toIso(item.row.createdAt),
            }))

        const elapsedMs = Date.now() - startedAt
        if (elapsedMs > latencyBudgetMs) {
            this.trackRetrieval(elapsedMs, 0)
            return {
                used: true,
                weak: true,
                timedOut: true,
                latencyMs: elapsedMs,
                hits: [],
                context: '',
            }
        }

        this.trackRetrieval(elapsedMs, hits.length)
        return {
            used: true,
            weak: hits.length === 0,
            timedOut: false,
            latencyMs: elapsedMs,
            hits,
            context: this.buildContext(hits, maxContextChars),
        }
    }

    getStats(): RuntimeRagStats {
        const db = getDatabase()
        const row = db.select({ count: sql<number>`count(*)` }).from(schema.agentKnowledge).get()
        const totalEntries = Number(row?.count || 0)
        const hitRate = this.retrievalCount > 0
            ? Number((this.retrievalHitCount / this.retrievalCount).toFixed(4))
            : 0

        return {
            enabled: runtimePolicyService.getPolicy().ragEnabled,
            totalEntries,
            retrievalCount: this.retrievalCount,
            retrievalHitCount: this.retrievalHitCount,
            hitRate,
            p95LatencyMs: this.getP95LatencyMs(),
            avgLatencyMs: this.getAvgLatencyMs(),
            lastRetrievalAt: this.lastRetrievalAt,
            updatedAt: new Date().toISOString(),
        }
    }

    clear(scope?: RagClearScope): { deleted: number } {
        const db = getDatabase()
        const rows = db.select({
            id: schema.agentKnowledge.id,
            campaignId: schema.agentKnowledge.campaignId,
            domain: schema.agentKnowledge.domain,
            riskType: schema.agentKnowledge.riskType,
        }).from(schema.agentKnowledge).all()

        const ids = rows
            .filter((row) => {
                if (!scope) {
                    return true
                }
                if (scope.campaignId !== undefined && row.campaignId !== scope.campaignId) {
                    return false
                }
                if (scope.domain && this.safeDomain(row.domain) !== this.safeDomain(scope.domain)) {
                    return false
                }
                if (scope.riskType && (row.riskType || '').toLowerCase() !== scope.riskType.toLowerCase()) {
                    return false
                }
                return true
            })
            .map(row => row.id)

        let deleted = 0
        for (const id of ids) {
            deleted += db.delete(schema.agentKnowledge).where(eq(schema.agentKnowledge.id, id)).run().changes
        }
        return { deleted }
    }
}

export const miniRagService = new MiniRagService()
