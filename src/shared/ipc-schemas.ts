/**
 * Shared IPC payload schemas (Zod v4).
 * Strict by default: unknown keys/types are rejected at the boundary.
 */
import { z } from 'zod'
import {
    WEB_SEO_KEYWORD_MAX_COUNT,
    WEB_SEO_KEYWORD_MAX_LEN,
    normalizeWebSeoTargetUrl,
    parseWebSeoKeywords,
} from './web-seo-contracts'

// Re-export Web SEO helpers as single source of truth (callers/tests may import from here).
export {
    WEB_SEO_KEYWORD_MAX_COUNT,
    WEB_SEO_KEYWORD_MAX_LEN,
    normalizeWebSeoTargetUrl,
    parseWebSeoKeywords,
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const positiveIntSchema = z.number().int().positive()
export const nonNegativeIntSchema = z.number().int().nonnegative()
export const idSchema = positiveIntSchema
export const optionalIdSchema = positiveIntSchema.optional()

/** Non-empty trimmed string with max length. */
export function boundedString(max = 2000, min = 1) {
    return z.string().trim().min(min).max(max)
}

/**
 * http/https URL only. Rejects javascript:, file:, data:, etc.
 * Allows common Google Maps short forms that still use https.
 */
export const httpUrlSchema = z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => {
        try {
            const parsed = new URL(value)
            return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        } catch {
            return false
        }
    }, { message: 'URL must use http or https protocol' })

/** Optional http(s) URL (empty string treated as undefined for backward compat). */
export const optionalHttpUrlSchema = z
    .union([httpUrlSchema, z.literal(''), z.undefined()])
    .transform((v) => (v === '' || v === undefined ? undefined : v))

/**
 * Absolute filesystem path candidate (syntax only).
 * Semantic root checks live in main/ipc/validate.ts (needs Electron paths).
 */
export const absolutePathSchema = z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes('\0'), { message: 'Path must not contain null bytes' })
    .refine((value) => {
        // Windows drive path or UNC or POSIX absolute
        return (
            /^[a-zA-Z]:[\\/]/.test(value) ||
            value.startsWith('\\\\') ||
            value.startsWith('/')
        )
    }, { message: 'Path must be absolute' })

export const optionalAbsolutePathSchema = absolutePathSchema.optional()

/**
 * Empty string or absolute filesystem path (syntax only).
 * Used by settings dataDir / analyticsKeyFilePath — semantic root checks in main.
 */
export const emptyOrAbsolutePathSchema = z
    .string()
    .trim()
    .max(4096)
    .refine((value) => {
        if (value === '') return true
        if (value.includes('\0')) return false
        return (
            /^[a-zA-Z]:[\\/]/.test(value) ||
            value.startsWith('\\\\') ||
            value.startsWith('/')
        )
    }, { message: 'Path must be empty or absolute' })

