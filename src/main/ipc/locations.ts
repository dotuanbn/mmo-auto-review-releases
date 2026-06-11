import { ipcMain } from 'electron'
import { locationService } from '../services/LocationService'

export function registerLocationHandlers() {
    // Get all locations
    ipcMain.handle('locations:getAll', async () => {
        return locationService.getAll()
    })

    // Get pending locations
    ipcMain.handle('locations:getPending', async () => {
        return locationService.getPending()
    })

    // Add new location
    ipcMain.handle('locations:add', async (_event, data: {
        name: string
        url: string
        placeId?: string
        address?: string
        phone?: string
        website?: string
        category?: string
        targetRating?: number
        targetReviews?: number
    }) => {
        return locationService.create({
            ...data,
            createdAt: new Date(),
        })
    })

    // Add from URL
    ipcMain.handle('locations:addFromUrl', async (_event, url: string, targetReviews?: number, phone?: string, website?: string) => {
        return locationService.createFromUrl(url, targetReviews, phone, website)
    })

    // Parse Google Maps URL
    ipcMain.handle('locations:parseUrl', async (_event, url: string) => {
        return locationService.parseGoogleMapsUrl(url)
    })

    // Update location
    ipcMain.handle('locations:update', async (_event, id: number, data: any) => {
        return locationService.update(id, data)
    })

    // Delete location
    ipcMain.handle('locations:delete', async (_event, id: number) => {
        return locationService.delete(id)
    })

    // Get statistics
    ipcMain.handle('locations:getStats', async () => {
        return locationService.getStats()
    })
}
