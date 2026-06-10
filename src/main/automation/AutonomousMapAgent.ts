/**
 * AutonomousMapAgent — Fully autonomous Google Maps engagement agent.
 *
 * Replaces manual configuration (enabledActions, targetKpi, actionsPerVisit...)
 * with a deterministic AI strategy engine that autonomously:
 *   1. Detects business type from DOM context
 *   2. Selects optimal KPI strategy (phone, website, directions, photos, reviews)
 *   3. Executes full session: warm-up → multi-KPI → cool-down
 *   4. Self-calibrates timing to exceed Google's 30s bot detection threshold
 *   5. Self-heals from popups, overlays, and navigation errors
 *
 * NO LLM/Ollama/Groq dependency. 100% deterministic with randomization.
 */

import { Page } from 'playwright'
import { kpiSkills, KpiAvailability, KpiSkillResult, MapKpiType } from './KpiSkills'
import { HumanBehavior } from './HumanBehavior'
import { DOMUtils } from './DOMUtils'
import { moveCursor } from './BrowserCursorOverlay'
import { contextualInterruptionResolver, ContextualInterruptionResolveResult } from './ContextualInterruptionResolver'
import { writeAgenticLog } from '../utils/agenticLog'

// ============================================================
// Types
// ============================================================

/** Detected business category from DOM analysis */
export type BusinessType =
    | 'restaurant'
    | 'hotel'
    | 'clinic'
    | 'store'
    | 'service'
    | 'entertainment'
    | 'generic'

/** Single action recorded during an autonomous session */
export interface SessionAction {
    action: string
    success: boolean
    source: 'autonomous' | 'kpi_skill' | 'recovery'
    detail?: string
    durationMs?: number
    timestamp: string
}

/** Result of a single KPI execution within the session */
export interface KpiExecutionResult {
    kpiType: string
    executed: boolean
    verified: boolean
    detail: string
    durationMs: number
}

/** Full result of an autonomous browsing session */
export interface AutonomousSessionResult {
    actionsPerformed: SessionAction[]
    kpisExecuted: KpiExecutionResult[]
    totalDurationMs: number
    businessType: BusinessType
    strategyUsed: string
}

/** Minimal config required to run an autonomous session */
export interface AutonomousSessionConfig {
    page: Page
    locationName: string
    locationUrl: string
    threadId: number
    onStatusUpdate: (msg: string) => void
    shouldStop: () => boolean
}

// ============================================================
// Strategy Constants
// ============================================================

/** KPI priority order for each business type */
const KPI_STRATEGY: Record<BusinessType, MapKpiType[]> = {
    restaurant:    ['direction', 'website', 'phone'],
    hotel:         ['website', 'direction', 'phone'],
    clinic:        ['website', 'direction', 'phone'],
    store:         ['direction', 'website', 'phone'],
    service:       ['website', 'direction', 'phone'],
    entertainment: ['direction', 'website', 'phone'],
    generic:       ['website', 'direction', 'phone'],
}

/**
 * Warm-up action pool — organic browsing actions to build natural session
 * before executing KPI skills.
 */
type WarmUpAction = 'scroll_panel' | 'read_info' | 'zoom_map' | 'pan_map' | 'browse_photos_preview' | 'browse_photos_deep' | 'check_hours' | 'hover_rating' | 'nearby_glance'

/**
 * Cool-down action pool — actions to perform after KPI to extend session
 * and look like a natural user finishing their research.
 */
type CoolDownAction = 'scroll_reviews' | 'browse_photos' | 'pan_map' | 'read_about' | 'explore_popular_times' | 'read_reviews_deep' | 'browse_photos_deep' | 'hover_share_save' | 'nearby_glance'

// ============================================================
// Helpers
// ============================================================

function log(msg: string): void {
    console.log(`[AutonomousAgent] ${msg}`)
    writeAgenticLog('AutonomousAgent', msg)
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function delay(minMs: number, maxMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, randomInt(minMs, maxMs)))
}

function shuffleArray<T>(arr: T[]): T[] {
    const result = [...arr]
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]]
    }
    return result
}

function nowISO(): string {
    return new Date().toISOString()
}

// ============================================================
// Business Type Detector
// ============================================================

/**
 * Detect business type from DOM text and URL context.
 * Uses keyword matching against the visible page content.
 */
export function detectBusinessType(domText: string, url: string): BusinessType {
    const text = (domText + ' ' + url).toLowerCase()

    // Restaurant / Food & Beverage
    if (/(restaurant|café|cafe|coffee|quán ăn|nhà hàng|bistro|pizz|sushi|burger|bakery|bar |pub |grill|bún|phở|cơm|trà sữa|bubble tea|food|ẩm thực|ăn uống|dinner|lunch|breakfast|fastfood|fast food|buffet|noodle|ramen|bbq|hotpot|lẩu)/i.test(text)) {
        return 'restaurant'
    }

    // Hotel / Accommodation
    if (/(hotel|motel|resort|hostel|khách sạn|homestay|villa|airbnb|accommodation|booking|lodging|inn |guesthouse|nhà nghỉ|bungalow|apartment hotel)/i.test(text)) {
        return 'hotel'
    }

    // Clinic / Medical / Health
    if (/(clinic|hospital|bệnh viện|phòng khám|doctor|dentist|nha khoa|pharmacy|nhà thuốc|thẩm mỹ|dermatolog|physiother|chiropr|optometr|veterinar|thú y|health|medical|y tế|bác sĩ)/i.test(text)) {
        return 'clinic'
    }

    // Entertainment / Recreation
    if (/(cinema|theater|museum|bảo tàng|park|công viên|zoo|karaoke|spa |massage|gym|fitness|pool|bowling|arcade|amusement|theme park|gallery|nightclub|club |yoga|stadium|sân vận|concert)/i.test(text)) {
        return 'entertainment'
    }

    // Store / Retail / Shopping
    if (/(store|shop|cửa hàng|market|siêu thị|supermarket|mall|boutique|outlet|showroom|dealer|thời trang|fashion|electronics|điện máy|furniture|nội thất|jewelry|trang sức|bookstore|hardware|grocery)/i.test(text)) {
        return 'store'
    }

    // Service / Professional
    if (/(service|dịch vụ|repair|sửa chữa|laundry|giặt|salon|barber|tóc|lawyer|luật|accountant|kế toán|insurance|bảo hiểm|bank|ngân hàng|agency|công ty|office|văn phòng|consulting|tư vấn|education|trường|school|university|đại học|training|đào tạo|plumb|electric|moving|cleaning|wash)/i.test(text)) {
        return 'service'
    }

    return 'generic'
}

