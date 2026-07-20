import * as fs from 'fs'
import * as path from 'path'

/**
 * ImageManager - Manage images for review campaigns
 * Supports image folder mapping and random selection
 *
 * Path safety: all public methods normalize paths, reject null bytes,
 * and refuse path traversal segments after resolve.
 */

export const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'] as const
export type SupportedImageExtension = (typeof SUPPORTED_IMAGE_EXTENSIONS)[number]

/** Max upload/preview size for review photos (10MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const SUPPORTED_EXTENSIONS: readonly string[] = SUPPORTED_IMAGE_EXTENSIONS

export interface ImageFolder {
    path: string
    name: string
    imageCount: number
}

export interface RandomImagePickOptions {
    /** Absolute paths to skip (e.g. already used this process/account). */
    excludePaths?: ReadonlySet<string> | readonly string[]
}

function rejectUnsafePath(rawPath: string): string | null {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        return null
    }
    if (rawPath.includes('\0')) {
        return null
    }

    let resolved: string
    try {
        resolved = path.resolve(rawPath)
    } catch {
        return null
    }

    // After resolve, no remaining parent references should appear as segments
    const segments = resolved.split(/[/\\]/)
    if (segments.includes('..')) {
        return null
    }

    return resolved
}

function isSupportedImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return SUPPORTED_EXTENSIONS.includes(ext)
}

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

function toExcludeSet(exclude?: ReadonlySet<string> | readonly string[]): Set<string> {
    if (!exclude) return new Set()
    return new Set(exclude)
}

/**
 * Safe log label for an image path — basename only, never full absolute path.
 */
export function redactImagePathForLog(imagePath: string): string {
    if (typeof imagePath !== 'string' || imagePath.trim().length === 0) {
        return '[empty]'
    }
    try {
        const base = path.basename(imagePath)
        // Strip drive/parent hints if basename somehow still looks absolute
        return base.replace(/^[A-Za-z]:/, '').replace(/^[/\\]+/, '') || '[image]'
    } catch {
        return '[image]'
    }
}

/**
 * True when resolved image path is under at least one allowed root.
 */
export function isImagePathWithinRoots(imagePath: string, allowedRoots: readonly string[]): boolean {
    const safe = rejectUnsafePath(imagePath)
    if (!safe || allowedRoots.length === 0) return false
    return allowedRoots.some((root) => {
        try {
            return pathIsInside(safe, root)
        } catch {
            return false
        }
    })
}

export class ImageManager {
    private usedImages: Map<string, Set<string>> = new Map() // campaignId -> used image paths

    /**
     * Scan a folder for images
     * @param folderPath - Path to image folder
     * @returns Image folder info with count
     */
    scanFolder(folderPath: string): ImageFolder | null {
        const safe = rejectUnsafePath(folderPath)
        if (!safe || !fs.existsSync(safe)) {
            return null
        }

        let stats: fs.Stats
        try {
            stats = fs.statSync(safe)
        } catch {
            return null
        }
        if (!stats.isDirectory()) {
            return null
        }

        const images = this.getImagesInFolder(safe)

        return {
            path: safe,
            name: path.basename(safe),
            imageCount: images.length,
        }
    }

    /**
     * Get all images in a folder
     * @param folderPath - Path to scan
     * @returns Array of image file paths
     */
    getImagesInFolder(folderPath: string): string[] {
        const safe = rejectUnsafePath(folderPath)
        if (!safe || !fs.existsSync(safe)) {
            return []
        }

        try {
            const files = fs.readdirSync(safe)
            return files
                .filter(file => {
                    // Reject nested traversal via file names
                    if (file.includes('..') || file.includes('\0') || file.includes('/') || file.includes('\\')) {
                        return false
                    }
                    const full = path.join(safe, file)
                    const resolved = path.resolve(full)
                    if (!resolved.startsWith(safe)) {
                        return false
                    }
                    return isSupportedImageFile(file)
                })
                .map(file => path.join(safe, file))
        } catch (error) {
            console.error('Failed to read image folder:', error)
            return []
        }
    }

