import { ipcMain } from 'electron'
import { z } from 'zod'
import { locationService } from '../services/LocationService'
import {
    idSchema,
    locationAddFromUrlSchema,
    locationAddSchema,
    locationUpdateSchema,
    httpUrlSchema,
} from '../../shared/ipc-schemas'
import { parseIpcArgs, parseIpcPayload, withIpcValidation } from './validate'

export function registerLocationHandlers() {
    // Get all locations
    ipcMain.handle('locations:getAll', withIpcValidation('locations:getAll', async () => {
        return locationService.getAll()
    }))

    // Get pending locations
    ipcMain.handle('locations:getPending', withIpcValidation('locations:getPending', async () => {
        return locationService.getPending()
    }))

    // Add new location
    ipcMain.handle('locations:add', withIpcValidation('locations:add', async (_event, data: unknown) => {
        const parsed = parseIpcPayload('locations:add', locationAddSchema, data)
        return locationService.create({
            ...parsed,
            createdAt: new Date(),
        })
    }))

    // Add from URL
    ipcMain.handle('locations:addFromUrl', withIpcValidation('locations:addFromUrl', async (
        _event,
        url: unknown,
        targetReviews?: unknown,
        phone?: unknown,
        website?: unknown,
    ) => {
        const [parsedUrl, parsedTarget, parsedPhone, parsedWebsite] = parseIpcArgs(
            'locations:addFromUrl',
            locationAddFromUrlSchema,
            [url, targetReviews, phone, website],
        )
        const websiteValue = parsedWebsite === '' ? undefined : parsedWebsite
        return locationService.createFromUrl(parsedUrl, parsedTarget, parsedPhone, websiteValue)
    }))

    // Parse Google Maps URL
    ipcMain.handle('locations:parseUrl', withIpcValidation('locations:parseUrl', async (_event, url: unknown) => {
        const parsedUrl = parseIpcPayload('locations:parseUrl', httpUrlSchema, url)
        return locationService.parseGoogleMapsUrl(parsedUrl)
    }))

    // Update location
    ipcMain.handle('locations:update', withIpcValidation('locations:update', async (_event, id: unknown, data: unknown) => {
        const [parsedId, parsedData] = parseIpcArgs(
            'locations:update',
            z.tuple([idSchema, locationUpdateSchema]),
            [id, data],
        )
        return locationService.update(parsedId, parsedData)
    }))

    // Delete location
    ipcMain.handle('locations:delete', withIpcValidation('locations:delete', async (_event, id: unknown) => {
        const parsedId = parseIpcPayload('locations:delete', idSchema, id)
        return locationService.delete(parsedId)
    }))

    // Get statistics
    ipcMain.handle('locations:getStats', withIpcValidation('locations:getStats', async () => {
        return locationService.getStats()
    }))
}
