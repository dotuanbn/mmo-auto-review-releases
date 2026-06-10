import { Page } from 'playwright'
import { ollamaService } from '../services/OllamaService'
import { DOMUtils, ObservedElementSummary } from './DOMUtils'
import { miniRagService } from '../services/MiniRagService'
import { RuntimeDecisionSource } from '../runtime/v2/types'

export interface ContextualInterruptionResolveOptions {
    threadId?: number
    reason?: string
    useLlmFallback?: boolean
    llmTimeoutMs?: number
    useEscapeFallback?: boolean
    maxPasses?: number
    goal?: 'map_interaction' | 'review_flow' | 'website_browse' | 'generic'
    campaignType?: 'traffic' | 'review' | 'web_seo' | 'organic' | 'generic'
    campaignId?: number
    domain?: string
    logger?: (msg: string) => void
}

export interface ContextualInterruptionResolveResult {
    handled: boolean
    via?: string
    detail?: string
    latencyMs?: number
    decisionSource?: RuntimeDecisionSource
    ragUsed?: boolean
    ragHitCount?: number
    ragEvidenceIds?: number[]
    decisionLatencyMs?: number
}

type Candidate = {
    summary: ObservedElementSummary
    score: number
    label: string
}

type RagHints = {
    dismissBias: boolean
    avoidPreciseLocation: boolean
}

export class ContextualInterruptionResolver {
    private readonly fallbackSelectors = [
        'button:has-text("Để sau")',
        'button:has-text("De sau")',
        '[role="button"]:has-text("Để sau")',
        '[role="button"]:has-text("De sau")',
        '[role="button"]:has-text("Not now")',
        '[role="button"]:has-text("Later")',
        '[role="button"]:has-text("Skip")',
        'button:has-text("Later")',
        'button:has-text("Not now")',
        'button:has-text("Skip")',
        'button:has-text("Close")',
        'button:has-text("Dismiss")',
        'button:has-text("Cancel")',
        'button:has-text("OK")',
        'button:has-text("Ok")',
        'button:has-text("Got it")',
        'button:has-text("Continue")',
        'button:has-text("Đồng ý")',
        'button:has-text("Đã hiểu")',
        'button:has-text("Tiếp tục")',
        'button:has-text("Đóng")',
        'button:has-text("Dong y")',
        'button:has-text("Da hieu")',
        'button:has-text("Hieu roi")',
        'button:has-text("Tiep tuc")',
        'button:has-text("Dong")',
        '[role="dialog"] [role="button"]',
        '[role="dialog"] button',
    ]

    private log(options: ContextualInterruptionResolveOptions, message: string): void {
        if (options.logger) {
            options.logger(message)
            return
        }

        const tid = options.threadId !== undefined ? `T${options.threadId}` : 'T?'
        console.log(`[ContextResolver] ${tid}: ${message}`)
    }

    private normalizeText(value?: string): string {
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
        return this.normalizeText([
            summary.textContent,
            summary.ariaLabel,
            summary.title,
            summary.placeholder,
            summary.href,
            summary.role,
            summary.tagName,
            summary.type,
        ].filter(Boolean).join(' '))
    }

    private inferRiskType(reason?: string): string {
        const normalizedReason = this.normalizeText(reason)
        if (/captcha|sorry|robot/.test(normalizedReason)) {
            return 'captcha'
        }
        if (/popup|dialog|prompt|modal|overlay/.test(normalizedReason)) {
            return 'popup'
        }
        if (/recover|retry|interrupt/.test(normalizedReason)) {
            return 'recover'
        }
        return 'interruption'
    }

    private safeDomain(raw?: string): string {
        if (!raw) return 'unknown'
        try {
            const url = raw.startsWith('http://') || raw.startsWith('https://')
                ? new URL(raw)
                : new URL(`https://${raw}`)
            return (url.hostname || 'unknown').toLowerCase()
        } catch {
            return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || 'unknown'
        }
    }

    private extractRagHints(context: string): RagHints {
        const normalized = this.normalizeText(context)
        return {
            dismissBias: /(close|dismiss|skip|later|not now|de sau|dong|ok|got it|cancel)/i.test(normalized),
            avoidPreciseLocation: /(use precise location|su dung vi tri chinh xac|always allow|allow location|cho phep vi tri)/i.test(normalized),
        }
    }

    private isLikelyInterruptionSignal(text: string): boolean {
        if (!text) {
            return false
        }

        return /(use precise location|vi tri chinh xac|near your location|cookie|consent|notification|thong bao|posts appear|xuat hien|allow location|allow notifications|cho phep vi tri|cho phep thong bao|login required|sign in to|dang nhap de|privacy reminder|privacy settings)/i.test(text)
    }

