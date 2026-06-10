import { ipcMain, dialog, BrowserWindow } from 'electron'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { fproxyService } from '../services/FProxyService'
import { setRuntimeLogLevel } from '../utils/runtimeLogger'

// Simple JSON-based settings storage
const getSettingsPath = () => path.join(app.getPath('userData'), 'settings.json')

const DEFAULT_SETTINGS: Record<string, any> = {
    // Browser
    headless: false,
    hideAutomation: true,
    saveProfiles: true,
    maxConcurrentBrowsers: 3,
    randomizeUserAgent: true,
    randomizeViewport: true,

    // AI / Groq
    groqApiKey: '',
    groqModel: 'llama-3.3-70b-versatile',
    defaultReviewLanguage: 'vi',
    defaultReviewStyle: 'casual',
    defaultReviewLength: 'medium',

    // Local AI / Ollama
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5:latest',

    // Review Defaults
    defaultRating: 5,
    includePhotos: false,
    autoGenerateReview: true,
    manualReviewSubmit: true,
    allowAutoSubmitOnTrustedHosts: true,
    trustedAutoSubmitHosts: 'localhost,127.0.0.1',

    // Traffic Defaults
    defaultTrafficMode: 'organic',
    defaultVisitsPerLocation: 10,
    defaultActionsPerVisit: 4,
    trafficDelayMin: 10,
    trafficDelayMax: 30,

    // Proxy
    useProxy: false,
    rotateProxyPerSession: true,
    autoRemoveDeadProxies: false,
    fproxyApiKey: '',
    fproxyLocation: 0,

    // Timing
    delayMin: 30,
    delayMax: 60,
    maxRetries: 3,

    // Storage
    dataDir: '',

    // App
    autoUpdate: true,

    // Runtime Policy V2
    captchaMode: 'hybrid',
    captchaAutoSkipMaxStrikes: 2,
    captchaManualWaitSeconds: 180,
    queueConcurrency: 2,
    queueIntervalMs: 5000,
    networkRetryMax: 3,
    uiRetryMax: 2,
    logLevel: 'info',
    ragEnabled: true,
    ragTopK: 4,
    ragMaxContextChars: 1200,
    ragWriteMode: 'risk_only',
    ragLatencyBudgetMs: 850,
    ragMinScore: 0.16,
    ragEntryTtlHours: 336,
    ragDedupeWindowMinutes: 240,

    // CAPTCHA Solver
    captchaSolverProvider: 'none',  // 'none' | '2captcha' | 'capsolver'
    captchaSolverApiKey: '',

    // Analytics (Google APIs)
    analyticsKeyFilePath: '',

    // In-house AI (Hugging Face Transformers.js)
    hfModelEnabled: false,          // Toggle global on/off
    hfTextGenModel: '',             // Override default text-gen model (empty = use registry default)
    hfAutoUnloadMinutes: 5,         // Auto-dispose idle models after N minutes (0 = disabled)
    hfMaxMemoryMB: 0,               // 0 = auto (based on SystemResourceDetector)
}

function syncFProxyServiceWithSettings(settings: Record<string, any>) {
    const useProxy = settings.useProxy === true
    const apiKey = typeof settings.fproxyApiKey === 'string' ? settings.fproxyApiKey.trim() : ''

    if (useProxy && apiKey) {
        fproxyService.setApiKey(apiKey)
        return
    }

    fproxyService.clearConfiguration(useProxy ? 'missing_api_key' : 'proxy_disabled_in_settings')
}

function syncRuntimeLoggerWithSettings(settings: Record<string, any>) {
    setRuntimeLogLevel(settings.logLevel)
}

export const loadSettings = (): Record<string, any> => {
    try {
        const settingsPath = getSettingsPath()
        if (fs.existsSync(settingsPath)) {
            const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            const merged = { ...DEFAULT_SETTINGS, ...saved }
            syncRuntimeLoggerWithSettings(merged)
            return merged
        }
    } catch (error) {
        console.error('Failed to load settings:', error)
    }
    syncRuntimeLoggerWithSettings(DEFAULT_SETTINGS)
    return { ...DEFAULT_SETTINGS }
}

export const saveSettings = (settings: Record<string, any>): void => {
    try {
        const settingsPath = getSettingsPath()
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        syncRuntimeLoggerWithSettings(settings)
    } catch (error) {
        console.error('Failed to save settings:', error)
        throw error
    }
}

export const saveSetting = (key: string, value: any): void => {
    const settings = loadSettings()
    settings[key] = value
    saveSettings(settings)
}

export function registerSettingsHandlers() {
    // Get a specific setting
    ipcMain.handle('settings:get', async (_event, key: string) => {
        const settings = loadSettings()
        return settings[key]
    })

    // Set a specific setting
    ipcMain.handle('settings:set', async (_event, key: string, value: any) => {
        const settings = loadSettings()
        settings[key] = value
        saveSettings(settings)
    })

    // Get all settings
    ipcMain.handle('settings:getAll', async () => {
        const settings = loadSettings()
        syncFProxyServiceWithSettings(settings)
        return settings
    })

    // Save all settings at once
    ipcMain.handle('settings:saveAll', async (_event, newSettings: Record<string, any>) => {
        const current = loadSettings()
        const merged = { ...current, ...newSettings }
        saveSettings(merged)
        syncFProxyServiceWithSettings(merged)
        return merged
    })

    // Reset to defaults
    ipcMain.handle('settings:resetDefaults', async () => {
        const reset = { ...DEFAULT_SETTINGS }
        saveSettings(reset)
        syncFProxyServiceWithSettings(reset)
        return { ...DEFAULT_SETTINGS }
    })

    // Dialog to select directory
    ipcMain.handle('dialog:selectDirectory', async () => {
        const window = BrowserWindow.getFocusedWindow()
        if (!window) return null

        const result = await dialog.showOpenDialog(window, {
            properties: ['openDirectory'],
            title: 'Select Data Directory',
        })

        if (result.canceled || result.filePaths.length === 0) {
            return null
        }

        return result.filePaths[0]
    })
}
