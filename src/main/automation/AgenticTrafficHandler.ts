/**
 * AgenticTrafficHandler - Autonomous web automation for Traffic Boost using local LLM
 */

import { Page } from 'playwright'
import { ollamaService } from '../services/OllamaService'
import { writeAgenticLog } from '../utils/agenticLog'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'
import { isMapTargetRelevantElement, isUnsafeTrafficElement, pickTrafficFallbackAction } from './AgenticFallbacks'
import { DOMUtils, ExtractedInteractiveDOM, ObservedElementSummary } from './DOMUtils'
import { contextualInterruptionResolver } from './ContextualInterruptionResolver'
import { parseInterruptionCandidate, parseTrafficAgentAction } from './agentSchemas'
import { kpiSkills, KpiSkillResult } from './KpiSkills'

export interface AgentTrafficAction {
    thought: string
    action: 'click' | 'wait' | 'scroll_down' | 'scroll_up' | 'finish' | 'fail'
    element_id?: number
}

export interface AgenticPerformedAction {
    action: string
    success: boolean
    source?: string
    detail?: string
    thought?: string
    error?: string
    durationMs?: number
    step?: number
    elementId?: number
    timestamp?: string
}

interface AgentDecisionResult {
    actionData: AgentTrafficAction
    source: 'llm' | 'heuristic'
}

type FollowUpIntent = 'photos' | 'reviews' | 'directions' | 'info' | 'map' | 'generic'
type InterruptionRecoveryResult = { handled: boolean; via?: string; detail?: string }

export class AgenticTrafficHandler {
    private readonly MIN_STEPS = 8
    private readonly MAX_STEPS = 24
    private LLM_TIMEOUT_MS = 3200
    private readonly allowedActions = new Set<AgentTrafficAction['action']>(['click', 'wait', 'scroll_down', 'scroll_up', 'finish', 'fail'])

    private log(msg: string) {
        console.log(`[AgenticTraffic] ${msg}`)
        writeAgenticLog('AgenticTraffic', msg)
    }

