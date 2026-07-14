/**
 * Pure unit tests for Web SEO visit quality assessment.
 * Source: src/main/automation/web-seo/WebSeoQualityPolicy.ts
 */
import { describe, expect, it } from 'vitest'
import { assessWebSeoQuality } from '../src/main/automation/web-seo/WebSeoQualityPolicy'

type QualityInput = Parameters<typeof assessWebSeoQuality>[0]

function assess(overrides: Partial<QualityInput> & Record<string, unknown> = {}) {
    const base: QualityInput = {
        mode: 'organic',
        requireOrganic: false,
        targetHost: 'example.com',
        landedHost: 'example.com',
        dwellSeconds: 60,
        minDwellSeconds: 30,
        maxDwellSeconds: 120,
        actionCount: 8,
        interrupted: false,
        ...overrides,
    } as QualityInput
    return assessWebSeoQuality(base)
}

function scoreOf(result: ReturnType<typeof assessWebSeoQuality>): number {
    if (typeof result === 'number') return result
    if (result && typeof result === 'object') {
        const r = result as { score?: unknown; quality?: unknown }
        if (typeof r.score === 'number') return r.score
        if (typeof r.quality === 'number') return r.quality
    }
    throw new Error(`Unexpected quality result shape: ${JSON.stringify(result)}`)
}

function countableOf(result: ReturnType<typeof assessWebSeoQuality>): boolean {
    if (result && typeof result === 'object' && 'countable' in result) {
        return Boolean((result as { countable: unknown }).countable)
    }
    // Some implementations may use counted / isCountable / willCount
    if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>
        if (typeof r.counted === 'boolean') return r.counted
        if (typeof r.isCountable === 'boolean') return r.isCountable
        if (typeof r.willCount === 'boolean') return r.willCount
    }
    throw new Error(`Quality result missing countable flag: ${JSON.stringify(result)}`)
}

// ---------------------------------------------------------------------------
// assessWebSeoQuality
// ---------------------------------------------------------------------------

describe('assessWebSeoQuality', () => {
    it('marks high-quality organic visits as countable with a high score', () => {
        const result = assess({
            mode: 'organic',
            requireOrganic: true,
            targetHost: 'example.com',
            landedHost: 'www.example.com',
            dwellSeconds: 90,
            minDwellSeconds: 30,
            actionCount: 12,
            interrupted: false,
        })

        const score = scoreOf(result)
        expect(score).toBeGreaterThanOrEqual(60)
        expect(score).toBeLessThanOrEqual(100)
        expect(countableOf(result)).toBe(true)
    })

    it('allows direct visits when requireOrganic is false', () => {
        const result = assess({
            mode: 'direct',
            requireOrganic: false,
            targetHost: 'example.com',
            landedHost: 'example.com',
            dwellSeconds: 75,
            minDwellSeconds: 30,
            actionCount: 6,
            interrupted: false,
        })

        expect(countableOf(result)).toBe(true)
        expect(scoreOf(result)).toBeGreaterThan(0)
    })

    it('rejects direct visits when requireOrganic is true', () => {
        const result = assess({
            mode: 'direct',
            requireOrganic: true,
            targetHost: 'example.com',
            landedHost: 'example.com',
            dwellSeconds: 90,
            minDwellSeconds: 30,
            actionCount: 10,
            interrupted: false,
        })

        expect(countableOf(result)).toBe(false)
    })

    it('fails countable on host mismatch (including evil suffix tricks)', () => {
        for (const landedHost of [
            'evil-example.com',
            'example.com.evil',
            'notexample.com',
            'attacker.net',
        ]) {
            const result = assess({
                mode: 'organic',
                requireOrganic: false,
                targetHost: 'example.com',
                landedHost,
                dwellSeconds: 90,
                actionCount: 10,
                interrupted: false,
            })
            expect(countableOf(result), landedHost).toBe(false)
            expect(scoreOf(result), landedHost).toBeLessThanOrEqual(40)
        }
    })

    it('penalizes interrupted visits (not high-quality countable)', () => {
        const healthy = assess({
            mode: 'organic',
            requireOrganic: false,
            interrupted: false,
            dwellSeconds: 80,
            actionCount: 10,
        })
        const interrupted = assess({
            mode: 'organic',
            requireOrganic: false,
            interrupted: true,
            dwellSeconds: 80,
            actionCount: 10,
        })

        expect(scoreOf(interrupted)).toBeLessThan(scoreOf(healthy))
        // Interrupted should not be treated as a clean countable success
        expect(countableOf(interrupted)).toBe(false)
    })

    it('clamps score into 0..100', () => {
        const cases: Array<Partial<QualityInput> & Record<string, unknown>> = [
            {
                mode: 'organic',
                dwellSeconds: 10_000,
                actionCount: 10_000,
                interrupted: false,
                requireOrganic: false,
            },
            {
                mode: 'direct',
                requireOrganic: true,
                dwellSeconds: 0,
                actionCount: 0,
                interrupted: true,
                landedHost: 'evil.com',
                targetHost: 'example.com',
            },
            {
                mode: 'organic',
                dwellSeconds: -50,
                actionCount: -3,
                interrupted: false,
            },
        ]

        for (const overrides of cases) {
            const score = scoreOf(assess(overrides))
            expect(score).toBeGreaterThanOrEqual(0)
            expect(score).toBeLessThanOrEqual(100)
            expect(Number.isFinite(score)).toBe(true)
        }
    })

    it('uses the canonical engine shape and requires the configured dwell minimum', () => {
        const base = {
            discoverySource: 'organic' as const,
            organicHit: true,
            hostVerified: true,
            minTimeOnPageSeconds: 45,
            actionsPerformed: [
                { action: 'scroll_read', success: true },
                { action: 'mouse_move', success: true },
            ],
            requireOrganic: true,
            siteType: 'generic' as const,
            interrupted: false,
        }

        expect(assessWebSeoQuality({ ...base, durationSeconds: 44 }).countable).toBe(false)
        expect(assessWebSeoQuality({ ...base, durationSeconds: 45 }).countable).toBe(true)
        expect(assessWebSeoQuality({
            ...base,
            discoverySource: 'direct_fallback',
            organicHit: false,
            durationSeconds: 90,
        }).countable).toBe(false)
    })
})
