import { describe, expect, it } from 'vitest'
import {
    absolutePathSchema,
    automationScriptSchema,
    campaignCreateSchema,
    campaignUpdateSchema,
    emptyOrAbsolutePathSchema,
    httpUrlSchema,
    locationAddSchema,
    optionalHttpUrlSchema,
    projectCreateSchema,
    safeCliArgSchema,
    scriptActionSchema,
    settingsPatchSchema,
    toolNameSchema,
    toolsRunSchema,
    trafficBoostCreateSchema,
    trafficModeSchema,
    trafficTaskCreateSchema,
} from '../src/shared/ipc-schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectOk(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
    return result
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
    return result
}

// ---------------------------------------------------------------------------
// URL: http/https only
// ---------------------------------------------------------------------------

describe('httpUrlSchema', () => {
    it('accepts http and https URLs', () => {
        expectOk(httpUrlSchema, 'https://maps.google.com/place/abc')
        expectOk(httpUrlSchema, 'http://example.com')
        expectOk(httpUrlSchema, 'https://goo.gl/maps/xyz')
        expectOk(httpUrlSchema, '  https://example.com/path?q=1  ')
    })

    it('rejects non-http(s) protocols', () => {
        for (const url of [
            'javascript:alert(1)',
            'file:///C:/secrets.txt',
            'data:text/html,hi',
            'ftp://files.example.com',
            'ws://localhost:8080',
            'vbscript:msgbox(1)',
        ]) {
            expectFail(httpUrlSchema, url)
        }
    })

    it('rejects empty, non-URL, and oversized values', () => {
        expectFail(httpUrlSchema, '')
        expectFail(httpUrlSchema, '   ')
        expectFail(httpUrlSchema, 'not-a-url')
        expectFail(httpUrlSchema, 'htp://broken')
        expectFail(httpUrlSchema, `https://x.com/${'a'.repeat(5000)}`)
    })
})

describe('optionalHttpUrlSchema', () => {
    it('treats empty string and undefined as undefined', () => {
        const empty = optionalHttpUrlSchema.safeParse('')
        expect(empty.success).toBe(true)
        if (empty.success) expect(empty.data).toBeUndefined()

        const undef = optionalHttpUrlSchema.safeParse(undefined)
        expect(undef.success).toBe(true)
        if (undef.success) expect(undef.data).toBeUndefined()
    })

    it('accepts valid https and rejects file/javascript', () => {
        expectOk(optionalHttpUrlSchema, 'https://site.example')
        expectFail(optionalHttpUrlSchema, 'file:///tmp')
        expectFail(optionalHttpUrlSchema, 'javascript:void(0)')
    })
})

// ---------------------------------------------------------------------------
// Strict unknown fields
// ---------------------------------------------------------------------------

