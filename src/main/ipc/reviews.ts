import { ipcMain } from 'electron'
import {
    reviewHistoryCampaignIdSchema,
    reviewHistoryFiltersInputSchema,
    reviewHistoryOptionalLimitSchema,
} from '../../shared/review-history-contracts'
import { reviewService } from '../services/ReviewService'
import { parseIpcPayload, withIpcValidation } from './validate'

/** Re-export filter type for any legacy main-process imports. */
export type { ReviewHistoryFilters as ReviewFilters } from '../../shared/review-history-contracts'

export function registerReviewHandlers(): void {
    ipcMain.handle(
        'reviews:getAll',
        withIpcValidation('reviews:getAll', async () => {
            return reviewService.getAll()
        }),
    )

    ipcMain.handle(
        'reviews:getByCampaign',
        withIpcValidation('reviews:getByCampaign', async (_event, campaignId: unknown) => {
            const parsedId = parseIpcPayload(
                'reviews:getByCampaign',
                reviewHistoryCampaignIdSchema,
                campaignId,
            )
            return reviewService.getByCampaign(parsedId)
        }),
    )

    ipcMain.handle(
        'reviews:getRecent',
        withIpcValidation('reviews:getRecent', async (_event, limit?: unknown) => {
            const parsedLimit = parseIpcPayload(
                'reviews:getRecent',
                reviewHistoryOptionalLimitSchema,
                limit,
            )
            return reviewService.getRecent(parsedLimit)
        }),
    )

    ipcMain.handle(
        'reviews:getToday',
        withIpcValidation('reviews:getToday', async () => {
            return reviewService.getToday()
        }),
    )

    ipcMain.handle(
        'reviews:getStats',
        withIpcValidation('reviews:getStats', async () => {
            return reviewService.getStats()
        }),
    )

    ipcMain.handle(
        'reviews:getHistory',
        withIpcValidation('reviews:getHistory', async (_event, filters?: unknown) => {
            const parsedFilters = parseIpcPayload(
                'reviews:getHistory',
                reviewHistoryFiltersInputSchema,
                filters,
            )

            let reviews = await reviewService.getAll()

            if (parsedFilters) {
                if (parsedFilters.campaignId) {
                    reviews = reviews.filter((r) => r.campaignId === parsedFilters.campaignId)
                }
                if (parsedFilters.accountId) {
                    reviews = reviews.filter((r) => r.accountId === parsedFilters.accountId)
                }
                if (parsedFilters.locationId) {
                    reviews = reviews.filter((r) => r.locationId === parsedFilters.locationId)
                }
                if (parsedFilters.status) {
                    reviews = reviews.filter((r) => r.status === parsedFilters.status)
                }
                if (parsedFilters.dateFrom) {
                    const from = new Date(parsedFilters.dateFrom)
                    reviews = reviews.filter((r) => r.createdAt && r.createdAt >= from)
                }
                if (parsedFilters.dateTo) {
                    const to = new Date(parsedFilters.dateTo)
                    reviews = reviews.filter((r) => r.createdAt && r.createdAt <= to)
                }
                if (parsedFilters.limit) {
                    reviews = reviews.slice(0, parsedFilters.limit)
                }
            }

            return reviews
        }),
    )
}
