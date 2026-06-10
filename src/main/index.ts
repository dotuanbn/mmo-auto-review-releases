import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { dataRootService } from './services/DataRootService'
import { soakTestService } from './services/SoakTestService'
import { automationController } from './automation/AutomationController'
import { trafficBoostEngine } from './automation/TrafficBoostEngine'

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
let lastMainWindowBlurAt = 0

function openExternalUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Blocked external URL protocol: ${parsed.protocol}`)
    }
    return shell.openExternal(parsed.toString())
}
let lastForegroundReloadAt = 0

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
        appendFileSync(getBootstrapLogPath(), line)
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

function hasActiveAutomationWindowWork(): boolean {
    return automationController.isRunning() || trafficBoostEngine.isRunning()
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

    mainWindow.on('blur', () => {
        lastMainWindowBlurAt = Date.now()
    })

    mainWindow.on('focus', () => {
        const hiddenDurationMs = lastMainWindowBlurAt > 0 ? Date.now() - lastMainWindowBlurAt : 0
        const reloadedRecently = Date.now() - lastForegroundReloadAt < 10_000

        if (!hasActiveAutomationWindowWork() || hiddenDurationMs < 1_500 || reloadedRecently) {
            return
        }

        lastForegroundReloadAt = Date.now()
        reloadRenderer(`focus_after_background_${hiddenDurationMs}ms`)
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
    })
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
        createWindow()
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

app.on('window-all-closed', () => {
    try {
        soakTestService.stop('app_shutdown')
    } catch (error) {
        logBootstrap('Failed to stop soak test during shutdown', error)
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
    if (BrowserWindow.getAllWindows().length === 0) {
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
