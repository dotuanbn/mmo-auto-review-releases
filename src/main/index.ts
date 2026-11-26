import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { dataRootService, resolveSmokeDataRootOverride } from './services/DataRootService'
import { getRotatingLogger } from './utils/RotatingLogger'
import {
    containConsolePipeErrors,
    isStreamPipeError,
    rendererRecoveryController,
    resolveBootstrapLogPath,
    runtimeHealthService,
} from './services/RuntimeHealthService'
import {
    AppShutdownService,
    registerLifecycleRouter,
} from './services/AppShutdownService'

// Contain broken console pipe errors early so a closed terminal/pipe cannot
// trigger recursive uncaughtException / logBootstrap loops.
containConsolePipeErrors()

type RuntimeServices = {
    soakTestService: typeof import('./services/SoakTestService')['soakTestService']
    automationController: typeof import('./automation/AutomationController')['automationController']
    trafficBoostEngine: typeof import('./automation/TrafficBoostEngine')['trafficBoostEngine']
    schedulerService: typeof import('./services/SchedulerService')['schedulerService']
}

type ActiveCleanableService = {
    name: string
    stop: () => Promise<void> | void
}

// Keep renderer stable when the app regains focus on Windows.
// Browser fidelity is handled by the launched Chrome contexts, not by this window.
// Use Electron's supported API for software rendering. This is more stable on
// Windows machines that intermittently stop repainting the renderer after the
// app is occluded by an external browser window.
app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let closeDatabaseRef: (() => void) | null = null
const gotSingleInstanceLock = app.requestSingleInstanceLock()
let runtimeServices: RuntimeServices | null = null

const activeBackgroundWorkers: ActiveCleanableService[] = []

const appShutdownService = new AppShutdownService({
    defaultStepTimeoutMs: 15_000,
    logger: (message, error) => logBootstrap(message, error),
})

// 1. Dispose renderer recovery timers
appShutdownService.registerStep({
    name: 'renderer_recovery',
    run: () => {
        rendererRecoveryController.dispose()
    },
})

// 2. Stop soak/schedulers/background workers before accepting new work
// Calls each actually started worker independently, aggregates failures, and marks clean=false if any fail
appShutdownService.registerStep({
    name: 'background_workers',
    run: async () => {
        const failures: string[] = []
        for (const worker of activeBackgroundWorkers) {
            try {
                await worker.stop()
            } catch (error) {
                failures.push(worker.name)
                logBootstrap(`Failed to stop background worker: ${worker.name}`, error)
            }
        }
        if (failures.length > 0) {
            throw new Error(`background_workers_failed:${failures.join(',')}`)
        }
    },
})

// 3. Await automationController.stop and trafficBoostEngine.stopCampaign
// Guarded to runtimeServices initialization: skips unstarted automation on early quit/startup failure
appShutdownService.registerStep({
    name: 'automation_engines',
    run: async () => {
        if (!runtimeServices) {
            return
        }
        const failures: string[] = []
        try {
            await runtimeServices.automationController.stop()
        } catch (error) {
            failures.push('automation_controller')
            logBootstrap('Failed to stop automation during shutdown', error)
        }
        try {
            await runtimeServices.trafficBoostEngine.stopCampaign()
        } catch (error) {
            failures.push('traffic_boost_engine')
            logBootstrap('Failed to stop traffic campaigns during shutdown', error)
        }
        if (failures.length > 0) {
            throw new Error(`automation_engines_failed:${failures.join(',')}`)
        }
    },
})

// 4. Close BrowserService remaining owned browser contexts
// Guarded to runtime initialization: does not dynamically load browser automation if never started
appShutdownService.registerStep({
    name: 'browser_service',
    run: async () => {
        if (!runtimeServices) {
            return
        }
        try {
            const { browserService } = await import('./automation/BrowserService')
            await browserService.closeBrowser()
        } catch (error) {
            logBootstrap('Failed to close browser contexts during shutdown', error)
            throw error
        }
    },
})

