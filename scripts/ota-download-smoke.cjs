/** Exercise the installed client's real updater without touching customer data. */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const yaml = require('js-yaml')
const { _electron } = require('playwright')

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const executable = path.resolve(arg('executable') || '')
const releaseDir = arg('release-dir') && path.resolve(arg('release-dir'))
const expectedVersion = arg('expected-version')
const currentVersion = arg('current-version')
const oldInstaller = arg('old-installer') && path.resolve(arg('old-installer'))
const github = arg('github') === 'true'
const verifyOnly = arg('verify-only') === 'true'
assert(expectedVersion && currentVersion, 'Explicit current and expected versions are required')
assert(fs.existsSync(executable), 'Installed executable is required')
assert(!executable.toLowerCase().includes('win-unpacked'), 'Use the isolated installed client')
assert(github || verifyOnly || releaseDir, 'A local release directory or GitHub mode is required')

const fixtureParent = path.join(os.tmpdir(), 'mmo-packaged-smoke')
fs.mkdirSync(fixtureParent, { recursive: true })
assert(fs.realpathSync(executable).toLowerCase().startsWith(`${fs.realpathSync(fixtureParent).toLowerCase()}${path.sep}`), 'Executable must be an isolated TEMP fixture')
const fixture = arg('fixture') ? path.resolve(arg('fixture')) : fs.mkdtempSync(path.join(fixtureParent, 'ota-'))
assert(fixture.toLowerCase().startsWith(`${path.resolve(fixtureParent).toLowerCase()}${path.sep}`), 'Fixture must be inside the dedicated temp smoke root')
const userData = path.join(fixture, 'user-data')
const localCache = path.join(fixture, 'local-cache')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(localCache, { recursive: true })
const outDir = path.resolve('output', 'ota-smoke', path.basename(fixture), verifyOnly ? 'upgraded' : github ? 'github' : 'local')
fs.mkdirSync(outDir, { recursive: true })
const report = { ok: false, executable, fixture, userData, currentVersion, expectedVersion, github, verifyOnly, requests: [], gates: {} }
const persist = () => fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(report, null, 2))

