import { ipcMain } from 'electron'
import { z } from 'zod'
import { projectService } from '../services/ProjectService'
import {
    idSchema,
    projectCreateSchema,
    projectDeleteSchema,
    projectUpdateSchema,
} from '../../shared/ipc-schemas'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

export function registerProjectHandlers() {
    // Get all projects
    ipcMain.handle('projects:getAll', withIpcValidation('projects:getAll', async () => {
        return projectService.getAll()
    }))

    // Get all projects with summary (counts)
    ipcMain.handle('projects:getAllWithSummary', withIpcValidation('projects:getAllWithSummary', async () => {
        return projectService.getAllWithSummary()
    }))

    // Get project by ID
    ipcMain.handle('projects:getById', withIpcValidation('projects:getById', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('projects:getById', idSchema, id)
        return projectService.getById(parsedId)
    }))

    // Get project with details
    ipcMain.handle('projects:getWithDetails', withIpcValidation('projects:getWithDetails', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('projects:getWithDetails', idSchema, id)
        return projectService.getWithDetails(parsedId)
    }))

    // Get active projects
    ipcMain.handle('projects:getActive', withIpcValidation('projects:getActive', async () => {
        return projectService.getActive()
    }))

    // Create a new project
    ipcMain.handle('projects:create', withIpcValidation('projects:create', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('projects:create', projectCreateSchema, data)
        return projectService.create({
            name: parsed.name,
            description: parsed.description,
            color: parsed.color || '#3b82f6',
            icon: parsed.icon || 'folder',
            createdAt: new Date(),
        })
    }))

    // Update a project
    ipcMain.handle('projects:update', withIpcValidation('projects:update', async (_event, id: unknown, data: unknown) => {
        const [parsedId, parsedData] = parseIpcArgs(
            'projects:update',
            z.tuple([idSchema, projectUpdateSchema]),
            [id, data],
        )
        // Normalize nullables to match service Partial<Project> (no null for non-nullable cols)
        const updatePayload: {
            name?: string
            description?: string | null
            color?: string
            icon?: string
            status?: 'active' | 'archived' | 'completed'
        } = {}
        if (parsedData.name !== undefined) updatePayload.name = parsedData.name
        if (parsedData.description !== undefined) updatePayload.description = parsedData.description
        if (parsedData.color !== undefined && parsedData.color !== null) updatePayload.color = parsedData.color
        if (parsedData.icon !== undefined && parsedData.icon !== null) updatePayload.icon = parsedData.icon
        if (parsedData.status !== undefined) updatePayload.status = parsedData.status
        return projectService.update(parsedId, updatePayload)
    }))

    // Delete a project
    ipcMain.handle('projects:delete', withIpcValidation('projects:delete', async (
        _event,
        id: unknown,
        deleteContents?: unknown,
    ) => {
        const [parsedId, parsedDeleteContents] = parseIpcArgs(
            'projects:delete',
            projectDeleteSchema,
            [id, deleteContents],
        )
        return projectService.delete(parsedId, parsedDeleteContents)
    }))

    // Archive a project
    ipcMain.handle('projects:archive', withIpcValidation('projects:archive', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('projects:archive', idSchema, id)
        return projectService.archive(parsedId)
    }))

    // Get project statistics
    ipcMain.handle('projects:getStats', withIpcValidation('projects:getStats', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('projects:getStats', idSchema, id)
        return projectService.getStats(parsedId)
    }))
}
