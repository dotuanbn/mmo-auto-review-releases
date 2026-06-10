const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright')
const electronPath = require('electron')

const cwd = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(cwd, 'output', 'maps-kpi-smoke', runId)
const userDataDir = path.join(outDir, 'user-data')
const resultPath = path.join(outDir, 'result.json')

fs.mkdirSync(outDir, { recursive: true })

function serializeError(error) {
  return error && error.stack ? error.stack : String(error)
}

async function main() {
  let app
  const result = {
    ok: false,
    outDir,
    campaignId: null,
    status: null,
    report: null,
    trace: [],
    failedAssertions: [],
    pageErrors: [],
    consoleErrors: [],
  }

  try {
    app = await _electron.launch({
      executablePath: electronPath,
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    })

    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', error => result.pageErrors.push(serializeError(error)))
    page.on('console', message => {
      if (message.type() === 'error') result.consoleErrors.push(message.text())
    })

    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    await page.waitForFunction(
      () => typeof window.electronAPI === 'object' && !!window.electronAPI.trafficBoost,
      null,
      { timeout: 30_000 }
    )

    async function callApi(fn, arg) {
      let lastError
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const activePage = app.windows()[0] || await app.firstWindow({ timeout: 10_000 })
          await activePage.waitForFunction(
            () => typeof window.electronAPI === 'object' && !!window.electronAPI.trafficBoost,
            null,
            { timeout: 20_000 }
          )
          return await activePage.evaluate(fn, arg)
        } catch (error) {
          lastError = error
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      throw lastError
    }

    await callApi(async () => {
      const api = window.electronAPI
      await api.settings.set('headless', false)
      await api.settings.set('hideAutomation', true)
      await api.settings.set('maxConcurrentBrowsers', 1)
    })

    const location = await callApi(async () => {
      return window.electronAPI.locations.add({
        name: `KAFF Maps KPI Smoke ${Date.now()}`,
        url: 'https://www.google.com/maps/place/KAFF+Vi%E1%BB%87t+Nam/@21.031426,105.9155158,17z/data=!3m1!4b1!4m6!3m5!1s0x3135a99d20400035:0x9a2dbb5af97f9a07!8m2!3d21.031426!4d105.915518!16s%2Fg%2F11wcbkk_t5',
        address: '56 P. Vu Xuan Thieu, Phuc Loi, Ha Noi 100000, Vietnam',
        phone: '+84 876 611 567',
        website: 'https://kaffhanoi.vn',
        targetReviews: 1,
      })
    })

    const campaign = await callApi(async (locationId) => {
      return window.electronAPI.trafficBoost.createCampaign({
        name: `Maps KPI Smoke ${Date.now()}`,
        trafficMode: 'direct',
        accountIds: [],
        locationIds: [locationId],
        threadsCount: 1,
        visitsPerLocation: 1,
        delayMinSeconds: 0,
        delayMaxSeconds: 1,
        actionsPerVisit: 4,
        aiAutoControl: false,
      })
    }, location.id)

    await callApi(async (campaignId) => {
      return window.electronAPI.trafficBoost.start(campaignId)
    }, campaign.id)

    const deadline = Date.now() + 180_000
    let status = await callApi(async () => window.electronAPI.trafficBoost.getStatus())
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2500))
      status = await callApi(async () => window.electronAPI.trafficBoost.getStatus())
      const done = !status.isRunning && ((status.completedVisits || 0) + (status.failedVisits || 0) >= 1)
      if (done) break
    }

    const report = await callApi(async (campaignId) => {
      return window.electronAPI.trafficBoost.getReport(campaignId)
    }, campaign.id)
    const trace = await callApi(async (campaignId) => {
      return window.electronAPI.reports.getActionTrace({ campaignId, limit: 300 })
    }, campaign.id)
    const logs = await callApi(async (campaignId) => {
      return window.electronAPI.trafficBoost.getLogs(campaignId)
    }, campaign.id)

    const smoke = { campaign, status, report, trace, logs }

    result.campaignId = smoke.campaign.id
    result.status = smoke.status
    result.report = smoke.report
    result.trace = smoke.trace

    const traceText = JSON.stringify(smoke.trace) + JSON.stringify(smoke.logs)
    const assertions = [
      [smoke.status.completedVisits === 1, 'expected 1 completed visit'],
      [smoke.status.failedVisits === 0, 'expected 0 failed visits'],
      [/autonomous:kpi_direction/.test(traceText), 'missing direction KPI trace'],
      [/direction_origin_non_empty/.test(traceText), 'missing non-empty direction origin proof'],
      [/direction_route_ready/.test(traceText), 'missing route-ready proof'],
      [/autonomous:kpi_phone/.test(traceText), 'missing phone KPI trace'],
      [/phone_protocol_popup_/.test(traceText), 'missing phone protocol popup dismissal trace'],
      [!/semantic_candidate|warmup_zoom_map|warmup_pan_map|cooldown_pan_map|browse_random_click/.test(traceText), 'forbidden random/semantic action found'],
    ]

    for (const [ok, message] of assertions) {
      if (!ok) result.failedAssertions.push(message)
    }

    result.ok = result.failedAssertions.length === 0 && result.pageErrors.length === 0 && result.consoleErrors.length === 0
  } catch (error) {
    result.failedAssertions.push(serializeError(error))
  } finally {
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    if (app) await app.close().catch(() => {})
  }

  console.log(JSON.stringify({
    ok: result.ok,
    outDir,
    campaignId: result.campaignId,
    failedAssertions: result.failedAssertions,
    pageErrors: result.pageErrors.length,
    consoleErrors: result.consoleErrors.length,
  }, null, 2))

  if (!result.ok) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
