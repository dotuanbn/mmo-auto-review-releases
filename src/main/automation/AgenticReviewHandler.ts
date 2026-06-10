/**
 * AgenticReviewHandler - Autonomous web automation using local LLM.
 * Designed to be plugged into the existing AutomationController threads.
 */

import { BrowserWindow } from 'electron'
import { Locator, Page } from 'playwright'
import { ollamaService } from '../services/OllamaService'
import { DOMUtils, ObservedElementSummary } from './DOMUtils'
import { contextualInterruptionResolver } from './ContextualInterruptionResolver'
import { parseReviewAgentAction } from './agentSchemas'
import { loadSettings } from '../ipc/settings'
import {
    buildManualSubmitMessage,
    getReviewSubmissionDecision,
    requestManualReviewSubmissionApproval,
} from '../services/ComplianceService'

export interface AgentAction {
    thought: string
    action: 'click' | 'type' | 'scroll_down' | 'wait' | 'finish' | 'fail'
    element_id?: number
    value?: string
}

export class AgenticReviewHandler {
    private MAX_STEPS = 20
    private LLM_TIMEOUT_MS = 8000
    private readonly allowedActions = new Set<AgentAction['action']>(['click', 'type', 'scroll_down', 'wait', 'finish', 'fail'])

    private log(msg: string) {
        console.log(`[AgenticReview] ${msg}`)
    }

