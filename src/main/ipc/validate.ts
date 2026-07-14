/**
 * IPC validation wrapper + filesystem/path guards for main-process handlers.
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { z } from 'zod'
import { createIpcError } from './errors'
import { absolutePathSchema, httpUrlSchema } from '../../shared/ipc-schemas'

// ---------------------------------------------------------------------------
// Schema parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single IPC payload with Zod. Throws createIpcError on failure.
 */
export function parseIpcPayload<T extends z.ZodType>(
    channel: string,
    schema: T,
    value: unknown,
): z.infer<T> {
    const result = schema.safeParse(value)
    if (!result.success) {
        throw createIpcError(channel, result.error)
    }
    return result.data
}

/**
 * Parse multi-arg IPC payloads as a tuple schema.
 * Usage: parseIpcArgs('locations:update', z.tuple([idSchema, locationUpdateSchema]), [id, data])
 */
export function parseIpcArgs<T extends z.ZodType>(
    channel: string,
    schema: T,
    args: unknown[],
): z.infer<T> {
    return parseIpcPayload(channel, schema, args)
}

/**
 * Wrap an IPC handler body: catch validation/runtime errors and rethrow as channel errors.
 */
export function withIpcValidation<TArgs extends unknown[], TResult>(
    channel: string,
    handler: (...args: TArgs) => TResult | Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
        try {
            return await handler(...args)
        } catch (error) {
            throw createIpcError(channel, error)
        }
    }
}

// ---------------------------------------------------------------------------
// URL guards
// ---------------------------------------------------------------------------

export function assertHttpUrl(channel: string, value: unknown): string {
    return parseIpcPayload(channel, httpUrlSchema, value)
}

