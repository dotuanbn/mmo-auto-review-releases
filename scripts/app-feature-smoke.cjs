const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright')
const electronPath = require('electron')

const cwd = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(cwd, 'output', 'electron-feature-smoke', runId)
const userDataDir = path.join(outDir, 'user-data')
const imageDir = path.join(outDir, 'images')
const resultPath = path.join(outDir, 'result.json')

fs.mkdirSync(imageDir, { recursive: true })
fs.writeFileSync(
  path.join(imageDir, 'one-pixel.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
)

function serializeError(error) {
  return error && error.stack ? error.stack : String(error)
}

async function main() {
  let app
  const result = {
    ok: false,
    outDir,
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
      executablePath: electronPath,
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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

    const apiResults = await page.evaluate(async ({ imageDir }) => {
      const api = window.electronAPI
      const results = []
      const ids = {}

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
        return { version, userData: paths.userData }
      })

      await step('settings.crud', async () => {
        const before = await api.settings.getAll()
        await api.settings.set('smokeKey', 'smokeValue')
        assert(await api.settings.get('smokeKey') === 'smokeValue', 'settings.set/get mismatch')
        await api.settings.saveAll({ ...before, smokeKey2: 'saved' })
        assert(await api.settings.get('smokeKey2') === 'saved', 'settings.saveAll mismatch')
        return await api.settings.getAll()
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
        const updated = await api.accounts.update(account.id, { status: 'active' })
        assert(updated.status === 'active', 'account update mismatch')
        await api.accounts.importCSV([{ email: `import-${Date.now()}@example.test`, password: 'not-real', loginType: 'manual' }])
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
        if (api.trafficBoost.getAudit) {
          await api.trafficBoost.getAudit(campaign.id)
        }
        return campaign
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

      await step('proxies-fproxy.local', async () => {
        const proxy = await api.proxies.add({ host: '127.0.0.1', port: 8080, type: 'http', country: 'local' })
        ids.proxyId = proxy.id
        await api.proxies.update(proxy.id, { status: 'dead' })
        await api.proxies.importText('127.0.0.2:8081:user:pass:http')
        await api.proxies.getAll()
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
        if (ids.trafficCampaignId) await api.trafficBoost.deleteCampaign(ids.trafficCampaignId)
        if (ids.trafficTaskId) await api.traffic.delete(ids.trafficTaskId)
        if (ids.campaignId) await api.campaigns.delete(ids.campaignId)
        if (ids.templateId) await api.templates.delete(ids.templateId)
        if (ids.scriptId) await api.scripts.delete(ids.scriptId)
        if (ids.imageFolderId) await api.images.deleteFolder(ids.imageFolderId)
        if (ids.locationFromUrlId) await api.locations.delete(ids.locationFromUrlId)
        if (ids.locationId) await api.locations.delete(ids.locationId)
        if (ids.accountId) await api.accounts.delete(ids.accountId)
        if (ids.projectId) await api.projects.delete(ids.projectId, false)
        return { cleaned: true }
      })

      return results
    }, { imageDir })

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
      outDir,
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
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')
    console.error(JSON.stringify({ ok: false, outDir, error: String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    if (app) {
      await app.close().catch(() => {})
    }
  }
}

main()