// 5. Dispose HFModelService (no downloading)
// Guarded to runtime initialization: does not dynamically load AI service if never started
appShutdownService.registerStep({
    name: 'hf_models',
    run: async () => {
        if (!runtimeServices) {
            return
        }
        try {
            const { hfModelService } = await import('./services/HFModelService')
            await hfModelService.dispose()
        } catch (error) {
            logBootstrap('Failed to dispose HFModelService during shutdown', error)
            throw error
        }
    },
})

// 6. Close proxy bridges
// Guarded to runtime initialization: does not dynamically load proxy bridges if never started
appShutdownService.registerStep({
    name: 'proxy_bridges',
    run: async () => {
        if (!runtimeServices) {
            return
        }
        try {
            const { proxyBridgeService } = await import('./services/ProxyBridgeService')
            await proxyBridgeService.closeAll()
        } catch (error) {
            logBootstrap('Failed to close proxy bridges during shutdown', error)
            throw error
        }
    },
})

// 7. Close DB last
appShutdownService.registerStep({
    name: 'database',
    run: () => {
        if (closeDatabaseRef) {
            try {
                closeDatabaseRef()
            } catch (error) {
                logBootstrap('Failed to close database during shutdown', error)
                throw error
            } finally {
                closeDatabaseRef = null
            }
        }
    },
})

// Wire canonical lifecycle event routing directly to app (zero unsafe any or assertions)
registerLifecycleRouter({
    port: app,
    shutdownService: appShutdownService,
    onShutdownComplete: (result) => {
        try {
            logBootstrap(`[AppShutdown] Completed clean=${result.clean} failedSteps=${JSON.stringify(result.failedSteps)}`)
            runtimeHealthService.stop(result.clean)
        } catch (error) {
            logBootstrap('Failed to stop runtime health during shutdown', error)
        }
    },
    onWillQuit: (isClean) => {
        try {
            if (runtimeHealthService.isRunning()) {
                runtimeHealthService.stop(isClean)
            }
        } catch (error) {
            logBootstrap('Failed to stop runtime health on will-quit', error)
        }
    },
    isMac: process.platform === 'darwin',
    logger: (message, error) => logBootstrap(message, error),
})

function openExternalUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Blocked external URL protocol: ${parsed.protocol}`)
    }
    return shell.openExternal(parsed.toString())
}

function getBootstrapLogPath(): string {
    let smokeRoot: string | null = null
    try {
        smokeRoot = resolveSmokeDataRootOverride()
    } catch {
        smokeRoot = null
    }
    return resolveBootstrapLogPath({
        smokeDataRoot: smokeRoot,
        appDataPath: (() => {
            try {
                return app.getPath('appData')
            } catch {
                return undefined
            }
        })(),
        fallbackCwd: process.cwd(),
    })
}

function stringifyError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ''}`
    }
    return String(error)
}

function logBootstrap(message: string, error?: unknown): void {
    const line = `[${new Date().toISOString()}] ${message}${error ? `\n${stringifyError(error)}` : ''}\n`
    try {
        getRotatingLogger('bootstrap', getBootstrapLogPath()).write(line)
    } catch {
        // Last-resort logging: keep startup path resilient.
    }
    try {
        if (error) {
            console.error(message, error)
        } else {
            console.log(message)
        }
    } catch (err) {
        if (!isStreamPipeError(err)) {
            throw err
        }
    }
}

function focusMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
}

function reloadWindow(targetWindow: BrowserWindow, reason: string): void {
    if (!targetWindow || targetWindow.isDestroyed()) {
        return
    }

    rendererRecoveryController.scheduleRecovery(
        targetWindow,
        reason,
        () => {
            if (!targetWindow || targetWindow.isDestroyed()) {
                return
            }
            logBootstrap(`Reloading renderer after ${reason} (attempt ${rendererRecoveryController.getAttempts()})`)
            try {
                targetWindow.webContents.reloadIgnoringCache()
            } catch (error) {
                logBootstrap('Failed to reload renderer', error)
            }
        }
    )
}