// ============================================================
// Autonomous Map Agent
// ============================================================

export class AutonomousMapAgent {

    private static readonly MIN_SESSION_DURATION_MS = 75_000  // Google filters <30s; Maps KPI Optimization target 75s session
    private static readonly MAX_CONTEXT_RECOVERY_ATTEMPTS = 3

    // -----------------------------------------------------------------------
    // Main Entry Point
    // -----------------------------------------------------------------------

    /**
     * Execute a fully autonomous browsing session on a Google Maps place page.
     *
     * The session follows a 3-phase pattern:
     *   Phase 1: Warm-up (organic browsing to build natural session context)
     *   Phase 2: KPI Execution (2-3 deterministic KPI actions based on business type)
     *   Phase 3: Cool-down (natural exit behavior to extend session duration)
     */
    async execute(config: AutonomousSessionConfig): Promise<AutonomousSessionResult> {
        const sessionStart = Date.now()
        const actions: SessionAction[] = []
        const kpiResults: KpiExecutionResult[] = []
        const { page, locationName, locationUrl, threadId, onStatusUpdate, shouldStop } = config

        log(`T${threadId}: Starting autonomous session for "${locationName}"`)

        // --- Step 1: Analyze DOM & detect business type ---
        onStatusUpdate('🧠 Analyzing business type...')
        let domText = ''
        try {
            const domSnapshot = await DOMUtils.extractInteractiveDOM(page)
            domText = domSnapshot.domText
        } catch (err) {
            log(`T${threadId}: DOM extraction failed: ${err}`)
        }

        const businessType = detectBusinessType(domText, locationUrl)
        const kpiPriority = KPI_STRATEGY[businessType]
        const strategyLabel = `${businessType} → ${kpiPriority.join(' > ')}`

        log(`T${threadId}: Business type="${businessType}", Strategy="${strategyLabel}"`)
        onStatusUpdate(`🧠 ${businessType.toUpperCase()}: ${kpiPriority.join(' → ')}`)

        this.pushAction(actions, {
            action: 'strategy_selected',
            success: true,
            source: 'autonomous',
            detail: strategyLabel,
        })

        const kpiAvailability = await kpiSkills.detectAvailableKpis(page)
        const hasActionableKpi = kpiAvailability.some(item => item.available)
        if (!hasActionableKpi) {
            for (const item of kpiAvailability) {
                this.pushAction(actions, {
                    action: `kpi_skip_${item.type}`,
                    success: true,
                    source: 'kpi_skill',
                    detail: item.detail,
                })
            }
            this.pushAction(actions, {
                action: 'kpi_no_actionable_info',
                success: true,
                source: 'kpi_skill',
                detail: 'No phone, website, or directions action available on this map page',
            })
            onStatusUpdate('No actionable KPI info on this map page')

            return {
                actionsPerformed: actions,
                kpisExecuted: kpiResults,
                totalDurationMs: Date.now() - sessionStart,
                businessType,
                strategyUsed: `${strategyLabel} | skipped:no_actionable_kpi`,
            }
        }

        if (!shouldStop()) {
            onStatusUpdate('Reading map details before KPI...')
            // Maps KPI Optimization: pre-KPI warm-up now business-type aware, 3-5 actions
            await this.executeWarmUp(page, threadId, actions, shouldStop, businessType)
        }

        if (!shouldStop()) {
            onStatusUpdate(`Executing available KPIs: ${kpiPriority.join(', ')}...`)
            await this.executeKpiPhase(
                page, threadId, locationUrl, kpiPriority,
                actions, kpiResults, onStatusUpdate, shouldStop, kpiAvailability, businessType
            )
        }

        if (!shouldStop()) {
            onStatusUpdate('Finishing with cool-down engagement...')
            // Maps KPI Optimization: post-KPI cool-down using executeCoolDown, 2-3 actions + share/save/nearby
            await this.executeCoolDown(page, threadId, actions, shouldStop, businessType)
        }

        const remainingMs = AutonomousMapAgent.MIN_SESSION_DURATION_MS - (Date.now() - sessionStart)
        if (remainingMs > 5000 && !shouldStop()) {
            onStatusUpdate(`Keeping session natural for ${Math.round(remainingMs / 1000)}s...`)
            await this.executeTimePadding(page, threadId, remainingMs, actions, shouldStop)
        }

        const totalDurationMs = Date.now() - sessionStart
        const executedKpis = kpiResults.filter(k => k.executed).length
        const verifiedKpis = kpiResults.filter(k => k.verified).length

        log(`T${threadId}: Session complete. Duration=${totalDurationMs}ms, KPIs=${executedKpis}/${kpiResults.length} executed, ${verifiedKpis} verified, Actions=${actions.length}`)
        onStatusUpdate(`✅ Done: ${executedKpis} KPIs, ${actions.length} actions (${Math.round(totalDurationMs / 1000)}s)`)

        return {
            actionsPerformed: actions,
            kpisExecuted: kpiResults,
            totalDurationMs,
            businessType,
            strategyUsed: strategyLabel,
        }
    }

    // -----------------------------------------------------------------------
    // Phase 1: Warm-up
    // -----------------------------------------------------------------------

