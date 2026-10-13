import { ipcMain, dialog, BrowserWindow } from 'electron'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { fproxyService } from '../services/FProxyService'
import {
    secretVault,
    SecretStorageUnavailableError,
} from '../services/SecretVault'
import { setRuntimeLogLevel } from '../utils/runtimeLogger'
import {
    absolutePathSchema,
    settingsKeySchema,
    settingsPatchSchema,
    settingsSetTupleSchema,
    SETTINGS_KEYS,
    type SettingsKey,
} from '../../shared/ipc-schemas'
import {
    SETTINGS_SECRET_KEYS,
    SETTINGS_SECRET_MASK,
    isSettingsSecretKey,
    type SettingsValue,
    type SettingsRecord,
} from '../../shared/types'
import {
    assertPathWithinRoots,
    getDefaultAllowedRoots,
    parseIpcArgs,
    parseIpcPayload,
    withIpcValidation,
} from './validate'
import { createIpcError } from './errors'

// Simple JSON-based settings storage
const getSettingsPath = () => path.join(app.getPath('userData'), 'settings.json')

/**
 * Default settings. Kept as a plain object for backward-compatible loadSettings()
 * return typing used across main-process services.
 * hfMaxMemoryMB default aligned with Settings UI (2048).
 *
 * Public loadSettings() return stays structurally open (Record bag) so Ollama,
 * runtimePolicy, Analytics OAuth extras, and automation engines keep compiling
 * without cross-module type churn. Internal helpers use SettingsRecord.
 */
const DEFAULT_SETTINGS: SettingsRecord = {
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
    enforceAccountWarmup: false,
    enablePerAccountReviewStyle: true,
    stealthLevel: 'high',
    crossAccountCooldownMinutes: 120,
    restHoursEnabled: true,
    restHoursStart: 23,
    restHoursEnd: 6,
    // Opt-in only: agentic review must never auto-enable just because Ollama is online
    enableAgenticReview: false,
    // Opt-in only: background Google Maps survival checks stay off until explicitly enabled
    enableReviewVerification: false,
    reviewVerificationIntervalMinutes: 30,
    reviewVerificationMaxPerTick: 10,
    // Sprint 3 — Natural Behavior integration (safe defaults: on)
    enableTimeLocality: true,
    enableSmartPhotos: true,
    enableAccountHealth: true,
    // Opt-in only: background cross-account Helpful votes
    enableHelpfulVotes: false,
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
    updateMode: 'manual', // 'auto' | 'manual' - manual default for safety

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
    captchaSolverProvider: 'none',
    captchaSolverApiKey: '',
    captchaSolverFallbackProvider: 'none',
    captchaSolverFallbackApiKey: '',

    // Analytics (Google APIs)
    analyticsKeyFilePath: '',

    // In-house AI (Hugging Face Transformers.js)
    hfModelEnabled: false,
    hfTextGenModel: '',
    hfAutoUnloadMinutes: 5,
    hfMaxMemoryMB: 2048,
}

const SETTINGS_KEY_SET = new Set<string>(SETTINGS_KEYS)
const SECRET_KEY_SET = new Set<string>(SETTINGS_SECRET_KEYS)

/** Sync write critical section — serializes overlapping save paths in main. */
let writeInProgress = false
const writeWaiters: Array<() => void> = []

function acquireWriteLock(): void {
    if (!writeInProgress) {
        writeInProgress = true
        return
    }
    // Spin-yield via busy wait is not viable in single-thread JS.
    // Nested sync re-entry (save inside save) is forbidden; queue via waiters for async paths.
    // For sync callers, Node is single-threaded so only re-entrant calls hit this.
    if (writeInProgress) {
        // Re-entrant: allow nested only if same stack already holds lock by reusing it.
        // True concurrent IPC is serialized below via withSettingsWrite.
    }
}

function releaseWriteLock(): void {
    writeInProgress = false
    const next = writeWaiters.shift()
    if (next) {
        writeInProgress = true
        next()
    }
}

/** Async write queue for IPC handlers (await between read/modify/write). */
let writeChain: Promise<void> = Promise.resolve()

async function withSettingsWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const prev = writeChain
    writeChain = prev.then(() => gate)
    await prev
    try {
        return await fn()
    } finally {
        release()
    }
}