/** Safe CLI arg: no shell metacharacters / null bytes. */
export const safeCliArgSchema = z
    .string()
    .max(1024)
    .refine((v) => !v.includes('\0'), { message: 'Arg must not contain null bytes' })
    .refine(
        (v) => !/[;&|`$<>\n\r]/.test(v),
        { message: 'Arg contains disallowed shell metacharacters' },
    )

export const toolNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
        message: 'Tool name must be alphanumeric (with ._-)',
    })

// ---------------------------------------------------------------------------
// Settings whitelist (keys from DEFAULT_SETTINGS in settings.ts)
// ---------------------------------------------------------------------------

export const SETTINGS_KEYS = [
    'headless',
    'hideAutomation',
    'saveProfiles',
    'maxConcurrentBrowsers',
    'randomizeUserAgent',
    'randomizeViewport',
    'groqApiKey',
    'groqModel',
    'defaultReviewLanguage',
    'defaultReviewStyle',
    'defaultReviewLength',
    'ollamaUrl',
    'ollamaModel',
    'defaultRating',
    'includePhotos',
    'autoGenerateReview',
    'enforceAccountWarmup',
    'enablePerAccountReviewStyle',
    'enableAgenticReview',
    'manualReviewSubmit',
    'allowAutoSubmitOnTrustedHosts',
    'trustedAutoSubmitHosts',
    'defaultTrafficMode',
    'defaultVisitsPerLocation',
    'defaultActionsPerVisit',
    'trafficDelayMin',
    'trafficDelayMax',
    'useProxy',
    'rotateProxyPerSession',
    'autoRemoveDeadProxies',
    'fproxyApiKey',
    'fproxyLocation',
    'delayMin',
    'delayMax',
    'maxRetries',
    'dataDir',
    'autoUpdate',
    'updateMode',
    'captchaMode',
    'captchaAutoSkipMaxStrikes',
    'captchaManualWaitSeconds',
    'queueConcurrency',
    'queueIntervalMs',
    'networkRetryMax',
    'uiRetryMax',
    'logLevel',
    'ragEnabled',
    'ragTopK',
    'ragMaxContextChars',
    'ragWriteMode',
    'ragLatencyBudgetMs',
    'ragMinScore',
    'ragEntryTtlHours',
    'ragDedupeWindowMinutes',
    'captchaSolverProvider',
    'captchaSolverApiKey',
    'captchaSolverFallbackProvider',
    'captchaSolverFallbackApiKey',
    'analyticsKeyFilePath',
    'hfModelEnabled',
    'hfTextGenModel',
    'hfAutoUnloadMinutes',
    'hfMaxMemoryMB',
] as const

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

export const settingsKeySchema = z.enum(SETTINGS_KEYS)

/** Per-key value types for settings:set / settings:saveAll. */
export const settingsValueSchema = z.union([
    z.boolean(),
    z.number(),
    z.string().max(20000),
])

export const settingsPatchSchema = z
    .object({
        headless: z.boolean().optional(),
        hideAutomation: z.boolean().optional(),
        saveProfiles: z.boolean().optional(),
        maxConcurrentBrowsers: z.number().int().min(1).max(32).optional(),
        randomizeUserAgent: z.boolean().optional(),
        randomizeViewport: z.boolean().optional(),
        groqApiKey: z.string().max(512).optional(),
        groqModel: boundedString(128, 0).optional(),
        defaultReviewLanguage: z.enum(['vi', 'en']).or(z.string().max(16)).optional(),
        defaultReviewStyle: boundedString(64, 0).optional(),
        defaultReviewLength: boundedString(32, 0).optional(),
        ollamaUrl: z.union([httpUrlSchema, z.literal('')]).optional(),
        ollamaModel: boundedString(128, 0).optional(),
        defaultRating: z.number().int().min(1).max(5).optional(),
        includePhotos: z.boolean().optional(),
        autoGenerateReview: z.boolean().optional(),
        enforceAccountWarmup: z.boolean().optional(),
        enablePerAccountReviewStyle: z.boolean().optional(),
        enableAgenticReview: z.boolean().optional(),
        manualReviewSubmit: z.boolean().optional(),
        allowAutoSubmitOnTrustedHosts: z.boolean().optional(),
        trustedAutoSubmitHosts: z.string().max(2000).optional(),
        defaultTrafficMode: z.enum(['direct', 'organic', 'web_seo', 'map_search']).or(z.string().max(32)).optional(),
        defaultVisitsPerLocation: z.number().int().min(1).max(100000).optional(),
        defaultActionsPerVisit: z.number().int().min(1).max(50).optional(),
        trafficDelayMin: z.number().int().min(0).max(3600).optional(),
        trafficDelayMax: z.number().int().min(0).max(7200).optional(),
        useProxy: z.boolean().optional(),
        rotateProxyPerSession: z.boolean().optional(),
        autoRemoveDeadProxies: z.boolean().optional(),
        fproxyApiKey: z.string().max(512).optional(),
        fproxyLocation: z.number().int().min(0).max(100000).optional(),
        delayMin: z.number().int().min(0).max(3600).optional(),
        delayMax: z.number().int().min(0).max(7200).optional(),
        maxRetries: z.number().int().min(0).max(50).optional(),
        dataDir: emptyOrAbsolutePathSchema.optional(),
        autoUpdate: z.boolean().optional(),
        updateMode: z.enum(['auto', 'manual']).or(z.string().max(16)).optional(),
        captchaMode: z.enum(['manual', 'auto_skip', 'hybrid']).or(z.string().max(32)).optional(),
        captchaAutoSkipMaxStrikes: z.number().int().min(0).max(10).optional(),
        captchaManualWaitSeconds: z.number().int().min(0).max(3600).optional(),
        queueConcurrency: z.number().int().min(1).max(32).optional(),
        queueIntervalMs: z.number().int().min(100).max(120000).optional(),
        networkRetryMax: z.number().int().min(0).max(50).optional(),
        uiRetryMax: z.number().int().min(0).max(50).optional(),
        logLevel: z.enum(['debug', 'info', 'warn', 'error']).or(z.string().max(16)).optional(),
        ragEnabled: z.boolean().optional(),
        ragTopK: z.number().int().min(1).max(50).optional(),
        ragMaxContextChars: z.number().int().min(100).max(50000).optional(),
        ragWriteMode: z.enum(['off', 'risk_only', 'all']).or(z.string().max(32)).optional(),
        ragLatencyBudgetMs: z.number().int().min(50).max(60000).optional(),
        ragMinScore: z.number().min(0).max(1).optional(),
        ragEntryTtlHours: z.number().int().min(1).max(10000).optional(),
        ragDedupeWindowMinutes: z.number().int().min(1).max(100000).optional(),
        captchaSolverProvider: z.enum(['none', '2captcha', 'capsolver']).or(z.string().max(32)).optional(),
        captchaSolverApiKey: z.string().max(512).optional(),
        captchaSolverFallbackProvider: z.enum(['none', '2captcha', 'capsolver']).or(z.string().max(32)).optional(),
        captchaSolverFallbackApiKey: z.string().max(512).optional(),
        analyticsKeyFilePath: emptyOrAbsolutePathSchema.optional(),
        hfModelEnabled: z.boolean().optional(),
        hfTextGenModel: z.string().max(256).optional(),
        hfAutoUnloadMinutes: z.number().int().min(0).max(1440).optional(),
        hfMaxMemoryMB: z.number().int().min(0).max(128000).optional(),
    })
    .strict()

export const settingsSetTupleSchema = z.tuple([settingsKeySchema, settingsValueSchema])

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const locationAddSchema = z
    .object({
        name: boundedString(500),
        url: httpUrlSchema,
        placeId: boundedString(256, 0).optional(),
        address: boundedString(1000, 0).optional(),
        phone: boundedString(64, 0).optional(),
        website: optionalHttpUrlSchema,
        category: boundedString(128, 0).optional(),
        targetRating: z.number().int().min(1).max(5).optional(),
        targetReviews: z.number().int().min(0).max(1_000_000).optional(),
        projectId: optionalIdSchema,
        searchKeywords: z.string().max(4000).optional(),
        analyticsMode: boundedString(32, 0).optional(),
        ga4PropertyId: boundedString(128, 0).optional(),
        gscSiteUrl: z.string().max(512).optional(),
        analyticsGoogleEmail: boundedString(320, 0).optional(),
    })
    .strict()

export const locationUpdateSchema = z
    .object({
        name: boundedString(500).optional(),
        url: httpUrlSchema.optional(),
        placeId: boundedString(256, 0).nullable().optional(),
        address: boundedString(1000, 0).nullable().optional(),
        phone: boundedString(64, 0).nullable().optional(),
        website: z.union([httpUrlSchema, z.literal(''), z.null()]).optional(),
        category: boundedString(128, 0).nullable().optional(),
        targetRating: z.number().int().min(1).max(5).optional(),
        targetReviews: z.number().int().min(0).max(1_000_000).optional(),
        currentReviews: z.number().int().min(0).max(1_000_000).optional(),
        status: z.enum(['pending', 'in_progress', 'done']).optional(),
        projectId: z.number().int().positive().nullable().optional(),
        searchKeywords: z.string().max(4000).nullable().optional(),
        analyticsMode: boundedString(32, 0).nullable().optional(),
        ga4PropertyId: boundedString(128, 0).nullable().optional(),
        gscSiteUrl: z.string().max(512).nullable().optional(),
        analyticsGoogleEmail: boundedString(320, 0).nullable().optional(),
    })
    .strict()

export const locationAddFromUrlSchema = z.tuple([
    httpUrlSchema,
    z.number().int().min(0).max(1_000_000).optional(),
    boundedString(64, 0).optional(),
    z.union([httpUrlSchema, z.literal(''), z.undefined()]).optional(),
])

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectCreateSchema = z
    .object({
        name: boundedString(200),
        description: boundedString(2000, 0).optional(),
        color: z.string().max(32).optional(),
        icon: boundedString(64, 0).optional(),
    })
    .strict()

export const projectUpdateSchema = z
    .object({
        name: boundedString(200).optional(),
        description: boundedString(2000, 0).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
        icon: boundedString(64, 0).nullable().optional(),
        status: z.enum(['active', 'archived', 'completed']).optional(),
    })
    .strict()

export const projectDeleteSchema = z.tuple([
    idSchema,
    z.boolean().optional(),
])

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templateCreateSchema = z
    .object({
        name: boundedString(200),
        content: boundedString(20000),
        category: boundedString(64),
    })
    .strict()

export const templateUpdateSchema = z
    .object({
        name: boundedString(200).optional(),
        content: boundedString(20000).optional(),
        category: boundedString(64).optional(),
        isActive: z.boolean().optional(),
    })
    .strict()

export const templatePreviewSchema = boundedString(20000)
export const templateGenerateVariationsSchema = z.tuple([
    boundedString(20000),
    z.number().int().min(1).max(50).optional(),
])

// ---------------------------------------------------------------------------
// Campaigns (review)
// ---------------------------------------------------------------------------

export const campaignCreateSchema = z
    .object({
        name: boundedString(200),
        locationIds: z.array(idSchema).min(1).max(5000),
        accountIds: z.array(idSchema).max(5000).optional(),
        proxyIds: z.array(idSchema).max(5000).optional(),
        reviewTemplates: z.array(z.string().max(20000)).min(1).max(500),
        rating: z.number().int().min(1).max(5).optional(),
        delayMin: z.number().int().min(0).max(7200).optional(),
        delayMax: z.number().int().min(0).max(14400).optional(),
        maxReviewsPerAccountPerDay: z.number().int().min(1).max(1000).optional(),
        maxMapScroll: z.number().int().min(1).max(100).optional(),
        projectId: optionalIdSchema,
        workingHoursStart: z.string().max(16).optional(),
        workingHoursEnd: z.string().max(16).optional(),
    })
    .strict()

export const campaignUpdateSchema = z
    .object({
        name: boundedString(200).optional(),
        locationIds: z.union([z.array(idSchema).max(5000), z.string().max(50000)]).optional(),
        accountIds: z.union([z.array(idSchema).max(5000), z.string().max(50000), z.null()]).optional(),
        proxyIds: z.union([z.array(idSchema).max(5000), z.string().max(50000), z.null()]).optional(),
        reviewTemplates: z.union([z.array(z.string().max(20000)).max(500), z.string().max(100000)]).optional(),
        rating: z.number().int().min(1).max(5).optional(),
        delayMin: z.number().int().min(0).max(7200).optional(),
        delayMax: z.number().int().min(0).max(14400).optional(),
        maxReviewsPerAccountPerDay: z.number().int().min(1).max(1000).optional(),
        maxMapScroll: z.number().int().min(1).max(100).optional(),
        projectId: z.number().int().positive().nullable().optional(),
        workingHoursStart: z.string().max(16).nullable().optional(),
        workingHoursEnd: z.string().max(16).nullable().optional(),
        status: z.enum(['pending', 'running', 'paused', 'done', 'error']).optional(),
        progress: z.number().int().min(0).max(100).optional(),
    })
    .strict()

// ---------------------------------------------------------------------------
// Traffic tasks + TrafficBoost campaigns
// ---------------------------------------------------------------------------

export const trafficTaskCreateSchema = z
    .object({
        locationId: idSchema,
        targetViews: z.number().int().min(1).max(10_000_000),
        viewsPerDay: z.number().int().min(1).max(1_000_000).optional(),
        useProxies: z.boolean().optional(),
        projectId: optionalIdSchema,
        proxyIds: z.string().max(20000).optional(),
    })
    .strict()

export const trafficTaskUpdateSchema = z
    .object({
        locationId: idSchema.optional(),
        targetViews: z.number().int().min(1).max(10_000_000).optional(),
        currentViews: z.number().int().min(0).max(10_000_000).optional(),
        viewsPerDay: z.number().int().min(1).max(1_000_000).optional(),
        useProxies: z.boolean().optional(),
        proxyIds: z.string().max(20000).nullable().optional(),
        status: z.enum(['pending', 'running', 'paused', 'completed', 'stopped']).optional(),
        projectId: z.number().int().positive().nullable().optional(),
    })
    .strict()

export const trafficModeSchema = z.enum(['direct', 'organic', 'web_seo', 'map_search'])

/** Web SEO dwell window (seconds). Shared bounds for create/update traffic boost. */
const webSeoDwellSecondsSchema = z.number().int().min(10).max(300)

/** Shared superRefine: delay/dwell max>=min; web_seo requires non-empty keywords. */
function refineTrafficBoostWebSeoFields(
    data: {
        trafficMode?: 'direct' | 'organic' | 'web_seo' | 'map_search'
        searchKeywords?: string[]
        delayMinSeconds?: number
        delayMaxSeconds?: number
        webSeoMinDwellSeconds?: number
        webSeoMaxDwellSeconds?: number
    },
    ctx: z.RefinementCtx,
): void {
    if (
        typeof data.delayMinSeconds === 'number'
        && typeof data.delayMaxSeconds === 'number'
        && data.delayMaxSeconds < data.delayMinSeconds
    ) {
        ctx.addIssue({
            code: 'custom',
            path: ['delayMaxSeconds'],
            message: 'delayMaxSeconds must be greater than or equal to delayMinSeconds',
        })
    }

    if (
        typeof data.webSeoMinDwellSeconds === 'number'
        && typeof data.webSeoMaxDwellSeconds === 'number'
        && data.webSeoMaxDwellSeconds < data.webSeoMinDwellSeconds
    ) {
        ctx.addIssue({
            code: 'custom',
            path: ['webSeoMaxDwellSeconds'],
            message: 'webSeoMaxDwellSeconds must be greater than or equal to webSeoMinDwellSeconds',
        })
    }

    if (data.trafficMode === 'web_seo') {
        const keywordCount = (data.searchKeywords ?? []).filter((k) => k.trim().length > 0).length
        if (keywordCount < 1) {
            ctx.addIssue({
                code: 'custom',
                path: ['searchKeywords'],
                message: 'web_seo mode requires at least one search keyword',
            })
        }
    }
}

export const trafficBoostCreateSchema = z
    .object({
        name: boundedString(200),
        trafficMode: trafficModeSchema.optional(),
        searchKeywords: z.array(boundedString(200)).max(200).optional(),
        maxMapScroll: z.number().int().min(1).max(100).optional(),
        accountIds: z.array(idSchema).max(5000),
        locationIds: z.array(idSchema).min(1).max(5000),
        threadsCount: z.number().int().min(1).max(32).optional(),
        visitsPerLocation: z.number().int().min(1).max(100000).optional(),
        delayMinSeconds: z.number().int().min(0).max(7200).optional(),
        delayMaxSeconds: z.number().int().min(0).max(14400).optional(),
        webSeoMinDwellSeconds: webSeoDwellSecondsSchema.optional(),
        webSeoMaxDwellSeconds: webSeoDwellSecondsSchema.optional(),
        webSeoRequireOrganic: z.boolean().optional(),
        aiAutoControl: z.boolean().optional(),
    })
    .strict()
    .superRefine(refineTrafficBoostWebSeoFields)

export const trafficBoostUpdateSchema = z
    .object({
        name: boundedString(200).optional(),
        trafficMode: trafficModeSchema.optional(),
        searchKeywords: z.array(boundedString(200)).max(200).optional(),
        maxMapScroll: z.number().int().min(1).max(100).optional(),
        accountIds: z.array(idSchema).max(5000).optional(),
        locationIds: z.array(idSchema).max(5000).optional(),
        threadsCount: z.number().int().min(1).max(32).optional(),
        visitsPerLocation: z.number().int().min(1).max(100000).optional(),
        delayMinSeconds: z.number().int().min(0).max(7200).optional(),
        delayMaxSeconds: z.number().int().min(0).max(14400).optional(),
        webSeoMinDwellSeconds: webSeoDwellSecondsSchema.optional(),
        webSeoMaxDwellSeconds: webSeoDwellSecondsSchema.optional(),
        webSeoRequireOrganic: z.boolean().optional(),
        aiAutoControl: z.boolean().optional(),
    })
    .strict()
    .superRefine(refineTrafficBoostWebSeoFields)

export const positiveIdListSchema = z.array(idSchema).min(1).max(5000)

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const dataMigrateLegacySchema = optionalAbsolutePathSchema
export const dataOpenPathSchema = absolutePathSchema

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const imagesAddFolderSchema = z.tuple([
    absolutePathSchema,
    boundedString(64, 0).optional(),
])

export const imagesGetRandomSchema = z.tuple([
    idSchema,
    z.string().max(128).optional(),
])

export const imagesGetBase64Schema = absolutePathSchema

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const toolsRunSchema = z.tuple([
    toolNameSchema,
    z.array(safeCliArgSchema).max(64).optional(),
])

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export const scriptActionTypeSchema = z.enum([
    'navigate',
    'click',
    'type',
    'wait',
    'scroll',
    'screenshot',
    'keyboard',
    'select',
    'hover',
    'upload',
    'extract',
    'condition',
    'loop',
    'variable',
    'random_delay',
    'human_type',
    'random_scroll',
    'google_search',
    'maps_click',
    'write_review',
    'set_rating',
    'go_back',
    'refresh_page',
])

const scriptActionParamsBaseSchema = z
    .object({
        url: z.string().max(4096).optional(),
        selector: z.string().max(1000).optional(),
        selectorType: z.enum(['css', 'xpath', 'text', 'placeholder', 'label']).optional(),
        text: z.string().max(20000).optional(),
        clearFirst: z.boolean().optional(),
        minDelay: z.number().int().min(0).max(60000).optional(),
        maxDelay: z.number().int().min(0).max(60000).optional(),
        waitType: z.enum(['time', 'element', 'navigation']).optional(),
        waitTime: z.number().int().min(0).max(600000).optional(),
        waitSelector: z.string().max(1000).optional(),
        timeout: z.number().int().min(0).max(600000).optional(),
        scrollDirection: z.enum(['up', 'down', 'left', 'right']).optional(),
        scrollAmount: z.number().int().min(0).max(100000).optional(),
        scrollToElement: z.string().max(1000).optional(),
        minScrolls: z.number().int().min(0).max(100).optional(),
        maxScrolls: z.number().int().min(0).max(100).optional(),
        minDelayMs: z.number().int().min(0).max(600000).optional(),
        maxDelayMs: z.number().int().min(0).max(600000).optional(),
        key: z.string().max(64).optional(),
        modifiers: z.array(z.enum(['Shift', 'Control', 'Alt'])).max(4).optional(),
        screenshotName: z.string().max(256).optional(),
        fullPage: z.boolean().optional(),
        filePath: z.string().max(4096).optional(),
        inputSelector: z.string().max(1000).optional(),
        selectValue: z.string().max(1000).optional(),
        selectByText: z.boolean().optional(),
        variableName: z.string().max(128).optional(),
        variableValue: z.string().max(10000).optional(),
        extractFrom: z.string().max(1000).optional(),
        searchQuery: z.string().max(1000).optional(),
        reviewText: z.string().max(20000).optional(),
        rating: z.number().int().min(1).max(5).optional(),
        loopCount: z.number().int().min(1).max(100).optional(),
    })
    .strict()

type ScriptActionSchemaType = z.ZodType<{
    id: string
    type: z.infer<typeof scriptActionTypeSchema>
    name: string
    description?: string
    enabled: boolean
    params: z.infer<typeof scriptActionParamsBaseSchema> & {
        loopActions?: ScriptActionSchemaType['_output'][]
        thenActions?: ScriptActionSchemaType['_output'][]
        elseActions?: ScriptActionSchemaType['_output'][]
    }
    condition?: {
        variable: string
        operator: 'equals' | 'not_equals' | 'contains' | 'exists'
        value: string
    }
    onError?: 'stop' | 'continue' | 'retry'
    maxRetries?: number
}>

export const scriptActionSchema: ScriptActionSchemaType = z.lazy(() =>
    z
        .object({
            id: boundedString(128),
            type: scriptActionTypeSchema,
            name: boundedString(200),
            description: boundedString(1000, 0).optional(),
            enabled: z.boolean(),
            params: scriptActionParamsBaseSchema
                .extend({
                    loopActions: z.array(scriptActionSchema).max(100).optional(),
                    thenActions: z.array(scriptActionSchema).max(100).optional(),
                    elseActions: z.array(scriptActionSchema).max(100).optional(),
                })
                .strict(),
            condition: z
                .object({
                    variable: boundedString(128),
                    operator: z.enum(['equals', 'not_equals', 'contains', 'exists']),
                    value: z.string().max(2000),
                })
                .strict()
                .optional(),
            onError: z.enum(['stop', 'continue', 'retry']).optional(),
            maxRetries: z.number().int().min(0).max(20).optional(),
        })
        .strict(),
)

export const scriptVariableSchema = z
    .object({
        name: boundedString(128),
        type: z.enum(['string', 'number', 'boolean', 'list']),
        defaultValue: z.string().max(10000).optional(),
        description: boundedString(500, 0).optional(),
        required: z.boolean().optional(),
    })
    .strict()

export const automationScriptSchema = z
    .object({
        id: boundedString(128),
        name: boundedString(200),
        description: z.string().max(2000).default(''),
        version: z.string().max(32).default('1.0.0'),
        createdAt: z.union([z.string(), z.number(), z.date()]).optional(),
        updatedAt: z.union([z.string(), z.number(), z.date()]).optional(),
        variables: z.array(scriptVariableSchema).max(100).default([]),
        actions: z.array(scriptActionSchema).max(500).default([]),
        settings: z
            .object({
                headless: z.boolean(),
                defaultTimeout: z.number().int().min(1000).max(600000),
                viewport: z
                    .object({
                        width: z.number().int().min(320).max(7680),
                        height: z.number().int().min(240).max(4320),
                    })
                    .strict(),
                userAgent: z.string().max(512).optional(),
                locale: z.string().max(32).optional(),
                timezone: z.string().max(64).optional(),
            })
            .strict()
            .optional(),
    })
    .strict()

export const scriptVariablesMapSchema = z
    .record(z.string().max(128), z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]))
    .optional()

export const scriptsRunSchema = z.tuple([
    automationScriptSchema,
    scriptVariablesMapSchema,
])

export const scriptsRunWithAccountsSchema = z.tuple([
    automationScriptSchema,
    z.array(idSchema).min(1).max(500),
    scriptVariablesMapSchema,
])

export const scriptIdSchema = boundedString(128)