    private isDismissOrConsentText(text: string): boolean {
        return /(de sau|later|not now|skip|close|dismiss|cancel|dong|ok|got it|continue|da hieu|hieu roi|done|xong|accept|i agree|dong y|chap nhan|allow once)/i.test(text)
    }

    private isMapActionText(text: string): boolean {
        return /(directions?|direction|chi duong|duong di|route|website|phone|call|goi dien|photo|photos|anh|review|reviews|danh gia|nearby|lan can|save|share|send to phone|menu|booking|reserve|order|shop now|mua ngay)/i.test(text)
    }

    private scoreCandidate(
        summary: ObservedElementSummary,
        goal: ContextualInterruptionResolveOptions['goal'],
        ragHints?: RagHints
    ): number {
        const text = this.summaryText(summary)
        if (!text) {
            return -99
        }

        let score = 0
        if (summary.tagName === 'button' || summary.role === 'button') {
            score += 2
        }
        if (summary.inDialog) {
            score += 7
        }

        if (/(de sau|later|not now|skip|close|dismiss|cancel|dong|ok|got it|continue|da hieu|hieu roi|done|xong)/i.test(text)) {
            score += 8
        }

        if (/(accept|i agree|dong y|chap nhan|allow once)/i.test(text)) {
            score += 3
        }

        if (/(su dung vi tri chinh xac|use precise location|always allow|share location|allow location|cho phep vi tri)/i.test(text)) {
            score -= 8
        }

        if (/(i am not a robot|toi khong phai la nguoi may|captcha|recaptcha)/i.test(text)) {
            score -= 30
        }

        if (/(dang nhap|sign in|login|create account|tao tai khoan|submit|publish|post|upload|share publicly|delete|xoa|remove)/i.test(text)) {
            score -= 12
        }

        if (summary.href && /^https?:\/\//i.test(summary.href)) {
            score -= 4
        }

        if (goal === 'map_interaction') {
            if (this.isMapActionText(text) && !this.isDismissOrConsentText(text)) {
                return -99
            }
        }

        if (goal === 'review_flow') {
            if (/(write a review|viet danh gia|danh gia|review)/i.test(text)) {
                score += 2
            }
            if (/(delete|xoa|remove|report)/i.test(text)) {
                score -= 4
            }
        }

        if (ragHints?.dismissBias && /(de sau|later|not now|skip|close|dismiss|cancel|dong|ok|got it|continue|da hieu|hieu roi)/i.test(text)) {
            score += 2.5
        }

        if (ragHints?.avoidPreciseLocation && /(su dung vi tri chinh xac|use precise location|always allow|allow location|cho phep vi tri)/i.test(text)) {
            score -= 5
        }

        return score
    }

    private async detectSignal(page: Page): Promise<{ hasVisibleDialog: boolean; text: string }> {
        return page.evaluate(() => {
            const dialogEl = document.querySelector('[role="dialog"], [aria-modal="true"], [role="alertdialog"]') as HTMLElement | null
            const rect = dialogEl?.getBoundingClientRect()
            const hasVisibleDialog = !!dialogEl && !!rect && rect.width > 0 && rect.height > 0
            const rawText = (dialogEl?.innerText || document.body?.innerText || '').slice(0, 1800)
            const text = rawText.replace(/\s+/g, ' ').trim()
            return { hasVisibleDialog, text }
        }).catch(() => ({ hasVisibleDialog: false, text: '' }))
    }