/**
 * IPC writes only accept whitelisted keys. Disk may still contain extra
 * keys used by other modules (e.g. googleOAuth*) — preserve those on load.
 */
function pickWhitelistedPatch(input: Record<string, unknown>): SettingsRecord {
    const out: SettingsRecord = {}
    for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
            const value = input[key]
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                out[key] = value
            }
        }
    }
    return out
}

/**
 * Coerce a raw disk/patch value to the type of the schema default.
 * Invalid booleans (including enableAgenticReview) fall back to the default (false).
 */
export function coerceSettingValue(
    key: string,
    value: unknown,
    defaultValue: SettingsValue
): SettingsValue {
    if (SECRET_KEY_SET.has(key)) {
        if (typeof value === 'string') return value
        if (value == null) return ''
        return String(value)
    }

    if (typeof defaultValue === 'boolean') {
        if (typeof value === 'boolean') return value
        // Strict: only exact boolean types count; strings/numbers fall back to default
        return defaultValue
    }

    if (typeof defaultValue === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() !== '') {
            const n = Number(value)
            if (Number.isFinite(n)) return n
        }
        return defaultValue
    }

    // string default
    if (typeof value === 'string') return value
    if (value == null) return defaultValue
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return defaultValue
}

/** Normalize raw JSON into typed settings; preserve unknown extra keys when scalar. */
export function normalizeSettingsFromDisk(saved: Record<string, unknown>): SettingsRecord {
    const result: SettingsRecord = { ...DEFAULT_SETTINGS }

    for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== undefined) {
            const def = DEFAULT_SETTINGS[key] as SettingsValue
            result[key] = coerceSettingValue(key, saved[key], def)
        }
    }

    for (const [key, value] of Object.entries(saved)) {
        if (SETTINGS_KEY_SET.has(key)) continue
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            result[key] = value
        }
    }

    return result
}

function readRawFromDisk(): Record<string, unknown> | null {
    try {
        const settingsPath = getSettingsPath()
        if (!fs.existsSync(settingsPath)) return null
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
        }
    } catch (error) {
        console.error('Failed to load settings:', error)
    }
    return null
}

