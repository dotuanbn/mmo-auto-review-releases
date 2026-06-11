import { ObservedElementSummary } from './DOMUtils'

export type TrafficFallbackAction =
    | { action: 'click'; element_id: number; thought: string }
    | { action: 'scroll_down' | 'scroll_up' | 'finish'; thought: string }

const unsafeTrafficPatterns: RegExp[] = [
    /(add|upload|post|write|edit).*(photo|video|review|image)/i,
    /(them|dang).*(anh|video|danh gia)/i,
    /(th[m]?|dang).*(anh|video|danh ?gia)/i,
    /(photo|video|anh).*(add|upload|them)/i,
    /(delete|remove|sign out|log out|claim this business|report)/i,
    /(direction|directions|chi duong|route|driving|walking|transit|cycling)/i,
]

const trafficKeywords = [
    { pattern: /(map|ban do|terrain|satellite|street view|fullscreen|nearby|lan can|similar)/i, thought: 'Explore the target map area with map-specific interactions.' },
    { pattern: /(review|reviews|danh gia|nhan xet)/i, thought: 'Open reviews and continue reading more user feedback.' },
    { pattern: /(photo|photos|anh|hinh|gallery|album|360)/i, thought: 'Open photos and continue visual exploration.' },
    { pattern: /(about|overview|gioi thieu|thong tin|hours|open|close)/i, thought: 'Open the information panel to inspect business details.' },
    { pattern: /(direction|directions|chi duong|route|driving|walking|transit)/i, thought: 'Open directions to simulate route planning behavior.' },
    { pattern: /(menu|thuc don|products|san pham|services|dich vu)/i, thought: 'Open menu/products/services to inspect in-map business content.' },
    { pattern: /(nearby|similar|lan can|tuong tu|explore)/i, thought: 'Open nearby/similar sections to broaden browsing flow.' },
]

const mapTargetFocusPatterns: RegExp[] = [
    /(map|ban do|terrain|satellite|street view|fullscreen|nearby|lan can|similar|explore)/i,
    /(review|reviews|danh gia|nhan xet|local guide|contributor|profile)/i,
    /(photo|photos|anh|hinh|gallery|album|360)/i,
    /(direction|directions|chi duong|route|driving|walking|transit|cycling)/i,
    /(about|overview|gioi thieu|thong tin|hours|open|close|address|phone|menu|products|services|price|amenities)/i,
]

function summarizeElementText(element: ObservedElementSummary): string {
    return [
        element.textContent,
        element.ariaLabel,
        element.placeholder,
        element.title,
        element.href,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
}

function normalizeComparableText(text: string): string {
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function tokenizeLocationName(locationName?: string): string[] {
    const normalized = normalizeComparableText(locationName || '')
    if (!normalized) {
        return []
    }

    return normalized
        .split(/[^a-z0-9]+/i)
        .map(token => token.trim())
        .filter(token => token.length >= 3)
        .slice(0, 8)
}

function shuffleCopy<T>(items: T[]): T[] {
    return [...items].sort(() => Math.random() - 0.5)
}

function pickRandom<T>(items: T[]): T | undefined {
    if (items.length === 0) {
        return undefined
    }

    return items[Math.floor(Math.random() * items.length)]
}

function getRotatedKeywords(stepCount: number) {
    if (trafficKeywords.length === 0) {
        return []
    }

    const offset = Math.abs(stepCount) % trafficKeywords.length
    return [
        ...trafficKeywords.slice(offset),
        ...trafficKeywords.slice(0, offset),
    ]
}

export function isUnsafeTrafficElement(summary?: ObservedElementSummary): boolean {
    if (!summary) {
        return false
    }

    const text = normalizeComparableText(summarizeElementText(summary))
    return unsafeTrafficPatterns.some(pattern => pattern.test(text))
}

export function isMapTargetRelevantElement(summary: ObservedElementSummary | undefined, locationName?: string): boolean {
    if (!summary) {
        return false
    }

    const text = normalizeComparableText(summarizeElementText(summary))
    if (!text) {
        return false
    }

    if (mapTargetFocusPatterns.some(pattern => pattern.test(text))) {
        return true
    }

    const href = normalizeComparableText(summary.href || '')
    if (href && (href.includes('/maps/') || href.includes('google.com/maps') || href.includes('g.co/'))) {
        return true
    }

    const locationTokens = tokenizeLocationName(locationName)
    if (locationTokens.length === 0) {
        return false
    }

    const matched = locationTokens.filter(token => text.includes(token)).length
    return matched >= Math.min(2, locationTokens.length)
}

export function pickTrafficFallbackAction(
    summaries: ObservedElementSummary[],
    stepCount: number,
    targetSteps: number,
    excludedElementIds: Set<number> = new Set(),
    locationName?: string
): TrafficFallbackAction {
    const safeCandidates = summaries.filter(summary => (
        !excludedElementIds.has(summary.id)
        && !isUnsafeTrafficElement(summary)
        && isMapTargetRelevantElement(summary, locationName)
    ))

    const weightedKeywordMatches: Array<{ id: number; thought: string; priority: number }> = []
    const rotatedKeywords = getRotatedKeywords(stepCount)

    rotatedKeywords.forEach((keyword, priority) => {
        const matches = safeCandidates.filter(summary => {
            const normalizedText = normalizeComparableText(summarizeElementText(summary))
            return keyword.pattern.test(normalizedText)
        })

        for (const summary of shuffleCopy(matches).slice(0, 3)) {
            weightedKeywordMatches.push({
                id: summary.id,
                thought: keyword.thought,
                priority,
            })
        }
    })

    if (weightedKeywordMatches.length > 0) {
        const bestPriority = Math.min(...weightedKeywordMatches.map(item => item.priority))
        const nearBest = weightedKeywordMatches.filter(item => item.priority <= bestPriority + 1)
        const selected = pickRandom(nearBest) || pickRandom(weightedKeywordMatches)
        if (selected) {
            return {
                action: 'click',
                element_id: selected.id,
                thought: selected.thought,
            }
        }
    }

    const genericClickable = shuffleCopy(safeCandidates).find(summary => {
        const normalizedText = normalizeComparableText(summarizeElementText(summary))
        if (!normalizedText) {
            return false
        }

        if (summary.tagName === 'input' && /(search|tim|query)/i.test(normalizedText)) {
            return false
        }

        return true
    })

    if (genericClickable && stepCount % 4 !== 0) {
        return {
            action: 'click',
            element_id: genericClickable.id,
            thought: 'Try a different visible element to keep browsing behavior diverse.',
        }
    }

    const safeTargetSteps = Number.isFinite(targetSteps) ? Math.max(1, Math.floor(targetSteps)) : 8
    const minStepsBeforeFinish = Math.max(6, Math.min(16, Math.floor(safeTargetSteps * 0.65)))

    if (stepCount >= minStepsBeforeFinish && Math.random() > 0.45) {
        return {
            action: 'finish',
            thought: 'Enough natural actions were completed for this visit target.',
        }
    }

    if (stepCount % 5 === 0 || Math.random() < 0.22) {
        return {
            action: 'scroll_up',
            thought: 'Scroll up to revisit previous sections before continuing.',
        }
    }

    return {
        action: 'scroll_down',
        thought: 'No safe click target found, continue reading by scrolling down.',
    }
}
