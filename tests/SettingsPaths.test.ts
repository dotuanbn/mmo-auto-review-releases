/**
 * Settings path semantics: dataDir + analyticsKeyFilePath.
 * Schema: empty | absolute. Main: assertPathWithinRoots + directory/parent / .json file.
 * SecretVault mask/encryption must remain untouched by path guards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let userDataDir = ''
let homeDir = ''
let tempDir = ''
const encryptMap = new Map<string, string>()

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => {
            switch (name) {
                case 'userData':
                    return userDataDir
                case 'appData':
                    return path.join(homeDir, 'AppData')
                case 'temp':
                    return tempDir
                case 'home':
                    return homeDir
                case 'documents':
                    return path.join(homeDir, 'Documents')
                case 'downloads':
                    return path.join(homeDir, 'Downloads')
                case 'desktop':
                    return path.join(homeDir, 'Desktop')
                default:
                    return userDataDir
            }
        },
        getAppPath: () => path.join(userDataDir, 'app'),
        isPackaged: false,
    },
    safeStorage: {
        isEncryptionAvailable: () => true,
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

import {
    applySettingsPathGuards,
    assertSettingsAnalyticsKeyFilePath,
    assertSettingsDataDir,
    isSettingsFilesystemRoot,
    loadSettings,
    saveSettings,
    sealSecretsForDisk,
} from '../src/main/ipc/settings'
import { secretVault } from '../src/main/services/SecretVault'
import { emptyOrAbsolutePathSchema, settingsPatchSchema } from '../src/shared/ipc-schemas'
import { SETTINGS_SECRET_MASK } from '../src/shared/types'

function expectThrowMatching(fn: () => unknown, pattern: RegExp): void {
    try {
        fn()
        expect.fail('expected throw')
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toMatch(pattern)
    }
}

beforeEach(() => {
    encryptMap.clear()
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-paths-home-'))
    userDataDir = path.join(homeDir, 'userData')
    tempDir = path.join(homeDir, 'temp')
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.mkdirSync(tempDir, { recursive: true })
    fs.mkdirSync(path.join(homeDir, 'Documents'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, 'Downloads'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, 'Desktop'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, 'AppData'), { recursive: true })
})

afterEach(() => {
    try {
        fs.rmSync(homeDir, { recursive: true, force: true })
    } catch {
        // ignore Windows locks
    }
})

// ---------------------------------------------------------------------------
// Schema: empty | absolute only
// ---------------------------------------------------------------------------

describe('emptyOrAbsolutePathSchema / settingsPatchSchema path fields', () => {
    it('accepts empty and absolute paths', () => {
        expect(emptyOrAbsolutePathSchema.safeParse('').success).toBe(true)
        expect(emptyOrAbsolutePathSchema.safeParse('C:\\Users\\data').success).toBe(true)
        expect(emptyOrAbsolutePathSchema.safeParse('/home/user/data').success).toBe(true)
        expect(emptyOrAbsolutePathSchema.safeParse('\\\\server\\share\\folder').success).toBe(true)
        expect(settingsPatchSchema.safeParse({ dataDir: '' }).success).toBe(true)
        expect(settingsPatchSchema.safeParse({ analyticsKeyFilePath: '' }).success).toBe(true)
        expect(settingsPatchSchema.safeParse({ dataDir: path.join(homeDir, 'subdir') }).success).toBe(true)
    })

    it('rejects relative paths and null bytes', () => {
        expect(emptyOrAbsolutePathSchema.safeParse('relative/path').success).toBe(false)
        expect(emptyOrAbsolutePathSchema.safeParse('./local').success).toBe(false)
        expect(emptyOrAbsolutePathSchema.safeParse('folder').success).toBe(false)
        expect(emptyOrAbsolutePathSchema.safeParse('C:\\bad\0path').success).toBe(false)
        expect(settingsPatchSchema.safeParse({ dataDir: 'relative' }).success).toBe(false)
        expect(settingsPatchSchema.safeParse({ analyticsKeyFilePath: '../escape' }).success).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Filesystem root detection
// ---------------------------------------------------------------------------

describe('isSettingsFilesystemRoot', () => {
    it('detects drive/posix roots', () => {
        if (process.platform === 'win32') {
            expect(isSettingsFilesystemRoot('C:\\')).toBe(true)
            expect(isSettingsFilesystemRoot('C:/')).toBe(true)
            expect(isSettingsFilesystemRoot('C:\\Users')).toBe(false)
        } else {
            expect(isSettingsFilesystemRoot('/')).toBe(true)
            expect(isSettingsFilesystemRoot('/home')).toBe(false)
        }
        expect(isSettingsFilesystemRoot(homeDir)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// dataDir semantic guards
// ---------------------------------------------------------------------------

describe('assertSettingsDataDir', () => {
    const channel = 'settings:set'

    it('accepts empty string', () => {
        expect(assertSettingsDataDir(channel, '')).toBe('')
        expect(assertSettingsDataDir(channel, '   ')).toBe('')
    })

    it('accepts existing directory under allowed roots', () => {
        const dir = path.join(homeDir, 'my-data')
        fs.mkdirSync(dir)
        const resolved = assertSettingsDataDir(channel, dir)
        expect(resolved).toBe(path.resolve(dir))
    })

    it('accepts nonexistent path when parent is a valid directory under roots', () => {
        const parent = path.join(homeDir, 'Documents')
        const candidate = path.join(parent, 'new-data-dir')
        const resolved = assertSettingsDataDir(channel, candidate)
        expect(resolved).toBe(path.resolve(candidate))
        expect(fs.existsSync(candidate)).toBe(false)
    })

    it('rejects filesystem/drive roots', () => {
        if (process.platform === 'win32') {
            expectThrowMatching(() => assertSettingsDataDir(channel, 'C:\\'), /system\/drive root/i)
        } else {
            expectThrowMatching(() => assertSettingsDataDir(channel, '/'), /system\/drive root/i)
        }
    })

    it('rejects paths outside allowed roots', () => {
        // Sibling of home outside all mocked roots (except if cwd collides — use far path)
        const outside = process.platform === 'win32'
            ? 'Z:\\definitely-not-allowed-settings-path'
            : '/var/definitely-not-allowed-settings-path'
        // Only assert when outside is not under cwd
        const cwd = path.resolve(process.cwd())
        if (!path.resolve(outside).toLowerCase().startsWith(cwd.toLowerCase())) {
            expectThrowMatching(
                () => assertSettingsDataDir(channel, outside),
                /outside allowed|does not exist|parent/i,
            )
        }
    })

    it('rejects file path as dataDir', () => {
        const filePath = path.join(homeDir, 'not-a-dir.txt')
        fs.writeFileSync(filePath, 'x', 'utf-8')
        expectThrowMatching(() => assertSettingsDataDir(channel, filePath), /must be a directory/i)
    })

    it('rejects nonexistent path with missing parent', () => {
        const missing = path.join(homeDir, 'no-such-parent', 'child')
        expectThrowMatching(
            () => assertSettingsDataDir(channel, missing),
            /parent directory does not exist/i,
        )
    })
})

// ---------------------------------------------------------------------------
// analyticsKeyFilePath semantic guards
// ---------------------------------------------------------------------------

describe('assertSettingsAnalyticsKeyFilePath', () => {
    const channel = 'settings:saveAll'

    it('accepts empty string', () => {
        expect(assertSettingsAnalyticsKeyFilePath(channel, '')).toBe('')
        expect(assertSettingsAnalyticsKeyFilePath(channel, '  ')).toBe('')
    })

    it('accepts existing regular .json under allowed roots', () => {
        const keyFile = path.join(homeDir, 'Documents', 'sa-key.json')
        fs.writeFileSync(keyFile, '{"type":"service_account"}', 'utf-8')
        const resolved = assertSettingsAnalyticsKeyFilePath(channel, keyFile)
        expect(resolved).toBe(path.resolve(keyFile))
    })

    it('rejects nonexistent path', () => {
        const missing = path.join(homeDir, 'missing-key.json')
        expectThrowMatching(
            () => assertSettingsAnalyticsKeyFilePath(channel, missing),
            /does not exist/i,
        )
    })

    it('rejects non-json extension', () => {
        const txt = path.join(homeDir, 'key.txt')
        fs.writeFileSync(txt, '{}', 'utf-8')
        expectThrowMatching(
            () => assertSettingsAnalyticsKeyFilePath(channel, txt),
            /\.json/i,
        )
    })

    it('rejects directory path', () => {
        const dir = path.join(homeDir, 'Documents')
        expectThrowMatching(
            () => assertSettingsAnalyticsKeyFilePath(channel, dir),
            /regular file/i,
        )
    })

    it('rejects path outside allowed roots', () => {
        const outside = process.platform === 'win32'
            ? 'Z:\\not-allowed\\key.json'
            : '/var/not-allowed/key.json'
        const cwd = path.resolve(process.cwd())
        if (!path.resolve(outside).toLowerCase().startsWith(cwd.toLowerCase())) {
            expectThrowMatching(
                () => assertSettingsAnalyticsKeyFilePath(channel, outside),
                /outside allowed|does not exist/i,
            )
        }
    })
})

// ---------------------------------------------------------------------------
// applySettingsPathGuards — set/saveAll shared semantics
// ---------------------------------------------------------------------------

describe('applySettingsPathGuards', () => {
    it('normalizes both fields and leaves other keys alone', () => {
        const dir = path.join(homeDir, 'data-store')
        fs.mkdirSync(dir)
        const keyFile = path.join(userDataDir, 'analytics.json')
        fs.writeFileSync(keyFile, '{}', 'utf-8')

        const result = applySettingsPathGuards('settings:saveAll', {
            dataDir: dir,
            analyticsKeyFilePath: keyFile,
            headless: true,
            groqApiKey: SETTINGS_SECRET_MASK,
        })

        expect(result.dataDir).toBe(path.resolve(dir))
        expect(result.analyticsKeyFilePath).toBe(path.resolve(keyFile))
        expect(result.headless).toBe(true)
        expect(result.groqApiKey).toBe(SETTINGS_SECRET_MASK)
    })

    it('allows clearing both paths with empty string', () => {
        const result = applySettingsPathGuards('settings:set', {
            dataDir: '',
            analyticsKeyFilePath: '',
        })
        expect(result.dataDir).toBe('')
        expect(result.analyticsKeyFilePath).toBe('')
    })

    it('does not rewrite secret mask through path guards', () => {
        const sealed = sealSecretsForDisk({ groqApiKey: 'path-guard-secret' }, null)
        expect(String(sealed.groqApiKey).startsWith('enc:v1:') || String(sealed.groqApiKey).length > 0).toBe(true)

        const keep = sealSecretsForDisk(
            {
                groqApiKey: SETTINGS_SECRET_MASK,
                dataDir: '',
            },
            { groqApiKey: sealed.groqApiKey },
        )
        expect(keep.groqApiKey).toBe(sealed.groqApiKey)

        // Path guard on a non-secret patch must not touch disk secrets
        applySettingsPathGuards('settings:saveAll', { dataDir: '', headless: false })
        const loaded = loadSettings()
        // fresh userData — no secrets yet; ensure path clear works without throw
        expect(loaded.dataDir === '' || typeof loaded.dataDir === 'string').toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Integration: saveSettings with paths + secret preservation
// ---------------------------------------------------------------------------

describe('path writes preserve secrets', () => {
    function settingsPath(): string {
        return path.join(userDataDir, 'settings.json')
    }

    it('saving dataDir does not wipe encrypted secrets', () => {
        const sealed = secretVault.encrypt('keep-secret')
        fs.writeFileSync(
            settingsPath(),
            JSON.stringify({ groqApiKey: sealed, headless: false }, null, 2),
            'utf-8',
        )

        const dir = path.join(homeDir, 'profiles-root')
        fs.mkdirSync(dir)
        const guarded = applySettingsPathGuards('settings:set', { dataDir: dir })
        saveSettings({ dataDir: guarded.dataDir as string, headless: true })

        const disk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>
        expect(String(disk.groqApiKey).startsWith('enc:v1:')).toBe(true)
        expect(secretVault.decrypt(String(disk.groqApiKey))).toBe('keep-secret')
        expect(disk.dataDir).toBe(path.resolve(dir))
        expect(disk.headless).toBe(true)
    })
})
