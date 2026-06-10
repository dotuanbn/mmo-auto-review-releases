import { ipcMain } from 'electron'
import { aiService } from '../services/AIService'

export function registerAIHandlers() {
    // Generate single review
    ipcMain.handle('ai:generateReview', async (_event, locationName: string, options?: any) => {
        return await aiService.generateReview(locationName, options?.category, options)
    })

    // Generate multiple reviews
    ipcMain.handle('ai:generateBulk', async (_event, count: number, locationName: string, category?: string, options?: any) => {
        return await aiService.generateBulkReviews(count, locationName, category, options)
    })

    // Improve existing review
    ipcMain.handle('ai:improveReview', async (_event, text: string, language?: 'vi' | 'en') => {
        return await aiService.improveReview(text, language)
    })

    // Set API key
    ipcMain.handle('ai:setApiKey', async (_event, key: string) => {
        return await aiService.setApiKey(key)
    })

    // Get API key status
    ipcMain.handle('ai:getApiKeyStatus', async () => {
        return await aiService.getApiKeyStatus()
    })

    // Save generated review
    ipcMain.handle('ai:saveReview', async (_event, review: any, locationId?: number) => {
        return await aiService.saveGeneratedReview(review, locationId)
    })

    console.log('AI handlers registered')
}
