/**
 * Long-Run Stability & Lifecycle Smoke Harness
 *
 * Verifies Electron lifecycle stability, RuntimeHealthService persistence,
 * renderer crash recovery, EPIPE console resilience, native dialog suppression,
 * and clean/unclean shutdown markers in an isolated temporary userData fixture.
 *
 * Run post-build with:
 *   node scripts/long-run-stability-smoke.cjs [--executable=path/to/binary]
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { _electron } = require('playwright')

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const executable = arg('executable') && path.resolve(arg('executable'))
const executablePath = executable || require('electron')

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
const outDir = path.resolve('output', 'long-run-stability-20261123', `runtime-${runId}`)
const resultFile = path.join(outDir, 'result.json')
const smokeRoot = path.join(os.tmpdir(), 'mmo-packaged-smoke', `stability-${runId}`)
const userDataDir = path.join(smokeRoot, 'user-data')

assert(
  path.resolve(userDataDir).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()),
  'SMOKE_USER_DATA_DIR must be placed under OS temp directory'
)

fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(userDataDir, { recursive: true })

const result = {
  ok: false,
  status: 'starting',
  startedAt: new Date().toISOString(),
  completedAt: null,
  elapsedSeconds: 0,
  outDir,
  userDataDir,
  executable: executablePath,
  steps: [],
  launches: [],
  gates: {},
  descendantVerification: null,
  errors: [],
}

const persist = () => {
  result.updatedAt = new Date().toISOString()
  result.elapsedSeconds = Math.round((Date.now() - Date.parse(result.startedAt)) / 1000)
  const tmp = path.join(outDir, 'result.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8')
  try {
    fs.renameSync(tmp, resultFile)
  } catch {
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8')
  }
}

const recordStep = (name, ok, details = {}) => {
  result.steps.push({
    name,
    ok,
    at: new Date().toISOString(),
    ...details,
  })
  persist()
}

const sleep = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  if (timer.unref) timer.unref()
})

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

const canonicalize = p => path.resolve(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')

const ownedProcesses = []

function registerOwnedProcess(electronApp, label, mainPid) {
  const launcherChild = electronApp.process()
  const record = {
    label,
    launcherPid: launcherChild.pid,
    pid: mainPid || launcherChild.pid,
    mainPid: mainPid || launcherChild.pid,
    child: launcherChild,
    electron: electronApp,
    exited: false,
    exitCode: null,
    exitSignal: null,
    cleanupSuccess: null,
  }
  launcherChild.once('close', (code, signal) => {
    record.exited = true
    record.exitCode = code
    record.exitSignal = signal
  })
  ownedProcesses.push(record)
  result.launches.push({
    label,
    launcherPid: launcherChild.pid,
    mainPid: record.mainPid,
    startedAt: new Date().toISOString(),
  })
  return record
}

async function launchElectron(label) {
  const env = { ...process.env, MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: userDataDir }
  delete env.ELECTRON_RUN_AS_NODE
  if (arg('diagnostics') === 'true') {
    env.DEBUG = 'pw:browser'
  }

  const args = [...(executable ? [] : ['.']), `--user-data-dir=${userDataDir}`]
  const cwd = executable ? path.dirname(executable) : process.cwd()

  const electronApp = await _electron.launch({
    executablePath,
    args,
    cwd,
    env,
    timeout: 60_000,
  })

  const mainPid = await withTimeout(
    electronApp.evaluate(() => process.pid),
    15_000,
    'obtain actual main process PID'
  )

  const procRecord = registerOwnedProcess(electronApp, label, mainPid)
  return { electronApp, procRecord, mainPid }
}

async function getAndAssertCanonicalPaths(electronApp, stepName) {
  const page = await withTimeout(electronApp.firstWindow({ timeout: 60_000 }), 65_000, 'firstWindow')
  await withTimeout(
    page.waitForFunction(
      () => typeof window.electronAPI?.getPaths === 'function',
      null,
      { timeout: 30_000 }
    ),
    35_000,
    'waitForFunction getPaths'
  )
  const paths = await withTimeout(page.evaluate(async () => await window.electronAPI.getPaths()), 15_000, 'page getPaths')
  assert(paths && typeof paths.userData === 'string', 'getPaths().userData must return a valid string')

  const canonicalActual = canonicalize(paths.userData)
  const canonicalExpected = canonicalize(userDataDir)
  const canonicalTemp = canonicalize(os.tmpdir())

  assert.equal(
    canonicalActual,
    canonicalExpected,
    `userData mismatch: expected canonical ${canonicalExpected}, got ${canonicalActual}`
  )
  assert(
    canonicalActual.startsWith(canonicalTemp),
    `userData ${canonicalActual} is not strictly within OS temp ${canonicalTemp}`
  )

  recordStep(`${stepName}:canonical_paths_asserted`, true, { actualUserData: paths.userData })
  return { page, paths }
}

/**
 * Instruments dialog.showErrorBox in fixture main process.
 * Increments an in-memory counter and prevents blocking native modal popups during testing.
 */
