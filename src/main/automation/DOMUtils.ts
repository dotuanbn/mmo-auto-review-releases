import { Locator, Page } from 'playwright'

export interface DOMElement {
    id: number
    tagName: string
    text: string
    role?: string
    placeholder?: string
    href?: string
    isVisible: boolean
}

export interface ObservedElementSummary {
    id: number
    tagName: string
    textContent?: string
    role?: string
    placeholder?: string
    href?: string
    type?: string
    ariaLabel?: string
    title?: string
    inDialog?: boolean
}

export interface ExtractedInteractiveDOM {
    domText: string
    elementIds: Set<number>
    summaries: ObservedElementSummary[]
}

export class DOMUtils {
    static readonly AI_ID_ATTRIBUTE = 'data-ai-id'

    /**
     * Extracts an interactive, simplified DOM representation and annotates elements with unique IDs.
     * @param page Playwright Page instance
     * @returns Compact text representation of the DOM and the currently observed element IDs
     */
    static async extractInteractiveDOM(page: Page): Promise<ExtractedInteractiveDOM> {
        // Run extraction logic entirely inside the browser to avoid thousands of slow Playwright IPC calls
        const extractedData = await page.evaluate((aiIdAttribute) => {
            document.querySelectorAll(`[${aiIdAttribute}]`).forEach(el => el.removeAttribute(aiIdAttribute))

            const els = document.querySelectorAll([
                'button',
                'a',
                'input',
                'textarea',
                'select',
                '[role="button"]',
                '[role="link"]',
                '[role="menuitem"]',
                '[role="tab"]',
                '[role="option"]',
                '[role="switch"]',
                '[role="checkbox"]',
                '[contenteditable="true"]',
                '[onclick]',
                '[jsaction*="click"]',
                '[data-item-id]',
                '[data-tab-id]',
                '[data-tooltip]',
                '[aria-haspopup="dialog"]',
                '[tabindex]'
            ].join(', '))
            const data: any[] = []
            let idCounter = 1
            const viewportW = window.innerWidth
            const viewportH = window.innerHeight
            const viewportCenterX = viewportW / 2
            const viewportCenterY = viewportH / 2

            for (const el of Array.from(els)) {
                // Check visibility fast
                const rect = el.getBoundingClientRect()
                if (rect.width === 0 || rect.height === 0) continue

                const style = window.getComputedStyle(el)
                if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue

                const htmlEl = el as HTMLElement
                const tagName = htmlEl.tagName.toLowerCase()
                const role = htmlEl.getAttribute('role') || undefined
                const hasClickBehavior = htmlEl.hasAttribute('onclick')
                    || htmlEl.hasAttribute('jsaction')
                    || style.cursor === 'pointer'
                    || role === 'button'
                    || role === 'link'
                    || role === 'menuitem'
                    || role === 'tab'
                    || role === 'option'
                    || role === 'switch'
                    || role === 'checkbox'
                    || tagName === 'button'
                    || tagName === 'a'
                    || tagName === 'input'
                    || tagName === 'textarea'
                    || tagName === 'select'
                if (!hasClickBehavior) continue

                let textContent = (htmlEl.innerText || (htmlEl as any).value || '').trim()
                const placeholder = htmlEl.getAttribute('placeholder') || undefined
                const href = htmlEl.getAttribute('href') || undefined
                const type = htmlEl.getAttribute('type') || undefined
                const ariaLabel = htmlEl.getAttribute('aria-label') || undefined
                const title = htmlEl.getAttribute('title') || undefined
                const inDialog = !!htmlEl.closest('[role="dialog"], [aria-modal="true"], [role="alertdialog"]')
                const centerX = rect.left + rect.width / 2
                const centerY = rect.top + rect.height / 2
                const centerDistance = Math.abs(centerX - viewportCenterX) + Math.abs(centerY - viewportCenterY)
                const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportH && rect.left < viewportW
                const zIndex = Number.parseInt(style.zIndex || '0', 10)
                let priority = 0
                if (inDialog) priority += 120
                if (inViewport) priority += 28
                if (style.position === 'fixed' || style.position === 'sticky') priority += 9
                if (Number.isFinite(zIndex)) priority += Math.max(0, Math.min(zIndex, 40))
                priority -= Math.min(80, Math.floor(centerDistance / 40))

                if (!textContent && !placeholder && !ariaLabel) {
                    if (tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') {
                        if (!title) continue
                    }
                }

                // If text is super long, truncate it early to save memory
                if (textContent.length > 200) textContent = textContent.substring(0, 200) + '...'

                const currentId = idCounter++
                htmlEl.setAttribute(aiIdAttribute, String(currentId))

                data.push({
                    id: currentId,
                    tagName,
                    textContent,
                    role,
                    placeholder,
                    href,
                    type,
                    ariaLabel,
                    title,
                    inDialog,
                    priority
                })
            }
            data.sort((left, right) => (right.priority || 0) - (left.priority || 0))
            return data
        }, DOMUtils.AI_ID_ATTRIBUTE)

        const elementIds = new Set<number>()
        const summaries: ObservedElementSummary[] = []

        let domText = ''
        // Cap to ~250 interactive elements to prevent LLM context overflow
        const MAX_ELEMENTS = 160
        const itemsToProcess = extractedData.slice(0, MAX_ELEMENTS)
        
        for (const item of itemsToProcess) {
            elementIds.add(item.id)
            summaries.push({
                id: item.id,
                tagName: item.tagName,
                textContent: item.textContent,
                role: item.role,
                placeholder: item.placeholder,
                href: item.href,
                type: item.type,
                ariaLabel: item.ariaLabel,
                title: item.title,
                inDialog: item.inDialog === true
            })

            let elementDesc = `[ID: ${item.id}] <${item.tagName}`
            if (item.inDialog) elementDesc += ` in-dialog="true"`
            if (item.type) elementDesc += ` type="${item.type}"`
            if (item.role) elementDesc += ` role="${item.role}"`
            if (item.placeholder) elementDesc += ` placeholder="${item.placeholder}"`
            if (item.ariaLabel) elementDesc += ` aria-label="${item.ariaLabel}"`
            if (item.href) {
                const shortHref = item.href.length > 50 ? item.href.substring(0, 50) + '...' : item.href
                elementDesc += ` href="${shortHref}"`
            }
            elementDesc += `>`

            const innerText = item.textContent || item.ariaLabel || item.title || ''
            let displayString = innerText.length > 100 ? innerText.substring(0, 100) + '...' : innerText
            
            // Clean up newlines that might break LLM reasoning
            displayString = displayString.replace(/\r?\n|\r/g, ' ')
            
            elementDesc += `${displayString}</${item.tagName}>\n`

            domText += elementDesc
        }

        if (extractedData.length > MAX_ELEMENTS) {
            domText += `\n... ${extractedData.length - MAX_ELEMENTS} more elements truncated ...\n`
        }

        if (domText.trim().length === 0) {
            domText = 'No interactive elements found on the screen.'
        }

        return {
            domText,
            elementIds,
            summaries
        }
    }

