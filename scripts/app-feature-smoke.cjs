const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright')
const electronPath = require('electron')

const cwd = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')

function getArg(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find(arg => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

/**
 * Resolve launch target:
 * - Dev/default: bundled Electron + project root (args: ['.', --user-data-dir])
 * - Packaged: SMOKE_EXECUTABLE / --executable= points at win-unpacked or installed .exe
 */
const packagedExecutable =
  process.env.SMOKE_EXECUTABLE ||
  getArg('executable') ||
  null

const outDir =
  process.env.SMOKE_OUT_DIR ||
  getArg('out-dir') ||
  path.join(cwd, 'output', packagedExecutable ? 'packaged-feature-smoke' : 'electron-feature-smoke', runId)

const userDataDir =
  process.env.SMOKE_USER_DATA_DIR ||
  getArg('user-data-dir') ||
  path.join(outDir, 'user-data')

const imageDir = path.join(outDir, 'images')
const resultPath = path.join(outDir, 'result.json')
const executablePath = packagedExecutable
  ? path.resolve(packagedExecutable)
  : electronPath

fs.mkdirSync(imageDir, { recursive: true })
fs.mkdirSync(userDataDir, { recursive: true })
fs.writeFileSync(
  path.join(imageDir, 'one-pixel.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
)

function serializeError(error) {
  return error && error.stack ? error.stack : String(error)
}

/** Strip ELECTRON_RUN_AS_NODE so Playwright launches a real Electron GUI process. */
function buildLaunchEnv(isPackaged) {
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  if (isPackaged) {
    env.MMO_SMOKE_MODE = '1'
    env.SMOKE_USER_DATA_DIR = userDataDir
  }
  return env
}

function resolveLaunchConfig() {
  const env = buildLaunchEnv(Boolean(packagedExecutable))
  if (packagedExecutable) {
    if (!fs.existsSync(executablePath)) {
      throw new Error(`Packaged executable not found: ${executablePath}`)
    }
    return {
      executablePath,
      args: [`--user-data-dir=${userDataDir}`],
      cwd: path.dirname(executablePath),
      env,
      mode: 'packaged',
    }
  }
  return {
    executablePath,
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd,
    env,
    mode: 'dev',
  }
}

async function main() {
  let app
  const launch = resolveLaunchConfig()
  const result = {
    ok: false,
    mode: launch.mode,
    executablePath: launch.executablePath,
    outDir,
    userDataDir,
    passed: 0,
    failed: 0,
    results: [],
    pageErrors: [],
    consoleErrors: [],
    credentialGated: [
      'accounts.testLogin/loginVisible/checkLiveDie/openManualLogin require a disposable Google account and browser login approval',
      'fproxy.test/network proxy checks require valid proxy or FProxy credentials',
      'analytics OAuth/GA4/GSC listing requires Google OAuth access',
      'ai.generateReview/improveReview requires a configured AI API key or local model',
      'ollama.testConnection requires local Ollama running',
      'hfmodel.preload/testGenerate and datasets APIs may download or call Hugging Face',
      'updates.check/download/install require release/network access',
    ],
  }

  try {
    app = await _electron.launch({
      executablePath: launch.executablePath,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
    })

    const page = await app.firstWindow({ timeout: 30_000 })
    page.on('pageerror', error => result.pageErrors.push(serializeError(error)))
    page.on('console', message => {
      if (message.type() === 'error') {
        result.consoleErrors.push(message.text())
      }
    })

    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    await page.waitForFunction(
      () => typeof window.electronAPI === 'object' && !!window.electronAPI.settings,
      null,
      { timeout: 30_000 }
    )

    const resolvedUserData = path.resolve(userDataDir)
    const resolvedOutputRoot = path.resolve(path.join(cwd, 'output'))
    const requestedIsolatedRestore =
      resolvedUserData.startsWith(`${resolvedOutputRoot}${path.sep}`) ||
      resolvedUserData.toLowerCase().includes(`${path.sep}mmo-packaged-smoke${path.sep}`) ||
      resolvedUserData.toLowerCase().includes(`${path.sep}electron-feature-smoke${path.sep}`) ||
      resolvedUserData.toLowerCase().includes(`${path.sep}packaged-feature-smoke${path.sep}`)

    const apiResults = await page.evaluate(async ({
      imageDir,
      expectedUserDataDir,
      requestedIsolatedRestore,
      requireLaya,
    }) => {
      const api = window.electronAPI
      const results = []
      const ids = {}
      let allowIsolatedRestore = false

      function short(value) {
        try {
          return JSON.parse(JSON.stringify(value))
        } catch {
          return String(value)
        }
      }

      function assert(condition, message) {
        if (!condition) throw new Error(message)
      }

      function hasFn(obj, name) {
        return !!(obj && typeof obj[name] === 'function')
      }

      async function step(name, fn, options = {}) {
        try {
          const value = await fn()
          results.push({ name, ok: true, optional: !!options.optional, value: short(value) })
          return value
        } catch (error) {
          results.push({ name, ok: false, optional: !!options.optional, error: error?.message || String(error) })
          return undefined
        }
      }

      await step('app.bridge-isolated', async () => {
        assert(typeof window.electronAPI === 'object', 'electronAPI missing')
        assert(typeof window.require === 'undefined', 'window.require should be hidden')
        return { bridge: true }
      })

      await step('app.version-paths-report', async () => {
        const version = await api.getVersion()
        const paths = await api.getPaths()
        await api.reportRendererEvent({ level: 'info', message: 'feature smoke ping' })
        assert(/^\d+\.\d+\.\d+/.test(version), `bad version ${version}`)
        assert(paths && paths.userData, 'missing paths.userData')
        const normalizePath = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        allowIsolatedRestore =
          requestedIsolatedRestore &&
          normalizePath(paths.userData) === normalizePath(expectedUserDataDir)
        assert(
          !requestedIsolatedRestore || allowIsolatedRestore,
          `app userData is not isolated: expected ${expectedUserDataDir}, got ${paths.userData}`
        )
        return { version, userData: paths.userData }
      })

      if (requireLaya) {
        await step('laya.bundled-runtime-and-inference', async () => {
          assert(api.laya && hasFn(api.laya, 'healthCheck'), 'Laya IPC API missing')
          const health = await api.laya.healthCheck()
          assert(health.online === true && health.tier1Ready === true, 'Bundled Laya did not start')
          assert(health.version === 'laya-0.3.20-local', 'Unexpected Laya runtime')
          const metrics = {
            campaignId: 1, campaignName: 'Smoke', trafficMode: 'web_seo',
            totalVisits: 20, completedVisits: 18, failedVisits: 2,
            successRate: 0.9, consecutiveFailures: 0, currentThreadCount: 1,
            avgVisitDurationMs: 5000, elapsedMs: 100000, locationCount: 1,
          }
          const decision = await api.laya.decide('campaign_optimization', metrics)
          assert(decision.tier === 'laya-choice', 'Laya inference silently fell back')
          assert(['aggressive', 'normal', 'cautious', 'pause'].includes(decision.decision), 'Invalid model choice')
          assert(Number.isFinite(decision.confidence), 'Missing model confidence')
          const pause = await api.laya.optimizeCampaign({ ...metrics, consecutiveFailures: 16 })
          assert(pause.shouldContinue === false && pause.suggestedPacing === 'pause', 'Local hard pause gate was bypassed')
          return { health, decision, hardPauseGate: true }
        })
      }

      await step('settings.crud', async () => {
        const before = await api.settings.getAll()
        const toggledHeadless = before.headless !== true
        await api.settings.set('headless', toggledHeadless)
        assert(await api.settings.get('headless') === toggledHeadless, 'settings.set/get mismatch')
        await api.settings.saveAll({ headless: before.headless === true })
        assert(await api.settings.get('headless') === (before.headless === true), 'settings.saveAll mismatch')
        return await api.settings.getAll()
      })

      await step('captcha.metrics', async () => {
        assert(api.captcha && typeof api.captcha.getMetrics === 'function', 'captcha metrics API missing')
        const before = await api.captcha.getMetrics()
        assert(typeof before.totals?.attempts === 'number', 'captcha totals missing')
        assert(Array.isArray(before.recentAttempts), 'captcha recentAttempts missing')
        const reset = await api.captcha.resetMetrics()
        assert(reset.success === true, 'captcha metrics reset failed')
        const after = await api.captcha.getMetrics()
        assert(after.totals.attempts === 0, 'captcha metrics reset did not clear attempts')
        return { before: before.totals, reset }
      })

      await step('projects.crud', async () => {
        const project = await api.projects.create({ name: 'Smoke Project', description: 'local smoke', color: '#22c55e', icon: 'folder' })
        ids.projectId = project.id
        assert((await api.projects.getById(project.id)).name === 'Smoke Project', 'project getById mismatch')
        const updated = await api.projects.update(project.id, { name: 'Smoke Project Updated' })
        assert(updated.name === 'Smoke Project Updated', 'project update mismatch')
        await api.projects.archive(project.id)
        await api.projects.getStats(project.id)
        await api.projects.getWithDetails(project.id)
        await api.projects.getAllWithSummary()
        return project
      })

      await step('accounts.crud-import-stats', async () => {
        const account = await api.accounts.add({
          email: `smoke-${Date.now()}@example.test`,
          password: 'not-real',
          recoveryEmail: 'recovery@example.test',
          loginType: 'manual',
        })
        ids.accountId = account.id
        assert(account.loginType === 'manual', 'account loginType not persisted')
        assert(!('password' in account), 'account password leaked over IPC')
        assert(!('twoFactorSecret' in account), 'account TOTP leaked over IPC')
        assert(!('cookies' in account), 'account cookies leaked over IPC')
        assert(account.hasPassword === true, 'account hasPassword flag missing')
        const updated = await api.accounts.update(account.id, { status: 'active' })
        assert(updated.status === 'active', 'account update mismatch')
        await api.accounts.importCSV([{ email: `import-${Date.now()}@example.test`, password: 'not-real', loginType: 'manual' }])
        if (api.warmup) {
          const warmupStatus = await api.warmup.getStatus(account.id)
          assert(warmupStatus.accountId === account.id, 'warmup status account mismatch')
          const warmupStatuses = await api.warmup.getAllStatuses()
          assert(Array.isArray(warmupStatuses), 'warmup batch status missing')
        }
        return await api.accounts.getStats()
      })

      await step('locations.crud-phone-website-analytics', async () => {
        const mapsUrl = 'https://www.google.com/maps/place/Smoke+Place/@21.031426,105.9129409,17z'
        const parsed = await api.locations.parseUrl(mapsUrl)
        assert(parsed.name.includes('Smoke Place'), 'parseUrl name mismatch')
        const location = await api.locations.add({
          name: 'Smoke Location',
          url: mapsUrl,
          phone: '+84000000000',
          website: 'https://example.com',
          targetReviews: 3,
        })
        ids.locationId = location.id
        const updated = await api.locations.update(location.id, {
          phone: '+84111111111',
          website: 'https://example.org',
          searchKeywords: JSON.stringify(['alpha', 'beta']),
        })
        assert(updated.phone === '+84111111111', 'location phone update mismatch')
        assert(updated.website === 'https://example.org', 'location website update mismatch')
        const fromUrl = await api.locations.addFromUrl(mapsUrl, 2, '+84222222222', 'https://example.net')
        ids.locationFromUrlId = fromUrl.id
        assert(fromUrl.phone === '+84222222222', 'addFromUrl phone dropped')
        assert(fromUrl.website === 'https://example.net', 'addFromUrl website dropped')
        await api.analytics.updateLocationConfig(location.id, {
          analyticsMode: 'scrape',
          ga4PropertyId: 'properties/123',
          gscSiteUrl: 'https://example.org/',
          analyticsGoogleEmail: 'analytics@example.test',
        })
        const config = await api.analytics.getLocationConfig(location.id)
        assert(config.analyticsMode === 'scrape', 'analytics config mismatch')
        const configured = await api.analytics.getLocationsWithConfig()
        assert(configured.some(item => item.id === location.id && item.analyticsMode === 'scrape'), 'analytics list camelCase mismatch')
        await api.analytics.getData(location.id)
        return await api.locations.getStats()
      })

      await step('templates.crud-preview-generate', async () => {
        const template = await api.templates.create({ name: 'Smoke Template', content: '{good|great} place', category: 'general' })
        ids.templateId = template.id
        const preview = await api.templates.preview('{good|great} place')
        assert(preview.variationCount === 2, 'template preview variation mismatch')
        const variations = await api.templates.generateVariations('{a|b}', 2)
        assert(Array.isArray(variations) && variations.length > 0, 'template variations missing')
        await api.templates.generateReview(template.id)
        await api.templates.update(template.id, { name: 'Smoke Template Updated' })
        return template
      })

      await step('campaigns.scheduler.reviews', async () => {
        const campaign = await api.campaigns.create({
          name: 'Smoke Review Campaign',
          locationIds: [ids.locationId],
          accountIds: [ids.accountId],
          reviewTemplates: ['Great place'],
          rating: 5,
          delayMin: 1,
          delayMax: 2,
        })
        ids.campaignId = campaign.id
        assert((await api.campaigns.getById(campaign.id)).name === campaign.name, 'campaign get mismatch')
        await api.campaigns.update(campaign.id, { name: 'Smoke Review Campaign Updated' })
        await api.campaigns.getRunning()
        await api.campaigns.getStats()
        await api.reviews.getAll()
        await api.reviews.getByCampaign(campaign.id)
        await api.reviews.getRecent(5)
        await api.reviews.getToday()
        await api.reviews.getStats()
        await api.reviews.getHistory({ campaignId: campaign.id })
        const schedule = await api.scheduler.create({
          campaignId: campaign.id,
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          repeatType: 'once',
          isActive: true,
        })
        assert(schedule.success && schedule.id, 'schedule create failed')
        ids.scheduleId = schedule.id
        await api.scheduler.update(schedule.id, { repeatType: 'daily', isActive: true })
        await api.scheduler.getForCampaign(campaign.id)
        await api.scheduler.getAll()
        await api.scheduler.toggle(schedule.id)
        return campaign
      })

      await step('traffic.local-crud-report-audit', async () => {
        const task = await api.traffic.create({ locationId: ids.locationId, targetViews: 3, viewsPerDay: 1, useProxies: false })
        ids.trafficTaskId = task.id
        await api.traffic.update(task.id, { targetViews: 4 })
        await api.traffic.start(task.id)
        await api.traffic.stop(task.id)
        await api.traffic.getStats()
        const campaign = await api.trafficBoost.createCampaign({
          name: 'Smoke Traffic Campaign',
          trafficMode: 'direct',
          accountIds: [],
          locationIds: [ids.locationId],
          threadsCount: 1,
          visitsPerLocation: 1,
          delayMinSeconds: 0,
          delayMaxSeconds: 1,
          aiAutoControl: false,
          maxMapScroll: 15,
        })
        ids.trafficCampaignId = campaign.id
        await api.trafficBoost.updateCampaign(campaign.id, { name: 'Smoke Traffic Campaign Updated', aiAutoControl: false })
        await api.trafficBoost.getCampaigns()
        await api.trafficBoost.getStatus()
        await api.trafficBoost.getReport(campaign.id)
        await api.trafficBoost.getLogs(campaign.id)
        if (hasFn(api.trafficBoost, 'getAudit')) {
          await api.trafficBoost.getAudit(campaign.id)
        }
        // Durable visit-queue stats / recover — only when preload exposes them
        if (hasFn(api.trafficBoost, 'getVisitQueueStats')) {
          const queueStats = await api.trafficBoost.getVisitQueueStats(campaign.id)
          assert(queueStats && typeof queueStats === 'object', 'traffic visit queue stats missing')
        }
        if (hasFn(api.trafficBoost, 'recoverVisitLeases')) {
          const recovered = await api.trafficBoost.recoverVisitLeases(campaign.id)
          assert(recovered !== undefined, 'traffic visit lease recover returned undefined')
        }
        return campaign
      })

      await step('traffic.web-seo-config', async () => {
        const location = await api.locations.add({
          name: 'Smoke Web SEO Target',
          url: 'https://example.com/landing?source=smoke',
          address: 'https://example.com/landing?source=smoke',
          placeId: `web_seo_smoke_${Date.now()}`,
        })
        ids.webSeoLocationId = location.id

        const campaign = await api.trafficBoost.createCampaign({
          name: 'Smoke Web SEO Campaign',
          trafficMode: 'web_seo',
          searchKeywords: ['example landing', 'example website'],
          accountIds: [],
          locationIds: [location.id],
          threadsCount: 1,
          visitsPerLocation: 1,
          delayMinSeconds: 1,
          delayMaxSeconds: 2,
          webSeoMinDwellSeconds: 10,
          webSeoMaxDwellSeconds: 20,
          webSeoRequireOrganic: true,
        })
        ids.webSeoCampaignId = campaign.id
        assert(campaign.trafficMode === 'web_seo', 'web seo campaign mode mismatch')
        assert(campaign.webSeoMinDwellSeconds === 10, 'web seo min dwell mismatch')
        assert(campaign.webSeoMaxDwellSeconds === 20, 'web seo max dwell mismatch')
        assert(campaign.webSeoRequireOrganic === true, 'web seo organic gate mismatch')

        const updated = await api.trafficBoost.updateCampaign(campaign.id, {
          webSeoMinDwellSeconds: 15,
          webSeoMaxDwellSeconds: 30,
          webSeoRequireOrganic: false,
        })
        assert(updated.webSeoMinDwellSeconds === 15, 'web seo update min dwell mismatch')
        assert(updated.webSeoMaxDwellSeconds === 30, 'web seo update max dwell mismatch')
        assert(updated.webSeoRequireOrganic === false, 'web seo update organic gate mismatch')
        return updated
      })

      await step('runtime-network-rag-reports-tiling-soak-compliance', async () => {
        await api.runtime.getStatusV2()
        await api.runtime.getDiagnostics()
        await api.runtime.getPolicy()
        await api.runtime.updatePolicy({ queueConcurrency: 1 })
        await api.network.getEffectiveMode()
        await api.network.testConfig()
        await api.reports.getActionTrace({ limit: 10 })
        await api.rag.getStats()
        await api.rag.clear({ domain: 'smoke.local' })
        await api.mcp.getHealth()
        await api.soak.status()
        await api.tiling.getLayout(2)
        await api.tiling.setEnabled(true)
        await api.tiling.isEnabled()
        await api.compliance.getPendingReviewSubmissions()
        return { ok: true }
      })

      // Manual reconciliation list (submitting/unconfirmed durable intents)
      await step('reconciliation.list', async () => {
        assert(api.compliance, 'compliance API missing')
        assert(hasFn(api.compliance, 'getPendingReviewIntents'), 'compliance.getPendingReviewIntents missing')
        const intents = await api.compliance.getPendingReviewIntents()
        assert(Array.isArray(intents), 'pending review intents must be an array')
        return { count: intents.length }
      })

      // Compliance audit history (bounded page) — optional until main IPC is wired
      await step('compliance.audit', async () => {
        assert(api.data, 'data API missing')
        assert(hasFn(api.data, 'getComplianceAudit'), 'data.getComplianceAudit missing')
        const page = await api.data.getComplianceAudit({ limit: 10, page: 1 })
        assert(page && typeof page === 'object', 'compliance audit page missing')
        const items = Array.isArray(page.items) ? page.items : (Array.isArray(page.events) ? page.events : null)
        assert(items !== null, 'compliance audit items/events missing')
        return { total: page.total ?? items.length, count: items.length }
      }, { optional: true })

      // Backup list / create / inspect (managed backups under isolated userData)
      await step('backup.list-create-inspect', async () => {
        assert(api.data, 'data API missing')
        assert(hasFn(api.data, 'listBackups'), 'data.listBackups missing')
        assert(hasFn(api.data, 'createBackup'), 'data.createBackup missing')
        assert(hasFn(api.data, 'inspectBackup'), 'data.inspectBackup missing')

        const before = await api.data.listBackups()
        assert(Array.isArray(before), 'backup list must be an array')

        const created = await api.data.createBackup({
          includeProfiles: false,
          label: `smoke-backup-${Date.now()}`,
        })
        assert(created && created.success === true, created?.message || 'backup create failed')
        assert(typeof created.backupId === 'string' && created.backupId.length > 0, 'backupId missing')
        ids.backupId = created.backupId

        const listed = await api.data.listBackups()
        assert(listed.some(item => (item.backupId || item.id) === created.backupId), 'created backup not listed')

        const inspected = await api.data.inspectBackup(created.backupId)
        assert(inspected && typeof inspected === 'object', 'backup inspect returned empty')
        const inspectId = inspected.backupId || inspected.id
        assert(inspectId === created.backupId, 'backup inspect id mismatch')
        return { backupId: created.backupId, listed: listed.length, valid: inspected.valid !== false }
      })

      // Restore is destructive — only against isolated smoke userData, never real profiles
      await step('backup.restore-isolated', async () => {
        assert(allowIsolatedRestore, 'restore refused: userData is not an isolated smoke path')
        assert(api.data && hasFn(api.data, 'restoreBackup'), 'data.restoreBackup missing')
        assert(ids.backupId, 'no backupId from create step')
        const restored = await api.data.restoreBackup({
          backupId: ids.backupId,
          confirmation: 'RESTORE',
          includeProfiles: false,
        })
        assert(restored && restored.success === true, restored?.message || 'backup restore failed')
        const restoredAccounts = await api.accounts.getAll()
        assert(
          restoredAccounts.some(account => account.id === ids.accountId),
          'backup restore lost the smoke account'
        )
        return {
          backupId: ids.backupId,
          restartRequired: !!restored.restartRequired,
          preRestoreBackupId: restored.preRestoreBackupId || null,
        }
      })

      await step('proxies-fproxy.local', async () => {
        const proxy = await api.proxies.add({ host: '127.0.0.1', port: 8080, username: 'smoke', password: 'not-real', type: 'http', country: 'local' })
        ids.proxyId = proxy.id
        assert(!('password' in proxy), 'proxy password leaked over IPC')
        assert(proxy.hasPassword === true, 'proxy hasPassword flag missing')
        await api.proxies.update(proxy.id, { status: 'dead' })
        await api.proxies.importText('127.0.0.2:8081:user:pass:http')
        const listedProxies = await api.proxies.getAll()
        assert(listedProxies.every(item => !('password' in item)), 'proxy list leaked password')
        await api.proxies.getActive()
        await api.proxies.getStats()
        await api.proxies.deleteDead()
        await api.fproxy.getInfo()
        return proxy
      })

      await step('profiles.local', async () => {
        await api.profiles.list()
        const profile = await api.profiles.create(ids.accountId)
        await api.profiles.get(ids.accountId)
        await api.profiles.update({ accountId: ids.accountId, profilePath: profile.profilePath })
        return profile
      })

      await step('images.local-folder', async () => {
        const added = await api.images.addFolder(imageDir, 'smoke')
        assert(added.success, added.error || 'image folder add failed')
        ids.imageFolderId = added.id
        const images = await api.images.getImagesInFolder(added.id)
        assert(images.success && images.images.length > 0, 'image listing failed')
        const random = await api.images.getRandomImage(added.id, 'smoke')
        assert(random.success && random.image.path, 'random image failed')
        const base64 = await api.images.getBase64(random.image.path)
        assert(typeof base64 === 'string' && base64.length > 0, 'base64 image failed')
        await api.images.rescanFolder(added.id)
        return added
      })

      await step('scripts-tools-ai-status', async () => {
        const script = {
          id: `smoke-script-${Date.now()}`,
          name: 'Smoke Script',
          description: 'local smoke',
          version: '1.0.0',
          createdAt: new Date(),
          updatedAt: new Date(),
          variables: [],
          actions: [],
          settings: { headless: true, defaultTimeout: 5000, viewport: { width: 800, height: 600 } },
        }
        ids.scriptId = script.id
        await api.scripts.save(script)
        const saved = await api.scripts.getAll()
        assert(saved.some(item => item.id === script.id), 'script save not listed')
        await api.toolBuilder.list()
        await api.toolBuilder.stop()
        await api.ai.getApiKeyStatus()
        await api.ollama.getConfig()
        await api.hfmodel.getStatus()
        await api.trackio.getMetrics('24h')
        await api.trackio.getHistory(5)
        await api.trackio.getAlerts()
        await api.trackio.cleanup(1)
        return { ok: true }
      })

      await step('updates-state', async () => {
        return await api.updates.getState()
      })

      await step('ui.sidebar-navigation', async () => {
        const buttons = Array.from(document.querySelectorAll('aside button'))
        assert(buttons.length >= 9, `expected sidebar buttons, got ${buttons.length}`)
        for (const button of buttons) {
          button.click()
          await new Promise(resolve => setTimeout(resolve, 150))
          assert(document.querySelector('main'), 'main disappeared during navigation')
        }
        return { clicked: buttons.length }
      })

      await step('cleanup', async () => {
        if (ids.scheduleId) await api.scheduler.delete(ids.scheduleId)
        if (ids.webSeoCampaignId) await api.trafficBoost.deleteCampaign(ids.webSeoCampaignId)
        if (ids.trafficCampaignId) await api.trafficBoost.deleteCampaign(ids.trafficCampaignId)
        if (ids.trafficTaskId) await api.traffic.delete(ids.trafficTaskId)
        if (ids.campaignId) await api.campaigns.delete(ids.campaignId)
        if (ids.templateId) await api.templates.delete(ids.templateId)
        if (ids.scriptId) await api.scripts.delete(ids.scriptId)
        if (ids.imageFolderId) await api.images.deleteFolder(ids.imageFolderId)
        if (ids.locationFromUrlId) await api.locations.delete(ids.locationFromUrlId)
        if (ids.webSeoLocationId) await api.locations.delete(ids.webSeoLocationId)
        if (ids.locationId) await api.locations.delete(ids.locationId)
        if (ids.accountId) await api.accounts.delete(ids.accountId)
        if (ids.projectId) await api.projects.delete(ids.projectId, false)
        return { cleaned: true }
      })

      return results
    }, {
      imageDir,
      expectedUserDataDir: userDataDir,
      requestedIsolatedRestore,
      requireLaya: Boolean(packagedExecutable) && process.platform === 'win32',
    })

    result.results = apiResults
    result.failed = apiResults.filter(item => !item.ok && !item.optional).length
    result.passed = apiResults.filter(item => item.ok).length

    if (result.pageErrors.length > 0) {
      result.failed += result.pageErrors.length
    }

    result.ok = result.failed === 0
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')

    console.log(JSON.stringify({
      ok: result.ok,
      mode: result.mode,
      executablePath: result.executablePath,
      outDir,
      userDataDir,
      passed: result.passed,
      failed: result.failed,
      failedSteps: result.results.filter(item => !item.ok && !item.optional).map(item => ({ name: item.name, error: item.error })),
      pageErrors: result.pageErrors.length,
      consoleErrors: result.consoleErrors.length,
    }, null, 2))

    if (!result.ok) {
      process.exitCode = 1
    }
  } catch (error) {
    result.failed += 1
    result.error = serializeError(error)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')
    console.error(JSON.stringify({ ok: false, mode: result.mode, outDir, error: String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    if (app) {
      await app.close().catch(() => {})
    }
  }

  // Strict exit: never soft-succeed after a recorded failure.
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode)
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: serializeError(error) }, null, 2))
  process.exit(1)
})
