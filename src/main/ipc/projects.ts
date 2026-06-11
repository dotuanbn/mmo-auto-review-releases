import { ipcMain } from 'electron'
import { projectService } from '../services/ProjectService'

export function registerProjectHandlers() {
    // Get all projects
    ipcMain.handle('projects:getAll', async () => {
        return projectService.getAll()
    })

    // Get all projects with summary (counts)
    ipcMain.handle('projects:getAllWithSummary', async () => {
        return projectService.getAllWithSummary()
    })

    // Get project by ID
    ipcMain.handle('projects:getById', async (_event, id: number) => {
        return projectService.getById(id)
    })

    // Get project with details
    ipcMain.handle('projects:getWithDetails', async (_event, id: number) => {
        return projectService.getWithDetails(id)
    })

    // Get active projects
    ipcMain.handle('projects:getActive', async () => {
        return projectService.getActive()
    })

    // Create a new project
    ipcMain.handle('projects:create', async (_event, data: {
        name: string
        description?: string
        color?: string
        icon?: string
    }) => {
        return projectService.create({
            name: data.name,
            description: data.description,
            color: data.color || '#3b82f6',
            icon: data.icon || 'folder',
            createdAt: new Date(),
        })
    })

    // Update a project
    ipcMain.handle('projects:update', async (_event, id: number, data: any) => {
        return projectService.update(id, data)
    })

    // Delete a project
    ipcMain.handle('projects:delete', async (_event, id: number, deleteContents?: boolean) => {
        return projectService.delete(id, deleteContents)
    })

    // Archive a project
    ipcMain.handle('projects:archive', async (_event, id: number) => {
        return projectService.archive(id)
    })

    // Get project statistics
    ipcMain.handle('projects:getStats', async (_event, id: number) => {
        return projectService.getStats(id)
    })
}
