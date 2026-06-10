/**
 * IPC handlers for review templates
 */
import { ipcMain } from 'electron'
import { reviewTemplateService } from '../services/ReviewTemplateService'

export function registerTemplateHandlers() {
    // Get all templates
    ipcMain.handle('templates:getAll', async () => {
        try {
            return await reviewTemplateService.getAll()
        } catch (error) {
            console.error('Failed to get templates:', error)
            return []
        }
    })

    // Get template by ID
    ipcMain.handle('templates:getById', async (_, id: number) => {
        try {
            return await reviewTemplateService.getById(id)
        } catch (error) {
            console.error('Failed to get template:', error)
            return null
        }
    })

    // Create template
    ipcMain.handle('templates:create', async (_, data: { name: string; content: string; category: string }) => {
        try {
            return await reviewTemplateService.create({
                name: data.name,
                content: data.content,
                category: data.category,
                isActive: true
            })
        } catch (error) {
            console.error('Failed to create template:', error)
            throw error
        }
    })

    // Update template
    ipcMain.handle('templates:update', async (_, id: number, data: Partial<{ name: string; content: string; category: string; isActive: boolean }>) => {
        try {
            await reviewTemplateService.update(id, data)
            return true
        } catch (error) {
            console.error('Failed to update template:', error)
            throw error
        }
    })

    // Delete template
    ipcMain.handle('templates:delete', async (_, id: number) => {
        try {
            await reviewTemplateService.delete(id)
            return true
        } catch (error) {
            console.error('Failed to delete template:', error)
            throw error
        }
    })

    // Preview spintax
    ipcMain.handle('templates:preview', async (_, content: string) => {
        try {
            const result = reviewTemplateService.previewSpintax(content)
            const variations = reviewTemplateService.generateVariations(content, 5)
            return {
                preview: result.preview,
                variationCount: result.variationCount,
                variations
            }
        } catch (error) {
            console.error('Failed to preview spintax:', error)
            throw error
        }
    })

    // Generate variations
    ipcMain.handle('templates:generateVariations', async (_, content: string, count: number = 5) => {
        try {
            return reviewTemplateService.generateVariations(content, count)
        } catch (error) {
            console.error('Failed to generate variations:', error)
            throw error
        }
    })

    // Generate review from template
    ipcMain.handle('templates:generateReview', async (_, templateId?: number) => {
        try {
            return await reviewTemplateService.generateReview(templateId)
        } catch (error) {
            console.error('Failed to generate review:', error)
            throw error
        }
    })

    // Seed default templates
    ipcMain.handle('templates:seedDefaults', async () => {
        try {
            return await reviewTemplateService.seedDefaults()
        } catch (error) {
            console.error('Failed to seed defaults:', error)
            throw error
        }
    })

    console.log('[IPC] Template handlers registered')
}
