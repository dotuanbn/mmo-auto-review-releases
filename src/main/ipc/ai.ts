/**
 * AI IPC handlers - all payloads validated at the boundary.
 * API keys are validated and persisted through AIService's encrypted settings path.
 */

import { ipcMain } from 'electron'
import { aiService } from '../services/AIService'
import {
    aiGenerateBulkArgsSchema,
    aiGenerateReviewArgsSchema,
    aiImproveReviewArgsSchema,
    aiSetApiKeyArgsSchema,
    aiSaveReviewArgsSchema,
} from '../../shared/ai-contracts'
import { parseIpcArgs, withIpcValidation } from './validate'

export function registerAIHandlers() {
    ipcMain.handle(
        'ai:generateReview',
        withIpcValidation('ai:generateReview', async (_event, locationName: unknown, options?: unknown) => {
            const [name, opts] = parseIpcArgs(
                'ai:generateReview',
                aiGenerateReviewArgsSchema,
                [locationName, options],
            )
            return await aiService.generateReview(name, opts?.category, {
                style: opts?.style,
                language: opts?.language,
                rating: opts?.rating,
                length: opts?.length,
            })
        }),
    )

    ipcMain.handle(
        'ai:generateBulk',
        withIpcValidation(
            'ai:generateBulk',
            async (
                _event,
                count: unknown,
                locationName: unknown,
                category?: unknown,
                options?: unknown,
            ) => {
                const [n, name, cat, opts] = parseIpcArgs(
                    'ai:generateBulk',
                    aiGenerateBulkArgsSchema,
                    [count, locationName, category, options],
                )
                return await aiService.generateBulkReviews(n, name, cat, opts ?? {})
            },
        ),
    )

    ipcMain.handle(
        'ai:improveReview',
        withIpcValidation('ai:improveReview', async (_event, text: unknown, language?: unknown) => {
            const [body, lang] = parseIpcArgs(
                'ai:improveReview',
                aiImproveReviewArgsSchema,
                [text, language],
            )
            return await aiService.improveReview(body, lang)
        }),
    )

    ipcMain.handle(
        'ai:setApiKey',
        withIpcValidation('ai:setApiKey', async (_event, key: unknown) => {
            const [parsedKey] = parseIpcArgs('ai:setApiKey', aiSetApiKeyArgsSchema, [key])
            return await aiService.setApiKey(parsedKey)
        }),
    )

    ipcMain.handle(
        'ai:getApiKeyStatus',
        withIpcValidation('ai:getApiKeyStatus', async () => {
            return await aiService.getApiKeyStatus()
        }),
    )

    ipcMain.handle(
        'ai:saveReview',
        withIpcValidation('ai:saveReview', async (_event, review: unknown, locationId?: unknown) => {
            const [parsedReview, parsedLocationId] = parseIpcArgs(
                'ai:saveReview',
                aiSaveReviewArgsSchema,
                [review, locationId],
            )
            return await aiService.saveGeneratedReview(parsedReview, parsedLocationId)
        }),
    )

    console.log('AI handlers registered')
}
