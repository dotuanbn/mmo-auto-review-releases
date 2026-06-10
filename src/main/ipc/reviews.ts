import { ipcMain } from 'electron'
import { reviewService } from '../services/ReviewService'

export interface ReviewFilters {
    campaignId?: number
    accountId?: number
    locationId?: number
    status?: 'success' | 'failed'
    dateFrom?: string // ISO date string
    dateTo?: string // ISO date string
    limit?: number
}

export function registerReviewHandlers() {
    // Get all review history
    ipcMain.handle('reviews:getAll', async () => {
        return reviewService.getAll()
    })

    // Get reviews for campaign
    ipcMain.handle('reviews:getByCampaign', async (_event, campaignId: number) => {
        return reviewService.getByCampaign(campaignId)
    })

    // Get recent reviews
    ipcMain.handle('reviews:getRecent', async (_event, limit?: number) => {
        return reviewService.getRecent(limit)
    })

    // Get reviews today
    ipcMain.handle('reviews:getToday', async () => {
        return reviewService.getToday()
    })

    // Get statistics
    ipcMain.handle('reviews:getStats', async () => {
        return reviewService.getStats()
    })

    // Get history with filters
    ipcMain.handle('reviews:getHistory', async (_event, filters?: ReviewFilters) => {
        let reviews = await reviewService.getAll()

        if (filters) {
            if (filters.campaignId) {
                reviews = reviews.filter(r => r.campaignId === filters.campaignId)
            }
            if (filters.accountId) {
                reviews = reviews.filter(r => r.accountId === filters.accountId)
            }
            if (filters.locationId) {
                reviews = reviews.filter(r => r.locationId === filters.locationId)
            }
            if (filters.status) {
                reviews = reviews.filter(r => r.status === filters.status)
            }
            if (filters.dateFrom) {
                const from = new Date(filters.dateFrom)
                reviews = reviews.filter(r => r.createdAt && r.createdAt >= from)
            }
            if (filters.dateTo) {
                const to = new Date(filters.dateTo)
                reviews = reviews.filter(r => r.createdAt && r.createdAt <= to)
            }
            if (filters.limit && filters.limit > 0) {
                reviews = reviews.slice(0, filters.limit)
            }
        }

        return reviews
    })
}