    private async executeSafeEngagementPhase(
        page: Page,
        threadId: number,
        phase: 'pre' | 'post',
        actions: SessionAction[],
        shouldStop: () => boolean
    ): Promise<void> {
        const safeActions: Array<'scroll_panel' | 'read_info' | 'idle_hover'> =
            phase === 'pre'
                ? ['scroll_panel', 'read_info', 'idle_hover']
                : ['read_info', 'scroll_panel', 'idle_hover']
        const count = phase === 'pre' ? 2 : 1

        for (let i = 0; i < count && !shouldStop(); i++) {
            const action = safeActions[i % safeActions.length]
            const start = Date.now()
            let success = true

            try {
                if (action === 'scroll_panel') {
                    success = await this.scrollPanel(page, threadId)
                } else if (action === 'read_info') {
                    success = await this.readInfoSection(page, threadId)
                } else {
                    await delay(1800, 3600)
                }
            } catch (err) {
                success = false
                log(`T${threadId}: Safe engagement "${action}" error: ${err}`)
            }

            this.pushAction(actions, {
                action: `engagement_${phase}_${action}`,
                success,
                source: 'autonomous',
                durationMs: Date.now() - start,
            })

            await delay(900, 1800)
        }
    }

    private async executeWarmUp(
        page: Page,
        threadId: number,
        actions: SessionAction[],
        shouldStop: () => boolean,
        businessType: BusinessType = 'generic'
    ): Promise<void> {
        // Maps KPI Optimization (4): business-type aware warm-up 3-5 actions (pre-KPI)
        const warmUpActions: WarmUpAction[] = this.getBusinessAwareWarmActions(businessType)

        // Execute 3-5 warm-up actions for richer pre-KPI context
        const count = randomInt(3, 5)
        for (let i = 0; i < count && !shouldStop(); i++) {
            const action = warmUpActions[i % warmUpActions.length]
            const start = Date.now()
            let success = false

            try {
                switch (action) {
                    case 'scroll_panel':
                        success = await this.scrollPanel(page, threadId)
                        break
                    case 'read_info':
                        success = await this.readInfoSection(page, threadId)
                        break
                    case 'zoom_map':
                        success = await this.zoomMap(page, threadId)
                        break
                    case 'pan_map':
                        success = await this.panMap(page, threadId)
                        break
                    case 'browse_photos_preview':
                        success = await this.browsePhotosPreview(page, threadId)
                        break
                    case 'browse_photos_deep':
                        success = await this.browsePhotosDeep(page, threadId)
                        break
                    case 'check_hours':
                        success = await this.recheckHours(page, threadId)
                        break
                    case 'hover_rating':
                        success = await this.hoverRatingStars(page, threadId)
                        break
                    case 'nearby_glance':
                        success = await this.glanceNearby(page, threadId)
                        break
                    default:
                        success = await this.readInfoSection(page, threadId)
                        break
                }
            } catch (err) {
                log(`T${threadId}: Warm-up action "${action}" error: ${err}`)
                await this.recoverFromError(page, threadId)
            }

            this.pushAction(actions, {
                action: `warmup_${action}`,
                success,
                source: 'autonomous',
                durationMs: Date.now() - start,
            })

            // Natural inter-action delay
            await delay(1500, 3500)
        }
    }

    /** Maps KPI Optimization: business-type aware warm-up action selection (3-5 actions) */
    private getBusinessAwareWarmActions(businessType: BusinessType): WarmUpAction[] {
        const base: WarmUpAction[] = ['scroll_panel', 'read_info', 'hover_rating']
        let extra: WarmUpAction[] = ['browse_photos_preview', 'check_hours', 'nearby_glance']

        if (businessType === 'restaurant') {
            extra = ['browse_photos_deep', 'check_hours', 'browse_photos_preview', 'nearby_glance']
        } else if (businessType === 'hotel') {
            extra = ['browse_photos_preview', 'read_info', 'check_hours', 'nearby_glance']
        } else if (businessType === 'clinic') {
            extra = ['read_info', 'check_hours', 'hover_rating', 'scroll_panel']
        } else if (businessType === 'store' || businessType === 'service') {
            extra = ['browse_photos_preview', 'hover_rating', 'nearby_glance']
        }
        return shuffleArray([...base, ...extra]).slice(0, 6) // enough variety, pick 3-5 at call site
    }

    // -----------------------------------------------------------------------
    // Phase 2: KPI Execution
    // -----------------------------------------------------------------------

