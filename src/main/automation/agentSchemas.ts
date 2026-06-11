import { z } from 'zod'

const agentActionBase = z.object({
    thought: z.string().min(1),
    element_id: z.number().int().positive().optional(),
    value: z.string().optional(),
})

export const trafficAgentActionSchema = agentActionBase.extend({
    action: z.enum(['click', 'wait', 'scroll_down', 'scroll_up', 'finish', 'fail']),
})

export const reviewAgentActionSchema = agentActionBase.extend({
    action: z.enum(['click', 'type', 'scroll_down', 'wait', 'finish', 'fail']),
})

export const interruptionCandidateSchema = z.object({
    thought: z.string().optional(),
    element_id: z.number().int().positive(),
})

export function parseTrafficAgentAction(input: unknown) {
    return trafficAgentActionSchema.safeParse(input)
}

export function parseReviewAgentAction(input: unknown) {
    return reviewAgentActionSchema.safeParse(input)
}

export function parseInterruptionCandidate(input: unknown) {
    return interruptionCandidateSchema.safeParse(input)
}

export const loginAgentActionSchema = agentActionBase.extend({
    action: z.enum(['type_email', 'type_password', 'type_recovery_email', 'type_recovery_phone', 'click', 'wait', 'finish', 'fail', 'manual_required']),
})

export function parseLoginAgentAction(input: unknown) {
    return loginAgentActionSchema.safeParse(input)
}

