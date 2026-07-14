/**
 * Pure unit tests for Web SEO action policy (site classify + safe action plan).
 * Source: src/main/automation/web-seo/WebSeoActionPolicy.ts
 */
import { describe, expect, it } from 'vitest'
import {
    buildWebSeoActionPlan,
    classifyWebSeoSite,
} from '../src/main/automation/web-seo/WebSeoActionPolicy'

const FORBIDDEN_ACTION_MARKERS = [
    'cart',
    'checkout',
    'form',
    'chat',
    'phone',
    'external',
] as const

function planActions(
    plan: ReturnType<typeof buildWebSeoActionPlan>,
): string[] {
    if (Array.isArray(plan)) {
        return plan.map((a) => (typeof a === 'string' ? a : String((a as { action?: string }).action ?? a)))
    }
    if (plan && typeof plan === 'object' && Array.isArray((plan as { actions?: unknown }).actions)) {
        const actions = (plan as { actions: unknown[] }).actions
        return actions.map((a) =>
            typeof a === 'string' ? a : String((a as { action?: string; type?: string }).action
                ?? (a as { type?: string }).type
                ?? a),
        )
    }
    throw new Error(`Unexpected action plan shape: ${JSON.stringify(plan)}`)
}

// ---------------------------------------------------------------------------
// classifyWebSeoSite
// ---------------------------------------------------------------------------

describe('classifyWebSeoSite', () => {
    it('classifies ecommerce sites from product/cart/price signals', () => {
        const kind = classifyWebSeoSite({
            url: 'https://shop.example.com/products/widget',
            title: 'Buy Widget Online — Best Price',
            text: 'Add to cart Free shipping product SKU price 199000 VND',
            htmlHints: ['product', 'add-to-cart', 'price'],
        })
        expect(kind).toBe('ecommerce')
    })

    it('classifies article / content sites', () => {
        const kind = classifyWebSeoSite({
            url: 'https://blog.example.com/posts/how-to-seo',
            title: 'How to improve SEO — Full guide',
            text: 'Published author reading time article blog post comments',
            htmlHints: ['article', 'blog', 'published'],
        })
        expect(kind).toBe('article')
    })

    it('classifies local business sites', () => {
        const kind = classifyWebSeoSite({
            url: 'https://cafe.example.com/lien-he',
            title: 'Cafe Ha Noi — Opening hours',
            text: 'Address: 12 Pho Hue, Ha Noi. Hours Mon-Sun 8:00-22:00. Near me directions map',
            htmlHints: ['address', 'opening-hours', 'local-business'],
        })
        expect(kind).toBe('local')
    })

    it('falls back to generic when signals are weak', () => {
        const kind = classifyWebSeoSite({
            url: 'https://example.com',
            title: 'Welcome',
            text: 'Hello world',
            htmlHints: [],
        })
        expect(kind).toBe('generic')
    })
})

// ---------------------------------------------------------------------------
// buildWebSeoActionPlan
// ---------------------------------------------------------------------------

describe('buildWebSeoActionPlan', () => {
    it('returns a non-empty plan without duplicate actions', () => {
        for (const siteClass of ['ecommerce', 'article', 'local', 'generic'] as const) {
            const plan = buildWebSeoActionPlan(siteClass)
            const actions = planActions(plan)
            expect(actions.length, siteClass).toBeGreaterThan(0)

            const lower = actions.map((a) => a.toLowerCase())
            expect(new Set(lower).size, siteClass).toBe(lower.length)
        }
    })

    it('never includes cart / checkout / form / chat / phone / external actions', () => {
        for (const siteClass of ['ecommerce', 'article', 'local', 'generic'] as const) {
            const actions = planActions(buildWebSeoActionPlan(siteClass))
            for (const action of actions) {
                const lower = action.toLowerCase()
                for (const marker of FORBIDDEN_ACTION_MARKERS) {
                    expect(lower.includes(marker), `${siteClass}:${action} contains ${marker}`).toBe(
                        false,
                    )
                }
            }
        }
    })

    it('accepts optional context object without changing safety invariants', () => {
        const plan = buildWebSeoActionPlan('ecommerce', {
            maxActions: 8,
            keyword: 'may loc nuoc',
            targetHost: 'example.com',
        })
        const actions = planActions(plan)
        expect(actions.length).toBeGreaterThan(0)
        expect(actions.length).toBeLessThanOrEqual(20)

        const lower = actions.map((a) => a.toLowerCase())
        expect(new Set(lower).size).toBe(lower.length)
        for (const action of lower) {
            for (const marker of FORBIDDEN_ACTION_MARKERS) {
                expect(action.includes(marker)).toBe(false)
            }
        }
    })
})
