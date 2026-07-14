/**
 * Settings secrets: disk encryption (enc:v1), IPC mask semantics, coerce on load.
 * Mocks Electron safeStorage + app userData so tests run headless under vitest/node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const encryptMap = new Map<string, string>()
let encryptionAvailable = true
let userDataDir = ''

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => {
            if (name === 'userData') return userDataDir
            return userDataDir
        },
    },
    safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (plain: string) => {
            const token = `tok_${Buffer.from(plain, 'utf8').toString('hex')}`
            encryptMap.set(token, plain)
            return Buffer.from(token, 'utf8')
        },
        decryptString: (buf: Buffer) => {
            const token = buf.toString('utf8')
            const plain = encryptMap.get(token)
            if (plain === undefined) throw new Error('decrypt failed')
            return plain
        },
    },
    ipcMain: { handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    BrowserWindow: { getFocusedWindow: vi.fn() },
}))

vi.mock('../src/main/services/FProxyService', () => ({
    fproxyService: {
        setApiKey: vi.fn(),
        clearConfiguration: vi.fn(),
    },
}))

vi.mock('../src/main/utils/runtimeLogger', () => ({
    setRuntimeLogLevel: vi.fn(),
}))

import { secretVault, SecretStorageUnavailableError } from '../src/main/services/SecretVault'
import {
    coerceSettingValue,
    hydrateSecrets,
    loadSettings,
    maskSecretsFromDisk,
    maskSecretsForRenderer,
    normalizeSettingsFromDisk,
    saveSettings,
    sealSecretsForDisk,
} from '../src/main/ipc/settings'
import {
    SETTINGS_SECRET_KEYS,
    SETTINGS_SECRET_MASK,
} from '../src/shared/types'

function settingsPath(): string {
    return path.join(userDataDir, 'settings.json')
}

function writeDisk(data: Record<string, unknown>): void {
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function readDisk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
    encryptionAvailable = true
    encryptMap.clear()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-secrets-'))
})

afterEach(() => {
    try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
        // ignore cleanup errors on Windows locks
    }
})

// ---------------------------------------------------------------------------
// SecretVault
// ---------------------------------------------------------------------------

describe('SecretVault', () => {
    it('encrypts with enc:v1 prefix and decrypts round-trip', () => {
        const sealed = secretVault.encrypt('super-secret-key')
        expect(sealed.startsWith('enc:v1:')).toBe(true)
        expect(sealed).not.toContain('super-secret-key')
        expect(secretVault.decrypt(sealed)).toBe('super-secret-key')
    })

    it('does not double-encrypt already sealed values', () => {
        const sealed = secretVault.encrypt('once')
        expect(secretVault.encrypt(sealed)).toBe(sealed)
    })

    it('fail-closed on new encrypt when safeStorage unavailable', () => {
        encryptionAvailable = false
        expect(() => secretVault.encrypt('new-key')).toThrow(SecretStorageUnavailableError)
    })

    it('returns legacy plaintext as-is from decrypt', () => {
        expect(secretVault.decrypt('legacy-plain')).toBe('legacy-plain')
    })

    it('lazy-migrates plaintext when encryption available', () => {
        const mig = secretVault.migrateIfNeeded('legacy-key')
        expect(mig.migrated).toBe(true)
        expect(mig.value.startsWith('enc:v1:')).toBe(true)
        expect(secretVault.decrypt(mig.value)).toBe('legacy-key')
    })

    it('skips migration when encryption unavailable', () => {
        encryptionAvailable = false
        const mig = secretVault.migrateIfNeeded('legacy-key')
        expect(mig.migrated).toBe(false)
        expect(mig.value).toBe('legacy-key')
    })
})

// ---------------------------------------------------------------------------
// Coerce / defaults
// ---------------------------------------------------------------------------

describe('coerceSettingValue / normalizeSettingsFromDisk', () => {
    it('invalid enableAgenticReview falls back to false', () => {
        expect(coerceSettingValue('enableAgenticReview', 'yes', false)).toBe(false)
        expect(coerceSettingValue('enableAgenticReview', 1, false)).toBe(false)
        expect(coerceSettingValue('enableAgenticReview', null, false)).toBe(false)
        expect(coerceSettingValue('enableAgenticReview', true, false)).toBe(true)
    })

    it('coerces numbers and preserves valid types', () => {
        expect(coerceSettingValue('hfMaxMemoryMB', '2048', 2048)).toBe(2048)
        expect(coerceSettingValue('hfMaxMemoryMB', 'nope', 2048)).toBe(2048)
        expect(coerceSettingValue('headless', true, false)).toBe(true)
    })

    it('defaults hfMaxMemoryMB to 2048 when missing', () => {
        const n = normalizeSettingsFromDisk({})
        expect(n.hfMaxMemoryMB).toBe(2048)
        expect(n.enableAgenticReview).toBe(false)
    })

    it('preserves extra non-whitelist keys', () => {
        const n = normalizeSettingsFromDisk({ googleOAuthToken: 'abc', headless: true })
        expect(n.googleOAuthToken).toBe('abc')
        expect(n.headless).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Disk seal / hydrate / mask
// ---------------------------------------------------------------------------

describe('sealSecretsForDisk / hydrate / mask', () => {
    it('seal encrypts plaintext secrets', () => {
        const sealed = sealSecretsForDisk(
            { groqApiKey: 'gsk_live', fproxyApiKey: '', captchaSolverApiKey: '' },
            null
        )
        expect(String(sealed.groqApiKey).startsWith('enc:v1:')).toBe(true)
        expect(sealed.fproxyApiKey).toBe('')
    })

    it('mask keeps previous disk secret; empty clears; other replaces', () => {
        const prev = { groqApiKey: secretVault.encrypt('old-key') }
        const keep = sealSecretsForDisk({ groqApiKey: SETTINGS_SECRET_MASK }, prev)
        expect(keep.groqApiKey).toBe(prev.groqApiKey)

        const clear = sealSecretsForDisk({ groqApiKey: '' }, prev)
        expect(clear.groqApiKey).toBe('')

        const replace = sealSecretsForDisk({ groqApiKey: 'new-key' }, prev)
        expect(String(replace.groqApiKey).startsWith('enc:v1:')).toBe(true)
        expect(secretVault.decrypt(String(replace.groqApiKey))).toBe('new-key')
    })

    it('hydrate returns plaintext for services', () => {
        const sealed = secretVault.encrypt('svc-key')
        const { settings } = hydrateSecrets(
            { groqApiKey: sealed, fproxyApiKey: '', captchaSolverApiKey: '' },
            { groqApiKey: sealed }
        )
        expect(settings.groqApiKey).toBe('svc-key')
    })

    it('maskSecretsForRenderer never returns raw secrets', () => {
        const masked = maskSecretsForRenderer({
            groqApiKey: 'gsk_raw_secret',
            fproxyApiKey: '',
            captchaSolverApiKey: 'cap',
            headless: true,
        })
        expect(masked.groqApiKey).toBe(SETTINGS_SECRET_MASK)
        expect(masked.fproxyApiKey).toBe('')
        expect(masked.captchaSolverApiKey).toBe(SETTINGS_SECRET_MASK)
        expect(masked.headless).toBe(true)
        for (const key of SETTINGS_SECRET_KEYS) {
            const v = masked[key]
            if (typeof v === 'string' && v.length > 0) {
                expect(v).toBe(SETTINGS_SECRET_MASK)
                expect(v.startsWith('enc:v1:')).toBe(false)
            }
        }
    })

    it('masks an encrypted disk secret even when it cannot be decrypted', () => {
        const sealed = secretVault.encrypt('temporarily-unavailable')
        encryptionAvailable = false

        const masked = maskSecretsFromDisk(
            { groqApiKey: '', fproxyApiKey: '', captchaSolverApiKey: '' },
            { groqApiKey: sealed },
        )

        expect(masked.groqApiKey).toBe(SETTINGS_SECRET_MASK)
    })
})

// ---------------------------------------------------------------------------
// loadSettings / saveSettings integration
// ---------------------------------------------------------------------------

describe('loadSettings / saveSettings', () => {
    it('lazy-migrates plaintext secrets on load and returns plaintext internally', () => {
        writeDisk({
            groqApiKey: 'plain-groq',
            fproxyApiKey: 'plain-fproxy',
            enableAgenticReview: 'invalid',
        })

        const loaded = loadSettings()
        expect(loaded.groqApiKey).toBe('plain-groq')
        expect(loaded.fproxyApiKey).toBe('plain-fproxy')
        expect(loaded.enableAgenticReview).toBe(false)

        const disk = readDisk()
        expect(String(disk.groqApiKey).startsWith('enc:v1:')).toBe(true)
        expect(String(disk.fproxyApiKey).startsWith('enc:v1:')).toBe(true)
        expect(JSON.stringify(disk)).not.toContain('plain-groq')
        expect(JSON.stringify(disk)).not.toContain('plain-fproxy')
    })

    it('does not lose encrypted secret when saving non-secret fields only', () => {
        writeDisk({ groqApiKey: secretVault.encrypt('keep-me'), headless: false })
        // Partial write (runtimePolicy-style patch without re-listing secrets)
        saveSettings({ headless: true, ollamaModel: 'qwen2.5:latest' })

        const disk = readDisk()
        expect(String(disk.groqApiKey).startsWith('enc:v1:')).toBe(true)
        expect(secretVault.decrypt(String(disk.groqApiKey))).toBe('keep-me')
        expect(disk.headless).toBe(true)
        expect(disk.ollamaModel).toBe('qwen2.5:latest')
    })

    it('Ollama-style full load→mutate→save re-seals secrets and keeps values', () => {
        writeDisk({ groqApiKey: secretVault.encrypt('round-trip'), ollamaModel: 'old' })
        const settings = loadSettings()
        expect(settings.groqApiKey).toBe('round-trip')
        settings.ollamaModel = 'new-model'
        saveSettings(settings)

        const disk = readDisk()
        expect(disk.ollamaModel).toBe('new-model')
        expect(secretVault.decrypt(String(disk.groqApiKey))).toBe('round-trip')
        expect(JSON.stringify(disk)).not.toContain('round-trip')
    })

    it('saveAll-equivalent: mask keeps, empty clears, other replaces', () => {
        writeDisk({
            groqApiKey: secretVault.encrypt('alpha'),
            fproxyApiKey: secretVault.encrypt('beta'),
            captchaSolverApiKey: secretVault.encrypt('gamma'),
        })

        // mask keep + clear fproxy + replace captcha
        saveSettings({
            groqApiKey: SETTINGS_SECRET_MASK,
            fproxyApiKey: '',
            captchaSolverApiKey: 'gamma-new',
            headless: true,
        })

        const disk = readDisk()
        expect(secretVault.decrypt(String(disk.groqApiKey))).toBe('alpha')
        expect(disk.fproxyApiKey).toBe('')
        expect(secretVault.decrypt(String(disk.captchaSolverApiKey))).toBe('gamma-new')

        const publicView = maskSecretsForRenderer(loadSettings())
        expect(publicView.groqApiKey).toBe(SETTINGS_SECRET_MASK)
        expect(publicView.fproxyApiKey).toBe('')
        expect(publicView.captchaSolverApiKey).toBe(SETTINGS_SECRET_MASK)
    })

    it('new secret write fails closed when encryption unavailable', () => {
        encryptionAvailable = false
        expect(() =>
            saveSettings({ groqApiKey: 'cannot-store-plaintext' })
        ).toThrow(SecretStorageUnavailableError)
    })

    it('preserves encrypted secrets when secure storage is temporarily unavailable', () => {
        const sealed = secretVault.encrypt('keep-while-unavailable')
        writeDisk({ groqApiKey: sealed, headless: false })
        encryptionAvailable = false

        const loaded = loadSettings()
        expect(loaded.groqApiKey).toBe('')
        loaded.headless = true
        saveSettings(loaded)

        const disk = readDisk()
        expect(disk.groqApiKey).toBe(sealed)
        expect(disk.headless).toBe(true)
    })

    it('allows an explicit clear while secure storage is unavailable', () => {
        const sealed = secretVault.encrypt('clear-me')
        writeDisk({ groqApiKey: sealed })
        encryptionAvailable = false

        saveSettings(
            { groqApiKey: '' },
            { explicitSecretClears: new Set(['groqApiKey']) },
        )

        expect(readDisk().groqApiKey).toBe('')
    })
})
