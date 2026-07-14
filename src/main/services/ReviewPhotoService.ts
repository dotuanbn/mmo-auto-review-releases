import { app } from 'electron'
import * as path from 'path'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { loadSettings } from '../ipc/settings'
import {
    imageManager,
    isImagePathWithinRoots,
    redactImagePathForLog,
} from './ImageManager'

/**
 * ReviewPhotoService — resolve optional review photo attachments.
 *
 * - Honors settings.includePhotos unless explicitly overridden
 * - Validates extension, size, and allowed path roots
 * - Avoids reusing the same image for the same process/account when possible
 * - Never logs full absolute paths (basename-only redaction)
 */

export interface ReviewPhotoResolveInput {
    /** Explicit single photo path (highest priority with photoPaths). */
    photoPath?: string
    /** Explicit multi photo paths (capped by maxPhotos). */
    photoPaths?: readonly string[]
    /** Default 1 — optional attach is single-image by default. */
    maxPhotos?: number
    /**
     * When undefined, reads loadSettings().includePhotos.
     * Explicit photoPath/photoPaths still win even if includePhotos is false
     * (caller intentionally provided a path).
     */
    includePhotos?: boolean
    /** Account / process key for reuse avoidance (email, account id, etc.). */
    accountKey?: string
    /** Campaign id string for ImageManager usage tracking. */
    campaignId?: string
    /** Optional folder roots to sample from; defaults to registered DB image folders. */
    folderPaths?: readonly string[]
    /** Extra allowed filesystem roots (merged with defaults). */
    allowedRoots?: readonly string[]
}

export type ReviewPhotoSource = 'explicit' | 'library' | 'none'

export interface ReviewPhotoResolveResult {
    paths: string[]
    source: ReviewPhotoSource
    /** Human-readable skip/selection note (safe for logs — no full paths). */
    reason?: string
    /** Basename-only labels for logging. */
    labels: string[]
}

export interface ReviewPhotoValidationResult {
    valid: boolean
    resolvedPath?: string
    error?: string
    label: string
}

const DEFAULT_MAX_PHOTOS = 1
const MAX_PHOTOS_HARD_CAP = 5

function clampMaxPhotos(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_PHOTOS
    const n = Math.floor(value)
    if (n <= 0) return DEFAULT_MAX_PHOTOS
    return Math.min(n, MAX_PHOTOS_HARD_CAP)
}

function normalizeUsagePart(raw: string | undefined, fallback: string): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
    // Bound length; strip path-like separators from keys
    return raw.trim().slice(0, 96).replace(/[/\\]/g, '_')
}

export class ReviewPhotoService {
    /** Process-lifetime used images keyed by account (or "global"). */
    private readonly processUsedByAccount = new Map<string, Set<string>>()

    /**
     * Whether photo attach should run from library/settings.
     * Explicit paths always proceed when provided.
     */
    shouldAttachFromSettings(includePhotosOverride?: boolean): boolean {
        if (typeof includePhotosOverride === 'boolean') {
            return includePhotosOverride
        }
        try {
            const settings = loadSettings()
            return settings.includePhotos === true
        } catch {
            return false
        }
    }

    /**
     * Build usage key shared with ImageManager for this process.
     */
    buildUsageKey(accountKey?: string, campaignId?: string): string {
        const acct = normalizeUsagePart(accountKey, 'global')
        const camp = normalizeUsagePart(campaignId, 'default')
        return `review-photo|acct:${acct}|camp:${camp}`
    }