    private delay(min: number, max: number, context: 'kpi' | 'organic' | 'transition' = 'organic'): Promise<void> {
        // Adaptive speed: KPI actions run at real human speed (Google tracks these).
        // Organic = moderate speed, Transition = faster for UI navigation.
        const speedFactor = context === 'kpi' ? 1.0 : context === 'transition' ? 0.5 : 0.7
        const scaledMin = Math.max(80, Math.floor(min * speedFactor))
        const scaledMax = Math.max(scaledMin, Math.floor(max * speedFactor))
        const ms = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    private randomInt(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    private sanitizeForStatus(raw: string, maxLen = 180): string {
        const withoutAnsi = raw.replace(/\u001b\[[0-9;]*m/g, '')
        const oneLine = withoutAnsi.replace(/\s+/g, ' ').trim()
        if (oneLine.length <= maxLen) {
            return oneLine
        }

        return `${oneLine.slice(0, maxLen)}...`
    }

    private formatError(error: unknown): string {
        const raw = error instanceof Error ? error.message : String(error)
        return this.sanitizeForStatus(raw, 260)
    }

    private pushAction(
        actionsPerformed: AgenticPerformedAction[],
        action: AgenticPerformedAction
    ): void {
        actionsPerformed.push({
            ...action,
            timestamp: action.timestamp || new Date().toISOString(),
        })
    }

    private isValidAction(actionData: unknown): actionData is AgentTrafficAction {
        if (!actionData || typeof actionData !== 'object') {
            return false
        }

        const candidate = actionData as Record<string, unknown>
        return typeof candidate.thought === 'string'
            && typeof candidate.action === 'string'
            && this.allowedActions.has(candidate.action as AgentTrafficAction['action'])
    }

    private async preparePage(page: Page, threadId: number): Promise<void> {
        if (page.isClosed()) {
            throw new Error(`Playwright page for thread ${threadId} is already closed`)
        }

        await page.bringToFront().catch((error: unknown) => {
            this.log(`T${threadId}: Failed to bring page to front: ${this.formatError(error)}`)
        })
    }

    private async cleanupExtraTabs(page: Page, threadId: number, reason: string): Promise<void> {
        if (page.isClosed()) {
            return
        }

        const tabs = page.context().pages()
        let closed = 0

        for (const tab of tabs) {
            if (tab === page || tab.isClosed()) {
                continue
            }

            try {
                await tab.close({ runBeforeUnload: false })
                closed++
            } catch {
                // Ignore tabs that cannot be closed.
            }
        }

        if (closed > 0) {
            this.log(`T${threadId}: Closed ${closed} extra tab(s) during ${reason}`)
        }

        await page.bringToFront().catch(() => { })
    }

    private getSummaryById(summaries: ObservedElementSummary[], elementId: number): ObservedElementSummary | undefined {
        return summaries.find(summary => summary.id === elementId)
    }

    private shouldRecoverOverlay(errorMessage: string): boolean {
        const pattern = /(intercepts pointer events|another element|element is detached|timeout|not receiving pointer events|subtree intercepts)/i
        return pattern.test(errorMessage)
    }

    private getMinStepsBeforeTerminalAction(targetSteps: number): number {
        return Math.max(6, Math.min(18, Math.floor(targetSteps * 0.6)))
    }

    private isLikelyInterruptionSignal(text: string): boolean {
        if (!text) {
            return false
        }

        return /(vi tri chinh xac|location|near your location|cookie|consent|thong bao|notification|xuat hien|posts appear|dang nhap|sign in|allow|cho phep)/i.test(text)
    }

    private scoreInterruptionCandidate(summary: ObservedElementSummary): number {
        const text = this.summaryText(summary)
        if (!text) {
            return -99
        }

        let score = 0
        if (summary.tagName === 'button' || summary.role === 'button') {
            score += 2
        }

        if (/(de sau|later|not now|skip|close|dismiss|cancel|dong|ok|got it|continue|da hieu|hieu roi|done|xong)/i.test(text)) {
            score += 8
        }

        if (/(accept|i agree|dong y|chap nhan|allow once)/i.test(text)) {
            score += 3
        }

        if (/(su dung vi tri chinh xac|use precise location|always allow|share location|bat vi tri|cho phep vi tri)/i.test(text)) {
            score -= 8
        }

        if (/(dang nhap|sign in|login|create account|tao tai khoan|submit|publish|post|upload|share publicly)/i.test(text)) {
            score -= 10
        }

        if (summary.href && /^https?:\/\//i.test(summary.href)) {
            score -= 4
        }

        return score
    }

    private async clickObservedElementFast(
        page: Page,
        elementId: number,
        threadId: number,
        summary?: ObservedElementSummary
    ): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        const count = await locator.count().catch(() => 0)
        if (count === 0) {
            throw new Error(`Interruption element ${elementId} not found`)
        }

        await locator.waitFor({ state: 'visible', timeout: 2200 })
        await locator.scrollIntoViewIfNeeded().catch(() => { })
        await this.delay(80, 180)
        await locator.click({ timeout: 1500 }).catch(async () => {
            await locator.click({ timeout: 1500, force: true })
        })
        this.log(`T${threadId}: Fast-clicked interruption element ${elementId}${summary ? ` (${summary.tagName})` : ''}`)
    }

    private async resolveInterruptionByScreenUnderstanding(
        page: Page,
        threadId: number
    ): Promise<InterruptionRecoveryResult> {
        const signal = await page.evaluate(() => {
            const dialogEl = document.querySelector('[role="dialog"], [aria-modal="true"], [role="alertdialog"]') as HTMLElement | null
            const rect = dialogEl?.getBoundingClientRect()
            const hasVisibleDialog = !!dialogEl && !!rect && rect.width > 0 && rect.height > 0
            const rawText = (dialogEl?.innerText || document.body?.innerText || '').slice(0, 1800)
            const text = rawText.replace(/\s+/g, ' ').trim()
            return { hasVisibleDialog, text }
        }).catch(() => ({ hasVisibleDialog: false, text: '' }))

        const normalizedSignalText = this.normalizedText(signal.text)
        if (!signal.hasVisibleDialog && !this.isLikelyInterruptionSignal(normalizedSignalText)) {
            return { handled: false }
        }

        const snapshot = await DOMUtils.extractInteractiveDOM(page)
        const candidates = snapshot.summaries
            .filter(summary => {
                const tag = (summary.tagName || '').toLowerCase()
                const role = (summary.role || '').toLowerCase()
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    return false
                }
                return tag === 'button'
                    || tag === 'a'
                    || role === 'button'
                    || role === 'link'
                    || role === 'menuitem'
            })
            .map(summary => ({
                summary,
                score: this.scoreInterruptionCandidate(summary),
                label: this.summaryText(summary).slice(0, 120),
            }))
            .sort((left, right) => right.score - left.score)

        const top = candidates.slice(0, 6)
        for (const candidate of top) {
            if (candidate.score < 4) {
                continue
            }

            try {
                await this.clickObservedElementFast(page, candidate.summary.id, threadId, candidate.summary)
                await this.delay(180, 320)
                this.log(`T${threadId}: Screen-understanding recovered interruption by clicking "${candidate.label}" (score=${candidate.score})`)
                return {
                    handled: true,
                    via: 'semantic_candidate',
                    detail: `${candidate.summary.id}:${candidate.label || 'unknown'}`,
                }
            } catch (error: unknown) {
                this.log(`T${threadId}: Semantic interruption candidate ${candidate.summary.id} failed: ${this.formatError(error)}`)
            }
        }

        if (signal.hasVisibleDialog && top.length > 0) {
            const llmCandidates = top
                .map(item => `{"id":${item.summary.id},"text":"${(item.label || '').replace(/"/g, '\\"')}","score":${item.score}}`)
                .join('\n')

            const llmPrompt = `A browser interruption dialog is blocking automation.
Visible dialog text: "${this.sanitizeForStatus(signal.text, 320)}"
Candidate actions:
${llmCandidates}

Choose the safest and fastest action to continue normal browsing.
Prefer: close/skip/later/not now/dong/de sau.
Avoid: sign in, upload, submit, share publicly, precise location allow.

Respond strictly as JSON. No markdown:
{"thought":"brief logical reason","element_id":number}`

            const llmResult = await ollamaService.chat('Pick interruption action', llmPrompt, true, 4500)
            if (llmResult.success && llmResult.response) {
                try {
                    const parsed = JSON.parse(llmResult.response.trim())
                    const parsedCandidate = parseInterruptionCandidate(parsed)
                    if (!parsedCandidate.success) {
                        return { handled: false }
                    }
                    const chosenId = Number(parsedCandidate.data.element_id)
                    if (Number.isFinite(chosenId) && top.some(item => item.summary.id === chosenId)) {
                        const chosen = top.find(item => item.summary.id === chosenId)!
                        await this.clickObservedElementFast(page, chosenId, threadId, chosen.summary)
                        await this.delay(200, 360)
                        this.log(`T${threadId}: LLM recovered interruption via candidate ${chosenId}`)
                        return {
                            handled: true,
                            via: 'llm_candidate',
                            detail: `${chosenId}:${chosen.label || 'unknown'}`,
                        }
                    }
                } catch {
                    // Ignore malformed JSON and continue fallback.
                }
            }
        }

        return { handled: false }
    }

    private async recoverFromUnexpectedOverlay(
        page: Page,
        threadId: number,
        options: { useEscapeFallback?: boolean } = {}
    ): Promise<InterruptionRecoveryResult> {
        const sharedRecovery = await contextualInterruptionResolver.resolve(page, {
            threadId,
            reason: 'agentic_traffic_overlay',
            useLlmFallback: true,
            llmTimeoutMs: 2600,
            useEscapeFallback: options.useEscapeFallback,
            maxPasses: 3,
            goal: 'map_interaction',
            campaignType: 'traffic',
            domain: page.url(),
            logger: (msg) => this.log(msg),
        }).catch(() => ({ handled: false } as InterruptionRecoveryResult))
        if (sharedRecovery.handled) {
            return sharedRecovery
        }

        const selectors = [
            'button[aria-label*="Close"]',
            'button[aria-label*="Dismiss"]',
            'button[aria-label*="Cancel"]',
            'button[aria-label*="OK"]',
            'button[aria-label*="Dong y"]',
            'button[aria-label*="Tiep tuc"]',
            'button[aria-label*="Da hieu"]',
            'button[aria-label*="Dong"]',
            'button:has-text("Close")',
            'button:has-text("Dismiss")',
            'button:has-text("OK")',
            'button:has-text("Ok")',
            'button:has-text("Not now")',
            'button:has-text("No thanks")',
            'button:has-text("Cancel")',
            'button:has-text("Skip")',
            'button:has-text("Later")',
            'button:has-text("Got it")',
            'button:has-text("Continue")',
            'button:has-text("Đồng ý")',
            'button:has-text("Đã hiểu")',
            'button:has-text("Hiểu rồi")',
            'button:has-text("Tiếp tục")',
            'button:has-text("Đóng")',
            '[role="dialog"] button:has-text("OK")',
            '[role="dialog"] button:has-text("Ok")',
            '[role="dialog"] button:has-text("Close")',
            '[role="dialog"] button:has-text("Dismiss")',
            '[role="dialog"] button:has-text("Got it")',
            '[role="dialog"] button:has-text("Đồng ý")',
            '[role="dialog"] button:has-text("Đã hiểu")',
            '[role="dialog"] button:has-text("Tiếp tục")',
            '[role="dialog"] button:has-text("Đóng")',
            'button:has-text("Accept all")',
            'button:has-text("I agree")',
        ]

        for (const selector of selectors) {
            const locator = page.locator(selector).first()
            const count = await locator.count().catch(() => 0)
            if (count === 0) {
                continue
            }

            try {
                if (await locator.isVisible({ timeout: 600 }).catch(() => false)) {
                    await locator.click({ timeout: 1500 }).catch(async () => {
                        await locator.click({ timeout: 1500, force: true })
                    })
                    this.log(`T${threadId}: Recovered by dismissing potential overlay via selector: ${selector}`)
                    await this.delay(180, 320)
                    return { handled: true, via: selector }
                }
            } catch {
                // Try next selector.
            }
        }

        if (options.useEscapeFallback) {
            await page.keyboard.press('Escape').catch(() => { })
            await this.delay(120, 240)
            return { handled: true, via: 'keyboard_escape' }
        }

        return { handled: false }
    }

    private async clickObservedElement(
        page: Page,
        elementId: number,
        threadId: number,
        summary?: ObservedElementSummary
    ): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        if (await locator.count() === 0) {
            throw new Error(`Observed element ${elementId} no longer exists in the DOM`)
        }

        await locator.waitFor({ state: 'visible', timeout: 5000 })
        await locator.scrollIntoViewIfNeeded().catch(() => {})
        await this.delay(180, 320)

        const strategies: Array<{ name: string; run: () => Promise<void> }> = [
            {
                name: 'direct_click',
                run: async () => {
                    await locator.click({ timeout: 2200 })
                },
            },
            {
                name: 'force_click',
                run: async () => {
                    await locator.click({ timeout: 2200, force: true })
                },
            },
            {
                name: 'mouse_center_click',
                run: async () => {
                    const box = await locator.boundingBox()
                    if (!box) {
                        throw new Error('No bounding box available for mouse click fallback')
                    }

                    const x = box.x + Math.max(4, box.width / 2)
                    const y = box.y + Math.max(4, box.height / 2)
                    await moveCursor(page, x, y)
                    await page.mouse.move(x, y)
                    await clickCursor(page, x, y)
                    await page.mouse.click(x, y, { delay: 35 })
                },
            },
            {
                name: 'dom_dispatch_click',
                run: async () => {
                    await locator.evaluate(node => {
                        const target = (node as HTMLElement).closest('button,a,[role="button"],[role="link"],input,textarea,select') as HTMLElement | null
                        const element = target || (node as HTMLElement)
                        element.focus?.()
                        element.click?.()
                        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    })
                },
            },
            {
                name: 'overlay_recover_then_click',
                run: async () => {
                    const overlayResult = await this.recoverFromUnexpectedOverlay(page, threadId, { useEscapeFallback: true })
                    if (!overlayResult.handled) {
                        throw new Error('Overlay recovery unavailable for retry')
                    }
                    await this.delay(100, 220)
                    await locator.click({ timeout: 2200 })
                },
            },
        ]

        let lastError = ''
        for (const strategy of strategies) {
            try {
                await strategy.run()
                this.log(`T${threadId}: Clicked element ${elementId} with strategy ${strategy.name}${summary ? ` (${summary.tagName})` : ''}`)
                return
            } catch (error: unknown) {
                lastError = this.formatError(error)
                this.log(`T${threadId}: Click strategy ${strategy.name} failed on element ${elementId}: ${lastError}`)

                if (this.shouldRecoverOverlay(lastError)) {
                    const overlayResult = await this.recoverFromUnexpectedOverlay(page, threadId, { useEscapeFallback: true })
                    if (overlayResult.handled) {
                        this.log(`T${threadId}: Overlay recovery attempted via ${overlayResult.via || 'unknown'}`)
                    }
                }
            }
        }

        throw new Error(`All click strategies failed for element ${elementId}: ${lastError}`)
    }