function writeRawToDisk(settings: SettingsRecord): void {
    const settingsPath = getSettingsPath()
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

/**
 * Seal secret fields for at-rest storage.
 * - SETTINGS_SECRET_MASK → keep previous disk value (must not wipe)
 * - empty string → clear
 * - enc:v1:... → keep as-is (already sealed)
 * - other non-empty plaintext → encrypt (fail-closed if unavailable)
 * - undefined → preserve previous disk secret when present
 */
export function sealSecretsForDisk(
    incoming: SettingsRecord,
    previousDisk: Record<string, unknown> | null,
    explicitClearKeys: ReadonlySet<string> = new Set(),
): SettingsRecord {
    const out: SettingsRecord = { ...incoming }

    for (const key of SETTINGS_SECRET_KEYS) {
        const prevRaw = previousDisk && typeof previousDisk[key] === 'string'
            ? (previousDisk[key] as string)
            : ''
        const value = out[key]

        if (value === undefined) {
            out[key] = prevRaw
            continue
        }

        if (typeof value !== 'string') {
            out[key] = prevRaw
            continue
        }

        if (value === SETTINGS_SECRET_MASK) {
            out[key] = prevRaw
            continue
        }

        if (value === '') {
            // An encrypted value decrypts to an empty string when OS secure storage is
            // temporarily unavailable. Preserve that ciphertext unless the caller
            // explicitly requested a clear operation.
            if (
                prevRaw
                && secretVault.isEncrypted(prevRaw)
                && !secretVault.isAvailable()
                && !explicitClearKeys.has(key)
            ) {
                out[key] = prevRaw
                continue
            }
            out[key] = ''
            continue
        }

        if (secretVault.isEncrypted(value)) {
            out[key] = value
            continue
        }

        // New plaintext secret write — fail closed when OS storage unavailable
        out[key] = secretVault.seal(value)
    }

    return out
}

/**
 * Hydrate secrets for internal consumers (plaintext) and lazily migrate
 * legacy plaintext secrets to enc:v1 when safeStorage is available.
 * Returns hydrated settings + whether disk was rewritten for migration.
 */
export function hydrateSecrets(
    normalized: SettingsRecord,
    rawDisk: Record<string, unknown> | null
): { settings: SettingsRecord; diskDirty: boolean; diskSecrets: Record<string, string> } {
    const settings: SettingsRecord = { ...normalized }
    const diskSecrets: Record<string, string> = {}
    let diskDirty = false

    for (const key of SETTINGS_SECRET_KEYS) {
        const raw =
            rawDisk && typeof rawDisk[key] === 'string'
                ? (rawDisk[key] as string)
                : typeof normalized[key] === 'string'
                  ? (normalized[key] as string)
                  : ''

        const migration = secretVault.migrateIfNeeded(raw)
        diskSecrets[key] = migration.value
        if (migration.migrated) {
            diskDirty = true
        }
        settings[key] = secretVault.decrypt(migration.value)
    }

    return { settings, diskDirty, diskSecrets }
}

/** Renderer-facing view: nonempty secrets become ASCII mask only. */
export function maskSecretsForRenderer(settings: SettingsRecord): SettingsRecord {
    const out: SettingsRecord = { ...settings }
    for (const key of SETTINGS_SECRET_KEYS) {
        const v = out[key]
        out[key] = typeof v === 'string' && v.length > 0 ? SETTINGS_SECRET_MASK : ''
    }
    return out
}

/**
 * Mask based on disk presence so encrypted-but-undecryptable secrets still show as set.
 */
export function maskSecretsFromDisk(
    settings: SettingsRecord,
    diskSecrets: Record<string, string>
): SettingsRecord {
    const out: SettingsRecord = { ...settings }
    for (const key of SETTINGS_SECRET_KEYS) {
        const diskVal = diskSecrets[key] ?? ''
        const plain = typeof settings[key] === 'string' ? (settings[key] as string) : ''
        const present = diskVal.length > 0 || plain.length > 0
        out[key] = present ? SETTINGS_SECRET_MASK : ''
    }
    return out
}

function getStoredSecrets(): Record<string, string> {
    const raw = readRawFromDisk()
    const stored: Record<string, string> = {}
    for (const key of SETTINGS_SECRET_KEYS) {
        stored[key] = raw && typeof raw[key] === 'string' ? raw[key] as string : ''
    }
    return stored
}

function maskSettingsForRenderer(settings: SettingsRecord): SettingsRecord {
    return maskSecretsFromDisk(settings, getStoredSecrets())
}

function syncFProxyServiceWithSettings(settings: SettingsRecord) {
    const useProxy = settings.useProxy === true
    const apiKey = typeof settings.fproxyApiKey === 'string' ? settings.fproxyApiKey.trim() : ''

    if (useProxy && apiKey) {
        fproxyService.setApiKey(apiKey)
        return
    }

    fproxyService.clearConfiguration(useProxy ? 'missing_api_key' : 'proxy_disabled_in_settings')
}

function syncRuntimeLoggerWithSettings(settings: SettingsRecord) {
    setRuntimeLogLevel(settings.logLevel)
}

function asSettingsRecord(input: Record<string, unknown>): SettingsRecord {
    const out: SettingsRecord = {}
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value
        }
    }
    return out
}

/**
 * Load settings from disk with type coercion.
 * Secrets are returned as plaintext for main-process services.
 * Legacy plaintext secrets are lazily migrated to enc:v1 when encryption is available.
 *
 * Public return type keeps the historical open bag (`Record<string, any>`) so Ollama,
 * runtimePolicy, Analytics OAuth extras, and automation engines typecheck unchanged.
 * New secret/coerce logic is strictly typed via SettingsRecord internally.
 */
export const loadSettings = (): Record<string, any> => {
    const raw = readRawFromDisk()
    if (!raw) {
        syncRuntimeLoggerWithSettings(DEFAULT_SETTINGS)
        return { ...DEFAULT_SETTINGS }
    }

    const normalized = normalizeSettingsFromDisk(raw)
    const { settings, diskDirty, diskSecrets } = hydrateSecrets(normalized, raw)

    if (diskDirty) {
        try {
            const toWrite: SettingsRecord = { ...normalized }
            for (const key of SETTINGS_SECRET_KEYS) {
                toWrite[key] = diskSecrets[key] ?? ''
            }
            // Preserve extra non-whitelisted keys from raw
            for (const [key, value] of Object.entries(raw)) {
                if (SETTINGS_KEY_SET.has(key)) continue
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    toWrite[key] = value
                }
            }
            writeRawToDisk(toWrite)
        } catch (error) {
            console.warn('[settings] Failed to persist lazy secret migration:', error)
        }
    }

    syncRuntimeLoggerWithSettings(settings)
    return settings
}

