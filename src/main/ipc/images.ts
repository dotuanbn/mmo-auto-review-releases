import { ipcMain, dialog } from 'electron'
import { imageManager } from '../services/ImageManager'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import * as path from 'path'
import {
    idSchema,
    imagesAddFolderSchema,
    imagesGetBase64Schema,
    imagesGetRandomSchema,
} from '../../shared/ipc-schemas'
import {
    assertExistingFile,
    assertSafeImageDirectory,
    getDefaultAllowedRoots,
    parseIpcArgs,
    parseIpcPayload,
    withIpcValidation,
} from './validate'

export function registerImageHandlers() {
    // Get all image folders from database
    ipcMain.handle('images:getFolders', withIpcValidation('images:getFolders', async () => {
        try {
            const db = getDatabase()
            return db.select().from(schema.imageFolders).all()
        } catch (error) {
            console.error('Failed to get folders:', error)
            return []
        }
    }))

    // Add a folder to database
    ipcMain.handle('images:addFolder', withIpcValidation('images:addFolder', async (
        _event,
        folderPath: unknown,
        category?: unknown,
    ) => {
        try {
            const [parsedPath, parsedCategory] = parseIpcArgs(
                'images:addFolder',
                imagesAddFolderSchema,
                [folderPath, category],
            )
            const safePath = assertSafeImageDirectory('images:addFolder', parsedPath)

            const folderInfo = imageManager.scanFolder(safePath)
            if (!folderInfo) {
                return { success: false, error: 'Invalid folder path' }
            }

            const db = getDatabase()
            const result = db.insert(schema.imageFolders).values({
                name: folderInfo.name,
                path: safePath,
                category: parsedCategory || 'general',
                imageCount: folderInfo.imageCount,
            }).run()

            return {
                success: true,
                id: Number(result.lastInsertRowid),
                folder: {
                    id: Number(result.lastInsertRowid),
                    ...folderInfo,
                    category: parsedCategory || 'general',
                },
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: message }
        }
    }))

    // Select folder using dialog
    ipcMain.handle('images:selectFolder', withIpcValidation('images:selectFolder', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select Image Folder',
        })

        if (result.canceled || result.filePaths.length === 0) {
            return null
        }

        const folderPath = result.filePaths[0]
        // Dialog-selected paths are user-consented; still normalize via ImageManager
        const folderInfo = imageManager.scanFolder(folderPath)

        return folderInfo || null
    }))

    // Delete folder from database (doesn't delete actual files)
    ipcMain.handle('images:deleteFolder', withIpcValidation('images:deleteFolder', async (_event, id: unknown) => {
        try {
            const parsedId = parseIpcPayload('images:deleteFolder', idSchema, id)
            const db = getDatabase()
            db.delete(schema.imageFolders).where(eq(schema.imageFolders.id, parsedId)).run()
            return { success: true }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: message }
        }
    }))

    // Get images from a folder
    ipcMain.handle('images:getImagesInFolder', withIpcValidation('images:getImagesInFolder', async (
        _event,
        folderId: unknown,
    ) => {
        try {
            const parsedId = parseIpcPayload('images:getImagesInFolder', idSchema, folderId)
            const db = getDatabase()
            const folder = db.select().from(schema.imageFolders).where(eq(schema.imageFolders.id, parsedId)).get()

            if (!folder) {
                return { success: false, error: 'Folder not found' }
            }

            const safePath = assertSafeImageDirectory('images:getImagesInFolder', folder.path)

            const images = imageManager.getImagesInFolder(safePath)
            return {
                success: true,
                images: images.map(img => ({
                    path: img,
                    filename: path.basename(img),
                })),
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: message }
        }
    }))

    // Get random image from folder
    ipcMain.handle('images:getRandomImage', withIpcValidation('images:getRandomImage', async (
        _event,
        folderId: unknown,
        campaignId?: unknown,
    ) => {
        try {
            const [parsedFolderId, parsedCampaignId] = parseIpcArgs(
                'images:getRandomImage',
                imagesGetRandomSchema,
                [folderId, campaignId],
            )
            const db = getDatabase()
            const folder = db.select().from(schema.imageFolders).where(eq(schema.imageFolders.id, parsedFolderId)).get()

            if (!folder) {
                return { success: false, error: 'Folder not found' }
            }

            const safePath = assertSafeImageDirectory('images:getRandomImage', folder.path)

            const campaignKey = parsedCampaignId || 'default'
            const image = imageManager.getRandomImage(safePath, campaignKey)

            if (!image) {
                return { success: false, error: 'No images available' }
            }

            return {
                success: true,
                image: {
                    path: image,
                    filename: path.basename(image),
                },
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: message }
        }
    }))

    // Update folder info (rescan)
    ipcMain.handle('images:rescanFolder', withIpcValidation('images:rescanFolder', async (_event, id: unknown) => {
        try {
            const parsedId = parseIpcPayload('images:rescanFolder', idSchema, id)
            const db = getDatabase()
            const folder = db.select().from(schema.imageFolders).where(eq(schema.imageFolders.id, parsedId)).get()

            if (!folder) {
                return { success: false, error: 'Folder not found' }
            }

            const safePath = assertSafeImageDirectory('images:rescanFolder', folder.path)

            const folderInfo = imageManager.scanFolder(safePath)
            if (!folderInfo) {
                return { success: false, error: 'Folder no longer exists' }
            }

            db.update(schema.imageFolders)
                .set({ imageCount: folderInfo.imageCount })
                .where(eq(schema.imageFolders.id, parsedId))
                .run()

            return { success: true, imageCount: folderInfo.imageCount }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: message }
        }
    }))

    // Get image base64 for preview — only files under allowed roots or registered image folders
    ipcMain.handle('images:getBase64', withIpcValidation('images:getBase64', async (_event, imagePath: unknown) => {
        const parsedPath = parseIpcPayload('images:getBase64', imagesGetBase64Schema, imagePath)

        const extraRoots: string[] = []
        try {
            const db = getDatabase()
            const folders = db.select({ path: schema.imageFolders.path }).from(schema.imageFolders).all()
            for (const folder of folders) {
                if (typeof folder.path === 'string' && folder.path.trim()) {
                    extraRoots.push(folder.path)
                }
            }
        } catch {
            // DB may be unavailable; fall back to default roots only
        }

        const safePath = assertExistingFile(
            'images:getBase64',
            parsedPath,
            getDefaultAllowedRoots(extraRoots),
        )
        return imageManager.getImageBase64(safePath)
    }))

    console.log('Image handlers registered')
}