    private normalizedText(value?: string): string {
        if (!value) return ''
        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
    }

    private summaryText(summary?: ObservedElementSummary): string {
        if (!summary) return ''
        return this.normalizedText(
            [
                summary.textContent,
                summary.ariaLabel,
                summary.title,
                summary.placeholder,
                summary.href,
                summary.role,
                summary.tagName,
                summary.type,
            ]
                .filter(Boolean)
                .join(' ')
        )
    }

    private buildSummaryFingerprint(summary?: ObservedElementSummary): string {
        if (!summary) {
            return 'unknown'
        }

        const text = this.normalizedText(summary.textContent)
        const aria = this.normalizedText(summary.ariaLabel)
        const title = this.normalizedText(summary.title)
        const placeholder = this.normalizedText(summary.placeholder)
        const href = this.normalizedText(summary.href)
        const tag = this.normalizedText(summary.tagName)
        const role = this.normalizedText(summary.role)
        const type = this.normalizedText(summary.type)

        const keyText = (text || aria || title || placeholder || href).slice(0, 120)
        return [tag, role, type, keyText].filter(Boolean).join('|') || `id:${summary.id}`
    }

    private buildFingerprintById(summaries: ObservedElementSummary[]): Map<number, string> {
        const map = new Map<number, string>()
        for (const summary of summaries) {
            map.set(summary.id, this.buildSummaryFingerprint(summary))
        }
        return map
    }

    private buildExcludedElementIds(
        summaries: ObservedElementSummary[],
        fingerprintById: Map<number, string>,
        recentFingerprints: string[],
        blockedFingerprints: Set<string>
    ): Set<number> {
        const excluded = new Set<number>()
        const recentSet = new Set<string>(recentFingerprints)

        for (const summary of summaries) {
            const fingerprint = fingerprintById.get(summary.id)
            if (!fingerprint) {
                continue
            }

            if (blockedFingerprints.has(fingerprint) || recentSet.has(fingerprint)) {
                excluded.add(summary.id)
            }
        }

        return excluded
    }

    private rememberRecentFingerprint(history: string[], fingerprint: string, maxSize = 16): void {
        if (!fingerprint) {
            return
        }

        history.unshift(fingerprint)
        if (history.length > maxSize) {
            history.length = maxSize
        }
    }

    private rememberRecentActionSignature(history: string[], signature: string, maxSize = 18): void {
        history.unshift(signature)
        if (history.length > maxSize) {
            history.length = maxSize
        }
    }

    private isActionLoop(history: string[], signature: string): boolean {
        if (!signature || history.length < 3) {
            return false
        }

        const recent = history.slice(0, 3)
        return recent.every(item => item === signature)
    }

    private getActionSignature(actionData: AgentTrafficAction, fingerprintById: Map<number, string>): string {
        if (actionData.action === 'click' && actionData.element_id !== undefined) {
            return `click:${fingerprintById.get(actionData.element_id) || `id:${actionData.element_id}`}`
        }
        return actionData.action
    }

    private contextRecoveryCount = 0
    private readonly MAX_CONTEXT_RECOVERIES = 3

    private isGoogleMapsUrl(url: string): boolean {
        // Accept any Google Maps page across any locale
        const lowerUrl = url.toLowerCase()
        return lowerUrl.includes('google.') && lowerUrl.includes('map')
    }

    /**
     * Check if we are still on or very close to the original target place page.
     * Returns false for /dir/, /search, /sorry, or any non-place Maps URL.
     */
    private isStillOnTargetPlace(currentUrl: string, targetUrl: string): boolean {
        const current = currentUrl.toLowerCase()
        const target = targetUrl.toLowerCase()

        // Clearly off-Google → not on target
        if (!current.includes('google.')) return false

        // On CAPTCHA/sorry page → not on target
        if (current.includes('/sorry')) return false

        // On Directions page → not on target (this is the main cause of flickering)
        if (current.includes('/dir')) return false

        // Accept if URL is substantially the same FIRST (just query params differ) 
        // This stops side-panel searches from being incorrectly rejected as drift
        const currentBase = current.split('?')[0]
        const targetBase = target.split('?')[0]
        if (currentBase === targetBase) return true

        // On Google Search results (not Maps place) → not on target
        if (current.includes('/search') && !current.includes('/maps')) return false

        // Still on a Maps place page → check if same place (by comparing the path before query params)
        if (current.includes('/maps/place/') && target.includes('/maps/place/')) {
            // Extract the place path segment (e.g. /maps/place/KAFF+...)
            const currentPlace = current.split('/maps/place/')[1]?.split('?')[0]?.split('/')[0] || ''
            const targetPlace = target.split('/maps/place/')[1]?.split('?')[0]?.split('/')[0] || ''
            if (currentPlace && targetPlace && currentPlace === targetPlace) return true
        }

        // Accept if it's a Maps URL and we haven't drifted to a different page type
        if (this.isGoogleMapsUrl(current) && !current.includes('/dir') && !current.includes('/search')) {
            return true
        }

        return false
    }

    private async isCaptchaLikePage(page: Page): Promise<boolean> {
        if (page.isClosed()) {
            return false
        }

        const currentUrl = page.url().toLowerCase()
        if (
            currentUrl.includes('google.com/sorry')
            || currentUrl.includes('/sorry/index')
            || currentUrl.includes('ipv4.google.com/sorry')
            || currentUrl.includes('recaptcha')
        ) {
            return true
        }

        const hasRecaptchaFrame = await page.locator('iframe[src*="recaptcha"], div.g-recaptcha').count().catch(() => 0)
        if (hasRecaptchaFrame > 0) {
            return true
        }

        try {
            const textSnapshot = await page.evaluate(() => {
                const bodyText = (document.body?.innerText || '').toLowerCase().slice(0, 5000)
                const titleText = (document.title || '').toLowerCase()
                return `${titleText}\n${bodyText}`
            })

            if (
                textSnapshot.includes("i'm not a robot")
                || textSnapshot.includes('unusual traffic')
                || textSnapshot.includes('our systems have detected unusual traffic')
                || textSnapshot.includes('toi khong phai la nguoi may')
                || textSnapshot.includes('captcha')
            ) {
                return true
            }
        } catch {
            // Ignore evaluation errors.
        }

        return false
    }

    private isExternalNavigationCandidate(summary?: ObservedElementSummary): boolean {
        if (!summary) {
            return false
        }

        const text = this.summaryText(summary)
        const href = this.normalizedText(summary.href)
        if (/(website|trang web|order|booking|reservation|call|go to site|external)/i.test(text)) {
            return true
        }

        if (!href) {
            return false
        }

        if (href.startsWith('#') || href.startsWith('/maps') || href.startsWith('javascript:')) {
            return false
        }

        if (href.includes('google.') || href.includes('g.co')) {
            return false
        }

        return /^https?:\/\//i.test(summary.href || '')
    }