    private async executeKpiPhase(
        page: Page,
        threadId: number,
        targetMapUrl: string,
        kpiPriority: MapKpiType[],
        actions: SessionAction[],
        kpiResults: KpiExecutionResult[],
        onStatusUpdate: (msg: string) => void,
        shouldStop: () => boolean,
        precomputedAvailability?: KpiAvailability[],
        businessType: BusinessType = 'generic'
    ): Promise<void> {
        const availability = precomputedAvailability || await kpiSkills.detectAvailableKpis(page)
        const availableSet = new Set(
            availability.filter(item => item.available).map(item => item.type)
        )
        const kpiQueue = kpiPriority.filter(type => availableSet.has(type))

        for (const item of availability) {
            if (!item.available) {
                this.pushAction(actions, {
                    action: `kpi_skip_${item.type}`,
                    success: true,
                    source: 'kpi_skill',
                    detail: item.detail,
                })
            }
        }

        if (kpiQueue.length === 0) {
            this.pushAction(actions, {
                action: 'kpi_no_actionable_info',
                success: true,
                source: 'kpi_skill',
                detail: 'No phone, website, or directions action available on this map page',
            })
            onStatusUpdate('No actionable KPI info on this map page')
            return
        }

        for (let i = 0; i < kpiQueue.length && !shouldStop(); i++) {
            const kpiType = kpiQueue[i]
            const kpiLabel = kpiType.toUpperCase()

            log(`T${threadId}: [KPI ${i + 1}/${kpiQueue.length}] Executing: ${kpiLabel}`)
            onStatusUpdate(`KPI ${i + 1}/${kpiQueue.length}: ${kpiLabel}...`)

            // Ensure we're on the target map page before each KPI
            await this.ensureTargetContext(page, targetMapUrl, threadId, actions)
            await delay(800, 1500)

            const start = Date.now()
            let result: KpiSkillResult

            try {
                result = await kpiSkills.executeKpi(page, threadId, kpiType)
            } catch (err) {
                log(`T${threadId}: KPI "${kpiType}" threw: ${err}`)
                result = {
                    executed: false,
                    verified: false,
                    actions: [],
                    detail: `Error: ${err}`,
                    durationMs: Date.now() - start,
                }
            }

            const durationMs = Date.now() - start

            // Record KPI result
            kpiResults.push({
                kpiType,
                executed: result.executed,
                verified: result.verified,
                detail: result.detail,
                durationMs,
            })

            this.pushAction(actions, {
                action: `kpi_${kpiType}`,
                success: result.executed,
                source: 'kpi_skill',
                detail: result.detail,
                durationMs,
            })
            this.recordKpiEvidenceActions(actions, kpiType, result)

            // If executed but not verified, retry once
            if (result.executed && !result.verified && !shouldStop()) {
                log(`T${threadId}: KPI "${kpiType}" unverified, retrying once...`)
                onStatusUpdate(`⚠️ ${kpiLabel} unverified, retrying...`)

                await this.ensureTargetContext(page, targetMapUrl, threadId, actions)
                await delay(2000, 3500)

                try {
                    const retryResult = await kpiSkills.executeKpi(page, threadId, kpiType)
                    this.pushAction(actions, {
                        action: `kpi_retry_${kpiType}`,
                        success: retryResult.executed,
                        source: 'kpi_skill',
                        detail: `Retry: ${retryResult.detail}`,
                        durationMs: Date.now() - start,
                    })
                    this.recordKpiEvidenceActions(actions, kpiType, retryResult)

                    if (retryResult.verified) {
                        kpiResults[kpiResults.length - 1].verified = true
                        log(`T${threadId}: KPI "${kpiType}" verified on retry!`)
                    }
                } catch (err) {
                    log(`T${threadId}: KPI retry "${kpiType}" threw: ${err}`)
                }
            }

            // Ensure back on target map after each KPI
            await this.ensureTargetContext(page, targetMapUrl, threadId, actions)
            await this.cleanupExtraTabs(page, threadId)

            // Maps KPI Optimization (6): dynamic business-type aware KPI spacing + micro-engagements
            if (i < kpiQueue.length - 1) {
                const spacing = this.getKpiSpacing(businessType)
                await this.microEngagement(page, threadId)
                await delay(spacing.min, spacing.max)
            }
        }
    }

    private recordKpiEvidenceActions(
        actions: SessionAction[],
        kpiType: MapKpiType,
        result: KpiSkillResult
    ): void {
        for (const action of result.actions) {
            this.pushAction(actions, {
                action,
                success: result.executed,
                source: 'kpi_skill',
                detail: `${kpiType}: ${action}`,
            })
        }
    }

    // -----------------------------------------------------------------------
    // Phase 3: Cool-down
    // -----------------------------------------------------------------------

    private async executeCoolDown(
        page: Page,
        threadId: number,
        actions: SessionAction[],
        shouldStop: () => boolean,
        businessType: BusinessType = 'generic'
    ): Promise<void> {
        // Maps KPI Optimization (4): post-KPI cool-down 2-3 actions using executeCoolDown + share/save hovers, nearby glances
        const coolDownActions: CoolDownAction[] = this.getBusinessAwareCoolActions(businessType)

        // Execute 2-3 cool-down actions
        const count = randomInt(2, 3)
        for (let i = 0; i < count && !shouldStop(); i++) {
            const action = coolDownActions[i % coolDownActions.length]
            const start = Date.now()
            let success = false

            try {
                switch (action) {
                    case 'scroll_reviews':
                        success = await this.scrollReviews(page, threadId)
                        break
                    case 'browse_photos':
                        success = await this.browsePhotos(page, threadId)
                        break
                    case 'pan_map':
                        success = await this.panMap(page, threadId)
                        break
                    case 'read_about':
                        success = await this.readAboutSection(page, threadId)
                        break
                    case 'explore_popular_times':
                        success = await this.explorePopularTimes(page, threadId)
                        break
                    case 'read_reviews_deep':
                        success = await this.readReviewsDeep(page, threadId)
                        break
                    case 'browse_photos_deep':
                        success = await this.browsePhotosDeep(page, threadId)
                        break
                    case 'hover_share_save':
                        success = await this.hoverShareSave(page, threadId)
                        break
                    case 'nearby_glance':
                        success = await this.glanceNearby(page, threadId)
                        break
                }
            } catch (err) {
                log(`T${threadId}: Cool-down action "${action}" error: ${err}`)
                await this.recoverFromError(page, threadId)
            }

            this.pushAction(actions, {
                action: `cooldown_${action}`,
                success,
                source: 'autonomous',
                durationMs: Date.now() - start,
            })

            await delay(1200, 2800)
        }
    }

    /** Maps KPI Optimization: business-aware cool-down actions (2-3) with share/save/nearby */
    private getBusinessAwareCoolActions(businessType: BusinessType): CoolDownAction[] {
        const base: CoolDownAction[] = ['scroll_reviews', 'read_about', 'explore_popular_times']
        let extra: CoolDownAction[] = ['browse_photos_deep', 'hover_share_save', 'nearby_glance', 'read_reviews_deep']

        if (businessType === 'restaurant' || businessType === 'hotel') {
            extra = ['browse_photos_deep', 'read_reviews_deep', 'hover_share_save', 'nearby_glance']
        } else if (businessType === 'clinic') {
            extra = ['read_reviews_deep', 'hover_share_save', 'read_about']
        }
        return shuffleArray([...base, ...extra]).slice(0, 5)
    }

    // -----------------------------------------------------------------------
    // Time Padding — Ensure session >= 75s (Maps KPI Opt) + recheck/hover stars + natural exit
    // -----------------------------------------------------------------------