async function instrumentDialogShowErrorBox(electronApp) {
  await withTimeout(electronApp.evaluate(({ dialog }) => {
    if (!globalThis.__mmoDialogFixture) {
      const originalShowErrorBox = dialog.showErrorBox.bind(dialog)
      globalThis.__mmoDialogFixture = {
        errorBoxCount: 0,
        errorBoxCalls: [],
        originalShowErrorBox,
      }
      dialog.showErrorBox = (title, content) => {
        globalThis.__mmoDialogFixture.errorBoxCount += 1
        globalThis.__mmoDialogFixture.errorBoxCalls.push({
          title: String(title),
          content: String(content),
          at: new Date().toISOString(),
        })
      }
    }
  }), 15_000, 'instrumentDialogShowErrorBox')
}

/**
 * Restores original dialog.showErrorBox in fixture main process.
 */
async function restoreDialogShowErrorBox(electronApp) {
  try {
    await withTimeout(electronApp.evaluate(({ dialog }) => {
      if (globalThis.__mmoDialogFixture && globalThis.__mmoDialogFixture.originalShowErrorBox) {
        dialog.showErrorBox = globalThis.__mmoDialogFixture.originalShowErrorBox
        delete globalThis.__mmoDialogFixture
      }
    }), 10_000, 'restoreDialogShowErrorBox')
  } catch {
    // Process may already be terminated
  }
}

/**
 * Inspects both native dialog.showErrorBox hook counter and BrowserWindow instances.
 */