function createWindow(): void {
    const window = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 700,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
        frame: true,
        icon: join(__dirname, '../../resources/icon.png'),
        show: false,
        backgroundColor: '#0f172a',
    })
    mainWindow = window

    const forceShowTimer = setTimeout(() => {
        if (!window || window.isDestroyed() || window.isVisible()) {
            return
        }
        logBootstrap('ready-to-show timeout, forcing window visible')
        focusMainWindow()
    }, 12000)

    // Wait until ready to show to prevent visual flash
    window.once('ready-to-show', () => {
        clearTimeout(forceShowTimer)
        focusMainWindow()
    })

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
            return
        }
        logBootstrap(`Main frame load failed (${errorCode}) ${errorDescription} - ${validatedURL}`)
        dialog.showErrorBox(
            'MMO Auto Review - Load Error',
            `Main window failed to load.\nCode: ${errorCode}\n${errorDescription}\nURL: ${validatedURL}\n\nLog: ${getBootstrapLogPath()}`
        )
        focusMainWindow()
    })

    window.webContents.on('did-finish-load', () => {
        rendererRecoveryController.onRendererLoaded(window)
        logBootstrap('Main window renderer finished load')
    })

    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level < 2) {
            return
        }
        logBootstrap(`Renderer console [level=${level}] ${message} (${sourceId}:${line})`)
    })

    window.webContents.on('render-process-gone', (_event, details) => {
        logBootstrap(`Renderer process gone (reason=${details.reason}, exitCode=${details.exitCode})`)
        runtimeHealthService.recordRendererLoss({
            reason: details.reason,
            exitCode: details.exitCode,
        })
        reloadWindow(window, `render_process_gone:${details.reason}`)
    })

    window.on('unresponsive', () => {
        logBootstrap('Main window is unresponsive')
    })

    window.on('focus', () => {
        // Do not reloadIgnoringCache() on focus. That wiped React state and
        // leaked memory whenever automation was running in the background.
    })

    // Load the app
    if (process.env.VITE_DEV_SERVER_URL) {
        window.loadURL(process.env.VITE_DEV_SERVER_URL)
        window.webContents.openDevTools()
    } else {
        window.loadFile(join(__dirname, '../../dist/index.html'))
    }

    window.on('closed', () => {
        rendererRecoveryController.onWindowClosed(window)
        if (mainWindow === window) {
            mainWindow = null
            runtimeServices?.schedulerService.setMainWindow(null)
        }
    })

    // Keep scheduler notifications bound to the live BrowserWindow.
    runtimeServices?.schedulerService.setMainWindow(window)
}

app.on('child-process-gone', (_event, details) => {
    logBootstrap(`Child process gone (type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode})`)
    runtimeHealthService.recordChildProcessLoss({
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
    })
})