    /**
     * Default allowed roots for review photos (userData, home, documents, downloads, cwd, extras).
     */
    getAllowedRoots(extraRoots: readonly string[] = []): string[] {
        const roots: string[] = []
        const push = (value: string | undefined | null) => {
            if (!value || typeof value !== 'string' || value.trim().length === 0) return
            try {
                roots.push(path.resolve(value).replace(/[/\\]+$/, ''))
            } catch {
                // ignore invalid
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
            // app may not be ready in tests
        }

        push(process.cwd())
        for (const extra of extraRoots) {
            push(extra)
        }

        return Array.from(new Set(roots))
    }

    /**
     * Registered image folder paths from DB (read-only). Empty if DB unavailable.
     */
    getRegisteredFolderPaths(): string[] {
        try {
            const db = getDatabase()
            const rows = db.select({ path: schema.imageFolders.path }).from(schema.imageFolders).all()
            const paths: string[] = []
            for (const row of rows) {
                if (typeof row.path === 'string' && row.path.trim().length > 0) {
                    paths.push(row.path)
                }
            }
            return paths
        } catch {
            return []
        }
    }

    /**
     * Validate a single candidate path (ext, size, roots).
     */
    validatePhotoPath(
        imagePath: string,
        allowedRoots: readonly string[],
    ): ReviewPhotoValidationResult {
        const label = redactImagePathForLog(imagePath)
        if (typeof imagePath !== 'string' || imagePath.trim().length === 0) {
            return { valid: false, error: 'Empty path', label }
        }

        if (!isImagePathWithinRoots(imagePath, allowedRoots)) {
            return { valid: false, error: 'Path outside allowed roots', label }
        }

        const result = imageManager.validateImageWithinRoots(imagePath, allowedRoots)
        if (!result.valid || !result.resolvedPath) {
            return { valid: false, error: result.error || 'Invalid image', label }
        }

        return {
            valid: true,
            resolvedPath: result.resolvedPath,
            label: redactImagePathForLog(result.resolvedPath),
        }
    }

    private getProcessUsedSet(accountKey: string): Set<string> {
        if (!this.processUsedByAccount.has(accountKey)) {
            this.processUsedByAccount.set(accountKey, new Set())
        }
        return this.processUsedByAccount.get(accountKey)!
    }

    /**
     * Mark paths used for this process/account (in-memory only).
     * ImageManager usageKey tracking is handled inside resolvePhotos.
     */
    markUsed(accountKey: string | undefined, imagePaths: readonly string[]): void {
        const key = normalizeUsagePart(accountKey, 'global')
        const set = this.getProcessUsedSet(key)
        for (const p of imagePaths) {
            set.add(p)
        }
    }

    /**
     * Resolve 0..maxPhotos validated image paths for an optional review attach.
     */
    resolvePhotos(input: ReviewPhotoResolveInput = {}): ReviewPhotoResolveResult {
        const maxPhotos = clampMaxPhotos(input.maxPhotos)
        const accountPart = normalizeUsagePart(input.accountKey, 'global')
        const usageKey = this.buildUsageKey(input.accountKey, input.campaignId)
        const processUsed = this.getProcessUsedSet(accountPart)

        const folderExtras = [
            ...(input.folderPaths ?? []),
            ...this.getRegisteredFolderPaths(),
        ]
        const allowedRoots = this.getAllowedRoots([
            ...(input.allowedRoots ?? []),
            ...folderExtras,
        ])

        // 1) Explicit paths from caller — always considered (backward-compatible override)
        const explicitRaw: string[] = []
        if (typeof input.photoPath === 'string' && input.photoPath.trim()) {
            explicitRaw.push(input.photoPath.trim())
        }
        if (Array.isArray(input.photoPaths)) {
            for (const p of input.photoPaths) {
                if (typeof p === 'string' && p.trim()) explicitRaw.push(p.trim())
            }
        }

        if (explicitRaw.length > 0) {
            const validated: string[] = []
            const labels: string[] = []
            const seen = new Set<string>()
            for (const raw of explicitRaw) {
                if (validated.length >= maxPhotos) break
                const check = this.validatePhotoPath(raw, allowedRoots)
                if (!check.valid || !check.resolvedPath) {
                    console.warn(
                        `[ReviewPhoto] skip explicit photo ${check.label}: ${check.error}`,
                    )
                    continue
                }
                if (seen.has(check.resolvedPath)) continue
                seen.add(check.resolvedPath)
                validated.push(check.resolvedPath)
                labels.push(check.label)
            }

            if (validated.length === 0) {
                return {
                    paths: [],
                    source: 'none',
                    reason: 'explicit photos invalid',
                    labels: [],
                }
            }

            this.markUsed(input.accountKey, validated)
            imageManager.markImagesUsed(usageKey, validated)
            return {
                paths: validated,
                source: 'explicit',
                reason: `explicit:${validated.length}`,
                labels,
            }
        }

        // 2) Library pick only when includePhotos is enabled
        if (!this.shouldAttachFromSettings(input.includePhotos)) {
            return {
                paths: [],
                source: 'none',
                reason: 'includePhotos disabled',
                labels: [],
            }
        }

        const folders =
            input.folderPaths && input.folderPaths.length > 0
                ? [...input.folderPaths]
                : this.getRegisteredFolderPaths()

        if (folders.length === 0) {
            return {
                paths: [],
                source: 'none',
                reason: 'no image folders registered',
                labels: [],
            }
        }

        // Prefer unused in this process/account; fall back if pool exhausted
        let picked = imageManager.getRandomImagesFromFolders(
            folders,
            maxPhotos,
            usageKey,
            { excludePaths: processUsed },
        )

        if (picked.length === 0) {
            // Soft recycle process-level set for this account and retry once
            processUsed.clear()
            picked = imageManager.getRandomImagesFromFolders(
                folders,
                maxPhotos,
                usageKey,
            )
        }

        const validated: string[] = []
        const labels: string[] = []
        for (const candidate of picked) {
            if (validated.length >= maxPhotos) break
            const check = this.validatePhotoPath(candidate, allowedRoots)
            if (!check.valid || !check.resolvedPath) {
                console.warn(
                    `[ReviewPhoto] skip library photo ${check.label}: ${check.error}`,
                )
                continue
            }
            validated.push(check.resolvedPath)
            labels.push(check.label)
        }

        if (validated.length === 0) {
            return {
                paths: [],
                source: 'none',
                reason: 'no valid library photos',
                labels: [],
            }
        }

        this.markUsed(input.accountKey, validated)
        return {
            paths: validated,
            source: 'library',
            reason: `library:${validated.length}`,
            labels,
        }
    }

    /**
     * Clear process-level reuse tracking (tests / long sessions).
     */
    clearProcessUsage(accountKey?: string): void {
        if (accountKey === undefined) {
            this.processUsedByAccount.clear()
            return
        }
        this.processUsedByAccount.delete(normalizeUsagePart(accountKey, 'global'))
    }
}

export const reviewPhotoService = new ReviewPhotoService()