    private sendStatusToUI(campaignId: number, progress: number, message: string) {
        this.log(message)
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('automation:status', {
                running: true,
                campaignId,
                progress,
                message,
            })
        }
    }

    private delay(min: number, max: number): Promise<void> {
        const speedFactor = 0.4 // Faster execution
        const scaledMin = Math.max(30, Math.floor(min * speedFactor))
        const scaledMax = Math.max(scaledMin, Math.floor(max * speedFactor))
        const ms = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin
        return new Promise(resolve => setTimeout(resolve, ms))
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

    private isValidAction(actionData: unknown): actionData is AgentAction {
        if (!actionData || typeof actionData !== 'object') {
            return false
        }

        const candidate = actionData as Record<string, unknown>
        return typeof candidate.thought === 'string'
            && typeof candidate.action === 'string'
            && this.allowedActions.has(candidate.action as AgentAction['action'])
    }

    private async preparePage(page: Page, threadId: number): Promise<void> {
        if (page.isClosed()) {
            throw new Error(`Playwright page for thread ${threadId} is already closed`)
        }

        await page.bringToFront().catch((error: unknown) => {
            this.log(`T${threadId}: Failed to bring page to front: ${this.formatError(error)}`)
        })
    }

    private shouldRecoverOverlay(errorMessage: string): boolean {
        const pattern = /(intercepts pointer events|another element|element is detached|timeout|not receiving pointer events|subtree intercepts)/i
        return pattern.test(errorMessage)
    }

    private async recoverFromUnexpectedOverlay(page: Page, threadId: number): Promise<boolean> {
        const sharedRecovery = await contextualInterruptionResolver.resolve(page, {
            threadId,
            reason: 'agentic_review_overlay',
            useLlmFallback: true,
            llmTimeoutMs: 2600,
            useEscapeFallback: true,
            maxPasses: 3,
            goal: 'review_flow',
            campaignType: 'review',
            domain: page.url(),
            logger: (msg) => this.log(msg),
        }).catch(() => ({ handled: false }))
        if (sharedRecovery.handled) {
            return true
        }

        const selectors = [
            'button[aria-label*="Close"]',
            'button[aria-label*="Dismiss"]',
            'button[aria-label*="Cancel"]',
            'button[aria-label*="Dong"]',
            'button:has-text("Close")',
            'button:has-text("Dismiss")',
            'button:has-text("Not now")',
            'button:has-text("No thanks")',
            'button:has-text("Cancel")',
            'button:has-text("Skip")',
            'button:has-text("Later")',
            'button:has-text("Got it")',
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
                    return true
                }
            } catch {
                // Try next selector.
            }
        }

        await page.keyboard.press('Escape').catch(() => {})
        await this.delay(120, 240)
        return false
    }

    private async clickLocatorRobustly(page: Page, locator: Locator, threadId: number, context: string): Promise<void> {
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
                    await page.mouse.move(x, y)
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
        ]

        let lastError = ''
        for (const strategy of strategies) {
            try {
                await strategy.run()
                this.log(`T${threadId}: Clicked ${context} with strategy ${strategy.name}`)
                return
            } catch (error: unknown) {
                lastError = this.formatError(error)
                this.log(`T${threadId}: Click strategy ${strategy.name} failed on ${context}: ${lastError}`)
                if (this.shouldRecoverOverlay(lastError)) {
                    await this.recoverFromUnexpectedOverlay(page, threadId)
                }
            }
        }

        throw new Error(`All click strategies failed on ${context}: ${lastError}`)
    }

    private async clickObservedElement(page: Page, elementId: number, threadId: number): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        const count = await locator.count()

        if (count === 0) {
            throw new Error(`Observed element ${elementId} no longer exists in the DOM`)
        }

        await this.clickLocatorRobustly(page, locator, threadId, `element ${elementId}`)
    }

    private async typeIntoObservedElement(page: Page, elementId: number, value: string, threadId: number): Promise<void> {
        const locator = DOMUtils.getObservedElementLocator(page, elementId)
        const count = await locator.count()

        if (count === 0) {
            throw new Error(`Observed element ${elementId} no longer exists in the DOM`)
        }

        await this.clickLocatorRobustly(page, locator, threadId, `type-target ${elementId}`)
        await this.delay(200, 400)
        await page.keyboard.press('Control+A').catch(() => {})
        await page.keyboard.press('Backspace').catch(() => {})

        // If keyboard clear did not work (custom widgets), clear value via DOM as fallback.
        await locator.evaluate(node => {
            const el = node as HTMLInputElement | HTMLTextAreaElement | HTMLElement
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value = ''
                el.dispatchEvent(new Event('input', { bubbles: true }))
                el.dispatchEvent(new Event('change', { bubbles: true }))
                return
            }

            if (el.isContentEditable) {
                el.textContent = ''
                el.dispatchEvent(new InputEvent('input', { bubbles: true }))
            }
        }).catch(() => {})

        for (const char of value) {
            await page.keyboard.type(char, { delay: 30 + Math.random() * 50 })
        }

        this.log(`T${threadId}: Typed into element ${elementId}`)
    }

    private getSummaryById(summaries: ObservedElementSummary[], elementId: number): ObservedElementSummary | undefined {
        return summaries.find(summary => summary.id === elementId)
    }

    private normalizedText(value?: string): string {
        if (!value) {
            return ''
        }

        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
    }

    private isSubmitElement(summary?: ObservedElementSummary): boolean {
        if (!summary) {
            return false
        }

        const text = this.normalizedText([
            summary.textContent,
            summary.ariaLabel,
            summary.title,
            summary.placeholder,
            summary.role,
            summary.type,
        ].filter(Boolean).join(' '))

        return /(post|submit|publish|dang|gui|hoan tat|xac nhan)/i.test(text)
    }

    async performReview(
        page: Page,
        locationName: string,
        locationUrl: string,
        reviewText: string,
        rating: number,
        campaignId: number,
        threadId: number,
        shouldStopCheck: () => boolean
    ): Promise<{ success: boolean; error?: string }> {
        try {
            this.log(`T${threadId}: Navigating to ${locationUrl}`)
            await page.goto(locationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
            await this.preparePage(page, threadId)
            await this.delay(3000, 5000)

            const complianceSettings = loadSettings()
            const submitDecision = getReviewSubmissionDecision(locationUrl, complianceSettings)
            if (!submitDecision.allowed) {
                const manualMsg = buildManualSubmitMessage(locationUrl, complianceSettings)
                this.sendStatusToUI(campaignId, 45, `T${threadId}: ${manualMsg}`)
            }

            const goal = `You need to review the location "${locationName}". Find the "Write a review" button and click it. Then type this review text: "${reviewText}" into the review textbox, select ${rating} stars, and click the "Post" button. Confirm it is posted.`
            let stepCount = 0

            while (stepCount < this.MAX_STEPS && !shouldStopCheck()) {
                stepCount++
                this.log(`T${threadId}: --- Step ${stepCount}/${this.MAX_STEPS} ---`)
                await this.preparePage(page, threadId)
                const recoveredAtStepStart = await this.recoverFromUnexpectedOverlay(page, threadId)
                if (recoveredAtStepStart) {
                    this.sendStatusToUI(campaignId, 50, `T${threadId}: Resolved blocking popup/context prompt.`)
                    await this.delay(180, 360)
                }

                this.sendStatusToUI(campaignId, 50, `T${threadId}: Agent observing screen (Step ${stepCount})...`)

                const currentUrl = page.url()
                const { domText, elementIds, summaries } = await DOMUtils.extractInteractiveDOM(page)

                const systemPrompt = `You are a fast, smart autonomous web agent.
Your objective: ${goal}
Current URL: ${currentUrl}

Interactive Elements on Screen:
${domText}

Rules:
1. Respond ONLY with a valid JSON object. No markdown formatting.
2. JSON structure EXACTLY:
{
  "thought": "Brief, logical reasoning for next immediate action",
  "action": "click" | "type" | "scroll_down" | "wait" | "finish" | "fail",
  "element_id": number (required for click/type),
  "value": "string" (required for type)
}
3. If objective complete (review posted), use "finish".
4. If impossible, use "fail".
5. Wait for elements to load with "wait" after submitting a form.
6. Think fast, prioritize reaching the goal efficiently.`

                this.sendStatusToUI(campaignId, 50, `T${threadId}: Agent reasoning (LLM processing)...`)

                const llmResult = await ollamaService.chat(
                    'Analyze the elements and decide the next action. Output JSON only.',
                    systemPrompt,
                    true,
                    this.LLM_TIMEOUT_MS
                )

                if (!llmResult.success || !llmResult.response) {
                    const reason = this.sanitizeForStatus(llmResult.error || 'no response', 140)
                    this.sendStatusToUI(campaignId, 50, `T${threadId}: LLM timeout/error -> wait (${reason})`)
                    await this.delay(1200, 2200)
                    continue
                }

                let actionData: AgentAction
                try {
                    let cleanJson = llmResult.response.trim()
                    if (cleanJson.startsWith('```json')) cleanJson = cleanJson.substring(7)
                    if (cleanJson.startsWith('```')) cleanJson = cleanJson.substring(3)
                    if (cleanJson.endsWith('```')) cleanJson = cleanJson.substring(0, cleanJson.length - 3)
                    cleanJson = cleanJson.trim()

                    const parsed = JSON.parse(cleanJson)
                    const schemaResult = parseReviewAgentAction(parsed)
                    if (schemaResult.success) {
                        actionData = schemaResult.data
                    } else if (this.isValidAction(parsed)) {
                        actionData = parsed
                    } else {
                        throw new Error('Invalid action schema')
                    }
                } catch {
                    this.log(`T${threadId}: Failed to parse LLM JSON: ${llmResult.response}`)
                    this.sendStatusToUI(campaignId, 50, `T${threadId}: AI returned invalid JSON`)
                    await this.delay(1000, 1800)
                    continue
                }

                if (!this.isValidAction(actionData)) {
                    this.log(`T${threadId}: Invalid LLM action payload: ${JSON.stringify(actionData)}`)
                    this.sendStatusToUI(campaignId, 50, `T${threadId}: AI returned invalid action payload`)
                    await this.delay(900, 1600)
                    continue
                }

                this.log(`T${threadId}: Action: ${actionData.action} | Thought: ${actionData.thought}`)
                this.sendStatusToUI(campaignId, 50, `T${threadId}: Agent Act: ${actionData.action} - ${this.sanitizeForStatus(actionData.thought, 140)}`)

                if (actionData.action === 'finish') {
                    this.log(`T${threadId}: Agent completed goal successfully.`)
                    return { success: true }
                }

                if (actionData.action === 'fail') {
                    return { success: false, error: `Agent declared failure: ${actionData.thought}` }
                }

                if (actionData.action === 'wait') {
                    await this.delay(1500, 2800)
                    continue
                }

                if (actionData.action === 'scroll_down') {
                    await DOMUtils.scrollObservedPage(page, 'down')
                    this.log(`T${threadId}: Scrolled down`)
                    await this.delay(1000, 2000)
                    continue
                }

                if (actionData.element_id !== undefined && elementIds.has(actionData.element_id)) {
                    try {
                        const targetSummary = this.getSummaryById(summaries, actionData.element_id)
                        if (actionData.action === 'click' && this.isSubmitElement(targetSummary) && !submitDecision.allowed) {
                            const manualMsg = buildManualSubmitMessage(locationUrl, complianceSettings)
                            this.log(`T${threadId}: Waiting manual approval before submit: ${submitDecision.reason}`)
                            this.sendStatusToUI(campaignId, 95, `T${threadId}: ${manualMsg} Waiting for approval...`)
                            const manualResult = await requestManualReviewSubmissionApproval({
                                locationUrl,
                                locationName,
                                campaignId,
                                threadId,
                                reason: submitDecision.reason,
                            })
                            if (!manualResult.approved) {
                                return { success: false, error: `${manualMsg} (reason: ${manualResult.reason})` }
                            }
                            this.sendStatusToUI(campaignId, 96, `T${threadId}: Manual approval received. Continuing submit...`)
                        }

                        if (actionData.action === 'click') {
                            await this.clickObservedElement(page, actionData.element_id, threadId)
                        } else if (actionData.action === 'type' && actionData.value) {
                            await this.typeIntoObservedElement(page, actionData.element_id, actionData.value, threadId)
                        } else if (actionData.action === 'type') {
                            throw new Error('Type action missing value')
                        }
                    } catch (error: unknown) {
                        const errorMessage = this.formatError(error)
                        this.log(`T${threadId}: Action execution failed on element ${actionData.element_id}: ${errorMessage}`)
                        this.sendStatusToUI(campaignId, 50, `T${threadId}: Action failed on element ${actionData.element_id}: ${this.sanitizeForStatus(errorMessage, 150)}`)

                        if (this.shouldRecoverOverlay(errorMessage)) {
                            const recovered = await this.recoverFromUnexpectedOverlay(page, threadId)
                            if (recovered) {
                                this.sendStatusToUI(campaignId, 50, `T${threadId}: Recovered from overlay, continuing...`)
                            }
                        }
                    }
                } else if (actionData.element_id !== undefined) {
                    this.log(`T${threadId}: Warning: LLM referenced invalid element_id ${actionData.element_id}`)
                    this.sendStatusToUI(campaignId, 50, `T${threadId}: Invalid element_id: ${actionData.element_id}`)
                } else if (actionData.action === 'click' || actionData.action === 'type') {
                    this.log(`T${threadId}: ${actionData.action} action missing element_id`)
                    this.sendStatusToUI(campaignId, 50, `T${threadId}: ${actionData.action} missing element_id`)
                }

                await this.delay(900, 2200)
            }

            if (shouldStopCheck()) {
                return { success: false, error: 'Campaign stopped by user' }
            }

            return { success: false, error: 'Maximum agent steps reached without finishing.' }
        } catch (error) {
            const errorMsg = this.formatError(error)
            this.log(`T${threadId}: Error: ${errorMsg}`)
            return { success: false, error: errorMsg }
        }
    }
}

export const agenticReviewHandler = new AgenticReviewHandler()