export function isHttpUrl(value: string): boolean {
    try {
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------
// Path root guards
// ---------------------------------------------------------------------------

function normalizeRoot(root: string): string {
    return path.resolve(root).replace(/[/\\]+$/, '')
}

function pathIsInside(candidate: string, root: string): boolean {
    const resolvedCandidate = path.resolve(candidate)
    const resolvedRoot = normalizeRoot(root)
    if (process.platform === 'win32') {
        const c = resolvedCandidate.toLowerCase()
        const r = resolvedRoot.toLowerCase()
        return c === r || c.startsWith(r + path.sep.toLowerCase()) || c.startsWith(r + '\\') || c.startsWith(r + '/')
    }
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep)
}

/**
 * Default roots considered safe for open/read/write from IPC.
 * Includes userData, appData, common user folders, app path, and cwd.
 */
export function getDefaultAllowedRoots(extraRoots: string[] = []): string[] {
    const roots: string[] = []

    const push = (value: string | undefined | null) => {
        if (!value || typeof value !== 'string' || value.trim().length === 0) return
        try {
            roots.push(normalizeRoot(value))
        } catch {
            // ignore invalid path entries
        }
    }

    try {
        push(app.getPath('userData'))
        push(app.getPath('appData'))
        push(app.getPath('temp'))
        push(app.getPath('home'))
        push(app.getPath('documents'))
        push(app.getPath('downloads'))
        push(app.getPath('desktop'))
        push(app.getAppPath())
    } catch {
        // app may not be ready in unit-test contexts
    }

    push(process.cwd())
    for (const extra of extraRoots) {
        push(extra)
    }

    // Deduplicate
    return Array.from(new Set(roots))
}

/**
 * Resolve path and ensure it stays under one of the allowed roots.
 * Rejects path traversal and null bytes.
 */
export function assertPathWithinRoots(
    channel: string,
    rawPath: unknown,
    allowedRoots?: string[],
): string {
    const syntax = parseIpcPayload(channel, absolutePathSchema, rawPath)
    let resolved: string
    try {
        resolved = path.resolve(syntax)
    } catch {
        throw createIpcError(channel, new Error('Invalid path'))
    }

    if (resolved.includes('\0')) {
        throw createIpcError(channel, new Error('Path must not contain null bytes'))
    }

    // Reject remaining relative segments after resolve (should not happen, belt-and-suspenders)
    const parts = resolved.split(/[/\\]/)
    if (parts.includes('..')) {
        throw createIpcError(channel, new Error('Path traversal is not allowed'))
    }

    const roots = allowedRoots && allowedRoots.length > 0
        ? allowedRoots.map(normalizeRoot)
        : getDefaultAllowedRoots()

    const allowed = roots.some((root) => pathIsInside(resolved, root))
    if (!allowed) {
        throw createIpcError(
            channel,
            new Error('Path is outside allowed application roots'),
        )
    }

    return resolved
}

/**
 * Soft path resolve for optional paths (returns undefined when input is empty/undefined).
 */
export function assertOptionalPathWithinRoots(
    channel: string,
    rawPath: unknown,
    allowedRoots?: string[],
): string | undefined {
    if (rawPath === undefined || rawPath === null || rawPath === '') {
        return undefined
    }
    return assertPathWithinRoots(channel, rawPath, allowedRoots)
}

/**
 * Ensure directory exists and is a directory (after root check).
 */
export function assertExistingDirectory(
    channel: string,
    rawPath: unknown,
    allowedRoots?: string[],
): string {
    const resolved = assertPathWithinRoots(channel, rawPath, allowedRoots)
    if (!fs.existsSync(resolved)) {
        throw createIpcError(channel, new Error('Directory does not exist'))
    }
    let stats: fs.Stats
    try {
        stats = fs.statSync(resolved)
    } catch {
        throw createIpcError(channel, new Error('Cannot stat directory'))
    }
    if (!stats.isDirectory()) {
        throw createIpcError(channel, new Error('Path is not a directory'))
    }
    return resolved
}

/**
 * Ensure file exists and is a regular file (after root check).
 */
export function assertExistingFile(
    channel: string,
    rawPath: unknown,
    allowedRoots?: string[],
): string {
    const resolved = assertPathWithinRoots(channel, rawPath, allowedRoots)
    if (!fs.existsSync(resolved)) {
        throw createIpcError(channel, new Error('File does not exist'))
    }
    let stats: fs.Stats
    try {
        stats = fs.statSync(resolved)
    } catch {
        throw createIpcError(channel, new Error('Cannot stat file'))
    }
    if (!stats.isFile()) {
        throw createIpcError(channel, new Error('Path is not a file'))
    }
    return resolved
}

/**
 * Legacy-migrate sources may only come from appData / userData / portable roots.
 */
export function getLegacyMigrateAllowedRoots(): string[] {
    const roots: string[] = []
    try {
        roots.push(app.getPath('appData'))
        roots.push(app.getPath('userData'))
        const portable = process.env.PORTABLE_EXECUTABLE_DIR
        if (portable) roots.push(portable)
        if (app.isPackaged) {
            roots.push(path.dirname(process.execPath))
        }
    } catch {
        // ignore
    }
    roots.push(process.cwd())
    return Array.from(new Set(roots.map(normalizeRoot)))
}

/**
 * Roots for data:openPath — storage-related dirs only.
 */
export function getDataOpenAllowedRoots(dataRoot: string, profilesPath?: string): string[] {
    const roots = [
        dataRoot,
        path.join(dataRoot, 'screenshots'),
        path.join(dataRoot, 'data'),
        path.join(dataRoot, 'traffic_profiles'),
        path.join(dataRoot, 'browser-profiles'),
        path.join(dataRoot, 'profiles'),
    ]
    if (profilesPath) roots.push(profilesPath)
    try {
        roots.push(app.getPath('userData'))
        roots.push(app.getPath('temp'))
    } catch {
        // ignore
    }
    return Array.from(new Set(roots.map(normalizeRoot)))
}

const FORBIDDEN_PATH_MARKERS = [
    `${path.sep}windows${path.sep}system32`,
    `${path.sep}windows${path.sep}syswow64`,
    `${path.sep}program files${path.sep}`,
    `${path.sep}program files (x86)${path.sep}`,
    '/etc/',
    '/usr/bin',
    '/usr/sbin',
    '/bin/',
    '/sbin/',
    '/System/Library',
]

/**
 * Image folders may be user-selected anywhere reasonable.
 * Reject null/traversal + well-known system directories; allow absolute existing dirs.
 */
export function assertSafeImageDirectory(channel: string, rawPath: unknown): string {
    const syntax = parseIpcPayload(channel, absolutePathSchema, rawPath)
    let resolved: string
    try {
        resolved = path.resolve(syntax)
    } catch {
        throw createIpcError(channel, new Error('Invalid path'))
    }

    if (resolved.includes('\0') || resolved.split(/[/\\]/).includes('..')) {
        throw createIpcError(channel, new Error('Path traversal is not allowed'))
    }

    const lower = resolved.toLowerCase().replace(/\//g, path.sep)
    for (const marker of FORBIDDEN_PATH_MARKERS) {
        if (lower.includes(marker.toLowerCase())) {
            throw createIpcError(channel, new Error('Path points to a forbidden system location'))
        }
    }

    // Prefer confinement under default roots when possible; otherwise allow non-system absolute dirs
    // (user may pick image folders on other drives via the native dialog).
    const defaultRoots = getDefaultAllowedRoots()
    const inDefault = defaultRoots.some((root) => pathIsInside(resolved, root))
    if (!inDefault) {
        // Still require it looks like a normal absolute path (already checked by absolutePathSchema)
        console.warn(`[${channel}] image path outside default roots (allowed if non-system): ${resolved}`)
    }

    if (!fs.existsSync(resolved)) {
        throw createIpcError(channel, new Error('Directory does not exist'))
    }
    let stats: fs.Stats
    try {
        stats = fs.statSync(resolved)
    } catch {
        throw createIpcError(channel, new Error('Cannot stat directory'))
    }
    if (!stats.isDirectory()) {
        throw createIpcError(channel, new Error('Path is not a directory'))
    }
    return resolved
}
