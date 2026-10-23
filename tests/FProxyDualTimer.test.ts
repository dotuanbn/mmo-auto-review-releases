import { describe, expect, it } from 'vitest'
import { resolveFProxyDeadlines } from '../src/main/services/FProxyApiClient'

describe('resolveFProxyDeadlines dual-timer contract', () => {
    const now = 1_700_000_000_000

    it('keeps getnew waiting_time as rotate (~2 min) and time_die as IP life (~30 min)', () => {
        const result = resolveFProxyDeadlines('1800', '120', now, 'getnew')
        expect(result.endpointExpiresAt).toBe(now + 1_800_000)
        expect(result.rotateAllowedAt).toBe(now + 120_000)
        expect(result.rotateMirroredIpLife).toBe(false)
    })

    it('sanitizes getcurrent when waiting_time mirrors time_die (~30 min)', () => {
        const result = resolveFProxyDeadlines('1781', '1781', now, 'getcurrent')
        expect(result.endpointExpiresAt).toBe(now + 1_781_000)
        // Rotate is ready/unknown — never a 29-minute fake rotate countdown.
        expect(result.rotateAllowedAt).toBe(now)
        expect(result.rotateMirroredIpLife).toBe(true)
    })

    it('sanitizes near-equal mirror within tolerance', () => {
        const result = resolveFProxyDeadlines('1800', '1799', now, 'getcurrent')
        expect(result.rotateAllowedAt).toBe(now)
        expect(result.rotateMirroredIpLife).toBe(true)
    })

    it('trusts short getcurrent waiting_time when not mirrored', () => {
        const result = resolveFProxyDeadlines('1800', '55', now, 'getcurrent')
        expect(result.rotateAllowedAt).toBe(now + 55_000)
        expect(result.rotateMirroredIpLife).toBe(false)
    })

    it('treats waiting_time 0 as ready to rotate', () => {
        const result = resolveFProxyDeadlines('1700', '0', now, 'getnew')
        expect(result.rotateAllowedAt).toBe(now)
        expect(result.endpointExpiresAt).toBe(now + 1_700_000)
    })
})
