import { screen } from 'electron'

// ============================================================
// Window Tiling Service
// ============================================================

export interface TileRect {
    x: number
    y: number
    width: number
    height: number
}

export interface TilingLayout {
    rects: TileRect[]
    screenWidth: number
    screenHeight: number
    columns: number
    rows: number
}

export interface SlotTilingTarget {
    slot: number
    contextId: number
    context: { pages: () => any[] }
}

/**
 * Compute tiling layout rectangles for N browser windows.
 *
 * Rules:
 *   1 = fullscreen
 *   2 = side-by-side (2 columns)
 *   3 = 3 columns
 *   4 = 2×2 grid
 *  >4 = automatic grid (ceil-sqrt columns × rows)
 */
export function computeTilingLayout(count: number, sw?: number, sh?: number): TilingLayout {
    const display = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = sw && sh
        ? { width: sw, height: sh }
        : display.workAreaSize

    if (count <= 0) {
        return { rects: [], screenWidth, screenHeight, columns: 0, rows: 0 }
    }

    let columns: number
    let rows: number

    if (count === 1) {
        columns = 1; rows = 1
    } else if (count === 2) {
        columns = 2; rows = 1
    } else if (count === 3) {
        columns = 3; rows = 1
    } else if (count === 4) {
        columns = 2; rows = 2
    } else {
        columns = Math.ceil(Math.sqrt(count))
        rows = Math.ceil(count / columns)
    }

    const cellWidth = Math.floor(screenWidth / columns)
    const cellHeight = Math.floor(screenHeight / rows)

    const rects: TileRect[] = []
    for (let i = 0; i < count; i++) {
        const col = i % columns
        const row = Math.floor(i / columns)
        rects.push({
            x: col * cellWidth,
            y: row * cellHeight,
            width: cellWidth,
            height: cellHeight,
        })
    }

    return { rects, screenWidth, screenHeight, columns, rows }
}

/**
 * Apply tiling layout to Playwright browser contexts using CDP.
 * Each context gets a window position + viewport matching its tile rect.
 */
export async function applyTilingToContexts(
    contexts: Map<number, { pages: () => any[] }>,
    layout?: TilingLayout
): Promise<{ applied: number; errors: string[] }> {
    const contextEntries = Array.from(contexts.entries())
    const count = contextEntries.length

    if (count === 0) {
        return { applied: 0, errors: [] }
    }

    const tiling = layout || computeTilingLayout(count)
    const errors: string[] = []
    let applied = 0

    for (let i = 0; i < contextEntries.length; i++) {
        const [contextId, context] = contextEntries[i]
        const rect = tiling.rects[i]
        if (!rect) continue

        try {
            await applyRectToContext(context, rect)
            applied++
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            errors.push(`Context ${contextId}: ${message}`)
        }
    }

    return { applied, errors }
}

async function applyRectToContext(context: { pages: () => any[] }, rect: TileRect): Promise<void> {
    const pages = context.pages()
    if (!pages || pages.length === 0) {
        throw new Error('No page available to tile')
    }

    const page = pages[0]
    const cdpSession = await page.context().newCDPSession(page)
    try {
        const { windowId } = await cdpSession.send('Browser.getWindowForTarget')
        await cdpSession.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
                windowState: 'normal',
            },
        })
        await page.setViewportSize({
            width: Math.max(rect.width - 16, 400),
            height: Math.max(rect.height - 80, 300),
        })
    } finally {
        try { await cdpSession.detach() } catch { /* ignore */ }
    }
}

export class WindowTilingService {
    private enabled = true
    private lastAppliedSignature = ''

    setEnabled(value: boolean): void {
        this.enabled = value
    }

    isEnabled(): boolean {
        return this.enabled
    }

    getLayout(count: number): TilingLayout {
        return computeTilingLayout(count)
    }

    async apply(
        contexts: Map<number, { pages: () => any[] }>
    ): Promise<{ applied: number; errors: string[] }> {
        if (!this.enabled) {
            return { applied: 0, errors: ['tiling disabled'] }
        }

        const orderedIds = Array.from(contexts.keys())
        const signature = `count:${contexts.size}|ids:${orderedIds.join(',')}`
        if (signature === this.lastAppliedSignature && contexts.size > 0) {
            return { applied: 0, errors: [] }
        }

        this.lastAppliedSignature = signature
        return applyTilingToContexts(contexts)
    }

    async applyBySlots(
        targets: SlotTilingTarget[],
        totalSlots: number
    ): Promise<{ applied: number; errors: string[] }> {
        if (!this.enabled) {
            return { applied: 0, errors: ['tiling disabled'] }
        }

        const normalizedTotalSlots = Math.max(1, Math.floor(totalSlots))
        const normalizedTargets = targets
            .filter(target => Number.isInteger(target.slot) && target.slot >= 0 && target.slot < normalizedTotalSlots)
            .sort((a, b) => a.slot - b.slot)

        if (normalizedTargets.length === 0) {
            return { applied: 0, errors: [] }
        }

        const signature = `slots:${normalizedTotalSlots}|${normalizedTargets.map(t => `${t.slot}:${t.contextId}`).join('|')}`
        if (signature === this.lastAppliedSignature) {
            return { applied: 0, errors: [] }
        }

        const layout = computeTilingLayout(normalizedTotalSlots)
        const errors: string[] = []
        let applied = 0

        for (const target of normalizedTargets) {
            const rect = layout.rects[target.slot]
            if (!rect) {
                continue
            }
            try {
                await applyRectToContext(target.context, rect)
                applied++
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err)
                errors.push(`Context ${target.contextId} (slot ${target.slot}): ${message}`)
            }
        }

        this.lastAppliedSignature = signature
        return { applied, errors }
    }

    reset(): void {
        this.lastAppliedSignature = ''
    }
}

export const windowTilingService = new WindowTilingService()
