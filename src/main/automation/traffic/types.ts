import type { NetworkStateV2, RuntimeActionEvent } from '../../runtime/v2/types'
import type { SeoFlowConfig, SeoFlowResult } from '../WebSeoFlow'

/** Public listener payload. Defined in runtime v2; re-exported for traffic callers. */
export type { RuntimeActionEvent }

export type SEOAction =
    | 'map_zoom_in' | 'map_zoom_out' | 'map_drag_pan' | 'map_satellite_view'
    | 'map_street_view' | 'map_terrain_view' | 'map_fullscreen' | 'map_measure_distance'
    | 'photos_browse' | 'photos_view_single' | 'photos_next_prev' | 'photos_category'
    | 'photos_owner' | 'photos_latest' | 'photos_360'
    | 'reviews_read' | 'reviews_expand' | 'reviews_sort' | 'reviews_filter_stars'
    | 'reviews_view_photos' | 'reviews_helpful' | 'reviews_author_profile'
    | 'directions_driving' | 'directions_walking' | 'directions_transit'
    | 'directions_cycling' | 'directions_reverse'
    | 'info_view_hours' | 'info_view_about' | 'info_phone' | 'info_address_copy'
    | 'info_website' | 'info_menu' | 'info_price_range' | 'info_amenities'
    | 'share_link' | 'share_embed' | 'save_place' | 'send_to_phone' | 'print_location'
    | 'explore_nearby' | 'explore_similar' | 'explore_category' | 'explore_popular_times'
    | 'explore_qa' | 'explore_updates'
    | 'browse_scroll_deep' | 'browse_read_panel' | 'browse_random_click' | 'browse_back_forward'

export interface TrafficBoostStatus {
    isRunning: boolean
    isPaused?: boolean
    campaignId: number | null
    campaignName: string
    activeThreads: number
    threadsTotal: number
    currentRound: number
    totalRounds: number
    completedVisits: number
    totalVisits: number
    failedVisits: number
    message: string
    threads: ThreadDetail[]
    effectiveNetworkMode?: 'direct' | 'fproxy' | 'static_proxy'
    networkState?: NetworkStateV2
}

export interface ThreadDetail {
    id: number
    accountEmail: string
    locationName: string
    currentAction: string
    currentUrl?: string
    currentKeyword?: string // Current search keyword being used
    status: 'idle' | 'visiting' | 'waiting' | 'done'
    progress: number
    proxyInfo?: string // e.g. "113.190.148.126:38733 (Quang Binh, Vietnam)"
    /** Absolute ms when FProxy IP for this thread expires (time_die). */
    proxyIpExpiresAt?: number | null
    /** Absolute ms when this thread's proxy can rotate next (waiting_time). */
    proxyRotateAt?: number | null
    /** Absolute soft deadline for current visit budget. */
    visitSoftDeadlineAt?: number | null
    /** Human timing note for UI countdown (waiting for rotate / budget left). */
    timingLabel?: string
}

export interface VisitActionRecord {
    action: string
    success: boolean
    source?: string
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    threadId?: number
    step?: number
    elementId?: number
    attempt?: number
    retryCategory?: string
    queueDepth?: number
    latencyMs?: number
    recoverPath?: string
    decisionSource?: 'heuristic' | 'llm' | 'llm+rag'
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
    timestamp?: string
}

export type ActionContext = {
    campaignName: string
    round: number
    campaignId: number
    threadId: number
    accountEmail: string
    locationName: string
    domain?: string
    goal?: string
    riskType?: string
}

/** Contract-aligned Web SEO discovery source (matches traffic_logs.discovery_source enum). */
export type WebSeoDiscoverySource = 'organic' | 'direct_fallback' | 'captcha_cooldown' | 'unreachable'

/**
 * Per-visit Web SEO outcome (typed). Prefer numeric fields from flow result when present;
 * engine maps SeoFlowResult → this shape without string/regex quality heuristics.
 */
export type WebSeoFlowResult = SeoFlowResult & {
    discoverySource?: WebSeoDiscoverySource
    hostVerified?: boolean
    organicHit?: boolean
    qualityScore?: number
    countable?: boolean
    targetHost?: string
    errorCode?: string
    reachedTarget?: boolean
}

export type WebSeoExecuteConfig = SeoFlowConfig & {
    deadlineAt?: number
    shouldStop?: () => boolean
    requireOrganic?: boolean
}

/** Per-visit Web SEO outcome. There is no separate WebSeoOutcome interface in the engine. */
export type WebSeoVisitOutcome = {
    success: boolean
    reachedTarget: boolean
    discoverySource: WebSeoDiscoverySource
    hostVerified: boolean
    organicHit: boolean
    qualityScore: number
    countable: boolean
    targetHost: string | null
    errorCode?: string
    message: string
}

export interface TrafficReport {
    campaignId: number
    campaignName: string
    totalVisits: number
    completedVisits: number
    failedVisits: number
    totalRounds: number
    totalDuration: number // seconds
    avgVisitDuration: number
    visitsByLocation: { locationId: number; locationName: string; visits: number; avgDuration: number }[]
    visitsByAccount: { accountId: number; accountEmail: string; visits: number }[]
    actionStats: { action: string; count: number }[]
    logs: any[]
}
