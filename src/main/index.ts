import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { dataRootService } from './services/DataRootService'
import { getRotatingLogger } from './utils/RotatingLogger'
import { layaSidecarManager } from './services/LayaSidecarManager'

type RuntimeServices = {
    soakTestService: typeof import('./services/SoakTestService')['soakTestService']
    automationController: typeof import('./automation/AutomationController')['automationController']
    trafficBoostEngine: typeof import('./automation/TrafficBoostEngine')['trafficBoostEngine']
    schedulerService: typeof import('./services/SchedulerService')['schedulerService']
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
let rendererRecoveryAttempts = 0
let runtimeServices: RuntimeServices | null = null

function openExternalUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Blocked external URL protocol: ${parsed.protocol}`)
    }
    return shell.openExternal(parsed.toString())
}

function getBootstrapLogPath(): string {
    try {
        const base = join(app.getPath('appData'), 'MMO Auto Review')
        if (!existsSync(base)) {
            mkdirSync(base, { recursive: true })
        }
        return join(base, 'bootstrap.log')
    } catch {
        return join(process.cwd(), 'bootstrap.log')
    }
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
    if (error) {
        console.error(message, error)
    } else {
        console.log(message)
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

function reloadRenderer(reason: string): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return
    }

    rendererRecoveryAttempts += 1
    logBootstrap(`Reloading renderer after ${reason} (attempt ${rendererRecoveryAttempts})`)
    try {
        mainWindow.webContents.reloadIgnoringCache()
    } catch (error) {
        logBootstrap('Failed to reload renderer', error)
    }
    focusMainWindow()
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
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

    const forceShowTimer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) {
            return
        }
        logBootstrap('ready-to-show timeout, forcing window visible')
        focusMainWindow()
    }, 12000)

    // Wait until ready to show to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        clearTimeout(forceShowTimer)
        focusMainWindow()
    })

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
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

    mainWindow.webContents.on('did-finish-load', () => {
        rendererRecoveryAttempts = 0
        logBootstrap('Main window renderer finished load')
    })

    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level < 2) {
            return
        }
        logBootstrap(`Renderer console [level=${level}] ${message} (${sourceId}:${line})`)
    })

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        logBootstrap(`Renderer process gone (reason=${details.reason}, exitCode=${details.exitCode})`)
        reloadRenderer(`render_process_gone:${details.reason}`)
    })

    mainWindow.on('unresponsive', () => {
        logBootstrap('Main window is unresponsive')
    })

    mainWindow.on('focus', () => {
        // Do not reloadIgnoringCache() on focus. That wiped React state and
        // leaked memory whenever automation was running in the background.
    })

    // Load the app
    if (process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
        mainWindow.webContents.openDevTools()
    } else {
        mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
    }

    mainWindow.on('closed', () => {
        mainWindow = null
        runtimeServices?.schedulerService.setMainWindow(null)
    })

    // Keep scheduler notifications bound to the live BrowserWindow.
    runtimeServices?.schedulerService.setMainWindow(mainWindow)
}

// Initialize app
app.whenReady().then(async () => {
    if (!gotSingleInstanceLock) {
        app.quit()
        return
    }
    try {
        logBootstrap('App startup begin')
        const dataRoot = dataRootService.configurePortableUserDataPath()
        logBootstrap(`[Bootstrap] Data root: ${dataRoot.dataRoot} (portable=${dataRoot.portable})`)

        const { initDatabase, closeDatabase } = await import('./database')
        closeDatabaseRef = closeDatabase

        // Initialize database
        logBootstrap('Initializing database...')
        initDatabase()
        logBootstrap('Database initialized successfully')

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

        // Create window
        createWindow()
        logBootstrap('Main window created')

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
            logBootstrap('Scheduler service started (automation runner wired)')
        } catch (schedulerError) {
            logBootstrap('Scheduler service failed to start (non-fatal)', schedulerError)
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
    logBootstrap('Unhandled rejection', reason)
})

process.on('uncaughtException', (error) => {
    logBootstrap('Uncaught exception', error)
    dialog.showErrorBox(
        'MMO Auto Review - Fatal Error',
        `${stringifyError(error)}\n\nXem log: ${getBootstrapLogPath()}`
    )
})

app.on('window-all-closed', async () => {
    try {
        runtimeServices?.soakTestService.stop('app_shutdown')
    } catch (error) {
        logBootstrap('Failed to stop soak test during shutdown', error)
    }

    try {
        runtimeServices?.schedulerService.stop()
        const { warmupSchedulerService } = require('./services/WarmupSchedulerService')
        warmupSchedulerService.stop()
    } catch (error) {
        logBootstrap('Failed to stop scheduler during shutdown', error)
    }

    // Stop browsers before closing the database so Chrome is not orphaned.
    try {
        await runtimeServices?.automationController.stop()
    } catch (error) {
        logBootstrap('Failed to stop automation during shutdown', error)
    }

    try {
        await runtimeServices?.trafficBoostEngine.stopCampaign()
    } catch (error) {
        logBootstrap('Failed to stop traffic campaigns during shutdown', error)
    }

    try {
        await layaSidecarManager.stop()
    } catch (error) {
        logBootstrap('Failed to stop Laya sidecar during shutdown', error)
    }

    try {
        const { proxyBridgeService } = await import('./services/ProxyBridgeService')
        await proxyBridgeService.closeAll()
    } catch (error) {
        logBootstrap('Failed to close proxy bridges during shutdown', error)
    }

    // Close database on app quit
    if (closeDatabaseRef) {
        closeDatabaseRef()
    }


    if (process.platform !== 'darwin') {
        app.quit()
    }
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
    reloadRenderer(reason || 'renderer_requested_reload')
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