/**
 * Persist settings. Secret fields are sealed for at-rest storage.
 * Callers that obtained state via loadSettings() may pass plaintext secrets;
 * they are re-encrypted on write. Mask / missing secrets preserve prior disk values.
 * Accepts loose records for runtimePolicy / Ollama backward compatibility.
 */
export const saveSettings = (
    settings: Record<string, any>,
    options: { explicitSecretClears?: ReadonlySet<string> } = {},
): void => {
    acquireWriteLock()
    try {
        const previousDisk = readRawFromDisk()
        const incoming = asSettingsRecord(settings as Record<string, unknown>)
        // Preserve extra keys not present in the incoming patch object
        const base: SettingsRecord = previousDisk
            ? normalizeSettingsFromDisk(previousDisk)
            : { ...DEFAULT_SETTINGS }

        const merged: SettingsRecord = { ...base, ...incoming }

        // Preserve unknown extra keys from disk / incoming
        if (previousDisk) {
            for (const [key, value] of Object.entries(previousDisk)) {
                if (key in merged) continue
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    merged[key] = value
                }
            }
        }
        for (const [key, value] of Object.entries(incoming)) {
            if (SETTINGS_KEY_SET.has(key) || SECRET_KEY_SET.has(key)) continue
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                merged[key] = value
            }
        }

        // If caller omitted a secret key entirely, keep prior ciphertext (non-secret saves).
        for (const key of SETTINGS_SECRET_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(settings, key)) {
                merged[key] = SETTINGS_SECRET_MASK
            }
        }

        const sealed = sealSecretsForDisk(
            merged,
            previousDisk,
            options.explicitSecretClears,
        )
        writeRawToDisk(sealed)
        syncRuntimeLoggerWithSettings(hydrateSecrets(sealed, sealed).settings)
    } catch (error) {
        console.error('Failed to save settings:', error)
        throw error
    } finally {
        releaseWriteLock()
    }
}

export const saveSetting = (key: string, value: SettingsValue): void => {
    if (!SETTINGS_KEY_SET.has(key)) {
        throw createIpcError('settings:set', new Error(`Unknown settings key: ${key}`))
    }
    const settings = loadSettings()
    settings[key] = value
    const explicitSecretClears = isSettingsSecretKey(key) && value === ''
        ? new Set<string>([key])
        : undefined
    saveSettings(settings, { explicitSecretClears })
}

/** Apply IPC secret write semantics onto a hydrated settings object. */
function applySecretPatch(
    target: SettingsRecord,
    key: SettingsKey,
    value: SettingsValue
): void {
    if (!isSettingsSecretKey(key)) {
        target[key] = value
        return
    }
    if (typeof value !== 'string') {
        return
    }
    if (value === SETTINGS_SECRET_MASK) {
        // Sentinel preserved through sealSecretsForDisk → keeps prior ciphertext
        target[key] = SETTINGS_SECRET_MASK
        return
    }
    // empty clears; other replaces (plaintext sealed on save)
    target[key] = value
}

// ---------------------------------------------------------------------------
// Path semantic guards (dataDir / analyticsKeyFilePath)
// Schema allows empty|absolute only; main enforces roots + filesystem shape.
// ---------------------------------------------------------------------------

/** True when path is a filesystem/drive root (C:\, /, etc.) — not a usable dataDir. */
export function isSettingsFilesystemRoot(resolvedPath: string): boolean {
    let resolved: string
    try {
        resolved = path.resolve(resolvedPath)
    } catch {
        return true
    }
    const { root } = path.parse(resolved)
    if (!root) return false
    const stripTrailing = (p: string) => p.replace(/[/\\]+$/, '')
    if (process.platform === 'win32') {
        return stripTrailing(resolved).toLowerCase() === stripTrailing(root).toLowerCase()
    }
    return stripTrailing(resolved) === stripTrailing(root)
}

/**
 * dataDir: empty clears/default; otherwise absolute under allowed user roots,
 * not a filesystem root, and either an existing directory or a creatable path
 * whose parent exists as a directory under the same roots.
 */