    private rememberRecentIntent(history: FollowUpIntent[], intent: FollowUpIntent, maxSize = 10): void {
        history.unshift(intent)
        if (history.length > maxSize) {
            history.length = maxSize
        }
    }

    private pickDiversifiedIntent(inferredIntent: FollowUpIntent, intentHistory: FollowUpIntent[]): FollowUpIntent {
        if (inferredIntent === 'generic') {
            // Removed 'directions' — it navigates to /dir/ page and causes flickering
            const weighted: FollowUpIntent[] = ['map', 'reviews', 'photos', 'info', 'map', 'generic']
            return weighted[this.randomInt(0, weighted.length - 1)]
        }

        // Redirect directions intent to info (safer)
        if (inferredIntent === 'directions') {
            inferredIntent = 'info'
        }

        const sameRecent = intentHistory.slice(0, 2).every(value => value === inferredIntent)
        if (!sameRecent) {
            return inferredIntent
        }

        // Removed 'directions' from alternatives
        const alternatives: FollowUpIntent[] = ['map', 'reviews', 'photos', 'info']
            .filter(value => value !== inferredIntent) as FollowUpIntent[]

        return alternatives[this.randomInt(0, alternatives.length - 1)]
    }

    private async ensureTargetMapContext(
        page: Page,
        targetMapUrl: string,
        threadId: number
    ): Promise<string[]> {
        const recoveryActions: string[] = []
        const currentUrl = page.url()

        // Use the strict check: are we still on the same target place?
        if (this.isStillOnTargetPlace(currentUrl, targetMapUrl)) {
            return recoveryActions
        }

        // Limit context recoveries to avoid "goBack loop" that looks like random clicking
        if (this.contextRecoveryCount >= this.MAX_CONTEXT_RECOVERIES) {
            this.log(`T${threadId}: Max context recoveries (${this.MAX_CONTEXT_RECOVERIES}) reached. Navigating directly to target.`)
            await page.goto(targetMapUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { })
            await this.delay(1000, 1800)
            recoveryActions.push('context_direct_navigate')
            this.contextRecoveryCount = 0 // Reset after direct navigation
            return recoveryActions
        }

        this.contextRecoveryCount++
        this.log(`T${threadId}: Context recovery ${this.contextRecoveryCount}/${this.MAX_CONTEXT_RECOVERIES} — drifted to (${currentUrl.substring(0, 80)})`)
        
        // Try goBack first
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { })
        await this.delay(700, 1300)

        // Check if goBack brought us back to the target
        if (!this.isStillOnTargetPlace(page.url(), targetMapUrl)) {
            // goBack didn't help, navigate directly to the target
            this.log(`T${threadId}: goBack did not return to target. Navigating directly.`)
            await page.goto(targetMapUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { })
            await this.delay(1000, 1800)
            recoveryActions.push('context_return_to_target_map')
        } else {
            recoveryActions.push('context_back_to_maps')
        }

