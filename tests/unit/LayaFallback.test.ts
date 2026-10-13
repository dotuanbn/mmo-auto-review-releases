import { afterEach, describe, expect, it, vi } from 'vitest'
import { layaService } from '../../src/main/services/LayaService'
import { LayaCampaignOptimizer } from '../../src/main/services/LayaCampaignOptimizer'
import { LayaAccountHealthService } from '../../src/main/services/LayaAccountHealthService'
import type {
    AccountHealthContext,
    CampaignMetricsSnapshot,
    LayaDecisionResult,
} from '../../src/shared/laya-types'

const { sidecarMocks } = vi.hoisted(() => ({
    sidecarMocks: {
        ensureRunning: vi.fn(),
        endpoint: 'http://127.0.0.1:23456',
    },
}))

vi.mock('../../src/main/services/LayaSidecarManager', () => ({
    layaSidecarManager: {
        ensureRunning: (...args: unknown[]) => sidecarMocks.ensureRunning(...args),
        get endpoint() {
            return sidecarMocks.endpoint
        },
    },
}))

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    sidecarMocks.ensureRunning.mockReset()
})

function campaignMetrics(overrides: Partial<CampaignMetricsSnapshot> = {}): CampaignMetricsSnapshot {
    return {
        campaignId: 1,
        campaignName: 'test-campaign',
        trafficMode: 'direct',
        totalVisits: 20,
        completedVisits: 18,
        failedVisits: 2,
        successRate: 0.9,
        consecutiveFailures: 0,
        currentThreadCount: 2,
        avgVisitDurationMs: 1_000,
        elapsedMs: 5_000,
        locationCount: 1,
        ...overrides,
    }
}

function accountContext(overrides: Partial<AccountHealthContext> = {}): AccountHealthContext {
    return {
        accountId: 10,
        email: 'user@example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
        warmupLevel: 5,
        totalReviews: 12,
        banCount: 0,
        daysSinceCreation: 40,
        recentFailures: 0,
        ...overrides,
    }
}

function layaDecision(overrides: Partial<LayaDecisionResult> = {}): LayaDecisionResult {
    return {
        decision: 'aggressive',
        confidence: 0.9,
        reasoning: 'ok',
        tier: 'laya-choice',
        ...overrides,
    }
}

function healthDecisionPayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        score: 90,
        grade: 'A',
        risks: [],
        recommendations: ['none'],
        readyForTraffic: true,
        cooldownMs: 0,
        ...overrides,
    })
}

describe('LayaService local sidecar contract', () => {
    it('does not send OPENROUTER_API_KEY or any Authorization header to the local sidecar', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'sk-cloud-secret')
        sidecarMocks.ensureRunning.mockResolvedValue({ state: 'ready', endpoint: sidecarMocks.endpoint })
        const fetchMock = vi.fn(async () => ({
            ok: true,
            text: async () => JSON.stringify({
                choices: [{ message: { content: JSON.stringify({ decision: 'proceed', confidence: 0.9, reasoning: 'ok', tier: 'laya-choice' }) } }],
            }),
        }))
        vi.stubGlobal('fetch', fetchMock)

        await layaService.decide('campaign_optimization', { campaignId: 1 })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit
        const headers = init.headers as Record<string, string>
        expect(headers.Authorization).toBeUndefined()
        expect(JSON.stringify(headers)).not.toContain('sk-cloud-secret')
        expect(JSON.stringify(headers)).not.toMatch(/Bearer/i)
    })

    it('does not use HEAD as a readiness fallback when GET /models fails', async () => {
        sidecarMocks.ensureRunning.mockResolvedValue({ state: 'ready', endpoint: sidecarMocks.endpoint })
        const fetchMock = vi.fn(async () => {
            throw new Error('connection refused')
        })
        vi.stubGlobal('fetch', fetchMock)

        const health = await layaService.healthCheck()

        expect(health.online).toBe(false)
        expect(health.tier1Ready).toBe(false)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit
        expect(init.method).toBe('GET')
        expect(init.method).not.toBe('HEAD')
    })

    it('preserves offline and fallback DTOs when the sidecar is not ready', async () => {
        sidecarMocks.ensureRunning.mockResolvedValue({
            state: 'unavailable',
            endpoint: sidecarMocks.endpoint,
            error: 'Laya sidecar executable is not packaged',
        })

        const health = await layaService.healthCheck()
        const risk = await layaService.riskScore({
            accountEmail: 'a@b.c',
            locationName: 'loc',
            trafficMode: 'direct',
            threadCount: 1,
            consecutiveFailures: 0,
        })
        const decision = await layaService.decide('campaign_optimization', { campaignId: 1 })

        expect(health).toMatchObject({ online: false, tier1Ready: false, tier2Ready: false, version: '' })
        expect(risk).toMatchObject({
            score: 50,
            level: 'medium',
            shouldProceed: true,
        })
        expect(decision).toEqual({
            decision: 'proceed',
            confidence: 0.5,
            reasoning: 'Laya proxy unreachable; using default proceed',
            tier: 'fallback',
        })
    })
})

