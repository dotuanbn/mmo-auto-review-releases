import { z } from 'zod'

export const runtimeLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export const captchaModeSchema = z.enum(['manual', 'auto_skip', 'hybrid'])
export const ragWriteModeSchema = z.enum(['off', 'risk_only', 'all'])

export const runtimePolicyPatchSchema = z.object({
    captchaMode: captchaModeSchema.optional(),
    captchaAutoSkipMaxStrikes: z.number().int().min(0).max(10).optional(),
    captchaManualWaitSeconds: z.number().int().min(30).max(600).optional(),
    queueConcurrency: z.number().int().min(1).max(12).optional(),
    queueIntervalMs: z.number().int().min(500).max(30000).optional(),
    networkRetryMax: z.number().int().min(0).max(10).optional(),
    uiRetryMax: z.number().int().min(0).max(10).optional(),
    logLevel: runtimeLogLevelSchema.optional(),
    ragEnabled: z.boolean().optional(),
    ragTopK: z.number().int().min(1).max(12).optional(),
    ragMaxContextChars: z.number().int().min(200).max(6000).optional(),
    ragWriteMode: ragWriteModeSchema.optional(),
    ragLatencyBudgetMs: z.number().int().min(100).max(5000).optional(),
    ragMinScore: z.number().min(0).max(1).optional(),
    ragEntryTtlHours: z.number().int().min(24).max(2160).optional(),
    ragDedupeWindowMinutes: z.number().int().min(1).max(10080).optional(),
})

export const runtimeActionEventSchema = z.object({
    eventId: z.string().min(1),
    campaignId: z.number().int().nullable(),
    campaignName: z.string(),
    round: z.number().int().min(0),
    threadId: z.number().int().min(0),
    accountEmail: z.string(),
    locationName: z.string(),
    action: z.string().min(1),
    source: z.string().min(1),
    success: z.boolean(),
    detail: z.string().optional(),
    thought: z.string().optional(),
    error: z.string().optional(),
    durationMs: z.number().int().min(0).optional(),
    step: z.number().int().min(0).optional(),
    elementId: z.number().int().positive().optional(),
    attempt: z.number().int().min(0).optional(),
    retryCategory: z.string().optional(),
    queueDepth: z.number().int().min(0).optional(),
    latencyMs: z.number().int().min(0).optional(),
    recoverPath: z.string().optional(),
    decisionSource: z.enum(['heuristic', 'llm', 'llm+rag']).optional(),
    ragUsed: z.boolean().optional(),
    ragHitCount: z.number().int().min(0).optional(),
    ragEvidenceIds: z.array(z.number().int().positive()).max(32).optional(),
    decisionLatencyMs: z.number().int().min(0).optional(),
    timestamp: z.string().min(1),
})

export const reportActionTraceQuerySchema = z.object({
    campaignId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
})

export const ragClearScopeSchema = z.object({
    campaignId: z.number().int().positive().optional(),
    domain: z.string().min(1).max(255).optional(),
    riskType: z.string().min(1).max(128).optional(),
}).optional()
