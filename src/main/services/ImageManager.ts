import * as fs from 'fs'
import * as path from 'path'

/**
 * ImageManager - Manage images for review campaigns
 * Supports image folder mapping and random selection
 */

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']

export interface ImageFolder {
    path: string
    name: string
    imageCount: number
}

export class ImageManager {
    private usedImages: Map<string, Set<string>> = new Map() // campaignId -> used image paths

    /**
     * Scan a folder for images
     * @param folderPath - Path to image folder
     * @returns Image folder info with count
     */
    scanFolder(folderPath: string): ImageFolder | null {
        if (!fs.existsSync(folderPath)) {
            return null
        }

        const stats = fs.statSync(folderPath)
        if (!stats.isDirectory()) {
            return null
        }

        const images = this.getImagesInFolder(folderPath)

        return {
            path: folderPath,
            name: path.basename(folderPath),
            imageCount: images.length,
        }
    }

    /**
     * Get all images in a folder
     * @param folderPath - Path to scan
     * @returns Array of image file paths
     */
    getImagesInFolder(folderPath: string): string[] {
        if (!fs.existsSync(folderPath)) {
            return []
        }

        try {
            const files = fs.readdirSync(folderPath)
            return files
                .filter(file => {
                    const ext = path.extname(file).toLowerCase()
                    return SUPPORTED_EXTENSIONS.includes(ext)
                })
                .map(file => path.join(folderPath, file))
        } catch (error) {
            console.error('Failed to read image folder:', error)
            return []
        }
    }

    /**
     * Get random images from a folder (without repeating for same campaign)
     * @param folderPath - Image folder path
     * @param count - Number of images to get
     * @param campaignId - Campaign ID to track usage
     * @returns Array of image paths
     */
    getRandomImages(folderPath: string, count: number, campaignId: string): string[] {
        const allImages = this.getImagesInFolder(folderPath)
        if (allImages.length === 0) return []

        // Get or create used images set for this campaign
        if (!this.usedImages.has(campaignId)) {
            this.usedImages.set(campaignId, new Set())
        }
        const used = this.usedImages.get(campaignId)!

        // Filter out already used images
        const available = allImages.filter(img => !used.has(img))

        // If all images used, reset tracking
        if (available.length === 0) {
            used.clear()
            return this.getRandomImages(folderPath, count, campaignId)
        }

        // Select random images
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
    getRandomImage(folderPath: string, campaignId: string): string | null {
        const images = this.getRandomImages(folderPath, 1, campaignId)
        return images.length > 0 ? images[0] : null
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
     * @param imagePath - Path to image
     * @returns Validation result
     */
    validateImage(imagePath: string): {
        valid: boolean
        error?: string
        sizeBytes?: number
        dimensions?: { width: number; height: number }
    } {
        if (!fs.existsSync(imagePath)) {
            return { valid: false, error: 'File not found' }
        }

        const ext = path.extname(imagePath).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
            return { valid: false, error: `Unsupported format: ${ext}` }
        }

        const stats = fs.statSync(imagePath)

        // Check file size (max 10MB)
        const maxSize = 10 * 1024 * 1024
        if (stats.size > maxSize) {
            return { valid: false, error: 'File too large (max 10MB)', sizeBytes: stats.size }
        }

        return { valid: true, sizeBytes: stats.size }
    }

    /**
     * Get image as base64 for upload
     */
    getImageBase64(imagePath: string): string | null {
        try {
            const buffer = fs.readFileSync(imagePath)
            const ext = path.extname(imagePath).toLowerCase()
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
        if (!fs.existsSync(basePath)) return []

        const folders: ImageFolder[] = []

        try {
            const entries = fs.readdirSync(basePath, { withFileTypes: true })

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const folderPath = path.join(basePath, entry.name)
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
     * @param sourcePath - Source image path
     * @param destFolder - Destination folder 
     * @param newName - Optional new filename
     * @returns New image path or null on error
     */
    copyImageToFolder(sourcePath: string, destFolder: string, newName?: string): string | null {
        try {
            // Ensure destination folder exists
            if (!fs.existsSync(destFolder)) {
                fs.mkdirSync(destFolder, { recursive: true })
            }

            const ext = path.extname(sourcePath)
            const filename = newName || `${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`
            const destPath = path.join(destFolder, filename)

            fs.copyFileSync(sourcePath, destPath)
            return destPath
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
            if (!fs.existsSync(imagePath)) return null
            const stats = fs.statSync(imagePath)
            return {
                filename: path.basename(imagePath),
                path: imagePath,
                size: stats.size,
                extension: path.extname(imagePath).toLowerCase()
            }
        } catch (error) {
            return null
        }
    }

    /**
     * Import multiple images from folder
     * @param sourceFolder - Source folder
     * @param destFolder - Destination folder
     * @returns Number of images imported
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

