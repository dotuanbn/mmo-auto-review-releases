import { ipcMain, dialog, app } from 'electron'
import { imageManager } from '../services/ImageManager'
import { getDatabase } from '../database'
import * as schema from '../database/schema'
import { eq } from 'drizzle-orm'
import * as path from 'path'

export function registerImageHandlers() {
    // Get all image folders from database
    ipcMain.handle('images:getFolders', async () => {
        try {
            const db = getDatabase()
            return db.select().from(schema.imageFolders).all()
        } catch (error) {
            console.error('Failed to get folders:', error)
            return []
        }
    })

    // Add a folder to database
    ipcMain.handle('images:addFolder', async (_event, folderPath: string, category?: string) => {
        try {
            const folderInfo = imageManager.scanFolder(folderPath)
            if (!folderInfo) {
                return { success: false, error: 'Invalid folder path' }
            }

            const db = getDatabase()
            const result = db.insert(schema.imageFolders).values({
                name: folderInfo.name,
                path: folderPath,
                category: category || 'general',
                imageCount: folderInfo.imageCount,
            }).run()

            return {
                success: true,
                id: Number(result.lastInsertRowid),
                folder: {
                    id: Number(result.lastInsertRowid),
                    ...folderInfo,
                    category: category || 'general'
                }
            }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // Select folder using dialog
    ipcMain.handle('images:selectFolder', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select Image Folder'
        })

        if (result.canceled || result.filePaths.length === 0) {
            return null
        }

        const folderPath = result.filePaths[0]
        const folderInfo = imageManager.scanFolder(folderPath)

        return folderInfo || null
    })

    // Delete folder from database (doesn't delete actual files)
    ipcMain.handle('images:deleteFolder', async (_event, id: number) => {
        try {
            const db = getDatabase()
            db.delete(schema.imageFolders).where(eq(schema.imageFolders.id, id)).run()
            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // Get images from a folder
    ipcMain.handle('images:getImagesInFolder', async (_event, folderId: number) => {
        try {
            const db = getDatabase()
            const folder = db.select().from(schema.imageFolders).where(eq(schema.imageFolders.id, folderId)).get()

            if (!folder) {
                return { success: false, error: 'Folder not found' }
            }

            const images = imageManager.getImagesInFolder(folder.path)
            return {
                success: true,
                images: images.map(img => ({
                    path: img,
                    filename: path.basename(img)
                }))
            }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // Get random image from folder
    ipcMain.handle('images:getRandomImage', async (_event, folderId: number, campaignId?: string) => {
        try {
            const db = getDatabase()
            const folder = db.select().from(schema.imageFolders).where(eq(schema.imageFolders.id, folderId)).get()

            if (!folder) {
                return { success: false, error: 'Folder not found' }
            }

            const campaignKey = campaignId || 'default'
            const image = imageManager.getRandomImage(folder.path, campaignKey)

            if (!image) {
                return { success: false, error: 'No images available' }
            }

            return {
                success: true,
                image: {
                    path: image,
                    filename: path.basename(image)
                }
            }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // Update folder info (rescan)
    ipcMain.handle('images:rescanFolder', async (_event, id: number) => {
        try {
            const db = getDatabase()
            const folder = db.select().from(schema.imageFolders).where(eq(schema.imageFolders.id, id)).get()

            if (!folder) {
                return { success: false, error: 'Folder not found' }
            }

            const folderInfo = imageManager.scanFolder(folder.path)
            if (!folderInfo) {
                return { success: false, error: 'Folder no longer exists' }
            }

            db.update(schema.imageFolders)
                .set({ imageCount: folderInfo.imageCount })
                .where(eq(schema.imageFolders.id, id))
                .run()

            return { success: true, imageCount: folderInfo.imageCount }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    // Get image base64 for preview
    ipcMain.handle('images:getBase64', async (_event, imagePath: string) => {
        const base64 = imageManager.getImageBase64(imagePath)
        return base64
    })

    console.log('Image handlers registered')
}