    /**
     * Get random images from a folder (without repeating for same usage key).
     * usageKey is typically campaignId, or a composite account/process key.
     */
    getRandomImages(
        folderPath: string,
        count: number,
        usageKey: string,
        options?: RandomImagePickOptions,
    ): string[] {
        if (!Number.isFinite(count) || count <= 0 || count > 100) {
            return []
        }
        if (typeof usageKey !== 'string' || usageKey.length === 0 || usageKey.length > 256) {
            return []
        }

        const allImages = this.getImagesInFolder(folderPath)
        if (allImages.length === 0) return []

        if (!this.usedImages.has(usageKey)) {
            this.usedImages.set(usageKey, new Set())
        }
        const used = this.usedImages.get(usageKey)!
        const exclude = toExcludeSet(options?.excludePaths)

        const available = allImages.filter(img => !used.has(img) && !exclude.has(img))

        if (available.length === 0) {
            // Prefer unused under exclude; only recycle usageKey pool when exclude is empty
            const withoutUsedOnly = allImages.filter(img => !exclude.has(img))
            if (withoutUsedOnly.length === 0) {
                return []
            }
            if (used.size > 0 && withoutUsedOnly.every(img => used.has(img))) {
                used.clear()
                return this.getRandomImages(folderPath, count, usageKey, options)
            }
            // All remaining candidates are excluded externally — nothing to pick
            return []
        }

        const selected: string[] = []
        const shuffled = [...available].sort(() => Math.random() - 0.5)

        for (let i = 0; i < Math.min(count, shuffled.length); i++) {
            selected.push(shuffled[i])
            used.add(shuffled[i])
        }

        return selected
    }

    /**
     * Get a single random image
     */
    getRandomImage(
        folderPath: string,
        usageKey: string,
        options?: RandomImagePickOptions,
    ): string | null {
        const images = this.getRandomImages(folderPath, 1, usageKey, options)
        return images.length > 0 ? images[0] : null
    }

    /**
     * Pick random images across multiple folders with a shared usage key.
     * Shuffles folder order each call; avoids reusing within usageKey / excludePaths.
     */
    getRandomImagesFromFolders(
        folderPaths: readonly string[],
        count: number,
        usageKey: string,
        options?: RandomImagePickOptions,
    ): string[] {
        if (!Number.isFinite(count) || count <= 0 || count > 100) {
            return []
        }
        if (!Array.isArray(folderPaths) || folderPaths.length === 0) {
            return []
        }

        const selected: string[] = []
        const localExclude = new Set<string>(toExcludeSet(options?.excludePaths))
        const folders = [...folderPaths].sort(() => Math.random() - 0.5)

        // Round-robin across folders until count is met or no more unique images
        while (selected.length < count) {
            let pickedThisRound = 0
            for (const folder of folders) {
                if (selected.length >= count) break
                const one = this.getRandomImages(folder, 1, usageKey, { excludePaths: localExclude })
                if (one.length === 1) {
                    selected.push(one[0])
                    localExclude.add(one[0])
                    pickedThisRound++
                }
            }
            if (pickedThisRound === 0) break
        }

        return selected
    }

    /**
     * Mark paths as used under a usage key (e.g. after explicit photoPath attach).
     */
    markImagesUsed(usageKey: string, imagePaths: readonly string[]): void {
        if (typeof usageKey !== 'string' || usageKey.length === 0 || usageKey.length > 256) {
            return
        }
        if (!this.usedImages.has(usageKey)) {
            this.usedImages.set(usageKey, new Set())
        }
        const used = this.usedImages.get(usageKey)!
        for (const raw of imagePaths) {
            const safe = rejectUnsafePath(raw)
            if (safe) used.add(safe)
        }
    }

    /**
     * Whether a path was already marked used under usageKey in this process.
     */
    isImageUsed(usageKey: string, imagePath: string): boolean {
        const used = this.usedImages.get(usageKey)
        if (!used) return false
        const safe = rejectUnsafePath(imagePath)
        return safe ? used.has(safe) : false
    }

    /**
     * Reset used images tracking for a campaign
     */
    resetCampaignUsage(campaignId: string): void {
        this.usedImages.delete(campaignId)
    }

    /**
     * Clear all usage tracking
     */
    clearAllUsage(): void {
        this.usedImages.clear()
    }

    /**
     * Validate image file
     */
    validateImage(imagePath: string): {
        valid: boolean
        error?: string
        sizeBytes?: number
        dimensions?: { width: number; height: number }
    } {
        const safe = rejectUnsafePath(imagePath)
        if (!safe || !fs.existsSync(safe)) {
            return { valid: false, error: 'File not found' }
        }

        if (!isSupportedImageFile(safe)) {
            return { valid: false, error: `Unsupported format: ${path.extname(safe)}` }
        }

        let stats: fs.Stats
        try {
            stats = fs.statSync(safe)
        } catch {
            return { valid: false, error: 'Cannot read file stats' }
        }

        if (!stats.isFile()) {
            return { valid: false, error: 'Path is not a file' }
        }

        if (stats.size > MAX_IMAGE_BYTES) {
            return { valid: false, error: 'File too large (max 10MB)', sizeBytes: stats.size }
        }

        if (stats.size <= 0) {
            return { valid: false, error: 'File is empty', sizeBytes: stats.size }
        }

        return { valid: true, sizeBytes: stats.size }
    }