// Initialize app
app.whenReady().then(async () => {
    if (!gotSingleInstanceLock) {
        app.quit()
        return
    }
    if (appShutdownService.isShuttingDown() || appShutdownService.isComplete()) {
        logBootstrap('[Bootstrap] Shutdown already active at whenReady, aborting startup')
        return
    }
    try {
        logBootstrap('App startup begin')
        const dataRoot = dataRootService.configurePortableUserDataPath()
        logBootstrap(`[Bootstrap] Data root: ${dataRoot.dataRoot} (portable=${dataRoot.portable})`)

        if (appShutdownService.isShuttingDown() || appShutdownService.isComplete()) {
            logBootstrap('[Bootstrap] Shutdown active after dataRoot configured, aborting startup')
            return
        }

        // Start health diagnostics only after dataRoot has been finalized; non-fatal on error
        try {
            runtimeHealthService.start({
                logsDir: join(dataRoot.dataRoot, 'logs'),
            })
            logBootstrap(`[RuntimeHealth] Started session ${runtimeHealthService.getSessionId()}`)
        } catch (healthErr) {
            logBootstrap('[RuntimeHealth] Failed to start runtime health service (non-fatal)', healthErr)
        }

        const { initDatabase, closeDatabase } = await import('./database')
        closeDatabaseRef = closeDatabase

        // Initialize database
        logBootstrap('Initializing database...')
        initDatabase()
        logBootstrap('Database initialized successfully')

        if (appShutdownService.isShuttingDown() || appShutdownService.isComplete()) {
            logBootstrap('[Bootstrap] Shutdown active after database init, aborting remaining startup')
            return
        }

        const [soakModule, automationModule, trafficModule, schedulerModule] = await Promise.all([
            import('./services/SoakTestService'),
            import('./automation/AutomationController'),
            import('./automation/TrafficBoostEngine'),
            import('./services/SchedulerService'),
        ])
        runtimeServices = {
            soakTestService: soakModule.soakTestService,
            automationController: automationModule.automationController,
            trafficBoostEngine: trafficModule.trafficBoostEngine,
            schedulerService: schedulerModule.schedulerService,
        }
        const {
            soakTestService,
            automationController,
            schedulerService,
        } = runtimeServices

        activeBackgroundWorkers.push({
            name: 'soak_test_service',
            stop: () => {
                soakTestService.stop('app_shutdown')
            },
        })
        activeBackgroundWorkers.push({
            name: 'scheduler_service',
            stop: () => {
                schedulerService.stop()
            },
        })

        if (appShutdownService.isShuttingDown() || appShutdownService.isComplete()) {
            logBootstrap('[Bootstrap] Shutdown active after async imports, aborting before recovery/window/schedulers')
            return
        }

        // Durable review queue crash recovery (job_queue load + zombie campaign reconcile)
        // Does not auto-start browsers; resume is deterministic via AutomationController.
        try {
            const { reviewRecoveryService } = await import('./automation/ReviewRecoveryService')
            const recovery = await reviewRecoveryService.recoverOnBoot()
            logBootstrap(
                `[ReviewRecovery] pendingJobs=${recovery.totalPendingJobs}, ` +
                `zombies=${recovery.zombieCampaigns.length}, ` +
                `resumeCandidates=${recovery.pendingCampaignIds.join(',') || 'none'}`
            )
        } catch (recoveryError) {
            logBootstrap('[ReviewRecovery] Boot recovery failed (non-fatal)', recoveryError)
        }

        const { registerAllHandlers } = await import('./ipc')
        // Register IPC handlers
        logBootstrap('Registering IPC handlers...')
        registerAllHandlers()
        logBootstrap('IPC handlers registered')

        const soakBoot = soakTestService.startFromEnvironment()
        if (soakBoot?.running) {
            logBootstrap(`[SoakTest] Started session ${soakBoot.sessionId} (${soakBoot.durationHours}h, ${soakBoot.intervalSeconds}s) -> ${soakBoot.logPath}`)
        }

        if (appShutdownService.isShuttingDown() || appShutdownService.isComplete()) {
            logBootstrap('[Bootstrap] Shutdown active before window creation, aborting')
            return
        }

        // Create window
        createWindow()
        logBootstrap('Main window created')

        // Guard before starting schedulers/workers
        if (appShutdownService.isShuttingDown() || appShutdownService.isComplete()) {
            logBootstrap('[Bootstrap] Shutdown active before scheduler start, aborting')
            return
        }

        // Wire scheduler → real automation via DI (no circular import in SchedulerService).
        // start/resume only; schedule lastRunAt/nextRunAt advance only on runner success.
        try {
            const { reviewRecoveryService } = await import('./automation/ReviewRecoveryService')
            schedulerService.setMainWindow(mainWindow)
            schedulerService.setAutomationRunner({
                startCampaign: (campaignId) => automationController.startCampaign(campaignId),
                resumeCampaign: (campaignId) => automationController.resumeCampaign(campaignId),
                hasPendingDurableJobs: async (campaignId) => {
                    const plan = await reviewRecoveryService.getResumePlan(campaignId)
                    return plan.canResume
                },
            })
            schedulerService.start()
            const { warmupSchedulerService } = await import('./services/WarmupSchedulerService')
            warmupSchedulerService.start()
            activeBackgroundWorkers.push({
                name: 'warmup_scheduler',
                stop: () => {
                    warmupSchedulerService.stop()
                },
            })
            logBootstrap('Scheduler service started (automation runner wired)')

            // Sprint 3: start background workers if enabled
            try {
                const { loadSettings: loadS3Settings } = await import('./ipc/settings')
                const s3 = loadS3Settings()
                if (s3.enableHelpfulVotes) {
                    const { helpfulVoteWorker } = await import('./services/HelpfulVoteWorker')
                    helpfulVoteWorker.start()
                    activeBackgroundWorkers.push({
                        name: 'helpful_vote_worker',
                        stop: () => {
                            helpfulVoteWorker.stop()
                        },
                    })
                    logBootstrap('HelpfulVoteWorker started')
                }
                if (s3.enableReviewVerification) {
                    const { reviewVerificationWorker } = await import('./services/ReviewVerificationWorker')
                    reviewVerificationWorker.start()
                    activeBackgroundWorkers.push({
                        name: 'review_verification_worker',
                        stop: () => {
                            reviewVerificationWorker.stop()
                        },
                    })
                    logBootstrap('ReviewVerificationWorker started')
                }
            } catch (workerErr) {
                logBootstrap('Sprint 3 workers failed to start (non-fatal)', workerErr)
            }
        } catch (schedulerError) {
            logBootstrap('Scheduler service failed to start (non-fatal)', schedulerError)
        }

        try {
            const {
                configureAgentBridge,
                getAgentBridgeService,
                syncAgentBridgeFromSettings,
            } = await import('./services/AgentBridgeService')
            const { createAgentBridgeController } = await import('./services/agentBridgeController')
            configureAgentBridge({
                statePath: join(dataRoot.dataRoot, 'agent-bridge.json'),
                controller: createAgentBridgeController(),
            })
            await syncAgentBridgeFromSettings()
            activeBackgroundWorkers.push({
                name: 'agent_bridge',
                stop: () => getAgentBridgeService().stop(),
            })
            logBootstrap('Agent bridge synced from settings')
        } catch (bridgeError) {
            logBootstrap('Agent bridge failed to start (non-fatal)', bridgeError)
        }
    } catch (error) {
        logBootstrap('Failed to initialize app', error)
        dialog.showErrorBox(
            'MMO Auto Review - Startup Error',
            `Không thể khởi động ứng dụng.\n\n${stringifyError(error)}\n\nXem log: ${getBootstrapLogPath()}`
        )
        app.quit()
    }
})