    static getObservedElementLocator(page: Page, elementId: number): Locator {
        return page.locator(`[${DOMUtils.AI_ID_ATTRIBUTE}="${elementId}"]`).first()
    }

    static async scrollObservedPage(page: Page, direction: 'up' | 'down'): Promise<void> {
        const delta = direction === 'down' ? 700 : -700
        const key = direction === 'down' ? 'PageDown' : 'PageUp'

        await page.mouse.move(960, 540).catch(() => {})
        await page.mouse.wheel(0, delta).catch(() => {})
        await page.keyboard.press(key).catch(() => {})
        await page.evaluate((scrollDelta) => {
            const scrollables = Array.from(document.querySelectorAll<HTMLElement>('body *'))
                .filter(el => {
                    const rect = el.getBoundingClientRect()
                    if (rect.width === 0 || rect.height === 0) return false

                    const style = window.getComputedStyle(el)
                    return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20
                })
                .sort((left, right) => (right.clientHeight * right.clientWidth) - (left.clientHeight * left.clientWidth))

            const target = scrollables[0] || document.scrollingElement || document.documentElement

            if ('scrollBy' in target && typeof target.scrollBy === 'function') {
                target.scrollBy({ top: scrollDelta, behavior: 'smooth' })
                return
            }

            window.scrollBy({ top: scrollDelta, behavior: 'smooth' })
        }, delta)
    }
}