describe('strict unknown fields', () => {
    it('locationAddSchema rejects unknown keys', () => {
        expectOk(locationAddSchema, {
            name: 'Cafe',
            url: 'https://maps.google.com/?cid=1',
        })
        expectFail(locationAddSchema, {
            name: 'Cafe',
            url: 'https://maps.google.com/?cid=1',
            inject: true,
        })
    })

    it('projectCreateSchema rejects unknown keys', () => {
        expectOk(projectCreateSchema, { name: 'Proj A' })
        expectFail(projectCreateSchema, { name: 'Proj A', ownerId: 99 })
    })

    it('settingsPatchSchema rejects unknown keys', () => {
        expectOk(settingsPatchSchema, { headless: true, maxConcurrentBrowsers: 2 })
        expectFail(settingsPatchSchema, { headless: true, evilKey: 'x' })
        expectFail(settingsPatchSchema, { notASetting: 1 })
    })

    it('settingsPatchSchema accepts secret fields and enableAgenticReview boolean', () => {
        expectOk(settingsPatchSchema, {
            groqApiKey: '********',
            fproxyApiKey: '',
            captchaSolverApiKey: 'new-secret-value',
            enableAgenticReview: false,
            hfMaxMemoryMB: 2048,
        })
        expectFail(settingsPatchSchema, { enableAgenticReview: 'yes' })
        expectFail(settingsPatchSchema, { groqApiKey: 12345 })
    })

    it('campaignCreateSchema rejects unknown keys', () => {
        const valid = {
            name: 'Camp',
            locationIds: [1],
            reviewTemplates: ['Nice place'],
        }
        expectOk(campaignCreateSchema, valid)
        expectFail(campaignCreateSchema, { ...valid, extraField: 1 })
    })

    it('trafficBoostCreateSchema rejects unknown keys', () => {
        const valid = {
            name: 'Boost',
            accountIds: [1],
            locationIds: [2],
        }
        expectOk(trafficBoostCreateSchema, valid)
        expectFail(trafficBoostCreateSchema, { ...valid, malware: true })
    })

    it('trafficTaskCreateSchema rejects unknown keys', () => {
        expectOk(trafficTaskCreateSchema, { locationId: 1, targetViews: 100 })
        expectFail(trafficTaskCreateSchema, {
            locationId: 1,
            targetViews: 100,
            unknown: 'no',
        })
    })

    it('scriptActionSchema rejects unknown top-level and params keys', () => {
        const base = {
            id: 'a1',
            type: 'click' as const,
            name: 'Click btn',
            enabled: true,
            params: { selector: '#ok' },
        }
        expectOk(scriptActionSchema, base)
        expectFail(scriptActionSchema, { ...base, hacked: true })
        expectFail(scriptActionSchema, {
            ...base,
            params: { selector: '#ok', nestedEvil: 1 },
        })
    })
})

// ---------------------------------------------------------------------------
// Campaign / traffic normalization inputs
// ---------------------------------------------------------------------------

describe('campaignCreateSchema', () => {
    const base = {
        name: 'Review Campaign',
        locationIds: [1, 2],
        reviewTemplates: ['Great food', 'Awesome service'],
    }

    it('accepts minimal and full valid payloads', () => {
        expectOk(campaignCreateSchema, base)
        expectOk(campaignCreateSchema, {
            ...base,
            accountIds: [10],
            proxyIds: [20, 21],
            rating: 5,
            delayMin: 30,
            delayMax: 120,
            maxReviewsPerAccountPerDay: 5,
            maxMapScroll: 10,
            projectId: 3,
            workingHoursStart: '09:00',
            workingHoursEnd: '18:00',
        })
    })

    it('rejects empty locationIds / reviewTemplates and out-of-range rating', () => {
        expectFail(campaignCreateSchema, { ...base, locationIds: [] })
        expectFail(campaignCreateSchema, { ...base, reviewTemplates: [] })
        expectFail(campaignCreateSchema, { ...base, rating: 0 })
        expectFail(campaignCreateSchema, { ...base, rating: 6 })
        expectFail(campaignCreateSchema, { ...base, locationIds: [0] })
        expectFail(campaignCreateSchema, { ...base, delayMin: -1 })
    })

    it('rejects non-integer ids and missing required fields', () => {
        expectFail(campaignCreateSchema, { name: 'X', locationIds: [1] })
        expectFail(campaignCreateSchema, {
            name: 'X',
            locationIds: [1.5],
            reviewTemplates: ['t'],
        })
        expectFail(campaignCreateSchema, {
            name: '',
            locationIds: [1],
            reviewTemplates: ['t'],
        })
    })
})

describe('campaignUpdateSchema', () => {
    it('accepts array or serialized-string forms for list fields', () => {
        expectOk(campaignUpdateSchema, { name: 'Renamed' })
        expectOk(campaignUpdateSchema, { locationIds: [1, 2] })
        expectOk(campaignUpdateSchema, { locationIds: '[1,2,3]' })
        expectOk(campaignUpdateSchema, { accountIds: null })
        expectOk(campaignUpdateSchema, { proxyIds: '1,2,3' })
        expectOk(campaignUpdateSchema, {
            reviewTemplates: ['a'],
            status: 'paused',
            progress: 50,
        })
        expectOk(campaignUpdateSchema, { reviewTemplates: '["one"]' })
    })

    it('rejects invalid status and progress range', () => {
        expectFail(campaignUpdateSchema, { status: 'cancelled' })
        expectFail(campaignUpdateSchema, { progress: 101 })
        expectFail(campaignUpdateSchema, { progress: -1 })
        expectFail(campaignUpdateSchema, { rating: 9 })
    })
})

