import { BrowserWindow, app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { autoUpdater } from 'electron-updater'
import { automationController } from '../automation/AutomationController'
import { trafficBoostEngine } from '../automation/TrafficBoostEngine'
import { loadSettings } from '../ipc/settings'

export type UpdaterStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled'

interface UpdateState {
    enabled: boolean
    status: UpdaterStatus
    checking: boolean
    available: boolean
    downloaded: boolean
    progress: number
    bytesPerSecond?: number
    transferred?: number
    total?: number
    pendingInstall: boolean
    blockedReason?: string
    currentVersion: string
    latestVersion?: string
    error?: string
    checkedAt?: string
}

class UpdateService {
    private state: UpdateState = {
        enabled: false,
        status: 'disabled',
        checking: false,
        available: false,
        downloaded: false,
        progress: 0,
        pendingInstall: false,
        currentVersion: app.getVersion(),
    }

    private initialized = false
    private pendingInstallWatcher: NodeJS.Timeout | null = null
    private startupAutoCheckTimer: NodeJS.Timeout | null = null

    init(): void {
        if (this.initialized) {
            return
        }
        this.initialized = true

        const enablement = this.resolveEnablement()
        if (!enablement.enabled) {
            this.state = {
                ...this.state,
                enabled: false,
                status: 'disabled',
                blockedReason: enablement.reason,
                error: undefined,
            }
            this.broadcast()
            return
        }

        this.state = {
            ...this.state,
            enabled: true,
            status: 'idle',
            blockedReason: undefined,
            error: undefined,
        }

        autoUpdater.autoDownload = false
        autoUpdater.autoInstallOnAppQuit = false

        autoUpdater.on('checking-for-update', () => {
            this.state = {
                ...this.state,
                status: 'checking',
                checking: true,
                error: undefined,
                checkedAt: new Date().toISOString(),
            }
            this.broadcast()
        })

        autoUpdater.on('update-available', (info) => {
            this.state = {
                ...this.state,
                status: 'available',
                checking: false,
                available: true,
                downloaded: false,
                progress: 0,
                pendingInstall: false,
                blockedReason: undefined,
                latestVersion: info.version,
                error: undefined,
                checkedAt: new Date().toISOString(),
            }
            this.broadcast()
        })

        autoUpdater.on('update-not-available', (info) => {
            this.state = {
                ...this.state,
                status: 'idle',
                checking: false,
                available: false,
                downloaded: false,
                progress: 0,
                pendingInstall: false,
                blockedReason: undefined,
                latestVersion: info.version,
                error: undefined,
                checkedAt: new Date().toISOString(),
            }
            this.broadcast()
        })

        autoUpdater.on('download-progress', (progress) => {
            this.state = {
                ...this.state,
                status: 'downloading',
                checking: false,
                available: true,
                progress: Number.isFinite(progress.percent) ? progress.percent : this.state.progress,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total,
                error: undefined,
            }
            this.broadcast()
        })

        autoUpdater.on('update-downloaded', (info) => {
            this.state = {
                ...this.state,
                status: 'downloaded',
                checking: false,
                available: true,
                downloaded: true,
                progress: 100,
                latestVersion: info.version,
                error: undefined,
                checkedAt: new Date().toISOString(),
            }
            this.refreshInstallBlockState()
            this.broadcast()
        })

        autoUpdater.on('error', (error) => {
            const message = error?.message || 'Unknown update error'
            this.state = {
                ...this.state,
                status: this.state.downloaded ? 'downloaded' : 'error',
                checking: false,
                error: message,
                checkedAt: new Date().toISOString(),
            }
            this.broadcast()
        })

        this.startPendingInstallWatcher()
        this.scheduleStartupAutoCheck()
        this.broadcast()
    }

    getState(): UpdateState {
        if (this.refreshInstallBlockState()) {
            this.broadcast()
        }
        return { ...this.state }
    }

    async checkForUpdates(): Promise<UpdateState> {
        if (!this.state.enabled) {
            return {
                ...this.state,
                checkedAt: new Date().toISOString(),
            }
        }

        try {
            await autoUpdater.checkForUpdates()
        } catch (error: any) {
            this.state = {
                ...this.state,
                status: this.state.downloaded ? 'downloaded' : 'error',
                checking: false,
                error: error?.message || 'Failed to check for updates',
                checkedAt: new Date().toISOString(),
            }
            this.broadcast()
        }

        return { ...this.state }
    }

    async downloadUpdate(): Promise<UpdateState> {
        if (!this.state.enabled) {
            return { ...this.state }
        }

        if (!this.state.available) {
            return {
                ...this.state,
                error: 'No available update to download',
            }
        }

        try {
            this.state = {
                ...this.state,
                status: 'downloading',
                checking: false,
                progress: 0,
                error: undefined,
            }
            this.broadcast()

            await autoUpdater.downloadUpdate()
        } catch (error: any) {
            this.state = {
                ...this.state,
                status: this.state.downloaded ? 'downloaded' : 'error',
                checking: false,
                error: error?.message || 'Failed to download update',
            }
            this.broadcast()
        }

        return { ...this.state }
    }

    async checkAndDownload(): Promise<UpdateState> {
        const stateAfterCheck = await this.checkForUpdates()
        if (!stateAfterCheck.enabled) {
            return stateAfterCheck
        }

        if (stateAfterCheck.available && !stateAfterCheck.downloaded) {
            return this.downloadUpdate()
        }

        return this.getState()
    }

    installUpdate(): UpdateState {
        if (!this.state.enabled) {
            return { ...this.state }
        }

        if (!this.state.downloaded) {
            const nextState = {
                ...this.state,
                error: 'No downloaded update to install',
            }
            this.state = nextState
            this.broadcast()
            return { ...nextState }
        }

        if (this.refreshInstallBlockState()) {
            this.broadcast()
        }
        if (this.state.pendingInstall) {
            this.state = {
                ...this.state,
                error: this.state.blockedReason || 'Install is blocked while campaign is running',
            }
            this.broadcast()
            return { ...this.state }
        }

        autoUpdater.quitAndInstall(false, true)
        return { ...this.state }
    }

    private resolveEnablement(): { enabled: boolean; reason?: string } {
        if (!app.isPackaged) {
            return {
                enabled: false,
                reason: 'Auto update is disabled in development mode',
            }
        }

        const portableOrUnpacked = Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
            || process.execPath.toLowerCase().includes('win-unpacked')
        if (portableOrUnpacked) {
            return {
                enabled: false,
                reason: 'Auto update only supports installed NSIS build (khong ho tro portable/win-unpacked)',
            }
        }

        const candidates = [
            join(process.resourcesPath, 'app-update.yml'),
            join(dirname(process.execPath), 'resources', 'app-update.yml'),
            join(dirname(process.execPath), 'app-update.yml'),
        ]
        const hasUpdateConfig = candidates.some(candidate => existsSync(candidate))
        if (!hasUpdateConfig) {
            return {
                enabled: false,
                reason: 'Missing app-update.yml publish config. Rebuild installer with publish provider',
            }
        }

        return { enabled: true }
    }

    private isAnyCampaignRunning(): boolean {
        try {
            if (trafficBoostEngine.isRunning()) {
                return true
            }
        } catch {
            // Ignore and continue checking other engines.
        }

        try {
            if (automationController.isRunning()) {
                return true
            }
        } catch {
            // Ignore and continue checking other engines.
        }

        return false
    }

    private refreshInstallBlockState(): boolean {
        if (!this.state.enabled) {
            return false
        }

        if (!this.state.downloaded) {
            if (!this.state.pendingInstall && !this.state.blockedReason) {
                return false
            }
            this.state = {
                ...this.state,
                pendingInstall: false,
                blockedReason: undefined,
            }
            return true
        }

        const blocked = this.isAnyCampaignRunning()
        const reason = blocked
            ? 'Campaign dang chay. Da tai xong update, vui long doi campaign ket thuc roi khoi dong lai de cai dat.'
            : undefined

        if (this.state.pendingInstall === blocked && this.state.blockedReason === reason) {
            return false
        }

        this.state = {
            ...this.state,
            pendingInstall: blocked,
            blockedReason: reason,
        }
        return true
    }

    private scheduleStartupAutoCheck(): void {
        const settings = loadSettings()
        if (settings.autoUpdate === false) {
            return
        }

        this.startupAutoCheckTimer = setTimeout(() => {
            this.checkForUpdates().catch((error) => {
                this.state = {
                    ...this.state,
                    status: this.state.downloaded ? 'downloaded' : 'error',
                    checking: false,
                    error: error instanceof Error ? error.message : String(error),
                }
                this.broadcast()
            })
        }, 7000)
    }

    private startPendingInstallWatcher(): void {
        if (this.pendingInstallWatcher) {
            clearInterval(this.pendingInstallWatcher)
        }

        this.pendingInstallWatcher = setInterval(() => {
            if (!this.state.enabled || !this.state.downloaded) {
                return
            }
            if (this.refreshInstallBlockState()) {
                this.broadcast()
            }
        }, 3000)
    }

    private broadcast(): void {
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
            win.webContents.send('updates:state', this.state)
        }
    }
}

export const updateService = new UpdateService()
