/**
 * Read-only Web SEO action policy: site classification + non-repeating action plans.
 * Dangerous actions (cart, checkout, chat, phone, payment, external video/banner) are never emitted.
 */

import type { WebSeoSiteType } from '../../../shared/web-seo-contracts'

/** Safe, read-only browse actions only. */
export type WebSeoSafeActionId =
    | 'scroll_read'
    | 'scroll_updown'
    | 'mouse_move'
    | 'view_images'
    | 'gallery_browse'
    | 'hover_elements'
    | 'read_details'
    | 'check_price'
    | 'product_tabs'
    | 'read_reviews'
    | 'expand_faq'
    | 'scroll_section'
    | 'view_breadcrumb'
    | 'view_policy'
    | 'click_internal'
    | 'view_footer'
    | 'zoom_image'
    | 'highlight_text'
    | 'related_hover'
    | 'view_social'
    | 'view_menu'
    | 'resize_scroll'

export const WEB_SEO_SAFE_ACTION_IDS: readonly WebSeoSafeActionId[] = [
    'scroll_read',
    'scroll_updown',
    'mouse_move',
    'view_images',
    'gallery_browse',
    'hover_elements',
    'read_details',
    'check_price',
    'product_tabs',
    'read_reviews',
    'expand_faq',
    'scroll_section',
    'view_breadcrumb',
    'view_policy',
    'click_internal',
    'view_footer',
    'zoom_image',
    'highlight_text',
    'related_hover',
    'view_social',
    'view_menu',
    'resize_scroll',
]

const WEB_SEO_SAFE_ACTION_SET: ReadonlySet<string> = new Set(WEB_SEO_SAFE_ACTION_IDS)

export function isWebSeoSafeActionId(value: string): value is WebSeoSafeActionId {
    return WEB_SEO_SAFE_ACTION_SET.has(value)
}

export interface WebSeoClassifyInput {
    url: string
    title?: string
    /** Free-text page content signal. */
    text?: string
    /** Alias for text (engine may send either). */
    textSample?: string
    /** Extra HTML / microdata hint tokens. */
    htmlHints?: string[]
}

export interface WebSeoActionPlanOptions {
    maxActions?: number
    /** Injected RNG in [0, 1). Defaults to Math.random. */
    random?: () => number
    keyword?: string
    targetHost?: string
}

/** Markers that must never appear in emitted action ids. */
const FORBIDDEN_MARKERS = [
    'cart',
    'checkout',
    'form',
    'chat',
    'phone',
    'external',
    'payment',
    'buy',
    'submit',
] as const

const ECOM_RE = /\b(add to cart|mua ngay|them gio|gio hang|cart|checkout|sku|gia ban|sale|shop|san pham|product|price|buy now|dat hang)\b/i
const ARTICLE_RE = /\b(article|blog|post|tin tuc|bai viet|author|published|min read|comment|chia se|reading time|full guide)\b/i
const LOCAL_RE = /\b(dia chi|address|gio mo cua|opening hours|hotline|chi nhanh|google maps|chi duong|lien he|contact us|store locator|near me|directions|local-business)\b/i

function combineClassifySignals(input: WebSeoClassifyInput): string {
    const hints = Array.isArray(input.htmlHints)
        ? input.htmlHints.filter((h): h is string => typeof h === 'string').join(' ')
        : ''
    return [input.url, input.title, input.text, input.textSample, hints]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' ')
        .toLowerCase()
}

export function classifyWebSeoSite(input: WebSeoClassifyInput): WebSeoSiteType {
    const haystack = combineClassifySignals(input)
    const url = input.url || ''

    if (ECOM_RE.test(haystack) || /\/(product|san-pham|shop|cart|collections)\b/i.test(url)) {
        return 'ecommerce'
    }
    if (ARTICLE_RE.test(haystack) || /\/(blog|news|tin-tuc|bai-viet|article|posts)\b/i.test(url)) {
        return 'article'
    }
    if (LOCAL_RE.test(haystack) || /\/(contact|lien-he|stores?|chi-nhanh)\b/i.test(url)) {
        return 'local'
    }
    return 'generic'
}

const BASE_POOL: WebSeoSafeActionId[] = [
    'scroll_read',
    'mouse_move',
    'scroll_updown',
    'view_images',
    'hover_elements',
    'scroll_section',
    'view_footer',
    'highlight_text',
    'resize_scroll',
]

const BY_SITE: Record<WebSeoSiteType, WebSeoSafeActionId[]> = {
    ecommerce: [
        'scroll_read',
        'view_images',
        'gallery_browse',
        'read_details',
        'check_price',
        'product_tabs',
        'read_reviews',
        'related_hover',
        'view_breadcrumb',
        'zoom_image',
        'click_internal',
        'mouse_move',
        'hover_elements',
        'view_policy',
        'expand_faq',
        'scroll_updown',
    ],
    article: [
        'scroll_read',
        'highlight_text',
        'scroll_updown',
        'view_images',
        'expand_faq',
        'scroll_section',
        'view_breadcrumb',
        'click_internal',
        'mouse_move',
        'view_social',
        'view_footer',
        'hover_elements',
    ],
    local: [
        'scroll_read',
        'view_menu',
        'scroll_section',
        'view_images',
        'view_policy',
        'view_footer',
        'hover_elements',
        'mouse_move',
        'click_internal',
        'view_breadcrumb',
        'expand_faq',
        'scroll_updown',
    ],
    generic: [
        ...BASE_POOL,
        'read_details',
        'click_internal',
        'view_policy',
        'view_breadcrumb',
        'expand_faq',
        'view_images',
        'gallery_browse',
    ],
}

function isForbiddenAction(id: string): boolean {
    const lower = id.toLowerCase()
    return FORBIDDEN_MARKERS.some((m) => lower.includes(m))
}

function resolvePlanOptions(
    options?: number | WebSeoActionPlanOptions,
): { maxActions: number; random: () => number } {
    if (typeof options === 'number') {
        return {
            maxActions: options,
            random: Math.random,
        }
    }
    const maxActions = typeof options?.maxActions === 'number' ? options.maxActions : 12
    const random = typeof options?.random === 'function' ? options.random : Math.random
    return { maxActions, random }
}

/**
 * Build a non-repeating action plan for the site type.
 * Forbidden action markers are never emitted. Order can be lightly shuffled
 * via injected random() for deterministic tests.
 */
export function buildWebSeoActionPlan(
    siteType: WebSeoSiteType,
    options?: number | WebSeoActionPlanOptions,
): WebSeoSafeActionId[] {
    const { maxActions, random } = resolvePlanOptions(options)
    const source = BY_SITE[siteType] || BY_SITE.generic
    const unique: WebSeoSafeActionId[] = []
    const seen = new Set<WebSeoSafeActionId>()

    // Prefer site-specific order, then fill gaps from base pool.
    for (const id of [...source, ...BASE_POOL]) {
        if (seen.has(id)) continue
        if (isForbiddenAction(id)) continue
        seen.add(id)
        unique.push(id)
    }

    const limit = Math.max(1, Math.min(Math.max(0, maxActions), unique.length, 20))
    const head = unique.slice(0, limit)

    // Light shuffle of the first `limit` candidates for human variance.
    for (let i = head.length - 1; i > 0; i--) {
        let r: number
        try {
            r = random()
        } catch {
            r = 0
        }
        if (!(r > 0.55)) continue
        const j = Math.floor((Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0) * (i + 1))
        const tmp = head[i]
        head[i] = head[j]
        head[j] = tmp
    }

    // Final safety filter (defense in depth)
    return head.filter((id) => !isForbiddenAction(id))
}
