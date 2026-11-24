/** Offline Electron + real Chrome lifecycle soak; never uses production userData. */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { _electron } = require('playwright')

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const minutes = Number(arg('minutes') || 3)
assert(Number.isFinite(minutes) && minutes > 0 && minutes <= 44640, 'minutes must be in (0, 44640]')
const parallel = Number(arg('parallel') || 3)
assert(Number.isInteger(parallel) && parallel >= 2 && parallel <= 32, 'parallel fixture size must be between 2 and 32')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('output', 'performance-soak', runId)
const userData = path.join(os.tmpdir(), 'mmo-packaged-smoke', `performance-${runId}`, 'user-data')
const executable = arg('executable') && path.resolve(arg('executable'))

const SAMPLE_CAPACITY = 1024

const result = {
  ok: false,
  status: 'starting',
  startedAt: new Date().toISOString(),
  minutes,
  parallel,
  outDir,
  userData,
  runtimeMode: 'wall-clock',
  host: {
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / 1048576),
  },
  simulatedMemory: {
    totalMB: 8192,
    normalFreeMB: 1700,
    pressuredFreeMB: 500,
    type: 'simulated_governor_pressure',
    note: 'Injected governor telemetry; models pressure deterministically without allocating physical RAM',
  },
  cpuThrottle: Number(arg('cpu-throttle') || 1),
  cycles: 0,
  samples: [],
  sampleCapacity: SAMPLE_CAPACITY,
  onlinePeaks: {
    maxMainRssMB: 0,
    maxElectronWorkingSetMB: 0,
    maxMainHeapMB: 0,
  },
  totalPageErrors: 0,
  pageErrors: [],
  gates: {},
  launcher: null,
  exitOutcome: null,
  healthAtExit: null,
  errors: [],
}

assert(Number.isFinite(result.cpuThrottle) && result.cpuThrottle >= 1 && result.cpuThrottle <= 20, 'cpu-throttle must be between 1 and 20')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

const persist = () => {
  result.updatedAt = new Date().toISOString()
  result.elapsedSeconds = Math.round((Date.now() - Date.parse(result.startedAt)) / 1000)
  const tmp = path.join(outDir, 'result.json.tmp')
  const final = path.join(outDir, 'result.json')
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2))
  try {
    fs.renameSync(tmp, final)
  } catch {
    fs.writeFileSync(final, JSON.stringify(result, null, 2))
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function withTimeout(promise, timeoutMs, description = 'operation') {
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })
}

function waitForProcessClose(record, timeoutMs = 15000) {
  if (record.exited) {
    return Promise.resolve({ code: record.exitCode, signal: record.exitSignal })
  }
  return new Promise(resolve => {
    let timer = null
    const onClose = (code, signal) => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      record.child?.removeListener('close', onClose)
      resolve({ code, signal })
    }
    timer = setTimeout(() => {
      timer = null
      record.child?.removeListener('close', onClose)
      resolve({ timeout: true })
    }, timeoutMs)
    if (timer.unref) timer.unref()
    record.child?.once('close', onClose)
  })
}