async function getDialogVerification(electronApp) {
  return await withTimeout(electronApp.evaluate(({ BrowserWindow }) => {
    const allWindows = BrowserWindow.getAllWindows()
    const hook = globalThis.__mmoDialogFixture
    return {
      windowCount: allWindows.length,
      windowTitles: allWindows.map(w => w.getTitle()),
      errorBoxCount: hook ? hook.errorBoxCount : 0,
      errorBoxCalls: hook ? hook.errorBoxCalls : [],
    }
  }), 15_000, 'getDialogVerification')
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

async function pollHealthSnapshot(healthFilePath, predicate, timeoutMs = 15000, desc = 'predicate') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snap = readHealthSnapshot(healthFilePath)
    if (snap && predicate(snap)) {
      return snap
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for health snapshot matching: ${desc}`)
}

/**
 * Bounded process exit waiter.
 * Removes listeners and timers upon resolution to prevent keeping Node event loop alive.
 */
function waitForProcessClose(procRecord, timeoutMs = 15000) {
  if (procRecord.exited) {
    return Promise.resolve({ code: procRecord.exitCode, signal: procRecord.exitSignal })
  }
  return new Promise(resolve => {
    let timer = null
    const onClose = (code, signal) => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      procRecord.child.removeListener('close', onClose)
      resolve({ code, signal })
    }
    timer = setTimeout(() => {
      timer = null
      procRecord.child.removeListener('close', onClose)
      resolve({ timeout: true })
    }, timeoutMs)
    if (timer.unref) timer.unref()
    procRecord.child.once('close', onClose)
  })
}

async function main() {
  const keepAlive = setInterval(() => {}, 5000)
  const overallDeadline = Date.now() + 420_000 // 7-minute finite overall deadline
  const checkOverallTimeout = () => {
    if (Date.now() > overallDeadline) {
      throw new Error('Overall long-run stability smoke deadline (420s) exceeded')
    }
  }

  persist()
  try {
    // -------------------------------------------------------------------------
    // Phase 1: Baseline Launch, Health Check, Renderer Crash & Recovery, EPIPE, Heartbeat
    // -------------------------------------------------------------------------
    const { electronApp: app1, procRecord: proc1, mainPid: initialPid } = await launchElectron('launch-1-baseline')
    const { page: page1, paths: paths1 } = await getAndAssertCanonicalPaths(app1, 'launch-1')
    const healthFile = path.join(paths1.userData, 'logs', 'runtime-health.json')

    // Instrument native dialog.showErrorBox to detect unhandled error modals without blocking
    await instrumentDialogShowErrorBox(app1)
    recordStep('launch-1:dialog_hook_installed', true)

    // Wait DOMcontentloaded + visible nav before forcing crash (fail if timeout, no ignored catch)
    await withTimeout(page1.waitForLoadState('domcontentloaded'), 30_000, 'waitForLoadState domcontentloaded')
    await withTimeout(page1.locator('nav').first().waitFor({ state: 'visible', timeout: 30_000 }), 35_000, 'wait for visible nav')
    recordStep('launch-1:domcontentloaded_and_nav_visible', true)

    // 1. Initial health snapshot: cleanExit=false
    const initialSnap = await pollHealthSnapshot(
      healthFile,
      s => s.version === 1 && s.current && s.current.cleanExit === false,
      15000,
      'initial health record with cleanExit=false'
    )
    assert.equal(initialSnap.current.cleanExit, false, 'Initial snapshot must record cleanExit=false')
    const initialSessionId = initialSnap.current.sessionId
    assert(typeof initialSessionId === 'string' && initialSessionId.length > 0, 'Session ID must be non-empty')
    result.gates.initialHealthUncleanMarker = true
    recordStep('launch-1:initial_health_verified', true, {
      sessionId: initialSessionId,
      mainPid: initialPid,
      launcherPid: proc1.launcherPid,
    })

    checkOverallTimeout()

    // 2. Renderer process crash using ONLY fixture main window webContents.forcefullyCrashRenderer()
    await withTimeout(app1.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      if (!win) throw new Error('No active BrowserWindow found to forcefully crash')
      win.webContents.forcefullyCrashRenderer()
    }), 15_000, 'forcefullyCrashRenderer')
    recordStep('launch-1:renderer_forcefully_crashed', true)

    // Poll ACTUAL renderer through electronApp.evaluate(({BrowserWindow}) => win.webContents.executeJavaScript(...))
    // Do not use stale Page as recovery truth.
    const recoveryDeadline = Date.now() + 35_000
    let recoveredData = null
    while (Date.now() < recoveryDeadline) {
      checkOverallTimeout()
      await sleep(600)
      try {
        const evalPromise = app1.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
          if (!win || !win.webContents || win.webContents.isCrashed()) return null
          try {
            return await win.webContents.executeJavaScript(
              '(async()=>({nav:!!document.querySelector("nav"),paths:await window.electronAPI.getPaths()}))()'
            )
          } catch {
            return null
          }
        })
        const res = await withTimeout(evalPromise, 5000, 'renderer executeJavaScript check')
        if (res && res.nav && res.paths && res.paths.userData) {
          recoveredData = res
          break
        }
      } catch {
        // Expected while window is in reload / recovery phase or evaluate times out
      }
    }
    assert(recoveredData, 'Renderer did not recover IPC within deadline after forcefullyCrashRenderer()')
    assert.equal(recoveredData.nav, true, 'Recovered renderer nav element is missing')
    assert.equal(
      canonicalize(recoveredData.paths.userData),
      canonicalize(userDataDir),
      'Recovered renderer userData root mismatch'
    )
    result.gates.rendererLossRecovered = true

    // Verify main process remained alive with the exact same actual main PID from electronApp.evaluate(() => process.pid)
    const currentMainPid = await withTimeout(app1.evaluate(() => process.pid), 10_000, 'evaluate current main PID')
    assert.equal(currentMainPid, initialPid, `Main process PID changed after renderer crash (expected ${initialPid}, got ${currentMainPid})`)
    result.gates.sameMainPidPreserved = true

    // Verify health snapshot recorded the renderer loss count increment and kept same session
    const postCrashSnap = await pollHealthSnapshot(
      healthFile,
      s => s.current?.rendererLossCount >= 1 && s.current?.sessionId === initialSessionId,
      15000,
      'rendererLossCount >= 1 with same sessionId'
    )
    assert.equal(postCrashSnap.current.sessionId, initialSessionId, 'Session ID changed after renderer recovery')
    assert(postCrashSnap.current.rendererLossCount >= 1, 'rendererLossCount did not increment in health snapshot')
    result.gates.rendererLossCountIncremented = true
    recordStep('launch-1:renderer_recovery_verified', true, {
      rendererLossCount: postCrashSnap.current.rendererLossCount,
      lastRendererLossReason: postCrashSnap.current.lastRendererLossReason,
    })

    // Verify no native dialog.showErrorBox was triggered and no secondary windows appeared
    const postCrashDialog = await getDialogVerification(app1)
    assert.equal(
      postCrashDialog.errorBoxCount,
      0,
      `Native dialog.showErrorBox was called during renderer crash: ${JSON.stringify(postCrashDialog.errorBoxCalls)}`
    )
    assert.equal(
      postCrashDialog.windowCount,
      1,
      `Unexpected window detected after crash: ${postCrashDialog.windowTitles.join(', ')}`
    )
    result.gates.noFatalErrorDialogObserved = true
    recordStep('launch-1:no_fatal_dialog_verified_post_crash', true, postCrashDialog)

    // 3. Emit stdout/stderr error with code EPIPE and assert main remains alive
    const epipeCheck = await withTimeout(app1.evaluate(() => {
      const createEpipe = () => {
        const err = new Error('write EPIPE')
        err.code = 'EPIPE'
        return err
      }
      process.stdout.emit('error', createEpipe())
      process.stderr.emit('error', createEpipe())
      return {
        pid: process.pid,
        alive: !process.killed,
      }
    }), 15_000, 'emit EPIPE')
    assert(epipeCheck.alive, 'Main process died from EPIPE error on console streams')
    assert.equal(epipeCheck.pid, initialPid, 'PID changed after EPIPE error')

    // Confirm main IPC remains interactive
    const echoResult = await withTimeout(app1.evaluate(() => 20261123), 10_000, 'echo evaluation')
    assert.equal(echoResult, 20261123, 'Main process unresponsive after EPIPE error')
    result.gates.epipeResilienceVerified = true

    // Verify dialog.showErrorBox remained uncalled during EPIPE emission
    const postEpipeDialog = await getDialogVerification(app1)
    assert.equal(
      postEpipeDialog.errorBoxCount,
      0,
      `Native dialog.showErrorBox was called during EPIPE: ${JSON.stringify(postEpipeDialog.errorBoxCalls)}`
    )
    recordStep('launch-1:epipe_resilience_verified', true, postEpipeDialog)

    // 4. Wait for at least 1 real heartbeat (30s interval, finite deadline 65s) and bounded size <= 16KB
    const heartbeatDeadline = Date.now() + 65_000
    let heartbeatRecord = null
    while (Date.now() < heartbeatDeadline) {
      checkOverallTimeout()
      await sleep(1000)
      const currentSnap = readHealthSnapshot(healthFile)
      if (currentSnap?.current?.heartbeatCount >= 1) {
        heartbeatRecord = currentSnap
        break
      }
    }
    assert(heartbeatRecord, 'Heartbeat (heartbeatCount >= 1) was not observed within 65s deadline')
    result.gates.heartbeatObserved = true

    const healthStat = fs.statSync(healthFile)
    assert(healthStat.size <= 16384, `Health file size ${healthStat.size} bytes exceeds 16KB limit`)
    result.gates.healthFileBoundedSize = true
    recordStep('launch-1:heartbeat_and_size_verified', true, {
      heartbeatCount: heartbeatRecord.current.heartbeatCount,
      fileSizeBytes: healthStat.size,
    })

    // Restore original dialog method before intentional close
    await restoreDialogShowErrorBox(app1)

    // 5. Normal close: request native app.quit() while retaining inspector until native exit
    const proc1ClosePromise = waitForProcessClose(proc1, 15_000)
    await withTimeout(
      app1.evaluate(({ app }) => {
        app.quit()
      }).catch(err => {
        // Expected transport disconnection as native process terminates
        return { transportClosed: true, error: String(err) }
      }),
      10_000,
      'app1.quit()'
    )
    const exit1 = await proc1ClosePromise
    assert(!exit1.timeout, 'Instance 1 launcher failed to close within 15s after app.quit()')
    assert.equal(exit1.code, 0, `Instance 1 launcher exited with non-zero code ${exit1.code} (signal: ${exit1.signal})`)
    recordStep('launch-1:closed_cleanly', true, exit1)

    const postCloseSnap = await pollHealthSnapshot(
      healthFile,
      s => s.current?.cleanExit === true && s.current?.exitReason === 'clean_shutdown',
      5000,
      'cleanExit=true and clean_shutdown marker'
    )
    assert.equal(postCloseSnap.current.cleanExit, true, 'Health snapshot missing cleanExit=true after clean close')
    result.gates.cleanExitMarkerWritten = true
    recordStep('launch-1:clean_marker_verified', true)

    // -------------------------------------------------------------------------
    // Phase 2: Reopen Same Fixture, Verify previous.cleanExit=true, Abrupt app.exit(91)
    // -------------------------------------------------------------------------
    checkOverallTimeout()
    const { electronApp: app2, procRecord: proc2 } = await launchElectron('launch-2-abrupt-test')
    await getAndAssertCanonicalPaths(app2, 'launch-2')

    const reopenSnap = await pollHealthSnapshot(
      healthFile,
      s => s.previous?.cleanExit === true && s.previous?.sessionId === initialSessionId,
      15000,
      'previous.cleanExit=true matching previous session'
    )
    assert.equal(reopenSnap.previous.cleanExit, true, 'previous.cleanExit must be true on reopen')
    assert.equal(reopenSnap.previous.sessionId, initialSessionId, 'previous sessionId mismatch')
    assert.equal(reopenSnap.current.cleanExit, false, 'active session cleanExit must be false')
    result.gates.previousCleanExitVerified = true
    recordStep('launch-2:previous_clean_exit_verified', true, {
      previousSessionId: reopenSnap.previous.sessionId,
      activeSessionId: reopenSnap.current.sessionId,
    })

    // Simulate abrupt exit via app.exit(91) without quit callbacks
    const proc2ClosePromise = waitForProcessClose(proc2, 15_000)
    await withTimeout(
      app2.evaluate(({ app }) => {
        app.exit(91)
      }).catch(err => {
        return { transportClosed: true, error: String(err) }
      }),
      10_000,
      'app2.exit(91)'
    )

    const exit2 = await proc2ClosePromise
    assert(!exit2.timeout, 'Instance 2 failed to exit within 15s after app.exit(91)')
    assert.equal(exit2.code, 91, `Expected exit code 91 from abrupt exit, got ${exit2.code}`)
    result.gates.abruptExitObserved = true
    recordStep('launch-2:abrupt_exit_verified', true, exit2)

    // -------------------------------------------------------------------------
    // Phase 3: Reopen Same Fixture, Verify previous.cleanExit=false (unclean), Final Clean Close
    // -------------------------------------------------------------------------
    checkOverallTimeout()
    const { electronApp: app3, procRecord: proc3 } = await launchElectron('launch-3-unclean-recovery')
    await getAndAssertCanonicalPaths(app3, 'launch-3')

    const uncleanReopenSnap = await pollHealthSnapshot(
      healthFile,
      s => s.previous && s.previous.cleanExit === false && s.current && s.current.cleanExit === false,
      15000,
      'previous.cleanExit=false with unclean classification'
    )
    assert.equal(uncleanReopenSnap.previous.cleanExit, false, 'previous.cleanExit must be false after abrupt exit')
    assert(
      uncleanReopenSnap.previous.exitReason === 'unknown_unclean' || !uncleanReopenSnap.previous.exitReason,
      `Expected unknown_unclean classification, got ${uncleanReopenSnap.previous.exitReason}`
    )
    assert.notEqual(
      uncleanReopenSnap.current.sessionId,
      uncleanReopenSnap.previous.sessionId,
      'Current session must be fresh after abrupt exit'
    )
    assert.equal(uncleanReopenSnap.current.cleanExit, false, 'Current session cleanExit must be false')
    result.gates.previousUncleanClassificationVerified = true
    recordStep('launch-3:previous_unclean_verified', true, {
      previousSessionId: uncleanReopenSnap.previous.sessionId,
      previousExitReason: uncleanReopenSnap.previous.exitReason,
      currentSessionId: uncleanReopenSnap.current.sessionId,
    })

    // Final intentional close: request native app.quit() while retaining inspector until native exit
    const proc3ClosePromise = waitForProcessClose(proc3, 15_000)
    await withTimeout(
      app3.evaluate(({ app }) => {
        app.quit()
      }).catch(err => {
        return { transportClosed: true, error: String(err) }
      }),
      10_000,
      'app3.quit()'
    )
    const exit3 = await proc3ClosePromise
    assert(!exit3.timeout, 'Instance 3 failed to close within 15s after final app.quit()')
    assert.equal(exit3.code, 0, `Instance 3 launcher exited with non-zero code ${exit3.code} (signal: ${exit3.signal})`)
    recordStep('launch-3:closed_cleanly', true, exit3)

    const finalSnap = await pollHealthSnapshot(
      healthFile,
      s => s.current?.cleanExit === true,
      5000,
      'final cleanExit=true'
    )
    assert.equal(finalSnap.current.cleanExit, true, 'Final snapshot must record cleanExit=true')
    result.gates.finalCleanCloseVerified = true
    recordStep('launch-3:final_clean_verified', true)

    // -------------------------------------------------------------------------
    // Final Verification: All owned launcher processes verified stopped with expected exit codes
    // -------------------------------------------------------------------------
    for (const record of ownedProcesses) {
      assert(record.exited, `Owned launcher process ${record.label} (PID ${record.launcherPid}) did not stop`)
      if (record.label === 'launch-1-baseline' || record.label === 'launch-3-unclean-recovery') {
        assert.equal(record.exitCode, 0, `Owned launcher ${record.label} exited with code ${record.exitCode}, expected 0`)
      } else if (record.label === 'launch-2-abrupt-test') {
        assert.equal(record.exitCode, 91, `Owned launcher ${record.label} exited with code ${record.exitCode}, expected 91`)
      }
    }
    result.gates.ownedLaunchersStopped = true
    result.descendantVerification = {
      scope: 'owned_launcher_process',
      verifiedByHarness: true,
      pids: ownedProcesses.map(p => ({
        label: p.label,
        launcherPid: p.launcherPid,
        mainPid: p.mainPid,
        exited: p.exited,
        exitCode: p.exitCode,
        exitSignal: p.exitSignal,
      })),
      note: 'Child close events prove owned launcher processes closed with expected exit codes, not all actual Electron mains or descendant processes. Actual main PID is verified preserved during recovery; host and descendant process trees verified independently by Brain.',
    }
    recordStep('all_owned_launchers_verified_stopped', true, result.descendantVerification)

    checkOverallTimeout()
    result.ok = true
  } catch (error) {
    result.ok = false
    result.errors.push(error.stack || String(error))
    process.exitCode = 1
  } finally {
    // -------------------------------------------------------------------------
    // Bounded Cleanup for all owned processes (native app.quit / owned child handle only)
    // -------------------------------------------------------------------------
    for (const record of ownedProcesses) {
      if (!record.exited) {
        if (record.electron) {
          await restoreDialogShowErrorBox(record.electron).catch(() => {})
        }
        try {
          if (record.electron) {
            // Request native app.quit() instead of SDK electronApp.close()
            await withTimeout(
              record.electron.evaluate(({ app }) => {
                app.quit()
              }).catch(() => {}),
              5000,
              'emergency app.quit()'
            )
          }
        } catch {
          // Ignore evaluate error during emergency cleanup
        }

        // Await close event boundedly after quit attempt
        await waitForProcessClose(record, 5000)

        // Fallback kill of ONLY the owned launcher child process handle (never unverified numeric PID)
        if (!record.exited) {
          try {
            record.child.kill()
          } catch {
            // Ignore kill error
          }
          // Boundedly await final close event after fallback kill
          await waitForProcessClose(record, 5000)
        }

        record.cleanupSuccess = record.exited
        if (!record.exited) {
          record.cleanupError = 'Owned launcher process failed to stop within deadlines after app.quit() and kill()'
        }
      } else {
        record.cleanupSuccess = true
      }
    }

    const allLaunchersStopped = ownedProcesses.every(r => r.exited)
    const allExpectedCodesMatch = ownedProcesses.every(r => {
      if (!r.exited) return false
      if (r.label === 'launch-1-baseline' || r.label === 'launch-3-unclean-recovery') return r.exitCode === 0
      if (r.label === 'launch-2-abrupt-test') return r.exitCode === 91
      return true
    })

    result.gates.ownedLaunchersStopped = allLaunchersStopped && allExpectedCodesMatch
    if (!result.descendantVerification) {
      result.descendantVerification = {
        scope: 'owned_launcher_process',
        verifiedByHarness: allLaunchersStopped && allExpectedCodesMatch,
        pids: ownedProcesses.map(p => ({
          label: p.label,
          launcherPid: p.launcherPid,
          mainPid: p.mainPid,
          exited: p.exited,
          exitCode: p.exitCode,
          exitSignal: p.exitSignal,
        })),
        note: 'Child close events prove owned launcher processes closed, not all actual Electron mains or descendant processes. Actual main PID is verified preserved during recovery; host and descendant process trees verified independently by Brain.',
      }
    }

    if (!allLaunchersStopped || !allExpectedCodesMatch) {
      result.ok = false
      result.errors.push('One or more owned launcher processes failed to stop cleanly with expected exit codes')
      process.exitCode = 1
    }

    result.status = result.ok ? 'completed' : 'failed'
    if (!result.ok) {
      process.exitCode = 1
    }
    result.completedAt = new Date().toISOString()
    persist()
    console.log(JSON.stringify(result, null, 2))

    // Clear referenced keepAlive only at the final safe location after cleanup and persistence
    clearInterval(keepAlive)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