        await page.keyboard.press('Escape').catch(() => { })
        await this.delay(180, 320)
        return recoveryActions
    }

    private inferPostClickIntent(summary?: ObservedElementSummary): FollowUpIntent {
        const text = this.summaryText(summary)
        if (!text) return 'generic'

        if (/(photo|image|anh|hinh|gallery|album|360|street view)/i.test(text)) {
            return 'photos'
        }

        if (/(review|danh gia|nhan xet|local guide|contributor|ho so nguoi danh gia)/i.test(text)) {
            return 'reviews'
        }

        if (/(direction|route|chi duong|duong di|driving|walking|transit|cycling)/i.test(text)) {
            return 'directions'
        }

        if (/(about|gioi thieu|thong tin|hours|open|close|website|menu|price|amenit|san pham|services|dich vu)/i.test(text)) {
            return 'info'
        }

        if (/(map|ban do|terrain|satellite|fullscreen|measure)/i.test(text)) {
            return 'map'
        }

        return 'generic'
    }

    private async clickRandomVisibleFromSelectors(
        page: Page,
        selectors: string[],
        threadId: number,
        reason: string
    ): Promise<boolean> {
        for (const selector of selectors) {
            const locator = page.locator(selector)
            const count = Math.min(await locator.count().catch(() => 0), 10)
            if (count <= 0) {
                continue
            }

            const order = Array.from({ length: count }, (_, index) => index)
                .sort(() => Math.random() - 0.5)

            for (const idx of order) {
                const candidate = locator.nth(idx)
                const visible = await candidate.isVisible({ timeout: 700 }).catch(() => false)
                if (!visible) {
                    continue
                }

                try {
                    await candidate.scrollIntoViewIfNeeded().catch(() => {})
                    await this.delay(120, 260)
                    await candidate.click({ timeout: 2000 }).catch(async () => {
                        await candidate.click({ timeout: 2000, force: true })
                    })
                    this.log(`T${threadId}: Context click succeeded (${reason}) via selector: ${selector}`)
                    return true
                } catch (error: unknown) {
                    this.log(`T${threadId}: Context click failed (${reason}) on selector ${selector}: ${this.formatError(error)}`)
                }
            }
        }

        return false
    }

    private async runMapZoomPanFollowUp(page: Page, threadId: number): Promise<string[]> {
        const results: string[] = []
        const mapArea = page.locator('div[aria-label*="Map"], div.widget-scene-canvas, canvas').first()
        const visible = await mapArea.isVisible({ timeout: 1000 }).catch(() => false)
        if (!visible) {
            return []
        }

        const box = await mapArea.boundingBox().catch(() => null)
        if (!box) {
            return []
        }

        const centerX = box.x + box.width / 2
        const centerY = box.y + box.height / 2
        await moveCursor(page, centerX, centerY)
        await page.mouse.move(centerX, centerY).catch(() => {})
        await this.delay(120, 280)

        // Perform multiple map cycles to look more like real map exploration.
        const cycles = this.randomInt(2, 4)
        for (let index = 0; index < cycles; index++) {
            const zoomDirection: 'in' | 'out' = Math.random() > 0.4 ? 'in' : 'out'
            const zoomDelta = zoomDirection === 'in'
                ? -this.randomInt(180, 340)
                : this.randomInt(160, 320)

            await page.mouse.wheel(0, zoomDelta).catch(() => {})
            results.push(`map_zoom_${zoomDirection}`)
            await this.delay(220, 540)

            const startX = centerX + this.randomInt(-80, 80)
            const startY = centerY + this.randomInt(-70, 70)
            const moveX = startX + this.randomInt(-220, 220)
            const moveY = startY + this.randomInt(-180, 180)

            await moveCursor(page, startX, startY)
            await page.mouse.move(startX, startY).catch(() => {})
            await page.mouse.down().catch(() => {})
            await page.mouse.move(moveX, moveY, { steps: this.randomInt(9, 16) }).catch(() => {})
            await page.mouse.up().catch(() => {})
            results.push('map_pan_explore')
            await this.delay(260, 620)
        }

        // NOTE: Removed "Nearby" / "Similar" clicking — it navigates away from the target place
        // and causes the bot to get stuck on search results pages, triggering flickering.

        this.log(`T${threadId}: Performed diversified map follow-up with ${results.length} actions.`)
        return results
    }

    private async runPhotoFollowUp(page: Page, threadId: number): Promise<string[]> {
        const results: string[] = []

        // Open a photo if viewer is not active yet.
        const openedPhoto = await this.clickRandomVisibleFromSelectors(page, [
            'button[data-tab-id="photos"]',
            'button:has-text("Photos")',
            'button:has-text("Anh")',
            'a[data-photo-index]',
            'button[data-photo-index]',
            'img[src*="googleusercontent"]',
            'div[role="img"]'
        ], threadId, 'photo_open')
        if (openedPhoto) {
            results.push('photo_open')
            await this.delay(900, 1500)
        }

        const image = page.locator('div[role="dialog"] img, img[src*="googleusercontent"], img[src*="gstatic"]').first()
        const imageVisible = await image.isVisible({ timeout: 1200 }).catch(() => false)
        if (imageVisible) {
            const box = await image.boundingBox().catch(() => null)
            if (box) {
                const x = box.x + box.width / 2
                const y = box.y + box.height / 2
                await page.mouse.move(x, y).catch(() => {})
                await this.delay(120, 260)
                await page.mouse.wheel(0, -300).catch(() => {})
                await page.mouse.wheel(0, -220).catch(() => {})
                results.push('photo_zoom_in')
                await this.delay(220, 420)

                await page.mouse.down().catch(() => {})
                await page.mouse.move(
                    x + this.randomInt(-120, 120),
                    y + this.randomInt(-90, 90),
                    { steps: this.randomInt(7, 12) }
                ).catch(() => {})
                await page.mouse.up().catch(() => {})
                results.push('photo_pan')
                await this.delay(220, 420)

                await this.clickRandomVisibleFromSelectors(page, [
                    'button[aria-label*="Next"]',
                    'button[jsaction*="forward"]',
                    'button:has-text("Next")'
                ], threadId, 'photo_next')
                results.push('photo_next_or_browse')

                await page.mouse.wheel(0, 280).catch(() => {})
                results.push('photo_zoom_out')
            }
        }

        const closed = await this.clickRandomVisibleFromSelectors(page, [
            'button[aria-label*="Close"]',
            'button:has-text("Close")',
            'button:has-text("Dong")',
            'button:has-text("Xong")'
        ], threadId, 'photo_close')
        if (!closed) {
            await page.keyboard.press('Escape').catch(() => {})
        }

        return results
    }

    private async runReviewFollowUp(page: Page, threadId: number): Promise<string[]> {
        const results: string[] = []

        const openedReviews = await this.clickRandomVisibleFromSelectors(page, [
            'button[data-tab-id="reviews"]',
            'button:has-text("Reviews")',
            'button:has-text("Danh gia")',
            'button:has-text("Danh Gia")'
        ], threadId, 'reviews_open')
        if (openedReviews) {
            results.push('reviews_open')
            await this.delay(800, 1400)
        }

        const scrollTimes = this.randomInt(3, 7)
        for (let i = 0; i < scrollTimes; i++) {
            await DOMUtils.scrollObservedPage(page, 'down')
            await this.delay(420, 880)
        }
        results.push('reviews_scroll')

        await this.clickRandomVisibleFromSelectors(page, [
            'button:has-text("More")',
            'button:has-text("Them")',
            'button[aria-label*="more"]'
        ], threadId, 'reviews_expand')
        results.push('reviews_expand')

        // Sometimes open reviewer profile then come back.
        if (Math.random() > 0.35) {
            const openedProfile = await this.clickRandomVisibleFromSelectors(page, [
                'a[href*="/maps/contrib/"]',
                'a[href*="/contrib/"]',
                'button[aria-label*="contributor"]',
                'button[aria-label*="profile"]'
            ], threadId, 'review_profile_open')
            if (openedProfile) {
                results.push('review_profile_open')
                await this.delay(1800, 3200)
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 9000 }).catch(async () => {
                    await page.keyboard.press('Escape').catch(() => {})
                })
                await this.delay(800, 1400)
                results.push('review_profile_back')
            }
        }

        return results
    }

    private async runDirectionsFollowUp(page: Page, threadId: number): Promise<string[]> {
        // DISABLED: Directions follow-up navigates to /maps/dir/ which has a completely
        // different DOM layout. The bot then clicks random elements and causes flickering.
        // Instead, redirect to a safe info follow-up.
        this.log(`T${threadId}: Directions follow-up redirected to info reading (safer action).`)
        return await this.runInfoFollowUp(page, threadId)
    }

    private async runInfoFollowUp(page: Page, threadId: number): Promise<string[]> {
        const results: string[] = []
        const steps = [
            {
                label: 'info_hours',
                selectors: ['button[aria-label*="hours"]', 'div[data-section-id="hours"]', 'button:has-text("Open"), button:has-text("Closed")']
            },
            {
                label: 'info_about',
                selectors: ['button[data-tab-id="about"]', 'button:has-text("About")', 'button:has-text("Gioi thieu")']
            },
            {
                label: 'info_products',
                selectors: ['button:has-text("Products")', 'button:has-text("San pham")', 'a:has-text("Menu")', 'a[data-item-id*="menu"]']
            },
            {
                label: 'info_website',
                selectors: ['a[data-item-id="authority"]', 'a[aria-label*="website"]', 'a:has-text("Website")']
            }
        ].sort(() => Math.random() - 0.5)

        const currentUrl = page.url()
        const maxInfoActions = this.randomInt(2, 3)

        for (const step of steps.slice(0, maxInfoActions)) {
            const clicked = await this.clickRandomVisibleFromSelectors(page, step.selectors, threadId, step.label)
            if (!clicked) {
                continue
            }

            results.push(step.label)
            await this.delay(900, 1700)
            await DOMUtils.scrollObservedPage(page, Math.random() > 0.75 ? 'up' : 'down')
            await this.delay(500, 980)

            // If info action moved away from the place page, return back.
            if (page.url() !== currentUrl && !this.isStillOnTargetPlace(page.url(), currentUrl)) {
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 9000 }).catch(async () => {
                    await page.keyboard.press('Escape').catch(() => {})
                })
                await this.delay(700, 1300)
                results.push(`${step.label}_back`)
            }
        }

        return results
    }

    private async runWebsiteFollowUp(page: Page, threadId: number): Promise<string[]> {
        const results: string[] = []
        
        // Find the website link
        const selectors = ['a[data-item-id="authority"]', 'a[aria-label*="website" i]', 'a:has-text("Website")']
        let targetElement = null
        for (const sel of selectors) {
            const locator = page.locator(sel).first()
            if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
                targetElement = locator
                break
            }
        }

        if (!targetElement) {
            this.log(`T${threadId}: No website button found. Doing normal info read instead.`)
            return this.runInfoFollowUp(page, threadId)
        }

        this.log(`T${threadId}: Clicking website link...`)
        
        // Website clicks on Maps open in a new tab (popup). We MUST capture it.
        const newPagePromise = page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null)
        
        try {
            await targetElement.scrollIntoViewIfNeeded().catch(() => {})
            await this.delay(300, 600)
            await targetElement.click({ timeout: 3000 })
            results.push('website_click')
        } catch (e) {
            this.log(`T${threadId}: Failed to click website: ${e}`)
            return results
        }

        // Wait for the popup
        const newPage = await newPagePromise
        
        if (newPage) {
            this.log(`T${threadId}: Successfully captured new website tab: ${newPage.url()}`)
            results.push('website_popup_handled')
            try {
                // Wait for the page to load sufficiently
                await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
                
                // Pretend to be a human reading the website organically for 15-30s
                // This ensures google analytics captures it and Dwell Time > 10s (engaged session)
                this.log(`T${threadId}: Starting organic browse on new website tab...`)
                const scrollCount = this.randomInt(6, 12)
                for (let i = 0; i < scrollCount; i++) {
                    await DOMUtils.scrollObservedPage(newPage as Page, 'down').catch(() => {})
                    await this.delay(2000, 4000)
                    
                    if (Math.random() > 0.7) {
                        await DOMUtils.scrollObservedPage(newPage as Page, 'up').catch(() => {})
                        await this.delay(1000, 2500)
                    }
                }
                
                results.push('website_organic_browse')
            } catch (err) {
                this.log(`T${threadId}: Error during external website browse: ${err}`)
            } finally {
                // Always ensure the new tab is closed so it doesn't leak memory
                if (!newPage.isClosed()) {
                    await newPage.close().catch(() => {})
                }
                // Bring Maps back to focus
                await page.bringToFront().catch(() => {})
                this.log(`T${threadId}: Closed website tab, returning to Maps.`)
            }
        } else {
            // It didn't open a new tab, maybe navigation in same tab or failed?
            this.log(`T${threadId}: No new tab detected. Likely failed or same-page nav.`)
            await this.delay(4000, 7000)
            if (!this.isStillOnTargetPlace(page.url(), page.url())) {
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 9000 }).catch(() => {})
            }
        }
        
        return results
    }

    private async runPostClickFollowUp(
        page: Page,
        threadId: number,
        summary: ObservedElementSummary | undefined,
        onStatusUpdate: (msg: string) => void,
        followUpIntentHistory: FollowUpIntent[]
    ): Promise<AgenticPerformedAction[]> {
        if (!summary) {
            return []
        }

        // Not every click needs deep follow-up; keep behavior natural.
        if (Math.random() < 0.12) {
            return []
        }

        const inferredIntent = this.inferPostClickIntent(summary)
        const intent = this.pickDiversifiedIntent(inferredIntent, followUpIntentHistory)
        this.rememberRecentIntent(followUpIntentHistory, intent)
        const actionResults: string[] = []
        this.log(`T${threadId}: Running contextual follow-up for intent=${intent} (inferred=${inferredIntent})`)

        try {
            if (intent === 'photos') {
                onStatusUpdate('AI: exploring photo viewer (zoom/pan)')
                actionResults.push(...await this.runPhotoFollowUp(page, threadId))
            } else if (intent === 'reviews') {
                onStatusUpdate('AI: reading several reviews and profiles')
                actionResults.push(...await this.runReviewFollowUp(page, threadId))
            } else if (intent === 'directions') {
                onStatusUpdate('AI: checking directions and route details')
                actionResults.push(...await this.runDirectionsFollowUp(page, threadId))
            } else if (intent === 'info') {
                onStatusUpdate('AI: exploring place information sections')
                actionResults.push(...await this.runInfoFollowUp(page, threadId))
            } else if (intent === 'map' || intent === 'generic') {
                onStatusUpdate('AI: doing map zoom/pan exploration')
                actionResults.push(...await this.runMapZoomPanFollowUp(page, threadId))
            }

            // Keep focus around target map after any intent.
            if (intent !== 'map' && Math.random() > 0.35) {
                actionResults.push(...await this.runMapZoomPanFollowUp(page, threadId))
            }
        } catch (error: unknown) {
            const followupError = this.formatError(error)
            this.log(`T${threadId}: Contextual follow-up failed: ${followupError}`)
            return [{ action: 'context_followup_error', success: false, source: 'context', error: followupError }]
        } finally {
            await this.cleanupExtraTabs(page, threadId, `post_click_followup_${intent}`)
        }

        if (actionResults.length === 0) {
            return []
        }

        return actionResults.map(action => ({
            action: `context_${action}`,
            success: true,
            source: 'context',
            detail: action,
        }))
    }

    private resolveFallbackDecision(
        domSnapshot: ExtractedInteractiveDOM,
        stepCount: number,
        targetSteps: number,
        threadId: number,
        reason: string,
        locationName: string,
        excludedElementIds: Set<number> = new Set()
    ): AgentDecisionResult {
        const fallbackAction = pickTrafficFallbackAction(domSnapshot.summaries, stepCount, targetSteps, excludedElementIds, locationName)
        this.log(`T${threadId}: Using heuristic fallback because ${reason}. Selected ${fallbackAction.action}${fallbackAction.action === 'click' ? `:${fallbackAction.element_id}` : ''}`)

        return {
            actionData: fallbackAction,
            source: 'heuristic',
        }
    }

    private normalizeDecisionSafety(
        decision: AgentDecisionResult,
        domSnapshot: ExtractedInteractiveDOM,
        threadId: number,
        stepCount: number,
        targetSteps: number,
        locationName: string,
        excludedElementIds: Set<number>,
        blockedFingerprints: Set<string>,
        recentFingerprints: string[],
        fingerprintById: Map<number, string>
    ): AgentDecisionResult {
        const action = decision.actionData
        if (action.action !== 'click' || action.element_id === undefined) {
            return decision
        }

        if (excludedElementIds.has(action.element_id)) {
            this.log(`T${threadId}: Rejected excluded click target element ${action.element_id}`)
            excludedElementIds.add(action.element_id)
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `excluded_target:${action.element_id}`, locationName, excludedElementIds)
        }

        const summary = this.getSummaryById(domSnapshot.summaries, action.element_id)
        if (!summary) {
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `missing_summary:${action.element_id}`, locationName, excludedElementIds)
        }

        const fingerprint = fingerprintById.get(action.element_id)
        if (fingerprint && blockedFingerprints.has(fingerprint)) {
            excludedElementIds.add(action.element_id)
            this.log(`T${threadId}: Rejected blocked fingerprint target ${fingerprint}`)
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `blocked_fingerprint:${action.element_id}`, locationName, excludedElementIds)
        }

        if (fingerprint && recentFingerprints.includes(fingerprint)) {
            excludedElementIds.add(action.element_id)
            this.log(`T${threadId}: Rejected recent fingerprint target ${fingerprint}`)
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `recent_target:${action.element_id}`, locationName, excludedElementIds)
        }

        if (this.isExternalNavigationCandidate(summary)) {
            excludedElementIds.add(action.element_id)
            this.log(`T${threadId}: Rejected external navigation target ${action.element_id}`)
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `external_target:${action.element_id}`, locationName, excludedElementIds)
        }

        if (!isMapTargetRelevantElement(summary, locationName)) {
            excludedElementIds.add(action.element_id)
            this.log(`T${threadId}: Rejected off-target click target ${action.element_id}`)
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `off_target:${action.element_id}`, locationName, excludedElementIds)
        }

        if (isUnsafeTrafficElement(summary)) {
            this.log(`T${threadId}: Rejected unsafe click target element ${action.element_id} (${summary.tagName})`)
            excludedElementIds.add(action.element_id)
            return this.resolveFallbackDecision(domSnapshot, stepCount, targetSteps, threadId, `unsafe_target:${action.element_id}`, locationName, excludedElementIds)
        }

        return decision
    }

    /**
     * Execute a single planned action from the LLM plan.
     */
    private async executePlannedAction(
        page: Page,
        action: string,
        threadId: number
    ): Promise<string[]> {
        switch (action) {
            case 'view_photos':
                return this.runPhotoFollowUp(page, threadId)
            case 'scroll_reviews':
                return this.runReviewFollowUp(page, threadId)
            case 'read_info':
                return this.runInfoFollowUp(page, threadId)
            case 'browse_website':
                return this.runWebsiteFollowUp(page, threadId)
            case 'check_directions':
                return this.runInfoFollowUp(page, threadId)
            case 'pan_map':
            case 'map':
            case 'generic':
                return this.runMapZoomPanFollowUp(page, threadId)
            case 'scroll_down':
                await DOMUtils.scrollObservedPage(page, 'down')
                await this.delay(800, 1500)
                return ['scroll_down']
            case 'scroll_up':
                await DOMUtils.scrollObservedPage(page, 'up')
                await this.delay(800, 1500)
                return ['scroll_up']
            case 'wait':
                await this.delay(2000, 4000)
                return ['wait']
            default:
                this.log(`T${threadId}: Unknown action in plan: ${action}, doing generic map pan.`)
                return this.runMapZoomPanFollowUp(page, threadId)
        }
    }

    /**
     * Execute a single step from the plan with full context recovery, captcha check,
     * and error handling.
     */
    private async executeStepWithSafety(
        page: Page,
        action: string,
        actionDelaySec: number,
        stepIndex: number,
        totalSteps: number,
        threadId: number,
        targetMapUrl: string,
        actionsPerformed: AgenticPerformedAction[],
        onStatusUpdate: (msg: string) => void,
        shouldStopCheck: () => boolean
    ): Promise<'ok' | 'stop' | 'captcha'> {
        if (shouldStopCheck()) {
            this.log(`T${threadId}: Stop requested during plan execution.`)
            return 'stop'
        }

        this.log(`T${threadId}: Executing planned action ${stepIndex + 1}/${totalSteps}: ${action} (delay: ${actionDelaySec}s)`)
        onStatusUpdate(`Executing (${stepIndex + 1}/${totalSteps}): ${action} ~${actionDelaySec}s`)

        // Context recovery
        const contextRecoveryActions = await this.ensureTargetMapContext(page, targetMapUrl, threadId)
        for (const recoveryAction of contextRecoveryActions) {
            this.pushAction(actionsPerformed, {
                action: `runtime_${recoveryAction}`,
                success: true,
                source: 'runtime',
                detail: recoveryAction,
                step: stepIndex + 1,
            })
        }

        // Captcha check
        if (await this.isCaptchaLikePage(page)) {
            this.log(`T${threadId}: CAPTCHA detected during plan execution.`)
            onStatusUpdate('CAPTCHA detected. Waiting for manual solve...')
            this.pushAction(actionsPerformed, {
                action: 'captcha_detected',
                success: false,
                source: 'safety',
                detail: 'Google CAPTCHA/sorry page detected',
                step: stepIndex + 1,
            })
            return 'captcha'
        }

        try {
            const executedSubActions = await this.executePlannedAction(page, action, threadId)
            this.pushAction(actionsPerformed, {
                action: `execute_${action}`,
                success: true,
                source: 'llm',
                detail: `Sub-actions: ${executedSubActions.join(', ')}`,
                step: stepIndex + 1,
            })
        } catch (err) {
            const errorMsg = this.formatError(err)
            this.log(`T${threadId}: Error executing ${action}: ${errorMsg}`)
            this.pushAction(actionsPerformed, {
                action: `error_${action}`,
                success: false,
                source: 'runtime',
                error: errorMsg,
                step: stepIndex + 1,
            })
            const overlayRecovery = await this.recoverFromUnexpectedOverlay(page, threadId, { useEscapeFallback: true })
            if (overlayRecovery.handled) {
                onStatusUpdate(`Recovered popup after ${action} error (${overlayRecovery.via || 'escape'})`)
                await this.delay(500, 1000, 'transition')
            }
        }

        await this.cleanupExtraTabs(page, threadId, `step_${stepIndex}_${action}`)
        // Natural delay with ±20% jitter
        const jitterMin = Math.floor(actionDelaySec * 1000 * 0.8)
        const jitterMax = Math.ceil(actionDelaySec * 1000 * 1.2)
        await this.delay(jitterMin, jitterMax)
        return 'ok'
    }

    async performBrowsing(
        page: Page,
        locationName: string,
        maxSteps: number,
        threadId: number,
        onStatusUpdate: (msg: string) => void,
        shouldStopCheck: () => boolean,
        targetKpi?: string,
        delayRange?: [number, number]
    ): Promise<{ actionsPerformed: AgenticPerformedAction[] }> {
        const actionsPerformed: AgenticPerformedAction[] = []
        const minDelaySec = delayRange?.[0] ?? 3
        const maxDelaySec = delayRange?.[1] ?? 15
        try {
            const hasKpiTarget = !!targetKpi && targetKpi !== 'none'
            this.log(`T${threadId}: Agentic Planner starting for ${locationName}, planning ~${maxSteps} actions. Target KPI: ${targetKpi || 'None'}, Delay: ${minDelaySec}-${maxDelaySec}s`)

            const requestedSteps = Number.isFinite(maxSteps) ? Math.max(1, Math.floor(maxSteps)) : this.MAX_STEPS
            const planSize = Math.max(2, Math.min(15, requestedSteps))
            const targetMapUrl = page.url()
            
            // Reset context recovery counter for this browsing session
            this.contextRecoveryCount = 0

            await this.preparePage(page, threadId)
            
            // 1. Scrape Context
            onStatusUpdate('AI scraping map context...')
            const domSnapshot = await DOMUtils.extractInteractiveDOM(page)
            const { domText } = domSnapshot
            
            // 2. Generate Plan with LLM
            onStatusUpdate('AI synthesizing execution plan...')
            
            // When we have a KPI target, instruct LLM to focus on warm-up/cool-down actions
            // (the actual KPI action will be injected deterministically)
            const kpiPlanHint = hasKpiTarget
                ? `\nIMPORTANT: The system will AUTOMATICALLY handle the "${targetKpi}" action via a dedicated skill.
Your plan should focus on ORGANIC warm-up actions BEFORE and cool-down actions AFTER the main KPI action.
Do NOT include "browse_website", "check_directions" or phone-related actions — they will be handled separately.
Focus on: scroll_down, scroll_up, view_photos, scroll_reviews, read_info, pan_map, wait.\n`
                : ''

            const systemPrompt = `You are an expert autonomous web automation agent simulating an organic human user exploring Google Maps.
Current target: "${locationName}"
Current URL: ${targetMapUrl}
${kpiPlanHint}
Visible Interactive Context on Screen:
${domText.substring(0, 4000)}

Your task is to create a realistic sequence of actions to explore this specific place.
IMPORTANT ANTI-BOT RULES:
- Google filters sessions shorter than 30 seconds as bot traffic. Your total session MUST be at least 45 seconds.
- Each action needs a realistic "delay_seconds" (how long to spend on that action BEFORE moving to the next).
- The user configured allowed delay range: minimum ${minDelaySec}s, maximum ${maxDelaySec}s per action.
- For "browse_website", ALWAYS set delay_seconds to at least 15 (Google Analytics requires 10s+ to count as engaged session).
- For "scroll_reviews" or "view_photos", set delay_seconds between 5-15 (people spend time reading/viewing).
- For "scroll_down", "scroll_up", "pan_map", set delay_seconds between ${minDelaySec}-8.
- For "wait", set delay_seconds between 2-6.

Rules:
1. Respond ONLY with a valid JSON object. No markdown, no extra text.
2. The JSON MUST BE STRICTLY in this format:
{
  "thought": "Reasoning for the plan based on the place type",
  "actions": [
    { "action": "scroll_down", "delay_seconds": 4 },
    { "action": "view_photos", "delay_seconds": 10 },
    { "action": "browse_website", "delay_seconds": 20 }
  ]
}
3. The "actions" array must contain between 3 and ${planSize} action objects.
4. Allowed action names: "view_photos", "scroll_reviews", "read_info", "pan_map", "scroll_down", "scroll_up", "wait", "browse_website".
5. The sequence should simulate a real human. E.g., for a restaurant, view photos then reviews. For a service, read info then website.
6. Make it somewhat randomized but logical. DO NOT use action names not in the allowed list.
7. Each action object MUST have both "action" (string) and "delay_seconds" (number) fields.`

            const llmStartedAt = Date.now()
            const llmResult = await ollamaService.chat(
                'Generate a logical JSON action plan for this map location. Output JSON ONLY.',
                systemPrompt,
                true,
                this.LLM_TIMEOUT_MS
            )
            const llmElapsedMs = Date.now() - llmStartedAt
            this.log(`T${threadId}: LLM Planner completed in ${llmElapsedMs}ms.`)

            interface PlannedAction { action: string; delay_seconds: number }
            let planObj: { thought: string, actions: PlannedAction[] } | null = null;
            if (llmResult.success && llmResult.response) {
                try {
                     let cleanJson = llmResult.response.trim()
                     if (cleanJson.startsWith('```json')) cleanJson = cleanJson.substring(7)
                     if (cleanJson.startsWith('```')) cleanJson = cleanJson.substring(3)
                     if (cleanJson.endsWith('```')) cleanJson = cleanJson.substring(0, cleanJson.length - 3)
                     cleanJson = cleanJson.trim()
                     const rawPlan = JSON.parse(cleanJson)
                     
                     // Normalize: support both old string[] format and new {action, delay_seconds}[] format
                     if (rawPlan && Array.isArray(rawPlan.actions)) {
                         const normalizedActions: PlannedAction[] = rawPlan.actions.map((a: any) => {
                             if (typeof a === 'string') {
                                 const defaultDelay = a === 'browse_website' ? 20 : this.randomInt(minDelaySec, maxDelaySec)
                                 return { action: a, delay_seconds: defaultDelay }
                             }
                             return {
                                 action: String(a.action || 'wait'),
                                 delay_seconds: Number(a.delay_seconds) || this.randomInt(minDelaySec, maxDelaySec)
                             }
                         })
                         planObj = { thought: rawPlan.thought || '', actions: normalizedActions }
                     }
                } catch(e) {
                     this.log(`T${threadId}: LLM Parse Error: ` + this.formatError(e))
                }
            } else {
                 this.log(`T${threadId}: LLM Error: ${llmResult.error}`)
                 onStatusUpdate(`AI Error: ${this.sanitizeForStatus(llmResult.error || 'no response')}`)
            }
            
            if (!planObj || !Array.isArray(planObj.actions) || planObj.actions.length === 0) {
                this.log(`T${threadId}: Failed to parse LLM plan or empty plan, using heuristic fallback...`)
                onStatusUpdate('AI plan failed -> using heuristic sequence')
                planObj = {
                    thought: "Fallback execution plan due to error",
                    actions: [
                        { action: 'pan_map', delay_seconds: 5 },
                        { action: 'read_info', delay_seconds: 8 },
                        { action: 'scroll_reviews', delay_seconds: 10 },
                        { action: 'view_photos', delay_seconds: 8 }
                    ]
                }
            }
            
            const totalPlannedDelay = planObj.actions.reduce((s, a) => s + a.delay_seconds, 0)
            this.log(`T${threadId}: Plan generated: Thought=${planObj.thought}, Actions=${JSON.stringify(planObj.actions)}, EstimatedDuration=${totalPlannedDelay}s`)
            onStatusUpdate(`AI Plan: ${this.sanitizeForStatus(planObj.thought, 80)} (~${totalPlannedDelay}s)`)
            await this.delay(1000, 2000)
            
            // ===================================================================
            // 3. EXECUTE WITH KPI ENFORCEMENT
            // ===================================================================
            if (hasKpiTarget) {
                // ---- Phase 1: WARM-UP (2-4 organic actions before KPI) ----
                const warmUpCount = Math.min(this.randomInt(2, 4), planObj.actions.length)
                this.log(`T${threadId}: [KPI MODE] Phase 1: Warm-up with ${warmUpCount} organic actions`)
                onStatusUpdate(`🎯 KPI Mode: Warm-up (${warmUpCount} actions)...`)

                for (let i = 0; i < warmUpCount; i++) {
                    const plannedAction = planObj.actions[i]
                    const result = await this.executeStepWithSafety(
                        page, plannedAction.action, plannedAction.delay_seconds,
                        i, planObj.actions.length, threadId, targetMapUrl,
                        actionsPerformed, onStatusUpdate, shouldStopCheck
                    )
                    if (result !== 'ok') break
                }

                // ---- Phase 2: KPI SKILL EXECUTION (deterministic) ----
                if (!shouldStopCheck()) {
                    this.log(`T${threadId}: [KPI MODE] Phase 2: Executing KPI skill -> ${targetKpi}`)
                    onStatusUpdate(`🎯 Executing KPI: ${targetKpi!.toUpperCase()}...`)

                    // Ensure we're on the target page before KPI action
                    await this.ensureTargetMapContext(page, targetMapUrl, threadId)
                    await this.delay(1000, 2000, 'kpi')

                    const kpiResult: KpiSkillResult = await kpiSkills.executeKpi(page, threadId, targetKpi!)

                    this.pushAction(actionsPerformed, {
                        action: `kpi_skill_${targetKpi}`,
                        success: kpiResult.executed,
                        source: 'kpi_skill',
                        detail: kpiResult.detail,
                        durationMs: kpiResult.durationMs,
                    })

                    if (kpiResult.executed && kpiResult.verified) {
                        this.log(`T${threadId}: [KPI MODE] ✅ KPI VERIFIED: ${kpiResult.detail}`)
                        onStatusUpdate(`✅ KPI ${targetKpi!.toUpperCase()} verified!`)
                    } else if (kpiResult.executed && !kpiResult.verified) {
                        this.log(`T${threadId}: [KPI MODE] ⚠️ KPI executed but unverified. Retrying once...`)
                        onStatusUpdate(`⚠️ KPI ${targetKpi!.toUpperCase()} unverified, retrying...`)

                        // Retry once
                        await this.ensureTargetMapContext(page, targetMapUrl, threadId)
                        await this.delay(2000, 4000, 'kpi')
                        const retryResult = await kpiSkills.executeKpi(page, threadId, targetKpi!)

                        this.pushAction(actionsPerformed, {
                            action: `kpi_skill_retry_${targetKpi}`,
                            success: retryResult.executed,
                            source: 'kpi_skill',
                            detail: `Retry: ${retryResult.detail}`,
                            durationMs: retryResult.durationMs,
                        })

                        if (retryResult.verified) {
                            this.log(`T${threadId}: [KPI MODE] ✅ KPI VERIFIED on retry!`)
                            onStatusUpdate(`✅ KPI ${targetKpi!.toUpperCase()} verified on retry!`)
                        } else {
                            this.log(`T${threadId}: [KPI MODE] ❌ KPI still unverified after retry.`)
                            onStatusUpdate(`❌ KPI ${targetKpi!.toUpperCase()} could not be verified`)
                        }
                    } else {
                        this.log(`T${threadId}: [KPI MODE] ❌ KPI skill could not execute: ${kpiResult.detail}`)
                        onStatusUpdate(`❌ KPI ${targetKpi!.toUpperCase()} element not found`)
                    }

                    // Ensure we're back on target page after KPI action
                    await this.ensureTargetMapContext(page, targetMapUrl, threadId)
                    await this.cleanupExtraTabs(page, threadId, 'after_kpi_skill')
                }

                // ---- Phase 3: COOL-DOWN (remaining organic actions) ----
                const coolDownStart = warmUpCount
                const coolDownCount = Math.min(
                    this.randomInt(1, 3),
                    Math.max(0, planObj.actions.length - coolDownStart)
                )
                if (coolDownCount > 0 && !shouldStopCheck()) {
                    this.log(`T${threadId}: [KPI MODE] Phase 3: Cool-down with ${coolDownCount} organic actions`)
                    onStatusUpdate(`🎯 KPI Mode: Cool-down (${coolDownCount} actions)...`)

                    for (let i = 0; i < coolDownCount; i++) {
                        const planIdx = coolDownStart + i
                        if (planIdx >= planObj.actions.length) break
                        const plannedAction = planObj.actions[planIdx]
                        const result = await this.executeStepWithSafety(
                            page, plannedAction.action, plannedAction.delay_seconds,
                            planIdx, planObj.actions.length, threadId, targetMapUrl,
                            actionsPerformed, onStatusUpdate, shouldStopCheck
                        )
                        if (result !== 'ok') break
                    }
                }

            } else {
                // ===================================================================
                // NO KPI TARGET — Execute all planned actions normally
                // ===================================================================
                for (let i = 0; i < planObj.actions.length; i++) {
                    const plannedAction = planObj.actions[i]
                    const result = await this.executeStepWithSafety(
                        page, plannedAction.action, plannedAction.delay_seconds,
                        i, planObj.actions.length, threadId, targetMapUrl,
                        actionsPerformed, onStatusUpdate, shouldStopCheck
                    )
                    if (result !== 'ok') break
                }
            }
            
            this.log(`T${threadId}: Agentic Planner finished execution successfully.`)
            onStatusUpdate(`AI Plan Completed`)
            return { actionsPerformed }
            
        } catch (error) {
            const errorMsg = this.formatError(error)
            this.log(`T${threadId}: Critical Error: ${errorMsg}`)
            this.pushAction(actionsPerformed, { action: 'ai_error', success: false, source: 'runtime', error: errorMsg })
            return { actionsPerformed }
        }
    }
}

export const agenticTrafficHandler = new AgenticTrafficHandler()