    private buildCandidates(
        summaries: ObservedElementSummary[],
        goal: ContextualInterruptionResolveOptions['goal'],
        ragHints?: RagHints
    ): Candidate[] {
        return summaries
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
                score: this.scoreCandidate(summary, goal, ragHints),
                label: this.summaryText(summary).slice(0, 120),
            }))
            .sort((left, right) => right.score - left.score)
    }

    private async clickObservedCandidate(page: Page, elementId: number): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        const count = await locator.count().catch(() => 0)
        if (count === 0) {
            throw new Error(`Candidate ${elementId} not found`)
        }

        await locator.waitFor({ state: 'visible', timeout: 1700 })
        await locator.scrollIntoViewIfNeeded().catch(() => { })
        await locator.click({ timeout: 1500 }).catch(async () => {
            await locator.click({ timeout: 1500, force: true })
        })
    }

    private async tryHandleGoogleLocationPrompt(
        page: Page,
        options: ContextualInterruptionResolveOptions
    ): Promise<ContextualInterruptionResolveResult | null> {
        const startedAt = Date.now()

        // Fast path 1: exact locator attempts for "Để sau"/"Not now" variants
        const preferredSelectors = [
            'button:has-text("Để sau")',
            '[role="button"]:has-text("Để sau")',
            'button:has-text("De sau")',
            '[role="button"]:has-text("De sau")',
            'button:has-text("Not now")',
            '[role="button"]:has-text("Not now")',
            'button:has-text("Later")',
            '[role="button"]:has-text("Later")',
        ]

        for (const selector of preferredSelectors) {
            const locator = page.locator(selector).first()
            const count = await locator.count().catch(() => 0)
            if (count === 0) {
                continue
            }
            try {
                const visible = await locator.isVisible({ timeout: 500 }).catch(() => false)
                if (!visible) {
                    continue
                }
                await locator.click({ timeout: 1400 }).catch(async () => {
                    await locator.click({ timeout: 1400, force: true })
                })
                this.log(options, `Resolved Google location prompt via selector ${selector}`)
                return {
                    handled: true,
                    via: 'google_location_prompt_selector',
                    detail: selector,
                    latencyMs: Date.now() - startedAt,
                    decisionSource: 'heuristic',
                    decisionLatencyMs: Date.now() - startedAt,
                }
            } catch {
                // Try next selector.
            }
        }

        // Fast path 2: DOM-text heuristic fallback (works when nodes are custom divs/spans)
        const domHandled = await page.evaluate(() => {
            const normalize = (value: string): string => value
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .trim()

            const bodyText = normalize((document.body?.innerText || '').slice(0, 6000))
            const hasLocationPrompt = /ban co muon xem ket qua o gan vi tri cua ban hon khong|use precise location|near your location|vi tri chinh xac/.test(bodyText)
            if (!hasLocationPrompt) {
                return { handled: false, detail: '' }
            }

            const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],[tabindex],div,span'))
            const preferred = nodes.filter(node => {
                const text = normalize((node.innerText || node.textContent || '').slice(0, 120))
                if (!text) return false
                if (node.offsetParent === null) return false
                return /de sau|not now|later|skip|close|dismiss/.test(text)
            })

            const target = preferred[0]
            if (!target) {
                return { handled: false, detail: '' }
            }

            target.focus?.()
            target.click?.()
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
            return { handled: true, detail: (target.innerText || target.textContent || '').trim().slice(0, 80) }
        }).catch(() => ({ handled: false, detail: '' }))

        if (domHandled.handled) {
            this.log(options, `Resolved Google location prompt via DOM heuristic (${domHandled.detail || 'unknown'})`)
            return {
                handled: true,
                via: 'google_location_prompt_dom',
                detail: domHandled.detail || 'dom_heuristic',
                latencyMs: Date.now() - startedAt,
                decisionSource: 'heuristic',
                decisionLatencyMs: Date.now() - startedAt,
            }
        }

        return null
    }

    private async tryLlmCandidate(
        candidates: Candidate[],
        signalText: string,
        options: ContextualInterruptionResolveOptions,
        ragContext?: string
    ): Promise<number | null> {
        if (candidates.length === 0) {
            return null
        }

        const compact = candidates
            .slice(0, 6)
            .map(item => `{"id":${item.summary.id},"text":"${(item.label || '').replace(/"/g, '\\"')}","score":${item.score}}`)
            .join('\n')

        const prompt = `A browser interruption is blocking automation.
Visible text: "${signalText.slice(0, 300)}"
Candidates:
${compact}
${ragContext ? `\nRecovered prior evidence:\n${ragContext.slice(0, 1000)}\n` : ''}

Choose the SAFEST and FASTEST action to continue browsing.
Prefer close/skip/later/not now/de sau.
Avoid sign in/upload/submit/precise location allow.

Respond strictly as JSON. No markdown.
{"thought":"brief logical reasoning","element_id":number}`

        const llmResult = await ollamaService.chat(
            'Pick safest interruption action candidate',
            prompt,
            true,
            Math.max(1200, options.llmTimeoutMs || 2800)
        )

        if (!llmResult.success || !llmResult.response) {
            return null
        }

        try {
            const parsed = JSON.parse(llmResult.response.trim())
            const id = Number(parsed?.element_id)
            if (!Number.isFinite(id)) {
                return null
            }
            if (!candidates.some(candidate => candidate.summary.id === id)) {
                return null
            }
            return id
        } catch {
            return null
        }
    }

    async resolve(
        page: Page,
        options: ContextualInterruptionResolveOptions = {}
    ): Promise<ContextualInterruptionResolveResult> {
        const startedAt = Date.now()
        const goal = options.goal || 'generic'
        const campaignType = options.campaignType || 'generic'
        const riskType = this.inferRiskType(options.reason)
        const maxPasses = Math.max(1, Math.min(4, options.maxPasses || 2))
        let resolved = false
        let lastVia: string | undefined
        let lastDetail: string | undefined
        let lastSignalText = ''
        let decisionSource: RuntimeDecisionSource = 'heuristic'
        let ragUsed = false
        let ragHitCount = 0
        let ragEvidenceIds: number[] = []
        let ragContext = ''
        let ragHints: RagHints | undefined
        let sawInterruptionSignal = false

        if (page.isClosed()) {
            return { handled: false, latencyMs: 0 }
        }

        const currentDomain = options.domain || this.safeDomain(page.url())

        const directGooglePrompt = await this.tryHandleGoogleLocationPrompt(page, options)
        if (directGooglePrompt?.handled) {
            void miniRagService.ingest({
                campaignType,
                campaignId: options.campaignId,
                threadId: options.threadId,
                domain: currentDomain,
                goal,
                riskType,
                signalText: 'google location prompt',
                action: 'context_recovered',
                decisionSource: directGooglePrompt.decisionSource || 'heuristic',
                success: true,
                detail: directGooglePrompt.detail || directGooglePrompt.via,
                recoverPath: directGooglePrompt.via,
                latencyMs: directGooglePrompt.latencyMs,
            }).catch(() => { })
            return directGooglePrompt
        }

        for (let pass = 1; pass <= maxPasses; pass++) {
            const signal = await this.detectSignal(page)
            const normalizedSignal = this.normalizeText(signal.text)
            if (!signal.hasVisibleDialog && !this.isLikelyInterruptionSignal(normalizedSignal)) {
                break
            }
            sawInterruptionSignal = true
            lastSignalText = signal.text || lastSignalText

            if (pass === 1) {
                const ragResult = await miniRagService.retrieve({
                    campaignType,
                    campaignId: options.campaignId,
                    threadId: options.threadId,
                    domain: currentDomain,
                    goal,
                    riskType,
                    signalText: signal.text || options.reason || goal,
                }).catch(() => ({
                    used: false,
                    weak: true,
                    timedOut: false,
                    latencyMs: 0,
                    hits: [],
                    context: '',
                }))
                if (ragResult.used && !ragResult.timedOut && ragResult.hits.length > 0) {
                    ragUsed = true
                    ragHitCount = ragResult.hits.length
                    ragEvidenceIds = ragResult.hits.map(hit => hit.id)
                    ragContext = ragResult.context
                    ragHints = this.extractRagHints(ragContext)
                }
            }

            const snapshot = await DOMUtils.extractInteractiveDOM(page)
            const candidates = this.buildCandidates(snapshot.summaries, goal, ragHints)
            let passHandled = false

            for (const candidate of candidates.slice(0, 8)) {
                if (candidate.score < 3) {
                    continue
                }

                try {
                    await this.clickObservedCandidate(page, candidate.summary.id)
                    lastVia = 'semantic_candidate'
                    lastDetail = `${candidate.summary.id}:${candidate.label}`
                    resolved = true
                    passHandled = true
                    decisionSource = 'heuristic'
                    this.log(options, `Pass ${pass}/${maxPasses}: semantic candidate ${candidate.summary.id} (${candidate.label})`)
                    await page.waitForTimeout(140).catch(() => { })
                    break
                } catch {
                    // Try next candidate.
                }
            }

            if (!passHandled && options.useLlmFallback && signal.hasVisibleDialog) {
                const pickedId = await this.tryLlmCandidate(candidates, signal.text, options, ragContext)
                if (pickedId !== null) {
                    try {
                        const picked = candidates.find(candidate => candidate.summary.id === pickedId)
                        await this.clickObservedCandidate(page, pickedId)
                        lastVia = 'llm_candidate'
                        lastDetail = `${pickedId}:${picked?.label || 'unknown'}`
                        resolved = true
                        passHandled = true
                        decisionSource = ragUsed && ragHitCount > 0 ? 'llm+rag' : 'llm'
                        this.log(options, `Pass ${pass}/${maxPasses}: llm candidate ${pickedId}`)
                        await page.waitForTimeout(160).catch(() => { })
                    } catch {
                        // Continue fallback selectors.
                    }
                }
            }

            if (!passHandled) {
                for (const selector of this.fallbackSelectors) {
                    const locator = page.locator(selector).first()
                    const count = await locator.count().catch(() => 0)
                    if (count === 0) {
                        continue
                    }
                    try {
                        const visible = await locator.isVisible({ timeout: 500 }).catch(() => false)
                        if (!visible) {
                            continue
                        }
                        await locator.click({ timeout: 1200 }).catch(async () => {
                            await locator.click({ timeout: 1200, force: true })
                        })
                        lastVia = 'selector_fallback'
                        lastDetail = selector
                        resolved = true
                        passHandled = true
                        decisionSource = 'heuristic'
                        this.log(options, `Pass ${pass}/${maxPasses}: selector ${selector}`)
                        await page.waitForTimeout(120).catch(() => { })
                        break
                    } catch {
                        // Ignore and continue.
                    }
                }
            }

            if (!passHandled) {
                if (options.useEscapeFallback) {
                    await page.keyboard.press('Escape').catch(() => { })
                    lastVia = 'keyboard_escape'
                    resolved = true
                    passHandled = true
                    decisionSource = 'heuristic'
                    this.log(options, `Pass ${pass}/${maxPasses}: escape fallback`)
                    await page.waitForTimeout(120).catch(() => { })
                } else {
                    break
                }
            }

            if (!passHandled) {
                break
            }

            const signalAfterAction = await this.detectSignal(page)
            const normalizedAfterAction = this.normalizeText(signalAfterAction.text)
            if (!signalAfterAction.hasVisibleDialog && !this.isLikelyInterruptionSignal(normalizedAfterAction)) {
                break
            }
        }

        if (resolved) {
            const elapsed = Date.now() - startedAt
            void miniRagService.ingest({
                campaignType,
                campaignId: options.campaignId,
                threadId: options.threadId,
                domain: currentDomain,
                goal,
                riskType,
                signalText: lastSignalText || options.reason || goal,
                action: 'context_recovered',
                decisionSource,
                success: true,
                detail: lastDetail,
                recoverPath: lastVia,
                latencyMs: elapsed,
                metadata: ragEvidenceIds.length > 0 ? { ragEvidenceIds } : undefined,
            }).catch(() => { })
            return {
                handled: true,
                via: lastVia,
                detail: lastDetail,
                latencyMs: elapsed,
                decisionSource,
                ragUsed,
                ragHitCount,
                ragEvidenceIds: ragEvidenceIds.length > 0 ? ragEvidenceIds : undefined,
                decisionLatencyMs: elapsed,
            }
        }

        if (options.useEscapeFallback && sawInterruptionSignal) {
            await page.keyboard.press('Escape').catch(() => { })
            const elapsed = Date.now() - startedAt
            void miniRagService.ingest({
                campaignType,
                campaignId: options.campaignId,
                threadId: options.threadId,
                domain: currentDomain,
                goal,
                riskType,
                signalText: lastSignalText || options.reason || goal,
                action: 'context_recovered',
                decisionSource: 'heuristic',
                success: true,
                detail: 'keyboard_escape',
                recoverPath: 'keyboard_escape',
                latencyMs: elapsed,
                metadata: ragEvidenceIds.length > 0 ? { ragEvidenceIds } : undefined,
            }).catch(() => { })
            return {
                handled: true,
                via: 'keyboard_escape',
                latencyMs: elapsed,
                decisionSource: 'heuristic',
                ragUsed,
                ragHitCount,
                ragEvidenceIds: ragEvidenceIds.length > 0 ? ragEvidenceIds : undefined,
                decisionLatencyMs: elapsed,
            }
        }

        const elapsed = Date.now() - startedAt
        void miniRagService.ingest({
            campaignType,
            campaignId: options.campaignId,
            threadId: options.threadId,
            domain: currentDomain,
            goal,
            riskType,
            signalText: lastSignalText || options.reason || goal,
            action: 'context_unresolved',
            decisionSource,
            success: false,
            detail: lastDetail,
            recoverPath: lastVia,
            latencyMs: elapsed,
            metadata: ragEvidenceIds.length > 0 ? { ragEvidenceIds } : undefined,
        }).catch(() => { })
        return {
            handled: false,
            latencyMs: elapsed,
            decisionSource,
            ragUsed,
            ragHitCount,
            ragEvidenceIds: ragEvidenceIds.length > 0 ? ragEvidenceIds : undefined,
            decisionLatencyMs: elapsed,
        }
    }
}

export const contextualInterruptionResolver = new ContextualInterruptionResolver()
