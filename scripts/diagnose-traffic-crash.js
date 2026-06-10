const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright')
const electronPath = require('electron')

const cwd = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(cwd, 'output', 'diagnose-traffic-crash', runId)
const userDataDir = path.join(outDir, 'user-data')
const imageDir = path.join(outDir, 'images')
const resultPath = path.join(outDir, 'result.json')

fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(imageDir, { recursive: true })

function serializeError(error) {
  if (!error) return 'unknown error'
  if (error.stack) return error.stack
  if (error.message) return error.message
  return String(error)
}

async function main() {
  let app
  const result = {
    ok: false,
    outDir,
    runId,
    pageErrors: [],
    consoleErrors: [],
    navigation: { sidebarFound: false, clicked: false, targetLabel: 'Traffic Booster' },
    screenshot: null,
    summary: '',
  }

  try {
    console.log('[diagnose] launching electron with isolated userData...')
    app = await _electron.launch({
      executablePath: electronPath,
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    })

    const page = await app.firstWindow({ timeout: 30_000 })
    console.log('[diagnose] firstWindow obtained')

    // Capture errors from the very beginning
    page.on('pageerror', (error) => {
      const serialized = serializeError(error)
      console.error('[pageerror]', serialized)
      result.pageErrors.push(serialized)
    })

    page.on('console', (message) => {
      if (message.type() === 'error') {
        const text = message.text()
        console.error('[console-error]', text)
        result.consoleErrors.push(text)
      }
    })

    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    await page.waitForFunction(
      () => typeof window.electronAPI === 'object' && !!window.electronAPI.settings,
      null,
      { timeout: 30_000 }
    )
    console.log('[diagnose] app bridge ready')

    // Give React a moment to finish initial render of sidebar
    await page.waitForTimeout(600)

    // Find and click the Traffic Booster sidebar item
    const navResult = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('aside button'))
      const target = buttons.find((btn) => /traffic booster/i.test((btn.textContent || '').trim()))
      if (target) {
        target.click()
        return { found: true, clicked: true, text: (target.textContent || '').trim().slice(0, 80) }
      }
      return {
        found: buttons.length > 0,
        clicked: false,
        count: buttons.length,
        samples: buttons.slice(0, 3).map((b) => (b.textContent || '').trim().slice(0, 40)),
      }
    })

    result.navigation.sidebarFound = !!navResult.found
    result.navigation.clicked = !!navResult.clicked
    console.log('[diagnose] sidebar click result:', JSON.stringify(navResult))

    if (!navResult.clicked) {
      result.summary = 'Failed to locate "Traffic Booster" button in sidebar'
      // Still take a screenshot for diagnosis
    } else {
      // Wait for the Traffic page to mount and run its effects (getCampaigns, status, etc.)
      await page.waitForTimeout(2200)
    }

    // Capture a screenshot of the state after navigation attempt
    const shotPath = path.join(imageDir, 'after-traffic-click.png')
    try {
      await page.screenshot({ path: shotPath, fullPage: false })
      result.screenshot = shotPath
      console.log('[diagnose] screenshot saved:', shotPath)
    } catch (shotErr) {
      console.warn('[diagnose] screenshot failed:', String(shotErr))
    }

    // Optional: try to detect if a main content area for traffic rendered
    const hasTrafficContent = await page.evaluate(() => {
      const main = document.querySelector('main')
      if (!main) return false
      const txt = (main.textContent || '').toLowerCase()
      return txt.includes('traffic') || txt.includes('booster') || txt.includes('campaign')
    }).catch(() => false)

    result.navigation.hasTrafficContent = hasTrafficContent

    const totalErrors = result.pageErrors.length + result.consoleErrors.length
    result.ok = totalErrors === 0 && result.navigation.clicked
    result.summary = result.navigation.clicked
      ? (totalErrors === 0 ? 'Traffic Booster navigation succeeded with no captured errors' : `Captured ${totalErrors} error(s) after clicking Traffic Booster`)
      : 'Could not click Traffic Booster sidebar item'

    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')

    // Human readable console output
    console.log('\n================ DIAGNOSE TRAFFIC CRASH RESULT ================')
    console.log('ok:', result.ok)
    console.log('outDir:', outDir)
    console.log('navigation:', result.navigation)
    console.log('pageErrors count:', result.pageErrors.length)
    if (result.pageErrors.length) {
      console.log('--- PAGE ERRORS (uncaught / React) ---')
      result.pageErrors.forEach((e, i) => console.log(`[${i + 1}]`, e))
    }
    console.log('consoleErrors count:', result.consoleErrors.length)
    if (result.consoleErrors.length) {
      console.log('--- CONSOLE ERRORS ---')
      result.consoleErrors.forEach((e, i) => console.log(`[${i + 1}]`, e))
    }
    console.log('screenshot:', result.screenshot)
    console.log('summary:', result.summary)
    console.log('result json:', resultPath)
    console.log('==============================================================\n')

    if (!result.ok) {
      process.exitCode = 1
    }
  } catch (error) {
    result.error = serializeError(error)
    result.ok = false
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')
    console.error('\n[diagnose] FATAL:', result.error)
    console.error('result json:', resultPath)
    process.exitCode = 1
  } finally {
    if (app) {
      await app.close().catch(() => {})
    }
  }
}

main()
