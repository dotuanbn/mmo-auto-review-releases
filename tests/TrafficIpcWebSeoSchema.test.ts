/**
 * IPC schema bounds for Web SEO dwell + webSeoRequireOrganic fields on traffic boost.
 * Source: src/shared/ipc-schemas.ts (trafficBoostCreateSchema / trafficBoostUpdateSchema)
 */
import { describe, expect, it } from 'vitest'
import {
    trafficBoostCreateSchema,
    trafficBoostUpdateSchema,
} from '../src/shared/ipc-schemas'

function expectOk(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify({ input, result })).toBe(true)
    return result
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify({ input, result })).toBe(false)
    return result
}

const createBase = {
    name: 'Web SEO Boost',
    accountIds: [1],
    locationIds: [2],
    trafficMode: 'web_seo' as const,
    searchKeywords: ['cafe ha noi'],
}

// ---------------------------------------------------------------------------
// trafficBoostCreateSchema — web SEO fields
// ---------------------------------------------------------------------------

describe('trafficBoostCreateSchema web SEO fields', () => {
    it('accepts dwell bounds 10..300 and webSeoRequireOrganic boolean', () => {
        expectOk(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 10,
            webSeoMaxDwellSeconds: 300,
            webSeoRequireOrganic: true,
        })
        expectOk(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 30,
            webSeoMaxDwellSeconds: 90,
            webSeoRequireOrganic: false,
        })
        expectOk(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 10,
            webSeoMaxDwellSeconds: 10,
            webSeoRequireOrganic: false,
        })
    })

    it('requires at least one non-empty searchKeywords for web_seo mode', () => {
        expectFail(trafficBoostCreateSchema, {
            name: createBase.name,
            accountIds: createBase.accountIds,
            locationIds: createBase.locationIds,
            trafficMode: 'web_seo',
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            searchKeywords: [],
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            searchKeywords: ['  ', ''],
        })
        expectOk(trafficBoostCreateSchema, {
            ...createBase,
            searchKeywords: ['seo keyword'],
        })
    })

    it('rejects dwell outside 10..300', () => {
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 9,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 301,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMaxDwellSeconds: 0,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMaxDwellSeconds: 999,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 10.5,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMaxDwellSeconds: '60',
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 90,
            webSeoMaxDwellSeconds: 30,
        })
    })

    it('rejects non-boolean webSeoRequireOrganic', () => {
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoRequireOrganic: 'yes',
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoRequireOrganic: 1,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoRequireOrganic: null,
        })
    })

    it('rejects unknown keys (strict)', () => {
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoMinDwellSeconds: 30,
            webSeoMaxDwellSeconds: 90,
            webSeoRequireOrganic: true,
            evilPayload: true,
        })
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            webSeoUnknown: 1,
        })
        // Legacy field name must not pass strict schema
        expectFail(trafficBoostCreateSchema, {
            ...createBase,
            requireOrganic: true,
        })
    })
})

// ---------------------------------------------------------------------------
// trafficBoostUpdateSchema — web SEO fields
// ---------------------------------------------------------------------------

describe('trafficBoostUpdateSchema web SEO fields', () => {
    it('accepts partial web SEO fields with valid bounds', () => {
        expectOk(trafficBoostUpdateSchema, {
            webSeoMinDwellSeconds: 10,
        })
        expectOk(trafficBoostUpdateSchema, {
            webSeoMaxDwellSeconds: 300,
        })
        expectOk(trafficBoostUpdateSchema, {
            webSeoRequireOrganic: true,
        })
        expectOk(trafficBoostUpdateSchema, {
            webSeoMinDwellSeconds: 45,
            webSeoMaxDwellSeconds: 120,
            webSeoRequireOrganic: false,
        })
    })

    it('rejects dwell outside 10..300 and non-boolean webSeoRequireOrganic', () => {
        expectFail(trafficBoostUpdateSchema, { webSeoMinDwellSeconds: 9 })
        expectFail(trafficBoostUpdateSchema, { webSeoMinDwellSeconds: 301 })
        expectFail(trafficBoostUpdateSchema, { webSeoMaxDwellSeconds: 5 })
        expectFail(trafficBoostUpdateSchema, { webSeoMaxDwellSeconds: 400 })
        expectFail(trafficBoostUpdateSchema, { webSeoRequireOrganic: 'true' })
        expectFail(trafficBoostUpdateSchema, { webSeoRequireOrganic: 0 })
        expectFail(trafficBoostUpdateSchema, {
            webSeoMinDwellSeconds: 120,
            webSeoMaxDwellSeconds: 45,
        })
    })

    it('rejects unknown keys (strict)', () => {
        expectFail(trafficBoostUpdateSchema, {
            webSeoRequireOrganic: true,
            malware: 'x',
        })
        expectFail(trafficBoostUpdateSchema, {
            webSeoMinDwellSeconds: 20,
            unexpectedField: 1,
        })
        expectFail(trafficBoostUpdateSchema, {
            requireOrganic: true,
        })
    })
})