function readHealthSnapshot(healthFilePath) {
  if (!fs.existsSync(healthFilePath)) return null
  try {
    const raw = fs.readFileSync(healthFilePath, 'utf8')
    if (!raw || !raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function main() {
  let electron = null
  const ownedLauncher = {
    child: null,
    launcherPid: null,
    mainPid: null,
    exited: false,
    exitCode: null,
    exitSignal: null,
    timeout: false,
  }

  persist()

  // Referenced keepalive interval to ensure Node event loop remains alive during async tests.
  // Also performs periodic deadline checks avoiding Node 32-bit setTimeout (> 2^31 ms) overflow for up to 44640 mins.
  const soakDurationMs = minutes * 60_000
  const overallDeadline = Date.now() + soakDurationMs + 300_000 // 5-minute setup/teardown allowance
  let overallDeadlineExceeded = false
  let overallDeadlineError = null

  const keepAlive = setInterval(() => {
    if (Date.now() > overallDeadline) {
      overallDeadlineExceeded = true
      overallDeadlineError = new Error(`Overall performance soak deadline (${minutes}m + 5m setup/teardown) exceeded`)
    }
  }, 5000)

  const checkOverallDeadline = () => {
    if (overallDeadlineExceeded) throw overallDeadlineError
  }

  try {
    const env = { ...process.env, MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: userData }
    if (arg('diagnostics') === 'true') env.DEBUG = 'pw:browser'
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({
      executablePath: executable || require('electron'),
      args: [...(executable ? [] : ['.']), `--user-data-dir=${userData}`],
      cwd: executable ? path.dirname(executable) : process.cwd(),
      env,
      timeout: 120_000,
    })

    const launcherChild = electron.process()
    ownedLauncher.child = launcherChild
    ownedLauncher.launcherPid = launcherChild.pid
    launcherChild.once('close', (code, signal) => {
      ownedLauncher.exited = true
      ownedLauncher.exitCode = code
      ownedLauncher.exitSignal = signal
    })

    const actualMainPid = await withTimeout(
      electron.evaluate(() => process.pid),
      15_000,
      'obtain actual main process PID'
    )
    ownedLauncher.mainPid = actualMainPid

    result.launcher = {
      launcherPid: ownedLauncher.launcherPid,
      mainPid: ownedLauncher.mainPid,
    }
    persist()

    if (arg('diagnostics') === 'true') {
      for (const stream of [electron.process().stdout, electron.process().stderr]) {
        stream?.on('data', chunk => fs.appendFileSync(path.join(outDir, 'isolated-runtime.log'), chunk))
      }
    }
    const page = await withTimeout(electron.firstWindow({ timeout: 60_000 }), 65_000, 'firstWindow')
    page.on('pageerror', error => {
      result.totalPageErrors += 1
      result.pageErrors.push(String(error))
      if (result.pageErrors.length > 20) {
        result.pageErrors.shift()
      }
      persist()
    })

    await withTimeout(
      page.waitForFunction(() => Boolean(window.electronAPI?.performance), null, { timeout: 30_000 }),
      35_000,
      'waitForFunction performance API'
    )
    const actualRoot = await withTimeout(
      page.evaluate(async () => (await window.electronAPI.getPaths()).userData),
      15_000,
      'evaluate getPaths'
    )
    assert.equal(path.resolve(actualRoot).toLowerCase(), path.resolve(userData).toLowerCase(), 'Refusing non-isolated userData')
    if (result.cpuThrottle > 1) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: result.cpuThrottle })
    }

    await withTimeout(page.locator('nav').getByRole('button', { name: /^(Settings|Cài đặt)$/i }).click(), 15_000, 'click settings nav')
    const toggle = page.getByTestId('low-resource-mode').getByRole('switch')
    await withTimeout(toggle.waitFor({ timeout: 15_000 }), 15_000, 'wait for toggle')
    await withTimeout(page.getByRole('button', { name: 'VI', exact: true }).click(), 10_000, 'click VI')
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await withTimeout(toggle.click(), 10_000, 'toggle click')
    await withTimeout(page.getByTitle(/^(Save Settings|Lưu cài đặt)$/i).click(), 10_000, 'save settings click')
    await withTimeout(
      page.waitForFunction(() => document.documentElement.dataset.lowResourceMode === 'true', null, { timeout: 15_000 }),
      15_000,
      'wait for lowResourceMode dataset'
    )
    await withTimeout(page.reload(), 30_000, 'page reload')
    await withTimeout(
      page.waitForFunction(async () => (await window.electronAPI.performance.getStatus()).enabled === true, null, { timeout: 15_000 }),
      15_000,
      'wait for performance enabled'
    )
    await withTimeout(page.locator('nav').getByRole('button', { name: /^(Settings|Cài đặt)$/i }).click(), 15_000, 'click settings nav post-reload')
    await withTimeout(page.getByTestId('low-resource-mode').getByRole('switch').waitFor({ timeout: 15_000 }), 15_000, 'wait for toggle post-reload')
    assert.equal(await page.getByTestId('low-resource-mode').getByRole('switch').getAttribute('aria-checked'), 'true')
    await withTimeout(page.screenshot({ path: path.join(outDir, 'low-resource-settings.png'), fullPage: false, scale: 'css' }), 15_000, 'screenshot')
    result.gates.uiToggleSavedAndReloaded = true

    // Resolve the actual bundled service, with an injected 8 GB memory sample.
    // This models pressure deterministically without allocating the user's RAM.
    const mainDir = executable
      ? path.join(path.dirname(executable), 'resources', 'app', 'dist-electron', 'main')
      : path.resolve('dist-electron', 'main')
    await withTimeout(electron.evaluate(async ({ app }, moduleRoot) => {
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
    }, mainDir), 60_000, 'setup bundled browser service fixture')

    const pressured = await withTimeout(electron.evaluate(async (_, count) => {
      const fixture = globalThis.__mmoPerfFixture
      const ids = await Promise.all(Array.from({ length: count }, () =>
        fixture.service.createEphemeralContext({ headless: true })))
      try {
        await Promise.all(ids.map(id => fixture.service.getPage(id).setContent('<h1>Parallel offline fixture</h1>')))
        return fixture.governor.getSnapshot()
      } finally { await Promise.all(ids.map(id => fixture.service.closeContext(id))) }
    }, parallel), 120_000, 'pressured context creation')

    assert.equal(pressured.activeContexts, parallel)
    assert.equal(pressured.queuedLaunches, 0)
    assert.equal(pressured.maxContexts, null)
    assert.equal(pressured.memoryPressure, true)
    result.gates.lowMemoryDoesNotDelayParallelBrowsers = true
    result.status = 'running'
    persist()

    const firstSteadySamples = []
    const lastSamples = []
    let lastPersistTime = Date.now()

    const soakEnd = Date.now() + soakDurationMs
    while (Date.now() < soakEnd) {
      checkOverallDeadline()
      const sample = await withTimeout(electron.evaluate(async ({ app }, { cycle, cpuThrottle, parallel }) => {
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
          return {
            at: new Date().toISOString(),
            activeContexts: snapshot.activeContexts,
            mainRssMB: Math.round(process.memoryUsage().rss / 1048576),
            mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
            electronWorkingSetMB: Math.round(app.getAppMetrics().reduce((sum, item) => sum + (item.memory?.workingSetSize || 0), 0) / 1024),
          }
        } finally { await Promise.all(ids.map(id => fixture.service.closeContext(id))) }
      }, { cycle: result.cycles, cpuThrottle: result.cpuThrottle, parallel }), 120_000, `cycle ${result.cycles} sample`)

      // Track online peaks across entire run
      result.onlinePeaks.maxMainRssMB = Math.max(result.onlinePeaks.maxMainRssMB, sample.mainRssMB)
      result.onlinePeaks.maxElectronWorkingSetMB = Math.max(result.onlinePeaks.maxElectronWorkingSetMB, sample.electronWorkingSetMB)
      result.onlinePeaks.maxMainHeapMB = Math.max(result.onlinePeaks.maxMainHeapMB, sample.mainHeapMB)

      // Capture first steady-state samples (cycles 2 through 6)
      if (result.cycles >= 2 && result.cycles <= 6) {
        firstSteadySamples.push(sample)
      }

      // Maintain trailing window of samples
      lastSamples.push(sample)
      if (lastSamples.length > 5) {
        lastSamples.shift()
      }

      // Retain samples in bounded ring buffer
      result.samples.push(sample)
      if (result.samples.length > SAMPLE_CAPACITY) {
        result.samples.shift()
      }

      result.cycles += 1

      // Bounded incremental persistence
      const now = Date.now()
      if (result.cycles === 1 || result.cycles % 10 === 0 || (now - lastPersistTime >= 30_000)) {
        lastPersistTime = now
        persist()
      }

      if (result.cycles % 10 === 0) {
        console.log(JSON.stringify({
          cycles: result.cycles,
          elapsedSeconds: Math.round((now - Date.parse(result.startedAt)) / 1000),
          ...sample,
        }))
      }
    }

    checkOverallDeadline()
    await sleep(31_000)
    const final = await withTimeout(electron.evaluate(() => {
      const fixture = globalThis.__mmoPerfFixture
      return { ...fixture.governor.getSnapshot(), sharedBrowserReclaimed: fixture.service.browser === null }
    }), 60_000, 'final governor reclaim evaluation')
    assert.equal(final.activeContexts, 0)
    assert.equal(final.queuedLaunches, 0)
    assert.equal(final.sharedBrowserReclaimed, true)
    result.gates.idleBrowserReclaimed = true
    result.gates.noLeakedContextsOrWaiters = true
    result.gates.configuredParallelismPreserved = true

    const first = firstSteadySamples.length >= 3
      ? firstSteadySamples
      : result.samples.slice(0, Math.min(5, result.samples.length))
    const last = lastSamples.length > 0 ? lastSamples : result.samples.slice(-5)
    const mean = (values, key) => values.reduce((sum, value) => sum + value[key], 0) / Math.max(1, values.length)
    result.memory = {
      firstSteadyMainHeapMB: mean(first, 'mainHeapMB'),
      lastMainHeapMB: mean(last, 'mainHeapMB'),
      maxMainRssMB: result.onlinePeaks.maxMainRssMB,
      maxElectronWorkingSetMB: result.onlinePeaks.maxElectronWorkingSetMB,
    }
    assert(result.memory.lastMainHeapMB - result.memory.firstSteadyMainHeapMB < 128, 'Main heap grew more than 128 MB during the soak')
    result.gates.boundedMainHeapGrowth = true

    await withTimeout(page.getByTestId('low-resource-mode').getByRole('switch').click(), 10_000, 'toggle off low resource mode')
    await withTimeout(page.getByTitle(/^(Save Settings|Lưu cài đặt)$/i).click(), 10_000, 'save settings after toggle off')
    await withTimeout(
      page.waitForFunction(async () => (await window.electronAPI.performance.getStatus()).enabled === false, null, { timeout: 15_000 }),
      15_000,
      'wait for performance disabled'
    )
    result.gates.uiToggleOffRestoresMode = true
    assert.equal(result.totalPageErrors, 0, `Encountered ${result.totalPageErrors} page error(s) during soak: ${JSON.stringify(result.pageErrors)}`)
    result.ok = true
  } catch (error) {
    result.ok = false
    result.error = error.stack || String(error)
    process.exitCode = 1
  } finally {
    if (electron) {
      try {
        await withTimeout(
          electron.evaluate(async () => { await globalThis.__mmoPerfFixture?.service.closeBrowser() }),
          15_000,
          'closeBrowser'
        )
      } catch (cleanupErr) {
        result.cleanupError = (result.cleanupError ? result.cleanupError + '; ' : '') + (cleanupErr.stack || String(cleanupErr))
        result.ok = false
      }

      const closePromise = waitForProcessClose(ownedLauncher, 15_000)
      try {
        // Request native app.quit() while retaining inspector connection until exit (do not use SDK electronApp.close())
        await withTimeout(
          electron.evaluate(({ app }) => {
            app.quit()
          }).catch(err => {
            // Expected transport disconnection as native process terminates
            return { transportClosed: true, error: String(err) }
          }),
          10_000,
          'app.quit()'
        )
      } catch (cleanupErr) {
        result.cleanupError = (result.cleanupError ? result.cleanupError + '; ' : '') + (cleanupErr.stack || String(cleanupErr))
        result.ok = false
      }

      const exitOutcome = await closePromise
      if (exitOutcome.timeout) {
        ownedLauncher.timeout = true
        // Fallback kill of ONLY the owned child process handle (never unverified numeric PID)
        try {
          ownedLauncher.child?.kill()
        } catch {}
        await waitForProcessClose(ownedLauncher, 5000)
      }

      result.exitOutcome = {
        launcherPid: ownedLauncher.launcherPid,
        mainPid: ownedLauncher.mainPid,
        exited: ownedLauncher.exited,
        exitCode: ownedLauncher.exitCode,
        exitSignal: ownedLauncher.exitSignal,
        timeout: ownedLauncher.timeout,
      }

      // Require exit code 0
      if (!ownedLauncher.exited || ownedLauncher.exitCode !== 0) {
        result.ok = false
        result.errors.push(`Owned launcher failed to exit cleanly (exitCode=${ownedLauncher.exitCode}, signal=${ownedLauncher.exitSignal}, timeout=${ownedLauncher.timeout})`)
      }

      // Plus persisted runtime-health current.cleanExit=true for overall ok
      const healthFile = path.join(userData, 'logs', 'runtime-health.json')
      const healthSnap = readHealthSnapshot(healthFile)
      result.healthAtExit = healthSnap?.current || null
      if (!healthSnap?.current?.cleanExit) {
        result.ok = false
        result.errors.push(`Runtime health snapshot cleanExit is not true at shutdown (cleanExit=${healthSnap?.current?.cleanExit})`)
      } else {
        result.gates.cleanExitMarkerWritten = true
      }
    }

    result.completedAt = new Date().toISOString()
    result.status = result.ok ? 'completed' : 'failed'
    if (!result.ok) {
      process.exitCode = 1
    }
    persist()
    console.log(JSON.stringify({ ...result, samples: `${result.samples.length} samples; see result.json` }, null, 2))

    // Clear referenced keepAlive only at the final safe location after cleanup and persistence
    clearInterval(keepAlive)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