if (!gotSingleInstanceLock) {
    app.quit()
} else {
    app.on('second-instance', () => {
        logBootstrap('Second instance requested, focusing existing window')
        if (mainWindow) {
            focusMainWindow()
            return
        }
        if (runtimeServices) createWindow()
    })
}

process.on('unhandledRejection', (reason) => {
    if (isStreamPipeError(reason)) {
        return
    }
    logBootstrap('Unhandled rejection', reason)
})

process.on('uncaughtException', (error) => {
    if (isStreamPipeError(error)) {
        return
    }
    runtimeHealthService.recordExitReason('uncaught_exception')
    logBootstrap('Uncaught exception', error)
    dialog.showErrorBox(
        'MMO Auto Review - Fatal Error',
        `${stringifyError(error)}\n\nXem log: ${getBootstrapLogPath()}`
    )
})

app.on('activate', () => {
    if (runtimeServices && BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

// Basic IPC handlers
ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:openExternal', (_event, url: string) => openExternalUrl(url))
ipcMain.handle('app:reloadWindow', (_event, reason?: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        reloadWindow(mainWindow, reason || 'renderer_requested_reload')
    }
    return { success: true }
})
ipcMain.handle('app:reportRendererEvent', (_event, payload: { level?: 'info' | 'warn' | 'error'; message: string }) => {
    const level = payload?.level || 'info'
    const message = payload?.message || 'Renderer event'
    logBootstrap(`[Renderer:${level}] ${message}`)
    return { success: true }
})

// Get app paths
ipcMain.handle('app:getPaths', () => ({
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    temp: app.getPath('temp'),
    home: app.getPath('home'),
}))