describe('trafficModeSchema', () => {
    it('accepts known traffic modes only', () => {
        for (const mode of ['direct', 'organic', 'web_seo', 'map_search'] as const) {
            expectOk(trafficModeSchema, mode)
        }
        expectFail(trafficModeSchema, 'random')
        expectFail(trafficModeSchema, 'seo')
        expectFail(trafficModeSchema, '')
    })
})

describe('trafficTaskCreateSchema', () => {
    it('accepts valid task and rejects invalid ranges', () => {
        expectOk(trafficTaskCreateSchema, {
            locationId: 1,
            targetViews: 1000,
            viewsPerDay: 50,
            useProxies: true,
            projectId: 2,
            proxyIds: '1,2',
        })
        expectFail(trafficTaskCreateSchema, { locationId: 1, targetViews: 0 })
        expectFail(trafficTaskCreateSchema, { locationId: 0, targetViews: 10 })
        expectFail(trafficTaskCreateSchema, {
            locationId: 1,
            targetViews: 10,
            viewsPerDay: 0,
        })
    })
})

describe('trafficBoostCreateSchema', () => {
    const base = {
        name: 'Maps Boost',
        accountIds: [1],
        locationIds: [2],
    }

    it('accepts valid boost with optional traffic fields', () => {
        expectOk(trafficBoostCreateSchema, base)
        expectOk(trafficBoostCreateSchema, {
            ...base,
            trafficMode: 'map_search',
            searchKeywords: ['cafe ha noi', 'coffee'],
            maxMapScroll: 5,
            threadsCount: 4,
            visitsPerLocation: 10,
            delayMinSeconds: 5,
            delayMaxSeconds: 30,
            aiAutoControl: false,
        })
    })

    it('allows anonymous account pool but requires locationIds', () => {
        expectOk(trafficBoostCreateSchema, { ...base, accountIds: [] })
        expectFail(trafficBoostCreateSchema, { ...base, locationIds: [] })
        expectFail(trafficBoostCreateSchema, {
            ...base,
            trafficMode: 'invalid_mode',
        })
        expectFail(trafficBoostCreateSchema, {
            ...base,
            threadsCount: 0,
        })
        expectFail(trafficBoostCreateSchema, {
            ...base,
            threadsCount: 99,
        })
        expectFail(trafficBoostCreateSchema, {
            ...base,
            visitsPerLocation: 0,
        })
    })

    it('rejects empty name after trim', () => {
        expectFail(trafficBoostCreateSchema, { ...base, name: '   ' })
    })
})

// ---------------------------------------------------------------------------
// Script action validation
// ---------------------------------------------------------------------------