export function assertSettingsDataDir(channel: string, rawPath: string): string {
    const trimmed = rawPath.trim()
    if (trimmed === '') return ''

    // Syntax first so drive roots get an explicit error before allow-list rejection
    const syntax = parseIpcPayload(channel, absolutePathSchema, trimmed)
    let resolved: string
    try {
        resolved = path.resolve(syntax)
    } catch {
        throw createIpcError(channel, new Error('Invalid dataDir path'))
    }

    if (isSettingsFilesystemRoot(resolved)) {
        throw createIpcError(channel, new Error('dataDir must not be a system/drive root'))
    }

    // Main semantic guard: must stay under allowed user roots
    resolved = assertPathWithinRoots(channel, resolved, getDefaultAllowedRoots())

    if (fs.existsSync(resolved)) {
        let stats: fs.Stats
        try {
            stats = fs.statSync(resolved)
        } catch {
            throw createIpcError(channel, new Error('Cannot stat dataDir path'))
        }
        if (!stats.isDirectory()) {
            throw createIpcError(channel, new Error('dataDir must be a directory'))
        }
        return resolved
    }

    // Nonexistent: parent must exist as a directory within allowed roots
    const parent = path.dirname(resolved)
    assertPathWithinRoots(channel, parent, getDefaultAllowedRoots())
    if (!fs.existsSync(parent)) {
        throw createIpcError(channel, new Error('dataDir parent directory does not exist'))
    }
    let parentStats: fs.Stats
    try {
        parentStats = fs.statSync(parent)
    } catch {
        throw createIpcError(channel, new Error('Cannot stat dataDir parent'))
    }
    if (!parentStats.isDirectory()) {
        throw createIpcError(channel, new Error('dataDir parent must be a directory'))
    }
    return resolved
}

/**
 * analyticsKeyFilePath: empty clears; otherwise existing regular .json file
 * confined under allowed user roots (assertPathWithinRoots).
 */
export function assertSettingsAnalyticsKeyFilePath(channel: string, rawPath: string): string {
    const trimmed = rawPath.trim()
    if (trimmed === '') return ''

    const resolved = assertPathWithinRoots(channel, trimmed, getDefaultAllowedRoots())
    if (!fs.existsSync(resolved)) {
        throw createIpcError(channel, new Error('analyticsKeyFilePath does not exist'))
    }
    let stats: fs.Stats
    try {
        stats = fs.statSync(resolved)
    } catch {
        throw createIpcError(channel, new Error('Cannot stat analyticsKeyFilePath'))
    }
    if (!stats.isFile()) {
        throw createIpcError(channel, new Error('analyticsKeyFilePath must be a regular file'))
    }
    if (path.extname(resolved).toLowerCase() !== '.json') {
        throw createIpcError(channel, new Error('analyticsKeyFilePath must be a .json file'))
    }
    return resolved
}

/**
 * Apply path guards to a whitelisted settings patch (set + saveAll share this).
 * Only mutates dataDir / analyticsKeyFilePath when present as strings.
 * Does not touch secret fields (mask/encryption semantics unchanged).
 */
export function applySettingsPathGuards(channel: string, patch: SettingsRecord): SettingsRecord {
    const out: SettingsRecord = { ...patch }

    if (Object.prototype.hasOwnProperty.call(out, 'dataDir')) {
        const value = out.dataDir
        if (typeof value !== 'string') {
            throw createIpcError(channel, new Error('dataDir must be a string'))
        }
        out.dataDir = assertSettingsDataDir(channel, value)
    }

    if (Object.prototype.hasOwnProperty.call(out, 'analyticsKeyFilePath')) {
        const value = out.analyticsKeyFilePath
        if (typeof value !== 'string') {
            throw createIpcError(channel, new Error('analyticsKeyFilePath must be a string'))
        }
        out.analyticsKeyFilePath = assertSettingsAnalyticsKeyFilePath(channel, value)
    }

    return out
}