async function hashFile(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

async function startFeed() {
  const manifest = yaml.load(fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8'))
  assert.equal(manifest.version, expectedVersion)
  const entry = manifest.files.find(file => file.url.endsWith('.exe'))
  assert(entry && entry.url === path.basename(entry.url), 'Expected a local installer filename')
  const setup = path.join(releaseDir, entry.url)
  assert.equal(fs.statSync(setup).size, entry.size)
  assert.equal(await hashFile(setup, 'sha512', 'base64'), entry.sha512)
  report.gates.localManifestHash = true
  const files = new Map([
    ['latest.yml', path.join(releaseDir, 'latest.yml')],
    [entry.url, setup],
    [`${entry.url}.blockmap`, `${setup}.blockmap`],
  ])
  if (oldInstaller) {
    assert(fs.existsSync(oldInstaller) && fs.existsSync(`${oldInstaller}.blockmap`))
    files.set(path.basename(oldInstaller), oldInstaller)
    files.set(`${path.basename(oldInstaller)}.blockmap`, `${oldInstaller}.blockmap`)
    const cache = path.join(localCache, 'mmo-auto-review-updater')
    fs.mkdirSync(cache, { recursive: true })
    fs.copyFileSync(oldInstaller, path.join(cache, 'installer.exe'))
  }
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1))
    const file = files.get(name)
    report.requests.push({ name, range: request.headers.range || null })
    if (!file || !fs.existsSync(file) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end()
      return
    }
    const size = fs.statSync(file).size
    const range = request.headers.range
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range)
    if (range && !match) {
      response.writeHead(416).end()
      return
    }
    const start = match ? Number(match[1]) : 0
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      response.writeHead(416).end()
      return
    }
    const headers = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' }
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    response.writeHead(match ? 206 : 200, headers)
    if (request.method === 'HEAD') response.end()
    else fs.createReadStream(file, { start, end }).on('error', error => response.destroy(error)).pipe(response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/`, manifest, setup }
}

async function main() {
  let electron
  let feed
  let originalConfig
  const configFile = path.join(path.dirname(executable), 'resources', 'app-update.yml')
  persist()
  try {
    if (!github && !verifyOnly) feed = await startFeed()
    const settingsFile = path.join(userData, 'settings.json')
    const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}
    // Set manual mode before startup so closing the fixture never installs an update.
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, updateMode: 'manual' }, null, 2))
    const configText = fs.readFileSync(configFile, 'utf8')
    const config = yaml.load(configText)
    if (feed) {
      originalConfig = configText
      // The app bundles electron-updater: changing an externally required instance
      // would not affect its real IPC updater. Override only the fixture's feed.
      fs.writeFileSync(configFile, yaml.dump({ ...config, provider: 'generic', url: feed.url }))
    }
    const env = { ...process.env, MMO_SMOKE_MODE: '1', SMOKE_USER_DATA_DIR: userData, LOCALAPPDATA: localCache }
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({
      executablePath: executable, args: [`--user-data-dir=${userData}`],
      cwd: path.dirname(executable), env, timeout: 120_000,
    })
    for (const stream of [electron.process().stdout, electron.process().stderr]) {
      stream?.on('data', chunk => fs.appendFileSync(path.join(outDir, 'runtime.log'), chunk))
    }
    const page = await electron.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.electronAPI?.updates))
    const paths = await page.evaluate(() => window.electronAPI.getPaths())
    assert.equal(path.resolve(paths.userData).toLowerCase(), userData.toLowerCase())
    report.gates.isolatedUserData = true
    const actualVersion = await page.evaluate(() => window.electronAPI.getVersion())
    assert.equal(actualVersion, verifyOnly ? expectedVersion : currentVersion)
    report.gates.installedVersion = true
    if (verifyOnly) {
      assert.equal(await page.evaluate(() => window.electronAPI.settings.get('maxConcurrentBrowsers')), 7)
      assert.equal(await page.evaluate(() => window.electronAPI.settings.get('updateMode')), 'manual')
      assert.equal(fs.readFileSync(path.join(userData, 'upgrade-sentinel.txt'), 'utf8'), 'ota-upgrade-preserved')
      assert.equal(typeof (await page.evaluate(() => window.electronAPI.performance.getStatus())).enabled, 'boolean')
      report.gates.settingsAndDataPreserved = true
      report.ok = true
      return
    }
    await page.evaluate(async () => {
      await window.electronAPI.settings.set('updateMode', 'manual')
      await window.electronAPI.settings.set('maxConcurrentBrowsers', 7)
    })
    fs.writeFileSync(path.join(userData, 'upgrade-sentinel.txt'), 'ota-upgrade-preserved')
    const prepared = { publisherName: config.publisherName || null, version: actualVersion }
    report.client = prepared
    assert.equal(prepared.version, currentVersion)
    report.check = await page.evaluate(() => window.electronAPI.updates.check())
    assert.equal(report.check.latestVersion, expectedVersion)
    assert.equal(report.check.available, true)
    assert.equal(report.check.enabled, true)
    report.gates.installedClientDetectsUpdate = true
    persist()
    console.log(`Update detected: ${currentVersion} -> ${expectedVersion}; source=${github ? 'GitHub' : 'loopback'}`)
    report.download = await page.evaluate(() => window.electronAPI.updates.download())
    assert.equal(report.download.downloaded, true, report.download.error)
    assert.equal(report.download.status, 'downloaded')
    report.gates.realUpdaterDownload = true
    const pending = path.join(localCache, config.updaterCacheDirName, 'pending')
    const installers = fs.readdirSync(pending).filter(name => name.endsWith('.exe'))
    assert.equal(installers.length, 1, 'Expected exactly one updater-downloaded installer')
    report.downloadedInstaller = path.join(pending, installers[0])
    assert(report.downloadedInstaller.toLowerCase().startsWith(`${localCache.toLowerCase()}${path.sep}`))
    report.sha256 = await hashFile(report.downloadedInstaller, 'sha256', 'hex')
    if (feed) {
      assert.equal(report.sha256, await hashFile(feed.setup, 'sha256', 'hex'))
      report.gates.downloadedArtifactMatches = true
    }
    report.ok = true
  } finally {
    try {
      if (electron) await electron.close()
    } finally {
      if (originalConfig !== undefined) fs.writeFileSync(configFile, originalConfig)
      if (feed) await new Promise(resolve => feed.server.close(resolve))
      persist()
    }
  }
}

main().then(() => console.log(JSON.stringify({ ok: report.ok, outDir, gates: report.gates }))).catch(error => {
  report.ok = false
  report.error = error.stack || String(error)
  persist()
  console.error(report.error)
  process.exitCode = 1
})
