/** Offline Electron + real Chrome lifecycle soak; never uses production userData. */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { _electron } = require('playwright')

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const minutes = Number(arg('minutes') || 3)
assert(Number.isFinite(minutes) && minutes > 0 && minutes <= 1440, 'minutes must be in (0, 1440]')
const parallel = Number(arg('parallel') || 3)
assert(Number.isInteger(parallel) && parallel >= 2 && parallel <= 32, 'parallel fixture size must be between 2 and 32')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('output', 'performance-soak', runId)
const userData = path.join(os.tmpdir(), 'mmo-packaged-smoke', `performance-${runId}`, 'user-data')
const executable = arg('executable') && path.resolve(arg('executable'))
const result = {
  ok: false, status: 'starting', startedAt: new Date().toISOString(), minutes, parallel, outDir, userData,
  host: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryMB: Math.round(os.totalmem() / 1048576) },
  simulatedMemory: { totalMB: 8192, normalFreeMB: 1700, pressuredFreeMB: 500 },
  cpuThrottle: Number(arg('cpu-throttle') || 1), cycles: 0, samples: [], pageErrors: [],
  gates: {},
}
assert(Number.isFinite(result.cpuThrottle) && result.cpuThrottle >= 1 && result.cpuThrottle <= 20, 'cpu-throttle must be between 1 and 20')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
const persist = () => {
  result.updatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  let electron
  persist()
  try {
    const env = { ...process.env, MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: userData }
    if (arg('diagnostics') === 'true') env.DEBUG = 'pw:browser'
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({
      executablePath: executable || require('electron'),
      args: [...(executable ? [] : ['.']), `--user-data-dir=${userData}`],
      cwd: executable ? path.dirname(executable) : process.cwd(), env, timeout: 120_000,
    })
    if (arg('diagnostics') === 'true') {
      for (const stream of [electron.process().stdout, electron.process().stderr]) {
        stream?.on('data', chunk => fs.appendFileSync(path.join(outDir, 'isolated-runtime.log'), chunk))
      }
    }
    const page = await electron.firstWindow({ timeout: 60_000 })
    page.on('pageerror', error => { result.pageErrors.push(String(error)); persist() })
    await page.waitForFunction(() => Boolean(window.electronAPI?.performance))
    const actualRoot = await page.evaluate(async () => (await window.electronAPI.getPaths()).userData)
    assert.equal(path.resolve(actualRoot).toLowerCase(), path.resolve(userData).toLowerCase(), 'Refusing non-isolated userData')
    if (result.cpuThrottle > 1) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: result.cpuThrottle })
    }

    await page.locator('nav').getByRole('button', { name: /^(Settings|Cài đặt)$/i }).click()
    const toggle = page.getByTestId('low-resource-mode').getByRole('switch')
    await toggle.waitFor()
    await page.getByRole('button', { name: 'VI', exact: true }).click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    await page.getByTitle(/^(Save Settings|Lưu cài đặt)$/i).click()
    await page.waitForFunction(() => document.documentElement.dataset.lowResourceMode === 'true')
    await page.reload()
    await page.waitForFunction(async () => (await window.electronAPI.performance.getStatus()).enabled === true)
    await page.locator('nav').getByRole('button', { name: /^(Settings|Cài đặt)$/i }).click()
    await page.getByTestId('low-resource-mode').getByRole('switch').waitFor()
    assert.equal(await page.getByTestId('low-resource-mode').getByRole('switch').getAttribute('aria-checked'), 'true')
    await page.screenshot({ path: path.join(outDir, 'low-resource-settings.png'), fullPage: false, scale: 'css' })
    result.gates.uiToggleSavedAndReloaded = true

    // Resolve the actual bundled service, with an injected 8 GB memory sample.
    // This models pressure deterministically without allocating the user's RAM.
    const mainDir = executable
      ? path.join(path.dirname(executable), 'resources', 'app', 'dist-electron', 'main')
      : path.resolve('dist-electron', 'main')
    await electron.evaluate(async ({ app }, moduleRoot) => {
      const nodeRequire = process.mainModule.require('node:module').createRequire(process.mainModule.filename)
      // Use the running app's module graph, never an obsolete hashed build chunk.
      const modules = Object.values(nodeRequire.cache).filter(module => module.filename.startsWith(moduleRoot)
        && /^BrowserService-.*\.js$/.test(nodeRequire('node:path').basename(module.filename)))
      const shared = modules.flatMap(module => Object.values(module.exports))
        .find(value => value && typeof value.createEphemeralContext === 'function')
      if (!shared?.governor) throw new Error('Bundled browser service not found')
      const memory = { freeMB: 500, totalMB: 8192 }
      const governor = new shared.governor.constructor(() => memory)
      governor.configure(true)
      globalThis.__mmoPerfFixture = { service: new shared.constructor(governor), governor, memory, profile: nodeRequire('node:path').join(app.getPath('userData'), 'performance-profile') }
    }, mainDir)
    const pressured = await electron.evaluate(async (_, count) => {
      const fixture = globalThis.__mmoPerfFixture
      const ids = await Promise.all(Array.from({ length: count }, () =>
        fixture.service.createEphemeralContext({ headless: true })))
      try {
        await Promise.all(ids.map(id => fixture.service.getPage(id).setContent('<h1>Parallel offline fixture</h1>')))
        return fixture.governor.getSnapshot()
      } finally { await Promise.all(ids.map(id => fixture.service.closeContext(id))) }
    }, parallel)
    assert.equal(pressured.activeContexts, parallel)
    assert.equal(pressured.queuedLaunches, 0)
    assert.equal(pressured.maxContexts, null)
    assert.equal(pressured.memoryPressure, true)
    result.gates.lowMemoryDoesNotDelayParallelBrowsers = true
    result.status = 'running'
    persist()

    const deadline = Date.now() + minutes * 60_000
    while (Date.now() < deadline) {
      const sample = await electron.evaluate(async ({ app }, { cycle, cpuThrottle, parallel }) => {
        const fixture = globalThis.__mmoPerfFixture
        fixture.memory.freeMB = cycle % 2 ? 500 : 1700
        const ids = await Promise.all(Array.from({ length: parallel }, (_, index) =>
          index === 0
            ? fixture.service.createContext({ headless: true, profilePath: fixture.profile })
            : fixture.service.createEphemeralContext({ headless: true })))
        try {
          await Promise.all(ids.map(async id => {
            const browserPage = fixture.service.getPage(id)
            if (cpuThrottle > 1) {
              const cdp = await browserPage.context().newCDPSession(browserPage)
              await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
            }
            await browserPage.setContent('<html><body><h1>Offline fixture</h1>' + '<p>Local lifecycle verification</p>'.repeat(300) + '</body></html>')
            if (await browserPage.locator('p').count() !== 300) throw new Error('Real browser page did not render')
          }))
          const controller = new AbortController()
          controller.abort()
          const cancelled = await fixture.service.createEphemeralContext({ headless: true, signal: controller.signal }).catch(error => error.name)
          if (cancelled !== 'BrowserResourceWaitError') throw new Error('Cancelled launch was admitted')
          const snapshot = fixture.governor.getSnapshot()
          if (snapshot.activeContexts !== parallel || snapshot.queuedLaunches !== 0 || snapshot.maxContexts !== null) {
            throw new Error('Low-resource mode changed requested parallelism')
          }
          return { at: new Date().toISOString(), activeContexts: snapshot.activeContexts,
            mainRssMB: Math.round(process.memoryUsage().rss / 1048576), mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
            electronWorkingSetMB: Math.round(app.getAppMetrics().reduce((sum, item) => sum + (item.memory?.workingSetSize || 0), 0) / 1024) }
        } finally { await Promise.all(ids.map(id => fixture.service.closeContext(id))) }
      }, { cycle: result.cycles, cpuThrottle: result.cpuThrottle, parallel })
      result.samples.push(sample)
      result.cycles += 1
      persist()
      if (result.cycles % 10 === 0) console.log(JSON.stringify({ cycles: result.cycles, elapsedSeconds: Math.round((Date.now() - Date.parse(result.startedAt)) / 1000), ...sample }))
    }

    await sleep(31_000)
    const final = await electron.evaluate(() => {
      const fixture = globalThis.__mmoPerfFixture
      return { ...fixture.governor.getSnapshot(), sharedBrowserReclaimed: fixture.service.browser === null }
    })
    assert.equal(final.activeContexts, 0)
    assert.equal(final.queuedLaunches, 0)
    assert.equal(final.sharedBrowserReclaimed, true)
    result.gates.idleBrowserReclaimed = true
    result.gates.noLeakedContextsOrWaiters = true
    result.gates.configuredParallelismPreserved = true
    const first = result.samples.slice(2, 7)
    const last = result.samples.slice(-5)
    const mean = (values, key) => values.reduce((sum, value) => sum + value[key], 0) / Math.max(1, values.length)
    result.memory = { firstSteadyMainHeapMB: mean(first, 'mainHeapMB'), lastMainHeapMB: mean(last, 'mainHeapMB'),
      maxMainRssMB: Math.max(...result.samples.map(value => value.mainRssMB)),
      maxElectronWorkingSetMB: Math.max(...result.samples.map(value => value.electronWorkingSetMB)) }
    assert(result.memory.lastMainHeapMB - result.memory.firstSteadyMainHeapMB < 128, 'Main heap grew more than 128 MB during the soak')
    result.gates.boundedMainHeapGrowth = true

    await page.getByTestId('low-resource-mode').getByRole('switch').click()
    await page.getByTitle(/^(Save Settings|Lưu cài đặt)$/i).click()
    await page.waitForFunction(async () => (await window.electronAPI.performance.getStatus()).enabled === false)
    result.gates.uiToggleOffRestoresMode = true
    assert.equal(result.pageErrors.length, 0)
    result.ok = true
  } catch (error) {
    result.error = error.stack || String(error)
    process.exitCode = 1
  } finally {
    if (electron) {
      await electron.evaluate(async () => { await globalThis.__mmoPerfFixture?.service.closeBrowser() }).catch(() => {})
      await electron.close().catch(() => {})
    }
    result.completedAt = new Date().toISOString()
    result.status = result.ok ? 'completed' : 'failed'
    persist()
    console.log(JSON.stringify({ ...result, samples: `${result.samples.length} samples; see result.json` }, null, 2))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