    /**
     * Validate image under allowed filesystem roots (ext + size + root confinement).
     */
    validateImageWithinRoots(
        imagePath: string,
        allowedRoots: readonly string[],
    ): {
        valid: boolean
        error?: string
        sizeBytes?: number
        resolvedPath?: string
    } {
        const safe = rejectUnsafePath(imagePath)
        if (!safe) {
            return { valid: false, error: 'Invalid path' }
        }
        if (!isImagePathWithinRoots(safe, allowedRoots)) {
            return { valid: false, error: 'Path outside allowed roots' }
        }
        const base = this.validateImage(safe)
        if (!base.valid) {
            return { valid: false, error: base.error, sizeBytes: base.sizeBytes }
        }
        return { valid: true, sizeBytes: base.sizeBytes, resolvedPath: safe }
    }

    /**
     * Get image as base64 for upload/preview.
     * Only supported image extensions; max 10MB.
     */
    getImageBase64(imagePath: string): string | null {
        const validation = this.validateImage(imagePath)
        if (!validation.valid) {
            console.error('getImageBase64 rejected:', validation.error)
            return null
        }

        const safe = rejectUnsafePath(imagePath)
        if (!safe) return null

        try {
            const buffer = fs.readFileSync(safe)
            const ext = path.extname(safe).toLowerCase()
            const mimeType = ext === '.png' ? 'image/png'
                : ext === '.webp' ? 'image/webp'
                    : ext === '.gif' ? 'image/gif'
                        : 'image/jpeg'

            return `data:${mimeType};base64,${buffer.toString('base64')}`
        } catch (error) {
            console.error('Failed to read image:', error)
            return null
        }
    }

    /**
     * List all image folders in a directory
     */
    listImageFolders(basePath: string): ImageFolder[] {
        const safe = rejectUnsafePath(basePath)
        if (!safe || !fs.existsSync(safe)) return []

        const folders: ImageFolder[] = []

        try {
            const entries = fs.readdirSync(safe, { withFileTypes: true })

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (entry.name.includes('..') || entry.name.includes('\0')) continue
                    const folderPath = path.join(safe, entry.name)
                    const folder = this.scanFolder(folderPath)
                    if (folder && folder.imageCount > 0) {
                        folders.push(folder)
                    }
                }
            }
        } catch (error) {
            console.error('Failed to list folders:', error)
        }

        return folders
    }

    /**
     * Copy image to app's image storage folder
     */
    copyImageToFolder(sourcePath: string, destFolder: string, newName?: string): string | null {
        const safeSource = rejectUnsafePath(sourcePath)
        const safeDestFolder = rejectUnsafePath(destFolder)
        if (!safeSource || !safeDestFolder) return null
        if (!isSupportedImageFile(safeSource)) return null

        try {
            if (!fs.existsSync(safeDestFolder)) {
                fs.mkdirSync(safeDestFolder, { recursive: true })
            }

            const ext = path.extname(safeSource)
            let filename: string
            if (newName) {
                // Sanitize new name: basename only, no path separators
                const base = path.basename(newName).replace(/[<>:"|?*\0]/g, '_')
                filename = base.includes('.') ? base : `${base}${ext}`
            } else {
                filename = `${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`
            }
            const destPath = path.join(safeDestFolder, filename)
            const resolvedDest = path.resolve(destPath)
            if (!resolvedDest.startsWith(safeDestFolder)) {
                return null
            }

            fs.copyFileSync(safeSource, resolvedDest)
            return resolvedDest
        } catch (error) {
            console.error('Failed to copy image:', error)
            return null
        }
    }

    /**
     * Get image file info
     */
    getImageInfo(imagePath: string): {
        filename: string
        path: string
        size: number
        extension: string
    } | null {
        try {
            const safe = rejectUnsafePath(imagePath)
            if (!safe || !fs.existsSync(safe)) return null
            const stats = fs.statSync(safe)
            if (!stats.isFile() || !isSupportedImageFile(safe)) return null
            return {
                filename: path.basename(safe),
                path: safe,
                size: stats.size,
                extension: path.extname(safe).toLowerCase(),
            }
        } catch {
            return null
        }
    }

    /**
     * Import multiple images from folder
     */
    importImagesFromFolder(sourceFolder: string, destFolder: string): number {
        const images = this.getImagesInFolder(sourceFolder)
        let imported = 0

        for (const img of images) {
            if (this.copyImageToFolder(img, destFolder)) {
                imported++
            }
        }

        return imported
    }
}

export const imageManager = new ImageManager()
