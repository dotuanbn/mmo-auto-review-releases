'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { spawn } = require('node:child_process')

const rootArg = process.argv.find(arg => arg.startsWith('--root='))
const root = path.resolve(rootArg ? rootArg.slice(7) : 'resources/laya-sidecar')
const evidenceDir = path.resolve('output/laya-ota')
const resultPath = path.join(evidenceDir, 'sidecar-smoke.json')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke requires Windows x64')
  const exe = path.join(root, 'laya-sidecar.exe')
  assert(fs.existsSync(exe), `Missing executable: ${exe}`)
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'mmo-laya-offline-'))
  const environment = { ...process.env }
  for (const key of ['PYTHONPATH', 'PYTHONHOME', 'LAYA_MODEL_DIR', 'LAYA_PORT', 'OPENROUTER_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN']) delete environment[key]
  Object.assign(environment, {
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
    HF_HOME: isolated,
    HF_HUB_CACHE: path.join(isolated, 'hub'),
    TRANSFORMERS_CACHE: path.join(isolated, 'transformers'),
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    PYTHONNOUSERSITE: '1',
  })
  const port = await freePort()
  const endpoint = `http://127.0.0.1:${port}/api/v1`
  const child = spawn(exe, [
    '--host=127.0.0.1', `--port=${port}`, `--model-dir=${path.join(root, 'model', 'multilingual')}`,
  ], { cwd: isolated, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  let spawnError
  const drain = chunk => { tail = (tail + chunk.toString()).slice(-8192) }
  child.stdout.on('data', drain)
  child.stderr.on('data', drain)
  child.on('error', error => { spawnError = error })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const evidence = { ok: false, root, isolatedCache: isolated, noPythonOrSharedCache: true, offline: true, pid: child.pid, cases: [], startedAt: new Date().toISOString() }
  const started = Date.now()
  try {
    let health
    while (Date.now() - started < 120000) {
      if (spawnError) throw spawnError
      assert.equal(child.exitCode, null, `Sidecar exited before readiness: ${tail}`)
      try {
        const response = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) {
          const body = await response.json()
          if (body.service === 'mmo-laya-sidecar' && body.protocol === 1 && body.pid === child.pid && body.model_loaded === true) {
            health = body
            break
          }
        }
      } catch { /* Readiness is polled while the local model loads. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert(health, `Model did not become ready: ${tail}`)
    evidence.startupMs = Date.now() - started
    evidence.cases.push({ name: 'offline-owned-process-readiness', ok: true, health })
    const completion = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tier1-local', messages: [{ role: 'user', content: JSON.stringify({ request_type: 'campaign_optimization', campaignId: 1, successRate: 0.9, consecutiveFailures: 0, totalVisits: 10, currentThreadCount: 1 }) }] }),
      signal: AbortSignal.timeout(30000),
    })
    const reply = await completion.json()
    assert.equal(completion.status, 200, JSON.stringify(reply))
    const decision = JSON.parse(reply.choices[0].message.content)
    assert(['aggressive', 'normal', 'cautious', 'pause'].includes(decision.decision))
    assert(decision.confidence >= 0 && decision.confidence <= 1)
    assert.equal(decision.tier, 'laya-choice')
    evidence.cases.push({ name: 'real-model-inference', ok: true, decision })
    const invalid = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]', signal: AbortSignal.timeout(3000),
    })
    assert.equal(invalid.status, 503)
    evidence.cases.push({ name: 'invalid-input-rejected', ok: true })
    const missing = await fetch(`${endpoint}/unknown`, { signal: AbortSignal.timeout(3000) })
    assert.equal(missing.status, 404)
    evidence.cases.push({ name: 'unknown-route-rejected', ok: true })
    evidence.ok = true
  } catch (error) {
    evidence.error = error.stack || String(error)
    evidence.diagnosticTail = tail
    throw error
  } finally {
    if (child.exitCode === null && !child.killed) child.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
    evidence.stopped = child.exitCode !== null || child.signalCode !== null
    evidence.finishedAt = new Date().toISOString()
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(resultPath, JSON.stringify(evidence, null, 2))
    fs.rmSync(isolated, { recursive: true, force: true })
    console.log(JSON.stringify({ ok: evidence.ok, stopped: evidence.stopped, startupMs: evidence.startupMs, resultPath }))
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
