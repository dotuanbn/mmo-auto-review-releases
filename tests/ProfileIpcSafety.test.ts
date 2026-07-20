/**
 * P0 Profile filesystem safety:
 * - path traversal / root delete blocked
 * - basename must match account
 * - poisoned DB paths never cause rm outside roots / on roots
 * - symlink escape rejected
 *
 * Pure helpers from profiles.ts; electron/services mocked at load time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const USER_DATA = path.join(os.tmpdir(), `mmo-profile-safety-ud-${process.pid}`)

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => {
            if (name === 'userData') return USER_DATA
            return USER_DATA
        },
    },
    ipcMain: { handle: vi.fn() },
}))

vi.mock('../src/main/services/AccountService', () => ({
    accountService: {
        getById: vi.fn(),
        getAll: vi.fn(),
        update: vi.fn(),
    },
}))

vi.mock('../src/main/services/ProfileService', () => ({
    profileService: {
        getProfilesPath: () => path.join(USER_DATA, 'profiles'),
        createProfile: vi.fn(),
        getProfileInfo: vi.fn(() => ({
            exists: false,
            hasCookies: false,
            hasStorage: false,
            sizeBytes: 0,
        })),
    },
}))

import {
    checkProfileDeletePath,
    checkProfilePathForAccount,
    expectedProfileBasenames,
    expectedProfileFolderName,
    isExactlyAnyRoot,
    isExpectedProfileBasename,
    isStrictChildOfRoot,
    isWithinAnyRootStrict,
    normalizeFsPath,
    pathsEqual,
    sanitizeProfileEmail,
} from '../src/main/ipc/profiles'
import {
    profileCreateSchema,
    profileDeleteSchema,
    profileGetSchema,
    profileMigratePayloadSchema,
    profileUpdatePayloadSchema,
} from '../src/shared/account-contracts'

function expectOk(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(true)
}

function expectFail(schema: { safeParse: (v: unknown) => { success: boolean } }, input: unknown) {
    const result = schema.safeParse(input)
    expect(result.success, JSON.stringify(input)).toBe(false)
}

const ACCOUNT_ID = 42
const EMAIL = 'user@gmail.com'

function profilesRoot(): string {
    return path.join(USER_DATA, 'profiles')
}

function trafficRoot(): string {
    return path.join(USER_DATA, 'traffic_profiles')
}

function allowedRoots(): string[] {
    return [
        normalizeFsPath(profilesRoot()),
        normalizeFsPath(trafficRoot()),
        normalizeFsPath(USER_DATA),
    ]
}

beforeEach(() => {
    fs.mkdirSync(profilesRoot(), { recursive: true })
    fs.mkdirSync(trafficRoot(), { recursive: true })
})

afterEach(() => {
    try {
        fs.rmSync(USER_DATA, { recursive: true, force: true })
    } catch {
        // ignore
    }
})

// ---------------------------------------------------------------------------
// Basename / expected folder
// ---------------------------------------------------------------------------

describe('expected profile basenames', () => {
    it('builds canonical profile_<id>_<sanitized> name', () => {
        expect(sanitizeProfileEmail(EMAIL)).toBe('user_gmail_com')
        expect(expectedProfileFolderName(ACCOUNT_ID, EMAIL)).toBe(
            `profile_${ACCOUNT_ID}_user_gmail_com`,
        )
        expect(expectedProfileBasenames(ACCOUNT_ID, EMAIL)).toContain(
            `profile_${ACCOUNT_ID}_user_gmail_com`,
        )
    })

    it('accepts expected and legacy account_ prefixes for same id', () => {
        expect(isExpectedProfileBasename(`profile_${ACCOUNT_ID}_user_gmail_com`, ACCOUNT_ID, EMAIL)).toBe(
            true,
        )
        expect(isExpectedProfileBasename(`account_${ACCOUNT_ID}_user_gmail_com`, ACCOUNT_ID, EMAIL)).toBe(
            true,
        )
        expect(isExpectedProfileBasename(`profile_${ACCOUNT_ID}_custom_tag`, ACCOUNT_ID, EMAIL)).toBe(
            true,
        )
    })

    it('rejects traversal, wrong account id, and unrelated names', () => {
        expect(isExpectedProfileBasename('..', ACCOUNT_ID, EMAIL)).toBe(false)
        expect(isExpectedProfileBasename('../evil', ACCOUNT_ID, EMAIL)).toBe(false)
        expect(isExpectedProfileBasename('profiles', ACCOUNT_ID, EMAIL)).toBe(false)
        expect(isExpectedProfileBasename(`profile_99_user_gmail_com`, ACCOUNT_ID, EMAIL)).toBe(false)
        expect(isExpectedProfileBasename('System32', ACCOUNT_ID, EMAIL)).toBe(false)
        expect(isExpectedProfileBasename(`profile_${ACCOUNT_ID}_x/y`, ACCOUNT_ID, EMAIL)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Root containment
// ---------------------------------------------------------------------------

describe('strict root containment', () => {
    it('treats equal path as root (not a child)', () => {
        const root = profilesRoot()
        expect(isStrictChildOfRoot(root, root)).toBe(false)
        expect(isExactlyAnyRoot(root, allowedRoots())).toBe(true)
        expect(pathsEqual(root, path.join(root, '.'))).toBe(true)
    })

    it('accepts profile folder under root', () => {
        const child = path.join(profilesRoot(), expectedProfileFolderName(ACCOUNT_ID, EMAIL))
        expect(isStrictChildOfRoot(child, profilesRoot())).toBe(true)
        expect(isWithinAnyRootStrict(child, allowedRoots())).toBe(true)
    })

    it('rejects path traversal out of root', () => {
        const escaped = path.join(profilesRoot(), '..', '..', 'Windows', 'System32')
        expect(isWithinAnyRootStrict(path.resolve(escaped), allowedRoots())).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// checkProfilePathForAccount — write / copy targets
// ---------------------------------------------------------------------------

describe('checkProfilePathForAccount', () => {
    it('accepts expected folder under profiles root', () => {
        const target = path.join(profilesRoot(), expectedProfileFolderName(ACCOUNT_ID, EMAIL))
        const result = checkProfilePathForAccount(target, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(pathsEqual(result.resolved, target)).toBe(true)
        }
    })

    it('rejects the profiles root itself (arbitrary wipe protection)', () => {
        const result = checkProfilePathForAccount(
            profilesRoot(),
            allowedRoots(),
            ACCOUNT_ID,
            EMAIL,
        )
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason.toLowerCase()).toMatch(/root/)
        }
    })

    it('rejects userData root itself', () => {
        const result = checkProfilePathForAccount(USER_DATA, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })

    it('rejects path traversal payloads', () => {
        const traversal = path.join(
            profilesRoot(),
            '..',
            '..',
            'Windows',
            'System32',
            expectedProfileFolderName(ACCOUNT_ID, EMAIL),
        )
        const result = checkProfilePathForAccount(traversal, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })

    it('rejects wrong basename even under allowed root', () => {
        const evil = path.join(profilesRoot(), 'not_a_profile_folder')
        const result = checkProfilePathForAccount(evil, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason.toLowerCase()).toMatch(/folder name|match/)
        }
    })

    it('rejects absolute path outside allowed roots', () => {
        const outside = path.join(os.tmpdir(), 'other-app', expectedProfileFolderName(ACCOUNT_ID, EMAIL))
        const result = checkProfilePathForAccount(outside, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Delete guards — root / poisoned DB / symlink
// ---------------------------------------------------------------------------

describe('checkProfileDeletePath', () => {
    it('never allows deleting the profiles root', () => {
        const result = checkProfileDeletePath(profilesRoot(), allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })

    it('blocks poisoned DB path outside roots (no rm of arbitrary dirs)', () => {
        const poison = process.platform === 'win32'
            ? 'C:\\Windows\\System32'
            : '/etc'
        const result = checkProfileDeletePath(poison, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })

    it('blocks poisoned DB path that is userData root', () => {
        const result = checkProfileDeletePath(USER_DATA, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })

    it('allows delete of real account profile folder under profiles root', () => {
        const folder = path.join(profilesRoot(), expectedProfileFolderName(ACCOUNT_ID, EMAIL))
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(path.join(folder, 'marker.txt'), 'x', 'utf-8')

        const result = checkProfileDeletePath(folder, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(true)
        if (result.ok) {
            // Still must not equal root
            expect(isExactlyAnyRoot(result.resolved, allowedRoots())).toBe(false)
            expect(isWithinAnyRootStrict(result.resolved, allowedRoots())).toBe(true)
        }
    })

    it('rejects symlink that escapes allowed roots', () => {
        if (process.platform === 'win32') {
            // Symlink creation often requires admin on Windows CI — soft-skip
            try {
                const outside = path.join(os.tmpdir(), `mmo-profile-escape-${process.pid}`)
                fs.mkdirSync(outside, { recursive: true })
                const linkPath = path.join(
                    profilesRoot(),
                    expectedProfileFolderName(ACCOUNT_ID, EMAIL),
                )
                fs.symlinkSync(outside, linkPath, 'junction')
                const result = checkProfileDeletePath(linkPath, allowedRoots(), ACCOUNT_ID, EMAIL)
                // Junction to outside tmp should fail containment on realpath
                expect(result.ok).toBe(false)
                fs.rmSync(linkPath, { recursive: true, force: true })
                fs.rmSync(outside, { recursive: true, force: true })
            } catch {
                // Environment cannot create symlinks — still assert pure escape logic via resolve
                const escaped = path.join(os.tmpdir(), expectedProfileFolderName(ACCOUNT_ID, EMAIL))
                const result = checkProfileDeletePath(escaped, allowedRoots(), ACCOUNT_ID, EMAIL)
                expect(result.ok).toBe(false)
            }
            return
        }

        const outside = path.join(os.tmpdir(), `mmo-profile-escape-${process.pid}`)
        fs.mkdirSync(outside, { recursive: true })
        const linkPath = path.join(profilesRoot(), expectedProfileFolderName(ACCOUNT_ID, EMAIL))
        fs.symlinkSync(outside, linkPath)
        try {
            const result = checkProfileDeletePath(linkPath, allowedRoots(), ACCOUNT_ID, EMAIL)
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(result.reason.toLowerCase()).toMatch(/symlink|escape|outside|root/)
            }
        } finally {
            try {
                fs.unlinkSync(linkPath)
            } catch {
                fs.rmSync(linkPath, { recursive: true, force: true })
            }
            fs.rmSync(outside, { recursive: true, force: true })
        }
    })

    it('rejects traversal-style poisoned DB path with expected basename suffix', () => {
        const poison = path.join(
            profilesRoot(),
            '..',
            '..',
            'Windows',
            expectedProfileFolderName(ACCOUNT_ID, EMAIL),
        )
        const result = checkProfileDeletePath(poison, allowedRoots(), ACCOUNT_ID, EMAIL)
        expect(result.ok).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Zod IPC payload contracts for profiles:*
// ---------------------------------------------------------------------------

describe('profile IPC schemas', () => {
    it('get/create/delete require positive account id', () => {
        expectOk(profileGetSchema, 1)
        expectOk(profileCreateSchema, 99)
        expectOk(profileDeleteSchema, 3)
        for (const bad of [0, -1, 1.5, '1', null, undefined]) {
            expectFail(profileGetSchema, bad)
            expectFail(profileCreateSchema, bad)
            expectFail(profileDeleteSchema, bad)
        }
    })

    it('update requires accountId + profilePath or basePath (absolute)', () => {
        expectOk(profileUpdatePayloadSchema, {
            accountId: 1,
            profilePath: 'C:\\Users\\x\\AppData\\profiles\\profile_1_a',
        })
        expectOk(profileUpdatePayloadSchema, {
            accountId: 1,
            basePath: 'C:\\Users\\x\\AppData\\profiles',
        })
        expectFail(profileUpdatePayloadSchema, { accountId: 1 })
        expectFail(profileUpdatePayloadSchema, {
            accountId: 1,
            basePath: 'relative/profiles',
        })
        expectFail(profileUpdatePayloadSchema, {
            accountId: 1,
            profilePath: 'C:\\x',
            inject: true,
        })
    })

    it('migrate requires accountId + absolute targetBasePath', () => {
        expectOk(profileMigratePayloadSchema, {
            accountId: 2,
            targetBasePath: '/var/lib/app/profiles',
        })
        expectFail(profileMigratePayloadSchema, {
            accountId: 2,
            targetBasePath: 'relative',
        })
        expectFail(profileMigratePayloadSchema, { accountId: 2 })
        expectFail(profileMigratePayloadSchema, {
            accountId: 0,
            targetBasePath: 'C:\\profiles',
        })
    })
})