    private async executeTimePadding(
        page: Page,
        threadId: number,
        remainingMs: number,
        actions: SessionAction[],
        shouldStop: () => boolean
    ): Promise<void> {
        const paddingEnd = Date.now() + remainingMs
        let iteration = 0

        while (Date.now() < paddingEnd && !shouldStop()) {
            iteration++
            const mod = iteration % 5
            const paddingAction: 'idle_hover' | 'scroll_gentle' | 'map_drift' | 'recheck_hours' | 'hover_rating_stars' =
                mod === 0 ? 'recheck_hours'
                    : mod === 1 ? 'hover_rating_stars'
                    : mod === 2 ? 'idle_hover'
                    : mod === 3 ? 'scroll_gentle'
                    : 'map_drift'

            try {
                switch (paddingAction) {
                    case 'scroll_gentle':
                        await DOMUtils.scrollObservedPage(page, Math.random() > 0.5 ? 'down' : 'up')
                        break
                    case 'map_drift': {
                        const vp = page.viewportSize()
                        if (vp) {
                            const x = randomInt(100, vp.width - 100)
                            const y = randomInt(100, vp.height - 100)
                            await moveCursor(page, x, y)
                            await page.mouse.move(x, y, { steps: randomInt(5, 10) }).catch(() => {})
                        }
                        break
                    }
                    case 'recheck_hours':
                        await this.recheckHours(page, threadId)
                        break
                    case 'hover_rating_stars':
                        await this.hoverRatingStars(page, threadId)
                        break
                    case 'idle_hover':
                        // Simulate reading — just wait
                        break
                }
            } catch {
                // Ignore padding errors
            }

            // Maps KPI Optimization (5): 2-8s delays for padding actions
            await delay(2000, 8000)
        }

        this.pushAction(actions, {
            action: 'session_time_padding',
            success: true,
            source: 'autonomous',
            detail: `Padded ${Math.round(remainingMs / 1000)}s`,
        })

        // Natural exit after padding (point 5)
        if (!shouldStop()) {
            await this.naturalExit(page, threadId, actions)
        }
    }

    // -----------------------------------------------------------------------
    // Organic Browsing Actions
    // -----------------------------------------------------------------------

    /** Scroll the place info panel naturally */
    private async scrollPanel(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Scrolling place panel...`)
        const scrollCount = randomInt(3, 6)
        for (let i = 0; i < scrollCount; i++) {
            await DOMUtils.scrollObservedPage(page, 'down')
            await delay(800, 1800)
        }
        // Scroll back up partially
        if (Math.random() > 0.4) {
            await DOMUtils.scrollObservedPage(page, 'up')
            await delay(600, 1200)
        }
        return true
    }

    /** Read info sections (hours, address, etc.) */
    private async readInfoSection(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Reading info section...`)
        const sections = [
            'div[data-section-id="hours"]',
            'div[data-section-id="address"]',
            'div[data-section-id="phone"]',
            'button[data-tab-id="about"]',
        ]