describe('LayaCampaignOptimizer fallback policy', () => {
    it('uses local heuristics when the decision tier is fallback', async () => {
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: 'aggressive',
            confidence: 0.99,
            tier: 'fallback',
        }))
        const optimizer = new LayaCampaignOptimizer()

        const result = await optimizer.optimize(campaignMetrics({ successRate: 0.8 }))

        expect(result.suggestedPacing).toBe('normal')
        expect(result.shouldContinue).toBe(true)
        expect(result.confidence).toBe(0.5)
    })

    it('uses local heuristics when Laya confidence is below 0.75', async () => {
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: 'aggressive',
            confidence: 0.74,
            tier: 'laya-choice',
        }))
        const optimizer = new LayaCampaignOptimizer()

        const result = await optimizer.optimize(campaignMetrics({ successRate: 0.6 }))

        expect(result.suggestedPacing).toBe('cautious')
        expect(result.shouldContinue).toBe(true)
    })

    it('maps a high-confidence pause decision to shouldContinue=false', async () => {
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: 'pause',
            confidence: 0.88,
            tier: 'laya-choice',
        }))
        const optimizer = new LayaCampaignOptimizer()

        const result = await optimizer.optimize(campaignMetrics({ successRate: 0.95 }))

        expect(result.suggestedPacing).toBe('pause')
        expect(result.shouldContinue).toBe(false)
    })

    it('keeps the hard shouldPauseCampaign gate authoritative over Laya', async () => {
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: 'aggressive',
            confidence: 0.99,
            tier: 'laya-choice',
        }))
        const optimizer = new LayaCampaignOptimizer()
        const metrics = campaignMetrics({ consecutiveFailures: 16, successRate: 0.95 })

        expect(optimizer.shouldPauseCampaign(metrics)).toBe(true)
        const result = await optimizer.optimize(metrics)

        expect(result.suggestedPacing).toBe('pause')
        expect(result.shouldContinue).toBe(false)
    })
})

describe('LayaAccountHealthService local gates', () => {
    it('uses local heuristics when Laya is fallback or low-confidence', async () => {
        const service = new LayaAccountHealthService()
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: healthDecisionPayload({ grade: 'A', score: 90, readyForTraffic: true }),
            confidence: 0.4,
            tier: 'laya-choice',
        }))

        const lowConfidence = await service.evaluateHealth(accountContext({ banCount: 3 }))
        expect(lowConfidence.readyForTraffic).toBe(false)
        expect(lowConfidence.grade).not.toBe('A')

        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: healthDecisionPayload({ grade: 'A', score: 90, readyForTraffic: true }),
            confidence: 0.99,
            tier: 'fallback',
        }))
        const fallback = await service.evaluateHealth(accountContext({ banCount: 3 }))
        expect(fallback.readyForTraffic).toBe(false)
        expect(fallback.grade).not.toBe('A')
    })

    it('never loosens banCount>=3 even when Laya returns a synthetic A/ready grade', async () => {
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: healthDecisionPayload({ grade: 'A', score: 95, readyForTraffic: true, cooldownMs: 0 }),
            confidence: 0.99,
            tier: 'laya-choice',
            reasoning: healthDecisionPayload({ grade: 'A', score: 95, readyForTraffic: true, cooldownMs: 0 }),
        }))
        const service = new LayaAccountHealthService()

        const result = await service.evaluateHealth(accountContext({ banCount: 3 }))

        expect(result.grade).toBe('A')
        expect(result.readyForTraffic).toBe(false)
    })

    it('never loosens a recent-ban cooldown even when Laya says the account is ready', async () => {
        vi.spyOn(layaService, 'decide').mockResolvedValue(layaDecision({
            decision: healthDecisionPayload({ grade: 'A', score: 95, readyForTraffic: true, cooldownMs: 0 }),
            confidence: 0.99,
            tier: 'laya-choice',
            reasoning: healthDecisionPayload({ grade: 'A', score: 95, readyForTraffic: true, cooldownMs: 0 }),
        }))
        const service = new LayaAccountHealthService()

        const result = await service.evaluateHealth(accountContext({
            banCount: 1,
            lastBanAt: new Date().toISOString(),
        }))

        expect(result.readyForTraffic).toBe(false)
        expect(result.cooldownMs).toBeGreaterThan(0)
    })
})