describe('scriptActionSchema', () => {
    const clickAction = {
        id: 'step-1',
        type: 'click' as const,
        name: 'Click submit',
        enabled: true,
        params: {
            selector: 'button.submit',
            selectorType: 'css' as const,
        },
    }

    it('accepts core action types with valid params', () => {
        expectOk(scriptActionSchema, clickAction)
        expectOk(scriptActionSchema, {
            id: 'nav',
            type: 'navigate',
            name: 'Open maps',
            enabled: true,
            params: { url: 'https://maps.google.com' },
        })
        expectOk(scriptActionSchema, {
            id: 'type',
            type: 'type',
            name: 'Type text',
            enabled: false,
            params: { selector: 'input', text: 'hello', clearFirst: true },
        })
        expectOk(scriptActionSchema, {
            id: 'rate',
            type: 'set_rating',
            name: 'Rate 5',
            enabled: true,
            params: { rating: 5 },
        })
    })

    it('accepts nested loop/condition action trees', () => {
        expectOk(scriptActionSchema, {
            id: 'loop-1',
            type: 'loop',
            name: 'Loop actions',
            enabled: true,
            params: {
                loopCount: 3,
                loopActions: [clickAction],
            },
            onError: 'retry',
            maxRetries: 2,
        })
        expectOk(scriptActionSchema, {
            id: 'cond-1',
            type: 'condition',
            name: 'If var',
            enabled: true,
            params: {
                thenActions: [clickAction],
                elseActions: [],
            },
            condition: {
                variable: 'flag',
                operator: 'equals',
                value: 'yes',
            },
        })
    })

    it('rejects invalid action type, rating, and condition operator', () => {
        expectFail(scriptActionSchema, {
            ...clickAction,
            type: 'execute_shell',
        })
        expectFail(scriptActionSchema, {
            ...clickAction,
            type: 'set_rating',
            params: { rating: 0 },
        })
        expectFail(scriptActionSchema, {
            ...clickAction,
            condition: {
                variable: 'x',
                operator: 'gt',
                value: '1',
            },
        })
        expectFail(scriptActionSchema, {
            ...clickAction,
            onError: 'ignore',
        })
        expectFail(scriptActionSchema, {
            ...clickAction,
            maxRetries: 99,
        })
    })

    it('rejects missing required fields', () => {
        expectFail(scriptActionSchema, {
            id: 'a',
            type: 'click',
            name: 'x',
            params: {},
        })
        expectFail(scriptActionSchema, {
            type: 'click',
            name: 'x',
            enabled: true,
            params: {},
        })
    })
})

describe('automationScriptSchema', () => {
    it('applies defaults for description/version/variables/actions', () => {
        const result = automationScriptSchema.safeParse({
            id: 'script-1',
            name: 'My Script',
        })
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data.description).toBe('')
            expect(result.data.version).toBe('1.0.0')
            expect(result.data.variables).toEqual([])
            expect(result.data.actions).toEqual([])
        }
    })

    it('accepts full script with settings and variables', () => {
        expectOk(automationScriptSchema, {
            id: 's1',
            name: 'Full',
            description: 'desc',
            version: '2.0.0',
            variables: [
                {
                    name: 'query',
                    type: 'string',
                    defaultValue: 'cafe',
                    required: true,
                },
            ],
            actions: [
                {
                    id: 'a1',
                    type: 'google_search',
                    name: 'Search',
                    enabled: true,
                    params: { searchQuery: 'cafe' },
                },
            ],
            settings: {
                headless: true,
                defaultTimeout: 30000,
                viewport: { width: 1280, height: 720 },
            },
        })
    })

    it('rejects unknown keys and invalid settings ranges', () => {
        expectFail(automationScriptSchema, {
            id: 's1',
            name: 'X',
            extra: true,
        })
        expectFail(automationScriptSchema, {
            id: 's1',
            name: 'X',
            settings: {
                headless: true,
                defaultTimeout: 100,
                viewport: { width: 1280, height: 720 },
            },
        })
        expectFail(automationScriptSchema, {
            id: 's1',
            name: 'X',
            settings: {
                headless: true,
                defaultTimeout: 5000,
                viewport: { width: 10, height: 720 },
            },
        })
    })
})

// ---------------------------------------------------------------------------
// Tool args / path schemas
// ---------------------------------------------------------------------------

describe('absolutePathSchema', () => {
    it('accepts Windows drive, UNC, and POSIX absolute paths', () => {
        expectOk(absolutePathSchema, 'C:\\Users\\data')
        expectOk(absolutePathSchema, 'D:/projects/app')
        expectOk(absolutePathSchema, '\\\\server\\share\\folder')
        expectOk(absolutePathSchema, '/home/user/data')
        expectOk(absolutePathSchema, '  /var/tmp  ')
    })

    it('rejects relative paths and null bytes', () => {
        expectFail(absolutePathSchema, 'relative/path')
        expectFail(absolutePathSchema, './local')
        expectFail(absolutePathSchema, 'folder')
        expectFail(absolutePathSchema, '')
        expectFail(absolutePathSchema, 'C:\\path\\with\0null')
    })
})