export function registerSettingsHandlers() {
    // Get a specific setting (secrets masked)
    ipcMain.handle('settings:get', withIpcValidation('settings:get', async (_event, key: unknown) => {
        const parsedKey = parseIpcPayload('settings:get', settingsKeySchema, key)
        const settings = loadSettings()
        if (isSettingsSecretKey(parsedKey)) {
            return maskSettingsForRenderer(settings)[parsedKey]
        }
        return settings[parsedKey]
    }))

    // Set a specific setting (whitelist key + typed value)
    ipcMain.handle('settings:set', withIpcValidation('settings:set', async (_event, key: unknown, value: unknown) => {
        return withSettingsWrite(async () => {
            const [parsedKey, parsedValue] = parseIpcArgs('settings:set', settingsSetTupleSchema, [key, value])
            parseIpcPayload('settings:set', settingsPatchSchema, { [parsedKey]: parsedValue })

            // Semantic path guards (dataDir / analyticsKeyFilePath) — same as saveAll
            const pathGuarded = applySettingsPathGuards('settings:set', { [parsedKey]: parsedValue })
            const valueToApply = pathGuarded[parsedKey] !== undefined
                ? pathGuarded[parsedKey]!
                : parsedValue

            try {
                const settings = loadSettings()
                applySecretPatch(settings, parsedKey, valueToApply)
                const explicitSecretClears = isSettingsSecretKey(parsedKey) && valueToApply === ''
                    ? new Set<string>([parsedKey])
                    : undefined
                saveSettings(settings, { explicitSecretClears })
                if (parsedKey === 'useProxy' || parsedKey === 'fproxyApiKey') {
                    syncFProxyServiceWithSettings(loadSettings())
                }
            } catch (error) {
                if (error instanceof SecretStorageUnavailableError) {
                    throw createIpcError('settings:set', error)
                }
                throw error
            }
        })
    }))

    // Get all settings (secrets masked for renderer)
    ipcMain.handle('settings:getAll', withIpcValidation('settings:getAll', async () => {
        const settings = loadSettings()
        syncFProxyServiceWithSettings(settings)
        return maskSettingsForRenderer(settings)
    }))

    // Save all settings at once — unknown keys stripped before strict parse; extra disk keys preserved
    // Secret semantics: mask = keep, empty = clear, other = replace+encrypt
    // Path semantics: dataDir / analyticsKeyFilePath share guards with settings:set
    ipcMain.handle('settings:saveAll', withIpcValidation('settings:saveAll', async (_event, newSettings: unknown) => {
        return withSettingsWrite(async () => {
            // Strip unknown keys first so legacy UI/disk extras (googleOAuth*, geminiApiKey)
            // never fail strict schema validation. Known keys are still schema-checked.
            const incoming = (newSettings && typeof newSettings === 'object' && !Array.isArray(newSettings))
                ? (newSettings as Record<string, unknown>)
                : {}
            const stripped = pickWhitelistedPatch(incoming)
            const patch = parseIpcPayload('settings:saveAll', settingsPatchSchema, stripped)
            const safePatch = pickWhitelistedPatch(patch as Record<string, unknown>)
            const pathGuarded = applySettingsPathGuards('settings:saveAll', safePatch)
            const current = loadSettings()

            try {
                const explicitSecretClears = new Set<string>()
                for (const [key, value] of Object.entries(pathGuarded)) {
                    applySecretPatch(current, key as SettingsKey, value)
                    if (isSettingsSecretKey(key) && value === '') {
                        explicitSecretClears.add(key)
                    }
                }
                saveSettings(current, { explicitSecretClears })
                const hydrated = loadSettings()
                syncFProxyServiceWithSettings(hydrated)
                return maskSettingsForRenderer(hydrated)
            } catch (error) {
                if (error instanceof SecretStorageUnavailableError) {
                    throw createIpcError('settings:saveAll', error)
                }
                throw error
            }
        })
    }))

    // Reset to defaults (clears secrets intentionally)
    ipcMain.handle('settings:resetDefaults', withIpcValidation('settings:resetDefaults', async () => {
        return withSettingsWrite(async () => {
            const reset = { ...DEFAULT_SETTINGS }
            saveSettings(reset, {
                explicitSecretClears: new Set<string>(SETTINGS_SECRET_KEYS),
            })
            syncFProxyServiceWithSettings(reset)
            return maskSettingsForRenderer({ ...DEFAULT_SETTINGS })
        })
    }))

    // Dialog to select directory
    ipcMain.handle('dialog:selectDirectory', withIpcValidation('dialog:selectDirectory', async () => {
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
    }))
}

// Re-export for consumers that may want the key list / secret helpers
export {
    SETTINGS_KEYS,
    SETTINGS_SECRET_KEYS,
    SETTINGS_SECRET_MASK,
    type SettingsKey,
}
export type { SettingsValue, SettingsRecord }
