import http from 'http'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { chromium } from 'playwright'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEBUG_HTML = join(ROOT, 'debug', 'agentic-test.html')
const OUTPUT_DIR = join(ROOT, 'output', 'playwright')
const PORT = 4173
const HOST = '127.0.0.1'
const MAX_STEPS = 4
const LLM_TIMEOUT_MS = 12000

mkdirSync(OUTPUT_DIR, { recursive: true })

function loadSettings() {
  try {
    return JSON.parse(readFileSync(join(process.env.APPDATA, 'mmo-auto-review', 'settings.json'), 'utf-8'))
  } catch {
    return {
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen2.5:latest',
    }
  }
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, '').replace('localhost', '127.0.0.1')
}

function summarizeElementText(element) {
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

function pickFallbackAction(summaries, stepCount) {
  const keywordRules = [
    { pattern: /(photo|photos|ảnh)/i, thought: 'Open the photos section to explore the place naturally.' },
    { pattern: /(review|reviews|đánh giá)/i, thought: 'Open the reviews section to simulate reading feedback.' },
    { pattern: /(about|overview|giới thiệu)/i, thought: 'Open the about section to inspect more details.' },
    { pattern: /(website|trang web)/i, thought: 'Open the website option for a realistic exploration flow.' },
    { pattern: /(direction|directions|chỉ đường)/i, thought: 'Directions are a common next interaction for map browsing.' },
  ]

  for (const rule of keywordRules) {
    const match = summaries.find(summary => rule.pattern.test(summarizeElementText(summary)))
    if (match) {
      return { thought: rule.thought, action: 'click', element_id: match.id, source: 'heuristic' }
    }
  }

  if (stepCount >= 3) {
    return { thought: 'Enough actions were performed on the local test page.', action: 'finish', source: 'heuristic' }
  }

  return { thought: 'Scroll further to inspect more of the local page.', action: 'scroll_down', source: 'heuristic' }
}

async function extractInteractiveDOM(page) {
  const extractedData = await page.evaluate((attributeName) => {
    document.querySelectorAll(`[${attributeName}]`).forEach(el => el.removeAttribute(attributeName))

    const nodes = document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [contenteditable="true"]')
    const data = []
    let idCounter = 1

    for (const node of Array.from(nodes)) {
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue

      const style = window.getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue

      const htmlEl = node
      const textContent = (htmlEl.innerText || htmlEl.value || '').trim()
      const ariaLabel = htmlEl.getAttribute('aria-label') || undefined
      const placeholder = htmlEl.getAttribute('placeholder') || undefined
      const title = htmlEl.getAttribute('title') || undefined

      if (!textContent && !ariaLabel && !placeholder && !title) continue

      const currentId = idCounter++
      htmlEl.setAttribute(attributeName, String(currentId))

      data.push({
        id: currentId,
        tagName: htmlEl.tagName.toLowerCase(),
        textContent,
        ariaLabel,
        placeholder,
        title,
        role: htmlEl.getAttribute('role') || undefined,
        href: htmlEl.getAttribute('href') || undefined,
      })
    }

    return data
  }, 'data-ai-id')

  return {
    domText: extractedData.map(item => `[ID: ${item.id}] <${item.tagName}>${(item.textContent || item.ariaLabel || item.placeholder || item.title || '').replace(/\r?\n|\r/g, ' ')}</${item.tagName}>`).join('\n'),
    summaries: extractedData,
  }
}

async function decideAction(domSnapshot, settings, stepCount) {
  const url = `${normalizeBaseUrl(settings.ollamaUrl || 'http://127.0.0.1:11434')}/api/chat`
  const requestBody = {
    model: settings.ollamaModel || 'qwen2.5:latest',
    messages: [
      {
        role: 'system',
        content: `You are an autonomous browser agent. Respond only with valid JSON:
{
  "thought": "short reasoning",
  "action": "click" | "wait" | "scroll_down" | "scroll_up" | "finish" | "fail",
  "element_id": number
}

Interactive elements:
${domSnapshot.domText}`,
      },
      {
        role: 'user',
        content: 'Choose the next natural browsing step on this local smoke test page.',
      },
    ],
    stream: false,
    format: 'json',
    options: {
      temperature: 0.1,
      top_p: 0.9,
    },
  }

  try {
    const startedAt = Date.now()
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })

    const rawText = await response.text()
    if (!response.ok) {
      return {
        ...pickFallbackAction(domSnapshot.summaries, stepCount),
        reason: `http_${response.status}:${rawText}`,
        elapsedMs: Date.now() - startedAt,
      }
    }

    const payload = JSON.parse(rawText)
    const actionData = JSON.parse(payload.message.content.trim())
    return {
      ...actionData,
      source: 'llm',
      elapsedMs: Date.now() - startedAt,
      rawText,
    }
  } catch (error) {
    return {
      ...pickFallbackAction(domSnapshot.summaries, stepCount),
      reason: error instanceof Error ? error.message : String(error),
      elapsedMs: 0,
    }
  }
}

async function run() {
  const html = readFileSync(DEBUG_HTML, 'utf-8')
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })

  await new Promise(resolve => server.listen(PORT, HOST, resolve))

  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const settings = loadSettings()
  const actionLog = []

  try {
    await page.goto(`http://${HOST}:${PORT}`, { waitUntil: 'domcontentloaded' })

    for (let step = 1; step <= MAX_STEPS; step++) {
      const domSnapshot = await extractInteractiveDOM(page)
      const decision = await decideAction(domSnapshot, settings, step)
      let executed = false

      if (decision.action === 'click' && typeof decision.element_id === 'number') {
        const locator = page.locator(`[data-ai-id="${decision.element_id}"]`).first()
        if (await locator.count()) {
          await locator.scrollIntoViewIfNeeded().catch(() => {})
          await locator.click({ timeout: 5000 }).catch(() => {})
          executed = true
        }
      } else if (decision.action === 'scroll_down') {
        await page.mouse.wheel(0, 700)
        await page.keyboard.press('PageDown').catch(() => {})
        executed = true
      } else if (decision.action === 'scroll_up') {
        await page.mouse.wheel(0, -700)
        await page.keyboard.press('PageUp').catch(() => {})
        executed = true
      } else if (decision.action === 'finish') {
        actionLog.push({ step, ...decision, executed: true })
        break
      }

      actionLog.push({ step, ...decision, executed })
      await page.waitForTimeout(1200)
    }

    await page.screenshot({ path: join(OUTPUT_DIR, 'agentic-smoke.png'), fullPage: true })
    writeFileSync(join(OUTPUT_DIR, 'agentic-smoke.json'), JSON.stringify(actionLog, null, 2))
    console.log(JSON.stringify({ ok: true, actionLog }, null, 2))
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    server.close()
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
