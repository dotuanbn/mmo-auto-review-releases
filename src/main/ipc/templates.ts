/**
 * IPC handlers for review templates
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { reviewTemplateService } from '../services/ReviewTemplateService'
import {
    idSchema,
    optionalIdSchema,
    templateCreateSchema,
    templateGenerateVariationsSchema,
    templatePreviewSchema,
    templateUpdateSchema,
} from '../../shared/ipc-schemas'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

export function registerTemplateHandlers() {
    // Get all templates
    ipcMain.handle('templates:getAll', withIpcValidation('templates:getAll', async () => {
        try {
            return await reviewTemplateService.getAll()
        } catch (error) {
            console.error('Failed to get templates:', error)
            return []
        }
    }))

    // Get template by ID
    ipcMain.handle('templates:getById', withIpcValidation('templates:getById', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('templates:getById', idSchema, id)
        try {
            return await reviewTemplateService.getById(parsedId)
        } catch (error) {
            console.error('Failed to get template:', error)
            return null
        }
    }))

    // Create template
    ipcMain.handle('templates:create', withIpcValidation('templates:create', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('templates:create', templateCreateSchema, data)
        return await reviewTemplateService.create({
            name: parsed.name,
            content: parsed.content,
            category: parsed.category,
            isActive: true,
        })
    }))

    // Update template
    ipcMain.handle('templates:update', withIpcValidation('templates:update', async (
        _event,
        id: unknown,
        data: unknown,
    ) => {
        const [parsedId, parsedData] = parseIpcArgs(
            'templates:update',
            z.tuple([idSchema, templateUpdateSchema]),
            [id, data],
        )
        await reviewTemplateService.update(parsedId, parsedData)
        return true
    }))

    // Delete template
    ipcMain.handle('templates:delete', withIpcValidation('templates:delete', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('templates:delete', idSchema, id)
        await reviewTemplateService.delete(parsedId)
        return true
    }))

    // Preview spintax
    ipcMain.handle('templates:preview', withIpcValidation('templates:preview', async (_event, content: unknown) => {
        const parsedContent = parseIpcPayload('templates:preview', templatePreviewSchema, content)
        const result = reviewTemplateService.previewSpintax(parsedContent)
        const variations = reviewTemplateService.generateVariations(parsedContent, 5)
        return {
            preview: result.preview,
            variationCount: result.variationCount,
            variations,
        }
    }))

    // Generate variations
    ipcMain.handle('templates:generateVariations', withIpcValidation('templates:generateVariations', async (
        _event,
        content: unknown,
        count: unknown = 5,
    ) => {
        const [parsedContent, parsedCount] = parseIpcArgs(
            'templates:generateVariations',
            templateGenerateVariationsSchema,
            [content, count],
        )
        return reviewTemplateService.generateVariations(parsedContent, parsedCount ?? 5)
    }))

    // Generate review from template
    ipcMain.handle('templates:generateReview', withIpcValidation('templates:generateReview', async (
        _event,
        templateId?: unknown,
    ) => {
        const parsedId = parseIpcPayload('templates:generateReview', optionalIdSchema, templateId)
        return await reviewTemplateService.generateReview(parsedId)
    }))

    // Seed default templates
    ipcMain.handle('templates:seedDefaults', withIpcValidation('templates:seedDefaults', async () => {
        return await reviewTemplateService.seedDefaults()
    }))

    console.log('[IPC] Template handlers registered')
}