describe('emptyOrAbsolutePathSchema (settings dataDir / analyticsKeyFilePath)', () => {
    it('accepts empty string and absolute paths', () => {
        expectOk(emptyOrAbsolutePathSchema, '')
        expectOk(emptyOrAbsolutePathSchema, 'C:\\Users\\data')
        expectOk(emptyOrAbsolutePathSchema, '/home/user/keys/sa.json')
        expectOk(emptyOrAbsolutePathSchema, '  /var/tmp  ')
    })

    it('rejects relative paths and null bytes', () => {
        expectFail(emptyOrAbsolutePathSchema, 'relative/path')
        expectFail(emptyOrAbsolutePathSchema, './local')
        expectFail(emptyOrAbsolutePathSchema, 'folder')
        expectFail(emptyOrAbsolutePathSchema, 'C:\\path\\with\0null')
    })

    it('settingsPatchSchema enforces empty|absolute for dataDir and analyticsKeyFilePath', () => {
        expectOk(settingsPatchSchema, { dataDir: '' })
        expectOk(settingsPatchSchema, { analyticsKeyFilePath: '' })
        expectOk(settingsPatchSchema, {
            dataDir: 'C:\\Users\\app\\data',
            analyticsKeyFilePath: 'C:\\Users\\app\\key.json',
        })
        expectFail(settingsPatchSchema, { dataDir: 'relative' })
        expectFail(settingsPatchSchema, { analyticsKeyFilePath: '../escape.json' })
        expectFail(settingsPatchSchema, { dataDir: 'C:\\bad\0path' })
    })
})

describe('safeCliArgSchema', () => {
    it('accepts plain safe arguments', () => {
        expectOk(safeCliArgSchema, '--flag')
        expectOk(safeCliArgSchema, 'value123')
        expectOk(safeCliArgSchema, 'path/to/file.txt')
        expectOk(safeCliArgSchema, '')
    })

    it('rejects shell metacharacters and null bytes', () => {
        for (const bad of [
            'a;b',
            'a&b',
            'a|b',
            'a`b',
            'a$b',
            'a<b',
            'a>b',
            'line\nbreak',
            'line\rbreak',
            'nul\0byte',
        ]) {
            expectFail(safeCliArgSchema, bad)
        }
    })

    it('rejects oversized args', () => {
        expectFail(safeCliArgSchema, 'x'.repeat(1025))
    })
})

describe('toolNameSchema', () => {
    it('accepts alphanumeric tool names with ._-', () => {
        expectOk(toolNameSchema, 'tool')
        expectOk(toolNameSchema, 'my-tool_v1.2')
        expectOk(toolNameSchema, 'A9')
        expectOk(toolNameSchema, '  export.csv  ')
    })

    it('rejects empty, spaces, and special characters', () => {
        expectFail(toolNameSchema, '')
        expectFail(toolNameSchema, '   ')
        expectFail(toolNameSchema, 'bad name')
        expectFail(toolNameSchema, 'tool/name')
        expectFail(toolNameSchema, '../escape')
        expectFail(toolNameSchema, '-leading')
        expectFail(toolNameSchema, '.leading')
    })
})

describe('toolsRunSchema', () => {
    it('accepts [name] and [name, args[]] tuples', () => {
        expectOk(toolsRunSchema, ['export-csv'])
        expectOk(toolsRunSchema, ['export-csv', undefined])
        expectOk(toolsRunSchema, ['my_tool', ['--out', 'report.json']])
        expectOk(toolsRunSchema, ['t1', []])
    })

    it('rejects unsafe args, invalid names, and too many args', () => {
        expectFail(toolsRunSchema, ['bad name'])
        expectFail(toolsRunSchema, ['tool', ['a;b']])
        expectFail(toolsRunSchema, ['tool', ['$(rm -rf /)']])
        expectFail(toolsRunSchema, ['tool', Array.from({ length: 65 }, (_, i) => `a${i}`)])
        expectFail(toolsRunSchema, [])
        expectFail(toolsRunSchema, [''])
    })
})
