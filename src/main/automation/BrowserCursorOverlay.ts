import { Page } from 'playwright'

/**
 * BrowserCursorOverlay — Inject a visible fake cursor into Playwright pages.
 * The cursor animates to every mouse position so the user can see what the bot is doing.
 */

const CURSOR_INJECT_SCRIPT = `
(function() {
    if (document.getElementById('__mmo_cursor')) return;

    // --- Cursor element ---
    const cursor = document.createElement('div');
    cursor.id = '__mmo_cursor';
    cursor.innerHTML = \`
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z"
                  fill="#FFD600" stroke="#000" stroke-width="1.2"/>
        </svg>
    \`;
    Object.assign(cursor.style, {
        position: 'fixed',
        top: '0px',
        left: '0px',
        width: '24px',
        height: '24px',
        zIndex: '2147483647',
        pointerEvents: 'none',
        transition: 'transform 0.12s cubic-bezier(0.25, 0.1, 0.25, 1)',
        transform: 'translate(-100px, -100px)',
        filter: 'drop-shadow(1px 2px 2px rgba(0,0,0,0.5))',
    });
    document.documentElement.appendChild(cursor);

    // --- Click ripple element ---
    const ring = document.createElement('div');
    ring.id = '__mmo_click_ring';
    Object.assign(ring.style, {
        position: 'fixed',
        width: '20px',
        height: '20px',
        borderRadius: '50%',
        border: '2px solid #FFD600',
        zIndex: '2147483646',
        pointerEvents: 'none',
        opacity: '0',
        transform: 'translate(-50%, -50%) scale(1)',
        transition: 'none',
    });
    document.documentElement.appendChild(ring);

    // --- Expose global move/click helpers ---
    window.__mmoCursorMoveTo = function(x, y) {
        cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    };

    window.__mmoCursorClick = function(x, y) {
        // Move cursor
        cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';

        // Show click ripple
        ring.style.transition = 'none';
        ring.style.opacity = '1';
        ring.style.left = x + 'px';
        ring.style.top = y + 'px';
        ring.style.transform = 'translate(-50%, -50%) scale(1)';

        // Force reflow
        ring.offsetHeight;

        // Animate expand + fade out
        ring.style.transition = 'transform 0.35s ease-out, opacity 0.35s ease-out';
        ring.style.transform = 'translate(-50%, -50%) scale(3)';
        ring.style.opacity = '0';
    };
})();
`

/**
 * Inject the fake cursor overlay into a page.
 * Safe to call multiple times (idempotent).
 */
export async function injectCursorOverlay(page: Page): Promise<void> {
    try {
        await page.evaluate(CURSOR_INJECT_SCRIPT)
    } catch { /* page might be closed or navigating */ }
}

/**
 * Move the fake cursor to (x, y) on the page.
 * Call this before page.mouse.move() for visual feedback.
 */
export async function moveCursor(page: Page, x: number, y: number): Promise<void> {
    try {
        await page.evaluate(
            ([cx, cy]) => {
                if (typeof (window as any).__mmoCursorMoveTo === 'function') {
                    (window as any).__mmoCursorMoveTo(cx, cy)
                }
            },
            [x, y] as [number, number]
        )
    } catch { /* ignore */ }
}

/**
 * Show a click effect at (x, y) on the page.
 * Call this before page.mouse.click() for visual feedback.
 */
export async function clickCursor(page: Page, x: number, y: number): Promise<void> {
    try {
        await page.evaluate(
            ([cx, cy]) => {
                if (typeof (window as any).__mmoCursorClick === 'function') {
                    (window as any).__mmoCursorClick(cx, cy)
                }
            },
            [x, y] as [number, number]
        )
        // Short delay so the user can see the cursor arrive before actual click
        await new Promise(r => setTimeout(r, 80))
    } catch { /* ignore */ }
}

/**
 * Re-inject cursor overlay after navigation (pages lose injected DOM on navigate).
 * Use this as a page event listener.
 */
export function setupAutoReinject(page: Page): void {
    page.on('load', async () => {
        try { await injectCursorOverlay(page) } catch { /* ignore */ }
    })
}
