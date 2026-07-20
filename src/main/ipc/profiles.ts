import { app, ipcMain } from 'electron'
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import { accountService } from '../services/AccountService'
import { profileService } from '../services/ProfileService'
import {
    profileCreateSchema,
    profileDeleteSchema,
    profileGetSchema,
    profileMigratePayloadSchema,
    profileUpdatePayloadSchema,
} from '../../shared/account-contracts'
import { parseIpcPayload, withIpcValidation } from './validate'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileSummary {
    accountId: number
    email: string
    profilePath: string | null
    exists: boolean
    hasCookies: boolean
    hasStorage: boolean
    sizeBytes: number
    createdAt?: Date
}

export type ProfilePathCheckResult =
    | { ok: true; resolved: string }
    | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Pure path / basename helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Sanitize email the same way ProfileService does for folder names. */
export function sanitizeProfileEmail(email: string): string {
    return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

/** Canonical + legacy basenames accepted for a given account. */
export function expectedProfileBasenames(accountId: number, email: string): string[] {
    const primary = sanitizeProfileEmail(email)
    const dotted = email.replace(/[@.]/g, '_')
    const dottedLower = dotted.toLowerCase()
    return Array.from(
        new Set([
            `profile_${accountId}_${primary}`,
            `profile_${accountId}_${dotted}`,
            `profile_${accountId}_${dottedLower}`,
            `account_${accountId}_${primary}`,
            `account_${accountId}_${dotted}`,
            `account_${accountId}_${dottedLower}`,
        ]),
    )
}

/** Expected primary folder name used when creating / migrating. */
export function expectedProfileFolderName(accountId: number, email: string): string {
    return `profile_${accountId}_${sanitizeProfileEmail(email)}`
}

/**
 * Folder basename must be a known profile folder for this account.
 * Rejects path separators, traversal segments, and unrelated names.
 */
export function isExpectedProfileBasename(
    folderName: string,
    accountId: number,
    email: string,
): boolean {
    if (!folderName || folderName === '.' || folderName === '..') return false
    if (folderName.includes('\0') || folderName.includes('/') || folderName.includes('\\')) {
        return false
    }
    if (expectedProfileBasenames(accountId, email).includes(folderName)) {
        return true
    }
    // Legacy rename / heal: still require account id prefix and safe charset
    const legacy = new RegExp(`^(?:profile|account)_${accountId}_[A-Za-z0-9_]+$`)
    return legacy.test(folderName)
}

export function normalizeFsPath(p: string): string {
    return resolve(p).replace(/[/\\]+$/, '')
}

export function pathsEqual(a: string, b: string): boolean {
    const left = normalizeFsPath(a)
    const right = normalizeFsPath(b)
    if (process.platform === 'win32') {
        return left.toLowerCase() === right.toLowerCase()
    }
    return left === right
}

/** True when candidate is a descendant of root (NOT the root itself). */
export function isStrictChildOfRoot(candidate: string, root: string): boolean {
    const resolvedCandidate = resolve(candidate)
    const resolvedRoot = normalizeFsPath(root)
    if (pathsEqual(resolvedCandidate, resolvedRoot)) return false

    if (process.platform === 'win32') {
        const c = resolvedCandidate.toLowerCase()
        const r = resolvedRoot.toLowerCase()
        return (
            c.startsWith(r + sep.toLowerCase()) ||
            c.startsWith(r + '\\') ||
            c.startsWith(r + '/')
        )
    }
    return resolvedCandidate.startsWith(resolvedRoot + sep)
}

export function isWithinAnyRootStrict(candidate: string, roots: string[]): boolean {
    return roots.some((root) => isStrictChildOfRoot(candidate, root))
}

export function isExactlyAnyRoot(candidate: string, roots: string[]): boolean {
    return roots.some((root) => pathsEqual(candidate, root))
}

/**
 * Resolve physical path when present; detect symlink escape outside roots.
 * Missing paths keep logical resolve (create/migrate targets).
 */
export function resolvePhysicalIfExists(candidate: string): string {
    const logical = resolve(candidate)
    if (!existsSync(logical)) return logical
    try {
        return realpathSync(logical)
    } catch {
        return logical
    }
}

function resolveNearestExistingAncestor(candidate: string): string | null {
    let current = resolve(candidate)
    while (!existsSync(current)) {
        const parent = dirname(current)
        if (pathsEqual(parent, current)) return null
        current = parent
    }
    try {
        return realpathSync(current)
    } catch {
        return null
    }
}

/**
 * Validate a profile folder path for an account:
 * - absolute (caller supplies already-resolved path)
 * - strict child of an allowed root (never the root itself)
 * - basename matches expected profile folder for the account
 * - if exists: realpath still inside roots (blocks symlink escape)
 */
export function checkProfilePathForAccount(
    rawPath: string,
    roots: string[],
    accountId: number,
    email: string,
    options: { forDelete?: boolean } = {},
): ProfilePathCheckResult {
    if (!rawPath || typeof rawPath !== 'string' || rawPath.includes('\0')) {
        return { ok: false, reason: 'Invalid profile path' }
    }

    let resolved: string
    try {
        resolved = resolve(rawPath)
    } catch {
        return { ok: false, reason: 'Invalid profile path' }
    }

    if (resolved.split(/[/\\]/).includes('..')) {
        return { ok: false, reason: 'Path traversal is not allowed' }
    }

    if (isExactlyAnyRoot(resolved, roots)) {
        return { ok: false, reason: 'Refusing to use profile root as profile folder' }
    }

    if (!isWithinAnyRootStrict(resolved, roots)) {
        return { ok: false, reason: 'Profile path is outside allowed roots' }
    }

    const folder = basename(resolved)
    if (!isExpectedProfileBasename(folder, accountId, email)) {
        return { ok: false, reason: 'Profile folder name does not match account' }
    }

    if (existsSync(resolved)) {
        let stats
        try {
            stats = lstatSync(resolved)
        } catch {
            return { ok: false, reason: 'Cannot stat profile path' }
        }

        if (stats.isSymbolicLink() || stats.isDirectory() || stats.isFile()) {
            let physical: string
            try {
                physical = realpathSync(resolved)
            } catch {
                return { ok: false, reason: 'Cannot resolve profile real path' }
            }

            if (isExactlyAnyRoot(physical, roots)) {
                return { ok: false, reason: 'Refusing to operate on profile root' }
            }
            if (!isWithinAnyRootStrict(physical, roots)) {
                return {
                    ok: false,
                    reason: options.forDelete
                        ? 'Refusing delete: symlink or path escapes allowed roots'
                        : 'Resolved path escapes allowed roots',
                }
            }
            if (!isExpectedProfileBasename(basename(physical), accountId, email)) {
                return { ok: false, reason: 'Resolved profile folder does not match account' }
            }
            // Remove a symlink/junction itself, never recursively delete its target.
            if (options.forDelete) {
                resolved = stats.isSymbolicLink() ? resolved : physical
            }
        }
    } else if (options.forDelete) {
        return { ok: false, reason: 'Profile path does not exist' }
    } else {
        // Parent of a new profile folder must be an allowed root or inside one
        const parent = dirname(resolved)
        const parentOk =
            isExactlyAnyRoot(parent, roots) || isWithinAnyRootStrict(parent, roots)
        if (!parentOk) {
            return { ok: false, reason: 'Profile parent is outside allowed roots' }
        }
        const physicalAncestor = resolveNearestExistingAncestor(parent)
        if (
            !physicalAncestor
            || (
                !isExactlyAnyRoot(physicalAncestor, roots)
                && !isWithinAnyRootStrict(physicalAncestor, roots)
            )
        ) {
            return { ok: false, reason: 'Profile parent resolves outside allowed roots' }
        }
    }

    return { ok: true, resolved }
}

/**
 * Delete-specific guard. Never returns a path equal to a root.
 * Callers must skip rmSync when ok is false (poisoned / escaped DB path).
 */
export function checkProfileDeletePath(
    rawPath: string,
    roots: string[],
    accountId: number,
    email: string,
): ProfilePathCheckResult {
    return checkProfilePathForAccount(rawPath, roots, accountId, email, { forDelete: true })
}

// ---------------------------------------------------------------------------
// Runtime root resolution (needs Electron / ProfileService)
// ---------------------------------------------------------------------------

export function getProfileAllowedRoots(extraRoots: string[] = []): string[] {
    const roots: string[] = []
    const push = (value: string | undefined | null) => {
        if (!value || typeof value !== 'string' || value.trim().length === 0) return
        try {
            roots.push(normalizeFsPath(value))
        } catch {
            // ignore
        }
    }

    try {
        push(profileService.getProfilesPath())
    } catch {
        // ignore when service/app not ready
    }

    try {
        const userData = app.getPath('userData')
        push(join(userData, 'profiles'))
        push(join(userData, 'traffic_profiles'))
        push(join(userData, 'browser-profiles'))
    } catch {
        // ignore
    }

    for (const extra of extraRoots) {
        push(extra)
    }

    return Array.from(new Set(roots))
}

function assertProfilePathOrThrow(
    channel: string,
    rawPath: string,
    accountId: number,
    email: string,
    roots: string[],
    options?: { forDelete?: boolean },
): string {
    const result = checkProfilePathForAccount(rawPath, roots, accountId, email, options)
    if (!result.ok) {
        throw new Error(result.reason)
    }
    return result.resolved
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

const emptySummary = (
    accountId: number,
    email: string,
    profilePath: string | null,
): ProfileSummary => ({
    accountId,
    email,
    profilePath,
    exists: false,
    hasCookies: false,
    hasStorage: false,
    sizeBytes: 0,
})

/**
 * Read profile info only when DB path is still safe.
 * Poisoned paths are treated as missing (no FS ops outside roots).
 */
function safeProfileSummary(
    accountId: number,
    email: string,
    profilePath: string | null,
    roots: string[],
): ProfileSummary {
    if (!profilePath) {
        return emptySummary(accountId, email, null)
    }

    const check = checkProfilePathForAccount(profilePath, roots, accountId, email)
    if (!check.ok) {
        // Do not touch poisoned / escaped paths
        return emptySummary(accountId, email, profilePath)
    }

    const info = profileService.getProfileInfo(check.resolved)
    return {
        accountId,
        email,
        profilePath: check.resolved,
        exists: info.exists,
        hasCookies: info.hasCookies,
        hasStorage: info.hasStorage,
        sizeBytes: info.sizeBytes,
        createdAt: info.createdAt,
    }
}

async function getProfileSummary(accountId: number): Promise<ProfileSummary> {
    const account = await accountService.getById(accountId)
    if (!account) {
        throw new Error(`Account ${accountId} not found`)
    }
    const roots = getProfileAllowedRoots()
    return safeProfileSummary(
        account.id,
        account.email,
        account.profilePath || null,
        roots,
    )
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerProfileHandlers() {
    ipcMain.handle(
        'profiles:list',
        withIpcValidation('profiles:list', async () => {
            const accounts = await accountService.getAll()
            const roots = getProfileAllowedRoots()
            const summaries: ProfileSummary[] = []

            for (const account of accounts) {
                summaries.push(
                    safeProfileSummary(
                        account.id,
                        account.email,
                        account.profilePath || null,
                        roots,
                    ),
                )
            }

            return summaries
        }),
    )

    ipcMain.handle(
        'profiles:get',
        withIpcValidation('profiles:get', async (_event, accountId: unknown) => {
            const parsedId = parseIpcPayload('profiles:get', profileGetSchema, accountId)
            return getProfileSummary(parsedId)
        }),
    )

    ipcMain.handle(
        'profiles:create',
        withIpcValidation('profiles:create', async (_event, accountId: unknown) => {
            const parsedId = parseIpcPayload('profiles:create', profileCreateSchema, accountId)
            const account = await accountService.getById(parsedId)
            if (!account) {
                throw new Error(`Account ${parsedId} not found`)
            }

            const roots = getProfileAllowedRoots()
            const expectedTarget = join(
                profileService.getProfilesPath(),
                expectedProfileFolderName(account.id, account.email),
            )
            assertProfilePathOrThrow(
                'profiles:create',
                expectedTarget,
                account.id,
                account.email,
                roots,
            )
            const profilePath = await profileService.createProfile(account.id, account.email)
            // Defense-in-depth: ensure service returned the expected safe path.
            const safePath = assertProfilePathOrThrow(
                'profiles:create',
                profilePath,
                account.id,
                account.email,
                roots,
            )

            const summary = await getProfileSummary(account.id)
            return { ...summary, profilePath: safePath }
        }),
    )

    ipcMain.handle(
        'profiles:update',
        withIpcValidation('profiles:update', async (_event, payload: unknown) => {
            const parsed = parseIpcPayload('profiles:update', profileUpdatePayloadSchema, payload)
            const account = await accountService.getById(parsed.accountId)
            if (!account) {
                throw new Error(`Account ${parsed.accountId} not found`)
            }

            const roots = getProfileAllowedRoots()
            const expectedName = expectedProfileFolderName(account.id, account.email)

            let targetPath: string
            if (parsed.profilePath) {
                targetPath = resolve(parsed.profilePath)
            } else if (parsed.basePath) {
                // Always use expected basename — never trust DB basename for join
                const safeBase = resolve(parsed.basePath)
                const baseAllowed =
                    isExactlyAnyRoot(safeBase, roots) || isWithinAnyRootStrict(safeBase, roots)
                if (!baseAllowed) {
                    throw new Error('basePath is outside allowed roots')
                }
                targetPath = join(safeBase, expectedName)
            } else {
                throw new Error('profilePath or basePath is required')
            }

            const safeTarget = assertProfilePathOrThrow(
                'profiles:update',
                targetPath,
                account.id,
                account.email,
                roots,
            )

            mkdirSync(safeTarget, { recursive: true })

            // Copy from previous location only when source is also safe
            const previous = account.profilePath
            if (previous && previous !== safeTarget && existsSync(previous)) {
                const sourceCheck = checkProfilePathForAccount(
                    previous,
                    roots,
                    account.id,
                    account.email,
                )
                if (sourceCheck.ok && sourceCheck.resolved !== safeTarget) {
                    cpSync(sourceCheck.resolved, safeTarget, { recursive: true, force: true })
                }
            }

            await accountService.update(account.id, { profilePath: safeTarget })
            return getProfileSummary(account.id)
        }),
    )

    ipcMain.handle(
        'profiles:delete',
        withIpcValidation('profiles:delete', async (_event, accountId: unknown) => {
            const parsedId = parseIpcPayload('profiles:delete', profileDeleteSchema, accountId)
            const account = await accountService.getById(parsedId)
            if (!account) {
                throw new Error(`Account ${parsedId} not found`)
            }

            const roots = getProfileAllowedRoots()
            const previous = account.profilePath

            if (previous) {
                const delCheck = checkProfileDeletePath(
                    previous,
                    roots,
                    account.id,
                    account.email,
                )
                if (delCheck.ok) {
                    // Final belt-and-suspenders: never rm a root
                    if (!isExactlyAnyRoot(delCheck.resolved, roots)) {
                        try {
                            if (existsSync(delCheck.resolved)) {
                                const st = lstatSync(delCheck.resolved)
                                if (st.isDirectory() || st.isSymbolicLink()) {
                                    rmSync(delCheck.resolved, { recursive: true, force: true })
                                }
                            }
                        } catch (err) {
                            console.error('[profiles:delete] rm failed:', err)
                            throw new Error('Failed to delete profile directory')
                        }
                    }
                } else {
                    // Poisoned DB path: never touch filesystem; clear pointer only
                    console.warn(
                        `[profiles:delete] skipping FS delete for account ${account.id}: ${delCheck.reason}`,
                    )
                }
            }

            await accountService.update(account.id, { profilePath: null })
            return {
                success: true,
                accountId: account.id,
            }
        }),
    )

    ipcMain.handle(
        'profiles:migrate',
        withIpcValidation('profiles:migrate', async (_event, payload: unknown) => {
            const parsed = parseIpcPayload(
                'profiles:migrate',
                profileMigratePayloadSchema,
                payload,
            )
            const account = await accountService.getById(parsed.accountId)
            if (!account) {
                throw new Error(`Account ${parsed.accountId} not found`)
            }

            if (!account.profilePath) {
                throw new Error('Source profile does not exist')
            }

            const roots = getProfileAllowedRoots()
            const sourceCheck = checkProfilePathForAccount(
                account.profilePath,
                roots,
                account.id,
                account.email,
            )
            if (!sourceCheck.ok || !existsSync(sourceCheck.resolved)) {
                throw new Error(
                    sourceCheck.ok
                        ? 'Source profile does not exist'
                        : `Unsafe source profile: ${sourceCheck.reason}`,
                )
            }

            const targetBase = resolve(parsed.targetBasePath)
            // target base may equal a profile root (e.g. profiles dir)
            const baseAllowed =
                isExactlyAnyRoot(targetBase, roots) || isWithinAnyRootStrict(targetBase, roots)
            if (!baseAllowed) {
                throw new Error('targetBasePath is outside allowed roots')
            }

            const folderName = isExpectedProfileBasename(
                basename(sourceCheck.resolved),
                account.id,
                account.email,
            )
                ? basename(sourceCheck.resolved)
                : expectedProfileFolderName(account.id, account.email)

            const targetPath = join(targetBase, folderName)
            const safeTarget = assertProfilePathOrThrow(
                'profiles:migrate',
                targetPath,
                account.id,
                account.email,
                roots,
            )

            if (pathsEqual(sourceCheck.resolved, safeTarget)) {
                return {
                    success: true,
                    accountId: account.id,
                    sourcePath: sourceCheck.resolved,
                    targetPath: safeTarget,
                }
            }

            mkdirSync(safeTarget, { recursive: true })
            cpSync(sourceCheck.resolved, safeTarget, { recursive: true, force: true })

            await accountService.update(account.id, { profilePath: safeTarget })
            return {
                success: true,
                accountId: account.id,
                sourcePath: sourceCheck.resolved,
                targetPath: safeTarget,
            }
        }),
    )
}
