import { describe, expect, it } from 'vitest'
import {
    fproxyAddSlotSchema,
    fproxyPoolPolicySchema,
    fproxyPoolSnapshotSchema,
    fproxySlotPublicSchema,
    fproxyUpdatePolicyInputSchema,
} from '../src/shared/fproxy-pool-contracts'

function expectOk<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    input: unknown,
): T {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(result)).toBe(true)
    return result.data as T
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    expect(schema.safeParse(input).success).toBe(false)
}

describe('fproxy pool contracts', () => {
    it('accepts multi-slot public snapshot without secrets', () => {
        const snapshot = expectOk(fproxyPoolSnapshotSchema, {
            slots: [
                {
                    id: 1,
                    label: 'Slot 1',
                    enabled: true,
                    hasSecret: true,
                    status: 'leased',
                    available: false,
                    cooldownUntil: null,
        ipExpiresAt: null,
        nextRotateAt: null,
                    currentEgress: { ip: '203.0.113.10', location: 'Ha Noi' },
                    leaseOwner: { kind: 'traffic_visit', id: 'campaign-1:thread-0', threadId: 0 },
                    lastTest: Date.now(),
                    error: null,
                },
                {
                    id: 2,
                    label: 'Slot 2',
                    enabled: true,
                    hasSecret: true,
                    status: 'idle',
                    available: true,
                    cooldownUntil: null,
        ipExpiresAt: null,
        nextRotateAt: null,
                    currentEgress: null,
                    leaseOwner: null,
                    lastTest: null,
                    error: null,
                },
            ],
            policy: { strictUnique: true, rotationPolicy: 'rotate_per_visit' },
            capacity: 1,
            revision: 4,
            serverNow: Date.now(),
        })
        expect(snapshot.slots).toHaveLength(2)
        expect(snapshot.capacity).toBe(1)
    })

    it('rejects secret-like extra fields on public slot DTO', () => {
        expectFail(fproxySlotPublicSchema, {
            id: 1,
            label: 'Slot',
            enabled: true,
            hasSecret: true,
            status: 'idle',
            available: true,
            cooldownUntil: null,
        ipExpiresAt: null,
        nextRotateAt: null,
            currentEgress: null,
            leaseOwner: null,
            lastTest: null,
            error: null,
            apiKey: 'should-not-be-here',
        })
    })

    it('validates add-slot and policy inputs', () => {
        expectOk(fproxyAddSlotSchema, {
            label: '  FProxy Slot 1  ',
            apiKey: 'plain-key-value-without-spaces-edges',
            enabled: true,
        })
        expectFail(fproxyAddSlotSchema, { label: 'x', apiKey: '  padded  ' })
        expectOk(fproxyPoolPolicySchema, {
            strictUnique: true,
            rotationPolicy: 'sticky_session',
        })
        expectFail(fproxyUpdatePolicyInputSchema, {
            strictUnique: true,
            rotationPolicy: 'unknown',
        })
    })
})
