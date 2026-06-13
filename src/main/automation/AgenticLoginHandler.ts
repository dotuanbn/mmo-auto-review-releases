import { Page } from 'playwright'
import { ollamaService } from '../services/OllamaService'
import { writeAgenticLog } from '../utils/agenticLog'
import { DOMUtils, ObservedElementSummary } from './DOMUtils'
import { parseLoginAgentAction } from './agentSchemas'
import { browserService } from './BrowserService'
import { moveCursor, clickCursor } from './BrowserCursorOverlay'

export class AgenticLoginHandler {
    private log(msg: string) {
        console.log(`[AgenticLogin] ${msg}`)
        writeAgenticLog('AgenticLogin', msg)
    }

    private formatError(error: unknown): string {
        const raw = error instanceof Error ? error.message : String(error)
        return raw.replace(/\s+/g, ' ').trim().slice(0, 260)
    }

    private delay(min: number, max: number): Promise<void> {
        const speedFactor = 0.4 // Faster execution
        const scaledMin = Math.max(30, Math.floor(min * speedFactor))
        const scaledMax = Math.max(scaledMin, Math.floor(max * speedFactor))
        const ms = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    public async executeLogin(
        page: Page,
        account: { email: string; password?: string; recoveryEmail?: string | null; recoveryPhone?: string | null },
        threadId: number = 0
    ): Promise<{ success: boolean; error?: string; requiresManual?: boolean }> {
        this.log(`T${threadId}: Starting Agentic Login for ${account.email}`)
        let steps = 0
        const MAX_STEPS = 15

        try {
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' })
            await this.delay(2000, 3000)

            while (steps < MAX_STEPS) {
                // Use strict isGoogleLoggedIn (SAPISID+SID cookies) instead of loose URL (prevents false positive on challenges/intermediates).
                const logged = await browserService.isGoogleLoggedIn(undefined, page.context()).catch(() => false)
                if (logged) {
                    this.log(`T${threadId}: Login successful (cookie confirmed)`)
                    return { success: true }
                }

                this.log(`T${threadId}: Step ${steps + 1} - Analyzing DOM`)
                const snapshot = await DOMUtils.extractInteractiveDOM(page)

                const prompt = this.buildPrompt(snapshot.domText, account)
                const llmResponse = await ollamaService.chat(prompt, undefined, true)
                
                if (!llmResponse.success || !llmResponse.response) {
                    this.log(`T${threadId}: LLM returned error or empty. Error: ${llmResponse.error}`)
                    return { success: false, error: 'LLM error or empty' }
                }

                const parsed = parseLoginAgentAction(JSON.parse(llmResponse.response))
                if (!parsed.success) {
                    this.log(`T${threadId}: LLM returned invalid JSON schema: ${llmResponse}`)
                    return { success: false, error: 'Invalid LLM response' }
                }

                const actionData = parsed.data
                this.log(`T${threadId}: Action: ${actionData.action}, Element: ${actionData.element_id || 'N/A'}. Thought: ${actionData.thought}`)

                const result = await this.performAction(page, actionData, snapshot.summaries, account, threadId)
                if (result === 'finish') {
                    return { success: true }
                } else if (result === 'fail') {
                    return { success: false, error: 'Agent marked as failed' }
                } else if (result === 'manual_required') {
                    return { success: false, requiresManual: true, error: 'Agent requested manual intervention' }
                }

                await this.delay(1500, 2500)
                steps++
            }

            return { success: false, error: 'Max steps reached' }
        } catch (error) {
            this.log(`T${threadId}: Error during Agentic Login: ${this.formatError(error)}`)
            return { success: false, error: this.formatError(error) }
        }
    }

    private buildPrompt(domText: string, account: any): string {
        return `You are a fast, highly logical AI browser automation agent attempting to log into a Google Account.
Task: Analyze the webpage DOM and decide the most efficient next action.
Choose ONE action from:
- type_email, type_password, type_recovery_email, type_recovery_phone, click, wait, manual_required, fail, finish.

Account info:
- Email: ${account.email}
- Password: ${account.password ? 'Available' : 'Missing'}
- Recovery Email: ${account.recoveryEmail ? 'Available' : 'Missing'}
- Recovery Phone: ${account.recoveryPhone ? 'Available' : 'Missing'}

IMPORTANT: Provide 'element_id' if interacting with an element.

Output JSON only. No markdown:
{
  "thought": "Brief, logical reasoning.",
  "action": "type_email" | "type_password" | "type_recovery_email" | "type_recovery_phone" | "click" | "wait" | "manual_required" | "fail" | "finish",
  "element_id": <number, optional>
}

DOM:
${domText}
`
    }

    private async performAction(page: Page, actionData: any, summaries: ObservedElementSummary[], account: any, threadId: number): Promise<'continue' | 'finish' | 'fail' | 'manual_required'> {
        switch (actionData.action) {
            case 'type_email': {
                if (actionData.element_id) {
                    await this.typeIntoElement(page, actionData.element_id, account.email, threadId)
                    await this.clickNext(page, threadId)
                } else {
                    const emailInput = 'input[type="email"]'
                    if (await page.$(emailInput)) {
                        await browserService.humanType(page, emailInput, account.email)
                        await this.clickNext(page, threadId)
                    } else {
                        this.log(`T${threadId}: Missing element_id for type_email and no input[type="email"] found`)
                    }
                }
                break
            }
            case 'type_password': {
                if (!account.password) {
                    this.log(`T${threadId}: Password missing!`)
                    return 'manual_required'
                }
                if (actionData.element_id) {
                    await this.typeIntoElement(page, actionData.element_id, account.password, threadId)
                    await this.clickNext(page, threadId)
                } else {
                    const pwdInput = 'input[type="password"]'
                    if (await page.$(pwdInput)) {
                        await browserService.humanType(page, pwdInput, account.password)
                        await this.clickNext(page, threadId)
                    } else {
                        this.log(`T${threadId}: Missing element_id for type_password`)
                    }
                }
                break
            }
            case 'type_recovery_email': {
                if (!account.recoveryEmail) {
                    this.log(`T${threadId}: Recovery Email missing!`)
                    return 'manual_required'
                }
                if (actionData.element_id) {
                    await this.typeIntoElement(page, actionData.element_id, account.recoveryEmail, threadId)
                    await this.clickNext(page, threadId)
                } else {
                    const emailInput = 'input[type="email"]'
                    if (await page.$(emailInput)) {
                        await browserService.humanType(page, emailInput, account.recoveryEmail)
                        await this.clickNext(page, threadId)
                    }
                }
                break
            }
            case 'type_recovery_phone': {
                if (!account.recoveryPhone) {
                    this.log(`T${threadId}: Recovery Phone missing!`)
                    return 'manual_required'
                }
                if (actionData.element_id) {
                    await this.typeIntoElement(page, actionData.element_id, account.recoveryPhone, threadId)
                    await this.clickNext(page, threadId)
                } else {
                    const phoneInput = 'input[type="tel"]'
                    if (await page.$(phoneInput)) {
                        await browserService.humanType(page, phoneInput, account.recoveryPhone)
                        await this.clickNext(page, threadId)
                    }
                }
                break
            }
            case 'click': {
                if (actionData.element_id) {
                    try {
                        const locator = DOMUtils.getObservedElementLocator(page, actionData.element_id)
                        const isVisible = await locator.isVisible()
                        if (isVisible) {
                            const bBox = await locator.boundingBox()
                            if (bBox) {
                                await moveCursor(page, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
                                await clickCursor(page, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
                            } else {
                                await locator.click()
                            }
                        } else {
                            this.log(`T${threadId}: Element ${actionData.element_id} not visible`)
                        }
                    } catch (e) {
                         this.log(`T${threadId}: Failed to click element: ${this.formatError(e)}`)
                    }
                }
                break
            }
            case 'wait':
                await this.delay(3000, 5000)
                break
            case 'finish':
                return 'finish'
            case 'fail':
                return 'fail'
            case 'manual_required':
                return 'manual_required'
        }
        return 'continue'
    }

    private async typeIntoElement(page: Page, elementId: number, text: string, threadId: number) {
        try {
            const locator = DOMUtils.getObservedElementLocator(page, elementId)
            const isVisible = await locator.isVisible()
            if (isVisible) {
                await locator.fill('')
                const bBox = await locator.boundingBox()
                if (bBox) {
                    await moveCursor(page, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
                    await clickCursor(page, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
                } else {
                    await locator.click()
                }
                await page.keyboard.type(text, { delay: 50 })
            } else {
                this.log(`T${threadId}: Element ${elementId} not visible for typing`)
            }
        } catch (e) {
            this.log(`T${threadId}: Failed to type into element ${elementId}: ${this.formatError(e)}`)
        }
    }

    private async clickNext(page: Page, threadId: number) {
        try {
            await this.delay(500, 1000)
            const nextButton = 'button:has-text("Next"), button:has-text("Tiếp theo"), #identifierNext, #passwordNext'
            const els = await page.$$(nextButton)
            if (els.length > 0) {
                const bBox = await els[0].boundingBox()
                if (bBox) {
                    await moveCursor(page, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
                    await clickCursor(page, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
                } else {
                    await els[0].click()
                }
                this.log(`T${threadId}: Clicked Next button`)
            }
        } catch (e) {
             this.log(`T${threadId}: Failed to click next button: ${this.formatError(e)}`)
        }
    }
}