        for (const selector of shuffleArray(sections).slice(0, 2)) {
            const el = page.locator(selector).first()
            const visible = await el.isVisible({ timeout: 1000 }).catch(() => false)
            if (visible) {
                const box = await el.boundingBox().catch(() => null)
                if (box) {
                    await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2)
                    await page.mouse.move(
                        box.x + box.width / 2,
                        box.y + box.height / 2,
                        { steps: randomInt(4, 8) }
                    ).catch(() => {})
                    await delay(1500, 3000) // "reading" pause
                }
            }
        }
        return true
    }

    /** Zoom in/out on the map area */
    private async zoomMap(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Zooming map...`)
        const mapArea = page.locator('div[aria-label*="Map"], div.widget-scene-canvas, canvas').first()
        const visible = await mapArea.isVisible({ timeout: 1500 }).catch(() => false)
        if (!visible) return false

        const box = await mapArea.boundingBox().catch(() => null)
        if (!box) return false

        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        await moveCursor(page, cx, cy)
        await page.mouse.move(cx, cy).catch(() => {})

        // Zoom in
        await page.mouse.wheel(0, -randomInt(200, 350)).catch(() => {})
        await delay(600, 1200)

        // Zoom out partially
        await page.mouse.wheel(0, randomInt(100, 200)).catch(() => {})
        await delay(500, 1000)

        return true
    }

    /** Pan/drag the map */
    private async panMap(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Panning map...`)
        const mapArea = page.locator('div[aria-label*="Map"], div.widget-scene-canvas, canvas').first()
        const visible = await mapArea.isVisible({ timeout: 1500 }).catch(() => false)
        if (!visible) return false

        const box = await mapArea.boundingBox().catch(() => null)
        if (!box) return false

        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        const offsetX = (Math.random() - 0.5) * box.width * 0.3
        const offsetY = (Math.random() - 0.5) * box.height * 0.3

        await moveCursor(page, cx, cy)
        await page.mouse.move(cx, cy).catch(() => {})
        await page.mouse.down().catch(() => {})
        await page.mouse.move(cx + offsetX, cy + offsetY, { steps: randomInt(8, 14) }).catch(() => {})
        await page.mouse.up().catch(() => {})
        await delay(500, 1200)

        return true
    }

    /** Quick preview of the photos thumbnail area (no full viewer) */
    private async browsePhotosPreview(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Browsing photos preview...`)
        const photoArea = page.locator('button[data-tab-id="photos"], div[data-section-id="photos"]').first()
        const visible = await photoArea.isVisible({ timeout: 1000 }).catch(() => false)
        if (!visible) return false

        const box = await photoArea.boundingBox().catch(() => null)
        if (box) {
            await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 }).catch(() => {})
            await delay(1200, 2500) // "looking at photos" pause
        }
        return true
    }

    /** Scroll through reviews section */
    private async scrollReviews(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Scrolling reviews...`)

        // Try to open reviews tab
        const reviewTab = page.locator('button[data-tab-id="reviews"]').first()
        const reviewTabVisible = await reviewTab.isVisible({ timeout: 1000 }).catch(() => false)
        if (reviewTabVisible) {
            await reviewTab.click({ timeout: 2000 }).catch(() => {})
            await delay(800, 1500)
        }

        // Scroll through reviews
        const scrollCount = randomInt(3, 6)
        for (let i = 0; i < scrollCount; i++) {
            await DOMUtils.scrollObservedPage(page, 'down')
            await delay(1000, 2500)
        }

        // Occasionally expand a review
        if (Math.random() > 0.5) {
            const moreBtn = page.locator('button:has-text("More"), button:has-text("Thêm")').first()
            const moreBtnVisible = await moreBtn.isVisible({ timeout: 800 }).catch(() => false)
            if (moreBtnVisible) {
                await moreBtn.click({ timeout: 1500 }).catch(() => {})
                await delay(800, 1500)
            }
        }

        return true
    }

    /** Browse full photo viewer */
    private async browsePhotos(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Browsing full photos...`)
        const photosTab = page.locator('button[data-tab-id="photos"], button:has-text("Photos"), button:has-text("Ảnh")').first()
        const visible = await photosTab.isVisible({ timeout: 1000 }).catch(() => false)

        if (visible) {
            await photosTab.click({ timeout: 2000 }).catch(() => {})
            await delay(1000, 2000)

            // Scroll through photo thumbnails
            const scrollCount = randomInt(2, 4)
            for (let i = 0; i < scrollCount; i++) {
                await DOMUtils.scrollObservedPage(page, 'down')
                await delay(800, 1800)
            }
        }
        return true
    }

    /** Read the About/Overview section */
    private async readAboutSection(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Reading about section...`)
        const aboutTab = page.locator('button[data-tab-id="about"], button:has-text("About"), button:has-text("Giới thiệu")').first()
        const visible = await aboutTab.isVisible({ timeout: 1000 }).catch(() => false)

        if (visible) {
            await aboutTab.click({ timeout: 2000 }).catch(() => {})
            await delay(1000, 2000)
            await DOMUtils.scrollObservedPage(page, 'down')
            await delay(1500, 3000)
        }
        return true
    }

    /** Explore Popular Times chart */
    private async explorePopularTimes(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Exploring popular times...`)
        const popSection = page.locator('div[aria-label*="Popular times" i], div[data-section-id="poptimes"]').first()
        const visible = await popSection.isVisible({ timeout: 1000 }).catch(() => false)

        if (visible) {
            const box = await popSection.boundingBox().catch(() => null)
            if (box) {
                await popSection.hover().catch(() => {})
                await delay(1500, 3000)

                // Click a day bar
                const bars = page.locator('div[aria-label*="Popular times" i] div[role="img"], div[data-section-id="poptimes"] div[role="button"]')
                const barCount = await bars.count().catch(() => 0)
                if (barCount > 0) {
                    const barIdx = randomInt(0, Math.min(barCount - 1, 5))
                    await bars.nth(barIdx).click({ timeout: 1500 }).catch(() => {})
                    await delay(1000, 2000)
                }
            }
        }
        return true
    }

    // -----------------------------------------------------------------------
    // Maps KPI Optimization: Deep browsing + time padding actions + helpers
    // -----------------------------------------------------------------------

    /**
     * browsePhotosDeep (2): open photo viewer / lightbox, browse multiple photos with nav,
     * hovers, scroll, close naturally. Used in warm-up and cool-down.
     */
    private async browsePhotosDeep(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Browsing photos deep (viewer)...`)
        // Try tab first, then direct photo grid to open viewer
        const photosTab = page.locator('button[data-tab-id="photos"], button:has-text("Photos"), button:has-text("Ảnh"), div[data-section-id="photos"]').first()
        let opened = false
        const tabVisible = await photosTab.isVisible({ timeout: 1200 }).catch(() => false)
        if (tabVisible) {
            await photosTab.click({ timeout: 2000 }).catch(() => {})
            await delay(900, 1600)
            opened = true
        }
        // Click first visible photo thumbnail to enter full viewer/lightbox
        const firstPhoto = page.locator('div[role="img"][aria-label*="Photo" i], button img, a[href*="photo"] img, div[data-photo-index], .gallery img').first()
        const photoVisible = await firstPhoto.isVisible({ timeout: 1200 }).catch(() => false)
        if (photoVisible) {
            const box = await firstPhoto.boundingBox().catch(() => null)
            if (box) {
                await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2)
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: randomInt(5, 9) }).catch(() => {})
                await firstPhoto.click({ timeout: 1800 }).catch(() => {})
                await delay(1100, 2200)
                opened = true
            }
        }

        if (opened) {
            // Browse 2-4 photos in viewer (arrows / next buttons)
            const navCount = randomInt(2, 4)
            for (let i = 0; i < navCount; i++) {
                const nextBtn = page.locator('button[aria-label*="Next" i], button[aria-label*="Tiếp" i], button[aria-label*="›" i], [jsaction*="next"]').first()
                const nextVis = await nextBtn.isVisible({ timeout: 800 }).catch(() => false)
                if (nextVis) {
                    await nextBtn.hover().catch(() => {})
                    await delay(400, 900)
                    await nextBtn.click({ timeout: 1200 }).catch(() => {})
                } else {
                    // Fallback: right arrow key or wheel
                    await page.keyboard.press('ArrowRight').catch(() => {})
                }
                await delay(900, 1800)
                // Occasional hover on photo area
                await page.mouse.move(400 + randomInt(0, 200), 300 + randomInt(0, 150), { steps: 4 }).catch(() => {})
                await delay(600, 1100)
            }
            // Close viewer naturally
            const closeBtn = page.locator('button[aria-label*="Close" i], button[aria-label*="Đóng" i], button[aria-label*="×" i], [jsaction*="close"]').first()
            const closeVis = await closeBtn.isVisible({ timeout: 800 }).catch(() => false)
            if (closeVis) {
                await closeBtn.click({ timeout: 1500 }).catch(() => {})
            } else {
                await page.keyboard.press('Escape').catch(() => {})
            }
            await delay(700, 1400)
        }
        return true
    }

    /**
     * readReviewsDeep (3): open reviews, apply sorting, scroll, expand, hover "useful"/"helpful".
     */
    private async readReviewsDeep(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Reading reviews deep (sort/scroll/expand/hover useful)...`)
        // Open reviews tab/section
        const reviewTab = page.locator('button[data-tab-id="reviews"], button:has-text("Reviews"), button:has-text("Đánh giá")').first()
        const tabVis = await reviewTab.isVisible({ timeout: 1200 }).catch(() => false)
        if (tabVis) {
            await reviewTab.click({ timeout: 2000 }).catch(() => {})
            await delay(800, 1500)
        }

        // Sorting (newest / relevant / highest)
        const sortBtn = page.locator('button:has-text("Sort"), button:has-text("Sắp xếp"), [aria-label*="Sort" i], button[aria-haspopup="listbox"]').first()
        const sortVis = await sortBtn.isVisible({ timeout: 1000 }).catch(() => false)
        if (sortVis) {
            await sortBtn.click({ timeout: 1500 }).catch(() => {})
            await delay(500, 900)
            const option = page.locator('div[role="option"]:has-text("Newest"), div[role="option"]:has-text("Mới nhất"), li:has-text("Highest"), [data-value*="newest" i]').first()
            const optVis = await option.isVisible({ timeout: 800 }).catch(() => false)
            if (optVis) {
                await option.click({ timeout: 1200 }).catch(() => {})
                await delay(900, 1700)
            } else {
                await page.keyboard.press('Escape').catch(() => {})
            }
        }

        // Scroll reviews deeply
        const scrollCount = randomInt(4, 8)
        for (let i = 0; i < scrollCount; i++) {
            await DOMUtils.scrollObservedPage(page, 'down')
            await delay(700, 1600)
        }

        // Expand 1-2 "More"/"Xem thêm"
        const moreBtns = page.locator('button:has-text("More"), button:has-text("Thêm"), button:has-text("Xem thêm")')
        const moreCount = Math.min(await moreBtns.count().catch(() => 0), 2)
        for (let i = 0; i < moreCount; i++) {
            await moreBtns.nth(i).click({ timeout: 1200 }).catch(() => {})
            await delay(700, 1400)
        }

        // Hover "Useful" / "Helpful" / "Hữu ích" (no click to stay non-voting signal)
        const useful = page.locator('button:has-text("Useful"), button:has-text("Helpful"), button:has-text("Hữu ích"), button[aria-label*="useful" i], button[aria-label*="helpful" i]').first()
        const usefulVis = await useful.isVisible({ timeout: 900 }).catch(() => false)
        if (usefulVis) {
            await useful.hover().catch(() => {})
            await delay(1100, 2300)
            // Slight move as if reading the vote count
            await page.mouse.move(0, 8, { steps: 3 }).catch(() => {})
            await delay(600, 1200)
        }

        // Gentle scroll back
        if (Math.random() > 0.5) {
            await DOMUtils.scrollObservedPage(page, 'up')
            await delay(600, 1100)
        }
        return true
    }

    /** Hover share / save buttons (post-KPI cool-down enrichment) */
    private async hoverShareSave(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Hovering share/save actions...`)
        const share = page.locator('button[aria-label*="Share" i], button:has-text("Share"), button:has-text("Chia sẻ"), a[aria-label*="Share" i]').first()
        if (await share.isVisible({ timeout: 800 }).catch(() => false)) {
            await share.hover().catch(() => {})
            await delay(900, 1800)
        }
        const save = page.locator('button[aria-label*="Save" i], button:has-text("Save"), button:has-text("Lưu"), button[aria-label*="bookmark" i]').first()
        if (await save.isVisible({ timeout: 800 }).catch(() => false)) {
            await save.hover().catch(() => {})
            await delay(800, 1700)
        }
        return true
    }

    /** Quick nearby / "People also search" glance (contextual natural behavior) */
    private async glanceNearby(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Glancing nearby suggestions...`)
        const nearby = page.locator('div[aria-label*="Nearby" i], button:has-text("Nearby"), [data-section-id*="nearby" i], a:has-text("Similar")').first()
        const vis = await nearby.isVisible({ timeout: 900 }).catch(() => false)
        if (vis) {
            const box = await nearby.boundingBox().catch(() => null)
            if (box) {
                await moveCursor(page, box.x + 20, box.y + 12)
                await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: randomInt(4, 8) }).catch(() => {})
                await delay(1200, 2400)
            }
        }
        return true
    }

    /** Recheck hours (for time padding + warm-up) */
    private async recheckHours(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Rechecking hours...`)
        const hours = page.locator('div[data-section-id="hours"], button[aria-label*="Hours" i], [aria-label*="Giờ" i]').first()
        const vis = await hours.isVisible({ timeout: 900 }).catch(() => false)
        if (vis) {
            const box = await hours.boundingBox().catch(() => null)
            if (box) {
                await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2)
                await hours.hover().catch(() => {})
                await delay(1400, 2800)
                // Click to expand if possible (recheck)
                await hours.click({ timeout: 1200 }).catch(() => {})
                await delay(900, 1800)
            }
        }
        return true
    }

    /** Hover over rating stars area (micro trust/inspection signal) */
    private async hoverRatingStars(page: Page, threadId: number): Promise<boolean> {
        log(`T${threadId}: Hovering rating stars...`)
        const rating = page.locator('div[aria-label*="rating" i], span[aria-label*="stars" i], [role="img"][aria-label*="Rated" i], button[aria-label*="Rate" i]').first()
        const vis = await rating.isVisible({ timeout: 900 }).catch(() => false)
        if (vis) {
            const box = await rating.boundingBox().catch(() => null)
            if (box) {
                await moveCursor(page, box.x + 8, box.y + box.height / 2)
                // Slow sweep across stars
                for (let s = 0; s < 5; s++) {
                    await page.mouse.move(box.x + 8 + s * 14, box.y + box.height / 2, { steps: 2 }).catch(() => {})
                    await delay(180, 420)
                }
                await delay(900, 1600)
            }
        }
        return true
    }

    /** Dynamic KPI spacing per business type (point 6) */
    private getKpiSpacing(businessType: BusinessType): { min: number; max: number } {
        switch (businessType) {
            case 'restaurant': return { min: 4000, max: 8000 }
            case 'hotel':      return { min: 5000, max: 10000 }
            case 'clinic':     return { min: 3000, max: 7000 }
            default:           return { min: 3000, max: 8000 } // generic + store/service/entertainment
        }
    }

    /** Small natural micro-engagement between KPIs (hover/scroll snippet) */
    private async microEngagement(page: Page, threadId: number): Promise<void> {
        try {
            if (Math.random() > 0.5) {
                await DOMUtils.scrollObservedPage(page, Math.random() > 0.6 ? 'down' : 'up')
            } else {
                const info = page.locator('div[data-section-id="address"], button[data-tab-id="about"]').first()
                if (await info.isVisible({ timeout: 600 }).catch(() => false)) {
                    await info.hover().catch(() => {})
                }
            }
        } catch {
            // best effort micro
        }
        await delay(400, 900)
    }

    /** Natural exit behavior at end of padded session */
    private async naturalExit(page: Page, threadId: number, actions: SessionAction[]): Promise<void> {
        const start = Date.now()
        try {
            // Gentle return to top of panel + final hover on header/rating
            await DOMUtils.scrollObservedPage(page, 'up')
            await delay(600, 1100)
            const header = page.locator('h1, [role="heading"], button[data-tab-id="overview"], div[aria-label*="rating" i]').first()
            if (await header.isVisible({ timeout: 700 }).catch(() => false)) {
                await header.hover().catch(() => {})
            }
            await delay(1100, 1900)
        } catch {
            await delay(800, 1400)
        }
        this.pushAction(actions, {
            action: 'natural_session_exit',
            success: true,
            source: 'autonomous',
            durationMs: Date.now() - start,
        })
    }

    // -----------------------------------------------------------------------
    // Context Recovery & Safety
    // -----------------------------------------------------------------------

    /** Ensure the page is still on the target Google Maps place */
    private async ensureTargetContext(
        page: Page,
        targetUrl: string,
        threadId: number,
        actions: SessionAction[]
    ): Promise<void> {
        if (page.isClosed()) return

        const currentUrl = page.url()

        // Check if we're still on a Google Maps page
        const isOnMaps = currentUrl.includes('google.com/maps')
            || currentUrl.includes('maps.google.')
        if (isOnMaps) return

        // Not on maps → try to recover
        log(`T${threadId}: Off-target (${currentUrl.substring(0, 80)}). Recovering...`)

        // Try context resolver first
        const resolved = await contextualInterruptionResolver.resolve(page, {
            reason: 'autonomous_context_recovery',
            useLlmFallback: false,
            useEscapeFallback: true,
            maxPasses: 2,
            goal: 'map_interaction',
            campaignType: 'traffic',
            domain: currentUrl,
        }).catch((): ContextualInterruptionResolveResult => ({ handled: false }))

        if (resolved.handled) {
            await delay(300, 600)
            if (page.url().includes('google.com/maps')) {
                this.pushAction(actions, {
                    action: 'context_recovery',
                    success: true,
                    source: 'recovery',
                    detail: `Recovered via ${resolved.via || 'resolver'}`,
                })
                return
            }
        }

        // Fallback: press Escape
        await page.keyboard.press('Escape').catch(() => {})
        await delay(300, 600)

        if (page.url().includes('google.com/maps')) return

        // Fallback: goBack
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {})
        await delay(500, 1000)

        if (page.url().includes('google.com/maps')) {
            this.pushAction(actions, {
                action: 'context_recovery',
                success: true,
                source: 'recovery',
                detail: 'Recovered via goBack',
            })
            return
        }

        // Final fallback: navigate directly
        try {
            await page.goto(targetUrl, { waitUntil: 'commit', timeout: 15000 })
            await delay(1000, 2000)
            this.pushAction(actions, {
                action: 'context_recovery',
                success: true,
                source: 'recovery',
                detail: 'Recovered via direct navigation',
            })
        } catch (err) {
            log(`T${threadId}: Context recovery failed: ${err}`)
            this.pushAction(actions, {
                action: 'context_recovery',
                success: false,
                source: 'recovery',
                detail: `Failed: ${err}`,
            })
        }
    }

    /** Recover from unexpected errors (dismiss overlays, press Escape) */
    private async recoverFromError(page: Page, threadId: number): Promise<void> {
        try {
            // Try closing any overlay
            const overlaySelectors = [
                'button[aria-label*="Close"]',
                'button[aria-label*="Dismiss"]',
                'button:has-text("OK")',
                'button:has-text("Got it")',
                'button:has-text("Đóng")',
                'button:has-text("Đã hiểu")',
            ]

            for (const selector of overlaySelectors) {
                const btn = page.locator(selector).first()
                const visible = await btn.isVisible({ timeout: 500 }).catch(() => false)
                if (visible) {
                    await btn.click({ timeout: 1500 }).catch(() => {})
                    log(`T${threadId}: Recovered by clicking: ${selector}`)
                    await delay(300, 600)
                    return
                }
            }

            // Fallback: Escape key
            await page.keyboard.press('Escape').catch(() => {})
            await delay(200, 400)
        } catch {
            // Best-effort recovery
        }
    }

    /** Close any extra tabs that opened (e.g. website popup) */
    private async cleanupExtraTabs(page: Page, threadId: number): Promise<void> {
        if (page.isClosed()) return

        const tabs = page.context().pages()
        let closedCount = 0

        for (const tab of tabs) {
            if (tab === page || tab.isClosed()) continue

            try {
                await tab.close({ runBeforeUnload: false })
                closedCount++
            } catch {
                // Ignore close failures
            }
        }

        if (closedCount > 0) {
            log(`T${threadId}: Closed ${closedCount} extra tab(s)`)
            await page.bringToFront().catch(() => {})
        }
    }

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------

    private pushAction(actions: SessionAction[], partial: Omit<SessionAction, 'timestamp'>): void {
        actions.push({
            ...partial,
            timestamp: nowISO(),
        })
    }
}

// Singleton export
export const autonomousMapAgent = new AutonomousMapAgent()
