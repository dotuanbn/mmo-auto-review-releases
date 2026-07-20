import { describe, expect, it } from 'vitest'
import {
    parseInterruptionCandidate,
    parseLoginAgentAction,
    parseReviewAgentAction,
    parseTrafficAgentAction,
} from '../src/main/automation/agentSchemas'

describe('parseTrafficAgentAction', () => {
    it('accepts valid traffic actions', () => {
        for (const action of ['click', 'wait', 'scroll_down', 'scroll_up', 'finish', 'fail'] as const) {
            const result = parseTrafficAgentAction({
                thought: 'reason',
                action,
                element_id: action === 'click' ? 3 : undefined,
            })
            expect(result.success, action).toBe(true)
        }
    })

    it('rejects review-only action type "type"', () => {
        const result = parseTrafficAgentAction({
            thought: 'type something',
            action: 'type',
            value: 'hello',
        })
        expect(result.success).toBe(false)
    })

    it('rejects empty thought', () => {
        expect(
            parseTrafficAgentAction({ thought: '', action: 'wait' }).success
        ).toBe(false)
    })

    it('rejects non-positive element_id', () => {
        expect(
            parseTrafficAgentAction({ thought: 'x', action: 'click', element_id: 0 }).success
        ).toBe(false)
    })
})

describe('parseReviewAgentAction', () => {
    it('accepts type action with value', () => {
        const result = parseReviewAgentAction({
            thought: 'fill review',
            action: 'type',
            value: 'Great place',
            element_id: 2,
        })
        expect(result.success).toBe(true)
    })

    it('rejects traffic-only scroll_up', () => {
        const result = parseReviewAgentAction({
            thought: 'scroll',
            action: 'scroll_up',
        })
        expect(result.success).toBe(false)
    })
})

describe('parseInterruptionCandidate', () => {
    it('requires positive element_id', () => {
        expect(parseInterruptionCandidate({ element_id: 1 }).success).toBe(true)
        expect(parseInterruptionCandidate({ element_id: 0 }).success).toBe(false)
        expect(parseInterruptionCandidate({ thought: 'maybe' }).success).toBe(false)
    })
})

describe('parseLoginAgentAction', () => {
    it('accepts login-specific action enums', () => {
        for (const action of [
            'type_email',
            'type_password',
            'type_recovery_email',
            'type_recovery_phone',
            'click',
            'wait',
            'finish',
            'fail',
            'manual_required',
        ] as const) {
            const result = parseLoginAgentAction({
                thought: 'login step',
                action,
                value: action.startsWith('type_') ? 'secret' : undefined,
            })
            expect(result.success, action).toBe(true)
        }
    })

    it('rejects generic traffic actions not in login enum', () => {
        expect(
            parseLoginAgentAction({ thought: 'x', action: 'scroll_down' }).success
        ).toBe(false)
    })
})
